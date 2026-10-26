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

use crate::app::{App, Popup, View};
use crate::store::{self, Chat, Role};
use eframe::egui::{self, Align, Layout, ScrollArea, Ui};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
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

#[derive(Default)]
pub struct State {
    pub draft: DraftWs,
    /// Folder → (when read, its head); read on a thread.
    heads: Arc<Mutex<HashMap<PathBuf, (Instant, Option<Head>)>>>,
    /// The open branch picker: its folder, branches and filter.
    pub menu: Option<(PathBuf, Result<Branches, String>)>,
    pub query: String,
    /// The last git error, shown in the menus until the next action.
    pub error: Option<String>,
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

    /// Reads a folder again at once (after a switch).
    fn ws_refresh(&self, dir: &Path) {
        let h = head(dir);
        self.ws.heads.lock().unwrap().insert(dir.to_path_buf(), (Instant::now(), h));
    }

    /// Makes the worktree for a new chat about to start in `repo`, if the bar says so.
    pub fn ws_for_new_chat(&mut self, repo: Option<i64>, device: &str) -> Result<Option<PathBuf>, String> {
        if !self.ws.draft.worktree || !device.is_empty() {
            return Ok(None);
        }
        let Some(info) = self.ws_info(Target::Draft(repo)) else { return Ok(None) };
        add(&info.repo, &info.base).map(Some)
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
    pub fn ws_move_to_worktree(&mut self, chat_id: i64) -> Result<PathBuf, String> {
        let info = self.ws_info(Target::Chat(chat_id)).ok_or("this chat isn't in a git project on this PC")?;
        info.can_move.clone()?;
        let ids = self.movable(chat_id)?;
        let dir = add(&info.repo, "")?;
        for id in &ids {
            let Some(c) = self.chat(*id).cloned() else { continue };
            let Some(acc) = self.account(&c.account).cloned() else { continue };
            if acc.kind == crate::providers::Kind::Claude && c.started && !c.session_id.is_empty() {
                if let Err(e) = crate::movechat::ensure_session(&acc.config_dir, &c.session_id, &dir) {
                    let _ = remove(&info.repo, &dir);
                    return Err(format!("couldn't copy {}'s session: {e}", c.name));
                }
            }
            crate::workspace::forget(*id);
        }
        self.store.set(&format!("worktree:{chat_id}"), &dir.to_string_lossy());
        let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.notice(chat_id, "folder", &format!("Moved to a new worktree, {name}"), &dir.to_string_lossy());
        Ok(dir)
    }

    /// Before a chat is deleted: its worktree goes too, unless it has uncommitted changes
    /// (then it stays, and the returned text says where).
    pub fn ws_drop(&mut self, chat_id: i64) -> Option<String> {
        let c = self.chat(chat_id)?.clone();
        let key = format!("worktree:{chat_id}");
        let dir = self.store.get(&key).filter(|p| !p.is_empty()).map(PathBuf::from);
        self.store.set(&key, "");
        let dir = dir?;
        let repo = self.cwd_of(c.repo_id);
        match remove(&repo, &dir) {
            Ok(()) => None,
            Err(e) => Some(format!("Kept the chat's worktree: {e}. Commit or discard them, then remove it with `git worktree remove {}`.", dir.display())),
        }
    }

    /// The branch picker's pick: switch (or, for a new chat headed for a worktree, its base).
    fn ws_pick_branch(&mut self, target: Target, row: &Row) -> Result<(), String> {
        let info = self.ws_info(target).ok_or("no git project here")?;
        if info.new_worktree {
            self.ws.draft.base = row.name.clone();
            return Ok(());
        }
        if let Some(why) = info.branch_lock {
            return Err(why);
        }
        let r = switch(&info.dir, &row.name, row.remote);
        self.ws_refresh(&info.dir);
        r
    }

    fn ws_create_branch(&mut self, target: Target, name: &str) -> Result<(), String> {
        let info = self.ws_info(target).ok_or("no git project here")?;
        if let Some(why) = info.branch_lock {
            return Err(why);
        }
        let r = create(&info.dir, name);
        self.ws_refresh(&info.dir);
        r
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
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 2.0;
            ui.add_space(6.0);
            let (label, tip) = match (&info.worktree, info.new_worktree) {
                (Some(w), _) => (
                    w.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    format!("Runs in its own worktree, {}. It's removed with the thread, unless it has uncommitted changes.", w.display()),
                ),
                (None, true) => ("New worktree".to_string(), "The first message makes a worktree of its own (own folder and branch), so parallel agents don't collide.".to_string()),
                (None, false) => ("Current checkout".to_string(), format!("Runs in the project's checkout, {}", info.repo.display())),
            };
            let icon = if info.worktree.is_some() || info.new_worktree { crate::icons::FOLDER_GIT } else { crate::icons::FOLDER };
            let r = w_small(ui, icon, &label, self.popup == Some(Popup::Workspace), &t).on_hover_text(tip);
            if r.clicked() {
                open = Some((Popup::Workspace, r.rect));
            } else if self.popup == Some(Popup::Workspace) {
                self.popup_anchor = r.rect;
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.add_space(6.0);
                let (label, tip) = match &h {
                    _ if info.new_worktree => {
                        let base = if info.base.is_empty() { h.as_ref().map(|h| h.label()).unwrap_or_default() } else { info.base.clone() };
                        (format!("from {base}"), "The new worktree's branch starts from this one".to_string())
                    }
                    Some(h) if h.dirty > 0 => (h.label(), format!("{} uncommitted change{}", h.dirty, if h.dirty == 1 { "" } else { "s" })),
                    Some(h) => (h.label(), "Switch or create a branch".to_string()),
                    None => ("…".to_string(), "Reading the branch…".to_string()),
                };
                let r = w_small(ui, crate::icons::BRANCH, &label, self.popup == Some(Popup::Branch), &t).on_hover_text(tip);
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
                    self.ws.menu = Some((info.dir.clone(), branches(&info.dir)));
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
            crate::widgets::subtle(ui, "  Workspace", "label-12");
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
                        .on_hover_text("A thread stays in its worktree. It's removed with the thread, unless it has uncommitted changes.");
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
            (Some(_), Target::Chat(id)) => match self.ws_move_to_worktree(id) {
                Ok(_) => return true,
                Err(e) => self.ws.error = Some(e),
            },
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
            _ => branches(&info.dir),
        };
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
            match &list {
                Err(e) => {
                    crate::widgets::subtle(ui, format!("  {e}"), "label-12");
                }
                Ok(b) => {
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
                        ui.add_space(4.0);
                        crate::widgets::separator(ui);
                        ui.add_space(4.0);
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
        let done = match pick {
            Some(Ok(row)) => Some(self.ws_pick_branch(target, &row)),
            Some(Err(name)) => Some(self.ws_create_branch(target, &name)),
            None => None,
        };
        match done {
            Some(Ok(())) => {
                self.ws.menu = None;
                true
            }
            Some(Err(e)) => {
                self.ws.error = Some(e);
                self.ws.menu = Some((info.dir.clone(), branches(&info.dir)));
                false
            }
            None => close,
        }
    }

    // -------------------------------------------------------------- phones (api.rs)

    fn api_target(&self, chat: Option<&str>, project: Option<&str>) -> Result<Target, (u16, String)> {
        match chat.filter(|c| !c.is_empty()) {
            Some(c) => self.ref_id(c).filter(|c| self.chat(*c).is_some()).map(Target::Chat).ok_or((404, "no such chat".into())),
            None => Ok(Target::Draft(self.project_ref(project.unwrap_or("")))),
        }
    }

    /// `GET /v1/workspace?chat=<id>` or `?project=<id>&worktree=0|1&base=<branch>`: the bar.
    pub fn api_workspace(&mut self, chat: Option<&str>, project: Option<&str>, worktree: bool, base: &str) -> Result<Value, (u16, String)> {
        let target = self.api_target(chat, project)?;
        let Some(info) = self.ws_info(target) else { return Ok(json!({ "git": false })) };
        let h = head(&info.dir);
        let new_worktree = matches!(target, Target::Draft(_)) && worktree;
        let name = info.worktree.as_ref().and_then(|w| w.file_name()).map(|n| n.to_string_lossy().into_owned());
        Ok(json!({
            "git": true,
            "mode": if info.worktree.is_some() || new_worktree { "worktree" } else { "checkout" },
            "name": name,
            "path": info.worktree.as_ref().unwrap_or(&info.repo).to_string_lossy(),
            "branch": h.as_ref().map(|h| h.label()).unwrap_or_default(),
            "dirty": h.as_ref().map_or(0, |h| h.dirty),
            "base": if new_worktree { if base.is_empty() { h.as_ref().map(|h| h.branch.clone()).unwrap_or_default() } else { base.to_string() } } else { String::new() },
            "can_move": info.can_move.is_ok(),
            "move_why": info.can_move.err(),
            "branch_lock": if new_worktree { None } else { info.branch_lock },
        }))
    }

    /// `GET /v1/branches?chat=|project=&q=`: ranked here, as the desktop's picker.
    pub fn api_branches(&mut self, chat: Option<&str>, project: Option<&str>, q: &str) -> Result<Value, (u16, String)> {
        let target = self.api_target(chat, project)?;
        let info = self.ws_info(target).ok_or((409, "not a git project".to_string()))?;
        let b = branches(&info.dir).map_err(|e| (409, e))?;
        let h = head(&info.dir).unwrap_or_default();
        let rows = rank(&b, q, 100);
        let q = q.trim();
        let warning = (h.dirty > 0).then(|| format!("{} uncommitted change{} here: they come along to the branch you switch to, and git refuses if they'd be overwritten.", h.dirty, if h.dirty == 1 { "" } else { "s" }));
        Ok(json!({
            "current": h.branch,
            "dirty": h.dirty,
            "warning": warning,
            "checkout_note": info.worktree.is_none().then_some("Switches the project's checkout (other threads there see it too)"),
            "branches": rows.iter().map(|r| json!({ "name": r.name, "remote": r.remote, "current": !r.remote && r.name == h.branch })).collect::<Vec<_>>(),
            "can_create": !q.is_empty() && !b.local.iter().any(|l| l == q) && valid_branch(&info.dir, q),
            "branch_lock": info.branch_lock,
        }))
    }

    /// `POST /v1/branches` `{chat|project, "switch": name, "remote": bool}` or `{…, "create": name}`.
    pub fn api_branch_post(&mut self, body: &Value) -> Result<Value, (u16, String)> {
        // Ids come as numbers or strings (gids, project paths).
        let s = |v: &Value| v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string()));
        let (chat, project) = (s(&body["chat"]), s(&body["project"]));
        let target = self.api_target(chat.as_deref(), project.as_deref())?;
        let r = if let Some(name) = body["switch"].as_str() {
            let row = Row { name: name.to_string(), remote: body["remote"].as_bool().unwrap_or(false) };
            let info = self.ws_info(target).ok_or((409, "not a git project".to_string()))?;
            if let Some(why) = info.branch_lock {
                return Err((409, why));
            }
            let r = switch(&info.dir, &row.name, row.remote);
            self.ws_refresh(&info.dir);
            r
        } else if let Some(name) = body["create"].as_str() {
            self.ws_create_branch(target, name)
        } else {
            return Err((400, "switch or create a branch".into()));
        };
        r.map_err(|e| (409, e))?;
        let info = self.ws_info(target).ok_or((409, "not a git project".to_string()))?;
        Ok(json!({ "ok": true, "branch": head(&info.dir).map(|h| h.label()).unwrap_or_default() }))
    }
}

/// A wrapped line of the menus (a warning, a note, git's error).
fn note(ui: &mut Ui, text: &str, color: egui::Color32) {
    egui::Frame::new().inner_margin(egui::Margin { left: 8, right: 8, top: 2, bottom: 6 }).show(ui, |ui| {
        ui.add(egui::Label::new(egui::RichText::new(text).color(color).size(12.0)).wrap());
    });
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
