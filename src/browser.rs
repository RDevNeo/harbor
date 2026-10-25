//! Built-in browser panel. The engine (Servo) runs in the separate `harbor-browser`
//! process, started when the panel opens and killed when it closes, so Harbor
//! itself stays small. Frames arrive through a private folder in RAM (`store::run_dir`); input goes back as JSON.

use crate::icons as ic;
use crate::theme::Tokens;
use crate::widgets as w;
use eframe::egui::{self, Color32, ColorImage, CursorIcon, Frame, Id, Key, Margin, Rect, Sense, TextureHandle, TextureOptions, Ui, pos2};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};

/// Where the helper binary is: $HARBOR_BROWSER, next to harbor, or the source tree's build.
pub fn helper_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HARBOR_BROWSER") {
        return Some(PathBuf::from(p)).filter(|p| p.is_file());
    }
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let dir = exe.parent()?;
    [dir.join("harbor-browser"), dir.join("../../browser/target/release/harbor-browser")]
        .into_iter()
        .find(|p| p.is_file())
}

/// Folder of the helper's source, for "Build engine".
/// An http(s) URL, the only kind "Open in my browser" hands to the system.
fn web(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    u.starts_with("http://") || u.starts_with("https://")
}

pub fn source_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    Some(exe.parent()?.join("../../browser")).filter(|p| p.join("Cargo.toml").is_file()).and_then(|p| p.canonicalize().ok())
}

pub struct Browser {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    frames: String,
    tex: Option<TextureHandle>,
    pub url: String,
    pub input: String,
    pub title: String,
    pub loading: bool,
    back: bool,
    forward: bool,
    cursor: CursorIcon,
    size: (u32, u32),
    editing: bool,
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for b in 0..2 {
            let _ = std::fs::remove_file(format!("{}.{b}", self.frames));
        }
    }
}

pub enum Action {
    External(String),
    /// Load this URL (picked from the "nothing running" screen).
    Load(String),
}

impl Browser {
    pub fn spawn(url: &str, wake: impl Fn() + Send + 'static) -> Result<Self, String> {
        let bin = helper_path().ok_or("engine not built")?;
        let frames = crate::store::run_dir().join(format!("browser-{}", std::process::id())).to_string_lossy().into_owned();
        let mut child = Command::new(bin)
            .args([&frames, url, "1024", "768", "1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().unwrap();
        // One frame at a time: the engine paints the next only after our "got", so a
        // hidden tab (not polled) costs no painting, copies or repaints here.
        let _ = writeln!(stdin, "{}", json!({ "t": "acks", "on": true }));
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
        });
        Ok(Self {
            child,
            stdin,
            rx,
            frames,
            tex: None,
            url: url.into(),
            input: url.into(),
            title: String::new(),
            loading: true,
            back: false,
            forward: false,
            cursor: CursorIcon::Default,
            size: (1024, 768),
            editing: false,
        })
    }

