//! Where a thread's agent works: the project's own checkout, or a git worktree of its own
//! (its own folder and branch, so parallel agents don't collide), and which branch that is.
//! The bar under the composer (desktop) and the two chips under the phone's composer show and
//! change it, as T3 Code's does.
//!
//! A new chat picks "Current checkout" or "New worktree" before its first message; the
//! worktree is made from the branch picked (default: the checkout's), named for what the chat is
//! about: a few words Haiku gives for its title or first message (`namer`), asked while git
//! checks it out, else (no Claude login, offline, slow) a few of the message's own words
//! (`slug`), renamed when Haiku answers late (`ws_name_later`). It's
//! `<data dir>/worktrees/<project>-<name>` on branch `harbor/<name>` ("-2"… when taken; 6 hex
//! when the message gives no words). In a chat's own worktree the two chips go straight to the
//! rename form (`rename_menu`): the branch chip renames the branch at any time (`ws_rename`; a
//! pushed one on its remote too, or it stops tracking it); the folder follows once nothing works
//! in it (`ws_moves`: no turn, no process, no terminal there; kept in kv `worktree_move:<lead>`
//! across restarts), and the agents are told on their next turn. The workspace chip renames the
//! folder on its own; once the user named it (kv `worktree_named:<lead>`), branch renames leave
//! it be. Where nothing can be renamed they open their menus instead. Its path is kept in kv
//! `worktree:<chat id>`; sub-agents run in their lead's. An existing chat in the checkout can
//! move to a new worktree when it could move projects (movechat.rs: not running, on this PC,
//! its Claude sessions copied over); one in a worktree stays there. Deleting the chat removes
//! its worktree, and the branch if it has nothing unmerged (`git branch -d`), unless the
//! worktree has uncommitted changes: then it's kept and the user is told where.
//!
//! The branch picker (from the chip, or "Switch branch…" in the rename form) switches the branch of where the chat runs (`git switch`, which refuses
//! to overwrite uncommitted changes; the menu warns about them first) or creates one. For a
//! new chat headed for a new worktree it picks the worktree's base instead.

use crate::widgets::Tip as _;
use crate::app::{App, Popup, View};
use crate::store::{self, Chat, Role};
use eframe::egui::{self, Align, Layout, ScrollArea, Ui};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// Checking out a big project takes a while.
const ADD_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a folder's branch and changes are shown before they're read again.
const HEAD_TTL: Duration = Duration::from_secs(4);

fn git(dir: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0").args(["-c", "core.fsmonitor=false"]).arg("-C").arg(dir).args(args);
    let out = crate::git::output_within(&mut cmd, limit).map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        let e = String::from_utf8_lossy(&out.stderr);
        let line = e.lines().map(|l| l.trim_start_matches("error: ").trim_start_matches("fatal: ").trim()).find(|l| !l.is_empty() && !l.starts_with("hint:")).unwrap_or("git failed");
        Err(line.to_string())
    }
}

/// A folder's branch ("" when detached: then `detached` is the short commit) and how many
/// files differ from it (untracked included).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Head {
    pub branch: String,
    pub detached: String,
    pub dirty: usize,
}

impl Head {
    pub fn label(&self) -> String {
        if self.branch.is_empty() { format!("detached at {}", self.detached) } else { self.branch.clone() }
    }
}

pub fn head(dir: &Path) -> Option<Head> {
    let s = git(dir, &["status", "--porcelain=v2", "--branch"], GIT_TIMEOUT).ok()?;
    let mut h = Head::default();
    for l in s.lines() {
        if let Some(b) = l.strip_prefix("# branch.head ") {
            h.branch = if b == "(detached)" { String::new() } else { b.to_string() };
        } else if let Some(o) = l.strip_prefix("# branch.oid ") {
            h.detached = o.chars().take(7).collect();
        } else if !l.starts_with('#') && !l.is_empty() {
            h.dirty += 1;
        }
    }
    Some(h)
}

/// Local and remote-tracking branches, most recently committed first (remote HEAD aliases left out).
#[derive(Clone, Debug, Default)]
pub struct Branches {
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

pub fn branches(dir: &Path) -> Result<Branches, String> {
    let out = git(dir, &["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"], GIT_TIMEOUT)?;
    let mut b = Branches::default();
    for r in out.lines() {
        if let Some(n) = r.strip_prefix("refs/heads/") {
            b.local.push(n.to_string());
        } else if let Some(n) = r.strip_prefix("refs/remotes/") {
            if !n.ends_with("/HEAD") {
                b.remote.push(n.to_string());
            }
        }
    }
    Ok(b)
}

/// One row of the branch picker.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub name: String,
    pub remote: bool,
}

/// The picker's rows for `query`: all of them (local first, then remote branches that have no
/// local one) in recency order when it's empty, else the best matches first (tags.rs ranking).
pub fn rank(b: &Branches, query: &str, limit: usize) -> Vec<Row> {
    let remote: Vec<String> = b.remote.iter().filter(|r| r.split_once('/').is_none_or(|(_, n)| !b.local.iter().any(|l| l == n))).cloned().collect();
    let q = query.trim();
    if q.is_empty() {
        return b.local.iter().map(|n| Row { name: n.clone(), remote: false }).chain(remote.iter().map(|n| Row { name: n.clone(), remote: true })).take(limit).collect();
    }
    let all: Vec<String> = b.local.iter().chain(remote.iter()).cloned().collect();
    crate::tags::rank_files(&all, q, limit).into_iter().map(|n| Row { name: n.to_string(), remote: !b.local.iter().any(|l| l == n) }).collect()
}

/// A name `git switch -c` takes.
pub fn valid_branch(dir: &Path, name: &str) -> bool {
    !name.trim().is_empty() && git(dir, &["check-ref-format", "--branch", name.trim()], GIT_TIMEOUT).is_ok()
}

/// Switches `dir` to `name` (a local branch, or a remote one: a local branch tracking it is
/// made, as `git switch` does). Git refuses rather than overwrite uncommitted changes.
pub fn switch(dir: &Path, name: &str, remote: bool) -> Result<(), String> {
    if remote {
        let local = name.split_once('/').map(|(_, n)| n).unwrap_or(name);
        git(dir, &["switch", "--track", name], GIT_TIMEOUT).or_else(|_| git(dir, &["switch", local], GIT_TIMEOUT)).map(|_| ())
    } else {
        git(dir, &["switch", name], GIT_TIMEOUT).map(|_| ())
    }
}

pub fn create(dir: &Path, name: &str) -> Result<(), String> {
    let name = name.trim();
    if !valid_branch(dir, name) {
        return Err(format!("“{name}” isn't a valid branch name"));
    }
    git(dir, &["switch", "-c", name], GIT_TIMEOUT).map(|_| ())
}

/// Where worktrees go: outside every project, in Harbor's data folder.
pub fn root() -> PathBuf {
    store::data_dir().join("worktrees")
}

/// Words that say little about what a chat is about, left out of its worktree's name.
const FILLER: &[&str] = &[
    "a", "an", "the", "to", "of", "and", "or", "in", "on", "at", "by", "for", "from", "with", "into", "as", "is", "are", "be", "it", "its", "that", "this", "these",
    "there", "here", "so", "i", "im", "me", "my", "we", "our", "you", "your", "can", "could", "would", "should", "please", "pls", "lets", "let", "just", "also", "now",
    "then", "when", "where", "what", "how", "why", "do", "does", "some", "all", "about", "hey", "hi", "ok", "okay",
    // Portuguese, as people write to Harbor in it too.
    "o", "os", "as", "um", "uma", "de", "da", "do", "das", "dos", "e", "que", "para", "pra", "por", "com", "em", "no", "na", "nos", "nas", "eu", "voce", "quero",
    "queria", "preciso", "pode", "favor", "se", "isso", "esse", "essa", "ao", "aos",
];

/// Up to five meaningful words of what a chat is about (its title or first message), as a
/// branch and folder name: "Fix the login bug where users…" → "fix-login-bug-users". Only
/// a-z, 0-9 and "-" (accents folded), so it's always a valid ref. "" when nothing's left.
pub fn slug(about: &str) -> String {
    let line = about.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let fold = |c: char| -> Option<char> {
        let c = c.to_lowercase().next().unwrap_or(c);
        Some(match c {
            'a'..='z' | '0'..='9' => c,
            'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            _ => return None,
        })
    };
    // Links and apostrophes ("let's", "don't") aren't words of their own.
    let words: Vec<String> = line
        .split_whitespace()
        .filter(|w| !w.contains("://"))
        .flat_map(|w| w.replace(['\'', '’'], "").chars().map(|c| fold(c).unwrap_or(' ')).collect::<String>().split(' ').map(String::from).collect::<Vec<_>>())
        .filter(|w| !w.is_empty())
        .collect();
    let kept: Vec<&String> = words.iter().filter(|w| !FILLER.contains(&w.as_str())).collect();
    let pick = if kept.is_empty() { words.iter().collect() } else { kept };
    let mut out = String::new();
    for w in pick.into_iter().take(5) {
        if !out.is_empty() && out.len() + 1 + w.len() > 32 {
            break;
        }
        if !out.is_empty() {
            out.push('-');
        }
        out.extend(w.chars().take(32));
    }
    out
}

/// How long a new worktree waits for its name from Claude (`NAME_SYSTEM`) before it's made
/// with `slug`'s; the checkout runs meanwhile, so it's mostly hidden.
const NAME_WAIT: Duration = Duration::from_secs(5);
/// A name that comes later than that still renames the worktree (`App::ws_name_later`).
const NAME_LATE: Duration = Duration::from_secs(45);

const NAME_SYSTEM: &str = "You name git branches. You get the first message a user sent an AI coding agent. Reply with a short name for the task it asks for: 2 to 5 lowercase English words joined by hyphens, only a-z and 0-9, like inline-chat-mention-links or fix-login-redirect. Say what is to be done, not how the user phrased it; no filler words. Reply with only the name: no prefix, quotes or explanation.";

/// Asks for a worktree's name, on the worktree's thread: Claude's answer, cleaned (`clean_name`).
pub type Namer = Box<dyn FnOnce() -> Option<String> + Send>;

/// A `Namer` asking Haiku through this Claude account (binary, environment) what the chat is
/// about; None when the message gives nothing to name.
pub fn namer(bin: String, env: Vec<(String, Option<String>)>, about: &str) -> Option<Namer> {
    let text: String = about.trim().chars().take(2000).collect();
    if slug(&text).is_empty() {
        return None;
    }
    Some(Box::new(move || crate::recap::ask_within(bin, env, NAME_SYSTEM, format!("<message>\n{text}\n</message>"), NAME_LATE).ok().and_then(|a| clean_name(&a))))
}

/// Claude's answer as a branch and folder name: "Inline-Chat-Mention links" → "inline-chat-mention-links".
/// Only a-z, 0-9 and "-", at most 5 words and 40 characters; None when it isn't a name (a
/// sentence, nothing left).
pub fn clean_name(answer: &str) -> Option<String> {
    let line = answer.lines().map(str::trim).find(|l| !l.is_empty())?;
    let line = line.trim_matches(|c: char| c == '`' || c == '"' || c == '\'' || c == '*' || c == '.');
    // "harbor/x", "feature/x": the name is the last part.
    let line = line.rsplit('/').next().unwrap_or(line).trim();
    if line.split_whitespace().count() > 5 || line.contains(':') {
        return None;
    }
    let s: String = line.chars().map(|c| c.to_ascii_lowercase()).map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '-' }).collect();
    let mut out = String::new();
    for w in s.split('-').filter(|w| !w.is_empty()).take(5) {
        if !out.is_empty() && out.len() + 1 + w.len() > 40 {
            break;
        }
        if !out.is_empty() {
            out.push('-');
        }
        out.extend(w.chars().take(40));
    }
    (out.len() >= 3 && out.chars().any(|c| c.is_ascii_lowercase())).then_some(out)
}

/// The project's part of its worktrees' folder names.
fn project_part(repo: &Path) -> String {
    repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into()).chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect()
}

/// A branch as the end of a folder name: "harbor/fix-login" → "fix-login", "feature/a b" →
/// "feature-a-b".
fn folder_part(branch: &str) -> String {
    let b = branch.strip_prefix("harbor/").unwrap_or(branch);
    let s: String = b.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' { c.to_ascii_lowercase() } else { '-' }).collect();
    s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-").trim_matches('.').to_string()
}

/// Whether `name` is `want` or `want-<n>` (a name made unique).
fn is_named(name: &str, want: &str) -> bool {
    name == want || name.strip_prefix(want).and_then(|r| r.strip_prefix('-')).is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// Every branch name the repository knows, local and remote ("harbor/x" for "origin/harbor/x" too).
fn taken_branches(repo: &Path) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    if let Ok(b) = branches(repo) {
        set.extend(b.local);
        set.extend(b.remote.iter().filter_map(|r| r.split_once('/').map(|(_, n)| n.to_string())));
    }
    set
}

/// `want`, or `want-2`, `want-3`… : the first whose folder (`<project>-<id>` in `root`) and
/// branch (`harbor/<id>`) are both free.
fn free_id(root: &Path, project: &str, want: &str, taken: &std::collections::HashSet<String>) -> Option<String> {
    (1..100).map(|n| if n == 1 { want.to_string() } else { format!("{want}-{n}") }).find(|id| !root.join(format!("{project}-{id}")).exists() && !taken.contains(&format!("harbor/{id}")))
}

/// Renames a worktree just made by `add_in` (nothing works in it yet) to `name`: branch
/// `harbor/<name>`, folder `<project>-<name>` ("-2"… when taken). None when it can't or
/// already is.
fn rename_new(repo: &Path, dir: &Path, name: &str) -> Option<PathBuf> {
    let (root, project) = (dir.parent()?, project_part(repo));
    let id = dir.file_name()?.to_string_lossy().strip_prefix(&format!("{project}-"))?.to_string();
    if is_named(&id, name) {
        return None;
    }
    let old = head(dir)?.branch;
    let new = free_id(root, &project, name, &taken_branches(repo))?;
    git(dir, &["branch", "-m", &old, &format!("harbor/{new}")], GIT_TIMEOUT).ok()?;
    let to = root.join(format!("{project}-{new}"));
    if move_dir(dir, &to).is_err() {
        let _ = git(dir, &["branch", "-m", &format!("harbor/{new}"), &old], GIT_TIMEOUT);
        return None;
    }
    Some(to)
}

