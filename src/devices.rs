//! Devices: the user's PCs and phones from Remote Devices, a separate app
//! (`remote-pcs.py`). It stays the control plane; Harbor only runs it hidden and
//! reads JSON. Without it installed, the Devices surface isn't offered:
//!
//! - `--devices-json`: the list (refreshed in the background while a tab shows it)
//! - `--send-json KEY FILE…`: files to a device (agent `recv` / the phone app), with progress
//! - `--prepare-view KEY view|control --once`: start screen sharing, print where to connect
//!
//! PCs also get a terminal (ssh in a Harbor terminal) and a file browser over the
//! system `ssh` (python3 lists folders there, `cat` moves bytes); nothing new runs on
//! any device. Image files preview inside Harbor (crate::images).

use crate::icons as ic;
use crate::theme::{RADIUS_MD, Tokens};
use crate::widgets as w;
use eframe::egui::{self, Align, CornerRadius, CursorIcon, FontId, Id, Layout, Margin, Rect, ScrollArea, Sense, Stroke, Ui, Vec2, pos2};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Wake = Arc<dyn Fn() + Send + Sync>;

const REFRESH: Duration = Duration::from_secs(20);
/// Images above this aren't fetched for a preview.
const PREVIEW_MAX: u64 = 25 << 20;

/// Remote Devices' app: $HARBOR_REMOTE_DEVICES, `remote-pcs` on PATH, or its install in
/// $XDG_DATA_HOME/remote-pcs; only a copy that has the JSON options (an older one would
/// take an unknown option for "open the window").
pub fn script() -> Option<PathBuf> {
    let home = crate::store::home();
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".local/share"));
    let mut all: Vec<PathBuf> = std::env::var_os("HARBOR_REMOTE_DEVICES").map(PathBuf::from).into_iter().collect();
    all.extend(std::env::var_os("PATH").iter().flat_map(std::env::split_paths).map(|d| d.join("remote-pcs")));
    all.push(data.join("remote-pcs/remote-pcs.py"));
    all.into_iter().find(|p| std::fs::read_to_string(p).is_ok_and(|s| s.contains("\"--devices-json\"")))
}

/// Whether Remote Devices is installed (looked up again every 10 s, so installing it
/// while Harbor runs makes Devices appear).
pub fn available() -> bool {
    static LAST: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    match *last {
        Some((at, ok)) if at.elapsed() < Duration::from_secs(10) => ok,
        _ => {
            let ok = script().is_some();
            *last = Some((Instant::now(), ok));
            ok
        }
    }
}

fn rd(args: &[&str]) -> Result<Command, String> {
    let s = script().ok_or("Remote Devices isn't installed, or it's too old for Harbor (remote-pcs.py without --devices-json)")?;
    let mut c = Command::new("python3");
    c.arg(s).args(args).stdin(Stdio::null()).stderr(Stdio::null());
    Ok(c)
}

/// The same reuse-one-connection options Remote Devices uses, with Harbor's own socket.
fn ssh_opts() -> Vec<String> {
    let cp = format!("ControlPath={}/.ssh/harbor-%C", crate::store::home().display());
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "StrictHostKeyChecking=accept-new", "-o", "ControlMaster=auto", "-o", &cp, "-o", "ControlPersist=120"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// POSIX shell quoting (ssh joins its arguments into one remote command line).
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
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
    pub key: String,
    pub name: String,
    /// "pc" or "android".
    pub kind: String,
    pub online: bool,
    pub ip: String,
    pub os: String,
    pub ssh_user: String,
    /// This computer.
    pub me: bool,
    /// Who controls it right now (another PC's name), from its agent.
    pub controller: String,
    /// A phone's companion app status (None: not running / unreachable).
    pub app: Option<Value>,
    pub sunshine: Option<bool>,
    /// Phones: the app version this PC serves (Remote Devices reads it from its APK).
    pub app_apk: i64,
}

impl Device {
    fn from_json(v: &Value) -> Self {
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        Self {
            key: s("key"),
            name: s("name"),
            kind: s("kind"),
            online: v["online"].as_bool().unwrap_or(false),
            ip: s("ip"),
            os: s("os"),
            ssh_user: s("ssh_user"),
            me: v["me"].as_bool().unwrap_or(false),
            controller: s("controller"),
            app: v.get("app").filter(|a| a.is_object()).cloned(),
            sunshine: v["sunshine"].as_bool(),
            app_apk: v["app_apk"].as_i64().unwrap_or(0),
        }
    }

    pub fn phone(&self) -> bool {
        self.kind == "android"
    }

    pub fn target(&self) -> String {
        format!("{}@{}", self.ssh_user, self.ip)
    }

    fn icon(&self) -> &'static str {
        if self.phone() {
            ic::SMARTPHONE
        } else if self.os.eq_ignore_ascii_case("macos") {
            ic::LAPTOP
        } else {
            ic::MONITOR
        }
    }

    fn os_label(&self) -> String {
        match self.os.as_str() {
            "linux" => "Linux".into(),
            "macOS" => "macOS".into(),
            "android" => "Android".into(),
            "windows" => "Windows".into(),
            o => o.to_string(),
        }
    }

    /// A phone's app can share its screen and take files.
    fn app_ready(&self) -> bool {
        self.app.is_some()
    }

    /// A phone whose app is older than the one this PC serves: (have, served).
    fn app_update(&self) -> Option<(i64, i64)> {
        let have = self.app.as_ref()?["app"].as_i64().unwrap_or(0);
        (self.phone() && self.online && have > 0 && have < self.app_apk).then_some((have, self.app_apk))
    }

    /// Can it take an image onto its clipboard? PCs always; phones from app v11 (`clip-image`).
    fn clip_image(&self) -> bool {
        !self.phone() || self.app.as_ref().is_some_and(|a| a["app"].as_i64().unwrap_or(0) >= PHONE_CLIP_IMAGE_APP)
    }

    fn can_control(&self) -> bool {
        !self.phone() || self.app.as_ref().is_some_and(|a| a["control"].as_bool().unwrap_or(false))
    }
}

