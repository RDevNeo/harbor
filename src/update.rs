//! Self-update for per-user installs (packaging/install.sh puts Harbor in ~/.local/lib/harbor
//! and leaves a `.managed` marker there). Harbor asks GitHub for the latest release now and
//! then, downloads it, checks its minisign signature against the key below, and renames the
//! new files over the old ones (helpers first, harbor last). The hot reload (reload.rs) sees
//! its own file change and restarts into the new version; agent turns run detached and live on.
//!
//! The previous files are kept in `.previous/` (hard links), for "Restore previous version".
//! Builds from a source tree have no marker and are never touched.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const REPO: &str = "RDevNeo/harbor";
/// minisign public key of the release workflow (secret: MINISIGN_SECRET_KEY on GitHub).
const PUBKEY: &str = "RWSaeVHfD2GBvTEgaNXQQs8eQR5rCD50vuckgoo79X6wqhOKXIpUVHNh";
const ARCH: &str = "x86_64";
const CHECK_EVERY: Duration = Duration::from_secs(4 * 3600);
/// The first check waits a little, so starting Harbor stays quick.
const FIRST_CHECK: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Idle,
    Checking,
    UpToDate,
    Available(String),
    Installing(String),
    /// Installed; the reload into it happens when the window is focused.
    Installed(String),
    Failed(String),
}

static STATE: Mutex<State> = Mutex::new(State::Idle);
static BUSY: AtomicBool = AtomicBool::new(false);
static LAST_CHECK: Mutex<Option<Instant>> = Mutex::new(None);
static STARTED: Mutex<Option<Instant>> = Mutex::new(None);
static BROWSER: Mutex<Option<Result<(), String>>> = Mutex::new(None);

pub fn state() -> State {
    STATE.lock().unwrap().clone()
}

fn set(s: State) {
    *STATE.lock().unwrap() = s;
}

/// "0.1.0 (abc1234)" with the commit CI built it from.
pub fn version_label() -> String {
    match option_env!("HARBOR_GIT_SHA") {
        Some(sha) if sha.len() >= 7 => format!("{VERSION} ({})", &sha[..7]),
        _ => VERSION.to_string(),
    }
}

/// Harbor's own file: where it was started from, even after an update replaced it.
pub fn self_exe() -> Option<PathBuf> {
    std::env::current_exe().ok().map(|p| PathBuf::from(p.to_string_lossy().trim_end_matches(" (deleted)")))
}

/// The install folder, if this Harbor was installed by install.sh (and so may update itself).
pub fn install_dir() -> Option<PathBuf> {
    let dir = self_exe()?.parent()?.to_path_buf();
    dir.join(".managed").is_file().then_some(dir)
}

pub fn managed() -> bool {
    install_dir().is_some()
}

pub fn has_previous() -> bool {
    install_dir().is_some_and(|d| d.join(".previous/harbor").is_file())
}

// ------------------------------------------------------------------ versions

/// (major, minor, patch, is_release): "0.2.0" > "0.2.0-rc.1" > "0.1.9".
fn parse(v: &str) -> Option<(u64, u64, u64, bool)> {
    let v = v.trim().trim_start_matches('v');
    let (core, pre) = match v.split_once('-') {
        Some((c, _)) => (c, true),
        None => (v, false),
    };
    let mut it = core.split('.').map(|x| x.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0), !pre))
}

