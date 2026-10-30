//! What the Discord app runs on, and where it lives: official Electron, the shell (`discord/`, a
//! separate GPL program this binary never contains), stock Vencord, the profile. All of it is
//! downloaded on first sign-in into `<data>/apps/discord` (0700).
//!
//! Electron is pinned by sha256. The shell comes from this repository at this build's commit
//! (raw.githubusercontent.com: no build job needed), checked against `discord/SHA256SUMS`. Vencord
//! follows its rolling release: a version that fails the self-test goes back to the last one that
//! passed (discordhost.rs), and the tool script can carry repair's local edits ([`Override`]).

use crate::mcp::{private_dir, write_private};
use crate::store;
use ring::digest::{Context, SHA256, digest};
use serde::{Deserialize, Serialize};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const ELECTRON: &str = "45.1.0";
/// From the release's SHASUMS256.txt.
const ELECTRON_SUMS: &[(&str, &str)] =
    &[("x64", "9dafab2c57ce209f8f716f8f3e4fddd8ffe0820e2455bfbbfc00b0fc13e03a3b"), ("arm64", "64b78d93d1129ab805cdc0f2710f446716afbe814a1d08e639dab3175d2285a1")];
/// The shell's files and their hashes. Only hashes: its code stays out of this binary.
const SHELL_SUMS: &str = include_str!("../discord/SHA256SUMS");
const VENCORD_URL: &str = "https://github.com/Vendicated/Vencord/releases/download/devbuild";
pub const VENCORD_FILES: &[&str] = &["vencordDesktopMain.js", "vencordDesktopPreload.js", "vencordDesktopRenderer.js", "vencordDesktopRenderer.css"];
/// How often Vencord is checked for a new version.
pub const VENCORD_EVERY: i64 = 24 * 3600;
/// Versions kept on disk besides the current one, for rollback.
const VENCORD_KEEP: usize = 3;

pub fn root() -> PathBuf {
    private_dir(crate::mcp::dir().join("discord"))
}

/// The Chromium profile: the session, and nothing else of Harbor's.
pub fn profile() -> PathBuf {
    private_dir(root().join("profile"))
}

/// The host's socket (short name: socket paths are limited).
pub fn socket() -> PathBuf {
    root().join("h.sock")
}

