//! Live previews: a build of a change, straight from `scripts/boat/dev`, running on this PC within
//! seconds. Unoptimised, untested and unsigned, so it's off unless this PC's owner turns it on
//! (Settings › Updates, `harbor preview on`); the setting is a file in the install, so it never
//! travels with the account.
//!
//! The signed release stays where it was, untouched: a preview sits beside it (`harbor-preview`,
//! with `preview.json` saying what it is) and the release starts it. So the updater, the
//! `.previous` copy and every path a helper uses work as before, and the way back is always there:
//!
//! - Harbor restarts into a preview at once (reload.rs: same pid, agent turns carry on), skipping
//!   the wait for a quiet moment that a release gets.
//! - The release leaves a watchdog behind first (`harbor preview-watch`). A preview that exits or
//!   shows no frame in [`START_LIMIT`] is marked failed and the release is started in its place.
//!   Where the watchdog dies with it (a systemd unit), the next launch finds the attempt
//!   unconfirmed and stays on the release.
//! - "Back to the release" (`harbor preview back`) restarts into the release.
//! - A newer signed release replaces a preview: the updater compares against the release on disk,
//!   not this build, and installs it whatever Settings › Updates says.
//!
//! Other PCs get a preview over the mesh's pinned TLS, the channel they already trust: a PC takes
//! one only if it's turned on there and the sender may run anything on it anyway
//! (`machines::Level::Full`), so no new trust is added and no key is needed. The sender says what
//! it has (`POST /mesh/v1/preview`); the PC fetches the small patch against the preview it runs,
//! or else the whole binary (`GET /mesh/v1/preview/file`), and checks its SHA-256.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The preview, beside `harbor`.
const SLOT: &str = "harbor-preview";
/// What it is and how its start went.
const META: &str = "preview.json";
/// There: this PC takes previews.
const OPT_IN: &str = ".preview";
/// The SHA-256 of `harbor-preview`, kept after going back: the next patch may start from it.
const SLOT_SHA: &str = "harbor-preview.sha256";
/// What this PC offers other PCs: `harbor`, `patch`, `offer.json`.
const OUT: &str = "preview-out";
/// Started by the release: watches a preview's start.
pub const WATCH_ARG: &str = "preview-watch";
/// A preview has this long to show its first frame.
const START_LIMIT: Duration = Duration::from_secs(30);
/// ... and has to stay up this long after it to count as started.
const SETTLE: Duration = Duration::from_secs(2);
/// zstd's window: it has to span the whole binary for a patch to find it.
const WINDOW: &str = "--long=28";

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// Waiting for its first frames.
    #[default]
    Trying,
    Ok,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Meta {
    /// A short name for this build (`scripts/boat/dev`: commit and a hash of the changes).
    pub id: String,
    pub sha256: String,
    /// Its Cargo version.
    pub version: String,
    /// What it holds, in a few words.
    #[serde(default)]
    pub note: String,
    /// The PC it came from ("" this one).
    #[serde(default)]
    pub from: String,
    /// Unix time it got here.
    pub at: i64,
    pub stage: Stage,
    /// Why it failed.
    #[serde(default)]
    pub why: String,
    /// When its first frame came, in Unix milliseconds (0: not yet).
    #[serde(default)]
    pub shown_ms: i64,
}

fn dir() -> Option<PathBuf> {
    crate::update::install_dir()
}

static WAKE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// How a thread gets the UI to look at what it sent.
pub fn set_wake(f: impl Fn() + Send + Sync + 'static) {
    let _ = WAKE.set(Box::new(f));
}

pub fn wake() {
    if let Some(f) = WAKE.get() {
        f();
    }
}

/// This process is a preview.
pub fn running() -> bool {
    static RUNNING: OnceLock<bool> = OnceLock::new();
    *RUNNING.get_or_init(|| crate::update::self_exe().is_some_and(|e| e.file_name().is_some_and(|n| n == SLOT)))
}

/// This PC takes previews.
pub fn enabled() -> bool {
    dir().is_some_and(|d| d.join(OPT_IN).is_file())
}

