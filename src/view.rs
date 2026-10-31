//! What a chat's transcript shows, card by card. The desktop (chat.rs) draws these cards and
//! the phone API (api.rs) sends them, so a chat looks the same on both: the same items hidden
//! (a lead's coordination), the same labels, dividers and images.

use std::borrow::Cow;

use crate::media::Media;
use crate::mentions::Mention;
use crate::store::Item;

/// One transcript item as shown. `Hidden` items take no space (the phone drops them).
#[derive(Debug, Clone, PartialEq)]
pub enum Card<'a> {
    Hidden,
    User {
        text: &'a str,
        /// Attached files that aren't images (shown as a 📎 line each).
        files: Vec<&'a str>,
        /// Attached images (a thumbnail strip).
        images: Vec<&'a str>,
        mentions: &'a [Mention],
        at: i64,
        /// Written on another PC or a phone: its name ("from laptop"); empty when written here.
        sender: &'a str,
        /// "steer" or "promoted" when it steered a running turn (queue.rs); else empty.
        intent: &'a str,
    },
    Text { text: &'a str, at: i64, forkable: bool },
    Thinking { text: &'a str },
    Tool { label: String, summary: &'a str, input: &'a str, result: Option<&'a str>, is_error: bool },
    /// The top of a fork: back to the reply it came from.
    ForkedFrom { chat: i64, seq: usize },
    /// A chat an agent opened (openchat.rs): in the new chat, where it came from; in the
    /// opening chat, the new one. `gid`: the other chat's global id.
    ChatLink { gid: &'a str, text: &'a str },
    Notice {
        icon: &'a str,
        text: Cow<'a, str>,
        detail: Cow<'a, str>,
        /// The detail is markdown (an agent's report), not plain text.
        markdown: bool,
        /// A process's address: the notice opens it instead of expanding.
        url: Option<&'a str>,
    },
    Message { from: &'a str, to: &'a str, text: &'a str },
    Error { text: &'a str },
}

/// What a message offers: the desktop's hover bar, the phone's long-press sheet (served as
/// the card's `actions`, so both list the same ones in the same order).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Copy,
    Quote,
    Fork,
    Mention,
}

impl Action {
    /// Its name on the wire (PROTOCOL.md `actions`).
    pub fn id(self) -> &'static str {
        match self {
            Action::Copy => "copy",
            Action::Quote => "quote",
            Action::Fork => "fork",
            Action::Mention => "mention",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Action::Copy => "Copy",
            Action::Quote => "Quote in reply",
            Action::Fork => "Fork from this response",
            Action::Mention => "Mention in your next message",
        }
    }
}

/// A card's actions, in the hover bar's order: your messages Copy, Quote, Mention; a reply
/// Copy, Fork (once forkable), Mention; tool calls, notices and messages only Mention.
pub fn actions(card: &Card) -> Vec<Action> {
    use Action::*;
    match card {
        Card::User { .. } => vec![Copy, Quote, Mention],
        Card::Text { forkable: true, .. } => vec![Copy, Fork, Mention],
        Card::Text { .. } => vec![Copy, Mention],
        Card::Tool { .. } | Card::Notice { .. } | Card::Message { .. } => vec![Mention],
        _ => vec![],
    }
}

/// An old transcript's `show_media` call: still shown, as a tool card with its file.
const OLD_SHOW_MEDIA: &str = "mcp__harbor__show_media";
/// A lead's tools that hand work off: each leaves a line in its chat ([`handoff`]).
pub const SPAWN_AGENT: &str = "mcp__harbor__spawn_agent";
pub const MESSAGE_AGENT: &str = "mcp__harbor__message_agent";

/// A card and where it is: `seq` is the item's index in the transcript, `forks_after` the
/// chats forked from it ("Conversation fork" dividers drawn right after it).
#[derive(Debug, Clone, PartialEq)]
pub struct Shown<'a> {
    pub seq: usize,
    pub card: Card<'a>,
    pub forks_after: Vec<i64>,
    /// The run of tool calls (and the thinking between them) this card belongs to, shown
    /// folded behind one chevron row: the seq of the run's first card, which stays put while
    /// the run grows. `None` outside a run.
    pub group: Option<usize>,
}

/// "mcp__harbor__spawn_agent" → "Spawn agent"; "mcp__github__get_pr" → "github · get_pr".
pub fn tool_label(name: &str) -> String {
    match name.strip_prefix("mcp__") {
        Some(rest) => {
            let (server, tool) = rest.split_once("__").unwrap_or(("", rest));
            if server == "harbor" {
                let t = tool.replace('_', " ");
                let mut c = t.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    None => name.to_string(),
                }
            } else {
                format!("{server} · {tool}")
            }
        }
        None => name.to_string(),
    }
}

