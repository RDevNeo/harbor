//! A user's message as the transcript shows it, on the desktop and the phone alike (the
//! phone gets these parts as the user card's `parts`, api.rs): a chat mentioned with `$`
//! (chatmention.rs) is its title written in the text, drawn as a link to the chat; `@file`
//! and `#123` tags (tags.rs) and `/command`s are blue. The text stays the user's own; this
//! only says which runs of it are what. The composer draws the same runs (tags.rs `layout`).
//!
//! Older messages mention chats without their title in the text: the title goes on a line
//! of its own before it, still a link.
//!
//! In the composer, a token picked from a menu (`@file`, `#12`, `/command`) and a mentioned
//! chat's title go in one Backspace or Delete (`erase`); text typed by hand erases as usual.
//! The phone does the same with spans on what it picked (Composer.java `Picked`).
//!
//! An image attached to a message is `[Image #N]` in its text, where it was pasted: the Nth
//! image of the message's files, so nothing but the text and the order of the files says which
//! is which, on any device and through the queue.

use crate::mentions::Mention;
use crate::theme;
use crate::widgets as w;
use eframe::egui::{self, CursorIcon, Event, Key, Modifiers, Stroke, Ui, text::CCursor, text::CCursorRange, util::undoer::Undoer};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;

/// A run's kind.
#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Plain,
    /// `@path` or `#123`.
    Tag,
    /// `/command` (a slash command or a skill).
    Command,
    /// A mentioned chat's title: its global id.
    Chat(String),
    /// `[Image #N]`: N.
    Image(usize),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub text: String,
    pub kind: Kind,
}

/// Most of a chat's title the composer writes for its mention, in characters.
const LABEL_CHARS: usize = 60;

/// What the composer writes for a mentioned chat: its title, a long one cut.
pub fn label(title: &str) -> String {
    let t = title.trim();
    if t.chars().count() <= LABEL_CHARS {
        return t.to_string();
    }
    format!("{}…", t.chars().take(LABEL_CHARS - 1).collect::<String>().trim_end())
}

/// The `/command` tokens of `text`: (byte offset, byte length), the punctuation after them
/// left out. At the start of a word, a letter first, then letters, digits, `-`, `_` or `:`
/// (`/review`, `/plugin:skill`); a path (`/tmp/x`) isn't one.
pub fn commands(text: &str) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let mut prev: Option<char> = None;
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if c == '/' && crate::tags::opens(prev) {
            let len = text[i..].find(char::is_whitespace).unwrap_or(text.len() - i);
            let body = text[i + 1..i + len].trim_end_matches(crate::tags::PUNCT);
            let ok = body.starts_with(|c: char| c.is_ascii_alphabetic()) && body.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'));
            if ok {
                out.push((i, 1 + body.len()));
            }
            // The rest of the word is no command either (`/tmp/x`).
            while it.peek().is_some_and(|(j, _)| *j < i + len) {
                prev = it.next().map(|x| x.1);
            }
            continue;
        }
        prev = Some(c);
    }
    out
}

/// The marked runs of `text`, by byte range, in order and apart: each of `titles` (a chat's
/// title and its id, every time it's written; longer titles first), then the images, tags and
/// commands outside them.
pub fn runs(text: &str, titles: &[(String, String)]) -> Vec<(usize, usize, Kind)> {
    let mut out: Vec<(usize, usize, Kind)> = vec![];
    let free = |out: &[(usize, usize, Kind)], a: usize, z: usize| !out.iter().any(|(s, e, _)| a < *e && *s < z);
    let mut by_len: Vec<&(String, String)> = titles.iter().filter(|(t, _)| !t.trim().is_empty()).collect();
    by_len.sort_by_key(|(t, _)| std::cmp::Reverse(t.len()));
    for (title, gid) in by_len {
        for (i, _) in text.match_indices(title.as_str()) {
            if free(&out, i, i + title.len()) {
                out.push((i, i + title.len(), Kind::Chat(gid.clone())));
            }
        }
    }
    let shown = images(text).into_iter().map(|(a, z, n)| (a, z, Kind::Image(n)));
    let tags = crate::tags::tokens(text).into_iter().map(|(i, n)| (i, i + n, Kind::Tag));
    let cmds = commands(text).into_iter().map(|(i, n)| (i, i + n, Kind::Command));
    for (a, z, k) in shown.chain(tags).chain(cmds).collect::<Vec<_>>() {
        if free(&out, a, z) {
            out.push((a, z, k));
        }
    }
    out.sort_by_key(|r| r.0);
    out
}

