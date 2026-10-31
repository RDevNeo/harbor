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

/// The turns of this Harbor. A Harbor on another data folder (a test instance) gets
/// its own, so instances never see, pick up or sweep each other's turns.
pub fn root() -> PathBuf {
    let base = crate::store::state_dir();
    let data = crate::store::data_dir();
    if data == crate::store::home().join(".local/share/harbor") {
        return base.join("turns");
    }
    // FNV-1a of the data folder: stable across runs and builds.
    let h = data.to_string_lossy().bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    base.join(format!("turns-{:012x}", h & 0xffff_ffff_ffff))
}

/// The chat a process runs a turn for, if it is a `harbor turn <root>/<chat>-…` runner.
pub fn runner_chat(args: &[String], root: &Path) -> Option<i64> {
    if args.get(1).map(String::as_str) != Some("turn") {
        return None;
    }
    let dir = Path::new(args.get(2)?);
    if dir.parent()? != root {
        return None;
    }
    dir.file_name()?.to_str()?.split('-').next()?.parse().ok()
}

/// Live runners of this Harbor's turns, from the processes themselves (so one is found
/// even if its folder is gone): chat id, folder, pid. Only this user's processes: another
/// user's that only looks like a runner isn't one.
pub fn runners() -> Vec<(i64, PathBuf, u32)> {
    use std::os::unix::fs::MetadataExt;
    let root = root();
    let Ok(me) = std::fs::metadata("/proc/self").map(|m| m.uid()) else { return vec![] };
    let mut v = vec![];
    for e in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        if e.metadata().map(|m| m.uid()).ok() != Some(me) {
            continue;
        }
        let Ok(raw) = std::fs::read(e.path().join("cmdline")) else { continue };
        let args: Vec<String> = raw.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
        if let Some(chat) = runner_chat(&args, &root) {
            if proc_start(pid).is_some_and(|st| alive(pid, st)) {
                v.push((chat, PathBuf::from(&args[2]), pid));
            }
        }
    }
    v
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
/// the agent first; with `keep_input` the input stays open for more until closed. With
/// `agent_env` the runner adds Harbor's app credentials (`mcp::agent_env`) itself.
pub fn spawn(cmd: &Command, input: Option<&str>, keep_input: bool, agent_env: bool, mut meta: Meta) -> std::io::Result<(PathBuf, Meta)> {
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
        "agent_env": agent_env,
    });
    crate::mcp::write_private(&dir.join("cmd.json"), &spec.to_string())?;
    if let Some(text) = input {
        // Owner-only: a remote turn's input starts with the account's login (agent.rs).
        crate::mcp::write_private(&dir.join("in"), text)?;
        if !keep_input {
            std::fs::write(dir.join("in.closed"), "")?;
        }
    }
    let exe = crate::update::self_exe().ok_or_else(|| std::io::Error::other("cannot find harbor's own executable"))?;
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
    // A folder that was deleted under a live runner: its output is still open in the
    // runner, reachable through /proc/<pid>/fd.
    let file = |name: &str| if dir.join(name).exists() { dir.join(name) } else { fd_of(meta.pid, dir, name).unwrap_or_else(|| dir.join(name)) };
    let mut out = Tail::new(file("out"));
    let mut errs = Tail::new(file("err"));
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
    /// Kept open once found: a /proc fd link vanishes with its process, the file doesn't.
    file: Option<std::fs::File>,
    buf: Vec<u8>,
}

impl Tail {
    fn new(path: PathBuf) -> Self {
        Tail { path, file: None, buf: vec![] }
    }

    /// True if anything was read.
    fn lines(&mut self, f: &mut impl FnMut(&str)) -> bool {
        if self.file.is_none() {
            self.file = std::fs::File::open(&self.path).ok();
        }
        let Some(file) = self.file.as_mut() else { return false };
        let mut chunk = vec![];
        let n = file.read_to_end(&mut chunk).unwrap_or(0);
        if n == 0 {
            return false;
        }
        self.buf.extend_from_slice(&chunk);
        while let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
            let l: Vec<u8> = self.buf.drain(..=i).collect();
            f(String::from_utf8_lossy(&l[..l.len() - 1]).trim_end_matches('\r'));
        }
        true
    }
}

/// The runner's open `<dir>/<name>` (also once deleted), as a /proc/<pid>/fd path.
fn fd_of(pid: u32, dir: &Path, name: &str) -> Option<PathBuf> {
    let want = dir.join(name).to_string_lossy().into_owned();
    std::fs::read_dir(format!("/proc/{pid}/fd")).ok()?.flatten().map(|e| e.path()).find(|p| {
        std::fs::read_link(p).is_ok_and(|t| {
            let t = t.to_string_lossy();
            t == want || t.strip_suffix(" (deleted)") == Some(want.as_str())
        })
    })
}

/// Unix time a process started.
fn started_at(pid: u32) -> Option<i64> {
    let ticks = proc_start(pid)? as i64;
    let btime: i64 = std::fs::read_to_string("/proc/stat").ok()?.lines().find_map(|l| l.strip_prefix("btime ")?.trim().parse().ok())?;
    Some(btime + ticks / 100)
}

