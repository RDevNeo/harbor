//! The command palette (Ctrl+K, or the search button in the sidebar's header): one
//! search over everything Harbor can jump to or do. Projects, chats (settled ones too),
//! agents, devices, pages and Settings sections, and actions (a new chat in a project,
//! settle or fork the open chat, fast mode, checking for updates…), fuzzy-ranked with
//! tags.rs's rules and grouped in sections. With nothing typed, what was picked lately
//! comes first.
//!
//! The phone shows the same list as a search screen: `GET /v1/palette` (ranked here,
//! only what the phone can open or do) and `POST /v1/palette/run` (android/PROTOCOL.md).

use crate::app::{App, Tab, View};
use crate::icons as ic;
use crate::store::Role;
use crate::tags::text_score;
use crate::theme::{self, RADIUS_MD};
use crate::widgets as w;
use eframe::egui::{self, Align2, CornerRadius, FontId, Frame, Id, Key, Margin, Modifiers, Rect, ScrollArea, Sense, Stroke, Ui, Vec2, pos2};
use serde_json::{Value, json};

/// Picks remembered for the empty query.
const RECENT_MAX: usize = 20;
const RECENT_KEY: &str = "palette_recent";
const ROW_H: f32 = 34.0;
const HEAD_H: f32 = 26.0;
const WIDTH: f32 = 600.0;

/// Where an item is listed, in this order among equally good matches.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Section {
    Recent,
    Actions,
    Projects,
    Chats,
    Agents,
    Devices,
    Pages,
}

impl Section {
    const ALL: [Section; 7] = [Section::Recent, Section::Actions, Section::Projects, Section::Chats, Section::Agents, Section::Devices, Section::Pages];

    pub fn title(self) -> &'static str {
        match self {
            Section::Recent => "Recent",
            Section::Actions => "Actions",
            Section::Projects => "Projects",
            Section::Chats => "Chats",
            Section::Agents => "Agents",
            Section::Devices => "Devices",
            Section::Pages => "Pages",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Section::Recent => "recent",
            Section::Actions => "actions",
            Section::Projects => "projects",
            Section::Chats => "chats",
            Section::Agents => "agents",
            Section::Devices => "devices",
            Section::Pages => "pages",
        }
    }

    /// Rows a section shows at most, with nothing typed and with a query.
    fn cap(self, empty: bool) -> usize {
        match (self, empty) {
            (Section::Recent, _) => 6,
            (Section::Pages, true) => 12,
            (_, true) => 5,
            (_, false) => 8,
        }
    }
}

/// What picking an item does.
#[derive(Clone, PartialEq)]
pub enum Act {
    /// Opens a project: its latest chat, else a new one there.
    Project(i64),
    Chat(i64),
    NewChat(Option<i64>),
    Prs,
    Issues,
    Settings(Tab),
    Settle(i64, bool),
    Fork(i64),
    Fast(bool),
    CheckUpdates,
    ToggleSidebar,
    ToggleTerminal,
    ToggleBrowser,
}

impl Act {
    /// How the phone does it: opens a screen (`chat`, `new_chat`, `page`), or asks the PC
    /// (`action`). None: not on the phone.
    fn wire(&self) -> Option<Value> {
        Some(match self {
            Act::Chat(id) => json!({ "kind": "chat", "chat": id }),
            Act::Project(id) => json!({ "kind": "new_chat", "project": id }),
            Act::NewChat(p) => json!({ "kind": "new_chat", "project": p }),
            Act::Prs => json!({ "kind": "page", "page": "prs" }),
            Act::Issues => json!({ "kind": "page", "page": "issues" }),
            Act::Settle(..) | Act::Fork(_) | Act::Fast(_) => json!({ "kind": "action" }),
            _ => return None,
        })
    }
}

#[derive(Clone)]
pub struct Item {
    /// Stable across lists ("chat:12"): what the recent picks remember.
    pub id: String,
    pub section: Section,
    pub icon: &'static str,
    /// The phone's name for the icon.
    pub glyph: &'static str,
    pub title: String,
    pub detail: String,
    /// More words it is found by.
    pub keywords: String,
    pub act: Act,
    /// When it was last active (chats), for the empty query.
    pub at: i64,
}

