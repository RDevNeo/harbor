//! Slash commands in the composer, as in T3 Code: typing `/` at the start of a word
//! opens a menu above the composer with Harbor's own commands (/model, /effort, /plan,
//! /default, and in a chat /new, /fork, /settle, /clear-queue), the agent's commands and the user's commands and skills, filtered as
//! you type. Claude Code expands `/name` itself, so accepting an entry only writes it;
//! other agents, and Claude on another device for this PC's commands, get the
//! command's text in the prompt instead (`expand`).
//!
//! Claude Code lists what it offers, with descriptions, in its answer to the
//! `initialize` control request of `--input-format stream-json`: a short run per
//! account and project asks it (no hooks, no MCP servers, no session) and is cached.
//! The `.claude/commands` and `.claude/skills` files (personal and the project's) fill
//! in until it answers, tell skills apart, and are what other agents get.

use crate::app::App;
use crate::icons as ic;
use crate::providers::{self, Account, Kind};
use crate::theme::{self, RADIUS_MD};
use crate::widgets as w;
use eframe::egui::{self, Align2, CornerRadius, FontId, Id, Key, Modifiers, Rect, ScrollArea, Sense, Ui, Vec2, pos2};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Claude Code's list is asked again when the menu opens after this long.
const STALE: Duration = Duration::from_secs(60);
/// A probe that hasn't answered by then is stopped.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const ROW_H: f32 = 32.0;
const MENU_MAX_H: f32 = 288.0;
/// Claude Code's commands that do nothing in a one-turn `claude -p` run, or that
/// Harbor's own controls do (model, effort, fast mode, access; `/clear` starts a
/// session Harbor wouldn't follow).
const HIDDEN: &[&str] = &[
    "clear", "color", "config", "model", "effort", "fast", "focus", "heapdump", "mcp", "import", "rename", "output-style",
    "reload-plugins", "reload-skills", "usage-credits", "extra-usage", "agents", "auto-mode-setup", "autocompact", "advisor",
    "design", "design-consent", "design-revoke", "list-agents", "loop", "team-onboarding", "workflow-launch-exec",
];

/// Harbor's own commands: they change the chat instead of going to the agent.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Harbor {
    Model,
    Plan,
    Default,
    Effort,
    /// A new chat in the chat's project.
    New,
    /// The chat forked after its last reply.
    Fork,
    /// The chat marked settled (done).
    Settle,
    /// The messages waiting for the running turn dropped.
    ClearQueue,
}

impl Harbor {
    /// Its name on the wire (the phone's `command`).
    pub fn wire(self) -> &'static str {
        match self {
            Harbor::Model => "model",
            Harbor::Plan => "plan",
            Harbor::Default => "default",
            Harbor::Effort => "effort",
            Harbor::New => "new",
            Harbor::Fork => "fork",
            Harbor::Settle => "settle",
            Harbor::ClearQueue => "clear-queue",
        }
    }
}

/// Where an entry comes from: its badge, and its rank among equal matches.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Scope {
    Harbor(Harbor),
    Project,
    Personal,
    Builtin,
    Plugin,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    /// What it takes after its name ("[low|medium|high]").
    pub hint: String,
    pub scope: Scope,
    /// A skill's folder (`.claude/skills/x`), not a command's file.
    pub skill: bool,
}

impl Entry {
    fn harbor(h: Harbor, name: &str, description: &str) -> Self {
        Entry { name: name.into(), aliases: vec![], description: description.into(), hint: String::new(), scope: Scope::Harbor(h), skill: false }
    }

    /// Its badge: icon and label.
    pub fn badge(&self) -> (&'static str, &'static str) {
        match self.scope {
            Scope::Harbor(_) => (ic::SLIDERS, "Harbor"),
            Scope::Builtin => (ic::TERMINAL, "Built-in"),
            Scope::Plugin => (ic::PLUG, "Plugin"),
            Scope::Project => (ic::FOLDER, if self.skill { "Project skill" } else { "Project command" }),
            Scope::Personal => (ic::USER_ROUND, if self.skill { "Personal skill" } else { "Personal command" }),
        }
    }
}

// ---------------------------------------------------------------- files

/// A command or skill read from a `.claude` folder.
#[derive(Clone, Debug, PartialEq)]
pub struct Local {
    /// As Claude Code names it: `a:b` for `commands/a/b.md`; a skill's front matter
    /// `name`, else its folder's.
    pub name: String,
    pub description: String,
    pub body: String,
    /// A skill's folder; None for a command (one `.md` file).
    pub skill: Option<PathBuf>,
}

impl Local {
    /// The skill's folder name when it differs from `name` (Claude Code takes both).
    fn alias(&self) -> Option<String> {
        let dir = self.skill.as_ref()?.file_name()?.to_string_lossy().into_owned();
        (dir != self.name).then_some(dir)
    }

    fn entry(&self, scope: Scope) -> Entry {
        Entry { name: self.name.clone(), aliases: self.alias().into_iter().collect(), description: self.description.clone(), hint: String::new(), scope, skill: self.skill.is_some() }
    }
}

/// Front matter's `name:` and `description:` (block scalars folded into one line),
/// and the text after it.
pub fn front(text: &str) -> (String, String, String) {
    let text = text.replace("\r\n", "\n");
    let Some((head, body)) = text.strip_prefix("---\n").and_then(|rest| rest.split_once("\n---")) else {
        return (String::new(), String::new(), text);
    };
    let lines: Vec<&str> = head.lines().collect();
    let field = |key: &str| -> String {
        let Some(i) = lines.iter().position(|l| l.strip_prefix(key).is_some_and(|v| v.starts_with(':'))) else { return String::new() };
        let v = lines[i][key.len() + 1..].trim();
        if v.starts_with(['>', '|']) {
            let more = lines[i + 1..].iter().take_while(|l| l.starts_with([' ', '\t']) || l.trim().is_empty());
            return more.map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
        }
        let quoted = v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
        if quoted { v[1..v.len() - 1].to_string() } else { v.to_string() }
    };
    (field("name"), field("description"), body.trim_start_matches(['-', '\n']).to_string())
}

fn md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            md_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "md") {
            out.push(p);
        }
    }
}