#[derive(Default)]
struct Listing {
    devices: Vec<Device>,
    loaded: bool,
    busy: bool,
    error: Option<String>,
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
}

pub enum Action {
    /// Open a terminal running `argv` (ssh into the device).
    Terminal { title: String, argv: Vec<String> },
    /// Open the device's screen in a new tab.
    View { device: Device, control: bool },
    /// Browse the device's files in a new tab.
    Files(Device),
}

/// The Devices tab.
pub struct List {
    listing: Arc<Mutex<Listing>>,
    transfers: Arc<Mutex<Vec<Transfer>>>,
    wake: Wake,
    last: Option<Instant>,
    picked: Arc<Mutex<Vec<(String, Pick, Vec<PathBuf>)>>>,
    /// Files dropped where no device row was under the pointer: "Send to…".
    unplaced: Vec<PathBuf>,
    /// A row's Send menu, open under its button.
    send_menu: Option<(Device, Rect)>,
    /// "Text to clipboard": the device and the text being written.
    text_box: Option<(Device, Rect, String)>,
    /// A phone's app is too old for what was asked: the QR dialog to update it.
    update: Option<AppUpdate>,
}

/// What a Send menu's file picker is for.
#[derive(Clone, Copy)]
enum Pick {
    Files,
    /// Images (they open there, like any file sent).
    Images,
    /// One image, onto the device's clipboard.
    ClipImage,
}

/// The first phone app version with the `clip-image` op (Remote Devices' Phone.APP_CLIP_IMAGE).
const PHONE_CLIP_IMAGE_APP: i64 = 11;
/// Older phone apps only take text onto the clipboard.
const PHONE_NO_CLIP_IMAGE: &str = "Needs the phone's Remote Devices app v11 or newer";

