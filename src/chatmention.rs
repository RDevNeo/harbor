//! Chat mentions (#96): typing `$` at the start of a word in the composer opens a menu of
//! chats, fuzzy-matched as you type (this project's first, then the others, other PCs' too;
//! settled ones below the active ones; never the chat itself). Picking one writes the chat's
//! title in place of the `$word`, highlighted, and adds the chat to the message's mentions
//! (mentions.rs); taking the title out of the text drops it. On send the agent gets a quoted
//! block per mentioned chat: title, project, PC, status, recap, its last turns (user prompts
//! and final answers) within [`MAX_CHARS`], and its id for `message_chat`. The transcript
//! shows the title as a link in the text (usertext.rs); a click opens the chat.
//!
//! Another PC's chat is the mesh's copy here (mesh.rs keeps a full copy of every chat), so
//! its context is read from that copy when the message is sent. The phone asks the same rows,
//! ranked here, with `GET /v1/chats/{id}/tags?trigger=$` (android/PROTOCOL.md).

use crate::app::App;
use crate::icons as ic;
use crate::mentions::Mention;
use crate::store::{Item, Role};
use crate::theme::{self, RADIUS_MD};
use crate::widgets as w;
use crate::widgets::Tip as _;
use eframe::egui::{self, Align2, CornerRadius, FontId, Id, Key, Modifiers, Rect, ScrollArea, Sense, Ui, Vec2, pos2};
use serde_json::{Value, json};

/// Most of a mentioned chat sent to the agent, in characters (about 8 KB).
pub const MAX_CHARS: usize = 8000;
/// Its last turns sent: user prompts and final answers.
pub const TURNS: usize = 6;
const ROW_H: f32 = 32.0;
const MENU_MAX_H: f32 = 288.0;

// ---------------------------------------------------------------- the word

/// The `$word` being typed: where it is (in chars) and what follows the `$` up to the cursor.
#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    pub start: usize,
    pub end: usize,
    pub query: String,
}

/// The `$word` at char `cursor` of `text`, if the cursor is in one: `$` at the start of a
/// word (after a space or an opening bracket). `$$` and `$5` (money) are not.
pub fn word(text: &str, cursor: usize) -> Option<Word> {
    let chars: Vec<char> = text.chars().collect();
    let cursor = cursor.min(chars.len());
    let mut start = (0..cursor).rev().find(|&i| chars[i].is_whitespace()).map_or(0, |i| i + 1);
    while start < cursor && "([{\"'`".contains(chars[start]) {
        start += 1;
    }
    if chars.get(start) != Some(&'$') || start == cursor {
        return None;
    }
    let query: String = chars[start + 1..cursor].iter().collect();
    if query.starts_with(|c: char| c == '$' || c.is_ascii_digit()) {
        return None;
    }
    let end = (cursor..chars.len()).find(|&i| chars[i].is_whitespace()).unwrap_or(chars.len());
    Some(Word { start, end, query })
}

// ---------------------------------------------------------------- the list

/// A chat the menu can offer.
#[derive(Clone, Debug, Default)]
pub struct Cand {
    pub gid: String,
    pub title: String,
    pub project: String,
    /// The PC it runs on.
    pub pc: String,
    /// "working", "idle" or "settled".
    pub status: String,
    pub updated: i64,
    /// In the composer's project.
    pub here: bool,
    pub settled: bool,
}

impl Cand {
    /// "harbor · desk · working": where it is and how it is, under its title.
    pub fn line(&self) -> String {
        let mut v = vec![];
        if !self.project.is_empty() {
            v.push(self.project.clone());
        }
        if !self.pc.is_empty() {
            v.push(self.pc.clone());
        }
        v.push(self.status.clone());
        v.join(" · ")
    }

    fn json(&self) -> Value {
        json!({
            "kind": "chat", "insert": "", "chat": self.gid, "title": self.title, "project": self.project,
            "pc": self.pc, "status": self.status, "updated": self.updated, "line": self.line(),
            // What the composer writes for it (0.94): the mention's title, a link once sent.
            "label": crate::usertext::label(&self.title),
        })
    }