/// The commands (`commands/**/*.md`) and skills (`skills/*/SKILL.md`) of a `.claude`
/// folder, commands first, each sorted by path.
pub fn scan(base: &Path) -> Vec<Local> {
    let mut v = vec![];
    let cdir = base.join("commands");
    let mut files = vec![];
    md_files(&cdir, &mut files);
    files.sort();
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        let rel = f.strip_prefix(&cdir).unwrap_or(&f).with_extension("");
        let name = rel.iter().map(|s| s.to_string_lossy()).collect::<Vec<_>>().join(":");
        let (_, desc, body) = front(&text);
        let description = if desc.is_empty() {
            body.lines().map(|l| l.trim_start_matches('#').trim()).find(|l| !l.is_empty()).unwrap_or("").chars().take(120).collect()
        } else {
            desc
        };
        v.push(Local { name, description, body, skill: None });
    }
    let mut skills: Vec<PathBuf> = std::fs::read_dir(base.join("skills")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.join("SKILL.md").is_file()).collect();
    skills.sort();
    for d in skills {
        let Ok(text) = std::fs::read_to_string(d.join("SKILL.md")) else { continue };
        let (name, description, body) = front(&text);
        let name = if name.is_empty() { d.file_name().unwrap_or_default().to_string_lossy().into_owned() } else { name };
        v.push(Local { name, description, body, skill: Some(d) });
    }
    v
}

/// A command's text for `args`: in place of `$ARGUMENTS`, or after it.
pub fn with_args(body: &str, args: &str) -> String {
    if body.contains("$ARGUMENTS") {
        body.replace("$ARGUMENTS", args)
    } else if args.is_empty() {
        body.to_string()
    } else {
        format!("{body}\n\nArguments: {args}")
    }
}

/// The prompt for an agent that doesn't expand these itself: a leading `/command args`
/// becomes the command's text, and every `/skill` named gets its instructions before
/// the message.
pub fn expand(text: &str, locals: &[Local]) -> String {
    let find = |name: &str| locals.iter().find(|l| l.name == name || l.alias().as_deref() == Some(name));
    if let Some(rest) = text.strip_prefix('/') {
        let (name, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        if let Some(c) = find(name).filter(|l| l.skill.is_none()) {
            return with_args(&c.body, args.trim());
        }
    }
    let mut blocks: Vec<String> = vec![];
    let mut seen: Vec<&str> = vec![];
    for word in text.split_whitespace() {
        let word = word.trim_end_matches([',', '.', ';', ':', '!', '?', ')']);
        let Some(s) = word.strip_prefix('/').and_then(find).filter(|l| !seen.contains(&l.name.as_str())) else { continue };
        let Some(dir) = &s.skill else { continue };
        seen.push(&s.name);
        blocks.push(format!("[skill /{}: follow it for this message. Its other files are in {}]\n\n{}", s.name, dir.display(), s.body.trim()));
    }
    if blocks.is_empty() {
        return text.to_string();
    }
    format!("{}\n\n---\n\n{text}", blocks.join("\n\n---\n\n"))
}

// ---------------------------------------------------------------- Claude Code's list

/// The commands in Claude Code's answer to `initialize`; None for other lines.
fn parse_initialize(line: &str) -> Option<Vec<Entry>> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v["type"] != "control_response" {
        return None;
    }
    let s = |v: &Value| v.as_str().unwrap_or_default().to_string();
    let list = v["response"]["response"]["commands"].as_array()?;
    Some(
        list.iter()
            .filter(|c| c["name"].is_string())
            .map(|c| {
                let desc = s(&c["description"]);
                // The badge says where it comes from.
                let desc = desc.strip_suffix(" (project)").or_else(|| desc.strip_suffix(" (user)")).unwrap_or(&desc).to_string();
                Entry {
                    name: s(&c["name"]),
                    aliases: c["aliases"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(String::from)).collect(),
                    description: desc,
                    hint: s(&c["argumentHint"]),
                    scope: if c["builtin"] == true { Scope::Builtin } else { Scope::Plugin },
                    skill: false,
                }
            })
            .collect(),
    )
}

/// Asks the account's Claude Code, in `cwd`, for its commands.
fn probe(account: &Account, cwd: &Path) -> Option<Vec<Entry>> {
    let mut cmd = Command::new(account.bin_str());
    cmd.current_dir(cwd)
        .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .args(["--strict-mcp-config", "--no-session-persistence", "--settings", r#"{"disableAllHooks":true}"#])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (k, v) in account.env().into_iter().chain(crate::mcp::agent_env()) {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    let mut child = cmd.spawn().ok()?;
    let ask = r#"{"type":"control_request","request_id":"harbor-slash","request":{"subtype":"initialize"}}"#;
    child.stdin.as_mut()?.write_all(format!("{ask}\n").as_bytes()).ok()?;
    let out = child.stdout.take()?;
    // Stdin stays open (it would end the run) until the answer, or the timeout.
    let (done, wait) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let _ = wait.recv_timeout(PROBE_TIMEOUT);
        let _ = child.kill();
        let _ = child.wait();
    });
    let list = BufReader::new(out).lines().map_while(Result::ok).find_map(|l| parse_initialize(&l));
    let _ = done.send(());
    list
}

struct Probe {
    at: Instant,
    /// None until it answers (or when it failed).
    entries: Option<Vec<Entry>>,
}

// ---------------------------------------------------------------- the menu's list

