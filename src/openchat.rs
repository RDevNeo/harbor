//! Chats agents open: `open_chat` starts a new chat of a project (in the sidebar, on the
//! desktop and the phone, like one the user starts) with the agent's prompt as its first
//! message; `list_chats` and `message_chat` let it follow up. Each side gets a link to the
//! other (a "chat" notice, drawn as a divider by view.rs `Card::ChatLink`).
//!
//! A chat driven from another PC (meshctx.rs `Guest`) opens chats only here, and they run for
//! the same person; it sees and messages only that person's chats.

use crate::app::App;
use crate::control::ToolCall;
use crate::providers::Kind;
use crate::store::{self, Chat, Item, Repo, Role};
use eframe::egui;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// A chat notice's detail that links to another chat by its gid.
pub const LINK: &str = "harbor:gid/";

fn arg<'a>(a: &'a Value, k: &str) -> &'a str {
    a[k].as_str().unwrap_or("").trim()
}

fn quoted(title: &str) -> String {
    format!("“{}”", crate::app::clip(title.trim(), 60))
}

/// The note at the top of a chat an agent opened.
pub fn opened_by(source: &str) -> String {
    format!("Opened by the agent of {}", quoted(source))
}

/// A project by its name or folder (`want`): exact path, then name, then folder name.
pub fn find_project(repos: &[Repo], want: &str) -> Option<i64> {
    let want = want.trim().trim_end_matches('/');
    repos
        .iter()
        .find(|r| r.path.to_string_lossy().trim_end_matches('/') == want)
        .or_else(|| repos.iter().find(|r| r.name.eq_ignore_ascii_case(want)))
        .or_else(|| repos.iter().find(|r| r.path.file_name().is_some_and(|f| f.to_string_lossy().eq_ignore_ascii_case(want))))
        .map(|r| r.id)
}

/// The chat `r` names among `chats`: its id, its gid, or its title.
pub fn find_chat<'a>(chats: &[&'a Chat], r: &str) -> Option<&'a Chat> {
    let r = r.trim().trim_start_matches('#');
    let r = r.trim_matches(|c| c == '"' || c == '“' || c == '”');
    chats
        .iter()
        .find(|c| r.parse::<i64>().is_ok_and(|i| i == c.id) || c.gid == r)
        .or_else(|| chats.iter().find(|c| c.title.eq_ignore_ascii_case(r)))
        .copied()
}

/// What an opened chat's agent reads before the prompt.
fn preamble(source: &Chat) -> String {
    format!(
        "[Harbor: the agent of the chat {} (id {}) opened this chat for you with the request below. Work on it here: the user follows this chat in Harbor's sidebar. To report back to that chat, use harbor message_chat.]\n\n",
        quoted(&source.title),
        source.id
    )
}

impl App {
    /// The PC whose person runs a chat: the commanding PC's peer id for a chat driven from
    /// another PC, empty for this PC's own.
    fn commander(&self, chat: &Chat) -> String {
        self.guest_of(chat).map(|g| g.peer.clone()).unwrap_or_default()
    }

    /// This PC's chats of `repo` that `me` may see and message: leads run here, for the same person.
    fn chats_for(&self, me: &Chat, repo: Option<i64>) -> Vec<Chat> {
        let who = self.commander(me);
        self.threads_of(repo).into_iter().filter(|c| !c.foreign() && self.commander(c) == who).collect()
    }

    /// The project a tool call names (`project`), or the calling chat's.
    fn tool_project(&self, me: &Chat, a: &Value) -> Result<Option<i64>, String> {
        match arg(a, "project") {
            "" => Ok(me.repo_id),
            p => find_project(&self.repos, p).map(Some).ok_or_else(|| {
                let names: Vec<&str> = self.repos.iter().map(|r| r.name.as_str()).collect();
                format!("no project '{p}'. Projects: {}", names.join(", "))
            }),
        }
    }

    /// `open_chat`. Answers through `call.reply`, at once or (another PC's) when that PC does.
    pub fn open_chat(&mut self, call: ToolCall, ctx: &egui::Context) {
        match self.open_chat_inner(&call, ctx) {
            Ok(Some(text)) => {
                let _ = call.reply.send((true, text));
            }
            Ok(None) => {}
            Err(e) => {
                let _ = call.reply.send((false, e));
            }
        }
    }