/// `--clip-json`: text (on stdin) or a PNG onto a device's clipboard, tracked like a transfer.
fn send_clip(dev: &Device, text: Option<String>, image: Option<PathBuf>, transfers: Arc<Mutex<Vec<Transfer>>>, wake: Wake) {
    let (key, name) = (dev.key.clone(), dev.name.clone());
    let i = {
        let mut l = transfers.lock().unwrap();
        let what = if text.is_some() { "Text".to_string() } else { image.as_ref().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default() };
        l.push(Transfer { label: format!("{what} → {name}'s clipboard"), ..Default::default() });
        l.len() - 1
    };
    wake();
    std::thread::spawn(move || {
        let r = (|| -> Result<(), String> {
            let out = match (&text, &image) {
                (Some(t), _) => {
                    let mut child = rd(&["--clip-json", &key, "text"])?.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
                    let _ = child.stdin.take().unwrap().write_all(t.as_bytes());
                    child.wait_with_output().map_err(|e| e.to_string())?
                }
                (None, Some(path)) => {
                    let png = to_png(path)?;
                    let out = rd(&["--clip-json", &key, "image", &png.to_string_lossy()])?.output().map_err(|e| e.to_string());
                    if png != *path {
                        let _ = std::fs::remove_file(&png);
                    }
                    out?
                }
                _ => return Err("nothing to send".into()),
            };
            let v: Value = String::from_utf8_lossy(&out.stdout).lines().rev().find_map(|l| serde_json::from_str(l).ok()).ok_or("Remote Devices gave no answer")?;
            if v["ok"].as_bool() == Some(true) { Ok(()) } else { Err(v["error"].as_str().unwrap_or("failed").to_string()) }
        })();
        {
            let mut l = transfers.lock().unwrap();
            match r {
                Ok(()) => l[i].done = true,
                Err(e) => l[i].error = Some(e),
            }
        }
        wake();
    });
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
    let out = crate::stream::run_dir().join(format!("clip-{}-{n}.png", std::process::id()));
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
        let mut l = Self {
            listing: Default::default(),
            transfers: Default::default(),
            wake: Arc::new(wake),
            last: None,
            picked: Default::default(),
            unplaced: vec![],
            send_menu: None,
            text_box: None,
            update: None,
        };
        l.refresh();
        l
    }

    fn refresh(&mut self) {
        self.last = Some(Instant::now());
        {
            let mut l = self.listing.lock().unwrap();
            if l.busy {
                return;
            }
            l.busy = true;
        }
        let (listing, wake) = (self.listing.clone(), self.wake.clone());
        std::thread::spawn(move || {
            let r = rd(&["--devices-json"]).and_then(|mut c| c.output().map_err(|e| e.to_string())).and_then(|o| {
                serde_json::from_slice::<Value>(&o.stdout).map_err(|_| "Remote Devices gave no device list".to_string())
            });
            let mut l = listing.lock().unwrap();
            l.busy = false;
            l.loaded = true;
            match r {
                Ok(v) => {
                    l.devices = v.as_array().into_iter().flatten().map(Device::from_json).collect();
                    l.error = None;
                }
                Err(e) => l.error = Some(e),
            }
            drop(l);
            wake();
        });
    }

    /// Files to a device through Remote Devices (opens there, like its Send button).
    fn send(&self, dev: &Device, paths: Vec<PathBuf>) {
        let files: Vec<PathBuf> = paths.into_iter().filter(|p| p.is_file()).collect();
        if files.is_empty() {
            return;
        }
        send_files(dev, files, self.transfers.clone(), self.wake.clone());
    }

    fn pick(&self, key: String, kind: Pick) {
        let (picked, wake) = (self.picked.clone(), self.wake.clone());
        std::thread::spawn(move || {
            let mut args = vec!["--file-selection", "--separator=\n"];
            match kind {
                Pick::Files => args.extend(["--multiple", "--title=Send files"]),
                Pick::Images => args.extend(["--multiple", "--title=Send images", "--file-filter=Images | *.png *.jpg *.jpeg *.gif *.webp *.PNG *.JPG *.JPEG"]),
                Pick::ClipImage => args.extend(["--title=Image to clipboard", "--file-filter=Images | *.png *.jpg *.jpeg *.PNG *.JPG *.JPEG"]),
            }
            if let Ok(o) = Command::new("zenity").args(&args).output() {
                let files: Vec<PathBuf> = String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect();
                if !files.is_empty() {
                    picked.lock().unwrap().push((key, kind, files));
                    wake();
                }
            }
        });
    }

    pub fn ui(&mut self, ui: &mut Ui, t: &Tokens) -> Option<Action> {
        if self.last.is_none_or(|l| l.elapsed() > REFRESH) {
            self.refresh();
        }
        ui.ctx().request_repaint_after(REFRESH);
        let picked: Vec<_> = std::mem::take(&mut *self.picked.lock().unwrap());
        let devices = self.listing.lock().unwrap().devices.clone();
        for (key, kind, files) in picked {
            if let Some(d) = devices.iter().find(|d| d.key == key) {
                match kind {
                    Pick::ClipImage => send_clip(d, None, files.into_iter().next(), self.transfers.clone(), self.wake.clone()),
                    _ => self.send(d, files),
                }
            }
        }
        let (loaded, busy, error) = {
            let l = self.listing.lock().unwrap();
            (l.loaded, l.busy, l.error.clone())
        };
        let hovering = ui.ctx().input(|i| !i.raw.hovered_files.is_empty());
        let dropped: Vec<PathBuf> = ui.ctx().input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).filter(|p| !p.as_os_str().is_empty()).collect());
        let pointer = ui.ctx().input(|i| i.pointer.hover_pos());
        let mut action = None;
        let mut drop_rects = vec![];

        ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            egui::Frame::new().inner_margin(Margin::symmetric(16, 14)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        w::text(ui, "Devices", "heading-16");
                        let online = devices.iter().filter(|d| d.online).count();
                        w::subtle(ui, if loaded { format!("Remote Devices · {online} of {} online", devices.len()) } else { "Remote Devices".into() }, "label-13");
                    });
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let r = w::btn(ic::REFRESH).muted().icon_sm().enabled(!busy).show(ui).on_hover_text("Refresh");
                        if busy {
                            ui.painter().rect_filled(r.rect, CornerRadius::same(RADIUS_MD), t.bg100);
                            w::spinner(ui.painter(), r.rect.center(), 6.0, t.subtle());
                            ui.ctx().request_repaint_after(Duration::from_millis(80));
                        }
                        if r.clicked() {
                            self.refresh();
                        }
                    });
                });
                ui.add_space(12.0);
                if let Some(e) = &error {
                    w::well(ui).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.label(egui::RichText::new(e).text_style(crate::theme::ts("label-13")).color(t.red(900)));
                    });
                    ui.add_space(10.0);
                }
                if !loaded {
                    ui.horizontal(|ui| {
                        let (r, _) = ui.allocate_exact_size(Vec2::splat(16.0), Sense::hover());
                        w::spinner(ui.painter(), r.center(), 6.0, t.subtle());
                        w::subtle(ui, "Looking for devices…", "label-13");
                    });
                    ui.ctx().request_repaint_after(Duration::from_millis(80));
                    return;
                }
                if hovering {
                    w::subtle(ui, "Drop on a device to send the files there.", "label-13");
                    ui.add_space(6.0);
                }
                if devices.is_empty() {
                    return;
                }
                w::card(ui).inner_margin(Margin::same(4)).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    for (n, d) in devices.iter().enumerate() {
                        if n > 0 {
                            w::separator(ui);
                        }
                        let (a, rect) = device_row(ui, t, d, hovering);
                        if d.online && (!d.phone() || d.app_ready()) {
                            drop_rects.push(rect);
                            if !dropped.is_empty() && pointer.is_some_and(|p| rect.contains(p)) {
                                self.send(d, dropped.clone());
                            }
                        }
                        match a {
                            Some(RowAction::Send(r)) => self.send_menu = Some((d.clone(), r)),
                            // a phone whose app is older than the one Remote Devices ships: update first
                            Some(RowAction::Do(Action::View { device, control })) if outdated(&device, latest_app()).is_some() => {
                                let need = latest_app();
                                self.update = Some(AppUpdate::new(device, need, Then::View(control), &devices, self.wake.clone()));
                            }
                            Some(RowAction::Do(x)) => action = Some(x),
                            Some(RowAction::UpdateApp) => {
                                let need = d.app_apk;
                                self.update = Some(AppUpdate::new(d.clone(), need, Then::Nothing, &devices, self.wake.clone()));
                            }
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
        if let Some(a) = self.update_ui(ui.ctx(), t) {
            action = Some(a);
        }
        if !self.unplaced.is_empty() {
            let targets: Vec<Device> = devices.iter().filter(|d| d.online && (!d.phone() || d.app_ready())).cloned().collect();
            let anchor = Rect::from_center_size(pane.center_top() + Vec2::new(0.0, 60.0), Vec2::new(10.0, 10.0));
            let n = self.unplaced.len();
            let mut chosen = None;
            let ((), close) = w::popover(ui.ctx(), "device-send-to", anchor, 260.0, false, t, |ui| {
                w::subtle(ui, format!("  Send {} to…", if n == 1 { "1 file".into() } else { format!("{n} files") }), "label-12");
                for d in &targets {
                    if w::menu_item(ui, d.icon(), &d.name, None, false).clicked() {
                        chosen = Some(d.clone());
                    }
                }
            });
            if let Some(d) = chosen {
                let files = std::mem::take(&mut self.unplaced);
                self.send(&d, files);
            } else if close {
                self.unplaced.clear();
            }
        }
        action
    }

    /// The "update the phone's app" dialog: a QR code for the APK this PC serves. Closes
    /// on Esc; once the phone reports the needed version (polled every few seconds, and once
    /// more after closing) it goes on with what was asked.
    fn update_ui(&mut self, ctx: &egui::Context, t: &Tokens) -> Option<Action> {
        let u = self.update.as_mut()?;
        let have = u.poll();
        if have >= u.need {
            let u = self.update.take()?;
            self.refresh();
            return match u.then {
                Then::View(control) => Some(Action::View { device: u.dev, control }),
                Then::ClipImage => {
                    self.pick(u.dev.key.clone(), Pick::ClipImage);
                    None
                }
                Then::Nothing => None,
            };
        }
        if u.closed {
            // one last check after closing; then it's dropped
            if u.last_check.elapsed() > Duration::from_secs(4) {
                self.update = None;
            }
            return None;
        }
        ctx.request_repaint_after(POLL_APP);
        let tex = u.qr.get_or_insert_with(|| qr_texture(ctx, &u.url)).clone();
        let modal = egui::Modal::new(Id::NULL.with("device-app-update"))
            .frame(
                egui::Frame::new()
                    .fill(t.bg100)
                    .stroke(Stroke::new(1.0, t.border()))
                    .corner_radius(CornerRadius::same(crate::theme::RADIUS_XL))
                    .inner_margin(Margin::same(24))
                    .shadow(ctx.global_style().visuals.window_shadow),
            )
            .show(ctx, |ui| {
                ui.set_width(380.0);
                w::text(ui, format!("Update {}'s app", u.dev.name), "heading-20");
                ui.add_space(6.0);
                let have = if have > 0 { format!("v{have}") } else { "an old version".into() };
                w::subtle(
                    ui,
                    format!("Your phone's Remote Devices app is out of date ({have}, needs v{}). Scan with the phone's camera to install the update.", u.need),
                    "copy-14",
                );
                ui.add_space(14.0);
                ui.vertical_centered(|ui| {
                    // white quiet zone around the code, whatever the theme
                    let side = 220.0;
                    let (r, _) = ui.allocate_exact_size(Vec2::splat(side), Sense::hover());
                    ui.painter().rect_filled(r, CornerRadius::same(RADIUS_MD), egui::Color32::WHITE);
                    ui.painter().image(tex.id(), r, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), egui::Color32::WHITE);
                });
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new(&u.url).text_style(crate::theme::ts("label-13")).monospace().color(t.fg()));
                    if w::btn(ic::COPY).muted().icon_sm().show(ui).on_hover_text("Copy the link").clicked() {
                        ui.ctx().copy_text(u.url.clone());
                    }
                });
                ui.add_space(6.0);
                ui.horizontal(|ui| {
                    let (r, _) = ui.allocate_exact_size(Vec2::splat(14.0), Sense::hover());
                    w::spinner(ui.painter(), r.center(), 5.0, t.subtle());
                    w::subtle(ui, "Waiting for the phone… it goes on by itself once updated.", "label-12");
                });
                ui.add_space(14.0);
                let mut anyway = false;
                let close = ui
                    .with_layout(Layout::right_to_left(Align::Min), |ui| {
                        let close = w::btn("Close").outline().show(ui).clicked();
                        // the screen works with the old app too; only newer features need the update
                        if matches!(u.then, Then::View(_)) {
                            anyway = w::btn("Connect anyway").ghost().show(ui).clicked();
                        }
                        close
                    })
                    .inner;
                (close, anyway)
            });
        let (close, anyway) = modal.inner;
        if anyway {
            let u = self.update.take()?;
            return match u.then {
                Then::View(control) => Some(Action::View { device: u.dev, control }),
                _ => None,
            };
        }
        if close || modal.should_close() {
            u.closed = true;
            u.check_now();
        }
        None
    }

    /// A row's Send menu (text or an image to the clipboard, files, images), and the
    /// text box for "Text to clipboard".
    fn send_menu_ui(&mut self, ui: &Ui, t: &Tokens) {
        if let Some((d, anchor)) = self.send_menu.clone() {
            let mut pick = None;
            let mut text = false;
            let mut update = None;
            let ((), close) = w::popover(ui.ctx(), "device-send-menu", anchor, 240.0, false, t, |ui| {
                w::subtle(ui, format!("  Send to {}", d.name), "label-12");
                if w::menu_item(ui, ic::CLIP, "Text to clipboard", None, false).clicked() {
                    text = true;
                }
                if w::menu_item(ui, ic::FILE, "File", None, false).clicked() {
                    pick = Some(Pick::Files);
                }
                let opens = if d.phone() { "Opens in the phone's photo app" } else { "Opens in the image viewer there" };
                if w::menu_item(ui, ic::IMAGE, "Image", None, false).on_hover_text(opens).clicked() {
                    pick = Some(Pick::Images);
                }
                let r = w::menu_item(ui, ic::FILE_IMAGE, "Image to clipboard", None, false);
                let r = if d.clip_image() { r } else { r.on_hover_text(PHONE_NO_CLIP_IMAGE) };
                if r.clicked() {
                    if d.clip_image() {
                        pick = Some(Pick::ClipImage);
                    } else {
                        update = Some(d.clone());
                    }
                }
            });
            if let Some(k) = pick {
                self.pick(d.key.clone(), k);
                self.send_menu = None;
            } else if let Some(dev) = update {
                let devices = self.listing.lock().unwrap().devices.clone();
                let need = PHONE_CLIP_IMAGE_APP.max(latest_app());
                self.update = Some(AppUpdate::new(dev, need, Then::ClipImage, &devices, self.wake.clone()));
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
                        if w::btn("Send").primary().sm().enabled(!text.is_empty()).show(ui).clicked() || (enter && !text.is_empty()) {
                            go = true;
                        }
                    });
                });
            });
            if go {
                send_clip(&d, Some(text), None, self.transfers.clone(), self.wake.clone());
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
    /// "Update app": the QR dialog for the phone's app.
    UpdateApp,
}