impl Item {
    fn new(id: String, section: Section, icon: &'static str, glyph: &'static str, title: impl Into<String>, detail: impl Into<String>, act: Act) -> Self {
        Item { id, section, icon, glyph, title: title.into(), detail: detail.into(), keywords: String::new(), act, at: 0 }
    }

    fn kw(mut self, k: &str) -> Self {
        self.keywords = k.to_string();
        self
    }

    /// As the phone gets it; None for what it can't open or do.
    fn json(&self) -> Option<Value> {
        let mut v = self.act.wire()?;
        v["id"] = json!(self.id);
        v["title"] = json!(self.title);
        v["detail"] = json!(self.detail);
        v["icon"] = json!(self.glyph);
        Some(v)
    }
}

/// How well `query` matches an item (lower is better): every word must be in its title, its
/// detail or its keywords (the title counts most).
pub fn score(it: &Item, query: &str) -> Option<u32> {
    let mut total = 0;
    for word in query.split_whitespace() {
        let best = [text_score(&it.title, word), text_score(&it.detail, word).map(|s| s + 40), keyword_score(&it.keywords, word).map(|s| s + 60)].into_iter().flatten().min()?;
        total += best;
    }
    Some(total)
}

fn keyword_score(keywords: &str, word: &str) -> Option<u32> {
    keywords.split_whitespace().filter_map(|k| text_score(k, word)).min()
}

/// The items for `query` in sections, best first. With nothing typed: the recent picks
/// (`recent`, newest first) in their own section, then each section's first rows (chats by
/// their last activity). With a query: each section by score, sections by their best row.
pub fn rank<'a>(items: &'a [Item], query: &str, recent: &[String]) -> Vec<(Section, Vec<&'a Item>)> {
    let query = query.trim();
    let mut out: Vec<(Section, Vec<&Item>)> = vec![];
    if query.is_empty() {
        let recents: Vec<&Item> = recent.iter().filter_map(|id| items.iter().find(|i| &i.id == id)).take(Section::Recent.cap(true)).collect();
        for s in Section::ALL {
            let mut v: Vec<&Item> = if s == Section::Recent { recents.clone() } else { items.iter().filter(|i| i.section == s && !recents.iter().any(|r| r.id == i.id)).collect() };
            if matches!(s, Section::Chats | Section::Agents) {
                v.sort_by(|a, b| b.at.cmp(&a.at));
            }
            v.truncate(s.cap(true));
            if !v.is_empty() {
                out.push((s, v));
            }
        }
        return out;
    }
    let mut scored: Vec<(Section, u32, Vec<(u32, &Item)>)> = vec![];
    for s in Section::ALL.into_iter().filter(|s| *s != Section::Recent) {
        let mut v: Vec<(u32, &Item)> = items.iter().filter(|i| i.section == s).filter_map(|i| Some((score(i, query)?, i))).collect();
        if v.is_empty() {
            continue;
        }
        // Equal matches: the recently picked first, then the recently active.
        let rank_of = |i: &Item| recent.iter().position(|r| *r == i.id).unwrap_or(usize::MAX);
        v.sort_by(|a, b| a.0.cmp(&b.0).then(rank_of(a.1).cmp(&rank_of(b.1))).then(b.1.at.cmp(&a.1.at)).then(a.1.title.len().cmp(&b.1.title.len())));
        v.truncate(s.cap(false));
        scored.push((s, v[0].0, v));
    }
    scored.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    scored.into_iter().map(|(s, _, v)| (s, v.into_iter().map(|x| x.1).collect())).collect()
}

/// The ranked sections as one list, for the keyboard.
fn flat<'a>(sections: &[(Section, Vec<&'a Item>)]) -> Vec<&'a Item> {
    sections.iter().flat_map(|s| s.1.iter().copied()).collect()
}

/// A recent-picks list with `id` put first.
fn remember(mut recent: Vec<String>, id: &str) -> Vec<String> {
    recent.retain(|r| r != id);
    recent.insert(0, id.to_string());
    recent.truncate(RECENT_MAX);
    recent
}

