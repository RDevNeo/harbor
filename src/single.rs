//! One Harbor per session: an flock on `harbor.lock`, beside the control socket.
//! A second launch asks the running Harbor to come to the front and exits.
//! The kernel drops the lock when its holder dies (even on kill -9), so a crash
//! never blocks the next start. Another XDG_RUNTIME_DIR (or HARBOR_SOCK) means
//! another socket and lock, so headless test instances run side by side.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Held for the life of the process. Opened close-on-exec, so a hot reload's exec
/// releases it and the new image (same pid) takes it straight back.
static LOCK: OnceLock<File> = OnceLock::new();

/// Set by reload.rs on the exec: this pid is a hot reload, not a second launch.
pub const RELOADED_PID: &str = "HARBOR_RELOADED_PID";

fn lock_path() -> PathBuf {
    crate::control::socket_path().with_extension("lock")
}

/// Takes the instance lock. False when another Harbor holds it.
pub fn acquire() -> bool {
    let path = lock_path();
    let Ok(f) = OpenOptions::new().create(true).write(true).truncate(false).open(&path) else {
        // No lock file (read-only runtime dir?): don't keep Harbor from starting.
        return true;
    };
    // After a hot reload the lock was released by the exec a moment ago.
    let reloaded = std::env::var(RELOADED_PID).ok().and_then(|p| p.parse::<u32>().ok()) == Some(std::process::id());
    let deadline = Instant::now() + if reloaded { Duration::from_secs(3) } else { Duration::ZERO };
    loop {
        match f.try_lock() {
            Ok(()) => {
                let _ = f.set_len(0);
                let _ = writeln!(&f, "{}", std::process::id());
                let _ = LOCK.set(f);
                return true;
            }
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(TryLockError::WouldBlock) => return false,
            // A filesystem without locks: run rather than refuse.
            Err(TryLockError::Error(_)) => return true,
        }
    }
}

/// Asks the running Harbor to show itself; true when it answered. Retries for a
/// few seconds, in case it is still starting and hasn't opened its socket yet.
pub fn focus_running() -> bool {
    let path = crate::control::socket_path();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(s) = UnixStream::connect(&path) {
            let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
            let mut w = &s;
            if writeln!(w, "{}", serde_json::json!({ "focus": true })).is_ok() {
                let mut line = String::new();
                if BufReader::new(&s).read_line(&mut line).is_ok() && line.contains("\"ok\":true") {
                    return true;
                }
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Raises this process's window through the compositor (Wayland clients can't
/// raise themselves). False when there is no compositor IPC to ask.
pub fn raise() -> bool {
    let pid = std::process::id();
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
        // With the Lua config `hyprctl dispatch` takes a Lua expression; otherwise
        // the legacy dispatcher. hyprctl prints "ok" when it worked.
        let hypr = |args: &[&str]| Command::new("hyprctl").args(args).output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "ok");
        return hypr(&["dispatch", &format!("hl.dsp.focus({{ window = \"pid:{pid}\" }})")]) || hypr(&["dispatch", "focuswindow", &format!("pid:{pid}")]);
    }
    if std::env::var_os("SWAYSOCK").is_some() {
        return Command::new("swaymsg").arg(format!("[pid={pid}] focus")).output().is_ok_and(|o| o.status.success());
    }
    false
}