    /// What it becomes in the composer: a mention, its context filled when sent.
    pub fn mention(&self) -> Mention {
        Mention { item: 0, from: self.line(), at: 0, text: String::new(), len: 0, excerpt: false, note: String::new(), kind: "chat".into(), chat: self.gid.clone(), title: self.title.clone() }
    }
}

/// How well `q` matches a chat (lower is better): its title, then its project, PC, status.
fn score(c: &Cand, q: &str) -> Option<u32> {
    use crate::tags::text_score;
    [text_score(&c.title, q), text_score(&c.project, q).map(|s| s + 5), text_score(&c.pc, q).map(|s| s + 8), text_score(&c.status, q).map(|s| s + 40)].into_iter().flatten().min()
}

/// The chats for `query`, best first: by match, then this project's first, active before
/// settled, the latest first.
pub fn rank<'a>(cands: &'a [Cand], query: &str, limit: usize) -> Vec<&'a Cand> {
    let mut v: Vec<(u32, &Cand)> = cands.iter().filter_map(|c| Some((score(c, query)?, c))).collect();
    // Close matches count as one: the order inside them is the list's.
    v.sort_by(|a, b| (a.0 / 10, !a.1.here, a.1.settled, -a.1.updated).cmp(&(b.0 / 10, !b.1.here, b.1.settled, -b.1.updated)));
    v.into_iter().take(limit).map(|x| x.1).collect()
}

// ---------------------------------------------------------------- what the agent gets

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max).collect::<String>()) }
}

/// The chat's last `TURNS` turns: each user prompt and the final answer that followed it.
pub fn last_turns(items: &[Item]) -> Vec<(String, String)> {
    let mut turns: Vec<(String, String)> = vec![];
    for it in items {
        match it {
            Item::User { text, .. } => turns.push((text.trim().to_string(), String::new())),
            // The last text of the turn is its final answer.
            Item::Text { text, .. } if !text.trim().is_empty() => match turns.last_mut() {
                Some(t) => t.1 = text.trim().to_string(),
                None => turns.push((String::new(), text.trim().to_string())),
            },
            _ => {}
        }
    }
    let skip = turns.len().saturating_sub(TURNS);
    turns.into_iter().skip(skip).collect()
}

/// The context block of a chat (without quote marks), within [`MAX_CHARS`]: its facts and
/// recap first, then as many of its last turns as fit (the newest kept; long ones cut).
pub fn context(c: &Cand, recap: Option<&str>, items: &[Item]) -> String {
    let mut head = format!("Title: {}\n", c.title);
    if !c.project.is_empty() {
        head.push_str(&format!("Project: {}\n", c.project));
    }
    if !c.pc.is_empty() {
        head.push_str(&format!("PC: {}\n", c.pc));
    }
    head.push_str(&format!("Status: {}\n", c.status));
    if let Some(r) = recap.map(str::trim).filter(|r| !r.is_empty()) {
        head.push_str(&format!("Recap: {}\n", clip(r, 1200)));
    }
    let turns = last_turns(items);
    if turns.is_empty() {
        head.push_str("(no messages yet)");
        return head;
    }
    let room = MAX_CHARS.saturating_sub(head.chars().count() + 80);
    // Each turn gets an equal share at first; what short ones leave goes to the newest.
    let share = room / turns.len().max(1);
    let mut parts: Vec<String> = vec![];
    let mut used = 0;
    for (i, (user, answer)) in turns.iter().enumerate().rev() {
        let left = room.saturating_sub(used);
        if left < 200 {
            break;
        }
        let cap = if i == turns.len() - 1 { left.saturating_sub(share * i).max(share) } else { share.min(left) };
        let u = clip(user, (cap / 3).max(120));
        let a = clip(answer, cap.saturating_sub(u.chars().count()).max(120));
        let mut t = String::new();
        if !u.is_empty() {
            t.push_str(&format!("User: {u}\n"));
        }
        if !a.is_empty() {
            t.push_str(&format!("Agent: {a}\n"));
        }
        used += t.chars().count();
        parts.push(t);
    }
    parts.reverse();
    let shown = parts.len();
    let mut out = head;
    out.push_str(&format!("Last {} turn{}:\n", shown, if shown == 1 { "" } else { "s" }));
    for p in parts {
        out.push_str(&p);
    }
    let out: String = out.chars().take(MAX_CHARS).collect();
    out.trim_end().to_string()
}

