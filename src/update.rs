//! Self-update for per-user installs (packaging/install.sh puts Harbor in ~/.local/lib/harbor
//! and leaves a `.managed` marker there). Harbor asks GitHub for the latest release now and
//! then. By default it only offers it (the Update button); clicking it, or "Automatically"
//! in Settings, downloads it, checks its minisign signature against the key below, and renames
//! the new files over the old ones (helpers first, harbor last). The hot reload (reload.rs)
//! sees its own file change and restarts into the new version; agent turns run detached and
//! live on.
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
/// The release assets are named by it: harbor-x86_64-linux, harbor-aarch64-linux.
const ARCH: &str = std::env::consts::ARCH;
const CHECK_EVERY: Duration = Duration::from_secs(4 * 3600);
/// The first check waits a little, so starting Harbor stays quick.
const FIRST_CHECK: Duration = Duration::from_secs(20);
/// The scheduler looks again at least this often (a check started by hand moves the next one).
const LOOK_EVERY: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Idle,
    Checking,
    UpToDate,
    Available(String),
    Installing(String),
    /// Installed; the reload into it happens on the Update button (or, updating automatically,
    /// when the window is focused).
    Installed(String),
    Failed(String),
}

static STATE: Mutex<State> = Mutex::new(State::Idle);
static BUSY: AtomicBool = AtomicBool::new(false);
static LAST_CHECK: Mutex<Option<Instant>> = Mutex::new(None);
static STARTED: Mutex<Option<Instant>> = Mutex::new(None);
/// Settings › Updates › "Automatically", as last seen by `tick` (the scheduler thread reads it).
static AUTO: AtomicBool = AtomicBool::new(false);
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

/// The version installed in `dir` when it isn't the one running (installed by the Update
/// button, `harbor --update`, or restored), for the reload into it.
fn version_in(dir: &Path) -> Option<String> {
    Some(read(&dir.join("VERSION"))).filter(|v| !v.is_empty() && v != VERSION)
}

