use crate::store;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Shorter values would hide common words in every output.
pub const MIN_LEN: usize = 4;
/// What run_with_secrets keeps of each stream; the rest is read and dropped.
const CAP: usize = 1 << 20;
/// What the agent gets of the output.
const SHOWN: usize = 30_000;
/// The control socket waits 120 s for an answer.
pub const MAX_TIMEOUT: u64 = 110;
pub const DEFAULT_TIMEOUT: u64 = 50;

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Secret {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub value: String,
    #[serde(default)]
    pub updated: i64,
}

/// The value never goes into a log line.
impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret({})", self.name)
    }
}

pub const DEFAULT_MINUTES: u32 = 15;
pub const MAX_MINUTES: u32 = 24 * 60;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AskKind {
    /// A key the user pastes (request_secret).
    #[default]
    Value,
    /// Use of saved keys for a while (request_secret_access).
    Use,
    /// A saved key written to a .env file (write_secret_to_env).
    Env,
}

/// A card in a chat waiting for the user (kv `secret_asks`: no value in it).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Ask {
    pub id: String,
    pub chat: i64,
    pub kind: AskKind,
    pub names: Vec<String>,
    pub reason: String,
    /// The agent that asked: "lead" or a sub-agent's name.
    pub agent: String,
    /// How long the agent asked to use the keys.
    pub minutes: u32,
    pub how_to_get: String,
    /// A .env file in the chat's folder, and the variable the key goes in there.
    pub env_file: String,
    pub env_var: String,
}

/// A chat's use of a key until `until` (kv `secret_grants`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Grant {
    pub chat: i64,
    pub name: String,
    pub until: i64,
}

/// How long the user lets a chat use keys.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Span {
    Minutes(u32),
    /// Saved without access for the chat.
    Not,
}

impl Span {
    pub fn label(self, asked: u32) -> String {
        match self {
            Span::Minutes(m) if m == asked => format!("{} (as asked)", minutes_label(m)),
            Span::Minutes(m) => minutes_label(m),
            Span::Not => "Save only, no access".into(),
        }
    }
}

/// What the user may pick for `asked` minutes: that, or shorter.
pub fn spans(asked: u32) -> Vec<Span> {
    let mut v = vec![Span::Minutes(asked)];
    v.extend([5, 60].into_iter().filter(|&m| m < asked).map(Span::Minutes));
    v
}