/// Makes a worktree of `repo` in `root` on a new branch `harbor/<slug of about>` from `base`
/// (a branch, or "" for the checkout's HEAD), in `<project>-<slug>`; "-2", "-3"… when the
/// folder or the branch is taken (here or on a remote), 6 hex when `about` says nothing.
/// Returns its folder.
fn add_in(root: &Path, repo: &Path, base: &str, about: &str) -> Result<PathBuf, String> {
    let project = project_part(repo);
    let s = slug(about);
    let taken = taken_branches(repo);
    let mut last = String::new();
    let mut n = 1;
    let mut tries = 0;
    while tries < 4 && n < 100 {
        let id = match (s.is_empty(), n) {
            (true, _) => store::new_uuid().chars().filter(|c| c.is_ascii_hexdigit()).take(6).collect(),
            (false, 1) => s.clone(),
            (false, n) => format!("{s}-{n}"),
        };
        n += 1;
        let dir = root.join(format!("{project}-{id}"));
        let branch = format!("harbor/{id}");
        if dir.exists() || taken.contains(&branch) {
            continue;
        }
        tries += 1;
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let d = dir.to_string_lossy().into_owned();
        let mut args = vec!["worktree", "add", "-b", branch.as_str(), d.as_str()];
        if !base.is_empty() {
            args.push(base);
        }
        match git(repo, &args, ADD_TIMEOUT) {
            Ok(_) => return Ok(dir),
            Err(e) => last = e,
        }
    }
    Err(format!("couldn't make a worktree: {last}"))
}

/// Where a branch is pushed: its upstream (remote, branch there) or, without one, a remote
/// that has a branch of its name. Whether it has an upstream.
fn pushed(dir: &Path, branch: &str) -> Option<(String, String, bool)> {
    let cfg = |k: &str| git(dir, &["config", "--get", &format!("branch.{branch}.{k}")], GIT_TIMEOUT).ok().filter(|v| !v.is_empty());
    if let (Some(remote), Some(merge)) = (cfg("remote").filter(|r| r != "."), cfg("merge")) {
        return Some((remote, merge.strip_prefix("refs/heads/").unwrap_or(&merge).to_string(), true));
    }
    let remotes = git(dir, &["remote"], GIT_TIMEOUT).ok()?;
    remotes.lines().map(str::trim).filter(|r| !r.is_empty()).find(|r| git(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{r}/{branch}")], GIT_TIMEOUT).is_ok()).map(|r| (r.to_string(), branch.to_string(), false))
}

/// What the rename form says about the branch on its remote: "origin/harbor/x", or None when
/// it was never pushed.
pub fn pushed_as(dir: &Path) -> Option<String> {
    let h = head(dir)?;
    if h.branch.is_empty() {
        return None;
    }
    pushed(dir, &h.branch).map(|(r, b, _)| format!("{r}/{b}"))
}

/// A branch renamed: from what, to what, and what happened on its remote (None: never pushed).
#[derive(Clone, Debug, PartialEq)]
pub struct Renamed {
    pub old: String,
    pub branch: String,
    pub remote: Option<String>,
}

/// Renames the branch checked out in `dir` to `new`. When it was pushed and `on_remote`: on
/// GitHub through its API (its pull requests follow), elsewhere (or when gh can't) the new
/// name is pushed and the old one left there; else it stops tracking the old remote branch,
/// so a plain `git push` can't go there under the old name.
pub fn rename_branch(dir: &Path, new: &str, on_remote: bool) -> Result<Renamed, String> {
    let new = new.trim();
    let h = head(dir).ok_or_else(|| format!("{} isn't a git worktree", dir.display()))?;
    if h.branch.is_empty() {
        return Err(format!("it's detached at {}: switch to a branch first", h.detached));
    }
    let old = h.branch;
    if new == old {
        return Ok(Renamed { old: old.clone(), branch: old, remote: None });
    }
    if !valid_branch(dir, new) {
        return Err(format!("“{new}” isn't a valid branch name"));
    }
    if git(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{new}")], GIT_TIMEOUT).is_ok() {
        return Err(format!("a branch named “{new}” already exists"));
    }
    let up = pushed(dir, &old);
    git(dir, &["branch", "-m", &old, new], GIT_TIMEOUT)?;
    let remote = up.map(|(remote, there, tracked)| {
        if !on_remote {
            if tracked {
                let _ = git(dir, &["branch", "--unset-upstream", new], GIT_TIMEOUT);
            }
            return format!("{remote}/{there} keeps its name; push again to publish {new}");
        }
        let repo = git(dir, &["remote", "get-url", &remote], GIT_TIMEOUT).ok().and_then(|u| crate::prs::github_repo(&u));
        let gh = match &repo {
            Some(r) => gh_rename(r, &there, new),
            None => Err(String::new()),
        };
        match gh {
            Ok(()) => {
                let _ = git(dir, &["fetch", &remote, &format!("+refs/heads/{new}:refs/remotes/{remote}/{new}")], ADD_TIMEOUT);
                let _ = git(dir, &["update-ref", "-d", &format!("refs/remotes/{remote}/{there}")], GIT_TIMEOUT);
                let _ = git(dir, &["branch", &format!("--set-upstream-to={remote}/{new}"), new], GIT_TIMEOUT);
                format!("Renamed on GitHub too ({remote}/{new}); its pull requests follow")
            }
            Err(why) => {
                let why = if why.is_empty() { String::new() } else { format!(" (GitHub: {why})") };
                match git(dir, &["push", "-u", &remote, new], ADD_TIMEOUT) {
                    Ok(_) => format!("Pushed as {remote}/{new}; {remote}/{there} is still there{why}"),
                    Err(e) => format!("Renamed here only: pushing it failed: {e}{why}"),
                }
            }
        }
    });
    Ok(Renamed { old, branch: new.to_string(), remote })
}

/// Renames branch `old` of GitHub repo `repo` ("owner/name") to `new`, with gh.
fn gh_rename(repo: &str, old: &str, new: &str) -> Result<(), String> {
    let mut cmd = Command::new("gh");
    cmd.args(["api", "-X", "POST", &format!("repos/{repo}/branches/{old}/rename"), "-f", &format!("new_name={new}")])
        .env("PATH", crate::providers::child_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1");
    let out = match crate::git::output_within(&mut cmd, ADD_TIMEOUT) {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("gh isn't installed".into()),
        Err(e) => return Err(format!("gh: {e}")),
    };
    if out.status.success() {
        return Ok(());
    }
    let e = String::from_utf8_lossy(&out.stderr);
    Err(e.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("gh failed").to_string())
}

/// The folder a worktree of `repo` on `branch` should have, next to `dir` (None: its name
/// already fits, or the branch gives no name). Made unique with "-2", "-3"….
pub fn folder_for(repo: &Path, dir: &Path, branch: &str) -> Option<PathBuf> {
    let part = folder_part(branch);
    if part.is_empty() {
        return None;
    }
    let want = format!("{}-{part}", project_part(repo));
    let name = dir.file_name()?.to_string_lossy().into_owned();
    if is_named(&name, &want) {
        return None;
    }
    let parent = dir.parent()?;
    (1..100).map(|n| if n == 1 { want.clone() } else { format!("{want}-{n}") }).map(|n| parent.join(n)).find(|p| !p.exists())
}

/// Why `name` can't be a worktree's folder name next to `dir` (None: it can): one plain name,
/// no path, not taken.
pub fn folder_name_problem(dir: &Path, name: &str) -> Option<String> {
    let n = name.trim();
    if n.is_empty() {
        return Some("type the folder's new name".into());
    }
    if n.contains('/') || n.contains('\\') {
        return Some("just a name, no “/”: it stays in the same place".into());
    }
    if n.starts_with('.') || n.starts_with('-') {
        return Some(format!("“{n}” can't start with “{}”", &n[..1]));
    }
    if n.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Some("no spaces: use “-” instead".into());
    }
    if n.len() > 120 {
        return Some("that name is too long".into());
    }
    let to = dir.parent().map(|p| p.join(n))?;
    (to != dir && to.exists()).then(|| format!("a folder named “{n}” is already there"))
}

/// Moves worktree `dir` to `to` (as `git worktree move`, but only file operations, so it's
/// instant and can't race a turn starting): the folder is renamed, and its entry in the
/// repository's worktree list pointed at it.
pub fn move_dir(dir: &Path, to: &Path) -> Result<(), String> {
    let link = std::fs::read_to_string(dir.join(".git")).map_err(|e| format!("{} isn't a worktree: {e}", dir.display()))?;
    let admin = link.trim().strip_prefix("gitdir:").map(str::trim).ok_or_else(|| format!("{} isn't a worktree", dir.display()))?;
    let admin = if Path::new(admin).is_absolute() { PathBuf::from(admin) } else { std::fs::canonicalize(dir.join(admin)).unwrap_or_else(|_| dir.join(admin)) };
    if admin.join("locked").exists() {
        return Err("git has it locked (`git worktree unlock`)".into());
    }
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    std::fs::rename(dir, to).map_err(|e| format!("couldn't rename the folder: {e}"))?;
    if let Err(e) = std::fs::write(admin.join("gitdir"), format!("{}\n", to.join(".git").display())) {
        let _ = std::fs::rename(to, dir);
        return Err(format!("couldn't update git's worktree list: {e}"));
    }
    Ok(())
}

/// A worktree just made: its folder, its branch and the branch it started from; and its name
/// from Claude when that's still on its way (then it's made with `slug`'s, renamed later).
#[derive(Clone, Debug)]
pub struct Made {
    pub dir: PathBuf,
    pub branch: String,
    pub base: String,
    pub late: Option<Arc<Mutex<Receiver<Option<String>>>>>,
}

impl Made {
    pub fn name(&self) -> String {
        self.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }

    /// The chat's line about it: "Working in a new worktree · harbor-a1b2c3 on branch
    /// harbor/a1b2c3 (from main)", and its detail.
    fn notice(&self, what: &str) -> (String, String) {
        let from = if self.base.is_empty() { String::new() } else { format!(" (from {})", self.base) };
        let text = format!("{what} · {} on branch {}{from}", self.name(), self.branch);
        let detail = format!(
            "Folder: {}\nBranch: {}{from}\nIts own folder and branch, so parallel agents don't collide. It's removed with the thread, unless it has uncommitted changes.",
            crate::app::tilde(&self.dir),
            self.branch
        );
        (text, detail)
    }
}

/// Makes a worktree of `repo` on a new branch named for what the chat is about (`about`: its
/// title or first message) from `base` (a branch, or "" for the checkout's HEAD), in Harbor's
/// data folder; with what the chat's line says about it. The name is Claude's (`name`), asked
/// while git checks it out; when it isn't there within `NAME_WAIT`, or there's no Claude to
/// ask, `slug`'s (`harbor/<slug>`), and a late answer renames it (`Made::late`).
pub fn make(repo: &Path, base: &str, about: &str, name: Option<Namer>) -> Result<Made, String> {
    make_in(&root(), repo, base, about, name)
}

fn make_in(root: &Path, repo: &Path, base: &str, about: &str, name: Option<Namer>) -> Result<Made, String> {
    let start = Instant::now();
    let asked = name.map(|f| {
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx
    });
    let mut dir = add_in(root, repo, base, about)?;
    let mut late = None;
    if let Some(rx) = asked {
        match rx.recv_timeout(NAME_WAIT.saturating_sub(start.elapsed())) {
            Ok(Some(n)) => dir = rename_new(repo, &dir, &n).unwrap_or(dir),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => late = Some(Arc::new(Mutex::new(rx))),
            _ => {}
        }
    }
    let branch = head(&dir).map(|h| h.label()).unwrap_or_default();
    let base = if base.is_empty() { head(repo).map(|h| h.label()).unwrap_or_default() } else { base.to_string() };
    Ok(Made { dir, branch, base, late })
}

/// Removes a worktree made by `make`, unless it has uncommitted changes (Err says so). Its
/// branch goes too when everything on it is merged somewhere (`git branch -d`).
pub fn remove(repo: &Path, dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        let _ = git(repo, &["worktree", "prune"], GIT_TIMEOUT);
        return Ok(());
    }
    let h = head(dir).ok_or_else(|| format!("{} isn't a git worktree", dir.display()))?;
    if h.dirty > 0 {
        return Err(format!("{} has {} uncommitted change{}", dir.display(), h.dirty, if h.dirty == 1 { "" } else { "s" }));
    }
    git(repo, &["worktree", "remove", &dir.to_string_lossy()], GIT_TIMEOUT)?;
    if h.branch.starts_with("harbor/") {
        let _ = git(repo, &["branch", "-d", &h.branch], GIT_TIMEOUT);
    }
    Ok(())
}

// ------------------------------------------------------------------ state

/// What the new chat's bar says: a new worktree (from `base`, "" = the checkout's branch) or not.
#[derive(Clone, Debug, Default)]
pub struct DraftWs {
    pub worktree: bool,
    pub base: String,
}

/// Work finished on a thread, to apply on the UI thread (`App::ws_poll`).
type Done = Box<dyn FnOnce(&mut App, &egui::Context) + Send>;

pub struct State {
    pub draft: DraftWs,
    done_tx: Sender<Done>,
    done_rx: Receiver<Done>,
    /// What git is doing for the bar now ("Creating worktree…", "Switching to main…"), and on
    /// which side: none of it runs on the UI thread.
    pub busy: Option<(Side, String)>,
    /// Folder → (when read, its head); read on a thread.
    heads: Arc<Mutex<HashMap<PathBuf, (Instant, Option<Head>)>>>,
    /// The open branch picker: its folder, branches and filter.
    /// (None while they're read.)
    pub menu: Option<(PathBuf, Option<Result<Branches, String>>)>,
    pub query: String,
    /// The last git error, shown in the menus until the next action.
    pub error: Option<String>,
    /// The workspace menu was opened from the header's chip (it opens under it), not the bar.
    pub from_header: bool,
    /// The rename form the chips open, while open.
    pub rename: Option<RenameForm>,
    /// Leads whose worktree folder is still to be renamed (→ its new name, next to it): moved
    /// once nothing runs there (`ws_moves`). Also in kv `worktree_move:<lead>`, so a restart
    /// keeps them (read back on the first poll).
    moves: HashMap<i64, String>,
    moves_loaded: bool,
}

/// What the rename form renames.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RenameKind {
    Branch,
    Folder,
}

