//! Agent turns that outlive Harbor. Each turn runs under `harbor turn <dir>`, a small
//! runner started in its own session (`setsid -f`), so a reload or restart of Harbor
//! doesn't take it down. The runner gives the agent its input from `<dir>/in` (an
//! append-only file Harbor writes to, ended by `<dir>/in.closed`), appends its output
//! to `<dir>/out` and `<dir>/err`, and writes the exit code to `<dir>/exit`.
//! Harbor follows those files; after a restart it finds the turns still running (or
//! finished while it was away) and replays them from the start.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(60);
/// Sent to a chat whose turn was cut off while Harbor was away.
const RESTARTED: &str = "[harbor] Your previous turn was cut off (the computer restarted or its process was killed). Continue the task from where you stopped.";
/// Finished turns' folders older than this are swept at startup.
const KEEP: Duration = Duration::from_secs(2 * 24 * 3600);

/// What Harbor needs to pick a turn back up.
#[derive(Clone, Serialize, Deserialize)]
pub struct Meta {
    pub chat_id: i64,
    /// Provider kind, as `providers::Kind::as_str`.
    pub kind: String,
    /// Unix time the turn started.
    pub started: i64,
    /// Transcript length when it started: replay rebuilds from there.
    pub base: usize,
    pub pid: u32,
    /// The runner's start time (/proc stat field 22), so a reused pid isn't taken for it.
    pub pid_start: u64,
}

pub fn root() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from).unwrap_or_else(|| crate::store::home().join(".local/state"));
    base.join("harbor/turns")
}

fn proc_start(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Fields after "(comm)": state is field 3, starttime field 22.
    stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()
}

/// The runner is still the process it was (and not a zombie).
pub fn alive(pid: u32, start: u64) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return false };
    let Some((_, rest)) = stat.rsplit_once(')') else { return false };
    let mut f = rest.split_whitespace();
    let state = f.next().unwrap_or("Z");
    state != "Z" && state != "X" && f.nth(18).and_then(|v| v.parse::<u64>().ok()) == Some(start)
}

