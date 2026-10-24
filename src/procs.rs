//! Background processes owned by Harbor, not by an agent's turn: dev servers,
//! watchers, long data pulls. An agent's CLI kills its own background shells when
//! its turn ends, so long-running work is started here instead.
//!
//! Each process runs in its own process group with output going to a log file,
//! and is recorded in the database. It keeps running when Harbor closes or
//! restarts; on the next start Harbor finds it again (pid + start time) and keeps
//! watching it. When it ends, it is forgotten.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use crate::store::ProcRow;

pub enum ProcEvent {
    Url(i64, String),
    Exited(i64, Option<i32>),
}

pub struct Proc {
    pub id: i64,
    pub name: String,
    /// The team's lead (a project's thread, or a project-less one).
    pub lead: i64,
    /// The chat that started it; it gets the exit event.
    pub owner: i64,
    pub cmd: String,
    pub pid: u32,
    pub started: Instant,
    pub log: PathBuf,
    pub url: Option<String>,
}

impl Proc {
    /// Last `n` lines of output (reads only the end of the log).
    pub fn tail(&self, n: usize) -> String {
        tail_file(&self.log, n)
    }

    /// Stops the whole process group (npm → node → vite…): TERM, and KILL for whatever
    /// is still in it a few seconds later.
    pub fn stop(&self) {
        let pid = self.pid;
        signal_group("-TERM", pid);
        std::thread::spawn(move || {
            let t = Instant::now();
            while !group(pid).is_empty() {
                if t.elapsed() > STOP_GRACE {
                    signal_group("-KILL", pid);
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        });
    }
}

/// How long a stopped process group gets to exit after TERM before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(5);
/// A log beyond this keeps only its last [`LOG_KEEP`] bytes (only its end is read).
const LOG_MAX: u64 = 8 * 1024 * 1024;
const LOG_KEEP: u64 = 1024 * 1024;

fn signal_group(sig: &str, pgid: u32) {
    let _ = Command::new("kill").args([sig, "--", &format!("-{pgid}")]).stderr(Stdio::null()).status();
}

/// The live processes of process group `pgid` (field 5 of /proc/<pid>/stat).
fn group(pgid: u32) -> Vec<u32> {
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
        .filter(|p| {
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{p}/stat")) else { return false };
            let Some((_, rest)) = stat.rsplit_once(')') else { return false };
            let mut f = rest.split_whitespace();
            let state = f.next().unwrap_or("Z");
            // After the state: ppid, then pgrp.
            state != "Z" && f.nth(1).and_then(|g| g.parse::<u32>().ok()) == Some(pgid)
        })
        .collect()
}

/// Keeps a process's log small while it runs: past [`LOG_MAX`] only its last
/// [`LOG_KEEP`] bytes stay. Ends once the log is gone (the process ended).
fn cap_log(log: PathBuf) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(30));
            let Ok(len) = std::fs::metadata(&log).map(|m| m.len()) else { return };
            if len > LOG_MAX {
                let _ = trim(&log, LOG_KEEP);
            }
        }
    });
}

/// Cuts `path` down to its last `keep` bytes, in place: the process writes with
/// O_APPEND, so its next output lands after them.
fn trim(path: &Path, keep: u64) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    let len = f.metadata()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(keep)))?;
    let mut tail = Vec::new();
    f.read_to_end(&mut tail)?;
    // From the first whole line on.
    let start = tail.iter().position(|b| *b == b'\n').map_or(0, |i| i + 1);
    f.set_len(0)?;
    f.seek(SeekFrom::Start(0))?;
    std::io::Write::write_all(&mut f, "[… earlier output cut by Harbor]\n".as_bytes())?;
    std::io::Write::write_all(&mut f, &tail[start..])
}

pub fn log_dir() -> PathBuf {
    crate::store::state_dir().join("procs")
}