/// One device: icon with its online dot, name, details, and its actions on the right.
fn device_row(ui: &mut Ui, t: &Tokens, d: &Device, hovering: bool) -> (Option<RowAction>, Rect) {
    let h = 56.0;
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), h), Sense::hover());
    let p = ui.painter().clone();
    // By position, not by the row's response: the action buttons drawn over the row take
    // the hover, which would hide them again next frame (flicker).
    let hot = ui.rect_contains_pointer(rect);
    let target = d.online && (!d.phone() || d.app_ready());
    if hot {
        let fill = if hovering && target { w::alpha(t.blue(300), 0.5) } else { w::alpha(t.accent(), 0.6) };
        p.rect_filled(rect.shrink2(Vec2::new(0.0, 2.0)), CornerRadius::same(RADIUS_MD), fill);
    }
    let dim = !d.online;
    let fg = if dim { t.subtle() } else { t.fg() };
    // Leading column: a 32pt disc with the glyph centred, the status dot on its lower right.
    const LEAD: f32 = 32.0;
    let ic_c = pos2((rect.left() + 10.0 + LEAD / 2.0).round(), rect.center().y.round());
    p.circle_filled(ic_c, LEAD / 2.0, t.gray(200));
    ic::glyph(&p, ic_c, d.icon(), 16.0, fg);
    let dot = ic_c + Vec2::splat((LEAD / 2.0 * std::f32::consts::FRAC_1_SQRT_2).round());
    p.circle_filled(dot, 4.0, if d.online { t.green(800) } else { t.gray(600) });
    p.circle_stroke(dot, 4.0, Stroke::new(1.5, t.gray(200)));

    // Details: OS · IP · state.
    let mut bits = vec![d.os_label()];
    if !d.ip.is_empty() {
        bits.push(d.ip.clone());
    }
    if !d.online {
        bits.push("offline".into());
    } else if d.phone() {
        bits.push(match &d.app {
            None => "app not running".into(),
            Some(a) => {
                let mut s = format!("app v{}", a["app"].as_i64().unwrap_or(0));
                if a["sharing"].as_bool().unwrap_or(false) {
                    s.push_str(" · sharing");
                }
                if let Some(b) = a["battery"]["pct"].as_i64().or(a["battery"].as_i64()) {
                    s.push_str(&format!(" · {b}%"));
                }
                s
            }
        });
    } else if !d.controller.is_empty() {
        bits.push(format!("controlled by {}", d.controller));
    }
    let x = rect.left() + 10.0 + LEAD + 12.0;

    // Actions, right to left.
    let mut out = None;
    let mut right = rect.right() - 8.0;
    if let Some((have, apk)) = d.app_update() {
        // always shown, at the right edge (the hover buttons go left of it, so it never moves)
        let g = p.layout_no_wrap("Update app".into(), FontId::new(12.0, crate::theme::medium()), t.fg());
        let br = Rect::from_min_size(pos2(right - g.size().x - 18.0, rect.center().y - 11.0), Vec2::new(g.size().x + 18.0, 22.0));
        let r = ui.interact(br, Id::NULL.with(("device-update-app", &d.key)), Sense::click());
        p.rect_filled(br, CornerRadius::same(11), if r.hovered() { t.blue(400) } else { t.blue(300) });
        p.galley(br.center() - g.size() / 2.0, g, t.fg());
        if r.on_hover_cursor(CursorIcon::PointingHand).on_hover_text(format!("v{have} → v{apk}: scan a QR code with the phone to install it")).clicked() {
            out = Some(RowAction::UpdateApp);
        }
        right = br.left() - 8.0;
    }
    if d.online && hot {
        let mut buttons: Vec<(&str, &str, u8)> = vec![];
        // (a PC without Sunshine set up can't share its screen yet)
        if (!d.phone() || d.app_ready()) && d.sunshine != Some(false) {
            if d.can_control() {
                buttons.push((ic::MOUSE_POINTER, "Control", 0));
            }
            buttons.push((ic::EYE, "View", 1));
        }
        if !d.phone() || d.app_ready() {
            buttons.push((ic::SEND, "Send", 2));
        }
        if !d.phone() && !d.ssh_user.is_empty() {
            buttons.push((ic::FOLDER, "Files", 3));
            buttons.push((ic::TERMINAL, "Terminal", 4));
        }
        for (icon, tip, k) in buttons {
            let br = Rect::from_center_size(pos2(right - 14.0, rect.center().y), Vec2::splat(28.0));
            right -= 32.0;
            let r = ui.interact(br, Id::NULL.with(("device-act", &d.key, k)), Sense::click());
            if r.hovered() {
                p.rect_filled(br, CornerRadius::same(RADIUS_MD), t.gray(300));
            }
            ic::glyph(&p, br.center(), icon, 15.0, if r.hovered() { t.fg() } else { t.subtle() });
            if r.on_hover_cursor(CursorIcon::PointingHand).on_hover_text(tip).clicked() {
                out = Some(match k {
                    0 => RowAction::Do(Action::View { device: d.clone(), control: true }),
                    1 => RowAction::Do(Action::View { device: d.clone(), control: false }),
                    2 => RowAction::Send(br),
                    3 => RowAction::Do(Action::Files(d.clone())),
                    _ => RowAction::Do(Action::Terminal { title: d.name.clone(), argv: vec!["ssh".into(), d.target()] }),
                });
            }
        }
    }
    if d.me && !(d.online && hot) {
        let g = p.layout_no_wrap("This PC".into(), FontId::new(12.0, crate::theme::medium()), t.subtle());
        let br = Rect::from_min_size(pos2(right - g.size().x - 14.0, rect.center().y - 10.0), Vec2::new(g.size().x + 14.0, 20.0));
        p.rect_filled(br, CornerRadius::same(10), t.gray(200));
        p.galley(br.center() - g.size() / 2.0, g, t.subtle());
        right = br.left() - 8.0;
    }
    let max_w = (right - x - 8.0).max(40.0);
    let name = w::truncated(ui, &d.name, FontId::new(14.0, crate::theme::medium()), fg, max_w);
    p.galley(pos2(x, rect.center().y - 17.0), name, fg);
    let sub = w::truncated(ui, &bits.join(" · "), FontId::proportional(12.5), t.subtle(), max_w);
    p.galley(pos2(x, rect.center().y + 2.0), sub, t.subtle());
    (out, rect)
}