/// A live runner whose folder is gone gets it back: what Harbor needs to follow it
/// (its provider from the agent process, its start, where its turn began in the
/// transcript), and its input closed, so the agent finishes what it's doing and exits
/// (the runner looks for `in.closed` by path; its exit code lands there too).
pub fn recover(dir: &Path, pid: u32, chat_id: i64, items: &[crate::store::Item]) -> Meta {
    let started = started_at(pid).unwrap_or_else(crate::store::now);
    let kind = std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
        .filter(|c| std::fs::read_to_string(format!("/proc/{c}/stat")).ok().and_then(|s| s.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse::<u32>().ok()) == Some(pid))
        .find_map(|c| {
            let raw = std::fs::read(format!("/proc/{c}/cmdline")).ok()?;
            let exe = String::from_utf8_lossy(raw.split(|b| *b == 0).next()?).into_owned();
            let name = Path::new(&exe).file_name()?.to_string_lossy().into_owned();
            crate::providers::Kind::ALL.into_iter().find(|k| k.bin() == name)
        })
        .unwrap_or(crate::providers::Kind::Claude);
    // The turn began after the last message sent before the runner started.
    let base = items.iter().rposition(|it| matches!(it, crate::store::Item::User { at, .. } if *at <= started + 5)).map_or(items.len(), |i| i + 1);
    let meta = Meta { chat_id, kind: kind.label().to_string(), started, base, pid, pid_start: proc_start(pid).unwrap_or(0) };
    if std::fs::create_dir_all(dir).is_ok() {
        let _ = std::fs::write(dir.join("in.closed"), "");
        let _ = std::fs::write(dir.join("meta.json"), serde_json::to_string(&meta).unwrap_or_default());
    }
    meta
}

/// Leftover turns in the order they are picked up (one per chat): live ones first, then
/// the newest.
fn follow_order(left: &mut [(PathBuf, Meta)]) {
    // When a folder was made: its name is `<chat>-<nanoseconds>`.
    let made = |dir: &Path| -> u128 { dir.file_name().and_then(|n| n.to_str()?.split_once('-')?.1.parse().ok()).unwrap_or(0) };
    left.sort_by_key(|(dir, m)| std::cmp::Reverse((alive(m.pid, m.pid_start), made(dir))));
}

