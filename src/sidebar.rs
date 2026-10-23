//! Sidebar: search, view options / add project / new message, the projects
//! (one thread each, ordered by hand or by last activity), the collapsible
//! "Settled" section, and the footer (settings, PRs, usage, refresh).

use crate::app::{App, Dialog, Popup, Tab, View, ago};
use crate::git;
use crate::icons as ic;
use crate::store::{Repo, Role};
use crate::widgets as w;
use std::collections::HashMap;
use eframe::egui::{self, Align, CornerRadius, FontId, Id, Layout, Rect, ScrollArea, Sense, Stroke, Ui, Vec2, pos2};

impl App {
    /// Last activity of a project: its newest chat (lead, subagents or old chats).
    pub fn activity(&self, repo: i64) -> i64 {
        self.chats.iter().filter(|c| c.repo_id == Some(repo)).map(|c| c.updated).max().unwrap_or(0)
    }

    fn running_in(&self, repo: i64) -> usize {
        self.chats.iter().filter(|c| c.repo_id == Some(repo) && self.turns.contains_key(&c.id)).count()
    }

    /// When a chat or one of its subagents started the turn still running (the earliest),
    /// None once all of them finished: a lead isn't done while its team still works.
    pub fn team_started(&self, id: i64) -> Option<std::time::Instant> {
        self.chats
            .iter()
            .filter(|c| c.id == id || (c.role == Role::Sub && c.parent == Some(id)))
            .filter_map(|c| self.turns.get(&c.id).map(|(_, at)| *at))
            .min()
    }

    /// Opens the project's main chat, or a new one if it has none.
    pub fn open_project(&mut self, repo: i64) {
        match self.main_thread(repo) {
            Some(id) => self.open(View::Chat(id)),
            None => self.new_draft(Some(repo)),
        }
    }

    /// A chat's sidebar status, its own and its subagents' (not other chats'):
    /// Working while it or a subagent runs, waiting out a usage limit, Done / Failed
    /// until opened, else `idle`.
    fn own_status(&self, id: i64, idle: w::Status) -> w::Status {
        if let Some(at) = self.team_started(id) {
            w::Status::Working(at.elapsed().as_secs())
        } else if let Some(p) = self.paused(id) {
            // Waiting out a usage limit: when it continues.
            let at = p.at.map(crate::limits::when).unwrap_or_else(|| "limit".into());
            w::Status::Text(format!("{} {at}", crate::icons::CLOCK), self.theme.t.amber(900))
        } else if self.failed.contains(&id) {
            w::Status::Failed
        } else if self.unread.contains(&id) {
            w::Status::Done
        } else {
            idle
        }
    }

    /// A chat row's status: its own, else when it was last active.
    fn chat_status(&self, c: &crate::store::Chat) -> w::Status {
        self.own_status(c.id, w::Status::Text(ago(c.updated), self.theme.t.gray(800)))
    }

