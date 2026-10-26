//! Chat screens: the draft ("What should we work on?"), the transcript, the
//! composer (model · effort · access, attach, send) and its pickers.

use crate::widgets::Tip as _;
use crate::app::{App, CHAT_MIN_W, CONTENT_W, Picker, Popup, Sel, TEAM_W, View, clip, tilde};
use crate::icons as ic;
use crate::providers::{self, Kind};
use crate::store::{Item, Role};
use crate::theme::{self, RADIUS_LG, RADIUS_MD};
use crate::widgets::{self as w, Tone};
use eframe::egui::{
    self, Align, Align2, Color32, CornerRadius, FontId, Frame, Id, Key, Layout, Margin, Rect, RichText, ScrollArea, Sense,
    Stroke, Ui, Vec2, pos2,
};
use egui_commonmark::CommonMarkViewer;

/// One selectable model row in the picker.
#[derive(Clone)]
struct Row {
    account: String,
    kind: crate::providers::Kind,
    model: String,
    label: String,
    sub: String,
    enabled: bool,
}

/// How far beyond the visible part of a transcript messages are still laid out.
const CULL_MARGIN: f32 = 800.0;

/// Tells items apart cheaply, so a remembered height never belongs to another item
/// after the list changes (an undone send, a queued message shown in place).
fn item_sig(item: &Item) -> (u8, usize) {
    match item {
        Item::User { text, files, mentions, .. } => (0, text.len() + files.len() + mentions.len()),
        Item::Text { text, .. } => (1, text.len()),
        Item::Thinking { text } => (2, text.len()),
        Item::Tool { input, result, .. } => (3, input.len() + result.as_ref().map_or(0, |r| r.len() + 1)),
        Item::Result { output_tokens, .. } => (4, *output_tokens as usize),
        Item::Error { text } => (5, text.len()),
        Item::Notice { text, detail, .. } => (6, text.len() + detail.len()),
        Item::Message { text, .. } => (7, text.len()),
    }
}

pub fn centered(ui: &mut Ui, max: f32, add: impl FnOnce(&mut Ui)) {
    let avail = ui.available_width();
    // 24pt gutters, narrowing to 12pt on small columns.
    let gutter = if avail < 520.0 { 12.0 } else { 24.0 };
    let side = ((avail - max) / 2.0).max(gutter);
    let width = (avail - side * 2.0).max(0.0);
    ui.horizontal(|ui| {
        ui.add_space(side);
        ui.vertical(|ui| {
            ui.set_width(width);
            // Content wider than the column is clipped, never drawn over its neighbours.
            let clip = Rect::from_min_size(ui.max_rect().min, Vec2::new(width, f32::INFINITY));
            ui.shrink_clip_rect(clip.expand2(Vec2::new(4.0, 0.0)));
            add(ui);
        });
    });
}

impl App {
    // ------------------------------------------------------------ draft

    pub fn draft_view(&mut self, ui: &mut Ui) {
        let t = self.theme.t;
        self.top_bar(ui, None);
        let h = ui.available_height();
        // A long draft grows the composer; the screen moves up to keep it in view.
        let grown = w::composer_growth(ui.ctx(), Id::NULL.with(("composer", self.key())));
        ui.add_space((h * 0.5 - 170.0 - grown).max(24.0));
        centered(ui, CONTENT_W, |ui| {
            ui.vertical_centered(|ui| {
                w::text(ui, "What should we work on?", "heading-32");
                ui.add_space(6.0);
                let label = match self.draft.repo.and_then(|r| self.repo(r)) {
                    Some(r) => r.name.clone(),
                    None => "No project".into(),
                };
                let g = ui.painter().layout_no_wrap(label, FontId::proportional(15.0), t.subtle());
                let (rect, resp) = ui.allocate_exact_size(g.size() + Vec2::new(0.0, 4.0), Sense::click());
                let hover = resp.hovered() || self.popup == Some(Popup::Project);
                let col = if hover { t.fg() } else { t.subtle() };
                ui.painter().galley(rect.min, g, col);
                // Dashed underline, as in the mock.
                let y = rect.bottom() - 1.0;
                let mut x = rect.left();
                while x < rect.right() {
                    ui.painter().hline(x..=(x + 3.0).min(rect.right()), y, Stroke::new(1.0, col));
                    x += 6.0;
                }
                if resp.on_hover_cursor(egui::CursorIcon::PointingHand).tip("Choose the project the agent works in").clicked() {
                    self.popup = if self.popup == Some(Popup::Project) { None } else { Some(Popup::Project) };
                    self.popup_anchor = rect;
                }
            });
            ui.add_space(18.0);
            self.composer(ui, None);
        });
    }

    // ------------------------------------------------------------ top bar

