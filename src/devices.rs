//! Devices: what is paired with this Harbor. PCs are the other Harbors of the mesh (mesh.rs,
//! Settings › Devices); phones are Harbor for Android paired here (api.rs, Settings › Phones).
//! Nothing unpaired shows up, and online is what Harbor's own connections say.
//!
//! - Send (text or an image onto the clipboard, images, files): to a PC over the mesh
//!   (`POST /mesh/v1/deliver`, answered by [`receive`] there); to a phone through this PC's hub
//!   (api::Parcel), where it waits until the app picks it up.
//! - PCs also get a terminal and a file browser over the system `ssh`, which reaches them
//!   through `harbor nc` (relay.rs) with Settings › Devices' login, like remote agents. Image
//!   files preview inside Harbor (crate::images).

use crate::widgets::Tip as _;
use crate::icons as ic;
use crate::theme::{RADIUS_MD, Tokens};
use crate::widgets as w;
use eframe::egui::{self, Align, CornerRadius, CursorIcon, FontId, Id, Layout, Margin, Rect, ScrollArea, Sense, Stroke, Ui, Vec2, pos2};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Wake = Arc<dyn Fn() + Send + Sync>;

/// Images above this aren't fetched for a preview.
const PREVIEW_MAX: u64 = 25 << 20;
/// The most one send to a PC may carry (its listener's upload limit).
const SEND_MAX: u64 = 200 << 20;
/// A phone's Harbor app calls every 30 s while it's open: seen this recently, it's open.
pub const PHONE_OPEN_SECS: i64 = 75;
/// In the background the app pings every 15 minutes (`POST /v1/alive`; Android may run it later
/// in Doze): pinged this recently, the phone is online (reachable), the app open or not.
pub const PHONE_ALIVE_SECS: i64 = 35 * 60;

/// ssh's options and destination for a paired PC: one reused connection (Harbor's own socket),
/// then what remote agents use (`harbor nc`, Settings › Devices' login and key).
pub fn ssh_args(cfg: &crate::remote::Config, h: &crate::remote::Host) -> Vec<String> {
    let cp = format!("ControlPath={}/.ssh/harbor-%C", crate::store::home().display());
    let mut v: Vec<String> = ["-o", "ControlMaster=auto", "-o", &cp, "-o", "ControlPersist=120"].iter().map(|s| s.to_string()).collect();
    // (ssh takes an option's first value: drop the agents' "no reuse" ones)
    let opts = crate::remote::ssh_opts(cfg, h);
    let mut i = 0;
    while i < opts.len() {
        if opts[i] == "-o" && opts.get(i + 1).is_some_and(|o| o.starts_with("ControlMaster=") || o.starts_with("ControlPath=")) {
            i += 2;
            continue;
        }
        v.push(opts[i].clone());
        i += 1;
    }
    // (`--`: the destination is never read as an option)
    v.push("--".into());
    v.push(h.host.clone());
    v
}

/// POSIX shell quoting (ssh joins its arguments into one remote command line).
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `cmd` run by the PC's sh, whatever its login shell: ssh hands the command line to that shell,
/// and fish reads `\'` inside single quotes, so it gets only base64 in quotes free of both.
fn sh_cmd(cmd: &str) -> String {
    format!("python3 -c 'import base64,os;os.execv(\"/bin/sh\",[\"sh\",\"-c\",base64.b64decode(\"{}\")])'", crate::agent::base64(cmd.as_bytes()))
}

/// A device's key as one folder name (a PC picks its own mesh id).
fn dir_name(key: &str) -> String {
    let s: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '_' }).collect();
    if s.chars().all(|c| c == '.') { format!("_{s}") } else { s }
}

fn human(n: u64) -> String {
    match n {
        0..1024 => format!("{n} B"),
        1024..1_048_576 => format!("{:.0} KB", n as f64 / 1024.0),
        1_048_576..1_073_741_824 => format!("{:.1} MB", n as f64 / 1_048_576.0),
        _ => format!("{:.1} GB", n as f64 / 1_073_741_824.0),
    }
}

/// A free name in `dir` for `name` ("a.png", "a (2).png", …).
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let p = Path::new(name);
    let (stem, ext) = (p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default());
    let mut out = dir.join(name);
    let mut n = 2;
    while out.exists() {
        out = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    out
}

fn downloads_dir() -> PathBuf {
    let home = crate::store::home();
    Command::new("xdg-user-dir")
        .arg("DOWNLOAD")
        .output()
        .ok()
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
        .filter(|p| p.is_dir() && *p != home)
        .unwrap_or_else(|| home.join("Downloads"))
}

// ---------------------------------------------------------------- devices

#[derive(Clone, Default)]
pub struct Device {
    /// A paired PC's mesh id ("pc:…"), or "phone:<pairing group>".
    pub key: String,
    pub name: String,
    /// "pc" or "android".
    pub kind: String,
    pub online: bool,
    /// The address it was last seen at.
    pub ip: String,
    /// When it last answered or called (unix seconds, 0: not known).
    pub seen: i64,
    /// Phones: the PC of the mesh it was last seen at, when that isn't this one.
    pub via: String,
    /// Phones: its app's versionCode (api::PairedPhone::app, 0: unknown, an old app).
    pub app: i64,
    /// Phones: the pairing's factors (2: the phone has no screen lock).
    pub factors: u8,
    /// PCs that don't answer: why (mesh::Down::slug: "harbor" isn't running there, the "pc" is off).
    pub down: String,
    /// Phones: Harbor is open on it right now (online is also true while it only pings).
    pub open: bool,
    /// PCs: its Harbor version and updates in a line (versions.rs; "" when unknown).
    pub harbor: String,
}

impl Device {
    fn from_json(v: &Value) -> Self {
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        Self { key: s("key"), name: s("name"), kind: s("kind"), online: v["online"].as_bool().unwrap_or(false), ip: s("ip"), seen: v["seen"].as_i64().unwrap_or(0), via: s("via"), app: v["app"].as_i64().unwrap_or(0), factors: v["factors"].as_u64().unwrap_or(0) as u8, down: s("down"), open: v["open"].as_bool().unwrap_or(false), harbor: s("harbor") }
    }

    pub fn phone(&self) -> bool {
        self.kind == "android"
    }

    /// A phone's pairing ([`crate::api::Token::group`]).
    fn group(&self) -> &str {
        self.key.strip_prefix("phone:").unwrap_or("")
    }

    fn icon(&self) -> &'static str {
        if self.phone() { ic::SMARTPHONE } else { ic::MONITOR }
    }

    /// Phones take sends any time (they wait for the app); PCs while they answer.
    fn can_send(&self) -> bool {
        self.phone() || self.online
    }
}

/// What a phone's app is, for Devices and Settings › Phones: "app 0.18.1", or how it's behind
/// the app this PC serves. None while the phone hasn't been seen.
pub fn app_note(app: i64, seen: i64) -> Option<(String, bool)> {
    let served = crate::update::apk().map_or(0, |(_, c)| c);
    let name = |c: i64| format!("{}.{}.{}", c / 1_000_000, c / 1000 % 1000, c % 1000);
    match app {
        _ if seen == 0 => None,
        0 => Some(("app older than 0.17: update it".into(), true)),
        // (an app that picks up sends but doesn't say its version: 0.17 or 0.18.0)
        a if a == crate::api::APP_INBOX => Some((if served > a { format!("app 0.17+, {} available", name(served)) } else { "app 0.17+".into() }, served > a)),
        a if served > a => Some((format!("app {} → {} available", name(a), name(served)), true)),
        a => Some((format!("app {}", name(a)), false)),
    }
}