/// The chats `mentions` names: (title, global id).
pub fn chat_titles(mentions: &[Mention]) -> Vec<(String, String)> {
    mentions.iter().filter(|m| m.is_chat() && !m.title.trim().is_empty()).map(|m| (m.title.clone(), m.chat.clone())).collect()
}

/// The message as it reads: its text in runs, with an older message's mentioned chats (not
/// written in it) on lines of their own first.
pub fn parts(text: &str, mentions: &[Mention]) -> Vec<Part> {
    let titles = chat_titles(mentions);
    let runs = runs(text, &titles);
    let mut out: Vec<Part> = vec![];
    for m in mentions.iter().filter(|m| m.is_chat()) {
        let written = runs.iter().any(|(_, _, k)| *k == Kind::Chat(m.chat.clone()));
        if written {
            continue;
        }
        let title = if m.title.trim().is_empty() { "a chat".to_string() } else { m.title.trim().to_string() };
        out.push(Part { text: title, kind: Kind::Chat(m.chat.clone()) });
        let note = m.note.trim();
        let tail = if note.is_empty() { String::new() } else { format!(" \u{2014} {note}") };
        if !text.is_empty() || !tail.is_empty() {
            push(&mut out, &format!("{tail}\n"), Kind::Plain);
        }
    }
    let mut at = 0;
    for (a, z, k) in runs {
        push(&mut out, &text[at..a], Kind::Plain);
        push(&mut out, &text[a..z], k);
        at = z;
    }
    push(&mut out, &text[at..], Kind::Plain);
    // A trailing newline after the last prefix line with no text after it.
    if let Some(p) = out.last_mut().filter(|p| p.kind == Kind::Plain && text.is_empty()) {
        p.text = p.text.trim_end_matches('\n').to_string();
    }
    out.retain(|p| !p.text.is_empty());
    out
}

fn push(out: &mut Vec<Part>, s: &str, kind: Kind) {
    if s.is_empty() {
        return;
    }
    match out.last_mut() {
        Some(p) if p.kind == Kind::Plain && kind == Kind::Plain => p.text.push_str(s),
        _ => out.push(Part { text: s.to_string(), kind }),
    }
}

/// Only plain text in it.
pub fn plain(parts: &[Part]) -> bool {
    parts.iter().all(|p| p.kind == Kind::Plain)
}

/// What the message reads as, all its parts' text.
pub fn display(parts: &[Part]) -> String {
    parts.iter().map(|p| p.text.as_str()).collect()
}

/// The composer's mentions as the message keeps them: a chat whose title was taken out of
/// the text is no longer mentioned.
pub fn kept(text: &str, mentions: Vec<Mention>) -> Vec<Mention> {
    mentions.into_iter().filter(|m| !m.is_chat() || m.title.trim().is_empty() || text.contains(m.title.as_str())).collect()
}

/// The parts for the phone: `{text}`, or `{text, kind: tag|command|chat|image, chat|image}`.
pub fn wire(parts: &[Part]) -> Value {
    Value::Array(
        parts
            .iter()
            .map(|p| match &p.kind {
                Kind::Plain => json!({ "text": p.text }),
                Kind::Tag => json!({ "text": p.text, "kind": "tag" }),
                Kind::Command => json!({ "text": p.text, "kind": "command" }),
                Kind::Chat(gid) => json!({ "text": p.text, "kind": "chat", "chat": gid }),
                Kind::Image(n) => json!({ "text": p.text, "kind": "image", "image": n }),
            })
            .collect(),
    )
}

