//! Chat links: `harbor://chat/<gid>`, optionally `?pc=<name>` (the PC the chat lives on). A gid
//! is the same on every PC of the mesh, so one link opens the chat anywhere: in an agent's reply
//! the desktop draws it as a link labelled with the chat's title and the phone as a tappable
//! title (the hub resolves it for the phone: api.rs `chat_links`). Sub-agent chats have links too
//! (they open the sub-agent's view under its lead).
//!
//! Agents get links from list_chats, list_agents and find_chats (team.rs), and the lead's prompt
//! explains them. [`App::link_target`] and [`App::open_link`] are the one place a gid becomes a
//! chat; anything else that names chats by gid (mentions in the composer…) can use them too.

use crate::app::{App, View};
use crate::store::{Chat, Role};
use std::borrow::Cow;

pub const SCHEME: &str = "harbor://chat/";

/// The link of chat `gid`; `pc` (its PC's name) when known.
pub fn link(gid: &str, pc: &str) -> String {
    if pc.is_empty() { format!("{SCHEME}{gid}") } else { format!("{SCHEME}{gid}?pc={}", crate::api::url_encode(pc)) }
}

/// A chat link at the start of `s`: its length, the gid and the `pc` it names.
pub fn parse(s: &str) -> Option<(usize, &str, &str)> {
    let rest = s.strip_prefix(SCHEME)?;
    let n = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).unwrap_or(rest.len());
    if n == 0 || n > 64 {
        return None;
    }
    let gid = &rest[..n];
    let mut len = SCHEME.len() + n;
    let mut pc = "";
    if let Some(q) = rest[n..].strip_prefix("?pc=") {
        let m = q.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '%'))).unwrap_or(q.len());
        // A sentence's full stop after the link isn't part of it.
        pc = q[..m].trim_end_matches('.');
        let m = pc.len();
        len += 4 + m;
    }
    Some((len, gid, pc))
}

/// Every chat link `md` names outside code, in order (bare, `<…>` or `[label](…)`): the whole
/// link as written and its gid.
pub fn links(md: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![];
    for (at, len, _) in sites(md) {
        if let Some((_, gid, _)) = parse(&md[at..at + len]) {
            if !out.iter().any(|(l, _)| l == &md[at..at + len]) {
                out.push((md[at..at + len].to_string(), gid.to_string()));
            }
        }
    }
    out
}

/// Where chat links start in `md` outside code spans and blocks: (byte offset, length, bare).
/// `bare`: not already a markdown link's destination or an autolink.
fn sites(md: &str) -> Vec<(usize, usize, bool)> {
    let mut out = vec![];
    if !md.contains(SCHEME) {
        return out;
    }
    let mut in_code = false;
    let mut i = 0;
    while i < md.len() {
        let rest = &md[i..];
        if rest.starts_with('`') {
            let n = rest.len() - rest.trim_start_matches('`').len();
            in_code = !in_code;
            i += n;
            continue;
        }
        if !in_code {
            if let Some((len, _, _)) = parse(rest) {
                let prev = md[..i].chars().last();
                let bare = !matches!(prev, Some('(' | '<'));
                out.push((i, len, bare));
                i += len;
                continue;
            }
        }
        i += rest.chars().next().map_or(1, char::len_utf8);
    }
    out
}

/// `md` with each bare chat link as a markdown link labelled `title(link)` (its chat's title):
/// what the desktop draws and the phone's blocks carry. Links already in `[label](…)` keep
/// their label; `<…>` autolinks get the title too.
pub fn labelled<'a>(md: &'a str, title: &dyn Fn(&str) -> String) -> Cow<'a, str> {
    let sites = sites(md);
    if sites.is_empty() {
        return md.into();
    }
    let mut out = String::with_capacity(md.len() + 64);
    let mut at = 0;
    for (i, len, bare) in sites {
        let url = &md[i..i + len];
        let auto = md[..i].ends_with('<') && md[i + len..].starts_with('>');
        if !bare && !auto {
            continue;
        }
        let (start, end) = if auto { (i - 1, i + len + 1) } else { (i, i + len) };
        out.push_str(&md[at..start]);
        let label: String = title(url).chars().map(|c| if matches!(c, '[' | ']' | '\\' | '*' | '_' | '`') { format!("\\{c}") } else { c.to_string() }).collect();
        out.push_str(&format!("[{label}]({url})"));
        at = end;
    }
    out.push_str(&md[at..]);
    out.into()
}