// ---------------------------------------------------------------- phone app updates

/// How often the update dialog asks the phone for its app version.
const POLL_APP: Duration = Duration::from_secs(3);
/// Remote Devices serves its phone app here (`GET /app.apk` on its message endpoint).
const APK_PORT: u16 = 47880;

/// The app version Remote Devices ships (`android/app/VERSION` next to remote-pcs.py);
/// 0 when unknown (then nothing counts as outdated).
fn latest_app() -> i64 {
    let Some(dir) = script().and_then(|p| p.canonicalize().ok()).and_then(|p| p.parent().map(Path::to_path_buf)) else { return 0 };
    std::fs::read_to_string(dir.join("android/app/VERSION")).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(0)
}

/// A phone whose app runs but is older than `need`: its version (0 = unknown).
fn outdated(d: &Device, need: i64) -> Option<i64> {
    let have = d.app.as_ref()?["app"].as_i64().unwrap_or(0);
    (d.phone() && have < need).then_some(have)
}

/// What to do once the phone's app is new enough.
enum Then {
    View(bool),
    ClipImage,
    /// Just the update ("Update app" on the row).
    Nothing,
}

struct AppUpdate {
    dev: Device,
    need: i64,
    then: Then,
    url: String,
    qr: Option<egui::TextureHandle>,
    /// The phone's app version from its status port (polled off the UI thread).
    seen: Arc<Mutex<i64>>,
    last_check: Instant,
    closed: bool,
    wake: Wake,
}