    fn send(&mut self, v: Value) {
        let _ = writeln!(self.stdin, "{v}");
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn load(&mut self, url: &str) {
        self.send(json!({ "t": "load", "url": url }));
        self.url = url.into();
        self.input = url.into();
    }

    fn poll(&mut self, ctx: &egui::Context) {
        let mut newest = None;
        while let Ok(v) = self.rx.try_recv() {
            match v["t"].as_str().unwrap_or("") {
                // only the newest frame is worth reading (an engine without acks may queue several)
                "frame" => newest = Some(v),
                "url" => {
                    self.url = v["url"].as_str().unwrap_or("").into();
                    if !self.editing {
                        self.input = self.url.clone();
                    }
                }
                "title" => self.title = v["title"].as_str().unwrap_or("").into(),
                "loading" => self.loading = v["on"].as_bool().unwrap_or(false),
                "nav" => {
                    self.back = v["back"].as_bool().unwrap_or(false);
                    self.forward = v["forward"].as_bool().unwrap_or(false);
                }
                "cursor" => {
                    self.cursor = match v["name"].as_str().unwrap_or("") {
                        "Pointer" => CursorIcon::PointingHand,
                        "Text" | "VerticalText" => CursorIcon::Text,
                        "Grab" => CursorIcon::Grab,
                        "Grabbing" => CursorIcon::Grabbing,
                        "Move" | "AllScroll" => CursorIcon::Move,
                        "NotAllowed" | "NoDrop" => CursorIcon::NotAllowed,
                        "Wait" => CursorIcon::Wait,
                        "Progress" => CursorIcon::Progress,
                        "Crosshair" => CursorIcon::Crosshair,
                        "EwResize" | "EResize" | "WResize" | "ColResize" => CursorIcon::ResizeHorizontal,
                        "NsResize" | "NResize" | "SResize" | "RowResize" => CursorIcon::ResizeVertical,
                        "None" => CursorIcon::None,
                        _ => CursorIcon::Default,
                    }
                }
                _ => {}
            }
        }
        if let Some(v) = newest {
            let (fw, fh) = (v["w"].as_u64().unwrap_or(0) as usize, v["h"].as_u64().unwrap_or(0) as usize);
            let path = format!("{}.{}", self.frames, v["buf"].as_u64().unwrap_or(0));
            if let Ok(bytes) = std::fs::read(&path) {
                // A frame at the wrong size means a resize was lost (sent before the
                // page existed): ask again.
                if (fw as u32, fh as u32) != self.size {
                    let (w, h) = self.size;
                    self.send(json!({ "t": "resize", "w": w, "h": h }));
                }
                if bytes.len() == fw * fh * 4 && fw > 0 {
                    let img = ColorImage::from_rgba_unmultiplied([fw, fh], &bytes);
                    match &mut self.tex {
                        Some(t) => t.set(img, TextureOptions::LINEAR),
                        None => self.tex = Some(ctx.load_texture("browser-page", img, TextureOptions::LINEAR)),
                    }
                }
            }
            self.send(json!({ "t": "got" }));
        }
    }

    /// Toolbar and page. Returns what the app should do (close, open externally).
    /// `servers`: local URLs worth offering when a page can't be reached.
    pub fn ui(&mut self, ui: &mut Ui, t: &Tokens, servers: &[String], id: Id) -> Option<Action> {
        self.poll(ui.ctx());
        let mut action = None;
        // ---- toolbar
        Frame::new().inner_margin(Margin::symmetric(8, 6)).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                if w::btn(ic::ARROW_LEFT).muted().icon_sm().enabled(self.back).show(ui).on_hover_text("Back").clicked() {
                    self.send(json!({ "t": "back" }));
                }
                if w::btn(ic::ARROW_RIGHT).muted().icon_sm().enabled(self.forward).show(ui).on_hover_text("Forward").clicked() {
                    self.send(json!({ "t": "forward" }));
                }
                let (icon, tip) = if self.loading { (ic::X, "Loading…") } else { (ic::ROTATE_CW, "Reload") };
                if w::btn(icon).muted().icon_sm().show(ui).on_hover_text(tip).clicked() {
                    self.send(json!({ "t": "reload" }));
                }
                let wdt = ui.available_width() - 64.0;
                let r = w::input(ui, &mut self.input, "localhost:3000 or a URL", true, wdt);
                self.editing = r.has_focus();
                if r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
                    let u = self.input.clone();
                    self.load(&u);
                }
                // (the page picks this URL: only a web page goes to xdg-open)
                if w::btn(ic::EXTERNAL).muted().icon_sm().enabled(web(&self.url)).show(ui).on_hover_text("Open in my browser").clicked() {
                    action = Some(Action::External(self.url.clone()));
                }
            });
        });
        // ---- page
        let (_, rect) = ui.allocate_space(ui.available_size());
        let resp = ui.interact(rect, id, Sense::click_and_drag());
        let ppp = ui.ctx().pixels_per_point();
        let want = ((rect.width() * ppp).round().max(1.0) as u32, (rect.height() * ppp).round().max(1.0) as u32);
        if want != self.size && want.0 > 8 && want.1 > 8 {
            self.size = want;
            self.send(json!({ "t": "resize", "w": want.0, "h": want.1 }));
        }
        let painter = ui.painter_at(rect);
        painter.rect_filled(rect, 0.0, Color32::WHITE);
        match &self.tex {
            Some(tex) => {
                // Draw at 1:1 device pixels from the top-left, even mid-resize.
                let size = tex.size_vec2() / ppp;
                painter.image(tex.id(), Rect::from_min_size(rect.min, size), Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), Color32::WHITE);
            }
            None => {
                painter.text(rect.center(), egui::Align2::CENTER_CENTER, "Loading…", egui::FontId::proportional(14.0), t.gray(700));
            }
        }
        // Servo's own error page is bare text; show what's actually reachable instead.
        if self.title == "Error loading page" {
            painter.rect_filled(rect, 0.0, t.bg100);
            let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rect.shrink(24.0)));
            child.add_space(rect.height() * 0.18);
            child.vertical_centered(|ui| {
                ui.label(egui::RichText::new(ic::GLOBE).size(28.0).color(t.subtle()));
                let host = self.url.trim_start_matches("http://").trim_start_matches("https://").trim_end_matches('/').to_string();
                w::text(ui, format!("Can't reach {host}"), "heading-16");
                let local = host.starts_with("localhost") || host.starts_with("127.");
                w::subtle(ui, if local { "Nothing is running there." } else { "The site didn't respond." }, "label-13");
                ui.add_space(10.0);
                if w::btn(&format!("{}  Retry", ic::ROTATE_CW)).outline().show(ui).clicked() {
                    self.send(json!({ "t": "reload" }));
                }
                if !servers.is_empty() {
                    ui.add_space(14.0);
                    w::subtle(ui, "Running on this machine", "label-12");
                    for s in servers {
                        let label = s.trim_start_matches("http://").trim_end_matches('/');
                        if w::btn(&format!("{}  {label}", ic::GLOBE)).sm().variant(w::Variant::Ghost).show(ui).clicked() {
                            action = Some(Action::Load(s.clone()));
                        }
                    }
                }
            });
            return action;
        }
        if resp.hovered() {
            ui.ctx().set_cursor_icon(self.cursor);
        }
        if resp.clicked() || resp.drag_started() {
            resp.request_focus();
            self.send(json!({ "t": "focus", "on": true }));
        }
        let focused = resp.has_focus();
        if focused {
            ui.memory_mut(|m| m.set_focus_lock_filter(id, egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: true }));
        }
        self.forward_input(ui, rect, ppp, resp.hovered() || resp.dragged(), focused);
        action
    }

    fn forward_input(&mut self, ui: &Ui, rect: Rect, ppp: f32, hovered: bool, focused: bool) {
        let events = ui.input(|i| i.events.clone());
        let to_dev = |p: egui::Pos2| ((p.x - rect.left()) * ppp, (p.y - rect.top()) * ppp);
        for e in events {
            match e {
                egui::Event::PointerMoved(p) if hovered && rect.contains(p) => {
                    let (x, y) = to_dev(p);
                    self.send(json!({ "t": "move", "x": x, "y": y }));
                }
                egui::Event::PointerButton { pos, button, pressed, .. } if rect.contains(pos) || !pressed => {
                    if !hovered && pressed {
                        continue;
                    }
                    let (x, y) = to_dev(pos);
                    let b = match button {
                        egui::PointerButton::Secondary => 1,
                        egui::PointerButton::Middle => 2,
                        _ => 0,
                    };
                    self.send(json!({ "t": "button", "x": x, "y": y, "button": b, "down": pressed }));
                }
                egui::Event::MouseWheel { delta, unit, .. } if hovered => {
                    let k = match unit {
                        egui::MouseWheelUnit::Point => ppp,
                        egui::MouseWheelUnit::Line => 40.0 * ppp,
                        egui::MouseWheelUnit::Page => rect.height() * ppp,
                    };
                    let pos = ui.input(|i| i.pointer.hover_pos()).unwrap_or(rect.center());
                    let (x, y) = to_dev(pos);
                    // Servo takes egui's sign as is; negating it scrolled the wrong way.
                    self.send(json!({ "t": "wheel", "x": x, "y": y, "dx": delta.x * k, "dy": delta.y * k }));
                }
                egui::Event::Text(text) if focused => {
                    for ch in text.chars() {
                        let s = ch.to_string();
                        for down in [true, false] {
                            self.send(json!({ "t": "key", "key": s, "code": "", "down": down }));
                        }
                    }
                }
                egui::Event::Paste(text) if focused => {
                    for ch in text.chars() {
                        let s = if ch == '\n' { "Enter".to_string() } else { ch.to_string() };
                        for down in [true, false] {
                            self.send(json!({ "t": "key", "key": s, "code": "", "down": down }));
                        }
                    }
                }
                egui::Event::Key { key, pressed, modifiers, .. } if focused => {
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
                    // Shortcuts (Ctrl+A, Ctrl+C…) come as keys without text.
                    let shortcut = (modifiers.ctrl || modifiers.command) && key.name().len() == 1;
                    let key_name = match (named, shortcut) {
                        (Some(n), _) => n.to_string(),
                        (None, true) => key.name().to_lowercase(),
                        _ => continue,
                    };
                    self.send(json!({
                        "t": "key", "key": key_name, "code": "", "down": pressed,
                        "ctrl": modifiers.ctrl, "shift": modifiers.shift, "alt": modifiers.alt, "meta": modifiers.mac_cmd,
                    }));
                }
                _ => {}
            }
        }
    }
}

