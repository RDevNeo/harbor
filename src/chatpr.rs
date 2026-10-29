//! The pull request of a chat's branch, so it's clear a chat opened one and whether it's merged:
//! the composer footer shows it ("PR #123 · Open", a click opens it on GitHub), the sidebar row
//! of a chat in its own worktree has a mark (a checkout's branch is every chat's there, so their
//! rows don't), and phones get it as chat JSON `pr` (android/PROTOCOL.md).
//!
//! The hub looks it up with the GitHub CLI (`gh pr list --head <branch>`) on a thread, never on
//! the UI thread: while the chat is shown (again after a minute), after each of its turns (agents
//! open and merge PRs in turns), for open ones every few minutes, so a merge on GitHub reaches
//! rows too, and once for every unsettled chat in a worktree after a start (a few at a time,
//! newest first), so rows have marks without being opened. Branches never pushed cost git calls
//! only, no gh. What was found is kept in kv `chat_prs`, so rows have their marks after a
//! restart. No gh, no GitHub remote, a branch never pushed, the default branch, a detached head
//! or no PR: nothing is shown. Sub-agents work in their lead's folder, so they share its PR.

use crate::app::App;
use crate::store::{Chat, Role};
use eframe::egui;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

/// A shown chat's PR is looked up again after this long.
pub const SHOWN_TTL: Duration = Duration::from_secs(60);
/// Open and draft PRs of chats nobody looks at, so a merge on GitHub reaches their rows.
const SWEEP_TTL: Duration = Duration::from_secs(600);
/// How often the sweep looks for those (and chats not looked up yet), and how many it looks up at once.
const SWEEP_EVERY: Duration = Duration::from_secs(20);
const SWEEP_MAX: usize = 3;
/// After gh failed (not installed, signed out, offline): don't ask every minute.
const FAILED_TTL: Duration = Duration::from_secs(300);
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const GH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

impl PrState {
    pub fn word(self) -> &'static str {
        match self {
            PrState::Open => "Open",
            PrState::Draft => "Draft",
            PrState::Merged => "Merged",
            PrState::Closed => "Closed",
        }
    }

    fn key(self) -> &'static str {
        match self {
            PrState::Open => "open",
            PrState::Draft => "draft",
            PrState::Merged => "merged",
            PrState::Closed => "closed",
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            PrState::Open => crate::icons::PR_OPEN,
            PrState::Draft => crate::icons::PR_DRAFT,
            PrState::Merged => crate::icons::GIT_MERGE,
            PrState::Closed => crate::icons::PR_CLOSED,
        }
    }

    /// The icon's colour (the PR list's, with open ones green as on GitHub).
    pub fn color(self, t: &crate::theme::Tokens) -> egui::Color32 {
        match self {
            PrState::Open => t.green(900),
            PrState::Draft => t.gray(800),
            PrState::Merged => crate::prs::merged_color(t),
            PrState::Closed => t.red(900),
        }
    }
}

/// A chat's PR, as the footer, the row and phones show it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatPr {
    pub number: u64,
    pub state: PrState,
    pub url: String,
    pub title: String,
    /// The local branch it was found for: looked up with it again once the worktree is gone.
    #[serde(default)]
    pub branch: String,
}

impl ChatPr {
    /// "PR #123 · Merged".
    pub fn label(&self) -> String {
        format!("PR #{} · {}", self.number, self.state.word())
    }

    pub fn tip(&self) -> String {
        format!("{}\n{}\nOpens it on GitHub", self.label(), self.title)
    }

    /// Chat JSON `pr` (phones, peers).
    pub fn json(&self) -> Value {
        json!({ "number": self.number, "state": self.state.key(), "label": self.label(), "title": self.title, "url": self.url })
    }

    /// A peer's `pr` (None when it has none, or is older than 0.83).
    pub fn from_json(v: &Value) -> Option<ChatPr> {
        let state = match v["state"].as_str()? {
            "open" => PrState::Open,
            "draft" => PrState::Draft,
            "merged" => PrState::Merged,
            "closed" => PrState::Closed,
            _ => return None,
        };
        Some(ChatPr { number: v["number"].as_u64()?, state, url: v["url"].as_str()?.to_string(), title: v["title"].as_str().unwrap_or("").to_string(), branch: String::new() })
    }
}

#[derive(Default)]
pub struct State {
    /// Lead chat → its PR, as last found.
    pub found: HashMap<i64, ChatPr>,
    /// Lead chat → when it was last looked up, and whether gh failed then.
    checked: HashMap<i64, (Instant, bool)>,
    busy: HashSet<i64>,
    /// Asked for again while a lookup ran: looked up once more when it lands.
    again: HashSet<i64>,
    swept: Option<Instant>,
    /// Chats in worktrees still to look up once after the start (newest last).
    todo: Option<Vec<i64>>,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0").arg("-C").arg(dir).args(args);
    let out = crate::git::output_within(&mut cmd, GIT_TIMEOUT).ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}

