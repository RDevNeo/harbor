//! Usage limits: when an account hits one, Harbor waits for the reset and then
//! continues the work by itself.
//!
//! A limit belongs to the account, not the chat, so the whole account is blocked:
//! new turns on it queue (in `pending`) instead of starting a turn that would fail at
//! once. Each paused chat gets a continuation timer (the `timers` table, kind
//! 'limit') a minute or two after the reset, staggered, sub-agents before their lead;
//! timers, blocks and the queued prompts are stored, so a restart changes nothing. On
//! the timer the chat continues with `RESUME` (if its turn was cut off) and whatever
//! it queued. A limited sub-agent isn't reported to its lead as finished.
//!
//! Where the reset time comes from: Claude's `rate_limit_event` / the synthetic
//! `error: "rate_limit"` message (exact); Codex's "Try again at 3:21 PM"; Gemini's
//! daily quota (midnight Pacific); otherwise a backoff of 15, 30, then 60 minutes.

use crate::agent::Event;
use crate::app::App;
use crate::icons as ic;
use crate::store::{self, Role};
use crate::widgets as w;
use eframe::egui::{self, Ui};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

pub const RESUME: &str = "[harbor] Your usage limit reset. Continue the task from where you stopped.";
/// Hits with the same reset time before Harbor stops trying and asks.
const MAX_TRIES: u32 = 3;

