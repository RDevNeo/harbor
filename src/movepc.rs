//! "Move to PC…": a finished chat (and its sub-agents) leaves this PC for another PC of the mesh
//! and goes on there. The chat keeps its gid, so every PC and phone sees the same chat; only its
//! home changes (mesh.rs: one owner per chat).
//!
//! The PC that owns the chat (the source) hands it over to the target:
//! 1. `POST /mesh/v1/adopt/check` asks the target first whether it can take it: a project for the
//!    chat's repository (same git remote, else the same folder or project name; a chat in a
//!    project the target doesn't have is refused, not dropped into "No project") and a Claude
//!    account of its own (the source account's email if it's there, else the target's default
//!    account, else the one with the most quota left, as Continue on… picks). A target from
//!    before this feature answers 404 and the move is refused cleanly.
//! 2. A chat in its own worktree has its branch pushed; the target fetches it and checks it out
//!    in a worktree of its own. A chat with uncommitted changes where it works doesn't move
//!    ("Commit or stash first"): no patches travel in this version.
//! 3. The transcripts and every started Claude session (`<sid>.jsonl` and its sidecar folder)
//!    are uploaded (`/mesh/v1/upload`), then `POST /mesh/v1/adopt` makes the target write the
//!    sessions under its account's folder for its own project path and become the chat's home.
//! 4. Only once the target says so does the source turn its chat into a copy of the target's.
//!    No answer: the move stays pending (kv `move_pc`), the chat takes no turns, and the
//!    target's chat list settles it (it lists the chat as its own: done; a full list without
//!    it: it stays here). The target only takes a chat within [`DEADLINE`] of receiving the
//!    call, so a call the source gave up on can't make two owners later.
//!
//! Other PCs learn the new home from the target's chat list (copies are matched by gid).
//! Not moved: chats mid-turn, other providers (Claude only for now), chats on an SSH device.

use crate::api::{self, Call, Reply, err, ok};
use crate::app::App;
use crate::providers::Kind;
use crate::store::{self, Chat, Item, Role};
use eframe::egui;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// Said in `hello` (`moves`): this Harbor takes moved chats. Raise it when the handoff changes.
pub const VERSION: u64 = 1;
/// How long the target's listener waits for its answer to `adopt` (it fetches a branch).
pub const SERVE_WAIT: Duration = Duration::from_secs(180);
/// The target takes the chat only within this of receiving the call (well inside `SERVE_WAIT`).
pub const DEADLINE: Duration = Duration::from_secs(150);
/// How long the source waits for that answer.
const SEND_WAIT: Duration = Duration::from_secs(200);
const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const NET_TIMEOUT: Duration = Duration::from_secs(120);
/// Sidecar files per session, at most.
const MAX_FILES: usize = 4000;
/// kv: moves waiting for the target's answer, {gid: [peer id, peer name]}.
const KV: &str = "move_pc";

/// A PC a chat could move to; `why` says why not (now).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Target {
    pub id: String,
    pub name: String,
    pub why: Option<String>,
}

/// The UI thread's part.
#[derive(Default)]
pub struct Local {
    /// Chats being handed over, by gid: (peer id, peer name). Until the target has answered.
    pub moving: HashMap<String, (String, String)>,
    /// Gids this PC is taking from another PC right now.
    pub adopting: HashSet<String>,
    /// Gids whose handoff thread still runs here (its outcome settles them).
    pub sending: HashSet<String>,
    /// Messages sent to a chat while it was being handed over: they follow it, or are sent
    /// here if it stays.
    pub held: HashMap<i64, Vec<(String, Vec<PathBuf>, Vec<crate::mentions::Mention>)>>,
    /// The desktop menu of a copy: its home PC's targets (None while asked).
    pub asked: HashMap<i64, (Instant, Option<Result<(Option<String>, Vec<Target>), String>>)>,
}

// ================================================================== pure parts

/// A git remote reduced to "host/path", lowercased: `git@github.com:a/b.git`,
/// `https://github.com/a/b` and `ssh://git@github.com:22/a/b` are all "github.com/a/b".
pub fn normalize_remote(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    let u = u.strip_suffix(".git").unwrap_or(u);
    let rest = match u.split_once("://") {
        Some((_, r)) => r.to_string(),
        // scp-like "user@host:path"
        None => match u.split_once(':') {
            Some((h, p)) if !h.contains('/') => format!("{h}/{p}"),
            _ => u.to_string(),
        },
    };
    let rest = match rest.split_once('@') {
        Some((user, r)) if !user.contains('/') => r.to_string(),
        _ => rest,
    };
    let (host, path) = rest.split_once('/').unwrap_or((&rest, ""));
    let host = host.split(':').next().unwrap_or(host);
    format!("{host}/{}", path.trim_matches('/')).to_ascii_lowercase()
}

/// One of this PC's projects, as matching sees it.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: i64,
    pub name: String,
    /// Its folder's name.
    pub folder: String,
    pub remote: String,
}

/// This PC's project for the chat's project on the source: the same remote first, else the same
/// folder or project name (only when one side has no remote: two different repositories that
/// share a name aren't the same project).
pub fn match_project(cands: &[Candidate], remote: &str, folder: &str, name: &str) -> Option<i64> {
    let want = if remote.is_empty() { String::new() } else { normalize_remote(remote) };
    if !want.is_empty() {
        if let Some(c) = cands.iter().find(|c| !c.remote.is_empty() && normalize_remote(&c.remote) == want) {
            return Some(c.id);
        }
    }
    cands
        .iter()
        .filter(|c| want.is_empty() || c.remote.is_empty())
        .find(|c| (!folder.is_empty() && c.folder == folder) || (!name.is_empty() && c.name == name))
        .map(|c| c.id)
}

/// A Claude account here that could take the chat: (id, email, (weekly, 5-hour) use 0–1).
#[derive(Clone, Debug)]
pub struct AccountCand {
    pub id: String,
    pub email: String,
    pub usage: (f64, f64),
}

/// The account the chat runs as here: the source account's own login if it's here too, else
/// this PC's default account, else the one with the most quota left.
pub fn pick_account(cands: &[AccountCand], email: &str, default: &str) -> Option<String> {
    if !email.is_empty() {
        if let Some(c) = cands.iter().find(|c| c.email.eq_ignore_ascii_case(email)) {
            return Some(c.id.clone());
        }
    }
    if let Some(c) = cands.iter().find(|c| c.id == default) {
        return Some(c.id.clone());
    }
    cands.iter().min_by(|a, b| a.usage.partial_cmp(&b.usage).unwrap_or(std::cmp::Ordering::Equal)).map(|c| c.id.clone())
}

