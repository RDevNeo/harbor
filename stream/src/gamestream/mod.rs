//! PCs: GameStream (Sunshine) through moonlight-common-c, the protocol library
//! inside Moonlight, built from third_party/ by build.rs. This replaces running
//! Moonlight: Harbor is its own GameStream client (certificate under
//! ~/.config/harbor/gamestream, paired once per host through the host's agent),
//! video is decoded by decode.rs, sound goes to ALSA/PipeWire (audio.rs).
//!
//! connect-json (from `remote-pcs.py --prepare-view`, see devices):
//!   ip, port (the Sunshine to watch), control_port/view_port, single, mode, me, kbd,
//!   agent (argv prefix that runs the host's remote-pcs-agent), res, fps, bitrate,
//!   route, codec, name, status (the agent's `go` reply; absent = we call `go` ourselves).
//! Sessions follow the Remote Devices model: `heartbeat <me> <mode>` every second
//! keeps the host's "being controlled" notice right and tells us when someone
//! else took control (then we drop to view); Take Control = `go control`.

mod audio;
mod ffi;
mod http;
mod keys;
mod pair;

use crate::decode::{Codec, Decoder};
use crate::{Input, Sink, emit};
use ffi::*;
use http::{Host, Identity, check_status, xml};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone)]
struct Cfg {
    name: String,
    ip: String,
    control_port: u16,
    view_port: u16,
    single: bool,
    me: String,
    kbd: String,
    agent: Vec<String>,
    width: i32,
    height: i32,
    fps: i32,
    bitrate: i32,
    route: String,
    codec: String,
}

impl Cfg {
    fn parse(v: &Value) -> Result<Self, String> {
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        let ip = s("ip");
        if ip.is_empty() {
            return Err("no host address (ip) in the connect info".into());
        }
        let res = v["res"].as_str().unwrap_or("1920x1080");
        let (w, h) = res.split_once('x').and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?))).unwrap_or((1920, 1080));
        let me = Some(s("me")).filter(|m| !m.is_empty()).unwrap_or_else(|| {
            std::fs::read_to_string("/etc/hostname").unwrap_or_default().trim().split('.').next().unwrap_or("harbor").to_lowercase()
        });
        Ok(Self {
            name: Some(s("name")).filter(|n| !n.is_empty()).unwrap_or_else(|| s("key")),
            ip,
            control_port: v["control_port"].as_u64().unwrap_or(47989) as u16,
            view_port: v["view_port"].as_u64().unwrap_or(48989) as u16,
            single: v["single"].as_bool().or_else(|| v["status"]["single"].as_bool()).unwrap_or(false),
            me,
            kbd: s("kbd"),
            agent: v["agent"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
            width: w,
            height: h,
            fps: v["fps"].as_i64().unwrap_or(60) as i32,
            bitrate: v["bitrate"].as_i64().unwrap_or(20000) as i32,
            route: Some(s("route")).filter(|r| !r.is_empty()).unwrap_or_else(|| "home".into()),
            codec: Some(s("codec")).filter(|c| !c.is_empty()).unwrap_or_else(|| "auto".into()),
        })
    }

    /// Which Sunshine serves a mode: single hosts serve both from the main one.
    fn port(&self, control: bool) -> u16 {
        if control || self.single { self.control_port } else { self.view_port }
    }

    /// Run the host's agent (Session.ssh). None without an agent (standalone tests).
    fn agent(&self, args: &[&str], timeout: Duration) -> Option<Result<String, String>> {
        let (bin, pre) = self.agent.split_first()?;
        let child = Command::new(bin).args(pre).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => return Some(Err(e.to_string())),
        };
        let t0 = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if t0.elapsed() < timeout => std::thread::sleep(Duration::from_millis(20)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Some(Err(format!("agent {} timed out", args.first().unwrap_or(&""))));
                }
            }
        }
        let out = child.wait_with_output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        if out.status.success() {
            Some(Ok(text))
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            let why = err.lines().chain(text.lines()).filter(|l| !l.trim().is_empty()).last().unwrap_or("agent failed").to_string();
            Some(Err(why))
        }
    }

    fn go(&self, control: bool) -> Result<(), String> {
        let mode = if control { "control" } else { "view" };
        let mut args = vec!["go", mode, &self.me];
        if control && !self.kbd.is_empty() {
            args.push(&self.kbd);
        }
        match self.agent(&args, Duration::from_secs(40)) {
            None | Some(Ok(_)) => Ok(()),
            Some(Err(e)) => Err(e),
        }
    }
}

