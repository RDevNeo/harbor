//! Message mentions: any message of the transcript (yours, the agent's, a tool
//! result, a subagent's report) can be mentioned in the next message. Mentions
//! wait as chips above the composer; on send they go to the agent as quoted blocks
//! before your text, and the transcript shows them as chips on your message.
//!
//! A piece of a message can be mentioned too: select text in the transcript and a
//! "Mention selection" button appears by it. The chip then holds just that excerpt,
//! still pointing at its message. egui reports a finished label selection as
//! `OutputCommand::TextSelectionSettled` (the text egui would copy); [`Selection`]
//! catches it, and the transcript ties it to the message the drag started in.
//!
//! A click on the chip scrolls to that piece and lights up just its rows. A selection is what
//! egui copied, not the message's markdown, so it's looked for in the glyphs the message paints.
//!
//! Each mention waiting in the composer has its own note box: what the user says about
//! that message or excerpt. The note goes to the agent right under its quote.

use crate::widgets::Tip as _;
use crate::app::App;
use crate::icons as ic;
use crate::store::{Item, Role};
use crate::theme::{self, RADIUS_LG, RADIUS_MD};
use crate::widgets as w;
use eframe::egui::{self, Align2, CornerRadius, CursorIcon, FontId, Rect, Sense, Stroke, StrokeKind, Ui, Vec2, pos2};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Longest quote sent to the agent, in characters.
const MAX_CHARS: usize = 4000;
/// How long a message stays highlighted after its chip is clicked.
const FLASH_SECS: f64 = 1.6;
/// Frames to look for an excerpt (a table lays out unseen on its first frame) before
/// the whole message lights up instead.
const SEEK_FRAMES: u8 = 5;
/// A piece of painted text this short can sit inside an excerpt without being part of it
/// (a list's number, a copy button): selections don't hold those.
const SKIPPED_CHARS: usize = 16;

/// A mentioned message: where it is (its item in the same chat) and what it said.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mention {
    #[serde(default)]
    pub item: usize,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub at: i64,
    /// The message, cut at `MAX_CHARS`.
    #[serde(default)]
    pub text: String,
    /// Its full length in characters (more than `text` holds when cut).
    #[serde(default)]
    pub len: usize,
    /// `text` is a part of the message the user selected, not all of it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub excerpt: bool,
    /// What the user wrote about it, sent right under its quote.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// "chat": a whole chat mentioned with `$` (chatmention.rs; `chat` and `title` say which,
    /// `text` gets its context when sent). "" for a message.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// The mentioned chat's global id.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub chat: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
}

/// Text selected in a message, waiting for its "Mention selection" button.
pub struct Selected {
    pub chat: i64,
    pub item: usize,
    pub text: String,
    /// Where the button goes, from the item's top left (set once the item is drawn).
    pub offset: Option<Vec2>,
    /// When the selection last changed or the pointer last moved, in `Context` time.
    pub settled_at: f64,
    /// Since when the button shows (restarted while the pointer is on it).
    pub shown_at: Option<f64>,
    /// The button timed out: it stays away until a new selection.
    pub gone: bool,
}

/// egui plugin keeping the text of the last settled label selection (a drag released,
/// a double click, shift+arrows done). The transcript takes it each frame.
#[derive(Default)]
pub struct Selection {
    settled: Option<String>,
}

impl egui::plugin::Plugin for Selection {
    fn debug_name(&self) -> &'static str {
        "harbor-selection"
    }

    fn output_hook(&mut self, ctx: &egui::Context, output: &mut egui::FullOutput) {
        // Left in the output: egui-winit also puts it in the PRIMARY selection.
        for c in &output.platform_output.commands {
            if let egui::OutputCommand::TextSelectionSettled(t) = c {
                self.settled = Some(t.clone());
                // The next frame shows its button, even with the mouse at rest.
                ctx.request_repaint();
            }
        }
    }
}

/// The selection settled since the last call, if any.
pub fn take_settled(ctx: &egui::Context) -> Option<String> {
    ctx.with_plugin(|s: &mut Selection| s.settled.take()).flatten()
}

/// Is some label text selected right now?
pub fn has_selection(ctx: &egui::Context) -> bool {
    ctx.with_plugin(|s: &mut egui::text_selection::LabelSelectionState| s.has_selection()).unwrap_or(false)
}