/// A mentioned chat as the agent reads it, before the user's text.
pub fn quote(m: &Mention) -> String {
    let mut out = format!("> [mentioned chat \u{201c}{}\u{201d}, chat id {} (message_chat takes it; link it as {})]\n", m.title, m.chat, crate::chatlink::link(&m.chat, ""));
    let body = if m.text.trim().is_empty() { "(its context couldn't be read)" } else { m.text.as_str() };
    for l in body.lines() {
        out.push_str("> ");
        out.push_str(l);
        out.push('\n');
    }
    let note = m.note.trim();
    if !note.is_empty() {
        out.push_str(note);
        out.push('\n');
    }
    out.push('\n');
    out
}

// ---------------------------------------------------------------- the app

#[derive(Default)]
pub struct State {
    /// The composer whose menu showed last frame.
    pub open: Option<i64>,
    sel: usize,
    query: String,
    scroll: bool,
    /// Esc closed the menu for the word starting here (composer, char).
    dismissed: Option<(i64, usize)>,
}

impl App {
    /// A chat as the menu and the context see it (`repo`: the composer's project).
    fn chat_cand(&self, c: &crate::store::Chat, repo: Option<i64>) -> Cand {
        let status = if self.is_running(c.id) {
            "working"
        } else if c.settled {
            "settled"
        } else {
            "idle"
        };
        Cand {
            gid: c.gid.clone(),
            title: if c.title.trim().is_empty() { "Untitled chat".into() } else { c.title.clone() },
            project: c.repo_id.and_then(|r| self.repo(r)).map(|r| r.name.clone()).unwrap_or_default(),
            pc: self.home_name(c),
            status: status.into(),
            updated: c.updated,
            here: repo.is_some() && c.repo_id == repo,
            settled: c.settled,
        }
    }

    /// Every chat the composer `key` can mention: the user's chats (not subagents), not itself.
    pub fn chat_cands(&self, key: i64, repo: Option<i64>) -> Vec<Cand> {
        self.chats.iter().filter(|c| c.id != key && c.role != Role::Sub && !c.gid.is_empty()).map(|c| self.chat_cand(c, repo)).collect()
    }

    /// `GET /v1/chats/{id}/tags?trigger=$` (and `/v1/tags` for a new chat): the menu's rows.
    pub fn api_chat_rows(&self, key: i64, repo: Option<i64>, query: &str) -> Value {
        let cands = self.chat_cands(key, repo);
        json!({ "items": rank(&cands, query, crate::tags::MAX_ROWS).iter().map(|c| c.json()).collect::<Vec<_>>(), "pending": false })
    }

    /// Before a message goes out: each mentioned chat gets its context (from this PC's copy).
    /// One already filled (forwarded from another PC) stays as it is.
    pub fn fill_chat_mentions(&mut self, mentions: &mut [Mention]) {
        for m in mentions.iter_mut().filter(|m| m.is_chat() && m.text.trim().is_empty()) {
            let Some(id) = self.shared().by_gid(&m.chat).or_else(|| self.chats.iter().find(|c| c.gid == m.chat).map(|c| c.id)) else {
                m.text = "(this chat isn't on this PC)".into();
                continue;
            };
            let Some(chat) = self.chat(id).cloned() else { continue };
            let c = self.chat_cand(&chat, None);
            let items = match self.transcripts.get(&id) {
                Some(t) if !t.items.is_empty() => t.items.clone(),
                _ => self.store.items(id),
            };
            let recap = match self.mesh.status.get(&id) {
                Some(r) => r.status["recap"].as_str().map(str::to_string),
                None => self.recap_load(id).0,
            };
            m.text = context(&c, recap.as_deref(), &items);
            m.len = m.text.chars().count();
            if m.title.is_empty() {
                m.title = c.title.clone();
            }
            m.from = c.line();
        }
    }

