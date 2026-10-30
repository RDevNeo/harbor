//! Holding Discord's page still while nothing needs it: a frozen client uses no CPU and, once its
//! memory is reclaimed, almost no RAM (with swap or zram), and a tool call has it back in a fraction
//! of a second instead of the 10 to 15 s of a cold start.
//!
//! Frozen through cgroup v2, so nothing inside can notice or race it: the shell runs in its own
//! systemd --user scope, and every cgroup its processes are in is frozen, because Chromium can
//! move its main process to a second one. A cgroup with anything else in it is left alone, and then
//! (as with no cgroups at all) the tree gets SIGSTOP instead. Without swap a freeze saves less,
//! only the file pages, but it's still a client that isn't running.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Reclaimed a little at a time: a tool call shouldn't wait for it, and all at once is hard on a PC.
const STEP: &str = "32M";
const PAUSE: Duration = Duration::from_millis(30);
/// Below this there's nothing left worth the writes.
const ENOUGH: u64 = 16 << 20;

/// What a freeze did, to undo it.
#[derive(Debug, PartialEq)]
pub enum Held {
    Cgroups(Vec<PathBuf>),
    Signals(Vec<i32>),
}

impl Held {
    pub fn word(&self) -> &'static str {
        match self {
            Held::Cgroups(_) => "cgroup",
            Held::Signals(_) => "signals",
        }
    }
}

/// `leader`'s process group and everything under it.
pub fn tree(leader: i32) -> Vec<i32> {
    let mut all: Vec<(i32, i32, i32)> = vec![];
    for e in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = e.file_name().to_string_lossy().parse::<i32>().ok() else { continue };
        let Ok(st) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
        // pid (comm) state ppid pgrp …: comm can hold anything, so from the last ')'.
        let rest: Vec<&str> = st.rsplit_once(')').map(|x| x.1).unwrap_or("").split_whitespace().collect();
        if let (Some(ppid), Some(pgrp)) = (rest.get(1).and_then(|s| s.parse().ok()), rest.get(2).and_then(|s| s.parse().ok())) {
            all.push((pid, ppid, pgrp));
        }
    }
    let mut set: Vec<i32> = all.iter().filter(|p| p.0 == leader || p.2 == leader).map(|p| p.0).collect();
    loop {
        let more: Vec<i32> = all.iter().filter(|p| !set.contains(&p.0) && set.contains(&p.1)).map(|p| p.0).collect();
        if more.is_empty() {
            return set;
        }
        set.extend(more);
    }
}

/// The cgroup a /proc/<pid>/cgroup file names, under `root`; only the unified (v2) line counts.
fn cgroup_in(text: &str, root: &Path) -> Option<PathBuf> {
    let rel = text.lines().find_map(|l| l.strip_prefix("0::"))?.trim_start_matches('/');
    (!rel.is_empty()).then(|| root.join(rel))
}

fn cgroups(pids: &[i32]) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = pids.iter().filter_map(|p| cgroup_in(&std::fs::read_to_string(format!("/proc/{p}/cgroup")).ok()?, Path::new("/sys/fs/cgroup"))).collect();
    v.sort();
    v.dedup();
    v
}

/// Whether a cgroup holds only these processes: freezing anything else would be a disaster.
fn only(procs: &str, pids: &[i32]) -> bool {
    procs.split_whitespace().filter_map(|p| p.parse::<i32>().ok()).all(|p| pids.contains(&p))
}

fn ours(cg: &Path, pids: &[i32]) -> bool {
    cg.join("cgroup.freeze").exists() && std::fs::read_to_string(cg.join("cgroup.procs")).is_ok_and(|p| only(&p, pids))
}

fn set_frozen(cg: &Path, on: bool) -> bool {
    std::fs::write(cg.join("cgroup.freeze"), if on { "1" } else { "0" }).is_ok()
}

fn frozen(cg: &Path) -> bool {
    std::fs::read_to_string(cg.join("cgroup.events")).is_ok_and(|e| e.lines().any(|l| l == "frozen 1"))
}