    /// One chat in the sidebar: title and its status; on hover, snooze and Settle
    /// (or Unsettle) take the status's place.
    fn thread_row(&mut self, ui: &mut Ui, c: &crate::store::Chat, indent: f32) {
        let t = self.theme.t;
        let rect = Rect::from_min_size(ui.cursor().min + Vec2::new(indent, 0.0), Vec2::new(ui.available_width() - indent, 32.0));
        let hovering = ui.rect_contains_pointer(rect);
        let resp = ui.allocate_rect(rect, Sense::click());
        let active = self.view == View::Chat(c.id);
        let p = ui.painter();
        if active || hovering {
            p.rect_filled(rect, CornerRadius::same(crate::theme::RADIUS_MD), t.accent());
        }
        let mut x = rect.left() + 8.0;
        if indent == 0.0 {
            ic::glyph(p, pos2(x + 8.0, rect.center().y), ic::MESSAGE, 14.0, if active { t.fg() } else { t.subtle() });
            x += 24.0;
        }
        let right = if hovering {
            self.row_actions(ui, rect, &format!("c{}", c.id), c.settled)
        } else {
            let status = self.chat_status(c);
            w::paint_status(ui.painter(), pos2(rect.right() - 8.0, rect.center().y), &status);
            w::status_width(ui, &status) + 16.0
        };
        let font = FontId::new(14.0, if active { crate::theme::medium() } else { egui::FontFamily::Proportional });
        let g = w::truncated(ui, &c.title, font, t.fg(), (rect.right() - right - x).max(10.0));
        ui.painter().galley(pos2(x, rect.center().y - g.size().y / 2.0), g, t.fg());
        let resp = resp.on_hover_cursor(egui::CursorIcon::PointingHand);
        if resp.clicked() {
            self.open(View::Chat(c.id));
        }
        resp.context_menu(|ui| {
            if ui.button("Rename").clicked() {
                self.dialog = Some(Dialog::Rename { chat: c.id, title: c.title.clone() });
            }
            if ui.button(if c.settled { "Unsettle" } else { "Settle" }).clicked() {
                self.set_chat_settled(c.id, !c.settled);
            }
            if ui.button("Delete").clicked() {
                self.dialog = Some(Dialog::DeleteChat(c.id));
            }
        });
    }

    /// Hover actions on the right of a chat or project row: snooze, and Settle /
    /// Unsettle. `key` is "c<chat>" or "r<project>". Returns the width they take.
    fn row_actions(&mut self, ui: &mut Ui, rect: Rect, key: &str, settled: bool) -> f32 {
        let label = if settled { format!("{}  Unsettle", ic::UNARCHIVE) } else { format!("{}  Settle", ic::CHECK) };
        let sw = w::btn(&label).muted().sm().width(ui);
        let sr = Rect::from_min_size(pos2(rect.right() - 2.0 - sw, rect.top() + 2.0), Vec2::new(sw, 28.0));
        let b = w::overlay(ui, sr, |ui| w::btn(&label).muted().sm().show(ui));
        if b.clicked() {
            let id: i64 = key[1..].parse().unwrap_or(0);
            if key.starts_with('c') {
                self.set_chat_settled(id, !settled);
            } else {
                self.set_project_settled(id, !settled);
            }
        }
        let mut used = sw + 4.0;
        if !settled {
            let cr = Rect::from_min_size(pos2(sr.left() - 28.0, rect.top() + 2.0), Vec2::splat(28.0));
            let snoozed = self.snoozed.contains_key(key);
            let c = w::overlay(ui, cr, |ui| w::btn(ic::CLOCK).muted().icon_sm().pressed(snoozed).show(ui));
            let c = c.on_hover_text("Snooze");
            if c.clicked() {
                self.snooze_for = key.to_string();
                self.popup = Some(Popup::Snooze);
                self.popup_anchor = c.rect;
            }
            used += 28.0;
        }
        used + 8.0
    }

    pub fn set_chat_settled(&mut self, id: i64, settled: bool) {
        if let Some(c) = self.chat_mut(id) {
            c.settled = settled;
        }
        self.persist(id);
        self.unread.remove(&id);
        self.failed.remove(&id);
    }

    // ------------------------------------------------------------ snooze

    pub fn load_snoozed(&mut self) {
        if let Some(v) = self.store.get("snoozed").and_then(|s| serde_json::from_str::<HashMap<String, i64>>(&s).ok()) {
            self.snoozed = v;
        }
    }

    fn save_snoozed(&self) {
        self.store.set("snoozed", &serde_json::to_string(&self.snoozed).unwrap_or_default());
    }

    pub fn is_snoozed(&self, key: &str) -> bool {
        self.snoozed.get(key).is_some_and(|until| *until > crate::store::now())
    }