impl AppUpdate {
    fn new(dev: Device, need: i64, then: Then, devices: &[Device], wake: Wake) -> Self {
        // This PC's address: the phone reaches it whatever its DNS does.
        let host = devices.iter().find(|d| d.me && !d.ip.is_empty()).map(|d| d.ip.clone()).unwrap_or_else(|| {
            crate::tls::lan_addrs().into_iter().find(|a| a.is_ipv4()).map(|a| a.to_string()).unwrap_or_else(|| "localhost".into())
        });
        let have = dev.app.as_ref().and_then(|a| a["app"].as_i64()).unwrap_or(0);
        let mut u = Self {
            url: format!("http://{host}:{APK_PORT}/app.apk"),
            dev,
            need,
            then,
            qr: None,
            seen: Arc::new(Mutex::new(have)),
            last_check: Instant::now(),
            closed: false,
            wake,
        };
        u.last_check = Instant::now() - POLL_APP; // ask at once
        u
    }

    /// The newest version seen; starts a check every POLL_APP.
    fn poll(&mut self) -> i64 {
        if !self.closed && self.last_check.elapsed() >= POLL_APP {
            self.check_now();
        }
        *self.seen.lock().unwrap()
    }

    fn check_now(&mut self) {
        self.last_check = Instant::now();
        let (ip, seen, wake) = (self.dev.ip.clone(), self.seen.clone(), self.wake.clone());
        std::thread::spawn(move || {
            if let Some(v) = app_version(&ip) {
                let mut s = seen.lock().unwrap();
                if v != *s {
                    *s = v;
                    drop(s);
                    wake();
                }
            }
        });
    }
}

/// The phone app's version from its status port (one JSON line; never disturbs a viewer).
fn app_version(ip: &str) -> Option<i64> {
    let addr = format!("{ip}:47887").parse().ok()?;
    let mut s = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut line = String::new();
    BufReader::new(&mut s).read_line(&mut line).ok()?;
    serde_json::from_str::<Value>(&line).ok()?["app"].as_i64()
}

fn qr_texture(ctx: &egui::Context, text: &str) -> egui::TextureHandle {
    ctx.load_texture("device-app-qr", qr_image(text), egui::TextureOptions::NEAREST)
}

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
            if list.iter().any(|x| x.done || x.error.is_some()) && w::btn("Clear").ghost().sm().show(ui).clicked() {
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
                } else {
                    w::meter(ui, if x.size > 0 { x.sent as f32 / x.size as f32 } else { 0.0 }, (width - 8.0).min(320.0));
                    w::subtle(ui, format!("{} of {}", human(x.sent), human(x.size)), "label-12");
                }
            });
        });
        ui.add_space(6.0);
    }
}

