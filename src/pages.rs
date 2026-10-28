//! Full-page views: Settings (providers, integrations, appearance), Usage,
//! plus the modal dialogs. Pull requests live in prs.rs.

use crate::widgets::Tip as _;
use crate::app::{App, CONTENT_W, Dialog, Tab, View, ago};
use crate::chat::centered;
use crate::icons as ic;
use crate::mcp;
use crate::providers::Kind;
use crate::store::{self, Item};
use crate::theme::{self, Mode};
use crate::widgets::{self as w, Tone};
use eframe::egui::{self, Align, Color32, CornerRadius, Frame, Id, Key, Layout, Margin, Rect, RichText, ScrollArea, Sense, Stroke, Ui, Vec2, pos2};
use std::collections::{BTreeMap, HashMap};

pub fn section(ui: &mut Ui, title: &str) {
    ui.add_space(8.0);
    w::text(ui, title, "heading-16");
    ui.add_space(6.0);
}

/// Usage rows in a card: a name, then its tokens and cost, dim, with the whole split on hover.
fn usage_rows(ui: &mut Ui, rows: Vec<(String, crate::cost::Usage)>) {
    w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
        ui.set_width(ui.available_width());
        if rows.is_empty() {
            Frame::new().inner_margin(Margin::same(16)).show(ui, |ui| w::subtle(ui, "No turns yet.", "label-13"));
        }
        for (i, (name, u)) in rows.iter().enumerate() {
            if i > 0 {
                w::separator(ui);
            }
            Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    w::text(ui, name, "strong-14");
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        w::subtle(ui, u.compact(), "label-13-mono").tip(u.detail());
                    });
                });
            });
        }
    });
}

/// A settings card: rows split by `w::separator`, flush to its edges.
pub fn rows(ui: &mut Ui, add: impl FnOnce(&mut Ui)) {
    w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 0.0;
        add(ui);
    });
}

/// What Settings › Usage shows: per account (turns, tokens in, out, cost), tokens per day, and
/// per project, per day and per chat (cost.rs's Usage; the agent cards read the last).
#[derive(Clone, Default, Debug, PartialEq)]
pub struct Totals {
    pub by_account: BTreeMap<String, (u64, u64, u64, f64)>,
    pub by_day: BTreeMap<i64, u64>,
    /// The last 14 days.
    pub days: BTreeMap<i64, crate::cost::Usage>,
    /// By project name ("" for chats without one).
    pub by_project: BTreeMap<String, crate::cost::Usage>,
    pub by_chat: HashMap<i64, crate::cost::Usage>,
}

/// Sums turn results; `chats` is each chat's (account, project name): the account for results
/// saved without one.
pub fn sum_results(results: Vec<(i64, Item)>, chats: &HashMap<i64, (String, String)>, today: i64) -> Totals {
    let mut t = Totals::default();
    for (chat, it) in results {
        if let Item::Result { input_tokens, output_tokens, cost_usd, at, account, .. } = &it {
            let (acc, project) = chats.get(&chat).cloned().unwrap_or_default();
            let a = if account.is_empty() { acc } else { account.clone() };
            let e = t.by_account.entry(a).or_default();
            e.0 += 1;
            e.1 += input_tokens;
            e.2 += output_tokens;
            e.3 += cost_usd;
            if *at > 0 && today - at / 86400 < 14 {
                *t.by_day.entry(at / 86400).or_default() += input_tokens + output_tokens;
                t.days.entry(at / 86400).or_default().add(&it);
            }
            t.by_project.entry(project).or_default().add(&it);
            t.by_chat.entry(chat).or_default().add(&it);
        }
    }
    t
}

/// The Usage page's totals: read from the store on a thread, again only when the
/// chats change (a turn ends, a chat goes away) or a minute has passed, never per frame.
#[derive(Default)]
pub struct UsageTotals {
    asked: Option<(usize, i64, i64)>,
    running: bool,
    done: std::sync::Arc<std::sync::Mutex<Option<Totals>>>,
    totals: Totals,
}

impl UsageTotals {
    /// The totals as last summed (without asking again).
    pub fn last(&self) -> &Totals {
        &self.totals
    }

    fn get(&mut self, ctx: &egui::Context, key: (usize, i64, i64), accounts: HashMap<i64, (String, String)>, today: i64) -> &Totals {
        if let Some(t) = self.done.lock().unwrap_or_else(|e| e.into_inner()).take() {
            self.totals = t;
            self.running = false;
        }
        if !self.running && self.asked != Some(key) {
            self.asked = Some(key);
            self.running = true;
            let (done, ctx) = (self.done.clone(), ctx.clone());
            std::thread::spawn(move || {
                let t = sum_results(store::results(), &accounts, today);
                *done.lock().unwrap_or_else(|e| e.into_inner()) = Some(t);
                ctx.request_repaint();
            });
        }
        &self.totals
    }
}

impl Tab {
    pub const ALL: [Tab; 12] = [Tab::Account, Tab::General, Tab::Notifications, Tab::Appearance, Tab::Keybindings, Tab::Voice, Tab::Providers, Tab::Limits, Tab::Integrations, Tab::Devices, Tab::Phones, Tab::Webhooks];

    pub fn label(self) -> &'static str {
        match self {
            Tab::Account => "Account",
            Tab::General => "General",
            Tab::Notifications => "Notifications",
            Tab::Appearance => "Appearance",
            Tab::Keybindings => "Keybindings",
            Tab::Providers => "Providers",
            Tab::Limits => "Usage",
            Tab::Integrations => "Integrations",
            Tab::Webhooks => "Webhooks",
            Tab::Devices => "Devices",
            Tab::Phones => "Phones",
            Tab::Voice => "Voice",
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            Tab::Account => ic::USER_ROUND,
            Tab::General => ic::SLIDERS,
            Tab::Notifications => ic::BELL,
            Tab::Appearance => ic::PALETTE,
            Tab::Keybindings => ic::KEYBOARD,
            Tab::Providers => ic::BOT,
            Tab::Limits => ic::GAUGE,
            Tab::Integrations => ic::PLUG,
            Tab::Webhooks => ic::WEBHOOK,
            Tab::Devices => ic::MONITOR,
            Tab::Phones => ic::SMARTPHONE,
            Tab::Voice => ic::MIC,
        }
    }

    /// Its name in reload snapshots and HARBOR_VIEW.
    pub fn slug(self) -> &'static str {
        match self {
            Tab::Account => "account",
            Tab::General => "general",
            Tab::Notifications => "notifications",
            Tab::Appearance => "appearance",
            Tab::Keybindings => "keybindings",
            Tab::Providers => "providers",
            Tab::Limits => "usage",
            Tab::Integrations => "integrations",
            Tab::Webhooks => "webhooks",
            Tab::Devices => "devices",
            Tab::Phones => "phones",
            Tab::Voice => "voice",
        }
    }

    pub fn from_slug(s: &str) -> Option<Tab> {
        // "limits": the Usage page's old name.
        Tab::ALL.into_iter().find(|t| t.slug() == s || (s == "limits" && *t == Tab::Limits))
    }

    /// What the settings search matches besides the name.
    pub fn keywords(self) -> &'static str {
        match self {
            Tab::Account => "account google sign in sign out login logout workspace invite people members team email pcs",
            Tab::General => "restart resume continue order activity sort fast mode recap summary suggestion prompt background tray autostart login startup quit close",
            Tab::Notifications => "notify notifications alerts popups desktop phone quiet hours away finished needs input ci checks limit offline",
            Tab::Appearance => "theme dark light omarchy colours colors density compact comfortable",
            Tab::Keybindings => "shortcuts keyboard keys hotkeys cheat sheet",
            Tab::Providers => "accounts claude codex cursor gemini sign in login models default",
            Tab::Limits => "usage limits quota caps cap percent warn tokens cost weekly wait switch accounts notify history",
            Tab::Integrations => "apps mcp servers sign in tools",
            Tab::Webhooks => "hooks public url https certificate lets encrypt",
            Tab::Devices => "remote machines pcs tailscale ssh run agents elsewhere mcp bridge",
            Tab::Phones => "android phone mobile app sign in api",
            Tab::Voice => "voice dictation speech microphone mic whisper transcribe language model",
        }
    }

    fn desc(self) -> &'static str {
        match self {
            Tab::Account => "Your Google account, this PC's workspace and the people who share it. Settings follow your account to every PC you sign in on.",
            Tab::General => "How threads behave.",
            Tab::Notifications => "What Harbor tells you about while you're elsewhere, on this desktop and on your phones.",
            Tab::Appearance => "How Harbor looks.",
            Tab::Keybindings => "Harbor's keyboard shortcuts. Changes apply at once.",
            Tab::Providers => "",
            Tab::Limits => "What each account has used, how much of it Harbor may use, and what threads do at a limit.",
            Tab::Integrations => "",
            Tab::Webhooks => "",
            Tab::Devices => "Run agents on your other PCs. They work in that PC's folders, with this PC's MCP servers and apps.",
            Tab::Phones => "Your chats on your phone: Harbor for Android signs in with Google and talks to this PC over your network, encrypted with both keys.",
            Tab::Voice => "Dictate into the composer. Speech is transcribed on this PC with whisper.cpp: private, free, offline.",
        }
    }
}

