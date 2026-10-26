//! Where a thread's agent works: the project's own checkout, or a git worktree of its own
//! (its own folder and branch, so parallel agents don't collide), and which branch that is.
//! The bar under the composer (desktop) and the two chips under the phone's composer show and
//! change it, as T3 Code's does.
//!
//! A new chat picks "Current checkout" or "New worktree" before its first message; the
//! worktree is made from the branch picked (default: the checkout's), as
//! `<data dir>/worktrees/<project>-<6 hex>` on branch `harbor/<6 hex>`. Its path is kept in kv
//! `worktree:<chat id>`; sub-agents run in their lead's. An existing chat in the checkout can
//! move to a new worktree when it could move projects (movechat.rs: not running, on this PC,
//! its Claude sessions copied over); one in a worktree stays there. Deleting the chat removes
//! its worktree, and the branch if it has nothing unmerged (`git branch -d`), unless the
//! worktree has uncommitted changes: then it's kept and the user is told where.
//!
//! The branch picker switches the branch of where the chat runs (`git switch`, which refuses
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

/// Makes a worktree of `repo` on a new branch `harbor/<id>` from `base` (a branch, or "" for
/// the checkout's HEAD). Returns its folder.
pub fn add(repo: &Path, base: &str) -> Result<PathBuf, String> {
    add_in(&root(), repo, base)
}

fn add_in(root: &Path, repo: &Path, base: &str) -> Result<PathBuf, String> {
    let project: String = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into()).chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect();
    let mut last = String::new();
    for _ in 0..4 {
        let id: String = store::new_uuid().chars().filter(|c| c.is_ascii_hexdigit()).take(6).collect();
        let dir = root.join(format!("{project}-{id}"));
        if dir.exists() {
            continue;
        }
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let branch = format!("harbor/{id}");
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

/// Removes a worktree made by `add`, unless it has uncommitted changes (Err says so). Its
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
}

impl Default for State {
    fn default() -> Self {
        let (done_tx, done_rx) = channel();
        Self { draft: DraftWs::default(), done_tx, done_rx, busy: None, heads: Default::default(), menu: None, query: String::new(), error: None }
    }
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
}

impl App {
    /// The worktree a chat runs in (sub-agents: their lead's), if any.
    pub fn worktree_of(&self, c: &Chat) -> Option<PathBuf> {
        let id = if c.role == Role::Sub { c.parent? } else { c.id };
        self.store.get(&format!("worktree:{id}")).filter(|p| !p.is_empty()).map(PathBuf::from)
    }