// ---- moonlight-common-c callbacks. It's a singleton (one connection per
// process), so its callbacks reach us through statics.

struct Video {
    sink: Sink,
    dec: Option<Decoder>,
    buf: Vec<u8>,
    empty: u32,
}

static VIDEO: Mutex<Option<Video>> = Mutex::new(None);
static AUDIO: Mutex<Option<audio::Audio>> = Mutex::new(None);
static TERMINATED: AtomicBool = AtomicBool::new(false);
static TERM_CODE: AtomicI32 = AtomicI32::new(0);
static FAILED_STAGE: Mutex<Option<String>> = Mutex::new(None);
// latency counters (µs sums over the current second)
static LAT_N: AtomicU32 = AtomicU32::new(0);
static LAT_HOST: AtomicU64 = AtomicU64::new(0);
static LAT_QUEUE: AtomicU64 = AtomicU64::new(0);
static LAT_DECODE: AtomicU64 = AtomicU64::new(0);

unsafe extern "C" {
    fn harbor_gs_log(fmt: *const c_char, ...);
}

#[unsafe(no_mangle)]
extern "C" fn harbor_gs_log_line(line: *const c_char) {
    let s = unsafe { CStr::from_ptr(line) }.to_string_lossy();
    eprint!("[gamestream] {s}");
}

unsafe extern "C" fn dr_setup(format: c_int, w: c_int, h: c_int, _fps: c_int, _ctx: *mut c_void, _flags: c_int) -> c_int {
    let codec = if format & VIDEO_FORMAT_MASK_H265 != 0 { Codec::H265 } else { Codec::H264 };
    eprintln!("[gamestream] video {w}x{h} {}", if matches!(codec, Codec::H265) { "HEVC" } else { "H.264" });
    let mut v = VIDEO.lock().unwrap();
    let Some(v) = v.as_mut() else { return -1 };
    match Decoder::new(codec) {
        Ok(d) => {
            eprintln!("[gamestream] decoding on the {}", if d.hardware() { "GPU (VAAPI)" } else { "CPU" });
            v.dec = Some(d);
            0
        }
        Err(e) => {
            eprintln!("[gamestream] {e}");
            -1
        }
    }
}

unsafe extern "C" fn dr_cleanup() {
    if let Some(v) = VIDEO.lock().unwrap().as_mut() {
        v.dec = None;
    }
}

unsafe extern "C" fn dr_submit(du: *mut DECODE_UNIT) -> c_int {
    let du = unsafe { &*du };
    let mut g = VIDEO.lock().unwrap();
    let Some(v) = g.as_mut() else { return DR_OK };
    v.buf.clear();
    let mut e = du.bufferList;
    while !e.is_null() {
        let en = unsafe { &*e };
        v.buf.extend_from_slice(unsafe { std::slice::from_raw_parts(en.data as *const u8, en.length as usize) });
        e = en.next;
    }
    v.sink.received(v.buf.len());
    let Some(dec) = v.dec.as_mut() else { return DR_OK };
    let t0 = Instant::now();
    let start_us = unsafe { LiGetMicroseconds() };
    let frames = dec.decode(&v.buf);
    let ms = t0.elapsed().as_secs_f32() * 1000.0;
    if frames.is_empty() {
        v.empty += 1;
        // a broken reference chain shows up as nothing decoding: ask for a key frame
        if v.empty >= 3 {
            v.empty = 0;
            return DR_NEED_IDR;
        }
        return DR_OK;
    }
    v.empty = 0;
    LAT_N.fetch_add(1, Ordering::Relaxed);
    LAT_HOST.fetch_add(du.frameHostProcessingLatency as u64 * 100, Ordering::Relaxed);
    LAT_QUEUE.fetch_add(start_us.saturating_sub(du.receiveTimeUs), Ordering::Relaxed);
    LAT_DECODE.fetch_add((ms * 1000.0) as u64, Ordering::Relaxed);
    for f in frames {
        v.sink.frame(f, ms);
    }
    DR_OK
}