/// A message pointed at: it scrolls into view and lights up, or just its excerpt does.
pub struct Flash {
    pub chat: i64,
    pub item: usize,
    since: f64,
    /// The scroll to it is still due.
    scroll: bool,
    /// The excerpt, while it's still to be found in what the message paints.
    seek: Option<String>,
    tries: u8,
    /// The excerpt's rows from the item's top left. Empty: the whole message lights up.
    rows: Vec<Rect>,
}

impl Flash {
    /// Still looking for an excerpt, which may be inside a folded tool call or notice.
    pub fn seeking(&self) -> bool {
        self.seek.is_some()
    }
}

/// What [`State::seek`] left for [`State::flash`] while item is drawn.
pub struct Seek {
    from: usize,
    view: Rect,
}

#[derive(Default)]
pub struct State {
    /// Per composer (chat id), mentions waiting to be sent.
    pub drafts: HashMap<i64, Vec<Mention>>,
    /// The message being pointed at.
    pub flash: Option<Flash>,
    /// The message (chat, item) the latest press in a transcript landed on.
    pub press: Option<(i64, usize)>,
    /// Selected text that can be mentioned.
    pub selected: Option<Selected>,
    /// The note box to focus once drawn (a selection was just mentioned).
    pub focus_note: Option<egui::Id>,
}

impl State {
    /// Called by the transcript before drawing item `i`. An excerpt is found in the glyphs
    /// the message paints, and egui paints no label outside the clip rect: until it's found
    /// the item draws with no clip, and [`Self::flash`] puts the clip back on its shapes.
    pub fn seek(&self, ui: &mut Ui, chat_id: i64, i: usize) -> Option<Seek> {
        self.flash.as_ref().filter(|f| f.chat == chat_id && f.item == i && f.seeking())?;
        let (view, from) = (ui.clip_rect(), ui.ctx().graphics(|g| g.get(ui.layer_id()).map_or(0, |l| l.next_idx().0)));
        ui.set_clip_rect(Rect::EVERYTHING);
        Some(Seek { from, view })
    }

    /// Called by the transcript after drawing item `i` in `rect`: scrolls to it and
    /// paints the fading highlight while it's the one pointed at.
    pub fn flash(&mut self, ui: &mut Ui, chat_id: i64, i: usize, rect: Rect, seek: Option<Seek>) {
        let Some(f) = self.flash.as_mut().filter(|f| f.chat == chat_id && f.item == i) else { return };
        if let Some(s) = seek {
            ui.set_clip_rect(s.view);
            let rows = excerpt_rows(ui, &s, f.seek.as_deref().unwrap_or_default());
            f.tries = f.tries.saturating_sub(1);
            if rows.is_empty() && f.tries > 0 {
                ui.ctx().request_repaint();
                return;
            }
            f.seek = None;
            f.rows = rows.iter().map(|r| r.translate(-rect.min.to_vec2())).collect();
        }
        let now = ui.input(|x| x.time);
        if f.scroll {
            let to = if f.rows.is_empty() { rect } else { scroll_target(&f.rows, ui.clip_rect().height()).translate(rect.min.to_vec2()) };
            ui.scroll_to_rect(to, Some(egui::Align::Center));
            f.since = now;
            f.scroll = false;
        }
        let age = now - f.since;
        if age > FLASH_SECS {
            self.flash = None;
            return;
        }
        let t = w::tokens(ui);
        let a = (1.0 - age / FLASH_SECS) as f32;
        let (fill, stroke) = (w::alpha(t.blue(400), 0.25 * a), Stroke::new(1.5, w::alpha(t.blue(700), a)));
        if f.rows.is_empty() {
            ui.painter().rect(rect.expand2(Vec2::new(6.0, 4.0)), CornerRadius::same(RADIUS_LG), fill, stroke, StrokeKind::Outside);
        }
        for r in &f.rows {
            ui.painter().rect(r.translate(rect.min.to_vec2()).expand2(Vec2::new(2.0, 0.0)), CornerRadius::same(RADIUS_MD), fill, stroke, StrokeKind::Outside);
        }
        ui.ctx().request_repaint();
    }
}

/// Text the item painted, with what it takes to place its glyphs.
struct Painted {
    pos: egui::Pos2,
    galley: std::sync::Arc<egui::Galley>,
    clip: Rect,
}