/// What the menu offers. `cli`: Claude Code's own list (None for other agents, or
/// until it answers); `remote`: Claude runs on another device, which has the built-in
/// commands but not this PC's plugins, and gets this PC's files inlined.
pub fn entries(kind: Kind, remote: bool, access: &str, chat: Option<&Chat>, cli: Option<&[Entry]>, project: &[Local], personal: &[Local]) -> Vec<Entry> {
    let mut out = vec![Entry::harbor(Harbor::Model, "model", "Switch the model for this chat")];
    if !providers::efforts(kind).is_empty() {
        out.push(Entry::harbor(Harbor::Effort, "effort", "Change how hard the agent thinks"));
    }
    if access == "plan" {
        out.push(Entry::harbor(Harbor::Default, "default", "Switch this chat back from read only"));
    } else if providers::access(kind).iter().any(|a| a.0 == "plan") {
        out.push(Entry::harbor(Harbor::Plan, "plan", "Switch this chat to read only: it reads and plans, changes nothing"));
    }
    if let Some(c) = chat {
        out.push(Entry::harbor(Harbor::New, "new", "Start a new chat in this project"));
        if c.forkable {
            out.push(Entry::harbor(Harbor::Fork, "fork", "Fork this chat after its last reply into a new chat"));
        }
        if !c.settled {
            out.push(Entry::harbor(Harbor::Settle, "settle", "Mark this chat settled: done, out of the way in the sidebar"));
        }
        if c.queued {
            out.push(Entry::harbor(Harbor::ClearQueue, "clear-queue", "Drop the messages waiting for the running turn"));
        }
    }
    let files = project.iter().map(|l| (l, Scope::Project)).chain(personal.iter().map(|l| (l, Scope::Personal)));
    for e in cli.into_iter().flatten() {
        let hidden = HIDDEN.contains(&e.name.as_str()) || e.name.starts_with("__") || e.description.starts_with("(removed)") || e.description.starts_with("Renamed to");
        if (e.scope == Scope::Builtin && hidden) || (remote && e.scope != Scope::Builtin) {
            continue;
        }
        let mut e = e.clone();
        // Claude Code doesn't say which are the user's skills; the files do.
        if let Some((l, scope)) = files.clone().find(|(l, _)| l.name == e.name) {
            e.scope = scope;
            e.skill = l.skill.is_some();
        }
        out.push(e);
    }
    // Files Claude Code didn't list: new since it was asked, or all of them for other
    // agents and other devices.
    for (l, scope) in files {
        if !out.iter().any(|e| e.name == l.name || e.aliases.contains(&l.name)) {
            out.push(l.entry(scope));
        }
    }
    out
}

/// What the menu knows of an existing chat (the draft has none).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Chat {
    /// Its last reply can be forked.
    pub forkable: bool,
    pub settled: bool,
    /// Messages wait for its running turn.
    pub queued: bool,
}

/// The `/word` being typed: the chars from its slash to the end of the word.
#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    pub start: usize,
    pub end: usize,
    pub query: String,
    /// It begins the message: commands only run there, skills anywhere.
    pub first: bool,
}

/// The `/word` at char `cursor` of `text`, if the cursor is in one.
pub fn word(text: &str, cursor: usize) -> Option<Word> {
    let chars: Vec<char> = text.chars().collect();
    let cursor = cursor.min(chars.len());
    let start = (0..cursor).rev().find(|&i| chars[i].is_whitespace()).map_or(0, |i| i + 1);
    if chars.get(start) != Some(&'/') || start == cursor {
        return None;
    }
    let end = (cursor..chars.len()).find(|&i| chars[i].is_whitespace()).unwrap_or(chars.len());
    Some(Word { start, end, query: chars[start + 1..cursor].iter().collect(), first: chars[..start].iter().all(|c| c.is_whitespace()) })
}

/// `text` with the word replaced by `with` and a space after it (none for an empty
/// `with`, which also takes the space after the word); the cursor after it, in chars.
pub fn replace(text: &str, w: &Word, with: &str) -> (String, usize) {
    let chars: Vec<char> = text.chars().collect();
    let before: String = chars[..w.start].iter().collect();
    let mut after = &chars[w.end.min(chars.len())..];
    if with.is_empty() || after.first().is_some_and(|c| *c == ' ') {
        after = after.strip_prefix(&[' ']).unwrap_or(after);
    }
    let with = if with.is_empty() { String::new() } else { format!("{with} ") };
    let out = format!("{before}{with}{}", after.iter().collect::<String>());
    (out, w.start + with.chars().count())
}

/// How well `query` matches (lower is better), as T3 Code ranks: the name exactly,
/// then as a prefix, at a word boundary, anywhere, in order; then the description.
fn score(e: &Entry, query: &str) -> Option<u32> {
    if query.is_empty() {
        return Some(0);
    }
    let q = query.to_lowercase();
    let name = |n: &str| -> Option<u32> {
        let n = n.to_lowercase();
        if n == q {
            Some(0)
        } else if n.starts_with(&q) {
            Some(2)
        } else if n.match_indices(&q).any(|(i, _)| n[..i].ends_with(['-', '_', ':', '/'])) {
            Some(4)
        } else if n.contains(&q) {
            Some(6)
        } else {
            // Its letters in order, fewer skipped first.
            let mut gaps = 0;
            let mut rest = n.chars();
            for c in q.chars() {
                loop {
                    match rest.next() {
                        Some(x) if x == c => break,
                        Some(_) => gaps += 1,
                        None => return None,
                    }
                }
            }
            Some(100 + gaps)
        }
    };
    let names = std::iter::once(name(&e.name)).chain(e.aliases.iter().map(|a| name(a).map(|s| s + 1)));
    let desc = e.description.to_lowercase();
    let in_desc = if desc.starts_with(&q) { Some(22) } else if desc.contains(&q) { Some(26) } else { None };
    names.chain([in_desc]).flatten().min()
}

/// The entries for `w`, best first.
pub fn search<'a>(entries: &'a [Entry], w: &Word) -> Vec<&'a Entry> {
    let mut v: Vec<(u32, &Entry)> = entries
        .iter()
        .filter(|e| w.first || e.skill || matches!(e.scope, Scope::Harbor(_) | Scope::Plugin))
        .filter_map(|e| Some((score(e, &w.query)?, e)))
        .collect();
    v.sort_by(|a, b| (a.0, a.1.scope, &a.1.name).cmp(&(b.0, b.1.scope, &b.1.name)));
    v.into_iter().map(|x| x.1).collect()
}

// ---------------------------------------------------------------- state and UI

#[derive(Default)]
pub struct State {
    /// The composer whose menu showed last frame.
    pub open: Option<i64>,
    sel: usize,
    query: String,
    /// The keyboard moved the highlight: scroll it into view.
    scroll: bool,
    /// Esc closed the menu for the word starting here (composer, char).
    dismissed: Option<(i64, usize)>,
    /// Files per `.claude` folder, read again when the menu opens.
    files: HashMap<PathBuf, Vec<Local>>,
    /// Claude Code's list per (account, project).
    cli: Arc<Mutex<HashMap<(String, PathBuf), Probe>>>,
    /// The access a composer had before /plan, for /default.
    before_plan: HashMap<i64, String>,
}

/// The composer's agent, as the menu needs it.
struct Target {
    kind: Kind,
    remote: bool,
    access: String,
    account: Option<Account>,
    cwd: PathBuf,
    personal: PathBuf,
    chat: Option<Chat>,
}

