//! Hot reload: when the Harbor binary on disk changes (a new build), Harbor
//! saves what's on screen, replaces itself in place with the new binary (same
//! pid, via exec) and restores it, running agent turns included (they run detached,
//! see detach.rs). Updating automatically, it waits for a moment nobody sees it (`quiet`):
//! no window, or a focused window left untouched for a while, so it reappears where it was.

use crate::app::{App, Tab, View};
use crate::surface::{Dock, Surface};
use serde_json::{Value, json};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

/// An automatic update swaps a focused window in only after it went untouched this long (under
/// the usual screensaver delay: Omarchy's starts at 2.5 minutes and takes the focus).
const IDLE: Duration = Duration::from_secs(2 * 60);
/// ... or this long while the chat on screen is still running (its reply may be read as it comes).
const IDLE_WATCHING: Duration = Duration::from_secs(20 * 60);
/// No frame for this long: the screen was off or the window out of sight; it may be back now.
const STARVED: Duration = Duration::from_secs(45);
/// How often it looks again while it waits.
const LOOK: Duration = Duration::from_secs(30);

/// When the user last touched the window, and when an update last looked at it.
pub struct Watch {
    input: Instant,
    looked: Option<Instant>,
}

impl Default for Watch {
    fn default() -> Self {
        Watch { input: Instant::now(), looked: None }
    }
}

impl Watch {
    /// The user did something (or a window just opened).
    pub fn touched(&mut self) {
        self.input = Instant::now();
    }
}

/// What an automatic update sees of the window.
#[derive(Clone, Copy, Debug, Default)]
pub struct Moment {
    /// No window (background.rs): nobody sees the restart.
    pub hidden: bool,
    pub focused: bool,
    /// Since the window was last touched.
    pub idle: Duration,
    /// The composer on screen holds text (it's kept, but the user may be mid-sentence), or the
    /// chat is scrolled up to older messages (the restart would bring it back to its end).
    pub editing: bool,
    /// Files wait to be sent: a restart would drop them.
    pub attached: bool,
    /// The chat on screen is running.
    pub watching: bool,
    /// The frame before this one was long ago (screen off, window out of sight).
    pub starved: bool,
}

#[derive(Debug, PartialEq)]
pub enum Swap {
    Now,
    /// Look again after this.
    Later(Duration),
}

/// Whether an automatic update may swap in now. On Wayland a new window opens where the user
/// is (the active workspace) and takes the focus, so a window that isn't focused waits: the
/// user is elsewhere, and the restart would pull Harbor over what they're doing. A focused one
/// is replaced in place once nobody has touched it for a while.
pub fn quiet(m: Moment) -> Swap {
    if m.attached {
        return Swap::Later(LOOK);
    }
    if m.hidden {
        return Swap::Now;
    }
    if !m.focused || m.starved || m.editing {
        return Swap::Later(LOOK);
    }
    let need = if m.watching { IDLE_WATCHING } else { IDLE };
    match need.checked_sub(m.idle) {
        Some(left) if !left.is_zero() => Swap::Later(left.min(LOOK)),
        _ => Swap::Now,
    }
}

/// Input that means someone is at the window.
fn touches(e: &eframe::egui::Event) -> bool {
    use eframe::egui::Event as E;
    matches!(e, E::Key { .. } | E::Text(_) | E::PointerMoved(_) | E::PointerButton { .. } | E::MouseWheel { .. } | E::Zoom(_) | E::Touch { .. } | E::Ime(_) | E::Copy | E::Cut | E::Paste(_))
}

/// A new build is written in place; an update or a package manager renames a new file over
/// it (another inode, possibly the same size and time).
fn stamp(p: &PathBuf) -> Option<(SystemTime, u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(p).ok()?;
    Some((m.modified().ok()?, m.len(), m.ino()))
}

/// Watches the executable; sets `ready` once a different build has finished writing.
pub fn watch(exe: PathBuf, ready: Arc<AtomicBool>, wake: impl Fn() + Send + 'static) {
    let Some(start) = stamp(&exe) else { return };
    std::thread::spawn(move || {
        let mut last = start;
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let Some(now) = stamp(&exe) else { continue };
            // Changed, and unchanged since the previous look: the build is done writing.
            if now != start && now == last {
                ready.store(true, Ordering::Relaxed);
                wake();
                return;
            }
            last = now;
        }
    });
}