#[derive(Clone, Serialize, Deserialize)]
pub struct Block {
    /// When it should be usable again (Unix time).
    pub until: i64,
    /// "five_hour", "seven_day", … ("" when unknown).
    pub kind: String,
    /// Whether `until` came from the provider (else it's a backoff guess).
    pub known: bool,
    /// Hits in a row with the same `until`.
    pub tries: u32,
    /// Set when it's the user's own cap (usage_ctl.rs) rather than the provider's
    /// limit: the cap in percent.
    #[serde(default)]
    pub cap: Option<u8>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Paused {
    pub account: String,
    /// Its turn was cut off: it continues with `RESUME`.
    pub resume: bool,
    /// When it continues (with a timer), or None when it waits for the user.
    pub at: Option<i64>,
    #[serde(default)]
    pub timer: Option<i64>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct State {
    blocks: HashMap<String, Block>,
    paused: HashMap<i64, Paused>,
    /// Prompts queued for paused chats (`App::pending` is otherwise memory-only).
    #[serde(default)]
    pending: HashMap<i64, Vec<String>>,
    /// Per account: the last quota seen in a turn (window, utilization 0–1, resets at).
    /// Stored, so a cap that a turn's report reached still holds after a restart.
    #[serde(default)]
    pub quota: HashMap<String, Vec<(String, f64, i64)>>,
    /// Chats whose running turn hit a limit (until it exits).
    #[serde(skip)]
    hit: HashSet<i64>,
    /// Chats to move to another account once their limited turn has exited.
    #[serde(skip)]
    switch: HashMap<i64, String>,
    #[serde(skip)]
    pub ctl: crate::usage_ctl::Ctl,
}

/// "5-hour", "weekly", … for a limit window.
pub fn window_label(kind: &str) -> &str {
    match kind {
        "five_hour" => "5-hour",
        k if k.starts_with("seven_day") => "weekly",
        "daily" => "daily",
        _ => "usage",
    }
}

fn is_weekly(kind: &str) -> bool {
    kind.starts_with("seven_day")
}

/// "6:00 PM" today, or "Oct 9, 6:00 PM" further out. Drawn every frame, so no
/// date(1) here: the local offset is read once.
pub fn when(ts: i64) -> String {
    let hm = crate::team::clock(ts);
    if ts - store::now() < 20 * 3600 {
        return hm;
    }
    static OFFSET: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    let off = *OFFSET.get_or_init(|| utc_offset().unwrap_or(0));
    // Civil date from days since the epoch (Howard Hinnant's algorithm).
    let z = (ts + off).div_euclid(86400) + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!("{} {d}, {hm}", MONTHS[(m - 1) as usize])
}

/// The local UTC offset in seconds (from `date +%z`).
fn utc_offset() -> Option<i64> {
    let out = std::process::Command::new("date").arg("+%z").output().ok()?;
    let z = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let sign = if z.starts_with('-') { -1 } else { 1 };
    let n: i64 = z.trim_start_matches(['+', '-']).parse().ok()?;
    Some(sign * ((n / 100) * 3600 + (n % 100) * 60))
}

/// Unix time for a date(1) expression, in the given zone (None: local).
fn date(expr: &str, tz: Option<&str>) -> Option<i64> {
    let mut cmd = std::process::Command::new("date");
    if let Some(z) = tz {
        cmd.env("TZ", z);
    }
    let out = cmd.args(["-d", expr, "+%s"]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// An error that reads like a usage limit, from providers without structured
/// limit events: (window, reset time if it says).
pub fn from_text(text: &str) -> Option<(String, Option<i64>)> {
    let l = text.to_lowercase();
    let limit = ["rate limit", "rate-limit", "rate_limit", "ratelimit", "usage limit", "quota", "resource_exhausted", "hit your limit", " 429"]
        .iter()
        .any(|k| l.contains(k));
    if !limit {
        return None;
    }
    // Codex: "… Try again at 3:21 PM." or "… Try again at Oct 23rd, 2026 3:21 PM."
    if let Some(i) = l.find("try again at ") {
        let rest = &text[i + "try again at ".len()..];
        let when = rest.trim_end().trim_end_matches('.').split(". ").next().unwrap_or("");
        let clean: String = when.replace("st,", ",").replace("nd,", ",").replace("rd,", ",").replace("th,", ",");
        if let Some(mut t) = date(&clean, None) {
            if t < store::now() {
                t += 24 * 3600;
            }
            return Some((String::new(), Some(t)));
        }
    }
    // Gemini: daily quotas reset at midnight Pacific.
    if l.contains("daily quota") || l.contains("per day") {
        return Some(("daily".into(), date("tomorrow 00:00", Some("America/Los_Angeles"))));
    }
    Some((String::new(), None))
}

impl App {
    fn limits_save(&self) {
        self.store.set("limits", &serde_json::to_string(&self.limits).unwrap_or_default());
    }

    /// At startup: blocks, paused chats and their queued prompts come back; their
    /// timers are in the `timers` table.
    pub fn limits_load(&mut self) {
        if let Some(s) = self.store.get("limits").and_then(|v| serde_json::from_str::<State>(&v).ok()) {
            self.limits.blocks = s.blocks;
            self.limits.paused = s.paused;
            self.limits.pending = s.pending;
            self.limits.quota = s.quota;
        }
        let now = store::now();
        self.limits.blocks.retain(|_, b| b.until > now - 24 * 3600);
        for t in self.store.limit_timers() {
            let account = self.chat(t.chat_id).map(|c| c.account.clone()).unwrap_or_default();
            let p = self.limits.paused.entry(t.chat_id).or_insert(Paused { account, resume: true, at: None, timer: None });
            p.at = Some(t.at);
            p.timer = Some(t.id);
        }
        self.limits.paused.retain(|id, _| self.chats.iter().any(|c| c.id == *id));
        for (id, q) in std::mem::take(&mut self.limits.pending) {
            if self.limits.paused.contains_key(&id) {
                self.pending.entry(id).or_insert(q);
            }
        }
        self.limits_sync_pending();
    }

    /// Keeps the stored copy of paused chats' queued prompts current.
    fn limits_sync_pending(&mut self) {
        let ids: Vec<i64> = self.limits.paused.keys().copied().collect();
        self.limits.pending = ids.into_iter().filter_map(|id| self.pending.get(&id).filter(|q| !q.is_empty()).map(|q| (id, q.clone()))).collect();
        self.limits_save();
    }

    /// The account's block, while it lasts.
    pub fn blocked(&self, account: &str) -> Option<&Block> {
        self.limits.blocks.get(account).filter(|b| b.until > store::now())
    }

    /// The account reached the user's cap on a window: blocked like at a limit, until
    /// the window resets.
    pub fn cap_block(&mut self, account: &str, kind: String, cap: u8, until: i64, known: bool) {
        self.limits.blocks.insert(account.to_string(), Block { until, kind, known, tries: 0, cap: Some(cap) });
        self.limits_save();
    }

    /// A cap block that no longer applies (the cap was raised, the usage went down):
    /// it goes, and the chats waiting on it continue now.
    pub fn lift_block(&mut self, account: &str, ctx: &egui::Context) {
        self.limits.blocks.remove(account);
        self.limits_save();
        let waiting: Vec<i64> = self.limits.paused.iter().filter(|(_, p)| p.account == account).map(|(id, _)| *id).collect();
        self.limits.ctl.lifting = true;
        for id in waiting {
            self.continue_chat(id, false, ctx);
        }
        self.limits.ctl.lifting = false;
    }

    /// "Paused at your 80% cap of the weekly limit" or "Hit the weekly limit".
    pub fn block_reason(b: &Block) -> String {
        match b.cap {
            Some(c) => format!("Paused at your {c}% cap of the {} limit", window_label(&b.kind)),
            None => format!("Hit the {} limit", window_label(&b.kind)),
        }
    }

    pub fn paused(&self, chat_id: i64) -> Option<&Paused> {
        self.limits.paused.get(&chat_id)
    }

    /// The chat's running turn ended on a usage limit (so it isn't "finished").
    pub fn hit_limit(&self, chat_id: i64) -> bool {
        self.limits.hit.contains(&chat_id)
    }

    /// Agent events about limits. True when consumed here.
    pub fn limit_event(&mut self, chat_id: i64, ev: &Event) -> bool {
        let account = self.chat(chat_id).map(|c| c.account.clone()).unwrap_or_default();
        match ev {
            Event::Quota(w) => {
                self.limits.quota.insert(account, w.clone());
                self.limits_save();
                true
            }
            Event::Limit { kind, resets_at, text } => {
                self.limit_hit(chat_id, kind, *resets_at, text);
                true
            }
            // Providers without structured limit events (and a Claude limit that only
            // shows up as an error) are recognised by their wording.
            Event::Error(text) if !self.limits.hit.contains(&chat_id) => {
                if let Some((kind, at)) = from_text(text) {
                    self.limit_hit(chat_id, &kind, at, text);
                }
                false
            }
            _ => false,
        }
    }

    /// After the turn's exit was handled.
    pub fn limit_exited(&mut self, chat_id: i64, ctx: &egui::Context) {
        self.limits.hit.remove(&chat_id);
        if let Some(to) = self.limits.switch.remove(&chat_id) {
            let why = self.chat(chat_id).and_then(|c| self.limits.blocks.get(&c.account)).map(|b| format!("hit its {} limit", window_label(&b.kind))).unwrap_or_default();
            // If it can't move, it waits for the reset like any other.
            if !self.continue_on(chat_id, &to, &why, ctx) {
                self.pause(chat_id, true);
            }
        }
    }

    fn limit_hit(&mut self, chat_id: i64, kind: &str, resets_at: Option<i64>, said: &str) {
        let Some(chat) = self.chat(chat_id).cloned() else { return };
        let now = store::now();
        let first = self.limits.hit.insert(chat_id);
        let prev = self.limits.blocks.get(&chat.account).cloned();
        let block = match resets_at.filter(|t| *t > now) {
            Some(until) => {
                let tries = prev.as_ref().filter(|b| b.until == until).map_or(0, |b| b.tries + 1);
                Block { until, kind: kind.to_string(), known: true, tries, cap: None }
            }
            None => {
                // Unknown reset: back off 15, 30, then 60 minutes.
                let tries = prev.as_ref().filter(|b| !b.known && b.until > now - 3 * 3600).map_or(0, |b| b.tries + 1);
                let mins = [15, 30, 60].get(tries as usize).copied().unwrap_or(60);
                Block { until: now + mins * 60, kind: kind.to_string(), known: false, tries, cap: None }
            }
        };
        if !first && prev.as_ref().is_some_and(|b| b.until == block.until) {
            return; // the same hit, seen twice (rate_limit_event and the message)
        }
        self.limits.blocks.insert(chat.account.clone(), block.clone());
        let label = window_label(&block.kind);
        // Auto-switch: it moves to another account once this turn has exited.
        if let Some(to) = self.auto_target(chat_id) {
            let name = self.account(&to).map(account_name).unwrap_or_else(|| to.clone());
            self.notice(chat_id, "clock", &format!("Hit the {label} limit · moving to {name}"), said);
            self.limits.switch.insert(chat_id, to);
            self.limits_save();
            return;
        }
        self.pause(chat_id, true);
        let text = match self.paused(chat_id).and_then(|p| p.at) {
            Some(at) => format!("Hit the {label} limit · continuing at {}", when(at)),
            None if block.tries >= MAX_TRIES => format!("Still at the {label} limit after {MAX_TRIES} tries · continue it yourself"),
            None => format!("Hit the {label} limit · resets {} · waiting for you", when(block.until)),
        };
        self.notice(chat_id, "clock", &text, said);
        // Other chats already waiting on this account move to the new time.
        let others: Vec<i64> = self.limits.paused.iter().filter(|(id, p)| **id != chat_id && p.account == chat.account).map(|(id, _)| *id).collect();
        for id in others {
            let resume = self.limits.paused[&id].resume;
            self.pause(id, resume);
        }
    }

    /// Settings: (continue automatically, also weekly, wait at most (hours), notify).
    pub fn limit_settings(&self) -> (bool, bool, i64, bool) {
        let on = |k: &str, d: bool| self.store.get(k).map_or(d, |v| v == "1");
        let hours = self.store.get("limit_wait_max").and_then(|v| v.parse().ok()).unwrap_or(12);
        (on("limit_auto", true), on("limit_weekly", true), hours, on("limit_notify", false))
    }

    /// Pauses the chat until its account's block ends (sub-agents first, the lead
    /// half a minute after them), or until the user decides.
    fn pause(&mut self, chat_id: i64, resume: bool) {
        let Some(chat) = self.chat(chat_id).cloned() else { return };
        let Some(block) = self.limits.blocks.get(&chat.account).cloned() else { return };
        let (auto, weekly, max_h, _) = self.limit_settings();
        let ok = auto && (weekly || !is_weekly(&block.kind)) && block.until - store::now() <= max_h * 3600 && block.tries < MAX_TRIES;
        let resume = resume || self.limits.paused.get(&chat_id).is_some_and(|p| p.resume);
        if let Some(id) = self.limits.paused.get(&chat_id).and_then(|p| p.timer) {
            self.store.delete_timer(id);
        }
        let at = ok.then(|| {
            let n = self.limits.paused.iter().filter(|(id, p)| **id != chat_id && p.account == chat.account).count() as i64;
            let lead = if chat.role == Role::Lead { 30 } else { 0 };
            block.until + 60 + (chat_id * 7919).rem_euclid(45) + n * 8 + lead
        });
        let timer = at.map(|at| self.store.add_limit_timer(chat_id, at, &chat.account));
        if at.is_none() && !self.limits.paused.contains_key(&chat_id) {
            notify("Usage limit", &format!("{} waits until {}: continue it from Harbor.", chat.title, when(block.until)));
        }
        self.limits.paused.insert(chat_id, Paused { account: chat.account.clone(), resume, at, timer });
        self.limits_sync_pending();
    }

    /// Called by `start_turn`: on a blocked account the prompt is queued and the chat
    /// waits instead. True when it was held back.
    pub fn limit_guard(&mut self, chat_id: i64, prompt: &str, files: &[std::path::PathBuf]) -> bool {
        let Some(account) = self.chat(chat_id).map(|c| c.account.clone()) else { return false };
        if self.blocked(&account).is_none() {
            return false;
        }
        // Auto-switch: the turn starts on another account instead.
        if let Some(to) = self.auto_target(chat_id).filter(|to| self.bring_session(chat_id, to).is_ok()) {
            let from = self.account(&account).map(account_name).unwrap_or_default();
            let name = self.account(&to).map(account_name).unwrap_or_else(|| to.clone());
            if let Some(c) = self.chat_mut(chat_id) {
                c.account = to;
                let c = c.clone();
                self.store.save_chat(&c);
            }
            let why = match self.limits.blocks.get(&account).and_then(|b| b.cap) {
                Some(c) => format!("is at your {c}% cap"),
                None => "is at its usage limit".to_string(),
            };
            self.notice(chat_id, "clock", &format!("Switched to {name} ({from} {why})"), "");
            return false;
        }
        let mut p = prompt.to_string();
        for f in files {
            p.push_str(&format!("\n(attached: {})", f.display()));
        }
        self.pending.entry(chat_id).or_default().push(p);
        // The message is in the transcript already (send pushed it): keep it there.
        self.persist(chat_id);
        if !self.limits.paused.contains_key(&chat_id) {
            self.pause(chat_id, false);
            if let Some(b) = self.limits.blocks.get(&account).filter(|b| b.cap.is_some()).cloned() {
                let then = self.paused(chat_id).and_then(|p| p.at).map(|at| format!(" · continuing at {}", when(at))).unwrap_or_default();
                self.notice(chat_id, "clock", &format!("{}{then}", Self::block_reason(&b)), "");
            }
        } else {
            self.limits_sync_pending();
        }
        true
    }

    /// Every frame: continues the chats whose time has come. Returns how long until
    /// the next one.
    pub fn fire_limit_timers(&mut self, ctx: &egui::Context) -> Option<Duration> {
        self.check_caps(ctx);
        let now = store::now();
        let due: Vec<i64> = self.limits.paused.iter().filter(|(_, p)| p.at.is_some_and(|a| a <= now)).map(|(id, _)| *id).collect();
        for id in due {
            self.continue_chat(id, false, ctx);
        }
        let next = self.limits.paused.values().filter_map(|p| p.at).min().map(|at| Duration::from_secs((at - now).max(1) as u64));
        // A cap can lift any moment (the user raises it, usage drops): look again soon.
        if self.limits.blocks.values().any(|b| b.cap.is_some() && b.until > now) {
            let soon = Duration::from_secs(5);
            return Some(next.map_or(soon, |n| n.min(soon)));
        }
        next
    }

    /// Continues a paused chat: at its time, or now (`force`, "Continue now").
    pub fn continue_chat(&mut self, chat_id: i64, force: bool, ctx: &egui::Context) {
        let Some(p) = self.limits.paused.get(&chat_id).cloned() else { return };
        let Some(chat) = self.chat(chat_id).cloned() else {
            self.limits.paused.remove(&chat_id);
            return;
        };
        if self.turns.contains_key(&chat_id) {
            return;
        }
        if force {
            self.limits.blocks.remove(&p.account);
        } else if self.blocked(&p.account).is_some() {
            // Pushed out meanwhile (a later hit): wait for the new time.
            self.pause(chat_id, p.resume);
            return;
        }
        // Sub-agents keep to the per-lead limit; a full team waits half a minute.
        if chat.role == Role::Sub && !force {
            let busy = chat.parent.map_or(0, |l| self.running_subs(l).len());
            if busy >= crate::team::MAX_RUNNING_SUBS {
                if let Some(id) = p.timer {
                    self.store.delete_timer(id);
                }
                let at = store::now() + 30;
                let timer = Some(self.store.add_limit_timer(chat_id, at, &p.account));
                self.limits.paused.insert(chat_id, Paused { at: Some(at), timer, ..p });
                self.limits_save();
                return;
            }
        }
        if let Some(id) = p.timer {
            self.store.delete_timer(id);
        }
        self.limits.paused.remove(&chat_id);
        let mut parts: Vec<String> = vec![];
        if p.resume {
            parts.push(RESUME.into());
        }
        parts.extend(self.pending.remove(&chat_id).unwrap_or_default());
        self.limits_sync_pending();
        if parts.is_empty() {
            return;
        }
        let text = if self.limits.ctl.lifting { "Under your cap again · continuing" } else { "Usage limit reset · continuing" };
        self.notice(chat_id, "clock", text, "");
        if self.limit_settings().3 {
            notify("Work resumed", &format!("{} continues after the usage limit.", chat.title));
        }
        // Not counted against the hourly cap on automatic turns.
        self.start_turn(chat_id, parts.join("\n\n---\n\n"), vec![], ctx);
    }

    /// "Cancel": the chat stops waiting; what it queued stays queued.
    pub fn cancel_limit(&mut self, chat_id: i64) {
        if let Some(p) = self.limits.paused.remove(&chat_id) {
            if let Some(id) = p.timer {
                self.store.delete_timer(id);
            }
            self.notice(chat_id, "clock", "Won't continue after the usage limit", "");
            self.limits_sync_pending();
        }
    }

    /// The status line of a paused chat (under the transcript).
    /// The usage-limit line under a paused chat, and whether it has a continue time to cancel
    /// (the phone shows the same line).
    pub fn limit_text(&self, chat_id: i64) -> Option<(String, bool)> {
        let p = self.paused(chat_id)?;
        if self.turns.contains_key(&chat_id) {
            return None;
        }
        let block = self.limits.blocks.get(&p.account);
        // The user's own cap reads differently from the provider's limit.
        let what = match block.as_ref().and_then(|b| b.cap.map(|c| (c, b))) {
            Some((c, b)) => format!("Paused at your {c}% cap · resets {}", when(b.until)),
            None => "Usage limit".to_string(),
        };
        let text = match (p.at, &block) {
            (Some(at), _) => format!("{what} · continuing at {} (in {})", when(at), w::minutes((at - store::now()).max(0) as u64)),
            (None, Some(b)) if b.until > store::now() && b.cap.is_none() => format!("{what} · resets {} · waiting for you", when(b.until)),
            _ => format!("{what} · waiting for you"),
        };
        Some((text, p.at.is_some()))
    }

    pub fn limit_line(&mut self, ui: &mut Ui, chat_id: i64) {
        let Some((text, cancel)) = self.limit_text(chat_id) else { return };
        let t = self.theme.t;
        // Nothing else repaints an idle chat: keep "in 2h 10m" current.
        ui.ctx().request_repaint_after(Duration::from_secs(30));
        let mut act = 0;
        let mut to: Option<String> = None;
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new(ic::CLOCK).size(14.0).color(t.amber(900)));
            w::subtle(ui, text, "label-13");
            if w::btn("Continue now").sm().show(ui).clicked() {
                act = 1;
            }
            if cancel && w::btn("Cancel").sm().muted().show(ui).clicked() {
                act = 2;
            }
            // Always offered: continue on another account of the same provider.
            let targets = self.switch_targets(chat_id, false);
            if !targets.is_empty() {
                ui.menu_button(egui::RichText::new("Continue on…").text_style(crate::theme::ts("label-13")), |ui| {
                    for id in &targets {
                        let name = self.account(id).map(|a| format!("{} · {}", a.short(), a.email)).unwrap_or_else(|| id.clone());
                        if ui.button(name).clicked() {
                            to = Some(id.clone());
                            ui.close();
                        }
                    }
                });
            }
        });
        match act {
            1 => self.continue_chat(chat_id, true, ui.ctx()),
            2 => self.cancel_limit(chat_id),
            _ => {}
        }
        if let Some(id) = to {
            self.continue_on(chat_id, &id, "is at its usage limit", ui.ctx());
        }
    }

    /// Settings → Usage limits.
    pub fn limits_settings(&mut self, ui: &mut Ui) {
        let (mut auto, mut weekly, mut hours, mut notify_on) = self.limit_settings();
        let before = (auto, weekly, hours, notify_on);
        crate::pages::section(ui, "After a limit");
        crate::pages::rows(ui, |ui| {
            w::setting_row(ui, "Continue automatically", "The thread waits for the limit to reset, then continues where it stopped, with whatever you queued meanwhile.", |ui| {
                w::toggle(ui, &mut auto)
            });
            w::separator(ui);
            ui.add_enabled_ui(auto, |ui| {
                w::setting_row(ui, "Also after the weekly limit", "Weekly limits can take days to reset.", |ui| w::toggle(ui, &mut weekly));
            });
            w::separator(ui);
            ui.add_enabled_ui(auto, |ui| {
                w::setting_row(ui, "Wait at most", "Longer waits ask you instead.", |ui| {
                    egui::ComboBox::from_id_salt("limit-wait-max").selected_text(format!("{hours} h")).show_ui(ui, |ui| {
                        for h in [1, 3, 6, 12, 24, 48, 168] {
                            ui.selectable_value(&mut hours, h, format!("{h} h"));
                        }
                    });
                });
            });
            w::separator(ui);
            w::setting_row(ui, "Notify me when work resumes", "A desktop notification when a thread continues after its limit.", |ui| w::toggle(ui, &mut notify_on));
        });
        self.switch_settings_ui(ui);
        if (auto, weekly, hours, notify_on) != before {
            let b = |v: bool| if v { "1" } else { "0" };
            self.store.set("limit_auto", b(auto));
            self.store.set("limit_weekly", b(weekly));
            self.store.set("limit_wait_max", &hours.to_string());
            self.store.set("limit_notify", b(notify_on));
        }
    }
}

/// How notices name an account: a Claude account by its own name ("Sam (work)"),
/// which tells accounts apart even when their badges match; others by provider.
pub fn account_name(a: &crate::providers::Account) -> String {
    if a.kind == crate::providers::Kind::Claude && !a.name.is_empty() { a.name.clone() } else { a.short() }
}

pub fn notify(title: &str, body: &str) {
    let (title, body) = (title.to_string(), body.to_string());
    // Waited on a thread so finished notifiers don't linger as zombies.
    std::thread::spawn(move || {
        let _ = std::process::Command::new("notify-send").args(["-a", "Harbor", &title, &body]).status();
    });
}

// ------------------------------------------------------------------ account switching
//
// Optional and off by default: when an account hits its limit, the chat moves to
// another account of the same provider that the user opted in (accounts they own),
// if one has quota left. The Claude session is copied into that account's projects
// folder unless both already share it (the user's symlinked setup). Harbor never
// reads OAuth tokens: quota comes from rate_limit_events seen in turns and from the
// usage monitor's cache.

/// Above this utilization an account doesn't count as having quota left.
const FULL: f64 = 0.95;

impl App {
    /// Auto-switch: (on, opted-in account ids).
    pub fn switch_settings(&self) -> (bool, Vec<String>) {
        let on = self.store.get("limit_switch").as_deref() == Some("1");
        let ids = self.store.get("limit_switch_accounts").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
        (on, ids)
    }

