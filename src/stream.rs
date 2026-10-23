//! Remote screens (phones, PCs) inside a pane. The stream runs in the separate
//! `harbor-stream` process (crate stream/), which connects, decodes the video and
//! writes RGBA frames to a private folder in RAM (`run_dir`); input goes back as JSON on its stdin. Starting
//! and ending sessions is Remote Devices' job (`remote-pcs.py --prepare-view`):
//! what it prints is handed to the helper as is.
//!
//! Frames flow one at a time: the helper writes the next frame only after "got",
//! so a busy UI costs it nothing and never reads a half-written file.

use crate::theme::Tokens;
use crate::widgets as w;
use crate::icons as ic;
use eframe::egui::{self, Color32, ColorImage, CursorIcon, Id, Key, Pos2, Rect, Sense, Stroke, TextureHandle, TextureOptions, Ui, Vec2, pos2, vec2};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, channel};

/// Where the helper binary is: $HARBOR_STREAM, next to harbor, or the source tree's build.
pub fn helper_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HARBOR_STREAM") {
        return Some(PathBuf::from(p)).filter(|p| p.is_file());
    }
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let dir = exe.parent()?;
    [dir.join("harbor-stream"), dir.join("../../stream/target/release/harbor-stream")]
        .into_iter()
        .find(|p| p.is_file())
}

/// Folder of the helper's source, for "Build".
pub fn source_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    Some(exe.parent()?.join("../../stream")).filter(|p| p.join("Cargo.toml").is_file()).and_then(|p| p.canonicalize().ok())
}

pub enum Action {
    /// The user closed it (the helper is already told to quit).
    Disconnect,
    /// After an error: run prepare again and spawn a new one.
    Reconnect,
}

pub struct Stream {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    rx: Receiver<Value>,
    frames: String,
    tex: Option<TextureHandle>,
    /// RGBA frames are read into this (kept, so a frame costs no allocation)
    rgba: Vec<u8>,
    /// YUV frames, drawn by a shader (when the GL here can; else RGBA in `tex`)
    yuv: crate::yuv::Video,
    yuv_on: bool,
    /// the newest frame was YUV (draw `yuv`, not `tex`)
    last_yuv: bool,
    /// Video size (the device's, not the scaled frame's): the aspect ratio.
    video: (u32, u32),
    pub name: String,
    /// Phones have back/home/recents; PCs don't.
    phone: bool,
    /// Input is possible at all (the phone app's Control is on; PCs: always).
    can_control: bool,
    control: bool,
    status: Option<String>,
    error: Option<String>,
    closed: bool,
    stats: String,
    fit: (u32, u32),
    pressed: bool,
    /// keys sent down: a release is only sent for these (Ctrl+V's V comes down as a
    /// Paste, from clipboard.rs, and its lone release must not reach the device)
    keys_down: std::collections::HashSet<String>,
    /// Draw the toolbar (phone buttons, stats, disconnect). Off when the host pane
    /// has its own header for those. View/control is picked when opening the screen.
    pub toolbar: bool,
}

impl Drop for Stream {
    fn drop(&mut self) {
        // quit + EOF: the helper ends its session cleanly (PCs: releases held keys and
        // runs the agent's stop, which clears the host's pill); killed only if it hangs
        if let Some(mut stdin) = self.stdin.take() {
            let _ = writeln!(stdin, "{}", json!({ "t": "quit" }));
        }
        let (child, frames) = (self.child.take(), self.frames.clone());
        std::thread::spawn(move || {
            if let Some(mut child) = child {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while std::time::Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
            for b in 0..2 {
                let _ = std::fs::remove_file(format!("{frames}.{b}"));
            }
        });
    }
}

impl Stream {
    /// Start the helper with what `remote-pcs.py --prepare-view` printed.
    pub fn spawn(info: Value, wake: impl Fn() + Send + 'static) -> Result<Self, String> {
        if info["ok"].as_bool() == Some(false) {
            return Err(info["error"].as_str().unwrap_or("couldn't prepare the device").into());
        }
        let bin = helper_path().ok_or("harbor-stream isn't built (cd stream && cargo build --release)")?;
        static N: AtomicU32 = AtomicU32::new(0);
        if N.load(Ordering::Relaxed) == 0 {
            sweep_stale_frames();
        }
        let frames = run_dir().join(format!("stream-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))).to_string_lossy().into_owned();
        let mut child = Command::new(bin)
            .args([&frames, &info.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if tx.send(v).is_err() {
                        break;
                    }
                    wake();
                }
            }
            wake(); // exited
        });
        let mut stdin = stdin;
        let _ = writeln!(stdin, "{}", json!({ "t": "formats", "yuv": true }));
        let phone = info["backend"].as_str().unwrap_or("scrcpy") == "scrcpy";
        let can_control = info["control"].as_bool().unwrap_or(!phone);
        Ok(Self {
            child: Some(child),
            stdin: Some(stdin),
            rx,
            frames,
            tex: None,
            rgba: Vec::new(),
            yuv: Default::default(),
            yuv_on: true,
            last_yuv: false,
            video: (0, 0),
            name: info["name"].as_str().unwrap_or("Device").into(),
            phone,
            can_control,
            control: can_control && info["mode"].as_str() == Some("control"),
            status: Some("Connecting…".into()),
            error: None,
            closed: false,
            stats: String::new(),
            fit: (0, 0),
            pressed: false,
            keys_down: Default::default(),
            toolbar: true,
        })
    }

