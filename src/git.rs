//! Small, on-demand git queries. Nothing polls in the background.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Default)]
pub struct Status {
    pub branch: String,
    pub changed: usize,
    pub ahead: usize,
    pub behind: usize,
    pub remote: Option<String>,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
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
    s.remote = git(dir, &["remote", "get-url", "origin"]).map(|u| web_url(&u));
    Some(s)
}

/// git@github.com:a/b.git and https://github.com/a/b.git both become https://github.com/a/b
fn web_url(u: &str) -> String {
    let u = u.trim_end_matches(".git");
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