/// The rename form: the name typed, whether it's renamed on its remote too, and where the
/// branch is pushed (None while it's read; Some(None): never pushed).
#[derive(Clone, Debug)]
pub struct RenameForm {
    pub kind: RenameKind,
    pub dir: PathBuf,
    pub name: String,
    pub on_remote: bool,
    pub pushed: Option<Option<String>>,
    focus: bool,
}

/// A rename done: the branch, the folder's name now, and why it hasn't followed yet (None: it
/// has, or needn't).
#[derive(Clone, Debug)]
pub struct RenameDone {
    pub kind: RenameKind,
    /// The branch's rename (a folder rename: empty).
    pub renamed: Renamed,
    pub folder: String,
    pub path: PathBuf,
    pub waits: Option<String>,
}

impl Default for State {
    fn default() -> Self {
        let (done_tx, done_rx) = channel();
        Self { draft: DraftWs::default(), done_tx, done_rx, busy: None, heads: Default::default(), menu: None, query: String::new(), error: None, from_header: false, rename: None, moves: HashMap::new(), moves_loaded: false }
    }
}

/// What a chat's header and sidebar row say about its worktree.
#[derive(Clone, Debug, PartialEq)]
pub struct Marker {
    /// The folder's name ("harbor-a1b2c3").
    pub name: String,
    /// Its folder; None for another PC's chat (its home PC only says the name).
    pub path: Option<PathBuf>,
    /// The folder isn't there anymore (removed outside Harbor).
    pub gone: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Side {
    Workspace,
    Branch,
}

/// A message on its way into a new worktree: it's sent once the worktree is ready, or put
/// back in the composer if it can't be made.
pub struct Held {
    pub repo: Option<i64>,
    /// From the project's page: the chat becomes its main chat (app.rs `Draft::main`).
    pub main: bool,
    pub text: String,
    pub files: Vec<PathBuf>,
    pub mentions: Vec<crate::mentions::Mention>,
}

/// Where a bar is for: the new chat (its project) or a chat.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Target {
    Draft(Option<i64>),
    Chat(i64),
}

/// Everything the bar and the phone's chips show.
pub struct Info {
    /// The project's checkout.
    pub repo: PathBuf,
    /// Where it runs (or, for a new chat, where its branch is read: the checkout).
    pub dir: PathBuf,
    /// The chat's worktree; a new chat: whether it gets one.
    pub worktree: Option<PathBuf>,
    pub new_worktree: bool,
    pub base: String,
    /// An existing chat in the checkout: can it move to a new worktree (Err: why not).
    pub can_move: Result<(), String>,
    /// Why the branch can't be switched now (None: it can).
    pub branch_lock: Option<String>,
    /// Whether its branch can be renamed here (Err: why not): a chat in its own worktree.
    pub rename: Result<(), String>,
}

impl App {
    /// The worktree a chat runs in (sub-agents: their lead's), if any.
    pub fn worktree_of(&self, c: &Chat) -> Option<PathBuf> {
        let id = if c.role == Role::Sub { c.parent? } else { c.id };
        self.store.get(&format!("worktree:{id}")).filter(|p| !p.is_empty()).map(PathBuf::from)
    }

    /// Whether a chat runs in a worktree, for its header chip and sidebar row (and the phone's):
    /// this PC's chats from kv, another PC's as its home PC says.
    pub fn worktree_marker(&self, c: &Chat) -> Option<Marker> {
        if c.foreign() {
            let name = self.mesh.status.get(&c.id)?.worktree.clone()?;
            return Some(Marker { name, path: None, gone: false });
        }
        let w = self.worktree_of(c)?;
        let name = w.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Some(Marker { name, gone: !w.is_dir(), path: Some(w) })
    }

    /// The repository a chat's commit pills are looked up in (commits.rs): where it works, when
    /// it has a project on this PC. A copy of another PC's chat uses this PC's clone, if any.
    pub fn commit_dir(&self, chat: i64) -> Option<PathBuf> {
        let c = self.chat(chat)?;
        if !c.device.is_empty() {
            return None;
        }
        let repo = self.repo(c.repo_id?)?.dir().to_path_buf();
        let dir = if c.foreign() { repo } else { self.worktree_of(c).filter(|w| w.is_dir()).unwrap_or(repo) };
        dir.is_dir().then_some(dir)
    }

    /// Where a chat's agent works: its worktree, else its project (or home).
    pub fn chat_cwd(&self, c: &Chat) -> PathBuf {
        self.worktree_of(c).unwrap_or_else(|| self.cwd_of(c.repo_id))
    }

    /// Where a chat's replies' relative media paths start: its folder, or for another PC's
    /// chat its folder there (its files are fetched from there).
    pub fn media_cwd(&self, id: i64) -> Option<PathBuf> {
        let c = self.chat(id)?;
        if c.foreign() {
            return self.mesh.status.get(&id)?.cwd.as_ref().map(PathBuf::from);
        }
        Some(self.chat_cwd(c))
    }

    /// The bar's facts for a target; None outside a git project (no bar then).
    pub fn ws_info(&self, target: Target) -> Option<Info> {
        let (repo_id, chat) = match target {
            Target::Draft(r) => (r?, None),
            Target::Chat(id) => {
                let c = self.chat(id)?;
                if c.foreign() || !c.device.is_empty() {
                    return None;
                }
                (c.repo_id?, Some(c))
            }
        };
        let repo = self.repo(repo_id)?.dir().to_path_buf();
        if !repo.join(".git").exists() {
            return None;
        }
        Some(match chat {
            None => Info {
                dir: repo.clone(),
                repo,
                worktree: None,
                new_worktree: self.ws.draft.worktree,
                base: self.ws.draft.base.clone(),
                can_move: Err("a new chat".into()),
                branch_lock: None,
                rename: Err("a new chat: it's named after its first message".into()),
            },
            Some(c) => {
                let wt = self.worktree_of(c);
                let lead = if c.role == Role::Sub { c.parent.unwrap_or(c.id) } else { c.id };
                let running = std::iter::once(lead).chain(self.subs_of(lead).into_iter().map(|s| s.id)).any(|i| self.is_running(i));
                Info {
                    dir: wt.clone().unwrap_or_else(|| repo.clone()),
                    repo,
                    new_worktree: false,
                    base: String::new(),
                    can_move: if wt.is_some() { Err("it already has its own worktree".into()) } else { self.movable(lead).map(|_| ()) },
                    branch_lock: running.then(|| "An agent is working here: switch branches once it stops.".to_string()),
                    rename: match &wt {
                        None => Err("it runs in the project's checkout: only a thread's own worktree is renamed here".into()),
                        Some(w) if !w.is_dir() => Err("its worktree isn't there anymore".into()),
                        Some(_) => Ok(()),
                    },
                    worktree: wt,
                }
            }
        })
    }

    /// A folder's head as last read (None until the first read lands); reads again after a while.
    pub fn ws_head(&self, dir: &Path, ctx: &egui::Context) -> Option<Head> {
        let mut heads = self.ws.heads.lock().unwrap();
        let stale = heads.get(dir).is_none_or(|(at, _)| at.elapsed() >= HEAD_TTL);
        let shown = heads.get(dir).and_then(|(_, h)| h.clone());
        if stale {
            // Marked fresh now, so only one read runs at a time.
            heads.insert(dir.to_path_buf(), (Instant::now(), shown.clone()));
            let (dir, heads, ctx) = (dir.to_path_buf(), self.ws.heads.clone(), ctx.clone());
            std::thread::spawn(move || {
                let h = head(&dir);
                let changed = heads.lock().unwrap().insert(dir, (Instant::now(), h.clone())).is_none_or(|(_, old)| old != h);
                if changed {
                    ctx.request_repaint();
                }
            });
        }
        ctx.request_repaint_after(HEAD_TTL);
        shown
    }

    /// Reads a folder again soon (after a switch): its cached head goes stale.
    fn ws_refresh(&self, dir: &Path) {
        self.ws.heads.lock().unwrap().remove(dir);
    }