    /// T3-style top bar: breadcrumb (project / thread) on the left; team panel,
    /// bottom panel, right panel and close-window on the right.
    fn top_bar(&mut self, ui: &mut Ui, chat: Option<&crate::store::Chat>) {
        let t = self.theme.t;
        let repo = match chat {
            Some(c) => c.repo_id.and_then(|r| self.repo(r)).cloned(),
            None => self.draft.repo.and_then(|r| self.repo(r)).cloned(),
        };
        egui::Panel::top("top_bar")
            .frame(Frame::new().inner_margin(Margin { left: 18, right: 10, top: 8, bottom: 8 }).fill(t.bg100))
            .show_separator_line(false)
            .show(ui, |ui| {
                let row = Rect::from_min_size(ui.cursor().min, Vec2::new(ui.available_width(), 30.0));
                // ---- panels and window, laid out first so the breadcrumb knows its room
                let mut right = ui.new_child(egui::UiBuilder::new().max_rect(row).layout(Layout::right_to_left(Align::Center)));
                {
                    let ui = &mut right;
                    ui.spacing_mut().item_spacing.x = 4.0;
                    let close = if self.keep_running() { "Close the window (Harbor keeps running in the background)" } else { "Close Harbor" };
                    if w::btn(ic::X).ghost().icon_xs().show(ui).tip(close).clicked() {
                        ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                    ui.add_space(4.0);
                    if let Some(offer) = self.update_offered() {
                        use crate::update::State;
                        let keep = if self.turns.is_empty() { "" } else { "; running agents keep going" };
                        let (text, tip) = match &offer {
                            State::Available(v) => ("Update", format!("Install Harbor {v} and reload into it{keep}")),
                            State::Installing(v) => ("Updating…", format!("Installing Harbor {v}…")),
                            _ => ("Update ready", format!("Reload into the new build{keep}")),
                        };
                        // Icon-only when the bar is narrow.
                        let label = if row.width() < 560.0 { ic::REFRESH.to_string() } else { format!("{}  {text}", ic::REFRESH) };
                        let installing = matches!(offer, State::Installing(_)) || (self.reload_asked && !matches!(offer, State::Available(_)));
                        if w::btn(&label).xs().primary().enabled(!installing).show(ui).tip(tip).clicked() {
                            let ctx = ui.ctx().clone();
                            self.update_clicked(&ctx);
                        }
                        ui.add_space(6.0);
                    }
                    use crate::surface::Dock;
                    let right_on = self.pane_showing(Dock::Right);
                    if w::btn(ic::PANEL_RIGHT).muted().icon_xs().pressed(right_on).show(ui).tip("Right panel").clicked() {
                        self.toggle_dock(Dock::Right);
                    }
                    let bottom_on = self.pane_showing(Dock::Bottom);
                    if w::btn(ic::PANEL_BOTTOM).muted().icon_xs().pressed(bottom_on).show(ui).tip("Bottom panel").clicked() {
                        self.toggle_dock(Dock::Bottom);
                    }
                    let lead = chat.is_some_and(|c| c.role == Role::Lead);
                    if w::btn(ic::SQUARE_MENU)
                        .muted()
                        .icon_xs()
                        .enabled(lead)
                        .pressed(lead && self.team_showing())
                        .show(ui)
                        .tip("Team: agents, processes, wake-ups, webhooks")
                        .clicked()
                    {
                        self.toggle_team();
                    }
                    // Other PCs with this chat open (dimmed: their window isn't in front).
                    if let Some(c) = chat {
                        self.mesh_badges(ui, c.id);
                        // Its tokens and cost so far (a lead's with its agents'), dim (cost.rs).
                        if row.width() >= 640.0 {
                            if let Some((label, tip)) = self.usage_line(ui.ctx(), c.id) {
                                ui.add_space(6.0);
                                ui.label(RichText::new(label).text_style(theme::ts("label-13-mono")).color(t.gray(800))).tip(tip);
                            }
                        }
                    }
                }
                let left_rect = Rect::from_min_max(row.min, pos2((right.min_rect().left() - 12.0).max(row.left()), row.bottom()));
                let mut left = ui.new_child(egui::UiBuilder::new().max_rect(left_rect).layout(Layout::left_to_right(Align::Center)));
                left.shrink_clip_rect(left_rect);
                {
                    let ui = &mut left;
                    ui.spacing_mut().item_spacing.x = 6.0;
                    if !self.sidebar_docked(ui.ctx()) {
                        if w::btn(ic::PANEL_LEFT).muted().icon_xs().show(ui).tip(self.key_hint("Show sidebar", "toggle_sidebar")).clicked() {
                            let ctx = ui.ctx().clone();
                            self.toggle_sidebar(&ctx);
                        }
                        ui.add_space(4.0);
                    }
                    // ---- breadcrumb: crumbs truncate with an ellipsis instead of overlapping
                    let (icon, project) = match &repo {
                        Some(r) => (ic::FOLDER, r.name.clone()),
                        None => (ic::SQUARE_DASHED, "No project".to_string()),
                    };
                    let crumb = |ui: &mut Ui, icon: &str, text: &str, strong: bool, max_w: f32| -> egui::Response {
                        let col = if strong { t.fg() } else { t.subtle() };
                        let label = if icon.is_empty() { text.to_string() } else { format!("{icon}  {text}") };
                        let r = ui
                            .scope(|ui| {
                                ui.set_max_width(max_w.max(24.0));
                                ui.add(egui::Label::new(RichText::new(label).text_style(theme::ts("label-14")).color(col)).truncate().sense(Sense::click()))
                            })
                            .inner;
                        r.on_hover_cursor(egui::CursorIcon::PointingHand)
                    };
                    let sep = |ui: &mut Ui| {
                        ui.label(RichText::new("/").text_style(theme::ts("label-14")).color(t.gray(600)));
                    };
                    // Branch and changes go first when there's no room for them.
                    let git = repo.as_ref().and_then(|r| self.git.get(&r.id)).cloned().flatten();
                    let room = ui.available_width();
                    let show_branch = git.is_some() && room >= 260.0;
                    let show_changed = show_branch && git.as_ref().is_some_and(|s| s.changed > 0) && room >= 400.0;
                    let git_w = match &git {
                        Some(s) if show_branch => {
                            let font = FontId::monospace(13.0);
                            let bw = ui.painter().layout_no_wrap(format!("{} {}", ic::BRANCH, s.branch), font.clone(), Color32::WHITE).size().x.min(160.0);
                            12.0 + bw + if show_changed { 96.0 } else { 0.0 }
                        }
                        _ => 0.0,
                    };
                    let crumbs_w = (room - git_w).max(60.0);
                    let pr = crumb(ui, icon, &project, false, crumbs_w * 0.45);
                    if pr.clicked() {
                        match (&repo, chat) {
                            (Some(r), Some(c)) if c.role == Role::Sub => self.open_project(r.id),
                            (None, None) => {
                                self.popup = Some(Popup::Project);
                                self.popup_anchor = pr.rect;
                            }
                            _ => {}
                        }
                    }
                    // A project's main chat is the project itself: no second crumb.
                    let is_main = chat.is_some_and(|c| c.role == Role::Lead && c.repo_id.and_then(|r| self.main_thread(r)) == Some(c.id));
                    if !is_main {
                        sep(ui);
                    }
                    let rest = |ui: &Ui| ui.available_width() - git_w;
                    match chat {
                        None => {
                            crumb(ui, "", "New thread", true, rest(ui));
                        }
                        Some(c) => match c.role {
                            Role::Lead => {
                                if !is_main {
                                    crumb(ui, "", &c.title, true, rest(ui));
                                }
                            }
                            Role::Sub => {
                                let parent = c.parent.and_then(|l| self.chat(l)).map(|l| l.title.clone()).unwrap_or_else(|| "Lead".into());
                                let pw = rest(ui) * 0.5;
                                if crumb(ui, "", &parent, false, pw).tip(&parent).clicked() {
                                    if let Some(l) = c.parent {
                                        self.open(View::Chat(l));
                                    }
                                }
                                sep(ui);
                                crumb(ui, "", &c.name, true, rest(ui)).tip(&c.title);
                            }
                            Role::Chat => {
                                crumb(ui, "", &c.title, true, rest(ui));
                            }
                        },
                    }
                    if let Some(s) = git.as_ref().filter(|_| show_branch) {
                        ui.add_space(6.0);
                        ui.scope(|ui| {
                            ui.set_max_width(160.0);
                            ui.add(egui::Label::new(RichText::new(format!("{} {}", ic::BRANCH, s.branch)).text_style(theme::ts("label-13-mono")).color(t.subtle())).truncate());
                        });
                        if show_changed {
                            w::badge(ui, &format!("{} changed", s.changed), Tone::Amber);
                        }
                    }
                }
                ui.advance_cursor_after_rect(row);
            });
        w::separator(ui);
    }

    // ------------------------------------------------------------ chat

    pub fn chat_view(&mut self, ui: &mut Ui, id: i64) {
        let Some(chat) = self.chat(id).cloned() else {
            self.open(View::Draft);
            return;
        };
        let t = self.theme.t;
        let running = self.running_since(id).map(|s| s.elapsed().as_secs());
        // The team is working when the lead or any subagent is.
        let team_running = if chat.role == Role::Lead {
            let since = self.subs_of(id).iter().filter_map(|c| self.running_since(c.id).map(|s| s.elapsed().as_secs())).max();
            running.max(since)
        } else {
            running
        };
        let repo = chat.repo_id.and_then(|r| self.repo(r)).cloned();
        self.top_bar(ui, Some(&chat));

        // The team panel docks beside the chat while the chat keeps its minimum
        // width (and the surface isn't docked right); otherwise it's a drawer.
        self.team_docks = !self.pane_showing(crate::surface::Dock::Right) && ui.available_width() - TEAM_W >= CHAT_MIN_W;
        if self.team_docks || chat.role != Role::Lead {
            self.team_drawer = false;
        }
        let frame = Frame::new().fill(t.bg200).stroke(Stroke::new(1.0, t.border())).inner_margin(Margin::same(12));
        if chat.role == Role::Lead && self.team_docks && self.show_team {
            egui::Panel::right("team")
                .exact_size(TEAM_W)
                .resizable(false)
                .show_separator_line(false)
                .frame(frame)
                .show(ui, |ui| self.team_panel(ui, &chat));
        }
        if self.team_drawer {
            let ctx = ui.ctx().clone();
            let close = crate::app::drawer(&ctx, "team", false, TEAM_W + 40.0, frame, |ui| self.team_panel(ui, &chat));
            if close || self.view != View::Chat(id) {
                self.team_drawer = false;
            }
        }
        // Nothing in the chat column may paint over the panels beside it.
        ui.shrink_clip_rect(ui.available_rect_before_wrap());
        let empty = self.transcripts.get(&id).is_none_or(|t| t.items.is_empty());
        if empty && chat.role == Role::Lead {
            let h = ui.available_height();
            let grown = w::composer_growth(ui.ctx(), Id::NULL.with(("composer", self.key())));
            ui.add_space((h * 0.5 - 170.0 - grown).max(24.0));
            centered(ui, CONTENT_W, |ui| {
                ui.vertical_centered(|ui| {
                    w::text(ui, "What should we work on?", "heading-32");
                    ui.add_space(6.0);
                    w::subtle(ui, format!("The lead plans and delegates to subagents in {}.", repo.as_ref().map(|r| r.name.as_str()).unwrap_or("")), "copy-14");
                });
                ui.add_space(18.0);
                self.composer(ui, running);
            });
            return;
        }

        egui::Panel::bottom("composer")
            .frame(Frame::new().inner_margin(Margin { left: 0, right: 0, top: 8, bottom: 16 }).fill(t.bg100))
            .show_separator_line(false)
            .show(ui, |ui| centered(ui, CONTENT_W, |ui| self.composer(ui, running)));

        ScrollArea::vertical()
            .auto_shrink([false, false])
            .stick_to_bottom(true)
            .id_salt(("transcript", id))
            .show(ui, |ui| {
                centered(ui, CONTENT_W, |ui| {
                    ui.add_space(24.0);
                    self.transcript(ui, id, team_running);
                    ui.add_space(24.0);
                });
            });
    }

    fn transcript(&mut self, ui: &mut Ui, id: i64, _running: Option<u64>) {
        let t = self.theme.t;
        let forks = self.forks_of(id);
        let Some(tr) = self.transcripts.get(&id) else { return };
        ui.spacing_mut().item_spacing.y = if crate::theme::compact() { 8.0 } else { 12.0 };
        let width = ui.available_width();
        let lead = self.chat(id).is_some_and(|c| c.role == Role::Lead);
        // Where relative media paths in replies start (another PC's chat: nowhere here).
        let cwd = self.chat(id).filter(|c| !c.foreign()).map(|c| self.chat_cwd(c).to_string_lossy().into_owned()).unwrap_or_default();
        // The same cards the phone gets (view.rs): what's hidden, footers, dividers.
        let who = |account: &str, model: &str| self.account(account).map(|a| format!("{} · {} · ", a.short(), self.model_label(a.kind, model))).unwrap_or_default();
        let cards = crate::view::project(&tr.items, lead, &forks, &who);
        let mut action: Option<MsgAction> = None;
        for shown in &cards {
            let i = shown.seq;
            let item = &tr.items[i];
            if shown.card == crate::view::Card::Hidden {
                // A fork can branch off after a hidden item: its divider still shows.
                if let Some(f) = fork_dividers(ui, &shown.forks_after) {
                    action = Some(MsgAction::Open(f));
                }
                continue;
            }
            let top = ui.cursor().top();
            // Far off screen: a message whose height is known at this width is only
            // space, not laid out or painted. Long chats would otherwise lay out every
            // message on every frame. The last few (still streaming) always draw.
            let height_key = Id::NULL.with(("item-height", id, i, item_sig(item)));
            let flashing = self.mentions.flash.is_some_and(|(c, f, _, _)| c == id && f == i);
            if i + 3 < tr.items.len() && !flashing {
                if let Some((w, h)) = ui.data(|d| d.get_temp::<(f32, f32)>(height_key)) {
                    let view = ui.clip_rect();
                    if w == width && (top > view.bottom() + CULL_MARGIN || top + h < view.top() - CULL_MARGIN) {
                        ui.add_space(h);
                        continue;
                    }
                }
            }
            use crate::view::Card;
            match &shown.card {
                Card::Hidden => {}
                Card::User { text, files, images: shown_images, at, mentions, sender } => {
                    // Measured here, not from the transcript's start: the bubble sits against
                    // this row's right edge and never reaches past it, whatever came before.
                    let avail = ui.available_width().min(width);
                    let bubble = ui.allocate_ui_with_layout(Vec2::new(avail, 0.0), Layout::right_to_left(Align::Min), |ui| {
                        Frame::new()
                            .fill(t.gray(100))
                            .corner_radius(CornerRadius::same(RADIUS_LG))
                            .inner_margin(Margin::symmetric(14, 10))
                            .show(ui, |ui| {
                                // Hug the text: as wide as its longest line, at most 80%.
                                let font = ui.style().text_styles.get(&theme::ts("copy-14")).cloned().unwrap_or_default();
                                let mut need = text.lines().map(|l| ui.painter().layout_no_wrap(l.to_string(), font.clone(), Color32::WHITE).size().x).fold(0.0, f32::max);
                                let images = shown_images.len();
                                if images > 0 {
                                    need = need.max(images.min(3) as f32 * (THUMB.x + 8.0) - 8.0);
                                } else if !files.is_empty() {
                                    need = need.max(220.0);
                                }
                                if !mentions.is_empty() {
                                    need = need.max(260.0);
                                }
                                ui.set_max_width((need + 2.0).min(avail * 0.8 - 28.0).max(40.0));
                                ui.vertical(|ui| {
                                    if !mentions.is_empty() {
                                        ui.horizontal_wrapped(|ui| {
                                            ui.spacing_mut().item_spacing = Vec2::splat(6.0);
                                            for m in mentions.iter() {
                                                if let crate::mentions::Click::Open = crate::mentions::chip(ui, m, false) {
                                                    action = Some(MsgAction::Point(m.item));
                                                }
                                            }
                                        });
                                    }
                                    if images > 0 {
                                        let keys: Vec<String> = shown_images.iter().map(|s| s.to_string()).collect();
                                        crate::images::strip(ui, &keys, THUMB);
                                    }
                                    if !text.is_empty() {
                                        ui.add(egui::Label::new(RichText::new(*text).text_style(theme::ts("copy-14"))).wrap());
                                    }
                                    for f in files {
                                        let name = std::path::Path::new(f).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                                        ui.label(RichText::new(format!("{}  {name}", ic::CLIP)).text_style(theme::ts("label-12")).color(t.subtle()))
                                            .tip(*f);
                                    }
                                });
                            })
                            .response
                            .rect
                    });
                    // Only the bubble's own width counts as "hovering the message".
                    if let Some(a) = hover_actions(ui, bubble.inner, true, *at, &[(ic::COPY, "Copy"), (ic::LINK, "Quote in reply"), ("@", "Mention in your next message")]) {
                        action = Some(match a {
                            0 => MsgAction::Copy(text.to_string()),
                            1 => MsgAction::Quote(text.to_string()),
                            _ => MsgAction::Mention(i),
                        });
                    }
                    // Written on another PC or a phone: where, under the bubble.
                    if !sender.is_empty() {
                        ui.add_space(-8.0);
                        // One line inside the column: a long "from … via …" ends in "…" (full on hover).
                        ui.allocate_ui_with_layout(Vec2::new(avail, 0.0), Layout::right_to_left(Align::Min), |ui| {
                            let from = format!("from {sender}");
                            ui.add(egui::Label::new(RichText::new(&from).text_style(theme::ts("label-12")).color(t.subtle())).truncate()).on_hover_text(from);
                        });
                    }
                }
                Card::Text { text, at, forkable } => {
                    // The transcript's 12px item spacing pushes list text below its
                    // number/bullet; markdown gets its own tighter spacing.
                    let r = ui
                        .vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 5.0;
                            // List rows are bottom-aligned in egui_commonmark; with Harbor's
                            // 32px minimum row height the marker and the text drift apart.
                            let line = ui.text_style_height(&egui::TextStyle::Body);
                            ui.spacing_mut().interact_size.y = line;
                            // The theme's forced text colour would paint links like plain text.
                            let fg = ui.visuals().override_text_color;
                            ui.visuals_mut().override_text_color = None;
                            if let Some(fg) = fg {
                                ui.visuals_mut().widgets.noninteractive.fg_stroke.color = fg;
                            }
                            // Its own id scope: egui_commonmark numbers tables from 0 in every
                            // viewer, so two messages' tables shared an id and their grids and
                            // scroll bars overwrote each other's state, repainting every frame.
                            ui.push_id(("md", id, i), |ui| CommonMarkViewer::new().show(ui, &mut self.md, &linkify(&crate::media::strip_refs(text))))
                        })
                        .response
                        .rect;
                    let ctx = ui.ctx().clone();
                    media_view(ui, &crate::view::media(&shown.card, &mut |t| crate::images::media_in(&ctx, t, &cwd)), 0.0);
                    let mut buttons = vec![(ic::COPY, "Copy"), ("@", "Mention in your next message")];
                    if *forkable {
                        buttons.insert(1, (ic::FORK, "Fork from this response"));
                    }
                    if let Some(a) = hover_actions(ui, r, false, *at, &buttons) {
                        action = Some(match buttons[a].0 {
                            ic::COPY => MsgAction::Copy(text.to_string()),
                            ic::FORK => MsgAction::Fork(i),
                            _ => MsgAction::Mention(i),
                        });
                    }
                }
                Card::Thinking { text } => {
                    egui::CollapsingHeader::new(RichText::new(format!("{}  Thinking", ic::BRAIN)).text_style(theme::ts("label-13")).color(t.subtle()))
                        .id_salt(("think", id, i))
                        .show(ui, |ui| {
                            ui.label(RichText::new(*text).text_style(theme::ts("copy-14")).color(t.subtle()).italics());
                        });
                }
                Card::Tool { label, summary, input, result, is_error } => {
                    let key = (id, i);
                    let open = self.expanded_tools.contains(&key);
                    let (icon, col) = match (result, is_error) {
                        (None, _) => (ic::LOADER, t.gray(900)),
                        (Some(_), true) => (ic::CIRCLE_X, t.red(900)),
                        (Some(_), false) => (ic::CIRCLE_CHECK, t.green(900)),
                    };
                    let r = Frame::new()
                        .corner_radius(CornerRadius::same(RADIUS_MD))
                        .inner_margin(Margin::symmetric(8, 4))
                        .fill(if open { t.bg200 } else { Color32::TRANSPARENT })
                        .show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.horizontal(|ui| {
                                ui.spacing_mut().item_spacing.x = 8.0;
                                ui.label(RichText::new(icon).color(col).size(14.0));
                                ui.label(RichText::new(label).text_style(theme::ts("strong-14")));
                                let rest = ui.available_width();
                                let g = w::truncated(ui, summary, FontId::new(12.5, egui::FontFamily::Monospace), t.subtle(), rest);
                                ui.label(g);
                            });
                            if open {
                                ui.add_space(4.0);
                                w::well(ui).show(ui, |ui| {
                                    ui.set_width(ui.available_width());
                                    ui.label(RichText::new(clip(input, 4000)).text_style(theme::ts("label-12-mono")));
                                });
                                if let Some(res) = result {
                                    ui.add_space(4.0);
                                    w::well(ui).show(ui, |ui| {
                                        ui.set_width(ui.available_width());
                                        let c = if *is_error { t.red(900) } else { t.fg() };
                                        ui.label(RichText::new(clip(res, 8000)).text_style(theme::ts("label-12-mono")).color(c));
                                    });
                                }
                            }
                        })
                        .response
                        .interact(Sense::click());
                    if r.clicked() {
                        if open {
                            self.expanded_tools.remove(&key);
                        } else {
                            self.expanded_tools.insert(key);
                        }
                    }
                    if crate::mentions::hover_button(ui, r.rect, false) {
                        action = Some(MsgAction::Mention(i));
                    }
                    r.on_hover_cursor(egui::CursorIcon::PointingHand);
                    // Images the tool read or wrote (a Read of a .png, a screenshot).
                    let ctx = ui.ctx().clone();
                    media_view(ui, &crate::view::media(&shown.card, &mut |t| crate::images::media_in(&ctx, t, &cwd)), 30.0);
                }
                // An image or video an agent showed (show_media).
                Card::Media { .. } => {
                    let ctx = ui.ctx().clone();
                    let media = crate::view::media(&shown.card, &mut |t| crate::images::media_in(&ctx, t, &cwd));
                    if media.is_empty() {
                        w::subtle(ui, format!("{}  Can't show this file here", ic::ALERT), "label-12");
                    }
                    media_view(ui, &media, 0.0);
                }
                Card::Footer { text, .. } => {
                    w::subtle(ui, text.as_str(), "label-12-mono");
                }
                // The top of a fork: back to the reply it was forked from.
                Card::ForkedFrom { chat, seq } => {
                    if crate::fork::divider(ui, "Forked from conversation", "Open source conversation") && *chat > 0 {
                        action = Some(MsgAction::OpenAt(*chat, *seq));
                    }
                }
                Card::Notice { icon, text, detail, markdown, url } => {
                    let key = (id, i);
                    let open = self.expanded_tools.contains(&key);
                    let glyph = match *icon {
                        "bot" | "report" => ic::BOT,
                        "wake" => ic::ALARM,
                        "webhook" => ic::WEBHOOK,
                        "alert" => ic::ALERT,
                        "fork" => ic::FORK,
                        "process" => ic::ACTIVITY,
                        "clock" => ic::CLOCK,
                        "restart" => ic::ROTATE_CW,
                        "folder" => ic::FOLDER,
                        "users" => ic::USERS,
                        _ => ic::CIRCLE_CHECK,
                    };
                    // The pill never grows past the column (a long agent report widened the whole
                    // transcript, and right-aligned bubbles were cut at the edge): the text ends
                    // in "…" and shows whole on hover.
                    let column = ui.available_width();
                    let r = ui
                        .vertical_centered(|ui| {
                            Frame::new()
                                .fill(t.gray(100))
                                .stroke(Stroke::new(1.0, t.border()))
                                .corner_radius(CornerRadius::same(14))
                                .inner_margin(Margin::symmetric(12, 4))
                                .show(ui, |ui| {
                                    ui.horizontal(|ui| {
                                        ui.spacing_mut().item_spacing.x = 6.0;
                                        ui.label(RichText::new(glyph).size(13.0).color(t.subtle()));
                                        let chevron = !detail.is_empty() && !detail.starts_with("http");
                                        let rest = (column - 24.0 - 19.0 - if chevron { 18.0 } else { 0.0 }).max(40.0);
                                        let g = w::truncated(ui, text, FontId::new(13.0, egui::FontFamily::Proportional), t.fg(), rest);
                                        if g.size().x + 1.0 < ui.painter().layout_no_wrap(text.to_string(), FontId::new(13.0, egui::FontFamily::Proportional), t.fg()).size().x {
                                            ui.label(g).on_hover_text(*text);
                                        } else {
                                            ui.label(g);
                                        }
                                        if chevron {
                                            ui.label(RichText::new(if open { ic::UP } else { ic::DOWN }).size(12.0).color(t.subtle()));
                                        }
                                    });
                                })
                                .response
                                .interact(Sense::click())
                        })
                        .inner;
                    if crate::mentions::hover_button(ui, r.rect, true) {
                        action = Some(MsgAction::Mention(i));
                    }
                    if let Some(url) = url {
                        // A process's URL: open it in Harbor's browser.
                        if r.on_hover_cursor(egui::CursorIcon::PointingHand).tip("Open in Harbor's browser").clicked() {
                            action = Some(MsgAction::OpenUrl(url.to_string()));
                        }
                    } else if !detail.is_empty() {
                        if r.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                            if open {
                                self.expanded_tools.remove(&key);
                            } else {
                                self.expanded_tools.insert(key);
                            }
                        }
                        if open {
                            w::well(ui).show(ui, |ui| {
                                ui.set_width(ui.available_width());
                                if *markdown {
                                    ui.push_id(("md-detail", id, i), |ui| CommonMarkViewer::new().show(ui, &mut self.md, detail));
                                } else {
                                    ui.label(RichText::new(clip(detail, 6000)).text_style(theme::ts("label-12-mono")));
                                }
                            });
                        }
                    }
                }
                Card::Message { from, to, text } => {
                    let r = Frame::new()
                        .fill(t.blue(100))
                        .stroke(Stroke::new(1.0, t.blue(400)))
                        .corner_radius(CornerRadius::same(RADIUS_LG))
                        .inner_margin(Margin::symmetric(12, 8))
                        .show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.horizontal(|ui| {
                                ui.label(RichText::new(ic::MESSAGE).size(13.0).color(t.blue(900)));
                                ui.label(RichText::new(format!("{from} → {to}")).text_style(theme::ts("strong-14")).color(t.blue(900)));
                            });
                            ui.label(RichText::new(clip(text, 6000)).text_style(theme::ts("copy-14")));
                        })
                        .response;
                    if crate::mentions::hover_button(ui, r.rect, false) {
                        action = Some(MsgAction::Mention(i));
                    }
                }
                Card::Error { text } => {
                    Frame::new()
                        .fill(t.red(100))
                        .stroke(Stroke::new(1.0, t.red(400)))
                        .corner_radius(CornerRadius::same(RADIUS_LG))
                        .inner_margin(Margin::symmetric(12, 8))
                        .show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.label(RichText::new(clip(text, 4000)).text_style(theme::ts("label-13-mono")).color(t.red(900)));
                        });
                }
            }
            if let Some(f) = fork_dividers(ui, &shown.forks_after) {
                action = Some(MsgAction::Open(f));
            }
            // A mention chip was clicked: this item scrolls into view and lights up.
            let rect = Rect::from_x_y_ranges(ui.max_rect().x_range(), top..=(ui.cursor().top() - 12.0).max(top));
            self.mentions.flash(ui, id, i, rect);
            ui.data_mut(|d| d.insert_temp(height_key, (width, ui.cursor().top() - top)));
        }
        match action {
            Some(MsgAction::Copy(text)) => ui.ctx().copy_text(text),
            Some(MsgAction::OpenUrl(url)) => self.open_browser(Some(url)),
            Some(MsgAction::Open(chat)) => {
                if self.chat(chat).is_some() {
                    self.open(View::Chat(chat));
                }
            }
            Some(MsgAction::OpenAt(chat, i)) => {
                if self.chat(chat).is_some() {
                    self.open(View::Chat(chat));
                    self.point_at(ui.ctx(), chat, i);
                }
            }
            Some(MsgAction::Quote(text)) => {
                let quote: String = text.lines().map(|l| format!("> {l}\n")).collect();
                let draft = self.drafts.entry(id).or_default();
                *draft = format!("{quote}\n{draft}");
                self.focus_composer = true;
            }
            Some(MsgAction::Fork(upto)) => self.fork_from(id, upto),
            Some(MsgAction::Mention(i)) => self.mention(id, i),
            Some(MsgAction::Point(i)) => self.point_at(ui.ctx(), id, i),
            None => {}
        }
        self.status_line(ui, id);
    }

    // ------------------------------------------------------------ composer

    /// Over the composer in a cloned project the user hasn't trusted yet: its agents run
    /// without the project's own agent settings and hooks until they do.
    fn trust_bar(&mut self, ui: &mut Ui) {
        let repo = match self.view {
            View::Chat(id) => self.chat(id).and_then(|c| c.repo_id),
            View::Draft => self.draft.repo,
            _ => None,
        };
        let Some(repo) = repo.filter(|r| !self.trusted(Some(*r))) else { return };
        let t = self.theme.t;
        Frame::new()
            .fill(t.bg200)
            .stroke(Stroke::new(1.0, t.border()))
            .corner_radius(CornerRadius::same(12))
            .inner_margin(Margin::symmetric(14, 10))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    w::subtle(ui, "Cloned project: agents ignore its own agent settings and hooks until you trust it.", "label-13");
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if w::btn("Trust project").primary().xs().show(ui).clicked() {
                            self.set_trusted(repo, true);
                        }
                    });
                });
            });
        ui.add_space(8.0);
    }

    pub fn composer(&mut self, ui: &mut Ui, running: Option<u64>) {
        // Pre-team chats run an agent with all tools; work now goes through the lead.
        if let View::Chat(id) = self.view {
            if let Some(c) = self.chat(id).filter(|c| c.role == Role::Chat).cloned() {
                let t = self.theme.t;
                Frame::new()
                    .fill(t.bg200)
                    .stroke(Stroke::new(1.0, t.border()))
                    .corner_radius(CornerRadius::same(16))
                    .inner_margin(Margin::same(16))
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.horizontal(|ui| {
                            w::subtle(ui, "This is an earlier chat, kept read-only. Start a new chat in the project to continue.", "label-14");
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if let Some(repo) = c.repo_id {
                                    if w::btn(&format!("{}  New chat", ic::COMPOSE)).xs().primary().show(ui).clicked() {
                                        self.new_draft(Some(repo));
                                    }
                                }
                            });
                        });
                    });
                return;
            }
        }
        // Another PC's chat: where it runs, or read-only while that PC is off.
        if self.mesh_composer(ui) {
            return;
        }
        if let View::Chat(id) = self.view {
            self.typing_line(ui, id);
            self.agent_strip(ui, id);
            self.recap_line(ui, id);
        }
        self.trust_bar(ui);
        let t = self.theme.t;
        let key = self.key();
        let cid = Id::NULL.with(("composer", key));
        let focused = ui.memory(|m| m.has_focus(cid));
        let mut send = false;
        let mut draft = self.drafts.remove(&key).unwrap_or_default();
        // The suggested next prompt (recap.rs): the empty composer's placeholder; Tab or → takes it.
        let ghost = match self.view {
            View::Chat(id) if running.is_none() => self.ghost(id, &draft),
            _ => None,
        };
        crate::recap::accept_keys(ui, cid, &mut draft, ghost.as_deref());
        // Shift+Enter (by default): a line break at the cursor. Keys match exactly
        // (keys.rs), so the order of these checks doesn't matter.
        if focused && ui.input_mut(|i| self.keys.take(i, "newline")) {
            let mut state = egui::text_edit::TextEditState::load(ui.ctx(), cid).unwrap_or_default();
            let at = state.cursor.char_range().map(|r| r.primary.index.0).unwrap_or(draft.chars().count());
            let byte = draft.char_indices().nth(at).map(|(b, _)| b).unwrap_or(draft.len());
            draft.insert(byte, '\n');
            state.cursor.set_char_range(Some(egui::text::CCursorRange::one(egui::text::CCursor::new(at + 1))));
            state.store(ui.ctx(), cid);
        }
        // The slash menu takes its keys first: Enter accepts its entry instead of sending.
        let mut slash = if focused { self.slash_keys(ui, key, cid, &mut draft) } else { None };
        if focused {
            self.tags_keys(ui, key, cid, &mut draft);
        }
        // The dictation shortcut works wherever the composer is (not only while it's focused).
        if self.popup.is_none() && self.dialog.is_none() && ui.input_mut(|i| self.keys.take(i, "voice")) {
            self.voice_toggle(key, ui.ctx());
        }
        // While a turn runs, a message steers it; Ctrl+Enter does the same as Enter.
        let mut now = false;
        if focused && self.popup.is_none() && !crate::images::is_open(ui.ctx()) {
            now = ui.input_mut(|i| self.keys.take(i, "send_now"));
            send = ui.input_mut(|i| self.keys.take(i, "send"));
        }
        let sel = self.sel();
        let account = self.account(&sel.account).cloned();
        let kind = account.as_ref().map(|a| a.kind).unwrap_or(Kind::Claude);
        let mut remove: Option<usize> = None;
        let mut open: Option<(Popup, Rect)> = None;
        let mut attach = false;
        let mut stop = false;

        let frame = Frame::new()
            .fill(if t.dark { t.bg200 } else { t.bg100 })
            .stroke(Stroke::new(1.0, if focused { t.gray(600) } else { t.border() }))
            .corner_radius(CornerRadius::same(16))
            .inner_margin(Margin { left: 18, right: 14, top: 16, bottom: 12 });
        let mut unmention: Option<usize> = None;
        let mut point: Option<usize> = None;
        let mut model_rect = Rect::NOTHING;
        let mut effort_rect = Rect::NOTHING;
        let shown = frame.show(ui, |ui| {
            ui.set_width(ui.available_width());
            // Mentioned messages; a click shows the message in the chat.
            if let Some(ms) = self.mentions.drafts.get(&key).filter(|m| !m.is_empty()) {
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = Vec2::splat(8.0);
                    for (i, m) in ms.iter().enumerate() {
                        match crate::mentions::chip(ui, m, true) {
                            crate::mentions::Click::Remove => unmention = Some(i),
                            crate::mentions::Click::Open => point = Some(m.item),
                            crate::mentions::Click::None => {}
                        }
                    }
                });
                ui.add_space(6.0);
            }
            if let Some(files) = self.files.get(&key).filter(|f| !f.is_empty()) {
                // Images as thumbnails, other files as chips.
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = Vec2::splat(8.0);
                    for (i, f) in files.iter().enumerate() {
                        let path = f.to_string_lossy();
                        if crate::images::is_image(&path) {
                            if crate::images::attachment(ui, &path, Vec2::splat(64.0)) {
                                remove = Some(i);
                            }
                        }
                    }
                    for (i, f) in files.iter().enumerate() {
                        if !crate::images::is_image(&f.to_string_lossy()) {
                            let name = f.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                            if w::file_chip(ui, &name, false) {
                                remove = Some(i);
                            }
                        }
                    }
                });
                ui.add_space(6.0);
            }
            if ghost.is_some() {
                crate::recap::tint_hint(ui, cid);
            }
            let input = w::composer(ui, cid, &mut draft, ghost.as_deref().unwrap_or("Ask for changes, send follow-ups, or attach images"), 3);
            if ghost.is_some() && draft.is_empty() {
                crate::recap::tab_tag(ui, cid, input.rect);
            }
            ui.add_space(10.0);
            // Narrow composers (T3 Code's compact footer): effort and access go
            // icon-only, so the send button always stays in view.
            let compact = ui.available_width() < 560.0;
            let tiny = ui.available_width() < 460.0;
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                let mlabel = self.model_label(kind, &sel.model);
                let badge = account.as_ref().map(|a| a.badge.clone()).unwrap_or_default();
                let r = w::trigger(ui, w::Lead::Provider(kind, &badge), if tiny { "" } else { &mlabel }, self.popup == Some(Popup::Model));
                let tip = account.as_ref().map(|a| a.short()).unwrap_or_default();
                let r = r.on_hover_text(if tiny { format!("{mlabel} · {tip}") } else { tip });
                model_rect = r.rect;
                if r.clicked() {
                    open = Some((Popup::Model, r.rect));
                } else if self.popup == Some(Popup::Model) {
                    self.popup_anchor = r.rect;
                }
                if !providers::efforts(kind).is_empty() {
                    w::vsep(ui, 18.0);
                    let label = if self.fast && providers::has_fast(kind) {
                        format!("{} · Fast", providers::effort_label(kind, &sel.effort))
                    } else {
                        providers::effort_label(kind, &sel.effort).to_string()
                    };
                    let r = w::trigger(ui, w::Lead::Icon(ic::BRAIN), if compact { "" } else { &label }, self.popup == Some(Popup::Effort));
                    let r = if compact { r.on_hover_text(&label) } else { r };
                    effort_rect = r.rect;
                    if r.clicked() {
                        open = Some((Popup::Effort, r.rect));
                    } else if self.popup == Some(Popup::Effort) {
                        self.popup_anchor = r.rect;
                    }
                }
                w::vsep(ui, 18.0);
                let icon = match sel.access.as_str() {
                    "full" => ic::LOCK_OPEN,
                    "plan" => ic::EYE,
                    _ => ic::LOCK,
                };
                let access = providers::access_label(kind, &sel.access);
                let r = w::trigger(ui, w::Lead::Icon(icon), if compact { "" } else { access }, self.popup == Some(Popup::Access));
                let r = if compact { r.on_hover_text(access) } else { r };
                if r.clicked() {
                    open = Some((Popup::Access, r.rect));
                } else if self.popup == Some(Popup::Access) {
                    self.popup_anchor = r.rect;
                }
                w::vsep(ui, 18.0);
                let r = self.device_trigger(ui, compact, &sel);
                if r.clicked() {
                    open = Some((Popup::Device, r.rect));
                } else if self.popup == Some(Popup::Device) {
                    self.popup_anchor = r.rect;
                }
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    let empty = draft.trim().is_empty() && self.files.get(&key).is_none_or(|f| f.is_empty()) && self.mentions.drafts.get(&key).is_none_or(|m| m.is_empty());
                    if running.is_some() {
                        if w::round_button(ui, ic::STOP, true).on_hover_text("Stop (Esc)").clicked() {
                            stop = true;
                        }
                        // Something typed while it works: sending it steers the agent (queue.rs).
                        if !empty && w::round_button(ui, ic::ARROW_UP, true).on_hover_text("Steer the agent with this (Enter)").clicked() {
                            send = true;
                        }
                    } else if w::round_button(ui, ic::ARROW_UP, !empty).on_hover_text("Send (Enter)").clicked() {
                        send = true;
                    }
                    if w::btn(ic::CLIP).muted().icon_sm().show(ui).on_hover_text("Attach files or images (or drop them here)").clicked() {
                        attach = true;
                    }
                    // Dictation (voice.rs): the mic, or the meter and time while it records.
                    self.voice_button(ui, key);
                });
            });
        });
        // Where the agent works and its branch, attached under the box (worktree.rs).
        self.workspace_bar(ui);
        if let Some(h) = self.slash_menu(ui, key, cid, &mut draft, focused, shown.response.rect) {
            slash = Some(h);
        }
        self.tags_menu(ui, key, cid, &mut draft, focused, shown.response.rect);
        self.drafts.insert(key, draft);
        match slash {
            Some(crate::slash::Harbor::Model) => open = Some((Popup::Model, model_rect)),
            Some(crate::slash::Harbor::Effort) => open = Some((Popup::Effort, effort_rect)),
            Some(h) => self.slash_run(key, h),
            None => {}
        }
        if let Some(i) = remove {
            if let Some(f) = self.files.get_mut(&key) {
                f.remove(i);
            }
        }
        if let Some(i) = unmention {
            if let Some(m) = self.mentions.drafts.get_mut(&key) {
                m.remove(i);
            }
        }
        if let Some(i) = point {
            self.point_at(ui.ctx(), key, i);
        }
        if let Some((p, rect)) = open {
            if self.popup == Some(p) {
                self.popup = None;
            } else {
                self.popup = Some(p);
                self.popup_anchor = rect;
                if p == Popup::Model {
                    self.picker = Picker { rail: Some(sel.account.clone()), just_opened: true, ..Default::default() };
                }
            }
        }
        if attach {
            self.pick_files(key);
        }
        if stop {
            if let View::Chat(id) = self.view {
                self.stop_pressed(id, ui.ctx());
            }
        }
        if self.focus_composer && self.dialog.is_none() && self.popup.is_none() && !self.term_focus_pending() {
            ui.memory_mut(|m| m.request_focus(cid));
            self.focus_composer = false;
        }
        if send || now {
            self.send(ui.ctx());
        }
    }

    // ------------------------------------------------------------ popups

    pub fn popups(&mut self, ctx: &egui::Context) {
        let Some(p) = self.popup else { return };
        let t = self.theme.t;
        let anchor = self.popup_anchor;
        let close = match p {
            Popup::Model => {
                let ((), close) = w::popover(ctx, "model-picker", anchor, 448.0, true, &t, |ui| self.model_picker(ui));
                close
            }
            Popup::Effort => {
                let kind = self.account(&self.sel().account).map(|a| a.kind).unwrap_or(Kind::Claude);
                let fast = self.fast;
                let (pick, close) = w::popover(ctx, "effort", anchor, 300.0, true, &t, |ui| {
                    ui.spacing_mut().item_spacing.y = 0.0;
                    let mut pick: Option<Result<String, bool>> = None;
                    menu_header(ui, "Reasoning");
                    let cur = self.sel().effort;
                    let default = providers::default_effort(kind);
                    let cur = if cur.is_empty() { default.to_string() } else { cur };
                    for (k, l, d) in providers::efforts(kind) {
                        if effort_row(ui, l, d, *k == default, cur == *k).clicked() {
                            pick = Some(Ok(k.to_string()));
                        }
                    }
                    if providers::has_fast(kind) {
                        ui.add_space(6.0);
                        w::separator(ui);
                        ui.add_space(6.0);
                        menu_header(ui, "Fast Mode");
                        for (on, l) in [(true, "On"), (false, "Off")] {
                            if effort_row(ui, l, "", false, fast == on).clicked() {
                                pick = Some(Err(on));
                            }
                        }
                    }
                    pick
                });
                match pick {
                    Some(Ok(e)) => {
                        let s = self.sel();
                        self.set_sel(Sel { effort: e, ..s });
                        self.popup = None;
                    }
                    Some(Err(on)) => {
                        self.fast = on;
                        self.store.set("fast_mode", if on { "1" } else { "0" });
                        self.popup = None;
                    }
                    None => {}
                }
                close
            }
            Popup::Access => {
                let kind = self.account(&self.sel().account).map(|a| a.kind).unwrap_or(Kind::Claude);
                let (pick, close) = w::popover(ctx, "access", anchor, 320.0, true, &t, |ui| {
                    w::subtle(ui, "  Access", "label-12");
                    let cur = self.sel().access;
                    let mut pick = None;
                    for (k, l, d) in providers::access(kind) {
                        let icon = match *k {
                            "full" => ic::LOCK_OPEN,
                            "plan" => ic::EYE,
                            _ => ic::LOCK,
                        };
                        if w::menu_item(ui, icon, l, Some(d), cur == *k).clicked() {
                            pick = Some(k.to_string());
                        }
                    }
                    pick
                });
                if let Some(a) = pick {
                    let s = self.sel();
                    self.set_sel(Sel { access: a, ..s });
                    self.popup = None;
                }
                close
            }
            Popup::Project => {
                let (pick, close) = w::popover(ctx, "project", anchor, 300.0, false, &t, |ui| {
                    w::subtle(ui, "  Project", "label-12");
                    let mut pick: Option<Option<Option<i64>>> = None;
                    ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                        if w::menu_item(ui, ic::FOLDER, "No project", Some("Runs in your home folder"), self.draft.repo.is_none()).clicked() {
                            pick = Some(Some(None));
                        }
                        for r in &self.repos {
                            if w::menu_item(ui, ic::FOLDER, &r.name, Some(&tilde(&r.path)), self.draft.repo == Some(r.id)).clicked() {
                                pick = Some(Some(Some(r.id)));
                            }
                        }
                    });
                    w::separator(ui);
                    if w::menu_item(ui, ic::FOLDER_PLUS, "Add project…", None, false).clicked() {
                        pick = Some(None);
                    }
                    pick
                });
                match pick {
                    Some(Some(repo)) => {
                        self.draft.repo = repo;
                        self.store.set("draft_repo", &repo.map(|r| r.to_string()).unwrap_or_default());
                        self.popup = None;
                        // Stay on the draft: the first message starts a chat in that project.
                        self.focus_composer = true;
                    }
                    Some(None) => {
                        self.popup = None;
                        self.open_add_project();
                    }
                    None => {}
                }
                close
            }
            Popup::Filter => {
                let ((), close) = w::popover(ctx, "filter", anchor, 260.0, false, &t, |ui| self.filter_menu(ui));
                close
            }
            Popup::Device => self.device_menu(ctx),
            Popup::Workspace => self.workspace_menu(ctx),
            Popup::Branch => self.branch_menu(ctx),
            Popup::Snooze => {
                let ((), close) = w::popover(ctx, "snooze", anchor, 220.0, false, &t, |ui| self.snooze_menu(ui));
                close
            }
        };
        if close && !self.picker.just_opened {
            self.popup = None;
            self.focus_composer = true;
        }
        self.picker.just_opened = false;
    }

    /// Rows visible in the picker for its current rail/search state.
    fn picker_rows(&self) -> (Vec<Row>, Option<(String, usize)>) {
        let locked = self.locked_kind();
        let ok = |k: Kind| locked.is_none_or(|l| l == k);
        let row = |a: &crate::providers::Account, m: &crate::providers::Model| Row {
            account: a.id.clone(),
            kind: a.kind,
            model: m.id.clone(),
            label: m.label.clone(),
            sub: a.short(),
            enabled: ok(a.kind) && a.installed(),
        };
        let q = self.picker.search.trim().to_lowercase();
        if !q.is_empty() {
            let mut v = vec![];
            for a in self.accounts.iter().filter(|a| a.installed()) {
                for m in self.models_for(a.kind) {
                    if m.label.to_lowercase().contains(&q) || m.id.to_lowercase().contains(&q) || a.short().to_lowercase().contains(&q) {
                        v.push(row(a, m));
                    }
                }
            }
            return (v, None);
        }
        match &self.picker.rail {
            None => {
                let v = self
                    .favorites
                    .iter()
                    .filter_map(|(aid, mid)| {
                        let a = self.account(aid)?;
                        let m = self.models_for(a.kind).iter().find(|m| &m.id == mid).cloned().unwrap_or(crate::providers::Model {
                            id: mid.clone(),
                            label: mid.clone(),
                            more: false,
                        });
                        Some(row(a, &m))
                    })
                    .collect();
                (v, None)
            }
            Some(aid) => {
                let Some(a) = self.account(aid) else { return (vec![], None) };
                let all = self.models_for(a.kind);
                let more: Vec<_> = all.iter().filter(|m| m.more).collect();
                if self.picker.more {
                    (more.iter().map(|m| row(a, m)).collect(), None)
                } else {
                    let main = all.iter().filter(|m| !m.more).map(|m| row(a, m)).collect();
                    let label = if a.kind == Kind::Codex { "Legacy models" } else { "More models" };
                    (main, (!more.is_empty()).then(|| (label.to_string(), more.len())))
                }
            }
        }
    }

    pub fn picker_pick_nth(&mut self, n: usize) {
        let (rows, _) = self.picker_rows();
        if let Some(r) = rows.get(n).filter(|r| r.enabled).cloned() {
            self.pick_model(&r.account, &r.model);
        }
    }

    fn pick_model(&mut self, account: &str, model: &str) {
        let s = self.sel();
        self.set_sel(Sel { account: account.into(), model: model.into(), ..s });
        self.popup = None;
        self.focus_composer = true;
    }

    fn model_picker(&mut self, ui: &mut Ui) {
        let t = self.theme.t;
        let h = 300.0;
        let sel = self.sel();
        ui.horizontal_top(|ui| {
            ui.spacing_mut().item_spacing = Vec2::new(0.0, 4.0);
            // ---- rail
            let (rail, _) = ui.allocate_exact_size(Vec2::new(52.0, h), Sense::hover());
            let mut y = rail.top() + 2.0;
            let tile = |ui: &mut Ui, y: f32, id: &str| -> (Rect, egui::Response) {
                let r = Rect::from_min_size(pos2(rail.left() + 4.0, y), Vec2::splat(40.0));
                let resp = ui.interact(r, Id::NULL.with(("rail", id)), Sense::click());
                (r, resp)
            };
            // favourites
            let (r, resp) = tile(ui, y, "fav");
            let active = self.picker.rail.is_none();
            if resp.hovered() || active {
                ui.painter().rect_filled(r, CornerRadius::same(RADIUS_MD), if active { t.gray(200) } else { t.gray(100) });
            }
            ic::glyph(ui.painter(), r.center(), ic::STAR, 18.0, t.amber(900));
            if resp.tip("Favourites").clicked() {
                self.picker.rail = None;
                self.picker.more = false;
            }
            y += 46.0;
            ui.painter().hline(rail.left() + 10.0..=rail.right() - 10.0, y - 3.0, Stroke::new(1.0, t.border()));
            y += 4.0;
            let accounts: Vec<_> = self.accounts.iter().filter(|a| a.installed()).cloned().collect();
            let locked = self.locked_kind();
            for a in &accounts {
                if y + 40.0 > rail.bottom() {
                    break;
                }
                let (r, resp) = tile(ui, y, &a.id);
                let active = self.picker.rail.as_deref() == Some(&a.id);
                if resp.hovered() || active {
                    ui.painter().rect_filled(r, CornerRadius::same(RADIUS_MD), if active { t.gray(200) } else { t.gray(100) });
                }
                if active {
                    ui.painter().rect_filled(Rect::from_min_size(pos2(rail.right() - 3.0, r.top() + 8.0), Vec2::new(3.0, 24.0)), CornerRadius::same(2), t.gray(1000));
                }
                let dim = a.logged_in == Some(false) || locked.is_some_and(|k| k != a.kind);
                let painter = if dim { ui.painter().clone().with_layer_id(ui.layer_id()) } else { ui.painter().clone() };
                ic::account_mark(&painter, r.shrink(8.0), a.kind, &a.badge, &t);
                if dim {
                    ui.painter().rect_filled(r.shrink(6.0), CornerRadius::same(4), w::alpha(t.bg100, 0.5));
                }
                let mut tip = format!("{}\n{}", a.short(), if a.email.is_empty() { a.name.clone() } else { a.email.clone() });
                if !a.plan.is_empty() {
                    tip.push_str(&format!("\n{}", a.plan));
                }
                for wdw in &a.usage {
                    tip.push_str(&format!("\n{}: {:.0}% used", wdw.label, wdw.percent * 100.0));
                }
                if a.logged_in == Some(false) {
                    tip.push_str("\nNot signed in — Settings › Providers");
                }
                if resp.tip(tip).clicked() {
                    self.picker.rail = Some(a.id.clone());
                    self.picker.more = false;
                    self.picker.hover = 0;
                }
                y += 44.0;
            }
            ui.painter().vline(rail.right() + 4.0, rail.y_range(), Stroke::new(1.0, t.border()));
            ui.add_space(12.0);

            // ---- list
            ui.vertical(|ui| {
                ui.set_width(ui.available_width());
                ui.set_min_height(h);
                ui.spacing_mut().item_spacing.y = 2.0;
                // search
                let sid = Id::NULL.with("picker-search");
                let row_w = ui.available_width();
                if w::search_field(ui, &mut self.picker.search, "Search models...", Some(sid), row_w).changed() {
                    self.picker.hover = 0;
                }
                let line_y = ui.cursor().top();
                let focused = ui.memory(|m| m.has_focus(sid));
                ui.painter().hline(ui.max_rect().x_range(), line_y, Stroke::new(1.0, if focused { t.gray(700) } else { t.border() }));
                ui.add_space(6.0);
                if self.picker.just_opened || !ui.memory(|m| m.focused().is_some()) {
                    ui.memory_mut(|m| m.request_focus(sid));
                }

                let (rows, more) = self.picker_rows();
                // keyboard navigation
                let (up, down, enter) = ui.input_mut(|i| {
                    (
                        i.consume_key(egui::Modifiers::NONE, Key::ArrowUp),
                        i.consume_key(egui::Modifiers::NONE, Key::ArrowDown),
                        i.consume_key(egui::Modifiers::NONE, Key::Enter),
                    )
                });
                let n = rows.len().max(1);
                if down {
                    self.picker.hover = (self.picker.hover + 1) % n;
                }
                if up {
                    self.picker.hover = (self.picker.hover + n - 1) % n;
                }
                let mut pick: Option<(String, String)> = None;
                let mut star: Option<(String, String)> = None;
                if enter {
                    if let Some(r) = rows.get(self.picker.hover).filter(|r| r.enabled) {
                        pick = Some((r.account.clone(), r.model.clone()));
                    } else if !self.picker.search.trim().is_empty() {
                        // A model id typed by hand, for the current provider.
                        let aid = self.picker.rail.clone().unwrap_or(sel.account.clone());
                        pick = Some((aid, self.picker.search.trim().to_string()));
                    }
                }

                ScrollArea::vertical().max_height(h - 44.0).auto_shrink([false, false]).show(ui, |ui| {
                    if self.picker.more {
                        if w::menu_item(ui, ic::LEFT, "Back", None, false).clicked() {
                            self.picker.more = false;
                        }
                    }
                    if rows.is_empty() {
                        ui.add_space(16.0);
                        let msg = if self.picker.rail.is_none() && self.picker.search.is_empty() {
                            "Star a model to pin it here."
                        } else if !self.picker.search.is_empty() {
                            "No match — press Enter to use it as a model id."
                        } else {
                            "No models."
                        };
                        ui.vertical_centered(|ui| w::subtle(ui, msg, "label-13"));
                    }
                    for (i, r) in rows.iter().enumerate() {
                        let current = r.account == sel.account && r.model == sel.model;
                        let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 50.0), Sense::click());
                        if resp.hovered() {
                            self.picker.hover = i;
                        }
                        let hl = self.picker.hover == i || current;
                        let p = ui.painter();
                        if hl {
                            p.rect_filled(rect, CornerRadius::same(RADIUS_LG), if current { t.gray(200) } else { t.gray(100) });
                        }
                        let a = if r.enabled { 1.0 } else { 0.45 };
                        p.text(pos2(rect.left() + 12.0, rect.top() + 8.0), Align2::LEFT_TOP, &r.label, FontId::proportional(15.0), w::alpha(t.fg(), a));
                        let mark = Rect::from_min_size(pos2(rect.left() + 11.0, rect.top() + 28.0), Vec2::splat(14.0));
                        ic::account_mark(p, mark, r.kind, "", &t);
                        p.text(pos2(mark.right() + 6.0, mark.center().y), Align2::LEFT_CENTER, &r.sub, FontId::proportional(13.0), w::alpha(t.subtle(), a));
                        // star
                        let sr = Rect::from_center_size(pos2(rect.right() - 20.0, rect.center().y), Vec2::splat(26.0));
                        let sresp = ui.interact(sr, Id::NULL.with(("star", &r.account, &r.model)), Sense::click());
                        let fav = self.is_favorite(&r.account, &r.model);
                        let scol = if fav { t.amber(900) } else if sresp.hovered() { t.fg() } else { t.subtle() };
                        if fav {
                            star_shape(ui.painter(), sr.center(), 7.0, scol);
                        } else {
                            ic::glyph(ui.painter(), sr.center(), ic::STAR, 15.0, scol);
                        }
                        if sresp.tip(if fav { "Unfavourite" } else { "Favourite" }).clicked() {
                            star = Some((r.account.clone(), r.model.clone()));
                        } else if resp.clicked() && r.enabled {
                            pick = Some((r.account.clone(), r.model.clone()));
                        }
                        if i < 9 {
                            w::kbd(ui, pos2(sr.left() - 10.0, rect.center().y), &format!("Ctrl+{}", i + 1), hl);
                        }
                        if !r.enabled {
                            resp.tip("Start a new chat to switch provider");
                        }
                    }
                    if let Some((label, n)) = &more {
                        let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 50.0), Sense::click());
                        let p = ui.painter();
                        if resp.hovered() {
                            p.rect_filled(rect, CornerRadius::same(RADIUS_LG), t.gray(100));
                        }
                        p.text(pos2(rect.left() + 12.0, rect.top() + 8.0), Align2::LEFT_TOP, label, FontId::proportional(15.0), t.fg());
                        p.text(pos2(rect.left() + 12.0, rect.top() + 28.0), Align2::LEFT_TOP, format!("{n} model{}", if *n == 1 { "" } else { "s" }), FontId::proportional(13.0), t.subtle());
                        ic::glyph(p, pos2(rect.right() - 20.0, rect.center().y), ic::RIGHT, 15.0, t.subtle());
                        if resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                            self.picker.more = true;
                            self.picker.hover = 0;
                        }
                    }
                });
                if let Some((a, m)) = star {
                    self.toggle_favorite(&a, &m);
                }
                if let Some((a, m)) = pick {
                    self.pick_model(&a, &m);
                }
            });
        });
    }
}