pub fn set_enabled(on: bool) -> Result<(), String> {
    let d = dir().ok_or("this copy wasn't installed by install.sh")?;
    let p = d.join(OPT_IN);
    if on { std::fs::write(p, "").map_err(|e| e.to_string()) } else { std::fs::remove_file(p).or_else(|_| Ok::<(), std::io::Error>(())).map_err(|e| e.to_string()) }
}

fn read_meta(d: &Path) -> Option<Meta> {
    serde_json::from_str(&std::fs::read_to_string(d.join(META)).ok()?).ok()
}

fn write_meta(d: &Path, m: &Meta) -> Result<(), String> {
    let tmp = d.join(format!("{META}.new"));
    std::fs::write(&tmp, serde_json::to_string(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, d.join(META)).map_err(|e| e.to_string())
}

/// The preview this PC has now, whatever became of it.
pub fn meta() -> Option<Meta> {
    read_meta(&dir()?)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn sha256(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut d = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        d.update(&buf[..n]);
    }
    Ok(d.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

/// "harbor 0.101.0 (abcdef0)" → "0.101.0".
fn version_in(line: &str) -> Option<String> {
    let mut w = line.split_whitespace();
    (w.next() == Some("harbor")).then(|| w.next().map(String::from)).flatten()
}

/// Runs the build once, to see that it starts at all on this system; its version.
fn smoke(exe: &Path) -> Result<String, String> {
    let mut c = Command::new(exe).arg("--version").stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("it doesn't run here: {e}"))?;
    let start = Instant::now();
    loop {
        match c.try_wait().map_err(|e| e.to_string())? {
            Some(s) if s.success() => break,
            Some(s) => return Err(format!("it doesn't run here: {s}")),
            None if start.elapsed() > Duration::from_secs(10) => {
                let _ = c.kill();
                let _ = c.wait();
                return Err("it doesn't answer --version".into());
            }
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    let mut out = String::new();
    c.stdout.take().ok_or("no output")?.read_to_string(&mut out).map_err(|e| e.to_string())?;
    version_in(&out).ok_or_else(|| "that isn't Harbor".to_string())
}

/// A release newer than a build replaces it, and such a build isn't taken.
fn superseded(version: &str, release: Option<&str>) -> bool {
    release.is_some_and(|r| crate::update::newer(r, version))
}

/// Puts a build in the slot: the next restart runs it. `src` is left where it is.
fn install(d: &Path, src: &Path, id: &str, note: &str, from: &str) -> Result<Meta, String> {
    let new = d.join(format!("{SLOT}.new"));
    std::fs::copy(src, &new).map_err(|e| format!("{}: {e}", new.display()))?;
    let r = (|| {
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        let version = smoke(&new)?;
        let release = crate::update::on_disk();
        if superseded(&version, release.as_deref()) {
            return Err(format!("this build is {version}, older than the release here ({})", release.unwrap_or_default()));
        }
        let sha = sha256(&new)?;
        let name = |s: &str, n: usize| s.chars().take(n).collect::<String>();
        let m = Meta { id: name(id, 40), sha256: sha.clone(), version, note: name(note, 120), from: from.into(), at: crate::store::now(), stage: Stage::Trying, ..Default::default() };
        // Renamed over: a preview running from it keeps its own file.
        std::fs::rename(&new, d.join(SLOT)).map_err(|e| e.to_string())?;
        std::fs::write(d.join(SLOT_SHA), &sha).map_err(|e| e.to_string())?;
        write_meta(d, &m)?;
        Ok(m)
    })();
    if r.is_err() {
        let _ = std::fs::remove_file(&new);
    }
    r
}

/// What another PC is told about a build.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Offer {
    pub id: String,
    pub sha256: String,
    #[serde(default)]
    pub note: String,
    /// The binary `patch` starts from ("" no patch).
    #[serde(default)]
    pub base: String,
}

fn offered(d: &Path) -> PathBuf {
    d.join(OUT)
}

/// Keeps a build for other PCs to fetch.
fn offer(d: &Path, src: &Path, patch: Option<(&Path, &str)>, o: &Offer) -> Result<(), String> {
    let out = offered(d);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let tmp = out.join("harbor.new");
    std::fs::copy(src, &tmp).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, out.join("harbor")).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(out.join("patch"));
    if let Some((p, _)) = patch {
        std::fs::copy(p, out.join("patch")).map_err(|e| e.to_string())?;
    }
    std::fs::write(out.join("offer.json"), serde_json::to_string(o).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// `{"preview": {path, id, note, patch, base}}` on the control socket (`harbor preview push`).
/// The build goes in the slot when this PC takes previews, and on offer to the others either way.
/// Answers whether this PC restarts into it, and the offer to send.
pub fn received(v: &Value) -> Result<(bool, Offer), String> {
    let d = dir().ok_or("this copy wasn't installed by install.sh")?;
    let s = |k: &str| v[k].as_str().unwrap_or("");
    let src = PathBuf::from(s("path"));
    let patch = Some(s("patch")).filter(|p| !p.is_empty()).map(PathBuf::from);
    let here = if d.join(OPT_IN).is_file() { Some(install(&d, &src, s("id"), s("note"), "")?) } else { None };
    let sha = match &here {
        Some(m) => m.sha256.clone(),
        None => sha256(&src)?,
    };
    let base = if patch.is_some() { s("base").to_string() } else { String::new() };
    let o = Offer { id: s("id").into(), sha256: sha, note: s("note").into(), base: base.clone() };
    offer(&d, &src, patch.as_deref().map(|p| (p, base.as_str())), &o)?;
    Ok((here.is_some(), o))
}

/// A file of this PC's offer, for `GET /mesh/v1/preview/file`.
pub fn offered_file(kind: &str, id: &str) -> Option<PathBuf> {
    let out = offered(&dir()?);
    let o: Offer = serde_json::from_str(&std::fs::read_to_string(out.join("offer.json")).ok()?).ok()?;
    let p = out.join(match kind {
        "patch" => "patch",
        "binary" => "harbor",
        _ => return None,
    });
    (o.id == id && p.is_file()).then_some(p)
}

/// Whether a PC takes a preview from `peer`; why not, when it doesn't.
pub fn refuses(full_access: bool) -> Option<&'static str> {
    if !enabled() {
        Some("previews are off on this PC")
    } else if !full_access {
        Some("this PC doesn't give that one full access (Settings › Devices)")
    } else {
        None
    }
}

/// Brings a build offered by another PC here. `get` fetches one of its files (`patch` or `binary`)
/// to a path. `Ok`: it's in the slot, restart into it.
pub fn fetch(o: &Offer, from: &str, get: impl Fn(&str, &Path) -> Result<(), String>) -> Result<Meta, String> {
    let d = dir().ok_or("not an installed copy")?;
    let tmp = d.join(".preview-fetch");
    let bin = tmp.with_extension("bin");
    let mine = std::fs::read_to_string(d.join(SLOT_SHA)).unwrap_or_default();
    let patched = !o.base.is_empty() && mine.trim() == o.base && (|| {
        get("patch", &tmp).ok()?;
        patch(&d.join(SLOT), &tmp, &bin).ok()?;
        (sha256(&bin).ok()? == o.sha256).then_some(())
    })().is_some();
    let r = (|| {
        if !patched {
            get("binary", &bin)?;
            if sha256(&bin)? != o.sha256 {
                return Err("the file that came isn't the one offered".to_string());
            }
        }
        eprintln!("harbor: preview {} from {from}: {}", o.id, if patched { "by patch" } else { "whole" });
        install(&d, &bin, &o.id, &o.note, from)
    })();
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(&bin);
    r
}

/// `new` from `old` and a patch made with `zstd --patch-from`.
fn patch(old: &Path, delta: &Path, new: &Path) -> Result<(), String> {
    let s = Command::new("zstd").args(["-q", "-d", "-f", WINDOW, "--patch-from"]).arg(old).arg(delta).arg("-o").arg(new).status().map_err(|e| format!("zstd: {e}"))?;
    s.success().then_some(()).ok_or_else(|| format!("zstd: {s}"))
}

/// The other PCs that would take a preview, from what they said about themselves.
pub fn takes(update: &Value) -> bool {
    update["preview_on"].as_bool() == Some(true)
}

/// The release to go back to.
fn release(d: &Path) -> PathBuf {
    d.join("harbor")
}

/// Stops the preview's being used. The file stays: agents started from it may still call it, and
/// the next patch can start from it.
fn forget(d: &Path) {
    let _ = std::fs::remove_file(d.join(META));
}

/// No more of this preview: a restart goes to the release.
pub fn give_up() {
    if let Some(d) = dir() {
        forget(&d);
    }
}

/// The file a preview watches instead of itself: the release beside it.
pub fn release_exe() -> Option<PathBuf> {
    running().then(|| dir().map(|d| release(&d))).flatten()
}

/// Leaves the watchdog behind and says what to run: the release's own copy of it, as the preview
/// may be what's wrong. `pid` is this process, which is about to become the preview.
fn arm(d: &Path, m: &mut Meta, args: &[String]) -> Result<(), String> {
    m.stage = Stage::Trying;
    m.shown_ms = 0;
    write_meta(d, m)?;
    Command::new(release(d))
        .arg(WATCH_ARG)
        .arg(std::process::id().to_string())
        .arg(&m.id)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// What a restart (reload.rs) should run, when it isn't this same file. `release_changed`: a new
/// release was installed, which replaces any preview. `args`: Harbor's own.
pub fn next_exe(release_changed: bool, args: &[String]) -> Option<PathBuf> {
    let d = dir()?;
    if !release_changed && d.join(OPT_IN).is_file() {
        if let Some(mut m) = read_meta(&d).filter(|m| m.stage != Stage::Failed) {
            return match arm(&d, &mut m, args) {
                Ok(()) => Some(d.join(SLOT)),
                Err(e) => {
                    fail(&d, &m.id, &format!("no watchdog: {e}"));
                    running().then(|| release(&d))
                }
            };
        }
    }
    if running() {
        forget(&d);
        return Some(release(&d));
    }
    None
}

/// The exec into a preview didn't happen.
pub fn exec_failed(err: &str) {
    if let (Some(d), Some(m)) = (dir(), meta()) {
        fail(&d, &m.id, err);
    }
}

fn fail(d: &Path, id: &str, why: &str) {
    if let Some(mut m) = read_meta(d).filter(|m| m.id == id) {
        m.stage = Stage::Failed;
        m.why = why.into();
        let _ = write_meta(d, &m);
    }
}

/// Right after taking the instance lock, in the release: starts the preview this PC is on, as the
/// restart would. An attempt that never got confirmed counts as failed: the watchdog may have
/// died with it.
pub fn at_start(args: &[String]) {
    if running() {
        return;
    }
    let Some(d) = dir() else { return };
    let Some(mut m) = read_meta(&d) else { return };
    if !d.join(OPT_IN).is_file() || superseded(&m.version, crate::update::on_disk().as_deref()) {
        forget(&d);
        return;
    }
    match m.stage {
        Stage::Failed => {}
        Stage::Trying => fail(&d, &m.id, "it never finished starting"),
        Stage::Ok => {
            if arm(&d, &mut m, args).is_ok() {
                let err = Command::new(d.join(SLOT)).args(args).env(crate::single::RELOADED_PID, std::process::id().to_string()).exec();
                fail(&d, &m.id, &err.to_string());
            }
        }
    }
}

/// The first tick of a preview: it got as far as drawing. Counts as started if it lives a moment.
pub fn ticked() {
    static DONE: AtomicBool = AtomicBool::new(false);
    if !running() || DONE.swap(true, Ordering::Relaxed) {
        return;
    }
    if let (Some(d), Some(mut m)) = (dir(), meta()) {
        m.shown_ms = now_ms();
        let _ = write_meta(&d, &m);
    }
    std::thread::spawn(|| {
        std::thread::sleep(SETTLE);
        if let (Some(d), Some(mut m)) = (dir(), meta()) {
            if m.stage == Stage::Trying {
                m.stage = Stage::Ok;
                let _ = write_meta(&d, &m);
            }
        }
    });
}

/// `/proc/<pid>/stat` says it's alive (a zombie isn't).
fn alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| s.rsplit_once(") ").is_some_and(|(_, rest)| !rest.starts_with(['Z', 'X'])))
}

/// `harbor preview-watch <pid> <id> <harbor's args>`: run by the release. Waits for the preview's
/// verdict; when it fails, marks it and turns into the release.
pub fn watch(args: &[String]) -> i32 {
    let (Some(pid), Some(id), Some(d)) = (args.first().and_then(|p| p.parse::<u32>().ok()), args.get(1), dir()) else { return 2 };
    let start = Instant::now();
    let why = loop {
        std::thread::sleep(Duration::from_millis(200));
        match read_meta(&d) {
            Some(m) if m.id == *id && m.stage == Stage::Trying => {}
            // It started, or a newer one took over with a watchdog of its own, or it was given up.
            _ => return 0,
        }
        if !alive(pid) {
            break "it exited while starting";
        }
        if start.elapsed() > START_LIMIT {
            let _ = rustix::process::kill_process(rustix::process::Pid::from_raw(pid as i32).expect("pid"), rustix::process::Signal::KILL);
            while alive(pid) && start.elapsed() < START_LIMIT + Duration::from_secs(5) {
                std::thread::sleep(Duration::from_millis(50));
            }
            break "it showed no frame in time";
        }
    };
    fail(&d, id, why);
    let err = Command::new(release(&d)).args(&args[2..]).env_remove("HARBOR_VIEW").env_remove("HARBOR_POINTER").exec();
    eprintln!("harbor: could not start the release: {err}");
    1
}

/// For `update::info`: what this PC says about itself.
pub fn info() -> Value {
    let on = enabled();
    json!({ "preview_on": on, "preview": if running() { meta().map(|m| json!({ "id": m.id, "note": m.note, "from": m.from, "at": m.at })) } else { None } })
}

/// "preview 1a2b3c4" while running one.
pub fn label() -> Option<String> {
    running().then(|| format!("preview {}", meta().map_or_else(|| "?".into(), |m| m.id)))
}

/// The last attempt failed, for Settings.
pub fn failed() -> Option<Meta> {
    meta().filter(|m| m.stage == Stage::Failed)
}

fn ask(v: &Value) -> Option<Value> {
    let s = std::os::unix::net::UnixStream::connect(crate::control::socket_path()).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(60)));
    let mut w = &s;
    writeln!(w, "{v}").ok()?;
    let mut line = String::new();
    BufReader::new(&s).read_line(&mut line).ok()?;
    serde_json::from_str(&line).ok()
}