    /// Runs `work` on a thread, then `then` with its result on the UI thread.
    pub fn ws_spawn<T: Send + 'static>(&self, ctx: &egui::Context, work: impl FnOnce() -> T + Send + 'static, then: impl FnOnce(&mut App, T, &egui::Context) + Send + 'static) {
        let (tx, ctx2) = (self.ws.done_tx.clone(), ctx.clone());
        std::thread::spawn(move || {
            let r = work();
            let _ = tx.send(Box::new(move |app: &mut App, ctx: &egui::Context| then(app, r, ctx)));
            ctx2.request_repaint();
        });
    }

    /// Reads the branches for the picker on a thread.
    fn ws_load_branches(&mut self, dir: PathBuf, ctx: &egui::Context) {
        self.ws.menu = Some((dir.clone(), None));
        let d = dir.clone();
        self.ws_spawn(ctx, move || branches(&d), move |app, b, _| {
            if app.ws.menu.as_ref().is_some_and(|(m, _)| *m == dir) {
                app.ws.menu = Some((dir, Some(b)));
            }
        });
    }

    /// Applies what the git threads finished (from `App::tick`).
    pub fn ws_poll(&mut self, ctx: &egui::Context) {
        while let Ok(f) = self.ws.done_rx.try_recv() {
            f(self, ctx);
        }
        self.ws_moves();
    }

    /// The new chat's bar asks for a new worktree (and it can have one): where to make it.
    pub fn ws_wants_worktree(&self, repo: Option<i64>, device: &str) -> Option<(PathBuf, String)> {
        if !self.ws.draft.worktree || !device.is_empty() {
            return None;
        }
        self.ws_info(Target::Draft(repo)).map(|i| (i.repo, i.base))
    }

    /// Makes the new chat's worktree on a thread, then starts the chat there with the held
    /// message; if it can't be made the message goes back into the composer, with a toast.
    pub fn ws_send_in_worktree(&mut self, ctx: &egui::Context, repo: PathBuf, base: String, held: Held) {
        if self.ws.busy.is_some() {
            // One at a time: the message waits in the composer.
            self.ws_restore(held);
            crate::picker::show_toast(ctx, "Still making the last worktree: send again in a moment.".into());
            return;
        }
        self.ws.busy = Some((Side::Workspace, "Creating worktree…".into()));
        let about = held.text.clone();
        let name = self.ws_namer(&about);
        self.ws_spawn(ctx, move || make(&repo, &base, &about, name), move |app, r, ctx| {
            app.ws.busy = None;
            match r {
                Ok(made) => {
                    let id = app.new_thread(held.repo, &held.text);
                    if held.main {
                        app.adopt_main(held.repo, id);
                    }
                    app.ws_attach(id, Some(made), ctx);
                    // Still on the new chat: follow it there.
                    if app.view == View::Draft {
                        app.view = View::Chat(id);
                        app.store.set("last_chat", &id.to_string());
                    }
                    app.send_to(id, held.text, held.files, held.mentions, ctx);
                    app.focus_composer = true;
                }
                Err(e) => {
                    app.ws_restore(held);
                    crate::picker::show_toast(ctx, e);
                }
            }
        });
    }

    /// Puts a held message back into the new chat's composer (before what was typed since).
    fn ws_restore(&mut self, held: Held) {
        let key = crate::app::DRAFT;
        let now = self.drafts.remove(&key).unwrap_or_default();
        let now = crate::usertext::shift_images(&now, crate::usertext::image_count(&held.files));
        self.drafts.insert(key, if now.trim().is_empty() { held.text } else { format!("{}\n{now}", held.text) });
        let mut files = held.files;
        files.extend(self.files.remove(&key).unwrap_or_default());
        self.files.insert(key, files);
        self.mentions.drafts.entry(key).or_default().extend(held.mentions);
    }

    /// Records a new chat's worktree, with a line in the chat that says where it works.
    pub fn ws_attach(&mut self, chat_id: i64, made: Option<Made>, ctx: &egui::Context) {
        if let Some(m) = made {
            self.store.set(&format!("worktree:{chat_id}"), &m.dir.to_string_lossy());
            let (text, detail) = m.notice("Working in a new worktree");
            self.notice(chat_id, "worktree", &text, &detail);
            self.ws_name_later(chat_id, &m, ctx);
        }
    }

    /// What names a new worktree: Haiku through this PC's Claude login (the one dictation uses),
    /// unless it's at a usage limit. None: `slug`'s name.
    pub fn ws_namer(&self, about: &str) -> Option<Namer> {
        let a = self.accounts.iter().filter(|a| a.kind == crate::providers::Kind::Claude && a.installed() && a.logged_in == Some(true)).filter(|a| self.blocked(&a.id).is_none()).min_by_key(|a| a.id != "claude")?;
        if self.limits.quota.get(&a.id).is_some_and(|q| q.iter().any(|(_, used, _)| *used >= 0.9)) {
            return None;
        }
        namer(a.bin_str(), a.env(), about)
    }

    /// The worktree's name from Claude came too late to make it with: once it comes, its branch
    /// is renamed (the folder follows when nothing works in it, as with the user's renames),
    /// unless the user renamed either meanwhile.
    fn ws_name_later(&mut self, lead: i64, made: &Made, ctx: &egui::Context) {
        let Some(rx) = made.late.clone() else { return };
        let (dir, was) = (made.dir.clone(), made.branch.clone());
        self.ws_spawn(ctx, move || {
            let name = rx.lock().unwrap().recv_timeout(NAME_LATE).ok().flatten()?;
            // Still as it was made, and not already named so.
            let id = was.strip_prefix("harbor/")?;
            (head(&dir)?.branch == was && !is_named(id, &name)).then_some(())?;
            let root = dir.parent()?.to_path_buf();
            let project = dir.file_name()?.to_string_lossy().strip_suffix(&format!("-{id}"))?.to_string();
            free_id(&root, &project, &name, &taken_branches(&dir)).map(|id| format!("harbor/{id}"))
        }, move |app, to, ctx| {
            if let Some(to) = to {
                app.ws_name_apply(lead, to, 0, ctx);
            }
        });
    }

    fn ws_name_apply(&mut self, lead: i64, to: String, tries: u32, ctx: &egui::Context) {
        if self.ws_folder_named(lead) || self.chat(lead).is_none() {
            return;
        }
        if self.ws.busy.is_some() {
            // Git is busy with something the user asked for: in a moment.
            if tries < 20 {
                self.ws_spawn(ctx, || std::thread::sleep(Duration::from_secs(1)), move |app, _, ctx| app.ws_name_apply(lead, to, tries + 1, ctx));
            }
            return;
        }
        self.ws_rename_by(lead, to, false, false, ctx, |_, r, _| {
            if let Err(e) = r {
                eprintln!("harbor: couldn't name the worktree: {e}");
            }
        });
    }

    /// "Move to a new worktree": the chat (and its sub-agents) runs in a new worktree from now
    /// on, made from the checkout's current branch. Its Claude sessions come along on the next turn.
    /// On a thread: the worktree is made there, then `ws_moved` moves the chat (`done` gets
    /// the outcome).
    pub fn ws_move_to_worktree(&mut self, chat_id: i64, ctx: &egui::Context, done: impl FnOnce(&mut App, Result<PathBuf, String>, &egui::Context) + Send + 'static) {
        let info = match self.ws_info(Target::Chat(chat_id)).ok_or_else(|| "this chat isn't in a git project on this PC".to_string()).and_then(|i| i.can_move.clone().map(|_| i)) {
            Ok(i) => i,
            Err(e) => return done(self, Err(e), ctx),
        };
        if self.ws.busy.is_some() {
            return done(self, Err("still busy with the last worktree".into()), ctx);
        }
        self.ws.busy = Some((Side::Workspace, "Creating worktree…".into()));
        let repo = info.repo.clone();
        let about = self.chat(chat_id).map(|c| c.title.clone()).unwrap_or_default();
        let name = self.ws_namer(&about);
        self.ws_spawn(ctx, move || make(&repo, "", &about, name), move |app, r, ctx| {
            app.ws.busy = None;
            let r = r.and_then(|made| match app.ws_moved(chat_id, &made, ctx) {
                Ok(()) => Ok(made.dir),
                Err(e) => {
                    // It started meanwhile, or a session didn't copy: the new worktree goes again.
                    let (repo, d) = (info.repo.clone(), made.dir);
                    app.ws_spawn(ctx, move || remove(&repo, &d), |_, _, _| {});
                    Err(e)
                }
            });
            done(app, r, ctx);
        });
    }

    /// The chat (and its sub-agents) moves into the worktree just made, if it still may.
    fn ws_moved(&mut self, chat_id: i64, made: &Made, ctx: &egui::Context) -> Result<(), String> {
        let ids = self.movable(chat_id)?;
        for id in &ids {
            let Some(c) = self.chat(*id).cloned() else { continue };
            let Some(acc) = self.account(&c.account).cloned() else { continue };
            if acc.kind == crate::providers::Kind::Claude && c.started && !c.session_id.is_empty() {
                if let Err(e) = crate::movechat::ensure_session(&acc.config_dir, &c.session_id, &made.dir) {
                    return Err(format!("couldn't copy {}'s session: {e}", c.name));
                }
            }
            crate::workspace::forget(*id);
        }
        self.store.set(&format!("worktree:{chat_id}"), &made.dir.to_string_lossy());
        let (text, detail) = made.notice("Moved to a new worktree");
        self.notice(chat_id, "worktree", &text, &detail);
        self.ws_name_later(chat_id, made, ctx);
        Ok(())
    }

    /// The chat and its sub-agents.
    fn ws_tree(&self, lead: i64) -> Vec<i64> {
        std::iter::once(lead).chain(self.subs_of(lead).into_iter().map(|s| s.id)).collect()
    }

    /// Why a lead's worktree folder can't move now (None: it can): something works in it.
    pub fn ws_folder_busy(&self, lead: i64, dir: &Path) -> Option<String> {
        let ids = self.ws_tree(lead);
        if ids.iter().any(|i| self.is_running(*i)) {
            return Some("an agent is working in it".into());
        }
        if self.moving_to(lead).is_some() {
            return Some("the thread is moving to another PC".into());
        }
        if let Some(p) = self.procs.iter().find(|p| ids.contains(&p.lead) || ids.contains(&p.owner)) {
            return Some(format!("its process “{}” is running", p.name));
        }
        let term = [crate::surface::Dock::Right, crate::surface::Dock::Bottom]
            .iter()
            .any(|d| self.pane(*d).surfaces.iter().any(|s| matches!(s, crate::surface::Surface::Terminal(t) if t.alive() && t.cwd.starts_with(dir))));
        term.then(|| "a terminal is open in it".into())
    }

    /// Something the chat's agents are told at the start of their next turn (`ws_take_note`):
    /// its worktree's branch or folder changed under them.
    fn ws_note(&mut self, lead: i64, text: &str) {
        for id in self.ws_tree(lead) {
            let k = format!("worktree_note:{id}");
            let old = self.store.get(&k).unwrap_or_default();
            self.store.set(&k, &if old.is_empty() { text.to_string() } else { format!("{old}\n{text}") });
        }
    }

    /// What goes before a turn's prompt about its worktree having changed ("" if nothing).
    /// A slash command's turn leaves it for the next one (it must come first).
    pub fn ws_take_note(&mut self, chat_id: i64, prompt: &str) -> String {
        if prompt.starts_with('/') {
            return String::new();
        }
        let k = format!("worktree_note:{chat_id}");
        let n = self.store.get(&k).unwrap_or_default();
        if n.is_empty() {
            return n;
        }
        self.store.set(&k, "");
        format!("[Harbor: {n}]\n\n")
    }

    /// Renames the branch of a chat's worktree (on a thread: it may push); its folder follows
    /// at once when nothing runs there, else as soon as nothing does (`ws_moves`): moving a
    /// folder under a working agent, a dev server or a shell would pull it from under them.
    pub fn ws_rename(&mut self, chat_id: i64, name: String, on_remote: bool, ctx: &egui::Context, done: impl FnOnce(&mut App, Result<RenameDone, String>, &egui::Context) + Send + 'static) {
        self.ws_rename_by(chat_id, name, on_remote, true, ctx, done)
    }

    /// `ws_rename`, by the user or (`by_user` false) by Harbor naming a new worktree.
    fn ws_rename_by(&mut self, chat_id: i64, name: String, on_remote: bool, by_user: bool, ctx: &egui::Context, done: impl FnOnce(&mut App, Result<RenameDone, String>, &egui::Context) + Send + 'static) {
        let Some(c) = self.chat(chat_id).cloned() else { return done(self, Err("no such chat".into()), ctx) };
        let lead = if c.role == Role::Sub { c.parent.unwrap_or(c.id) } else { c.id };
        let info = match self.ws_info(Target::Chat(chat_id)).ok_or_else(|| "this chat isn't in a git project on this PC".to_string()).and_then(|i| i.rename.clone().map(|_| i)) {
            Ok(i) => i,
            Err(e) => return done(self, Err(e), ctx),
        };
        let name = name.trim().to_string();
        if name.is_empty() {
            return done(self, Err("type the branch's new name".into()), ctx);
        }
        if self.ws.busy.is_some() {
            return done(self, Err("git is still busy here".into()), ctx);
        }
        self.ws.busy = Some((Side::Branch, format!("Renaming to {name}…")));
        let dir = info.dir.clone();
        self.ws_spawn(ctx, move || rename_branch(&dir, &name, on_remote), move |app, r, ctx| {
            app.ws.busy = None;
            app.ws_refresh(&info.dir);
            let r = r.map(|rn| {
                if rn.old != rn.branch {
                    let mut detail = format!("Branch: {} (was {})", rn.branch, rn.old);
                    if let Some(n) = &rn.remote {
                        detail.push_str(&format!("\n{n}."));
                    }
                    if by_user {
                        app.notice(lead, "worktree", &format!("Branch renamed · {} → {}", rn.old, rn.branch), &detail);
                        app.ws_note(lead, &format!("the user renamed this worktree's branch from {} to {}.", rn.old, rn.branch));
                    } else {
                        app.notice(lead, "worktree", &format!("Branch named · {} → {}", rn.old, rn.branch), &detail);
                        app.ws_note(lead, &format!("Harbor renamed this worktree's branch from {} to {}, a name for the task.", rn.old, rn.branch));
                    }
                    // The folder follows, unless the user named it themselves.
                    if !app.ws_folder_named(lead) {
                        if let Some(to) = folder_for(&info.repo, &info.dir, &rn.branch).and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())) {
                            app.ws_plan_move(lead, &to);
                        }
                    }
                    app.pr_want(lead, None, ctx);
                    app.ws_moves();
                }
                let path = app.chat(lead).and_then(|c| app.worktree_of(c)).unwrap_or(info.dir.clone());
                let waits = app.ws.moves.contains_key(&lead).then(|| app.ws_folder_busy(lead, &path)).flatten();
                RenameDone { kind: RenameKind::Branch, folder: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path, renamed: rn, waits }
            });
            done(app, r, ctx);
        });
    }

    /// Whether the user named the lead's worktree folder themselves: then renaming its branch
    /// leaves the folder be.
    pub fn ws_folder_named(&self, lead: i64) -> bool {
        self.store.get(&format!("worktree_named:{lead}")).is_some_and(|v| v == "1")
    }

    /// The folder a lead's worktree is still to be renamed to, if any.
    pub fn ws_folder_to(&self, lead: i64) -> Option<&String> {
        self.ws.moves.get(&lead)
    }

    /// The lead's worktree folder is to be renamed to `name` (next to it): now, or once nothing
    /// works in it. Kept in kv until done.
    fn ws_plan_move(&mut self, lead: i64, name: &str) {
        self.store.set(&format!("worktree_move:{lead}"), name);
        self.ws.moves.insert(lead, name.to_string());
    }

    fn ws_unplan_move(&mut self, lead: i64) {
        if self.ws.moves.remove(&lead).is_some() {
            self.store.set(&format!("worktree_move:{lead}"), "");
        }
    }

    /// Renames a chat's worktree folder to `name`, in the same place: at once when nothing
    /// works in it, else as soon as nothing does (`ws_moves`). From then on a branch rename
    /// leaves the folder be (kv `worktree_named:<lead>`).
    pub fn ws_rename_folder(&mut self, chat_id: i64, name: &str) -> Result<RenameDone, String> {
        let c = self.chat(chat_id).cloned().ok_or("no such chat")?;
        let lead = if c.role == Role::Sub { c.parent.unwrap_or(c.id) } else { c.id };
        let info = self.ws_info(Target::Chat(chat_id)).ok_or("this chat isn't in a git project on this PC")?;
        info.rename.clone()?;
        let name = name.trim().to_string();
        if let Some(why) = folder_name_problem(&info.dir, &name) {
            return Err(why);
        }
        let current = info.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.store.set(&format!("worktree_named:{lead}"), "1");
        if name == current {
            // Named as it is: only a pending move goes.
            self.ws_unplan_move(lead);
        } else {
            self.ws_plan_move(lead, &name);
            self.ws_moves();
        }
        let path = self.chat(lead).and_then(|c| self.worktree_of(c)).unwrap_or(info.dir.clone());
        let waits = self.ws.moves.contains_key(&lead).then(|| self.ws_folder_busy(lead, &path)).flatten();
        Ok(RenameDone {
            kind: RenameKind::Folder,
            folder: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path,
            renamed: Renamed { old: String::new(), branch: String::new(), remote: None },
            waits: waits.map(|w| format!("{w}; it becomes {name} then")),
        })
    }

    /// Renames the worktree folders still to be renamed, where nothing works now (every frame;
    /// nothing to do almost always). The first call reads back the ones a restart left.
    fn ws_moves(&mut self) {
        if !self.ws.moves_loaded {
            self.ws.moves_loaded = true;
            for (k, v) in self.store.with_prefix("worktree_move:") {
                if let Some(id) = k.strip_prefix("worktree_move:").and_then(|i| i.parse().ok()) {
                    self.ws.moves.insert(id, v);
                }
            }
        }
        if self.ws.moves.is_empty() {
            return;
        }
        let leads: Vec<i64> = self.ws.moves.keys().copied().collect();
        for lead in leads {
            let Some(dir) = self.chat(lead).cloned().and_then(|c| self.worktree_of(&c)).filter(|d| d.is_dir()) else {
                self.ws_unplan_move(lead);
                continue;
            };
            if self.ws_folder_busy(lead, &dir).is_some() {
                continue;
            }
            let Some(name) = self.ws.moves.get(&lead).cloned() else { continue };
            self.ws_unplan_move(lead);
            let Some(parent) = dir.parent() else { continue };
            let mut to = parent.join(&name);
            if to == dir {
                continue;
            }
            // Taken meanwhile: a name the branch gave gets a number; one the user typed is said.
            if to.exists() {
                if self.ws_folder_named(lead) {
                    self.notice(lead, "worktree", "The worktree's folder keeps its name", &format!("Couldn't rename {} to {name}: a folder of that name appeared meanwhile.", crate::app::tilde(&dir)));
                    continue;
                }
                match (2..100).map(|n| parent.join(format!("{name}-{n}"))).find(|p| !p.exists()) {
                    Some(p) => to = p,
                    None => continue,
                }
            }
            if let Err(e) = self.ws_move_folder(lead, &dir, &to) {
                self.notice(lead, "worktree", "The worktree's folder keeps its name", &format!("Couldn't rename {} to {}: {e}", crate::app::tilde(&dir), to.display()));
            }
        }
    }

    /// Moves a lead's worktree folder to `to`: its agents' Claude sessions are copied to where
    /// the new folder's are looked for first, then the folder moves and the chat follows.
    fn ws_move_folder(&mut self, lead: i64, dir: &Path, to: &Path) -> Result<(), String> {
        let ids = self.ws_tree(lead);
        for id in &ids {
            let Some(c) = self.chat(*id).cloned() else { continue };
            let Some(acc) = self.account(&c.account).cloned() else { continue };
            if acc.kind == crate::providers::Kind::Claude && c.started && !c.session_id.is_empty() {
                crate::movechat::ensure_session(&acc.config_dir, &c.session_id, to).map_err(|e| format!("couldn't copy {}'s session: {e}", c.name))?;
            }
        }
        move_dir(dir, to)?;
        self.store.set(&format!("worktree:{lead}"), &to.to_string_lossy());
        for id in &ids {
            crate::workspace::forget(*id);
        }
        self.ws_refresh(dir);
        let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.notice(lead, "worktree", &format!("Worktree folder renamed · {} → {}", name(dir), name(to)), &format!("Folder: {}", crate::app::tilde(to)));
        self.ws_note(lead, &format!("this thread's worktree folder moved from {} to {}: work there now, nothing is left under the old path.", dir.display(), to.display()));
        Ok(())
    }

    /// Before a chat is deleted: its worktree goes too (on a thread), unless it has uncommitted
    /// changes: then it stays, and a toast and a desktop notification say where. True when
    /// there was one to remove.
    pub fn ws_drop(&mut self, chat_id: i64, ctx: &egui::Context) -> bool {
        let Some(c) = self.chat(chat_id).cloned() else { return false };
        let key = format!("worktree:{chat_id}");
        let dir = self.store.get(&key).filter(|p| !p.is_empty()).map(PathBuf::from);
        self.store.set(&key, "");
        // A reused chat id mustn't inherit its folder's name choice or a pending rename.
        self.store.set(&format!("worktree_named:{chat_id}"), "");
        self.ws_unplan_move(chat_id);
        let Some(dir) = dir else { return false };
        let repo = self.cwd_of(c.repo_id);
        self.ws_spawn(ctx, move || remove(&repo, &dir).map_err(|e| (e, dir)), |_, r, ctx| {
            if let Err((e, dir)) = r {
                let text = format!("Kept the chat's worktree: {e}. Commit or discard them, then remove it with `git worktree remove {}`.", dir.display());
                crate::picker::show_toast(ctx, text.clone());
                crate::limits::notify("Harbor kept a worktree", &text);
            }
        });
        true
    }

    /// The branch picker's pick: switch (or, for a new chat headed for a worktree, its base).
    /// Switches (`row`) or creates (`create`) a branch where `target` works, on a thread; `done`
    /// gets the outcome. For a new chat headed for a worktree a pick is only its base.
    pub fn ws_branch(&mut self, target: Target, row: Option<Row>, create_name: Option<String>, ctx: &egui::Context, done: impl FnOnce(&mut App, Result<(), String>, &egui::Context) + Send + 'static) {
        let Some(info) = self.ws_info(target) else { return done(self, Err("no git project here".into()), ctx) };
        if let (true, Some(r)) = (info.new_worktree, &row) {
            self.ws.draft.base = r.name.clone();
            return done(self, Ok(()), ctx);
        }
        if let Some(why) = info.branch_lock {
            return done(self, Err(why), ctx);
        }
        if self.ws.busy.is_some() {
            return done(self, Err("git is still busy here".into()), ctx);
        }
        let what = match (&row, &create_name) {
            (Some(r), _) => format!("Switching to {}…", r.name),
            (None, Some(n)) => format!("Creating {n}…"),
            _ => return done(self, Err("nothing to do".into()), ctx),
        };
        self.ws.busy = Some((Side::Branch, what));
        let dir = info.dir.clone();
        self.ws_spawn(
            ctx,
            move || match (row, create_name) {
                (Some(r), _) => switch(&dir, &r.name, r.remote),
                (None, Some(n)) => create(&dir, &n),
                _ => Ok(()),
            },
            move |app, r, ctx| {
                app.ws.busy = None;
                app.ws_refresh(&info.dir);
                done(app, r, ctx);
            },
        );
    }

    fn ws_target(&self) -> Target {
        match self.view {
            View::Chat(id) => Target::Chat(id),
            _ => Target::Draft(self.draft.repo),
        }
    }

    // -------------------------------------------------------------- the bar

    /// The slim bar under the composer: where the agent works (left), and its branch's pull
    /// request and the branch (right).
    pub fn workspace_bar(&mut self, ui: &mut Ui) {
        let target = self.ws_target();
        let ctx = ui.ctx().clone();
        if let Target::Chat(id) = target {
            self.pr_want(id, Some(crate::chatpr::SHOWN_TTL), &ctx);
        }
        let pr = match target {
            Target::Chat(id) => self.chat(id).and_then(|c| self.chat_pr(c)).cloned(),
            Target::Draft(_) => None,
        };
        let Some(info) = self.ws_info(target) else {
            // Another PC's chat (or one run on a device) in a worktree: where it works, read-only;
            // and its PR, as its home PC says.
            if let Target::Chat(id) = target {
                let marker = self.chat(id).cloned().and_then(|c| self.worktree_marker(&c).map(|m| (m, self.home_name(&c))));
                if marker.is_some() || pr.is_some() {
                    let t = self.theme.t;
                    ui.horizontal(|ui| {
                        ui.add_space(6.0);
                        if let Some((m, home)) = marker {
                            w_small(ui, crate::icons::FOLDER_GIT, &format!("Worktree · {}", m.name), false, &t).tip(format!("Runs in its own worktree on {home}, {}", m.name));
                        }
                        if let Some(p) = &pr {
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                ui.add_space(6.0);
                                w_pr(ui, p, &t);
                            });
                        }
                    });
                }
            }
            return;
        };
        // Its worktree was removed outside Harbor: said in place of the folder, no branch.
        let gone = info.worktree.as_ref().is_some_and(|w| !w.exists());
        let h = self.ws_head(&info.dir, &ctx);
        let t = self.theme.t;
        let mut open: Option<(Popup, egui::Rect)> = None;
        let busy = self.ws.busy.clone();
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 2.0;
            ui.add_space(6.0);
            if let Some((Side::Workspace, what)) = &busy {
                w_busy(ui, what, &t);
            } else {
            let (label, tip) = match (&info.worktree, info.new_worktree) {
                (Some(w), _) if gone => ("Worktree gone".to_string(), format!("This thread's worktree ({}) isn't there anymore. Start a new chat in the project to go on.", w.display())),
                (Some(w), _) => (
                    format!("Worktree · {}", w.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
                    format!("Runs in its own worktree, {}. It's removed with the thread, unless it has uncommitted changes.", w.display()),
                ),
                (None, true) => ("New worktree".to_string(), "The first message makes a worktree of its own (own folder and branch), so parallel agents don't collide.".to_string()),
                (None, false) => ("Current checkout".to_string(), format!("Runs in the project's checkout, {}", info.repo.display())),
            };
            let icon = if info.worktree.is_some() || info.new_worktree { crate::icons::FOLDER_GIT } else { crate::icons::FOLDER };
            let r = (if gone { w_small_tinted(ui, icon, &label, self.popup == Some(Popup::Workspace), t.destructive(), &t) } else { w_small(ui, icon, &label, self.popup == Some(Popup::Workspace) && !self.ws.from_header, &t) }).tip(tip);
            if r.clicked() {
                open = Some((Popup::Workspace, r.rect));
            } else if self.popup == Some(Popup::Workspace) && !self.ws.from_header {
                self.popup_anchor = r.rect;
            }
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.add_space(6.0);
                // The branch's PR goes left of the branch (and stays when the worktree is gone:
                // often why it went).
                if gone {
                    if let Some(p) = &pr {
                        w_pr(ui, p, &t);
                    }
                    return;
                }
                if let Some((Side::Branch, what)) = &busy {
                    let r = w_busy(ui, what, &t);
                    if self.popup == Some(Popup::Branch) {
                        self.popup_anchor = r.rect;
                    }
                    if let Some(p) = &pr {
                        w_pr(ui, p, &t);
                    }
                    return;
                }
                let (label, tip) = match &h {
                    _ if info.new_worktree => {
                        let base = if info.base.is_empty() { h.as_ref().map(|h| h.label()).unwrap_or_default() } else { info.base.clone() };
                        (format!("from {base}"), "The new worktree's branch starts from this one".to_string())
                    }
                    // As the phone's bar: "main  ·  3 changed".
                    Some(h) if h.dirty > 0 => (format!("{}  ·  {} changed", h.label(), h.dirty), format!("{} uncommitted change{}. {}", h.dirty, if h.dirty == 1 { "" } else { "s" }, branch_tip(&info, h))),
                    Some(h) => (h.label(), branch_tip(&info, h).to_string()),
                    None => ("…".to_string(), "Reading the branch…".to_string()),
                };
                let r = w_small(ui, crate::icons::BRANCH, &label, self.popup == Some(Popup::Branch), &t).tip(tip);
                if r.clicked() {
                    open = Some((Popup::Branch, r.rect));
                } else if self.popup == Some(Popup::Branch) {
                    self.popup_anchor = r.rect;
                }
                if let Some(p) = &pr {
                    w_pr(ui, p, &t);
                }
            });
        });
        if let Some((p, rect)) = open {
            self.ws_open(p, rect, false, info.dir.clone(), &ctx);
            // A chat's own worktree: straight to renaming it. Elsewhere, and on a detached
            // worktree's branch, there's nothing to rename: the menu.
            let on_branch = h.as_ref().is_some_and(|h| !h.branch.is_empty());
            if self.popup == Some(p) && info.rename.is_ok() {
                match p {
                    Popup::Workspace => self.ws_start_rename(RenameKind::Folder, &info, &ctx),
                    Popup::Branch if on_branch => self.ws_start_rename(RenameKind::Branch, &info, &ctx),
                    _ => {}
                }
            }
        }
    }

    /// A click on a trigger of the bar or the header's chip (`from_header`): opens its menu
    /// there, or closes it when it's open there already.
    fn ws_open(&mut self, p: Popup, rect: egui::Rect, from_header: bool, dir: PathBuf, ctx: &egui::Context) {
        if self.popup == Some(p) && (p != Popup::Workspace || self.ws.from_header == from_header) {
            self.popup = None;
            return;
        }
        self.popup = Some(p);
        self.popup_anchor = rect;
        self.ws.from_header = from_header && p == Popup::Workspace;
        // The click that opened it isn't a click outside it.
        self.picker.just_opened = true;
        self.ws.error = None;
        self.ws.query.clear();
        self.ws.rename = None;
        if p == Popup::Branch {
            self.ws_load_branches(dir, ctx);
        }
    }

    /// The workspace menu (Popup::Workspace). True: close it.
    pub fn workspace_menu(&mut self, ctx: &egui::Context) -> bool {
        let t = self.theme.t;
        let target = self.ws_target();
        let Some(info) = self.ws_info(target) else { return true };
        if let (Target::Chat(id), Some(_)) = (target, &self.ws.rename) {
            return self.rename_menu(ctx, id, &info, "workspace", !self.ws.from_header);
        }
        let error = self.ws.error.clone();
        let lead = match target {
            Target::Chat(id) => self.chat(id).map(|c| if c.role == Role::Sub { c.parent.unwrap_or(c.id) } else { c.id }),
            Target::Draft(_) => None,
        };
        let folder_to = lead.and_then(|l| self.ws_folder_to(l).cloned());
        // Over the bar, or under the header's chip.
        let (pick, close) = crate::widgets::popover(ctx, "workspace", self.popup_anchor, 320.0, !self.ws.from_header, &t, |ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            crate::widgets::menu_label(ui, "Workspace");
            let mut pick: Option<bool> = None;
            match (target, &info.worktree) {
                (Target::Draft(_), _) => {
                    if crate::widgets::menu_item(ui, crate::icons::FOLDER, "Current checkout", Some("Runs in the project's own folder"), !info.new_worktree).clicked() {
                        pick = Some(false);
                    }
                    if crate::widgets::menu_item(ui, crate::icons::FOLDER_GIT, "New worktree", Some("Its own folder and branch, so parallel agents don't collide"), info.new_worktree).clicked() {
                        pick = Some(true);
                    }
                }
                (Target::Chat(_), Some(w)) => {
                    let name = w.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    crate::widgets::menu_item(ui, crate::icons::FOLDER_GIT, &name, Some(&crate::app::tilde(w)), true)
                        .tip("A thread stays in its worktree. It's removed with the thread, unless it has uncommitted changes.");
                    if let Some(to) = &folder_to {
                        note(ui, &format!("Becomes {to} once nothing works in it."), t.subtle());
                    }
                }
                (Target::Chat(_), None) => {
                    crate::widgets::menu_item(ui, crate::icons::FOLDER, "Current checkout", Some(&crate::app::tilde(&info.repo)), true);
                    let ok = info.can_move.is_ok();
                    let r = ui.add_enabled_ui(ok, |ui| crate::widgets::menu_item(ui, crate::icons::FOLDER_GIT, "Move to a new worktree", Some("From the checkout's branch; the thread goes on there"), false)).inner;
                    let r = match &info.can_move {
                        Err(why) => r.on_disabled_hover_text(format!("Can't move now: {why}")),
                        Ok(()) => r,
                    };
                    if r.clicked() {
                        pick = Some(true);
                    }
                }
            }
            if let Some(e) = &error {
                note(ui, e, t.red(900));
            }
            pick
        });
        match (pick, target) {
            (Some(on), Target::Draft(_)) => {
                self.ws.draft.worktree = on;
                if !on {
                    self.ws.draft.base.clear();
                }
                return true;
            }
            (Some(_), Target::Chat(id)) => {
                self.ws.error = None;
                self.ws_move_to_worktree(id, ctx, |app, r, _| match r {
                    Ok(_) => {
                        if app.popup == Some(Popup::Workspace) {
                            app.popup = None;
                        }
                    }
                    Err(e) => app.ws.error = Some(e),
                });
            }
            _ => {}
        }
        close
    }

    /// The branch picker (Popup::Branch). True: close it.
    pub fn branch_menu(&mut self, ctx: &egui::Context) -> bool {
        let t = self.theme.t;
        let target = self.ws_target();
        let Some(info) = self.ws_info(target) else { return true };
        if let (Target::Chat(id), Some(_)) = (target, &self.ws.rename) {
            return self.rename_menu(ctx, id, &info, "branch", true);
        }
        let h = self.ws_head(&info.dir, ctx);
        let list = match &self.ws.menu {
            Some((d, b)) if *d == info.dir => b.clone(),
            _ => {
                self.ws_load_branches(info.dir.clone(), ctx);
                None
            }
        };
        let busy = self.ws.busy.clone();
        let mut query = std::mem::take(&mut self.ws.query);
        let error = self.ws.error.clone();
        let current = if info.new_worktree { if info.base.is_empty() { h.as_ref().map(|h| h.branch.clone()).unwrap_or_default() } else { info.base.clone() } } else { h.as_ref().map(|h| h.branch.clone()).unwrap_or_default() };
        let (pick, close) = crate::widgets::popover(ctx, "branch", self.popup_anchor, 340.0, true, &t, |ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            let mut pick: Option<Result<Row, String>> = None;
            let r = ui.add(egui::TextEdit::singleline(&mut query).hint_text("Search branches").desired_width(f32::INFINITY).margin(egui::Margin::symmetric(8, 6)));
            if !r.has_focus() && !r.lost_focus() {
                r.request_focus();
            }
            ui.add_space(4.0);
            if info.new_worktree {
                crate::widgets::subtle(ui, "  The new worktree starts from", "label-12");
            } else if let Some(why) = &info.branch_lock {
                crate::widgets::subtle(ui, format!("  {why}"), "label-12");
            } else if let Some(h) = h.as_ref().filter(|h| h.dirty > 0) {
                note(
                    ui,
                    &format!(
                        "{} {} uncommitted change{} here: they come along to the branch you switch to, and git refuses if they'd be overwritten.",
                        crate::icons::ALERT,
                        h.dirty,
                        if h.dirty == 1 { "" } else { "s" }
                    ),
                    t.amber(900),
                );
            }
            if info.worktree.is_none() && !info.new_worktree {
                note(ui, "Switches the project's checkout: other threads there see it too.", t.subtle());
            }
            let locked = info.branch_lock.is_some() && !info.new_worktree;
            let enter = r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            if let Some((_, what)) = &busy {
                busy_line(ui, what, &t);
            }
            let locked = locked || busy.is_some();
            match &list {
                None => busy_line(ui, "Reading branches…", &t),
                Some(Err(e)) => {
                    crate::widgets::subtle(ui, format!("  {e}"), "label-12");
                }
                Some(Ok(b)) => {
                    let rows = rank(b, &query, 200);
                    ScrollArea::vertical().max_height(300.0).show(ui, |ui| {
                        for (i, row) in rows.iter().enumerate() {
                            let desc = if row.remote { Some("remote") } else { None };
                            let r = ui.add_enabled_ui(!locked, |ui| crate::widgets::menu_item(ui, crate::icons::BRANCH, &row.name, desc, row.name == current)).inner;
                            if r.clicked() || (enter && i == 0 && !query.trim().is_empty()) {
                                pick = Some(Ok(row.clone()));
                            }
                        }
                        if rows.is_empty() {
                            crate::widgets::subtle(ui, "  No branch matches", "label-12");
                        }
                    });
                    let q = query.trim();
                    if !info.new_worktree && !q.is_empty() && !b.local.iter().any(|l| l == q) {
                        crate::widgets::menu_separator(ui);
                        let r = ui.add_enabled_ui(!locked, |ui| crate::widgets::menu_item(ui, crate::icons::PLUS, &format!("Create branch “{q}”"), Some("From where it is now, and switch to it"), false)).inner;
                        if r.clicked() {
                            pick = Some(Err(q.to_string()));
                        }
                    }
                }
            }
            if let Some(e) = &error {
                note(ui, e, t.red(900));
            }
            pick
        });
        self.ws.query = query;
        let (row, name) = match pick {
            Some(Ok(row)) => (Some(row), None),
            Some(Err(name)) => (None, Some(name)),
            None => return close && self.ws.busy.is_none(),
        };
        self.ws.error = None;
        let dir = info.dir.clone();
        self.ws_branch(target, row, name, ctx, move |app, r, ctx| match r {
            Ok(()) => {
                app.ws.menu = None;
                if app.popup == Some(Popup::Branch) {
                    app.popup = None;
                }
            }
            Err(e) => {
                app.ws.error = Some(e);
                app.ws_load_branches(dir, ctx);
            }
        });
        false
    }

    /// Opens the rename form (the chips do, in the popover they open): the branch's (its remote is read on a
    /// thread) or the worktree folder's.
    fn ws_start_rename(&mut self, kind: RenameKind, info: &Info, ctx: &egui::Context) {
        self.ws.error = None;
        let name = match kind {
            RenameKind::Branch => self.ws_head(&info.dir, ctx).map(|h| h.branch).unwrap_or_default(),
            RenameKind::Folder => info.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        };
        let pushed = if kind == RenameKind::Folder { Some(None) } else { None };
        self.ws.rename = Some(RenameForm { kind, dir: info.dir.clone(), name, on_remote: true, pushed, focus: true });
        if kind == RenameKind::Branch {
            let (dir, read) = (info.dir.clone(), info.dir.clone());
            self.ws_spawn(ctx, move || pushed_as(&read), move |app, p, _| {
                if let Some(f) = app.ws.rename.as_mut().filter(|f| f.dir == dir && f.kind == RenameKind::Branch) {
                    f.pushed = Some(p);
                }
            });
        }
    }

    /// The rename form, in the branch popover or the workspace popover (`id`, `above` as that
    /// popover): the branch's new name, whether its remote branch is renamed too and where the
    /// folder goes, with the way to the branch picker; or the worktree folder's new name. True:
    /// close it.
    fn rename_menu(&mut self, ctx: &egui::Context, chat: i64, info: &Info, id: &str, above: bool) -> bool {
        let t = self.theme.t;
        let Some(mut form) = self.ws.rename.take() else { return true };
        let busy = self.ws.busy.clone();
        let error = self.ws.error.clone();
        let lead = self.chat(chat).map(|c| if c.role == Role::Sub { c.parent.unwrap_or(c.id) } else { c.id }).unwrap_or(chat);
        let folder_now = info.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let current = match form.kind {
            RenameKind::Branch => self.ws_head(&info.dir, ctx).map(|h| h.branch).unwrap_or_default(),
            RenameKind::Folder => folder_now.clone(),
        };
        let named = self.ws_folder_named(lead);
        let folder_to = self.ws_folder_to(lead).cloned();
        let name = form.name.trim().to_string();
        // Where the folder goes: for a branch, the name it gives (unless the user named the
        // folder); for a folder, what's typed.
        let folder = match form.kind {
            RenameKind::Branch if named => None,
            RenameKind::Branch => (!name.is_empty()).then(|| folder_for(&info.repo, &info.dir, &name)).flatten().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())),
            RenameKind::Folder => (!name.is_empty() && name != current).then(|| name.clone()),
        };
        let waits = folder.as_ref().and_then(|_| self.ws_folder_busy(lead, &info.dir));
        // A folder name that can't be: said under the field as it's typed.
        let problem = if form.kind == RenameKind::Folder && name != current { folder_name_problem(&info.dir, &name) } else { None };
        let ready = !name.is_empty() && name != current && busy.is_none() && form.pushed.is_some() && problem.is_none();
        let (title, hint) = match form.kind {
            RenameKind::Branch => ("Rename branch", "New branch name"),
            RenameKind::Folder => ("Rename worktree", "New folder name"),
        };
        let ((submit, cancel, switch), close) = crate::widgets::popover(ctx, id, self.popup_anchor, 340.0, above, &t, |ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            crate::widgets::menu_label(ui, title);
            let r = ui.add(egui::TextEdit::singleline(&mut form.name).hint_text(hint).desired_width(f32::INFINITY).margin(egui::Margin::symmetric(8, 6)));
            if std::mem::take(&mut form.focus) {
                r.request_focus();
            }
            let enter = r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            ui.add_space(6.0);
            match &form.pushed {
                None => busy_line(ui, "Checking its remote…", &t),
                Some(Some(up)) => {
                    ui.horizontal(|ui| {
                        ui.add_space(8.0);
                        crate::widgets::toggle(ui, &mut form.on_remote);
                        ui.add_space(6.0);
                        ui.label(egui::RichText::new(format!("Also rename {up}")).size(13.0).color(t.fg()));
                    });
                    ui.add_space(4.0);
                    let say = if form.on_remote {
                        "On GitHub it's renamed there and its pull requests follow; on other remotes the new name is pushed and the old one stays."
                    } else {
                        "The remote branch keeps its old name; this one stops tracking it."
                    };
                    note(ui, say, t.subtle());
                }
                Some(None) => {}
            }
            if let (RenameKind::Folder, Some(to)) = (form.kind, &folder_to) {
                note(ui, &format!("Becomes {to} once nothing works in it."), t.subtle());
            }
            match (form.kind, &folder, &waits) {
                (RenameKind::Branch, None, _) if named => note(ui, &format!("The folder keeps its name, {folder_now}: you named it."), t.subtle()),
                (RenameKind::Branch, Some(f), None) => note(ui, &format!("The folder becomes {f}."), t.subtle()),
                (RenameKind::Branch, Some(f), Some(why)) => note(ui, &format!("The folder becomes {f} once nothing works in it ({why} now); the branch is renamed at once."), t.subtle()),
                (RenameKind::Folder, _, _) if problem.is_some() => note(ui, problem.as_deref().unwrap_or(""), t.red(900)),
                (RenameKind::Folder, Some(_), Some(why)) => note(ui, &format!("Renamed once nothing works in it ({why} now). Stays in {}; renaming the branch leaves it be from now on.", info.dir.parent().map(|p| crate::app::tilde(p)).unwrap_or_default()), t.subtle()),
                (RenameKind::Folder, _, _) => note(ui, &format!("Stays in {}; renaming the branch leaves it be from now on.", info.dir.parent().map(|p| crate::app::tilde(p)).unwrap_or_default()), t.subtle()),
                _ => {}
            }
            if let Some((_, what)) = &busy {
                busy_line(ui, what, &t);
            }
            if let Some(e) = &error {
                note(ui, e, t.red(900));
            }
            ui.add_space(2.0);
            let (submit, cancel) = ui
                .horizontal(|ui| {
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.add_space(4.0);
                        let submit = crate::widgets::btn("Rename").primary().sm().enabled(ready).show(ui).clicked() || (enter && ready);
                        let cancel = crate::widgets::btn("Cancel").outline().sm().enabled(busy.is_none()).show(ui).clicked();
                        (submit, cancel)
                    })
                    .inner
                })
                .inner;
            // Everything else the branch chip does: switching and creating branches.
            let mut switch = false;
            if form.kind == RenameKind::Branch {
                ui.add_space(4.0);
                crate::widgets::menu_separator(ui);
                switch = ui.add_enabled_ui(busy.is_none(), |ui| crate::widgets::menu_item(ui, crate::icons::BRANCH, "Switch branch…", Some("Or create one, from where it is now"), false)).inner.clicked();
            }
            (submit, cancel, switch)
        });
        if cancel {
            self.ws.error = None;
            return true;
        }
        // The form stays closed: branch_menu shows the picker from now on.
        if switch {
            self.ws.error = None;
            return false;
        }
        let on_remote = form.on_remote && matches!(form.pushed, Some(Some(_)));
        let kind = form.kind;
        self.ws.rename = Some(form);
        if submit {
            self.ws.error = None;
            let finish = |app: &mut App, r: Result<RenameDone, String>, ctx: &egui::Context| match r {
                Ok(d) => {
                    app.ws.rename = None;
                    app.ws.menu = None;
                    if matches!(app.popup, Some(Popup::Branch | Popup::Workspace)) {
                        app.popup = None;
                    }
                    crate::picker::show_toast(ctx, rename_said(&d));
                }
                Err(e) => app.ws.error = Some(e),
            };
            match kind {
                RenameKind::Branch => self.ws_rename(chat, name, on_remote, ctx, finish),
                RenameKind::Folder => {
                    let r = self.ws_rename_folder(chat, &name);
                    finish(self, r, ctx);
                }
            }
            return false;
        }
        if close && self.ws.busy.is_none() {
            self.ws.rename = None;
            return true;
        }
        false
    }

    // -------------------------------------------------------------- phones (api.rs)

    fn api_target(&self, chat: Option<&str>, project: Option<&str>) -> Result<Target, (u16, String)> {
        match chat.filter(|c| !c.is_empty()) {
            Some(c) => self.ref_id(c).filter(|c| self.chat(*c).is_some()).map(Target::Chat).ok_or((404, "no such chat".into())),
            None => Ok(Target::Draft(self.project_ref(project.unwrap_or("")))),
        }
    }

    /// The workspace and branch calls of phones (android/PROTOCOL.md), answered from git
    /// threads so the UI never waits on git: None, not one of them; Some(reply) to send now;
    /// Some(None) when a thread answers on its own.
    pub fn ws_api(&mut self, call: &crate::api::Call, ctx: &egui::Context) -> Option<Option<crate::api::Reply>> {
        use crate::api::{err, ok};
        let p: Vec<&str> = call.path.iter().map(String::as_str).collect();
        let q = |k: &str| call.query.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        // Ids come as numbers or strings (gids, project paths).
        let s = |v: &Value| v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string()));
        let reply = |c: &crate::api::Call| c.reply.clone();
        match (call.method.as_str(), p.as_slice()) {
            // `?chat=<id>` or `?project=<id>&worktree=0|1&base=<branch>`: the bar.
            ("GET", ["v1", "workspace"]) => {
                let target = match self.api_target(q("chat"), q("project")) {
                    Ok(t) => t,
                    Err((st, e)) => return Some(Some(err(st, e))),
                };
                // A phone shows the chat: its PR is looked up as for the desktop's footer (it comes
                // in the chat's JSON).
                if let Target::Chat(id) = target {
                    self.pr_want(id, Some(crate::chatpr::SHOWN_TTL), ctx);
                }
                let Some(info) = self.ws_info(target) else { return Some(Some(ok(json!({ "git": false })))) };
                let new_worktree = matches!(target, Target::Draft(_)) && q("worktree") == Some("1");
                let base = q("base").unwrap_or("").to_string();
                // Work git is doing for the desktop's bar now ("Creating worktree…").
                let pending = self.ws.busy.as_ref().map(|(_, w)| w.clone());
                // A renamed branch's folder still to follow it: why it waits.
                let lead = match target {
                    Target::Chat(id) => self.chat(id).map(|c| if c.role == Role::Sub { c.parent.unwrap_or(c.id) } else { c.id }),
                    Target::Draft(_) => None,
                };
                let folder_waits = lead.filter(|l| self.ws.moves.contains_key(l)).and_then(|l| self.ws_folder_busy(l, &info.dir));
                let folder_to = lead.and_then(|l| self.ws_folder_to(l).cloned());
                let folder_named = lead.is_some_and(|l| self.ws_folder_named(l));
                let tx = reply(call);
                std::thread::spawn(move || {
                    let h = head(&info.dir);
                    // The folder has no use for a branch: a detached worktree's can be renamed.
                    let folder_rename = info.rename.is_ok();
                    let rename = info.rename.clone().and_then(|_| if h.as_ref().is_some_and(|h| h.branch.is_empty()) { Err("it's detached: switch to a branch first".to_string()) } else { Ok(()) });
                    let pushed = rename.is_ok().then(|| pushed_as(&info.dir)).flatten();
                    let name = info.worktree.as_ref().and_then(|w| w.file_name()).map(|n| n.to_string_lossy().into_owned());
                    let _ = tx.send(ok(json!({
                        "git": true,
                        "mode": if info.worktree.is_some() || new_worktree { "worktree" } else { "checkout" },
                        "name": name,
                        "path": info.worktree.as_ref().unwrap_or(&info.repo).to_string_lossy(),
                        "branch": h.as_ref().map(|h| h.label()).unwrap_or_default(),
                        "dirty": h.as_ref().map_or(0, |h| h.dirty),
                        "base": if new_worktree { if base.is_empty() { h.as_ref().map(|h| h.branch.clone()).unwrap_or_default() } else { base } } else { String::new() },
                        "can_move": info.can_move.is_ok(),
                        "move_why": info.can_move.err(),
                        "branch_lock": if new_worktree { None } else { info.branch_lock },
                        "pending": pending,
                        "can_rename": rename.is_ok(),
                        "can_rename_folder": folder_rename,
                        "rename_why": rename.err(),
                        "pushed": pushed,
                        "folder_waits": folder_waits,
                        "folder_to": folder_to,
                        "folder_named": folder_named,
                    })));
                });
                Some(None)
            }
            // `?chat=|project=&q=`: ranked here, as the desktop's picker.
            ("GET", ["v1", "branches"]) => {
                let target = match self.api_target(q("chat"), q("project")) {
                    Ok(t) => t,
                    Err((st, e)) => return Some(Some(err(st, e))),
                };
                let Some(info) = self.ws_info(target) else { return Some(Some(err(409, "not a git project"))) };
                let query = q("q").unwrap_or("").trim().to_string();
                let tx = reply(call);
                std::thread::spawn(move || {
                    let b = match branches(&info.dir) {
                        Ok(b) => b,
                        Err(e) => return drop(tx.send(err(409, e))),
                    };
                    let h = head(&info.dir).unwrap_or_default();
                    let rows = rank(&b, &query, 100);
                    let warning = (h.dirty > 0).then(|| format!("{} uncommitted change{} here: they come along to the branch you switch to, and git refuses if they'd be overwritten.", h.dirty, if h.dirty == 1 { "" } else { "s" }));
                    let _ = tx.send(ok(json!({
                        "current": h.branch,
                        "dirty": h.dirty,
                        "warning": warning,
                        "checkout_note": info.worktree.is_none().then_some("Switches the project's checkout (other threads there see it too)"),
                        "branches": rows.iter().map(|r| json!({ "name": r.name, "remote": r.remote, "current": !r.remote && r.name == h.branch })).collect::<Vec<_>>(),
                        "can_create": !query.is_empty() && !b.local.iter().any(|l| *l == query) && valid_branch(&info.dir, &query),
                        "branch_lock": info.branch_lock,
                    })));
                });
                Some(None)
            }
            // `{chat|project, "switch": name, "remote": bool}` or `{…, "create": name}`.
            ("POST", ["v1", "branches"]) => {
                let body = &call.body;
                let (chat, project) = (s(&body["chat"]), s(&body["project"]));
                let target = match self.api_target(chat.as_deref(), project.as_deref()) {
                    Ok(t) => t,
                    Err((st, e)) => return Some(Some(err(st, e))),
                };
                let (row, name) = match (body["switch"].as_str(), body["create"].as_str()) {
                    (Some(n), _) => (Some(Row { name: n.to_string(), remote: body["remote"].as_bool().unwrap_or(false) }), None),
                    (None, Some(n)) => (None, Some(n.to_string())),
                    _ => return Some(Some(err(400, "switch or create a branch"))),
                };
                let tx = reply(call);
                self.ws_branch(target, row, name, ctx, move |app, r, _| {
                    let _ = tx.send(match r {
                        Ok(()) => {
                            let dir = app.ws_info(target).map(|i| i.dir);
                            ok(json!({ "ok": true, "branch": dir.and_then(|d| head(&d)).map(|h| h.label()).unwrap_or_default() }))
                        }
                        Err(e) => err(409, e),
                    });
                });
                Some(None)
            }
            // "Move to a new worktree".
            ("POST", ["v1", "chats", c, "worktree"]) => {
                let Some(id) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return Some(Some(err(404, "no such chat"))) };
                let tx = reply(call);
                self.ws_move_to_worktree(id, ctx, move |_, r, _| {
                    let _ = tx.send(match r {
                        Ok(d) => ok(json!({ "ok": true, "name": d.file_name().map(|n| n.to_string_lossy().into_owned()), "path": d.to_string_lossy() })),
                        Err(e) => err(409, e),
                    });
                });
                Some(None)
            }
            // `{"branch": "<new name>", "remote": bool}`: renames the branch of the chat's worktree;
            // `{"folder": "<new name>"}`: its folder.
            ("POST", ["v1", "chats", c, "worktree", "rename"]) => {
                let Some(id) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return Some(Some(err(404, "no such chat"))) };
                if let Some(name) = call.body["folder"].as_str() {
                    return Some(Some(match self.ws_rename_folder(id, name) {
                        Ok(d) => ok(json!({ "ok": true, "name": d.folder, "path": d.path.to_string_lossy(), "folder_waits": d.waits, "said": rename_said(&d) })),
                        Err(e) => err(409, e),
                    }));
                }
                let Some(name) = call.body["branch"].as_str().map(String::from) else { return Some(Some(err(400, "branch or folder: the new name"))) };
                let on_remote = call.body["remote"].as_bool().unwrap_or(true);
                let tx = reply(call);
                self.ws_rename(id, name, on_remote, ctx, move |_, r, _| {
                    let _ = tx.send(match r {
                        Ok(d) => ok(json!({
                            "ok": true, "branch": d.renamed.branch, "old": d.renamed.old, "remote": d.renamed.remote,
                            "name": d.folder, "path": d.path.to_string_lossy(), "folder_waits": d.waits, "said": rename_said(&d),
                        })),
                        Err(e) => err(409, e),
                    });
                });
                Some(None)
            }
            // A new chat in a new worktree: made on a thread, then the chat starts there.
            ("POST", ["v1", "chats"]) if call.body["worktree"].as_bool() == Some(true) && call.body["device"].as_str().unwrap_or("").is_empty() => {
                let repo = match self.api_create_repo(&call.body) {
                    Ok(r) => r,
                    Err(r) => return Some(Some(r)),
                };
                // A project without Git has no worktrees: the chat starts in its folder, as the
                // desktop does (a phone may still hold "New worktree" from another project).
                let Some(info) = self.ws_info(Target::Draft(repo)) else { return None };
                let base = call.body["base"].as_str().unwrap_or("").to_string();
                let call = call.clone();
                let repo_dir = info.repo.clone();
                // Named as the chat will be: its title, else its first message.
                let about = [&call.body["title"], &call.body["text"]].iter().filter_map(|v| v.as_str()).find(|t| !t.trim().is_empty()).unwrap_or("").to_string();
                let name = self.ws_namer(&about);
                self.ws_spawn(ctx, move || make(&repo_dir, &base, &about, name), move |app, r, ctx| {
                    let reply = match r {
                        Err(e) => err(409, e),
                        Ok(made) => {
                            app.sender = if call.device.is_empty() { "Phone".into() } else { call.device.clone() };
                            app.sender_device = crate::api::device_id(&call.token);
                            let dir = made.dir.clone();
                            let mut r = app.api_create_in(&call.body, ctx, Some(made));
                            app.sender.clear();
                            app.sender_device.clear();
                            if r.status >= 300 {
                                let repo = info.repo.clone();
                                app.ws_spawn(ctx, move || remove(&repo, &dir), |_, _, _| {});
                            } else if call.global {
                                app.globalize(&call, &mut r.body);
                            }
                            r
                        }
                    };
                    let _ = call.reply.send(reply);
                });
                Some(None)
            }
            _ => None,
        }
    }
}