unsafe extern "C" fn ar_init(_cfg: c_int, opus: *const OPUS_MULTISTREAM_CONFIGURATION, _ctx: *mut c_void, _flags: c_int) -> c_int {
    match audio::Audio::new(unsafe { &*opus }) {
        Ok(a) => {
            *AUDIO.lock().unwrap() = Some(a);
            0
        }
        Err(e) => {
            eprintln!("[gamestream] audio: {e}");
            -1
        }
    }
}

unsafe extern "C" fn ar_cleanup() {
    *AUDIO.lock().unwrap() = None;
}

unsafe extern "C" fn ar_sample(data: *mut c_char, len: c_int) {
    if let Some(a) = AUDIO.lock().unwrap().as_mut() {
        let d = if data.is_null() { &[][..] } else { unsafe { std::slice::from_raw_parts(data as *const u8, len as usize) } };
        a.decode(d);
    }
}

fn stage_name(stage: c_int) -> String {
    unsafe { CStr::from_ptr(LiGetStageName(stage)) }.to_string_lossy().into_owned()
}

unsafe extern "C" fn cl_stage_starting(stage: c_int) {
    emit(json!({ "t": "status", "text": format!("Connecting: {}…", stage_name(stage)) }));
}

unsafe extern "C" fn cl_stage_failed(stage: c_int, err: c_int) {
    *FAILED_STAGE.lock().unwrap() = Some(format!("{} failed (error {err})", stage_name(stage)));
}

unsafe extern "C" fn cl_terminated(err: c_int) {
    TERM_CODE.store(err, Ordering::Relaxed);
    TERMINATED.store(true, Ordering::Relaxed);
}

unsafe extern "C" fn cl_status(status: c_int) {
    if status != 0 {
        emit(json!({ "t": "status", "text": "Poor connection" }));
    }
}

// ---- one connection

struct Conn {
    w: i32,
    h: i32,
}

fn random_pin() -> String {
    let mut b = [0u8; 2];
    let _ = openssl::rand::rand_bytes(&mut b);
    format!("{:04}", u16::from_le_bytes(b) % 10000)
}

