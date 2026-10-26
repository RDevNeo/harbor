//! Provider CLI updates (Claude Code, Codex, Gemini, …). Now and then Harbor asks npm's
//! registry for each installed CLI's latest version and compares it with `<cli> --version`.
//! What's behind shows as the "Updates available" pop-up (desktop and phone), whose Update
//! button runs each CLI's own updater right here: `claude update`, `opencode upgrade`, and
//! `npm i -g <package>@latest` for the npm ones. Cursor and Meta publish no version to compare.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use eframe::egui;

use crate::providers::{self, Kind};

const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
/// The first check waits a little, so starting Harbor stays quick.
const FIRST_CHECK: Duration = Duration::from_secs(45);

#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub kind: Kind,
    pub current: String,
    pub latest: String,
}

#[derive(Clone, Debug, Default)]
pub struct Status {
    /// Providers with a newer version out, in Kind::ALL order.
    pub items: Vec<Pending>,
    /// Checking or updating.
    pub busy: bool,
    pub updating: bool,
    /// The last update's failure, per provider.
    pub error: Option<String>,
    /// "Codex and Claude are up to date" for a moment after an update.
    pub done: Option<(String, Instant)>,
}

static STATUS: Mutex<Option<Status>> = Mutex::new(None);
static LAST_CHECK: Mutex<Option<Instant>> = Mutex::new(None);
static STARTED: Mutex<Option<Instant>> = Mutex::new(None);

pub fn status() -> Status {
    STATUS.lock().unwrap().clone().unwrap_or_default()
}

fn with(f: impl FnOnce(&mut Status)) {
    f(STATUS.lock().unwrap().get_or_insert_with(Status::default));
}

/// Closing the pop-up after an update forgets how it went.
pub fn clear_outcome() {
    with(|s| {
        s.error = None;
        s.done = None;
    });
}

/// The npm package a CLI's version is looked up in.
fn package(kind: Kind) -> Option<&'static str> {
    match kind {
        Kind::Claude => Some("@anthropic-ai/claude-code"),
        Kind::Codex => Some("@openai/codex"),
        Kind::Gemini => Some("@google/gemini-cli"),
        Kind::Grok => Some("@xai-official/grok"),
        Kind::OpenCode => Some("opencode-ai"),
        Kind::Cursor | Kind::Meta => None,
    }
}

/// Its logo in the phone's assets (assets/logos, as src/logos.rs draws it).
pub fn logo_file(kind: Kind) -> &'static str {
    match kind {
        Kind::Claude => "p-claude-color.rgba",
        Kind::Codex => "p-openai.a8",
        Kind::Cursor => "p-cursor.a8",
        Kind::Grok => "p-grok.a8",
        Kind::Gemini => "p-gemini-color.rgba",
        Kind::Meta => "p-meta-color.rgba",
        Kind::OpenCode => "p-opencode.a8",
    }
}

/// How a CLI updates itself: Claude and OpenCode have their own updater (whatever installed
/// them); the others are npm packages.
fn update_cmd(kind: Kind, bin: &Path) -> Vec<String> {
    let b = bin.to_string_lossy().into_owned();
    match kind {
        Kind::Claude => vec![b, "update".into()],
        Kind::OpenCode => vec![b, "upgrade".into()],
        _ => vec!["npm".into(), "i".into(), "-g".into(), format!("{}@latest", package(kind).unwrap_or_default())],
    }
}

/// The first x.y.z in `claude --version` ("2.0.14 (Claude Code)"), `codex --version`
/// ("codex-cli 0.46.0"), …
pub fn parse_version(out: &str) -> Option<String> {
    out.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',')
        .map(|w| w.trim_start_matches('v'))
        .find(|w| {
            let core = w.split(['-', '+']).next().unwrap_or("");
            let parts: Vec<&str> = core.split('.').collect();
            parts.len() >= 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        })
        .map(String::from)
}

fn run(argv: &[String], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(&argv[0])
        .args(&argv[1..])
        .env("PATH", providers::child_path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", argv[0]))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(text)
    } else {
        let last = text.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("failed").to_string();
        Err(last)
    }
}

fn latest(pkg: &str) -> Option<String> {
    let out = Command::new("curl")
        .args(["-fsSL", "--retry", "1", "--connect-timeout", "10", "--max-time", "30"])
        .arg(format!("https://registry.npmjs.org/{pkg}/latest"))
        .output()
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    v["version"].as_str().map(String::from)
}

/// The installed CLIs worth checking: one per kind (Claude's accounts share a binary).
pub fn installed(accounts: &[providers::Account]) -> Vec<(Kind, PathBuf)> {
    let mut out: Vec<(Kind, PathBuf)> = vec![];
    for a in accounts {
        if let Some(b) = &a.bin {
            if package(a.kind).is_some() && !out.iter().any(|(k, _)| *k == a.kind) {
                out.push((a.kind, b.clone()));
            }
        }
    }
    out
}

