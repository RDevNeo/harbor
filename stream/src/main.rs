//! harbor-stream: a remote screen (phone or PC) for Harbor's Device panes.
//!
//! Harbor starts it when a view opens and kills it when it closes. The stream is
//! decoded here (libavcodec), so Harbor only ever sees RGBA frames.
//!
//! Usage: `harbor-stream <frames-prefix> '<connect-json>'`
//!        `harbor-stream --dump <out.ppm> '<connect-json>' [seconds]`  (test: first frame + stats, no input)
//! connect-json is what `remote-pcs.py --prepare-view` prints; "backend" picks the
//! backend ("scrcpy": the phone app's screen sharing). "mode": "control" starts with
//! input on.
//!
//! Protocol (one JSON object per line):
//! - stdout: {"t":"status","text"}  {"t":"ready","name","w","h","control"}
//!           {"t":"frame","w","h","buf"}  {"t":"stats","fps","shown","decode_ms","convert_ms","kbps"}
//!           {"t":"closed","reason"}  (reason null = ended normally; then it exits)
//! - stdin:  {"t":"got"}  frame consumed: the next one may be written
//!           {"t":"size","w","h"}  pane size in pixels: RGBA frames are scaled down to fit it
//!           {"t":"formats","yuv":true}  Harbor draws YUV: frames then carry "fmt" ("nv12": Y then
//!                                 interleaved UV; "i420": Y, U, V; tightly packed), "cs" (bt709|bt601)
//!                                 and "range" (limited|full); other pixel formats still come as RGBA
//!           {"t":"control","on"}  input on/off (view ↔ control)
//!           {"t":"pointer","x","y","down":bool|null,"button":0|1|2}  x, y in 0..1 of the video
//!           {"t":"wheel","x","y","dx","dy"}  lines, +dy = up (egui's sign)
//!           {"t":"key","key","down","ctrl","shift","alt","meta"}  "Enter", "Backspace", "ArrowLeft", "a"…
//!           {"t":"text","text","paste"?}  paste: true = from the clipboard (Ctrl+V), not typed
//!           {"t":"mute","on"}  PCs: silence the stream's sound here (the host keeps its own)
//!           {"t":"button","name"}  back | home | recents | notifications | power | volume_up | volume_down
//!           {"t":"quit"}
//! Frames are raw RGBA written to `<prefix>.0` / `<prefix>.1` (alternating), mode 0600. A frame is
//! only written once Harbor said "got" for the previous one: the newest decoded frame
//! wins, nothing is converted for nobody, and the reader never sees a half-written file.

mod decode;
#[cfg(feature = "gamestream")]
mod gamestream;
mod scrcpy;

use decode::{Converter, Frame};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Input for a backend (already gated: only arrives while control is on, except Quit).
#[derive(Debug, Clone)]
pub enum Input {
    Pointer { x: f32, y: f32, down: Option<bool>, button: u8 },
    Wheel { x: f32, y: f32, dx: f32, dy: f32 },
    /// `code`: the physical key (egui `physical_key` name) when known; PCs use it.
    Key { key: String, code: String, down: bool, ctrl: bool, shift: bool, alt: bool, meta: bool },
    Text(String),
    /// Pasted from Harbor's (the PC's) clipboard: phones set their clipboard and paste.
    Paste(String),
    Button(String),
    /// The view ↔ control gate changed (always forwarded; PCs ask the host's agent).
    Control(bool),
    Quit,
}

/// The input gate. A backend may close it itself (PCs: someone else took control).
static CONTROL: AtomicBool = AtomicBool::new(false);

#[allow(dead_code)]
pub fn set_control(on: bool) {
    CONTROL.store(on, Ordering::Relaxed);
}

pub fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

enum Present {
    Frame(Frame, f32),
    Got,
    Size(u32, u32),
    /// Harbor draws YUV itself (planes as they are, no conversion here)
    Yuv(bool),
}

/// What a backend hands its output to.
#[derive(Clone)]
pub struct Sink {
    tx: Sender<Present>,
    bytes: Arc<AtomicU64>,
}

impl Sink {
    /// A decoded frame (and how long decoding it took).
    pub fn frame(&self, f: Frame, decode_ms: f32) {
        let _ = self.tx.send(Present::Frame(f, decode_ms));
    }
    /// Bytes received, for the bitrate in stats.
    pub fn received(&self, n: usize) {
        self.bytes.fetch_add(n as u64, Ordering::Relaxed);
    }
}