/// serverinfo → pair if needed → launch/resume → moonlight-common-c connected.
fn connect(cfg: &Cfg, id: &Identity, sink: &Sink, control: bool) -> Result<Conn, String> {
    let port = cfg.port(control);
    let mut host = Host::new(&cfg.ip, port);
    emit(json!({ "t": "status", "text": "Connecting…" }));
    let mut info = host.server_info(id).map_err(|e| format!("Can't reach screen sharing on {}: {e}", cfg.ip))?;
    if xml(&info, "PairStatus").as_deref() != Some("1") {
        emit(json!({ "t": "status", "text": "Pairing…" }));
        if cfg.agent.is_empty() {
            return Err("not paired with this PC yet (and no agent to approve the PIN)".into());
        }
        let pin = random_pin();
        let view_inst = port == cfg.view_port && port != cfg.control_port;
        let agent_cfg = cfg.clone();
        let (p, me) = (pin.clone(), cfg.me.clone());
        let approve = move || {
            let mut a = vec!["pin", p.as_str(), me.as_str()];
            if view_inst {
                a.push("view");
            }
            if let Some(Err(e)) = agent_cfg.agent(&a, Duration::from_secs(30)) {
                eprintln!("[gamestream] agent pin: {e}");
            }
        };
        let ver = xml(&info, "appversion").unwrap_or_else(|| "7.1.431.-1".into());
        pair::pair(&mut host, id, &ver, &pin, approve).map_err(|e| format!("Pairing with {} failed: {e}", cfg.name))?;
        // the host takes a moment to save the new client
        std::thread::sleep(Duration::from_millis(500));
        info = host.server_info(id)?;
        if xml(&info, "PairStatus").as_deref() != Some("1") {
            return Err("paired, but the host still doesn't know us".into());
        }
    }
    let app_version = xml(&info, "appversion").unwrap_or_default();
    let gfe_version = xml(&info, "GfeVersion").unwrap_or_default();
    let codecs: c_int = xml(&info, "ServerCodecModeSupport").and_then(|s| s.parse().ok()).unwrap_or(SCM_H264);
    let current_game: u64 = xml(&info, "currentgame").and_then(|s| s.parse().ok()).unwrap_or(0);

    // the "Desktop" app
    let apps = host.https(id, "applist", "", Duration::from_secs(10))?;
    check_status(&apps)?;
    let app_id = apps
        .split("<App>")
        .skip(1)
        .find(|a| xml(a, "AppTitle").as_deref() == Some("Desktop"))
        .or_else(|| apps.split("<App>").nth(1))
        .and_then(|a| xml(a, "ID"))
        .ok_or("the host lists no apps")?;

    let mut sc: STREAM_CONFIGURATION = unsafe { std::mem::zeroed() };
    unsafe { LiInitializeStreamConfiguration(&mut sc) };
    sc.width = cfg.width;
    sc.height = cfg.height;
    sc.fps = cfg.fps;
    sc.bitrate = cfg.bitrate;
    // Tailscale's MTU is 1280: GameStream's default 1392-byte packets would fragment
    sc.packetSize = 1024;
    sc.streamingRemotely = if cfg.route == "home" { STREAM_CFG_LOCAL } else { STREAM_CFG_REMOTE };
    sc.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
    let want_hevc = matches!(cfg.codec.as_str(), "HEVC" | "H.265" | "hevc");
    sc.supportedVideoFormats = if want_hevc && codecs & SCM_HEVC != 0 { VIDEO_FORMAT_H265 } else { VIDEO_FORMAT_H264 };
    sc.clientRefreshRateX100 = cfg.fps * 100;
    sc.colorSpace = COLORSPACE_REC_709;
    sc.colorRange = COLOR_RANGE_LIMITED;
    sc.encryptionFlags = ENCFLG_ALL;
    let _ = openssl::rand::rand_bytes(unsafe { &mut *(&mut sc.remoteInputAesKey as *mut [c_char; 16] as *mut [u8; 16]) });
    let _ = openssl::rand::rand_bytes(unsafe { &mut *(&mut sc.remoteInputAesIv[..4] as *mut [c_char] as *mut [u8]) });
    let rikeyid = i32::from_be_bytes([sc.remoteInputAesIv[0] as u8, sc.remoteInputAesIv[1] as u8, sc.remoteInputAesIv[2] as u8, sc.remoteInputAesIv[3] as u8]);
    let rikey: Vec<u8> = sc.remoteInputAesKey.iter().map(|b| *b as u8).collect();
    let extra = unsafe { CStr::from_ptr(LiGetLaunchUrlQueryParameters()) }.to_string_lossy().into_owned();
    let verb = if current_game != 0 { "resume" } else { "launch" };
    let args = format!(
        "appid={app_id}&mode={}x{}x{}&additionalStates=1&sops=0&rikey={}&rikeyid={rikeyid}&localAudioPlayMode=0&surroundAudioInfo={}&remoteControllersBitmap=0&gcmap=0&gcpersist=0{extra}",
        cfg.width, cfg.height, cfg.fps, http::hex(&rikey), (0x3 << 16) | 2
    );
    emit(json!({ "t": "status", "text": "Starting the stream…" }));
    let launch = host.https(id, verb, &args, Duration::from_secs(30))?;
    check_status(&launch).map_err(|e| format!("{verb}: {e}"))?;
    let session_url = xml(&launch, "sessionUrl0").unwrap_or_default();

    *VIDEO.lock().unwrap() = Some(Video { sink: sink.clone(), dec: None, buf: Vec::new(), empty: 0 });
    TERMINATED.store(false, Ordering::Relaxed);
    *FAILED_STAGE.lock().unwrap() = None;

    let c_addr = CString::new(cfg.ip.clone()).unwrap();
    let c_app = CString::new(app_version).unwrap();
    let c_gfe = CString::new(gfe_version).unwrap();
    let c_url = CString::new(session_url).unwrap();
    let mut si: SERVER_INFORMATION = unsafe { std::mem::zeroed() };
    unsafe { LiInitializeServerInformation(&mut si) };
    si.address = c_addr.as_ptr();
    si.serverInfoAppVersion = c_app.as_ptr();
    if !c_gfe.as_bytes().is_empty() {
        si.serverInfoGfeVersion = c_gfe.as_ptr();
    }
    if !c_url.as_bytes().is_empty() {
        si.rtspSessionUrl = c_url.as_ptr();
    }
    si.serverCodecModeSupport = codecs;
    let mut dr: DECODER_RENDERER_CALLBACKS = unsafe { std::mem::zeroed() };
    unsafe { LiInitializeVideoCallbacks(&mut dr) };
    dr.setup = Some(dr_setup);
    dr.cleanup = Some(dr_cleanup);
    dr.submitDecodeUnit = Some(dr_submit);
    dr.capabilities = 0;
    let mut ar: AUDIO_RENDERER_CALLBACKS = unsafe { std::mem::zeroed() };
    unsafe { LiInitializeAudioCallbacks(&mut ar) };
    ar.init = Some(ar_init);
    ar.cleanup = Some(ar_cleanup);
    ar.decodeAndPlaySample = Some(ar_sample);
    let mut cl: CONNECTION_LISTENER_CALLBACKS = unsafe { std::mem::zeroed() };
    unsafe { LiInitializeConnectionCallbacks(&mut cl) };
    cl.stageStarting = Some(cl_stage_starting);
    cl.stageFailed = Some(cl_stage_failed);
    cl.connectionTerminated = Some(cl_terminated);
    cl.logMessage = Some(harbor_gs_log);
    cl.connectionStatusUpdate = Some(cl_status);
    let r = unsafe {
        LiStartConnection(&mut si, &mut sc, &mut cl, &mut dr, &mut ar, std::ptr::null_mut(), 0, std::ptr::null_mut(), 0)
    };
    if r != 0 {
        let why = FAILED_STAGE.lock().unwrap().take().unwrap_or_else(|| format!("error {r}"));
        *VIDEO.lock().unwrap() = None;
        return Err(format!("Couldn't start the stream: {why}"));
    }
    Ok(Conn { w: cfg.width, h: cfg.height })
}