/// The user's own `.claude` folder for an account: a Claude account's config dir, else ~/.claude.
fn personal_dir(account: Option<&Account>) -> PathBuf {
    account.filter(|a| a.kind == Kind::Claude).and_then(|a| a.config_dir.clone()).unwrap_or_else(|| crate::store::home().join(".claude"))
}

/// Whether Harbor puts the commands' and skills' text in for an agent: not for Claude Code on
/// this PC (`device` empty), which expands them itself.
pub fn expands(kind: Option<Kind>, device: &str) -> bool {
    !(kind == Some(Kind::Claude) && device.is_empty())
}

/// The access /plan or /default leaves a chat with; `before` is what it had before /plan.
fn access_after(h: Harbor, kind: Kind, before: Option<String>) -> String {
    match h {
        Harbor::Plan => "plan".to_string(),
        _ => before.filter(|b| b != "plan").unwrap_or_else(|| providers::access(kind)[0].0.to_string()),
    }
}

/// An entry as the phone API sends it (android/PROTOCOL.md, `GET /v1/chats/{id}/slash`).
pub fn entry_json(e: &Entry) -> Value {
    let (source, command) = match e.scope {
        Scope::Harbor(h) => ("harbor", Some(h.wire())),
        Scope::Project => ("project", None),
        Scope::Personal => ("personal", None),
        Scope::Builtin => ("builtin", None),
        Scope::Plugin => ("plugin", None),
    };
    serde_json::json!({
        "name": e.name, "aliases": e.aliases, "description": e.description, "hint": e.hint,
        "source": source, "skill": e.skill, "badge": e.badge().1, "command": command,
    })
}

impl App {
    fn slash_target(&self) -> Target {
        let sel = self.sel();
        let key = self.key();
        let chat = (key != crate::app::DRAFT).then_some(key);
        self.target_for(&sel.account, &sel.device, &sel.access, self.current_repo(), chat)
    }

    fn target_for(&self, account: &str, device: &str, access: &str, repo: Option<i64>, chat: Option<i64>) -> Target {
        let account = self.account(account).cloned();
        let kind = account.as_ref().map(|a| a.kind).unwrap_or(Kind::Claude);
        let personal = personal_dir(account.as_ref());
        let chat = chat.and_then(|id| self.chat(id)).map(|c| Chat {
            forkable: self.last_forkable(c.id).is_some(),
            settled: c.settled,
            queued: !self.queued(c.id).is_empty(),
        });
        Target { kind, remote: !device.is_empty(), access: access.to_string(), account, cwd: self.cwd_of(repo), personal, chat }
    }

    /// The last reply of a chat that can be forked (the one /fork forks after).
    pub(crate) fn last_forkable(&self, chat: i64) -> Option<usize> {
        let items = self.transcripts.get(&chat).map(|t| &t.items)?;
        crate::fork::forkable(items).iter().rposition(|f| f.is_some())
    }

    /// `GET /v1/chats/{id}/slash`: the menu's list for a chat, as the desktop's composer has
    /// it. Like opening the menu, it reads the files again and asks Claude Code when its list
    /// is old; `pending` while Claude Code hasn't answered yet (ask again in a moment).
    pub fn api_slash(&mut self, chat: i64, ctx: &egui::Context) -> Value {
        let Some(c) = self.chat(chat) else { return serde_json::json!({ "entries": [], "pending": false }) };
        let t = self.target_for(&c.account, &c.device, &c.access, c.repo_id, Some(chat));
        self.api_slash_for(t, ctx)
    }

    /// `GET /v1/slash?project=…&account=…&device=…&access=…`: the menu's list for a new chat's
    /// composer (no chat yet), with the run settings picked there.
    pub fn api_slash_draft(&mut self, account: &str, device: &str, access: &str, repo: Option<i64>, ctx: &egui::Context) -> Value {
        let account = if self.account(account).is_some() { account.to_string() } else { self.draft.sel.account.clone() };
        let t = self.target_for(&account, device, access, repo, None);
        self.api_slash_for(t, ctx)
    }

    fn api_slash_for(&mut self, t: Target, ctx: &egui::Context) -> Value {
        self.slash_refresh(&t, ctx, true);
        let pending = t.account.as_ref().filter(|a| a.kind == Kind::Claude && a.installed()).is_some_and(|a| {
            self.slash.cli.lock().unwrap().get(&(a.id.clone(), t.cwd.clone())).is_some_and(|p| p.entries.is_none() && p.at.elapsed() < PROBE_TIMEOUT)
        });
        let entries: Vec<Value> = self.slash_entries(&t).iter().map(entry_json).collect();
        serde_json::json!({ "entries": entries, "pending": pending })
    }

    /// `POST /v1/chats/{id}/slash` `{"command": "plan"|"default"|"fork"|"settle"|"clear-queue"}`:
    /// the menu's commands that act on the PC, as the desktop's composer does them (one
    /// /default for both). /model, /effort and /new are pickers the phone shows itself.
    pub fn api_slash_command(&mut self, chat: i64, body: &Value, ctx: &egui::Context) -> crate::api::Reply {
        let h = match body["command"].as_str() {
            Some("plan") => Harbor::Plan,
            Some("default") => Harbor::Default,
            Some("fork") => {
                if !self.transcripts.contains_key(&chat) {
                    let items = self.store.items(chat);
                    self.transcripts.insert(chat, crate::app::Transcript { items, ..Default::default() });
                }
                let Some(seq) = self.last_forkable(chat) else { return crate::api::err(409, "this chat has no finished reply to fork after") };
                // fork_from opens the new chat; the desktop stays where it was.
                let before = self.chats.iter().map(|c| c.id).max().unwrap_or(0);
                let (view, focus) = (self.view, self.focus_composer);
                self.fork_from(chat, seq);
                self.view = view;
                self.focus_composer = focus;
                return match self.chats.iter().map(|c| c.id).max().filter(|m| *m > before) {
                    Some(id) => crate::api::ok(serde_json::json!({ "ok": true, "id": id, "gid": self.chat(id).map(|c| c.gid.clone()).unwrap_or_default() })),
                    None => crate::api::err(500, "the fork failed"),
                };
            }
            Some("settle") => {
                self.set_chat_settled(chat, true);
                let chat = self.chat(chat).map(|ch| self.chat_json(ch)).unwrap_or_default();
                return crate::api::ok(serde_json::json!({ "ok": true, "chat": chat }));
            }
            Some("clear-queue") => {
                let n = self.take_queue(chat).len();
                return crate::api::ok(serde_json::json!({ "ok": true, "dropped": n }));
            }
            Some(c @ ("model" | "effort" | "new")) => return crate::api::err(400, format!("/{c} is picked on the phone: update Harbor there")),
            _ => return crate::api::err(400, "command is plan, default, fork, settle or clear-queue"),
        };
        let Some(c) = self.chat(chat).cloned() else { return crate::api::err(404, "no such chat") };
        let kind = self.account(&c.account).map(|a| a.kind).unwrap_or(Kind::Claude);
        let before = match h {
            Harbor::Plan => None,
            _ => self.slash.before_plan.remove(&chat),
        };
        let access = access_after(h, kind, before);
        if let Err(r) = self.api_patch_run(chat, &serde_json::json!({ "access": access }), ctx) {
            return r;
        }
        if h == Harbor::Plan && c.access != "plan" {
            self.slash.before_plan.insert(chat, c.access.clone());
        }
        let chat = self.chat(chat).map(|ch| self.chat_json(ch)).unwrap_or_default();
        crate::api::ok(serde_json::json!({ "ok": true, "chat": chat }))
    }