/// Everything paired: the mesh's PCs, then (with phone access on) the phones, one per pairing.
fn paired() -> Vec<Device> {
    let Some(hub) = crate::api::HUB.get() else { return vec![] };
    let allowed = hub.mesh.allowed.lock().unwrap().clone();
    let peers = hub.mesh.peers.lock().unwrap().clone();
    let mesh_on = hub.mesh.on.load(std::sync::atomic::Ordering::Relaxed);
    let (versions, _) = crate::versions::gather(hub);
    let newest = crate::versions::newest(&versions);
    let mut v: Vec<Device> = crate::remote::paired_pcs(&allowed, &peers)
        .into_iter()
        .map(|p| {
            let down = if mesh_on && !p.online { hub.mesh.down_of(&p.id).map(|d| d.slug().to_string()).unwrap_or_default() } else { String::new() };
            // Its Harbor: "0.66.0 (latest)", or the version it ran when last seen.
            let harbor = match versions.iter().find(|x| x.id == p.id) {
                Some(x) if x.online => format!("Harbor {}", crate::versions::pc_line(x, &newest)),
                Some(x) if !x.version.is_empty() => format!("Harbor {}", x.version),
                _ => String::new(),
            };
            Device { seen: peers.get(&p.id).map(|q| q.seen).unwrap_or(0), key: p.id, name: p.name, kind: "pc".into(), online: mesh_on && p.online, ip: p.ip, down, harbor, ..Default::default() }
        })
        .collect();
    if hub.enabled.load(std::sync::atomic::Ordering::Relaxed) {
        for p in hub.paired_phones() {
            let now = crate::store::now();
            let open = p.seen > 0 && now - p.seen < PHONE_OPEN_SECS;
            let online = open || (p.alive > 0 && now - p.alive < PHONE_ALIVE_SECS);
            let seen = p.seen.max(p.alive);
            v.push(Device { key: format!("phone:{}", p.group), name: if p.name.is_empty() { "Phone".into() } else { p.name }, kind: "android".into(), online, open, ip: p.ip, seen, via: p.via, app: p.app, factors: p.factors, ..Default::default() });
        }
    }
    v
}

/// One file transfer, shown under the list (or the file browser) with its progress.
#[derive(Clone, Default)]
pub struct Transfer {
    pub label: String,
    pub sent: u64,
    pub size: u64,
    pub done: bool,
    pub error: Option<String>,
    /// Where a download was saved.
    pub saved: Option<PathBuf>,
    /// Waits on this PC for the phone's Harbor app to pick it up.
    pub waiting: bool,
}

pub enum Action {
    /// A terminal on the PC (ssh into it).
    Terminal(Device),
    /// Browse the PC's files in a new tab.
    Files(Device),
    /// Settings › Devices (nothing is paired yet).
    Settings,
}

/// The Devices tab.
pub struct List {
    transfers: Arc<Mutex<Vec<Transfer>>>,
    wake: Wake,
    picked: Arc<Mutex<Vec<(String, Pick, Vec<PathBuf>)>>>,
    /// Files dropped where no device row was under the pointer: "Send to…".
    unplaced: Vec<PathBuf>,
    /// A row's Send menu, open under its button.
    send_menu: Option<(Device, Rect)>,
    /// "Text to clipboard": the device and the text being written.
    text_box: Option<(Device, Rect, String)>,
}

/// What a Send menu's file picker is for.
#[derive(Clone, Copy)]
enum Pick {
    Files,
    /// Images (they open there).
    Images,
    /// One image, onto the device's clipboard.
    ClipImage,
}

/// What a send is: "text" (onto the clipboard), "clip-image" (an image onto the clipboard),
/// "image" (opens there) or "file" (lands in Downloads there).
type Kind = &'static str;

/// Sends to a device, each item tracked like a transfer: to a phone through this PC's hub, to a
/// PC over the mesh.
fn send(dev: &Device, kind: Kind, text: Option<String>, files: Vec<PathBuf>, transfers: Arc<Mutex<Vec<Transfer>>>, wake: Wake) {
    let name = dev.name.clone();
    let to = if matches!(kind, "text" | "clip-image") { format!("{name}'s clipboard") } else { name.clone() };
    // (label, text, file, delete the file afterwards, size)
    let mut items: Vec<(String, String, Option<PathBuf>, bool, u64)> = vec![];
    if let Some(t) = text {
        items.push(("Text".into(), t, None, false, 0));
    }
    for f in files {
        let n = f.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let (path, temp) = if kind == "clip-image" {
            match to_png(&f) {
                Ok(p) => {
                    let temp = p != f;
                    (p, temp)
                }
                Err(e) => {
                    transfers.lock().unwrap().push(Transfer { label: format!("{n} → {to}"), error: Some(e), ..Default::default() });
                    continue;
                }
            }
        } else {
            (f, false)
        };
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let n = if temp { Path::new(&n).with_extension("png").to_string_lossy().into_owned() } else { n };
        items.push((n, String::new(), Some(path), temp, size));
    }
    for (label, text, path, temp, size) in items {
        let i = {
            let mut l = transfers.lock().unwrap();
            l.push(Transfer { label: format!("{label} → {to}"), size, waiting: dev.phone(), ..Default::default() });
            l.len() - 1
        };
        let (tr, wk) = (transfers.clone(), wake.clone());
        let report: crate::api::Report = Arc::new(move |sent, done, error| {
            if let Some(x) = tr.lock().unwrap().get_mut(i) {
                x.waiting = false;
                x.sent = sent;
                x.done = done;
                x.error = error;
            }
            wk();
        });
        if dev.phone() {
            let Some(hub) = crate::api::HUB.get() else { continue };
            hub.post(crate::api::Parcel {
                id: crate::store::random_hex(8).unwrap_or_else(|_| format!("{i}")),
                group: dev.group().to_string(),
                kind,
                name: label,
                text,
                path,
                temp,
                size,
                at: Instant::now(),
                report,
            });
        } else {
            let key = dev.key.clone();
            std::thread::spawn(move || {
                let r = send_pc(&key, kind, &label, &text, path.as_deref());
                if temp {
                    if let Some(p) = &path {
                        let _ = std::fs::remove_file(p);
                    }
                }
                match r {
                    Ok(()) => report(size, true, None),
                    Err(e) => report(0, false, Some(e)),
                }
            });
        }
    }
    wake();
}

/// One item to a paired PC (`POST /mesh/v1/deliver`).
fn send_pc(key: &str, kind: Kind, name: &str, text: &str, path: Option<&Path>) -> Result<(), String> {
    let hub = crate::api::HUB.get().ok_or("Harbor isn't ready")?;
    let peer = hub.mesh.peer(key).ok_or("this PC isn't connected right now")?;
    let body = match path {
        Some(p) => {
            if std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) > SEND_MAX {
                return Err("files up to 200 MB".into());
            }
            std::fs::read(p).map_err(|e| e.to_string())?
        }
        None => text.as_bytes().to_vec(),
    };
    let path = format!("/mesh/v1/deliver?kind={kind}&name={}", crate::api::url_encode(name));
    match crate::mesh::http(&peer.dest(), "POST", &path, Some(("application/octet-stream", &body)), Duration::from_secs(600)) {
        Ok((200, _)) => Ok(()),
        Ok((404, _)) => Err(format!("{}'s Harbor is too old to take this: update it", peer.name)),
        Ok((s, v)) => Err(v["error"].as_str().map(String::from).unwrap_or_else(|| format!("{} answered {s}", peer.name))),
        Err(e) => Err(format!("{} didn't answer: {e}", peer.name)),
    }
}