fn disconnect() {
    unsafe { LiStopConnection() };
    *VIDEO.lock().unwrap() = None;
    *AUDIO.lock().unwrap() = None;
}

// ---- input

#[derive(Default)]
struct Keyboard {
    held: HashSet<u16>,
    last_key: Option<Instant>,
}

impl Keyboard {
    fn mods(&self) -> c_char {
        self.held.iter().fold(0u8, |m, k| m | keys::modifier_bit(*k)) as c_char
    }

    fn send(&mut self, vk: u16, down: bool) {
        if down {
            self.held.insert(vk);
        } else {
            self.held.remove(&vk);
        }
        let m = self.mods();
        unsafe { LiSendKeyboardEvent(vk as i16 | 0x8000u16 as i16, if down { KEY_ACTION_DOWN } else { KEY_ACTION_UP }, m) };
    }

    /// egui reports modifiers as flags on each key; press/release the matching
    /// modifier keys on the host when they change (unless real modifier key events did).
    fn sync(&mut self, want: [(bool, u16); 4], except: u16) {
        for (on, vk) in want {
            let bit = keys::modifier_bit(vk);
            if keys::modifier_bit(except) == bit {
                continue;
            }
            let held: Vec<u16> = self.held.iter().copied().filter(|k| keys::modifier_bit(*k) == bit).collect();
            if on && held.is_empty() {
                self.send(vk, true);
            } else if !on {
                for k in held {
                    self.send(k, false);
                }
            }
        }
    }