fn find(bins: &[(Kind, PathBuf)]) -> Vec<Pending> {
    let mut found = vec![];
    for (kind, bin) in bins {
        let Some(current) = run(&[bin.to_string_lossy().into_owned(), "--version".into()], Duration::from_secs(20)).ok().and_then(|o| parse_version(&o)) else { continue };
        let Some(latest) = package(*kind).and_then(latest) else { continue };
        if crate::update::newer(&latest, &current) {
            found.push(Pending { kind: *kind, current, latest });
        }
    }
    found
}

/// Called every frame: checks soon after start and every few hours.
pub fn tick(ctx: &egui::Context, accounts: &[providers::Account]) {
    let started = *STARTED.lock().unwrap().get_or_insert_with(Instant::now);
    let due = match *LAST_CHECK.lock().unwrap() {
        None => started.elapsed() >= FIRST_CHECK,
        Some(t) => t.elapsed() >= CHECK_EVERY,
    };
    if due && !status().busy {
        check(ctx, installed(accounts));
    }
}

pub fn check(ctx: &egui::Context, bins: Vec<(Kind, PathBuf)>) {
    *LAST_CHECK.lock().unwrap() = Some(Instant::now());
    with(|s| s.busy = true);
    let ctx = ctx.clone();
    std::thread::spawn(move || {
        let found = find(&bins);
        with(|s| {
            s.items = found;
            s.busy = false;
        });
        ctx.request_repaint();
    });
}

/// "Codex and Claude", "Codex, Gemini and Claude".
pub fn names(items: &[Pending]) -> String {
    let n: Vec<&str> = items.iter().map(|p| p.kind.label()).collect();
    match n.as_slice() {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// What a dismissal remembers: the versions on offer, so the next ones show again.
pub fn key(items: &[Pending]) -> String {
    items.iter().map(|p| format!("{}={}", p.kind.label().to_lowercase(), p.latest)).collect::<Vec<_>>().join(",")
}

/// The Update button: updates every pending provider, one after the other, then looks again.
/// False when there is nothing to update or it's already busy.
pub fn update_all(ctx: &egui::Context, accounts: &[providers::Account]) -> bool {
    let st = status();
    if st.busy || st.items.is_empty() {
        return false;
    }
    let bins = installed(accounts);
    let todo: Vec<(Kind, PathBuf)> = bins.iter().filter(|(k, _)| st.items.iter().any(|p| p.kind == *k)).cloned().collect();
    with(|s| {
        s.busy = true;
        s.updating = true;
        s.error = None;
        s.done = None;
    });
    let ctx = ctx.clone();
    std::thread::spawn(move || {
        let mut failed = vec![];
        let mut ok = vec![];
        for (kind, bin) in &todo {
            match run(&update_cmd(*kind, bin), Duration::from_secs(600)) {
                Ok(_) => ok.push(*kind),
                Err(e) => failed.push(format!("{}: {e}", kind.label())),
            }
            ctx.request_repaint();
        }
        let found = find(&bins);
        *LAST_CHECK.lock().unwrap() = Some(Instant::now());
        with(|s| {
            let updated: Vec<Pending> = ok.iter().filter(|k| !found.iter().any(|p| p.kind == **k)).map(|k| Pending { kind: *k, current: String::new(), latest: String::new() }).collect();
            if !updated.is_empty() {
                let n = names(&updated);
                s.done = Some((format!("{n} {} up to date", if updated.len() == 1 { "is" } else { "are" }), Instant::now()));
            }
            s.items = found;
            s.error = (!failed.is_empty()).then(|| failed.join("; "));
            s.busy = false;
            s.updating = false;
        });
        ctx.request_repaint();
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_from_cli_output() {
        assert_eq!(parse_version("2.0.14 (Claude Code)\n").as_deref(), Some("2.0.14"));
        assert_eq!(parse_version("codex-cli 0.46.0").as_deref(), Some("0.46.0"));
        assert_eq!(parse_version("v1.2.3-beta.1").as_deref(), Some("1.2.3-beta.1"));
        assert_eq!(parse_version("opencode 0.15"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn names_and_keys() {
        let p = |kind, latest: &str| Pending { kind, current: "0.1.0".into(), latest: latest.into() };
        assert_eq!(names(&[p(Kind::Codex, "1.0.0")]), "Codex");
        assert_eq!(names(&[p(Kind::Codex, "1.0.0"), p(Kind::Claude, "2.0.0")]), "Codex and Claude");
        assert_eq!(names(&[p(Kind::Codex, "1.0.0"), p(Kind::Gemini, "1.0.0"), p(Kind::Claude, "2.0.0")]), "Codex, Gemini and Claude");
        assert_eq!(key(&[p(Kind::Codex, "1.0.0"), p(Kind::Claude, "2.0.0")]), "codex=1.0.0,claude=2.0.0");
    }
}