    /// Where a chat's agent works: its worktree, else its project (or home).
    pub fn chat_cwd(&self, c: &Chat) -> PathBuf {
        self.worktree_of(c).unwrap_or_else(|| self.cwd_of(c.repo_id))
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
        let repo = self.repo(repo_id)?.path.clone();
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
        self.ws_spawn(ctx, move || add(&repo, &base), move |app, r, ctx| {
            app.ws.busy = None;
            match r {
                Ok(dir) => {
                    let id = app.new_thread(held.repo, &held.text);
                    app.ws_attach(id, Some(dir));
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
        self.drafts.insert(key, if now.trim().is_empty() { held.text } else { format!("{}\n{now}", held.text) });
        self.files.entry(key).or_default().extend(held.files);
        self.mentions.drafts.entry(key).or_default().extend(held.mentions);
    }

    /// Records a new chat's worktree (from `ws_for_new_chat`).
    pub fn ws_attach(&mut self, chat_id: i64, dir: Option<PathBuf>) {
        if let Some(d) = dir {
            self.store.set(&format!("worktree:{chat_id}"), &d.to_string_lossy());
            let name = d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            self.notice(chat_id, "folder", &format!("Works in a new worktree, {name}"), &d.to_string_lossy());
        }
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
        self.ws_spawn(ctx, move || add(&repo, ""), move |app, r, ctx| {
            app.ws.busy = None;
            let r = r.and_then(|dir| match app.ws_moved(chat_id, &info.repo, &dir) {
                Ok(()) => Ok(dir),
                Err(e) => {
                    // It started meanwhile, or a session didn't copy: the new worktree goes again.
                    let (repo, d) = (info.repo.clone(), dir.clone());
                    app.ws_spawn(ctx, move || remove(&repo, &d), |_, _, _| {});
                    Err(e)
                }
            });
            done(app, r, ctx);
        });
    }

    /// The chat (and its sub-agents) moves into the worktree just made, if it still may.
    fn ws_moved(&mut self, chat_id: i64, _repo: &Path, dir: &Path) -> Result<(), String> {
        let ids = self.movable(chat_id)?;
        for id in &ids {
            let Some(c) = self.chat(*id).cloned() else { continue };
            let Some(acc) = self.account(&c.account).cloned() else { continue };
            if acc.kind == crate::providers::Kind::Claude && c.started && !c.session_id.is_empty() {
                if let Err(e) = crate::movechat::ensure_session(&acc.config_dir, &c.session_id, dir) {
                    return Err(format!("couldn't copy {}'s session: {e}", c.name));
                }
            }
            crate::workspace::forget(*id);
        }
        self.store.set(&format!("worktree:{chat_id}"), &dir.to_string_lossy());
        let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.notice(chat_id, "folder", &format!("Moved to a new worktree, {name}"), &dir.to_string_lossy());
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

    /// The slim bar under the composer: where the agent works (left) and its branch (right).
    pub fn workspace_bar(&mut self, ui: &mut Ui) {
        let target = self.ws_target();
        let Some(info) = self.ws_info(target) else { return };
        let ctx = ui.ctx().clone();
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
                (Some(w), _) => (
                    w.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    format!("Runs in its own worktree, {}. It's removed with the thread, unless it has uncommitted changes.", w.display()),
                ),
                (None, true) => ("New worktree".to_string(), "The first message makes a worktree of its own (own folder and branch), so parallel agents don't collide.".to_string()),
                (None, false) => ("Current checkout".to_string(), format!("Runs in the project's checkout, {}", info.repo.display())),
            };
            let icon = if info.worktree.is_some() || info.new_worktree { crate::icons::FOLDER_GIT } else { crate::icons::FOLDER };
            let r = w_small(ui, icon, &label, self.popup == Some(Popup::Workspace), &t).tip(tip);
            if r.clicked() {
                open = Some((Popup::Workspace, r.rect));
            } else if self.popup == Some(Popup::Workspace) {
                self.popup_anchor = r.rect;
            }
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.add_space(6.0);
                if let Some((Side::Branch, what)) = &busy {
                    let r = w_busy(ui, what, &t);
                    if self.popup == Some(Popup::Branch) {
                        self.popup_anchor = r.rect;
                    }
                    return;
                }
                let (label, tip) = match &h {
                    _ if info.new_worktree => {
                        let base = if info.base.is_empty() { h.as_ref().map(|h| h.label()).unwrap_or_default() } else { info.base.clone() };
                        (format!("from {base}"), "The new worktree's branch starts from this one".to_string())
                    }
                    Some(h) if h.dirty > 0 => (h.label(), format!("{} uncommitted change{}", h.dirty, if h.dirty == 1 { "" } else { "s" })),
                    Some(h) => (h.label(), "Switch or create a branch".to_string()),
                    None => ("…".to_string(), "Reading the branch…".to_string()),
                };
                let r = w_small(ui, crate::icons::BRANCH, &label, self.popup == Some(Popup::Branch), &t).tip(tip);
                if r.clicked() {
                    open = Some((Popup::Branch, r.rect));
                } else if self.popup == Some(Popup::Branch) {
                    self.popup_anchor = r.rect;
                }
            });
        });
        if let Some((p, rect)) = open {
            if self.popup == Some(p) {
                self.popup = None;
            } else {
                self.popup = Some(p);
                self.popup_anchor = rect;
                // The click that opened it isn't a click outside it.
                self.picker.just_opened = true;
                self.ws.error = None;
                self.ws.query.clear();
                if p == Popup::Branch {
                    self.ws_load_branches(info.dir.clone(), &ctx);
                }
            }
        }
    }

