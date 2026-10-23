//! The Claude login an account has on this PC, for its turns on other devices: the OAuth
//! access token in `<config dir>/.credentials.json`, refreshed when it is about to run out.
//! Claude Code honours `CLAUDE_CODE_OAUTH_TOKEN` over the login saved on the machine it
//! runs on, so a chat pinned to a device runs as the account picked in Harbor, not as
//! whoever signed in there (remote.rs sends it on stdin, never on a command line).
//!
//! Only the access token leaves this PC. The refresh token stays: the CLI rotates it on
//! every refresh, so a copy used elsewhere would sign this PC out. A refresh here is
//! written back for the CLI and the usage monitor, under the flock they share
//! (`.credentials.json.lock`), the same way the usage monitor does it.

use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A token this close to its expiry is refreshed before it goes.
const SKEW_MS: i64 = 5 * 60 * 1000;
/// Claude Code's OAuth client.
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Where a refresh token is exchanged, in order; the second is the older host.
const TOKEN_URLS: [&str; 2] = ["https://platform.claude.com/v1/oauth/token", "https://api.anthropic.com/v1/oauth/token"];
/// A refresh answer without `expires_in` lasts the CLI's usual eight hours.
const DEFAULT_EXPIRES_S: i64 = 28_800;

/// The credentials file of a Claude profile (None: the default, ~/.claude).
pub fn credentials_path(config_dir: Option<&Path>) -> PathBuf {
    config_dir.map(Path::to_path_buf).unwrap_or_else(|| crate::store::home().join(".claude")).join(".credentials.json")
}