/// Filled five-point star (lucide's star is outline-only).
fn star_shape(p: &egui::Painter, c: egui::Pos2, r: f32, col: Color32) {
    let pts: Vec<egui::Pos2> = (0..10)
        .map(|i| {
            let rr = if i % 2 == 0 { r } else { r * 0.45 };
            let a = i as f32 * std::f32::consts::PI / 5.0 - std::f32::consts::FRAC_PI_2;
            c + Vec2::angled(a) * rr
        })
        .collect();
    // Fan from the centre: the outline is concave.
    for i in 0..10 {
        p.add(egui::Shape::convex_polygon(vec![c, pts[i], pts[(i + 1) % 10]], col, Stroke::NONE));
    }
}

/// "Conversation fork · Open fork" for the forks that branch off right before item
/// `i`; the fork clicked, if any.
/// "Conversation fork" dividers for the chats forked after a message; the one clicked.
fn fork_dividers(ui: &mut Ui, forks: &[i64]) -> Option<i64> {
    let mut open = None;
    for f in forks {
        if crate::fork::divider(ui, "Conversation fork", "Open fork") {
            open = Some(*f);
        }
    }
    open
}

/// Size of image thumbnails in the transcript.
const THUMB: Vec2 = Vec2::new(132.0, 96.0);