    /// The workspace menu (Popup::Workspace). True: close it.
    pub fn workspace_menu(&mut self, ctx: &egui::Context) -> bool {
        let t = self.theme.t;
        let target = self.ws_target();
        let Some(info) = self.ws_info(target) else { return true };
        let error = self.ws.error.clone();
        let (pick, close) = crate::widgets::popover(ctx, "workspace", self.popup_anchor, 320.0, true, &t, |ui| {
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
                let Some(info) = self.ws_info(target) else { return Some(Some(ok(json!({ "git": false })))) };
                let new_worktree = matches!(target, Target::Draft(_)) && q("worktree") == Some("1");
                let base = q("base").unwrap_or("").to_string();
                // Work git is doing for the desktop's bar now ("Creating worktree…").
                let pending = self.ws.busy.as_ref().map(|(_, w)| w.clone());
                let tx = reply(call);
                std::thread::spawn(move || {
                    let h = head(&info.dir);
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
            // A new chat in a new worktree: made on a thread, then the chat starts there.
            ("POST", ["v1", "chats"]) if call.body["worktree"].as_bool() == Some(true) && call.body["device"].as_str().unwrap_or("").is_empty() => {
                let repo = match self.api_create_repo(&call.body) {
                    Ok(r) => r,
                    Err(r) => return Some(Some(r)),
                };
                let Some(info) = self.ws_info(Target::Draft(repo)) else { return Some(Some(err(409, "a worktree needs a git project"))) };
                let base = call.body["base"].as_str().unwrap_or("").to_string();
                let call = call.clone();
                let repo_dir = info.repo.clone();
                self.ws_spawn(ctx, move || add(&repo_dir, &base), move |app, r, ctx| {
                    let reply = match r {
                        Err(e) => err(409, e),
                        Ok(dir) => {
                            app.sender = if call.device.is_empty() { "Phone".into() } else { call.device.clone() };
                            app.sender_device = crate::api::device_id(&call.token);
                            let mut r = app.api_create_in(&call.body, ctx, Some(dir.clone()));
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

/// A small, quiet trigger of the bar (icon and text, a hover fill).
fn w_small(ui: &mut Ui, icon: &str, text: &str, open: bool, t: &crate::theme::Tokens) -> egui::Response {
    let label = format!("{icon}  {text}");
    let galley = ui.painter().layout_no_wrap(label, egui::FontId::proportional(12.5), if open { t.fg() } else { t.subtle() });
    let size = galley.size() + egui::vec2(16.0, 8.0);
    let (rect, r) = ui.allocate_exact_size(size, egui::Sense::click());
    let r = r.on_hover_cursor(egui::CursorIcon::PointingHand);
    if r.hovered() || open {
        ui.painter().rect_filled(rect, 6.0, t.gray(200));
    }
    let color = if r.hovered() || open { t.fg() } else { t.subtle() };
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
        let wt = add_in(&root, &d, "main").unwrap();
        let h = head(&wt).unwrap();
        assert!(h.branch.starts_with("harbor/"));
        remove(&d, &wt).unwrap();
        assert!(!wt.exists());
        assert!(!branches(&d).unwrap().local.contains(&h.branch));
        // Uncommitted changes keep it.
        let wt = add_in(&root, &d, "").unwrap();
        std::fs::write(wt.join("new.txt"), "x").unwrap();
        let e = remove(&d, &wt).unwrap_err();
        assert!(e.contains("1 uncommitted change"), "{e}");
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&d);
    }
}