/// The message drawn as a selectable, wrapping label in the text style `style`: tags and
/// commands blue, images marked, chats as underlined links. The chat whose title was clicked, if any.
pub fn show(ui: &mut Ui, parts: &[Part], style: &str) -> Option<String> {
    let font = egui::FontSelection::from(theme::ts(style)).resolve(ui.style());
    let color = ui.visuals().override_text_color.unwrap_or_else(|| ui.visuals().text_color());
    let blue = ui.visuals().hyperlink_color;
    let mut job = egui::text::LayoutJob::default();
    // Char ranges of the chat links, for the pointer.
    let mut links: Vec<(usize, usize, String)> = vec![];
    let mut chars = 0;
    for p in parts {
        let n = p.text.chars().count();
        let mut f = egui::TextFormat { font_id: font.clone(), color, ..Default::default() };
        match &p.kind {
            Kind::Plain => {}
            Kind::Tag | Kind::Command => f.color = blue,
            Kind::Image(_) => {
                f.color = blue;
                f.background = w::alpha(blue, 0.16);
            }
            Kind::Chat(gid) => {
                f.color = blue;
                f.underline = Stroke::new(1.0, w::alpha(blue, 0.6));
                links.push((chars, chars + n, gid.clone()));
            }
        }
        job.append(&p.text, 0.0, f);
        chars += n;
    }
    let (pos, galley, resp) = egui::Label::new(job).wrap().layout_in_ui(ui);
    if !ui.is_rect_visible(resp.rect) {
        return None;
    }
    let selectable = ui.style().interaction.selectable_labels;
    if selectable {
        egui::text_selection::LabelSelectionState::label_text_selection(ui, &resp, pos, galley.clone(), color, Stroke::NONE);
    } else {
        ui.painter().galley(pos, galley.clone(), color);
    }
    if links.is_empty() {
        return None;
    }
    // The chat whose title's glyphs are under the pointer (not the space past a line's end).
    let over = resp.hover_pos().and_then(|p| {
        let at = p - pos;
        let c = galley.cursor_from_pos(at).index.0;
        let on = |k: usize| {
            let (a, b) = (galley.pos_from_cursor(CCursor::new(k)), galley.pos_from_cursor(CCursor::new(k + 1)));
            (a.min.y..=a.max.y).contains(&at.y) && (b.min.y - a.min.y).abs() < 1.0 && a.min.x <= at.x && at.x < b.min.x
        };
        let k = [c.saturating_sub(1), c].into_iter().find(|&k| on(k))?;
        links.iter().find(|(a, z, _)| (*a..*z).contains(&k)).map(|l| l.2.clone())
    });
    if let Some(gid) = over {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
        if resp.clicked() {
            return Some(gid);
        }
    }
    None
}

const IMAGE_OPEN: &str = "[Image #";

fn image_token(n: usize) -> String {
    format!("{IMAGE_OPEN}{n}]")
}

/// The `[Image #N]` tokens of `text`: (byte offset, byte end, N).
pub fn images(text: &str) -> Vec<(usize, usize, usize)> {
    let mut out = vec![];
    for (a, _) in text.match_indices(IMAGE_OPEN) {
        let rest = &text[a + IMAGE_OPEN.len()..];
        let digits = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
        if !rest[digits..].starts_with(']') {
            continue;
        }
        if let Some(n) = rest[..digits].parse::<usize>().ok().filter(|n| *n > 0) {
            out.push((a, a + IMAGE_OPEN.len() + digits + 1, n));
        }
    }
    out
}

/// The numbers written in `text`, each once, lowest first.
pub fn image_numbers(text: &str) -> Vec<usize> {
    let mut v: Vec<usize> = images(text).into_iter().map(|i| i.2).collect();
    v.sort();
    v.dedup();
    v
}

/// How many of `files` are images (what the numbers count).
pub fn image_count(files: &[PathBuf]) -> usize {
    files.iter().filter(|f| crate::images::is_image(&f.to_string_lossy())).count()
}

/// What the agent gets after the user's text when it names images: which image each number is.
/// A CLI that takes images gets them in this order (agent.rs), and any agent can open the path.
pub fn images_prompt(text: &str, files: &[PathBuf]) -> String {
    let attached = files.iter().filter(|f| crate::images::is_image(&f.to_string_lossy()));
    let lines: Vec<String> = attached.enumerate().map(|(i, f)| format!("Image #{}: {}", i + 1, f.display())).collect();
    if lines.is_empty() || images(text).is_empty() {
        return String::new();
    }
    format!("\n\n[Images in this message, in the order attached:\n- {}]", lines.join("\n- "))
}

/// `text` with `[Image #n]` at char `at`, spaces around it where words would touch it, and the
/// cursor after it (in chars).
pub fn insert_image(text: &str, at: usize, n: usize) -> (String, usize) {
    let byte = text.char_indices().nth(at).map_or(text.len(), |(b, _)| b);
    let (head, tail) = text.split_at(byte);
    let before = if head.chars().next_back().is_none_or(char::is_whitespace) { "" } else { " " };
    let after = if tail.starts_with(char::is_whitespace) { "" } else { " " };
    let token = format!("{before}{}{after}", image_token(n));
    (format!("{head}{token}{tail}"), at + token.chars().count())
}