// ---------------------------------------------------------------- state and items

#[derive(Default)]
pub struct State {
    pub open: bool,
    query: String,
    sel: usize,
    scroll: bool,
    focus: bool,
}

impl App {
    fn palette_recent(&self) -> Vec<String> {
        serde_json::from_str(&self.store.get(RECENT_KEY).unwrap_or_default()).unwrap_or_default()
    }

    fn palette_remember(&mut self, id: &str) {
        let list = remember(self.palette_recent(), id);
        self.store.set(RECENT_KEY, &serde_json::to_string(&list).unwrap_or_default());
    }

    /// Everything the palette offers, with `current` the open chat (for its actions).
    pub fn palette_items(&self, current: Option<i64>) -> Vec<Item> {
        let mut v = vec![];
        let project_name = |r: Option<i64>| r.and_then(|r| self.repo(r)).map(|r| r.name.clone()).unwrap_or_else(|| "No project".into());
        // Actions: the open chat's first.
        if let Some(c) = current.and_then(|id| self.chat(id)) {
            let title = if c.title.is_empty() { "this chat".to_string() } else { c.title.clone() };
            if c.settled {
                v.push(Item::new(format!("act:unsettle:{}", c.id), Section::Actions, ic::UNARCHIVE, "unarchive", "Unsettle this chat", title.clone(), Act::Settle(c.id, false)).kw("unarchive reopen"));
            } else {
                v.push(Item::new(format!("act:settle:{}", c.id), Section::Actions, ic::ARCHIVE, "archive", "Settle this chat", title.clone(), Act::Settle(c.id, true)).kw("done archive finish"));
            }
            if self.last_forkable(c.id).is_some() {
                v.push(Item::new(format!("act:fork:{}", c.id), Section::Actions, ic::FORK, "fork", "Fork this chat", title, Act::Fork(c.id)).kw("branch copy"));
            }
        }
        let repo = current.and_then(|id| self.chat(id)).and_then(|c| c.repo_id).or(self.draft.repo);
        v.push(Item::new("act:new".into(), Section::Actions, ic::COMPOSE, "compose", "New chat", project_name(repo), Act::NewChat(repo)).kw("thread start create"));
        let fast = if self.fast { ("act:fast:off", "Turn fast mode off", false) } else { ("act:fast:on", "Turn fast mode on", true) };
        v.push(Item::new(fast.0.into(), Section::Actions, ic::GAUGE, "gauge", fast.1, "Fast mode for every chat on this PC", Act::Fast(fast.2)).kw("speed toggle setting"));
        v.push(Item::new("act:updates".into(), Section::Actions, ic::REFRESH, "refresh", "Check for updates", "Harbor's latest release", Act::CheckUpdates).kw("upgrade version release"));
        v.push(Item::new("act:sidebar".into(), Section::Actions, ic::PANEL_LEFT, "panel", "Show or hide the sidebar", "", Act::ToggleSidebar).kw("toggle"));
        v.push(Item::new("act:terminal".into(), Section::Actions, ic::TERMINAL, "terminal", "Open or close the terminal", "", Act::ToggleTerminal).kw("toggle shell console"));
        v.push(Item::new("act:browser".into(), Section::Actions, ic::GLOBE, "globe", "Open or close the browser", "", Act::ToggleBrowser).kw("toggle web"));
        for r in &self.repos {
            v.push(Item::new(format!("new:{}", r.id), Section::Actions, ic::COMPOSE, "compose", format!("New chat in {}", r.name), crate::app::tilde(&r.path), Act::NewChat(Some(r.id))).kw("thread start create"));
        }
        for r in &self.repos {
            v.push(Item::new(format!("project:{}", r.id), Section::Projects, ic::FOLDER, "folder", r.name.clone(), crate::app::tilde(&r.path), Act::Project(r.id)).kw("project folder repo"));
        }
        for c in &self.chats {
            let title = if c.title.is_empty() { "New chat".to_string() } else { c.title.clone() };
            let mut it = if c.role == Role::Sub {
                let lead = c.parent.and_then(|p| self.chat(p)).map(|p| p.title.clone()).unwrap_or_default();
                let name = if c.name.is_empty() { title.clone() } else { c.name.clone() };
                let detail = if lead.is_empty() { project_name(c.repo_id) } else { format!("{} · {lead}", project_name(c.repo_id)) };
                Item::new(format!("chat:{}", c.id), Section::Agents, ic::BOT, "bot", name, detail, Act::Chat(c.id)).kw(&title)
            } else {
                let detail = if c.settled { format!("{} · settled", project_name(c.repo_id)) } else { project_name(c.repo_id) };
                Item::new(format!("chat:{}", c.id), Section::Chats, ic::MESSAGE, "message", title, detail, Act::Chat(c.id))
            };
            it.at = c.updated;
            v.push(it);
        }
        for d in &self.remote.devices {
            v.push(Item::new(format!("device:{}", d.id), Section::Devices, ic::MONITOR, "monitor", d.name.clone(), "Settings › Devices", Act::Settings(Tab::Devices)).kw("device pc host"));
        }
        v.push(Item::new("page:prs".into(), Section::Pages, ic::PR_OPEN, "pr", "Pull requests", "GitHub", Act::Prs).kw("prs review"));
        v.push(Item::new("page:issues".into(), Section::Pages, ic::CIRCLE_DOT, "issue", "Issues", "GitHub", Act::Issues).kw("bugs"));
        for t in Tab::ALL {
            v.push(Item::new(format!("settings:{}", t.slug()), Section::Pages, t.icon(), "settings", t.label().to_string(), "Settings", Act::Settings(t)).kw(&format!("settings preferences {}", t.keywords())));
        }
        v
    }