    /// Brings snoozed chats and projects back when their time comes, marked unread.
    pub fn wake_snoozed(&mut self, ctx: &egui::Context) {
        if self.snoozed.is_empty() {
            return;
        }
        let now = crate::store::now();
        let due: Vec<String> = self.snoozed.iter().filter(|(_, u)| **u <= now).map(|(k, _)| k.clone()).collect();
        for k in &due {
            self.snoozed.remove(k);
            if let Some(id) = k.strip_prefix('c').and_then(|v| v.parse().ok()) {
                self.unread.insert(id);
            }
        }
        if !due.is_empty() {
            self.save_snoozed();
        }
        if let Some(next) = self.snoozed.values().min() {
            ctx.request_repaint_after(std::time::Duration::from_secs((next - now).clamp(1, 60) as u64));
        }
    }

    pub fn snooze_menu(&mut self, ui: &mut Ui) {
        w::subtle(ui, "  Snooze until", "label-12");
        let now = crate::store::now();
        // Tomorrow 9:00 local time.
        let hm = crate::team::local_hm(now);
        let mut parts = hm.split(':').map(|x| x.parse::<i64>().unwrap_or(0));
        let (h, m) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
        let tomorrow = now - (h * 3600 + m * 60) - now % 60 + 86400 + 9 * 3600;
        let mut pick: Option<Option<i64>> = None;
        for (label, until) in [("1 hour", now + 3600), ("3 hours", now + 3 * 3600), ("Tomorrow, 9:00", tomorrow), ("Next week", tomorrow + 6 * 86400)] {
            if w::menu_item(ui, ic::CLOCK, label, None, false).clicked() {
                pick = Some(Some(until));
            }
        }
        if self.snoozed.contains_key(&self.snooze_for) {
            w::separator(ui);
            if w::menu_item(ui, ic::X, "Unsnooze", None, false).clicked() {
                pick = Some(None);
            }
        }
        if let Some(p) = pick {
            let key = self.snooze_for.clone();
            match p {
                Some(until) => self.snoozed.insert(key, until),
                None => self.snoozed.remove(&key),
            };
            self.save_snoozed();
            self.popup = None;
        }
    }

    // ------------------------------------------------------------ project icons

    /// The project's icon: its own website icon (see favicon.rs), resolved once
    /// on a thread and reloaded when the icon file changes. None = monogram.
    fn avatar(&mut self, ctx: &egui::Context, r: &Repo) -> Option<egui::TextureHandle> {
        if let Some(a) = self.avatars.get(&r.id) {
            let a = a.clone();
            if crate::favicon::changed(r.id) {
                self.load_icon(ctx, r.id, false);
            }
            return a;
        }
        self.avatars.insert(r.id, None);
        self.load_icon(ctx, r.id, false);
        None
    }

    /// Resolves a project's icon in the background; `refresh` re-fetches its website icon.
    fn load_icon(&self, ctx: &egui::Context, id: i64, refresh: bool) {
        let Some(r) = self.repo(id) else { return };
        let tx = self.bg_tx.clone();
        let (path, name, ctx) = (r.path.clone(), r.name.clone(), ctx.clone());
        std::thread::spawn(move || {
            let img = crate::favicon::resolve(id, &path, &name, refresh);
            let _ = tx.send(crate::app::Bg::Avatar(id, img));
            ctx.request_repaint();
        });
    }