pub fn minutes_label(m: u32) -> String {
    match (m / 60, m % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

pub fn asked_minutes(v: &serde_json::Value) -> u32 {
    v.as_f64().map(|m| m.round().clamp(1.0, MAX_MINUTES as f64) as u32).unwrap_or(DEFAULT_MINUTES)
}

/// Lets `chat` use `names` for `span`, replacing what it had.
pub fn grant(grants: &mut Vec<Grant>, chat: i64, names: &[String], span: Span, now: i64) {
    let Span::Minutes(m) = span else { return };
    let until = now + m as i64 * 60;
    grants.retain(|g| !(g.chat == chat && names.contains(&g.name)));
    grants.extend(names.iter().map(|n| Grant { chat, name: n.clone(), until }));
}

/// The names `chat` may not use now.
pub fn ungranted(grants: &[Grant], chat: i64, names: &[String], now: i64) -> Vec<String> {
    names.iter().filter(|n| !grants.iter().any(|g| g.chat == chat && &g.name == *n && g.until > now)).cloned().collect()
}

/// Takes out the grants whose time is up.
pub fn expire(grants: &mut Vec<Grant>, now: i64) -> Vec<Grant> {
    let (gone, kept) = std::mem::take(grants).into_iter().partition(|g| g.until <= now);
    *grants = kept;
    gone
}

pub fn load_grants(store: &store::Store) -> Vec<Grant> {
    store.get("secret_grants").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_grants(store: &store::Store, grants: &[Grant]) {
    store.set("secret_grants", &serde_json::to_string(grants).unwrap_or_default());
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Keep {
    #[default]
    Harbor,
    File,
    Both,
}

/// What the user picks on a card before answering it.
#[derive(Default)]
pub struct Card {
    pub value: String,
    pub span: usize,
    pub keep: Keep,
    /// Whether git ignores the .env file (None: not in a git project), read once.
    pub ignored: Option<Option<bool>>,
    pub add_ignore: bool,
}

#[derive(Default)]
pub struct State {
    pub asks: Vec<Ask>,
    pub grants: Vec<Grant>,
    /// Each open card's choices, by ask id.
    pub cards: std::collections::HashMap<String, Card>,
    /// Settings › Secrets: names and descriptions, read again after each change.
    pub list: Option<Vec<Secret>>,
    pub name: String,
    pub value: String,
    pub description: String,
    /// The secret whose value is being replaced, and the new value.
    pub replacing: Option<(String, String)>,
    pub error: Option<String>,
    /// Keys pasted into a composer that the user chose to send as they are.
    pub ignored: Vec<String>,
    /// The name a pasted key is saved as, while the user edits it.
    pub paste_name: Option<(String, String)>,
}

/// Known key formats: a prefix and the name such a key usually goes by.
const KNOWN: [(&str, &str); 11] = [
    ("sk-ant-", "ANTHROPIC_API_KEY"),
    ("sk-", "OPENAI_API_KEY"),
    ("github_pat_", "GITHUB_TOKEN"),
    ("ghp_", "GITHUB_TOKEN"),
    ("gho_", "GITHUB_TOKEN"),
    ("glpat-", "GITLAB_TOKEN"),
    ("boat_", "BOAT_API_KEY"),
    ("xoxb-", "SLACK_BOT_TOKEN"),
    ("sk_live_", "STRIPE_SECRET_KEY"),
    ("AKIA", "AWS_ACCESS_KEY_ID"),
    ("AIza", "GOOGLE_API_KEY"),
];

/// A word of `text` that looks like a known kind of key, and the name it'd be saved as.
pub fn pasted_key(text: &str) -> Option<(&str, &'static str)> {
    text.split(|c: char| c.is_whitespace() || "\"'`=:,;()<>[]{}".contains(c)).find_map(|w| {
        let (p, name) = KNOWN.iter().find(|(p, _)| w.starts_with(p))?;
        let rest = &w[p.len()..];
        let shaped = w.len() >= 20 && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') && rest.chars().any(|c| c.is_ascii_digit());
        shaped.then_some((w, *name))
    })
}

pub fn path() -> PathBuf {
    crate::mcp::private_dir(store::data_dir()).join("secrets.json")
}

fn read(p: &Path) -> Vec<Secret> {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write(p: &Path, all: &[Secret]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(all).map_err(|e| e.to_string())?;
    crate::mcp::write_private(p, &json).map_err(|e| format!("can't save {}: {e}", p.display()))
}

pub fn load() -> Vec<Secret> {
    read(&path())
}

/// Names and descriptions, the values left out.
pub fn names() -> Vec<Secret> {
    load().into_iter().map(|s| Secret { value: String::new(), ..s }).collect()
}

/// An environment variable name: letters, digits and `_`, upper case, not starting with a
/// digit ("boat-api-key" is BOAT_API_KEY).
pub fn env_name(s: &str) -> Option<String> {
    let n: String = s.trim().chars().map(|c| if c == '-' || c == ' ' { '_' } else { c.to_ascii_uppercase() }).collect();
    let ok = (1..=64).contains(&n.len()) && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !n.starts_with(|c: char| c.is_ascii_digit());
    ok.then_some(n)
}

/// Adds or replaces `name`; an empty `description` keeps the one it had.
pub fn save(name: &str, value: &str, description: &str) -> Result<String, String> {
    save_at(&path(), name, value, description)
}

fn save_at(p: &Path, name: &str, value: &str, description: &str) -> Result<String, String> {
    let name = env_name(name).ok_or("A name has letters, digits and _ only, like BOAT_API_KEY.")?;
    let value = value.trim();
    if value.chars().count() < MIN_LEN {
        return Err(format!("The value needs at least {MIN_LEN} characters."));
    }
    let mut all = read(p);
    let description = description.trim();
    match all.iter_mut().find(|s| s.name == name) {
        Some(s) => {
            s.value = value.into();
            if !description.is_empty() {
                s.description = description.into();
            }
            s.updated = store::now();
        }
        None => all.push(Secret { name: name.clone(), description: description.into(), value: value.into(), updated: store::now() }),
    }
    all.sort_by(|a, b| a.name.cmp(&b.name));
    write(p, &all)?;
    Ok(name)
}

pub fn delete(name: &str) -> Result<(), String> {
    delete_at(&path(), name)
}

fn delete_at(p: &Path, name: &str) -> Result<(), String> {
    let mut all = read(p);
    all.retain(|s| s.name != name);
    write(p, &all)
}

pub fn load_asks(store: &store::Store) -> Vec<Ask> {
    store.get("secret_asks").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_asks(store: &store::Store, asks: &[Ask]) {
    store.set("secret_asks", &serde_json::to_string(asks).unwrap_or_default());
}

/// A variable name as a .env file has it (case kept): letters, digits and `_`.
pub fn env_var_name(s: &str) -> Option<String> {
    let n = s.trim();
    let ok = (1..=64).contains(&n.len()) && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !n.starts_with(|c: char| c.is_ascii_digit());
    ok.then(|| n.to_string())
}

/// Where Harbor may write a key for `file`: a file named `.env` or `.env.*`, in a folder that
/// exists inside `root` (symlinks resolved), and not itself a symlink.
pub fn env_path(root: &Path, file: &str) -> Result<PathBuf, String> {
    let file = file.trim();
    let p = Path::new(file);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name != ".env" && !(name.starts_with(".env.") && name.len() > 5) {
        return Err(format!("'{file}' isn't a .env file: only files named .env or .env.something"));
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("'{file}' goes outside the project"));
    }
    let root = root.canonicalize().map_err(|e| format!("can't open the project folder {}: {e}", root.display()))?;
    let full = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    let dir = full.parent().unwrap_or(&root);
    let dir = dir.canonicalize().map_err(|_| format!("the folder of '{file}' doesn't exist"))?;
    if !dir.starts_with(&root) {
        return Err(format!("'{file}' is outside the project ({})", root.display()));
    }
    let target = dir.join(name);
    match std::fs::symlink_metadata(&target) {
        Ok(m) if m.file_type().is_symlink() => Err(format!("'{file}' is a symlink; Harbor writes only plain files")),
        Ok(m) if !m.is_file() => Err(format!("'{file}' isn't a file")),
        _ => Ok(target),
    }
}

/// `VAR=value`, quoted when the value needs it: single quotes keep everything as is,
/// double quotes (with `\\`, `\"` and `\n`) when it holds a single quote or a line break.
pub fn env_line(var: &str, value: &str) -> String {
    let plain = !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || "_-./:+@,~%".contains(c));
    if plain {
        format!("{var}={value}")
    } else if !value.contains(['\'', '\n', '\r']) {
        format!("{var}='{value}'")
    } else {
        let v = value.replace('\\', "\\\\").replace('"', "\\\"").replace('\r', "").replace('\n', "\\n");
        format!("{var}=\"{v}\"")
    }
}

/// `text` (a .env file) with `var` set to `value`: its line replaced where it was (an
/// `export ` before it kept), later copies dropped, or a line added at the end.
pub fn set_env_var(text: &str, var: &str, value: &str) -> String {
    let line = env_line(var, value);
    let mut out: Vec<String> = vec![];
    let mut done = false;
    for l in text.lines() {
        let t = l.trim_start();
        let export = t.starts_with("export ");
        let rest = t.strip_prefix("export ").unwrap_or(t).trim_start();
        let is_var = rest.strip_prefix(var).is_some_and(|r| r.trim_start().starts_with('='));
        if !is_var {
            out.push(l.to_string());
        } else if !done {
            out.push(if export { format!("export {line}") } else { line.clone() });
            done = true;
        }
    }
    if !done {
        out.push(line);
    }
    out.join("\n") + "\n"
}

/// Sets `var` in the .env file at `path` (from [`env_path`]); a new file is owner-only.
pub fn write_env(path: &Path, var: &str, value: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let old = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("can't read {}: {e}", path.display())),
    };
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path).map_err(|e| format!("can't write {}: {e}", path.display()))?;
    f.write_all(set_env_var(&old, var, value).as_bytes()).map_err(|e| format!("can't write {}: {e}", path.display()))
}

fn git(root: &Path, args: &[&str]) -> Option<std::process::Output> {
    Command::new("git").arg("-C").arg(root).args(args).stdin(Stdio::null()).output().ok()
}

/// Whether git keeps `path` out of commits: None outside a git project; a tracked file is
/// not ignored, whatever .gitignore says.
pub fn git_ignored(root: &Path, path: &Path) -> Option<bool> {
    let top = git(root, &["rev-parse", "--show-toplevel"]).filter(|o| o.status.success())?;
    let top = PathBuf::from(String::from_utf8_lossy(&top.stdout).trim());
    let p = path.to_string_lossy();
    if git(&top, &["ls-files", "--error-unmatch", "--", &p]).is_some_and(|o| o.status.success()) {
        return Some(false);
    }
    Some(git(&top, &["check-ignore", "-q", "--no-index", "--", &p]).is_some_and(|o| o.status.success()))
}

/// Adds `path` to the .gitignore at the top of its git project.
pub fn add_to_gitignore(root: &Path, path: &Path) -> Result<(), String> {
    use std::io::Write;
    let top = git(root, &["rev-parse", "--show-toplevel"]).filter(|o| o.status.success()).ok_or("not a git project")?;
    let top = PathBuf::from(String::from_utf8_lossy(&top.stdout).trim()).canonicalize().map_err(|e| e.to_string())?;
    let rel = path.strip_prefix(&top).map_err(|_| "the file is outside the git project".to_string())?;
    let file = top.join(".gitignore");
    let old = std::fs::read_to_string(&file).unwrap_or_default();
    let sep = if old.is_empty() || old.ends_with('\n') { "" } else { "\n" };
    let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&file).map_err(|e| format!("can't write {}: {e}", file.display()))?;
    writeln!(f, "{sep}/{}", rel.display()).map_err(|e| format!("can't write {}: {e}", file.display()))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// The base64 characters that `value` alone decides, when it starts `skip` bytes into the
/// encoded data: what shows inside a longer base64 text ("user:key" in a Basic header).
fn b64_core(value: &[u8], skip: usize) -> String {
    let mut data = vec![0u8; skip];
    data.extend_from_slice(value);
    let bits = data.len() * 8;
    let (first, end) = ((skip * 8).div_ceil(6), bits / 6);
    (first..end)
        .map(|i| {
            let n = (i * 6..i * 6 + 6).fold(0usize, |n, b| n << 1 | (data[b / 8] >> (7 - b % 8) & 1) as usize);
            B64[n] as char
        })
        .collect()
}

/// Every form `value` may take in output.
fn forms(value: &str) -> Vec<String> {
    let b = value.as_bytes();
    let mut v = vec![value.to_string()];
    let json = serde_json::to_string(value).unwrap_or_default();
    v.push(json[1..json.len() - 1].to_string());
    let url: String = b
        .iter()
        .map(|&c| if c.is_ascii_alphanumeric() || b"-._~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") })
        .collect();
    v.push(lower_escapes(&url));
    v.push(url);
    let hex: String = b.iter().map(|c| format!("{c:02x}")).collect();
    v.push(hex.to_uppercase());
    v.push(hex);
    for skip in 0..3 {
        let core = b64_core(b, skip);
        v.push(core.replace('+', "-").replace('/', "_"));
        v.push(core);
    }
    v.retain(|f| f.chars().count() >= MIN_LEN);
    v.sort();
    v.dedup();
    v
}