/// What a paired PC sent this one (`POST /mesh/v1/deliver` from `from`): text or an image onto
/// the clipboard, an image saved to Downloads and opened, a file saved to Downloads; each with
/// a desktop notification.
pub fn receive(from: &str, kind: &str, name: &str, r: &mut impl Read, len: usize) -> crate::api::Reply {
    let fail = |status: u16, e: String| crate::api::Reply { status, body: json!({ "error": e }) };
    if len as u64 > SEND_MAX {
        return fail(413, "files up to 200 MB".into());
    }
    match kind {
        "text" | "clip-image" => {
            let Ok(bytes) = crate::api::read_body(r, len, if kind == "text" { 4 << 20 } else { 64 << 20 }) else { return fail(400, "short or too large".into()) };
            if kind == "text" {
                crate::clipboard::copy_text(String::from_utf8_lossy(&bytes).into_owned());
                crate::limits::notify("Copied to clipboard", &format!("Text from {from}"));
            } else {
                if image::guess_format(&bytes).is_err() {
                    return fail(400, "not an image".into());
                }
                crate::clipboard::copy_image(bytes);
                crate::limits::notify("Copied to clipboard", &format!("Image from {from}"));
            }
        }
        "image" | "file" => {
            let dir = downloads_dir();
            let _ = std::fs::create_dir_all(&dir);
            let to = free_name(&dir, &crate::api::safe_name(name));
            let part = to.with_file_name(format!(".{}.part", to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
            let res = std::fs::File::create(&part).and_then(|mut f| {
                let n = std::io::copy(&mut r.take(len as u64), &mut f)?;
                if n as usize != len { Err(std::io::Error::other("short body")) } else { Ok(()) }
            });
            if let Err(e) = res.and_then(|_| std::fs::rename(&part, &to)) {
                let _ = std::fs::remove_file(&part);
                return fail(500, format!("couldn't save it: {e}"));
            }
            let shown = to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if kind == "image" {
                let _ = Command::new("xdg-open").arg(&to).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
            }
            crate::limits::notify(&format!("From {from}"), &format!("{shown}, in {}", crate::app::tilde(&dir)));
        }
        _ => return fail(400, "unknown kind".into()),
    }
    crate::api::ok(json!({ "ok": true }))
}

/// The image as a PNG file (the clipboard takes PNGs): itself, or a converted temp copy.
fn to_png(path: &Path) -> Result<PathBuf, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(path.to_path_buf());
    }
    let img = image::load_from_memory(&bytes).map_err(|_| "only PNG and JPEG images can go on the clipboard".to_string())?;
    // private folder, one name per send (two sends at once mustn't share a file)
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let out = crate::store::run_dir().join(format!("clip-{}-{n}.png", std::process::id()));
    img.save_with_format(&out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Rows that take dropped files, drawn last frame (for the app's drop routing).
#[derive(Clone, Default)]
struct DropRects(u64, Vec<Rect>);

/// Marks `rect` as taking dropped files this frame.
fn drop_target(ctx: &egui::Context, rect: Rect) {
    let frame = ctx.cumulative_frame_nr();
    ctx.data_mut(|d| {
        let r = d.get_temp_mut_or_default::<DropRects>(Id::NULL.with("device-drop"));
        if r.0 != frame {
            *r = DropRects(frame, vec![]);
        }
        r.1.push(rect);
    });
}

/// Whether files dropped right now land on a device (then they aren't attached to the chat).
pub fn claims_drop(ctx: &egui::Context) -> bool {
    let Some(pos) = ctx.input(|i| i.pointer.hover_pos()) else { return false };
    // (logic runs before this frame's ui: the rects are last frame's)
    let r = ctx.data(|d| d.get_temp::<DropRects>(Id::NULL.with("device-drop")).unwrap_or_default());
    r.0 + 1 >= ctx.cumulative_frame_nr() && r.1.iter().any(|r| r.contains(pos))
}

impl List {
    pub fn new(wake: impl Fn() + Send + Sync + 'static) -> Self {
        Self { transfers: Default::default(), wake: Arc::new(wake), picked: Default::default(), unplaced: vec![], send_menu: None, text_box: None }
    }

    /// Files to a device: images open there (`images`, or dropped image files), the rest land
    /// in its Downloads.
    fn send_files(&self, dev: &Device, paths: Vec<PathBuf>, images: bool) {
        let files: Vec<PathBuf> = paths.into_iter().filter(|p| p.is_file()).collect();
        let (imgs, other): (Vec<PathBuf>, Vec<PathBuf>) = files.into_iter().partition(|p| images || crate::images::is_image(&p.to_string_lossy()));
        for (kind, list) in [("image", imgs), ("file", other)] {
            if !list.is_empty() {
                send(dev, kind, None, list, self.transfers.clone(), self.wake.clone());
            }
        }
    }

    fn pick(&self, key: String, kind: Pick) {
        let (picked, wake) = (self.picked.clone(), self.wake.clone());
        std::thread::spawn(move || {
            use crate::picker::Opts;
            let opts = match kind {
                Pick::Files => Opts { title: "Send files", multiple: true, ..Default::default() },
                Pick::Images => Opts { title: "Send images", multiple: true, filter: Some(("Images", &["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.PNG", "*.JPG", "*.JPEG"])), ..Default::default() },
                Pick::ClipImage => Opts { title: "Image to clipboard", filter: Some(("Images", &["*.png", "*.jpg", "*.jpeg", "*.PNG", "*.JPG", "*.JPEG"])), ..Default::default() },
            };
            let files = crate::picker::pick(opts);
            if !files.is_empty() {
                picked.lock().unwrap().push((key, kind, files));
                wake();
            }
        });
    }

    pub fn ui(&mut self, ui: &mut Ui, t: &Tokens) -> Option<Action> {
        // Phones' "last seen" and PCs' online state change by themselves.
        ui.ctx().request_repaint_after(Duration::from_secs(5));
        let devices = paired();
        let picked: Vec<_> = std::mem::take(&mut *self.picked.lock().unwrap());
        for (key, kind, files) in picked {
            if let Some(d) = devices.iter().find(|d| d.key == key) {
                match kind {
                    Pick::ClipImage => send(d, "clip-image", None, files.into_iter().take(1).collect(), self.transfers.clone(), self.wake.clone()),
                    Pick::Images => self.send_files(d, files, true),
                    Pick::Files => self.send_files(d, files, false),
                }
            }
        }
        let hovering = ui.ctx().input(|i| !i.raw.hovered_files.is_empty());
        let dropped: Vec<PathBuf> = ui.ctx().input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).filter(|p| !p.as_os_str().is_empty()).collect());
        let pointer = ui.ctx().input(|i| i.pointer.hover_pos());
        let mut action = None;
        let mut drop_rects = vec![];

        ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            egui::Frame::new().inner_margin(Margin::symmetric(16, 14)).show(ui, |ui| {
                w::text(ui, "Devices", "heading-16");
                let online = devices.iter().filter(|d| d.online).count();
                w::subtle(ui, if devices.is_empty() { "Nothing paired yet".to_string() } else { format!("{online} of {} online", devices.len()) }, "label-13");
                ui.add_space(12.0);
                if devices.is_empty() {
                    ui.add_space(24.0);
                    if w::empty(ui, ic::MONITOR, "Nothing paired yet", "Your PCs show up here once they're paired in Settings › Devices, and your phones once Harbor for Android is paired in Settings › Phones.", Some("Open Settings › Devices")) {
                        action = Some(Action::Settings);
                    }
                    return;
                }
                if hovering {
                    w::subtle(ui, "Drop on a device to send the files there.", "label-13");
                    ui.add_space(6.0);
                }
                w::card(ui).inner_margin(Margin::same(4)).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    for (n, d) in devices.iter().enumerate() {
                        if n > 0 {
                            w::separator(ui);
                        }
                        let (a, rect) = device_row(ui, t, d, hovering);
                        if d.can_send() {
                            drop_rects.push(rect);
                            if !dropped.is_empty() && pointer.is_some_and(|p| rect.contains(p)) {
                                self.send_files(d, dropped.clone(), false);
                            }
                        }
                        match a {
                            Some(RowAction::Send(r)) => self.send_menu = Some((d.clone(), r)),
                            Some(RowAction::Do(x)) => action = Some(x),
                            None => {}
                        }
                    }
                });
                transfers_ui(ui, t, &self.transfers);
            });
        });
        // Dropped onto the tab but not onto a row: ask where to.
        let pane = ui.min_rect();
        if !dropped.is_empty() && pointer.is_some_and(|p| pane.contains(p) && !drop_rects.iter().any(|r| r.contains(p))) {
            self.unplaced = dropped;
        }
        drop_rects.push(pane);
        for r in drop_rects {
            drop_target(ui.ctx(), r);
        }
        self.send_menu_ui(ui, t);
        if !self.unplaced.is_empty() {
            let targets: Vec<Device> = devices.iter().filter(|d| d.can_send()).cloned().collect();
            let anchor = Rect::from_center_size(pane.center_top() + Vec2::new(0.0, 60.0), Vec2::new(10.0, 10.0));
            let n = self.unplaced.len();
            let mut chosen = None;
            let ((), close) = w::popover(ui.ctx(), "device-send-to", anchor, 260.0, false, t, |ui| {
                w::subtle(ui, format!("  Send {} to…", if n == 1 { "1 file".into() } else { format!("{n} files") }), "label-12");
                if targets.is_empty() {
                    w::subtle(ui, "  No device is reachable right now.", "label-12");
                }
                for d in &targets {
                    if w::menu_item(ui, d.icon(), &d.name, None, false).clicked() {
                        chosen = Some(d.clone());
                    }
                }
            });
            if let Some(d) = chosen {
                let files = std::mem::take(&mut self.unplaced);
                self.send_files(&d, files, false);
            } else if close {
                self.unplaced.clear();
            }
        }
        action
    }

    /// A row's Send menu (text or an image to the clipboard, files, images), and the
    /// text box for "Text to clipboard".
    fn send_menu_ui(&mut self, ui: &Ui, t: &Tokens) {
        if let Some((d, anchor)) = self.send_menu.clone() {
            let mut pick = None;
            let mut text = false;
            let ((), close) = w::popover(ui.ctx(), "device-send-menu", anchor, 240.0, false, t, |ui| {
                w::subtle(ui, format!("  Send to {}", d.name), "label-12");
                if w::menu_item(ui, ic::CLIP, "Text to clipboard", None, false).clicked() {
                    text = true;
                }
                if w::menu_item(ui, ic::FILE, "File", None, false).tip("Lands in its Downloads").clicked() {
                    pick = Some(Pick::Files);
                }
                let opens = if d.phone() { "Saved to its Pictures and opened in its photo app" } else { "Saved to its Downloads and opened there" };
                if w::menu_item(ui, ic::IMAGE, "Image", None, false).tip(opens).clicked() {
                    pick = Some(Pick::Images);
                }
                if w::menu_item(ui, ic::FILE_IMAGE, "Image to clipboard", None, false).clicked() {
                    pick = Some(Pick::ClipImage);
                }
                if d.phone() && d.seen > 0 && d.app < crate::api::APP_INBOX {
                    w::subtle(ui, "  The phone's app is too old to take these: update it (Settings › Update there)", "label-12");
                } else if d.phone() && !d.online {
                    w::subtle(ui, "  Arrives when Harbor is open on the phone", "label-12");
                }
            });
            if let Some(k) = pick {
                self.pick(d.key.clone(), k);
                self.send_menu = None;
            } else if text {
                self.text_box = Some((d, anchor, String::new()));
                self.send_menu = None;
            } else if close {
                self.send_menu = None;
            }
        }
        if let Some((d, anchor, mut text)) = self.text_box.take() {
            let mut go = false;
            let ((), close) = w::popover(ui.ctx(), "device-send-text", anchor, 300.0, false, t, |ui| {
                ui.add_space(2.0);
                w::subtle(ui, format!("  Text for {}'s clipboard", d.name), "label-12");
                ui.add_space(4.0);
                let id = Id::NULL.with(("device-clip-text", &d.key));
                let r = egui::TextEdit::multiline(&mut text)
                    .id(id)
                    .hint_text("Type or paste text")
                    .font(crate::theme::ts("copy-14"))
                    .desired_rows(4)
                    .desired_width(f32::INFINITY)
                    .show(ui)
                    .response
                    .response;
                if !r.has_focus() && text.is_empty() {
                    r.request_focus();
                }
                let enter = r.has_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter) && (i.modifiers.ctrl || i.modifiers.command));
                ui.add_space(6.0);
                ui.horizontal(|ui| {
                    w::subtle(ui, "Ctrl+Enter", "label-12");
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if w::btn("Send").primary().xs().enabled(!text.is_empty()).show(ui).clicked() || (enter && !text.is_empty()) {
                            go = true;
                        }
                    });
                });
            });
            if go {
                send(&d, "text", Some(text), vec![], self.transfers.clone(), self.wake.clone());
            } else if !close {
                self.text_box = Some((d, anchor, text));
            }
        }
    }
}