/// A row of thumbnails under a message or tool call, indented by `indent`.
/// The images and videos a card shows: shown ones large (an image opens the lightbox, a video
/// the system's player) with their captions, files it only names as a strip of thumbnails.
fn media_view(ui: &mut Ui, media: &[crate::media::Media], indent: f32) {
    if media.is_empty() {
        return;
    }
    let max = crate::images::inline_size(ui.available_width() - indent);
    let group: Vec<String> = media.iter().filter(|m| m.shown && !m.video).map(|m| m.path.clone()).collect();
    for m in media.iter().filter(|m| m.shown || m.video) {
        ui.horizontal(|ui| {
            ui.add_space(indent);
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 4.0;
                match m.url.as_deref().and_then(crate::media::download_state) {
                    Some(None) => crate::images::downloading(ui, max),
                    Some(Some(e)) => {
                        if crate::images::failed(ui, &m.path, max, &e) {
                            let url = m.url.as_deref().unwrap_or_default();
                            crate::media::retry(url);
                            crate::media::fetch(url);
                        }
                    }
                    None if m.video => {
                        crate::images::video(ui, &m.path, max);
                    }
                    None => {
                        crate::images::inline(ui, &m.path, max, &group);
                    }
                }
                if !m.caption.is_empty() {
                    w::subtle(ui, m.caption.as_str(), "label-12");
                }
            });
        });
    }
    let rest: Vec<String> = media.iter().filter(|m| !m.shown && !m.video).map(|m| m.path.clone()).collect();
    image_strip(ui, &rest, indent);
}