impl App {
    /// Snapshot of what's on screen, for the next process to restore.
    fn snapshot(&self) -> Value {
        let view = match self.view {
            View::Draft => json!({ "t": "draft" }),
            View::Chat(id) => json!({ "t": "chat", "id": id }),
            View::Settings(tab) => json!({ "t": "settings", "tab": tab.slug(), "back": match self.settings_back {
                View::Chat(id) => Some(id),
                _ => None,
            } }),
            View::Prs => json!({ "t": "prs" }),
            View::Issues => json!({ "t": "issues" }),
        };
        let panes: Vec<Value> = [Dock::Right, Dock::Bottom]
            .iter()
            .map(|d| {
                let p = self.pane(*d);
                let surfaces: Vec<Value> = p
                    .surfaces
                    .iter()
                    .map(|s| match s {
                        Surface::Chooser => json!({ "t": "chooser" }),
                        Surface::Devices(_) => json!({ "t": "device" }),
                        Surface::Files(f) => json!({ "t": "device-files", "device": crate::devices::device_json(&f.dev), "path": f.path }),
                        Surface::Browser { url, .. } => json!({ "t": "browser", "url": url }),
                        Surface::Terminal(term) => json!({ "t": "terminal", "title": term.title, "cwd": term.cwd }),
                    })
                    .collect();
                json!({ "open": p.open, "active": p.active, "surfaces": surfaces })
            })
            .collect();
        json!({
            "view": view,
            "draft_repo": self.draft.repo,
            "draft_main": self.draft.main,
            "drafts": self.drafts.iter().filter(|(_, t)| !t.is_empty()).map(|(k, t)| (k.to_string(), Value::String(t.clone()))).collect::<serde_json::Map<String, Value>>(),
            "files": self.files.iter().filter(|(_, f)| !f.is_empty()).map(|(k, f)| (k.to_string(), json!(f))).collect::<serde_json::Map<String, Value>>(),
            "panes": panes,
            "max": self.surface_max.map(|d| d.idx()),
            // Agent turns keep running across the reload; what waits for them comes along.
            "pending": self.pending,
            "queue": self.queue_snapshot(),
        })
    }

    /// Restores a snapshot left by the previous process (once).
    pub fn restore_after_reload(&mut self, ctx: &eframe::egui::Context) {
        let Some(text) = self.store.get("reload_state") else { return };
        self.store.set("reload_state", "");
        let Ok(v) = serde_json::from_str::<Value>(&text) else { return };
        self.draft.repo = v["draft_repo"].as_i64();
        self.draft.main = v["draft_main"].as_bool().unwrap_or(false);
        if let Some(m) = v["drafts"].as_object() {
            for (k, t) in m {
                if let (Ok(k), Some(t)) = (k.parse::<i64>(), t.as_str()) {
                    self.drafts.insert(k, t.to_string());
                }
            }
        }
        if let Some(m) = v["files"].as_object() {
            for (k, f) in m {
                if let (Ok(k), Ok(f)) = (k.parse::<i64>(), serde_json::from_value::<Vec<PathBuf>>(f.clone())) {
                    self.files.insert(k, f);
                }
            }
        }
        let view = &v["view"];
        match view["t"].as_str() {
            Some("chat") => {
                if let Some(id) = view["id"].as_i64().filter(|id| self.chat(*id).is_some()) {
                    self.open(View::Chat(id));
                }
            }
            Some("settings") => {
                if let Some(id) = view["back"].as_i64().filter(|id| self.chat(*id).is_some()) {
                    self.open(View::Chat(id));
                }
                self.open(View::Settings(view["tab"].as_str().and_then(Tab::from_slug).unwrap_or(Tab::General)));
            }
            // The Usage page lives in Settings now.
            Some("usage") => self.open(View::Settings(Tab::Limits)),
            Some("prs") => self.open(View::Prs),
            Some("issues") => self.open(View::Issues),
            _ => self.open(View::Draft),
        }
        for (i, d) in [Dock::Right, Dock::Bottom].into_iter().enumerate() {
            let pv = &v["panes"][i];
            for s in pv["surfaces"].as_array().into_iter().flatten() {
                match s["t"].as_str() {
                    Some("browser") => self.restore_surface(d, Surface::Browser { engine: None, url: s["url"].as_str().unwrap_or("").to_string() }),
                    Some("device") => self.restore_devices(d, ctx),
                    // A screen isn't reconnected by itself after a reload (that would start sharing again).
                    Some("device-files") => self.restore_files(d, ctx, crate::devices::device_from(&s["device"]), s["path"].as_str().unwrap_or("~").to_string()),
                    Some("terminal") => {
                        let cwd = PathBuf::from(s["cwd"].as_str().unwrap_or("~"));
                        let title = s["title"].as_str().unwrap_or("terminal").to_string();
                        self.restore_terminal(d, ctx, &title, cwd);
                    }
                    _ => {}
                }
            }
            self.set_pane_state(d, pv["open"].as_bool().unwrap_or(false), pv["active"].as_u64().unwrap_or(0) as usize);
        }
        self.surface_max = v["max"].as_u64().map(|i| if i == 0 { Dock::Right } else { Dock::Bottom });
        if let Ok(p) = serde_json::from_value::<std::collections::HashMap<i64, Vec<String>>>(v["pending"].clone()) {
            self.pending = p;
        }
        self.queue_restore(&v["queue"]);
    }