/// Which items a transcript hides. Only a lead's: its coordination is invisible (tool calls
/// to Harbor, thinking, agents' reports). What it says when it hands work off shows, so the
/// user hears what happens next, and so does a line per hand-off ([`handoff`]).
pub fn hidden(items: &[Item], lead: bool) -> Vec<bool> {
    let mut out = vec![false; items.len()];
    if !lead {
        return out;
    }
    for (i, item) in items.iter().enumerate() {
        out[i] = match item {
            Item::Tool { name, is_error, .. } => name.starts_with("mcp__harbor__") && (name != OLD_SHOW_MEDIA || *is_error),
            Item::Thinking { .. } => true,
            Item::Notice { icon, .. } => icon == "bot",
            Item::Text { text, .. } => text.trim().is_empty(),
            _ => false,
        };
    }
    out
}

/// Whether each item is in a turn that answers the user: the user wrote since the last turn
/// ended (a turn an agent's report started is the lead's coordination).
fn answers_user(items: &[Item]) -> Vec<bool> {
    let mut on = false;
    items
        .iter()
        .map(|it| {
            let now = on || matches!(it, Item::User { .. });
            on = now && !matches!(it, Item::Result { .. });
            now
        })
        .collect()
}

/// A lead handing work off, as one line in its chat (its other Harbor calls stay hidden), so
/// a turn that only delegates still shows what happens: "api started: PR status in the
/// footer" for spawn_agent (its `title`, else the task's first sentence), "Sent to api: …" for
/// message_agent in a turn that answers the user. It opens on the whole task or message. A
/// call that failed shows nothing.
fn handoff(item: &Item, answers_user: bool) -> Option<Card<'_>> {
    let Item::Tool { name, input, result, is_error: false, .. } = item else { return None };
    if name != SPAWN_AGENT && !(name == MESSAGE_AGENT && answers_user) {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(input).ok()?;
    let arg = |k: &str| v[k].as_str().unwrap_or("").trim().to_string();
    let (icon, text, detail) = match name.as_str() {
        SPAWN_AGENT => {
            // Its name once spawned (Harbor makes a taken one unique: "api-2").
            let agent = result.as_deref().and_then(|r| r.strip_prefix("Spawned '")?.split_once('\'')).map(|(n, _)| n.to_string()).unwrap_or_else(|| arg("name"));
            let task = arg("task");
            let title = Some(arg("title")).filter(|t| !t.is_empty()).map(|t| crate::agentstrip::headline(&t)).unwrap_or_else(|| crate::agentstrip::headline(&task));
            let who = if agent.is_empty() { "Started".to_string() } else { format!("{agent} started") };
            ("started", if title.is_empty() { who } else { format!("{who}: {title}") }, task)
        }
        _ => {
            let text = arg("text");
            ("sent", format!("Sent to {}: {}", arg("agent"), crate::agentstrip::headline(&text)), text)
        }
    };
    Some(Card::Notice { icon, text: Cow::Owned(text), detail: Cow::Owned(detail), markdown: true, url: None })
}

/// The transcript as cards. `forks` are (item index, forked chat) pairs.
pub fn project<'a>(items: &'a [Item], lead: bool, forks: &[(usize, i64)]) -> Vec<Shown<'a>> {
    let hide = hidden(items, lead);
    let forkable = crate::fork::forkable(items);
    let user = if lead { answers_user(items) } else { vec![] };
    let mut out: Vec<Shown> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let card = if hide[i] {
                // Only a lead hides items; its hand-offs show as a line instead.
                handoff(item, user.get(i).copied().unwrap_or(false)).unwrap_or(Card::Hidden)
            } else {
                card(item, forkable[i].is_some())
            };
            let forks_after = forks.iter().filter(|(at, _)| *at == i).map(|(_, f)| *f).collect();
            Shown { seq: i, card, forks_after, group: None }
        })
        .collect();
    mark_groups(&mut out);
    out
}