    fn send(&mut self, v: Value) {
        if let Some(stdin) = &mut self.stdin {
            let _ = writeln!(stdin, "{v}");
        }
    }

    fn running(&mut self) -> bool {
        self.child.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)))
    }

    pub fn alive(&mut self) -> bool {
        !self.closed && self.running()
    }

    /// In control (input goes to the device)?
    pub fn control(&self) -> bool {
        self.control
    }

    pub fn can_control(&self) -> bool {
        self.can_control
    }

    /// "Connecting…" or the error it ended with; None while streaming.
    pub fn status(&self) -> Option<String> {
        self.error.clone().or_else(|| self.status.clone())
    }

    /// "60 fps · 3 ms", empty until the first stats.
    pub fn stats(&self) -> &str {
        &self.stats
    }

    /// A device button: back | home | recents | notifications | power | volume_up | volume_down.
    pub fn press(&mut self, name: &str) {
        if self.control {
            self.send(json!({ "t": "button", "name": name }));
        }
    }

    fn poll(&mut self, ctx: &egui::Context) {
        let mut newest = None;
        while let Ok(v) = self.rx.try_recv() {
            match v["t"].as_str().unwrap_or("") {
                "frame" => newest = Some(v),
                "status" => self.status = v["text"].as_str().or(v["msg"].as_str()).map(String::from),
                "ready" => {
                    self.video = (v["w"].as_u64().unwrap_or(0) as u32, v["h"].as_u64().unwrap_or(0) as u32);
                    if let Some(n) = v["name"].as_str() {
                        self.name = n.into();
                    }
                    if let Some(c) = v["control"].as_bool() {
                        self.can_control = c;
                        self.control &= c;
                    }
                    self.status = None;
                }
                "host" => {
                    // PCs: someone else took control (or gave it back)
                    if let Some(c) = v["you_control"].as_bool() {
                        self.control = c && self.can_control;
                    }
                }
                "stats" => {
                    self.stats = format!("{:.0} fps · {:.0} ms", v["fps"].as_f64().unwrap_or(0.0), v["decode_ms"].as_f64().unwrap_or(0.0));
                }
                "error" => self.error = v["msg"].as_str().map(String::from),
                "closed" => {
                    self.closed = true;
                    if let Some(r) = v["reason"].as_str() {
                        self.error = Some(r.into());
                    }
                }
                _ => {}
            }
        }
        if let Some(v) = newest {
            let (fw, fh) = (v["w"].as_u64().unwrap_or(0) as usize, v["h"].as_u64().unwrap_or(0) as usize);
            let path = format!("{}.{}", self.frames, v["buf"].as_u64().unwrap_or(0));
            let fmt = v["fmt"].as_str().unwrap_or("rgba");
            if fmt != "rgba" {
                let mut bytes = self.yuv.buffer();
                if read_into(&path, &mut bytes)
                    && fw > 0
                {
                    if self.video == (0, 0) {
                        self.video = (fw as u32, fh as u32);
                    }
                    self.yuv.set(crate::yuv::Planes {
                        nv12: fmt == "nv12",
                        w: fw as u32,
                        h: fh as u32,
                        bt709: v["cs"].as_str() == Some("bt709"),
                        full_range: v["range"].as_str() == Some("full"),
                        bytes,
                    });
                    self.last_yuv = true;
                }
            } else if read_into(&path, &mut self.rgba)
                && self.rgba.len() == fw * fh * 4
                && fw > 0
            {
                self.last_yuv = false;
                if self.video == (0, 0) {
                    self.video = (fw as u32, fh as u32);
                }
                // opaque video: premultiplied = straight, no per-pixel conversion
                let img = ColorImage::from_rgba_premultiplied([fw, fh], &self.rgba);
                match &mut self.tex {
                    Some(t) => t.set(img, TextureOptions::LINEAR),
                    None => self.tex = Some(ctx.load_texture("device-screen", img, TextureOptions::LINEAR)),
                }
            }
            self.send(json!({ "t": "got" }));
        }
        if self.yuv_on && self.yuv.failed() {
            // no shader here (old GL): RGBA from now on
            self.yuv_on = false;
            self.last_yuv = false;
            self.send(json!({ "t": "formats", "yuv": false }));
        }
        if !self.closed && !self.running() {
            self.closed = true;
            self.error.get_or_insert_with(|| "the stream ended".into());
        }
    }

    /// Toolbar and screen. Returns what the host pane should do.
    pub fn ui(&mut self, ui: &mut Ui, t: &Tokens, id: Id) -> Option<Action> {
        self.poll(ui.ctx());
        let mut action = None;
        if self.toolbar {
            egui::Frame::new().inner_margin(egui::Margin::symmetric(8, 6)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 2.0;
                    if self.phone {
                        for (name, tip) in [("back", "Back"), ("home", "Home"), ("recents", "Recent apps")] {
                            let r = w::btn("").muted().icon_sm().enabled(self.control).show(ui).on_hover_text(tip);
                            nav_glyph(ui, r.rect, name, if self.control { t.fg() } else { t.gray(600) });
                            if r.clicked() {
                                self.press(name);
                            }
                        }
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if w::btn(ic::X).muted().icon_sm().show(ui).on_hover_text("Disconnect").clicked() {
                            action = Some(Action::Disconnect);
                        }
                        if !self.stats.is_empty() {
                            w::subtle(ui, &self.stats, "label-12");
                        }
                    });
                });
            });
        }

        let (_, area) = ui.allocate_space(ui.available_size());
        let painter = ui.painter_at(area);
        painter.rect_filled(area, 0.0, t.bg100);
        let screen = fit_rect(area.shrink(8.0), self.video);
        let ppp = ui.ctx().pixels_per_point();
        if let Some(r) = screen {
            let want = ((r.width() * ppp).round() as u32, (r.height() * ppp).round() as u32);
            if want != self.fit && want.0 > 16 && want.1 > 16 {
                self.fit = want;
                self.send(json!({ "t": "size", "w": want.0, "h": want.1 }));
            }
        }
        match (&self.tex, screen) {
            (_, Some(r)) if self.last_yuv && self.yuv.has_frame() => {
                painter.rect_filled(r.expand(1.0), 4.0, Color32::BLACK);
                self.yuv.paint(&painter, r);
            }
            (Some(tex), Some(r)) => {
                painter.rect_filled(r.expand(1.0), 4.0, Color32::BLACK);
                painter.image(tex.id(), r, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), Color32::WHITE);
            }
            _ => {}
        }
        if let Some(msg) = self.status().filter(|_| self.closed || (self.tex.is_none() && !self.yuv.has_frame())) {
            let mut child = ui.new_child(egui::UiBuilder::new().max_rect(area.shrink(24.0)));
            child.add_space(area.height() * 0.3);
            child.vertical_centered(|ui| {
                ui.label(egui::RichText::new(if self.phone { ic::SMARTPHONE } else { ic::MONITOR }).size(28.0).color(t.subtle()));
                w::text(ui, &self.name, "heading-16");
                w::subtle(ui, &msg, "label-13");
                if self.closed {
                    ui.add_space(10.0);
                    if w::btn(&format!("{}  Reconnect", ic::ROTATE_CW)).outline().show(ui).clicked() {
                        action = Some(Action::Reconnect);
                    }
                }
            });
            return action;
        }
        let Some(screen) = screen else { return action };
        let resp = ui.interact(area, id, Sense::click_and_drag());
        if !self.control {
            return action;
        }
        if resp.hovered() && ui.input(|i| i.pointer.hover_pos()).is_some_and(|p| screen.contains(p)) {
            // PCs draw their own cursor into the video: ours would be a second one
            ui.ctx().set_cursor_icon(if self.phone { CursorIcon::PointingHand } else { CursorIcon::None });
        }
        if resp.clicked() || resp.drag_started() || resp.is_pointer_button_down_on() {
            resp.request_focus();
        }
        let focused = resp.has_focus();
        if focused {
            ui.memory_mut(|m| m.set_focus_lock_filter(id, egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: true }));
        }
        self.forward_input(ui, screen, resp.hovered() || self.pressed, focused);
        action
    }

    fn forward_input(&mut self, ui: &Ui, screen: Rect, hovered: bool, focused: bool) {
        let events = ui.input(|i| i.events.clone());
        let norm = |p: Pos2| ((p.x - screen.left()) / screen.width(), (p.y - screen.top()) / screen.height());
        for e in events {
            match e {
                egui::Event::PointerMoved(p) if self.pressed || (hovered && screen.contains(p) && !self.phone) => {
                    let (x, y) = norm(p);
                    self.send(json!({ "t": "pointer", "x": x, "y": y, "down": null, "button": 0 }));
                }
                egui::Event::PointerButton { pos, button, pressed, .. } => {
                    let b = match button {
                        egui::PointerButton::Primary => 0,
                        egui::PointerButton::Secondary => 1,
                        egui::PointerButton::Middle => 2,
                        _ => continue,
                    };
                    if pressed && !(hovered && screen.contains(pos)) {
                        continue;
                    }
                    if b == 0 {
                        if !pressed && !self.pressed {
                            continue;
                        }
                        self.pressed = pressed;
                    }
                    let (x, y) = norm(pos);
                    self.send(json!({ "t": "pointer", "x": x, "y": y, "down": pressed, "button": b }));
                }
                egui::Event::MouseWheel { delta, unit, .. } if hovered => {
                    // in lines (a notch); touchpads come in points
                    let k = match unit {
                        egui::MouseWheelUnit::Point => 1.0 / 50.0,
                        egui::MouseWheelUnit::Line => 1.0,
                        egui::MouseWheelUnit::Page => 10.0,
                    };
                    let pos = ui.input(|i| i.pointer.hover_pos()).unwrap_or(screen.center());
                    let (x, y) = norm(pos);
                    self.send(json!({ "t": "wheel", "x": x, "y": y, "dx": delta.x * k, "dy": delta.y * k }));
                }
                egui::Event::Text(text) if focused => self.send(json!({ "t": "text", "text": text })),
                egui::Event::Paste(text) if focused => self.send(json!({ "t": "text", "text": text, "paste": true })),
                egui::Event::Copy | egui::Event::Cut if focused => {
                    let k = if matches!(e, egui::Event::Copy) { "c" } else { "x" };
                    for down in [true, false] {
                        self.send(json!({ "t": "key", "key": k, "code": k.to_uppercase(), "down": down, "ctrl": true }));
                    }
                }
                egui::Event::Key { key, physical_key, pressed, modifiers, .. } if focused => {
                    let named = match key {
                        Key::Enter => Some("Enter"),
                        Key::Backspace => Some("Backspace"),
                        Key::Tab => Some("Tab"),
                        Key::Escape => Some("Escape"),
                        Key::ArrowUp => Some("ArrowUp"),
                        Key::ArrowDown => Some("ArrowDown"),
                        Key::ArrowLeft => Some("ArrowLeft"),
                        Key::ArrowRight => Some("ArrowRight"),
                        Key::Home => Some("Home"),
                        Key::End => Some("End"),
                        Key::PageUp => Some("PageUp"),
                        Key::PageDown => Some("PageDown"),
                        Key::Delete => Some("Delete"),
                        Key::Insert => Some("Insert"),
                        _ => None,
                    };
                    // Shortcuts (Ctrl+A…) come as keys without text; PCs want every key.
                    let shortcut = (modifiers.ctrl || modifiers.command || modifiers.alt) && key.name().len() == 1;
                    let name = match (named, shortcut || !self.phone) {
                        (Some(n), _) => n.to_string(),
                        (None, true) => key.name().to_lowercase(),
                        _ => continue,
                    };
                    let code = physical_key.unwrap_or(key).name();
                    if pressed {
                        self.keys_down.insert(name.clone());
                    } else if !self.keys_down.remove(&name) {
                        continue;
                    }
                    self.send(json!({
                        "t": "key", "key": name, "code": code, "down": pressed,
                        "ctrl": modifiers.ctrl, "shift": modifiers.shift, "alt": modifiers.alt, "meta": modifiers.mac_cmd,
                    }));
                }
                _ => {}
            }
        }
    }
}

