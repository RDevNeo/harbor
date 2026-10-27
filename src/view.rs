//! What a chat's transcript shows, card by card. The desktop (chat.rs) draws these cards and
//! the phone API (api.rs) sends them, so a chat looks the same on both: the same items hidden
//! (a lead's coordination), the same footers, labels, dividers and images.

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
    },
    Text { text: &'a str, at: i64, forkable: bool },
    Thinking { text: &'a str },
    Tool { label: String, summary: &'a str, input: &'a str, result: Option<&'a str>, is_error: bool },
    /// The line under a finished turn: "Claude · AB · Opus 5.5 · 4.3s · 189k in (180k cached) · 304 out · $3.96".
    Footer { text: String, at: i64 },
    /// The top of a fork: back to the reply it came from.
    ForkedFrom { chat: i64, seq: usize },
    /// A chat an agent opened (openchat.rs): in the new chat, where it came from; in the
    /// opening chat, the new one. `gid`: the other chat's global id.
    ChatLink { gid: &'a str, text: &'a str },
    Notice {
        icon: &'a str,
        text: &'a str,
        detail: &'a str,
        /// The detail is markdown (an agent's report), not plain text.
        markdown: bool,
        /// A process's address: the notice opens it instead of expanding.
        url: Option<&'a str>,
    },
    Message { from: &'a str, to: &'a str, text: &'a str },
    Error { text: &'a str },
    /// An image or video an agent showed with the `show_media` tool (its input, JSON).
    Media { input: &'a str, caption: String, pending: bool },
}

/// The tool that puts an image or video in the reply.
pub const SHOW_MEDIA: &str = "mcp__harbor__show_media";

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
/// to Harbor, thinking, agents' reports), and so is the text of turns that hand work off
/// (only an acknowledgement), and the footer of turns that said nothing.
pub fn hidden(items: &[Item], lead: bool) -> Vec<bool> {
    let mut out = vec![false; items.len()];
    if !lead {
        return out;
    }
    // Lead turns that hand work off.
    let mut handoff = vec![false; items.len()];
    let mut start = 0;
    for (i, it) in items.iter().enumerate() {
        if matches!(it, Item::Result { .. }) || i + 1 == items.len() {
            let delegated = items[start..=i].iter().any(|x| matches!(x, Item::Tool { name, .. } if name == "mcp__harbor__spawn_agent" || name == "mcp__harbor__message_agent"));
            handoff[start..=i].fill(delegated);
            start = i + 1;
        }
    }
    // Whether the current turn (since the last user message or result) said anything.
    let mut said = false;
    for (i, item) in items.iter().enumerate() {
        out[i] = match item {
            Item::Tool { name, is_error, .. } => name.starts_with("mcp__harbor__") && (name != SHOW_MEDIA || *is_error),
            Item::Thinking { .. } => true,
            Item::Notice { icon, .. } => icon == "bot",
            Item::Text { text, .. } => text.trim().is_empty() || handoff[i],
            Item::Result { .. } => !said,
            _ => false,
        };
        match item {
            Item::Text { text, .. } if !text.trim().is_empty() && !handoff[i] => said = true,
            Item::Result { .. } | Item::User { .. } => said = false,
            _ => {}
        }
    }
    out
}

/// The footer line of a turn; `who` is "Claude · AB · Opus 5.5 · " for its account and model
/// ("" when the account is gone).
pub fn footer(who: &str, cost_usd: f64, duration_ms: u64, input_tokens: u64, output_tokens: u64, cached: u64) -> String {
    use crate::cost::{money, short};
    let cost = money(cost_usd);
    let cost = if cost.is_empty() { cost } else { format!(" · {cost}") };
    let cached = if cached > 0 { format!(" ({} cached)", short(cached)) } else { String::new() };
    format!("{who}{:.1}s · {} in{cached} · {} out{cost}", duration_ms as f64 / 1000.0, short(input_tokens), short(output_tokens))
}

/// The transcript as cards. `who(account, model)` names a turn's account and model for its
/// footer; `forks` are (item index, forked chat) pairs.
pub fn project<'a>(items: &'a [Item], lead: bool, forks: &[(usize, i64)], who: &dyn Fn(&str, &str) -> String) -> Vec<Shown<'a>> {
    let hide = hidden(items, lead);
    let forkable = crate::fork::forkable(items);
    let mut out: Vec<Shown> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let card = if hide[i] { Card::Hidden } else { card(item, forkable[i].is_some(), who) };
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

fn card<'a>(item: &'a Item, forkable: bool, who: &dyn Fn(&str, &str) -> String) -> Card<'a> {
    match item {
        Item::User { text, files, at, mentions, sender } => Card::User {
            text,
            sender,
            files: files.iter().filter(|f| !crate::images::is_image(f)).map(String::as_str).collect(),
            images: files.iter().filter(|f| crate::images::is_image(f)).map(String::as_str).collect(),
            mentions,
            at: *at,
        },
        Item::Text { text, at } => Card::Text { text, at: *at, forkable },
        Item::Thinking { text } => Card::Thinking { text },
        // Shown media; a call that failed stays a tool card, with its error.
        Item::Tool { name, input, result, is_error: false, .. } if name == SHOW_MEDIA => {
            let v: serde_json::Value = serde_json::from_str(input).unwrap_or_default();
            Card::Media { input, caption: v["caption"].as_str().unwrap_or("").to_string(), pending: result.is_none() }
        }
        Item::Tool { name, summary, input, result, is_error, .. } => Card::Tool { label: tool_label(name), summary, input, result: result.as_deref(), is_error: *is_error },
        Item::Result { cost_usd, duration_ms, input_tokens, output_tokens, cached, account, model, at, .. } => {
            Card::Footer { text: footer(&who(account, model), *cost_usd, *duration_ms, *input_tokens, *output_tokens, *cached), at: *at }
        }
        Item::Notice { icon, detail, .. } if icon == "fork" && detail.starts_with("harbor:chat/") => {
            let (c, n) = detail["harbor:chat/".len()..].split_once('/').unwrap_or_default();
            Card::ForkedFrom { chat: c.parse().unwrap_or(0), seq: n.parse().unwrap_or(0) }
        }
        Item::Notice { icon, text, detail } if icon == "chat" && detail.starts_with(crate::openchat::LINK) => {
            Card::ChatLink { gid: &detail[crate::openchat::LINK.len()..], text }
        }
        Item::Notice { icon, text, detail } => Card::Notice {
            icon,
            text,
            detail,
            markdown: icon == "bot" || icon == "report",
            url: (icon == "process" && detail.starts_with("http")).then_some(detail.as_str()),
        },
        Item::Message { from, to, text } => Card::Message { from, to, text },
        Item::Error { text } => Card::Error { text },
    }
}

/// The images and videos a card shows: a user's attached images, what a reply shows
/// (markdown images) or names, what a tool read or wrote, what `show_media` showed. `find`
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
        Card::Media { input, .. } => find(&crate::media::tool_markdown(input)).into_iter().take(1).collect(),
        _ => vec![],
    }
}