    /// A mention chip clicked: a message is pointed at in its chat; a chat opens through its
    /// chat link (chatlink.rs, #84), which says why when it can't.
    pub fn open_mention(&mut self, ctx: &egui::Context, chat_id: i64, m: &Mention) {
        if m.is_chat() {
            if let Err(why) = self.open_link(&crate::chatlink::link(&m.chat, "")) {
                crate::picker::show_toast(ctx, why);
            }
        } else {
            self.point_at(ctx, chat_id, m.item);
        }
    }

    fn chat_rows(&self, key: i64, query: &str) -> Vec<Cand> {
        let cands = self.chat_cands(key, self.current_repo());
        rank(&cands, query, crate::tags::MAX_ROWS).into_iter().cloned().collect()
    }

    /// Before the composer's text field: the open menu takes its keys (arrows, Enter and
    /// Tab to pick, Esc to close).
    pub fn chat_mention_keys(&mut self, ui: &mut Ui, key: i64, cid: Id, draft: &mut String) {
        if self.chatm.open != Some(key) {
            return;
        }
        let Some(w) = cursor_word(ui.ctx(), cid, draft) else { return };
        let rows = self.chat_rows(key, &w.query);
        if rows.is_empty() {
            return;
        }
        let none = Modifiers::NONE;
        let (up, down, accept, esc) = ui.input_mut(|i| {
            let accept = i.consume_key(none, Key::Enter) | i.consume_key(none, Key::Tab);
            (i.consume_key(none, Key::ArrowUp), i.consume_key(none, Key::ArrowDown), accept, i.consume_key(none, Key::Escape))
        });
        let n = rows.len();
        if up || down {
            self.chatm.sel = if down { (self.chatm.sel + 1) % n } else { (self.chatm.sel + n - 1) % n };
            self.chatm.scroll = true;
        }
        if esc {
            self.chatm.dismissed = Some((key, w.start));
            self.chatm.open = None;
        }
        if accept {
            let c = rows[self.chatm.sel.min(n - 1)].clone();
            self.chat_mention_accept(ui.ctx(), key, cid, draft, &w, &c);
        }
    }

    fn chat_mention_accept(&mut self, ctx: &egui::Context, key: i64, cid: Id, draft: &mut String, w: &Word, c: &Cand) {
        // The `$word` becomes the chat's title, a link once sent (usertext.rs).
        let label = crate::usertext::label(&c.title);
        let (text, cursor) = crate::slash::replace(draft, &crate::slash::Word { start: w.start, end: w.end, query: w.query.clone(), first: false }, &label);
        *draft = text;
        let mut state = egui::text_edit::TextEditState::load(ctx, cid).unwrap_or_default();
        state.cursor.set_char_range(Some(egui::text::CCursorRange::one(egui::text::CCursor::new(cursor))));
        state.store(ctx, cid);
        ctx.memory_mut(|m| m.request_focus(cid));
        crate::mentions::add(self.mentions.drafts.entry(key).or_default(), Mention { title: label, ..c.mention() });
        self.chatm.open = None;
    }