impl App {
    // ------------------------------------------------------------ settings

    /// One settings page; the sidebar lists the pages (`settings_nav`).
    pub fn settings(&mut self, ui: &mut Ui, tab: Tab) {
        let t = self.theme.t;
        // Esc leaves Settings, unless something open on it takes the key first (a menu, a
        // dialog, a key being set) or a text field had focus (Esc only blurs it).
        let ctx = ui.ctx().clone();
        let typing = ctx.text_edit_focused();
        let calm = self.popup.is_none() && self.dialog.is_none() && self.keys.capture.is_none() && !w::popover_open(&ctx) && !egui::Popup::is_any_open(&ctx);
        egui::Panel::top("settings_bar")
            .frame(Frame::new().inner_margin(Margin { left: 18, right: 10, top: 8, bottom: 8 }).fill(t.bg100))
            .show_separator_line(false)
            .show(ui, |ui| {
                ui.allocate_ui_with_layout(Vec2::new(ui.available_width(), 30.0), Layout::left_to_right(Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    if !self.sidebar_docked(ui.ctx()) {
                        if w::btn(ic::PANEL_LEFT).muted().icon_xs().show(ui).tip(self.key_hint("Show sidebar", "toggle_sidebar")).clicked() {
                            let ctx = ui.ctx().clone();
                            self.toggle_sidebar(&ctx);
                        }
                        ui.add_space(4.0);
                    }
                    let home = ui.add(egui::Label::new(RichText::new(format!("{}  Settings", ic::SETTINGS)).text_style(theme::ts("label-14")).color(t.subtle())).sense(Sense::click()));
                    if home.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                        self.open(View::Settings(Tab::General));
                    }
                    ui.label(RichText::new("/").text_style(theme::ts("label-14")).color(t.gray(600)));
                    ui.label(RichText::new(tab.label()).text_style(theme::ts("label-14")).color(t.fg()));
                });
            });
        ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            centered(ui, CONTENT_W, |ui| {
                ui.add_space(20.0);
                w::text(ui, tab.label(), "heading-24");
                if !tab.desc().is_empty() {
                    ui.add_space(2.0);
                    w::subtle(ui, tab.desc(), "copy-14");
                }
                ui.add_space(20.0);
                match tab {
                    Tab::Account => self.account_tab(ui),
                    Tab::General => self.general_tab(ui),
                    Tab::Notifications => self.notifications_tab(ui),
                    Tab::Appearance => self.appearance_tab(ui),
                    Tab::Keybindings => self.keybindings_tab(ui),
                    Tab::Providers => self.providers_tab(ui),
                    Tab::Limits => self.usage_tab(ui),
                    Tab::Integrations => self.integrations_tab(ui),
                    Tab::Webhooks => self.webhooks_tab(ui),
                    Tab::Devices => self.devices_tab(ui),
                    Tab::Phones => self.phones_tab(ui),
                    Tab::Voice => self.voice_tab(ui),
                }
                ui.add_space(40.0);
            });
        });
        if calm && self.dialog.is_none() && !w::popover_open(&ctx) && crate::listdetail::esc_leaves(&ctx, typing) {
            self.leave_settings();
        }
    }

    /// Back from Settings: to the view it was opened from.
    pub fn leave_settings(&mut self) {
        let v = match self.settings_back {
            View::Chat(id) if self.chat(id).is_none() => View::Draft,
            View::Settings(_) => View::Draft,
            v => v,
        };
        self.open(v);
    }

    fn general_tab(&mut self, ui: &mut Ui) {
        let (mut resume, mut order, mut fast) = (self.resume_on_restart(), self.order_by_activity, self.fast);
        let follow = self.follow_default();
        let mut steer = follow == crate::queue::Mode::Steer;
        rows(ui, |ui| {
            // Steer or Queue (queue.rs), as T3 Code's "Follow-up behavior".
            w::setting_row(
                ui,
                "While the agent works, Enter…",
                "Steer: your message reaches the agent right away, changing what it's working on. Queue: it waits and runs after the current turn. Ctrl+Enter does the other for one message. Agents that can't be steered (Cursor, Gemini, Grok, OpenCode, Meta) always queue.",
                |ui| {
                    if let Some(i) = w::tabs(ui, &["Queue", "Steer"], usize::from(steer)) {
                        steer = i == 1;
                    }
                },
            );
            w::separator(ui);
            w::setting_row(
                ui,
                "Continue threads after restarts",
                "A thread that was working when the computer restarted picks up where it stopped the next time Harbor opens. Turns still running across a Harbor reload always come back.",
                |ui| w::toggle(ui, &mut resume),
            );
            w::separator(ui);
            w::setting_row(ui, "Order threads by activity", "The sidebar lists the most recently active projects first. Off, you drag them into your own order.", |ui| {
                w::toggle(ui, &mut order)
            });
            w::separator(ui);
            w::setting_row(ui, "Fast mode", "Claude and Codex turns use fast mode where the model has it. Also in the composer's reasoning menu.", |ui| w::toggle(ui, &mut fast));
        });
        let b = |v: bool| if v { "1" } else { "0" };
        if steer != (follow == crate::queue::Mode::Steer) {
            self.set_follow_default(if steer { crate::queue::Mode::Steer } else { crate::queue::Mode::Queue });
        }
        if resume != self.resume_on_restart() {
            self.store.set("resume_on_restart", b(resume));
        }
        if order != self.order_by_activity {
            self.order_by_activity = order;
            self.store.set("order_by_activity", b(order));
        }
        if fast != self.fast {
            self.fast = fast;
            self.store.set("fast_mode", b(fast));
        }
        ui.add_space(12.0);
        section(ui, "Background");
        self.background_rows(ui);
        ui.add_space(12.0);
        section(ui, "Recaps and suggestions");
        self.recap_rows(ui);
        ui.add_space(12.0);
        section(ui, "Issues and pull requests");
        self.auto_rows(ui);
        ui.add_space(12.0);
        section(ui, "Updates");
        self.updates_rows(ui);
    }

    /// Keep running when the window closes, start at login, quit completely (background.rs).
    fn background_rows(&mut self, ui: &mut Ui) {
        let ctx = ui.ctx().clone();
        let mut keep = self.keep_running();
        let mut login = crate::background::autostart();
        rows(ui, |ui| {
            w::setting_row(
                ui,
                "Keep running in the background when the window is closed",
                "Phones and your other PCs keep reaching this PC, and the queue, automatic work, wake-ups and webhooks go on. Run Harbor again (or use its tray icon) to open the window.",
                |ui| w::toggle(ui, &mut keep),
            );
            w::separator(ui);
            w::setting_row(ui, "Start Harbor when I log in", "Starts in the background, without a window, so this PC is reachable as soon as you log in.", |ui| w::toggle(ui, &mut login));
            w::separator(ui);
            let tray = if crate::tray::active() { "Also in the tray icon's menu." } else { "No tray was found on this desktop, so quit from here." };
            w::setting_row(ui, "Quit Harbor completely", &format!("Stops everything: phones and other PCs can't reach this PC until Harbor runs again. Running agent turns finish on their own. {tray}"), |ui| {
                if w::btn("Quit Harbor").sm().outline().show(ui).clicked() {
                    crate::background::quit(&ctx);
                }
            });
        });
        if keep != self.keep_running() {
            self.set_keep_running(keep);
        }
        if login != crate::background::autostart() {
            if let Err(e) = crate::background::set_autostart(login) {
                crate::picker::show_toast(&ctx, format!("Couldn't change the login item: {e}"));
            }
        }
    }

    /// The cheat sheet (`?`): every shortcut with the keys it has now, filterable.
    fn shortcuts_dialog(&mut self, ui: &mut Ui, query: &mut String, close: &mut bool) {
        use crate::keys::{ACTIONS, GROUPS};
        let t = self.theme.t;
        w::text(ui, "Keyboard shortcuts", "heading-20");
        ui.add_space(16.0);
        let r = Frame::new().stroke(Stroke::new(1.0, t.border())).corner_radius(CornerRadius::same(theme::RADIUS_MD)).show(ui, |ui| {
            w::search_field(ui, query, "Search shortcuts", Some(Id::NULL.with("shortcuts-search")), ui.available_width())
        });
        if !r.inner.has_focus() && !r.inner.lost_focus() {
            r.inner.request_focus();
        }
        let q = query.trim().to_lowercase();
        ui.add_space(8.0);
        ScrollArea::vertical().max_height(ui.ctx().content_rect().height() * 0.55).auto_shrink([false, true]).show(ui, |ui| {
            let mut any = false;
            for g in GROUPS {
                let acts: Vec<_> = ACTIONS
                    .iter()
                    .filter(|a| a.group == *g)
                    .filter(|a| q.is_empty() || [a.label, a.group, &crate::keys::label(&self.keys.get(a.id))].iter().any(|s| s.to_lowercase().contains(&q)))
                    .collect();
                if acts.is_empty() {
                    continue;
                }
                any = true;
                ui.add_space(8.0);
                w::subtle(ui, *g, "label-12");
                ui.add_space(4.0);
                for a in acts {
                    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 32.0), Sense::hover());
                    ui.painter().text(pos2(rect.left(), rect.center().y), egui::Align2::LEFT_CENTER, a.label, egui::FontId::proportional(14.0), t.fg());
                    let keys = crate::keys::label(&self.keys.get(a.id));
                    let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rect).layout(Layout::right_to_left(Align::Center)));
                    w::kbd_combo(&mut child, &keys);
                }
            }
            if !any {
                ui.add_space(8.0);
                w::subtle(ui, format!("No shortcut matches “{}”.", query.trim()), "copy-14");
            }
        });
        ui.add_space(16.0);
        ui.horizontal(|ui| {
            w::subtle(ui, format!("{} anywhere, or ? outside a text field, shows this.", crate::keys::label(&self.keys.get("shortcuts"))), "label-13");
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if w::btn("Change them…").outline().show(ui).clicked() {
                    self.open(View::Settings(Tab::Keybindings));
                    *close = true;
                }
            });
        });
    }

    /// Version, Updates (Ask me / Automatically), Check now / Install / Restore previous.
    fn updates_rows(&mut self, ui: &mut Ui) {
        use crate::update::{self as up, State};
        let ctx = ui.ctx().clone();
        let managed = up::managed();
        let mut auto = self.auto_update();
        let busy = up::busy();
        let status = match up::state() {
            _ if !managed => "Built from source: updates come from your checkout, not from GitHub.".to_string(),
            State::Idle => "Harbor checks GitHub for a new version a little after it starts, then every few hours.".into(),
            State::Checking => "Checking…".into(),
            State::UpToDate => "Harbor is up to date.".into(),
            State::Available(v) => format!("Harbor {v} is available."),
            State::Installing(v) => format!("Installing {v}…"),
            State::Installed(v) if auto => format!("Harbor {v} is installed. It takes over by itself when you're away (window closed, or left alone a few minutes); running agents carry on."),
            State::Installed(v) => format!("Harbor {v} is installed. Click Update ready at the top to switch to it; running agents carry on."),
            State::Failed(e) => format!("The last update failed: {e}"),
        };
        rows(ui, |ui| {
            w::setting_row(ui, &format!("Harbor {}", up::version_label()), &status, |ui| {
                if !managed {
                    return;
                }
                if let State::Available(v) = up::state() {
                    if w::btn(&format!("Install {v}")).sm().primary().enabled(!busy).show(ui).clicked() {
                        self.update_clicked(&ctx);
                    }
                }
                if w::btn("Check now").sm().outline().enabled(!busy).show(ui).clicked() {
                    up::check(auto, &ctx);
                }
            });
            w::separator(ui);
            w::setting_row(
                ui,
                "Updates",
                "Ask me: an Update button appears at the top when a new version or build is out; clicking it installs it and reloads Harbor in place, without losing your place. Automatically: new versions are downloaded and their signature checked in the background, then swapped in while you're away (the window closed, or left alone a few minutes with nothing typed), back on the same screen. Phones that haven't chosen for themselves follow this.",
                |ui| {
                    if let Some(i) = w::tabs(ui, &["Ask me", "Automatically"], usize::from(auto)) {
                        auto = i == 1;
                    }
                },
            );
            if managed && up::has_previous() {
                w::separator(ui);
                w::setting_row(ui, "Previous version", "The version before the last update is kept, in case the new one misbehaves.", |ui| {
                    if w::btn("Restore it").sm().outline().enabled(!busy).show(ui).clicked() {
                        self.reload_asked = true;
                        up::restore_previous(&ctx);
                    }
                });
            }
        });
        if auto != self.auto_update() {
            self.store.set("auto_update", if auto { "1" } else { "0" });
        }
    }

    fn keybindings_tab(&mut self, ui: &mut Ui) {
        use crate::keys::{ACTIONS, GROUPS};
        let t = self.theme.t;
        ui.horizontal(|ui| {
            let reset = ui.painter().layout_no_wrap("Reset all".into(), egui::FontId::new(12.0, theme::medium()), t.fg()).size().x + 40.0;
            Frame::new().stroke(Stroke::new(1.0, t.border())).corner_radius(CornerRadius::same(theme::RADIUS_MD)).show(ui, |ui| {
                w::search_field(ui, &mut self.keys.search, "Search shortcuts", Some(Id::NULL.with("keys-search")), (ui.available_width() - reset).max(120.0));
            });
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if w::btn("Reset all").sm().outline().enabled(self.keys.has_custom()).show(ui).clicked() {
                    self.keys.reset_all(&self.store);
                    self.keys.capture = None;
                }
            });
        });
        let q = self.keys.search.trim().to_lowercase();
        let mut any = false;
        for g in GROUPS {
            let acts: Vec<&'static crate::keys::Action> = ACTIONS
                .iter()
                .filter(|a| a.group == *g)
                .filter(|a| q.is_empty() || [a.label, a.when, a.group, &crate::keys::label(&self.keys.get(a.id))].iter().any(|s| s.to_lowercase().contains(&q)))
                .collect();
            if acts.is_empty() {
                continue;
            }
            any = true;
            ui.add_space(12.0);
            section(ui, g);
            rows(ui, |ui| {
                for (i, a) in acts.iter().enumerate() {
                    if i > 0 {
                        w::separator(ui);
                    }
                    self.key_row(ui, a);
                }
            });
        }
        if !any {
            ui.add_space(16.0);
            w::subtle(ui, format!("No shortcut matches “{}”.", self.keys.search.trim()), "copy-14");
        }
        ui.add_space(10.0);
        w::subtle(
            ui,
            "Click a shortcut, then press the new keys, e.g. Ctrl+Shift+K (Ctrl, Alt and Shift). Esc alone cancels, Backspace alone goes back to the default. Super combos can't be used: Hyprland takes most of them before Harbor sees them.",
            "label-12",
        );
    }

    /// A shortcut: what it does and when on the left, its keys on the right (a click
    /// waits for new keys, unless it's fixed).
    fn key_row(&mut self, ui: &mut Ui, a: &'static crate::keys::Action) {
        let t = self.theme.t;
        let capturing = self.keys.capture == Some(a.id);
        let custom = self.keys.is_custom(a.id);
        let conflicts = self.keys.conflicts(a.id);
        Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
            let full = ui.available_width();
            let top = ui.cursor().min;
            let lw = full - 240.0;
            let left = ui
                .allocate_ui_with_layout(Vec2::new(lw, 0.0), Layout::top_down(Align::Min), |ui| {
                    ui.set_width(lw);
                    ui.spacing_mut().item_spacing.y = 2.0;
                    w::text(ui, a.label, "label-14");
                    if !a.when.is_empty() {
                        w::subtle(ui, format!("when {}", a.when), "label-12-mono");
                    }
                    if capturing {
                        let msg = match &self.keys.refused {
                            Some(k) => format!("{k} would type instead · add Ctrl or Alt"),
                            None => "Press the new keys · Esc cancels · Backspace resets".into(),
                        };
                        ui.label(RichText::new(msg).text_style(theme::ts("label-12")).color(if self.keys.refused.is_some() { t.amber(900) } else { t.blue(900) }));
                    } else if !conflicts.is_empty() && !a.fixed {
                        let names: Vec<String> = conflicts.iter().map(|c| format!("“{}”", c.label)).collect();
                        ui.label(RichText::new(format!("{}  Also bound to {}", ic::ALERT, names.join(", "))).text_style(theme::ts("label-12")).color(t.amber(900)));
                    }
                })
                .response
                .rect;
            let slot = Rect::from_min_max(pos2(top.x + lw + 12.0, top.y), pos2(top.x + full, left.bottom().max(top.y + 24.0)));
            let mut right = ui.new_child(egui::UiBuilder::new().max_rect(slot).layout(Layout::right_to_left(Align::Center)));
            let ui = &mut right;
            ui.spacing_mut().item_spacing.x = 6.0;
            if capturing {
                let (r, resp) = ui.allocate_exact_size(Vec2::new(112.0, 24.0), Sense::click());
                ui.painter().rect(r, CornerRadius::same(theme::RADIUS_MD), t.blue(100), Stroke::new(1.0, t.blue(700)), egui::StrokeKind::Inside);
                ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, "Press keys…", egui::FontId::new(12.0, theme::medium()), t.blue(900));
                if resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                    self.keys.capture = None;
                }
                return;
            }
            let caps = w::kbd_combo(ui, &crate::keys::label(&self.keys.get(a.id)));
            if a.fixed {
                return;
            }
            if caps.hovered() {
                ui.painter().rect_stroke(caps.rect.expand(3.0), CornerRadius::same(6), Stroke::new(1.0, t.gray(600)), egui::StrokeKind::Inside);
            }
            if caps.on_hover_cursor(egui::CursorIcon::PointingHand).tip("Change").clicked() {
                self.keys.capture = Some(a.id);
                self.keys.refused = None;
            }
            if custom && w::btn(ic::ROTATE_CW).muted().icon_xs().show(ui).tip(format!("Back to {}", crate::keys::label(a.default))).clicked() {
                self.keys.reset(&self.store, a.id);
            }
        });
    }

    fn providers_tab(&mut self, ui: &mut Ui) {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        // Button first, so the text wraps in the room left instead of running under it.
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if w::btn(&format!("{}  Add Claude account", ic::PLUS)).sm().outline().show(ui).clicked() {
                self.add_claude_account(&ctx);
            }
            ui.add_space(8.0);
            ui.with_layout(Layout::top_down(Align::Min), |ui| {
                w::subtle(ui, "Every agent CLI on this machine is a provider. Claude Code adds one per account.", "copy-14");
            });
        });
        ui.add_space(8.0);
        // Provider CLI updates (the same as the "Updates available" pop-up).
        let up = crate::provupdate::status();
        if !up.items.is_empty() || up.updating || up.error.is_some() {
            rows(ui, |ui| {
                let list = up.items.iter().map(|p| format!("{} {} → {}", p.kind.label(), p.current, p.latest)).collect::<Vec<_>>().join(", ");
                let desc = up.error.clone().map(|e| format!("The last update failed: {e}")).unwrap_or(list);
                w::setting_row(ui, if up.updating { "Updating providers…" } else { "Updates available" }, &desc, |ui| {
                    if w::btn("Update").sm().primary().enabled(!up.busy && !up.items.is_empty()).show(ui).clicked() {
                        crate::provupdate::update_all(&ctx, &self.accounts);
                    }
                });
            });
            ui.add_space(8.0);
        }
        let accounts = self.accounts.clone();
        let default = self.draft.sel.account.clone();
        w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
            ui.set_width(ui.available_width());
            for (i, a) in accounts.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                Frame::new().inner_margin(Margin::symmetric(16, 12)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let (r, _) = ui.allocate_exact_size(Vec2::splat(32.0), Sense::hover());
                        ic::account_mark(ui.painter(), r, a.kind, &a.badge, &t);
                        ui.add_space(6.0);
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            ui.horizontal(|ui| {
                                w::text(ui, if a.kind == Kind::Claude { &a.name } else { a.kind.label() }, "strong-14");
                                if a.kind == Kind::Claude {
                                    w::subtle(ui, format!("Claude · {}", a.badge), "label-13");
                                }
                                if !a.plan.is_empty() {
                                    w::badge(ui, &a.plan, Tone::Gray);
                                }
                            });
                            if a.installed() && !a.email.is_empty() {
                                w::subtle(ui, &a.email, "label-13");
                            }
                            if !a.usage.is_empty() {
                                ui.horizontal(|ui| {
                                    for wdw in &a.usage {
                                        w::subtle(ui, &wdw.label, "label-12");
                                        w::meter(ui, wdw.percent, 70.0);
                                        w::subtle(ui, format!("{:.0}%", wdw.percent * 100.0), "label-12-mono");
                                        ui.add_space(6.0);
                                    }
                                });
                            }
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if !a.installed() {
                                if w::btn("Install").sm().show(ui).clicked() {
                                    self.login(&ctx, &a.id);
                                }
                                w::badge(ui, "Not installed", Tone::Gray);
                                return;
                            }
                            let sign = if a.logged_in == Some(false) { "Sign in" } else { "Re-auth" };
                            if w::btn(sign).sm().variant(if a.logged_in == Some(false) { w::Variant::Primary } else { w::Variant::Ghost }).show(ui).clicked() {
                                self.login(&ctx, &a.id);
                            }
                            if a.id == default {
                                w::badge(ui, "Default", Tone::Blue);
                            } else if w::btn("Make default").sm().variant(w::Variant::Ghost).show(ui).clicked() {
                                let m = self.models_for(a.kind).iter().find(|m| !m.more).map(|m| m.id.clone()).unwrap_or_default();
                                let s = crate::app::Sel { account: a.id.clone(), model: m, effort: String::new(), access: "full".into(), device: self.draft.sel.device.clone() };
                                let v = self.view;
                                self.view = View::Draft;
                                self.set_sel(s);
                                self.view = v;
                            }
                            match a.logged_in {
                                Some(true) => w::badge(ui, "Ready", Tone::Green),
                                Some(false) => w::badge(ui, "Signed out", Tone::Amber),
                                None => w::badge(ui, "Installed", Tone::Green),
                            };
                        });
                    });
                });
            }
        });
        ui.add_space(8.0);
        w::subtle(ui, "Sign-in runs the provider's own login in Harbor's terminal. Press Refresh in the sidebar afterwards.", "label-12");
    }

    fn webhooks_tab(&mut self, ui: &mut Ui) {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        let port = self.hook_port.unwrap_or(crate::control::HOOK_PORT);
        w::subtle(ui, "Leads create webhooks so other services can wake them. Harbor answers only /hooks/<secret-token> on this machine; anything else gets 404.", "copy-14");
        section(ui, "Public URL");
        let hs = crate::hookcert::status();
        let mut public = self.store.get("hooks_public").as_deref() == Some("1");
        let was = public;
        rows(ui, |ui| {
            w::setting_row(
                ui,
                "Reachable from the internet",
                &format!("Serves only /hooks/<secret-token> over HTTPS, with a certificate Harbor gets from Let's Encrypt by itself. Your router must send port 443 to this PC (port {}): Harbor asks it to.", crate::hookcert::PORT),
                |ui| w::toggle(ui, &mut public),
            );
            if public {
                w::separator(ui);
                let (badge, tone, text) = match (&hs.base, hs.busy) {
                    (Some(b), _) => ("Public", Tone::Green, b.clone()),
                    (None, true) => ("Working", Tone::Gray, "Opening port 443 and getting a certificate…".to_string()),
                    (None, false) => ("Not public", Tone::Amber, format!("http://127.0.0.1:{port}/hooks (this PC only)")),
                };
                w::setting_row(ui, &text, &hs.route, |ui| {
                    if w::btn(&format!("{}  Check", ic::REFRESH)).sm().ghost().show(ui).clicked() {
                        crate::hookcert::kick();
                    }
                    w::badge(ui, badge, tone);
                });
                if !hs.error.is_empty() {
                    w::separator(ui);
                    w::subtle(ui, format!("  {}", hs.error), "label-12");
                }
                w::separator(ui);
                let mut name = self.store.get("hooks_name").unwrap_or_default();
                let before = name.clone();
                w::setting_row(ui, "Name", "Empty: your public address as an sslip.io name (it changes when your address does). Or a name of yours that points at it.", |ui| {
                    w::input(ui, &mut name, if hs.name.is_empty() { "203-0-113-7.sslip.io" } else { &hs.name }, true, 260.0);
                });
                if name != before {
                    self.store.set("hooks_name", name.trim());
                }
                if hs.expires > 0 {
                    w::separator(ui);
                    let days = (hs.expires - crate::store::now()) / 86400;
                    w::subtle(ui, format!("  Certificate for {} · {days} days left · renewed by itself", hs.name), "label-12");
                }
            }
        });
        if public != was {
            self.store.set("hooks_public", if public { "1" } else { "0" });
            crate::hookcert::kick();
        }
        ui.add_space(6.0);
        w::subtle(ui, "GitHub: set the webhook's secret to its token (the last part of its URL); Harbor then checks every delivery's signature.", "label-12");
        // Tailscale Funnel, only while Tailscale is installed (an extra, not needed).
        if crate::providers::which("tailscale").is_some() {
            ui.add_space(8.0);
            w::card(ui).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    match &self.funnel {
                        Some(base) => {
                            w::badge(ui, "Funnel", Tone::Green);
                            w::text(ui, base, "label-13-mono");
                        }
                        None => match self.funnel_stale {
                            Some(p) => {
                                w::badge(ui, "Funnel", Tone::Amber);
                                w::subtle(ui, format!("Funnel sends /hooks to 127.0.0.1:{p}, not to Harbor's port {port}: another program there would get your webhooks."), "label-13");
                            }
                            None => {
                                w::subtle(ui, "Or with Tailscale Funnel (installed here): https://<machine>.<tailnet>.ts.net/hooks", "label-13");
                            }
                        },
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if self.funnel.is_none() {
                            if w::btn(if self.funnel_stale.is_some() { "Point Funnel here" } else { "Enable Funnel" }).sm().outline().show(ui).clicked() {
                                let cmd = format!("{} && echo && echo 'Done. Press Check in Harbor.'", crate::control::funnel_enable_cmd(port));
                                self.open_terminal(&ctx, "Tailscale Funnel", store::home(), vec!["bash".into(), "-lc".into(), cmd], vec![]);
                            }
                        } else if w::btn("Disable").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                            let cmd = crate::control::funnel_disable_cmd();
                            self.open_terminal(&ctx, "Tailscale Funnel", store::home(), vec!["bash".into(), "-lc".into(), cmd], vec![]);
                            self.funnel = None;
                        }
                        if w::btn(&format!("{}  Check", ic::REFRESH)).sm().ghost().show(ui).clicked() {
                            self.check_funnel();
                        }
                    });
                });
            });
        }
        ctx.request_repaint_after(std::time::Duration::from_secs(2));
        section(ui, "Webhooks");
        let hooks = self.webhooks.clone();
        w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
            ui.set_width(ui.available_width());
            if hooks.is_empty() {
                Frame::new().inner_margin(Margin::same(16)).show(ui, |ui| w::subtle(ui, "None yet. Ask a project's lead to create one.", "label-13"));
            }
            for (i, h) in hooks.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                let (local, public) = self.hook_url(&h.token);
                let url = public.unwrap_or(local);
                Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            let project = self.repo(h.repo_id).map(|r| r.name.clone()).unwrap_or_default();
                            w::text(ui, format!("{}  ·  {project}", h.name), "strong-14");
                            let g = w::truncated(ui, &url, egui::FontId::new(12.0, egui::FontFamily::Monospace), t.subtle(), ui.available_width() - 120.0);
                            ui.label(g);
                            let last = if h.last_hit > 0 { format!(" · last {}", ago(h.last_hit)) } else { String::new() };
                            w::subtle(ui, format!("{} calls{last}", h.hits), "label-12");
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if w::btn("Delete").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                                self.store.delete_webhook(h.id);
                                self.webhooks = self.store.webhooks();
                                self.sync_tokens();
                            }
                            if w::btn(&format!("{}  Copy", ic::COPY)).sm().ghost().show(ui).clicked() {
                                ui.ctx().copy_text(url.clone());
                            }
                        });
                    });
                });
            }
        });
    }

    fn appearance_tab(&mut self, ui: &mut Ui) {
        section(ui, "Theme");
        let modes = [(Mode::System, ic::SUN_MOON, "Follow Omarchy"), (Mode::Light, ic::SUN, "Light"), (Mode::Dark, ic::MOON, "Dark")];
        let density = usize::from(theme::compact());
        let labels: Vec<String> = modes.iter().map(|(_, icon, l)| format!("{icon}  {l}")).collect();
        let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let cur = modes.iter().position(|(m, ..)| *m == self.theme.mode).unwrap_or(0);
        if let Some(i) = w::tabs(ui, &refs, cur) {
            let m = modes[i].0;
            self.theme.set_mode(m, ui.ctx());
            self.store.set("theme", m.as_str());
        }
        ui.add_space(6.0);
        w::subtle(ui, "Colours and type are the rengaf design system (Geist).", "label-13");
        ui.add_space(24.0);
        section(ui, "Density");
        if let Some(i) = w::tabs(ui, &["Comfortable", "Compact"], density) {
            theme::set_compact(i == 1);
            self.store.set("density", if i == 1 { "compact" } else { "comfortable" });
        }
        ui.add_space(6.0);
        w::subtle(ui, "Compact fits more on screen: shorter rows in the sidebar, menus and settings, and less space between messages. On this PC only.", "label-13");
    }

    fn integrations_tab(&mut self, ui: &mut Ui) {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        w::subtle(ui, "Agents Harbor starts get the MCP servers below, plus only the apps you sign in to here. Your own sign-ins (gh, git, Claude Code, Convex) aren't shared with them.", "copy-14");
        section(ui, "Apps");
        let cols = if ui.available_width() > 600.0 { 2 } else { 1 };
        let cw = (ui.available_width() - 8.0 * (cols as f32 - 1.0)) / cols as f32;
        for row in mcp::APPS.chunks(cols) {
            ui.horizontal(|ui| {
                for a in row {
                    ui.allocate_ui(Vec2::new(cw, 72.0), |ui| {
                        w::card(ui).inner_margin(Margin::same(12)).show(ui, |ui| {
                            ui.set_width(cw - 26.0);
                            ui.vertical(|ui| self.app_card(ui, a, &ctx, &t));
                        });
                    });
                }
            });
        }
        for a in mcp::APPS {
            let Some(err) = mcp::error(a.id) else { continue };
            ui.horizontal(|ui| {
                ui.label(RichText::new(format!("{}  {}: {err}", ic::ALERT, a.label)).text_style(theme::ts("label-13")).color(t.red(900)));
                if w::btn(ic::X).muted().icon_xs().show(ui).clicked() {
                    mcp::dismiss(a.id);
                }
            });
        }
        section(ui, "MCP servers");
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = Vec2::new(6.0, 6.0);
            for (l, def) in mcp::locals() {
                let off = mcp::is_off(l.id);
                let r = mcp_chip(ui, l.label, def.is_some(), off, &t);
                if r.clicked() && def.is_some() {
                    mcp::toggle_off(l.id);
                }
            }
        });
        ui.add_space(4.0);
        w::subtle(ui, "Local tools on this machine, set up in your Claude Code config. Click one to turn it off or on for agents.", "label-12");
    }

    /// One app: logo, what it does or how its sign-in is going, and the action. The action
    /// is laid out first so the text truncates in the room left; a device code or a key
    /// field gets its own row underneath.
    fn app_card(&mut self, ui: &mut Ui, a: &'static mcp::App, ctx: &egui::Context, t: &crate::theme::Tokens) {
        let pending = mcp::pending(a.id);
        let signed = mcp::signed_in(a.id);
        let key_id = Id::NULL.with(("app-key", a.id));
        let mut key: Option<String> = ui.data(|d| d.get_temp(key_id));
        // A Google app's form: the client ID goes in `key`, its secret here.
        let secret_id = Id::NULL.with(("app-secret", a.id));
        let mut secret: String = ui.data(|d| d.get_temp(secret_id)).unwrap_or_default();
        ui.horizontal(|ui| {
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if pending.is_some() {
                    if w::btn("Cancel").sm().ghost().show(ui).clicked() {
                        mcp::cancel(a.id);
                    }
                    w::busy(ui);
                } else if key.is_some() {
                    if w::btn("Cancel").sm().ghost().show(ui).clicked() {
                        key = None;
                    }
                } else if signed {
                    if w::btn("Sign out").sm().ghost().show(ui).clicked() {
                        mcp::sign_out(a.id);
                    }
                    w::badge(ui, "Signed in", Tone::Green);
                } else if w::btn("Sign in").sm().primary().show(ui).clicked() {
                    match a.auth {
                        mcp::Auth::Key { .. } => key = Some(String::new()),
                        mcp::Auth::Google { .. } => {
                            let (c, s) = mcp::google_client(a.id);
                            (key, secret) = (Some(c), s);
                        }
                        _ => mcp::sign_in(a.id, ctx.clone()),
                    }
                }
                ui.add_space(8.0);
                ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                    crate::logos::tile(ui, a.id, 36.0, t);
                    ui.add_space(4.0);
                    let wdt = ui.available_width().max(20.0);
                    let (sub, color) = match &pending {
                        Some(p) if p.code.is_some() => ("Enter the code below in your browser".to_string(), t.blue(900)),
                        Some(_) => ("Finish in your browser…".to_string(), t.blue(900)),
                        None if key.is_some() && matches!(a.auth, mcp::Auth::Google { .. }) => ("Add your Google OAuth client below".to_string(), t.subtle()),
                        None if key.is_some() => ("Paste an API key below".to_string(), t.subtle()),
                        None if signed => (mcp::account(a.id).map(|u| format!("Signed in as {u}")).unwrap_or_else(|| a.about.into()), t.subtle()),
                        None => (a.about.to_string(), t.subtle()),
                    };
                    ui.vertical(|ui| {
                        ui.spacing_mut().item_spacing.y = 0.0;
                        ui.label(w::truncated(ui, a.label, theme::ts("heading-14").resolve(ui.style()), t.fg(), wdt));
                        ui.label(w::truncated(ui, &sub, theme::ts("label-13").resolve(ui.style()), color, wdt));
                    });
                });
            });
        });
        if let Some(p) = &pending {
            if p.code.is_some() || p.url.is_some() {
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    if let Some(c) = &p.code {
                        Frame::new()
                            .fill(t.gray(100))
                            .stroke(Stroke::new(1.0, t.border()))
                            .corner_radius(CornerRadius::same(theme::RADIUS_MD))
                            .inner_margin(Margin::symmetric(10, 4))
                            .show(ui, |ui| {
                                ui.label(RichText::new(c).monospace().size(16.0).color(t.fg()));
                            });
                        if w::btn(&format!("{}  Copy", ic::COPY)).sm().ghost().show(ui).clicked() {
                            ctx.copy_text(c.clone());
                        }
                    }
                    if let Some(url) = &p.url {
                        if w::btn(&format!("{}  Open page", ic::EXTERNAL)).sm().ghost().show(ui).tip("Open the sign-in page again").clicked() {
                            crate::git::open_url(url);
                        }
                    }
                });
            }
        } else if let (Some(k), mcp::Auth::Google { help, .. }) = (&mut key, &a.auth) {
            ui.add_space(8.0);
            let ready = mcp::valid_google_client(k, &secret);
            let mut go = false;
            w::input(ui, k, "Client ID, or the client's JSON file", true, ui.available_width());
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if w::btn(ic::EXTERNAL).muted().icon_xs().show(ui).tip("Create an OAuth client in Google Cloud").clicked() {
                        crate::git::open_url(help);
                    }
                    go |= w::btn("Sign in").sm().primary().enabled(ready).show(ui).clicked();
                    ui.add_space(4.0);
                    ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                        let r = w::input(ui, &mut secret, "Client secret", true, ui.available_width());
                        go |= r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) && ready;
                    });
                });
            });
            ui.add_space(6.0);
            w::subtle(
                ui,
                "Gmail needs your own OAuth client. In Google Cloud console: create a project, enable the Gmail API, set the OAuth consent screen to In production (sign-ins in Testing end after 7 days), then Credentials › Create OAuth client ID › Desktop app.",
                "label-12",
            );
            if go {
                let _ = mcp::save_google_client(a.id, k, &secret);
                mcp::sign_in(a.id, ctx.clone());
                key = None;
            }
        } else if let Some(k) = &mut key {
            ui.add_space(8.0);
            let mut save = false;
            ui.horizontal(|ui| {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if let mcp::Auth::Key { get, .. } = a.auth {
                        if w::btn(ic::EXTERNAL).muted().icon_xs().show(ui).tip("Get a key").clicked() {
                            crate::git::open_url(get);
                        }
                    }
                    save |= w::btn("Save").sm().primary().enabled(!k.trim().is_empty()).show(ui).clicked();
                    ui.add_space(4.0);
                    ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                        let r = w::input(ui, k, "Paste your API key", true, ui.available_width());
                        save |= r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) && !k.trim().is_empty();
                    });
                });
            });
            if save {
                let _ = mcp::save_key(a.id, k);
                key = None;
            }
        }
        ui.data_mut(|d| match key {
            Some(k) => {
                d.insert_temp(key_id, k);
                d.insert_temp(secret_id, secret);
            }
            None => {
                d.remove::<String>(key_id);
                d.remove::<String>(secret_id);
            }
        });
    }

    // ------------------------------------------------------------ usage

    /// Settings › Usage: the accounts with their caps, what threads do at a limit,
    /// and what Harbor's chats used.
    pub fn usage_tab(&mut self, ui: &mut Ui) {
        let t = self.theme.t;
        // Totals from every chat's result records, summed on a thread (see `UsageTotals`).
        let today = store::now() / 86400;
        let Totals { by_account, by_day, days, by_project, .. } = self.usage_now(ui.ctx()).clone();
        section(ui, "Accounts");
        w::subtle(ui, "Drag the marker on a bar to cap how much of that limit Harbor uses. At the cap, Harbor treats the account as limited: threads wait for the reset or move to another account.", "label-13");
        ui.add_space(4.0);
        self.usage_controller(ui);
        ui.add_space(16.0);
        self.limits_settings(ui);
        ui.add_space(16.0);
        section(ui, "Last 14 days");
        w::card(ui).show(ui, |ui| {
            ui.set_width(ui.available_width());
            let h = 120.0;
            let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), h + 18.0), Sense::hover());
            let max = by_day.values().copied().max().unwrap_or(1).max(1) as f32;
            let bw = rect.width() / 14.0;
            for i in 0..14 {
                let day = today - 13 + i;
                let v = by_day.get(&day).copied().unwrap_or(0) as f32;
                let bh = (v / max) * h;
                let x = rect.left() + i as f32 * bw;
                let bar = Rect::from_min_max(pos2(x + bw * 0.2, rect.top() + h - bh), pos2(x + bw * 0.8, rect.top() + h));
                ui.painter().rect_filled(bar, CornerRadius::same(3), if i == 13 { t.gray(1000) } else { t.gray(700) });
                if i % 2 == 1 || i == 13 {
                    let label = if i == 13 { "today".to_string() } else { format!("-{}d", 13 - i) };
                    ui.painter().text(pos2(x + bw / 2.0, rect.bottom()), egui::Align2::CENTER_BOTTOM, label, egui::FontId::proportional(11.0), t.subtle());
                }
            }
            w::subtle(ui, "Tokens (in + out) per day across all providers.", "label-12");
        });
        section(ui, "By project");
        let mut projects: Vec<(String, crate::cost::Usage)> = by_project.into_iter().map(|(p, u)| (if p.is_empty() { "No project".to_string() } else { p }, u)).collect();
        projects.sort_by(|a, b| b.1.cost.total_cmp(&a.1.cost).then(b.1.tokens().cmp(&a.1.tokens())));
        usage_rows(ui, projects);
        section(ui, "By day");
        usage_rows(ui, (0..14).filter_map(|i| {
            let d = today - i;
            let name = match i { 0 => "Today".to_string(), 1 => "Yesterday".to_string(), _ => crate::cost::day_label(d) };
            days.get(&d).map(|u| (name, *u))
        }).collect());
        section(ui, "By account");
        w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
            ui.set_width(ui.available_width());
            if by_account.is_empty() {
                Frame::new().inner_margin(Margin::same(16)).show(ui, |ui| w::subtle(ui, "No turns yet.", "label-13"));
            }
            for (i, (aid, (turns, tin, tout, cost))) in by_account.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let (name, kind, badge) = self
                            .account(aid)
                            .map(|a| (crate::limits::account_name(a), a.kind, a.badge.clone()))
                            .unwrap_or((aid.clone(), Kind::Claude, String::new()));
                        let (r, _) = ui.allocate_exact_size(Vec2::splat(22.0), Sense::hover());
                        ic::account_mark(ui.painter(), r, kind, &badge, &t);
                        w::text(ui, name, "strong-14");
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let u = crate::cost::Usage { turns: *turns, input: *tin, output: *tout, cached: 0, cost: *cost };
                            w::subtle(ui, u.compact(), "label-13-mono").on_hover_text(u.detail());
                        });
                    });
                });
            }
        });
    }

    /// The usage totals (on a thread from the store; again when a turn ends, a chat goes or a
    /// minute passes): the Usage page's, and the agent cards' and the phone's per chat.
    pub fn usage_now(&mut self, ctx: &egui::Context) -> &Totals {
        let today = store::now() / 86400;
        // A minute's step too, for results saved after the turn's chat update.
        let key = (self.chats.len(), self.chats.iter().map(|c| c.updated).max().unwrap_or(0), store::now() / 60);
        let names: HashMap<i64, String> = self.repos.iter().map(|r| (r.id, r.name.clone())).collect();
        let chats: HashMap<i64, (String, String)> =
            self.chats.iter().map(|c| (c.id, (c.account.clone(), c.repo_id.and_then(|r| names.get(&r).cloned()).unwrap_or_default()))).collect();
        self.usage_totals.get(ctx, key, chats, today)
    }

    // ------------------------------------------------------------ dialogs

    pub fn dialogs(&mut self, ctx: &egui::Context) {
        let Some(mut dialog) = self.dialog.take() else { return };
        let mut close = false;
        let mut start = false;
        let t = self.theme.t;
        // rengaf Dialog: md (448) for confirms, lg (512) for forms and lists; black/50 backdrop.
        let width = match &dialog {
            Dialog::Rename { .. } | Dialog::Instructions { .. } | Dialog::Shortcuts { .. } => 512.0,
            // Wider while it shows the diff.
            Dialog::Commit(c) => if c.showing_diff() { 760.0 } else { 512.0 },
            _ => 448.0,
        };
        let mut x_clicked = false;
        let modal = egui::Modal::new(Id::NULL.with("dialog"))
            .backdrop_color(Color32::from_black_alpha(128))
            .frame(
                Frame::new()
                    .fill(t.bg100)
                    .stroke(Stroke::new(1.0, t.border()))
                    .corner_radius(CornerRadius::same(theme::RADIUS_XL))
                    .inner_margin(Margin::same(24))
                    .shadow(ctx.global_style().visuals.window_shadow),
            )
            .show(ctx, |ui| {
                ui.set_width(width);
                // The close button, top right (rengaf DialogClose).
                let xr = Rect::from_min_size(pos2(ui.max_rect().right() - 12.0, ui.max_rect().top() - 8.0), Vec2::splat(28.0));
                let x = ui.interact(xr, Id::NULL.with("dialog-x"), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
                let col = if x.hovered() { t.fg() } else { w::alpha(t.fg(), 0.7) };
                crate::icons::glyph(ui.painter(), xr.center(), ic::X, 16.0, col);
                x_clicked = x.clicked();
                match &mut dialog {
                    Dialog::Rename { chat, title } => {
                        w::text(ui, "Rename chat", "heading-20");
                        ui.add_space(12.0);
                        let r = w::input(ui, title, "Title", false, ui.available_width());
                        r.request_focus();
                        let enter = ui.input(|i| i.key_pressed(Key::Enter));
                        ui.add_space(16.0);
                        ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                            if w::btn("Salvar Alterações").primary().show(ui).clicked() || enter {
                                let id = *chat;
                                let tt = title.trim().to_string();
                                if self.mesh_patch(id, serde_json::json!({ "title": tt })) {
                                } else if let Some(c) = self.chat_mut(id) {
                                    c.title = tt;
                                    let c = c.clone();
                                    self.store.save_chat(&c);
                                }
                                close = true;
                            }
                            if w::btn("Cancel").outline().show(ui).clicked() {
                                close = true;
                            }
                        });
                    }
                    Dialog::DeleteChat(id) => {
                        w::text(ui, "Delete chat?", "heading-20");
                        ui.add_space(4.0);
                        w::subtle(ui, "The transcript is removed from Harbor. The provider's session stays on disk.", "copy-14");
                        ui.add_space(16.0);
                        ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                            if w::btn("Delete").variant(w::Variant::Destructive).show(ui).clicked() {
                                let id = *id;
                                if self.mesh_delete(id) {
                                    close = true;
                                    return;
                                }
                                self.stop(id);
                                self.ws_drop(id, ui.ctx());
                                self.store.delete_chat(id);
                                self.chats.retain(|c| c.id != id);
                                self.transcripts.remove(&id);
                                if self.view == View::Chat(id) {
                                    self.view = View::Draft;
                                }
                                close = true;
                            }
                            if w::btn("Cancel").outline().show(ui).clicked() {
                                close = true;
                            }
                        });
                    }
                    Dialog::StopAll(id) => self.stop_all_dialog(ui, *id, &mut close),
                    Dialog::Shortcuts { query } => self.shortcuts_dialog(ui, query, &mut close),
                    Dialog::Commit(card) => self.commit_dialog(ui, card, &mut close),
                    Dialog::Instructions { job, text, .. } => start = self.instructions_dialog(ui, job, text, &mut close),
                    Dialog::RemoveRepo(id) => {
                        w::text(ui, "Remove project?", "heading-20");
                        ui.add_space(4.0);
                        w::subtle(ui, "Its chats are removed from Harbor. Nothing on disk is touched.", "copy-14");
                        ui.add_space(16.0);
                        ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                            if w::btn("Remove").variant(w::Variant::Destructive).show(ui).clicked() {
                                let id = *id;
                                let ids: Vec<i64> = self.chats.iter().filter(|c| c.repo_id == Some(id)).map(|c| c.id).collect();
                                for c in ids {
                                    self.stop(c);
                                    self.transcripts.remove(&c);
                                }
                                self.store.remove_repo(id);
                                self.repos = self.store.repos();
                                self.chats = self.store.chats();
                                // Removal revokes the project's webhooks: the database cascade drops
                                // them, and the listener must stop accepting their tokens now.
                                self.webhooks = self.store.webhooks();
                                self.sync_tokens();
                                self.timers = self.store.timers();
                                if self.draft.repo == Some(id) {
                                    self.draft.repo = None;
                                }
                                if matches!(self.view, View::Chat(c) if self.chat(c).is_none()) {
                                    self.view = View::Draft;
                                }
                                close = true;
                            }
                            if w::btn("Cancel").outline().show(ui).clicked() {
                                close = true;
                            }
                        });
                    }
                }
            });
        if modal.should_close() || x_clicked {
            close = true;
        }
        if start {
            if let Dialog::Instructions { project, job, text } = &dialog {
                self.start_job(ctx, *project, job, text);
            }
        } else if !close {
            self.dialog = Some(dialog);
        } else {
            self.focus_composer = true;
        }
    }
}