/// Image `n` left the message: `text` without its tokens, the later images a number lower, and
/// where the cursor at char `cursor` went. One space stays between the words around a token.
pub fn forget_image(text: &str, n: usize, cursor: usize) -> (String, usize) {
    let mut out = text.to_string();
    let mut c = text.char_indices().nth(cursor).map_or(text.len(), |(b, _)| b);
    for (a, mut z, k) in images(text).into_iter().rev() {
        let with = match k {
            k if k < n => continue,
            k if k > n => image_token(k - 1),
            _ => {
                if text[z..].starts_with(' ') && (a == 0 || text[..a].ends_with(char::is_whitespace)) {
                    z += 1;
                }
                String::new()
            }
        };
        out.replace_range(a..z, &with);
        if c >= z {
            c = c - (z - a) + with.len();
        } else if c > a {
            c = a;
        }
    }
    let at = out[..c].chars().count();
    (out, at)
}

/// `text` with each image number through `f`, in the order they're written; `None`: the token
/// stops being one and only reads as one (`[Image 3]`).
pub fn map_images(text: &str, mut f: impl FnMut(usize) -> Option<usize>) -> String {
    let mapped: Vec<_> = images(text).into_iter().map(|(a, z, n)| (a, z, n, f(n))).collect();
    let mut out = text.to_string();
    for (a, z, n, to) in mapped.into_iter().rev() {
        out.replace_range(a..z, &to.map_or_else(|| format!("[Image {n}]"), image_token));
    }
    out
}

/// `text` from another message, its tokens no longer tokens: they named that message's images.
pub fn defuse(text: &str) -> String {
    map_images(text, |_| None)
}

/// `text`'s image numbers raised by `by`: its images now follow `by` others in the message.
pub fn shift_images(text: &str, by: usize) -> String {
    map_images(text, |n| Some(n + by))
}

/// `text` without its image tokens, as a chat's title.
pub fn without_images(text: &str) -> String {
    let mut out = text.to_string();
    for (a, z, _) in images(text).into_iter().rev() {
        out.replace_range(a..z + usize::from(text[z..].starts_with(' ')), "");
    }
    out
}

/// Writes `[Image #n]` at the cursor of composer `cid` (at the end if it has none yet).
pub fn write_image(ctx: &egui::Context, cid: egui::Id, draft: &mut String, n: usize) {
    let mut state = egui::text_edit::TextEditState::load(ctx, cid).unwrap_or_default();
    let end = draft.chars().count();
    let at = state.cursor.char_range().map_or(end, |r| r.primary.index.0.max(r.secondary.index.0).min(end));
    // A token written by hand that named no image must not start naming this one.
    let spare = |t: &str| map_images(t, |k| (k < n).then_some(k));
    let at = spare(&draft.chars().take(at).collect::<String>()).chars().count();
    let (text, to) = insert_image(&spare(draft), at, n);
    *draft = text;
    state.cursor.set_char_range(Some(egui::text::CCursorRange::one(CCursor::new(to))));
    state.store(ctx, cid);
}

/// `forget_image` on composer `cid`'s text, its cursor along.
pub fn erase_image(ctx: &egui::Context, cid: egui::Id, draft: &mut String, n: usize) {
    let mut state = egui::text_edit::TextEditState::load(ctx, cid).unwrap_or_default();
    let at = state.cursor.char_range().map_or(0, |r| r.primary.index.0);
    let (text, to) = forget_image(draft, n, at);
    *draft = text;
    state.cursor.set_char_range(Some(egui::text::CCursorRange::one(CCursor::new(to))));
    state.store(ctx, cid);
}

#[derive(Clone)]
pub struct Composed {
    pub text: String,
    pub files: Vec<PathBuf>,
    pub cursor: Option<CCursorRange>,
}

pub type TextUndo = Undoer<(CCursorRange, String)>;

/// A step Ctrl+Z (or Ctrl+Y) can take: back to `was`, with its own undo history.
pub struct ImageStep {
    pub was: Composed,
    pub undoer: TextUndo,
    /// The text and files it's a step from: with anything else in the composer it waits.
    pub from: (String, Vec<PathBuf>),
}

/// egui's undo knows only the text, and its older texts number the images as they were then.
/// So its history starts over wherever images left a composer, and these steps go under it.
#[derive(Default)]
pub struct ImageMemory {
    pub undo: HashMap<i64, Vec<ImageStep>>,
    pub redo: HashMap<i64, Vec<ImageStep>>,
    /// The text last copied or cut out of a composer, and the images its tokens named.
    pub clip: Option<(String, Vec<(usize, PathBuf)>)>,
}

const IMAGE_STEPS: usize = 32;

impl ImageMemory {
    pub fn push(list: &mut Vec<ImageStep>, step: ImageStep) {
        list.push(step);
        if list.len() > IMAGE_STEPS {
            list.remove(0);
        }
    }