/// What a rename did, in a line: "Renamed to harbor/x · folder harbor-x", with what happened
/// on its remote and whether the folder waits.
pub fn rename_said(d: &RenameDone) -> String {
    if d.kind == RenameKind::Folder {
        return match &d.waits {
            Some(why) => format!("The worktree folder is renamed once nothing works in it ({why})"),
            None => format!("Worktree folder renamed to {}", d.folder),
        };
    }
    let mut s = format!("Renamed to {}", d.renamed.branch);
    match &d.waits {
        Some(why) => s.push_str(&format!(" · the folder follows once nothing works in it ({why})")),
        None => s.push_str(&format!(" · folder {}", d.folder)),
    }
    if let Some(r) = &d.renamed.remote {
        s.push_str(&format!(". {r}"));
    }
    s
}

/// What the branch chip does, for its tip: renames the branch of a chat's own worktree (with
/// the picker a row away), else opens the picker.
fn branch_tip(info: &Info, h: &Head) -> &'static str {
    if info.rename.is_ok() && !h.branch.is_empty() { "Rename this branch, or switch to another" } else { "Switch or create a branch" }
}

/// "Switching to main…" with a spinner.
fn busy_line(ui: &mut Ui, text: &str, t: &crate::theme::Tokens) {
    ui.horizontal(|ui| {
        ui.add_space(10.0);
        let (r, _) = ui.allocate_exact_size(egui::vec2(14.0, 18.0), egui::Sense::hover());
        crate::widgets::spinner(ui.painter(), r.center(), 5.0, t.subtle());
        ui.add_space(4.0);
        ui.label(egui::RichText::new(text).color(t.subtle()).size(12.0));
    });
    ui.add_space(4.0);
}