enum RowAction {
    /// The Send button (its rect, for the menu).
    Send(Rect),
    Do(Action),
}

/// One device: icon with its online dot, name, details, and its actions on the right.
fn device_row(ui: &mut Ui, t: &Tokens, d: &Device, hovering: bool) -> (Option<RowAction>, Rect) {
    let h = 56.0;
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), h), Sense::hover());
    let p = ui.painter().clone();
    // By position, not by the row's response: the action buttons drawn over the row take
    // the hover, which would hide them again next frame (flicker).
    let hot = ui.rect_contains_pointer(rect);
    if hot {
        let fill = if hovering && d.can_send() { w::alpha(t.blue(300), 0.5) } else { w::alpha(t.accent(), 0.6) };
        p.rect_filled(rect.shrink2(Vec2::new(0.0, 2.0)), CornerRadius::same(RADIUS_MD), fill);
    }
    let fg = if d.online { t.fg() } else { t.subtle() };
    // Leading column: a 32pt disc with the glyph centred, the status dot on its lower right.
    const LEAD: f32 = 32.0;
    let ic_c = pos2((rect.left() + 10.0 + LEAD / 2.0).round(), rect.center().y.round());
    p.circle_filled(ic_c, LEAD / 2.0, t.gray(200));
    ic::glyph(&p, ic_c, d.icon(), 16.0, fg);
    let dot = ic_c + Vec2::splat((LEAD / 2.0 * std::f32::consts::FRAC_1_SQRT_2).round());
    p.circle_filled(dot, 4.0, if d.online { t.green(800) } else { t.gray(600) });
    p.circle_stroke(dot, 4.0, Stroke::new(1.5, t.gray(200)));

    // Details: kind · state · address.
    let mut bits = vec![if d.phone() { "Phone".to_string() } else { "PC".to_string() }];
    let ago = |s: i64| match crate::app::ago(s).as_str() {
        "now" => "seen just now".to_string(),
        a => format!("seen {a} ago"),
    };
    bits.push(match (d.phone(), d.online) {
        (true, true) if d.open && !d.via.is_empty() => format!("Harbor open, via {}", d.via),
        (true, true) if d.open => "Harbor open".into(),
        // Reachable, the app in the background or closed (its pings, PHONE_ALIVE_SECS).
        (true, true) if !d.via.is_empty() => format!("online, via {}", d.via),
        (_, true) => "online".into(),
        (false, false) if d.down == "harbor" && d.seen > 0 => format!("Harbor isn't running, {}", ago(d.seen)),
        (false, false) if d.down == "harbor" => "Harbor isn't running".into(),
        (_, false) if d.seen > 0 => format!("offline, {}", ago(d.seen)),
        _ => "offline".into(),
    });
    if d.phone() {
        if d.factors == 2 {
            bits.push("2-factor, no screen lock".into());
        }
        if let Some((note, _)) = app_note(d.app, d.seen) {
            bits.push(note);
        }
    } else {
        if !d.harbor.is_empty() {
            bits.push(d.harbor.clone());
        }
        if !d.ip.is_empty() && d.online {
            bits.push(d.ip.clone());
        }
    }
    let x = rect.left() + 10.0 + LEAD + 12.0;

    // Actions, right to left.
    let mut out = None;
    let mut right = rect.right() - 8.0;
    if hot && d.can_send() {
        let mut buttons: Vec<(&str, &str, u8)> = vec![(ic::SEND, "Send", 0)];
        if !d.phone() {
            buttons.push((ic::FOLDER, "Files", 1));
            buttons.push((ic::TERMINAL, "Terminal", 2));
        }
        for (icon, tip, k) in buttons {
            let br = Rect::from_center_size(pos2(right - 14.0, rect.center().y), Vec2::splat(28.0));
            right -= 32.0;
            let r = ui.interact(br, Id::NULL.with(("device-act", &d.key, k)), Sense::click());
            if r.hovered() {
                p.rect_filled(br, CornerRadius::same(RADIUS_MD), t.gray(300));
            }
            ic::glyph(&p, br.center(), icon, 16.0, if r.hovered() { t.fg() } else { t.subtle() });
            if r.on_hover_cursor(CursorIcon::PointingHand).tip(tip).clicked() {
                out = Some(match k {
                    0 => RowAction::Send(br),
                    1 => RowAction::Do(Action::Files(d.clone())),
                    _ => RowAction::Do(Action::Terminal(d.clone())),
                });
            }
        }
    }
    let max_w = (right - x - 8.0).max(40.0);
    let name = w::truncated(ui, &d.name, FontId::new(14.0, crate::theme::medium()), fg, max_w);
    p.galley(pos2(x, rect.center().y - 17.0), name, fg);
    let sub = w::truncated(ui, &bits.join(" · "), FontId::proportional(12.5), t.subtle(), max_w);
    p.galley(pos2(x, rect.center().y + 2.0), sub, t.subtle());
    (out, rect)
}