/// A session id as Claude Code writes them (a uuid): nothing that could leave its folder.
pub fn valid_sid(sid: &str) -> bool {
    !sid.is_empty() && sid.len() <= 100 && sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A received file's place under the account's project folder: `<sid>.jsonl` or inside `<sid>/`.
pub fn safe_rel(sid: &str, rel: &str) -> bool {
    if !valid_sid(sid) || rel.contains('\\') {
        return false;
    }
    let parts: Vec<Component> = Path::new(rel).components().collect();
    if parts.is_empty() || !parts.iter().all(|c| matches!(c, Component::Normal(_))) {
        return false;
    }
    if parts.len() == 1 {
        return rel == format!("{sid}.jsonl");
    }
    parts[0].as_os_str() == sid
}

/// The newest copy of session `sid` of an account (`None`: ~/.claude), also in the profiles of
/// chats commanded from other PCs (meshctx.rs), with its sidecar folder's files, as
/// (place relative to the project folder, file here). None when there's no copy.
pub fn session_files(config: &Option<PathBuf>, sid: &str) -> Option<Vec<(String, PathBuf)>> {
    let mut copies = crate::movechat::session_copies(config, sid);
    for p in crate::meshctx::overlays() {
        copies.extend(crate::movechat::session_copies(&Some(p), sid));
    }
    let modified = |p: &PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    copies.sort_by_key(|p| std::cmp::Reverse(modified(p)));
    let src = copies.into_iter().next()?;
    let mut out = vec![(format!("{sid}.jsonl"), src.clone())];
    let side = src.with_extension("");
    walk(&side, sid, &mut out);
    out.truncate(MAX_FILES + 1);
    Some(out)
}

fn walk(dir: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() > MAX_FILES {
            return;
        }
        let Ok(t) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        let r = format!("{rel}/{name}");
        // (Symlinks stay behind: only what the session wrote travels.)
        if t.is_dir() {
            walk(&e.path(), &r, out);
        } else if t.is_file() {
            out.push((r, e.path()));
        }
    }
}

/// Puts received session files into `dir` (the account's folder for the chat's working
/// directory here). Every place is checked first; nothing is written if one is wrong.
pub fn place(dir: &Path, sid: &str, files: &[(String, PathBuf)]) -> Result<(), String> {
    if let Some((rel, _)) = files.iter().find(|(rel, _)| !safe_rel(sid, rel)) {
        return Err(format!("refused a session file outside its folder: {rel}"));
    }
    for (rel, src) in files {
        let dst = dir.join(rel);
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::copy(src, &dst).map_err(|e| format!("couldn't write {}: {e}", dst.display()))?;
    }
    Ok(())
}

fn git(dir: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0").arg("-C").arg(dir).args(args);
    let out = crate::git::output_within(&mut cmd, limit).map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let e = String::from_utf8_lossy(&out.stderr);
        Err(e.lines().map(|l| l.trim_start_matches("error: ").trim_start_matches("fatal: ").trim()).find(|l| !l.is_empty() && !l.starts_with("hint:")).unwrap_or("git failed").to_string())
    }
}

/// A folder's remotes, (name, URL), in git's order (one `git config` call).
fn remotes(dir: &Path) -> Vec<(String, String)> {
    let out = git(dir, &["config", "--get-regexp", r"^remote\..*\.url$"], GIT_TIMEOUT).unwrap_or_default();
    out.lines()
        .filter_map(|l| {
            let (k, url) = l.split_once(' ')?;
            Some((k.strip_prefix("remote.")?.strip_suffix(".url")?.to_string(), url.trim().to_string()))
        })
        .collect()
}

/// The URL of a folder's remote: "origin", else the first one ("" when none).
pub fn remote_url(dir: &Path) -> String {
    let r = remotes(dir);
    r.iter().find(|(n, _)| n == "origin").or(r.first()).map(|(_, u)| u.clone()).unwrap_or_default()
}

/// The name of the remote of `dir` whose URL is `url` ("origin" when none is).
fn remote_named(dir: &Path, url: &str) -> String {
    let want = normalize_remote(url);
    remotes(dir).into_iter().find(|(_, u)| normalize_remote(u) == want).map(|(n, _)| n).unwrap_or_else(|| "origin".into())
}

/// Where the chat works on the source, as the move needs it.
#[derive(Clone, Debug, Default)]
pub struct Code {
    pub remote: String,
    pub branch: String,
    pub sha: String,
    /// Its own worktree (its branch is pushed and checked out on the target).
    pub worktree: bool,
}

/// Refuses a folder with uncommitted changes; reads its remote, branch and commit.
pub fn code_state(dir: &Path, worktree: bool) -> Result<Code, String> {
    let Some(h) = crate::worktree::head(dir) else {
        // Not a git folder: nothing to carry, nothing to lose.
        return Ok(Code::default());
    };
    if h.dirty > 0 {
        return Err(format!("{} has {} uncommitted change{}: commit or stash them first", crate::app::tilde(dir), h.dirty, if h.dirty == 1 { "" } else { "s" }));
    }
    if worktree && h.branch.is_empty() {
        return Err("its worktree is on a detached commit: put it on a branch first".into());
    }
    let sha = git(dir, &["rev-parse", "--short", "HEAD"], GIT_TIMEOUT).unwrap_or_default();
    Ok(Code { remote: remote_url(dir), branch: h.branch, sha, worktree })
}

/// Pushes a worktree's branch to its remote (the source, before the handoff).
fn push(dir: &Path, branch: &str, remote: &str) -> Result<(), String> {
    let name = remote_named(dir, remote);
    git(dir, &["push", "-u", &name, branch], NET_TIMEOUT).map(|_| ()).map_err(|e| format!("couldn't push {branch}: {e}"))
}