    /// Reads the files again, and asks Claude Code again when its list is old.
    fn slash_refresh(&mut self, t: &Target, ctx: &egui::Context, files: bool) {
        if files {
            for dir in [t.cwd.join(".claude"), t.personal.clone()] {
                let found = scan(&dir);
                self.slash.files.insert(dir, found);
            }
        }
        let Some(a) = t.account.clone().filter(|a| a.kind == Kind::Claude && a.installed()) else { return };
        let key = (a.id.clone(), t.cwd.clone());
        {
            let mut cli = self.slash.cli.lock().unwrap();
            if cli.get(&key).is_some_and(|p| p.at.elapsed() < STALE) {
                return;
            }
            let old = cli.remove(&key).and_then(|p| p.entries);
            cli.insert(key.clone(), Probe { at: Instant::now(), entries: old });
        }
        let (cli, cwd, ctx) = (self.slash.cli.clone(), t.cwd.clone(), ctx.clone());
        std::thread::spawn(move || {
            let Some(list) = probe(&a, &cwd) else { return };
            if let Some(p) = cli.lock().unwrap().get_mut(&key) {
                p.entries = Some(list);
            }
            ctx.request_repaint();
        });
    }

    fn slash_entries(&self, t: &Target) -> Vec<Entry> {
        let none = vec![];
        let project = self.slash.files.get(&t.cwd.join(".claude")).unwrap_or(&none);
        let personal = self.slash.files.get(&t.personal).unwrap_or(&none);
        let cli = self.slash.cli.lock().unwrap();
        let list = t.account.as_ref().filter(|_| t.kind == Kind::Claude).and_then(|a| cli.get(&(a.id.clone(), t.cwd.clone()))).and_then(|p| p.entries.as_deref());
        entries(t.kind, t.remote, &t.access, t.chat.as_ref(), list, project, personal)
    }

    /// Before the composer's text field: the open menu takes its keys (arrows, Enter
    /// and Tab to accept, Esc to close). A Harbor command accepted is returned.
    pub fn slash_keys(&mut self, ui: &mut Ui, key: i64, cid: Id, draft: &mut String) -> Option<Harbor> {
        if self.slash.open != Some(key) {
            return None;
        }
        let w = cursor_word(ui.ctx(), cid, draft)?;
        let t = self.slash_target();
        let all = self.slash_entries(&t);
        let list = search(&all, &w);
        if list.is_empty() {
            return None;
        }
        let none = Modifiers::NONE;
        let (up, down, accept, esc) = ui.input_mut(|i| {
            let accept = i.consume_key(none, Key::Enter) | i.consume_key(none, Key::Tab);
            (i.consume_key(none, Key::ArrowUp), i.consume_key(none, Key::ArrowDown), accept, i.consume_key(none, Key::Escape))
        });
        let n = list.len();
        if up || down {
            self.slash.sel = if down { (self.slash.sel + 1) % n } else { (self.slash.sel + n - 1) % n };
            self.slash.scroll = true;
        }
        if esc {
            self.slash.dismissed = Some((key, w.start));
            self.slash.open = None;
        }
        if accept {
            let e = list[self.slash.sel.min(n - 1)].clone();
            return self.slash_accept(ui.ctx(), cid, draft, &w, &e);
        }
        None
    }

    fn slash_accept(&mut self, ctx: &egui::Context, cid: Id, draft: &mut String, w: &Word, e: &Entry) -> Option<Harbor> {
        let (with, cmd) = match e.scope {
            Scope::Harbor(h) => (String::new(), Some(h)),
            _ => (format!("/{}", e.name), None),
        };
        let (text, cursor) = replace(draft, w, &with);
        *draft = text;
        let mut state = egui::text_edit::TextEditState::load(ctx, cid).unwrap_or_default();
        state.cursor.set_char_range(Some(egui::text::CCursorRange::one(egui::text::CCursor::new(cursor))));
        state.store(ctx, cid);
        ctx.memory_mut(|m| m.request_focus(cid));
        self.slash.open = None;
        cmd
    }

