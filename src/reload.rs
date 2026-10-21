//! Hot reload: when the Harbor binary on disk changes (a new build), Harbor
//! saves what's on screen, replaces itself in place with the new binary (same
//! pid, via exec) and restores it, running agent turns included (they run detached,
//! see detach.rs). It waits for the window to be focused, so it reappears where it was.

use crate::app::{App, Tab, View};
use crate::surface::{Dock, Surface};
use serde_json::{Value, json};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

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
            View::Usage => json!({ "t": "usage" }),
            View::Prs => json!({ "t": "prs" }),
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
                        Surface::DeviceView(v) => json!({ "t": "device-view", "device": crate::devices::device_json(&v.dev), "control": v.control }),
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
            "drafts": self.drafts.iter().filter(|(_, t)| !t.is_empty()).map(|(k, t)| (k.to_string(), Value::String(t.clone()))).collect::<serde_json::Map<String, Value>>(),
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
        if let Some(m) = v["drafts"].as_object() {
            for (k, t) in m {
                if let (Ok(k), Some(t)) = (k.parse::<i64>(), t.as_str()) {
                    self.drafts.insert(k, t.to_string());
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
            Some("usage") => self.open(View::Usage),
            Some("prs") => self.open(View::Prs),
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

    /// Called every frame: reloads when an update is ready and it's a good moment.
    pub fn maybe_reload(&mut self, ctx: &eframe::egui::Context) {
        if !self.update_ready.load(Ordering::Relaxed) {
            return;
        }
        let focused = ctx.input(|i| i.viewport().focused.unwrap_or(false));
        // Agent turns run detached and are picked up again, so they don't hold it back.
        if focused && !self.hold_reload {
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
        let Some(exe) = crate::update::self_exe() else { return };
        let args: Vec<String> = std::env::args().skip(1).collect();
        // Development hooks describe the first launch only.
        let err = std::process::Command::new(&exe).args(args).env_remove("HARBOR_VIEW").env_remove("HARBOR_POINTER").env(crate::single::RELOADED_PID, std::process::id().to_string()).exec();
        eprintln!("harbor: reload failed: {err}");
        self.update_ready.store(false, Ordering::Relaxed);
    }
}

/// Keeps a flag the UI can show ("Update ready").
pub fn new_flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}