/// What a chat link leads to, as this PC sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    /// The chat here (a copy when it lives on another PC); `None`: not here.
    pub id: Option<i64>,
    /// Its title ("Fix login"; a sub-agent's "Fix login › tests"), or why it can't open.
    pub title: String,
    /// Why it can't be opened ("Chat not found", "laptop is offline"); empty when it can.
    pub missing: String,
}

impl App {
    /// The chat's link, naming its PC.
    pub fn chat_link(&self, c: &Chat) -> String {
        link(&c.gid, &self.home_name(c))
    }

    /// A chat's title as links show it: a sub-agent's under its lead's.
    pub fn link_title(&self, c: &Chat) -> String {
        let title = if c.title.trim().is_empty() { "Untitled chat".to_string() } else { c.title.trim().to_string() };
        match (c.role, c.parent.and_then(|p| self.chat(p))) {
            (Role::Sub, Some(lead)) => format!("{} › {}", lead.title.trim(), if c.name.is_empty() { &title } else { &c.name }),
            _ => title,
        }
    }

    /// Where link `url` (a chat link, as written) leads.
    pub fn link_target(&self, url: &str) -> Target {
        let Some((_, gid, pc)) = parse(url) else { return Target { id: None, title: url.to_string(), missing: "Not a chat link".into() } };
        if let Some(c) = self.chats.iter().find(|c| c.gid == gid) {
            return Target { id: Some(c.id), title: self.link_title(c), missing: String::new() };
        }
        let pc = crate::api::url_decode(pc);
        let off = !pc.is_empty() && self.shared().peers.lock().unwrap().values().any(|p| p.name.eq_ignore_ascii_case(&pc) && !p.online);
        let missing = if off { format!("{pc} is offline") } else { "Chat not found".to_string() };
        Target { id: None, title: missing.clone(), missing }
    }

    /// The chat links `md` names, resolved for the phone (api.rs `chat_links`): link as
    /// written → `{title, chat (its id here, or null), missing}`.
    pub fn link_targets(&self, md: &str) -> serde_json::Map<String, serde_json::Value> {
        links(md)
            .into_iter()
            .map(|(url, _)| {
                let t = self.link_target(&url);
                (url, serde_json::json!({ "title": t.title, "chat": t.id, "missing": t.missing }))
            })
            .collect()
    }

    /// Opens the chat link `url` on the desktop; the reason when it can't.
    pub fn open_link(&mut self, url: &str) -> Result<i64, String> {
        let t = self.link_target(url);
        match t.id {
            Some(id) => {
                self.open(View::Chat(id));
                Ok(id)
            }
            None => Err(t.missing),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: &str = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

    #[test]
    fn parses_links() {
        let s = format!("{SCHEME}{G}?pc=desk. Next");
        assert_eq!(parse(&s), Some((SCHEME.len() + G.len() + 8, G, "desk")));
        assert_eq!(parse(&format!("{SCHEME}{G})")), Some((SCHEME.len() + G.len(), G, "")));
        assert_eq!(parse(SCHEME), None);
        assert_eq!(parse("harbor://pair?v=3"), None);
        assert_eq!(link(G, "my pc"), format!("{SCHEME}{G}?pc=my%20pc"));
    }

    #[test]
    fn labels_bare_links_only() {
        let md = format!("See {SCHEME}{G}, or [that one]({SCHEME}abc) and <{SCHEME}{G}?pc=desk>; not `{SCHEME}{G}`.");
        let out = labelled(&md, &|u| if u.contains(G) { "Fix [login]".into() } else { "?".into() });
        assert_eq!(
            out,
            format!("See [Fix \\[login\\]]({SCHEME}{G}), or [that one]({SCHEME}abc) and [Fix \\[login\\]]({SCHEME}{G}?pc=desk); not `{SCHEME}{G}`.")
        );
        let l = links(&md);
        assert_eq!(l.iter().map(|(_, g)| g.as_str()).collect::<Vec<_>>(), [G, "abc", G]);
        assert_eq!(l[2].0, format!("{SCHEME}{G}?pc=desk"));
        assert_eq!(labelled("plain text", &|_| String::new()), "plain text");
    }
}