/// `--send-json`: one Transfer per file, updated from its JSON lines.
fn send_files(dev: &Device, files: Vec<PathBuf>, transfers: Arc<Mutex<Vec<Transfer>>>, wake: Wake) {
    let (key, name) = (dev.key.clone(), dev.name.clone());
    std::thread::spawn(move || {
        let base = {
            let mut l = transfers.lock().unwrap();
            let base = l.len();
            for f in &files {
                let size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
                let n = f.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                l.push(Transfer { label: format!("{n} → {name}"), size, ..Default::default() });
            }
            base
        };
        wake();
        let mut args: Vec<String> = vec!["--send-json".into(), key];
        args.extend(files.iter().map(|f| f.to_string_lossy().into_owned()));
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let child = rd(&refs).and_then(|mut c| c.stdout(Stdio::piped()).spawn().map_err(|e| e.to_string()));
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                for x in transfers.lock().unwrap()[base..].iter_mut() {
                    x.error = Some(e.clone());
                }
                wake();
                return;
            }
        };
        let mut cur = 0usize;
        let mut finished = false;
        for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let mut l = transfers.lock().unwrap();
            match v["event"].as_str() {
                Some("file") => {
                    cur = v["i"].as_u64().unwrap_or(0) as usize;
                    for x in l[base..base + cur.min(files.len())].iter_mut() {
                        x.done = true;
                        x.sent = x.size;
                    }
                }
                Some("progress") => {
                    if let Some(x) = l.get_mut(base + v["i"].as_u64().unwrap_or(0) as usize) {
                        x.sent = v["sent"].as_u64().unwrap_or(0);
                        x.size = v["size"].as_u64().unwrap_or(x.size);
                    }
                }
                Some("done") => {
                    finished = true;
                    for x in l[base..].iter_mut() {
                        x.done = true;
                        x.sent = x.size;
                    }
                }
                Some("error") => {
                    finished = true;
                    let e = v["error"].as_str().unwrap_or("failed").to_string();
                    for x in l[base + cur..].iter_mut().filter(|x| !x.done) {
                        x.error = Some(e.clone());
                    }
                }
                _ => {}
            }
            drop(l);
            wake();
        }
        let _ = child.wait();
        if !finished {
            for x in transfers.lock().unwrap()[base..].iter_mut().filter(|x| !x.done && x.error.is_none()) {
                x.error = Some("Remote Devices stopped unexpectedly".into());
            }
        }
        wake();
    });
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