/// Shown when the helper isn't built yet.
pub fn missing_ui(ui: &mut Ui, t: &Tokens) -> (bool, bool) {
    let mut build = false;
    let mut close = false;
    ui.add_space(40.0);
    ui.vertical_centered(|ui| {
        ui.label(egui::RichText::new(ic::GLOBE).size(28.0).color(t.subtle()));
        // Installed copies download the engine; a source checkout builds it.
        let download = source_dir().is_none() && crate::update::managed();
        let failed = crate::update::browser_result().and_then(|r| r.err());
        let working = download && crate::update::busy();
        w::text(ui, if download { "Browser engine not installed" } else { "Browser engine not built" }, "heading-16");
        let note = match (&failed, download) {
            (Some(e), _) => format!("The download failed: {e}"),
            (None, true) => "It's a separate download (Servo, about 40 MB), so Harbor stays small.".into(),
            (None, false) => "It's a separate program (Servo), so Harbor stays small. The first build takes a while.".into(),
        };
        w::subtle(ui, note, "label-13");
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.add_space((ui.available_width() - 220.0).max(0.0) / 2.0);
            let label = match (download, working) {
                (true, true) => "Installing…".to_string(),
                (true, false) => format!("{}  Install engine", ic::DOWNLOAD),
                _ => format!("{}  Build engine", ic::HAMMER),
            };
            if w::btn(&label).primary().enabled(!working).show(ui).clicked() {
                build = true;
            }
            if w::btn("Close").outline().show(ui).clicked() {
                close = true;
            }
        });
    });
    (build, close)
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_web_pages_open_outside() {
        assert!(super::web("https://example.com/a") && super::web("HTTP://localhost:3000"));
        for u in ["file:///etc/passwd", "x-test:hello", "javascript:alert(1)", "about:blank", ""] {
            assert!(!super::web(u), "{u}");
        }
    }
}