    /// Highest utilization seen for the account (0–1), per window: weekly, 5-hour.
    fn usage_of(&self, account: &str) -> (f64, f64) {
        let mut weekly = 0.0f64;
        let mut five = 0.0f64;
        for (k, u, _) in self.limits.quota.get(account).into_iter().flatten() {
            if is_weekly(k) {
                weekly = weekly.max(*u);
            } else {
                five = five.max(*u);
            }
        }
        if let Some(a) = self.account(account) {
            for wdw in &a.usage {
                let p = wdw.percent as f64;
                if wdw.label.to_lowercase().contains("week") {
                    weekly = weekly.max(p);
                } else {
                    five = five.max(p);
                }
            }
        }
        (weekly, five)
    }

    /// Accounts the chat could continue on: the same provider, signed in, not
    /// blocked, not the current one. `opted` limits it to the auto-switch list, and
    /// to accounts with quota left.
    pub fn switch_targets(&self, chat_id: i64, opted: bool) -> Vec<String> {
        let Some(chat) = self.chat(chat_id) else { return vec![] };
        let Some(kind) = self.account(&chat.account).map(|a| a.kind) else { return vec![] };
        let (_, allowed) = self.switch_settings();
        let mut v: Vec<(String, (f64, f64))> = self
            .accounts
            .iter()
            .filter(|a| a.kind == kind && a.id != chat.account && a.logged_in != Some(false) && self.blocked(&a.id).is_none() && self.over_cap(&a.id).is_none())
            .filter(|a| !opted || allowed.contains(&a.id))
            .map(|a| (a.id.clone(), self.usage_of(&a.id)))
            .filter(|(_, (w, f))| !opted || (*w < FULL && *f < FULL))
            .collect();
        v.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter().map(|(id, _)| id).collect()
    }

