//! Usage Controller: how much of each account's quota Harbor may use.
//!
//! Every account has usage windows (Claude's 5-hour and weekly ones, model-specific
//! weekly ones, Cursor's buckets, …). For each, the user can set a cap, a percentage
//! of the provider's own limit; 100% (the default) means no cap. Reaching a cap
//! counts as hitting a limit: the account gets a block like the one a real limit
//! causes (limits.rs, marked with the cap), so new turns on it queue, auto-switch
//! moves chats to another opted-in account under its caps, and chats continue once
//! the window resets. A turn already running finishes. An optional warning
//! threshold per account sends a notification once per window.
//!
//! Usage comes from what Harbor already sees, never from OAuth tokens: the
//! `rate_limit_event`s of Claude turns (live) and the usage monitor's cache
//! (`providers::apply_usage`). Settings are local to this computer, like all of them.

use crate::app::App;
use crate::icons as ic;
use crate::providers::Kind;
use crate::store;
use crate::limits::account_name;
use crate::widgets as w;
use eframe::egui::{self, Align2, CornerRadius, FontId, Sense, Stroke, Ui, Vec2, pos2};
use std::collections::{HashMap, HashSet};

/// Presets offered under each bar; 100 means no cap.
const PRESETS: [u8; 3] = [50, 80, 100];
/// How often caps are checked against usage (seconds).
const CHECK_EVERY: f64 = 5.0;

/// One usage window of an account.
#[derive(Clone)]
pub struct Win {
    /// Stable key: "5h", "week", "week:opus", or the monitor's label in lowercase.
    pub key: String,
    pub label: String,
    /// Fraction used (0–1); None when there's no data since the window reset.
    pub used: Option<f64>,
    pub resets_at: Option<i64>,
}

/// Runtime state (kept in `limits::State`, not stored).
#[derive(Default)]
pub struct Ctl {
    last_check: f64,
    /// Set while chats continue because a cap block was lifted (for their notice).
    pub lifting: bool,
    /// Warnings already sent: account, window, reset time.
    warned: HashSet<(String, String, i64)>,
}

/// Key and label of a window, from a Claude rate-limit kind or a monitor label.
fn key_label(name: &str) -> (String, String) {
    let l = name.to_lowercase();
    match l.as_str() {
        "five_hour" | "5-hour" | "5 hour" | "session" => ("5h".into(), "5-hour".into()),
        "seven_day" | "weekly" | "week" => ("week".into(), "Weekly".into()),
        _ if l.starts_with("seven_day_") => {
            let model = &name["seven_day_".len()..];
            let mut m = model.to_string();
            if let Some(c) = m.get_mut(0..1) {
                c.make_ascii_uppercase();
            }
            (format!("week:{}", model.to_lowercase()), format!("Weekly · {m}"))
        }
        _ => (l.clone(), name.to_string()),
    }
}

/// The limit kind limits.rs understands, for a window key ("seven_day" for weekly).
fn kind_of(key: &str) -> String {
    match key {
        "5h" => "five_hour".into(),
        "week" => "seven_day".into(),
        k if k.starts_with("week:") => format!("seven_day_{}", &k[5..]),
        k => k.into(),
    }
}

/// "3h 12m", "2d 4h", "12m".
pub fn span(secs: i64) -> String {
    let s = secs.max(0);
    match s {
        0..3600 => format!("{}m", (s / 60).max(1)),
        3600..86400 => format!("{}h {}m", s / 3600, s % 3600 / 60),
        _ => format!("{}d {}h", s / 86400, s % 86400 / 3600),
    }
}

impl App {
    /// The account's usage windows, merging the usage monitor's cache with what
    /// turns reported live (fresher, so it wins).
    pub fn usage_windows(&self, account: &str) -> Vec<Win> {
        let now = store::now();
        let mut v: Vec<Win> = vec![];
        let mut put = |name: &str, used: f64, resets: Option<i64>| {
            let (key, label) = key_label(name);
            // A window that has reset since: its number is stale.
            let used = if resets.is_some_and(|r| r <= now) { None } else { Some(used) };
            match v.iter_mut().find(|x| x.key == key) {
                Some(x) => {
                    x.used = used;
                    x.resets_at = resets.or(x.resets_at);
                }
                None => v.push(Win { key, label, used, resets_at: resets }),
            }
        };
        if let Some(a) = self.account(account) {
            for wdw in &a.usage {
                put(&wdw.label, wdw.percent as f64, wdw.resets_at);
            }
        }
        for (k, u, r) in self.limits.quota.get(account).into_iter().flatten() {
            put(k, *u, (*r > 0).then_some(*r));
        }
        v
    }