/// A frame file into `buf` (cleared first; its capacity is reused).
fn read_into(path: &str, buf: &mut Vec<u8>) -> bool {
    use std::io::Read;
    buf.clear();
    std::fs::File::open(path).and_then(|mut f| f.read_to_end(buf)).is_ok()
}

/// Frame files left by a Harbor that didn't close its streams (crash, kill): in
/// `run_dir` ("<kind>-<pid>…"), and in /dev/shm from versions that wrote there.
fn sweep_stale_frames() {
    let mine = std::fs::read_dir(run_dir()).into_iter().flatten().flatten().map(|e| (e.path(), e.file_name().to_string_lossy().split(['-', '.']).nth(1).map(String::from)));
    let old = std::fs::read_dir("/dev/shm").into_iter().flatten().flatten().map(|e| {
        let pid = e.file_name().to_string_lossy().strip_prefix("harbor-stream-").and_then(|r| r.split('-').next()).map(String::from);
        (e.path(), pid)
    });
    for (path, pid) in mine.chain(old) {
        if let Some(pid) = pid.filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            && !std::path::Path::new("/proc").join(pid).exists()
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// A folder only this user can open, in RAM, for frames and other short-lived files:
/// `$XDG_RUNTIME_DIR/harbor` (else /dev/shm/harbor-<uid>), mode 0700. Frame files in a
/// shared /dev/shm would be readable by other accounts (a live view of the device).
pub fn run_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        let uid = std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(u32::MAX);
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_absolute() && p.is_dir());
        let base = runtime.clone().unwrap_or_else(|| PathBuf::from("/dev/shm"));
        let ours = |p: &std::path::Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && m.uid() == uid);
        let mut dir = base.join(if runtime.is_some() { "harbor".to_string() } else { format!("harbor-{uid}") });
        let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
        // Someone else's (made first, in a shared folder): a fresh one with an unguessable name.
        let mut n = 0u64;
        while !ours(&dir) && n < 100 {
            let r = std::hash::BuildHasher::hash_one(&std::collections::hash_map::RandomState::new(), (std::time::SystemTime::now(), n));
            dir = base.join(format!("harbor-{uid}-{r:016x}"));
            let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
            n += 1;
        }
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        dir
    })
    .clone()
}