    /// After the composer (drawn in `frame`): the menu above it for the `/word` at
    /// the cursor. A Harbor command clicked is returned.
    pub fn slash_menu(&mut self, ui: &mut Ui, key: i64, cid: Id, draft: &mut String, focused: bool, frame: Rect) -> Option<Harbor> {
        let ctx = ui.ctx().clone();
        let t = self.slash_target();
        if focused && t.kind == Kind::Claude {
            // Ask Claude Code ahead, so the menu has its list when it opens.
            let known = t.account.as_ref().is_some_and(|a| self.slash.cli.lock().unwrap().contains_key(&(a.id.clone(), t.cwd.clone())));
            if !known {
                self.slash_refresh(&t, &ctx, false);
            }
        }
        let w = if focused && self.popup.is_none() && self.dialog.is_none() { cursor_word(&ctx, cid, draft) } else { None };
        // Esc's close lasts while that word is being typed.
        if self.slash.dismissed.is_some_and(|(k, start)| k == key && w.as_ref().map(|w| w.start) != Some(start)) {
            self.slash.dismissed = None;
        }
        let Some(w) = w.filter(|w| self.slash.dismissed != Some((key, w.start))) else {
            self.slash.open = None;
            return None;
        };
        if self.slash.open != Some(key) {
            self.slash_refresh(&t, &ctx, true);
            self.slash.sel = 0;
        }
        if self.slash.query != w.query {
            self.slash.query = w.query.clone();
            self.slash.sel = 0;
        }
        let all = self.slash_entries(&t);
        let list = search(&all, &w);
        if list.is_empty() {
            self.slash.open = None;
            return None;
        }
        self.slash.sel = self.slash.sel.min(list.len() - 1);
        self.slash.open = Some(key);
        // Tab and Esc are the menu's while it shows, not focus moves.
        ui.memory_mut(|m| m.set_focus_lock_filter(cid, egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: true }));
        let tk = self.theme.t;
        let (sel, scroll) = (self.slash.sel, std::mem::take(&mut self.slash.scroll));
        let (moved, pressed) = ctx.input(|i| (i.pointer.delta() != Vec2::ZERO, i.pointer.primary_pressed()));
        let mut hover = None;
        let mut pick = None;
        // Above the composer, as tall as the window leaves room for.
        let max_h = MENU_MAX_H.min(frame.top() - ctx.content_rect().top() - 24.0).max(ROW_H * 3.0);
        egui::Area::new(Id::NULL.with(("slash-menu", key)))
            .order(egui::Order::Foreground)
            .pivot(Align2::LEFT_BOTTOM)
            .fixed_pos(frame.left_top() - Vec2::new(0.0, 6.0))
            .constrain(true)
            .show(&ctx, |ui| {
                w::popover_frame(&tk).show(ui, |ui| {
                    ui.set_width(frame.width() - 14.0);
                    ScrollArea::vertical().max_height(max_h).auto_shrink([false, true]).show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 0.0;
                        for (i, e) in list.iter().enumerate() {
                            let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW_H), Sense::hover());
                            if ui.rect_contains_pointer(rect) {
                                if moved {
                                    hover = Some(i);
                                }
                                if pressed {
                                    pick = Some(i);
                                }
                            }
                            if i == sel && scroll {
                                ui.scroll_to_rect(rect, None);
                            }
                            row(ui, rect, e, i == sel);
                            let usage = if e.hint.is_empty() { format!("/{}", e.name) } else { format!("/{} {}", e.name, e.hint) };
                            resp.on_hover_text(format!("{usage}\n\n{}", e.description));
                        }
                    });
                });
            });
        if let Some(i) = hover {
            self.slash.sel = i;
        }
        let e = list[pick?].clone();
        self.slash_accept(&ctx, cid, draft, &w, &e)
    }

    /// A Harbor command picked in the composer (/model and /effort open their pickers there).
    pub fn slash_run(&mut self, key: i64, h: Harbor, ctx: &egui::Context) {
        match h {
            Harbor::Plan | Harbor::Default => self.slash_access(key, h),
            Harbor::New => {
                let repo = self.chat(key).and_then(|c| c.repo_id);
                self.new_draft(repo);
                self.focus_composer = true;
            }
            Harbor::Fork => {
                if let Some(seq) = self.last_forkable(key) {
                    self.fork_from(key, seq);
                }
            }
            Harbor::Settle => self.set_chat_settled(key, true),
            Harbor::ClearQueue => {
                self.take_queue(key);
                ctx.request_repaint();
            }
            Harbor::Model | Harbor::Effort => {}
        }
    }

    /// /plan and /default: the composer's access.
    fn slash_access(&mut self, key: i64, h: Harbor) {
        let s = self.sel();
        let kind = self.account(&s.account).map(|a| a.kind).unwrap_or(Kind::Claude);
        let before = match h {
            Harbor::Plan => {
                self.slash.before_plan.insert(key, s.access.clone());
                None
            }
            _ => self.slash.before_plan.remove(&key),
        };
        let access = access_after(h, kind, before);
        self.set_sel(crate::app::Sel { access, ..s });
    }

    /// The text a chat's agent gets for the user's `text`: as is for Claude Code here,
    /// which expands slash commands itself; with this PC's commands and skills put in
    /// for other agents and for Claude on another device.
    /// The files and issues tagged with `@` and `#` follow it (tags.rs).
    pub fn slash_prompt(&self, chat_id: i64, text: &str) -> String {
        let Some(chat) = self.chat(chat_id) else { return text.to_string() };
        let tags = self.tags_prompt(chat_id, text);
        let account = self.account(&chat.account);
        if !expands(account.map(|a| a.kind), &chat.device) || !text.contains('/') {
            return format!("{text}{tags}");
        }
        let mut locals = scan(&self.cwd_of(chat.repo_id).join(".claude"));
        locals.extend(scan(&personal_dir(account)));
        format!("{}{tags}", expand(text, &locals))
    }
}

/// The `/word` at the composer's cursor.
fn cursor_word(ctx: &egui::Context, cid: Id, draft: &str) -> Option<Word> {
    let state = egui::text_edit::TextEditState::load(ctx, cid)?;
    word(draft, state.cursor.char_range()?.primary.index.0)
}