    fn caps(&self) -> HashMap<String, HashMap<String, u8>> {
        self.store.get("usage_caps").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
    }

    /// The cap on a window, in percent (100: none).
    pub fn cap(&self, account: &str, key: &str) -> u8 {
        self.caps().get(account).and_then(|m| m.get(key)).copied().unwrap_or(100)
    }

    fn set_cap(&mut self, account: &str, key: &str, pct: u8) {
        let mut all = self.caps();
        let m = all.entry(account.to_string()).or_default();
        if pct >= 100 {
            m.remove(key);
        } else {
            m.insert(key.to_string(), pct.max(5));
        }
        all.retain(|_, m| !m.is_empty());
        self.store.set("usage_caps", &serde_json::to_string(&all).unwrap_or_default());
        self.limits.ctl.last_check = 0.0; // re-check at once
    }

    /// The warning threshold for the account, in percent (0: off).
    pub fn warn_at(&self, account: &str) -> u8 {
        self.store.get("usage_warn").and_then(|v| serde_json::from_str::<HashMap<String, u8>>(&v).ok()).and_then(|m| m.get(account).copied()).unwrap_or(0)
    }

    fn set_warn(&mut self, account: &str, pct: u8) {
        let mut m: HashMap<String, u8> = self.store.get("usage_warn").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
        if pct == 0 {
            m.remove(account);
        } else {
            m.insert(account.to_string(), pct);
        }
        self.store.set("usage_warn", &serde_json::to_string(&m).unwrap_or_default());
    }

    /// The first window the account has reached its cap on: (window, cap).
    pub fn over_cap(&self, account: &str) -> Option<(Win, u8)> {
        self.usage_windows(account).into_iter().find_map(|wdw| {
            let cap = self.cap(account, &wdw.key);
            (cap < 100 && wdw.used.is_some_and(|u| u * 100.0 >= cap as f64)).then_some((wdw, cap))
        })
    }

    /// Every few seconds: blocks accounts that reached a cap (like a limit), lifts
    /// cap blocks that no longer apply (the cap was raised, the window reset) and
    /// continues what waited on them, and sends warnings.
    pub fn check_caps(&mut self, ctx: &egui::Context) {
        let now_t = ctx.input(|i| i.time);
        if now_t - self.limits.ctl.last_check < CHECK_EVERY && self.limits.ctl.last_check > 0.0 {
            return;
        }
        self.limits.ctl.last_check = now_t;
        let now = store::now();
        let ids: Vec<String> = self.accounts.iter().map(|a| a.id.clone()).collect();
        for id in ids {
            let over = self.over_cap(&id);
            let cap_block = self.blocked(&id).is_some_and(|b| b.cap.is_some());
            match over {
                Some((wdw, cap)) if self.blocked(&id).is_none() => {
                    let until = wdw.resets_at.filter(|r| *r > now).unwrap_or(now + 30 * 60);
                    self.cap_block(&id, kind_of(&wdw.key), cap, until, wdw.resets_at.is_some());
                    let name = self.account(&id).map(account_name).unwrap_or_else(|| id.clone());
                    crate::limits::notify(
                        "Usage cap reached",
                        &format!("Harbor paused {name} at your {cap}% cap of the {} limit, until {}.", wdw.label.to_lowercase(), crate::limits::when(until)),
                    );
                }
                None if cap_block => {
                    self.lift_block(&id, ctx);
                }
                _ => {}
            }
            // Warning, once per window period.
            let warn = self.warn_at(&id);
            if warn > 0 {
                for wdw in self.usage_windows(&id) {
                    let Some(u) = wdw.used else { continue };
                    let mark = (id.clone(), wdw.key.clone(), wdw.resets_at.unwrap_or(0));
                    if u * 100.0 >= warn as f64 && !self.limits.ctl.warned.contains(&mark) {
                        self.limits.ctl.warned.insert(mark);
                        let name = self.account(&id).map(account_name).unwrap_or_else(|| id.clone());
                        crate::limits::notify("Usage warning", &format!("{name} has used {:.0}% of its {} limit.", u * 100.0, wdw.label.to_lowercase()));
                    }
                }
            }
        }
    }