/// Turn folders left by an earlier Harbor: still running, or done while it was away
/// and not picked up yet. Old leftovers without a turn are swept.
pub fn leftovers() -> Vec<(PathBuf, Meta)> {
    let mut v = vec![];
    for e in std::fs::read_dir(root()).into_iter().flatten().flatten() {
        let dir = e.path();
        match std::fs::read_to_string(dir.join("meta.json")).ok().and_then(|s| serde_json::from_str::<Meta>(&s).ok()) {
            Some(m) => v.push((dir, m)),
            None if runners().iter().any(|r| r.1 == dir) => {}
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
    // A chat commanded from another PC (meshctx.rs): the account's login comes in as a token,
    // read here so it stays out of cmd.json, and this PC's sign-ins may be off.
    let var = |k: &str| spec["env"].as_array().into_iter().flatten().find(|kv| kv[0] == k).and_then(|kv| kv[1].as_str().map(String::from));
    let signed_in = var(crate::agent::GUEST_APPS).as_deref() != Some("0");
    // The overlay holding the turn's login for the commands it runs, while it runs (oauth.rs).
    let mut lent = None;
    if let Some(login) = var(crate::agent::GUEST_LOGIN) {
        cmd.env_remove(crate::agent::GUEST_LOGIN).env_remove(crate::agent::GUEST_APPS);
        let dir = (!login.is_empty()).then(|| PathBuf::from(login));
        let overlay = var("CLAUDE_CONFIG_DIR").map(PathBuf::from);
        match crate::oauth::token(dir.as_deref()) {
            Some(t) => {
                lent = overlay.filter(|o| crate::oauth::lend(o, dir.as_deref(), &t).is_ok()).map(Lent);
                cmd.env("CLAUDE_CODE_OAUTH_TOKEN", t);
            }
            // Not signed in here: no login left from an earlier turn runs it as someone else.
            None => {
                if let Some(o) = overlay.filter(|o| !overlay_in_use(o, std::process::id())) {
                    crate::oauth::unlend(&o);
                }
            }
        }
    }
    if spec["agent_env"].as_bool() == Some(true) {
        for (k, v) in crate::mcp::agent_env_as(signed_in) {
            match v {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            };
        }
    }
    // Owner-only: the agent's whole stream (prompts, files it read, command output).
    let open = |name: &str| {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(dir.join(name))
    };
    let input = spec["input"].as_bool() == Some(true);
    let remote = Path::new(spec["program"].as_str().unwrap_or_default()).file_name().is_some_and(|n| n == "ssh");
    let device = var(DEVICE);
    cmd.env_remove(DEVICE);
    // A device ssh couldn't connect to (a changed address, a Wi-Fi blip) is tried again for
    // a while; ssh resolves its name anew each time. Nothing ran there yet, so it's safe.
    let started = Instant::now();
    let mut wait = RETRY_FIRST;
    let mut tries = 0;
    let code = loop {
        tries += 1;
        let (Ok(out), Ok(err)) = (open("out"), open("err")) else { return };
        let before = out.metadata().map(|m| m.len()).unwrap_or(0);
        cmd.stdin(if input { Stdio::piped() } else { Stdio::null() }).stdout(out);
        cmd.stderr(if remote { Stdio::piped() } else { Stdio::from(err) });
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = writeln!(std::fs::OpenOptions::new().append(true).open(dir.join("err")).unwrap(), "{}: {e}", spec["program"].as_str().unwrap_or(""));
                drop(lent);
                let _ = std::fs::write(dir.join("exit"), "127");
                return;
            }
        };
        let fed = child.stdin.take().map(|sin| feed(sin, &dir));
        if !remote {
            break child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
        }
        let held = child.stderr.take().map(|e| pass_stderr(e, &dir, before));
        let code = wait_remote(&mut child, &dir);
        if let Some(f) = fed {
            f.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        // Lines ssh printed before it got anywhere, held back from the chat.
        let held = held.and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok()).unwrap_or_default();
        let grew = std::fs::metadata(dir.join("out")).map(|m| m.len()).unwrap_or(0) > before;
        let why = held.iter().rev().find_map(|l| unreachable(l)).filter(|_| code == 255 && !grew);
        let Some((host, reason)) = why else {
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(dir.join("err")) {
                for l in &held {
                    let _ = writeln!(f, "{l}");
                }
            }
            break code;
        };
        if started.elapsed() + wait <= RETRY_FOR && !dir.join("stopped").exists() {
            std::thread::sleep(wait);
            wait = (wait * 2).min(RETRY_MAX);
            continue;
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(dir.join("err")) {
            let _ = writeln!(f, "{}", unreachable_text(device.as_deref().unwrap_or(&host), &host, &reason, tries, started.elapsed()));
        }
        break code;
    };
    drop(lent);
    let _ = std::fs::write(dir.join("exit"), code.to_string());
}

/// The env var that names a remote turn's device (agent.rs), for [`unreachable_text`].
pub const DEVICE: &str = "HARBOR_DEVICE";
/// How long a device ssh can't connect to is tried again, and the waits between tries.
const RETRY_FOR: Duration = Duration::from_secs(if cfg!(test) { 2 } else { 30 });
const RETRY_FIRST: Duration = Duration::from_millis(if cfg!(test) { 100 } else { 1000 });
const RETRY_MAX: Duration = Duration::from_secs(8);

/// Gives the agent its input: whatever is appended to `in`, from the start, until
/// `in.closed` and all of it is passed on (or the returned flag is set: ssh is gone).
fn feed(mut sin: std::process::ChildStdin, dir: &Path) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    let gone = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (dir, flag) = (dir.to_path_buf(), gone.clone());
    std::thread::spawn(move || {
        let mut pos = 0u64;
        while !flag.load(std::sync::atomic::Ordering::Relaxed) {
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
    gone
}

/// Copies ssh's stderr to `<dir>/err` as it comes, except the lines saying it couldn't
/// connect while nothing came from the device yet (`out` still at `before`): those are
/// sent once stderr ends, for the runner to try again or say so in plain words.
fn pass_stderr(e: std::process::ChildStderr, dir: &Path, before: u64) -> std::sync::mpsc::Receiver<Vec<String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let dir = dir.to_path_buf();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let mut held = vec![];
        let mut through = false;
        let mut f = std::fs::OpenOptions::new().append(true).open(dir.join("err")).ok();
        for line in std::io::BufReader::new(e).split(b'\n').map_while(Result::ok) {
            let line = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
            through = through || std::fs::metadata(dir.join("out")).map(|m| m.len()).unwrap_or(0) > before;
            if !through && unreachable(&line).is_some() {
                held.push(line);
                continue;
            }
            through = true;
            if let Some(f) = f.as_mut() {
                let _ = writeln!(f, "{line}");
            }
        }
        let _ = tx.send(held);
    });
    rx
}

/// ssh's line for a device it couldn't connect to: the host it dialed and why
/// ("ssh: connect to host H port 22: No route to host", "ssh: Could not resolve hostname
/// H: …"). None for anything else, such as a refused login.
pub fn unreachable(line: &str) -> Option<(String, String)> {
    const WHY: [&str; 7] = ["No route to host", "Connection timed out", "Connection refused", "Network is unreachable", "Host is down", "Operation timed out", "Name or service not known"];
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("ssh: connect to host ") {
        let (host, why) = rest.split_once(": ")?;
        let host = host.rsplit_once(" port ").map_or(host, |(h, _)| h);
        return WHY.iter().any(|w| why.starts_with(w)).then(|| (host.to_string(), why.to_string()));
    }
    let rest = line.strip_prefix("ssh: Could not resolve hostname ")?;
    let (host, why) = rest.split_once(": ").unwrap_or((rest, ""));
    Some((host.to_string(), if why.is_empty() { "Name or service not known".into() } else { why.to_string() }))
}

/// The chat's error once a device couldn't be reached.
fn unreachable_text(name: &str, host: &str, why: &str, tries: u32, took: Duration) -> String {
    let (what, ask) = match why {
        w if w.starts_with("No route to host") => ("no route to host", "Is it on and on the same network?"),
        w if w.starts_with("Connection timed out") || w.starts_with("Operation timed out") => ("it didn't answer", "Is it on, awake and on the same network?"),
        w if w.starts_with("Connection refused") => ("it refused the connection", "Is its SSH server (Remote Login on a Mac) on?"),
        w if w.starts_with("Network is unreachable") => ("this PC's network is unreachable", "Is this PC online?"),
        w if w.starts_with("Host is down") => ("the device is down", "Is it on and on the same network?"),
        _ => ("its name didn't resolve", "Is it on and on the same network, and is the name right in Settings › Devices?"),
    };
    let at = if name.eq_ignore_ascii_case(host) { name.to_string() } else { format!("{name} ({host})") };
    let tried = if tries > 1 { format!(" (tried {tries} times over {} s)", took.as_secs().max(1)) } else { String::new() };
    format!("Couldn't reach {at}: {what}{tried}. {ask}")
}