fn image_strip(ui: &mut Ui, paths: &[String], indent: f32) {
    if paths.is_empty() {
        return;
    }
    ui.horizontal(|ui| {
        ui.add_space(indent);
        crate::images::strip(ui, paths, THUMB);
    });
}

pub use crate::view::tool_label;

enum MsgAction {
    OpenUrl(String),
    Copy(String),
    Quote(String),
    Fork(usize),
    /// Mention item i in the next message.
    Mention(usize),
    /// Scroll to item i and highlight it.
    Point(usize),
    /// Open another thread (a fork).
    Open(i64),
    /// Open another thread and point at its item.
    OpenAt(i64, usize),
}

/// A row under a message, visible only while the message (or the row) is hovered:
/// time plus icon buttons, aligned like the message. Returns the clicked button.
fn hover_actions(ui: &mut Ui, msg: Rect, right: bool, at: i64, buttons: &[(&str, &str)]) -> Option<usize> {
    ui.add_space(-8.0);
    let (row, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 24.0), Sense::hover());
    let zone = Rect::from_min_max(egui::pos2(msg.left().min(row.left()), msg.top()), egui::pos2(msg.right().max(row.right()), row.bottom()));
    // A short reply is narrower than its buttons: the zone reaches past them.
    let reach = row.left() + buttons.len() as f32 * 30.0 + 80.0;
    let zone = if right { Rect::from_min_max(egui::pos2(msg.left(), zone.top()), zone.max) } else { Rect::from_min_max(zone.min, egui::pos2(msg.right().max(reach), zone.bottom())) };
    if !ui.rect_contains_pointer(zone) {
        return None;
    }
    let t = w::tokens(ui);
    let time = if at > 0 { crate::team::clock(at) } else { String::new() };
    let layout = if right { Layout::right_to_left(Align::Center) } else { Layout::left_to_right(Align::Center) };
    let mut child = ui.new_child(egui::UiBuilder::new().max_rect(row).layout(layout));
    child.spacing_mut().item_spacing.x = 2.0;
    let mut clicked = None;
    let draw_time = |ui: &mut Ui| {
        if !time.is_empty() {
            ui.add_space(6.0);
            ui.label(RichText::new(&time).text_style(theme::ts("label-12")).color(t.subtle()));
            ui.add_space(6.0);
        }
    };
    if right {
        // Right to left: buttons first (rightmost), then the time.
        for (i, (icon, tip)) in buttons.iter().enumerate().rev() {
            if w::btn(icon).muted().icon_xs().show(&mut child).tip(*tip).clicked() {
                clicked = Some(i);
            }
        }
        draw_time(&mut child);
    } else {
        for (i, (icon, tip)) in buttons.iter().enumerate() {
            if w::btn(icon).muted().icon_xs().show(&mut child).tip(*tip).clicked() {
                clicked = Some(i);
            }
        }
        draw_time(&mut child);
    }
    clicked
}