    /// Called every frame: reloads when the Update button asked for it, or (updating
    /// automatically) when an update is ready and it's a good moment.
    pub fn maybe_reload(&mut self, ctx: &eframe::egui::Context) {
        if !crate::background::hidden() && ctx.input(|i| i.events.iter().any(touches) || i.pointer.any_down()) {
            self.reload_watch.touched();
        }
        // The install failed (a build already on disk still counts, whatever a check said).
        if self.reload_asked && !self.update_ready.load(Ordering::Relaxed) && matches!(crate::update::state(), crate::update::State::Failed(_)) {
            self.reload_asked = false;
            self.reload_not_before = None;
        }
        // An Update from a phone or another PC that checked first (api.rs `/v1/hub/update`):
        // nothing newer after all, or the scheduled check found it first (it only offers).
        if self.reload_asked && !self.update_ready.load(Ordering::Relaxed) {
            match crate::update::state() {
                crate::update::State::UpToDate => {
                    self.reload_asked = false;
                    self.reload_not_before = None;
                }
                crate::update::State::Available(_) if !crate::update::busy() => crate::update::install_now(ctx),
                _ => {}
            }
        }
        if !self.update_ready.load(Ordering::Relaxed) {
            return;
        }
        if self.reload_asked {
            if let Some(wait) = self.reload_not_before.and_then(|t| t.checked_duration_since(std::time::Instant::now())) {
                ctx.request_repaint_after(wait);
                return;
            }
            self.reload_now();
            return;
        }
        // "Ask me": the Update button waits for a click. A release replaces a preview regardless.
        if !self.auto_update() && !crate::preview::running() {
            return;
        }
        // Agent turns run detached and are picked up again, so they don't hold it back.
        // With no window nobody is interrupted: it restarts at once, still in the background.
        let now = Instant::now();
        let starved = self.reload_watch.looked.is_none_or(|t| now.duration_since(t) > STARVED);
        self.reload_watch.looked = Some(now);
        let key = self.key();
        let m = Moment {
            hidden: crate::background::hidden(),
            focused: ctx.input(|i| i.viewport().focused.unwrap_or(false)),
            idle: now.duration_since(self.reload_watch.input),
            editing: self.drafts.get(&key).is_some_and(|d| !d.trim().is_empty()) || (matches!(self.view, View::Chat(_)) && self.reading_back),
            attached: self.files.values().any(|f| !f.is_empty()),
            watching: matches!(self.view, View::Chat(id) if self.turns.contains_key(&id)),
            starved,
        };
        match quiet(m) {
            Swap::Now => self.reload_now(),
            Swap::Later(wait) => ctx.request_repaint_after(wait),
        }
    }

    /// Something to update to: a build already on disk, or a release to install first.
    pub fn update_offered(&self) -> Option<crate::update::State> {
        use crate::update::State;
        if self.update_ready.load(Ordering::Relaxed) {
            return Some(State::Installed(String::new()));
        }
        Some(crate::update::state()).filter(|s| crate::update::managed() && matches!(s, State::Available(_) | State::Installing(_) | State::Installed(_)))
    }

    /// The Update button: reloads into the new build, installing the release first if needed.
    pub fn update_clicked(&mut self, ctx: &eframe::egui::Context) {
        if self.update_ready.load(Ordering::Relaxed) {
            self.reload_now();
            return;
        }
        self.reload_asked = true;
        crate::update::install_now(ctx);
    }