/// Marks each run of tool calls: consecutive Tool and Thinking cards (hidden ones in between
/// don't break it) with at least one tool call.
fn mark_groups(cards: &mut [Shown]) {
    let foldable = |c: &Card| matches!(c, Card::Tool { .. } | Card::Thinking { .. } | Card::Hidden);
    let mut i = 0;
    while i < cards.len() {
        let mut j = i;
        while j < cards.len() && foldable(&cards[j].card) {
            j += 1;
        }
        let run = &mut cards[i..j];
        if run.iter().any(|s| matches!(s.card, Card::Tool { .. })) {
            let first = run.iter().find(|s| s.card != Card::Hidden).map(|s| s.seq);
            for s in run.iter_mut().filter(|s| s.card != Card::Hidden) {
                s.group = first;
            }
        }
        i = j.max(i + 1);
    }
}

/// A run of tool calls as its chevron row shows it: how many calls, whether one still runs.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Group {
    pub calls: usize,
    pub pending: bool,
}

/// Each run's row, by its id ([`Shown::group`]).
pub fn groups(cards: &[Shown]) -> std::collections::HashMap<usize, Group> {
    let mut out = std::collections::HashMap::<usize, Group>::new();
    for s in cards {
        if let (Some(g), Card::Tool { result, .. }) = (s.group, &s.card) {
            let e = out.entry(g).or_default();
            e.calls += 1;
            e.pending |= result.is_none();
        }
    }
    out
}

/// "1 tool call", "5 tool calls".
pub fn group_label(calls: usize) -> String {
    format!("{calls} tool call{}", if calls == 1 { "" } else { "s" })
}

fn card<'a>(item: &'a Item, forkable: bool) -> Card<'a> {
    match item {
        Item::User { text, files, at, mentions, sender, intent } => Card::User {
            text,
            sender,
            intent,
            files: files.iter().filter(|f| !crate::images::is_image(f)).map(String::as_str).collect(),
            images: files.iter().filter(|f| crate::images::is_image(f)).map(String::as_str).collect(),
            mentions,
            at: *at,
        },
        Item::Text { text, at } => Card::Text { text, at: *at, forkable },
        Item::Thinking { text } => Card::Thinking { text },
        Item::Tool { name, summary, input, result, is_error, .. } => Card::Tool { label: tool_label(name), summary, input, result: result.as_deref(), is_error: *is_error },
        // A turn's end draws nothing: its usage line ("4.3s · 189k in · $3.96") stays in Usage.
        Item::Result { .. } => Card::Hidden,
        Item::Notice { icon, detail, .. } if icon == "fork" && detail.starts_with("harbor:chat/") => {
            let (c, n) = detail["harbor:chat/".len()..].split_once('/').unwrap_or_default();
            Card::ForkedFrom { chat: c.parse().unwrap_or(0), seq: n.parse().unwrap_or(0) }
        }
        Item::Notice { icon, text, detail } if icon == "chat" && detail.starts_with(crate::openchat::LINK) => {
            Card::ChatLink { gid: &detail[crate::openchat::LINK.len()..], text }
        }
        Item::Notice { icon, text, detail } => Card::Notice {
            icon,
            text: Cow::Borrowed(text),
            detail: Cow::Borrowed(detail),
            markdown: icon == "bot" || icon == "report",
            url: (icon == "process" && detail.starts_with("http")).then_some(detail.as_str()),
        },
        Item::Message { from, to, text } => Card::Message { from, to, text },
        Item::Error { text } => Card::Error { text },
    }
}

/// The images and videos a card shows: a user's attached images, what a reply shows
/// (markdown images) or names, what a tool read or wrote. `find`
/// lists the media of a text (media.rs `find`, resolved against the chat's folder).
pub fn media(card: &Card, find: &mut dyn FnMut(&str) -> Vec<Media>) -> Vec<Media> {
    match card {
        Card::User { images, .. } => images.iter().map(|s| Media { path: s.to_string(), caption: String::new(), video: false, shown: false, url: None }).collect(),
        Card::Text { text, .. } => find(text),
        Card::Tool { input, result, is_error: false, .. } => {
            let mut all = find(input);
            for m in result.map(|r| find(r)).unwrap_or_default() {
                if !all.iter().any(|x| x.path == m.path) {
                    all.push(m);
                }
            }
            // A tool's text names files; it doesn't show them on purpose.
            all.iter_mut().for_each(|m| m.shown = false);
            all
        }
        _ => vec![],
    }
}

