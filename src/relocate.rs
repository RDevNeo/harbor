//! "Runs on" for a started chat: the chat (and its sub-agents) moves between this PC, its SSH
//! devices (remote.rs) and the other PCs of the mesh (movepc.rs), and its next turn resumes the
//! same Claude session there.
//!
//! Claude Code resumes only sessions it finds in its own profile, in the folder of the
//! directory it runs in, so the move carries each started session (`<sid>.jsonl` and its
//! sidecar folder) to where the next turn will look:
//! - from a device: its newest copy there (any `~/.claude*` profile or Harbor's guest profiles,
//!   as [`remote::Setup::Session`] searches) comes over ssh as a tar stream;
//! - to this PC: into the account's folder for the chat's folder here (movechat.rs);
//! - to a device: into the profile and folder its turns use there ([`App::remote_spec`]);
//! - to another PC of the mesh: here first, then the handoff of movepc.rs.
//!
//! When the files the agent works on change place (this PC's files ↔ a device that works on
//! its own files), the folder it leaves must have no uncommitted changes. Mid-turn chats,
//! other providers and Windows devices don't move (yet); each says why.

use crate::app::App;
use crate::providers::Kind;
use crate::remote::{self, Family, Host, Setup};
use crate::store::{Chat, Role};
use eframe::egui;
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const SSH_WAIT: Duration = Duration::from_secs(120);

/// Where a chat can run: this PC, one of its SSH devices, or another PC's Harbor.
#[derive(Clone)]
pub enum Place {
    Here,
    Device(Host),
    Hub(crate::mesh::Peer),
}

/// Where the agent's files are: this PC's (`None`), or a device's own.
fn files_of(p: &Place) -> Option<String> {
    match p {
        Place::Here => None,
        Place::Device(h) if h.device_files => Some(h.id.clone()),
        Place::Device(_) => None,
        Place::Hub(p) => Some(format!("hub:{}", p.id)),
    }
}

/// A device's side of a move, prepared on the UI thread.
#[derive(Clone, Debug)]
pub struct Dev {
    pub name: String,
    pub ssh: Vec<String>,
    pub host: String,
    /// The folder its turns start in.
    pub dir: String,
    /// Shell lines that set `c` to the Claude profile its turns use.
    pub config: String,
}

/// The shell lines that set `c` to the profile a turn's `setup` gives Claude on a device.
pub fn config_lines(setup: &[Setup]) -> String {
    let mut s = String::from("c=\"$HOME/.claude\"");
    for l in setup {
        match l {
            Setup::Guest(rel) => s = format!("c=\"$HOME\"/{}; mkdir -p \"$c\"", remote::quote(rel)),
            Setup::Profile(rel) => s.push_str(&format!("; [ -d \"$HOME\"/{0} ] && c=\"$HOME\"/{0}", remote::quote(rel))),
            _ => {}
        }
    }
    s
}

/// The script that writes a session's tar stream (stdout) from a device: its newest copy in
/// any profile there. Exit 96 when there's none.
pub fn pull_script(sid: &str) -> String {
    let f = remote::quote(&format!("{sid}.jsonl"));
    let d = remote::quote(sid);
    format!(
        "s=$(ls -t \"$HOME\"/.claude*/projects/*/{f} \"$HOME\"/.local/state/harbor/guests/*/projects/*/{f} 2>/dev/null | head -n1)\n\
         [ -n \"$s\" ] || {{ echo \"harbor: the chat's session isn't on $(hostname)\" >&2; exit 96; }}\n\
         cd \"$(dirname \"$s\")\" || exit 96\n\
         export COPYFILE_DISABLE=1\n\
         if [ -d {d} ]; then tar -cf - {f} {d}; else tar -cf - {f}; fi"
    )
}

/// The script that unpacks a session's tar stream (stdin) where a device's turns will look.
pub fn push_script(dir: &str, config: &str) -> String {
    format!(
        "cd {} 2>/dev/null || {{ echo \"harbor: the folder {} doesn't exist on $(hostname)\" >&2; exit 97; }}\n{config}\n\
         d=\"$c/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')\"; mkdir -p \"$d\" && tar -xf - -C \"$d\"",
        remote::shell_path(dir),
        dir.replace(['"', '$', '`', '\\'], "")
    )
}