    /// The card list on the Usage page: one card per account, grouped by provider.
    pub fn usage_controller(&mut self, ui: &mut Ui) {
        let t = self.theme.t;
        let accounts: Vec<crate::providers::Account> = self.accounts.iter().filter(|a| a.installed() && a.logged_in != Some(false)).cloned().collect();
        if accounts.is_empty() {
            w::subtle(ui, "No provider accounts are signed in on this computer.", "label-13");
            return;
        }
        let (switch_on, mut opted) = self.switch_settings();
        let mut opted_changed = false;
        for kind in Kind::ALL {
            let group: Vec<_> = accounts.iter().filter(|a| a.kind == kind).collect();
            if group.is_empty() {
                continue;
            }
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                let (r, _) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::hover());
                ic::account_mark(ui.painter(), r, kind, "", &t);
                w::text(ui, kind.label(), "strong-14");
            });
            ui.add_space(4.0);
            for a in group {
                let mut use_it = opted.contains(&a.id);
                self.account_card(ui, a, kind == Kind::Claude && accounts.iter().filter(|x| x.kind == Kind::Claude).count() > 1, switch_on, &mut use_it);
                if use_it != opted.contains(&a.id) {
                    opted.retain(|x| *x != a.id);
                    if use_it {
                        opted.push(a.id.clone());
                    }
                    opted_changed = true;
                }
                ui.add_space(8.0);
            }
        }
        if opted_changed {
            self.store.set("limit_switch_accounts", &serde_json::to_string(&opted).unwrap_or_default());
        }
    }

    fn account_card(&mut self, ui: &mut Ui, a: &crate::providers::Account, switchable: bool, switch_on: bool, use_it: &mut bool) {
        let t = self.theme.t;
        let windows = self.usage_windows(&a.id);
        let block = self.blocked(&a.id).cloned();
        let now = store::now();
        w::card(ui).show(ui, |ui| {
            ui.set_width(ui.available_width());
            // Header: logo, name, email and plan; status and auto-switch on the right.
            ui.horizontal(|ui| {
                let (r, _) = ui.allocate_exact_size(Vec2::splat(30.0), Sense::hover());
                ic::account_mark(ui.painter(), r, a.kind, &a.badge, &t);
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 0.0;
                    ui.horizontal(|ui| {
                        w::text(ui, if a.kind == Kind::Claude { &a.name } else { a.kind.label() }, "strong-14");
                        if !a.plan.is_empty() {
                            w::badge(ui, &a.plan, w::Tone::Gray);
                        }
                    });
                    let sub = if a.email.is_empty() { a.short() } else { format!("{} · {}", a.short(), a.email) };
                    w::subtle(ui, sub, "label-12");
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if switchable {
                        ui.add_enabled_ui(switch_on, |ui| w::toggle(ui, use_it)).response.on_hover_text(if switch_on {
                            "When another account hits its limit or cap, its threads may move here."
                        } else {
                            "Turn on account switching in Settings › Usage limits first."
                        });
                        w::subtle(ui, "Use for auto-switch", "label-12");
                        ui.add_space(8.0);
                    }
                    match &block {
                        Some(b) if b.cap.is_some() => {
                            w::badge(ui, &format!("Paused at {}% · until {}", b.cap.unwrap_or(100), crate::limits::when(b.until)), w::Tone::Amber);
                        }
                        Some(b) => {
                            w::badge(ui, &format!("Limit reached · until {}", crate::limits::when(b.until)), w::Tone::Red);
                        }
                        None => {}
                    }
                });
            });
            ui.add_space(8.0);
            if windows.is_empty() {
                w::subtle(ui, "No usage data yet. It shows up after this account's next turn, or from the usage monitor.", "label-13");
                return;
            }
            // Plain-language summary.
            let capped: Vec<(Win, u8)> = windows.iter().filter_map(|x| {
                let c = self.cap(&a.id, &x.key);
                (c < 100).then(|| (x.clone(), c))
            }).collect();
            let summary = if capped.is_empty() {
                "No caps: Harbor uses this account up to the provider's own limits.".to_string()
            } else {
                let parts: Vec<String> = capped
                    .iter()
                    .map(|(x, c)| match x.used {
                        Some(u) => format!("{c}% of the {} limit (now {:.0}%)", x.label.to_lowercase(), u * 100.0),
                        None => format!("{c}% of the {} limit", x.label.to_lowercase()),
                    })
                    .collect();
                format!("Harbor will stop using this account at {}.", parts.join(" and at "))
            };
            ui.label(egui::RichText::new(summary).text_style(crate::theme::ts("copy-14")).color(t.fg()));
            ui.add_space(6.0);
            for x in &windows {
                ui.add_space(6.0);
                let cap = self.cap(&a.id, &x.key);
                let warn = self.warn_at(&a.id);
                // Label and numbers.
                ui.horizontal(|ui| {
                    w::text(ui, &x.label, "strong-14");
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let resets = x.resets_at.filter(|r| *r > now).map(|r| format!("resets in {}", span(r - now))).unwrap_or_default();
                        let used = match x.used {
                            Some(u) => format!("{:.0}% used", u * 100.0),
                            None => "no data since the reset".into(),
                        };
                        let txt = if resets.is_empty() { used } else { format!("{used}  ·  {resets}") };
                        w::subtle(ui, txt, "label-12");
                    });
                });
                // The bar, with its draggable cap marker.
                if let Some(new) = cap_bar(ui, x.used, cap, warn, &t) {
                    self.set_cap(&a.id, &x.key, new);
                }
                // Presets.
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 4.0;
                    for p in PRESETS {
                        let label = if p == 100 { "Unlimited".to_string() } else { format!("{p}%") };
                        if w::btn(&label).sm().muted().pressed(cap == p || (p == 100 && cap >= 100)).show(ui).clicked() {
                            self.set_cap(&a.id, &x.key, p);
                        }
                    }
                    if cap < 100 && !PRESETS.contains(&cap) {
                        w::subtle(ui, format!("cap {cap}%"), "label-12");
                    }
                });
            }
            ui.add_space(8.0);
            w::separator(ui);
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                w::subtle(ui, "Warn me at", "label-13");
                let mut warn = self.warn_at(&a.id);
                let before = warn;
                egui::ComboBox::from_id_salt(("usage-warn", a.id.clone())).selected_text(if warn == 0 { "Off".to_string() } else { format!("{warn}%") }).show_ui(ui, |ui| {
                    for p in [0u8, 50, 60, 70, 80, 90] {
                        ui.selectable_value(&mut warn, p, if p == 0 { "Off".to_string() } else { format!("{p}%") });
                    }
                });
                if warn != before {
                    self.set_warn(&a.id, warn);
                }
                w::subtle(ui, "of any window: a notification, once per window.", "label-12");
            });
        });
    }
}