    /// Lets the user pick an image file as the project's icon.
    fn pick_icon(&self, ctx: &egui::Context, id: i64) {
        let Some(r) = self.repo(id) else { return };
        let tx = self.bg_tx.clone();
        let (path, name, ctx) = (r.path.clone(), r.name.clone(), ctx.clone());
        std::thread::spawn(move || {
            let out = std::process::Command::new("zenity")
                .args(["--file-selection", "--title=Project icon", "--file-filter=Images | *.png *.svg *.ico *.jpg *.jpeg *.webp *.gif"])
                .arg(format!("--filename={}/", path.display()))
                .output();
            let Some(file) = out.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()) else { return };
            if file.is_empty() || !crate::favicon::set_custom(id, std::path::Path::new(&file)) {
                return;
            }
            let img = crate::favicon::resolve(id, &path, &name, false);
            let _ = tx.send(crate::app::Bg::Avatar(id, img));
            ctx.request_repaint();
        });
    }

    pub fn sidebar(&mut self, ui: &mut Ui) {
        if let View::Settings(tab) = self.view {
            return self.settings_nav(ui, tab);
        }
        let t = self.theme.t;
        ui.spacing_mut().item_spacing = Vec2::new(4.0, 2.0);

        // ---- header: collapse button and the name
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            if w::btn(ic::PANEL_LEFT_CLOSE).muted().icon_sm().show(ui).on_hover_text(self.key_hint("Hide sidebar", "toggle_sidebar")).clicked() {
                let ctx = ui.ctx().clone();
                self.toggle_sidebar(&ctx);
            }
            ui.label(egui::RichText::new("Harbor").text_style(crate::theme::ts("heading-16")).color(t.fg()));
        });
        ui.add_space(4.0);

        // ---- search row
        let row_w = ui.available_width();
        ui.allocate_ui_with_layout(Vec2::new(row_w, 32.0), Layout::left_to_right(Align::Center), |ui| {
            ui.spacing_mut().item_spacing.x = 2.0;
            let wdt = ui.available_width() - 3.0 * 30.0;
            w::search_field(ui, &mut self.search, "Search", None, wdt);
            let f = w::btn(ic::FILTER).muted().icon_sm().pressed(self.popup == Some(Popup::Filter)).show(ui).on_hover_text("Order and view");
            if f.clicked() {
                self.popup = if self.popup == Some(Popup::Filter) { None } else { Some(Popup::Filter) };
                self.popup_anchor = f.rect;
            }
            if w::btn(ic::FOLDER_PLUS).muted().icon_sm().show(ui).on_hover_text("Add project").clicked() {
                self.open_add_project();
            }
            if w::btn(ic::COMPOSE).muted().icon_sm().show(ui).on_hover_text(self.key_hint("New thread", "new_thread")).clicked() {
                self.new_draft(None);
            }
        });
        ui.add_space(8.0);

        let q = self.search.trim().to_lowercase();
        let mut active: Vec<Repo> = self.repos.iter().filter(|r| (!r.settled && !self.is_snoozed(&format!("r{}", r.id))) || !q.is_empty()).cloned().collect();
        if !q.is_empty() {
            active.retain(|r| {
                r.name.to_lowercase().contains(&q)
                    || self.chats.iter().any(|c| c.repo_id == Some(r.id) && c.role != Role::Chat && c.title.to_lowercase().contains(&q))
            });
        }
        if self.order_by_activity {
            active.sort_by_key(|r| std::cmp::Reverse(self.activity(r.id)));
        }
        let settled: Vec<Repo> = self.repos.iter().filter(|r| r.settled).cloned().collect();
        let mut settled_chats: Vec<crate::store::Chat> = self.chats.iter().filter(|c| c.settled && c.role == Role::Lead).cloned().collect();
        settled_chats.sort_by_key(|c| std::cmp::Reverse(c.updated));
        let n_settled = settled.len() + settled_chats.len();

        let footer_h = 40.0;
        let settled_h = if self.settled_open && n_settled > 0 { (n_settled as f32 * 36.0).min(220.0) } else { 0.0 };
        let section_h = if n_settled == 0 { 0.0 } else { 36.0 };
        let list_h = (ui.available_height() - footer_h - section_h - settled_h).max(40.0);

        let draggable = !self.order_by_activity && q.is_empty();
        let mut drop: Option<(i64, usize)> = None;
        ScrollArea::vertical().id_salt("projects").max_height(list_h).min_scrolled_height(list_h).auto_shrink([false, false]).show(ui, |ui| {
            if active.is_empty() {
                ui.add_space(12.0);
                ui.vertical_centered(|ui| {
                    w::subtle(ui, if q.is_empty() { "No projects yet" } else { "No match" }, "label-13");
                    if q.is_empty() && w::btn(&format!("{}  Add project", ic::FOLDER_PLUS)).sm().outline().show(ui).clicked() {
                        self.open_add_project();
                    }
                });
            }
            for (i, r) in active.iter().enumerate() {
                let Some(resp) = self.project_row(ui, r, draggable) else { continue };
                // The project's other chats (the main one is the project row itself).
                let main = self.main_thread(r.id);
                for c in self.threads_of(Some(r.id)) {
                    if c.settled || self.is_snoozed(&format!("c{}", c.id)) {
                        continue;
                    }
                    if Some(c.id) != main && (q.is_empty() || c.title.to_lowercase().contains(&q) || r.name.to_lowercase().contains(&q)) {
                        self.thread_row(ui, &c, 14.0);
                    }
                }
                if draggable {
                    if let Some(dragged) = resp.dnd_hover_payload::<i64>() {
                        if *dragged != r.id {
                            let above = ui.ctx().pointer_interact_pos().is_some_and(|p| p.y < resp.rect.center().y);
                            let y = if above { resp.rect.top() - 1.0 } else { resp.rect.bottom() + 1.0 };
                            ui.painter().hline(resp.rect.x_range(), y, Stroke::new(2.0, t.gray(1000)));
                        }
                    }
                    if let Some(dragged) = resp.dnd_release_payload::<i64>() {
                        let above = ui.ctx().pointer_interact_pos().is_some_and(|p| p.y < resp.rect.center().y);
                        drop = Some((*dragged, if above { i } else { i + 1 }));
                    }
                }
            }
            // Project-less chats ("No project / …").
            let loose: Vec<crate::store::Chat> =
                self.threads_of(None).into_iter().filter(|c| !c.settled && !self.is_snoozed(&format!("c{}", c.id)) && (q.is_empty() || c.title.to_lowercase().contains(&q))).collect();
            if !loose.is_empty() {
                ui.add_space(6.0);
                w::subtle(ui, "  Threads", "label-12");
                for c in &loose {
                    self.thread_row(ui, c, 0.0);
                }
            }
        });
        if let Some((dragged, to)) = drop {
            self.move_project(dragged, to, &active);
        }

        // ---- Settled (N) ─────── ^
        if n_settled > 0 {
            let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 32.0), Sense::click());
            let p = ui.painter();
            let g = p.layout_no_wrap(format!("Settled ({n_settled})"), FontId::proportional(13.0), t.subtle());
            let gw = g.size().x;
            p.galley(pos2(rect.left() + 8.0, rect.center().y - g.size().y / 2.0), g, t.subtle());
            let (x0, x1) = (rect.left() + 8.0 + gw + 10.0, rect.right() - 30.0);
            if x1 > x0 {
                p.hline(x0..=x1, rect.center().y, Stroke::new(1.0, if resp.hovered() { t.gray(600) } else { t.gray(500) }));
            }
            ic::glyph(p, pos2(rect.right() - 14.0, rect.center().y), if self.settled_open { ic::DOWN } else { ic::UP }, 14.0, t.subtle());
            if resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                self.settled_open = !self.settled_open;
            }
            if self.settled_open {
                ScrollArea::vertical().id_salt("settled").max_height(settled_h).auto_shrink([false, true]).show(ui, |ui| {
                    for r in &settled {
                        self.project_row(ui, r, false);
                    }
                    for c in &settled_chats {
                        self.thread_row(ui, c, 0.0);
                    }
                });
            }
        }

        // ---- footer
        ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                let v = self.view;
                // A list page (T3 Code style): Back takes its place, like Esc.
                if matches!(v, View::Prs | View::Issues) {
                    if w::btn(&format!("{}  Back", ic::ARROW_LEFT)).muted().sm().show(ui).on_hover_text("Back (Esc)").clicked() {
                        if v == View::Prs {
                            self.close_prs();
                        } else {
                            self.close_issues();
                        }
                    }
                } else {
                    if w::btn(ic::SETTINGS).muted().icon_sm().pressed(matches!(v, View::Settings(_))).show(ui).on_hover_text(self.key_hint("Settings", "settings")).clicked() {
                        self.open(View::Settings(Tab::General));
                    }
                    if w::btn(ic::PULL).muted().icon_sm().show(ui).on_hover_text("Pull requests").clicked() {
                        self.open_prs(None);
                    }
                    if w::btn(ic::CIRCLE_DOT).muted().icon_sm().show(ui).on_hover_text("Issues").clicked() {
                        self.open_issues(None);
                    }
                }
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if w::btn(ic::REFRESH).muted().icon_sm().show(ui).on_hover_text("Refresh providers, projects and git").clicked() {
                        self.refresh_all();
                    }
                    let n = self.turns.len();
                    if n > 0 {
                        w::subtle(ui, format!("{n} running"), "label-12");
                        w::dot(ui, t.green(700));
                    }
                });
            });
        });
    }

    /// The sidebar while Settings is open (T3 Code style): its pages, a search over
    /// them, and Back to where Settings was opened from.
    fn settings_nav(&mut self, ui: &mut Ui, tab: Tab) {
        let t = self.theme.t;
        ui.spacing_mut().item_spacing = Vec2::new(4.0, 2.0);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            if w::btn(ic::PANEL_LEFT_CLOSE).muted().icon_sm().show(ui).on_hover_text(self.key_hint("Hide sidebar", "toggle_sidebar")).clicked() {
                let ctx = ui.ctx().clone();
                self.toggle_sidebar(&ctx);
            }
            ui.label(egui::RichText::new("Settings").text_style(crate::theme::ts("heading-16")).color(t.fg()));
        });
        ui.add_space(4.0);
        let id = Id::NULL.with("settings-search");
        let mut q: String = ui.data(|d| d.get_temp(id)).unwrap_or_default();
        ui.allocate_ui_with_layout(Vec2::new(ui.available_width(), 32.0), Layout::left_to_right(Align::Center), |ui| {
            w::search_field(ui, &mut q, "Search settings", None, ui.available_width());
        });
        ui.data_mut(|d| d.insert_temp(id, q.clone()));
        ui.add_space(8.0);
        let q = q.trim().to_lowercase();
        let mut any = false;
        for tb in Tab::ALL {
            if !tb.label().to_lowercase().contains(&q) && !tb.keywords().contains(&q) {
                continue;
            }
            any = true;
            if w::menu_row(ui, tb == tab, tb.icon(), tb.label(), None).clicked() {
                self.open(View::Settings(tb));
            }
        }
        if !any {
            w::subtle(ui, "  Nothing matches.", "label-13");
        }
        ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
            if w::menu_row(ui, false, ic::ARROW_LEFT, "Back", None).clicked() {
                self.leave_settings();
            }
        });
    }

    /// One project row. With `grip`, only the handle on the left drags (the rest
    /// of the row stays a normal click target). Returns the row's response.
    fn project_row(&mut self, ui: &mut Ui, r: &Repo, grip: bool) -> Option<egui::Response> {
        let t = self.theme.t;
        let rect = Rect::from_min_size(ui.cursor().min, Vec2::new(ui.available_width(), 34.0));
        let hovering = ui.rect_contains_pointer(rect);
        let resp = ui.allocate_rect(rect, Sense::click());
        let mut dragging = false;
        if grip {
            let handle = ui.interact(Rect::from_min_size(rect.min, Vec2::new(30.0, rect.height())), Id::NULL.with(("proj-grip", r.id)), Sense::click_and_drag());
            if handle.clicked() {
                self.open_project(r.id);
            }
            if handle.drag_started() {
                egui::DragAndDrop::set_payload(ui.ctx(), r.id);
            }
            dragging = handle.dragged();
            handle.on_hover_cursor(if dragging { egui::CursorIcon::Grabbing } else { egui::CursorIcon::Grab });
        }
        // Selected while its main chat (or a new chat for it) is open.
        let selected = match self.view {
            View::Chat(id) => self.main_thread(r.id) == Some(id),
            View::Draft => self.draft.repo == Some(r.id),
            _ => false,
        };
        let p = ui.painter();
        if selected || hovering {
            p.rect_filled(rect, CornerRadius::same(crate::theme::RADIUS_MD), t.accent());
        }
        let threads = self.threads_of(Some(r.id));
        let snoozed = self.timers.iter().any(|x| threads.iter().any(|c| c.id == x.chat_id));
        let icon_at = pos2(rect.left() + 16.0, rect.center().y);
        let avatar = self.avatar(ui.ctx(), r);
        let p = ui.painter();
        match avatar {
            Some(tex) if !(grip && (hovering || dragging)) => {
                let ir = Rect::from_center_size(icon_at, Vec2::splat(16.0));
                egui::Image::new(&tex).corner_radius(4).paint_at(ui, ir);
            }
            _ if grip && (hovering || dragging) => ic::glyph(p, icon_at, ic::GRIP, 15.0, if selected { t.fg() } else { t.subtle() }),
            _ => {
                // No icon: the project's initial on a tinted rounded square.
                let ir = Rect::from_center_size(icon_at, Vec2::splat(16.0));
                p.rect_filled(ir, CornerRadius::same(4), if selected || hovering { t.gray(400) } else { t.gray(300) });
                let letter = r.name.chars().find(|c| c.is_alphanumeric()).map(|c| c.to_uppercase().to_string()).unwrap_or_default();
                p.text(ir.center(), egui::Align2::CENTER_CENTER, letter, FontId::new(10.5, crate::theme::semibold()), t.fg());
            }
        }
        // Right side: the main thread's status (working, also while its subagents do, waiting
        // on a limit, done / failed), else snoozed, else nothing. Other chats show on their own rows.
        let idle = if snoozed { w::Status::Text(ic::ALARM.to_string(), t.subtle()) } else { w::Status::Text(String::new(), t.gray(800)) };
        let status = match self.main_thread(r.id) {
            Some(id) => self.own_status(id, idle),
            None => idle,
        };
        let rx = if hovering {
            rect.right() - 28.0
        } else {
            w::paint_status(p, pos2(rect.right() - 8.0, rect.center().y), &status);
            rect.right() - 8.0 - w::status_width(ui, &status) - 8.0
        };
        let font = FontId::new(14.0, if selected { crate::theme::medium() } else { egui::FontFamily::Proportional });
        
        let mut rx = rx;
        if hovering {
            let used = self.row_actions(ui, rect, &format!("r{}", r.id), r.settled);
            let nr = Rect::from_min_size(pos2(rect.right() - used - 26.0, rect.top() + 3.0), Vec2::splat(28.0));
            let n = w::overlay(ui, nr, |ui| w::btn(ic::PLUS).muted().icon_sm().show(ui));
            if n.on_hover_text("New chat in this project").clicked() {
                self.new_draft(Some(r.id));
                return None;
            }
            rx = nr.left() - 4.0;
        }
        let label = w::truncated(ui, &r.name, font, t.fg(), (rx - rect.left() - 32.0).max(20.0));
        ui.painter().galley(pos2(rect.left() + 32.0, rect.center().y - label.size().y / 2.0), label, t.fg());
        if resp.clicked() {
            self.open_project(r.id);
        }
        let ctx = ui.ctx().clone();
        let path = r.path.clone();
        let id = r.id;
        let out = resp.clone();
        resp.on_hover_text(crate::app::tilde(&path)).context_menu(|ui| {
            if ui.button(format!("{}  Open terminal", ic::TERMINAL)).clicked() {
                let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                self.open_terminal(&ctx, &name, path.clone(), vec![], vec![]);
            }
            if ui.button(format!("{}  Pull requests", ic::PULL)).clicked() {
                self.open_prs(Some(id));
            }
            if ui.button(format!("{}  Issues", ic::CIRCLE_DOT)).clicked() {
                self.open_issues(Some(id));
            }
            if let Some(Some(url)) = self.git.get(&id).map(|s| s.as_ref().and_then(|s| s.remote.clone())) {
                if ui.button(format!("{}  Open remote", ic::EXTERNAL)).clicked() {
                    git::open_url(&url);
                }
            }
            ui.separator();
            if ui.button("Refresh icon").clicked() {
                self.load_icon(&ctx, id, true);
            }
            if ui.button("Choose icon…").clicked() {
                self.pick_icon(&ctx, id);
            }
            if crate::favicon::custom_path(id).is_file() && ui.button("Use website icon").clicked() {
                crate::favicon::clear_custom(id);
                self.load_icon(&ctx, id, false);
            }
            ui.separator();
            let settled = self.repo(id).is_some_and(|r| r.settled);
            if ui.button(if settled { "Unsettle" } else { "Settle" }).clicked() {
                self.set_project_settled(id, !settled);
            }
            if ui.button("Remove from Harbor").clicked() {
                self.dialog = Some(Dialog::RemoveRepo(id));
            }
        });
        ui.add_space(2.0);
        Some(out)
    }

    pub fn set_project_settled(&mut self, id: i64, settled: bool) {
        if let Some(r) = self.repos.iter_mut().find(|r| r.id == id) {
            r.settled = settled;
            let r = r.clone();
            self.store.save_repo_meta(&r);
        }
    }

    /// Manual order: moves `dragged` to position `to` among `visible`, renumbering.
    fn move_project(&mut self, dragged: i64, to: usize, visible: &[Repo]) {
        let mut order: Vec<i64> = visible.iter().map(|r| r.id).collect();
        let Some(from) = order.iter().position(|x| *x == dragged) else { return };
        order.remove(from);
        let to = if to > from { to - 1 } else { to }.min(order.len());
        order.insert(to, dragged);
        for (i, id) in order.iter().enumerate() {
            if let Some(r) = self.repos.iter_mut().find(|r| r.id == *id) {
                r.sort = i as i64;
                let r = r.clone();
                self.store.save_repo_meta(&r);
            }
        }
        self.repos.sort_by_key(|r| r.sort);
    }

    /// The sidebar's order / view menu.
    pub fn filter_menu(&mut self, ui: &mut Ui) {
        w::subtle(ui, "  Order projects", "label-12");
        if w::menu_item(ui, ic::GRIP, "Manual", Some("Drag projects to reorder"), !self.order_by_activity).clicked() {
            self.order_by_activity = false;
            self.store.set("order_by_activity", "0");
        }
        if w::menu_item(ui, ic::ACTIVITY, "Last activity", Some("Most recent first"), self.order_by_activity).clicked() {
            self.order_by_activity = true;
            self.store.set("order_by_activity", "1");
        }
        w::separator(ui);
        if w::menu_item(ui, ic::ARCHIVE, "Settle projects idle for 7 days", None, false).clicked() {
            let cutoff = crate::store::now() - 7 * 86400;
            let ids: Vec<i64> =
                self.repos.iter().filter(|r| !r.settled && self.activity(r.id) < cutoff && self.running_in(r.id) == 0).map(|r| r.id).collect();
            for id in ids {
                self.set_project_settled(id, true);
            }
            self.popup = None;
        }
    }
}