    fn open_chat_inner(&mut self, call: &ToolCall, ctx: &egui::Context) -> Result<Option<String>, String> {
        let me = self.chat(call.chat_id).cloned().ok_or("unknown agent")?;
        if me.role != Role::Lead {
            return Err("'open_chat' is only available to the lead".into());
        }
        let a = &call.args;
        let prompt = arg(a, "prompt").to_string();
        if prompt.is_empty() {
            return Err("prompt is empty".into());
        }
        let repo = self.tool_project(&me, a)?;
        let title: String = arg(a, "title").chars().take(80).collect();
        let guest = self.guest_of(&me).cloned();
        let here = self.home_name(&me);

        // Another PC: its Harbor starts the chat, as when the user picks that PC as the Device.
        let machine = arg(a, "machine");
        let elsewhere = !machine.is_empty() && !machine.eq_ignore_ascii_case(&here) && !machine.eq_ignore_ascii_case(&crate::remote::hostname());
        let peer = if elsewhere {
            let hosts = self.mesh_hosts();
            let Some(p) = hosts.iter().find(|p| p.name.eq_ignore_ascii_case(machine) || p.id == machine).cloned() else {
                let names: Vec<String> = std::iter::once(here.clone()).chain(hosts.iter().map(|p| p.name.clone())).collect();
                return Err(format!("no PC named '{machine}'. PCs: {}", names.join(", ")));
            };
            // It would run with this PC's person's instructions, not the commander's.
            if let Some(g) = &guest {
                return Err(format!("this chat is driven from {}, so it opens chats only here, on {here}", g.name));
            }
            if !p.online {
                return Err(format!("{} is off: open the chat here, or on a PC that's on", p.name));
            }
            Some(p)
        } else {
            None
        };

        // Against runaway loops (chats opening chats): counts as an automatic turn.
        let q = self.auto_turns.entry(repo.unwrap_or(0)).or_default();
        q.retain(|t| t.elapsed() < Duration::from_secs(3600));
        if q.len() >= crate::team::AUTO_TURNS_PER_HOUR {
            return Err("too many automatic turns in this project in the last hour: ask the user instead".into());
        }
        q.push_back(Instant::now());

        if let Some(peer) = peer {
            let project = repo.and_then(|r| self.repo(r)).map(|r| json!({ "name": r.name, "path": r.path.to_string_lossy() }));
            let mut body = json!({
                "project": project, "access": me.access, "device": "", "text": prompt,
                "opened_from": { "gid": me.gid, "title": me.title },
            });
            // That PC's accounts have their own ids: only the ones asked for.
            for k in ["account", "model", "effort"] {
                if !arg(a, k).is_empty() {
                    body[k] = json!(arg(a, k));
                }
            }
            if !title.is_empty() {
                body["title"] = json!(title);
            }
            let mctx = self.ctx_for(repo);
            let reply = call.reply.clone();
            let name = peer.name.clone();
            let sender = (here, crate::api::local_device());
            crate::mesh::forward(peer.dest(), peer.name, "POST", vec!["v1".into(), "chats".into()], body, vec![], sender, mctx, move |r| {
                let _ = reply.send(if r.status == 200 {
                    (true, format!("Opened a chat on {name} (gid {}). Its agent is working on it there; it shows in the sidebar on every PC.", r.body["gid"].as_str().unwrap_or("?")))
                } else {
                    (false, format!("{name} didn't open the chat: {}", r.body["error"].as_str().unwrap_or("no answer")))
                });
            });
            return Ok(None);
        }

        // The model: the one asked for, else the opener's (on a Claude account: leads run on Claude).
        let mine = self.account(&me.account).is_some_and(|x| x.kind == Kind::Claude);
        let account = match arg(a, "account") {
            "" if mine => me.account.clone(),
            "" => "claude".to_string(),
            x => x.to_string(),
        };
        let acc = self.account(&account).cloned().ok_or_else(|| format!("unknown account '{account}'. Use list_models."))?;
        if acc.kind != Kind::Claude {
            return Err(format!("chats run on a Claude account; give {} work with spawn_agent instead", acc.kind.label()));
        }
        let same = account == me.account;
        let model = match arg(a, "model") {
            "" if same => me.model.clone(),
            x => x.to_string(),
        };
        let effort = match arg(a, "effort") {
            "" if same => me.effort.clone(),
            x => x.to_string(),
        };
        // Never more access than the opener has; the same device.
        let sel = crate::app::Sel { account, model, effort, access: me.access.clone(), device: me.device.clone() };
        let id = self.new_thread_with(repo, &prompt, sel);
        if !title.is_empty() {
            if let Some(c) = self.chat_mut(id) {
                c.title = title;
            }
        }
        // It runs for the same person as the opener.
        if let Some(g) = guest {
            self.guests.insert(id, g);
            crate::meshctx::save_guests(&self.store, &self.guests);
        }
        let new = self.chat(id).cloned().ok_or("the chat wasn't made")?;
        self.notice(id, "chat", &opened_by(&me.title), &format!("{LINK}{}", me.gid));
        self.notice(me.id, "chat", &format!("Opened {}", quoted(&new.title)), &format!("{LINK}{}", new.gid));
        // The prompt as its first message, written by no one on another device. Not `send_to`:
        // that makes a chat this PC's person's own again (meshctx.rs `ctx_adopt`).
        let tr = self.transcripts.entry(id).or_default();
        tr.items.push(Item::User { text: prompt.clone(), files: vec![], at: store::now(), mentions: vec![], sender: String::new() });
        self.persist(id);
        self.start_turn(id, format!("{}{prompt}", preamble(&me)), vec![], ctx);
        ctx.request_repaint();
        let project = repo.and_then(|r| self.repo(r)).map(|r| r.name.clone()).unwrap_or_else(|| "No project".into());
        Ok(Some(format!(
            "Opened the chat {} (id {id}) in {project}. Its agent is working on it now; the user sees it in the sidebar. Follow up with message_chat(chat: {id}, text) and check it with list_chats.",
            quoted(&new.title)
        )))
    }