pub fn newer(candidate: &str, current: &str) -> bool {
    match (parse(candidate), parse(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

// ------------------------------------------------------------------ network (curl)

fn curl() -> Command {
    let mut c = Command::new("curl");
    c.args(["-fsSL", "--retry", "2", "--connect-timeout", "15", "-A"]).arg(format!("harbor/{VERSION}"));
    c
}

/// The latest release's version, from where /releases/latest redirects (no API rate limit).
fn latest() -> Result<String, String> {
    let out = curl()
        .args(["-o", "/dev/null", "-w", "%{url_effective}"])
        .arg(format!("https://github.com/{REPO}/releases/latest"))
        .output()
        .map_err(|e| format!("curl: {e}"))?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let tag = url.rsplit_once("/tag/").map(|(_, t)| t.to_string()).ok_or_else(|| "no release published yet".to_string())?;
    parse(&tag).ok_or_else(|| format!("unexpected release tag {tag}"))?;
    Ok(tag.trim_start_matches('v').to_string())
}

fn download(version: &str, name: &str, to: &Path) -> Result<(), String> {
    let url = format!("https://github.com/{REPO}/releases/download/v{version}/{name}");
    let st = curl().arg("-o").arg(to).arg(&url).status().map_err(|e| format!("curl: {e}"))?;
    if st.success() { Ok(()) } else { Err(format!("download failed: {name}")) }
}

/// Checks `file` against its minisign signature, and that the signature was made for this
/// version and file name (so an old signed archive can't pass as a newer one).
pub fn verify(file: &Path, sig: &str, version: &str, name: &str) -> Result<(), String> {
    let pk = minisign_verify::PublicKey::from_base64(PUBKEY).map_err(|e| format!("public key: {e}"))?;
    let sig = minisign_verify::Signature::decode(sig).map_err(|_| format!("{name}: unreadable signature"))?;
    let data = std::fs::read(file).map_err(|e| format!("{name}: {e}"))?;
    pk.verify(&data, &sig, false).map_err(|_| format!("{name}: bad signature"))?;
    let tc = sig.trusted_comment();
    if !tc.contains(&format!("v{version} ")) || !tc.ends_with(name) {
        return Err(format!("{name}: signed for another release ({tc})"));
    }
    Ok(())
}

/// Downloads, verifies and unpacks a release archive into `stage`; returns the unpacked folder.
fn fetch(version: &str, name: &str, stage: &Path) -> Result<PathBuf, String> {
    let file = stage.join(format!("{name}.tar.gz"));
    let sig = stage.join(format!("{name}.tar.gz.minisig"));
    download(version, &format!("{name}.tar.gz"), &file)?;
    download(version, &format!("{name}.tar.gz.minisig"), &sig)?;
    let sig_text = std::fs::read_to_string(&sig).map_err(|e| e.to_string())?;
    verify(&file, &sig_text, version, &format!("{name}.tar.gz"))?;
    let st = Command::new("tar").arg("-xzf").arg(&file).arg("-C").arg(stage).status().map_err(|e| format!("tar: {e}"))?;
    if !st.success() {
        return Err(format!("{name}: could not unpack"));
    }
    Ok(stage.join(name))
}

// ------------------------------------------------------------------ install

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// Moves `src` over `dst` atomically, after keeping a hard link of the old file in `prev`.
fn replace(src: &Path, dst: &Path, prev: Option<&Path>) -> Result<(), String> {
    if let (Some(prev), true) = (prev, dst.is_file()) {
        let keep = prev.join(dst.file_name().unwrap());
        let _ = std::fs::remove_file(&keep);
        if std::fs::hard_link(dst, &keep).is_err() {
            std::fs::copy(dst, &keep).map_err(|e| format!("backup: {e}"))?;
        }
    }
    std::fs::rename(src, dst).map_err(|e| format!("{}: {e}", dst.display()))
}

fn install(version: &str) -> Result<(), String> {
    let dir = install_dir().ok_or("not an installed copy")?;
    let stage = dir.join(".staging");
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        let core = fetch(version, &format!("harbor-{ARCH}-linux"), &stage)?;
        if read(&core.join("VERSION")) != version {
            return Err("the archive is for another version".into());
        }
        for f in ["harbor", "harbor-stream"] {
            if !core.join(f).is_file() {
                return Err(format!("the archive has no {f}"));
            }
        }
        // The browser engine is optional; refresh it only when installed and changed.
        let mut browser = None;
        if dir.join("harbor-browser").is_file() && read(&dir.join("browser.installed")) != read(&core.join("browser.id")) {
            let b = fetch(version, &format!("harbor-browser-{ARCH}-linux"), &stage)?;
            browser = Some(b);
        }
        let prev = dir.join(".previous");
        let _ = std::fs::remove_dir_all(&prev);
        std::fs::create_dir_all(&prev).map_err(|e| e.to_string())?;
        std::fs::write(prev.join("VERSION"), VERSION).map_err(|e| e.to_string())?;
        if let Some(b) = &browser {
            replace(&b.join("harbor-browser"), &dir.join("harbor-browser"), Some(&prev))?;
            replace(&b.join("browser.id"), &dir.join("browser.installed"), None)?;
        }
        replace(&core.join("harbor-stream"), &dir.join("harbor-stream"), Some(&prev))?;
        for f in ["VERSION", "browser.id"] {
            if core.join(f).is_file() {
                replace(&core.join(f), &dir.join(f), None)?;
            }
        }
        if core.join("licenses").is_dir() {
            let _ = std::fs::remove_dir_all(dir.join("licenses"));
            let _ = std::fs::rename(core.join("licenses"), dir.join("licenses"));
        }
        // Last: the reload watcher sees this one change.
        replace(&core.join("harbor"), &dir.join("harbor"), Some(&prev))
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

/// Puts the files from `.previous/` back (that copy is used up).
fn rollback() -> Result<String, String> {
    let dir = install_dir().ok_or("not an installed copy")?;
    let prev = dir.join(".previous");
    if !prev.join("harbor").is_file() {
        return Err("no previous version kept".into());
    }
    let version = read(&prev.join("VERSION"));
    if prev.join("harbor-browser").is_file() {
        replace(&prev.join("harbor-browser"), &dir.join("harbor-browser"), None)?;
        // Its id is unknown now; the next update fetches the matching engine.
        let _ = std::fs::remove_file(dir.join("browser.installed"));
    }
    if prev.join("harbor-stream").is_file() {
        replace(&prev.join("harbor-stream"), &dir.join("harbor-stream"), None)?;
    }
    let _ = std::fs::write(dir.join("VERSION"), &version);
    replace(&prev.join("harbor"), &dir.join("harbor"), None)?;
    let _ = std::fs::remove_dir_all(&prev);
    Ok(version)
}

// ------------------------------------------------------------------ driving it

fn spawn(ctx: &eframe::egui::Context, job: impl FnOnce() + Send + 'static) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let ctx = ctx.clone();
    std::thread::spawn(move || {
        job();
        BUSY.store(false, Ordering::SeqCst);
        ctx.request_repaint();
    });
}

/// Called every frame: checks on start and every few hours; installs when `auto`.
pub fn tick(auto: bool, ctx: &eframe::egui::Context) {
    if !managed() {
        return;
    }
    let started = *STARTED.lock().unwrap().get_or_insert_with(Instant::now);
    let due = match *LAST_CHECK.lock().unwrap() {
        None => started.elapsed() >= FIRST_CHECK,
        Some(t) => t.elapsed() >= CHECK_EVERY,
    };
    if due && !BUSY.load(Ordering::SeqCst) && !matches!(state(), State::Installed(_)) {
        check(auto, ctx);
    }
    // Wake up for the next check even when nothing else repaints.
    ctx.request_repaint_after(Duration::from_secs(60));
}

/// "Check now" (and the timer): finds the latest release, installs it when `auto`.
pub fn check(auto: bool, ctx: &eframe::egui::Context) {
    *LAST_CHECK.lock().unwrap() = Some(Instant::now());
    let ctx2 = ctx.clone();
    spawn(ctx, move || {
        set(State::Checking);
        ctx2.request_repaint();
        match latest() {
            Ok(v) if newer(&v, VERSION) => {
                if auto {
                    run_install(v);
                } else {
                    set(State::Available(v));
                }
            }
            Ok(_) => set(State::UpToDate),
            Err(e) => set(State::Failed(e)),
        }
    });
}

fn run_install(v: String) {
    set(State::Installing(v.clone()));
    match install(&v) {
        Ok(()) => set(State::Installed(v)),
        Err(e) => set(State::Failed(e)),
    }
}

/// "Install" for an available update (automatic installs off).
pub fn install_now(ctx: &eframe::egui::Context) {
    if let State::Available(v) = state() {
        spawn(ctx, move || run_install(v));
    }
}

pub fn restore_previous(ctx: &eframe::egui::Context) {
    spawn(ctx, || match rollback() {
        Ok(v) => set(State::Installed(v)),
        Err(e) => set(State::Failed(e)),
    });
}

// ------------------------------------------------------------------ browser engine on demand

/// Installs the browser engine of this exact version next to harbor.
pub fn install_browser(ctx: &eframe::egui::Context) {
    *BROWSER.lock().unwrap() = None;
    spawn(ctx, || {
        let r = (|| {
            let dir = install_dir().ok_or("not an installed copy")?;
            let stage = dir.join(".staging-browser");
            let _ = std::fs::remove_dir_all(&stage);
            std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
            let r = fetch(VERSION, &format!("harbor-browser-{ARCH}-linux"), &stage).and_then(|b| {
                replace(&b.join("browser.id"), &dir.join("browser.installed"), None)?;
                replace(&b.join("harbor-browser"), &dir.join("harbor-browser"), None)
            });
            let _ = std::fs::remove_dir_all(&stage);
            r
        })();
        *BROWSER.lock().unwrap() = Some(r);
    });
}

/// None: not started or running (see `busy`); Some: finished.
pub fn browser_result() -> Option<Result<(), String>> {
    BROWSER.lock().unwrap().clone()
}

pub fn busy() -> bool {
    BUSY.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(newer("0.2.0", "0.1.9"));
        assert!(newer("v1.0.0", "0.9.9"));
        assert!(newer("0.2.0", "0.2.0-rc.1"));
        assert!(!newer("0.2.0-rc.1", "0.2.0"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(!newer("garbage", "0.1.0"));
        assert!(newer("0.10.0", "0.9.0"));
    }

    /// Signed with the release key: `minisign -S -t "harbor v0.0.1 harbor-x86_64-linux.tar.gz"`.
    const SIG: &str = "untrusted comment: signature from minisign secret key
RUSaeVHfD2GBvargpdewoKaCPteir0zUTL31H4bcjFF5op1zwKHVaz4aU3MCYoB8DmZ+BbqDLBmvxEokE+YvUTkIXmvkhoxkFg8=
trusted comment: harbor v0.0.1 harbor-x86_64-linux.tar.gz
N5LtPI0Gsk3pOwxTI4SLqgkXbXPZe3xgdluvQMXHbmDLg/UIFKQnNC3sdYQke6ZBlrU6os7Moa5CZJTZufUQDQ==
";

    #[test]
    fn signatures() {
        let dir = std::env::temp_dir().join(format!("harbor-update-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.tar.gz");
        let name = "harbor-x86_64-linux.tar.gz";
        std::fs::write(&f, "harbor test\n").unwrap();
        assert_eq!(verify(&f, SIG, "0.0.1", name), Ok(()));
        // Another release, another file name, changed bytes: all refused.
        assert!(verify(&f, SIG, "0.0.2", name).is_err());
        assert!(verify(&f, SIG, "0.0.1", "harbor-browser-x86_64-linux.tar.gz").is_err());
        std::fs::write(&f, "harbor test!\n").unwrap();
        assert!(verify(&f, SIG, "0.0.1", name).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

impl crate::app::App {
    /// Settings › General › "Install updates automatically" (on unless turned off).
    pub fn auto_update(&self) -> bool {
        self.store.get("auto_update").as_deref() != Some("0")
    }
}