/// Writes frames to shm when Harbor is ready for one; stats once a second.
fn present(prefix: String, rx: Receiver<Present>, bytes: Arc<AtomicU64>, dump: Option<String>) {
    let mut conv = Converter::default();
    let mut buf = Vec::new();
    let mut newest: Option<Frame> = None;
    let mut can_write = true;
    let mut fit = (0u32, 0u32);
    let mut yuv = false;
    let mut n = 0u32;
    let (mut decoded, mut shown, mut dec_ms, mut conv_ms) = (0u32, 0u32, 0f32, 0f32);
    let mut since = Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Present::Frame(f, ms)) => {
                decoded += 1;
                dec_ms += ms;
                newest = Some(f);
            }
            Ok(Present::Got) => can_write = true,
            Ok(Present::Size(w, h)) => fit = (w, h),
            Ok(Present::Yuv(on)) => yuv = on,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return,
        }
        if can_write && let Some(f) = newest.as_ref() {
            // YUV planes for Harbor's shader: no conversion or scaling here at all
            if yuv && dump.is_none() {
                let t = Instant::now();
                if let Some(p) = conv.planes(&f, &mut buf) {
                    let b = n % 2;
                    if write_private(&format!("{prefix}.{b}"), &buf) {
                        conv_ms += t.elapsed().as_secs_f32() * 1000.0;
                        emit(json!({
                            "t": "frame", "w": p.w, "h": p.h, "buf": b, "fmt": p.fmt, "cs": p.cs,
                            "range": if p.full_range { "full" } else { "limited" },
                        }));
                        n += 1;
                        shown += 1;
                        can_write = false;
                    }
                    newest = None;
                }
            }
        }
        if can_write && let Some(f) = newest.take() {
            let (w, h) = scaled(f.size(), fit);
            let t = Instant::now();
            if conv.rgba(&f, w, h, &mut buf) {
                conv_ms += t.elapsed().as_secs_f32() * 1000.0;
                if let Some(path) = &dump {
                    let mut out = format!("P6\n{w} {h}\n255\n").into_bytes();
                    out.extend(buf.chunks(4).flat_map(|p| [p[0], p[1], p[2]]));
                    let _ = std::fs::write(path, out);
                    emit(json!({ "t": "frame", "w": w, "h": h, "file": path }));
                    // keep decoding (stats) but never write again
                } else {
                    let b = n % 2;
                    if write_private(&format!("{prefix}.{b}"), &buf) {
                        emit(json!({ "t": "frame", "w": w, "h": h, "buf": b }));
                        n += 1;
                        can_write = false;
                    }
                }
                shown += 1;
                if dump.is_some() {
                    can_write = false;
                }
            }
        }
        let el = since.elapsed().as_secs_f32();
        if el >= 1.0 {
            let kb = bytes.swap(0, Ordering::Relaxed) as f32 * 8.0 / 1000.0;
            emit(json!({
                "t": "stats", "fps": round1(decoded as f32 / el), "shown": round1(shown as f32 / el),
                "decode_ms": round1(dec_ms / decoded.max(1) as f32), "convert_ms": round1(conv_ms / shown.max(1) as f32),
                "kbps": (kb / el).round(),
            }));
            (decoded, shown, dec_ms, conv_ms) = (0, 0, 0.0, 0.0);
            since = Instant::now();
        }
    }
}

/// A frame file, owner-only (0600): it shows the device's screen.
fn write_private(path: &str, data: &[u8]) -> bool {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path).and_then(|mut f| f.write_all(data)).is_ok()
}

fn round1(x: f32) -> f64 {
    (x as f64 * 10.0).round() / 10.0
}