fn tail_file(path: &Path, n: usize) -> String {
    let Ok(mut f) = File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(64 * 1024)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = strip_ansi(&String::from_utf8_lossy(&buf));
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Clock ticks since boot now (the unit of a process's start time in /proc).
pub fn uptime_ticks() -> Option<i64> {
    let up: f64 = std::fs::read_to_string("/proc/uptime").ok()?.split_whitespace().next()?.parse().ok()?;
    Some((up * 100.0) as i64)
}

/// Children of this process started before `born` (ticks since boot), with whether
/// each has ended (a zombie).
fn children_before(born: i64) -> Vec<(u32, bool)> {
    let me = std::process::id();
    let mut v = vec![];
    for t in std::fs::read_dir("/proc/self/task").into_iter().flatten().flatten() {
        let Ok(list) = std::fs::read_to_string(t.path().join("children")) else { continue };
        for pid in list.split_whitespace().filter_map(|p| p.parse::<u32>().ok()) {
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
            let Some((_, rest)) = stat.rsplit_once(')') else { continue };
            let f: Vec<&str> = rest.split_whitespace().collect();
            let (Some(state), Some(ppid), Some(start)) = (f.first(), f.get(1).and_then(|p| p.parse::<u32>().ok()), f.get(19).and_then(|s| s.parse::<i64>().ok())) else { continue };
            if ppid == me && start < born && !v.iter().any(|(p, _)| *p == pid) {
                v.push((pid, *state == "Z"));
            }
        }
    }
    v
}

/// Reaps `pid` if it has ended; never blocks.
fn reap(pid: u32) {
    if let Some(pid) = rustix::process::Pid::from_raw(pid as i32) {
        let _ = rustix::process::waitpid(Some(pid), rustix::process::WaitOptions::NOHANG);
    }
}

/// A reload execs in place, so what the previous image started (start_process's
/// processes, MCP servers, helpers) stays this process's children, but the threads that
/// waited for them are gone: they'd stay zombies once they end. This reaps them as
/// they do, until none are left. Children started since `born` (this image's start)
/// have their own waiters and are never touched.
pub fn reap_inherited(born: i64) {
    std::thread::spawn(move || {
        loop {
            let kids = children_before(born);
            if kids.is_empty() {
                return;
            }
            for (pid, _) in kids.iter().filter(|k| k.1) {
                reap(*pid);
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

/// Field 22 of /proc/<pid>/stat: start time in clock ticks since boot.
fn start_ticks(pid: u32) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name (field 2) may contain spaces; fields after it follow ")".
    let after = stat.rsplit_once(')')?.1;
    after.split_whitespace().nth(19)?.parse().ok()
}

fn alive(pid: u32, ticks: i64) -> bool {
    // A zombie (state Z) has ended; after a hot reload nobody reaps it.
    let zombie = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|s| s.rsplit_once(')').map(|(_, a)| a.trim_start().starts_with('Z')))
        .unwrap_or(false);
    !zombie && start_ticks(pid) == Some(ticks)
}

/// First http(s) URL on this machine in a line of output.
fn local_url(line: &str) -> Option<String> {
    for start in ["http://", "https://"] {
        let mut from = 0;
        while let Some(i) = line[from..].find(start) {
            let s = &line[from + i..];
            let url: String = s.chars().take_while(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | ')' | ',' | '>')).collect();
            let host = url.split("://").nth(1).unwrap_or("");
            if ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"].iter().any(|h| host.starts_with(h)) {
                return Some(url.replace("0.0.0.0", "localhost").replace("[::]", "localhost").trim_end_matches('.').to_string());
            }
            from += i + start.len();
        }
    }
    None
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for d in chars.by_ref() {
                    if ('@'..='~').contains(&d) {
                        break;
                    }
                }
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Reads new log output until it finds a local URL (or gives up after ten minutes).
fn watch_url(id: i64, log: PathBuf, tx: Sender<ProcEvent>, wake: impl Fn() + Send + 'static) {
    std::thread::spawn(move || {
        let mut offset = 0u64;
        for _ in 0..1500 {
            let Ok(mut f) = File::open(&log) else { return };
            // Cut down meanwhile (cap_log): read it again from the start.
            if f.metadata().is_ok_and(|m| m.len() < offset) {
                offset = 0;
            }
            let _ = f.seek(SeekFrom::Start(offset));
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
                offset += buf.len() as u64;
                if let Some(u) = strip_ansi(&String::from_utf8_lossy(&buf)).lines().find_map(local_url) {
                    let _ = tx.send(ProcEvent::Url(id, u));
                    wake();
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    });
}

/// For processes adopted after a restart (not our children, so no wait()): polls the pid.
fn watch_exit(id: i64, pid: u32, ticks: i64, tx: Sender<ProcEvent>, wake: impl Fn() + Send + 'static) {
    std::thread::spawn(move || {
        while alive(pid, ticks) {
            std::thread::sleep(Duration::from_secs(2));
        }
        let _ = tx.send(ProcEvent::Exited(id, None));
        wake();
    });
}

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    store: &crate::store::Store,
    name: &str,
    cmd: &str,
    cwd: PathBuf,
    repo_id: Option<i64>,
    lead: i64,
    owner: i64,
    tx: Sender<ProcEvent>,
    wake: impl Fn() + Send + Sync + Clone + 'static,
) -> Result<Proc, String> {
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let log = dir.join(format!("{}.log", crate::store::new_uuid()));
    // Owner-only: dev servers print secrets (database URLs, tokens) too.
    let out = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().append(true).create(true).mode(0o600).open(&log).map_err(|e| e.to_string())?
    };
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new("bash");
    // Agents start these: same credentials as the agent itself.
    for (k, v) in crate::mcp::agent_env() {
        match v {
            Some(v) => command.env(k, v),
            None => command.env_remove(k),
        };
    }
    let mut child = command
        .args(["-lc", cmd])
        .current_dir(&cwd)
        .env("PATH", crate::providers::child_path())
        .env("FORCE_COLOR", "0")
        // Python and others buffer stdout when it is not a terminal; URLs would arrive late.
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        // Own process group: stop() reaches every child, and it outlives Harbor.
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.id();
    let id = store.add_proc(&ProcRow {
        id: 0,
        lead,
        repo_id,
        owner,
        name: name.into(),
        cmd: cmd.into(),
        cwd: cwd.to_string_lossy().into_owned(),
        pid: pid as i64,
        start_ticks: start_ticks(pid).unwrap_or(0),
        log: log.to_string_lossy().into_owned(),
        url: None,
    });
    // Our own child: reap it and learn its exit code.
    {
        let (tx, wake) = (tx.clone(), wake.clone());
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            let _ = tx.send(ProcEvent::Exited(id, code));
            wake();
        });
    }
    watch_url(id, log.clone(), tx, wake);
    cap_log(log.clone());
    Ok(Proc { id, name: name.into(), lead, owner, cmd: cmd.into(), pid, started: Instant::now(), log, url: None })
}

/// Processes from a previous Harbor run that are still alive; the rest are dropped.
pub fn adopt(store: &crate::store::Store, tx: Sender<ProcEvent>, wake: impl Fn() + Send + Sync + Clone + 'static) -> Vec<Proc> {
    let mut out = vec![];
    for r in store.procs() {
        let pid = r.pid as u32;
        if !alive(pid, r.start_ticks) {
            store.delete_proc(r.id);
            let _ = std::fs::remove_file(&r.log);
            continue;
        }
        let log = PathBuf::from(&r.log);
        watch_exit(r.id, pid, r.start_ticks, tx.clone(), wake.clone());
        cap_log(log.clone());
        if r.url.is_none() {
            watch_url(r.id, log.clone(), tx.clone(), wake.clone());
        }
        out.push(Proc {
            id: r.id,
            name: r.name,
            lead: r.lead,
            owner: r.owner,
            cmd: r.cmd,
            pid,
            started: Instant::now(),
            log,
            url: r.url,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_a_log_to_its_end() {
        let p = std::env::temp_dir().join(format!("harbor-proc-trim-{}.log", std::process::id()));
        let lines: String = (0..1000).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&p, &lines).unwrap();
        trim(&p, 100).unwrap();
        let t = std::fs::read_to_string(&p).unwrap();
        assert!(t.starts_with("[… earlier output cut by Harbor]\nline 9"), "{t}");
        assert!(t.ends_with("line 999\n") && t.len() < 150);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn reaps_only_inherited_children() {
        let before = uptime_ticks().unwrap();
        let mut ended = Command::new("true").spawn().unwrap();
        let pid = ended.id();
        while std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| !s.rsplit_once(')').unwrap().1.trim_start().starts_with('Z')) {
            std::thread::sleep(Duration::from_millis(10));
        }
        // Born after `born`: this image's own child, left alone.
        assert!(!children_before(before).iter().any(|k| k.0 == pid));
        // Born before it: an inherited one, reaped once it has ended.
        let born = uptime_ticks().unwrap() + 1;
        assert!(children_before(born).contains(&(pid, true)));
        reap(pid);
        assert!(std::fs::metadata(format!("/proc/{pid}")).is_err(), "reaped");
        assert!(ended.try_wait().is_err(), "nothing left to wait for");
    }

    #[test]
    fn finds_a_process_group() {
        let mut c = Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
        assert_eq!(group(c.id()), vec![c.id()]);
        let _ = c.kill();
        let _ = c.wait();
        assert!(group(c.id()).is_empty());
    }
}
