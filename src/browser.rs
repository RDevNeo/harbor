//! Built-in browser panel. The engine (Servo) runs in the separate `harbor-browser`
//! process, started when the panel opens and killed when it closes, so Harbor
//! itself stays small. Frames arrive through a private folder in RAM (`store::run_dir`); input goes back as JSON.

use crate::widgets::Tip as _;
use crate::icons as ic;
use crate::theme::Tokens;
use crate::widgets as w;
use eframe::egui::{self, Color32, ColorImage, CursorIcon, Frame, Id, Key, Margin, Rect, Sense, TextureHandle, TextureOptions, Ui, pos2};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Engines that stopped within `QUICK` of starting, lately, with their last stderr line: three
/// in a minute and the panel stops restarting it (it shows why, with "Try again").
static EXITS: Mutex<Vec<(Instant, String)>> = Mutex::new(Vec::new());
const QUICK: Duration = Duration::from_secs(5);

/// The engine keeps stopping right after it starts: its last words, if any.
pub fn crashing() -> Option<String> {
    let mut v = EXITS.lock().unwrap();
    v.retain(|(t, _)| t.elapsed() < Duration::from_secs(60));
    (v.len() >= 3).then(|| v.last().map(|x| x.1.clone()).unwrap_or_default())
}

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
    started: Instant,
    last_err: Arc<Mutex<String>>,
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
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        // Only its last line is kept, for when it stops right away (a missing library…).
        let last_err = Arc::new(Mutex::new(String::new()));
        if let Some(err) = child.stderr.take() {
            let last = last_err.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        *last.lock().unwrap() = line;
                    }
                }
            });
        }
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
            started: Instant::now(),
            last_err,
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

    /// False once the engine stopped (counted when that was right after it started).
    pub fn alive(&mut self) -> bool {
        let alive = matches!(self.child.try_wait(), Ok(None));
        if !alive && self.started.elapsed() < QUICK {
            // (stderr's reader may still be finishing its last line)
            std::thread::sleep(Duration::from_millis(50));
            EXITS.lock().unwrap().push((Instant::now(), self.last_err.lock().unwrap().clone()));
        }
        alive
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
                if w::btn(ic::ARROW_LEFT).muted().icon_xs().enabled(self.back).show(ui).tip("Back").clicked() {
                    self.send(json!({ "t": "back" }));
                }
                if w::btn(ic::ARROW_RIGHT).muted().icon_xs().enabled(self.forward).show(ui).tip("Forward").clicked() {
                    self.send(json!({ "t": "forward" }));
                }
                let (icon, tip) = if self.loading { (ic::X, "Loading…") } else { (ic::ROTATE_CW, "Reload") };
                if w::btn(icon).muted().icon_xs().show(ui).tip(tip).clicked() {
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
                if w::btn(ic::EXTERNAL).muted().icon_xs().enabled(web(&self.url)).show(ui).tip("Open in my browser").clicked() {
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
                if w::btn(&format!("{}  Retry", ic::ROTATE_CW)).sm().outline().show(ui).clicked() {
                    self.send(json!({ "t": "reload" }));
                }
                if !servers.is_empty() {
                    ui.add_space(14.0);
                    w::subtle(ui, "Running on this machine", "label-12");
                    for s in servers {
                        let label = s.trim_start_matches("http://").trim_end_matches('/');
                        if w::btn(&format!("{}  {label}", ic::GLOBE)).xs().variant(w::Variant::Ghost).show(ui).clicked() {
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

/// Shown while there's no engine to run: being downloaded, failed, turned off, unsupported, or
/// (source checkouts) not built yet. (build, close): "Build engine" / "Install engine" / "Try
/// again", and Close.
pub fn missing_ui(ui: &mut Ui, t: &Tokens) -> (bool, bool) {
    use crate::update;
    let mut build = false;
    let mut close = false;
    let source = source_dir().is_some();
    let crashed = crashing();
    let installing = update::browser_installing();
    let failed = update::browser_result().and_then(|r| r.err());
    // (title, note, button: label and enabled)
    let (title, note, button): (&str, String, Option<(String, bool)>) = if let Some(why) = &crashed {
        let why = if why.is_empty() { String::new() } else { format!(": {why}") };
        ("The browser engine stopped", format!("It quit right after starting{why}"), Some((format!("{}  Try again", ic::ROTATE_CW), true)))
    } else if helper_path().is_some() {
        ("Starting the browser…", String::new(), None)
    } else if source {
        ("Browser engine not built", "It's a separate program (Servo), so Harbor stays small. The first build takes a while.".into(), Some((format!("{}  Build engine", ic::HAMMER), true)))
    } else if !update::managed() {
        ("Browser engine not found", "This copy of Harbor has no harbor-browser beside it: install Harbor with install.sh, or set HARBOR_BROWSER.".into(), None)
    } else if let Some(why) = update::browser_unsupported() {
        ("The browser can't run on this system", why, None)
    } else if installing {
        ("Installing the browser engine…", "Servo, about 45 MB. The page opens here when it's done.".into(), Some(("Installing…".into(), false)))
    } else if let Some(e) = &failed {
        ("The browser engine didn't install", format!("{e}. Harbor tries again by itself later."), Some((format!("{}  Try again", ic::ROTATE_CW), true)))
    } else if update::browser_off() {
        ("The browser engine is turned off", "Harbor was installed with --no-browser.".into(), Some((format!("{}  Install engine", ic::DOWNLOAD), true)))
    } else {
        ("Getting the browser engine…", "Harbor downloads it by itself (Servo, about 45 MB).".into(), Some((format!("{}  Install now", ic::DOWNLOAD), true)))
    };
    ui.add_space(40.0);
    ui.vertical_centered(|ui| {
        ui.label(egui::RichText::new(ic::GLOBE).size(28.0).color(t.subtle()));
        w::text(ui, title, "heading-16");
        if !note.is_empty() {
            w::subtle(ui, note, "label-13");
        }
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            let width = if button.is_some() { 220.0 } else { 70.0 };
            ui.add_space((ui.available_width() - width).max(0.0) / 2.0);
            if let Some((label, enabled)) = &button {
                if w::btn(label).sm().primary().enabled(*enabled).show(ui).clicked() {
                    if crashed.is_some() {
                        EXITS.lock().unwrap().clear();
                    } else {
                        build = true;
                    }
                }
            }
            if w::btn("Close").sm().outline().show(ui).clicked() {
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