    pub fn forget(&mut self, key: i64) {
        self.undo.remove(&key);
        self.redo.remove(&key);
    }
}

/// Which of Ctrl+Z and Ctrl+Y (or Ctrl+Shift+Z) is pressed, as egui's text field reads them.
pub fn undo_keys(i: &egui::InputState) -> (bool, bool) {
    let mut keys = (false, false);
    for e in &i.events {
        if let Event::Key { key, pressed: true, modifiers: m, .. } = e {
            keys.0 |= *key == Key::Z && m.matches_logically(Modifiers::COMMAND) && !m.shift;
            keys.1 |= (*key == Key::Z && m.matches_logically(Modifiers::COMMAND) && m.shift) || (*key == Key::Y && m.matches_logically(Modifiers::COMMAND));
        }
    }
    keys
}

/// The images the tokens of `text` name among `files`: (number, file), each once.
pub fn named_images(text: &str, files: &[PathBuf]) -> Vec<(usize, PathBuf)> {
    let attached: Vec<&PathBuf> = files.iter().filter(|f| crate::images::is_image(&f.to_string_lossy())).collect();
    image_numbers(text).into_iter().filter_map(|n| Some((n, (*attached.get(n - 1)?).clone()))).collect()
}

/// `text` as it pastes into a composer with `files`. What `named` (`ImageMemory::clip`) says it
/// copied keeps its images: one that left the composer comes back, and the tokens take the
/// numbers they have here. Any other token isn't this message's.
pub fn pasted(text: &str, named: &[(usize, PathBuf)], files: &mut Vec<PathBuf>) -> String {
    map_images(text, |n| {
        let path = &named.iter().find(|(k, _)| *k == n)?.1;
        if !files.contains(path) {
            files.push(path.clone());
        }
        files.iter().filter(|f| crate::images::is_image(&f.to_string_lossy())).position(|f| f == path).map(|i| i + 1)
    })
}

// ---------------------------------------------------------------- erased whole

/// The composer remembers what was picked into it from a menu (`@file`, `#12`, `/command`):
/// such a token, like a mentioned chat's title, goes in one erase.
pub fn picked(ctx: &egui::Context, cid: egui::Id, token: &str) {
    let token = token.trim();
    if token.is_empty() {
        return;
    }
    ctx.data_mut(|d| {
        let list = d.get_temp_mut_or_default::<Vec<String>>(cid.with("picked"));
        if !list.iter().any(|t| t == token) {
            list.push(token.to_string());
        }
    });
}

/// The tokens of `text` erased whole, by byte range, in order and apart: every occurrence of
/// `tokens` standing as words of their own (longer ones first).
pub fn whole(text: &str, tokens: &[String]) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = vec![];
    let mut by_len: Vec<&String> = tokens.iter().filter(|t| !t.trim().is_empty()).collect();
    by_len.sort_by_key(|t| std::cmp::Reverse(t.len()));
    for t in by_len {
        for (a, _) in text.match_indices(t.as_str()) {
            let z = a + t.len();
            // A space or the end after it, maybe past punctuation (`@a.` but not `@a.rs`).
            let rest = &text[z..];
            let tail = rest.trim_start_matches(crate::tags::PUNCT);
            let apart = crate::tags::opens(text[..a].chars().next_back()) && tail.chars().next().is_none_or(char::is_whitespace);
            if apart && !out.iter().any(|(s, e)| a < *e && *s < z) {
                out.push((a, z));
            }
        }
    }
    out.sort();
    out
}

/// Backspace (`back`) or Delete at char `cursor` of `text`, when it touches a token erased
/// whole (`spans`, byte ranges): the text without it and the cursor (in chars). Backspace
/// takes it from inside it, at its end, or just after the space that follows it; Delete from
/// its start or inside it. One space stays between the words around it.
pub fn erase(text: &str, cursor: usize, back: bool, spans: &[(usize, usize)]) -> Option<(String, usize)> {
    let c = text.char_indices().nth(cursor).map_or(text.len(), |(b, _)| b);
    let &(a, mut z) = spans.iter().find(|&&(a, z)| {
        if back {
            (a < c && c <= z) || (text[z..].starts_with(' ') && c == z + 1)
        } else {
            a <= c && c < z
        }
    })?;
    if text[z..].starts_with(' ') && (c == z + 1 || a == 0 || text[..a].ends_with(' ')) {
        z += 1;
    }
    let out = format!("{}{}", &text[..a], &text[z..]);
    Some((out, text[..a].chars().count()))
}

