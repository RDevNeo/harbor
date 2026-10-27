//! A project another PC shares, brought to this PC. Other PCs know a shared project by the
//! owner's folder (`Repo::path`), which never exists here (each PC has its own home). The
//! owner shares its git remote too, and that is the project's name across the mesh: when a
//! chat's turn would start here without the folder, this PC uses its own clone of the same
//! remote (a project of its own, or a folder found where the owner keeps it, relative to
//! home), else clones it with its own git/gh login. Its folder is kept per PC
//! (`Repo::local`): the owner's path stays what the mesh calls the project.
//!
//! The clone runs on a thread; the turns that wait for it start once it's there. When it
//! can't be had, the folder line under the transcript (desktop and phone, `status.folder`)
//! offers Clone here (a folder the user picks) and Run on <owner>.

use crate::app::{App, Bg};
use crate::store::{Chat, Item};
use eframe::egui;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// `mesh::Msg::Done`'s `what` for Run on <owner>: from this window (the new chat opens), or
/// from a phone (it opens it itself).
pub const RUN_THERE: &str = "run the chat there";
pub const RAN_THERE: &str = "run the chat there from a phone";

/// How long a clone may take before it's given up.
const CLONE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
pub struct State {
    /// Projects being cloned now.
    running: HashMap<i64, PathBuf>,
    /// Per project, the turns waiting for its folder: (chat, prompt, files).
    held: HashMap<i64, Vec<(i64, String, Vec<PathBuf>)>>,
    /// Per project, why the last clone failed.
    failed: HashMap<i64, String>,
}

/// A remote's identity, whatever its form: `git@github.com:A/b.git`, `https://github.com/a/b`
/// and `ssh://git@github.com/a/b/` all become `github.com/a/b`. Empty for no remote.
pub fn normalize(remote: &str) -> String {
    let r = remote.trim();
    if r.is_empty() {
        return String::new();
    }
    let web = crate::git::web_url(r);
    let rest = web.split_once("://").map_or(web.as_str(), |x| x.1);
    // Credentials in an https URL (user:token@host).
    let rest = match rest.split_once('/') {
        Some((host, path)) => format!("{}/{path}", host.rsplit('@').next().unwrap_or(host)),
        None => rest.to_string(),
    };
    rest.trim_end_matches('/').trim_end_matches(".git").to_lowercase()
}

/// Whether two remotes name the same repository.
pub fn same(a: &str, b: &str) -> bool {
    let a = normalize(a);
    !a.is_empty() && a == normalize(b)
}

/// Where this PC keeps a project the owner has at `owner`: the same place relative to home
/// (`/home/<owner>/Documents/x/proj` → `<home>/Documents/x/proj`). A folder outside the
/// owner's home goes straight under this home.
pub fn home_relative(owner: &Path, home: &Path, name: &str) -> PathBuf {
    let parts: Vec<_> = owner.components().collect();
    let s = |i: usize| parts.get(i).map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();
    // "/", "home" | "Users", "<user>", rest… ; "/", "root", rest…
    let skip = match (s(1).as_str(), parts.len()) {
        ("home" | "Users", n) if n > 3 => Some(3),
        ("root", n) if n > 2 => Some(2),
        _ => None,
    };
    match skip {
        Some(k) => parts[k..].iter().fold(home.to_path_buf(), |p, c| p.join(c)),
        None => {
            let last = owner.file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| name.to_string());
            home.join(last)
        }
    }
}

/// This PC's folder for `remote` among its projects' folders and remotes, if one is here.
pub fn find_clone<'a>(dirs: impl IntoIterator<Item = (&'a Path, &'a str)>, remote: &str) -> Option<PathBuf> {
    dirs.into_iter().find(|(d, r)| same(r, remote) && d.is_dir()).map(|(d, _)| d.to_path_buf())
}

/// Where to clone into, given what's on disk: `Ok(dir)` a clone of the same repository already
/// there (use it), `Err(dir)` a free path to clone into (`want`, else `want-2`, `want-3`…).
/// `origin(dir)` reads a folder's remote.
pub fn place(want: &Path, remote: &str, origin: &dyn Fn(&Path) -> Option<String>) -> Result<PathBuf, PathBuf> {
    let mut n = 1;
    loop {
        let p = if n == 1 { want.to_path_buf() } else { PathBuf::from(format!("{}-{n}", want.display())) };
        if !p.exists() || is_empty_dir(&p) {
            return Err(p);
        }
        if origin(&p).is_some_and(|o| same(&o, remote)) {
            return Ok(p);
        }
        n += 1;
    }
}

