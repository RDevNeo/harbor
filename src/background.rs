//! Harbor keeps running when its window is closed: the same process, with no window.
//!
//! Wayland can't hide a window, so closing it really closes it: eframe returns from
//! `run_native_ext`, main.rs keeps the `App` and the egui context, and `run_hidden` ticks the
//! App's logic (phone API, mesh, queue, auto-work, wakes, webhooks, updates) without a pass or
//! a frame: only when something asks for a repaint, at least `MIN_GAP` apart, and once per
//! `HEARTBEAT` otherwise. Launching `harbor` again (single.rs), the tray's Open (tray.rs) or
//! `--background` → window: main.rs opens a new window on the same context.
//!
//! Settings (local, never synced): "Keep running in the background" (kv `bg_keep`, on by
//! default) and "Start Harbor when I log in" (an XDG autostart entry, `harbor --background`).

use crate::app::App;
use eframe::egui;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::time::{Duration, Instant};

/// Starts Harbor without a window (autostart): `harbor --background`.
pub const FLAG: &str = "--background";

static HIDDEN: AtomicBool = AtomicBool::new(false);
static SHOW: AtomicBool = AtomicBool::new(false);
static QUIT: AtomicBool = AtomicBool::new(false);
/// The kv `bg_keep` setting, read once: 0 not yet, 1 on, 2 off.
static KEEP: AtomicU8 = AtomicU8::new(0);

/// Hidden ticks run at most this often, whatever asks for repaints.
const MIN_GAP: Duration = Duration::from_millis(250);
/// And at least this often, for work that only checks the clock.
const HEARTBEAT: Duration = Duration::from_secs(5);

/// No window right now.
pub fn hidden() -> bool {
    HIDDEN.load(Ordering::Relaxed)
}

/// Quit Harbor completely was asked (tray, menu, Ctrl+Q).
pub fn quitting() -> bool {
    QUIT.load(Ordering::Relaxed)
}

/// Opens the window (or brings it to the front). Any thread.
pub fn show(ctx: &egui::Context) {
    SHOW.store(true, Ordering::Relaxed);
    ctx.request_repaint();
}

/// Quits Harbor completely, window or not. Any thread.
pub fn quit(ctx: &egui::Context) {
    QUIT.store(true, Ordering::Relaxed);
    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
    ctx.request_repaint();
}

/// A show asked for while the window is open: true once (the caller raises it).
pub fn take_show() -> bool {
    !hidden() && SHOW.swap(false, Ordering::Relaxed)
}

/// Ticks the App with no window until it's asked to show one (true) or to quit (false).
/// `closed`: the user closed the window (not a `--background` start).
pub fn run_hidden(app: &mut App, ctx: &egui::Context, closed: bool) -> bool {
    HIDDEN.store(true, Ordering::Relaxed);
    app.window_closed(closed);
    let (tx, rx) = channel::<Duration>();
    // eframe sets its own callback again when the next window opens.
    ctx.set_request_repaint_callback(move |info| {
        let _ = tx.send(info.delay);
    });
    // The App's own "hidden" test (minimized/unfocused): agents notify, nothing counts as read.
    let mut raw = egui::RawInput { focused: false, ..Default::default() };
    raw.viewports.insert(egui::ViewportId::ROOT, egui::ViewportInfo { minimized: Some(true), focused: Some(false), occluded: Some(true), ..Default::default() });
    let mut next = Instant::now();
    let mut last: Option<Instant> = None;
    loop {
        if QUIT.load(Ordering::Relaxed) {
            return false;
        }
        if SHOW.swap(false, Ordering::Relaxed) {
            HIDDEN.store(false, Ordering::Relaxed);
            return true;
        }
        let now = Instant::now();
        if now >= next {
            if let Some(gap) = last.map(|l| l.elapsed()).filter(|g| *g < MIN_GAP) {
                std::thread::sleep(MIN_GAP - gap);
            }
            last = Some(Instant::now());
            next = Instant::now() + HEARTBEAT;
            // Viewport commands (Focus, Close…) have no window to go to.
            let _ = ctx.run_logic(&raw, |ctx| app.tick(ctx));
            app.update_notice();
            continue;
        }
        match rx.recv_timeout(next - now) {
            Ok(delay) => next = next.min(Instant::now().checked_add(delay.min(HEARTBEAT)).unwrap_or(next)),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => std::thread::sleep(HEARTBEAT.min(next - now)),
        }
    }
}

// ------------------------------------------------------------------ settings

impl App {
    /// "Keep running in the background when the window is closed" (default on).
    pub fn keep_running(&self) -> bool {
        match KEEP.load(Ordering::Relaxed) {
            0 => {
                let on = self.store.get("bg_keep").as_deref() != Some("0");
                KEEP.store(if on { 1 } else { 2 }, Ordering::Relaxed);
                on
            }
            k => k == 1,
        }
    }

    pub fn set_keep_running(&self, on: bool) {
        self.store.set("bg_keep", if on { "1" } else { "0" });
        KEEP.store(if on { 1 } else { 2 }, Ordering::Relaxed);
    }