fn menu_header(ui: &mut Ui, text: &str) {
    let t = w::tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 26.0), Sense::hover());
    ui.painter().text(pos2(rect.left() + 10.0, rect.center().y), Align2::LEFT_CENTER, text, FontId::proportional(12.5), t.subtle());
}

/// A row of the reasoning menu: label, optional "Default" badge and description,
/// highlighted when selected or hovered (as in T3).
fn effort_row(ui: &mut Ui, label: &str, desc: &str, default: bool, selected: bool) -> egui::Response {
    let t = w::tokens(ui);
    let wrapped = (!desc.is_empty()).then(|| {
        let mut job = egui::text::LayoutJob::simple(desc.to_string(), FontId::proportional(12.5), t.subtle(), ui.available_width() - 20.0);
        job.wrap.max_rows = 2;
        ui.painter().layout_job(job)
    });
    let h = match &wrapped {
        Some(g) => 38.0 + g.size().y,
        None => 34.0,
    };
    let width = ui.available_width();
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, h), Sense::click());
    let p = ui.painter();
    if selected || resp.hovered() {
        p.rect_filled(rect.shrink2(Vec2::new(0.0, 1.0)), CornerRadius::same(RADIUS_MD), if selected { t.gray(200) } else { t.gray(100) });
    }
    let g = p.layout_no_wrap(label.into(), FontId::proportional(14.5), t.fg());
    let top = if desc.is_empty() { rect.center().y - g.size().y / 2.0 } else { rect.top() + 8.0 };
    let gw = g.size().x;
    p.galley(pos2(rect.left() + 10.0, top), g, t.fg());
    if default {
        let b = p.layout_no_wrap("Default".into(), FontId::new(11.0, theme::medium()), t.subtle());
        let br = Rect::from_min_size(pos2(rect.left() + 18.0 + gw, top + 1.0), b.size() + Vec2::new(10.0, 4.0));
        p.rect(br, CornerRadius::same(4), t.gray(100), Stroke::new(1.0, t.border()), egui::StrokeKind::Inside);
        p.galley(br.min + Vec2::new(5.0, 2.0), b, t.subtle());
    }
    if let Some(d) = wrapped {
        ui.painter().galley(pos2(rect.left() + 10.0, rect.top() + 30.0), d, t.subtle());
    }
    resp.on_hover_cursor(egui::CursorIcon::PointingHand)
}