/// `%2F` as `%2f`: some encoders write lower-case escapes.
fn lower_escapes(url: &str) -> String {
    let mut out = String::with_capacity(url.len());
    let mut left = 0;
    for c in url.chars() {
        if c == '%' {
            left = 2;
            out.push(c);
        } else if left > 0 {
            left -= 1;
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// `text` with every form of each (name, value) replaced by `[hidden: NAME]`. Not a boundary:
/// a command can re-encode a value, and agents run as the user, who can read the file.
pub fn scrub(text: &str, secrets: &[(String, String)]) -> String {
    let mut all: Vec<(String, &str)> = secrets.iter().flat_map(|(n, v)| forms(v).into_iter().map(move |f| (f, n.as_str()))).collect();
    // Longest first: a value that holds another one goes whole.
    all.sort_by_key(|(f, _)| std::cmp::Reverse(f.len()));
    let mut out = text.to_string();
    for (f, n) in all {
        if out.contains(&f) {
            out = out.replace(&f, &format!("[hidden: {n}]"));
        }
    }
    out
}

/// Output cut short (the cap, a timeout) may end partway through a value: that start goes too.
fn drop_partial(text: &str, secrets: &[(String, String)]) -> String {
    let forms: Vec<String> = secrets.iter().flat_map(|(_, v)| forms(v)).collect();
    let mut out = text.to_string();
    for f in &forms {
        let cut = (MIN_LEN - 1..f.len()).rev().filter(|&n| f.is_char_boundary(n)).find(|&n| out.ends_with(&f[..n]));
        if let Some(n) = cut {
            out.truncate(out.len() - n);
            out.push_str("[hidden]");
        }
    }
    out
}

/// Runs `cmd` in `cwd` with `secrets` as environment variables and the agent's own
/// environment otherwise (mcp::agent_env); the output comes back scrubbed. Err: it
/// couldn't start, or ran out of time.
pub fn run(cmd: &str, cwd: &Path, secrets: &[(String, String)], timeout: Duration) -> Result<String, String> {
    let mut c = Command::new("bash");
    for (k, v) in crate::mcp::agent_env() {
        match v {
            Some(v) => c.env(k, v),
            None => c.env_remove(k),
        };
    }
    c.args(["-lc", cmd])
        .current_dir(cwd)
        .env("PATH", crate::providers::child_path())
        .envs(secrets.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own group: a timeout ends whatever it started too.
        .process_group(0);
    let mut child = c.spawn().map_err(|e| format!("can't run bash: {e}"))?;
    let (out, err) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let t = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if t.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                crate::procs::signal_group("-KILL", child.id());
                let _ = child.wait();
                break None;
            }
        }
    };
    // Something it started outside its group may hold the pipes open: what came so far.
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && (Arc::strong_count(&out.0) > 1 || Arc::strong_count(&err.0) > 1) {
        std::thread::sleep(Duration::from_millis(20));
    }
    let text = |b: &(Arc<Mutex<Vec<u8>>>, Arc<Mutex<bool>>)| {
        let raw = String::from_utf8_lossy(&b.0.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
        let cut = status.is_none() || *b.1.lock().unwrap_or_else(|e| e.into_inner()) || Arc::strong_count(&b.0) > 1;
        let clean = scrub(&raw, secrets);
        if cut { drop_partial(&clean, secrets) } else { clean }
    };
    let (stdout, stderr) = (text(&out), text(&err));
    let mut body = stdout.trim_end().to_string();
    if !stderr.trim().is_empty() {
        body.push_str(&format!("\n--- stderr ---\n{}", stderr.trim_end()));
    }
    let body = crate::app::clip_middle(body, SHOWN);
    let secs = t.elapsed().as_secs_f32();
    match status {
        Some(s) => Ok(format!("{} ({secs:.1}s)\n{body}", s.code().map(|c| format!("exit code {c}")).unwrap_or_else(|| "killed by a signal".into()))),
        None => Err(format!("timed out after {}s and was stopped\n{body}", timeout.as_secs())),
    }
}

/// Reads a pipe on its own thread: up to [`CAP`] bytes kept (and whether more came), the
/// rest dropped so the command never blocks on a full pipe. The buffer's count falls to
/// one when the pipe closes.
#[allow(clippy::type_complexity)]
fn drain(pipe: Option<impl Read + Send + 'static>) -> (Arc<Mutex<Vec<u8>>>, Arc<Mutex<bool>>) {
    let (buf, over) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(false)));
    if let Some(mut p) = pipe {
        let (b, o) = (buf.clone(), over.clone());
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = p.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut b = b.lock().unwrap_or_else(|e| e.into_inner());
                let room = CAP.saturating_sub(b.len()).min(n);
                b.extend_from_slice(&chunk[..room]);
                if room < n {
                    *o.lock().unwrap_or_else(|e| e.into_inner()) = true;
                }
            }
        });
    }
    (buf, over)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> Vec<(String, String)> {
        vec![("BOAT_API_KEY".into(), "boat_s3cr3t/V4lue+x".into())]
    }

    #[test]
    fn scrubs_the_value_and_its_encodings() {
        let s = key();
        let v = &s[0].1;
        let basic = crate::agent::base64(format!("user:{v}").as_bytes());
        let hex: String = v.bytes().map(|c| format!("{c:02x}")).collect();
        let text = format!(
            "plain {v}\nurl {}\nlower {}\nb64 {}\nbasic {basic}\nurlsafe {}\nhex {hex}\n",
            "boat_s3cr3t%2FV4lue%2Bx",
            "boat_s3cr3t%2fV4lue%2bx",
            crate::agent::base64(v.as_bytes()),
            crate::agent::base64(v.as_bytes()).replace('+', "-").replace('/', "_"),
        );
        let out = scrub(&text, &s);
        assert!(!out.contains("s3cr3t"), "{out}");
        assert!(!out.contains(&hex), "{out}");
        for line in out.lines() {
            assert!(line.contains("[hidden: BOAT_API_KEY]"), "{line}");
        }
        // Basic auth: "user:" stays readable around the hidden part, a few chars at most.
        let b = out.lines().find(|l| l.starts_with("basic")).unwrap();
        assert!(b.len() < "basic ".len() + "[hidden: BOAT_API_KEY]".len() + 8, "{b}");
    }

    #[test]
    fn base64_cores_are_found_at_any_offset() {
        let v = b"abcdefgh12345";
        for pre in ["", "x", "xy", "xyz:"] {
            let mut data = pre.as_bytes().to_vec();
            data.extend_from_slice(v);
            data.extend_from_slice(b"!tail");
            let enc = crate::agent::base64(&data);
            assert!((0..3).any(|k| enc.contains(&b64_core(v, k))), "{pre}: {enc}");
        }
    }

    #[test]
    fn scrubs_json_escaped_values() {
        let s = vec![("PW".to_string(), "pa\"ss\\word".to_string())];
        let out = scrub(&serde_json::json!({ "pw": s[0].1 }).to_string(), &s);
        assert_eq!(out, "{\"pw\":\"[hidden: PW]\"}");
    }

    #[test]
    fn leaves_other_text_alone() {
        assert_eq!(scrub("nothing to see here\n", &key()), "nothing to see here\n");
        assert_eq!(scrub("a", &[]), "a");
    }

    #[test]
    fn a_cut_value_loses_its_start_too() {
        let s = key();
        assert_eq!(drop_partial("token: boat_s3cr", &s), "token: [hidden]");
        assert_eq!(drop_partial("done", &s), "done");
    }

    #[test]
    fn spots_pasted_keys() {
        assert_eq!(pasted_key("use BOAT_API_KEY=boat_9f8e7d6c5b4a3f2e1d0c please"), Some(("boat_9f8e7d6c5b4a3f2e1d0c", "BOAT_API_KEY")));
        assert_eq!(pasted_key("token: `ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7`").map(|k| k.1), Some("GITHUB_TOKEN"));
        assert_eq!(pasted_key("sk-ant-api03-abcDEF123456789xyz").map(|k| k.1), Some("ANTHROPIC_API_KEY"));
        assert_eq!(pasted_key("rename boat_api_key_handler_function"), None);
        assert_eq!(pasted_key("sk-short1"), None);
    }

    #[test]
    fn names_are_env_variables() {
        assert_eq!(env_name("boat-api-key").as_deref(), Some("BOAT_API_KEY"));
        assert_eq!(env_name(" OPENAI_API_KEY ").as_deref(), Some("OPENAI_API_KEY"));
        assert_eq!(env_name("1KEY"), None);
        assert_eq!(env_name("A=B"), None);
        assert_eq!(env_name(""), None);
    }

    #[test]
    fn stores_values_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("harbor-secrets-{}", store::new_uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("secrets.json");
        assert_eq!(save_at(&p, "boat_api_key", "  boat_123456  ", "Boat CLI").unwrap(), "BOAT_API_KEY");
        save_at(&p, "BOAT_API_KEY", "boat_654321", "").unwrap();
        assert!(save_at(&p, "X", "abc", "").is_err());
        let all = read(&p);
        assert_eq!(all.len(), 1);
        assert_eq!((all[0].value.as_str(), all[0].description.as_str()), ("boat_654321", "Boat CLI"));
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(!format!("{:?}", all[0]).contains("654321"));
        delete_at(&p, "BOAT_API_KEY").unwrap();
        assert!(read(&p).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn runs_with_the_secret_and_hides_it() {
        let s = key();
        let cwd = std::env::temp_dir();
        let out = run("echo \"$BOAT_API_KEY\"; printf %s \"$BOAT_API_KEY\" | base64 >&2; exit 3", &cwd, &s, Duration::from_secs(20)).unwrap();
        assert!(out.starts_with("exit code 3"), "{out}");
        assert!(!out.contains("s3cr3t"), "{out}");
        assert_eq!(out.matches("[hidden: BOAT_API_KEY]").count(), 2, "{out}");
        let slow = run("printf 'boat_s3c'; sleep 30", &cwd, &s, Duration::from_millis(500)).unwrap_err();
        assert!(slow.starts_with("timed out") && !slow.contains("boat_s3c"), "{slow}");
    }
    #[test]
    fn grants_expire_and_cover_only_their_chat() {
        let mut g = vec![];
        let names = vec!["A".to_string(), "B".to_string()];
        grant(&mut g, 1, &names, Span::Minutes(15), 1000);
        assert!(ungranted(&g, 1, &names, 1000).is_empty());
        assert_eq!(ungranted(&g, 2, &names, 1000), names, "another chat has none");
        assert_eq!(ungranted(&g, 1, &["C".to_string()], 1000), vec!["C".to_string()]);
        assert!(expire(&mut g, 1000 + 15 * 60 - 1).is_empty());
        assert_eq!(ungranted(&g, 1, &names, 1000 + 15 * 60), names, "ended at its time");
        assert_eq!(expire(&mut g, 1000 + 15 * 60).len(), 2);
        assert!(g.is_empty());
        grant(&mut g, 1, &names, Span::Not, 1000);
        assert!(g.is_empty());
    }

    #[test]
    fn durations_only_get_shorter() {
        assert_eq!(spans(15), vec![Span::Minutes(15), Span::Minutes(5)]);
        assert_eq!(spans(120), vec![Span::Minutes(120), Span::Minutes(5), Span::Minutes(60)]);
        assert_eq!(spans(3), vec![Span::Minutes(3)]);
        assert_eq!(asked_minutes(&serde_json::json!(100000)), MAX_MINUTES);
        assert_eq!(asked_minutes(&serde_json::Value::Null), DEFAULT_MINUTES);
        assert_eq!(minutes_label(90), "1 h 30 min");
        assert_eq!(Span::Minutes(15).label(15), "15 min (as asked)");
        assert_eq!(Span::Not.label(0), "Save only, no access");
    }

    #[test]
    fn env_lines_quote_what_needs_it() {
        assert_eq!(env_line("K", "sk_live_123-abc"), "K=sk_live_123-abc");
        assert_eq!(env_line("K", "a b#c$d\"e"), "K='a b#c$d\"e'");
        assert_eq!(env_line("K", "it's\nx\\"), "K=\"it's\\nx\\\\\"");
    }

    #[test]
    fn env_files_get_the_line_replaced() {
        let old = "# keys\nexport STRIPE_KEY=old\nOTHER=1\nSTRIPE_KEY = older\n";
        assert_eq!(set_env_var(old, "STRIPE_KEY", "sk_new"), "# keys\nexport STRIPE_KEY=sk_new\nOTHER=1\n");
        assert_eq!(set_env_var("A=1", "B", "2"), "A=1\nB=2\n");
        assert_eq!(set_env_var("", "B", "2"), "B=2\n");
        assert_eq!(set_env_var("STRIPE_KEY_2=x\n", "STRIPE_KEY", "y"), "STRIPE_KEY_2=x\nSTRIPE_KEY=y\n");
    }

    #[test]
    fn env_files_stay_in_the_project() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("harbor-env-{}", store::new_uuid()));
        let root = base.join("proj");
        std::fs::create_dir_all(root.join("apps/web")).unwrap();
        std::fs::create_dir_all(base.join("outside")).unwrap();
        std::os::unix::fs::symlink(base.join("outside"), root.join("out")).unwrap();
        std::os::unix::fs::symlink(base.join("outside/.env"), root.join(".env.prod")).unwrap();
        assert!(env_path(&root, ".env.local").is_ok());
        assert!(env_path(&root, "apps/web/.env.development").is_ok());
        assert!(env_path(&root, &root.join(".env").to_string_lossy()).is_ok());
        for bad in ["../.env", "out/.env", ".env.prod", "config.env", ".envrc", "src/.env.x/../.env", "/etc/.env", "nope/.env"] {
            assert!(env_path(&root, bad).is_err(), "{bad}");
        }
        let p = env_path(&root, ".env.local").unwrap();
        write_env(&p, "STRIPE_KEY", "sk_test_1").unwrap();
        write_env(&p, "STRIPE_KEY", "sk test 2").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "STRIPE_KEY='sk test 2'\n");
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn checks_and_fixes_gitignore() {
        let root = std::env::temp_dir().join(format!("harbor-gi-{}", store::new_uuid()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let file = root.join(".env.local");
        assert_eq!(git_ignored(&root, &file), None, "not a git project yet");
        assert!(Command::new("git").arg("-C").arg(&root).args(["init", "-q"]).status().unwrap().success());
        assert_eq!(git_ignored(&root, &file), Some(false));
        add_to_gitignore(&root, &file).unwrap();
        assert_eq!(git_ignored(&root, &file), Some(true));
        assert_eq!(git_ignored(&root, &root.join(".env")), Some(false));
        assert_eq!(std::fs::read_to_string(root.join(".gitignore")).unwrap(), "/.env.local\n");
        let _ = std::fs::remove_dir_all(root);
    }
}