    /// Makes the chat's Claude session available to `to` (same project folder name),
    /// unless both accounts already share their projects folder.
    fn bring_session(&self, chat_id: i64, to: &str) -> Result<(), String> {
        let chat = self.chat(chat_id).ok_or("no chat")?;
        let from = self.account(&chat.account).ok_or("no account")?;
        let target = self.account(to).ok_or("no account")?;
        if from.kind != crate::providers::Kind::Claude || !chat.started || chat.session_id.is_empty() {
            return Ok(()); // nothing to carry (or the provider keeps one store)
        }
        // A chat on another device keeps its session there: the next turn finds it in
        // the device's folders (agent.rs `session_here`), whichever account it runs as.
        if !chat.device.is_empty() {
            return Ok(());
        }
        let dir = |a: &crate::providers::Account| a.config_dir.clone().unwrap_or_else(|| store::home().join(".claude")).join("projects");
        let (src_root, dst_root) = (dir(from), dir(target));
        let same = |a: &std::path::Path, b: &std::path::Path| std::fs::canonicalize(a).ok().zip(std::fs::canonicalize(b).ok()).is_some_and(|(x, y)| x == y);
        if same(&src_root, &dst_root) {
            return Ok(());
        }
        let src = crate::undo::session_file(&from.config_dir, &chat.session_id).ok_or("the session file wasn't found")?;
        let slug = src.parent().and_then(|p| p.file_name()).ok_or("bad session path")?;
        // A second copy in another folder of the target would make --resume fail.
        if let Some(existing) = crate::undo::session_file(&target.config_dir, &chat.session_id) {
            if existing.parent().and_then(|p| p.file_name()) != Some(slug) {
                return Err("the target account has this session in another project folder".into());
            }
        }
        let dst_dir = dst_root.join(slug);
        std::fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
        let dst = dst_dir.join(src.file_name().ok_or("bad session path")?);
        let newer = |a: &std::path::Path, b: &std::path::Path| {
            let m = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
            m(b).is_none() || m(a) > m(b)
        };
        if newer(&src, &dst) {
            std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        }
        // Sidecar folder (sub-agent transcripts, tool output overflow), if any.
        let side = src.with_extension("");
        if side.is_dir() {
            let _ = std::process::Command::new("cp").arg("-r").arg(&side).arg(&dst_dir).status();
        }
        Ok(())
    }