fn painted_in(shape: &egui::Shape, clip: Rect, out: &mut Vec<Painted>) {
    match shape {
        egui::Shape::Text(t) => out.push(Painted { pos: t.pos, galley: t.galley.clone(), clip }),
        // A commit's pill (commits.rs).
        egui::Shape::Vec(v) => v.iter().for_each(|s| painted_in(s, clip, out)),
        _ => {}
    }
}

/// The rows `excerpt` covers in what was painted since `s.from`, on screen; empty when it's
/// not there. Those shapes get the clip they should have had.
fn excerpt_rows(ui: &Ui, s: &Seek, excerpt: &str) -> Vec<Rect> {
    let mut texts = vec![];
    ui.ctx().graphics_mut(|g| {
        let list = g.entry(ui.layer_id());
        for k in s.from..list.next_idx().0 {
            list.mutate_shape(egui::layers::ShapeIdx(k), |cs| {
                painted_in(&cs.shape, cs.clip_rect, &mut texts);
                cs.clip_rect = cs.clip_rect.intersect(s.view);
            });
        }
    });
    let pieces: Vec<Vec<char>> = texts.iter().map(|t| t.galley.rows.iter().flat_map(|r| r.glyphs.iter().map(|g| g.chr)).collect()).collect();
    let Some(hits) = locate(&pieces, excerpt) else { return vec![] };
    let mut rows = vec![];
    for (p, range) in hits {
        let t = &texts[p];
        let mut at = 0;
        for row in &t.galley.rows {
            let n = row.glyphs.len();
            let (a, b) = (range.start.max(at) - at, range.end.min(at + n).saturating_sub(at));
            at += n;
            if a >= b {
                continue;
            }
            let (left, right) = (row.pos.x + row.glyphs[a].pos.x, row.pos.x + row.glyphs[b - 1].max_x());
            let r = Rect::from_min_max(pos2(left, row.min_y()), pos2(right, row.max_y())).translate(t.pos.to_vec2());
            // Sideways only: the excerpt itself may be off screen for now.
            rows.push(Rect::from_x_y_ranges(r.left().max(t.clip.left())..=r.right().min(t.clip.right()), r.y_range()));
        }
    }
    merged(rows)
}

/// `rows` with the pieces of a line as one (a paragraph's bold words are labels of their own).
fn merged(rows: Vec<Rect>) -> Vec<Rect> {
    let mut out: Vec<Rect> = vec![];
    for r in rows {
        match out.last_mut() {
            Some(l) if (r.bottom().min(l.bottom()) - r.top().max(l.top())) > 0.5 * r.height().min(l.height()) && (r.left() - l.right()).abs() < r.height() * 1.5 => *l = l.union(r),
            _ => out.push(r),
        }
    }
    out
}

/// What to bring into a view `view` high: the rows, or their start when they don't fit.
fn scroll_target(rows: &[Rect], view: f32) -> Rect {
    let all = rows.iter().fold(Rect::NOTHING, |a, r| a.union(*r));
    Rect::from_min_size(all.min, Vec2::new(all.width(), all.height().min(view * 0.8)))
}

/// Where `excerpt` lies in `pieces`, the text painted, in paint order: per piece touched, the
/// range of its chars. Selections and glyphs differ in whitespace (egui joins labels with
/// spaces and new lines of its own), so only the rest is compared. An ending "…" may be a cut.
fn locate(pieces: &[Vec<char>], excerpt: &str) -> Option<Vec<(usize, std::ops::Range<usize>)>> {
    let ink = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<Vec<char>>();
    let whole = ink(excerpt);
    let cut = ink(excerpt.trim().trim_matches('\u{2026}'));
    [whole, cut].iter().filter(|n| !n.is_empty()).find_map(|needle| {
        pieces.iter().enumerate().find_map(|(p, chars)| chars.iter().enumerate().filter(|(_, c)| **c == needle[0]).find_map(|(o, _)| follow(pieces, p, o, needle)))
    })
}