/// A turn's login lent to its overlay (oauth.rs), taken out when the turn is done, unless
/// another turn still runs there.
struct Lent(PathBuf);

impl Drop for Lent {
    fn drop(&mut self) {
        if !overlay_in_use(&self.0, std::process::id()) {
            crate::oauth::unlend(&self.0);
        }
    }
}

/// A stopped turn's lent login: the kill (agent.rs) gives its runner no chance to take it out.
pub fn take_back(dir: &Path, runner: u32) {
    let spec = std::fs::read_to_string(dir.join("cmd.json")).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).unwrap_or_default();
    let var = |k: &str| spec["env"].as_array().into_iter().flatten().find(|kv| kv[0] == k).and_then(|kv| kv[1].as_str());
    // Only a guest turn's: another turn's config dir is its account's own profile.
    if let (Some(_), Some(overlay)) = (var(crate::agent::GUEST_LOGIN), var("CLAUDE_CONFIG_DIR")) {
        if !overlay_in_use(Path::new(overlay), runner) {
            crate::oauth::unlend(Path::new(overlay));
        }
    }
}

/// A live turn other than `runner`'s runs in this overlay profile (chats commanded from the
/// same PC share it).
fn overlay_in_use(overlay: &Path, runner: u32) -> bool {
    runners().into_iter().filter(|r| r.2 != runner).any(|(_, dir, _)| {
        let spec = std::fs::read_to_string(dir.join("cmd.json")).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).unwrap_or_default();
        spec["env"].as_array().into_iter().flatten().any(|kv| kv[0] == "CLAUDE_CONFIG_DIR" && kv[1].as_str().map(Path::new) == Some(overlay))
    })
}

/// The last line a device's script prints once the agent there has exited, with its exit
/// code (remote.rs): `{"type":"harbor_exit","code":N}`.
pub const REMOTE_EXIT: &str = "harbor_exit";
/// How long ssh gets after that to end by itself.
const LINGER: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 5 });

/// Waits for a remote turn's ssh. ssh only exits once every channel it forwards is closed,
/// so a connection to the bridge that stays open (a server that never answered) would keep
/// the turn going after the agent there is done. Once the device's script says the agent
/// exited, ssh gets [`LINGER`] and is then stopped; the turn ends with the agent's exit code.
fn wait_remote(child: &mut std::process::Child, dir: &Path) -> i32 {
    let out = dir.join("out");
    let mut seen = 0u64;
    let mut partial = vec![];
    let mut ended: Option<(i32, Instant)> = None;
    // Only that line is parsed (the agent's own lines can be large).
    let mark = format!("{{\"type\":\"{REMOTE_EXIT}\"");
    loop {
        if let Ok(Some(st)) = child.try_wait() {
            return st.code().or(ended.map(|e| e.0)).unwrap_or(1);
        }
        if ended.is_none() {
            let mut chunk = vec![];
            if let Ok(mut f) = std::fs::File::open(&out) {
                if f.seek(SeekFrom::Start(seen)).is_ok() {
                    let _ = f.read_to_end(&mut chunk);
                }
            }
            seen += chunk.len() as u64;
            partial.extend_from_slice(&chunk);
            while let Some(i) = partial.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = partial.drain(..=i).collect();
                if !line.starts_with(mark.as_bytes()) {
                    continue;
                }
                let Ok(v) = serde_json::from_slice::<serde_json::Value>(&line) else { continue };
                if v["type"] == REMOTE_EXIT {
                    ended = Some((v["code"].as_i64().unwrap_or(1) as i32, Instant::now()));
                }
            }
        }
        if let Some((code, at)) = ended.filter(|e| e.1.elapsed() >= LINGER) {
            let _ = Command::new("kill").args(["-TERM", &child.id().to_string()]).stderr(Stdio::null()).status();
            let t = Instant::now();
            while child.try_wait().ok().flatten().is_none() && t.elapsed() < Duration::from_secs(2) {
                std::thread::sleep(POLL);
            }
            let _ = child.kill();
            let _ = child.wait();
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(dir.join("err")) {
                let _ = writeln!(f, "harbor: the agent there exited {} s ago and ssh still held the connection open; closed it", at.elapsed().as_secs());
            }
            return code;
        }
        std::thread::sleep(POLL);
    }
}