/// Before the composer's text field: Backspace or Delete next to a picked token or a mentioned
/// chat's title (`titles`) takes all of it, one key.
pub fn erase_keys(ui: &mut Ui, cid: egui::Id, draft: &mut String, titles: &[(String, String)]) {
    let (back, del) = ui.input(|i| (i.key_pressed(Key::Backspace) && i.modifiers.is_none(), i.key_pressed(Key::Delete) && i.modifiers.is_none()));
    if !back && !del {
        return;
    }
    let ctx = ui.ctx().clone();
    let Some(mut state) = egui::text_edit::TextEditState::load(&ctx, cid) else { return };
    let Some(range) = state.cursor.char_range() else { return };
    if range.primary.index != range.secondary.index {
        return;
    }
    let mut tokens: Vec<String> = ctx.data(|d| d.get_temp::<Vec<String>>(cid.with("picked"))).unwrap_or_default();
    tokens.extend(titles.iter().map(|(t, _)| t.clone()));
    let mut spans = whole(draft, &tokens);
    spans.extend(images(draft).into_iter().map(|(a, z, _)| (a, z)));
    spans.sort();
    let Some((text, at)) = erase(draft, range.primary.index.0, back, &spans) else { return };
    ui.input_mut(|i| i.consume_key(Modifiers::NONE, if back { Key::Backspace } else { Key::Delete }));
    *draft = text;
    state.cursor.set_char_range(Some(egui::text::CCursorRange::one(CCursor::new(at))));
    state.store(&ctx, cid);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(title: &str, gid: &str) -> Mention {
        Mention { item: 0, from: String::new(), at: 0, text: String::new(), len: 0, excerpt: false, note: String::new(), kind: "chat".into(), chat: gid.into(), title: title.into() }
    }

    fn kinds(parts: &[Part]) -> Vec<(String, String)> {
        parts
            .iter()
            .map(|p| {
                let k = match &p.kind {
                    Kind::Plain => "plain".to_string(),
                    Kind::Tag => "tag".into(),
                    Kind::Command => "command".into(),
                    Kind::Chat(g) => format!("chat:{g}"),
                    Kind::Image(n) => format!("image:{n}"),
                };
                (k, p.text.clone())
            })
            .collect()
    }

    #[test]
    fn a_copied_token_brings_its_image_and_any_other_token_names_nothing() {
        let (a, b, c) = (PathBuf::from("/up/a.png"), PathBuf::from("/up/b.png"), PathBuf::from("/up/c.png"));
        let doc = PathBuf::from("/up/d.pdf");
        let mut files = vec![a.clone(), doc.clone(), b.clone()];
        // Numbers count images, so the PDF is no number; a token past the images names nothing.
        assert_eq!(named_images("[Image #2] [Image #1] [Image #2] [Image #3]", &files), [(1, a.clone()), (2, b.clone())]);
        // Cut #1 and #2: the composer went on with c as #1, and they come back after it.
        let named = [(1, a.clone()), (2, b.clone())];
        let mut left = vec![c.clone()];
        assert_eq!(pasted("[Image #2] and [Image #1]", &named, &mut left), "[Image #2] and [Image #3]");
        assert_eq!(left, [c.clone(), b.clone(), a.clone()]);
        // Still here (a copy, not a cut): the same images, at their numbers here, and no twice.
        files.remove(0);
        files.push(a.clone());
        assert_eq!(pasted("[Image #2] [Image #1]", &named, &mut files), "[Image #1] [Image #2]");
        assert_eq!(files.len(), 3);
        // Text from elsewhere names none of them.
        let mut none = vec![a.clone()];
        assert_eq!(pasted("old [Image #1]", &[], &mut none), "old [Image 1]");
        assert_eq!(none, [a.clone()]);
        // One the copy didn't name, either.
        assert_eq!(pasted("[Image #1] [Image #7]", &named, &mut none), "[Image #1] [Image 7]");
    }

    #[test]
    fn finds_commands() {
        let cmds = |s: &str| commands(s).into_iter().map(|(i, n)| s[i..i + n].to_string()).collect::<Vec<_>>();
        assert_eq!(cmds("/review this, then /plugin:skill."), ["/review", "/plugin:skill"]);
        assert_eq!(cmds("see /tmp/x and a/b and //x and /5 and (/compact)"), ["/compact"]);
        assert_eq!(cmds("é /ñ /ok"), ["/ok"]);
    }

    #[test]
    fn a_written_chat_title_is_a_link() {
        let ms = [chat("Fix login", "g1")];
        let p = parts("look at Fix login, then /review @src/a.rs #12", &ms);
        assert_eq!(
            kinds(&p),
            [
                ("plain".to_string(), "look at ".to_string()),
                ("chat:g1".into(), "Fix login".into()),
                ("plain".into(), ", then ".into()),
                ("command".into(), "/review".into()),
                ("plain".into(), " ".into()),
                ("tag".into(), "@src/a.rs".into()),
                ("plain".into(), " ".into()),
                ("tag".into(), "#12".into()),
            ]
        );
        assert_eq!(display(&p), "look at Fix login, then /review @src/a.rs #12");
        assert!(plain(&parts("just words", &[])));
    }

    #[test]
    fn longer_titles_win_and_tags_inside_titles_stay_the_title() {
        let ms = [chat("Fix", "g1"), chat("Fix @login page", "g2")];
        let p = parts("Fix @login page and Fix", &ms);
        assert_eq!(kinds(&p), [("chat:g2".to_string(), "Fix @login page".to_string()), ("plain".into(), " and ".into()), ("chat:g1".into(), "Fix".into())]);
    }

    #[test]
    fn older_messages_show_the_chat_before_the_text() {
        let mut m = chat("Website host", "g1");
        let p = parts("what's its status?", std::slice::from_ref(&m));
        assert_eq!(kinds(&p), [("chat:g1".to_string(), "Website host".to_string()), ("plain".into(), "\nwhat's its status?".into())]);
        m.note = "same bug?".into();
        let p = parts("", std::slice::from_ref(&m));
        assert_eq!(display(&p), "Website host \u{2014} same bug?");
        assert_eq!(display(&parts("", &[chat("Only", "g2")])), "Only");
    }

    #[test]
    fn a_title_taken_out_drops_its_mention() {
        let ms = vec![chat("Fix login", "g1"), chat("Other", "g2"), Mention { kind: String::new(), ..chat("", "") }];
        let left = kept("see Fix login", ms);
        assert_eq!(left.iter().map(|m| m.chat.as_str()).collect::<Vec<_>>(), ["g1", ""]);
    }

    #[test]
    fn long_titles_are_cut_for_the_composer() {
        assert_eq!(label("  Short  "), "Short");
        let l = label(&"word ".repeat(30));
        assert!(l.ends_with('…') && l.chars().count() <= LABEL_CHARS);
    }

    #[test]
    fn the_wire_has_kinds_and_chats() {
        let v = wire(&parts("Fix login /go", &[chat("Fix login", "g1")]));
        assert_eq!(v, json!([{ "text": "Fix login", "kind": "chat", "chat": "g1" }, { "text": " " }, { "text": "/go", "kind": "command" }]));
    }

    #[test]
    fn images_stay_in_the_text_with_their_numbers() {
        let text = "Hey Claude, take a look on this [Image #1] I want to remove that thing I draw over! Image #2 [Image #x] [Image #0]";
        assert_eq!(images(text).len(), 1);
        let p = parts(text, &[]);
        assert_eq!(kinds(&p)[1], ("image:1".to_string(), "[Image #1]".to_string()));
        assert_eq!(display(&p), text, "the text stays the user's own");
        assert_eq!(wire(&parts("[Image #2]", &[])), json!([{ "text": "[Image #2]", "kind": "image", "image": 2 }]));
        assert_eq!(image_numbers("[Image #3] [Image #1] [Image #3]"), [1, 3]);
    }

    #[test]
    fn the_agent_is_told_which_image_each_number_is() {
        let files: Vec<PathBuf> = ["/up/a.png", "/up/notes.txt", "/up/b.JPG"].iter().map(PathBuf::from).collect();
        assert_eq!(image_count(&files), 2);
        assert_eq!(images_prompt("see [Image #2] and [Image #1]", &files), "\n\n[Images in this message, in the order attached:\n- Image #1: /up/a.png\n- Image #2: /up/b.JPG]");
        // No token, or nothing to name: nothing to say.
        assert_eq!(images_prompt("see these", &files), "");
        assert_eq!(images_prompt("see [Image #1]", &files[1..2]), "");
    }

    #[test]
    fn an_image_goes_in_at_the_cursor() {
        assert_eq!(insert_image("", 0, 1), ("[Image #1] ".to_string(), 11));
        // After a word and before one: spaces where it touches them, none doubled.
        assert_eq!(insert_image("look at", 7, 1), ("look at [Image #1] ".to_string(), 19));
        assert_eq!(insert_image("look  there", 5, 2), ("look [Image #2] there".to_string(), 15));
        assert_eq!(insert_image("ab", 1, 1), ("a [Image #1] b".to_string(), 13));
        assert_eq!(insert_image("é", 1, 1).0, "é [Image #1] ");
        // Past the end (a draft that changed under the cursor): at the end.
        assert_eq!(insert_image("a", 9, 1).0, "a [Image #1] ");
    }

    #[test]
    fn an_image_that_leaves_moves_the_later_ones_down() {
        let text = "a [Image #1] b [Image #2] c [Image #3] d";
        let (t, at) = forget_image(text, 2, text.len());
        assert_eq!(t, "a [Image #1] b c [Image #2] d");
        assert_eq!(at, t.len());
        // The cursor keeps its place in the words.
        assert_eq!(forget_image(text, 1, 2).1, 2);
        assert_eq!(forget_image(text, 3, 0).0, "a [Image #1] b [Image #2] c d");
        // Inside the token: where it was.
        assert_eq!(forget_image(text, 2, 18).1, 15);
        // Numbers of two digits grow shorter: the cursor follows.
        assert_eq!(forget_image("[Image #1] [Image #10] x", 1, 24), ("[Image #9] x".to_string(), 12));
        // Its token already gone (erased in the text): only the numbers change.
        assert_eq!(forget_image("[Image #2] x", 1, 0).0, "[Image #1] x");
        assert_eq!(forget_image("[Image #1] ", 1, 11), (String::new(), 0));
    }

    #[test]
    fn merged_drafts_keep_their_images_apart() {
        assert_eq!(shift_images("a [Image #1] b [Image #2]", 3), "a [Image #4] b [Image #5]");
        assert_eq!(without_images("[Image #1] look at [Image #2] this"), "look at this");
        assert_eq!(defuse("see [Image #1], [Image #2] and Image #3"), "see [Image 1], [Image 2] and Image #3");
        assert!(images(&defuse("[Image #12]")).is_empty());
        assert!(crate::tags::tokens(&defuse("[Image #4]")).is_empty());
        assert_eq!(map_images("[Image #3] [Image #1]", |n| (n > 1).then_some(n - 1)), "[Image #2] [Image 1]");
    }

    #[test]
    fn picked_tokens_go_in_one_erase() {
        let toks = vec!["@src/a.rs".to_string(), "#12".to_string(), "/review".to_string(), "Fix login".to_string()];
        let text = "see Fix login and @src/a.rs, #12 /review";
        let sp = whole(text, &toks);
        assert_eq!(sp.iter().map(|&(a, z)| &text[a..z]).collect::<Vec<_>>(), ["Fix login", "@src/a.rs", "#12", "/review"]);
        let at = |s: &str| text.find(s).unwrap();
        // Backspace at its end, inside it, or after the space that follows it.
        assert_eq!(erase(text, at(" and"), true, &sp), Some(("see and @src/a.rs, #12 /review".to_string(), 4)));
        assert_eq!(erase(text, at("login") + 2, true, &sp).map(|r| r.0), Some("see and @src/a.rs, #12 /review".to_string()));
        assert_eq!(erase(text, at(" and") + 1, true, &sp).map(|r| r.0), Some("see and @src/a.rs, #12 /review".to_string()));
        assert_eq!(erase(text, text.len(), true, &sp), Some(("see Fix login and @src/a.rs, #12 ".to_string(), 33)));
        // Delete at its start.
        assert_eq!(erase(text, at("#12"), false, &sp).map(|r| r.0), Some("see Fix login and @src/a.rs, /review".to_string()));
        // Elsewhere: an ordinary key; at its start Backspace isn't in it.
        assert_eq!(erase(text, 2, true, &sp), None);
        assert_eq!(erase(text, at("Fix"), true, &sp), None);
        assert_eq!(erase(text, at(" and"), false, &sp), None);
    }

    #[test]
    fn whole_tokens_stand_apart() {
        let toks = vec!["/review".to_string(), "@a".to_string()];
        assert!(whole("/reviewer and x@a and @ab", &toks).is_empty());
        assert_eq!(whole("(/review) @a.", &toks), [(1, 8), (10, 12)]);
        // After the pick: "token " with the cursor after the space, the text ending there.
        assert_eq!(erase("hi @a ", 6, true, &whole("hi @a ", &toks)), Some(("hi ".to_string(), 3)));
        assert_eq!(erase("é @a", 4, true, &whole("é @a", &toks)), Some(("é ".to_string(), 2)));
    }
}