/// The installed version waiting for a reload, if any.
pub fn on_disk() -> Option<String> {
    version_in(&install_dir()?)
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
        if !core.join("harbor").is_file() {
            return Err("the archive has no harbor".into());
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
        // The screen viewer is gone since 0.18; kept only for "Restore previous version".
        if dir.join("harbor-stream").is_file() {
            let _ = std::fs::rename(dir.join("harbor-stream"), prev.join("harbor-stream"));
        }
        for f in ["VERSION", "browser.id"] {
            if core.join(f).is_file() {
                replace(&core.join(f), &dir.join(f), None)?;
            }
        }
        if core.join("licenses").is_dir() {
            let _ = std::fs::remove_dir_all(dir.join("licenses"));
            let _ = std::fs::rename(core.join("licenses"), dir.join("licenses"));
        }
        // The phone app (Settings › Phones serves it); releases before it have none.
        if let Err(e) = fetch_apk(version, &stage, &dir) {
            eprintln!("harbor: phone app not updated: {e}");
        }
        let _ = std::fs::remove_file(dir.join(".skip"));
        // Last: the reload watcher sees this one change.
        replace(&core.join("harbor"), &dir.join("harbor"), Some(&prev))
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

/// The version "Restore previous version" moved away from: offered, not installed automatically.
fn skipped(version: &str) -> bool {
    install_dir().is_some_and(|d| read(&d.join(".skip")) == version)
}

/// Puts the files from `.previous/` back (that copy is used up).
fn rollback() -> Result<String, String> {
    let dir = install_dir().ok_or("not an installed copy")?;
    let prev = dir.join(".previous");
    if !prev.join("harbor").is_file() {
        return Err("no previous version kept".into());
    }
    let version = read(&prev.join("VERSION"));
    // The version given up on isn't installed again by itself (only when asked).
    let _ = std::fs::write(dir.join(".skip"), read(&dir.join("VERSION")));
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

// ------------------------------------------------------------------ the phone app

/// The release asset with Harbor for Android, and the file it's kept as.
pub const APK: &str = "harbor-android.apk";
/// Beside the APK: its versionCode (one integer), written when Harbor fetches it.
const APK_VERSION: &str = "harbor-android.version";

/// The Android versionCode of a Harbor version: 0.7.0 → 7000, 1.2.3 → 1002003.
pub fn version_code(v: &str) -> i64 {
    parse(v).map_or(0, |(a, b, c, _)| (a * 1_000_000 + b * 1000 + c) as i64)
}

/// Where this Harbor keeps the phone app: its install folder, or its data folder for builds
/// from source.
pub fn apk_dir() -> PathBuf {
    install_dir().unwrap_or_else(crate::store::data_dir)
}

/// The phone app this Harbor serves, with its versionCode (0 when unknown).
pub fn apk() -> Option<(PathBuf, i64)> {
    let dir = apk_dir();
    let f = dir.join(APK);
    f.is_file().then(|| (f, read(&dir.join(APK_VERSION)).parse().unwrap_or(0)))
}

/// A phone app another PC of the mesh served (newer than this one's): kept as this PC's.
/// The phone checks its signature (only Harbor's key updates the installed app).
pub fn put_apk(bytes: &[u8], code: i64) -> Result<(), String> {
    let dir = apk_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (f, v) = (dir.join(format!(".{APK}.new")), dir.join(format!(".{APK_VERSION}.new")));
    std::fs::write(&f, bytes).map_err(|e| e.to_string())?;
    std::fs::write(&v, code.to_string()).map_err(|e| e.to_string())?;
    replace(&f, &dir.join(APK), None)?;
    replace(&v, &dir.join(APK_VERSION), None)
}

/// Downloads and checks the release's APK into `stage`, then moves it into `dir`.
fn fetch_apk(version: &str, stage: &Path, dir: &Path) -> Result<i64, String> {
    let (file, sig) = (stage.join(APK), stage.join(format!("{APK}.minisig")));
    download(version, APK, &file)?;
    download(version, &format!("{APK}.minisig"), &sig)?;
    verify(&file, &std::fs::read_to_string(&sig).map_err(|e| e.to_string())?, version, APK)?;
    let code = version_code(version);
    let v = stage.join(APK_VERSION);
    std::fs::write(&v, code.to_string()).map_err(|e| e.to_string())?;
    replace(&file, &dir.join(APK), None)?;
    replace(&v, &dir.join(APK_VERSION), None)?;
    Ok(code)
}

static APK_JOB: Mutex<Option<Result<i64, String>>> = Mutex::new(None);

/// Settings › Phones › Download: the latest release's APK, for copies that don't update
/// themselves (an installed copy gets it with every update).
pub fn download_apk(ctx: &eframe::egui::Context) {
    *APK_JOB.lock().unwrap() = None;
    spawn(ctx, || {
        let r = (|| {
            let v = latest()?;
            let dir = apk_dir();
            let stage = dir.join(".staging-apk");
            let _ = std::fs::remove_dir_all(&stage);
            std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
            let r = fetch_apk(&v, &stage, &dir);
            let _ = std::fs::remove_dir_all(&stage);
            r
        })();
        *APK_JOB.lock().unwrap() = Some(r);
    });
}

/// None: not started or running (see `busy`); Some: finished.
pub fn apk_result() -> Option<Result<i64, String>> {
    APK_JOB.lock().unwrap().clone()
}

// ------------------------------------------------------------------ command line

/// `--update` installs the latest release now; `--restore-previous` puts the kept one back.
/// A running Harbor reloads into the result by itself. None: not one of these options.
pub fn cli(arg: &str) -> Option<i32> {
    let r = match arg {
        "--update" => {
            if install_dir().is_none() {
                Err("this copy wasn't installed by install.sh, so it doesn't update itself".to_string())
            } else {
                latest().and_then(|v| {
                    if !newer(&v, VERSION) {
                        return Ok(format!("Harbor {VERSION} is up to date."));
                    }
                    println!("Installing Harbor {v}…");
                    install(&v).map(|()| format!("Harbor {v} is installed."))
                })
            }
        }
        "--restore-previous" => rollback().map(|v| format!("Harbor {v} is back.")),
        _ => return None,
    };
    Some(match r {
        Ok(msg) => {
            println!("{msg}");
            0
        }
        Err(e) => {
            eprintln!("harbor: {e}");
            1
        }
    })
}

// ------------------------------------------------------------------ driving it

/// Runs `job` on a thread unless another one is running (false then).
fn spawn(ctx: &eframe::egui::Context, job: impl FnOnce() + Send + 'static) -> bool {
    if BUSY.swap(true, Ordering::SeqCst) {
        return false;
    }
    let ctx = ctx.clone();
    std::thread::spawn(move || {
        job();
        BUSY.store(false, Ordering::SeqCst);
        ctx.request_repaint();
    });
    true
}

/// How long until the next scheduled check: shortly after start, then every CHECK_EVERY after
/// the last one. Zero: due.
fn next_check(started: Instant, last: Option<Instant>, now: Instant) -> Duration {
    let at = match last {
        None => started + FIRST_CHECK,
        Some(t) => t + CHECK_EVERY,
    };
    at.saturating_duration_since(now)
}

/// Called every tick: keeps the "Automatically" setting for the scheduler and starts it once.
/// The checks run on its own thread, not on frames: a hidden or unfocused window may get none
/// for hours, and with no window (background.rs) there are none at all.
pub fn tick(auto: bool, ctx: &eframe::egui::Context) {
    AUTO.store(auto, Ordering::Relaxed);
    if !managed() {
        return;
    }
    let started = {
        let mut s = STARTED.lock().unwrap();
        if s.is_some() {
            return;
        }
        *s.insert(Instant::now())
    };
    let ctx = ctx.clone();
    std::thread::spawn(move || {
        loop {
            let last = *LAST_CHECK.lock().unwrap();
            let wait = next_check(started, last, Instant::now());
            if !wait.is_zero() {
                std::thread::sleep(wait.min(LOOK_EVERY));
                continue;
            }
            // Installed: the reload into it comes first. Busy: try again in a while.
            if BUSY.load(Ordering::SeqCst) || matches!(state(), State::Installed(_)) || !check(AUTO.load(Ordering::Relaxed), &ctx) {
                std::thread::sleep(LOOK_EVERY);
            }
        }
    });
}

/// "Check now" (and the scheduler): finds the latest release, installs it when `auto`. The UI
/// is woken at each step (the hub API reads the same state, window or not). False: busy.
pub fn check(auto: bool, ctx: &eframe::egui::Context) -> bool {
    let ctx2 = ctx.clone();
    let started = spawn(ctx, move || {
        set(State::Checking);
        ctx2.request_repaint();
        match latest() {
            Ok(v) if newer(&v, VERSION) => {
                if auto && !skipped(&v) {
                    run_install(v);
                } else {
                    set(State::Available(v));
                }
            }
            Ok(_) => set(State::UpToDate),
            Err(e) => set(State::Failed(e)),
        }
    });
    if started {
        *LAST_CHECK.lock().unwrap() = Some(Instant::now());
    }
    started
}

fn run_install(v: String) {
    set(State::Installing(v.clone()));
    match install(&v) {
        Ok(()) => set(State::Installed(v)),
        Err(e) => set(State::Failed(e)),
    }
}

/// "Install" for an available update (the Update button, or automatic installs off).
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

    #[test]
    fn apk_version_codes() {
        assert_eq!(version_code("0.7.0"), 7000);
        assert_eq!(version_code("v1.2.3"), 1_002_003);
        assert_eq!(version_code("0.10.12"), 10_012);
        assert!(version_code("0.7.1") > version_code("0.7.0"));
        assert!(version_code("0.8.0") > version_code("0.7.999"));
        assert_eq!(version_code("junk"), 0);
    }

    #[test]
    fn schedule() {
        let t0 = Instant::now();
        assert_eq!(next_check(t0, None, t0), FIRST_CHECK);
        assert!(next_check(t0, None, t0 + FIRST_CHECK).is_zero());
        assert!(next_check(t0, None, t0 + FIRST_CHECK * 50).is_zero(), "overdue stays due");
        let last = t0 + Duration::from_secs(30);
        assert_eq!(next_check(t0, Some(last), last + Duration::from_secs(60)), CHECK_EVERY - Duration::from_secs(60));
        assert!(next_check(t0, Some(last), last + CHECK_EVERY).is_zero());
    }

    #[test]
    fn version_on_disk() {
        let dir = std::env::temp_dir().join(format!("harbor-update-disk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(version_in(&dir), None, "no VERSION file");
        std::fs::write(dir.join("VERSION"), format!("{VERSION}\n")).unwrap();
        assert_eq!(version_in(&dir), None, "the running version");
        std::fs::write(dir.join("VERSION"), "99.0.1\n").unwrap();
        assert_eq!(version_in(&dir).as_deref(), Some("99.0.1"));
        std::fs::write(dir.join("VERSION"), "  \n").unwrap();
        assert_eq!(version_in(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
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
    /// Settings › General › Updates: "Automatically", or (the default) "Ask me", where new
    /// versions and builds wait for the Update button.
    pub fn auto_update(&self) -> bool {
        self.store.get("auto_update").as_deref() == Some("1")
    }
}