    /// Moves the chat to `to` and continues it there now. False if it couldn't move.
    pub fn continue_on(&mut self, chat_id: i64, to: &str, why: &str, ctx: &egui::Context) -> bool {
        if self.turns.contains_key(&chat_id) {
            return false;
        }
        if let Err(e) = self.bring_session(chat_id, to) {
            self.notice(chat_id, "alert", &format!("Couldn't move to another account: {e}"), "");
            return false;
        }
        let from = self.chat(chat_id).and_then(|c| self.account(&c.account)).map(account_name).unwrap_or_default();
        let name = self.account(to).map(account_name).unwrap_or_else(|| to.to_string());
        if let Some(c) = self.chat_mut(chat_id) {
            c.account = to.to_string();
            let c = c.clone();
            self.store.save_chat(&c);
        }
        self.notice(chat_id, "clock", &format!("Switched to {name} ({from} {why})"), "");
        let p = self.limits.paused.remove(&chat_id);
        if let Some(id) = p.as_ref().and_then(|p| p.timer) {
            self.store.delete_timer(id);
        }
        let mut parts: Vec<String> = vec![];
        if p.as_ref().is_none_or(|p| p.resume) {
            parts.push(RESUME.replace("Your usage limit reset", "You're on another account now"));
        }
        parts.extend(self.pending.remove(&chat_id).unwrap_or_default());
        self.limits_sync_pending();
        self.start_turn(chat_id, parts.join("\n\n---\n\n"), vec![], ctx);
        true
    }

    /// After a limit hit, with auto-switch on: the account to move to, if any.
    fn auto_target(&self, chat_id: i64) -> Option<String> {
        self.switch_settings().0.then(|| self.switch_targets(chat_id, true).into_iter().next()).flatten()
    }

    /// Settings › Usage limits, the switching part.
    pub fn switch_settings_ui(&mut self, ui: &mut Ui) {
        let (mut on, ids) = self.switch_settings();
        let before = (on, ids.clone());
        ui.add_space(16.0);
        crate::pages::section(ui, "Switching accounts");
        crate::pages::rows(ui, |ui| {
            w::setting_row(ui, "Switch to another account at a limit", "The thread moves to another of your accounts that has quota left (and is under its caps), and continues there.", |ui| {
                w::toggle(ui, &mut on)
            });
            w::separator(ui);
            w::setting_row(ui, "Accounts to switch to", &format!("{} chosen, with \"Use for auto-switch\" on the account cards above.", ids.len()), |_| {});
        });
        if (on, ids.clone()) != before {
            self.store.set("limit_switch", if on { "1" } else { "0" });
        }
    }
}