    /// The Update of the phone's banner or another PC (`POST /v1/hub/update`): the button, but
    /// the reload waits a moment so the reply leaves first, and wakes itself (as incoming calls
    /// do), window or not, focused or not.
    pub fn update_requested(&mut self, ctx: &eframe::egui::Context) {
        const REPLY_FIRST: Duration = Duration::from_secs(1);
        self.reload_asked = true;
        self.reload_not_before = Some(std::time::Instant::now() + REPLY_FIRST);
        let wake = ctx.clone();
        std::thread::spawn(move || {
            std::thread::sleep(REPLY_FIRST);
            wake.request_repaint();
        });
        if !self.update_ready.load(Ordering::Relaxed) {
            crate::update::install_now(ctx);
        }
    }

    /// A preview arrived (preview.rs): other PCs hear of it first, as this one may be about to
    /// restart, and this one restarts into it at once, whatever the moment.
    pub fn preview_arrived(&mut self, offer: Option<crate::preview::Offer>, here: bool) {
        if let Some(o) = offer {
            crate::mesh::announce_preview(self.shared(), &o);
        }
        if here {
            self.reload_now();
        }
    }

    /// Back to the release, and with `off` no more previews here.
    pub fn preview_back(&mut self, off: bool) {
        crate::preview::give_up();
        if off {
            let _ = crate::preview::set_enabled(false);
        }
        if crate::preview::running() {
            self.reload_now();
        }
    }

    pub fn reload_now(&mut self) {
        let state = self.snapshot().to_string();
        self.store.set("reload_state", &state);
        // Stop what can't cross the exec cleanly; dev servers keep running on their own.
        for d in [Dock::Right, Dock::Bottom] {
            self.drop_surfaces(d);
        }
        // The new image opens a window only if this one has one (background.rs).
        let mut args: Vec<String> = std::env::args().skip(1).filter(|a| a != crate::background::FLAG).collect();
        if crate::background::hidden() {
            args.push(crate::background::FLAG.into());
        }
        // Into or out of a preview, this same file otherwise.
        let release_changed = self.update_ready.load(Ordering::Relaxed);
        let Some(exe) = crate::preview::next_exe(release_changed, &args).or_else(crate::update::self_exe) else { return };
        // Development hooks describe the first launch only.
        let err = std::process::Command::new(&exe).args(args).env_remove("HARBOR_VIEW").env_remove("HARBOR_POINTER").env(crate::single::RELOADED_PID, std::process::id().to_string()).exec();
        eprintln!("harbor: reload failed: {err}");
        crate::preview::exec_failed(&err.to_string());
        self.reload_asked = false;
        self.reload_not_before = None;
        self.update_ready.store(false, Ordering::Relaxed);
    }
}

/// Keeps a flag the UI can show (the Update button).
pub fn new_flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_window(idle: u64) -> Moment {
        Moment { focused: true, idle: Duration::from_secs(idle), ..Default::default() }
    }

    #[test]
    fn swaps_only_when_nobody_sees_it() {
        // No window: at once, unless files wait to be sent (a restart drops them).
        assert_eq!(quiet(Moment { hidden: true, editing: true, ..Default::default() }), Swap::Now);
        assert_eq!(quiet(Moment { hidden: true, attached: true, ..Default::default() }), Swap::Later(LOOK));
        // A focused window in use waits until it was left alone for IDLE, looking again meanwhile.
        assert_eq!(quiet(at_window(0)), Swap::Later(LOOK));
        assert_eq!(quiet(at_window(IDLE.as_secs() - 10)), Swap::Later(Duration::from_secs(10)));
        assert_eq!(quiet(at_window(IDLE.as_secs())), Swap::Now);
        assert_eq!(quiet(at_window(3600)), Swap::Now);
        // Not while something is being written, nor while the user looks elsewhere (the new
        // window would open over what they're doing), nor right after the screen came back.
        assert_eq!(quiet(Moment { editing: true, ..at_window(3600) }), Swap::Later(LOOK));
        assert_eq!(quiet(Moment { attached: true, ..at_window(3600) }), Swap::Later(LOOK));
        assert_eq!(quiet(Moment { focused: false, ..at_window(3600) }), Swap::Later(LOOK));
        assert_eq!(quiet(Moment { starved: true, ..at_window(3600) }), Swap::Later(LOOK));
        // A reply coming in on screen may be read as it comes: a longer wait.
        assert_eq!(quiet(Moment { watching: true, ..at_window(IDLE.as_secs()) }), Swap::Later(LOOK));
        assert_eq!(quiet(Moment { watching: true, ..at_window(IDLE_WATCHING.as_secs()) }), Swap::Now);
    }
}
