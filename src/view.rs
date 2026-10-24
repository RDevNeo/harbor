//! What a chat's transcript shows, card by card. The desktop (chat.rs) draws these cards and
//! the phone API (api.rs) sends them, so a chat looks the same on both: the same items hidden
//! (a lead's coordination), the same footers, labels, dividers and images.

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
    /// The line under a finished turn: "Claude · AB · Opus 5.5 · 4.3s · 189k in · 304 out · $3.9634".
    Footer { text: String, at: i64 },
    /// The top of a fork: back to the reply it came from.
    ForkedFrom { chat: i64, seq: usize },
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
}

/// A card and where it is: `seq` is the item's index in the transcript, `forks_after` the
/// chats forked from it ("Conversation fork" dividers drawn right after it).
#[derive(Debug, Clone, PartialEq)]
pub struct Shown<'a> {
    pub seq: usize,
    pub card: Card<'a>,
    pub forks_after: Vec<i64>,
}

/// "mcp__harbor__spawn_agent" → "Spawn agent"; "mcp__github__get_pr" → "github · get_pr".
pub fn tool_label(name: &str) -> String {
    match name.strip_prefix("mcp__") {
        Some(rest) => {
            let (server, tool) = rest.split_once("__").unwrap_or(("", rest));
            if server == "harbor" {
                let t = tool.replace('_', " ");
                t[..1].to_uppercase() + &t[1..]
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
            Item::Tool { name, .. } => name.starts_with("mcp__harbor__"),
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
pub fn footer(who: &str, cost_usd: f64, duration_ms: u64, input_tokens: u64, output_tokens: u64) -> String {
    let cost = if cost_usd > 0.0 { format!(" · ${cost_usd:.4}") } else { String::new() };
    format!("{who}{:.1}s · {}k in · {} out{cost}", duration_ms as f64 / 1000.0, input_tokens / 1000, output_tokens)
}

/// The transcript as cards. `who(account, model)` names a turn's account and model for its
/// footer; `forks` are (item index, forked chat) pairs.
pub fn project<'a>(items: &'a [Item], lead: bool, forks: &[(usize, i64)], who: &dyn Fn(&str, &str) -> String) -> Vec<Shown<'a>> {
    let hide = hidden(items, lead);
    let forkable = crate::fork::forkable(items);
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let card = if hide[i] { Card::Hidden } else { card(item, forkable[i].is_some(), who) };
            let forks_after = forks.iter().filter(|(at, _)| *at == i).map(|(_, f)| *f).collect();
            Shown { seq: i, card, forks_after }
        })
        .collect()
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
        Item::Tool { name, summary, input, result, is_error, .. } => Card::Tool { label: tool_label(name), summary, input, result: result.as_deref(), is_error: *is_error },
        Item::Result { cost_usd, duration_ms, input_tokens, output_tokens, account, model, at, .. } => {
            Card::Footer { text: footer(&who(account, model), *cost_usd, *duration_ms, *input_tokens, *output_tokens), at: *at }
        }
        Item::Notice { icon, detail, .. } if icon == "fork" && detail.starts_with("harbor:chat/") => {
            let (c, n) = detail["harbor:chat/".len()..].split_once('/').unwrap_or_default();
            Card::ForkedFrom { chat: c.parse().unwrap_or(0), seq: n.parse().unwrap_or(0) }
        }
        Item::Notice { icon, text, detail } => Card::Notice {
            icon,
            text,
            detail,
            markdown: icon == "bot",
            url: (icon == "process" && detail.starts_with("http")).then_some(detail.as_str()),
        },
        Item::Message { from, to, text } => Card::Message { from, to, text },
        Item::Error { text } => Card::Error { text },
    }
}

/// The images a card shows under it: a user's attached ones, the files a reply names, the
/// images a tool read or wrote. `find` lists the image files a text names.
pub fn images(card: &Card, find: &mut dyn FnMut(&str) -> Vec<String>) -> Vec<String> {
    match card {
        Card::User { images, .. } => images.iter().map(|s| s.to_string()).collect(),
        Card::Text { text, .. } => find(text),
        Card::Tool { input, result, is_error: false, .. } => {
            let mut paths = find(input);
            for p in result.map(|r| find(r)).unwrap_or_default() {
                if !paths.contains(&p) {
                    paths.push(p);
                }
            }
            paths
        }
        _ => vec![],
    }
}

/// A lead's turn that delegates, one that answers, and the cards around them (tests here and
/// in api.rs check the desktop's and the phone's projections of it).
#[cfg(test)]
pub fn fixture() -> Vec<Item> {
    let tool = |name: &str, result: Option<&str>| Item::Tool { id: name.into(), name: name.into(), summary: "s".into(), input: "{}".into(), result: result.map(String::from), is_error: false };
    let result = || Item::Result { cost_usd: 3.96342, duration_ms: 4300, turns: 1, input_tokens: 189_400, output_tokens: 304, at: 9, account: "claude".into(), model: "claude-opus-5-5".into() };
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
        Card::Notice { .. } => "notice",
        Card::Message { .. } => "message",
        Card::Error { .. } => "error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lead_hides_its_coordination() {
        let items = fixture();
        let who = |a: &str, _m: &str| if a == "claude" { "Claude · AB · Opus 5.5 · ".to_string() } else { String::new() };
        let cards = project(&items, true, &[(8, 42)], &who);
        let kinds: Vec<&str> = cards.iter().map(|s| kind(&s.card)).collect();
        assert_eq!(kinds, ["user", "hidden", "hidden", "hidden", "hidden", "message", "hidden", "tool", "text", "footer", "notice", "error"]);
        assert_eq!(cards[9].card, Card::Footer { text: "Claude · AB · Opus 5.5 · 4.3s · 189k in · 304 out · $3.9634".into(), at: 9 });
        assert_eq!(cards[8].forks_after, [42]);
        assert!(matches!(cards[8].card, Card::Text { forkable: true, .. }));
        let Card::User { files, images, .. } = &cards[0].card else { panic!() };
        assert_eq!((files.as_slice(), images.as_slice()), (["/tmp/notes.txt"].as_slice(), ["/tmp/shot.png"].as_slice()));
        assert!(matches!(cards[10].card, Card::Notice { url: Some("http://127.0.0.1:3000"), .. }));
        // Not a lead: everything shows.
        assert!(project(&items, false, &[], &who).iter().all(|s| s.card != Card::Hidden));
    }

    #[test]
    fn labels() {
        assert_eq!(tool_label("mcp__harbor__spawn_agent"), "Spawn agent");
        assert_eq!(tool_label("mcp__github__get_pr"), "github · get_pr");
        assert_eq!(tool_label("Bash"), "Bash");
        assert_eq!(footer("", 0.0, 1500, 999, 3), "1.5s · 0k in · 3 out");
    }
}