/// Where a branch's PR is looked for: its head branch on GitHub, the repo the PR is in and the
/// owner of the repo it's pushed to. None: it can't have one (not pushed, the default branch,
/// not a GitHub remote).
#[derive(Debug, PartialEq)]
struct Where {
    head: String,
    repos: Vec<String>,
    owner: String,
}

fn place(dir: &Path, branch: &str, known: bool) -> Option<Where> {
    // Pushed with an upstream: its remote and name there; else origin and its own name.
    let remote = git(dir, &["config", "--get", &format!("branch.{branch}.remote")]).filter(|r| r != ".").unwrap_or_else(|| "origin".into());
    let head = git(dir, &["config", "--get", &format!("branch.{branch}.merge")]).and_then(|m| m.strip_prefix("refs/heads/").map(String::from)).unwrap_or_else(|| branch.to_string());
    let pushed = crate::prs::github_repo(&git(dir, &["remote", "get-url", &remote])?)?;
    // The default branch has no PR of its own.
    let default = git(dir, &["symbolic-ref", "--short", &format!("refs/remotes/{remote}/HEAD")]).and_then(|s| s.strip_prefix(&format!("{remote}/")).map(String::from));
    if default.as_deref().map_or(head == "main" || head == "master", |d| d == head) {
        return None;
    }
    // Never pushed: no PR (unless one was found before; GitHub may have deleted the branch on merge).
    if !known && git(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote}/{head}")]).is_none() {
        return None;
    }
    // A fork's PRs live in the repo it was forked from (remote `upstream`), then its own.
    let mut repos: Vec<String> = git(dir, &["remote", "get-url", "upstream"]).as_deref().and_then(crate::prs::github_repo).into_iter().collect();
    if !repos.contains(&pushed) {
        repos.push(pushed.clone());
    }
    let owner = pushed.split('/').next().unwrap_or("").to_string();
    Some(Where { head, repos, owner })
}

fn gh_prs(repo: &str, head: &str) -> Result<Value, String> {
    let mut cmd = Command::new("gh");
    cmd.args(["pr", "list", "--repo", repo, "--head", head, "--state", "all", "--limit", "20", "--json", "number,state,isDraft,url,title,headRefName,headRepositoryOwner"])
        .env("PATH", crate::providers::child_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1");
    let out = match crate::git::output_within(&mut cmd, GH_TIMEOUT) {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("gh isn't installed".into()),
        Err(e) => return Err(format!("gh: {e}")),
    };
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr);
        return Err(e.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("gh failed").to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("gh: {e}"))
}

/// The PR of `head` from gh's list: pushed by `owner` (a fork's PR of the same branch name is
/// someone else's), an open one first, else the newest.
fn pick(list: &Value, head: &str, owner: &str, branch: &str) -> Option<ChatPr> {
    let rows: Vec<&Value> = list
        .as_array()?
        .iter()
        .filter(|p| p["headRefName"].as_str().is_none_or(|h| h == head))
        .filter(|p| p["headRepositoryOwner"]["login"].as_str().is_none_or(|o| o.eq_ignore_ascii_case(owner)))
        .collect();
    let p = rows.iter().find(|p| p["state"] == "OPEN").or(rows.first())?;
    let state = match p["state"].as_str()? {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ if p["isDraft"].as_bool() == Some(true) => PrState::Draft,
        _ => PrState::Open,
    };
    Some(ChatPr { number: p["number"].as_u64()?, state, url: p["url"].as_str()?.to_string(), title: p["title"].as_str().unwrap_or("").to_string(), branch: branch.to_string() })
}

/// Looks the PR up for the branch checked out in `dir`; when `dir` is gone (its worktree was
/// removed), for `last`'s branch in `repo`. Ok(None): it has none; Err: gh couldn't say.
fn lookup(dir: &Path, repo: &Path, last: Option<&ChatPr>) -> Result<Option<ChatPr>, String> {
    let (dir, branch) = if dir.is_dir() {
        (dir, crate::worktree::head(dir).map(|h| h.branch).unwrap_or_default())
    } else {
        (repo, last.map(|p| p.branch.clone()).unwrap_or_default())
    };
    if branch.is_empty() {
        return Ok(None);
    }
    let known = last.is_some_and(|p| p.branch == branch);
    let Some(w) = place(dir, &branch, known) else { return Ok(None) };
    for r in &w.repos {
        if let Some(p) = pick(&gh_prs(r, &w.head)?, &w.head, &w.owner, &branch) {
            return Ok(Some(p));
        }
    }
    Ok(None)
}