    /// After the composer (drawn in `frame`): the menu above it for the `$word` at the cursor.
    pub fn chat_mention_menu(&mut self, ui: &mut Ui, key: i64, cid: Id, draft: &mut String, focused: bool, frame: Rect) {
        let ctx = ui.ctx().clone();
        let w = if focused && self.popup.is_none() && self.dialog.is_none() { cursor_word(&ctx, cid, draft) } else { None };
        if self.chatm.dismissed.is_some_and(|(k, start)| k == key && w.as_ref().map(|w| w.start) != Some(start)) {
            self.chatm.dismissed = None;
        }
        let Some(w) = w.filter(|w| self.chatm.dismissed != Some((key, w.start))) else {
            self.chatm.open = None;
            return;
        };
        if self.chatm.open != Some(key) || self.chatm.query != w.query {
            self.chatm.query = w.query.clone();
            self.chatm.sel = 0;
        }
        let rows = self.chat_rows(key, &w.query);
        if rows.is_empty() {
            self.chatm.open = None;
            return;
        }
        self.chatm.sel = self.chatm.sel.min(rows.len() - 1);
        self.chatm.open = Some(key);
        ui.memory_mut(|m| m.set_focus_lock_filter(cid, egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: true }));
        let tk = self.theme.t;
        let (sel, scroll) = (self.chatm.sel, std::mem::take(&mut self.chatm.scroll));
        let (moved, pressed) = ctx.input(|i| (i.pointer.delta() != Vec2::ZERO, i.pointer.primary_pressed()));
        let mut hover = None;
        let mut pick = None;
        let max_h = MENU_MAX_H.min(frame.top() - ctx.content_rect().top() - 24.0).max(ROW_H * 3.0);
        egui::Area::new(Id::NULL.with(("chat-mention-menu", key)))
            .order(egui::Order::Foreground)
            .pivot(Align2::LEFT_BOTTOM)
            .fixed_pos(frame.left_top() - Vec2::new(0.0, 6.0))
            .constrain(true)
            .show(&ctx, |ui| {
                w::popover_frame(&tk).show(ui, |ui| {
                    ui.set_width(frame.width() - 14.0);
                    ScrollArea::vertical().max_height(max_h).auto_shrink([false, true]).show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 0.0;
                        for (i, c) in rows.iter().enumerate() {
                            let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW_H), Sense::hover());
                            if ui.rect_contains_pointer(rect) {
                                if moved {
                                    hover = Some(i);
                                }
                                if pressed {
                                    pick = Some(i);
                                }
                            }
                            if i == sel && scroll {
                                ui.scroll_to_rect(rect, None);
                            }
                            row(ui, rect, c, i == sel);
                            resp.tip(format!("{}\n{}\n\nMention this chat: the agent gets its recap and last turns", c.title, c.line()));
                        }
                    });
                });
            });
        if let Some(i) = hover {
            self.chatm.sel = i;
        }
        if let Some(c) = pick.and_then(|i| rows.get(i)).cloned() {
            self.chat_mention_accept(&ctx, key, cid, draft, &w, &c);
        }
    }
}

/// The `$word` at the composer's cursor.
fn cursor_word(ctx: &egui::Context, cid: Id, draft: &str) -> Option<Word> {
    let state = egui::text_edit::TextEditState::load(ctx, cid)?;
    word(draft, state.cursor.char_range()?.primary.index.0)
}