    fn release_all(&mut self) {
        for k in self.held.clone() {
            self.send(k, false);
        }
    }
}

struct Pointer {
    buttons: HashSet<c_int>,
    scroll: (f32, f32),
}

fn handle(input: &Input, conn: &Conn, kb: &mut Keyboard, ptr: &mut Pointer) {
    match input {
        Input::Pointer { x, y, down, button } => {
            let px = (x.clamp(0.0, 1.0) * (conn.w - 1) as f32).round() as i16;
            let py = (y.clamp(0.0, 1.0) * (conn.h - 1) as f32).round() as i16;
            unsafe { LiSendMousePositionEvent(px, py, conn.w as i16, conn.h as i16) };
            if let Some(d) = down {
                let b = match button {
                    1 => 3, // right
                    2 => 2, // middle
                    _ => 1,
                };
                if *d {
                    ptr.buttons.insert(b);
                } else {
                    ptr.buttons.remove(&b);
                }
                unsafe { LiSendMouseButtonEvent(if *d { BUTTON_ACTION_PRESS } else { BUTTON_ACTION_RELEASE }, b) };
            }
        }
        Input::Wheel { dx, dy, .. } => {
            // 120 = one notch (Windows' WHEEL_DELTA, what Sunshine expects)
            ptr.scroll.0 += -dx * 120.0;
            ptr.scroll.1 += dy * 120.0;
            let (sx, sy) = (ptr.scroll.0.trunc(), ptr.scroll.1.trunc());
            if sy != 0.0 {
                unsafe { LiSendHighResScrollEvent(sy.clamp(-32000.0, 32000.0) as i16) };
                ptr.scroll.1 -= sy;
            }
            if sx != 0.0 {
                unsafe { LiSendHighResHScrollEvent(sx.clamp(-32000.0, 32000.0) as i16) };
                ptr.scroll.0 -= sx;
            }
        }
        Input::Key { key, code, down, ctrl, shift, alt, meta } => {
            let vk = keys::vk(code).or_else(|| keys::vk(key));
            kb.sync([(*shift, 0xA0), (*ctrl, 0xA2), (*alt, 0xA4), (*meta, 0x5B)], vk.unwrap_or(0));
            if let Some(vk) = vk {
                if *down {
                    kb.last_key = Some(Instant::now());
                }
                kb.send(vk, *down);
            }
        }
        Input::Text(t) => {
            // Typed characters already went as keys (the host's layout makes the
            // character); text without a key (pastes, IME, emoji) goes as text.
            if kb.last_key.is_some_and(|t| t.elapsed() < Duration::from_millis(150)) {
                return;
            }
            let c = CString::new(t.replace('\0', "")).unwrap();
            unsafe { LiSendUtf8TextEvent(c.as_ptr(), c.as_bytes().len() as u32) };
        }
        // (stand-in until pcview's agent `clip` + Ctrl+V: typed as text, never deduped,
        // since the Ctrl of the Ctrl+V was just sent)
        Input::Paste(t) => {
            // the Ctrl of Ctrl+V is still held on the host: let go first, or the
            // text would arrive as Ctrl+letter shortcuts
            kb.release_all();
            let c = CString::new(t.replace('\0', "")).unwrap();
            unsafe { LiSendUtf8TextEvent(c.as_ptr(), c.as_bytes().len() as u32) };
        }
        _ => {}
    }
}