/// The account's access token, for a turn starting now. Expiring within five minutes
/// (or expired): refreshed first and written back; a refresh that fails leaves the stale
/// token, so the turn reports the CLI's error rather than silently running as someone
/// else. None: the account isn't signed in on this PC (no file, no token in it).
pub fn token(config_dir: Option<&Path>) -> Option<String> {
    token_at(&credentials_path(config_dir), now_ms(), request_refresh)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `refresh` exchanges a refresh token for the OAuth answer (`access_token`,
/// `refresh_token`, `expires_in`), None when it couldn't.
fn token_at(path: &Path, now_ms: i64, refresh: impl Fn(&str) -> Option<Value>) -> Option<String> {
    let _lock = lock(path);
    let mut data: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let login = &data["claudeAiOauth"];
    let access = clean(login["accessToken"].as_str())?;
    let expires = epoch_ms(&login["expiresAt"]);
    if expires == 0 || expires - SKEW_MS > now_ms {
        return Some(access);
    }
    let Some(rt) = clean(login["refreshToken"].as_str()) else { return Some(access) };
    let rt_expires = epoch_ms(&login["refreshTokenExpiresAt"]);
    if rt_expires > 0 && rt_expires <= now_ms {
        return Some(access);
    }
    let Some(payload) = refresh(&rt) else { return Some(access) };
    match apply(&mut data, &payload, now_ms) {
        // The old refresh token is spent either way: the new login is what counts.
        Some(new) => {
            let _ = write(path, &data);
            Some(new)
        }
        None => Some(access),
    }
}

/// A token as the CLI wrote it: one line, nothing a shell `read` would cut or a log
/// would wrap; None otherwise.
fn clean(s: Option<&str>) -> Option<String> {
    let s = s?.trim();
    (!s.is_empty() && !s.chars().any(|c| c.is_whitespace() || c.is_control())).then(|| s.to_string())
}

/// A time in the file as ms since the epoch; seconds are taken as such (0: none).
fn epoch_ms(v: &Value) -> i64 {
    let n = v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).unwrap_or(0.0);
    if n <= 0.0 {
        0
    } else if n < 1e12 {
        (n * 1000.0) as i64
    } else {
        n as i64
    }
}

/// Puts a refresh answer into the credentials (what the CLI and the usage monitor
/// write): the new access token, the rotated refresh token and the expiry times.
/// Returns the new access token; None for an answer without one (nothing changed).
fn apply(data: &mut Value, payload: &Value, now_ms: i64) -> Option<String> {
    let access = clean(payload["access_token"].as_str())?;
    let expires_in = payload["expires_in"].as_f64().filter(|n| *n > 0.0).map(|n| n as i64).unwrap_or(DEFAULT_EXPIRES_S);
    let login = &mut data["claudeAiOauth"];
    if !login.is_object() {
        *login = json!({});
    }
    login["accessToken"] = Value::String(access.clone());
    if let Some(rt) = clean(payload["refresh_token"].as_str()) {
        login["refreshToken"] = Value::String(rt);
    }
    login["expiresAt"] = Value::from(now_ms + expires_in * 1000);
    if let Some(n) = payload["refresh_token_expires_in"].as_f64().filter(|n| *n > 0.0) {
        login["refreshTokenExpiresAt"] = Value::from(now_ms + n as i64 * 1000);
    }
    Some(access)
}

/// Replaces the file in one step (tmp beside it, then rename), owner-only like the CLI's.
fn write(path: &Path, data: &Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(data).unwrap_or_default() + "\n";
    crate::mcp::write_private(&path.with_file_name(".credentials.json.tmp"), &text)?;
    std::fs::rename(path.with_file_name(".credentials.json.tmp"), path)
}

/// The lock other writers of the file take (`.credentials.json.lock` beside it), held
/// while the guard lives. None when it couldn't be opened: read anyway.
fn lock(path: &Path) -> Option<std::fs::File> {
    let f = std::fs::OpenOptions::new().create(true).write(true).truncate(false).open(path.with_file_name(".credentials.json.lock")).ok()?;
    f.lock().ok()?;
    Some(f)
}

/// Exchanges a refresh token with Anthropic's OAuth endpoint, through `curl` (Harbor has
/// no HTTP client). The body goes on curl's stdin: a token on a command line shows in `ps`.
fn request_refresh(refresh_token: &str) -> Option<Value> {
    let body = json!({ "grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": CLIENT_ID }).to_string();
    for url in TOKEN_URLS {
        let child = Command::new("curl")
            .args(["-fsS", "--connect-timeout", "5", "--max-time", "15", "-X", "POST"])
            .args(["-H", "Content-Type: application/json", "-H", "Accept: application/json", "-A", "claude-code/2.1.0"])
            .args(["--data-binary", "@-", url])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else { return None };
        if let Some(mut sin) = child.stdin.take() {
            let _ = sin.write_all(body.as_bytes());
        }
        let Ok(out) = child.wait_with_output() else { continue };
        if !out.status.success() {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) {
            if clean(v["access_token"].as_str()).is_some() {
                return Some(v);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("harbor-oauth-{}", crate::bridge::token()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn creds(d: &Path, expires_at: i64) -> PathBuf {
        let p = d.join(".credentials.json");
        let v = json!({ "claudeAiOauth": { "accessToken": "sk-ant-oat01-old", "refreshToken": "sk-ant-ort01-old", "expiresAt": expires_at, "scopes": ["user:inference"], "subscriptionType": "max" }, "mcpOAuth": {} });
        std::fs::write(&p, v.to_string()).unwrap();
        p
    }

    #[test]
    fn fresh_token_is_used_as_is() {
        let d = dir();
        let now = 1_700_000_000_000;
        let p = creds(&d, now + 3_600_000);
        let called = std::cell::Cell::new(false);
        let t = token_at(&p, now, |_| {
            called.set(true);
            None
        });
        assert_eq!(t.as_deref(), Some("sk-ant-oat01-old"));
        assert!(!called.get());
        // A credentials file in seconds (older CLIs) means the same.
        let p = creds(&d, (now + 3_600_000) / 1000);
        assert_eq!(token_at(&p, now, |_| None).as_deref(), Some("sk-ant-oat01-old"));
        assert_eq!(credentials_path(None), crate::store::home().join(".claude/.credentials.json"));
        assert_eq!(credentials_path(Some(Path::new("/x/.claude2"))), PathBuf::from("/x/.claude2/.credentials.json"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn expiring_token_is_refreshed_and_written_back() {
        let d = dir();
        let now = 1_700_000_000_000;
        // Four minutes left: within the skew.
        let p = creds(&d, now + 4 * 60_000);
        let t = token_at(&p, now, |rt| {
            assert_eq!(rt, "sk-ant-ort01-old");
            Some(json!({ "access_token": "sk-ant-oat01-new", "refresh_token": "sk-ant-ort01-new", "expires_in": 28800, "token_type": "Bearer" }))
        });
        assert_eq!(t.as_deref(), Some("sk-ant-oat01-new"));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        let login = &v["claudeAiOauth"];
        assert_eq!(login["accessToken"], "sk-ant-oat01-new");
        assert_eq!(login["refreshToken"], "sk-ant-ort01-new");
        assert_eq!(login["expiresAt"], now + 28_800_000);
        // The rest of the file survives the rewrite.
        assert_eq!(login["subscriptionType"], "max");
        assert!(v["mcpOAuth"].is_object());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(d.join(".credentials.json.lock").exists());
        assert!(!d.join(".credentials.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn failed_refresh_keeps_the_stale_token() {
        let d = dir();
        let now = 1_700_000_000_000;
        let p = creds(&d, now - 1);
        assert_eq!(token_at(&p, now, |_| None).as_deref(), Some("sk-ant-oat01-old"));
        // An answer without a token changes nothing either.
        assert_eq!(token_at(&p, now, |_| Some(json!({ "error": "invalid_grant" }))).as_deref(), Some("sk-ant-oat01-old"));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["claudeAiOauth"]["refreshToken"], "sk-ant-ort01-old");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn not_signed_in_means_no_token() {
        let d = dir();
        assert_eq!(token_at(&d.join(".credentials.json"), 0, |_| None), None);
        std::fs::write(d.join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":""}}"#).unwrap();
        assert_eq!(token_at(&d.join(".credentials.json"), 0, |_| None), None);
        std::fs::write(d.join(".credentials.json"), r#"{"mcpOAuth":{}}"#).unwrap();
        assert_eq!(token_at(&d.join(".credentials.json"), 0, |_| None), None);
        // A token that wouldn't survive one `read` line is not sent.
        std::fs::write(d.join(".credentials.json"), "{\"claudeAiOauth\":{\"accessToken\":\"a\\nb\"}}").unwrap();
        assert_eq!(token_at(&d.join(".credentials.json"), 0, |_| None), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn refresh_answer_defaults() {
        let mut v = json!({ "claudeAiOauth": { "accessToken": "a", "refreshToken": "r", "expiresAt": 1 } });
        // No rotated refresh token, no expires_in: the old refresh token stays, 8 h.
        assert_eq!(apply(&mut v, &json!({ "access_token": "b" }), 1000).as_deref(), Some("b"));
        assert_eq!(v["claudeAiOauth"]["refreshToken"], "r");
        assert_eq!(v["claudeAiOauth"]["expiresAt"], 1000 + 28_800_000);
        assert_eq!(apply(&mut v, &json!({ "access_token": "c", "refresh_token": "r2", "expires_in": 60, "refresh_token_expires_in": 120 }), 1000).as_deref(), Some("c"));
        assert_eq!(v["claudeAiOauth"]["refreshToken"], "r2");
        assert_eq!(v["claudeAiOauth"]["expiresAt"], 61_000);
        assert_eq!(v["claudeAiOauth"]["refreshTokenExpiresAt"], 121_000);
        assert_eq!(epoch_ms(&json!(1_700_000_000)), 1_700_000_000_000);
        assert_eq!(epoch_ms(&json!("1700000000000")), 1_700_000_000_000);
        assert_eq!(epoch_ms(&Value::Null), 0);
    }
}