    /// Does what an item says. Returns the chat to open on the phone (a fork), if any.
    fn palette_run(&mut self, act: &Act, ctx: &egui::Context, here: bool) -> Option<i64> {
        match *act {
            Act::Project(r) => {
                let latest = self.chats.iter().filter(|c| c.repo_id == Some(r) && c.role != Role::Sub && !c.settled).max_by_key(|c| c.updated).map(|c| c.id);
                match latest {
                    Some(id) => self.open(View::Chat(id)),
                    None => self.new_draft(Some(r)),
                }
            }
            Act::Chat(id) => self.open(View::Chat(id)),
            Act::NewChat(r) => {
                self.new_draft(r);
                self.focus_composer = true;
            }
            Act::Prs => self.open_prs(None),
            Act::Issues => self.open_issues(None),
            Act::Settings(t) => self.open(View::Settings(t)),
            Act::Settle(id, on) => self.set_chat_settled(id, on),
            Act::Fork(id) => {
                let seq = self.last_forkable(id)?;
                let before = self.chats.iter().map(|c| c.id).max().unwrap_or(0);
                let (view, focus) = (self.view, self.focus_composer);
                self.fork_from(id, seq);
                if !here {
                    // From the phone: the desktop stays where it was.
                    self.view = view;
                    self.focus_composer = focus;
                }
                return self.chats.iter().map(|c| c.id).max().filter(|m| *m > before);
            }
            Act::Fast(on) => {
                self.fast = on;
                self.store.set("fast_mode", if on { "1" } else { "0" });
            }
            Act::CheckUpdates => {
                crate::update::check(false, ctx);
            }
            Act::ToggleSidebar => self.toggle_sidebar(ctx),
            Act::ToggleTerminal => self.toggle_terminal(ctx),
            Act::ToggleBrowser => self.toggle_browser(),
        }
        None
    }

    fn palette_current(&self) -> Option<i64> {
        match self.view {
            View::Chat(id) => Some(id),
            _ => None,
        }
    }

    /// `GET /v1/palette?q=…&chat=…`: the palette's sections for the phone, with `chat` the one
    /// it has open (for its actions); only what the phone can open or do.
    pub fn api_palette(&self, query: &str, chat: Option<i64>) -> Value {
        let items = self.palette_items(chat);
        let recent = self.palette_recent();
        let sections: Vec<Value> = rank(&items, query, &recent)
            .into_iter()
            .filter_map(|(s, v)| {
                let rows: Vec<Value> = v.iter().filter_map(|i| i.json()).collect();
                (!rows.is_empty()).then(|| json!({ "key": s.key(), "title": s.title(), "items": rows }))
            })
            .collect();
        json!({ "sections": sections })
    }