/// Lists a folder on the device (python3 is on every PC Remote Devices runs on).
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
    pub fn new(dev: Device, path: Option<String>, wake: impl Fn() + Send + Sync + 'static) -> Self {
        let (tx, rx) = channel();
        let mut f = Self {
            dev,
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
        c.args(ssh_opts()).arg(self.dev.target()).stdin(Stdio::null()).stderr(Stdio::piped());
        c
    }

    fn list(&mut self, path: String) {
        self.loading = true;
        let mut c = self.ssh();
        c.args(["python3", "-c", &quote(LS_PY), &quote(&path)]);
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
        c.args(["cat", "--", &quote(&remote)]).stdout(Stdio::piped());
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
            c.arg(format!("cat > {p} && mv -f {p} {d}", p = quote(&format!("{dest}.part")), d = quote(&dest))).stdin(Stdio::piped()).stdout(Stdio::null());
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
        base.join("harbor/devices").join(&self.dev.key).join(format!("{:016x}.{ext}", h.finish()))
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
                if w::btn(ic::ARROW_LEFT).muted().icon_sm().enabled(!self.history.is_empty()).show(ui).on_hover_text("Back").clicked() {
                    if let Some(p) = self.history.pop() {
                        self.list(p);
                    }
                }
                if w::btn(ic::CORNER_LEFT_UP).muted().icon_sm().enabled(self.path != "/").show(ui).on_hover_text("Up").clicked() {
                    if let Some(p) = self.parent() {
                        self.go(p);
                    }
                }
                if w::btn(ic::HOUSE).muted().icon_sm().show(ui).on_hover_text("Home").clicked() {
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
                    if w::btn(ic::REFRESH).muted().icon_sm().enabled(!self.loading).show(ui).on_hover_text("Refresh").clicked() {
                        let p = self.path.clone();
                        self.list(p);
                    }
                    if w::btn(ic::UPLOAD).muted().icon_sm().show(ui).on_hover_text("Upload files here").clicked() {
                        let (picked, wake) = (self.picked.clone(), self.wake.clone());
                        std::thread::spawn(move || {
                            if let Ok(o) = Command::new("zenity").args(["--file-selection", "--multiple", "--separator=\n", "--title=Upload files"]).output() {
                                let files: Vec<PathBuf> = String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect();
                                picked.lock().unwrap().extend(files);
                                wake();
                            }
                        });
                    }
                    let (icon, tip) = if self.show_hidden { (ic::EYE, "Hide hidden files") } else { (ic::EYE_OFF, "Show hidden files") };
                    if w::btn(icon).muted().icon_sm().pressed(self.show_hidden).show(ui).on_hover_text(tip).clicked() {
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
                                ic::glyph(&p, lead.center(), icon, 15.0, if e.dir { t.blue(900) } else { t.subtle() });
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
                            if r.on_hover_text("Download to Downloads").clicked() {
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

// ---------------------------------------------------------------- screen view

/// A device's screen in a tab. `remote-pcs.py --prepare-view` gets its sharing going
/// (Sunshine through the agent, or the phone app's screen sharing) and says where to
/// connect; the stream itself (helper, decoding, input, its toolbar) is crate::stream's.
pub struct View {
    pub dev: Device,
    pub control: bool,
    prep: Option<Receiver<Result<Value, String>>>,
    error: Option<String>,
    wake: Wake,
    stream: Option<crate::stream::Stream>,
    /// When the view was last drawn: a stream nobody sees for [`PARK_AFTER`] is ended.
    drawn: Instant,
    /// Its stream was ended while hidden: reconnect when it is shown again.
    parked: bool,
}

/// How long a device screen may stay out of sight (another tab, a hidden pane) before
/// its stream ends: the phone or PC stops encoding, this PC stops decoding, and the
/// heartbeats stop. Quick tab switches keep it.
const PARK_AFTER: Duration = Duration::from_secs(15);

pub enum ViewAction {
    Close,
    /// The stream helper isn't built: build it in a terminal.
    Build(PathBuf),
}

impl View {
    pub fn new(dev: Device, control: bool, wake: impl Fn() + Send + Sync + 'static) -> Self {
        let mut v = Self { dev, control, prep: None, error: None, wake: Arc::new(wake), stream: None, drawn: Instant::now(), parked: false };
        v.prepare();
        v
    }

    /// Ends the stream if the view hasn't been drawn for a while (called every frame,
    /// drawn or not). It comes back by itself when the view is shown again.
    pub fn park_if_hidden(&mut self) {
        if self.stream.is_some() && self.drawn.elapsed() > PARK_AFTER {
            self.stream = None;
            self.parked = true;
        }
    }

    pub fn title(&self) -> String {
        self.dev.name.clone()
    }

    pub fn icon(&self) -> &'static str {
        if self.control { ic::MOUSE_POINTER } else { ic::EYE }
    }

    fn prepare(&mut self) {
        self.error = None;
        self.stream = None;
        // Don't start anyone's screen sharing for a client that can't run.
        if crate::stream::helper_path().is_none() {
            self.prep = None;
            return;
        }
        let (tx, rx) = channel();
        self.prep = Some(rx);
        let mode = if self.control { "control" } else { "view" };
        let key = self.dev.key.clone();
        let wake = self.wake.clone();
        std::thread::spawn(move || {
            let r = rd(&["--prepare-view", &key, mode, "--once"]).and_then(|mut c| c.output().map_err(|e| e.to_string())).and_then(|o| {
                let text = String::from_utf8_lossy(&o.stdout);
                let v: Value = text.lines().rev().find_map(|l| serde_json::from_str(l).ok()).ok_or("Remote Devices gave no answer")?;
                if v["ok"].as_bool() == Some(true) { Ok(v) } else { Err(v["error"].as_str().unwrap_or("couldn't start screen sharing").to_string()) }
            });
            let _ = tx.send(r);
            wake();
        });
    }

    pub fn ui(&mut self, ui: &mut Ui, t: &Tokens, id: Id) -> Option<ViewAction> {
        self.drawn = Instant::now();
        if std::mem::take(&mut self.parked) {
            self.prepare();
        }
        if let Some(Ok(r)) = self.prep.as_ref().map(|rx| rx.try_recv()) {
            self.prep = None;
            match r.and_then(|v| {
                let wake = self.wake.clone();
                crate::stream::Stream::spawn(v, move || wake())
            }) {
                Ok(s) => self.stream = Some(s),
                Err(e) => self.error = Some(e),
            }
        }
        if let Some(s) = &mut self.stream {
            self.control = s.control();
            return match s.ui(ui, t, id) {
                Some(crate::stream::Action::Disconnect) => Some(ViewAction::Close),
                Some(crate::stream::Action::Reconnect) => {
                    self.prepare();
                    None
                }
                None => None,
            };
        }
        // ---- before the stream: starting, an error, or no helper yet
        let mut out = None;
        ui.add_space((ui.available_height() * 0.35 - 40.0).max(20.0));
        ui.vertical_centered(|ui| {
            ui.label(egui::RichText::new(self.dev.icon()).size(26.0).color(t.subtle()));
            ui.add_space(4.0);
            w::text(ui, &self.dev.name, "heading-16");
            ui.add_space(8.0);
            if self.prep.is_some() {
                let (r, _) = ui.allocate_exact_size(Vec2::splat(22.0), Sense::hover());
                w::spinner(ui.painter(), r.center(), 9.0, t.subtle());
                ui.ctx().request_repaint_after(Duration::from_millis(80));
                ui.add_space(6.0);
                w::subtle(ui, format!("Starting screen sharing on {}…", self.dev.name), "label-13");
            } else if crate::stream::helper_path().is_none() {
                w::subtle(ui, "The stream viewer (harbor-stream) isn't built yet.", "label-13");
                ui.add_space(10.0);
                if let Some(dir) = crate::stream::source_dir() {
                    if w::btn("Build it").outline().sm().show(ui).clicked() {
                        out = Some(ViewAction::Build(dir));
                    }
                    if w::btn("Try again").ghost().sm().show(ui).clicked() {
                        self.prepare();
                    }
                }
            } else if let Some(e) = &self.error {
                ui.label(egui::RichText::new(e).text_style(crate::theme::ts("label-13")).color(t.red(900)));
                ui.add_space(10.0);
                if w::btn("Try again").outline().sm().show(ui).clicked() {
                    self.prepare();
                }
            }
            ui.add_space(6.0);
            if w::btn("Close").ghost().sm().show(ui).clicked() {
                out = Some(ViewAction::Close);
            }
        });
        out
    }
}

/// For hot reload: what a device tab needs to come back.
pub fn device_json(d: &Device) -> Value {
    serde_json::json!({ "key": d.key, "name": d.name, "kind": d.kind, "online": d.online, "ip": d.ip, "os": d.os, "ssh_user": d.ssh_user, "me": d.me })
}

pub fn device_from(v: &Value) -> Device {
    Device::from_json(v)
}
