//! Message mentions: any message of the transcript (yours, the agent's, a tool
//! result, a subagent's report) can be mentioned in the next message. Mentions
//! wait as chips above the composer; on send they go to the agent as quoted blocks
//! before your text, and the transcript shows them as chips on your message.

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

/// A mentioned message: where it is (its item in the same chat) and what it said.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mention {
    pub item: usize,
    pub from: String,
    #[serde(default)]
    pub at: i64,
    /// The message, cut at `MAX_CHARS`.
    pub text: String,
    /// Its full length in characters (more than `text` holds when cut).
    #[serde(default)]
    pub len: usize,
}

#[derive(Default)]
pub struct State {
    /// Per composer (chat id), mentions waiting to be sent.
    pub drafts: HashMap<i64, Vec<Mention>>,
    /// The message being pointed at: chat, item, start time, scroll still due.
    pub flash: Option<(i64, usize, f64, bool)>,
}

impl State {
    /// Called by the transcript after drawing item `i` in `rect`: scrolls to it and
    /// paints the fading highlight while it's the one pointed at.
    pub fn flash(&mut self, ui: &mut Ui, chat_id: i64, i: usize, rect: Rect) {
        let Some((c, item, since, scroll)) = self.flash else { return };
        if c != chat_id || item != i {
            return;
        }
        if scroll {
            ui.scroll_to_rect(rect, Some(egui::Align::Center));
            self.flash = Some((c, item, ui.input(|x| x.time), false));
        }
        let age = ui.input(|x| x.time) - since;
        if age > FLASH_SECS {
            self.flash = None;
            return;
        }
        let t = w::tokens(ui);
        let a = (1.0 - age / FLASH_SECS) as f32;
        let r = rect.expand2(Vec2::new(6.0, 4.0));
        ui.painter().rect(r, CornerRadius::same(RADIUS_LG), w::alpha(t.blue(400), 0.25 * a), Stroke::new(1.5, w::alpha(t.blue(700), a)), StrokeKind::Outside);
        ui.ctx().request_repaint();
    }
}

impl Mention {
    /// First non-empty line, for chips.
    pub fn snippet(&self) -> &str {
        self.text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
    }
}

/// The quoted blocks that go before the user's text.
pub fn prompt(ms: &[Mention]) -> String {
    let mut out = String::new();
    for m in ms {
        let when = if m.at > 0 { format!(", {}", crate::team::clock(m.at)) } else { String::new() };
        out.push_str(&format!("> [mentioned message from {}{when}]\n", m.from));
        for l in m.text.lines() {
            out.push_str("> ");
            out.push_str(l);
            out.push('\n');
        }
        if m.len > m.text.chars().count() {
            out.push_str(&format!("> (truncated: the first {} of {} characters)\n", m.text.chars().count(), m.len));
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
        Some(Mention { item: i, from, at, text, len })
    }

    /// Adds a mention of item `i` to the chat's composer (once).
    pub fn mention(&mut self, chat_id: i64, i: usize) {
        let Some(m) = self.mention_of(chat_id, i) else { return };
        let list = self.mentions.drafts.entry(chat_id).or_default();
        if !list.iter().any(|x| x.item == m.item) {
            list.push(m);
        }
        self.focus_composer = true;
    }

    /// Scrolls the chat to item `i` and highlights it for a moment.
    pub fn point_at(&mut self, ctx: &egui::Context, chat_id: i64, i: usize) {
        self.mentions.flash = Some((chat_id, i, ctx.input(|x| x.time), true));
        ctx.request_repaint();
    }
}

pub enum Click {
    None,
    Open,
    Remove,
}

/// A mention chip: "@ author  snippet", with an (x) when `removable`.
pub fn chip(ui: &mut Ui, m: &Mention, removable: bool) -> Click {
    let t = w::tokens(ui);
    let from = ui.painter().layout_no_wrap(m.from.clone(), FontId::new(12.5, theme::medium()), t.fg());
    let room = (ui.available_width() - from.size().x - if removable { 70.0 } else { 46.0 }).clamp(40.0, 220.0);
    let snip = w::truncated(ui, m.snippet(), FontId::proportional(12.5), t.subtle(), room);
    let x_w = if removable { 22.0 } else { 0.0 };
    let width = 24.0 + from.size().x + 8.0 + snip.size().x + 10.0 + x_w;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 26.0), Sense::click());
    let p = ui.painter();
    p.rect(rect, CornerRadius::same(RADIUS_MD), if resp.hovered() { t.gray(200) } else { t.gray(100) }, Stroke::new(1.0, t.border()), StrokeKind::Inside);
    p.text(pos2(rect.left() + 13.0, rect.center().y), Align2::CENTER_CENTER, "@", FontId::new(13.0, theme::medium()), t.subtle());
    let fx = rect.left() + 24.0;
    p.galley(pos2(fx, rect.center().y - from.size().y / 2.0), from.clone(), t.fg());
    p.galley(pos2(fx + from.size().x + 8.0, rect.center().y - snip.size().y / 2.0), snip, t.subtle());
    let mut click = Click::None;
    if removable {
        let xr = Rect::from_center_size(pos2(rect.right() - 13.0, rect.center().y), Vec2::splat(18.0));
        let x = ui.interact(xr, ui.scope_id().with(("unmention", m.item)), Sense::click());
        if x.hovered() {
            ui.painter().rect_filled(xr, CornerRadius::same(4), t.gray(300));
        }
        ic::glyph(ui.painter(), xr.center(), ic::X, 12.0, t.subtle());
        if x.on_hover_cursor(CursorIcon::PointingHand).tip("Remove").clicked() {
            click = Click::Remove;
        }
    }
    let tip: String = m.text.chars().take(300).collect();
    if resp.on_hover_cursor(CursorIcon::PointingHand).tip(format!("{tip}\n\nClick to see it in the chat")).clicked() && matches!(click, Click::None) {
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