/// Starts `cmd` under a detached runner in a new turn folder. `input` is written to
/// the agent first; with `keep_input` the input stays open for more until closed.
pub fn spawn(cmd: &Command, input: Option<&str>, keep_input: bool, mut meta: Meta) -> std::io::Result<(PathBuf, Meta)> {
    let dir = root().join(format!("{}-{}", meta.chat_id, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
    std::fs::create_dir_all(&dir)?;
    let env: Vec<(String, Option<String>)> =
        cmd.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
    let spec = json!({
        "program": cmd.get_program().to_string_lossy(),
        "args": cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        "cwd": cmd.get_current_dir().map(|d| d.to_string_lossy().into_owned()),
        "env": env,
        "input": input.is_some(),
    });
    std::fs::write(dir.join("cmd.json"), spec.to_string())?;
    if let Some(text) = input {
        std::fs::write(dir.join("in"), text)?;
        if !keep_input {
            std::fs::write(dir.join("in.closed"), "")?;
        }
    }
    let exe = std::env::current_exe().map(|p| PathBuf::from(p.to_string_lossy().trim_end_matches(" (deleted)")))?;
    // setsid -f: the runner gets its own session and isn't Harbor's child, so neither
    // a reload (exec) nor Harbor exiting reaches it.
    Command::new("setsid")
        .arg("-f")
        .arg(&exe)
        .arg("turn")
        .arg(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    let t = Instant::now();
    let pid = loop {
        if let Some(pid) = std::fs::read_to_string(dir.join("pid")).ok().and_then(|s| s.trim().parse::<u32>().ok()) {
            break pid;
        }
        if t.elapsed() > Duration::from_secs(5) {
            return Err(std::io::Error::other("the turn runner didn't start"));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    meta.pid = pid;
    meta.pid_start = proc_start(pid).unwrap_or(0);
    std::fs::write(dir.join("meta.json"), serde_json::to_string(&meta).unwrap_or_default())?;
    Ok((dir, meta))
}

/// Appends a message to the turn's input; false once it is closed.
pub fn write_input(dir: &Path, text: &str) -> bool {
    if dir.join("in.closed").exists() {
        return false;
    }
    std::fs::OpenOptions::new().append(true).open(dir.join("in")).and_then(|mut f| f.write_all(text.as_bytes())).is_ok()
}

pub fn close_input(dir: &Path) {
    let _ = std::fs::write(dir.join("in.closed"), "");
}

pub fn input_open(dir: &Path) -> bool {
    dir.join("in").exists() && !dir.join("in.closed").exists()
}

/// Follows the turn's output from the start: `line` gets each stdout line, `err` each
/// stderr line; returns whether it exited cleanly once it is done.
pub fn follow(dir: &Path, meta: &Meta, mut line: impl FnMut(&str), mut err: impl FnMut(&str)) -> bool {
    let mut out = Tail::new(dir.join("out"));
    let mut errs = Tail::new(dir.join("err"));
    loop {
        // Checked before reading, so nothing written before the exit is missed.
        let done = dir.join("exit").exists() || !alive(meta.pid, meta.pid_start);
        let a = out.lines(&mut line);
        let b = errs.lines(&mut err);
        if done {
            out.lines(&mut line);
            errs.lines(&mut err);
            return std::fs::read_to_string(dir.join("exit")).is_ok_and(|c| c.trim() == "0");
        }
        if !a && !b {
            std::thread::sleep(POLL);
        }
    }
}

/// Reads whole lines appended to a file since the last look.
struct Tail {
    path: PathBuf,
    pos: u64,
    buf: Vec<u8>,
}

impl Tail {
    fn new(path: PathBuf) -> Self {
        Tail { path, pos: 0, buf: vec![] }
    }

    /// True if anything was read.
    fn lines(&mut self, f: &mut impl FnMut(&str)) -> bool {
        let Ok(mut file) = std::fs::File::open(&self.path) else { return false };
        if file.seek(SeekFrom::Start(self.pos)).is_err() {
            return false;
        }
        let mut chunk = vec![];
        let n = file.read_to_end(&mut chunk).unwrap_or(0);
        if n == 0 {
            return false;
        }
        self.pos += n as u64;
        self.buf.extend_from_slice(&chunk);
        while let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
            let l: Vec<u8> = self.buf.drain(..=i).collect();
            f(String::from_utf8_lossy(&l[..l.len() - 1]).trim_end_matches('\r'));
        }
        true
    }
}

/// Turn folders left by an earlier Harbor: still running, or done while it was away
/// and not picked up yet. Old leftovers without a turn are swept.
pub fn leftovers() -> Vec<(PathBuf, Meta)> {
    let mut v = vec![];
    for e in std::fs::read_dir(root()).into_iter().flatten().flatten() {
        let dir = e.path();
        match std::fs::read_to_string(dir.join("meta.json")).ok().and_then(|s| serde_json::from_str::<Meta>(&s).ok()) {
            Some(m) => v.push((dir, m)),
            None => {
                let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_none_or(|a| a > KEEP);
                if old {
                    let _ = std::fs::remove_dir_all(&dir);
                }
            }
        }
    }
    v.sort_by_key(|(_, m)| m.started);
    v
}

/// `harbor turn <dir>`: runs the agent described in `<dir>/cmd.json`.
pub fn run(args: &[String]) {
    let Some(dir) = args.first().map(PathBuf::from) else { return };
    let _ = std::fs::write(dir.join("pid"), std::process::id().to_string());
    let Ok(spec) = std::fs::read_to_string(dir.join("cmd.json")).map(|s| serde_json::from_str::<serde_json::Value>(&s).unwrap_or_default()) else { return };
    let mut cmd = Command::new(spec["program"].as_str().unwrap_or_default());
    cmd.args(spec["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str()));
    if let Some(cwd) = spec["cwd"].as_str() {
        cmd.current_dir(cwd);
    }
    for kv in spec["env"].as_array().into_iter().flatten() {
        match (kv[0].as_str(), kv[1].as_str()) {
            (Some(k), Some(v)) => cmd.env(k, v),
            (Some(k), None) => cmd.env_remove(k),
            _ => continue,
        };
    }
    let open = |name: &str| std::fs::OpenOptions::new().create(true).append(true).open(dir.join(name));
    let (Ok(out), Ok(err)) = (open("out"), open("err")) else { return };
    let input = spec["input"].as_bool() == Some(true);
    cmd.stdin(if input { Stdio::piped() } else { Stdio::null() }).stdout(out).stderr(err);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(std::fs::OpenOptions::new().append(true).open(dir.join("err")).unwrap(), "{}: {e}", spec["program"].as_str().unwrap_or(""));
            let _ = std::fs::write(dir.join("exit"), "127");
            return;
        }
    };
    // Input: whatever is appended to `in`, until `in.closed` and all of it is passed on.
    if let Some(mut sin) = child.stdin.take() {
        let dir = dir.clone();
        std::thread::spawn(move || {
            let mut pos = 0u64;
            loop {
                let closed = dir.join("in.closed").exists();
                let mut chunk = vec![];
                if let Ok(mut f) = std::fs::File::open(dir.join("in")) {
                    if f.seek(SeekFrom::Start(pos)).is_ok() {
                        let _ = f.read_to_end(&mut chunk);
                    }
                }
                if !chunk.is_empty() {
                    pos += chunk.len() as u64;
                    if sin.write_all(&chunk).and_then(|_| sin.flush()).is_err() {
                        return;
                    }
                } else if closed {
                    return; // drops stdin: the agent sees the end of its input
                } else {
                    std::thread::sleep(POLL);
                }
            }
        });
    }
    let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
    let _ = std::fs::write(dir.join("exit"), code.to_string());
}

impl crate::app::App {
    /// At startup: picks up the turns an earlier Harbor left running (or that ended
    /// while it was away). Each chat's transcript goes back to where its turn began,
    /// keeping notices and messages that arrived since, and the turn is replayed.
    pub fn reattach_turns(&mut self, ctx: &eframe::egui::Context) {
        use crate::store::Item;
        for (dir, meta) in leftovers() {
            let id = meta.chat_id;
            if self.chat(id).is_none() || self.turns.contains_key(&id) {
                let _ = std::fs::remove_dir_all(&dir);
                continue;
            }
            // The runner died without an exit code (a reboot, a logout) and wasn't stopped.
            if !dir.join("exit").exists() && !dir.join("stopped").exists() && !alive(meta.pid, meta.pid_start) {
                self.cut_off.insert(id);
            }
            let mut items = self.store.items(id);
            let since: Vec<Item> = items.split_off(meta.base.min(items.len())).into_iter().filter(|it| matches!(it, Item::Notice { .. } | Item::Message { .. })).collect();
            items.extend(since);
            self.transcripts.insert(id, crate::app::Transcript { items, ..Default::default() });
            let age = Duration::from_secs((crate::store::now() - meta.started).max(0) as u64);
            let at = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
            let turn = crate::agent::reattach(dir, meta, self.tx.clone(), crate::app::turn_wake(ctx, id));
            self.turns.insert(id, (turn, at));
        }
    }

    /// Settings → General, "Continue threads after restarts" (on by default).
    pub fn resume_on_restart(&self) -> bool {
        self.store.get("resume_on_restart").as_deref() != Some("0")
    }

    /// Whether the chat's cut-off turn continues once its replay ends.
    pub fn resumes(&self, chat_id: i64) -> bool {
        self.cut_off.contains(&chat_id) && self.resume_on_restart() && self.chat(chat_id).is_some_and(|c| c.started && !c.session_id.is_empty())
    }

    /// After a cut-off turn's replay: continues the chat in its session (unless
    /// something else already did, or it waits out a usage limit).
    pub fn restart_exited(&mut self, chat_id: i64, ctx: &eframe::egui::Context) {
        let go = self.resumes(chat_id);
        if !self.cut_off.remove(&chat_id) || !go || self.turns.contains_key(&chat_id) || self.paused(chat_id).is_some() {
            return;
        }
        self.notice(chat_id, "restart", "The turn was cut off while Harbor was away · continuing", "");
        self.start_turn(chat_id, RESTARTED.into(), vec![], ctx);
    }
}