/// One menu row: `/name`, its description, and where it comes from.
fn row(ui: &Ui, rect: Rect, e: &Entry, selected: bool) {
    let t = w::tokens(ui);
    let p = ui.painter();
    if selected {
        p.rect_filled(rect, CornerRadius::same(RADIUS_MD), t.accent());
    }
    let (icon, label) = e.badge();
    let bg = p.layout_no_wrap(label.into(), FontId::new(11.5, theme::medium()), t.subtle());
    let bw = bg.size().x + 30.0;
    let badge = Rect::from_min_size(pos2(rect.right() - 8.0 - bw, rect.center().y - 10.0), Vec2::new(bw, 20.0));
    p.rect_filled(badge, CornerRadius::same(10), if selected { t.gray(300) } else { t.gray(200) });
    ic::glyph(p, pos2(badge.left() + 13.0, badge.center().y), icon, 11.0, t.subtle());
    p.galley(pos2(badge.left() + 22.0, badge.center().y - bg.size().y / 2.0), bg, t.subtle());
    let x = rect.left() + 10.0;
    let room = badge.left() - 12.0 - x;
    let name = w::truncated(ui, &format!("/{}", e.name), FontId::new(13.0, theme::medium()), t.fg(), room.min(rect.width() * 0.45).max(40.0));
    let dx = x + name.size().x + 10.0;
    p.galley(pos2(x, rect.center().y - name.size().y / 2.0), name, t.fg());
    let left = badge.left() - 12.0 - dx;
    if left > 30.0 && !e.description.is_empty() {
        let line = e.description.lines().next().unwrap_or_default();
        let d = w::truncated(ui, line, FontId::proportional(12.5), t.subtle(), left);
        p.galley(pos2(dx, rect.center().y - d.size().y / 2.0), d, t.subtle());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(name: &str, skill: bool, body: &str) -> Local {
        Local { name: name.into(), description: format!("{name} does things"), body: body.into(), skill: skill.then(|| PathBuf::from(format!("/s/{name}"))) }
    }

    #[test]
    fn front_matter() {
        let (n, d, b) = front("---\ndescription: Do it\n---\nBody $ARGUMENTS\n");
        assert_eq!((n.as_str(), d.as_str(), b.as_str()), ("", "Do it", "Body $ARGUMENTS\n"));
        let (n, d, b) = front("---\r\nname: \"x-y\"\r\ndescription: >\r\n  Folded\r\n  over lines\r\nother: 1\r\n---\r\nText\r\n");
        assert_eq!((n.as_str(), d.as_str(), b.as_str()), ("x-y", "Folded over lines", "Text\n"));
        let (n, d, b) = front("No front matter");
        assert_eq!((n.as_str(), d.as_str(), b.as_str()), ("", "", "No front matter"));
    }

    #[test]
    fn scans_commands_and_skills() {
        let base = std::env::temp_dir().join(format!("harbor-slash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("commands/fe")).unwrap();
        std::fs::create_dir_all(base.join("skills/folder")).unwrap();
        std::fs::create_dir_all(base.join("skills/empty")).unwrap();
        std::fs::write(base.join("commands/fe/comp.md"), "---\ndescription: Make one\n---\nBuild $ARGUMENTS\n").unwrap();
        std::fs::write(base.join("commands/top.md"), "# Top title\nbody\n").unwrap();
        std::fs::write(base.join("skills/folder/SKILL.md"), "---\nname: named\ndescription: A skill\n---\nSteps\n").unwrap();
        let v = scan(&base);
        let names: Vec<(&str, &str, bool)> = v.iter().map(|l| (l.name.as_str(), l.description.as_str(), l.skill.is_some())).collect();
        assert_eq!(names, [("fe:comp", "Make one", false), ("top", "Top title", false), ("named", "A skill", true)]);
        assert_eq!(v[2].alias().as_deref(), Some("folder"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn finds_the_word_at_the_cursor() {
        assert_eq!(word("/co", 3), Some(Word { start: 0, end: 3, query: "co".into(), first: true }));
        assert_eq!(word("/compact now", 4), Some(Word { start: 0, end: 8, query: "com".into(), first: true }));
        assert_eq!(word("fix it /rev", 11), Some(Word { start: 7, end: 11, query: "rev".into(), first: false }));
        assert_eq!(word("  /x", 4).map(|w| w.first), Some(true));
        assert_eq!(word("/", 1).map(|w| w.query), Some(String::new()));
        assert_eq!(word("a/b", 3), None);
        assert_eq!(word("/compact ", 9), None);
        assert_eq!(word("/x", 0), None);
    }

    #[test]
    fn replaces_the_word() {
        let w = word("/co", 3).unwrap();
        assert_eq!(replace("/co", &w, "/compact"), ("/compact ".to_string(), 9));
        let w = word("/co more", 2).unwrap();
        assert_eq!(replace("/co more", &w, "/compact"), ("/compact more".to_string(), 9));
        let w = word("/mod hello", 3).unwrap();
        assert_eq!(replace("/mod hello", &w, ""), ("hello".to_string(), 0));
        let w = word("é /sk", 5).unwrap();
        assert_eq!(replace("é /sk", &w, "/skill"), ("é /skill ".to_string(), 9));
    }

    #[test]
    fn lists_by_agent() {
        let cli = vec![
            Entry { name: "compact".into(), aliases: vec![], description: "Free up context".into(), hint: String::new(), scope: Scope::Builtin, skill: false },
            Entry { name: "clear".into(), aliases: vec!["reset".into()], description: "New session".into(), hint: String::new(), scope: Scope::Builtin, skill: false },
            Entry { name: "vercel:deploy".into(), aliases: vec![], description: "(vercel) Deploy".into(), hint: String::new(), scope: Scope::Plugin, skill: false },
            Entry { name: "mine".into(), aliases: vec![], description: "Mine".into(), hint: String::new(), scope: Scope::Plugin, skill: false },
        ];
        let personal = [local("mine", true, "Do mine"), local("fresh", false, "New")];
        let project = [local("proj", false, "P")];
        let names = |v: &[Entry]| v.iter().map(|e| (e.name.clone(), e.scope, e.skill)).collect::<Vec<_>>();
        // Claude here: its list, the user's files marked, newer files added; /clear hidden.
        let v = entries(Kind::Claude, false, "full", None, Some(&cli), &project, &personal);
        assert_eq!(
            names(&v),
            [
                ("model".into(), Scope::Harbor(Harbor::Model), false),
                ("effort".into(), Scope::Harbor(Harbor::Effort), false),
                ("plan".into(), Scope::Harbor(Harbor::Plan), false),
                ("compact".into(), Scope::Builtin, false),
                ("vercel:deploy".into(), Scope::Plugin, false),
                ("mine".into(), Scope::Personal, true),
                ("proj".into(), Scope::Project, false),
                ("fresh".into(), Scope::Personal, false),
            ]
        );
        // On another device: built-ins, and this PC's files (inlined), no plugins.
        let v = entries(Kind::Claude, true, "plan", None, Some(&cli), &project, &personal);
        assert_eq!(v.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["model", "effort", "default", "compact", "proj", "mine", "fresh"]);
        // Other agents: the files only; no /plan where there's no read-only mode.
        let v = entries(Kind::OpenCode, false, "full", None, None, &project, &personal);
        assert_eq!(v.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["model", "proj", "mine", "fresh"]);
    }

    #[test]
    fn ranks_and_filters() {
        let personal = [local("code-review", true, ""), local("review-pr", false, ""), local("deploy", false, "")];
        let all = entries(Kind::Codex, false, "full", None, None, &[], &personal);
        let find = |text: &str| search(&all, &word(text, text.chars().count()).unwrap()).iter().map(|e| e.name.clone()).collect::<Vec<_>>();
        assert_eq!(find("/review"), ["review-pr", "code-review"]);
        assert_eq!(find("/dpl"), ["deploy"]);
        assert_eq!(find("/zzz"), Vec::<String>::new());
        assert_eq!(find("/"), ["model", "plan", "effort", "code-review", "deploy", "review-pr"]);
        // After other words: no commands, only skills (and Harbor's).
        assert_eq!(find("look at /rev"), ["code-review"]);
        // Descriptions match too, after names.
        assert_eq!(find("/model"), ["model"]);
        assert_eq!(find("/things"), ["code-review", "deploy", "review-pr"]);
    }

    #[test]
    fn expands_for_other_agents() {
        let locals = [local("fix", false, "Fix $ARGUMENTS now"), local("plain", false, "Plain body"), local("style", true, "Write well")];
        assert_eq!(expand("/fix the bug", &locals), "Fix the bug now");
        assert_eq!(expand("/plain x y", &locals), "Plain body\n\nArguments: x y");
        assert_eq!(expand("/unknown thing", &locals), "/unknown thing");
        assert_eq!(expand("no commands here", &locals), "no commands here");
        let out = expand("please /style this, /style", &locals);
        assert!(out.starts_with("[skill /style: follow it for this message. Its other files are in /s/style]\n\nWrite well\n\n---\n\nplease /style this"));
        assert_eq!(out.matches("Write well").count(), 1);
    }

    #[test]
    fn the_phones_list() {
        let cli = vec![
            Entry { name: "compact".into(), aliases: vec!["c".into()], description: "Free up context".into(), hint: "<instructions>".into(), scope: Scope::Builtin, skill: false },
            Entry { name: "vercel:deploy".into(), aliases: vec![], description: "(vercel) Deploy".into(), hint: String::new(), scope: Scope::Plugin, skill: false },
        ];
        let v: Vec<Value> = entries(Kind::Claude, false, "full", None, Some(&cli), &[local("proj", false, "P")], &[local("mine", true, "M")]).iter().map(entry_json).collect();
        let row = |i: usize| (v[i]["name"].as_str().unwrap(), v[i]["source"].as_str().unwrap(), v[i]["badge"].as_str().unwrap(), v[i]["skill"].as_bool().unwrap());
        assert_eq!(row(0), ("model", "harbor", "Harbor", false));
        assert_eq!(v[0]["command"], "model");
        assert_eq!(row(1), ("effort", "harbor", "Harbor", false));
        assert_eq!(v[1]["command"], "effort");
        assert_eq!(row(2), ("plan", "harbor", "Harbor", false));
        assert_eq!(v[2]["command"], "plan");
        assert_eq!(row(3), ("compact", "builtin", "Built-in", false));
        assert_eq!((v[3]["hint"].as_str(), v[3]["aliases"].clone(), v[3]["command"].clone()), (Some("<instructions>"), serde_json::json!(["c"]), Value::Null));
        assert_eq!(row(4), ("vercel:deploy", "plugin", "Plugin", false));
        assert_eq!(row(5), ("proj", "project", "Project command", false));
        assert_eq!(row(6), ("mine", "personal", "Personal skill", true));
        assert_eq!(v[6]["description"], "mine does things");
        // A chat in read-only mode gets /default instead of /plan.
        let v = entries(Kind::Claude, false, "plan", None, None, &[], &[]);
        assert_eq!(entry_json(&v[2])["command"], "default");
    }

    #[test]
    fn a_chats_own_commands() {
        let names = |c: Option<&Chat>| entries(Kind::Claude, false, "full", c, None, &[], &[]).iter().map(|e| entry_json(e)["command"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>();
        // The draft: no chat to fork, settle or clear yet.
        assert_eq!(names(None), ["model", "effort", "plan"]);
        let c = Chat { forkable: true, settled: false, queued: true };
        assert_eq!(names(Some(&c)), ["model", "effort", "plan", "new", "fork", "settle", "clear-queue"]);
        // Nothing to fork after, settled already, nothing waiting.
        let c = Chat { forkable: false, settled: true, queued: false };
        assert_eq!(names(Some(&c)), ["model", "effort", "plan", "new"]);
    }

    #[test]
    fn plan_and_back() {
        assert_eq!(access_after(Harbor::Plan, Kind::Claude, None), "plan");
        assert_eq!(access_after(Harbor::Default, Kind::Claude, Some("ask".into())), "ask");
        // Nothing remembered (another device did /plan, or Harbor restarted): the provider's first level.
        assert_eq!(access_after(Harbor::Default, Kind::Claude, None), providers::access(Kind::Claude)[0].0);
        assert_eq!(access_after(Harbor::Default, Kind::Claude, Some("plan".into())), providers::access(Kind::Claude)[0].0);
    }

    #[test]
    fn who_gets_commands_expanded() {
        // Claude Code here expands them itself; other agents and Claude on another device get the text.
        assert!(!expands(Some(Kind::Claude), ""));
        assert!(expands(Some(Kind::Claude), "ts:laptop"));
        assert!(expands(Some(Kind::Codex), ""));
        assert!(expands(None, ""));
    }

    #[test]
    fn reads_claude_codes_list() {
        let line = r#"{"type":"control_response","response":{"subtype":"success","request_id":"harbor-slash","response":{"commands":[{"name":"compact","description":"Free up context","argumentHint":"<instructions>","builtin":true},{"name":"top","description":"Top body (project)","argumentHint":"","aliases":["t"]}]}}}"#;
        let v = parse_initialize(line).unwrap();
        assert_eq!(v[0], Entry { name: "compact".into(), aliases: vec![], description: "Free up context".into(), hint: "<instructions>".into(), scope: Scope::Builtin, skill: false });
        assert_eq!((v[1].description.as_str(), v[1].scope, v[1].aliases.clone()), ("Top body", Scope::Plugin, vec!["t".to_string()]));
        assert!(parse_initialize(r#"{"type":"system","subtype":"init"}"#).is_none());
    }
}