    /// `POST /v1/palette/run {"id", "chat"}`: remembers the pick, and does it when it's an
    /// action (`kind: "action"`); opening screens is the phone's.
    pub fn api_palette_run(&mut self, body: &Value, chat: Option<i64>, ctx: &egui::Context) -> crate::api::Reply {
        let Some(id) = body["id"].as_str() else { return crate::api::err(400, "id is required") };
        let Some(it) = self.palette_items(chat).into_iter().find(|i| i.id == id) else { return crate::api::err(404, "no such item (any more)") };
        if it.act.wire().is_none() {
            return crate::api::err(400, "not on the phone");
        }
        self.palette_remember(id);
        let open = match it.act {
            Act::Settle(..) | Act::Fork(_) | Act::Fast(_) => self.palette_run(&it.act, ctx, false),
            _ => None,
        };
        if matches!(it.act, Act::Fork(_)) && open.is_none() {
            return crate::api::err(409, "this chat has no finished reply to fork after");
        }
        let said = match it.act {
            Act::Settle(_, true) => "Settled",
            Act::Settle(_, false) => "Back from settled",
            Act::Fast(true) => "Fast mode on",
            Act::Fast(false) => "Fast mode off",
            _ => "",
        };
        let gid = open.and_then(|o| self.chat(o)).map(|c| c.gid.clone());
        crate::api::ok(json!({ "ok": true, "open": open, "gid": gid, "toast": said }))
    }

    /// Ctrl+K (rebindable) or the sidebar's search button: opens the palette, or closes it.
    pub fn palette_toggle(&mut self) {
        self.palette.open = !self.palette.open;
        if self.palette.open {
            self.palette.query.clear();
            self.palette.sel = 0;
            self.palette.focus = true;
            self.popup = None;
        }
    }