    /// The window just closed and Harbor stays: say so once, as a desktop notification (there
    /// is no window left for a toast). Also stops what only the window needs.
    fn window_closed(&mut self, explain: bool) {
        // Browser engines run only while shown; their URL survives.
        for d in [crate::surface::Dock::Right, crate::surface::Dock::Bottom] {
            for s in &mut self.pane_mut(d).surfaces {
                if let crate::surface::Surface::Browser { engine, .. } = s {
                    *engine = None;
                }
            }
        }
        if explain && self.store.get("bg_explained").is_none() {
            self.store.set("bg_explained", "1");
            let how = if crate::tray::active() { "Quit it from its tray icon" } else { "Quit it from Settings › General" };
            crate::limits::notify(
                "Harbor is still running",
                &format!("Phones, other PCs and queued work keep reaching this PC. Run Harbor again to open it. {how}, or turn this off there."),
            );
        }
    }

    /// "Ask me" updates with no window: a desktop notification, once per version (automatic
    /// updates install and restart by themselves, see reload.rs).
    fn update_notice(&mut self) {
        let Some(crate::update::State::Available(v) | crate::update::State::Installed(v)) = self.update_offered() else { return };
        if self.auto_update() || self.store.get("bg_update_noticed").as_deref() == Some(v.as_str()) {
            return;
        }
        self.store.set("bg_update_noticed", &v);
        let v = if v.is_empty() { "A new version".to_string() } else { format!("Harbor {v}") };
        crate::limits::notify(&format!("{v} is ready"), "Open Harbor and click Update to install it.");
    }

    /// A new window opened on the old context: its renderer has none of the textures the last
    /// one had, so the font atlas is rebuilt and every cached texture loads again.
    pub fn window_opened(&mut self, ctx: &egui::Context) {
        HIDDEN.store(false, Ordering::Relaxed);
        SHOW.store(false, Ordering::Relaxed);
        // Someone just opened it: an automatic update waits until it's left alone again.
        self.reload_watch.touched();
        // A changed missing-glyph policy makes egui build new fonts (a full atlas upload).
        use egui::MissingGlyphPolicy as P;
        let policy = ctx.missing_glyph_policy();
        let other = if policy == P::Tofu { P::Panic } else { P::Tofu };
        ctx.set_missing_glyph_policy(other);
        ctx.set_missing_glyph_policy(policy);
        ctx.data_mut(|d| d.remove_by_type::<egui::TextureHandle>());
        crate::images::forget_all(ctx);
        ctx.forget_all_images();
        self.avatars.clear();
        self.prs.avatars.clear();
        self.devices_ui.icons.clear();
        if let Some(p) = &mut self.api.ui.pairing {
            (p.1, p.2) = (None, None);
        }
        self.api.ui.install_qr = None;
        // (Browser engines were stopped with the last window; they start with a new texture.)
    }
}

// ------------------------------------------------------------------ autostart

fn autostart_file() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"));
    config.join("autostart/harbor.desktop")
}

/// What autostart runs: the installed launcher (~/.local/bin/harbor) when it leads to this
/// install, so it follows updates; else this very file.
fn launcher() -> Option<PathBuf> {
    let exe = crate::update::self_exe()?;
    let bin = PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/bin/harbor");
    let same = |a: &PathBuf, b: &PathBuf| a.canonicalize().ok().is_some_and(|a| b.canonicalize().ok().is_some_and(|b| a == b));
    Some(if crate::update::managed() && same(&bin, &exe) { bin } else { exe })
}

/// The entry is Harbor's (written by `set_autostart`) and not hidden.
pub fn autostart() -> bool {
    std::fs::read_to_string(autostart_file()).is_ok_and(|s| s.contains(FLAG) && !s.lines().any(|l| l.trim() == "Hidden=true"))
}

pub fn set_autostart(on: bool) -> Result<(), String> {
    let path = autostart_file();
    if !on {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", path.display())),
            _ => Ok(()),
        };
    }
    let exe = launcher().ok_or("Harbor can't tell where its own file is")?;
    std::fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;
    std::fs::write(&path, desktop_entry(&exe.to_string_lossy())).map_err(|e| format!("{}: {e}", path.display()))
}

fn desktop_entry(exe: &str) -> String {
    // Desktop Entry quoting: inside double quotes, \ " ` $ are escaped.
    let quoted = if exe.chars().any(|c| c.is_whitespace() || "\"'\\`$".contains(c)) {
        let mut q = String::from("\"");
        for c in exe.chars() {
            if "\"`$\\".contains(c) {
                q.push('\\');
            }
            q.push(c);
        }
        q.push('"');
        q
    } else {
        exe.to_string()
    };
    format!(
        "[Desktop Entry]\nType=Application\nName=Harbor\nComment=Starts Harbor in the background, so phones and other PCs can reach this one\nExec={quoted} {FLAG}\nIcon=harbor\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_entry_quotes_paths() {
        assert!(desktop_entry("/opt/harbor/harbor").contains("\nExec=/opt/harbor/harbor --background\n"));
        assert!(desktop_entry("/home/sam/My Apps/harbor").contains("\nExec=\"/home/sam/My Apps/harbor\" --background\n"));
        assert!(desktop_entry("/x/a$b").contains("Exec=\"/x/a\\$b\" --background"));
    }

    #[test]
    fn show_waits_for_hidden() {
        HIDDEN.store(true, Ordering::Relaxed);
        SHOW.store(true, Ordering::Relaxed);
        assert!(!take_show(), "hidden: run_hidden takes it");
        HIDDEN.store(false, Ordering::Relaxed);
        assert!(take_show());
        assert!(!take_show(), "once");
    }
}