fn by_cgroups(pids: &[i32]) -> Option<Held> {
    if std::env::var_os("HARBOR_DISCORD_NO_CGROUP").is_some() {
        return None;
    }
    let cgs = cgroups(pids);
    if cgs.is_empty() || !cgs.iter().all(|c| ours(c, pids)) {
        return None;
    }
    let held = Held::Cgroups(cgs.clone());
    if !cgs.iter().all(|c| set_frozen(c, true)) {
        thaw(&held);
        return None;
    }
    let until = Instant::now() + Duration::from_secs(3);
    while !cgs.iter().all(|c| frozen(c)) {
        if Instant::now() > until {
            thaw(&held);
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Some(held)
}

fn signal(pids: &[i32], sig: rustix::process::Signal) {
    for p in pids.iter().filter_map(|p| rustix::process::Pid::from_raw(*p)) {
        let _ = rustix::process::kill_process(p, sig);
    }
}

/// Stops `leader`'s whole tree.
pub fn freeze(leader: i32) -> Result<Held, String> {
    let pids = tree(leader);
    if pids.is_empty() {
        return Err("nothing to freeze".into());
    }
    if let Some(h) = by_cgroups(&pids) {
        return Ok(h);
    }
    signal(&pids, rustix::process::Signal::STOP);
    Ok(Held::Signals(pids))
}

pub fn thaw(h: &Held) {
    match h {
        Held::Cgroups(cgs) => {
            for c in cgs {
                set_frozen(c, false);
            }
        }
        Held::Signals(pids) => signal(pids, rustix::process::Signal::CONT),
    }
}

/// Pushes a frozen client's memory out, until there's little left, the kernel can't take more, or
/// `stop` says a tool call wants it back. Only a cgroup can do this.
pub fn reclaim(h: &Held, stop: &AtomicBool) {
    let Held::Cgroups(cgs) = h else { return };
    for c in cgs {
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let left: u64 = std::fs::read_to_string(c.join("memory.current")).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
            // The kernel says no once it can't free what was asked: without swap, soon.
            if left < ENOUGH || std::fs::write(c.join("memory.reclaim"), STEP).is_err() {
                break;
            }
            std::thread::sleep(PAUSE);
        }
    }
}

/// Clears what a dead host left: a shell can't notice its pipe closed while it's frozen.
pub fn kill_left_over(leader: i32) {
    let pids = tree(leader);
    thaw(&Held::Cgroups(cgroups(&pids).into_iter().filter(|c| ours(c, &pids)).collect()));
    signal(&pids, rustix::process::Signal::CONT);
    if let Some(p) = rustix::process::Pid::from_raw(leader) {
        let _ = rustix::process::kill_process_group(p, rustix::process::Signal::KILL);
    }
    signal(&pids, rustix::process::Signal::KILL);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    #[test]
    fn reads_the_unified_cgroup_line() {
        let root = Path::new("/sys/fs/cgroup");
        assert_eq!(cgroup_in("0::/user.slice/a.scope\n", root), Some(root.join("user.slice/a.scope")));
        assert_eq!(cgroup_in("1:name=x:/y\n0::/z\n", root), Some(root.join("z")));
        // The root, or cgroup v1 only: nothing that can be frozen.
        assert_eq!(cgroup_in("0::/\n", root), None);
        assert_eq!(cgroup_in("1:name=x:/y\n", root), None);
    }

    #[test]
    fn a_cgroup_with_anyone_else_in_it_isnt_ours() {
        assert!(only("10\n11\n", &[10, 11, 12]));
        assert!(!only("10\n99\n", &[10, 11]));
    }

    #[test]
    fn signals_hold_a_tree_and_let_it_go() {
        // A process group of a shell and a child, frozen without cgroups.
        let mut c = Command::new("sh").args(["-c", "sleep 30 & wait"]).stdout(Stdio::null()).process_group(0).spawn().unwrap();
        let leader = c.id() as i32;
        std::thread::sleep(Duration::from_millis(100));
        let pids = tree(leader);
        assert_eq!(pids.len(), 2, "{pids:?}");
        let state = |p: i32| std::fs::read_to_string(format!("/proc/{p}/stat")).unwrap().rsplit_once(')').unwrap().1.split_whitespace().next().unwrap().to_string();
        signal(&pids, rustix::process::Signal::STOP);
        std::thread::sleep(Duration::from_millis(50));
        assert!(pids.iter().all(|p| state(*p) == "T"));
        thaw(&Held::Signals(pids.clone()));
        std::thread::sleep(Duration::from_millis(50));
        assert!(pids.iter().all(|p| state(*p) != "T"));
        kill_left_over(leader);
        let _ = c.wait();
    }
}