/// The script that counts a device folder's uncommitted changes (0 outside git).
pub fn dirty_script(dir: &str) -> String {
    format!(
        "cd {} 2>/dev/null || {{ echo 0; exit 0; }}\ngit rev-parse --git-dir >/dev/null 2>&1 || {{ echo 0; exit 0; }}\ngit status --porcelain | wc -l",
        remote::shell_path(dir)
    )
}

fn ssh(dev: &Dev, script: &str) -> Command {
    let mut c = Command::new("ssh");
    c.args(&dev.ssh).arg(&dev.host).arg(format!("sh -c {}", remote::quote(script)));
    c
}

fn last_line(b: &[u8]) -> String {
    String::from_utf8_lossy(b).lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no answer").trim().to_string()
}

/// Runs `cmd` with `input` on its stdin; its output.
fn feed(mut cmd: Command, input: &[u8]) -> Result<std::process::Output, String> {
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let data = input.to_vec();
    let w = std::thread::spawn(move || {
        let _ = stdin.write_all(&data);
    });
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = w.join();
    Ok(out)
}

/// A session from a device into `into` (made here): its files there, as (place, file here).
fn pull(dev: &Dev, sid: &str, into: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let out = crate::git::output_within(&mut ssh(dev, &pull_script(sid)), SSH_WAIT).map_err(|e| format!("ssh to {}: {e}", dev.name))?;
    if !out.status.success() {
        return Err(format!("couldn't read the session on {}: {}", dev.name, last_line(&out.stderr)));
    }
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let mut tar = Command::new("tar");
    tar.arg("-xf").arg("-").arg("-C").arg(into);
    let x = feed(tar, &out.stdout)?;
    if !x.status.success() {
        return Err(format!("couldn't unpack the session from {}: {}", dev.name, last_line(&x.stderr)));
    }
    let mut files = vec![];
    collect(into, "", &mut files);
    // Only the session's own places (a Mac's tar may add `._…` files).
    files.retain(|(rel, _)| crate::movepc::safe_rel(sid, rel));
    if !files.iter().any(|(rel, _)| *rel == format!("{sid}.jsonl")) {
        return Err(format!("the session didn't come over from {}", dev.name));
    }
    Ok(files)
}

fn collect(dir: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(t) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        if t.is_dir() {
            collect(&e.path(), &r, out);
        } else if t.is_file() {
            out.push((r, e.path()));
        }
    }
}

/// A session's files to a device, where its turns will look.
fn push(dev: &Dev, sid: &str, files: &[(String, PathBuf)]) -> Result<(), String> {
    let (rel, path) = files.iter().find(|(r, _)| *r == format!("{sid}.jsonl")).ok_or("no session file")?;
    let root = path.to_string_lossy();
    let root = Path::new(root.strip_suffix(rel.as_str()).ok_or("bad session path")?);
    let mut tar = Command::new("tar");
    tar.env("COPYFILE_DISABLE", "1").arg("-cf").arg("-").arg("-C").arg(root).arg(format!("{sid}.jsonl"));
    if root.join(sid).is_dir() {
        tar.arg(sid);
    }
    let packed = crate::git::output_within(&mut tar, SSH_WAIT).map_err(|e| e.to_string())?;
    if !packed.status.success() {
        return Err(format!("couldn't pack the session: {}", last_line(&packed.stderr)));
    }
    let out = feed(ssh(dev, &push_script(&dev.dir, &dev.config)), &packed.stdout)?;
    if !out.status.success() {
        return Err(format!("couldn't put the session on {}: {}", dev.name, last_line(&out.stderr)));
    }
    Ok(())
}

/// One session of the move: its id, the account's profile here, and its folder here.
#[derive(Clone, Debug)]
pub struct Session {
    pub sid: String,
    pub config: Option<PathBuf>,
    pub here: PathBuf,
}

/// The files check before the agent's files change place.
#[derive(Clone, Debug)]
pub enum Check {
    None,
    Here(PathBuf),
    Device(Dev),
}

/// Everything the move's thread needs.
pub struct Job {
    pub from: Option<Dev>,
    pub to: Option<Dev>,
    pub sessions: Vec<Session>,
    pub check: Check,
}