/// A wrapped line of the menus (a warning, a note, git's error).
fn note(ui: &mut Ui, text: &str, color: egui::Color32) {
    egui::Frame::new().inner_margin(egui::Margin { left: 8, right: 8, top: 2, bottom: 6 }).show(ui, |ui| {
        ui.add(egui::Label::new(egui::RichText::new(text).color(color).size(12.0)).wrap());
    });
}

/// The bar's place of a trigger while git works: a spinner and what it does.
fn w_busy(ui: &mut Ui, text: &str, t: &crate::theme::Tokens) -> egui::Response {
    let galley = ui.painter().layout_no_wrap(text.to_string(), egui::FontId::proportional(12.5), t.subtle());
    let size = galley.size() + egui::vec2(30.0, 8.0);
    let (rect, r) = ui.allocate_exact_size(size, egui::Sense::hover());
    crate::widgets::spinner(ui.painter(), rect.left_center() + egui::vec2(13.0, 0.0), 5.0, t.subtle());
    ui.painter().galley(rect.min + egui::vec2(24.0, 4.0), galley, t.subtle());
    r
}

/// A quiet trigger of the footer under the composer, as the phone draws it: a muted icon and
/// text, no box; hovered or open, the text comes up to full strength.
fn w_small(ui: &mut Ui, icon: &str, text: &str, open: bool, t: &crate::theme::Tokens) -> egui::Response {
    w_small_tinted(ui, icon, text, open, t.subtle(), t)
}