/// The chat whose folder (and so branch) a chat works in: a sub-agent's lead.
fn lead_of(c: &Chat) -> i64 {
    if c.role == Role::Sub { c.parent.unwrap_or(c.id) } else { c.id }
}

impl App {
    /// A chat's PR as last found; another PC's chat: as its home PC says.
    pub fn chat_pr(&self, c: &Chat) -> Option<&ChatPr> {
        if c.foreign() {
            return self.mesh.status.get(&c.id)?.pr.as_ref();
        }
        self.chatpr.found.get(&lead_of(c))
    }

    pub fn load_chat_prs(&mut self) {
        if let Some(v) = self.store.get("chat_prs").and_then(|s| serde_json::from_str::<HashMap<i64, ChatPr>>(&s).ok()) {
            self.chatpr.found = v;
        }
    }

    /// Looks a chat's PR up again on a thread, when it was last looked up longer than `ttl` ago
    /// (None: now, after a turn). Only this PC's chats in a git project; one lookup per chat at a time.
    pub fn pr_want(&mut self, chat: i64, ttl: Option<Duration>, ctx: &egui::Context) {
        // Called every frame the footer shows: nothing but map lookups until it's due.
        let Some(lead) = self.chat(chat).map(lead_of) else { return };
        if self.chatpr.busy.contains(&lead) {
            if ttl.is_none() {
                self.chatpr.again.insert(lead);
            }
            return;
        }
        if let (Some(ttl), Some((at, failed))) = (ttl, self.chatpr.checked.get(&lead)) {
            if at.elapsed() < if *failed { ttl.max(FAILED_TTL) } else { ttl } {
                return;
            }
        }
        self.chatpr.checked.insert(lead, (Instant::now(), false));
        let Some(lc) = self.chat(lead) else { return };
        if lc.foreign() || !lc.device.is_empty() {
            return;
        }
        let Some(repo) = lc.repo_id.and_then(|r| self.repo(r)).map(|r| r.dir().to_path_buf()) else { return };
        if !repo.join(".git").exists() {
            return;
        }
        let dir = self.worktree_of(lc).unwrap_or_else(|| repo.clone());
        let last = self.chatpr.found.get(&lead).cloned();
        self.chatpr.busy.insert(lead);
        self.ws_spawn(ctx, move || lookup(&dir, &repo, last.as_ref()), move |app, r, ctx| app.pr_found(lead, r, ctx));
    }

    fn pr_found(&mut self, lead: i64, r: Result<Option<ChatPr>, String>, ctx: &egui::Context) {
        self.chatpr.busy.remove(&lead);
        match r {
            // What it had stays; asked again later.
            Err(_) => {
                self.chatpr.checked.insert(lead, (Instant::now(), true));
            }
            Ok(pr) if self.chatpr.found.get(&lead) != pr.as_ref() => {
                match pr {
                    Some(p) => self.chatpr.found.insert(lead, p),
                    None => self.chatpr.found.remove(&lead),
                };
                // Chats deleted since are left out.
                self.chatpr.found.retain(|id, _| self.chats.iter().any(|c| c.id == *id));
                self.store.set("chat_prs", &serde_json::to_string(&self.chatpr.found).unwrap_or_default());
                ctx.request_repaint();
            }
            Ok(_) => {}
        }
        if self.chatpr.again.remove(&lead) {
            self.pr_want(lead, None, ctx);
        }
    }