/// One menu row: the chat icon, its title, then project · PC · status, dimmed.
fn row(ui: &Ui, rect: Rect, c: &Cand, selected: bool) {
    let t = w::tokens(ui);
    let p = ui.painter();
    if selected {
        p.rect_filled(rect, CornerRadius::same(RADIUS_MD), t.accent());
    }
    let color = if c.settled { t.subtle() } else { t.fg() };
    ic::glyph(p, pos2(rect.left() + 18.0, rect.center().y), ic::MESSAGE, 14.0, t.subtle());
    let x = rect.left() + 32.0;
    let room = rect.right() - 10.0 - x;
    let name = w::truncated(ui, &c.title, FontId::new(13.0, theme::medium()), color, (room * 0.6).max(40.0));
    let dx = x + name.size().x + 10.0;
    p.galley(pos2(x, rect.center().y - name.size().y / 2.0), name, color);
    let left = rect.right() - 10.0 - dx;
    if left > 30.0 {
        let d = w::truncated(ui, &c.line(), FontId::proportional(12.5), t.subtle(), left);
        p.galley(pos2(dx, rect.center().y - d.size().y / 2.0), d, t.subtle());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(title: &str, project: &str, here: bool, settled: bool, updated: i64) -> Cand {
        Cand { gid: format!("g-{title}"), title: title.into(), project: project.into(), pc: "desk".into(), status: if settled { "settled" } else { "idle" }.into(), updated, here, settled }
    }

    #[test]
    fn finds_the_dollar_word() {
        assert_eq!(word("see $fix", 8), Some(Word { start: 4, end: 8, query: "fix".into() }));
        assert_eq!(word("$", 1), Some(Word { start: 0, end: 1, query: String::new() }));
        assert_eq!(word("(\u{24}lo", 4).map(|w| w.start), Some(1));
        assert_eq!(word("costs $5", 8), None, "money");
        assert_eq!(word("a$b", 3), None, "inside a word");
        assert_eq!(word("$$x", 3), None);
        assert_eq!(word("$abc def", 2).map(|w| (w.end, w.query)), Some((4, "a".into())));
    }

    #[test]
    fn ranks_this_project_and_active_chats_first() {
        let cs = vec![
            cand("Old settled", "harbor", true, true, 50),
            cand("Other project", "site", false, false, 100),
            cand("Fix login", "harbor", true, false, 10),
            cand("Fix tests", "harbor", true, false, 20),
        ];
        let titles = |q: &str| rank(&cs, q, 10).iter().map(|c| c.title.clone()).collect::<Vec<_>>();
        assert_eq!(titles(""), ["Fix tests", "Fix login", "Old settled", "Other project"]);
        assert_eq!(titles("login"), ["Fix login"]);
        assert_eq!(titles("site"), ["Other project"], "by project");
        assert_eq!(titles("fix")[..2], ["Fix tests", "Fix login"]);
    }

    fn user(t: &str) -> Item {
        Item::User { text: t.into(), files: vec![], at: 0, mentions: vec![], sender: String::new(), intent: Default::default() }
    }
    fn text(t: &str) -> Item {
        Item::Text { text: t.into(), at: 0 }
    }

    #[test]
    fn context_has_the_last_turns_within_the_cap() {
        let mut items = vec![];
        for i in 0..9 {
            items.push(user(&format!("ask {i}")));
            items.push(text(&format!("thinking out loud {i}")));
            items.push(text(&format!("answer {i}")));
        }
        let turns = last_turns(&items);
        assert_eq!(turns.len(), TURNS);
        assert_eq!(turns[0], ("ask 3".to_string(), "answer 3".to_string()));
        let c = cand("Fix login", "harbor", true, false, 1);
        let ctx = context(&c, Some("Fixed the cookie; tests pass."), &items);
        assert!(ctx.starts_with("Title: Fix login\nProject: harbor\nPC: desk\nStatus: idle\nRecap: Fixed the cookie; tests pass.\nLast 6 turns:\nUser: ask 3\nAgent: answer 3\n"), "{ctx}");
        assert!(ctx.ends_with("User: ask 8\nAgent: answer 8"));
        assert!(!ctx.contains("thinking out loud"));
        // Long chats stay within the cap, the newest turn kept.
        let big: Vec<Item> = (0..6).flat_map(|i| [user(&"q".repeat(5000)), text(&format!("{i}{}", "a".repeat(9000)))]).collect();
        let ctx = context(&c, None, &big);
        assert!(ctx.chars().count() <= MAX_CHARS, "{}", ctx.chars().count());
        assert!(ctx.contains("Agent: 5aaa"));
        assert_eq!(context(&c, None, &[]).lines().last(), Some("(no messages yet)"));
    }

    #[test]
    fn the_quote_names_the_chat() {
        let mut m = cand("Fix login", "harbor", true, false, 1).mention();
        assert!(m.is_chat() && m.text.is_empty());
        m.text = "Title: Fix login\nStatus: idle".into();
        m.note = "same bug?".into();
        m.chat = "g1".into();
        assert_eq!(quote(&m), "> [mentioned chat \u{201c}Fix login\u{201d}, chat id g1 (message_chat takes it; link it as harbor://chat/g1)]\n> Title: Fix login\n> Status: idle\nsame bug?\n\n");
        // On the wire: kind, chat and title; a message mention stays as before.
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!((v["kind"].as_str(), v["chat"].as_str(), v["title"].as_str()), (Some("chat"), Some("g1"), Some("Fix login")));
        let back: Mention = serde_json::from_value(json!({ "kind": "chat", "chat": "g1", "title": "T" })).unwrap();
        assert!(back.is_chat() && back.item == 0 && back.from.is_empty());
        // One chat once.
        let mut list = vec![];
        crate::mentions::add(&mut list, m.clone());
        crate::mentions::add(&mut list, m);
        assert_eq!(list.len(), 1);
    }
}