/// The branch's pull request in the footer: its state's icon in the state's colour, "PR #123 ·
/// Merged" muted like the rest; a click opens it on GitHub.
fn w_pr(ui: &mut Ui, p: &crate::chatpr::ChatPr, t: &crate::theme::Tokens) -> egui::Response {
    let font = egui::FontId::proportional(12.5);
    let icon = ui.painter().layout_no_wrap(format!("{}  ", p.state.icon()), font.clone(), p.state.color(t));
    let text = ui.painter().layout_no_wrap(p.label(), font, t.subtle());
    let size = egui::vec2(icon.size().x + text.size().x, icon.size().y.max(text.size().y)) + egui::vec2(16.0, 8.0);
    let (rect, r) = ui.allocate_exact_size(size, egui::Sense::click());
    let r = r.on_hover_cursor(egui::CursorIcon::PointingHand);
    let fg = if r.hovered() { t.fg() } else { t.subtle() };
    let at = rect.min + egui::vec2(8.0, 4.0);
    let icon_w = icon.size().x;
    ui.painter().galley(at, icon, p.state.color(t));
    ui.painter().galley_with_override_text_color(at + egui::vec2(icon_w, 0.0), text, fg);
    if r.clicked() {
        crate::git::open_url(&p.url);
    }
    r.tip(p.tip())
}