    /// `list_chats`: a project's chats with their status.
    pub fn list_chats(&self, me: &Chat, a: &Value) -> Result<String, String> {
        let repo = self.tool_project(me, a)?;
        let chats = self.chats_for(me, repo);
        if chats.is_empty() {
            return Ok("No chats.".into());
        }
        let out: Vec<String> = chats
            .iter()
            .map(|c| {
                let subs_busy = self.subs_of(c.id).iter().any(|s| self.turns.contains_key(&s.id));
                let status = if self.turns.contains_key(&c.id) || subs_busy {
                    let since = self.running_since(c.id).map(|t| crate::widgets::elapsed(t.elapsed().as_secs()));
                    format!("working{}", since.map(|s| format!(" {s}")).unwrap_or_default())
                } else if self.pending.get(&c.id).is_some_and(|q| !q.is_empty()) {
                    "queued".into()
                } else if c.settled {
                    "settled".into()
                } else {
                    match crate::app::ago(c.updated) {
                        a if a == "now" => "idle, active just now".to_string(),
                        a => format!("idle, last active {a} ago"),
                    }
                };
                let you = if c.id == me.id { " (this chat)" } else { "" };
                format!("- id {} {}{you} [{status}]", c.id, quoted(&c.title))
            })
            .collect();
        Ok(out.join("\n"))
    }