/// A usage bar with the cap marker (dragged or clicked to move it, in 5% steps;
/// 100% is no cap). Returns a new cap when the user moved it.
fn cap_bar(ui: &mut Ui, used: Option<f64>, cap: u8, warn: u8, t: &crate::theme::Tokens) -> Option<u8> {
    let h = 30.0;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), h), Sense::click_and_drag());
    let p = ui.painter();
    let track = egui::Rect::from_min_max(pos2(rect.left(), rect.center().y - 4.0), pos2(rect.right(), rect.center().y + 4.0));
    p.rect_filled(track, CornerRadius::same(4), t.gray(200));
    if let Some(u) = used {
        let frac = u.clamp(0.0, 1.0) as f32;
        let col = if cap < 100 && u * 100.0 >= cap as f64 {
            t.red(800)
        } else if warn > 0 && u * 100.0 >= warn as f64 {
            t.amber(800)
        } else {
            t.blue(800)
        };
        let fill = egui::Rect::from_min_max(track.min, pos2(track.left() + track.width() * frac, track.max.y));
        p.rect_filled(fill, CornerRadius::same(4), col);
    }
    // The marker: a line and a small label above the track.
    let x = |pct: f32| track.left() + track.width() * pct / 100.0;
    let hover = resp.hovered() || resp.dragged();
    if cap < 100 {
        let cx = x(cap as f32);
        p.line_segment([pos2(cx, track.top() - 7.0), pos2(cx, track.bottom() + 7.0)], Stroke::new(2.0, t.fg()));
        let label = format!("{cap}%");
        let g = p.layout_no_wrap(label, FontId::proportional(11.0), t.on_primary());
        let lr = egui::Rect::from_center_size(pos2(cx.clamp(rect.left() + 18.0, rect.right() - 18.0), track.top() - 9.0), g.size() + Vec2::new(10.0, 2.0));
        p.rect_filled(lr, CornerRadius::same(5), t.fg());
        p.galley(lr.center() - g.size() / 2.0, g, t.on_primary());
    } else if hover {
        p.text(pos2(rect.right(), track.top() - 9.0), Align2::RIGHT_CENTER, "Unlimited · drag to set a cap", FontId::proportional(11.0), t.subtle());
    }
    let resp = resp.on_hover_cursor(egui::CursorIcon::ResizeHorizontal);
    if (resp.dragged() || resp.clicked()) && resp.interact_pointer_pos().is_some() {
        let px = resp.interact_pointer_pos().unwrap().x;
        let pct = ((px - track.left()) / track.width() * 100.0).clamp(5.0, 100.0);
        let snapped = ((pct / 5.0).round() * 5.0) as u8;
        if snapped != cap {
            return Some(snapped);
        }
    }
    None
}