const USAGE: &str = "Usage: harbor preview [status [--json]|on|off|back|push <binary> --id <id> [--note <text>] [--patch <file> --base <sha256>] [--wait]]";

/// Waits for the verdict on a build, for the script that sent it.
fn wait(d: &Path, id: &str, pushed_ms: i64) -> i32 {
    let start = Instant::now();
    loop {
        match read_meta(d).filter(|m| m.id == id) {
            Some(m) if m.stage == Stage::Ok => {
                println!("on screen {} ms after the push, confirmed {} ms after it", m.shown_ms - pushed_ms, now_ms() - pushed_ms);
                return 0;
            }
            Some(m) if m.stage == Stage::Failed => {
                eprintln!("harbor: {id} failed to start ({}): back on the release", m.why);
                return 1;
            }
            None if start.elapsed() > Duration::from_secs(5) => {
                eprintln!("harbor: {id} isn't this PC's preview any more");
                return 1;
            }
            _ if start.elapsed() > START_LIMIT + Duration::from_secs(10) => {
                eprintln!("harbor: no word from {id}");
                return 1;
            }
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

pub fn cli(args: &[String]) -> i32 {
    let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    match args.first().map(String::as_str).unwrap_or("status") {
        "status" => {
            let m = meta();
            if args.iter().any(|a| a == "--json") {
                println!("{}", json!({ "on": enabled(), "preview": m, "managed": dir().is_some() }));
            } else {
                println!("Previews are {} on this PC.", if enabled() { "on" } else { "off" });
                match m {
                    Some(m) => println!("{}: {:?}{}{}", m.id, m.stage, if m.note.is_empty() { String::new() } else { format!(", {}", m.note) }, if m.why.is_empty() { String::new() } else { format!(" ({})", m.why) }),
                    None => println!("Running the release."),
                }
            }
            0
        }
        "on" => match set_enabled(true) {
            Ok(()) => {
                println!("Previews are on: this PC restarts into a build as soon as one arrives, from this PC or another with full access here.");
                0
            }
            Err(e) => {
                eprintln!("harbor: {e}");
                1
            }
        },
        "off" | "back" => {
            let off = args[0] == "off";
            if ask(&json!({ "preview_back": true, "off": off })).is_none() {
                // No Harbor running: the next start finds nothing to run.
                give_up();
                if off {
                    let _ = set_enabled(false);
                }
            }
            println!("Back on the release{}.", if off { ", previews off" } else { "" });
            0
        }
        "push" => {
            let (Some(path), Some(id)) = (args.get(1), opt("--id")) else {
                eprintln!("{USAGE}");
                return 2;
            };
            let Ok(path) = std::fs::canonicalize(path) else {
                eprintln!("harbor: no such file: {path}");
                return 2;
            };
            let pushed_ms = now_ms();
            let call = json!({ "preview": {
                "path": path, "id": id, "note": opt("--note").unwrap_or_default(),
                "patch": opt("--patch").and_then(|p| std::fs::canonicalize(p).ok()), "base": opt("--base").unwrap_or_default(),
            } });
            let local = || received(&call["preview"]).map(|(here, _)| json!({ "ok": true, "restarting": false, "here": here })).unwrap_or_else(|e| json!({ "ok": false, "text": e }));
            let r = ask(&call).unwrap_or_else(local);
            if r["ok"].as_bool() != Some(true) {
                eprintln!("harbor: {}", r["text"].as_str().unwrap_or("Harbor did not answer"));
                return 1;
            }
            if r["restarting"].as_bool() != Some(true) {
                println!("{}", r["text"].as_str().unwrap_or("Kept: the next start runs it."));
                return 0;
            }
            match (args.iter().any(|a| a == "--wait"), dir()) {
                (true, Some(d)) => wait(&d, &id, pushed_ms),
                _ => 0,
            }
        }
        _ => {
            eprintln!("{USAGE}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_line() {
        assert_eq!(version_in("harbor 0.101.0 (abcdef0)\n").as_deref(), Some("0.101.0"));
        assert_eq!(version_in("harbor 0.101.0\n").as_deref(), Some("0.101.0"));
        assert_eq!(version_in("something else 1.0"), None);
        assert_eq!(version_in(""), None);
    }

    #[test]
    fn a_newer_release_wins() {
        assert!(superseded("0.101.0", Some("0.102.0")));
        assert!(!superseded("0.102.0", Some("0.102.0")));
        assert!(!superseded("0.103.0", Some("0.102.0")));
        assert!(!superseded("0.103.0", None));
    }

    #[test]
    fn only_a_trusted_pc_with_previews_on() {
        // Off is the default: the file isn't there on a copy from source either.
        assert!(refuses(true).is_some());
        assert!(refuses(false).is_some());
    }

    #[test]
    fn says_what_runs() {
        let v = info();
        assert_eq!(v["preview_on"], json!(false));
        assert!(v["preview"].is_null());
        assert!(takes(&json!({ "preview_on": true })));
        assert!(!takes(&json!({ "version": "0.100.0" })));
        assert!(!takes(&Value::Null));
    }

    #[test]
    fn a_dead_process_is_not_alive() {
        assert!(alive(std::process::id()));
        assert!(!alive(u32::MAX));
    }

    #[test]
    fn meta_keeps_across_a_write() {
        let d = std::env::temp_dir().join(format!("harbor-preview-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let m = Meta { id: "abc".into(), sha256: "00".into(), version: "1.2.3".into(), at: 5, stage: Stage::Ok, ..Default::default() };
        write_meta(&d, &m).unwrap();
        assert_eq!(read_meta(&d), Some(m.clone()));
        fail(&d, "other", "no");
        assert_eq!(read_meta(&d), Some(m.clone()));
        fail(&d, "abc", "it exited");
        assert_eq!(read_meta(&d).unwrap().stage, Stage::Failed);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn hashes_a_file() {
        let d = std::env::temp_dir().join(format!("harbor-preview-sha-{}", std::process::id()));
        std::fs::write(&d, "abc").unwrap();
        assert_eq!(sha256(&d).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        std::fs::remove_file(&d).unwrap();
    }
}
