//! Fork (as in T3 Code): "Fork from this response" on a finished assistant reply
//! starts a new thread in the same project with the conversation up to the end of
//! that turn, and opens it with an empty composer. Nothing is sent until the user
//! writes. Dividers link the two: "Forked from conversation" at the top of the
//! fork, "Conversation fork" in the source where it branched.
//!
//! The agent keeps that history for real. A Claude session is forked on disk: its
//! JSONL is copied under a new session id, cut right after the forked message
//! (found by walking the transcript's messages and tool calls through the file),
//! and the new thread resumes it. Other providers, or a session that can't be
//! matched, get the conversation as a preamble with the first message, kept in the
//! store until then and never shown.

use crate::app::{App, Transcript, View};
use crate::icons as ic;
use crate::providers::Kind;
use crate::store::{self, Chat, Item, Role};
use crate::widgets as w;
use eframe::egui::{self, CursorIcon, FontId, Sense, Stroke, Ui, Vec2, pos2};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// Store key of a fork's preamble, waiting for its first message.
fn preamble_key(chat_id: i64) -> String {
    format!("fork_preamble_{chat_id}")
}

/// Store key of a chat's forks: JSON [[item, fork chat id], …].
fn forks_key(chat_id: i64) -> String {
    format!("forks_of_{chat_id}")
}

/// Per source chat, its forks (the item they branch after, the fork), read lazily.
#[derive(Default)]
pub struct State {
    of: HashMap<i64, Vec<(usize, i64)>>,
}

/// For each item, the end of its turn when it's the last reply of a finished turn
/// (the item a fork from it includes up to). Running turns can't be forked.
pub fn forkable(items: &[Item]) -> Vec<Option<usize>> {
    let mut out = vec![None; items.len()];
    let mut last = None;
    for (i, it) in items.iter().enumerate() {
        match it {
            Item::Text { text, .. } if !text.trim().is_empty() => last = Some(i),
            Item::Result { .. } => {
                if let Some(t) = last.take() {
                    out[t] = Some(i);
                }
            }
            Item::User { .. } => last = None,
            _ => {}
        }
    }
    out
}

/// A full-width divider: a line with "label · link" in the middle. True when the link is clicked.
pub fn divider(ui: &mut Ui, label: &str, link: &str) -> bool {
    let t = w::tokens(ui);
    let font = FontId::proportional(12.5);
    let lg = ui.painter().layout_no_wrap(format!("{}  {label}  ·  ", ic::FORK), font.clone(), t.subtle());
    let kg = ui.painter().layout_no_wrap(link.to_string(), font, t.fg());
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 22.0), Sense::hover());
    let width = lg.size().x + kg.size().x;
    let x0 = rect.center().x - width / 2.0;
    let y = rect.center().y;
    let stroke = Stroke::new(1.0, t.border());
    ui.painter().hline(rect.left()..=x0 - 12.0, y, stroke);
    ui.painter().hline(x0 + width + 12.0..=rect.right(), y, stroke);
    ui.painter().galley(pos2(x0, y - lg.size().y / 2.0), lg.clone(), t.subtle());
    let kr = egui::Rect::from_min_size(pos2(x0 + lg.size().x, y - kg.size().y / 2.0), kg.size());
    let resp = ui.interact(kr.expand(3.0), ui.scope_id().with(("fork-link", link, rect.top() as i64)), Sense::click());
    ui.painter().galley(kr.min, kg, t.fg());
    if resp.hovered() {
        ui.painter().hline(kr.x_range(), kr.bottom() + 1.0, Stroke::new(1.0, t.fg()));
    }
    resp.on_hover_cursor(CursorIcon::PointingHand).clicked()
}

impl App {
    /// The forks made from `chat_id`: (item they branch after, fork chat).
    pub fn forks_of(&mut self, chat_id: i64) -> Vec<(usize, i64)> {
        if !self.forks.of.contains_key(&chat_id) {
            let list: Vec<(usize, i64)> = self.store.get(&forks_key(chat_id)).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            self.forks.of.insert(chat_id, list);
        }
        let ids: Vec<i64> = self.chats.iter().map(|c| c.id).collect();
        self.forks.of[&chat_id].iter().filter(|(_, f)| ids.contains(f)).copied().collect()
    }