/// A lead's turn that delegates, one that answers, and the cards around them (tests here and
/// in api.rs check the desktop's and the phone's projections of it).
#[cfg(test)]
pub fn fixture() -> Vec<Item> {
    let tool = |name: &str, result: Option<&str>| Item::Tool { id: name.into(), name: name.into(), summary: "s".into(), input: "{}".into(), result: result.map(String::from), is_error: false };
    let result = || Item::Result { cost_usd: 3.96342, duration_ms: 4300, turns: 1, input_tokens: 189_400, output_tokens: 304, cached: 180_000, at: 9, account: "claude".into(), model: "claude-opus-5-5".into() };
    vec![
        Item::User { text: "build it".into(), files: vec!["/tmp/shot.png".into(), "/tmp/notes.txt".into()], at: 1, mentions: vec![], sender: String::new() },
        Item::Thinking { text: "hmm".into() },
        tool("mcp__harbor__spawn_agent", Some("ok")),
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
        Card::Footer { .. } => "footer",
        Card::ForkedFrom { .. } => "forked_from",
        Card::ChatLink { .. } => "chat_link",
        Card::Notice { .. } => "notice",
        Card::Message { .. } => "message",
        Card::Error { .. } => "error",
        Card::Media { .. } => "media",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_calls_fold_into_runs() {
        let tool = |id: &str, result: Option<&str>| Item::Tool { id: id.into(), name: "Bash".into(), summary: String::new(), input: "{}".into(), result: result.map(String::from), is_error: false };
        let text = |t: &str| Item::Text { text: t.into(), at: 0 };
        let groups_of = |items: &[Item]| project(items, false, &[], &|_: &str, _: &str| String::new()).iter().map(|s| s.group).collect::<Vec<_>>();
        let mut items = vec![
            Item::User { text: "go".into(), files: vec![], at: 0, mentions: vec![], sender: String::new() },
            Item::Thinking { text: "hmm".into() },
            tool("a", Some("ok")),
            text(""),
            tool("b", Some("ok")),
            text("Done with a and b."),
            tool("c", None),
        ];
        let groups_of_lead = |items: &[Item]| project(items, true, &[], &|_: &str, _: &str| String::new()).iter().map(|s| s.group).collect::<Vec<_>>();
        // A lead's (its thinking and empty text hidden: they don't break the run either).
        assert_eq!(groups_of_lead(&items), [None, None, Some(2), None, Some(2), None, Some(6)]);
        let cards = project(&items, true, &[], &|_: &str, _: &str| String::new());
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
    fn tool_label_accepts_empty_and_non_ascii_names() {
        assert_eq!(tool_label("mcp__harbor__spawn_agent"), "Spawn agent");
        assert_eq!(tool_label("mcp__harbor__"), "mcp__harbor__");
        assert_eq!(tool_label("mcp__harbor__\u{e9}t\u{e9}"), "\u{c9}t\u{e9}");
        assert_eq!(tool_label("mcp__linear__list"), "linear · list");
    }

    #[test]
    fn a_lead_hides_its_coordination() {
        let items = fixture();
        let who = |a: &str, _m: &str| if a == "claude" { "Claude · AB · Opus 5.5 · ".to_string() } else { String::new() };
        let cards = project(&items, true, &[(8, 42)], &who);
        let kinds: Vec<&str> = cards.iter().map(|s| kind(&s.card)).collect();
        assert_eq!(kinds, ["user", "hidden", "hidden", "hidden", "hidden", "message", "hidden", "tool", "text", "footer", "notice", "error"]);
        assert_eq!(cards[9].card, Card::Footer { text: "Claude · AB · Opus 5.5 · 4.3s · 189k in (180k cached) · 304 out · $3.96".into(), at: 9 });
        assert_eq!(cards[8].forks_after, [42]);
        assert!(matches!(cards[8].card, Card::Text { forkable: true, .. }));
        let Card::User { files, images, .. } = &cards[0].card else { panic!() };
        assert_eq!((files.as_slice(), images.as_slice()), (["/tmp/notes.txt"].as_slice(), ["/tmp/shot.png"].as_slice()));
        assert!(matches!(cards[10].card, Card::Notice { url: Some("http://127.0.0.1:3000"), .. }));
        // Not a lead: everything shows.
        assert!(project(&items, false, &[], &who).iter().all(|s| s.card != Card::Hidden));
    }

    #[test]
    fn a_lead_shows_its_agents_report_lines() {
        let items = vec![
            Item::Notice { icon: "bot".into(), text: "api finished".into(), detail: "old".into() },
            Item::Notice { icon: "report".into(), text: "api finished: added tests".into(), detail: "**Added tests.**".into() },
        ];
        let cards = project(&items, true, &[], &|_: &str, _: &str| String::new());
        assert_eq!(cards[0].card, Card::Hidden);
        assert!(matches!(cards[1].card, Card::Notice { text: "api finished: added tests", markdown: true, .. }));
    }

    #[test]
    fn shown_media_is_a_card_even_for_a_lead() {
        let tool = |result: Option<&str>, is_error: bool| Item::Tool { id: "m".into(), name: SHOW_MEDIA.into(), summary: String::new(), input: r#"{"path":"out/demo.mp4","caption":"Demo"}"#.into(), result: result.map(String::from), is_error };
        let items = vec![tool(Some("Shown"), false), tool(None, false), tool(Some("no such file"), true)];
        let cards = project(&items, true, &[], &|_: &str, _: &str| String::new());
        let kinds: Vec<&str> = cards.iter().map(|c| kind(&c.card)).collect();
        // A failed call stays a tool card (a lead hides it, like its other Harbor calls).
        assert_eq!(kinds, ["media", "media", "hidden"]);
        assert_eq!(cards[0].card, Card::Media { input: r#"{"path":"out/demo.mp4","caption":"Demo"}"#, caption: "Demo".into(), pending: false });
        assert!(matches!(cards[1].card, Card::Media { pending: true, .. }));
        // It resolves as the markdown image it stands for; a tool's named files aren't "shown".
        let mut asked = vec![];
        let m = media(&cards[0].card, &mut |t| {
            asked.push(t.to_string());
            vec![Media { path: "/p/out/demo.mp4".into(), caption: "Demo".into(), video: true, shown: true, url: None }]
        });
        assert_eq!((asked[0].as_str(), m.len()), ("![Demo](<out/demo.mp4>)", 1));
        let t = Card::Tool { label: "Bash".into(), summary: "", input: "x", result: None, is_error: false };
        assert!(media(&t, &mut |_| vec![Media { path: "/a.png".into(), caption: String::new(), video: false, shown: true, url: None }]).iter().all(|m| !m.shown));
    }

    #[test]
    fn labels() {
        assert_eq!(tool_label("mcp__harbor__spawn_agent"), "Spawn agent");
        assert_eq!(tool_label("mcp__github__get_pr"), "github · get_pr");
        assert_eq!(tool_label("Bash"), "Bash");
        assert_eq!(footer("", 0.0, 1500, 999, 3, 0), "1.5s · 999 in · 3 out");
        assert_eq!(footer("", 0.004, 1500, 12_400, 3, 12_000), "1.5s · 12.4k in (12k cached) · 3 out · <$0.01");
    }
}
