//! A user's message as the transcript shows it, on the desktop and the phone alike (the
//! phone gets these parts as the user card's `parts`, api.rs): a chat mentioned with `$`
//! (chatmention.rs) is its title written in the text, drawn as a link to the chat; `@file`
//! and `#123` tags (tags.rs) and `/command`s are blue. The text stays the user's own; this
//! only says which runs of it are what. The composer draws the same runs (tags.rs `layout`).
//!
//! Older messages mention chats without their title in the text: the title goes on a line
//! of its own before it, still a link.

use crate::mentions::Mention;
use crate::theme;
use crate::widgets as w;
use eframe::egui::{self, CursorIcon, Stroke, Ui, text::CCursor};
use serde_json::{Value, json};

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
/// title and its id, every time it's written; longer titles first), then the tags and
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
    let tags = crate::tags::tokens(text).into_iter().map(|(i, n)| (i, i + n, Kind::Tag));
    let cmds = commands(text).into_iter().map(|(i, n)| (i, i + n, Kind::Command));
    for (a, z, k) in tags.chain(cmds).collect::<Vec<_>>() {
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

/// The parts for the phone: `{text}`, or `{text, kind: tag|command|chat, chat}`.
pub fn wire(parts: &[Part]) -> Value {
    Value::Array(
        parts
            .iter()
            .map(|p| match &p.kind {
                Kind::Plain => json!({ "text": p.text }),
                Kind::Tag => json!({ "text": p.text, "kind": "tag" }),
                Kind::Command => json!({ "text": p.text, "kind": "command" }),
                Kind::Chat(gid) => json!({ "text": p.text, "kind": "chat", "chat": gid }),
            })
            .collect(),
    )
}

/// The message drawn as a selectable, wrapping label in the text style `style`: tags and
/// commands blue, chats as underlined links. The chat whose title was clicked, if any.
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
                };
                (k, p.text.clone())
            })
            .collect()
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
}