    /// `message_chat`: a message from this chat's agent to another chat's, which starts a turn
    /// with it (or reads it after the current one).
    pub fn message_chat(&mut self, me: &Chat, a: &Value, ctx: &egui::Context) -> Result<String, String> {
        let text = arg(a, "text");
        if text.is_empty() {
            return Err("text is empty".into());
        }
        let which = arg(a, "chat");
        let all: Vec<Chat> = self.chats.iter().filter(|c| c.role == Role::Lead && !c.foreign()).cloned().collect();
        let refs: Vec<&Chat> = all.iter().collect();
        let target = find_chat(&refs, which).cloned().ok_or_else(|| format!("no chat '{which}'. Use list_chats."))?;
        if target.id == me.id {
            return Err("that is this chat".into());
        }
        if self.commander(&target) != self.commander(me) {
            return Err(format!("no chat '{which}'. Use list_chats."));
        }
        let from = format!("chat {}", quoted(&me.title));
        let tr = self.transcripts.entry(target.id).or_default();
        if tr.items.is_empty() {
            tr.items = self.store.items(target.id);
        }
        tr.items.push(Item::Message { from, to: "this chat".into(), text: text.into() });
        self.persist(target.id);
        let busy = self.turns.contains_key(&target.id);
        self.trigger(target.id, format!("[message from the agent of the chat {} (id {})] {text}", quoted(&me.title), me.id), true, ctx);
        Ok(if busy {
            format!("Delivered to {}. It is busy; it reads it right after its turn.", quoted(&target.title))
        } else {
            format!("Delivered to {}; its agent is working on it now.", quoted(&target.title))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn repo(id: i64, name: &str, path: &str) -> Repo {
        Repo { id, name: name.into(), path: PathBuf::from(path), sort: 0 }
    }

    fn chat(id: i64, title: &str, gid: &str) -> Chat {
        Chat {
            id,
            repo_id: Some(1),
            title: title.into(),
            session_id: String::new(),
            started: false,
            account: "claude".into(),
            model: String::new(),
            effort: String::new(),
            access: "full".into(),
            settled: false,
            updated: 0,
            role: Role::Lead,
            parent: None,
            name: "lead".into(),
            device: String::new(),
            gid: gid.into(),
            home: String::new(),
            home_id: 0,
        }
    }

    #[test]
    fn finds_projects_by_path_name_or_folder() {
        let repos = [repo(1, "harbor", "/home/u/Projects/harbor"), repo(2, "Site", "/home/u/work/web-site")];
        assert_eq!(find_project(&repos, "/home/u/Projects/harbor/"), Some(1));
        assert_eq!(find_project(&repos, "site"), Some(2));
        assert_eq!(find_project(&repos, "web-site"), Some(2));
        assert_eq!(find_project(&repos, "nope"), None);
    }

    #[test]
    fn finds_chats_by_id_gid_or_title() {
        let (a, b) = (chat(4, "Fix login", "g-a"), chat(7, "Docs", "g-b"));
        let chats = [&a, &b];
        assert_eq!(find_chat(&chats, "7").map(|c| c.id), Some(7));
        assert_eq!(find_chat(&chats, "#4").map(|c| c.id), Some(4));
        assert_eq!(find_chat(&chats, "g-b").map(|c| c.id), Some(7));
        assert_eq!(find_chat(&chats, "“fix login”").map(|c| c.id), Some(4));
        assert!(find_chat(&chats, "9").is_none());
    }

    #[test]
    fn opened_chats_link_back_on_both_sides() {
        let items = vec![
            Item::Notice { icon: "chat".into(), text: opened_by("Fix login"), detail: format!("{LINK}g-a") },
            Item::User { text: "go".into(), files: vec![], at: 1, mentions: vec![], sender: String::new() },
        ];
        let cards = crate::view::project(&items, true, &[], &|_, _| String::new());
        assert_eq!(cards[0].card, crate::view::Card::ChatLink { gid: "g-a", text: "Opened by the agent of “Fix login”" });
        let v = crate::api::card_json(&cards[0], 1, &mut |_| vec![], &Default::default());
        assert_eq!((v["kind"].as_str(), v["gid"].as_str()), (Some("chat_link"), Some("g-a")));
        // A chat notice that isn't a link stays a notice.
        let plain = [Item::Notice { icon: "chat".into(), text: "x".into(), detail: "y".into() }];
        assert!(matches!(crate::view::project(&plain, true, &[], &|_, _| String::new())[0].card, crate::view::Card::Notice { .. }));
    }

    #[test]
    fn the_agent_learns_who_opened_it() {
        let p = preamble(&chat(4, "Fix login", "g"));
        assert!(p.contains("“Fix login” (id 4)") && p.contains("message_chat"), "{p}");
    }
}