    /// From `App::tick`: open and draft PRs nobody looked at for a while are looked up again,
    /// then unsettled chats in worktrees not looked up since the start, newest first.
    pub fn pr_sweep(&mut self, ctx: &egui::Context) {
        if self.chatpr.swept.is_some_and(|at| at.elapsed() < SWEEP_EVERY) {
            return;
        }
        self.chatpr.swept = Some(Instant::now());
        let mut due: Vec<i64> = self
            .chatpr
            .found
            .iter()
            .filter(|(id, p)| matches!(p.state, PrState::Open | PrState::Draft) && self.chatpr.checked.get(id).is_none_or(|(at, _)| at.elapsed() >= SWEEP_TTL))
            .map(|(id, _)| *id)
            .take(SWEEP_MAX)
            .collect();
        if self.chatpr.todo.is_none() {
            let mut new: Vec<&Chat> = self.chats.iter().filter(|c| c.role != Role::Sub && !c.settled && !c.foreign() && c.device.is_empty() && self.worktree_of(c).is_some()).collect();
            new.sort_by_key(|c| c.updated);
            self.chatpr.todo = Some(new.iter().map(|c| c.id).collect());
        }
        while due.len() < SWEEP_MAX {
            let Some(id) = self.chatpr.todo.as_mut().and_then(Vec::pop) else { break };
            if !self.chatpr.checked.contains_key(&id) {
                due.push(id);
            }
        }
        for id in due {
            self.pr_want(id, Some(SWEEP_TTL), ctx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn picks_the_branch_owners_pr_open_first() {
        let list = json!([
            { "number": 9, "state": "OPEN", "isDraft": false, "url": "u9", "title": "fork's", "headRefName": "feat", "headRepositoryOwner": { "login": "someone" } },
            { "number": 7, "state": "CLOSED", "isDraft": false, "url": "u7", "title": "old", "headRefName": "feat", "headRepositoryOwner": { "login": "Sam" } },
            { "number": 8, "state": "OPEN", "isDraft": true, "url": "u8", "title": "new", "headRefName": "feat", "headRepositoryOwner": { "login": "sam" } },
        ]);
        let p = pick(&list, "feat", "sam", "harbor/abc123").unwrap();
        assert_eq!((p.number, p.state, p.branch.as_str()), (8, PrState::Draft, "harbor/abc123"));
        assert_eq!(p.label(), "PR #8 · Draft");
        let merged = json!([{ "number": 3, "state": "MERGED", "isDraft": false, "url": "u3", "title": "t", "headRefName": "feat", "headRepositoryOwner": { "login": "sam" } }]);
        assert_eq!(pick(&merged, "feat", "sam", "feat").unwrap().state, PrState::Merged);
        assert_eq!(pick(&json!([]), "feat", "sam", "feat"), None);
        // Another branch whose name only starts the same isn't it.
        let other = json!([{ "number": 4, "state": "OPEN", "isDraft": false, "url": "u4", "title": "t", "headRefName": "feat-2", "headRepositoryOwner": { "login": "sam" } }]);
        assert_eq!(pick(&other, "feat", "sam", "feat"), None);
    }

    #[test]
    fn json_round_trips_for_peers() {
        let p = ChatPr { number: 12, state: PrState::Merged, url: "https://github.com/o/r/pull/12".into(), title: "Fix it".into(), branch: "b".into() };
        let v = p.json();
        assert_eq!(v["state"], "merged");
        assert_eq!(v["label"], "PR #12 · Merged");
        assert_eq!(ChatPr::from_json(&v), Some(ChatPr { branch: String::new(), ..p }));
        assert_eq!(ChatPr::from_json(&Value::Null), None);
    }

    #[test]
    fn only_pushed_branches_off_the_default_have_a_place() {
        let root = std::env::temp_dir().join(format!("harbor-chatpr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (bare, dir) = (root.join("origin.git"), root.join("work"));
        std::fs::create_dir_all(&dir).unwrap();
        sh(&root, &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
        sh(&dir, &["init", "-q", "-b", "main"]);
        sh(&dir, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one"]);
        sh(&dir, &["remote", "add", "origin", bare.to_str().unwrap()]);
        sh(&dir, &["push", "-q", "origin", "main"]);
        // Not a GitHub remote: no place.
        assert_eq!(place(&dir, "main", false), None);
        sh(&dir, &["remote", "set-url", "origin", "git@github.com:sam/proj.git"]);
        sh(&dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        // The default branch never has one.
        assert_eq!(place(&dir, "main", false), None);
        sh(&dir, &["switch", "-q", "-c", "harbor/abc123"]);
        // Not pushed yet: none, unless a PR was found for it before.
        assert_eq!(place(&dir, "harbor/abc123", false), None);
        assert_eq!(place(&dir, "harbor/abc123", true).map(|w| w.head), Some("harbor/abc123".to_string()));
        // Pushed under another name with an upstream: that name, in the fork's parent first.
        sh(&dir, &["update-ref", "refs/remotes/origin/fix-it", "HEAD"]);
        sh(&dir, &["config", "branch.harbor/abc123.remote", "origin"]);
        sh(&dir, &["config", "branch.harbor/abc123.merge", "refs/heads/fix-it"]);
        sh(&dir, &["remote", "add", "upstream", "https://github.com/acme/proj"]);
        let w = place(&dir, "harbor/abc123", false).unwrap();
        assert_eq!(w, Where { head: "fix-it".into(), repos: vec!["acme/proj".into(), "sam/proj".into()], owner: "sam".into() });
        let _ = std::fs::remove_dir_all(&root);
    }
}