fn release(kb: &mut Keyboard, ptr: &mut Pointer) {
    kb.release_all();
    for b in ptr.buttons.drain() {
        unsafe { LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, b) };
    }
}

// ---- the backend

pub fn run(v: &Value, sink: Sink, input: Receiver<Input>) -> Result<(), String> {
    let cfg = Cfg::parse(v)?;
    let id = Identity::load().map_err(|e| format!("GameStream identity: {e}"))?;
    let mut control = v["mode"].as_str() == Some("control");
    if v["status"].is_null() {
        // not prepared by remote-pcs.py: start the host's sharing ourselves
        emit(json!({ "t": "status", "text": "Starting screen sharing…" }));
        cfg.go(control)?;
    }
    let mut conn = match connect(&cfg, &id, &sink, control) {
        Ok(c) => c,
        Err(e) => {
            // prepare-view (or our `go`) opened a session: don't leave it behind
            let _ = cfg.agent(&["stop", if control { "control" } else { "view" }, &cfg.me], Duration::from_secs(15));
            return Err(e);
        }
    };
    emit(json!({ "t": "ready", "name": cfg.name, "w": conn.w, "h": conn.h, "control": control }));
    crate::set_control(control);

    // heartbeats on their own thread (an SSH round trip each)
    // mode for the heartbeats, plus a generation: a reply to a heartbeat sent
    // before a switch must not undo it (bit 0 = control, the rest counts switches)
    let mode_now = Arc::new(AtomicU64::new(control as u64));
    let set_mode = |m: &AtomicU64, on: bool| {
        let g = m.load(Ordering::Relaxed) >> 1;
        m.store(((g + 1) << 1) | on as u64, Ordering::Relaxed);
    };
    let alive = Arc::new(AtomicBool::new(true));
    let (htx, hrx) = channel::<(u64, Value)>();
    if !cfg.agent.is_empty() {
        let hcfg = cfg.clone();
        let (mode_now, alive) = (mode_now.clone(), alive.clone());
        std::thread::spawn(move || {
            while alive.load(Ordering::Relaxed) {
                let sent = mode_now.load(Ordering::Relaxed);
                let mode = if sent & 1 == 1 { "control" } else { "view" };
                if let Some(Ok(out)) = hcfg.agent(&["heartbeat", &hcfg.me, mode], Duration::from_secs(10)) {
                    if let Some(st) = out.lines().rev().find_map(|l| serde_json::from_str::<Value>(l).ok()) {
                        if htx.send((sent, st)).is_err() {
                            return;
                        }
                    }
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    }

    let mut kb = Keyboard::default();
    let mut ptr = Pointer { buttons: HashSet::new(), scroll: (0.0, 0.0) };
    let mut last_host = Value::Null;
    let mut last_lat = Instant::now();
    let result = loop {
        match input.recv_timeout(Duration::from_millis(100)) {
            Ok(Input::Quit) => break Ok(()),
            Ok(Input::Control(on)) if on != control => {
                release(&mut kb, &mut ptr);
                if on {
                    emit(json!({ "t": "status", "text": "Taking control…" }));
                    if let Err(e) = cfg.go(true) {
                        emit(json!({ "t": "status", "text": format!("Couldn't take control: {e}") }));
                        crate::set_control(false);
                        continue;
                    }
                } else if cfg.port(false) == cfg.port(true) {
                    // same stream: stop sending input now, tell the host meanwhile.
                    // Heartbeat as a viewer first, so dropping control never leaves
                    // us without a session (the agent would stop sharing).
                    control = false;
                    set_mode(&mode_now, false);
                    crate::set_control(false);
                    emit(json!({ "t": "ready", "name": cfg.name, "w": conn.w, "h": conn.h, "control": false }));
                    let c = cfg.clone();
                    std::thread::spawn(move || {
                        let _ = c.agent(&["heartbeat", &c.me, "view"], Duration::from_secs(10));
                        let _ = c.agent(&["stop", "control", &c.me], Duration::from_secs(15));
                        // a control heartbeat already in flight may have re-claimed it
                        std::thread::sleep(Duration::from_millis(1500));
                        let _ = c.agent(&["stop", "control", &c.me], Duration::from_secs(15));
                    });
                    continue;
                } else {
                    let _ = cfg.agent(&["heartbeat", &cfg.me, "view"], Duration::from_secs(10));
                    let _ = cfg.agent(&["stop", "control", &cfg.me], Duration::from_secs(15));
                }
                if cfg.port(on) != cfg.port(control) {
                    // two-instance host: the other mode is another Sunshine
                    if !on {
                        let _ = cfg.go(false);
                    }
                    disconnect();
                    conn = match connect(&cfg, &id, &sink, on) {
                        Ok(c) => c,
                        Err(e) => break Err(e),
                    };
                }
                control = on;
                set_mode(&mode_now, on);
                crate::set_control(on);
                emit(json!({ "t": "ready", "name": cfg.name, "w": conn.w, "h": conn.h, "control": control }));
            }
            Ok(Input::Control(_)) => {}
            Ok(i) => {
                if control {
                    handle(&i, &conn, &mut kb, &mut ptr);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break Ok(()),
        }
        if TERMINATED.load(Ordering::Relaxed) {
            let code = TERM_CODE.load(Ordering::Relaxed);
            break if code == ML_ERROR_GRACEFUL_TERMINATION { Err("The host ended the stream".into()) } else { Err(format!("Connection lost (error {code})")) };
        }
        while let Ok((sent, st)) = hrx.try_recv() {
            if sent != mode_now.load(Ordering::Relaxed) {
                continue; // answered before our last switch
            }
            if st["kicked"].as_bool() == Some(true) {
                alive.store(false, Ordering::Relaxed);
                disconnect();
                let _ = cfg.agent(&["stop", if control { "control" } else { "view" }, &cfg.me], Duration::from_secs(15));
                return Err(format!("Disconnected from {}", cfg.name));
            }
            let host = json!({
                "t": "host",
                "controller": st["controller"].as_str().unwrap_or(""),
                "you_control": st["you_control"].as_bool().unwrap_or(false),
            });
            if control && st["you_control"].as_bool() == Some(false) {
                // someone else took control: watch from here on
                release(&mut kb, &mut ptr);
                control = false;
                set_mode(&mode_now, false);
                crate::set_control(false);
                if cfg.port(false) != cfg.port(true) {
                    let _ = cfg.go(false);
                    disconnect();
                    conn = match connect(&cfg, &id, &sink, false) {
                        Ok(c) => c,
                        Err(e) => return Err(e),
                    };
                }
                emit(json!({ "t": "ready", "name": cfg.name, "w": conn.w, "h": conn.h, "control": false }));
            }
            if host != last_host {
                emit(host.clone());
                last_host = host;
            }
        }
        if last_lat.elapsed() >= Duration::from_secs(1) {
            last_lat = Instant::now();
            let n = LAT_N.swap(0, Ordering::Relaxed).max(1) as f64;
            let ms = |a: &AtomicU64| (a.swap(0, Ordering::Relaxed) as f64 / n / 100.0).round() / 10.0;
            let (mut rtt, mut var) = (0u32, 0u32);
            unsafe { LiGetEstimatedRttInfo(&mut rtt, &mut var) };
            emit(json!({
                "t": "latency", "host_ms": ms(&LAT_HOST), "queue_ms": ms(&LAT_QUEUE), "decode_ms": ms(&LAT_DECODE),
                "rtt_ms": rtt, "pending": unsafe { LiGetPendingVideoFrames() },
            }));
        }
    };
    alive.store(false, Ordering::Relaxed);
    release(&mut kb, &mut ptr);
    disconnect();
    let _ = cfg.agent(&["stop", if control { "control" } else { "view" }, &cfg.me], Duration::from_secs(15));
    result
}

pub fn set_muted(on: bool) {
    audio::MUTED.store(on, Ordering::Relaxed);
}