/// The images of one card in the order they show (its large ones, then its strip), each once:
/// what the image viewer browses with ← → or a swipe, whichever of them it opened on. The phone
/// builds the same list from the card's `media` and `images` (PROTOCOL.md).
pub fn gallery(card: &Card, find: &mut dyn FnMut(&str) -> Vec<Media>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let media = media(card, find);
    let images = media.iter().filter(|m| !m.video);
    images.clone().filter(|m| m.shown).chain(images.filter(|m| !m.shown)).filter(|m| seen.insert(m.path.clone())).map(|m| m.path.clone()).collect()
}

/// A lead's turn that delegates, one that answers, and the cards around them (tests here and
/// in api.rs check the desktop's and the phone's projections of it).
#[cfg(test)]
pub fn fixture() -> Vec<Item> {
    let tool = |name: &str, result: Option<&str>| Item::Tool { id: name.into(), name: name.into(), summary: "s".into(), input: "{}".into(), result: result.map(String::from), is_error: false };
    let result = || Item::Result { cost_usd: 3.96342, duration_ms: 4300, turns: 1, input_tokens: 189_400, output_tokens: 304, cached: 180_000, at: 9, account: "claude".into(), model: "claude-opus-5-5".into() };
    vec![
        Item::User { text: "build it".into(), files: vec!["/tmp/shot.png".into(), "/tmp/notes.txt".into()], at: 1, mentions: vec![], sender: String::new(), intent: String::new() },
        Item::Thinking { text: "hmm".into() },
        Item::Tool {
            id: "s".into(),
            name: SPAWN_AGENT.into(),
            summary: "s".into(),
            input: r#"{"name":"worker","title":"Build it","task":"Build it.\n\nAll the details."}"#.into(),
            result: Some("Spawned 'worker' on Claude / Opus 5.5. It reports back to you when its turn ends.".into()),
            is_error: false,
        },
        Item::Text { text: "Started a worker.".into(), at: 2 },
        result(),
        Item::Message { from: "worker".into(), to: "lead".into(), text: "done".into() },
        Item::Notice { icon: "bot".into(), text: "worker reported".into(), detail: "**report**".into() },
        tool("Bash", Some("ok")),
        Item::Text { text: "All done.".into(), at: 3 },
        result(),
        Item::Notice { icon: "process".into(), text: "dev".into(), detail: "http://127.0.0.1:3000".into() },
        Item::Error { text: "boom".into() },
    ]
}