/// The largest rect of the video's aspect ratio inside `area`, centred.
fn fit_rect(area: Rect, (w, h): (u32, u32)) -> Option<Rect> {
    if w == 0 || h == 0 || area.width() < 8.0 || area.height() < 8.0 {
        return None;
    }
    let k = (area.width() / w as f32).min(area.height() / h as f32);
    Some(Rect::from_center_size(area.center(), vec2(w as f32 * k, h as f32 * k)))
}

/// Android's navigation glyphs (◁ ○ ▢), painted: the icon font has no such set.
fn nav_glyph(ui: &Ui, r: Rect, name: &str, color: Color32) {
    let p = ui.painter();
    let c = r.center();
    let s = Stroke::new(1.5, color);
    match name {
        "back" => {
            let pts = vec![c + vec2(4.0, -5.5), c + vec2(4.0, 5.5), c + vec2(-5.0, 0.0)];
            p.add(egui::Shape::closed_line(pts, s));
        }
        "home" => {
            p.circle_stroke(c, 5.5, s);
        }
        _ => {
            p.rect_stroke(Rect::from_center_size(c, Vec2::splat(10.0)), 2.0, s, egui::StrokeKind::Middle);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn run_dir_is_private() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let d = super::run_dir();
        let m = std::fs::symlink_metadata(&d).unwrap();
        assert!(m.is_dir());
        assert_eq!(m.permissions().mode() & 0o777, 0o700);
        assert_eq!(m.uid(), std::fs::metadata("/proc/self").unwrap().uid());
    }
}