fn w_small_tinted(ui: &mut Ui, icon: &str, text: &str, open: bool, rest: egui::Color32, t: &crate::theme::Tokens) -> egui::Response {
    // Long names are cut in the middle (the phone's ellipsis), the rest of the row stays.
    let max = (ui.available_width() - 16.0).clamp(80.0, 320.0);
    let galley = crate::widgets::truncated(ui, &format!("{icon}  {text}"), egui::FontId::proportional(12.5), rest, max);
    let size = galley.size() + egui::vec2(16.0, 8.0);
    let (rect, r) = ui.allocate_exact_size(size, egui::Sense::click());
    let r = r.on_hover_cursor(egui::CursorIcon::PointingHand);
    let color = if r.hovered() || open { if rest == t.subtle() { t.fg() } else { rest } } else { rest };
    ui.painter().galley_with_override_text_color(rect.min + egui::vec2(8.0, 4.0), galley, color);
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("harbor-wt-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let g = |args: &[&str]| assert!(Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@example.com"]).args(args).current_dir(&d).output().unwrap().status.success(), "{args:?}");
        g(&["init", "-q", "-b", "main"]);
        std::fs::write(d.join("a.txt"), "a").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "a"]);
        g(&["branch", "feature/login"]);
        d
    }

    #[test]
    fn ranks_branches() {
        let b = Branches { local: vec!["main".into(), "feature/login".into()], remote: vec!["origin/main".into(), "origin/fix-ui".into()] };
        let all = rank(&b, "", 10);
        assert_eq!(all.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["main", "feature/login", "origin/fix-ui"], "remote copies of local branches are left out");
        assert!(all[2].remote);
        assert_eq!(rank(&b, "login", 10)[0].name, "feature/login");
        assert_eq!(rank(&b, "fxu", 10)[0].name, "origin/fix-ui", "letters in order");
    }

    #[test]
    fn switches_creates_and_cleans_up() {
        let d = repo("ops");
        assert_eq!(head(&d).unwrap().branch, "main");
        switch(&d, "feature/login", false).unwrap();
        assert_eq!(head(&d).unwrap().branch, "feature/login");
        assert!(create(&d, "bad name..").is_err());
        create(&d, "wip/one").unwrap();
        assert_eq!(head(&d).unwrap().branch, "wip/one");
        // A worktree from main, then removed (clean), its merged branch with it.
        let root = d.with_extension("wts");
        let wt = add_in(&root, &d, "main", "").unwrap();
        let h = head(&wt).unwrap();
        assert!(h.branch.starts_with("harbor/"));
        remove(&d, &wt).unwrap();
        assert!(!wt.exists());
        assert!(!branches(&d).unwrap().local.contains(&h.branch));
        // Uncommitted changes keep it.
        let wt = add_in(&root, &d, "", "").unwrap();
        std::fs::write(wt.join("new.txt"), "x").unwrap();
        let e = remove(&d, &wt).unwrap_err();
        assert!(e.contains("1 uncommitted change"), "{e}");
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_new_worktree_says_its_branch_and_base() {
        let d = repo("made");
        let root = d.with_extension("wts");
        // From the checkout's branch (""): that's its base.
        let m = make_in(&root, &d, "", "Fix the login bug", None).unwrap();
        assert_eq!((m.branch.as_str(), m.base.as_str()), ("harbor/fix-login-bug", "main"));
        let (text, detail) = m.notice("Working in a new worktree");
        assert_eq!(text, format!("Working in a new worktree · {} on branch harbor/fix-login-bug (from main)", m.name()));
        assert!(detail.contains("Branch: harbor/fix-login-bug (from main)"), "{detail}");
        let m = make_in(&root, &d, "feature/login", "", None).unwrap();
        assert_eq!(m.base, "feature/login");
        // Nothing to name it after: 6 hex, as before.
        let id = m.branch.strip_prefix("harbor/").unwrap();
        assert!(id.len() == 6 && id.chars().all(|c| c.is_ascii_hexdigit()), "{id}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn claude_names_new_worktrees() {
        let d = repo("claude");
        let root = d.with_extension("wts");
        let proj = project_part(&d);
        let say = |a: &'static str| -> Option<Namer> { Some(Box::new(move || clean_name(a))) };
        // In time: made with Claude's name, folder and branch.
        let m = make_in(&root, &d, "", "Remove this, i only want the worktree here", say("worktree-menu-cleanup")).unwrap();
        assert_eq!((m.branch.as_str(), m.name()), ("harbor/worktree-menu-cleanup", format!("{proj}-worktree-menu-cleanup")));
        assert!(m.late.is_none() && m.dir.is_dir() && !root.join(format!("{proj}-remove-only-want-worktree")).exists());
        assert_eq!(head(&m.dir).unwrap().branch, "harbor/worktree-menu-cleanup");
        let list = git(&d, &["worktree", "list", "--porcelain"], GIT_TIMEOUT).unwrap();
        assert!(list.contains(&format!("worktree {}", m.dir.display())), "{list}");
        // Taken: a number, as for slugs.
        assert_eq!(make_in(&root, &d, "", "Something else", say("worktree-menu-cleanup")).unwrap().branch, "harbor/worktree-menu-cleanup-2");
        // No answer (offline, no account, nonsense): the slug.
        assert_eq!(make_in(&root, &d, "", "Fix the login bug", Some(Box::new(|| None))).unwrap().branch, "harbor/fix-login-bug");
        assert_eq!(make_in(&root, &d, "", "Fix the login bug", say("I can't name this: it's not a task.")).unwrap().branch, "harbor/fix-login-bug-2");
        // Late: the slug now, the answer still to come.
        let slow: Namer = Box::new(|| {
            std::thread::sleep(NAME_WAIT + Duration::from_millis(500));
            Some("late-name".into())
        });
        let t = Instant::now();
        let m = make_in(&root, &d, "", "Sidebar chips", Some(slow)).unwrap();
        assert!(t.elapsed() < NAME_WAIT + Duration::from_millis(400), "waited {:?}", t.elapsed());
        assert_eq!(m.branch, "harbor/sidebar-chips");
        let rx = m.late.clone().expect("still coming");
        assert_eq!(rx.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap().as_deref(), Some("late-name"));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn claude_answers_are_cleaned_into_names() {
        assert_eq!(clean_name("inline-chat-mention-links").as_deref(), Some("inline-chat-mention-links"));
        assert_eq!(clean_name("  `Harbor/Fix_Login Redirect`.\n").as_deref(), Some("fix-login-redirect"));
        assert_eq!(clean_name("\"dark-mode\"\nBecause the user wants…").as_deref(), Some("dark-mode"));
        assert_eq!(clean_name("one-two-three-four-five-six-seven").as_deref(), Some("one-two-three-four-five"));
        assert!(clean_name("averyveryverylongwordthatgoeson-andanotherlongword").unwrap().len() <= 40);
        assert_eq!(clean_name("Here is a name for the task you asked for"), None, "a sentence");
        assert_eq!(clean_name("Name: fix-it"), None);
        assert_eq!(clean_name("日本語"), None);
        assert_eq!(clean_name("42"), None);
        assert_eq!(clean_name(""), None);
    }

    #[test]
    fn names_come_from_what_the_chat_is_about() {
        assert_eq!(slug("Main thread per project"), "main-thread-per-project");
        assert_eq!(slug("Fix the login bug where users get logged out"), "fix-login-bug-users-get");
        assert_eq!(slug("\n  Can you make the sidebar's chips blue? https://example.com/x"), "make-sidebars-chips-blue");
        assert_eq!(slug("Quero que a migração funcione"), "migracao-funcione");
        assert_eq!(slug("the and of"), "the-and-of", "only filler: kept rather than nothing");
        assert_eq!(slug("日本語"), "");
        assert_eq!(slug("supercalifragilisticexpialidocious and more").len(), 32);
        assert_eq!(folder_part("harbor/fix-login"), "fix-login");
        assert_eq!(folder_part("Feature/A b"), "feature-a-b");
        assert!(is_named("app-fix", "app-fix") && is_named("app-fix-2", "app-fix") && !is_named("app-fix-it", "app-fix"));
    }

    #[test]
    fn named_worktrees_are_unique_and_their_folder_follows_a_rename() {
        let d = repo("names");
        let root = d.with_extension("wts");
        let proj = project_part(&d);
        let a = make_in(&root, &d, "", "Main thread per project", None).unwrap();
        assert_eq!((a.branch.clone(), a.name()), ("harbor/main-thread-per-project".to_string(), format!("{proj}-main-thread-per-project")));
        let b = make_in(&root, &d, "", "Main thread per project", None).unwrap();
        assert_eq!((b.branch.clone(), b.name()), ("harbor/main-thread-per-project-2".to_string(), format!("{proj}-main-thread-per-project-2")));
        // A branch only on a remote is taken too.
        git(&d, &["update-ref", "refs/remotes/origin/harbor/sidebar", "HEAD"], GIT_TIMEOUT).unwrap();
        assert_eq!(make_in(&root, &d, "", "Sidebar", None).unwrap().branch, "harbor/sidebar-2");
        // Bad and taken names are refused, plainly.
        assert!(rename_branch(&a.dir, "bad..name", false).unwrap_err().contains("isn't a valid branch name"));
        assert!(rename_branch(&a.dir, "main", false).unwrap_err().contains("already exists"));
        let r = rename_branch(&a.dir, " harbor/per-project-lead ", false).unwrap();
        assert_eq!(r, Renamed { old: "harbor/main-thread-per-project".into(), branch: "harbor/per-project-lead".into(), remote: None });
        assert_eq!(head(&a.dir).unwrap().branch, "harbor/per-project-lead");
        // The folder follows: git finds it at its new place, and removes it from there.
        let to = folder_for(&d, &a.dir, &r.branch).unwrap();
        assert_eq!(to.file_name().unwrap().to_string_lossy(), format!("{proj}-per-project-lead"));
        move_dir(&a.dir, &to).unwrap();
        assert!(!a.dir.exists());
        assert_eq!(head(&to).unwrap().branch, "harbor/per-project-lead");
        let list = git(&d, &["worktree", "list", "--porcelain"], GIT_TIMEOUT).unwrap();
        assert!(list.contains(&format!("worktree {}", to.display())), "{list}");
        assert_eq!(folder_for(&d, &to, &r.branch), None, "already named for it");
        // A taken folder gets a number.
        assert_eq!(folder_for(&d, &b.dir, "harbor/per-project-lead").unwrap().file_name().unwrap().to_string_lossy(), format!("{proj}-per-project-lead-2"));
        remove(&d, &to).unwrap();
        assert!(!to.exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_pushed_branch_is_renamed_on_its_remote_or_let_go() {
        let d = repo("push");
        let bare = d.with_extension("git");
        let _ = std::fs::remove_dir_all(&bare);
        assert!(Command::new("git").args(["init", "-q", "--bare"]).arg(&bare).status().unwrap().success());
        git(&d, &["remote", "add", "origin", &bare.to_string_lossy()], GIT_TIMEOUT).unwrap();
        let root = d.with_extension("wts");
        let m = make_in(&root, &d, "", "Push branch", None).unwrap();
        assert_eq!(pushed_as(&m.dir), None);
        git(&m.dir, &["push", "-q", "-u", "origin", "harbor/push-branch"], ADD_TIMEOUT).unwrap();
        assert_eq!(pushed_as(&m.dir).as_deref(), Some("origin/harbor/push-branch"));
        // Not GitHub: the new name is pushed and tracked; the old one stays there.
        let r = rename_branch(&m.dir, "harbor/pushed", true).unwrap();
        assert!(r.remote.as_deref().is_some_and(|s| s.starts_with("Pushed as origin/harbor/pushed; origin/harbor/push-branch is still there")), "{:?}", r.remote);
        assert_eq!(pushed_as(&m.dir).as_deref(), Some("origin/harbor/pushed"));
        let there = git(&bare, &["branch", "--format=%(refname:short)"], GIT_TIMEOUT).unwrap();
        assert!(there.contains("harbor/pushed") && there.contains("harbor/push-branch"), "{there}");
        // Here only: it stops tracking the remote branch, which keeps its name.
        let r = rename_branch(&m.dir, "harbor/local-only", false).unwrap();
        assert_eq!(r.remote.as_deref(), Some("origin/harbor/pushed keeps its name; push again to publish harbor/local-only"));
        assert_eq!(pushed_as(&m.dir), None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&bare);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_folder_name_is_one_plain_name_not_taken() {
        let root = std::env::temp_dir().join(format!("harbor-wt-fname-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("app-fix");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(root.join("app-other")).unwrap();
        let p = |n: &str| folder_name_problem(&dir, n);
        assert_eq!(p("app-login"), None);
        assert_eq!(p(" app-fix "), None, "its own name is fine (nothing moves)");
        assert!(p("").unwrap().contains("type"));
        assert!(p("a/b").unwrap().contains("no “/”"));
        assert!(p("..").unwrap().contains("can't start with “.”"));
        assert!(p("-x").unwrap().contains("can't start with “-”"));
        assert!(p("my app").unwrap().contains("no spaces"));
        assert!(p("app-other").unwrap().contains("already there"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