    /// The palette, centered over everything while it's open.
    pub fn palette_ui(&mut self, ctx: &egui::Context) {
        if !self.palette.open {
            return;
        }
        let items = self.palette_items(self.palette_current());
        let recent = self.palette_recent();
        let none = Modifiers::NONE;
        let (up, down, enter) = ctx.input_mut(|i| (i.consume_key(none, Key::ArrowUp), i.consume_key(none, Key::ArrowDown), i.consume_key(none, Key::Enter)));
        let query = self.palette.query.clone();
        let sections = rank(&items, &query, &recent);
        let list = flat(&sections);
        let n = list.len();
        if n > 0 && (up || down) {
            self.palette.sel = if down { (self.palette.sel + 1) % n } else { (self.palette.sel + n - 1) % n };
            self.palette.scroll = true;
        }
        self.palette.sel = self.palette.sel.min(n.saturating_sub(1));
        let t = self.theme.t;
        let (sel, scroll) = (self.palette.sel, std::mem::take(&mut self.palette.scroll));
        let (moved, clicked) = ctx.input(|i| (i.pointer.delta() != Vec2::ZERO, i.pointer.primary_clicked()));
        let mut hover = None;
        let mut pick: Option<Item> = if enter { list.get(sel).map(|i| (*i).clone()) } else { None };
        let mut query = self.palette.query.clone();
        let focus = std::mem::take(&mut self.palette.focus);
        let max_h = (ctx.content_rect().height() * 0.6).clamp(160.0, 460.0);
        // Pinned near the top: the box stays put while the list under it grows and shrinks.
        let top = (ctx.content_rect().height() * 0.12).clamp(24.0, 120.0);
        let modal = egui::Modal::new(Id::NULL.with("palette"))
            .area(egui::Modal::default_area(Id::NULL.with("palette")).anchor(Align2::CENTER_TOP, Vec2::new(0.0, top)))
            .frame(
                Frame::new()
                    .fill(t.bg100)
                    .stroke(Stroke::new(1.0, t.border()))
                    .corner_radius(CornerRadius::same(theme::RADIUS_XL))
                    .inner_margin(Margin::same(8))
                    .shadow(ctx.global_style().visuals.window_shadow),
            )
            .show(ctx, |ui| {
                ui.set_width(WIDTH.min(ctx.content_rect().width() - 48.0));
                ui.spacing_mut().item_spacing.y = 0.0;
                let fid = Id::NULL.with("palette-search");
                let r = w::search_field(ui, &mut query, "Search projects, chats, agents, pages and actions", Some(fid), ui.available_width());
                if focus || !r.has_focus() {
                    r.request_focus();
                }
                ui.add_space(6.0);
                w::separator(ui);
                ui.add_space(4.0);
                if list.is_empty() {
                    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW_H * 2.0), Sense::hover());
                    ui.painter().text(rect.center(), Align2::CENTER_CENTER, "Nothing matches", FontId::proportional(13.0), t.subtle());
                    return;
                }
                ScrollArea::vertical().max_height(max_h).auto_shrink([false, true]).show(ui, |ui| {
                    let mut k = 0;
                    for (s, rows) in &sections {
                        let (head, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), HEAD_H), Sense::hover());
                        ui.painter().text(pos2(head.left() + 10.0, head.bottom() - 7.0), Align2::LEFT_BOTTOM, s.title(), FontId::new(11.5, theme::medium()), t.subtle());
                        for it in rows {
                            let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW_H), Sense::click());
                            if ui.rect_contains_pointer(rect) {
                                if moved {
                                    hover = Some(k);
                                }
                                if clicked {
                                    pick = Some((*it).clone());
                                }
                            }
                            if k == sel && scroll {
                                ui.scroll_to_rect(rect, None);
                            }
                            row(ui, rect, it, k == sel);
                            k += 1;
                        }
                    }
                });
                ui.add_space(4.0);
                w::separator(ui);
                let (foot, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 26.0), Sense::hover());
                ui.painter().text(pos2(foot.left() + 10.0, foot.center().y + 2.0), Align2::LEFT_CENTER, "↑↓ to move  ·  Enter to open  ·  Esc to close", FontId::proportional(11.5), t.subtle());
            });
        if query != self.palette.query {
            self.palette.query = query;
            self.palette.sel = 0;
        }
        if let Some(i) = hover {
            self.palette.sel = i;
        }
        if modal.should_close() {
            self.palette.open = false;
        }
        if let Some(it) = pick {
            self.palette.open = false;
            self.palette_remember(&it.id);
            self.palette_run(&it.act, ctx, true);
        }
    }
}