// ---------------------------------------------------------------- shared

/// The QR code for `text`, black on white, a 4-module quiet zone; load it with
/// `TextureOptions::NEAREST` so it stays sharp when scaled.
pub fn qr_image(text: &str) -> egui::ColorImage {
    match qrcode::QrCode::new(text.as_bytes()) {
        Ok(code) => {
            let n = code.width();
            let colors = code.to_colors();
            let (q, k) = (4, 6); // quiet zone (modules), pixels per module
            let side = (n + 2 * q) * k;
            let mut px = vec![egui::Color32::WHITE; side * side];
            for (i, c) in colors.iter().enumerate() {
                if *c == qrcode::Color::Dark {
                    let (mx, my) = (i % n + q, i / n + q);
                    for y in my * k..(my + 1) * k {
                        px[y * side + mx * k..y * side + (mx + 1) * k].fill(egui::Color32::BLACK);
                    }
                }
            }
            egui::ColorImage::new([side, side], px)
        }
        Err(_) => egui::ColorImage::filled([1, 1], egui::Color32::WHITE),
    }
}

fn transfers_ui(ui: &mut Ui, t: &Tokens, transfers: &Arc<Mutex<Vec<Transfer>>>) {
    let list = transfers.lock().unwrap().clone();
    if list.is_empty() {
        return;
    }
    ui.add_space(14.0);
    ui.horizontal(|ui| {
        w::subtle(ui, "Transfers", "label-12");
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if list.iter().any(|x| x.done || x.error.is_some()) && w::btn("Clear").ghost().xs().show(ui).clicked() {
                transfers.lock().unwrap().retain(|x| !x.done && x.error.is_none());
            }
        });
    });
    ui.add_space(4.0);
    for x in list.iter().rev() {
        ui.horizontal(|ui| {
            let (icon, col) = match (&x.error, x.done) {
                (Some(_), _) => (ic::CIRCLE_X, t.red(900)),
                (None, true) => (ic::CIRCLE_CHECK, t.green(900)),
                _ => (ic::LOADER, t.subtle()),
            };
            let (r, _) = ui.allocate_exact_size(Vec2::splat(16.0), Sense::hover());
            if x.done || x.error.is_some() {
                ic::glyph(ui.painter(), r.center(), icon, 14.0, col);
            } else {
                w::spinner(ui.painter(), r.center(), 6.0, col);
                ui.ctx().request_repaint_after(Duration::from_millis(80));
            }
            let width = ui.available_width();
            ui.vertical(|ui| {
                let g = w::truncated(ui, &x.label, FontId::proportional(13.0), t.fg(), width - 8.0);
                ui.label(egui::WidgetText::from(g));
                if let Some(e) = &x.error {
                    ui.label(egui::RichText::new(e).text_style(crate::theme::ts("label-12")).color(t.red(900)));
                } else if x.done {
                    let s = match &x.saved {
                        Some(p) => format!("{} · saved to {}", human(x.size), p.display()),
                        None if x.size == 0 => "Done".into(),
                        None => human(x.size),
                    };
                    w::subtle(ui, s, "label-12");
                } else if x.waiting {
                    w::subtle(ui, "Waiting for Harbor on the phone (open the app)", "label-12");
                } else {
                    w::meter(ui, if x.size > 0 { x.sent as f32 / x.size as f32 } else { 0.0 }, (width - 8.0).min(320.0));
                    w::subtle(ui, format!("{} of {}", human(x.sent), human(x.size)), "label-12");
                }
            });
        });
        ui.add_space(6.0);
    }
}

// ---------------------------------------------------------------- file browser

#[derive(Clone)]
struct Entry {
    name: String,
    dir: bool,
    size: u64,
    mtime: i64,
}

enum FsMsg {
    Listed(Result<(String, Vec<Entry>), String>),
    Preview(String, Result<PathBuf, String>),
    Refresh,
}

/// Lists a folder on the PC (python3: Harbor's PCs run Linux).
const LS_PY: &str = r#"import os,sys,json
p=os.path.abspath(os.path.expanduser(sys.argv[1] if len(sys.argv)>1 else "~"))
out=[]
for e in os.scandir(p):
    try:
        st=e.stat(); d=e.is_dir()
    except OSError:
        st=None; d=False
    out.append([e.name,d,st.st_size if st else 0,int(st.st_mtime) if st else 0])
print(json.dumps({"path":p,"entries":out}))"#;