/// `needle` read from char `o` of piece `p` on, if it's all there.
fn follow(pieces: &[Vec<char>], mut p: usize, mut o: usize, needle: &[char]) -> Option<Vec<(usize, std::ops::Range<usize>)>> {
    let mut out = vec![];
    let mut n = 0;
    while n < needle.len() {
        let chars = pieces.get(p)?;
        let mut span: Option<std::ops::Range<usize>> = None;
        while o < chars.len() && n < needle.len() {
            if !chars[o].is_whitespace() {
                if chars[o] != needle[n] {
                    break;
                }
                n += 1;
                span = Some(span.map_or(o, |s| s.start)..o + 1);
            }
            o += 1;
        }
        if n < needle.len() && o < chars.len() && (span.is_some() || chars.iter().filter(|c| !c.is_whitespace()).count() > SKIPPED_CHARS) {
            return None;
        }
        out.extend(span.map(|s| (p, s)));
        p += 1;
        o = 0;
    }
    Some(out)
}

impl Mention {
    /// A whole chat, mentioned with `$`.
    pub fn is_chat(&self) -> bool {
        self.kind == "chat"
    }

    /// First non-empty line, for chips.
    pub fn snippet(&self) -> &str {
        if self.is_chat() {
            return &self.from;
        }
        self.text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
    }

    /// The same message and text (excerpts of one message are told apart by their text).
    fn same(&self, other: &Mention) -> bool {
        if self.is_chat() || other.is_chat() {
            return self.chat == other.chat && self.kind == other.kind;
        }
        self.item == other.item && self.excerpt == other.excerpt && (!self.excerpt || self.text == other.text)
    }
}

/// Adds `m` to `list` unless it's already there.
pub fn add(list: &mut Vec<Mention>, m: Mention) {
    if !list.iter().any(|x| x.same(&m)) {
        list.push(m);
    }
}