/// One row: its icon, title, and dimmed detail.
fn row(ui: &Ui, rect: Rect, it: &Item, selected: bool) {
    let t = w::tokens(ui);
    let p = ui.painter();
    if selected {
        p.rect_filled(rect, CornerRadius::same(RADIUS_MD), t.accent());
    }
    ic::glyph(p, pos2(rect.left() + 18.0, rect.center().y), it.icon, 15.0, if selected { t.fg() } else { t.subtle() });
    let x = rect.left() + 34.0;
    let room = rect.right() - 10.0 - x;
    let title = w::truncated(ui, &it.title, FontId::new(13.5, theme::medium()), t.fg(), (room * 0.65).max(60.0));
    let dx = x + title.size().x + 10.0;
    p.galley(pos2(x, rect.center().y - title.size().y / 2.0), title, t.fg());
    let left = rect.right() - 10.0 - dx;
    if left > 30.0 && !it.detail.is_empty() {
        let d = w::truncated(ui, &it.detail, FontId::proportional(12.5), t.subtle(), left);
        p.galley(pos2(dx, rect.center().y - d.size().y / 2.0), d, t.subtle());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, s: Section, title: &str, detail: &str, at: i64) -> Item {
        let mut i = Item::new(id.into(), s, ic::FILE, "file", title, detail, Act::Prs);
        i.at = at;
        i
    }

    fn sample() -> Vec<Item> {
        vec![
            item("act:new", Section::Actions, "New chat", "harbor", 0).kw("thread start"),
            item("new:1", Section::Actions, "New chat in harbor", "~/Projects/harbor", 0),
            item("project:1", Section::Projects, "harbor", "~/Projects/harbor", 0),
            item("project:2", Section::Projects, "site", "~/Projects/site", 0),
            item("chat:1", Section::Chats, "Fix the composer", "harbor", 10),
            item("chat:2", Section::Chats, "Palette design", "harbor · settled", 30),
            item("chat:3", Section::Agents, "tests-runner", "harbor · Fix the composer", 20),
            item("settings:general", Section::Pages, "General", "Settings", 0).kw("settings fast mode"),
        ]
    }

    fn ids(v: &[(Section, Vec<&Item>)]) -> Vec<(Section, Vec<String>)> {
        v.iter().map(|(s, r)| (*s, r.iter().map(|i| i.id.clone()).collect())).collect()
    }

    #[test]
    fn empty_query_shows_recent_first() {
        let items = sample();
        let v = ids(&rank(&items, "", &["chat:1".into(), "gone:9".into(), "project:2".into()]));
        assert_eq!(v[0], (Section::Recent, vec!["chat:1".to_string(), "project:2".to_string()]));
        // Picked ones aren't listed twice; chats by their last activity.
        assert_eq!(v.iter().find(|s| s.0 == Section::Projects).unwrap().1, ["project:1"]);
        assert_eq!(v.iter().find(|s| s.0 == Section::Chats).unwrap().1, ["chat:2"]);
        assert_eq!(v.iter().map(|s| s.0).collect::<Vec<_>>(), [Section::Recent, Section::Actions, Section::Projects, Section::Chats, Section::Agents, Section::Pages]);
    }

    #[test]
    fn query_ranks_and_groups() {
        let items = sample();
        // The best match's section first.
        let v = ids(&rank(&items, "harbor", &[]));
        assert_eq!(v[0], (Section::Projects, vec!["project:1".to_string()]));
        // Every word must match; the title counts before the detail.
        let v = ids(&rank(&items, "new harbor", &[]));
        assert_eq!(v, [(Section::Actions, vec!["new:1".to_string(), "act:new".to_string()])]);
        let v = ids(&rank(&items, "composer", &[]));
        assert_eq!(v, [(Section::Chats, vec!["chat:1".to_string()]), (Section::Agents, vec!["chat:3".to_string()])]);
        // Keywords, letters in order, and nothing.
        assert_eq!(ids(&rank(&items, "fast", &[]))[0].1, ["settings:general"]);
        assert_eq!(ids(&rank(&items, "pltt", &[]))[0].1, ["chat:2"]);
        assert!(rank(&items, "zzzz", &[]).is_empty());
    }

    #[test]
    fn ties_go_to_recent_picks() {
        let items = vec![item("chat:1", Section::Chats, "Deploy", "a", 5), item("chat:2", Section::Chats, "Deploy", "b", 1)];
        assert_eq!(ids(&rank(&items, "deploy", &[]))[0].1, ["chat:1", "chat:2"]);
        assert_eq!(ids(&rank(&items, "deploy", &["chat:2".into()]))[0].1, ["chat:2", "chat:1"]);
    }

    #[test]
    fn remembers_picks() {
        let r = remember(vec!["a".into(), "b".into()], "b");
        assert_eq!(r, ["b", "a"]);
        let many: Vec<String> = (0..30).map(|i| i.to_string()).collect();
        assert_eq!(remember(many, "x").len(), RECENT_MAX);
    }

    #[test]
    fn phone_rows() {
        let i = Item::new("chat:4".into(), Section::Chats, ic::MESSAGE, "message", "T", "d", Act::Chat(4));
        let v = i.json().unwrap();
        assert_eq!((v["kind"].as_str(), v["chat"].as_i64(), v["icon"].as_str()), (Some("chat"), Some(4), Some("message")));
        assert!(Item::new("act:sidebar".into(), Section::Actions, ic::PANEL_LEFT, "panel", "S", "", Act::ToggleSidebar).json().is_none());
        assert_eq!(Item::new("new:".into(), Section::Actions, ic::COMPOSE, "compose", "N", "", Act::NewChat(None)).json().unwrap()["project"], Value::Null);
    }
}