impl crate::app::App {
    /// At startup: picks up the turns an earlier Harbor left running (or that ended
    /// while it was away). Each chat's transcript goes back to where its turn began,
    /// keeping notices and messages that arrived since, and the turn is replayed.
    pub fn reattach_turns(&mut self, ctx: &eframe::egui::Context) {
        // A chat's live turn (else its newest) is the one followed. An older folder is a
        // stopped turn's whose end hadn't come through yet: followed first, it would leave
        // the newer turn unfollowed, its MCP servers unserved, until the chat got a message.
        let mut left = leftovers();
        follow_order(&mut left);
        for (dir, meta) in left {
            let id = meta.chat_id;
            if self.chat(id).is_none() || self.turns.contains_key(&id) {
                // Never pull a folder from under a runner that is still going.
                if !alive(meta.pid, meta.pid_start) {
                    let _ = std::fs::remove_dir_all(&dir);
                }
                continue;
            }
            // The runner died without an exit code (a reboot, a logout) and wasn't stopped.
            if !dir.join("exit").exists() && !dir.join("stopped").exists() && !alive(meta.pid, meta.pid_start) {
                self.cut_off.insert(id);
            }
            self.pick_up(dir, meta, ctx);
        }
        // Runners still going whose folder vanished: they are recovered, not forgotten
        // (a forgotten one would get a second turn on its session).
        for (id, dir, pid) in runners() {
            if self.turns.contains_key(&id) || self.chat(id).is_none() {
                continue;
            }
            let meta = recover(&dir, pid, id, &self.store.items(id));
            self.notice(id, "alert", "Picked up a turn Harbor had lost track of", "");
            self.pick_up(dir, meta, ctx);
        }
    }