/// Text with its whitespace runs folded to one space, to compare a selection with a message.
fn folded(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `m` holding only `text` (cut at `MAX_CHARS`).
fn excerpt(m: Mention, text: &str) -> Mention {
    let len = text.chars().count();
    Mention { text: text.chars().take(MAX_CHARS).collect(), len, excerpt: true, ..m }
}

/// The quoted blocks that go before the user's text.
pub fn prompt(ms: &[Mention]) -> String {
    let mut out = String::new();
    for m in ms {
        if m.is_chat() {
            out.push_str(&crate::chatmention::quote(m));
            continue;
        }
        let when = if m.at > 0 { format!(", {}", crate::team::clock(m.at)) } else { String::new() };
        if m.excerpt {
            out.push_str(&format!("> [excerpt of a message from {}{when}]\n", m.from));
        } else {
            out.push_str(&format!("> [mentioned message from {}{when}]\n", m.from));
        }
        for l in crate::usertext::defuse(&m.text).lines() {
            out.push_str("> ");
            out.push_str(l);
            out.push('\n');
        }
        if m.len > m.text.chars().count() {
            out.push_str(&format!("> (truncated: the first {} of {} characters)\n", m.text.chars().count(), m.len));
        }
        let note = m.note.trim();
        if !note.is_empty() {
            out.push_str(note);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

impl App {
    /// A mention of the chat's `i`th item; None for items that aren't messages.
    pub fn mention_of(&self, chat_id: i64, i: usize) -> Option<Mention> {
        let item = self.transcripts.get(&chat_id)?.items.get(i)?;
        let agent = match self.chat(chat_id) {
            Some(c) if c.role == Role::Sub && !c.name.is_empty() => c.name.clone(),
            Some(c) => self.account(&c.account).map(|a| a.kind.label().to_string()).unwrap_or_else(|| "the agent".into()),
            None => "the agent".into(),
        };
        let (from, at, text) = match item {
            Item::User { text, files, at, .. } => {
                let mut t = text.clone();
                for f in files {
                    t.push_str(&format!("\n(attached: {f})"));
                }
                ("you".to_string(), *at, t)
            }
            Item::Text { text, at } => (agent, *at, text.clone()),
            Item::Tool { name, summary, input, result, .. } => {
                let mut t = format!("{} {summary}\ninput: {input}", crate::chat::tool_label(name));
                if let Some(r) = result {
                    t.push_str(&format!("\nresult: {r}"));
                }
                (format!("{agent} · {}", crate::chat::tool_label(name)), 0, t)
            }
            Item::Notice { text, detail, .. } => {
                let t = if detail.is_empty() { text.clone() } else { format!("{text}\n\n{detail}") };
                (text.chars().take(40).collect(), 0, t)
            }
            Item::Message { from, to, text } => (format!("{from} → {to}"), 0, text.clone()),
            Item::Error { text } => ("error".to_string(), 0, text.clone()),
            Item::Thinking { .. } | Item::Result { .. } => return None,
        };
        let len = text.chars().count();
        let text = if len > MAX_CHARS { text.chars().take(MAX_CHARS).collect() } else { text };
        Some(Mention { item: i, from, at, text, len, excerpt: false, note: String::new(), kind: String::new(), chat: String::new(), title: String::new() })
    }

    /// Adds a mention of item `i` to the chat's composer (once).
    pub fn mention(&mut self, chat_id: i64, i: usize) {
        let Some(m) = self.mention_of(chat_id, i) else { return };
        add(self.mentions.drafts.entry(chat_id).or_default(), m);
        self.focus_composer = true;
    }

    /// Adds a mention of just `text`, selected in item `i`. A selection of the
    /// whole message is a mention of the message.
    pub fn mention_excerpt(&mut self, chat_id: i64, i: usize, text: &str) {
        let Some(m) = self.excerpt_of(chat_id, i, text) else { return };
        // Straight into its note box: Enter there goes on to the message.
        self.mentions.focus_note = Some(note_id(chat_id, &m));
        add(self.mentions.drafts.entry(chat_id).or_default(), m);
    }

    /// The mention of `text`, selected in item `i` (the desktop's selection, the phone's).
    pub fn excerpt_of(&self, chat_id: i64, i: usize, text: &str) -> Option<Mention> {
        let m = self.mention_of(chat_id, i)?;
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        Some(if m.len <= MAX_CHARS && folded(text) == folded(&m.text) { m } else { excerpt(m, text) })
    }

    /// Scrolls the chat to item `i` and highlights it for a moment: `excerpt`, if given and
    /// found in it, or all of it.
    pub fn point_at(&mut self, ctx: &egui::Context, chat_id: i64, i: usize, excerpt: Option<&str>) {
        let seek = excerpt.filter(|e| !e.trim().is_empty()).map(str::to_string);
        self.mentions.flash = Some(Flash { chat: chat_id, item: i, since: ctx.input(|x| x.time), scroll: true, seek, tries: SEEK_FRAMES, rows: vec![] });
        ctx.request_repaint();
    }
}

pub enum Click {
    None,
    Open,
    Remove,
    /// Enter in its note box: on to the message.
    Done,
}

/// A mention chip: "@ author  snippet", with an (x) when `removable`.
pub fn chip(ui: &mut Ui, m: &Mention, removable: bool) -> Click {
    chip_in(ui, m, removable, true)
}

/// A mention waiting in the composer: its chip as the header of a card, with the
/// note box under it. Enter there moves on to the message (Shift+Enter: a new line).
pub fn draft(ui: &mut Ui, chat: i64, m: &mut Mention, focus: &mut Option<egui::Id>) -> Click {
    let t = w::tokens(ui);
    let id = note_id(chat, m);
    // Focus wanted here (a selection was just mentioned): the button acted on the press,
    // and egui takes focus away from a field when a click ends outside it, so the release
    // on that button would undo a request made in between. Asked again after the field
    // is laid out, every frame until the click is over and the field has it.
    let wanted = *focus == Some(id);
    if wanted && ui.memory(|x| x.has_focus(id)) && ui.input(|i| !i.pointer.any_down() && !i.pointer.any_released()) {
        *focus = None;
    }
    let enter = ui.memory(|x| x.has_focus(id)) && ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Enter));
    let mut click = Click::None;
    egui::Frame::new()
        .fill(t.gray(100))
        .stroke(Stroke::new(1.0, t.border()))
        .corner_radius(CornerRadius::same(RADIUS_MD))
        .inner_margin(egui::Margin { left: 0, right: 0, top: 0, bottom: 4 })
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing.y = 0.0;
            click = chip_in(ui, m, true, false);
            let hint = if m.is_chat() { "Add a note about this chat" } else if m.excerpt { "Add a note about this excerpt" } else { "Add a note about this message" };
            ui.horizontal(|ui| {
                ui.add_space(22.0);
                ui.add(
                    egui::TextEdit::multiline(&mut m.note)
                        .id(id)
                        .frame(egui::Frame::NONE)
                        .desired_rows(1)
                        .desired_width(ui.available_width() - 10.0)
                        .hint_text(hint)
                        .font(theme::ts("label-13"))
                        .return_key(egui::KeyboardShortcut::new(egui::Modifiers::SHIFT, egui::Key::Enter))
                        .lock_focus(false),
                );
            });
        });
    if wanted && focus.is_some() {
        ui.memory_mut(|x| x.request_focus(id));
        ui.ctx().request_repaint();
    }
    if enter {
        click = Click::Done;
    }
    click
}