/// The video's size scaled down (never up) to fit `fit`, keeping its aspect; even sizes.
fn scaled((w, h): (u32, u32), fit: (u32, u32)) -> (u32, u32) {
    if fit.0 < 16 || fit.1 < 16 || (w <= fit.0 && h <= fit.1) {
        return (w, h);
    }
    let k = (fit.0 as f32 / w as f32).min(fit.1 as f32 / h as f32);
    (((w as f32 * k) as u32 & !1).max(2), ((h as f32 * k) as u32 & !1).max(2))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (prefix, dump, cfg_s, secs) = match args.first().map(String::as_str) {
        Some("--dump") if args.len() >= 3 => (String::new(), Some(args[1].clone()), args[2].clone(), args.get(3).and_then(|s| s.parse().ok())),
        Some(_) if args.len() >= 2 => (args[0].clone(), None, args[1].clone(), None),
        _ => {
            eprintln!("usage: harbor-stream <frames-prefix> '<connect-json>' | --dump <out.ppm> '<connect-json>' [seconds]");
            std::process::exit(2);
        }
    };
    let cfg: Value = match serde_json::from_str(&cfg_s) {
        Ok(v) => v,
        Err(e) => {
            emit(json!({ "t": "closed", "reason": format!("bad connect info: {e}") }));
            std::process::exit(2);
        }
    };

    let (ptx, prx) = channel();
    let bytes = Arc::new(AtomicU64::new(0));
    let sink = Sink { tx: ptx.clone(), bytes: bytes.clone() };
    {
        let (prefix, dump, bytes) = (prefix.clone(), dump.clone(), bytes.clone());
        std::thread::spawn(move || present(prefix, prx, bytes, dump));
    }

    // stdin → gate → backend
    let (itx, irx) = channel::<Input>();
    CONTROL.store(cfg["mode"].as_str() == Some("control"), Ordering::Relaxed);
    {
        let (itx, testing) = (itx.clone(), dump.is_some());
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                let f = |k: &str| v[k].as_f64().unwrap_or(0.0) as f32;
                let b = |k: &str| v[k].as_bool().unwrap_or(false);
                let input = match v["t"].as_str().unwrap_or("") {
                    "got" => {
                        let _ = ptx.send(Present::Got);
                        continue;
                    }
                    "size" => {
                        let _ = ptx.send(Present::Size(f("w") as u32, f("h") as u32));
                        continue;
                    }
                    "formats" => {
                        let _ = ptx.send(Present::Yuv(b("yuv")));
                        continue;
                    }
                    "control" => {
                        CONTROL.store(b("on"), Ordering::Relaxed);
                        Input::Control(b("on"))
                    }
                    "quit" => Input::Quit,
                    "pointer" => Input::Pointer { x: f("x"), y: f("y"), down: v["down"].as_bool(), button: v["button"].as_u64().unwrap_or(0) as u8 },
                    "wheel" => Input::Wheel { x: f("x"), y: f("y"), dx: f("dx"), dy: f("dy") },
                    "key" => Input::Key {
                        key: v["key"].as_str().unwrap_or("").into(),
                        code: v["code"].as_str().unwrap_or("").into(),
                        down: b("down"),
                        ctrl: b("ctrl"),
                        shift: b("shift"),
                        alt: b("alt"),
                        meta: b("meta"),
                    },
                    "text" if b("paste") => Input::Paste(v["text"].as_str().unwrap_or("").into()),
                    "text" => Input::Text(v["text"].as_str().unwrap_or("").into()),
                    "mute" => {
                        #[cfg(feature = "gamestream")]
                        gamestream::set_muted(b("on"));
                        continue;
                    }
                    "button" => Input::Button(v["name"].as_str().unwrap_or("").into()),
                    _ => continue,
                };
                // a release always gets through, so switching to view never leaves a finger down
                let pass = matches!(input, Input::Quit | Input::Control(_) | Input::Pointer { down: Some(false), .. });
                let quit = matches!(input, Input::Quit);
                if (pass || CONTROL.load(Ordering::Relaxed)) && itx.send(input).is_err() {
                    break;
                }
                if quit {
                    return;
                }
            }
            if !testing {
                let _ = itx.send(Input::Quit); // Harbor went away
            }
        });
    }
    if let Some(s) = secs {
        let itx = itx.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs_f32(s));
            let _ = itx.send(Input::Quit);
        });
    }

    let result = match cfg["backend"].as_str().unwrap_or("scrcpy") {
        "scrcpy" => scrcpy::run(&cfg, sink, irx),
        #[cfg(feature = "gamestream")]
        "gamestream" => gamestream::run(&cfg, sink, irx),
        other => Err(format!("unknown backend {other:?}")),
    };
    let reason = result.err();
    emit(json!({ "t": "closed", "reason": reason }));
    // the presenter may still be writing a frame: let it finish
    std::thread::sleep(Duration::from_millis(50));
    std::process::exit(if reason.is_some() { 1 } else { 0 });
}