/// A card's kind as the phone API names it.
pub fn kind(c: &Card) -> &'static str {
    match c {
        Card::Hidden => "hidden",
        Card::User { .. } => "user",
        Card::Text { .. } => "text",
        Card::Thinking { .. } => "thinking",
        Card::Tool { .. } => "tool",
        Card::ForkedFrom { .. } => "forked_from",
        Card::ChatLink { .. } => "chat_link",
        Card::Notice { .. } => "notice",
        Card::Message { .. } => "message",
        Card::Error { .. } => "error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_calls_fold_into_runs() {
        let tool = |id: &str, result: Option<&str>| Item::Tool { id: id.into(), name: "Bash".into(), summary: String::new(), input: "{}".into(), result: result.map(String::from), is_error: false };
        let text = |t: &str| Item::Text { text: t.into(), at: 0 };
        let groups_of = |items: &[Item]| project(items, false, &[]).iter().map(|s| s.group).collect::<Vec<_>>();
        let mut items = vec![
            Item::User { text: "go".into(), files: vec![], at: 0, mentions: vec![], sender: String::new(), intent: String::new() },
            Item::Thinking { text: "hmm".into() },
            tool("a", Some("ok")),
            text(""),
            tool("b", Some("ok")),
            text("Done with a and b."),
            tool("c", None),
        ];
        let groups_of_lead = |items: &[Item]| project(items, true, &[]).iter().map(|s| s.group).collect::<Vec<_>>();
        // A lead's (its thinking and empty text hidden: they don't break the run either).
        assert_eq!(groups_of_lead(&items), [None, None, Some(2), None, Some(2), None, Some(6)]);
        let cards = project(&items, true, &[]);
        let g = groups(&cards);
        assert_eq!((g[&2], g[&6]), (Group { calls: 2, pending: false }, Group { calls: 1, pending: true }));
        assert_eq!((group_label(1), group_label(5)), ("1 tool call".to_string(), "5 tool calls".to_string()));
        // The run grows; its id stays its first card's seq.
        items.push(tool("d", Some("ok")));
        assert_eq!(groups_of_lead(&items)[6..], [Some(6), Some(6)]);
        // Others' thinking folds in with the calls; alone it doesn't.
        assert_eq!(groups_of(&items[..3]), [None, Some(1), Some(1)]);
        assert_eq!(groups_of(&[Item::Thinking { text: "x".into() }, text("hi")]), [None, None]);
    }

    #[test]
    fn the_gallery_is_one_cards_images_each_once_in_the_order_they_show() {
        let m = |path: &str, shown: bool, video: bool| Media { path: path.into(), caption: String::new(), video, shown, url: None };
        let items = vec![
            Item::User { text: "look".into(), files: vec!["/p/a.png".into(), "/p/notes.txt".into(), "/p/b.png".into()], at: 0, mentions: vec![], sender: String::new(), intent: String::new() },
            Item::Text { text: "reply".into(), at: 0 },
            Item::Tool { id: "t".into(), name: "Read".into(), summary: String::new(), input: "read".into(), result: Some("read".into()), is_error: false },
            Item::Text { text: "reply".into(), at: 0 },
            Item::Result { cost_usd: 0.0, duration_ms: 0, turns: 1, input_tokens: 0, output_tokens: 0, cached: 0, at: 0, account: String::new(), model: String::new() },
        ];
        let cards = project(&items, false, &[]);
        let mut find = |t: &str| match t {
            // A reply names a file first and shows two (and a video): the shown ones come first.
            "reply" => vec![m("/p/named.png", false, false), m("/p/c.png", true, false), m("/p/run.mp4", true, true), m("/p/d.png", true, false), m("/p/c.png", false, false)],
            "read" => vec![m("/p/e.png", true, false)],
            _ => vec![],
        };
        // Each card alone: a message's own images, nothing of the cards around it.
        assert_eq!(gallery(&cards[0].card, &mut find), ["/p/a.png", "/p/b.png"]);
        assert_eq!(gallery(&cards[1].card, &mut find), ["/p/c.png", "/p/d.png", "/p/named.png"]);
        assert_eq!(gallery(&cards[2].card, &mut find), ["/p/e.png"]);
        assert!(gallery(&cards[4].card, &mut find).is_empty());
    }

    #[test]
    fn tool_label_accepts_empty_and_non_ascii_names() {
        assert_eq!(tool_label("mcp__harbor__spawn_agent"), "Spawn agent");
        assert_eq!(tool_label("mcp__harbor__"), "mcp__harbor__");
        assert_eq!(tool_label("mcp__harbor__\u{e9}t\u{e9}"), "\u{c9}t\u{e9}");
        assert_eq!(tool_label("mcp__linear__list"), "linear · list");
    }

    #[test]
    fn a_lead_hides_its_coordination() {
        let items = fixture();
        let cards = project(&items, true, &[(8, 42)]);
        let kinds: Vec<&str> = cards.iter().map(|s| kind(&s.card)).collect();
        assert_eq!(kinds, ["user", "hidden", "notice", "text", "hidden", "message", "hidden", "tool", "text", "hidden", "notice", "error"]);
        // The hand-off is one line that opens on the task.
        let Card::Notice { icon, text, detail, markdown, url } = &cards[2].card else { panic!() };
        assert_eq!((*icon, text.as_ref(), detail.as_ref(), *markdown, *url), ("started", "worker started: Build it", "Build it.\n\nAll the details.", true, None));
        assert_eq!(cards[8].forks_after, [42]);
        assert!(matches!(cards[8].card, Card::Text { forkable: true, .. }));
        let Card::User { files, images, .. } = &cards[0].card else { panic!() };
        assert_eq!((files.as_slice(), images.as_slice()), (["/tmp/notes.txt"].as_slice(), ["/tmp/shot.png"].as_slice()));
        assert!(matches!(cards[10].card, Card::Notice { url: Some("http://127.0.0.1:3000"), .. }));
        // Not a lead: everything shows but the ends of turns (no usage line in the chat).
        assert!(project(&items, false, &[]).iter().zip(&items).all(|(s, it)| (s.card == Card::Hidden) == matches!(it, Item::Result { .. })));
    }

    #[test]
    fn a_lead_shows_its_agents_report_lines() {
        let items = vec![
            Item::Notice { icon: "bot".into(), text: "api finished".into(), detail: "old".into() },
            Item::Notice { icon: "report".into(), text: "api finished: added tests".into(), detail: "**Added tests.**".into() },
        ];
        let cards = project(&items, true, &[]);
        assert_eq!(cards[0].card, Card::Hidden);
        assert!(matches!(&cards[1].card, Card::Notice { text, markdown: true, .. } if text == "api finished: added tests"));
    }

    #[test]
    fn a_lead_says_what_it_handed_off() {
        let call = |name: &str, input: &str, result: Option<&str>, is_error: bool| Item::Tool { id: name.into(), name: name.into(), summary: String::new(), input: input.into(), result: result.map(String::from), is_error };
        let user = Item::User { text: "go".into(), files: vec![], at: 0, mentions: vec![], sender: String::new(), intent: String::new() };
        let end = Item::Result { cost_usd: 0.0, duration_ms: 0, turns: 1, input_tokens: 0, output_tokens: 0, cached: 0, at: 0, account: String::new(), model: String::new() };
        let text_of = |c: &Card| match c {
            Card::Notice { text, .. } => text.to_string(),
            c => kind(c).to_string(),
        };
        let items = vec![
            user.clone(),
            // No title: the task's first sentence; the name Harbor gave it once spawned.
            call(SPAWN_AGENT, &serde_json::json!({ "name": "api", "task": "## Task\n**Add** the `status` field. Then test it." }).to_string(), Some("Spawned 'api-2' on Claude / Opus 5.5."), false),
            // Still starting: the name it asked for.
            call(SPAWN_AGENT, r#"{"name":"ui","title":"PR status in the footer","task":"x"}"#, None, false),
            call(SPAWN_AGENT, r#"{"name":"db","task":"x"}"#, Some("unknown account"), true),
            call(MESSAGE_AGENT, r#"{"agent":"api","text":"Also make it blue. Thanks."}"#, Some("ok"), false),
            call("mcp__harbor__list_agents", "{}", Some("ok"), false),
            end.clone(),
            // A turn an agent's report started: its messages are coordination, its spawns not.
            Item::Notice { icon: "report".into(), text: "api finished".into(), detail: String::new() },
            call(MESSAGE_AGENT, r#"{"agent":"api","text":"Now the docs."}"#, Some("ok"), false),
            call(SPAWN_AGENT, r#"{"name":"docs","task":"Write the docs."}"#, Some("Spawned 'docs' on Claude / Opus 5.5."), false),
            end,
        ];
        let shown: Vec<String> = project(&items, true, &[]).iter().map(|s| text_of(&s.card)).collect();
        assert_eq!(
            shown,
            [
                "user",
                "api-2 started: Add the status field",
                "ui started: PR status in the footer",
                "hidden",
                "Sent to api: Also make it blue",
                "hidden",
                "hidden",
                "api finished",
                "hidden",
                "docs started: Write the docs",
                "hidden"
            ]
        );
        // Not a lead: its tool calls are tool cards.
        assert!(project(&items, false, &[]).iter().all(|s| !matches!(&s.card, Card::Notice { icon, .. } if *icon == "started" || *icon == "sent")));
    }

    #[test]
    fn an_old_show_media_call_is_a_tool_card_with_its_file() {
        let tool = |result: Option<&str>, is_error: bool| Item::Tool { id: "m".into(), name: OLD_SHOW_MEDIA.into(), summary: String::new(), input: r#"{"path":"out/demo.png","caption":"Demo"}"#.into(), result: result.map(String::from), is_error };
        let items = vec![tool(Some("Shown in the chat: /p/out/demo.png (image, 0.1 MB)."), false), tool(Some("no such file"), true)];
        let cards = project(&items, true, &[]);
        let kinds: Vec<&str> = cards.iter().map(|c| kind(&c.card)).collect();
        // A lead hides its Harbor calls, but not this one (unless it failed).
        assert_eq!(kinds, ["tool", "hidden"]);
        // Its file, from the call's answer, as a thumbnail: a tool's named files aren't "shown".
        let mut asked = vec![];
        let m = media(&cards[0].card, &mut |t| {
            asked.push(t.to_string());
            vec![Media { path: "/p/out/demo.png".into(), caption: String::new(), video: false, shown: true, url: None }]
        });
        assert!(asked.iter().any(|a| a.contains("/p/out/demo.png")));
        assert_eq!(m.len(), 1);
        assert!(!m[0].shown);
    }

    #[test]
    fn labels() {
        assert_eq!(tool_label("mcp__harbor__spawn_agent"), "Spawn agent");
        assert_eq!(tool_label("mcp__github__get_pr"), "github · get_pr");
        assert_eq!(tool_label("Bash"), "Bash");
    }
}