fn is_empty_dir(p: &Path) -> bool {
    std::fs::read_dir(p).is_ok_and(|mut d| d.next().is_none())
}

/// Whether a remote another PC sent is one to clone: a network URL (https, http, ssh, git) or
/// scp-like `user@host:path`. Never an option (`--upload-pack=…`), a helper (`ext::…`) or a
/// local path.
pub fn cloneable(remote: &str) -> bool {
    let r = remote.trim();
    if r.is_empty() || r.starts_with('-') || r.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    if let Some((scheme, rest)) = r.split_once("://") {
        return matches!(scheme, "https" | "http" | "ssh" | "git") && !rest.is_empty() && !rest.starts_with('-');
    }
    // scp-like: [user@]host:path, the host neither empty nor an option, no "::" helper.
    match r.split_once(':') {
        Some((host, path)) => !host.is_empty() && !host.contains('/') && !path.is_empty() && !path.starts_with(':'),
        None => false,
    }
}

/// Clones `remote` into `dest`: with `gh` when it's a GitHub repository and gh is signed in
/// (its login and protocol), else with git (its own credentials; never a prompt).
pub fn run(remote: &str, dest: &Path) -> Result<(), String> {
    if !cloneable(remote) {
        return Err(format!("{remote:?} isn't a git remote to clone from"));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("can't create {}: {e}", parent.display()))?;
    }
    let gh = crate::prs::github_repo(remote).filter(|_| gh_signed_in());
    let mut cmd = match &gh {
        Some(slug) => {
            let mut c = Command::new("gh");
            c.args(["repo", "clone", slug]).arg(dest).args(["--", "-q"]);
            c
        }
        None => {
            let mut c = Command::new("git");
            c.args(["clone", "-q", "--", remote]).arg(dest);
            c
        }
    };
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    match crate::git::output_within(&mut cmd, CLONE_TIMEOUT) {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let e = String::from_utf8_lossy(&o.stderr);
            Err(e.trim().lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("the clone failed").to_string())
        }
        Err(e) => Err(format!("{}: {e}", if gh.is_some() { "gh" } else { "git" })),
    }
}

fn gh_signed_in() -> bool {
    let mut c = Command::new("gh");
    c.args(["auth", "status", "--hostname", "github.com"]);
    crate::git::output_within(&mut c, Duration::from_secs(10)).is_ok_and(|o| o.status.success())
}

/// The thread's work: a clone of `remote` at `want` (or beside it), or the one already there.
fn fetch(remote: &str, want: &Path) -> Result<PathBuf, String> {
    match place(want, remote, &|p| crate::git::origin(p)) {
        Ok(found) => Ok(found),
        Err(dest) => run(remote, &dest).map(|_| dest),
    }
}

/// "Clone here" into a folder the user picked: the project itself when it's a clone of the
/// remote (or, with no remote known, a folder with files), else a clone in it (in a new
/// folder named after the project when it holds other files).
fn fetch_into(remote: &str, picked: &Path, name: &str) -> Result<PathBuf, String> {
    if remote.is_empty() {
        return if picked.is_dir() && !is_empty_dir(picked) {
            Ok(picked.to_path_buf())
        } else {
            Err("this project's git remote isn't known here: pick the folder that holds it".into())
        };
    }
    if crate::git::origin(picked).is_some_and(|o| same(&o, remote)) {
        return Ok(picked.to_path_buf());
    }
    if !picked.exists() || is_empty_dir(picked) {
        return run(remote, picked).map(|_| picked.to_path_buf());
    }
    fetch(remote, &picked.join(name))
}

/// The folder line's facts (`status.folder` for the phone).
pub struct Line {
    pub text: String,
    pub cloning: bool,
    /// The PC that has the project: (peer id, its name).
    pub owner: Option<(String, String)>,
    /// Where Clone here starts (the phone's suggested path).
    pub suggested: PathBuf,
}

