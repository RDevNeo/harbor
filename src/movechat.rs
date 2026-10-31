//! "Move to project": a chat changes project (or goes to "No project"), its sub-agents
//! with it. Its next turn runs in the new folder.
//!
//! Claude Code resumes only sessions of the folder it runs in: they live under
//! `<config dir>/projects/<folder, every non-alphanumeric as '-'>/<session id>.jsonl`. So
//! the move copies each started Claude session (and its sidecar folder) into the new
//! folder's place for the chat's account; the old copy stays where it was. A sub-agent
//! still running when its lead moves writes its old copy until its turn ends: the next
//! turn brings the newest copy over first ([`ensure_session`]), so nothing it wrote is lost.
//!
//! Not moved: a lead mid-turn (it'd keep running in the old folder), a chat on another
//! device (its session is on that device) and a copy of another PC's chat (it moves there).

use crate::app::App;
use crate::providers::Kind;
use crate::store::Role;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Claude Code's folder name for a working directory: the real path, with every
/// character but ASCII letters and digits turned into '-'.
pub fn project_slug(cwd: &Path) -> String {
    let real = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    real.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Where an account (its config dir; None: ~/.claude) keeps the sessions of `cwd`.
pub fn session_dir(config: &Option<PathBuf>, cwd: &Path) -> PathBuf {
    config.clone().unwrap_or_else(|| crate::store::home().join(".claude")).join("projects").join(project_slug(cwd))
}

fn modified(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Every copy of session `sid` in the account's project folders, newest first.
pub fn session_copies(config: &Option<PathBuf>, sid: &str) -> Vec<PathBuf> {
    let root = config.clone().unwrap_or_else(|| crate::store::home().join(".claude")).join("projects");
    let name = format!("{sid}.jsonl");
    let mut v: Vec<(Option<SystemTime>, PathBuf)> = std::fs::read_dir(root)
        .map(|d| d.flatten().map(|d| d.path().join(&name)).filter(|p| p.is_file()).map(|p| (modified(&p), p)).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|x| x.1).collect()
}

/// Makes session `sid` resumable in `cwd`: its newest copy is put in the folder's place
/// unless that one is already the newest. False if there's no copy at all.
pub fn ensure_session(config: &Option<PathBuf>, sid: &str, cwd: &Path) -> std::io::Result<bool> {
    ensure_session_in(config, &[], sid, cwd)
}

/// [`ensure_session`], also taking the newest copy from the profiles `also` (meshctx.rs: a
/// chat commanded from another PC runs in an overlay profile, and back here afterwards).
pub fn ensure_session_in(config: &Option<PathBuf>, also: &[PathBuf], sid: &str, cwd: &Path) -> std::io::Result<bool> {
    let mut copies: Vec<PathBuf> = session_copies(config, sid);
    for p in also {
        copies.extend(session_copies(&Some(p.clone()), sid));
    }
    copies.sort_by_key(|p| std::cmp::Reverse(modified(p)));
    let Some(src) = copies.into_iter().next() else { return Ok(false) };
    let dir = session_dir(config, cwd);
    let dst = dir.join(format!("{sid}.jsonl"));
    if src == dst || modified(&dst).is_some_and(|d| modified(&src).is_some_and(|s| d >= s)) {
        return Ok(true);
    }
    std::fs::create_dir_all(&dir)?;
    std::fs::copy(&src, &dst)?;
    // Sidecar folder (sub-agent transcripts, tool output overflow), if any.
    let side = src.with_extension("");
    if side.is_dir() {
        let _ = std::process::Command::new("cp").arg("-r").arg(&side).arg(&dir).status();
    }
    Ok(true)
}

impl App {
    /// The chats that move with `chat_id` (it first, then its sub-agents), or why it can't move.
    pub fn movable(&self, chat_id: i64) -> Result<Vec<i64>, String> {
        let c = self.chat(chat_id).ok_or("no such chat")?;
        if c.foreign() {
            return Err(format!("this chat is {}'s: move it there", self.home_name(c)));
        }
        if c.role == Role::Sub {
            return Err("a sub-agent moves with its lead: move the lead".into());
        }
        let mut ids = vec![chat_id];
        ids.extend(self.all_subs_of(chat_id).into_iter().map(|s| s.id));
        if let Some(d) = ids.iter().filter_map(|i| self.chat(*i)).find(|c| !c.device.is_empty()) {
            return Err(format!("{} runs on device {}, which keeps its session there", if d.id == chat_id { "it" } else { "one of its sub-agents" }, d.device));
        }
        if self.is_running(chat_id) {
            return Err("its turn is running: move it once it ends".into());
        }
        if let Some(w) = self.worktree_of(c) {
            return Err(format!("it works in its own worktree, {}", w.display()));
        }
        Ok(ids)
    }

    /// Moves `chat_id` and its sub-agents to project `repo` (None: "No project").
    pub fn move_chat(&mut self, chat_id: i64, repo: Option<i64>) -> Result<(), String> {
        let ids = self.movable(chat_id)?;
        let from = self.chat(chat_id).and_then(|c| c.repo_id);
        if from == repo {
            return Ok(());
        }
        if let Some(r) = repo {
            let r = self.repo(r).ok_or("no such project")?;
            if !r.dir().is_dir() {
                return Err(format!("{} isn't on this PC", r.path.display()));
            }
        }
        let cwd = self.cwd_of(repo);
        // Sessions first: nothing changes unless all of them made it.
        for id in &ids {
            let Some(c) = self.chat(*id) else { continue };
            let Some(acc) = self.account(&c.account) else { continue };
            if acc.kind != Kind::Claude || !c.started || c.session_id.is_empty() {
                continue;
            }
            ensure_session(&acc.config_dir, &c.session_id, &cwd).map_err(|e| format!("couldn't copy {}'s session: {e}", c.name))?;
        }
        let name = |a: &App, r: Option<i64>| r.and_then(|r| a.repo(r)).map(|r| r.name.clone()).unwrap_or_else(|| "No project".into());
        let text = format!("Moved from {} to {}", name(self, from), name(self, repo));
        for id in &ids {
            if let Some(c) = self.chat_mut(*id) {
                c.repo_id = repo;
            }
            crate::workspace::forget(*id);
            self.persist(*id);
        }
        self.notice(chat_id, "folder", &text, "");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("harbor-move-{tag}-{}", crate::bridge::token().unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn folders_map_like_claude_code() {
        assert_eq!(project_slug(Path::new("/nonexistent/igor/Projects/harbor")), "-nonexistent-igor-Projects-harbor");
        assert_eq!(project_slug(Path::new("/nonexistent/a.b/my work_1")), "-nonexistent-a-b-my-work-1");
        let cfg = Some(PathBuf::from("/x/.claude2"));
        assert_eq!(session_dir(&cfg, Path::new("/nonexistent/p")), PathBuf::from("/x/.claude2/projects/-nonexistent-p"));
        // A symlinked folder is its real path, as `pwd -P`.
        let root = tmp("link");
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, root.join("ln")).unwrap();
        assert_eq!(project_slug(&root.join("ln")), project_slug(&real));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sessions_follow_the_chat_and_stay_behind() {
        let root = tmp("sess");
        let cfg = Some(root.join("cfg"));
        let (home, work) = (root.join("home"), root.join("my work"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        assert!(!ensure_session(&cfg, "abc", &work).unwrap(), "no session yet");
        let old = session_dir(&cfg, &home);
        std::fs::create_dir_all(old.join("abc/subagents")).unwrap();
        std::fs::write(old.join("abc.jsonl"), "one\n").unwrap();
        std::fs::write(old.join("abc/subagents/x.jsonl"), "s\n").unwrap();
        assert!(ensure_session(&cfg, "abc", &work).unwrap());
        let new = session_dir(&cfg, &work);
        assert_eq!(std::fs::read_to_string(new.join("abc.jsonl")).unwrap(), "one\n");
        assert!(new.join("abc/subagents/x.jsonl").is_file());
        assert!(old.join("abc.jsonl").is_file(), "the old copy stays");
        // The old copy written later (a turn still running there) comes over on the next one.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(old.join("abc.jsonl"), "one\ntwo\n").unwrap();
        assert_eq!(session_copies(&cfg, "abc")[0], old.join("abc.jsonl"));
        ensure_session(&cfg, "abc", &work).unwrap();
        assert_eq!(std::fs::read_to_string(new.join("abc.jsonl")).unwrap(), "one\ntwo\n");
        // Once the new one is the newest it's left alone.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(new.join("abc.jsonl"), "one\ntwo\nthree\n").unwrap();
        ensure_session(&cfg, "abc", &work).unwrap();
        assert_eq!(std::fs::read_to_string(new.join("abc.jsonl")).unwrap(), "one\ntwo\nthree\n");
        assert_eq!(std::fs::read_to_string(old.join("abc.jsonl")).unwrap(), "one\ntwo\n");
        let _ = std::fs::remove_dir_all(&root);
    }
}