pub struct Files {
    pub dev: Device,
    /// ssh's options and destination for it (see [`ssh_args`]).
    ssh: Vec<String>,
    pub path: String,
    entries: Vec<Entry>,
    loading: bool,
    error: Option<String>,
    show_hidden: bool,
    history: Vec<String>,
    path_input: String,
    tx: Sender<FsMsg>,
    rx: Receiver<FsMsg>,
    wake: Wake,
    transfers: Arc<Mutex<Vec<Transfer>>>,
    /// Remote path → local copy of an image, for its preview.
    previews: HashMap<String, Result<PathBuf, String>>,
    queued: VecDeque<(String, u64, i64)>,
    fetching: HashSet<String>,
    picked: Arc<Mutex<Vec<PathBuf>>>,
}

impl Files {
    pub fn new(dev: Device, ssh: Vec<String>, path: Option<String>, wake: impl Fn() + Send + Sync + 'static) -> Self {
        let (tx, rx) = channel();
        let mut f = Self {
            dev,
            ssh,
            path: path.unwrap_or_else(|| "~".into()),
            entries: vec![],
            loading: false,
            error: None,
            show_hidden: false,
            history: vec![],
            path_input: String::new(),
            tx,
            rx,
            wake: Arc::new(wake),
            transfers: Default::default(),
            previews: HashMap::new(),
            queued: VecDeque::new(),
            fetching: HashSet::new(),
            picked: Default::default(),
        };
        f.list(f.path.clone());
        f
    }

    pub fn title(&self) -> String {
        format!("{} files", self.dev.name)
    }

    fn ssh(&self) -> Command {
        let mut c = Command::new("ssh");
        c.args(&self.ssh).stdin(Stdio::null()).stderr(Stdio::piped());
        c
    }