/// The note box of mention `m` in the chat's composer.
pub fn note_id(chat: i64, m: &Mention) -> egui::Id {
    egui::Id::NULL.with(("mention-note", chat, m.item, m.excerpt, &m.text))
}

/// The chip; `framed`: a pill of its own (else the header row of a card, as wide as it).
fn chip_in(ui: &mut Ui, m: &Mention, removable: bool, framed: bool) -> Click {
    let t = w::tokens(ui);
    // A chat: its title, then where it is (project · PC).
    let head = if m.is_chat() { m.title.clone() } else { m.from.clone() };
    let from = ui.painter().layout_no_wrap(head, FontId::new(12.5, theme::medium()), t.fg());
    let room = (ui.available_width() - from.size().x - if removable { 70.0 } else { 46.0 }).clamp(40.0, if framed { 220.0 } else { 600.0 });
    // An excerpt reads as a quote: “…”.
    let snippet = if m.excerpt { format!("\u{201c}{}\u{201d}", m.snippet()) } else { m.snippet().to_string() };
    let snip = w::truncated(ui, &snippet, FontId::proportional(12.5), t.subtle(), room);
    let x_w = if removable { 22.0 } else { 0.0 };
    let width = if framed { 24.0 + from.size().x + 8.0 + snip.size().x + 10.0 + x_w } else { ui.available_width() };
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 26.0), Sense::click());
    let p = ui.painter();
    if framed {
        p.rect(rect, CornerRadius::same(RADIUS_MD), if resp.hovered() { t.gray(200) } else { t.gray(100) }, Stroke::new(1.0, t.border()), StrokeKind::Inside);
    } else if resp.hovered() {
        let top = CornerRadius { nw: RADIUS_MD, ne: RADIUS_MD, sw: 0, se: 0 };
        p.rect_filled(rect.shrink(1.0), top, t.gray(200));
    }
    if m.is_chat() {
        ic::glyph(p, pos2(rect.left() + 13.0, rect.center().y), ic::MESSAGE, 12.5, t.subtle());
    } else {
        p.text(pos2(rect.left() + 13.0, rect.center().y), Align2::CENTER_CENTER, "@", FontId::new(13.0, theme::medium()), t.subtle());
    }
    let fx = rect.left() + 24.0;
    p.galley(pos2(fx, rect.center().y - from.size().y / 2.0), from.clone(), t.fg());
    p.galley(pos2(fx + from.size().x + 8.0, rect.center().y - snip.size().y / 2.0), snip, t.subtle());
    let mut click = Click::None;
    if removable {
        let xr = Rect::from_center_size(pos2(rect.right() - 13.0, rect.center().y), Vec2::splat(18.0));
        let x = ui.interact(xr, resp.id.with("unmention"), Sense::click());
        if x.hovered() {
            ui.painter().rect_filled(xr, CornerRadius::same(4), t.gray(300));
        }
        ic::glyph(ui.painter(), xr.center(), ic::X, 12.0, t.subtle());
        if x.on_hover_cursor(CursorIcon::PointingHand).tip("Remove").clicked() {
            click = Click::Remove;
        }
    }
    let mut tip: String = if m.is_chat() { format!("{}\n{}", m.title, m.from) } else { m.text.chars().take(300).collect() };
    if framed && !m.note.trim().is_empty() {
        tip.push_str(&format!("\n\nYour note: {}", m.note.trim()));
    }
    let what = if m.is_chat() { "Click to open this chat" } else if m.excerpt { "Excerpt. Click to see its message in the chat" } else { "Click to see it in the chat" };
    if resp.on_hover_cursor(CursorIcon::PointingHand).tip(format!("{tip}\n\n{what}")).clicked() && matches!(click, Click::None) {
        click = Click::Open;
    }
    click
}