/// A compact MCP chip: logo, name and a dot (green: on for agents, grey: off or not set up).
fn mcp_chip(ui: &mut Ui, label: &str, found: bool, off: bool, t: &crate::theme::Tokens) -> egui::Response {
    let font = egui::FontId::new(13.0, crate::theme::medium());
    let fg = if found && !off { t.fg() } else { t.subtle() };
    let g = ui.painter().layout_no_wrap(label.to_string(), font, fg);
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(g.size().x + 24.0 + 20.0 + 10.0, 28.0), Sense::click());
    let p = ui.painter();
    p.rect(rect, CornerRadius::same(theme::RADIUS_MD), if resp.hovered() && found { t.gray(200) } else { t.gray(100) }, Stroke::new(1.0, t.border()), egui::StrokeKind::Inside);
    let x = rect.left() + 10.0;
    crate::logos::paint(ui, p, Rect::from_center_size(pos2(x + 7.0, rect.center().y), Vec2::splat(14.0)), label, t);
    p.galley(pos2(x + 20.0, rect.center().y - g.size().y / 2.0), g, fg);
    let dot = if found && !off { t.green(700) } else { t.gray(600) };
    p.circle_filled(pos2(rect.right() - 12.0, rect.center().y), 3.5, dot);
    let hint = match (found, off) {
        (false, _) => "Not set up on this machine",
        (true, true) => "Off for agents · click to turn on",
        (true, false) => "On for agents · click to turn off",
    };
    resp.tip(hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(account: &str, tin: u64, tout: u64, at: i64) -> Item {
        Item::Result { cost_usd: 0.5, duration_ms: 0, turns: 1, input_tokens: tin, output_tokens: tout, cached: 0, at, account: account.into(), model: String::new() }
    }

    #[test]
    fn usage_sums_results_per_account_and_day() {
        let today = 20_000;
        let chats: HashMap<i64, (String, String)> = [(1, ("claude".to_string(), "harbor".to_string())), (2, ("codex".to_string(), String::new()))].into();
        let results = vec![
            (1, result("", 1000, 10, today * 86400)),
            (1, result("claude2", 2000, 20, today * 86400)),
            (2, result("", 3000, 30, (today - 20) * 86400)),
            (2, Item::Error { text: "x".into() }),
        ];
        let t = sum_results(results, &chats, today);
        assert_eq!(t.by_account["claude"], (1, 1000, 10, 0.5));
        assert_eq!(t.by_account["claude2"], (1, 2000, 20, 0.5));
        assert_eq!(t.by_account["codex"], (1, 3000, 30, 0.5));
        // Older than 14 days: in the account totals, not in the chart.
        assert_eq!(t.by_day, [(today, 3030)].into());
        // By day (with cost), project and chat.
        assert_eq!((t.days[&today].turns, t.days[&today].tokens()), (2, 3030));
        assert_eq!((t.by_project["harbor"].turns, t.by_project[""].input), (2, 3000));
        assert_eq!((t.by_chat[&1].output, t.by_chat[&2].turns), (30, 1));
    }

    #[test]
    fn result_rows_are_found_by_their_prefix() {
        // store::results() selects rows by this prefix of the saved JSON.
        assert!(serde_json::to_string(&result("a", 1, 1, 1)).unwrap().starts_with(r#"{"kind":"result""#));
    }
}