    fn list(&mut self, path: String) {
        self.loading = true;
        let mut c = self.ssh();
        c.arg(sh_cmd(&format!("python3 -c {} {}", quote(LS_PY), quote(&path))));
        let (tx, wake) = (self.tx.clone(), self.wake.clone());
        std::thread::spawn(move || {
            let r = c.output().map_err(|e| e.to_string()).and_then(|o| {
                if !o.status.success() {
                    let err = String::from_utf8_lossy(&o.stderr);
                    let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("can't list it").trim();
                    let last = last.rsplit(": ").next().unwrap_or(last);
                    return Err(last.to_string());
                }
                let v: Value = serde_json::from_slice(&o.stdout).map_err(|_| "unexpected answer".to_string())?;
                let mut es: Vec<Entry> = v["entries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|e| Entry {
                        name: e[0].as_str().unwrap_or("").into(),
                        dir: e[1].as_bool().unwrap_or(false),
                        size: e[2].as_u64().unwrap_or(0),
                        mtime: e[3].as_i64().unwrap_or(0),
                    })
                    .collect();
                es.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
                Ok((v["path"].as_str().unwrap_or("/").to_string(), es))
            });
            let _ = tx.send(FsMsg::Listed(r));
            wake();
        });
    }

    fn go(&mut self, path: String) {
        if !self.path.is_empty() {
            self.history.push(self.path.clone());
        }
        self.list(path);
    }

    fn join(&self, name: &str) -> String {
        if self.path.ends_with('/') { format!("{}{name}", self.path) } else { format!("{}/{name}", self.path) }
    }

    fn parent(&self) -> Option<String> {
        let p = Path::new(&self.path).parent()?;
        Some(p.to_string_lossy().into_owned())
    }

    /// A remote file to ~/Downloads (or the preview cache), with progress.
    fn download(&self, remote: String, size: u64, to: PathBuf, track: bool) {
        let mut c = self.ssh();
        c.arg(sh_cmd(&format!("cat -- {}", quote(&remote)))).stdout(Stdio::piped());
        let (tx, wake, transfers) = (self.tx.clone(), self.wake.clone(), self.transfers.clone());
        let idx = track.then(|| {
            let mut l = transfers.lock().unwrap();
            let name = Path::new(&remote).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            l.push(Transfer { label: format!("{name} ← {}", self.dev.name), size, ..Default::default() });
            l.len() - 1
        });
        std::thread::spawn(move || {
            let r = (|| -> Result<PathBuf, String> {
                let mut child = c.spawn().map_err(|e| e.to_string())?;
                let mut out = child.stdout.take().unwrap();
                let part = to.with_extension(format!("{}part", to.extension().map(|e| format!("{}.", e.to_string_lossy())).unwrap_or_default()));
                if let Some(d) = to.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
                let mut buf = vec![0u8; 1 << 16];
                let (mut sent, mut tick) = (0u64, Instant::now());
                loop {
                    let n = out.read(&mut buf).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                    sent += n as u64;
                    // a preview stops at its cap, whatever size the listing claimed
                    if idx.is_none() && sent > PREVIEW_MAX {
                        let _ = child.kill();
                        let _ = child.wait();
                        drop(f);
                        let _ = std::fs::remove_file(&part);
                        return Err("too big to preview".into());
                    }
                    if let Some(i) = idx.filter(|_| tick.elapsed() > Duration::from_millis(100)) {
                        tick = Instant::now();
                        transfers.lock().unwrap()[i].sent = sent;
                        wake();
                    }
                }
                let o = child.wait_with_output().map_err(|e| e.to_string())?;
                if !o.status.success() {
                    let _ = std::fs::remove_file(&part);
                    let err = String::from_utf8_lossy(&o.stderr);
                    return Err(err.lines().last().unwrap_or("download failed").rsplit(": ").next().unwrap_or("download failed").to_string());
                }
                std::fs::rename(&part, &to).map_err(|e| e.to_string())?;
                Ok(to)
            })();
            if let Some(i) = idx {
                let mut l = transfers.lock().unwrap();
                match &r {
                    Ok(p) => {
                        l[i].done = true;
                        l[i].sent = l[i].size;
                        l[i].saved = Some(p.clone());
                    }
                    Err(e) => l[i].error = Some(e.clone()),
                }
            } else {
                let _ = tx.send(FsMsg::Preview(remote, r));
            }
            wake();
        });
    }

    /// Local files into the folder being shown (not opened there: a plain copy).
    fn upload(&self, files: Vec<PathBuf>) {
        let taken: HashSet<String> = self.entries.iter().map(|e| e.name.clone()).collect();
        for f in files.into_iter().filter(|f| f.is_file()) {
            let name = f.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let (stem, ext) = match name.rsplit_once('.') {
                Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
                _ => (name.clone(), String::new()),
            };
            let mut there = name.clone();
            let mut n = 2;
            while taken.contains(&there) {
                there = format!("{stem} ({n}){ext}");
                n += 1;
            }
            let dest = self.join(&there);
            let size = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
            let mut c = self.ssh();
            c.arg(sh_cmd(&format!("cat > {p} && mv -f {p} {d}", p = quote(&format!("{dest}.part")), d = quote(&dest)))).stdin(Stdio::piped()).stdout(Stdio::null());
            let (tx, wake, transfers) = (self.tx.clone(), self.wake.clone(), self.transfers.clone());
            let i = {
                let mut l = transfers.lock().unwrap();
                l.push(Transfer { label: format!("{name} → {}", self.dev.name), size, ..Default::default() });
                l.len() - 1
            };
            std::thread::spawn(move || {
                let r = (|| -> Result<(), String> {
                    let mut src = std::fs::File::open(&f).map_err(|e| e.to_string())?;
                    let mut child = c.spawn().map_err(|e| e.to_string())?;
                    let mut sink = child.stdin.take().unwrap();
                    let mut buf = vec![0u8; 1 << 16];
                    let (mut sent, mut tick) = (0u64, Instant::now());
                    loop {
                        let n = src.read(&mut buf).map_err(|e| e.to_string())?;
                        if n == 0 {
                            break;
                        }
                        if sink.write_all(&buf[..n]).is_err() {
                            break;
                        }
                        sent += n as u64;
                        if tick.elapsed() > Duration::from_millis(100) {
                            tick = Instant::now();
                            transfers.lock().unwrap()[i].sent = sent;
                            wake();
                        }
                    }
                    drop(sink);
                    let o = child.wait_with_output().map_err(|e| e.to_string())?;
                    if !o.status.success() {
                        let err = String::from_utf8_lossy(&o.stderr);
                        return Err(err.lines().last().unwrap_or("upload failed").to_string());
                    }
                    Ok(())
                })();
                {
                    let mut l = transfers.lock().unwrap();
                    match r {
                        Ok(()) => {
                            l[i].done = true;
                            l[i].sent = l[i].size;
                        }
                        Err(e) => l[i].error = Some(e),
                    }
                }
                let _ = tx.send(FsMsg::Refresh);
                wake();
            });
        }
    }

    fn cache_path(&self, remote: &str, mtime: i64) -> PathBuf {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (remote, mtime).hash(&mut h);
        let ext = Path::new(remote).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let base = std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from).unwrap_or_else(|| crate::store::home().join(".cache"));
        base.join("harbor/devices").join(dir_name(&self.dev.key)).join(format!("{:016x}.{ext}", h.finish()))
    }

    /// The local copy of a remote image, fetching it (two at a time) when needed.
    fn preview(&mut self, remote: &str, size: u64, mtime: i64) -> Option<PathBuf> {
        if let Some(r) = self.previews.get(remote) {
            return r.as_ref().ok().cloned();
        }
        let local = self.cache_path(remote, mtime);
        if local.is_file() {
            self.previews.insert(remote.to_string(), Ok(local.clone()));
            return Some(local);
        }
        if size <= PREVIEW_MAX && !self.fetching.contains(remote) && !self.queued.iter().any(|q| q.0 == remote) {
            self.queued.push_back((remote.to_string(), size, mtime));
        }
        None
    }

    fn pump_previews(&mut self) {
        while self.fetching.len() < 2 {
            let Some((remote, size, mtime)) = self.queued.pop_front() else { break };
            let to = self.cache_path(&remote, mtime);
            self.fetching.insert(remote.clone());
            self.download(remote, size, to, false);
        }
    }

    pub fn ui(&mut self, ui: &mut Ui, t: &Tokens) {
        while let Ok(m) = self.rx.try_recv() {
            match m {
                FsMsg::Listed(Ok((path, es))) => {
                    self.loading = false;
                    self.error = None;
                    self.path = path;
                    self.entries = es;
                    self.queued.clear();
                }
                FsMsg::Listed(Err(e)) => {
                    self.loading = false;
                    self.error = Some(e);
                    // Stay where we were.
                    if let Some(p) = self.history.pop() {
                        self.path = p;
                    }
                }
                FsMsg::Preview(remote, r) => {
                    self.fetching.remove(&remote);
                    self.previews.insert(remote, r);
                }
                FsMsg::Refresh => {
                    let p = self.path.clone();
                    self.list(p);
                }
            }
        }
        let picked: Vec<PathBuf> = std::mem::take(&mut *self.picked.lock().unwrap());
        if !picked.is_empty() {
            self.upload(picked);
        }
        // ---- toolbar: back, up, home, path, hidden, upload, refresh
        egui::Frame::new().inner_margin(Margin::symmetric(10, 6)).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                if w::btn(ic::ARROW_LEFT).muted().icon_xs().enabled(!self.history.is_empty()).show(ui).tip("Back").clicked() {
                    if let Some(p) = self.history.pop() {
                        self.list(p);
                    }
                }
                if w::btn(ic::CORNER_LEFT_UP).muted().icon_xs().enabled(self.path != "/").show(ui).tip("Up").clicked() {
                    if let Some(p) = self.parent() {
                        self.go(p);
                    }
                }
                if w::btn(ic::HOUSE).muted().icon_xs().show(ui).tip("Home").clicked() {
                    self.go("~".into());
                }
                ui.add_space(6.0);
                let right = 3.0 * 32.0;
                let width = (ui.available_width() - right - 8.0).max(80.0);
                let id = Id::NULL.with(("files-path", &self.dev.key));
                let editing = ui.memory(|m| m.has_focus(id));
                if !editing {
                    self.path_input = self.path.clone();
                }
                let r = egui::TextEdit::singleline(&mut self.path_input)
                    .id(id)
                    .font(crate::theme::ts("label-13-mono"))
                    .desired_width(width)
                    .frame(egui::Frame::new().fill(t.bg100).stroke(Stroke::new(1.0, t.border())).corner_radius(CornerRadius::same(RADIUS_MD)).inner_margin(Margin::symmetric(8, 5)))
                    .show(ui)
                    .response
                    .response;
                if r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) && !self.path_input.trim().is_empty() {
                    let p = self.path_input.trim().to_string();
                    self.go(p);
                }
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if w::btn(ic::REFRESH).muted().icon_xs().enabled(!self.loading).show(ui).tip("Refresh").clicked() {
                        let p = self.path.clone();
                        self.list(p);
                    }
                    if w::btn(ic::UPLOAD).muted().icon_xs().show(ui).tip("Upload files here").clicked() {
                        let (picked, wake) = (self.picked.clone(), self.wake.clone());
                        std::thread::spawn(move || {
                            let files = crate::picker::pick(crate::picker::Opts { title: "Upload files", multiple: true, ..Default::default() });
                            picked.lock().unwrap().extend(files);
                            wake();
                        });
                    }
                    let (icon, tip) = if self.show_hidden { (ic::EYE, "Hide hidden files") } else { (ic::EYE_OFF, "Show hidden files") };
                    if w::btn(icon).muted().icon_xs().pressed(self.show_hidden).show(ui).tip(tip).clicked() {
                        self.show_hidden = !self.show_hidden;
                    }
                });
            });
        });
        w::separator(ui);

        // Files dropped on the browser go into this folder.
        let pane = ui.available_rect_before_wrap();
        let pointer = ui.ctx().input(|i| i.pointer.hover_pos());
        let dropped: Vec<PathBuf> = ui.ctx().input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).filter(|p| !p.as_os_str().is_empty()).collect());
        if !dropped.is_empty() && pointer.is_some_and(|p| pane.contains(p)) {
            self.upload(dropped);
        }
        drop_target(ui.ctx(), pane);

        if let Some(e) = &self.error {
            egui::Frame::new().inner_margin(Margin::symmetric(14, 8)).show(ui, |ui| {
                ui.label(egui::RichText::new(e).text_style(crate::theme::ts("label-13")).color(t.red(900)));
            });
        }
        // indexes of the entries shown (no copies: folders can hold tens of thousands)
        let shown: Vec<usize> = (0..self.entries.len()).filter(|&i| self.show_hidden || !self.entries[i].name.starts_with('.')).collect();
        let mut open: Option<String> = None;
        let mut fetch: Option<(String, u64)> = None;
        let transfers_h = if self.transfers.lock().unwrap().is_empty() { 0.0 } else { 150.0 };
        let area = ScrollArea::vertical().auto_shrink([false, false]).max_height((ui.available_height() - transfers_h).max(80.0));
        if shown.is_empty() {
            area.show(ui, |ui| {
                if self.loading {
                    ui.add_space(20.0);
                    ui.vertical_centered(|ui| {
                        let (r, _) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::hover());
                        w::spinner(ui.painter(), r.center(), 7.0, t.subtle());
                    });
                    ui.ctx().request_repaint_after(Duration::from_millis(80));
                    return;
                }
                if self.error.is_none() {
                    ui.add_space(20.0);
                    ui.vertical_centered(|ui| w::subtle(ui, "Empty folder", "label-13"));
                }
            });
        } else {
            // only the rows in view are laid out
            area.show_rows(ui, 34.0, shown.len(), |ui, rows| {
                egui::Frame::new().inner_margin(Margin::symmetric(6, 0)).show(ui, |ui| {
                    for &i in &shown[rows] {
                        let e = &self.entries[i].clone();
                        let remote = self.join(&e.name);
                        let image = !e.dir && crate::images::is_image(&e.name);
                        let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::click());
                        if !ui.is_rect_visible(rect) {
                            continue;
                        }
                        let p = ui.painter().clone();
                        if resp.hovered() {
                            p.rect_filled(rect, CornerRadius::same(RADIUS_MD), t.gray(100));
                        }
                        let lead = Rect::from_center_size(pos2(rect.left() + 18.0, rect.center().y), Vec2::splat(26.0));
                        let local = if image { self.preview(&remote, e.size, e.mtime) } else { None };
                        match &local {
                            Some(l) => {
                                let key = l.to_string_lossy().into_owned();
                                ui.scope_builder(egui::UiBuilder::new().max_rect(lead), |ui| {
                                    crate::images::thumbnail(ui, &key, lead.size());
                                });
                            }
                            None => {
                                let icon = if e.dir { ic::FOLDER } else if image { ic::FILE_IMAGE } else { ic::FILE };
                                ic::glyph(&p, lead.center(), icon, 16.0, if e.dir { t.blue(900) } else { t.subtle() });
                            }
                        }
                        let meta = if e.dir { String::new() } else { human(e.size) };
                        let mg = p.layout_no_wrap(meta, FontId::proportional(12.0), t.subtle());
                        let dl = Rect::from_center_size(pos2(rect.right() - 16.0, rect.center().y), Vec2::splat(26.0));
                        let name_w = rect.width() - 44.0 - mg.size().x - 44.0;
                        let g = w::truncated(ui, &e.name, FontId::proportional(13.5), t.fg(), name_w.max(40.0));
                        p.galley(pos2(rect.left() + 40.0, rect.center().y - g.size().y / 2.0), g, t.fg());
                        p.galley(pos2(dl.left() - 8.0 - mg.size().x, rect.center().y - mg.size().y / 2.0), mg, t.subtle());
                        let mut on_dl = false;
                        if !e.dir && resp.hovered() || !e.dir && ui.rect_contains_pointer(dl) {
                            let r = ui.interact(dl, Id::NULL.with(("files-dl", &remote)), Sense::click());
                            on_dl = r.hovered();
                            if r.hovered() {
                                p.rect_filled(dl, CornerRadius::same(RADIUS_MD), t.gray(300));
                            }
                            ic::glyph(&p, dl.center(), ic::DOWNLOAD, 14.0, if r.hovered() { t.fg() } else { t.subtle() });
                            if r.tip("Download to Downloads").clicked() {
                                fetch = Some((remote.clone(), e.size));
                            }
                        }
                        let resp = resp.on_hover_cursor(CursorIcon::PointingHand);
                        if resp.clicked() && !on_dl {
                            if e.dir {
                                open = Some(remote.clone());
                            } else if let Some(l) = &local {
                                crate::images::open(ui.ctx(), &l.to_string_lossy());
                            } else if !image {
                                fetch = Some((remote.clone(), e.size));
                            }
                        }
                    }
                });
            });
        }
        if let Some(p) = open {
            self.go(p);
        }
        if let Some((remote, size)) = fetch {
            let name = Path::new(&remote).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
            let to = free_name(&downloads_dir(), &name);
            self.download(remote, size, to, true);
        }
        self.pump_previews();
        if !self.fetching.is_empty() {
            ui.ctx().request_repaint_after(Duration::from_millis(250));
        }
        if transfers_h > 0.0 {
            w::separator(ui);
            ScrollArea::vertical().id_salt("files-transfers").auto_shrink([false, true]).show(ui, |ui| {
                egui::Frame::new().inner_margin(Margin::symmetric(14, 0)).show(ui, |ui| transfers_ui(ui, t, &self.transfers));
            });
        }
    }
}