/// A hover "@" button at the right of `rect` (rows that have no
/// hover actions of their own: tool calls, notices, agent messages). True when clicked.
pub fn hover_button(ui: &mut Ui, rect: Rect, outside: bool) -> bool {
    let b = if outside {
        Rect::from_min_size(pos2(rect.right() + 4.0, rect.center().y - 14.0), Vec2::splat(28.0))
    } else {
        Rect::from_min_size(pos2(rect.right() - 32.0, rect.top() + 2.0), Vec2::splat(28.0))
    };
    if !ui.rect_contains_pointer(rect.union(b)) {
        return false;
    }
    w::overlay(ui, b, |ui| w::btn("@").muted().icon_xs().show(ui).tip("Mention in your next message").clicked())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole(item: usize, text: &str) -> Mention {
        Mention { item, from: "Claude".into(), at: 0, text: text.into(), len: text.chars().count(), excerpt: false, note: String::new(), kind: String::new(), chat: String::new(), title: String::new() }
    }

    #[test]
    fn old_mentions_load_as_whole_messages() {
        let m: Mention = serde_json::from_str(r#"{"item":3,"from":"you","text":"hi"}"#).unwrap();
        assert!(!m.excerpt);
        // And whole ones are saved as before, without the new field.
        assert!(!serde_json::to_string(&whole(1, "x")).unwrap().contains("excerpt"));
    }

    #[test]
    fn an_excerpt_is_quoted_alone() {
        let m = excerpt(whole(2, "First line.\nThe part that matters.\nLast line."), "The part that matters.");
        assert!(m.excerpt);
        assert_eq!(prompt(&[m]), "> [excerpt of a message from Claude]\n> The part that matters.\n\n");
        assert_eq!(prompt(&[whole(2, "a\nb")]), "> [mentioned message from Claude]\n> a\n> b\n\n");
    }

    #[test]
    fn notes_go_under_their_quote() {
        let mut a = excerpt(whole(2, "One. Two. Three."), "Two.");
        a.note = "  why two?\n".into();
        let b = whole(3, "Done.");
        assert_eq!(prompt(&[a, b]), "> [excerpt of a message from Claude]\n> Two.\nwhy two?\n\n> [mentioned message from Claude]\n> Done.\n\n");
        // Old mentions have no note; an empty one isn't saved.
        let m: Mention = serde_json::from_str(r#"{"item":3,"from":"you","text":"hi","excerpt":true}"#).unwrap();
        assert!(m.note.is_empty());
        assert!(!serde_json::to_string(&m).unwrap().contains("note"));
    }

    #[test]
    fn long_excerpts_are_cut() {
        let long = "x".repeat(MAX_CHARS + 10);
        let m = excerpt(whole(0, &long), &long);
        assert_eq!(m.text.chars().count(), MAX_CHARS);
        assert!(prompt(&[m]).contains(&format!("(truncated: the first {MAX_CHARS} of {} characters)", MAX_CHARS + 10)));
    }

    #[test]
    fn excerpts_of_one_message_add_once_each() {
        let mut list = vec![];
        add(&mut list, whole(1, "a b c"));
        add(&mut list, whole(1, "a b c"));
        add(&mut list, excerpt(whole(1, "a b c"), "b"));
        add(&mut list, excerpt(whole(1, "a b c"), "b"));
        add(&mut list, excerpt(whole(1, "a b c"), "c"));
        assert_eq!(list.len(), 3);
        assert_eq!(folded(" a\n  b\tc "), "a b c");
    }

    fn pieces(texts: &[&str]) -> Vec<Vec<char>> {
        texts.iter().map(|t| t.chars().collect()).collect()
    }

    /// What of `texts` `locate` picked, a string per piece.
    fn found(texts: &[&str], excerpt: &str) -> Option<Vec<String>> {
        let ps = pieces(texts);
        locate(&ps, excerpt).map(|hits| hits.into_iter().map(|(p, r)| ps[p][r].iter().collect()).collect())
    }

    #[test]
    fn an_excerpt_is_found_with_any_whitespace() {
        assert_eq!(found(&["One two three four."], "two three"), Some(vec!["two three".into()]));
        // Wrapped in the message, a line break in the selection, or the other way round.
        assert_eq!(found(&["One two  three four."], "two\nthree"), Some(vec!["two  three".into()]));
        assert_eq!(found(&["One two\nthree four."], "  two three\n"), Some(vec!["two\nthree".into()]));
        // egui puts a space between two labels of a line that the text doesn't have.
        assert_eq!(found(&["Run ", "cargo", "test now"], "Run cargo test now"), Some(vec!["Run".into(), "cargo".into(), "test now".into()]));
    }

    #[test]
    fn an_excerpt_spans_labels_and_lines() {
        // Bold in a paragraph: three labels, the selection reads straight through.
        assert_eq!(found(&["First ", "bold", " last"], "st bold la"), Some(vec!["st".into(), "bold".into(), "la".into()]));
        // Two paragraphs, and the blank line egui's selection puts between them.
        assert_eq!(found(&["end of one.", "Start of two."], "of one.\n\nStart"), Some(vec!["of one.".into(), "Start".into()]));
        // A list: its numbers are painted but can't be selected.
        assert_eq!(found(&["1.", "First item", "2.", "Second item"], "First item\nSecond"), Some(vec!["First item".into(), "Second".into()]));
    }

    #[test]
    fn a_long_gap_is_not_part_of_an_excerpt() {
        assert_eq!(found(&["Alpha", "a whole paragraph that was not selected", "Beta"], "Alpha Beta"), None);
    }

    #[test]
    fn the_end_of_a_cut_excerpt_is_found() {
        // Cut with "…": what's before it counts.
        assert_eq!(found(&["It answers nothing to send and stops."], "answers nothing\u{2026}"), Some(vec!["answers nothing".into()]));
        assert_eq!(found(&["It answers nothing."], "\u{2026}answers\u{2026}"), Some(vec!["answers".into()]));
        // The message's own "…" stays in.
        assert_eq!(found(&["Well\u{2026} maybe"], "Well\u{2026}"), Some(vec!["Well\u{2026}".into()]));
        // At `MAX_CHARS`, with no mark: the start of the selection.
        let long = "word ".repeat(2000);
        let m = excerpt(whole(0, &long), &long);
        assert!(found(&[long.as_str()], &m.text).is_some());
    }

    #[test]
    fn what_isnt_there_is_not_found() {
        assert_eq!(found(&["Some text."], "other"), None);
        assert_eq!(found(&["Some text."], "   "), None);
        assert_eq!(found(&["Some text."], "\u{2026}"), None);
        assert_eq!(found(&[], "x"), None);
        // Runs out at the end of the message.
        assert_eq!(found(&["Some text."], "text. And more"), None);
    }

    #[test]
    fn the_first_start_that_goes_through_wins() {
        // "ab" starts twice before the one that holds the rest.
        assert_eq!(found(&["ab ab abc"], "abc"), Some(vec!["abc".into()]));
    }

    #[test]
    fn a_line_of_labels_is_one_row_and_lines_stay_apart() {
        let r = |l: f32, t: f32, w: f32| Rect::from_min_size(pos2(l, t), Vec2::new(w, 20.0));
        assert_eq!(merged(vec![r(0.0, 0.0, 40.0), r(44.0, 1.0, 30.0), r(0.0, 20.0, 50.0)]), vec![r(0.0, 0.0, 74.0).union(r(44.0, 1.0, 30.0)), r(0.0, 20.0, 50.0)]);
        // Two cells of a table are on one line, far apart.
        assert_eq!(merged(vec![r(0.0, 0.0, 40.0), r(300.0, 0.0, 30.0)]).len(), 2);
    }

    #[test]
    fn a_tall_excerpt_scrolls_to_its_start() {
        let rows = [Rect::from_min_size(pos2(10.0, 100.0), Vec2::new(50.0, 20.0)), Rect::from_min_size(pos2(0.0, 120.0), Vec2::new(80.0, 900.0))];
        assert_eq!(scroll_target(&rows, 2000.0), Rect::from_min_size(pos2(0.0, 100.0), Vec2::new(80.0, 920.0)));
        assert_eq!(scroll_target(&rows, 500.0), Rect::from_min_size(pos2(0.0, 100.0), Vec2::new(80.0, 400.0)));
    }
}