fn sha256_hex(data: &[u8]) -> String {
    hex(digest(&SHA256, data).as_ref())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn file_sha256(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let (mut c, mut buf) = (Context::new(&SHA256), vec![0u8; 1 << 16]);
    loop {
        match f.read(&mut buf).map_err(|e| e.to_string())? {
            0 => return Ok(hex(c.finish().as_ref())),
            n => c.update(&buf[..n]),
        }
    }
}

/// Fetches `url` to `to`, telling how far it got (bytes so far) about once a second.
fn download(url: &str, to: &Path, progress: &dyn Fn(u64)) -> Result<(), String> {
    let mut c = Command::new("curl")
        .args(["-fsSL", "--retry", "2", "--connect-timeout", "20", "-o"])
        .arg(to)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl: {e}"))?;
    loop {
        match c.try_wait().map_err(|e| e.to_string())? {
            Some(st) if st.success() => return Ok(()),
            Some(_) => {
                let mut err = String::new();
                if let Some(mut s) = c.stderr.take() {
                    let _ = s.read_to_string(&mut err);
                }
                let _ = std::fs::remove_file(to);
                return Err(format!("Couldn't download {url}: {}", err.trim()));
            }
            None => {
                progress(std::fs::metadata(to).map(|m| m.len()).unwrap_or(0));
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
    }
}

// ------------------------------------------------------------------ Electron

fn arch() -> Result<&'static str, String> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("x64"),
        "aarch64" => Ok("arm64"),
        a => Err(format!("Discord needs Electron, which isn't built for {a}.")),
    }
}

/// The Electron binary; `HARBOR_DISCORD_ELECTRON` points a test rig at its own.
pub fn electron_bin() -> PathBuf {
    match std::env::var_os("HARBOR_DISCORD_ELECTRON") {
        Some(p) => p.into(),
        None => root().join(format!("electron-{ELECTRON}/electron")),
    }
}

/// Downloads and unpacks Electron once.
pub fn ensure_electron(say: &dyn Fn(String)) -> Result<(), String> {
    if electron_bin().exists() {
        return Ok(());
    }
    let arch = arch()?;
    let want = ELECTRON_SUMS.iter().find(|(a, _)| *a == arch).map(|x| x.1).ok_or("no pinned Electron")?;
    let name = format!("electron-v{ELECTRON}-linux-{arch}.zip");
    let zip = root().join(format!("{name}.part"));
    let url = format!("https://github.com/electron/electron/releases/download/v{ELECTRON}/{name}");
    let base = std::env::var("HARBOR_DISCORD_ELECTRON_URL").map(|b| format!("{b}/{name}")).unwrap_or(url);
    download(&base, &zip, &|n| say(format!("Downloading Electron… {} MB of 120", n >> 20)))?;
    say("Checking the download…".into());
    let got = file_sha256(&zip)?;
    if got != want {
        let _ = std::fs::remove_file(&zip);
        return Err("The Electron download doesn't match its checksum.".into());
    }
    say("Unpacking…".into());
    let tmp = root().join(format!("electron-{ELECTRON}.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    unzip(&zip, &tmp)?;
    let _ = std::fs::remove_file(&zip);
    std::fs::rename(&tmp, root().join(format!("electron-{ELECTRON}"))).map_err(|e| e.to_string())
}

fn le(b: &[u8], at: usize, n: usize) -> u64 {
    b[at..at + n].iter().rev().fold(0, |v, x| v << 8 | *x as u64)
}

/// Unpacks a zip (stored or deflated, no zip64: Electron's isn't) with its file modes.
pub fn unzip(zip: &Path, to: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let bad = || "The zip file is damaged.".to_string();
    let mut f = std::fs::File::open(zip).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let tail = len.min(70_000);
    f.seek(SeekFrom::Start(len - tail)).map_err(|e| e.to_string())?;
    let mut end = vec![0u8; tail as usize];
    f.read_exact(&mut end).map_err(|e| e.to_string())?;
    let eocd = end.windows(4).rposition(|w| w == b"PK\x05\x06").ok_or_else(bad)?;
    let count = le(&end, eocd + 10, 2);
    let (size, start) = (le(&end, eocd + 12, 4) as usize, le(&end, eocd + 16, 4));
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut dir = vec![0u8; size];
    f.read_exact(&mut dir).map_err(|e| e.to_string())?;
    let mut at = 0;
    for _ in 0..count {
        if dir.len() < at + 46 || &dir[at..at + 4] != b"PK\x01\x02" {
            return Err(bad());
        }
        let (method, comp) = (le(&dir, at + 10, 2), le(&dir, at + 20, 4));
        let (nlen, xlen, clen) = (le(&dir, at + 28, 2) as usize, le(&dir, at + 30, 2) as usize, le(&dir, at + 32, 2) as usize);
        let attrs = le(&dir, at + 38, 4) >> 16;
        let local = le(&dir, at + 42, 4);
        let name = String::from_utf8_lossy(dir.get(at + 46..at + 46 + nlen).ok_or_else(bad)?).into_owned();
        at += 46 + nlen + xlen + clen;
        let rel = Path::new(&name);
        if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(bad());
        }
        let out = to.join(rel);
        if name.ends_with('/') {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut head = [0u8; 30];
        f.seek(SeekFrom::Start(local)).map_err(|e| e.to_string())?;
        f.read_exact(&mut head).map_err(|e| e.to_string())?;
        if &head[..4] != b"PK\x03\x04" {
            return Err(bad());
        }
        f.seek(SeekFrom::Start(local + 30 + le(&head, 26, 2) + le(&head, 28, 2))).map_err(|e| e.to_string())?;
        let data = BufReader::new((&f).take(comp));
        let mut body: Box<dyn Read> = match method {
            0 => Box::new(data),
            8 => Box::new(flate2::bufread::DeflateDecoder::new(data)),
            _ => return Err(bad()),
        };
        // A symlink's contents are its target (attrs: st_mode in the high half).
        if attrs & 0o170000 == 0o120000 {
            let mut t = String::new();
            body.read_to_string(&mut t).map_err(|e| e.to_string())?;
            std::os::unix::fs::symlink(t, &out).map_err(|e| e.to_string())?;
            continue;
        }
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut body, &mut w).map_err(|e| e.to_string())?;
        if attrs & 0o777 != 0 {
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(attrs as u32 & 0o777));
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ the shell

/// (hash, relative path) of each of the shell's files.
fn shell_files() -> Vec<(&'static str, &'static str)> {
    SHELL_SUMS.lines().filter_map(|l| l.split_once("  ")).collect()
}

/// The commit (or tag) of this repository whose `discord/` this build goes with.
fn shell_ref() -> String {
    std::env::var("HARBOR_DISCORD_REF").unwrap_or_else(|_| option_env!("HARBOR_GIT_SHA").map(String::from).unwrap_or_else(|| format!("v{}", crate::update::VERSION)))
}

/// The installed shell; `HARBOR_DISCORD_SHELL` points a test rig at a checkout's `discord/`.
pub fn shell_dir() -> PathBuf {
    match std::env::var_os("HARBOR_DISCORD_SHELL") {
        Some(p) => p.into(),
        None => root().join(format!("shell-{}", &sha256_hex(SHELL_SUMS.as_bytes())[..12])),
    }
}

/// Fetches the shell once, for this version of Harbor.
pub fn ensure_shell(say: &dyn Fn(String)) -> Result<(), String> {
    let dir = shell_dir();
    if dir.join("main.js").exists() {
        return Ok(());
    }
    say("Downloading Harbor's Discord shell…".into());
    let tmp = dir.with_extension("tmp");
    let _ = std::fs::remove_dir_all(&tmp);
    let r = shell_ref();
    for (want, rel) in shell_files() {
        let to = tmp.join(rel);
        std::fs::create_dir_all(to.parent().unwrap_or(&tmp)).map_err(|e| e.to_string())?;
        download(&format!("https://raw.githubusercontent.com/RDevNeo/harbor/{r}/discord/{rel}"), &to, &|_| {})?;
        if file_sha256(&to)? != want {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("Harbor's Discord shell ({rel}) doesn't match this version of Harbor."));
        }
    }
    // Earlier Harbors' shells: this one replaces them.
    for e in std::fs::read_dir(root()).into_iter().flatten().flatten() {
        if e.file_name().to_string_lossy().starts_with("shell-") && e.path() != tmp {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    std::fs::rename(&tmp, &dir).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ Vencord

/// Which Vencord runs (`vencord.json`). Versions are folders under `vencord/`, named by content.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Vencords {
    /// What the next start uses.
    #[serde(default)]
    pub current: String,
    /// The last one that passed the self-test.
    #[serde(default)]
    pub good: String,
    /// Failed it: never tried again.
    #[serde(default)]
    pub bad: Vec<String>,
    /// When a new version was last looked for.
    #[serde(default)]
    pub checked: i64,
}

impl Vencords {
    /// A version was downloaded: the next start tries it, unless it already failed.
    pub fn offer(&mut self, id: &str) {
        if !self.bad.iter().any(|b| b == id) {
            self.current = id.into();
        }
    }

    /// It passed the self-test.
    pub fn passed(&mut self) {
        self.good = self.current.clone();
    }

    /// It failed. True: went back to the last good version, try that. False: there's nothing to
    /// go back to, so it isn't Vencord's update that broke things.
    pub fn rollback(&mut self) -> bool {
        if self.good.is_empty() || self.current == self.good {
            return false;
        }
        self.bad.push(std::mem::take(&mut self.current));
        self.current = self.good.clone();
        true
    }

    fn path() -> PathBuf {
        root().join("vencord.json")
    }

    pub fn load() -> Vencords {
        std::fs::read_to_string(Self::path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self) {
        let _ = write_private(&Self::path(), &serde_json::to_string_pretty(self).unwrap_or_default());
    }
}

fn vencord_root() -> PathBuf {
    private_dir(root().join("vencord"))
}

pub fn vencord_dir(id: &str) -> PathBuf {
    vencord_root().join(id)
}

/// Downloads Vencord's current release; its id. The files only count once all are here.
pub fn fetch_vencord() -> Result<String, String> {
    let base = std::env::var("HARBOR_DISCORD_VENCORD_URL").unwrap_or_else(|_| VENCORD_URL.into());
    let tmp = vencord_root().join(format!("new-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    for f in VENCORD_FILES {
        if let Err(e) = download(&format!("{base}/{f}"), &tmp.join(f), &|_| {}) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
    }
    let id = file_sha256(&tmp.join("vencordDesktopRenderer.js"))?[..12].to_string();
    let dir = vencord_dir(&id);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
    } else {
        let _ = std::fs::write(tmp.join("package.json"), "{}");
        std::fs::rename(&tmp, &dir).map_err(|e| e.to_string())?;
    }
    Ok(id)
}

/// Has a Vencord to run, and every day looks for a newer one. A failed check just keeps what's here.
pub fn ensure_vencord(say: &dyn Fn(String)) -> Result<Vencords, String> {
    let mut v = Vencords::load();
    if v.current.is_empty() || !vencord_dir(&v.current).exists() {
        say("Downloading Vencord…".into());
        v.offer(&fetch_vencord()?);
        v.checked = store::now();
        v.save();
    }
    Ok(v)
}

/// Looks for a new Vencord, at most daily, or hourly when something's `broken` and a newer one
/// might be the fix. True: the next start runs another version.
pub fn check_vencord(broken: bool) -> bool {
    let mut v = Vencords::load();
    if store::now() - v.checked < if broken { 3600 } else { VENCORD_EVERY } {
        return false;
    }
    v.checked = store::now();
    let was = v.current.clone();
    if let Ok(id) = fetch_vencord() {
        v.offer(&id);
    }
    v.save();
    prune_vencords(&v);
    v.current != was
}

fn prune_vencords(v: &Vencords) {
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(vencord_root())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let n = e.file_name();
            n != v.current.as_str() && n != v.good.as_str()
        })
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    dirs.sort();
    dirs.reverse();
    for (_, d) in dirs.into_iter().skip(VENCORD_KEEP) {
        let _ = std::fs::remove_dir_all(d);
    }
}

// ------------------------------------------------------------------ the tool script

/// Text that repair may never add to the tool script: nothing it adds may reach the network or the
/// session, or hide what it does. The self-test and the notice are the other half of the check.
const NOT_IN_EDITS: &[&str] = &[
    "fetch(", "api(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "postMessage", "eval(", "Function(", "import(", "require(", "localStorage", "sessionStorage", "indexedDB",
    "document.cookie", "getToken", "getCachedToken", "getAuthToken", "http:", "https:", "ws:", "wss:", "//", "atob", "btoa", "fromCharCode", "constructor", "__proto__", "\\x", "\\u", "$harbor",
];

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Edit {
    pub old: String,
    pub new: String,
    #[serde(default)]
    pub why: String,
}

/// Repair's local edits to the tool script. They belong to one version of it (`base`, its
/// hash): a new Harbor brings its own script, and with it the real fix.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Override {
    pub base: String,
    pub edits: Vec<Edit>,
    #[serde(default)]
    pub at: i64,
}

fn override_path() -> PathBuf {
    root().join("override.json")
}

pub fn base_script() -> Result<String, String> {
    std::fs::read_to_string(shell_dir().join("page/harbor.js")).map_err(|e| e.to_string())
}

/// `script` with `edits` applied; each one's old text must be there exactly once.
pub fn apply_edits(script: &str, edits: &[Edit]) -> Result<String, String> {
    let mut s = script.to_string();
    for e in edits {
        if let Some(w) = NOT_IN_EDITS.iter().find(|w| e.new.contains(*w) && !e.old.contains(*w)) {
            return Err(format!("Edits can't add `{w}`: repairs only change how Discord's internals are found."));
        }
        match s.matches(e.old.as_str()).count() {
            1 => s = s.replacen(&e.old, &e.new, 1),
            0 => return Err("`old` isn't in the script: read it again first.".into()),
            n => return Err(format!("`old` is in the script {n} times: give more of its surroundings.")),
        }
    }
    Ok(s)
}

pub fn load_override(base: &str) -> Option<Override> {
    let o: Override = serde_json::from_str(&std::fs::read_to_string(override_path()).ok()?).ok()?;
    (o.base == sha256_hex(base.as_bytes())).then_some(o)
}

/// Adds repair's edit to the override.
pub fn add_edit(e: Edit) -> Result<(), String> {
    let base = base_script()?;
    let mut o = load_override(&base).unwrap_or_else(|| Override { base: sha256_hex(base.as_bytes()), ..Default::default() });
    o.edits.push(e);
    apply_edits(&base, &o.edits)?;
    o.at = store::now();
    write_private(&override_path(), &serde_json::to_string_pretty(&o).unwrap_or_default()).map_err(|e| e.to_string())
}

/// The tool script as it runs: the shell's, with repair's edits. Written where the shell reads it.
pub fn write_live_script() -> Result<PathBuf, String> {
    let base = base_script()?;
    let edits = load_override(&base).map(|o| o.edits).unwrap_or_default();
    // Edits that no longer apply are dropped, not fatal: the plain script still runs.
    let s = apply_edits(&base, &edits).unwrap_or(base);
    let p = root().join("page.js");
    write_private(&p, &s).map_err(|e| e.to_string())?;
    Ok(p)
}

pub fn live_script() -> Result<String, String> {
    std::fs::read_to_string(write_live_script()?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_match_the_shell_files() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("discord");
        assert!(!shell_files().is_empty());
        for (want, rel) in shell_files() {
            assert_eq!(file_sha256(&dir.join(rel)).unwrap(), want, "discord/{rel} changed: rerun discord/sums.sh");
        }
        // Every file the shell runs from is in the list.
        for rel in ["main.js", "preload.js", "scratch.js", "package.json", "tools.json", "page/harbor.js"] {
            assert!(shell_files().iter().any(|(_, r)| *r == rel), "{rel} isn't in SHA256SUMS");
        }
    }

    #[test]
    fn rollback_returns_to_the_last_good_version() {
        let mut v = Vencords::default();
        v.offer("a");
        // Nothing passed yet: nothing to go back to.
        assert!(!v.rollback());
        v.passed();
        v.offer("b");
        assert_eq!(v.current, "b");
        assert!(v.rollback());
        assert_eq!((v.current.as_str(), v.good.as_str()), ("a", "a"));
        // Offered again: it failed, so it isn't tried again.
        v.offer("b");
        assert_eq!(v.current, "a");
        // The good one failing means Discord changed, not Vencord.
        assert!(!v.rollback());
        v.offer("c");
        v.passed();
        assert_eq!(v.good, "c");
    }

    #[test]
    fn edits_apply_once_and_cant_add_network_or_token_access() {
        let script = "a: { props: [[\"x\"]] },\nb: 1,\nb: 1,\n";
        let edit = |old: &str, new: &str| Edit { old: old.into(), new: new.into(), why: String::new() };
        assert_eq!(apply_edits(script, &[edit("[\"x\"]", "[\"y\"]")]).unwrap(), "a: { props: [[\"y\"]] },\nb: 1,\nb: 1,\n");
        assert!(apply_edits(script, &[edit("nope", "y")]).is_err());
        assert!(apply_edits(script, &[edit("b: 1", "y")]).is_err());
        for evil in ["fetch(u)", "new WebSocket(u)", "getToken()", "eval(x)", "'htt' + 'p:'.concat(atob(x))", "window[\"\\x66\"]", "a.constructor.constructor", "https://x"] {
            assert!(apply_edits(script, &[edit("[\"x\"]", evil)]).is_err(), "{evil}");
        }
        // Keeping what was already there isn't adding it.
        assert!(apply_edits("getToken: 1", &[edit("getToken: 1", "getToken: 2")]).is_ok());
    }

    #[test]
    fn unzip_keeps_modes_and_refuses_escapes() {
        // A stored zip, written by hand: one executable file.
        fn zip(name: &str, data: &[u8]) -> Vec<u8> {
            let mut z = vec![];
            let u16le = |n: usize| (n as u16).to_le_bytes();
            let u32le = |n: usize| (n as u32).to_le_bytes();
            z.extend(b"PK\x03\x04\x14\0\0\0\0\0\0\0\0\0\0\0\0\0");
            z.extend(u32le(data.len()));
            z.extend(u32le(data.len()));
            z.extend(u16le(name.len()));
            z.extend([0, 0]);
            z.extend(name.as_bytes());
            z.extend(data);
            let dir = z.len();
            z.extend(b"PK\x01\x02\x14\x03\x14\0\0\0\0\0\0\0\0\0\0\0\0\0");
            z.extend(u32le(data.len()));
            z.extend(u32le(data.len()));
            z.extend(u16le(name.len()));
            z.extend([0u8; 8]);
            z.extend(u32le(0o100755 << 16));
            z.extend(u32le(0));
            z.extend(name.as_bytes());
            let size = z.len() - dir;
            z.extend(b"PK\x05\x06\0\0\0\0\x01\0\x01\0");
            z.extend(u32le(size));
            z.extend(u32le(dir));
            z.extend([0, 0]);
            z
        }
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("hdzip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("a.zip");
        std::fs::write(&p, zip("bin/run", b"hello")).unwrap();
        unzip(&p, &d.join("out")).unwrap();
        assert_eq!(std::fs::read(d.join("out/bin/run")).unwrap(), b"hello");
        assert_eq!(std::fs::metadata(d.join("out/bin/run")).unwrap().permissions().mode() & 0o777, 0o755);
        std::fs::write(&p, zip("../evil", b"x")).unwrap();
        assert!(unzip(&p, &d.join("out2")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