    /// "Fork from this response": forks `chat_id` after the turn of reply `reply`
    /// into a new thread and opens it.
    pub fn fork_from(&mut self, chat_id: i64, reply: usize) {
        // Another PC's chat forks there (its session is on that PC); the fork opens when copied.
        if self.mesh_fork(chat_id, reply) {
            return;
        }
        let Some(src) = self.chat(chat_id).cloned() else { return };
        let Some(upto) = self.transcripts.get(&chat_id).and_then(|t| forkable(&t.items).get(reply).copied().flatten()) else { return };
        let Some(items) = self.transcripts.get(&chat_id).map(|t| t.items[..=upto].to_vec()) else { return };
        let account = self.account(&src.account).cloned();
        let claude = account.as_ref().is_some_and(|a| a.kind == Kind::Claude);
        let session_id = if claude || account.as_ref().is_some_and(|a| matches!(a.kind, Kind::Grok | Kind::Meta)) { store::new_uuid() } else { String::new() };
        // Claude: the session file, cut at the message, under the new id.
        let forked = claude
            && src.started
            && crate::undo::session_file(&account.as_ref().and_then(|a| a.config_dir.clone()), &src.session_id)
                .is_some_and(|f| fork_jsonl(&f, &session_id, &items).is_ok());
        let title = if src.role == Role::Sub && !src.name.is_empty() { format!("{} · {}", src.name, src.title) } else { src.title.clone() };
        let chat = self.store.create_chat(Chat {
            id: 0,
            repo_id: src.repo_id,
            title: format!("{} fork", title.chars().take(60).collect::<String>()),
            session_id,
            started: forked,
            account: src.account.clone(),
            model: src.model.clone(),
            effort: src.effort.clone(),
            access: src.access.clone(),
            settled: false,
            updated: store::now(),
            role: Role::Lead,
            parent: None,
            name: "lead".into(),
            device: src.device.clone(),
            gid: String::new(), home: String::new(), home_id: 0,
        });
        let id = chat.id;
        self.chats.push(chat);
        if !forked {
            let context: Vec<String> = items.iter().filter(|i| !matches!(i, Item::Thinking { .. } | Item::Result { .. })).map(crate::team::render_item).collect();
            let context = crate::app::clip(&context.join("\n"), 40_000);
            self.store.set(
                &preamble_key(id),
                &format!("This conversation is a fork of an earlier one. Here it is so far; continue from it with the user's next message.\n\n{context}\n\n---\n\n"),
            );
        }
        // The divider links back to the reply; the copied items move down by one.
        let mut copy = vec![Item::Notice { icon: "fork".into(), text: "Forked from conversation".into(), detail: format!("harbor:chat/{chat_id}/{reply}") }];
        copy.extend(items.into_iter().map(|mut it| {
            if let Item::User { mentions, .. } = &mut it {
                for m in mentions {
                    m.item += 1;
                }
            }
            it
        }));
        self.store.save_items(id, &copy);
        let mut list = self.forks_of(chat_id);
        list.push((upto, id));
        self.store.set(&forks_key(chat_id), &serde_json::to_string(&list).unwrap_or_default());
        self.forks.of.insert(chat_id, list);
        self.transcripts.insert(id, Transcript { items: copy, ..Default::default() });
        self.drafts.remove(&id);
        self.open(View::Chat(id));
    }

    /// A fork's preamble for its first message (once), or "".
    pub fn take_fork_preamble(&mut self, chat_id: i64) -> String {
        let k = preamble_key(chat_id);
        let p = self.store.get(&k).unwrap_or_default();
        if !p.is_empty() {
            self.store.set(&k, "");
        }
        p
    }
}

/// What in the session file stands for a transcript item.
enum Anchor<'a> {
    User(&'a str),
    Text(&'a str),
    /// A tool call; with its result, the line carrying the result.
    Tool(&'a str, bool),
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn matches(line: &Value, a: &Anchor) -> bool {
    let kind = line["type"].as_str().unwrap_or("");
    let content = &line["message"]["content"];
    let blocks = content.as_array().map(|v| v.as_slice()).unwrap_or(&[]);
    match a {
        // The prompt Harbor sent holds the message (after quotes, queued context…).
        Anchor::User(t) => kind == "user" && text_of(content).contains(t),
        Anchor::Text(t) => {
            let s = text_of(content);
            let s = s.trim();
            kind == "assistant" && !s.is_empty() && (s == *t || s.contains(t) || t.contains(s))
        }
        Anchor::Tool(id, result) => {
            if *result {
                kind == "user" && blocks.iter().any(|b| b["type"] == "tool_result" && b["tool_use_id"] == *id)
            } else {
                kind == "assistant" && blocks.iter().any(|b| b["type"] == "tool_use" && b["id"] == *id)
            }
        }
    }
}

/// Copies the session file `src` next to itself as `new_id`, cut right after the
/// line of the last item. Errors when that item can't be found.
fn fork_jsonl(src: &Path, new_id: &str, items: &[Item]) -> Result<(), String> {
    let text = std::fs::read_to_string(src).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = text.lines().collect();
    let anchors: Vec<Anchor> = items
        .iter()
        .filter_map(|it| match it {
            Item::User { text, .. } if !text.trim().is_empty() => Some(Anchor::User(text.trim())),
            Item::Text { text, .. } if !text.trim().is_empty() => Some(Anchor::Text(text.trim())),
            Item::Tool { id, result, .. } if !id.is_empty() => Some(Anchor::Tool(id, result.is_some())),
            _ => None,
        })
        .collect();
    // Anchors in order, each searched after the previous one found; one that isn't
    // found (a message Harbor shows differently) is skipped, but the last must be.
    let parsed: Vec<Option<Value>> = lines.iter().map(|l| serde_json::from_str(l).ok()).collect();
    let mut from = 0;
    let mut cut = None;
    for (n, a) in anchors.iter().enumerate() {
        let hit = (from..parsed.len()).find(|&i| parsed[i].as_ref().is_some_and(|v| matches(v, a)));
        match hit {
            Some(i) => {
                from = i + 1;
                cut = Some(i);
            }
            None if n + 1 == anchors.len() => return Err("the forked message isn't in the session".into()),
            None => {}
        }
    }
    let cut = cut.ok_or("nothing to fork")?;
    let mut out = String::new();
    for (i, l) in lines[..=cut].iter().enumerate() {
        match &parsed[i] {
            Some(Value::Object(o)) if o.contains_key("sessionId") => {
                let mut o = o.clone();
                o.insert("sessionId".into(), Value::String(new_id.into()));
                out.push_str(&Value::Object(o).to_string());
            }
            _ => out.push_str(l),
        }
        out.push('\n');
    }
    let dst = src.with_file_name(format!("{new_id}.jsonl"));
    std::fs::write(&dst, out).map_err(|e| e.to_string())?;
    // As private as the session it came from.
    if let Ok(m) = std::fs::metadata(src) {
        let _ = std::fs::set_permissions(&dst, m.permissions());
    }
    Ok(())
}