    /// Follows a turn again: the chat's transcript goes back to where the turn began,
    /// keeping notices, messages and anything sent since, and the turn is replayed.
    fn pick_up(&mut self, dir: PathBuf, meta: Meta, ctx: &eframe::egui::Context) {
        use crate::store::Item;
        let id = meta.chat_id;
        let mut items = self.store.items(id);
        let since: Vec<Item> = items
            .split_off(meta.base.min(items.len()))
            .into_iter()
            .filter(|it| matches!(it, Item::Notice { .. } | Item::Message { .. }) || matches!(it, Item::User { at, .. } if *at > meta.started))
            .collect();
        items.extend(since);
        self.transcripts.insert(id, crate::app::Transcript { items, ..Default::default() });
        let age = Duration::from_secs((crate::store::now() - meta.started).max(0) as u64);
        let at = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
        let turn = crate::agent::reattach(dir, meta, self.tx.clone(), crate::app::turn_wake(ctx, id));
        self.turns.insert(id, (turn, at));
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

impl crate::app::App {
    /// A runner of this chat that Harbor isn't following (it lost track of it, say its
    /// folder vanished before a reload) is taken back by its pid, so the chat counts as
    /// busy and what's sent meanwhile waits for it. True if one was found.
    pub fn adopt_runner(&mut self, chat_id: i64, ctx: &eframe::egui::Context) -> bool {
        let Some((_, dir, pid)) = runners().into_iter().find(|r| r.0 == chat_id) else { return false };
        // What's on screen (a message just sent) is kept: it goes to the store first.
        self.persist(chat_id);
        let items = self.store.items(chat_id);
        let meta = std::fs::read_to_string(dir.join("meta.json")).ok().and_then(|s| serde_json::from_str::<Meta>(&s).ok()).unwrap_or_else(|| recover(&dir, pid, chat_id, &items));
        self.notice(chat_id, "alert", "A turn of this chat was still running: new messages wait for it", "");
        self.pick_up(dir, meta, ctx);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_the_chat_of_a_runner() {
        let root = Path::new("/home/u/.local/state/harbor/turns");
        assert_eq!(runner_chat(&args(&["/x/harbor", "turn", "/home/u/.local/state/harbor/turns/23-1792605157067846264"]), root), Some(23));
        // Its folder may be gone: the command line still names it.
        assert_eq!(runner_chat(&args(&["/x/harbor (deleted)", "turn", "/home/u/.local/state/harbor/turns/7-1"]), root), Some(7));
    }

    #[test]
    fn ignores_other_processes_and_other_harbors() {
        let root = Path::new("/home/u/.local/state/harbor/turns");
        assert_eq!(runner_chat(&args(&["/x/harbor", "mcp", "--chat", "23"]), root), None);
        assert_eq!(runner_chat(&args(&["/x/harbor"]), root), None);
        // A test instance's turns live in another folder.
        assert_eq!(runner_chat(&args(&["/x/harbor", "turn", "/home/u/.local/state/harbor/turns-0a1b2c3d4e5f/23-1"]), root), None);
        assert_eq!(runner_chat(&args(&["/x/harbor", "turn", "/elsewhere/23-1"]), root), None);
    }

    #[test]
    fn a_remote_turn_ends_when_ssh_lingers_after_its_agent() {
        let dir = std::env::temp_dir().join(format!("harbor-linger-{}", crate::bridge::token().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        // ssh once the agent there exited (code 0), with a forwarded connection still open.
        let ssh = |code: i32| {
            let out = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("out")).unwrap();
            let script = format!("printf '%s\\n' '{{\"type\":\"result\",\"subtype\":\"success\"}}' '' '{{\"type\":\"{REMOTE_EXIT}\",\"code\":{code}}}'; exec sleep 300");
            Command::new("sh").args(["-c", &script]).stdout(out).spawn().unwrap()
        };
        std::fs::write(dir.join("err"), "").unwrap();
        let mut child = ssh(0);
        let t = Instant::now();
        assert_eq!(wait_remote(&mut child, &dir), 0);
        assert!(t.elapsed() >= LINGER && t.elapsed() < LINGER + Duration::from_secs(3), "{:?}", t.elapsed());
        assert!(child.try_wait().unwrap().is_some(), "ssh is gone");
        assert!(std::fs::read_to_string(dir.join("err")).unwrap().contains("ssh still held"));
        // The agent's own code, not the signal's.
        std::fs::remove_file(dir.join("out")).unwrap();
        assert_eq!(wait_remote(&mut ssh(2), &dir), 2);
        // An ssh that ends by itself keeps its code, the agent's end said or not.
        let mut quick = Command::new("sh").args(["-c", "exit 3"]).spawn().unwrap();
        assert_eq!(wait_remote(&mut quick, &dir), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lingering_ssh_turn_ends_as_a_success() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("harbor-linger-run-{}", crate::bridge::token().unwrap()));
        let dir = root.join("7-1");
        std::fs::create_dir_all(&dir).unwrap();
        // An ssh whose agent there answered and exited, held open by a forwarded connection.
        let ssh = root.join("ssh");
        std::fs::write(&ssh, format!("#!/bin/sh\nprintf '%s\\n' '{{\"type\":\"result\",\"subtype\":\"success\",\"duration_ms\":5,\"num_turns\":1}}' '' '{{\"type\":\"{REMOTE_EXIT}\",\"code\":0}}'\nexec sleep 300\n")).unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("cmd.json"), json!({ "program": ssh, "args": ["-R", "127.0.0.1:1:127.0.0.1:1", "device", "cmd"], "input": false }).to_string()).unwrap();
        let t = Instant::now();
        run(&[dir.to_string_lossy().into_owned()]);
        assert!(t.elapsed() >= LINGER && t.elapsed() < LINGER + Duration::from_secs(3), "{:?}", t.elapsed());
        assert_eq!(std::fs::read_to_string(dir.join("exit")).unwrap(), "0");
        // Harbor reads it as a turn that ended well: its result, no stop, the exit line no event.
        let meta = Meta { chat_id: 7, kind: "Claude".into(), started: 1, base: 0, pid: u32::MAX, pid_start: 0 };
        let mut lines = vec![];
        assert!(follow(&dir, &meta, |l| lines.push(l.to_string()), |_| {}), "the turn ended as a success");
        assert!(!dir.join("stopped").exists());
        assert!(lines.iter().any(|l| l.contains("\"result\"")), "{lines:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ssh_lines_that_mean_the_device_is_out_of_reach() {
        let r = |l: &str| unreachable(l).map(|(h, w)| format!("{h}|{w}"));
        assert_eq!(r("ssh: connect to host mac.local port 22: No route to host").as_deref(), Some("mac.local|No route to host"));
        assert_eq!(r("ssh: connect to host 10.0.0.5 port 2222: Connection timed out\r").as_deref(), Some("10.0.0.5|Connection timed out"));
        assert_eq!(r("ssh: connect to host box port 22: Connection refused").as_deref(), Some("box|Connection refused"));
        assert_eq!(r("ssh: connect to host box port 22: Network is unreachable").as_deref(), Some("box|Network is unreachable"));
        assert_eq!(r("ssh: Could not resolve hostname mac.local: Name or service not known").as_deref(), Some("mac.local|Name or service not known"));
        assert_eq!(r("ssh: Could not resolve hostname mac.local: Temporary failure in name resolution").as_deref(), Some("mac.local|Temporary failure in name resolution"));
        // Got there: a login or anything later is no reason to try again.
        for l in ["user@box: Permission denied (publickey).", "Host key verification failed.", "ssh: connect to host box port 22: Permission denied", "Connection to box closed by remote host.", "error: something"] {
            assert_eq!(r(l), None, "{l}");
        }
        assert_eq!(
            unreachable_text("Studio-Mac", "studio-mac.local", "No route to host", 4, Duration::from_secs(31)),
            "Couldn't reach Studio-Mac (studio-mac.local): no route to host (tried 4 times over 31 s). Is it on and on the same network?"
        );
        assert_eq!(unreachable_text("box", "box", "Connection refused", 1, Duration::ZERO), "Couldn't reach box: it refused the connection. Is its SSH server (Remote Login on a Mac) on?");
    }

    /// A fake ssh (named so) that answers on try `ok` (0: never), saying `fail` until then;
    /// it records its tries and its first line of input.
    fn flaky_ssh(root: &Path, ok: u32, fail: &str) -> (PathBuf, String) {
        use std::os::unix::fs::PermissionsExt;
        let dir = root.join("7-1");
        std::fs::create_dir_all(&dir).unwrap();
        let ssh = root.join("ssh");
        let tries = root.join("tries");
        std::fs::write(
            &ssh,
            format!(
                "#!/bin/sh\necho x >> '{t}'\nn=$(wc -l < '{t}')\nif [ \"$n\" != {ok} ]; then echo '{fail}' >&2; exit 255; fi\nread -r first\necho \"$first\" > '{t}.in'\necho 'Warning: Permanently added box' >&2\nprintf '%s\\n' '{{\"type\":\"result\",\"subtype\":\"success\",\"duration_ms\":5,\"num_turns\":1}}'\nexit 0\n",
                t = tries.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = json!([[DEVICE, "Studio-Mac"]]);
        std::fs::write(dir.join("cmd.json"), json!({ "program": ssh, "args": ["box", "cmd"], "input": true, "env": env }).to_string()).unwrap();
        std::fs::write(dir.join("in"), "token\nhi\n").unwrap();
        std::fs::write(dir.join("in.closed"), "").unwrap();
        (dir, tries.to_string_lossy().into_owned())
    }

    #[test]
    fn a_device_out_of_reach_is_tried_again() {
        let root = std::env::temp_dir().join(format!("harbor-reach-{}", crate::bridge::token().unwrap()));
        let tries = |t: &str| std::fs::read_to_string(t).map(|s| s.lines().count()).unwrap_or(0);
        // Fails twice (its address changed), then answers: the turn runs, with its whole
        // input, and the chat never sees ssh's failures.
        let (dir, t) = flaky_ssh(&root, 3, "ssh: connect to host mac.local port 22: No route to host");
        run(&[dir.to_string_lossy().into_owned()]);
        assert_eq!(std::fs::read_to_string(dir.join("exit")).unwrap(), "0");
        assert_eq!(tries(&t), 3);
        assert_eq!(std::fs::read_to_string(format!("{t}.in")).unwrap(), "token\n");
        assert_eq!(std::fs::read_to_string(dir.join("err")).unwrap(), "Warning: Permanently added box\n");
        assert!(std::fs::read_to_string(dir.join("out")).unwrap().contains("\"result\""));
        let _ = std::fs::remove_dir_all(&root);
        // Never answers: one plain error, after RETRY_FOR.
        let (dir, t) = flaky_ssh(&root, 0, "ssh: connect to host mac.local port 22: Connection timed out");
        let at = Instant::now();
        run(&[dir.to_string_lossy().into_owned()]);
        assert!(at.elapsed() < RETRY_FOR + Duration::from_secs(1), "{:?}", at.elapsed());
        assert_eq!(std::fs::read_to_string(dir.join("exit")).unwrap(), "255");
        let err = std::fs::read_to_string(dir.join("err")).unwrap();
        assert!(err.starts_with("Couldn't reach Studio-Mac (mac.local): it didn't answer (tried ") && err.lines().count() == 1, "{err}");
        assert!(tries(&t) >= 3, "{}", tries(&t));
        let _ = std::fs::remove_dir_all(&root);
        // A refused login isn't tried again, and its line is the error.
        let (dir, t) = flaky_ssh(&root, 0, "user@box: Permission denied (publickey).");
        run(&[dir.to_string_lossy().into_owned()]);
        assert_eq!(tries(&t), 1);
        assert_eq!(std::fs::read_to_string(dir.join("err")).unwrap(), "user@box: Permission denied (publickey).\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_guest_turns_commands_run_as_its_account() {
        let root = std::env::temp_dir().join(format!("harbor-guest-run-{}", crate::bridge::token().unwrap()));
        let (dir, acct, overlay) = (root.join("9-1"), root.join("acct"), root.join("guests/pc-b"));
        for d in [&dir, &acct, &overlay] {
            std::fs::create_dir_all(d).unwrap();
        }
        let expires = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 + 3_600_000;
        let login = json!({ "claudeAiOauth": { "accessToken": "sk-ant-oat01-guest", "refreshToken": "sk-ant-ort01-guest", "expiresAt": expires, "scopes": ["user:inference"] } });
        std::fs::write(acct.join(".credentials.json"), login.to_string()).unwrap();
        // The agent, and a command it runs: Claude Code keeps the token from that one, which
        // has only the overlay to sign in from.
        let agent = "printf 'token=%s login=%s\\n' \"$CLAUDE_CODE_OAUTH_TOKEN\" \"${HARBOR_GUEST_LOGIN-none}\"; env -u CLAUDE_CODE_OAUTH_TOKEN sh -c 'cat \"$CLAUDE_CONFIG_DIR/.credentials.json\"; stat -c \" mode=%a\" \"$CLAUDE_CONFIG_DIR/.credentials.json\"'";
        let turn = |dir: &Path| {
            let env = json!([["CLAUDE_CONFIG_DIR", overlay], [crate::agent::GUEST_LOGIN, acct], ["CLAUDE_CODE_OAUTH_TOKEN", null]]);
            std::fs::write(dir.join("cmd.json"), json!({ "program": "sh", "args": ["-c", agent], "env": env, "input": false }).to_string()).unwrap();
            run(&[dir.to_string_lossy().into_owned()]);
            std::fs::read_to_string(dir.join("out")).unwrap_or_default()
        };
        let out = turn(&dir);
        assert!(out.starts_with("token=sk-ant-oat01-guest login=none\n"), "{out}");
        let flat: String = out.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(flat.contains("\"accessToken\":\"sk-ant-oat01-guest\"") && out.contains(" mode=600"), "{out}");
        assert!(!out.contains("sk-ant-ort01"), "the refresh token stays with the account: {out}");
        assert!(!std::fs::read_to_string(dir.join("cmd.json")).unwrap().contains("sk-ant-oat01"));
        // Taken out when the turn ends.
        assert!(!overlay.join(".credentials.json").exists());
        // An account not signed in here: a login left in the overlay doesn't stand in for it.
        std::fs::remove_file(acct.join(".credentials.json")).unwrap();
        std::fs::write(overlay.join(".credentials.json"), login.to_string()).unwrap();
        let dir = root.join("9-2");
        std::fs::create_dir_all(&dir).unwrap();
        let out = turn(&dir);
        assert!(out.starts_with("token= login=none\n") && !out.contains("sk-ant-"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_stopped_guest_turn_gives_its_login_back() {
        let root = std::env::temp_dir().join(format!("harbor-guest-stop-{}", crate::bridge::token().unwrap()));
        std::fs::create_dir_all(&root).unwrap();
        let creds = root.join(".credentials.json");
        let turn = |env: serde_json::Value| std::fs::write(root.join("cmd.json"), json!({ "program": "sh", "env": env }).to_string()).unwrap();
        std::fs::write(&creds, "{}").unwrap();
        // Any other turn: the config dir is its account's own profile, with its own login.
        turn(json!([["CLAUDE_CONFIG_DIR", root]]));
        take_back(&root, u32::MAX);
        assert!(creds.exists());
        turn(json!([["CLAUDE_CONFIG_DIR", root], [crate::agent::GUEST_LOGIN, ""]]));
        take_back(&root, u32::MAX);
        assert!(!creds.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn picks_up_a_chats_live_turn_before_an_older_stopped_one() {
        let mut sleeper = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = sleeper.id();
        let meta = |pid: u32| Meta { chat_id: 5, kind: "Claude".into(), started: 1, base: 0, pid, pid_start: proc_start(pid).unwrap_or(0) };
        // The stopped turn's runner is gone; the next turn's runs.
        let mut left = vec![(PathBuf::from("/x/5-100"), meta(u32::MAX)), (PathBuf::from("/x/5-200"), meta(pid)), (PathBuf::from("/x/6-50"), meta(u32::MAX))];
        follow_order(&mut left);
        assert_eq!(left[0].0, PathBuf::from("/x/5-200"));
        let _ = sleeper.kill();
        let _ = sleeper.wait();
        // None live: the newest first.
        follow_order(&mut left);
        assert_eq!(left.iter().map(|l| l.0.to_string_lossy().into_owned()).collect::<Vec<_>>(), ["/x/5-200", "/x/5-100", "/x/6-50"]);
    }

    /// A remote turn over a real ssh (to this PC): `cargo test -- --ignored remote_turn_ends_over_ssh`.
    /// Needs key-based ssh to 127.0.0.1. The agent there asks a stdio server that never
    /// answers and gives up; then one leaves a request open in the background.
    #[test]
    #[ignore]
    fn remote_turn_ends_over_ssh() {
        let mut servers = serde_json::Map::new();
        servers.insert("slow".into(), json!({ "type": "stdio", "command": "sh", "args": ["-c", "while read -r l; do :; done"] }));
        let g = crate::bridge::Grant { token: crate::bridge::token().unwrap(), chat_id: 1, cwd: std::env::temp_dir(), servers, commands: false, workspace: vec![], machines: None };
        let port = crate::bridge::grant(g.clone()).unwrap();
        let rport = 20000 + std::process::id() % 40000;
        let url = format!("http://127.0.0.1:{rport}/{}/slow", g.token);
        let curl = |wait: u32, method: &str| format!("curl -s -m {wait} -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"{method}\"}}' {url}");
        let turn = |agent: String| {
            let dir = std::env::temp_dir().join(format!("harbor-ssh-turn-{}", crate::bridge::token().unwrap()));
            std::fs::create_dir_all(&dir).unwrap();
            let argv: Vec<String> = ["sh", "-c", &agent].iter().map(|s| s.to_string()).collect();
            let cmd = crate::remote::remote_command("/tmp", &[], &argv);
            let args = ["-o", "BatchMode=yes", "-o", "UserKnownHostsFile=/tmp/harbor-dev-kh", "-o", "StrictHostKeyChecking=accept-new", "-o", "ExitOnForwardFailure=yes", "-R", &format!("127.0.0.1:{rport}:127.0.0.1:{port}"), "127.0.0.1", &cmd];
            std::fs::write(dir.join("cmd.json"), json!({ "program": "ssh", "args": args, "input": false }).to_string()).unwrap();
            let t = Instant::now();
            run(&[dir.to_string_lossy().into_owned()]);
            let r = (std::fs::read_to_string(dir.join("exit")).unwrap(), std::fs::read_to_string(dir.join("err")).unwrap(), t.elapsed());
            let _ = std::fs::remove_dir_all(&dir);
            r
        };
        let result = "printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\"}'";
        // The agent's request times out there and it exits: the bridge closes its end, so
        // ssh ends by itself.
        let (code, err, took) = turn(format!("{}; {result}", curl(2, "tools/list")));
        assert_eq!(code, "0", "{err}");
        assert!(!err.contains("ssh still held") && took < Duration::from_secs(10), "{took:?} {err}");
        // A request left open behind the agent (once it got through) keeps ssh's forwarding
        // open: stopped after LINGER.
        let (code, err, took) = turn(format!("nohup {} </dev/null >/dev/null 2>&1 & sleep 1; {result}", curl(300, "tools/call")));
        assert_eq!(code, "0", "{err}");
        assert!(err.contains("ssh still held") && took < Duration::from_secs(10), "{took:?} {err}");
        crate::bridge::revoke(&g.token);
    }

    #[test]
    fn sees_a_live_runner_by_its_process() {
        // `python3 turn <dir>` (a script named "turn") has a runner's command line.
        let tmp = std::env::temp_dir().join(format!("harbor-runner-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("turn"), "import time\ntime.sleep(10)\n").unwrap();
        let dir = root().join("424242-1");
        let mut p = Command::new("python3").current_dir(&tmp).arg("turn").arg(&dir).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let found = runners().into_iter().find(|r| r.0 == 424242);
        let _ = p.kill();
        let _ = p.wait();
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(found.map(|r| (r.1, r.2)), Some((dir, p.id())));
        assert!(!runners().iter().any(|r| r.0 == 424242), "gone once it exits");
    }
}