/// Checks out the pushed branch in a new worktree of `repo` (the target). Returns its folder.
fn fetch_worktree(repo: &Path, branch: &str, remote: &str) -> Result<PathBuf, String> {
    let name = remote_named(repo, remote);
    git(repo, &["fetch", &name, branch], NET_TIMEOUT).map_err(|e| format!("couldn't fetch {branch}: {e}"))?;
    let project: String = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into()).chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect();
    let root = crate::worktree::root();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let tail = branch.strip_prefix("harbor/").filter(|t| t.chars().all(|c| c.is_ascii_alphanumeric())).map(String::from);
    let mut last = String::new();
    for n in 0..4 {
        let id = match (&tail, n) {
            (Some(t), 0) => t.clone(),
            _ => store::new_uuid().chars().filter(|c| c.is_ascii_hexdigit()).take(6).collect(),
        };
        let dir = root.join(format!("{project}-{id}"));
        if dir.exists() {
            continue;
        }
        let d = dir.to_string_lossy().into_owned();
        let upstream = format!("{name}/{branch}");
        let r = git(repo, &["worktree", "add", "--track", "-b", branch, &d, &upstream], NET_TIMEOUT).or_else(|_| git(repo, &["worktree", "add", &d, branch], NET_TIMEOUT));
        match r {
            Ok(_) => return Ok(dir),
            Err(e) => last = e,
        }
    }
    Err(format!("couldn't check out {branch}: {last}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The deadline the target's listener stamps on an `adopt` call (mesh.rs `serve`).
pub fn deadline_ms() -> i64 {
    now_ms() + DEADLINE.as_millis() as i64
}

// ================================================================== the source's thread

/// How a handoff ended, as the source sees it.
enum Outcome {
    /// The target owns the chats now: gid → their ids there.
    Done(HashMap<String, i64>),
    /// It said no (or can't): the chat stays here.
    Refused(String),
    /// No answer: it may or may not have taken it.
    Unknown(String),
}

/// What the source sends, prepared on the UI thread.
struct Handoff {
    dest: crate::mesh::Dest,
    peer: String,
    /// `adopt/check`'s body (also the base of `adopt`'s).
    check: Value,
    payload: Vec<u8>,
    /// (sid, files)
    sessions: Vec<(String, Vec<(String, PathBuf)>)>,
    /// A worktree to push first: (its folder, branch, remote URL).
    push: Option<(PathBuf, String, String)>,
}

fn post(dest: &crate::mesh::Dest, path: &str, body: &Value, wait: Duration) -> Result<(u16, Value), String> {
    let data = serde_json::to_vec(body).unwrap_or_default();
    crate::mesh::http(dest, "POST", path, Some(("application/json", &data)), wait)
}

fn ids_of(v: &Value) -> HashMap<String, i64> {
    v["ids"].as_object().map(|o| o.iter().filter_map(|(g, i)| Some((g.clone(), i.as_i64()?))).collect()).unwrap_or_default()
}

fn send(h: Handoff) -> Outcome {
    let name = &h.peer;
    // 1. Can it take it? (A Harbor before moves answers 404: nothing was sent yet.)
    match post(&h.dest, "/mesh/v1/adopt/check", &h.check, Duration::from_secs(30)) {
        Ok((200, v)) if v["owns"].as_bool() == Some(true) => return Outcome::Done(ids_of(&v)),
        Ok((200, v)) if v["ok"].as_bool() == Some(true) => {}
        Ok((200, v)) | Ok((409, v)) => return Outcome::Refused(v["why"].as_str().or(v["error"].as_str()).unwrap_or("it can't take it").to_string()),
        Ok((404, _)) => return Outcome::Refused(format!("{name} runs an older Harbor: update it first")),
        Ok((s, v)) => return Outcome::Refused(format!("{name} answered {s}: {}", v["error"].as_str().unwrap_or(""))),
        Err(e) => return Outcome::Refused(format!("{name} didn't answer: {e}")),
    }
    // 2. The worktree's branch goes to its remote, for the target to fetch.
    if let Some((dir, branch, remote)) = &h.push {
        if let Err(e) = push(dir, branch, remote) {
            return Outcome::Refused(e);
        }
    }
    // 3. Transcripts and sessions, as uploads there.
    let upload = |name: &str, data: &[u8]| -> Result<String, String> {
        match crate::mesh::http(&h.dest, "POST", &format!("/mesh/v1/upload?name={}", api::url_encode(name)), Some(("application/octet-stream", data)), NET_TIMEOUT) {
            Ok((201, v)) => v["id"].as_str().map(String::from).ok_or_else(|| "no upload id".to_string()),
            Ok((s, v)) => Err(format!("{s}: {}", v["error"].as_str().unwrap_or(""))),
            Err(e) => Err(e),
        }
    };
    let payload = match upload("move.json", &h.payload) {
        Ok(id) => id,
        Err(e) => return Outcome::Refused(format!("couldn't send the chat to {name}: {e}")),
    };
    let mut sessions = vec![];
    for (sid, files) in &h.sessions {
        let mut list = vec![];
        for (rel, path) in files {
            let data = match std::fs::read(path) {
                Ok(d) => d,
                Err(e) => return Outcome::Refused(format!("couldn't read {}: {e}", path.display())),
            };
            match upload(&format!("{sid}.part"), &data) {
                Ok(id) => list.push(json!({ "rel": rel, "upload": id })),
                Err(e) => return Outcome::Refused(format!("couldn't send a session to {name}: {e}")),
            }
        }
        sessions.push(json!({ "sid": sid, "files": list }));
    }
    // 4. The handoff. Only its answer decides.
    let mut body = h.check.clone();
    body["payload"] = json!(payload);
    body["sessions"] = json!(sessions);
    let why = match post(&h.dest, "/mesh/v1/adopt", &body, SEND_WAIT) {
        Ok((200, v)) => return Outcome::Done(ids_of(&v)),
        Ok((503, v)) => v["error"].as_str().unwrap_or("no answer").to_string(),
        Ok((_, v)) => return Outcome::Refused(v["error"].as_str().unwrap_or("it refused").to_string()),
        Err(e) => e,
    };
    // No answer: ask until it says whether it took it.
    let gid = h.check["gid"].clone();
    for _ in 0..12 {
        std::thread::sleep(Duration::from_secs(10));
        match post(&h.dest, "/mesh/v1/adopt/check", &json!({ "gid": gid }), Duration::from_secs(20)) {
            Ok((200, v)) if v["owns"].as_bool() == Some(true) => return Outcome::Done(ids_of(&v)),
            Ok((200, v)) if v["busy"].as_bool() != Some(true) => return Outcome::Refused(format!("{name} didn't take it ({why})")),
            _ => {}
        }
    }
    Outcome::Unknown(why)
}

// ================================================================== the UI thread

impl App {
    /// At startup: moves still waiting for their target's answer.
    pub fn move_pc_load(&mut self) {
        let m: HashMap<String, (String, String)> = self.store.get(KV).and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
        self.movepc.moving = m;
    }

    fn move_pc_save(&self) {
        self.store.set(KV, &serde_json::to_string(&self.movepc.moving).unwrap_or_default());
    }

    /// The PC a chat (or its lead) is being handed to, by name.
    pub fn moving_to(&self, chat: i64) -> Option<String> {
        let c = self.chat(chat)?;
        let lead = if c.role == Role::Sub { c.parent.and_then(|p| self.chat(p))? } else { c };
        self.movepc.moving.get(&lead.gid).map(|(_, n)| n.clone())
    }

    /// Why this PC's chat can't move to any PC now (None: it may, the PCs say the rest).
    /// Cheap: no git here (`move_pc` checks the code before it sends anything).
    pub fn move_pc_blocker(&self, chat_id: i64) -> Option<String> {
        let c = self.chat(chat_id)?;
        if c.foreign() {
            return Some(format!("this chat is {}'s: move it from there", self.home_name(c)));
        }
        if c.role == Role::Sub {
            return Some("a sub-agent moves with its lead: move the lead".into());
        }
        if !self.api.hub.mesh.on.load(std::sync::atomic::Ordering::Relaxed) {
            return Some("this PC doesn't share chats with other PCs (Settings › Devices)".into());
        }
        if let Some(to) = self.moving_to(chat_id) {
            return Some(format!("it's moving to {to}"));
        }
        let mut ids = vec![chat_id];
        ids.extend(self.subs_of(chat_id).into_iter().map(|s| s.id));
        for id in &ids {
            let Some(x) = self.chat(*id) else { continue };
            let it = if *id == chat_id { "it".to_string() } else { format!("its sub-agent {}", x.name) };
            if !x.device.is_empty() {
                return Some(format!("{it} runs on device {}, which keeps its session there", x.device));
            }
            if self.account(&x.account).is_none_or(|a| a.kind != Kind::Claude) {
                return Some(format!("{it} isn't a Claude chat: only Claude chats move to another PC for now"));
            }
            if self.is_running(*id) {
                return Some(format!("{it} is running: move it once its turn ends"));
            }
        }
        None
    }

    /// The PCs this PC's chat could move to, each with why not (if so), and why it can't move
    /// at all (then every PC carries that reason too).
    pub fn move_pc_targets(&self, chat_id: i64) -> (Option<String>, Vec<Target>) {
        let blocker = self.move_pc_blocker(chat_id);
        let me = self.api.hub.mesh.me().id;
        let shared = &self.api.hub.mesh;
        let targets = self
            .mesh_hosts()
            .into_iter()
            .filter(|p| p.id != me && (p.online || shared.allowed_fp(&p.fp).is_some()))
            .map(|p| {
                let why = if let Some(b) = &blocker {
                    Some(b.clone())
                } else if !p.online {
                    Some(match shared.down_of(&p.id) {
                        Some(crate::mesh::Down::Harbor) => "Harbor isn't running there".to_string(),
                        _ => "it's off or out of reach".to_string(),
                    })
                } else if !p.moves {
                    Some("it runs an older Harbor: update it first".into())
                } else if !p.accounts.iter().any(|(_, _, kind)| kind == "claude") {
                    Some("it has no Claude account".into())
                } else {
                    None
                };
                Target { name: if p.name.is_empty() { crate::mesh::label(&p.id) } else { p.name.clone() }, id: p.id, why }
            })
            .collect();
        (blocker, targets)
    }

    /// `GET /v1/chats/{id}/move_targets` (and the desktop's menu): with the code's state.
    pub fn api_move_targets(&self, chat_id: i64) -> Value {
        let (mut blocker, mut targets) = self.move_pc_targets(chat_id);
        if blocker.is_none() {
            if let Some(Err(e)) = self.chat(chat_id).filter(|c| c.repo_id.is_some()).map(|c| code_state(&self.chat_cwd(c), self.worktree_of(c).is_some())) {
                for t in &mut targets {
                    t.why = Some(e.clone());
                }
                blocker = Some(e);
            }
        }
        json!({ "why": blocker, "targets": targets })
    }

    /// Starts handing `chat_id` (and its sub-agents) over to PC `pc`. Ok: the PC's name; the
    /// outcome comes later (a notice in the chat; the chat turns into a copy of that PC's).
    pub fn move_pc(&mut self, chat_id: i64, pc: &str, ctx: &egui::Context) -> Result<String, String> {
        let (blocker, targets) = self.move_pc_targets(chat_id);
        if let Some(b) = blocker {
            return Err(b);
        }
        let t = targets.into_iter().find(|t| t.id == pc).ok_or("that PC isn't one of this PC's")?;
        if let Some(why) = t.why {
            return Err(format!("{} can't take it: {why}", t.name));
        }
        let peer = self.api.hub.mesh.peer(pc).ok_or("that PC isn't one of this PC's")?;
        let lead = self.chat(chat_id).cloned().ok_or("no such chat")?;
        let mut chats = vec![lead.clone()];
        chats.extend(self.subs_of(chat_id));
        // Where it works: clean, or it doesn't go.
        let worktree = self.worktree_of(&lead);
        let code = if lead.repo_id.is_some() { code_state(&self.chat_cwd(&lead), worktree.is_some())? } else { Code::default() };
        let repo = lead.repo_id.and_then(|r| self.repo(r)).cloned();
        let email = self.account(&lead.account).map(|a| a.email.clone()).unwrap_or_default();
        let mut sessions = vec![];
        let mut list = vec![];
        for c in &chats {
            let acc = self.account(&c.account).cloned().ok_or("an account of the chat is gone")?;
            if c.started && !c.session_id.is_empty() {
                if !valid_sid(&c.session_id) {
                    return Err(format!("{}'s session id looks wrong", c.name));
                }
                let files = session_files(&acc.config_dir, &c.session_id).ok_or_else(|| format!("{}'s Claude session isn't on this PC", if c.id == chat_id { "its" } else { c.name.as_str() }))?;
                if files.len() > MAX_FILES {
                    return Err(format!("{}'s session has too many files to send", c.name));
                }
                sessions.push((c.session_id.clone(), files));
            }
            let items = match self.transcripts.get(&c.id) {
                Some(t) if !t.items.is_empty() => t.items.clone(),
                _ => self.store.items(c.id),
            };
            let parent = c.parent.and_then(|p| self.chat(p)).map(|p| p.gid.clone());
            list.push(json!({
                "gid": c.gid, "title": c.title, "session_id": c.session_id, "started": c.started, "model": c.model,
                "effort": c.effort, "access": c.access, "settled": c.settled, "role": c.role.as_str(), "parent": parent,
                "name": c.name, "items": items,
            }));
        }
        let me = self.api.hub.mesh.me().name;
        let project = repo.as_ref().map(|r| {
            let folder = r.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            json!({ "name": r.name, "folder": folder, "remote": code.remote })
        });
        let check = json!({
            "gid": lead.gid, "kind": "claude", "email": email, "project": project, "from": me,
            "code": { "branch": code.branch, "sha": code.sha },
            "worktree": if code.worktree { json!({ "branch": code.branch, "remote": code.remote }) } else { Value::Null },
        });
        let push = worktree.filter(|_| code.worktree).map(|w| (w, code.branch.clone(), code.remote.clone()));
        let payload = serde_json::to_vec(&json!({ "chats": list })).unwrap_or_default();
        let handoff = Handoff { dest: peer.dest(), peer: t.name.clone(), check, payload, sessions, push };
        self.movepc.moving.insert(lead.gid.clone(), (pc.to_string(), t.name.clone()));
        self.movepc.sending.insert(lead.gid.clone());
        self.move_pc_save();
        self.api_touch(chat_id);
        let (gid, pc, name) = (lead.gid.clone(), pc.to_string(), t.name.clone());
        self.ws_spawn(ctx, move || send(handoff), move |app, outcome, ctx| app.move_pc_done(chat_id, &gid, &pc, &name, outcome, ctx));
        Ok(t.name)
    }

    fn move_pc_done(&mut self, chat_id: i64, gid: &str, pc: &str, name: &str, outcome: Outcome, ctx: &egui::Context) {
        self.movepc.sending.remove(gid);
        // (Settled meanwhile by the target's chat list.)
        if !self.movepc.moving.contains_key(gid) {
            return;
        }
        match outcome {
            Outcome::Done(ids) => {
                self.move_pc_release(gid, pc, &ids, ctx);
                crate::picker::show_toast(ctx, format!("Moved to {name}: it goes on there"));
            }
            Outcome::Refused(why) => {
                self.movepc.moving.remove(gid);
                self.move_pc_save();
                self.notice(chat_id, "alert", &format!("Couldn't move to {name}: {why}"), "");
                crate::picker::show_toast(ctx, format!("Couldn't move to {name}: {why}"));
                self.move_pc_resume(chat_id, ctx);
            }
            Outcome::Unknown(why) => {
                self.notice(chat_id, "alert", &format!("Moving to {name}: no answer yet ({why}). The chat stays here and takes no turns until {name} answers."), "");
                self.api_touch(chat_id);
            }
        }
    }

    /// What waited while the chat was being handed over: its turn, here.
    fn move_pc_resume(&mut self, chat_id: i64, ctx: &egui::Context) {
        if let Some(q) = self.pending.remove(&chat_id).filter(|q| !q.is_empty()) {
            self.start_turn(chat_id, q.join("\n\n---\n\n"), vec![], ctx);
        }
        for (text, files, mentions) in self.movepc.held.remove(&chat_id).unwrap_or_default() {
            self.send_to(chat_id, text, files, mentions, ctx);
        }
        self.api_touch(chat_id);
    }

    /// The target took the chat: this PC's chat and its sub-agents become copies of its.
    fn move_pc_release(&mut self, gid: &str, pc: &str, ids: &HashMap<String, i64>, ctx: &egui::Context) {
        self.movepc.moving.remove(gid);
        self.move_pc_save();
        let Some(lead) = self.chats.iter().find(|c| c.gid == gid && !c.foreign()).map(|c| c.id) else { return };
        // Its worktree here is clean and pushed: it goes (kept, with a toast, if it changed since).
        self.ws_drop(lead, ctx);
        let mut all = vec![lead];
        all.extend(self.subs_of(lead).into_iter().map(|s| s.id));
        let waiting = self.pending.remove(&lead).unwrap_or_default();
        for id in &all {
            let Some(c) = self.chat_mut(*id) else { continue };
            let Some(hid) = ids.get(&c.gid).copied() else { continue };
            c.home = pc.to_string();
            c.home_id = hid;
            c.session_id = String::new();
            let c = c.clone();
            self.store.save_chat(&c);
            self.store.set_home(c.id, &c.home, c.home_id);
            self.mesh.status.insert(c.id, Default::default());
            crate::workspace::forget(*id);
        }
        self.mesh_index();
        for id in &all {
            self.api_touch(*id);
        }
        self.api.hub.touch(None, true);
        // What was sent meanwhile goes to its new home.
        if !waiting.is_empty() {
            let text = waiting.join("\n\n---\n\n");
            self.mesh_send(lead, &text, &[], &[]);
        }
        for (text, files, mentions) in self.movepc.held.remove(&lead).unwrap_or_default() {
            self.mesh_send(lead, &text, &files, &mentions);
        }
    }

    /// A target's chat list while a move to it waits for an answer (mesh.rs, before the copies
    /// are applied): it lists the chat as its own: the move happened; a full list without it:
    /// it didn't, and the chat goes on here.
    pub fn move_pc_reconcile(&mut self, peer: &str, body: &Value, ctx: &egui::Context) {
        let waiting: Vec<(String, String)> = self.movepc.moving.iter().filter(|(_, (p, _))| p == peer).map(|(g, (_, n))| (g.clone(), n.clone())).collect();
        if waiting.is_empty() {
            return;
        }
        let listed: HashMap<String, i64> = body["chats"].as_array().into_iter().flatten().filter_map(|m| Some((m["gid"].as_str()?.to_string(), m["id"].as_i64()?))).collect();
        let full = body["full"].as_bool().unwrap_or(false);
        for (gid, name) in waiting {
            if listed.contains_key(&gid) {
                self.move_pc_release(&gid, peer, &listed, ctx);
            } else if full && !self.movepc.sending.contains(&gid) {
                self.movepc.moving.remove(&gid);
                self.move_pc_save();
                if let Some(id) = self.chats.iter().find(|c| c.gid == gid).map(|c| c.id) {
                    self.notice(id, "alert", &format!("{name} didn't take the chat: it stays on this PC"), "");
                    self.move_pc_resume(id, ctx);
                }
            }
        }
    }

    // ---------------------------------------------------------------- the target

    /// This PC's projects as matching sees them (only those whose folder is here).
    fn move_candidates(&self) -> Vec<Candidate> {
        self.repos
            .iter()
            .filter(|r| r.path.is_dir())
            .map(|r| Candidate { id: r.id, name: r.name.clone(), folder: r.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), remote: remote_url(&r.path) })
            .collect()
    }

    /// The project and account the chat would get here, or why it can't come.
    fn move_plan(&self, body: &Value) -> Result<(Option<i64>, String), String> {
        let me = self.api.hub.mesh.me().name;
        if body["kind"].as_str() != Some("claude") {
            return Err(format!("{me} only takes Claude chats for now"));
        }
        let cands: Vec<AccountCand> = self
            .accounts
            .iter()
            .filter(|a| a.kind == Kind::Claude && a.installed() && a.logged_in != Some(false) && self.blocked(&a.id).is_none() && self.over_cap(&a.id).is_none())
            .map(|a| AccountCand { id: a.id.clone(), email: a.email.clone(), usage: self.usage_of(&a.id) })
            .collect();
        let default = self.store.get("default_account").unwrap_or_else(|| "claude".into());
        let account = pick_account(&cands, body["email"].as_str().unwrap_or(""), &default).ok_or_else(|| format!("{me} has no Claude account signed in that can take it now"))?;
        let p = &body["project"];
        if p.is_null() {
            return Ok((None, account));
        }
        let s = |k: &str| p[k].as_str().unwrap_or("").to_string();
        let repo = match_project(&self.move_candidates(), &s("remote"), &s("folder"), &s("name")).ok_or_else(|| {
            let what = if s("remote").is_empty() { s("name") } else { format!("{} ({})", s("name"), s("remote")) };
            format!("{me} has no project for {what}: clone it there and add it to Harbor first")
        })?;
        if body["worktree"].is_object() && crate::worktree::head(&self.repo(repo).map(|r| r.path.clone()).unwrap_or_default()).is_none() {
            return Err(format!("{me}'s copy of the project isn't a git checkout"));
        }
        Ok((Some(repo), account))
    }

    /// Lead and sub-agents this PC owns with these gids: gid → id.
    fn move_owned(&self, gid: &str) -> Option<HashMap<String, i64>> {
        let lead = self.chats.iter().find(|c| c.gid == gid && !c.foreign())?;
        let mut m: HashMap<String, i64> = HashMap::from([(lead.gid.clone(), lead.id)]);
        m.extend(self.subs_of(lead.id).into_iter().map(|s| (s.gid, s.id)));
        Some(m)
    }

    /// `POST /mesh/v1/adopt/check` from the chat's home: whether this PC owns it already (an
    /// answer that got lost), is taking it now, or could take it (with `kind`).
    pub fn move_pc_check(&self, peer: &str, body: &Value) -> Reply {
        let gid = body["gid"].as_str().unwrap_or("");
        if gid.is_empty() {
            return err(400, "no chat");
        }
        if let Some(ids) = self.move_owned(gid) {
            return ok(json!({ "ok": true, "owns": true, "ids": ids }));
        }
        if self.movepc.adopting.contains(gid) {
            return ok(json!({ "ok": false, "owns": false, "busy": true }));
        }
        if body["kind"].is_null() {
            return ok(json!({ "ok": false, "owns": false, "busy": false }));
        }
        if let Some(c) = self.chats.iter().find(|c| c.gid == gid).filter(|c| c.home != peer) {
            return ok(json!({ "ok": false, "owns": false, "why": format!("this chat belongs to {} here, not to you", self.home_name(c)) }));
        }
        match self.move_plan(body) {
            Ok((repo, account)) => {
                let project = repo.and_then(|r| self.repo(r)).map(|r| r.name.clone());
                let acc = self.account(&account).map(|a| a.short()).unwrap_or(account);
                ok(json!({ "ok": true, "owns": false, "project": project, "account": acc }))
            }
            Err(why) => ok(json!({ "ok": false, "owns": false, "why": why })),
        }
    }

    /// `POST /mesh/v1/adopt` from the chat's home: takes the chat (answered from a thread:
    /// Reply status 0), or says why not.
    pub fn move_pc_adopt(&mut self, call: &Call, ctx: &egui::Context) -> Reply {
        let body = &call.body;
        let peer = call.device.clone();
        let gid = body["gid"].as_str().unwrap_or("").to_string();
        if gid.is_empty() {
            return err(400, "no chat");
        }
        if let Some(ids) = self.move_owned(&gid) {
            return ok(json!({ "ok": true, "ids": ids }));
        }
        if self.movepc.adopting.contains(&gid) {
            return err(409, "already taking this chat");
        }
        let deadline = body["deadline_ms"].as_i64().unwrap_or(0);
        if now_ms() > deadline {
            return err(409, "the call came too late");
        }
        if let Some(c) = self.chats.iter().find(|c| c.gid == gid).filter(|c| c.home != peer) {
            return err(409, format!("this chat belongs to {} here, not to you", self.home_name(c)));
        }
        let (repo, account) = match self.move_plan(body) {
            Ok(p) => p,
            Err(e) => return err(409, e),
        };
        let Some(payload) = body["payload"].as_str().and_then(api::resolve_upload) else { return err(400, "the chat's upload is missing") };
        let Ok(payload) = std::fs::read(&payload).map_err(|_| ()).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|_| ())) else { return err(400, "the chat's upload isn't readable") };
        let chats: Vec<Value> = payload["chats"].as_array().cloned().unwrap_or_default();
        if chats.first().and_then(|c| c["gid"].as_str()) != Some(gid.as_str()) {
            return err(400, "the upload is another chat");
        }
        // Every file and its place, checked before anything is written.
        let mut uploads: Vec<PathBuf> = body["payload"].as_str().and_then(api::resolve_upload).into_iter().collect();
        let mut sessions: Vec<(String, Vec<(String, PathBuf)>)> = vec![];
        for s in body["sessions"].as_array().into_iter().flatten() {
            let sid = s["sid"].as_str().unwrap_or("").to_string();
            let mut files = vec![];
            for f in s["files"].as_array().into_iter().flatten() {
                let rel = f["rel"].as_str().unwrap_or("").to_string();
                let Some(p) = f["upload"].as_str().and_then(api::resolve_upload) else { return err(400, "a session file is missing") };
                if !safe_rel(&sid, &rel) {
                    return err(400, format!("refused a session file outside its folder: {rel}"));
                }
                uploads.push(p.clone());
                files.push((rel, p));
            }
            if files.len() > MAX_FILES + 1 {
                return err(400, "too many session files");
            }
            sessions.push((sid, files));
        }
        let config = self.account(&account).and_then(|a| a.config_dir.clone());
        let repo_path = repo.and_then(|r| self.repo(r)).map(|r| r.path.clone());
        let worktree = body["worktree"].is_object().then(|| (body["worktree"]["branch"].as_str().unwrap_or("").to_string(), body["worktree"]["remote"].as_str().unwrap_or("").to_string()));
        let home = store::home();
        self.movepc.adopting.insert(gid.clone());
        let reply = call.reply.clone();
        let body = body.clone();
        // Off the UI thread: the branch is fetched and checked out, the sessions written.
        let work = move || -> Result<Option<PathBuf>, String> {
            let wt = match (&worktree, &repo_path) {
                (Some((branch, remote)), Some(repo)) if !branch.is_empty() => Some(fetch_worktree(repo, branch, remote)?),
                _ => None,
            };
            let cwd = wt.clone().or(repo_path.clone()).unwrap_or(home);
            let dir = crate::movechat::session_dir(&config, &cwd);
            for (sid, files) in &sessions {
                if let Err(e) = place(&dir, sid, files) {
                    if let (Some(w), Some(r)) = (&wt, &repo_path) {
                        let _ = crate::worktree::remove(r, w);
                    }
                    return Err(e);
                }
            }
            Ok(wt)
        };
        self.ws_spawn(ctx, work, move |app, r, _| {
            app.movepc.adopting.remove(&gid);
            for u in &uploads {
                let _ = std::fs::remove_file(u);
            }
            let answer = match r {
                Err(e) => err(409, e),
                Ok(wt) if now_ms() > deadline => {
                    // The source has given up waiting: it keeps the chat.
                    if let (Some(w), Some(r)) = (wt, repo.and_then(|r| app.repo(r)).map(|r| r.path.clone())) {
                        std::thread::spawn(move || crate::worktree::remove(&r, &w));
                    }
                    err(409, "it took too long")
                }
                Ok(wt) => {
                    let ids = app.move_pc_take(&peer, &chats, repo, &account, wt, &body);
                    ok(json!({ "ok": true, "ids": ids }))
                }
            };
            let _ = reply.send(answer);
        });
        Reply { status: 0, body: Value::Null }
    }

    /// Makes the received chats this PC's own (the copies of them become the chats).
    fn move_pc_take(&mut self, peer: &str, chats: &[Value], repo: Option<i64>, account: &str, wt: Option<PathBuf>, body: &Value) -> HashMap<String, i64> {
        let mut ids: HashMap<String, i64> = HashMap::new();
        for m in chats {
            let s = |k: &str| m[k].as_str().unwrap_or("").to_string();
            let gid = s("gid");
            if gid.is_empty() {
                continue;
            }
            let existing = self.chats.iter().find(|c| c.gid == gid).map(|c| c.id);
            let parent = m["parent"].as_str().and_then(|g| ids.get(g).copied().or_else(|| self.chats.iter().find(|c| c.gid == g).map(|c| c.id)));
            let c = Chat {
                id: existing.unwrap_or(0),
                repo_id: repo,
                title: s("title"),
                session_id: s("session_id"),
                started: m["started"].as_bool().unwrap_or(false),
                account: account.to_string(),
                model: s("model"),
                effort: s("effort"),
                access: s("access"),
                settled: m["settled"].as_bool().unwrap_or(false),
                updated: store::now(),
                role: Role::parse(m["role"].as_str().unwrap_or("chat")),
                parent,
                name: s("name"),
                device: String::new(),
                gid: gid.clone(),
                home: String::new(),
                home_id: 0,
            };
            let id = match existing {
                Some(id) => {
                    if let Some(old) = self.chat_mut(id) {
                        *old = c.clone();
                    }
                    self.store.save_chat(&c);
                    self.store.set_home(id, "", 0);
                    id
                }
                None => {
                    let c = self.store.create_chat(c);
                    let id = c.id;
                    self.chats.push(c);
                    id
                }
            };
            let items: Vec<Item> = serde_json::from_value(m["items"].clone()).unwrap_or_default();
            self.store.save_items(id, &items);
            self.transcripts.entry(id).or_default().items = items;
            self.mesh.status.remove(&id);
            crate::workspace::forget(id);
            ids.insert(gid, id);
        }
        self.mesh_index();
        let lead = chats.first().and_then(|m| m["gid"].as_str()).and_then(|g| ids.get(g)).copied();
        if let Some(lead) = lead {
            if let Some(w) = &wt {
                self.store.set(&format!("worktree:{lead}"), &w.to_string_lossy());
            }
            let from = body["from"].as_str().filter(|f| !f.is_empty()).map(String::from).unwrap_or_else(|| self.api.hub.mesh.name_of(peer));
            let acc = self.account(account).map(|a| a.short()).unwrap_or_else(|| account.to_string());
            let mut detail = format!("It runs as {acc} here");
            if let Some(r) = repo.and_then(|r| self.repo(r)) {
                detail.push_str(&format!(", in {}", crate::app::tilde(&r.path)));
            }
            if let Some(w) = &wt {
                detail.push_str(&format!(", worktree {}", w.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
            }
            let code = &body["code"];
            if let (Some(b), Some(sha)) = (code["branch"].as_str().filter(|b| !b.is_empty()), code["sha"].as_str()) {
                detail.push_str(&format!(". On {from} it was on {b} at {sha}"));
                // In the checkout (not its own worktree): say where this PC's checkout is.
                let path = repo.and_then(|r| self.repo(r)).map(|r| r.path.clone()).filter(|_| wt.is_none());
                if let Some((p, h)) = path.and_then(|p| crate::worktree::head(&p).map(|h| (p, h))) {
                    let here = git(&p, &["rev-parse", "--short", "HEAD"], GIT_TIMEOUT).unwrap_or_default();
                    detail.push_str(&format!("; here the checkout is on {} at {here}", h.label()));
                }
            }
            detail.push('.');
            self.notice(lead, "monitor", &format!("Moved here from {from}"), &detail);
        }
        for id in ids.values() {
            self.api_touch(*id);
        }
        self.api.hub.touch(None, true);
        ids
    }

    // ---------------------------------------------------------------- the desktop's menu

    /// "Move to PC…" in a chat's menu: the PCs of the mesh, greyed out with why when the chat
    /// can't go there. A copy asks its home PC (once per opening).
    pub fn move_pc_menu(&mut self, ui: &mut egui::Ui, c: &Chat) {
        use crate::icons as ic;
        use crate::widgets as w;
        if c.role == Role::Sub {
            return;
        }
        let list: Result<(Option<String>, Vec<Target>), String> = if c.foreign() {
            match self.movepc.asked.get(&c.id) {
                Some((at, Some(r))) if at.elapsed() < Duration::from_secs(20) => r.clone(),
                Some((at, None)) if at.elapsed() < Duration::from_secs(20) => Err("Asking its PC…".into()),
                _ => {
                    self.move_pc_ask(c.id, ui.ctx());
                    Err("Asking its PC…".into())
                }
            }
        } else {
            let (blocker, mut targets) = self.move_pc_targets(c.id);
            // The code's state, as the bar reads it (on a thread, cached).
            let dirty = (blocker.is_none() && c.repo_id.is_some()).then(|| self.ws_head(&self.chat_cwd(c), ui.ctx())).flatten().filter(|h| h.dirty > 0);
            match dirty {
                Some(h) => {
                    let why = format!("{} uncommitted change{}: commit or stash them first", h.dirty, if h.dirty == 1 { "" } else { "s" });
                    for t in &mut targets {
                        t.why = Some(why.clone());
                    }
                    Ok((Some(why), targets))
                }
                None => Ok((blocker, targets)),
            }
        };
        let (blocker, targets) = match list {
            Ok(x) => x,
            Err(e) => {
                ui.add_enabled(false, egui::Button::new("Move to PC…")).on_disabled_hover_text(e);
                return;
            }
        };
        if targets.is_empty() {
            ui.add_enabled(false, egui::Button::new("Move to PC…")).on_disabled_hover_text("No other PCs: pair one in Settings › Devices");
            return;
        }
        if let Some(why) = blocker {
            ui.add_enabled(false, egui::Button::new("Move to PC…")).on_disabled_hover_text(why);
            return;
        }
        ui.menu_button("Move to PC…", |ui| {
            ui.set_min_width(240.0);
            let mut to: Option<(String, String)> = None;
            for t in &targets {
                let sub = t.why.clone().unwrap_or_else(|| "Goes on there".into());
                let r = ui.add_enabled_ui(t.why.is_none(), |ui| w::menu_item(ui, ic::MONITOR, &t.name, Some(&sub), false)).inner;
                if r.clicked() {
                    to = Some((t.id.clone(), t.name.clone()));
                }
            }
            if let Some((pc, name)) = to {
                ui.close();
                let ctx = ui.ctx().clone();
                if c.foreign() {
                    self.movepc.asked.remove(&c.id);
                    self.mesh_move_pc(c.id, &pc);
                    crate::picker::show_toast(&ctx, format!("Moving to {name}…"));
                } else {
                    match self.move_pc(c.id, &pc, &ctx) {
                        Ok(n) => crate::picker::show_toast(&ctx, format!("Moving to {n}…")),
                        Err(e) => crate::picker::show_toast(&ctx, format!("Couldn't move this chat: {e}")),
                    }
                }
            }
        });
    }

    /// A copy's targets, from its home PC (on a thread).
    fn move_pc_ask(&mut self, chat: i64, ctx: &egui::Context) {
        let Some(c) = self.chat(chat).filter(|c| c.foreign()).cloned() else { return };
        self.movepc.asked.insert(chat, (Instant::now(), None));
        let Some(peer) = self.api.hub.mesh.peer(&c.home).filter(|p| p.online) else {
            let name = self.home_name(&c);
            self.movepc.asked.insert(chat, (Instant::now(), Some(Err(format!("{name} is off: it moves the chat")))));
            return;
        };
        let (dest, hid) = (peer.dest(), c.home_id);
        let call = json!({ "method": "GET", "path": ["v1", "chats", hid.to_string(), "move_targets"], "body": null });
        self.ws_spawn(
            ctx,
            move || -> Result<(Option<String>, Vec<Target>), String> {
                match post(&dest, "/mesh/v1/call", &call, Duration::from_secs(20)) {
                    Ok((200, v)) => Ok((v["why"].as_str().map(String::from), serde_json::from_value(v["targets"].clone()).unwrap_or_default())),
                    Ok((404, _)) => Err("its PC runs an older Harbor".into()),
                    Ok((_, v)) => Err(v["error"].as_str().unwrap_or("its PC didn't say").to_string()),
                    Err(e) => Err(e),
                }
            },
            move |app, r, _| {
                app.movepc.asked.insert(chat, (Instant::now(), Some(r)));
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("harbor-movepc-{tag}-{}", crate::bridge::token().unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn remotes_compare_by_host_and_path() {
        let all = ["git@github.com:Sam/App.git", "https://github.com/sam/app", "https://github.com/sam/app.git/", "ssh://git@github.com:22/sam/app", "https://token@github.com/sam/app"];
        for u in all {
            assert_eq!(normalize_remote(u), "github.com/sam/app", "{u}");
        }
        assert_ne!(normalize_remote("git@gitlab.com:sam/app.git"), normalize_remote("git@github.com:sam/app.git"));
    }

    #[test]
    fn projects_match_by_remote_then_name() {
        let c = |id, name: &str, folder: &str, remote: &str| Candidate { id, name: name.into(), folder: folder.into(), remote: remote.into() };
        let here = vec![c(1, "app", "app", "git@github.com:sam/other.git"), c(2, "work", "app-clone", "https://github.com/sam/app"), c(3, "notes", "notes", "")];
        // The remote wins over a folder of the same name.
        assert_eq!(match_project(&here, "git@github.com:sam/app.git", "app", "app"), Some(2));
        // A different repository with the same name isn't it.
        assert_eq!(match_project(&here, "git@github.com:sam/third.git", "app", "app"), None);
        // No remote on either side: the name decides.
        assert_eq!(match_project(&here, "", "notes", "notes"), Some(3));
        assert_eq!(match_project(&here, "git@github.com:sam/notes.git", "notes", "notes"), Some(3));
        assert_eq!(match_project(&here, "", "nothing", "nothing"), None);
    }

    #[test]
    fn accounts_prefer_the_same_login_then_the_default() {
        let a = |id: &str, email: &str, w: f64| AccountCand { id: id.into(), email: email.into(), usage: (w, 0.0) };
        let here = vec![a("claude", "sam@example.com", 0.9), a("claude2", "kim@example.com", 0.1), a("claude3", "", 0.5)];
        assert_eq!(pick_account(&here, "KIM@example.com", "claude").as_deref(), Some("claude2"));
        assert_eq!(pick_account(&here, "lee@example.com", "claude3").as_deref(), Some("claude3"));
        // No default among them: the most quota left.
        assert_eq!(pick_account(&here, "", "gone").as_deref(), Some("claude2"));
        assert_eq!(pick_account(&[], "sam@example.com", "claude"), None);
    }

    #[test]
    fn session_files_stay_in_their_folder() {
        let sid = "0b7c1a7e-1111-4222-8333-944455556666";
        assert!(safe_rel(sid, &format!("{sid}.jsonl")));
        assert!(safe_rel(sid, &format!("{sid}/subagents/agent-1.jsonl")));
        assert!(!safe_rel(sid, "other.jsonl"));
        assert!(!safe_rel(sid, &format!("{sid}/../../.ssh/authorized_keys")));
        assert!(!safe_rel(sid, &format!("/{sid}/x")));
        assert!(!safe_rel(sid, &format!("{sid}x/y")));
        assert!(!safe_rel("../x", "../x.jsonl"));
        assert!(!valid_sid("a/b") && !valid_sid("") && valid_sid(sid));
    }

    #[test]
    fn sessions_are_gathered_and_placed_under_the_project_slug() {
        let root = tmp("place");
        let cfg = Some(root.join("from"));
        let sid = "5d1e0c55-aaaa-4bbb-8ccc-0123456789ab";
        let old = root.join("from/projects/-src-app");
        std::fs::create_dir_all(old.join(sid).join("subagents")).unwrap();
        std::fs::write(old.join(format!("{sid}.jsonl")), "{\"a\":1}\n").unwrap();
        std::fs::write(old.join(sid).join("subagents/agent-1.jsonl"), "{}\n").unwrap();
        let mut files = session_files(&cfg, sid).expect("found");
        files.sort();
        let rels: Vec<&str> = files.iter().map(|(r, _)| r.as_str()).collect();
        assert_eq!(rels, vec![format!("{sid}.jsonl").as_str(), format!("{sid}/subagents/agent-1.jsonl").as_str()]);
        // On the target: its account's folder for its own path of the project.
        let to_cfg = Some(root.join("to"));
        let cwd = root.join("elsewhere/app");
        std::fs::create_dir_all(&cwd).unwrap();
        let dir = crate::movechat::session_dir(&to_cfg, &cwd);
        place(&dir, sid, &files).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(format!("{sid}.jsonl"))).unwrap(), "{\"a\":1}\n");
        assert!(dir.join(sid).join("subagents/agent-1.jsonl").is_file());
        // A bad place: nothing written.
        let bad = vec![(format!("{sid}.jsonl"), files[0].1.clone()), ("../evil".to_string(), files[0].1.clone())];
        let other = root.join("other");
        assert!(place(&other, sid, &bad).is_err());
        assert!(!other.exists());
        assert!(session_files(&cfg, "no-such-session").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn dirty_folders_dont_move() {
        let root = tmp("code");
        let g = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(&root).args(args).output().unwrap().status.success(), "{args:?}");
        g(&["init", "-q", "-b", "main"]);
        g(&["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"]);
        g(&["remote", "add", "origin", "git@github.com:sam/app.git"]);
        let c = code_state(&root, false).unwrap();
        assert_eq!((c.branch.as_str(), normalize_remote(&c.remote).as_str()), ("main", "github.com/sam/app"));
        assert!(!c.sha.is_empty());
        std::fs::write(root.join("new.txt"), "x").unwrap();
        let e = code_state(&root, false).unwrap_err();
        assert!(e.contains("1 uncommitted change") && e.contains("commit or stash"), "{e}");
        // Not a git folder: nothing to check.
        let plain = tmp("plain");
        assert!(code_state(&plain, false).is_ok());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(plain);
    }
}