/// For hot reload: what a device tab needs to come back.
pub fn device_json(d: &Device) -> Value {
    json!({ "key": d.key, "name": d.name, "kind": d.kind, "online": d.online, "ip": d.ip, "seen": d.seen, "via": d.via, "app": d.app, "factors": d.factors, "down": d.down, "open": d.open, "harbor": d.harbor })
}

pub fn device_from(v: &Value) -> Device {
    Device::from_json(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_reuses_one_connection_through_harbor_nc() {
        let h = crate::remote::Host { id: "pc:desk".into(), host: "192.0.2.5".into(), user: "me".into(), ..Default::default() };
        let v = ssh_args(&crate::remote::Config::default(), &h);
        let joined = v.join(" ");
        assert!(joined.starts_with("-o ControlMaster=auto -o ControlPath="), "{joined}");
        assert_eq!(v.iter().filter(|o| o.starts_with("ControlMaster=")).count(), 1, "{joined}");
        assert_eq!(v.iter().filter(|o| o.starts_with("ControlPath=")).count(), 1, "{joined}");
        assert!(joined.contains("-l me"), "{joined}");
        assert_eq!(v[v.len() - 2..], ["--", "192.0.2.5"]);
    }

    #[test]
    fn device_keys_stay_one_cache_folder() {
        assert_eq!(dir_name("pc:desk"), "pc_desk");
        for k in ["/tmp/x", "../../x", "..", ".", "", "a/b\0c"] {
            let d = dir_name(k);
            assert!(!d.contains('/') && d != "." && d != ".." && !d.is_empty(), "{k} -> {d}");
            assert_eq!(Path::new("/c").join(&d).parent(), Some(Path::new("/c")), "{k}");
        }
    }

    #[test]
    fn remote_commands_survive_any_login_shell() {
        // a name that breaks out of POSIX quoting under fish
        let dir = std::env::temp_dir().join(format!("harbor-devq-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = dir.join("\\';touch poc;#.png");
        std::fs::write(&name, "ok").unwrap();
        let line = sh_cmd(&format!("cat -- {}", quote(&name.to_string_lossy())));
        assert!(!line.contains('\\') && line.matches('\'').count() == 2, "{line}");
        if Command::new("python3").arg("-V").output().is_ok() {
            let o = Command::new("bash").arg("-c").arg(&line).current_dir(&dir).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&o.stdout), "ok", "{}", String::from_utf8_lossy(&o.stderr));
            assert!(!dir.join("poc").exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn receive_refuses_what_it_cant_take() {
        let mut empty: &[u8] = b"";
        assert_eq!(receive("desk", "nope", "x", &mut empty, 0).status, 400);
        assert_eq!(receive("desk", "file", "x", &mut empty, (SEND_MAX + 1) as usize).status, 413);
        let mut junk: &[u8] = b"not an image";
        assert_eq!(receive("desk", "clip-image", "x", &mut junk, 12).status, 400);
    }

    #[test]
    fn devices_round_trip_for_reload() {
        let d = Device { key: "phone:g1".into(), name: "Pixel".into(), kind: "android".into(), online: true, ip: "192.0.2.9".into(), seen: 5, ..Default::default() };
        let back = device_from(&device_json(&d));
        assert_eq!((back.key.as_str(), back.group(), back.phone(), back.seen), ("phone:g1", "g1", true, 5));
        assert!(back.can_send());
        assert!(!Device { kind: "pc".into(), ..Default::default() }.can_send(), "an offline PC");
    }
}