/// The move off the UI thread: the files check, then each session from where it is to where
/// the next turn will look.
pub fn run(job: Job) -> Result<(), String> {
    match &job.check {
        Check::None => {}
        Check::Here(dir) => {
            crate::movepc::code_state(dir, false)?;
        }
        Check::Device(dev) => {
            let out = crate::git::output_within(&mut ssh(dev, &dirty_script(&dev.dir)), SSH_WAIT).map_err(|e| format!("ssh to {}: {e}", dev.name))?;
            if !out.status.success() {
                return Err(format!("couldn't reach {}: {}", dev.name, last_line(&out.stderr)));
            }
            let n: usize = last_line(&out.stdout).parse().unwrap_or(0);
            if n > 0 {
                return Err(format!("{} on {} has {n} uncommitted change{}: commit or stash them first", dev.dir, dev.name, if n == 1 { "" } else { "s" }));
            }
        }
    }
    let tmp = crate::store::data_dir().join("relocate").join(crate::store::new_uuid());
    let r = (|| {
        for s in &job.sessions {
            let files = match &job.from {
                Some(dev) => pull(dev, &s.sid, &tmp.join(&s.sid))?,
                None => crate::movepc::session_files(&s.config, &s.sid).ok_or("its Claude session isn't on this PC")?,
            };
            match &job.to {
                Some(dev) => push(dev, &s.sid, &files)?,
                None => crate::movepc::place(&crate::movechat::session_dir(&s.config, &s.here), &s.sid, &files)?,
            }
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    r
}

impl App {
    /// A place by the id the pickers use: "" this PC, a mesh PC's id (its Harbor), a device's.
    pub fn place_of(&self, id: &str, devs: &[(Host, Option<bool>)]) -> Option<(Place, Option<bool>)> {
        if id.is_empty() {
            return Some((Place::Here, Some(true)));
        }
        if let Some(p) = self.mesh_hosts().into_iter().find(|p| p.id == id) {
            let on = p.online;
            return Some((Place::Hub(p), Some(on)));
        }
        devs.iter().find(|(h, _)| h.id == id).map(|(h, o)| (Place::Device(h.clone()), *o))
    }

    /// A place's name, for notices and toasts.
    pub fn place_name(&self, p: &Place) -> String {
        match p {
            Place::Here => {
                let n = self.api.hub.mesh.me().name;
                if n.is_empty() { remote::hostname() } else { n }
            }
            Place::Device(h) => h.label().to_string(),
            Place::Hub(p) => if p.name.is_empty() { crate::mesh::label(&p.id) } else { p.name.clone() },
        }
    }

    /// Why a started chat can't move anywhere now (None: it may; the places say the rest).
    pub fn relocate_blocker(&self, chat_id: i64) -> Option<String> {
        let c = self.chat(chat_id)?;
        if c.foreign() {
            return Some(format!("it runs in {}'s Harbor: change it there, or move it with Move to PC…", self.home_name(c)));
        }
        if c.role == Role::Sub {
            return Some("a sub-agent runs where its lead does: change the lead".into());
        }
        if let Some(to) = self.moving_to(chat_id) {
            return Some(format!("it's moving to {to}"));
        }
        let mut ids = vec![chat_id];
        ids.extend(self.all_subs_of(chat_id).into_iter().map(|s| s.id));
        for id in &ids {
            let Some(x) = self.chat(*id) else { continue };
            let it = if *id == chat_id { "it".to_string() } else { format!("its sub-agent {}", x.name) };
            if self.account(&x.account).is_none_or(|a| a.kind != Kind::Claude) {
                return Some(format!("{it} isn't a Claude chat: only Claude chats move between devices for now"));
            }
            if self.is_running(*id) {
                return Some(format!("{it} is running: move it once its turn ends"));
            }
            if x.device != c.device {
                return Some(format!("its sub-agent {} runs on another device", x.name));
            }
        }
        if !c.device.is_empty() {
            let devs = remote::devices(&self.remote, &remote::tailnet_cached());
            match devs.iter().find(|(h, _)| h.id == c.device) {
                None => return Some("its device isn't in Settings › Devices anymore, so its session can't be fetched".into()),
                Some((h, _)) if remote::family(&h.os) == Family::Windows => return Some("Windows devices can't hand a started chat over yet".into()),
                _ => {}
            }
        }
        None
    }

    /// Why a started chat can't move to `to` now (None: it can, or it's already there). A chat
    /// not started yet is free to pick (the composer keeps it as before).
    pub fn relocate_why(&self, chat_id: i64, to: &str, devs: &[(Host, Option<bool>)]) -> Option<String> {
        let c = self.chat(chat_id)?;
        if !c.started || to == c.device {
            return None;
        }
        if let Some(b) = self.relocate_blocker(chat_id) {
            return Some(b);
        }
        let Some((place, online)) = self.place_of(to, devs) else { return Some("no such device".into()) };
        match &place {
            Place::Here => None,
            Place::Device(h) if remote::family(&h.os) == Family::Windows => Some("Windows devices can't take a started chat yet".into()),
            Place::Device(_) if online == Some(false) => Some("it's offline".into()),
            Place::Device(_) => None,
            Place::Hub(p) => {
                if !self.api.hub.mesh.on.load(std::sync::atomic::Ordering::Relaxed) {
                    Some("this PC doesn't share chats with other PCs (Settings › Devices)".into())
                } else if !p.online {
                    Some("it's off or out of reach".into())
                } else if !p.moves {
                    Some("it runs an older Harbor: update it first".into())
                } else if !p.accounts.iter().any(|(_, _, k)| k == "claude") {
                    Some("it has no Claude account".into())
                } else {
                    None
                }
            }
        }
    }

    /// For the phone: per place id, why a started chat can't move there (only those that can't).
    pub fn device_why(&self, c: &Chat) -> Value {
        if !c.started || c.foreign() {
            return Value::Null;
        }
        let devs = remote::devices(&self.remote, &remote::tailnet_cached());
        let mut ids: Vec<String> = vec![String::new()];
        ids.extend(devs.iter().filter(|(h, _)| !h.hidden).map(|(h, _)| h.id.clone()));
        ids.extend(self.mesh_hosts().into_iter().map(|p| p.id));
        let mut m = serde_json::Map::new();
        for id in ids {
            if let Some(w) = self.relocate_why(c.id, &id, &devs) {
                m.insert(id, json!(w));
            }
        }
        Value::Object(m)
    }

    /// A device's side of a move, as the chat's turns will use it there.
    fn dev_of(&self, chat: &Chat, h: &Host, ctx: &egui::Context) -> Result<Dev, String> {
        let account = self.account(&chat.account).cloned().ok_or("the chat's account is gone")?;
        let spec = self.remote_spec(&Chat { device: h.id.clone(), ..chat.clone() }, &account, ctx)?.ok_or("no device")?;
        Ok(Dev { name: h.label().to_string(), ssh: spec.ssh, host: spec.host, dir: spec.dir, config: config_lines(&spec.setup) })
    }

    /// Moves a started chat (and its sub-agents) to `to` ("" this PC, a device's id, a mesh
    /// PC's id): its sessions go along on a thread, then it runs there. Ok: the place's name;
    /// the outcome shows as a notice in the chat.
    pub fn relocate(&mut self, chat_id: i64, to: &str, ctx: &egui::Context) -> Result<String, String> {
        let devs = remote::devices(&self.remote, &remote::tailnet(ctx));
        if let Some(w) = self.relocate_why(chat_id, to, &devs) {
            return Err(w);
        }
        let lead = self.chat(chat_id).cloned().ok_or("no such chat")?;
        if to == lead.device {
            return Ok(String::new());
        }
        let (target, _) = self.place_of(to, &devs).ok_or("no such device")?;
        let (source, _) = self.place_of(&lead.device, &devs).ok_or("its device isn't in Settings › Devices anymore")?;
        let from = match &source {
            Place::Device(h) => Some(self.dev_of(&lead, h, ctx)?),
            _ => None,
        };
        let to_dev = match &target {
            Place::Device(h) => Some(self.dev_of(&lead, h, ctx)?),
            _ => None,
        };
        let check = if files_of(&source) == files_of(&target) || lead.repo_id.is_none() {
            Check::None
        } else {
            match (&source, &from) {
                (Place::Device(h), Some(d)) if h.device_files => Check::Device(d.clone()),
                // A hub target checks this PC's folder itself (movepc.rs).
                _ if matches!(target, Place::Hub(_)) => Check::None,
                _ => Check::Here(self.chat_cwd(&lead)),
            }
        };
        let mut chats = vec![lead.clone()];
        chats.extend(self.all_subs_of(chat_id));
        let sessions: Vec<Session> = chats
            .iter()
            .filter(|c| c.started && !c.session_id.is_empty())
            .map(|c| {
                if !crate::movepc::valid_sid(&c.session_id) {
                    return Err(format!("{}'s session id looks wrong", c.name));
                }
                let config = self.account(&c.account).and_then(|a| a.config_dir.clone());
                Ok(Session { sid: c.session_id.clone(), config, here: self.chat_cwd(&lead) })
            })
            .collect::<Result<_, String>>()?;
        let job = Job { from, to: to_dev.clone(), sessions, check };
        let (src_name, dst_name) = (self.place_name(&source), self.place_name(&target));
        self.movepc.relocating.insert(chat_id, dst_name.clone());
        self.api_touch(chat_id);
        let to = to.to_string();
        let ids: Vec<i64> = chats.iter().map(|c| c.id).collect();
        let name = dst_name.clone();
        self.ws_spawn(ctx, move || run(job), move |app, r, ctx| {
            app.movepc.relocating.remove(&chat_id);
            match r {
                Ok(()) => app.relocated(chat_id, &ids, &to, &target, &src_name, &name, ctx),
                Err(e) => {
                    app.notice(chat_id, "alert", &format!("Couldn't move to {name}: {e}"), "");
                    crate::picker::show_toast(ctx, format!("Couldn't move to {name}: {e}"));
                    app.move_pc_resume(chat_id, ctx);
                }
            }
        });
        Ok(dst_name)
    }

    /// The sessions are where the next turn looks: the chat runs there from now on.
    #[allow(clippy::too_many_arguments)]
    fn relocated(&mut self, chat_id: i64, ids: &[i64], to: &str, target: &Place, from: &str, name: &str, ctx: &egui::Context) {
        let old = self.chat(chat_id).map(|c| c.device.clone()).unwrap_or_default();
        let device = if matches!(target, Place::Hub(_)) { String::new() } else { to.to_string() };
        self.set_devices(ids, &device);
        if let Place::Hub(p) = target {
            // On to the other PC's Harbor, from here (movepc.rs). If that can't start, it
            // stays where it was: its session there is as it was.
            if let Err(e) = self.move_pc(chat_id, &p.id, ctx) {
                self.set_devices(ids, &old);
                self.notice(chat_id, "alert", &format!("Couldn't move to {name}: {e}"), "");
                crate::picker::show_toast(ctx, format!("Couldn't move to {name}: {e}"));
                self.move_pc_resume(chat_id, ctx);
            }
            return;
        }
        let detail = match target {
            Place::Here => "Its Claude session came along; its next turn runs on this PC.".to_string(),
            _ => format!("Its Claude session came along; its next turn runs on {name}."),
        };
        self.notice(chat_id, "monitor", &format!("Moved from {from} to {name}"), &detail);
        crate::picker::show_toast(ctx, format!("Moved to {name}"));
        self.move_pc_resume(chat_id, ctx);
    }

    fn set_devices(&mut self, ids: &[i64], device: &str) {
        for id in ids {
            if let Some(c) = self.chat_mut(*id) {
                c.device = device.to_string();
                let c = c.clone();
                self.store.save_chat(&c);
            }
            crate::workspace::forget(*id);
            self.api_touch(*id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str, home: &Path, input: &[u8]) -> std::process::Output {
        let mut c = Command::new("sh");
        c.arg("-c").arg(script).env("HOME", home).current_dir(home);
        feed(c, input).unwrap()
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("harbor-reloc-{tag}-{}", crate::bridge::token().unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn profile_lines_follow_the_turn_setup() {
        assert_eq!(config_lines(&[]), "c=\"$HOME/.claude\"");
        assert!(config_lines(&[Setup::Token, Setup::Guest(".local/state/harbor/guests/pc-a".into())]).starts_with("c=\"$HOME\"/'.local/state/harbor/guests/pc-a'"));
        assert!(config_lines(&[Setup::Profile(".claude2".into())]).contains("[ -d \"$HOME\"/'.claude2' ] && c=\"$HOME\"/'.claude2'"));
    }

    /// The device side with a plain `sh` and a fake home: the newest copy in any profile is
    /// packed with its sidecar, unpacked where the turn's profile and folder say.
    #[test]
    fn sessions_travel_through_the_device_scripts() {
        let dev = tmp("dev");
        let sid = "1c0ffee0-aaaa-4bbb-8ccc-0123456789ab";
        // Two copies: the newer in a profile folder of another project.
        let old = dev.join(".claude/projects/-x-old");
        let new = dev.join(".claude2/projects/-x-new");
        for d in [&old, &new] {
            std::fs::create_dir_all(d.join(sid).join("subagents")).unwrap();
        }
        std::fs::write(old.join(format!("{sid}.jsonl")), "old\n").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(new.join(format!("{sid}.jsonl")), "new\n").unwrap();
        std::fs::write(new.join(sid).join("subagents/a.jsonl"), "{}\n").unwrap();
        let out = sh(&pull_script(sid), &dev, b"");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let here = tmp("here");
        let mut x = Command::new("tar");
        x.arg("-xf").arg("-").arg("-C").arg(&here);
        assert!(feed(x, &out.stdout).unwrap().status.success());
        assert_eq!(std::fs::read_to_string(here.join(format!("{sid}.jsonl"))).unwrap(), "new\n");
        assert!(here.join(sid).join("subagents/a.jsonl").is_file());
        // None there: a clear word, exit 96.
        let none = sh(&pull_script("no-such-session"), &dev, b"");
        assert_eq!(none.status.code(), Some(96));
        assert!(String::from_utf8_lossy(&none.stderr).contains("isn't on"));
        // Back onto a device, in the folder its turn runs in, under the guest profile.
        let other = tmp("other");
        std::fs::create_dir_all(other.join("code/app")).unwrap();
        let mut c = Command::new("tar");
        c.arg("-cf").arg("-").arg("-C").arg(&here).arg(format!("{sid}.jsonl")).arg(sid);
        let packed = crate::git::output_within(&mut c, SSH_WAIT).unwrap().stdout;
        let lines = config_lines(&[Setup::Guest(".local/state/harbor/guests/pc-a".into())]);
        let out = sh(&push_script("~/code/app", &lines), &other, &packed);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let real = std::fs::canonicalize(other.join("code/app")).unwrap();
        let slug: String = real.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        let placed = other.join(".local/state/harbor/guests/pc-a/projects").join(&slug);
        assert_eq!(std::fs::read_to_string(placed.join(format!("{sid}.jsonl"))).unwrap(), "new\n");
        assert!(placed.join(sid).join("subagents/a.jsonl").is_file());
        // A folder that isn't there: exit 97, said.
        let out = sh(&push_script("~/code/missing", &lines), &other, &packed);
        assert_eq!(out.status.code(), Some(97));
        for d in [dev, here, other] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn device_folders_report_uncommitted_changes() {
        let home = tmp("dirty");
        let repo = home.join("code/app");
        std::fs::create_dir_all(&repo).unwrap();
        let count = || String::from_utf8_lossy(&sh(&dirty_script("~/code/app"), &home, b"").stdout).trim().to_string();
        assert_eq!(count(), "0", "not a git folder");
        assert!(Command::new("git").arg("-C").arg(&repo).args(["init", "-q"]).status().unwrap().success());
        std::fs::write(repo.join("a.txt"), "x").unwrap();
        std::fs::write(repo.join("b.txt"), "x").unwrap();
        assert_eq!(count(), "2");
        assert_eq!(String::from_utf8_lossy(&sh(&dirty_script("~/code/none"), &home, b"").stdout).trim(), "0");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn files_change_place_only_with_device_files() {
        let h = |files: bool| Place::Device(Host { id: "ssh:1".into(), device_files: files, ..Default::default() });
        assert_eq!(files_of(&Place::Here), files_of(&h(false)), "a device on this PC's files: nothing moves");
        assert_ne!(files_of(&Place::Here), files_of(&h(true)));
        assert_ne!(files_of(&h(true)), files_of(&Place::Hub(crate::mesh::Peer { id: "pc:b".into(), ..Default::default() })));
    }
}