impl App {
    /// A chat's turn is about to start without its project's folder: when another project here
    /// has the same remote, its folder becomes this one's (and the turn goes on: false); else,
    /// with a remote known, the turn waits for a clone (true). False also when nothing can be
    /// done (no remote, a lost worktree): the caller says why.
    pub fn clone_for_turn(&mut self, chat: &Chat, prompt: &str, files: &[PathBuf]) -> bool {
        if self.worktree_of(chat).is_some_and(|w| !w.is_dir()) {
            return false;
        }
        let Some(r) = chat.repo_id.and_then(|id| self.repo(id)).cloned() else { return false };
        if r.dir().is_dir() || r.remote.is_empty() {
            return false;
        }
        let found = find_clone(self.repos.iter().filter(|o| o.id != r.id).map(|o| (o.dir(), o.remote.as_str())), &r.remote);
        if let Some(dir) = found {
            self.set_local(r.id, &dir);
            return false;
        }
        self.clones.held.entry(r.id).or_default().push((chat.id, prompt.to_string(), files.to_vec()));
        if self.clones.running.contains_key(&r.id) {
            return true;
        }
        let want = home_relative(&r.path, &crate::store::home(), &r.name);
        self.clones.failed.remove(&r.id);
        self.clone_start(r.id, chat.id, want.clone(), move |remote| fetch(remote, &want));
        true
    }

    /// The folder line's Clone here: into `picked` (the desktop's folder picker, the phone's
    /// path). Any turn held for the project starts once it's there.
    pub fn clone_here(&mut self, chat: i64, picked: PathBuf) -> Result<(), String> {
        let c = self.chat(chat).filter(|c| !c.foreign()).ok_or("no such chat here")?;
        let r = c.repo_id.and_then(|id| self.repo(id)).cloned().ok_or("this chat has no project")?;
        if r.dir().is_dir() {
            return Err(format!("{} is already on this PC", r.name));
        }
        if self.clones.running.contains_key(&r.id) {
            return Err(format!("{} is being cloned already", r.name));
        }
        if !picked.is_absolute() {
            return Err("give a full path".into());
        }
        self.clones.failed.remove(&r.id);
        let name = r.name.clone();
        self.clone_start(r.id, chat, picked.clone(), move |remote| fetch_into(remote, &picked, &name));
        Ok(())
    }

