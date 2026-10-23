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

    /// Stops the whole process group (npm → node → vite…).
    pub fn stop(&self) {
        let _ = Command::new("kill").args(["-TERM", "--", &format!("-{}", self.pid)]).status();
    }
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
        std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&log).map_err(|e| e.to_string())?
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