/// Turns bare http(s) URLs in agent text into markdown autolinks, so they can be
/// clicked. URLs already in a link, in angle brackets or in code are left alone.
pub fn linkify(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains("http://") && !text.contains("https://") {
        return text.into();
    }
    let mut out = String::with_capacity(text.len() + 16);
    let mut in_code = false;
    let mut rest = text;
    while !rest.is_empty() {
        let at = rest.find(|c| c == '`' || c == 'h').unwrap_or(rest.len());
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        if rest.is_empty() {
            break;
        }
        if rest.starts_with('`') {
            let n = rest.len() - rest.trim_start_matches('`').len();
            in_code = !in_code;
            out.push_str(&rest[..n]);
            rest = &rest[n..];
            continue;
        }
        let prev = out.chars().last();
        let is_url = (rest.starts_with("http://") || rest.starts_with("https://")) && !in_code && !matches!(prev, Some('(' | '<' | '[' | '"' | '\'') ) && !prev.is_some_and(|c| c.is_alphanumeric());
        if !is_url {
            out.push('h');
            rest = &rest[1..];
            continue;
        }
        let end = rest.find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '`')).unwrap_or(rest.len());
        // Sentence punctuation after a URL isn't part of it.
        let url = rest[..end].trim_end_matches(['.', ',', ';', ':', '!', '?', ')', '\'', '*', '_']);
        out.push('<');
        out.push_str(url);
        out.push('>');
        rest = &rest[url.len()..];
    }
    out.into()
}