    fn clone_start(&mut self, repo: i64, chat: i64, at: PathBuf, work: impl FnOnce(&str) -> Result<PathBuf, String> + Send + 'static) {
        let Some(r) = self.repo(repo).cloned() else { return };
        let what = if r.remote.is_empty() { r.name.clone() } else { r.remote.clone() };
        self.notice(chat, "folder", &format!("Cloning {}…", r.name), &format!("{what} into {}", crate::app::tilde(&at)));
        self.clones.running.insert(repo, at);
        self.api_touch(chat);
        let (tx, ctx) = (self.bg_tx.clone(), self.ctx.clone());
        let remote = r.remote.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Bg::ProjectCloned(repo, work(&remote)));
            ctx.request_repaint();
        });
    }

    /// A clone's thread is done: the folder is the project's here and its held turns start, or
    /// they fail with the reason (and the folder line offers what else can be done).
    pub fn project_cloned(&mut self, repo: i64, r: Result<PathBuf, String>, ctx: &egui::Context) {
        self.clones.running.remove(&repo);
        let held = self.clones.held.remove(&repo).unwrap_or_default();
        let name = self.repo(repo).map(|r| r.name.clone()).unwrap_or_default();
        match r {
            Ok(dir) => {
                // Someone else's files until trusted, like any clone (addproject.rs).
                if self.repos.iter().all(|o| o.dir() != dir) {
                    self.store.set(&crate::addproject::untrusted_key(&dir), "1");
                }
                self.set_local(repo, &dir);
                let mut said = std::collections::HashSet::new();
                for (chat, prompt, files) in held {
                    if said.insert(chat) {
                        self.notice(chat, "folder", &format!("{name} is at {}", crate::app::tilde(&dir)), "");
                    }
                    if self.turns.contains_key(&chat) {
                        self.pending.entry(chat).or_default().push(prompt);
                    } else {
                        self.start_turn(chat, prompt, files, ctx);
                    }
                }
            }
            Err(e) => {
                self.clones.failed.insert(repo, e.clone());
                let chats: Vec<i64> = held.iter().map(|h| h.0).collect();
                // Kept for Clone here / Run on: they still want to run.
                self.clones.held.insert(repo, held);
                let mut said = std::collections::HashSet::new();
                for chat in chats {
                    if !said.insert(chat) {
                        continue;
                    }
                    let why = self.chat(chat).cloned().and_then(|c| self.missing_folder(&c)).unwrap_or_default();
                    if let Some(t) = self.transcripts.get_mut(&chat) {
                        t.items.push(Item::Error { text: format!("{why}\nCloning it here failed: {e}") });
                    }
                    self.persist(chat);
                }
            }
        }
        self.api.hub.touch(None, true);
    }

    /// Makes `dir` this PC's folder for a project (its own path when they're the same).
    fn set_local(&mut self, repo: i64, dir: &Path) {
        let Some(r) = self.repo(repo) else { return };
        let local = (r.path != dir).then_some(dir);
        self.store.set_repo_local(repo, local);
        self.repos = self.store.repos();
        self.refresh_git(repo);
        self.share_publish();
    }

    /// The folder line under a chat whose project isn't on this PC (None: nothing to say).
    pub fn folder_line(&self, chat: i64) -> Option<Line> {
        let c = self.chat(chat).filter(|c| !c.foreign() && c.device.is_empty())?;
        let r = self.repo(c.repo_id?)?;
        if r.dir().is_dir() || self.worktree_of(c).is_some_and(|w| !w.is_dir()) {
            return None;
        }
        let cloning = self.clones.running.get(&r.id);
        let owner = self.project_owner(r.id);
        let text = match (cloning, self.clones.failed.get(&r.id)) {
            (Some(at), _) => format!("Cloning {} into {}…", r.name, crate::app::tilde(at)),
            (None, Some(e)) => format!("{} isn't on this PC and couldn't be cloned: {e}", r.name),
            (None, None) => match &owner {
                Some((_, o)) => format!("{} isn't on this PC: it's on {o}.", r.name),
                None => format!("{}'s folder ({}) isn't on this PC.", r.name, crate::app::tilde(&r.path)),
            },
        };
        Some(Line { text, cloning: cloning.is_some(), owner, suggested: home_relative(&r.path, &crate::store::home(), &r.name) })
    }

    /// The PC a project of this list belongs to: the home of its chats from other PCs.
    pub fn project_owner(&self, repo: i64) -> Option<(String, String)> {
        let c = self.chats.iter().find(|c| c.repo_id == Some(repo) && c.foreign())?;
        Some((c.home.clone(), self.home_name(c)))
    }

    /// `status.folder` for the phone (PROTOCOL.md).
    pub fn folder_json(&self, chat: i64) -> Value {
        match self.folder_line(chat) {
            Some(l) => json!({
                "text": l.text, "cloning": l.cloning,
                "owner": l.owner.map(|(id, name)| json!({ "id": id, "name": name })),
                "suggested": l.suggested.to_string_lossy(),
            }),
            None => Value::Null,
        }
    }

    /// Desktop: the folder line, after the limit line.
    pub fn folder_ui(&mut self, ui: &mut egui::Ui, chat: i64) {
        use crate::icons as ic;
        use crate::widgets as w;
        let Some(line) = self.folder_line(chat) else { return };
        let t = self.theme.t;
        let mut act = 0;
        ui.horizontal_wrapped(|ui| {
            if line.cloning {
                let (r, _) = ui.allocate_exact_size(egui::Vec2::splat(16.0), egui::Sense::hover());
                w::spinner(ui.painter(), r.center(), 6.5, ui.visuals().strong_text_color());
            } else {
                ui.label(egui::RichText::new(ic::FOLDER).size(14.0).color(t.amber(900)));
            }
            w::subtle(ui, &line.text, "label-13");
            if !line.cloning {
                if w::btn("Clone here").primary().xs().show(ui).clicked() {
                    act = 1;
                }
                if let Some((_, o)) = &line.owner {
                    if w::btn(&format!("Run on {o}")).xs().show(ui).clicked() {
                        act = 2;
                    }
                }
            }
        });
        match act {
            1 => {
                let (tx, ctx) = (self.bg_tx.clone(), ui.ctx().clone());
                let start = line.suggested.parent().map(Path::to_path_buf).filter(|p| p.is_dir()).unwrap_or_else(crate::store::home);
                std::thread::spawn(move || {
                    let picked = crate::picker::pick(crate::picker::Opts { title: "Clone the project into…", dir: Some(&start), directory: true, ..Default::default() });
                    if let Some(p) = picked.into_iter().next() {
                        let _ = tx.send(Bg::ClonePicked(chat, p));
                        ctx.request_repaint();
                    }
                });
            }
            2 => {
                if let Err(e) = self.run_on_owner(chat, None) {
                    crate::picker::show_toast(ui.ctx(), e);
                }
            }
            _ => {}
        }
    }

    /// Run on <owner>: the chat's waiting message (else its last one) starts a chat in the
    /// project on the PC that has it, which opens once it's copied here. This chat goes if it
    /// never ran. `reply`: a phone's call, answered with the new chat's id.
    pub fn run_on_owner(&mut self, chat: i64, reply: Option<(std::sync::mpsc::Sender<crate::api::Reply>, bool)>) -> Result<(), String> {
        let c = self.chat(chat).filter(|c| !c.foreign()).cloned().ok_or("no such chat here")?;
        let r = c.repo_id.and_then(|id| self.repo(id)).cloned().ok_or("this chat has no project")?;
        let (owner, name) = self.project_owner(r.id).ok_or("no other PC shares this project")?;
        let peer = self.shared().peer(&owner).filter(|p| p.online).ok_or_else(|| format!("{name} is off: try again once it's back"))?;
        let held = self.clones.held.get_mut(&r.id).and_then(|h| h.iter().position(|x| x.0 == chat).map(|i| h.remove(i)));
        let (text, files) = match held {
            Some((_, p, f)) => (p, f),
            None => {
                let items = self.transcripts.get(&chat).map(|t| t.items.clone()).unwrap_or_else(|| self.store.items(chat));
                items
                    .iter()
                    .rev()
                    .find_map(|i| match i {
                        Item::User { text, files, .. } => Some((text.clone(), files.iter().map(PathBuf::from).filter(|f| f.is_file()).collect())),
                        _ => None,
                    })
                    .ok_or("this chat has no message to send")?
            }
        };
        let body = json!({
            "project": { "name": r.name, "path": r.path.to_string_lossy(), "remote": r.remote },
            "account": c.account, "model": c.model, "effort": c.effort, "access": c.access, "device": "", "text": text,
        });
        let restore = Some(text);
        let ctx = self.ctx_for(Some(r.id));
        let me = (self.shared().me().name, crate::api::local_device());
        let tx = self.inc_tx.clone();
        let (hub, home) = (self.api.hub.clone(), peer.id.clone());
        crate::mesh::forward(peer.dest(), peer.name, "POST", vec!["v1".into(), "chats".into()], body, files, me, ctx, move |r| match reply {
            // The phone opens the new chat itself.
            Some((reply, global)) => {
                let _ = tx.send(crate::control::Incoming::Mesh(crate::mesh::Msg::Done { chat, what: RAN_THERE, reply: r.clone(), restore: None }));
                let _ = reply.send(crate::mesh::map_new(&hub, &home, r, global));
            }
            // Here: it opens once copied; a failure says why under the composer.
            None => {
                let _ = tx.send(crate::control::Incoming::Mesh(crate::mesh::Msg::Done { chat, what: RUN_THERE, reply: r, restore }));
            }
        });
        Ok(())
    }

    /// Run on <owner> answered (`mesh::Msg::Done`): the chat started there; this one goes if
    /// it never ran (its message went there).
    pub fn ran_on_owner(&mut self, chat: i64) {
        if self.chat(chat).is_some_and(|c| !c.started && !c.foreign()) && !self.turns.contains_key(&chat) {
            self.drop_unstarted(chat);
        }
    }

    /// A chat that never ran, gone.
    fn drop_unstarted(&mut self, chat: i64) {
        for h in self.clones.held.values_mut() {
            h.retain(|x| x.0 != chat);
        }
        self.store.delete_chat(chat);
        self.chats.retain(|x| x.id != chat);
        self.transcripts.remove(&chat);
        self.pending.remove(&chat);
        if self.view == crate::app::View::Chat(chat) {
            self.view = crate::app::View::Draft;
        }
        self.mesh_index();
        self.api.hub.touch(None, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_normalize() {
        let all = [
            "git@github.com:Owner/Proj.git",
            "https://github.com/owner/proj",
            "https://github.com/owner/proj.git",
            "https://github.com/owner/proj/",
            "ssh://git@github.com/owner/proj.git",
            "ssh://git@github.com:22/owner/proj",
            "https://user:token@github.com/owner/proj.git",
            "  http://github.com/owner/proj  ",
        ];
        for a in all {
            assert_eq!(normalize(a), "github.com/owner/proj", "{a}");
        }
        assert_eq!(normalize("git@gitlab.example.com:group/sub/proj.git"), "gitlab.example.com/group/sub/proj");
        assert_eq!(normalize(""), "");
        assert!(same("git@github.com:a/b.git", "https://github.com/A/B"));
        assert!(!same("git@github.com:a/b.git", "git@github.com:a/c.git"));
        assert!(!same("", ""), "no remote is no match");
    }

    #[test]
    fn only_network_remotes_are_cloned() {
        for ok in ["https://github.com/o/p.git", "git@github.com:o/p.git", "ssh://git@host.example/o/p", "git://host.example/p", "host.example:p.git"] {
            assert!(cloneable(ok), "{ok}");
        }
        for bad in ["", "--upload-pack=touch /tmp/x", "-u x", "ext::sh -c touch% /tmp/x", "file:///tmp/repo", "/tmp/repo", "../repo", "https://-x/p", "a b:c"] {
            assert!(!cloneable(bad), "{bad}");
        }
        assert!(run("--upload-pack=true", Path::new("/nonexistent/x")).is_err());
    }

    #[test]
    fn maps_paths_relative_to_home() {
        let home = Path::new("/home/me");
        assert_eq!(home_relative(Path::new("/home/owner/Documents/x/proj"), home, "proj"), PathBuf::from("/home/me/Documents/x/proj"));
        assert_eq!(home_relative(Path::new("/Users/owner/code/proj"), home, "proj"), PathBuf::from("/home/me/code/proj"));
        assert_eq!(home_relative(Path::new("/root/proj"), home, "proj"), PathBuf::from("/home/me/proj"));
        assert_eq!(home_relative(Path::new("/srv/git/proj"), home, "proj"), PathBuf::from("/home/me/proj"), "outside a home: under this one");
        assert_eq!(home_relative(Path::new("/home/owner"), home, "proj"), PathBuf::from("/home/me/owner"), "the home itself isn't a project path to mirror");
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("harbor-clone-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn finds_an_existing_clone() {
        let d = tmp("find");
        let (mine, other) = (d.join("mine"), d.join("other"));
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let gone = d.join("gone");
        let dirs = [(gone.as_path(), "git@github.com:o/p.git"), (other.as_path(), "https://github.com/o/q"), (mine.as_path(), "https://github.com/O/P")];
        assert_eq!(find_clone(dirs, "git@github.com:o/p.git"), Some(mine.clone()), "same remote, folder here (not the missing one)");
        assert_eq!(find_clone(dirs, "git@github.com:o/z.git"), None);
        assert_eq!(find_clone([(mine.as_path(), "")], ""), None, "no remote never matches");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn picks_a_free_place() {
        let d = tmp("place");
        let want = d.join("proj");
        let origins: HashMap<PathBuf, &str> = [(want.clone(), "https://github.com/o/other"), (d.join("proj-2"), "git@github.com:o/p.git")].into_iter().collect();
        let origin = |p: &Path| origins.get(p).map(|s| s.to_string());
        // Nothing there: clone into it.
        assert_eq!(place(&want, "git@github.com:o/p.git", &origin), Err(want.clone()));
        // Another repository there: the next free name.
        std::fs::create_dir_all(want.join("src")).unwrap();
        assert_eq!(place(&want, "git@github.com:o/q.git", &origin), Err(d.join("proj-2")));
        // The same repository beside it: that one.
        std::fs::create_dir_all(d.join("proj-2/src")).unwrap();
        assert_eq!(place(&want, "https://github.com/o/p", &origin), Ok(d.join("proj-2")));
        // An empty folder is free.
        std::fs::create_dir_all(d.join("proj-3")).unwrap();
        assert_eq!(place(&want, "git@github.com:o/q.git", &origin), Err(d.join("proj-3")));
        let _ = std::fs::remove_dir_all(&d);
    }
}
