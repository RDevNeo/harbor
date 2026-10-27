//! Small, on-demand git queries. Nothing polls in the background.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub struct Status {
    pub branch: String,
    pub changed: usize,
    pub ahead: usize,
    pub behind: usize,
    pub remote: Option<String>,
    /// origin's URL as configured (`remote` is its web address).
    pub origin: Option<String>,
}

/// How long a git query may take before it's killed (a hung mount, a held lock).
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// `cmd.output()`, but the child is killed once `limit` has passed (ErrorKind::TimedOut).
pub fn output_within(cmd: &mut Command, limit: Duration) -> std::io::Result<Output> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    // Read both pipes on threads, so a chatty child never blocks on a full pipe.
    fn drain<R: std::io::Read + Send + 'static>(p: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut v = vec![];
            if let Some(mut p) = p {
                let _ = p.read_to_end(&mut v);
            }
            v
        })
    }
    let (out, err) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break st;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("timed out after {}s", limit.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(Output { status, stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() })
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    // No optional locks: a status never holds (or waits on) index.lock. No fsmonitor: a
    // repo's own config could name any command for it, and these run unasked.
    let mut cmd = Command::new("git");
    cmd.env("GIT_OPTIONAL_LOCKS", "0").args(["-c", "core.fsmonitor=false"]).arg("-C").arg(dir).args(args);
    let out = output_within(&mut cmd, GIT_TIMEOUT).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn status(dir: &Path) -> Option<Status> {
    let porcelain = git(dir, &["status", "--porcelain=v2", "--branch"])?;
    let mut s = Status::default();
    for l in porcelain.lines() {
        if let Some(b) = l.strip_prefix("# branch.head ") {
            s.branch = b.into();
        } else if let Some(ab) = l.strip_prefix("# branch.ab ") {
            let mut it = ab.split_whitespace();
            s.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            s.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if !l.starts_with('#') {
            s.changed += 1;
        }
    }
    s.origin = origin(dir);
    s.remote = s.origin.as_deref().map(web_url);
    Some(s)
}

/// origin's URL of the repository at `dir`, as configured.
pub fn origin(dir: &Path) -> Option<String> {
    git(dir, &["remote", "get-url", "origin"]).filter(|u| !u.is_empty())
}

/// git@github.com:a/b.git and https://github.com/a/b.git both become https://github.com/a/b
pub fn web_url(u: &str) -> String {
    let u = u.trim().trim_end_matches(".git");
    // ssh://git@host[:port]/owner/repo
    if let Some(rest) = u.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map_or(rest, |x| x.1);
        if let Some((host, path)) = rest.split_once('/') {
            return format!("https://{}/{path}", host.split(':').next().unwrap_or(host));
        }
    }
    if let Some(rest) = u.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':') {
            return format!("https://{host}/{path}");
        }
    }
    u.to_string()
}

/// Finds git repositories up to two levels under the usual project folders.
pub fn discover() -> Vec<PathBuf> {
    let home = crate::store::home();
    let roots = ["Projects", "projects", "work", "Work", "code", "src", "dev", "Documents"];
    let mut found = vec![];
    for r in roots {
        let root = home.join(r);
        scan(&root, 0, &mut found);
    }
    found.sort();
    found.dedup();
    found
}

fn scan(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if dir.join(".git").exists() {
        out.push(dir.to_path_buf());
        return;
    }
    if depth >= 2 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name();
        let n = name.to_string_lossy();
        if n.starts_with('.') || n == "node_modules" || n == "target" {
            continue;
        }
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            scan(&e.path(), depth + 1, out);
        }
    }
}

pub fn open_url(url: &str) {
    // Waited on a thread, so a finished xdg-open doesn't linger as a zombie.
    let url = url.to_string();
    std::thread::spawn(move || {
        let _ = Command::new("xdg-open").arg(url).status();
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn ssh_remotes_have_web_urls() {
        for u in ["git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "ssh://git@github.com:22/o/r", "https://github.com/o/r.git"] {
            assert_eq!(super::web_url(u), "https://github.com/o/r", "{u}");
        }
    }

    #[test]
    fn status_ignores_repo_fsmonitor() {
        let dir = std::env::temp_dir().join(format!("harbor-fsm-{}", std::process::id()));
        let marker = dir.with_extension("ran");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&marker);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| std::process::Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap();
        git(&["init", "-q"]);
        git(&["config", "core.fsmonitor", &format!("touch {}", marker.display())]);
        assert!(super::status(&dir).is_some());
        assert!(!marker.exists(), "git status ran the repo's fsmonitor command");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
