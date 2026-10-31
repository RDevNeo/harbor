//! Settings follow the account (0.85): what a person chooses (theme, density, keys, run
//! defaults, notifications, voice, recaps, limits…) is the same on every PC they sign in on.
//! What belongs to the machine stays: its TLS identity and ports, the network and router, the
//! mesh and its keys, phones' pairings, windows and sidebars, the last chat, per-chat and
//! per-project marks, and anything holding a secret. [`KEYS`] names every kv key Harbor uses
//! and which side it's on; a test fails when a new key isn't in it.
//!
//! Sync is per key, newest wins: each device keeps when its value of a key last changed (kv
//! `account_sync`, ms) and sends the keys changed here (`PUT /v1/settings`); the service keeps
//! the newest of each and answers with them all. Nothing a PC has is lost: at its first sign-in
//! its own settings win and go up to the account (it only takes the account's values for keys
//! it never set), and every value a later sync replaces is kept in kv `account_sync_backup`.

use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Class {
    /// Follows the account to every PC.
    Account,
    /// Stays on this PC.
    Device,
}

use Class::{Account as A, Device as D};

/// Every kv key, and keys starting with each prefix (ending in `:` or `_`).
pub const KEYS: &[(&str, Class)] = &[
    // Appearance and keys.
    ("theme", A),
    ("density", A),
    ("keybindings", A),
    // What a new thread runs with, and favourite models.
    ("default_account", A),
    ("default_model", A),
    ("default_effort", A),
    ("default_access", A),
    ("favorites", A),
    // The SSH device new threads run on: devices are set up per PC (remote.rs).
    ("default_device", D),
    // The sidebar's workspace filter (ids joined by commas): each device shows its own.
    ("sidebar_workspace", D),
    // How threads behave.
    ("follow_up", A),
    ("resume_on_restart", A),
    ("order_by_activity", A),
    ("fast_mode", A),
    ("bg_keep", A),
    ("auto_update", A),
    ("notify", A),
    ("recap_enabled", A),
    ("suggest_enabled", A),
    ("auto_fix", A),
    ("auto_merge", A),
    ("gh_agent_account", A),
    ("ctx_send", A),
    // Voice.
    ("voice_engine", A),
    ("voice_model", A),
    ("voice_lang2", A),
    ("voice_cleanup", A),
    ("voice_commands", A),
    ("voice_dict", A),
    ("voice_keep_min", A),
    // Usage limits: what threads do at a limit, caps and warnings.
    ("limit_auto", A),
    ("limit_notify", A),
    ("limit_weekly", A),
    ("limit_wait_max", A),
    ("limit_switch", A),
    ("limit_switch_accounts", A),
    ("usage_caps", A),
    ("usage_warn", A),
    // Threads waiting out a limit here, and counters.
    ("limits", D),
    ("recap_count", D),
    // This PC's network, phones and mesh: hardware-bound, and tokens.
    ("api_enabled", D),
    ("api_port", D),
    ("api_tokens", D),
    ("api_revoked", D),
    ("phones_seen", D),
    ("mesh_enabled", D),
    ("mesh_allowed", D),
    ("mesh_id", D),
    ("mesh_pair", D),
    ("mesh_peers", D),
    ("net_forward", D),
    ("net_map", D),
    ("net_name", D),
    ("net_outside", D),
    ("hooks_public", D),
    ("hooks_name", D),
    ("remote_devices", D),
    // Who owns this PC and what other PCs may do here (the account's name is on top of these).
    ("owner_name", D),
    ("owner_github", D),
    ("owner_suggested", D),
    ("share_files", D),
    ("share_github", D),
    ("ctx_memory", D),
    ("ctx_guests", D),
    ("move_pc", D),
    // Windows, sidebars, history and dismissed notices.
    ("sidebar_open", D),
    ("video_volume", D),
    ("show_team", D),
    ("collapsed", D),
    ("agents_settled_open", D),
    ("last_chat", D),
    ("draft_repo", D),
    ("draft_main", D),
    ("snoozed", D),
    ("palette_recent", D),
    ("browser_last", D),
    ("browser_recent", D),
    ("reload_state", D),
    ("bg_explained", D),
    ("bg_update_noticed", D),
    ("update_toast_dismissed", D),
    ("provider_updates_dismissed", D),
    ("owner_toast_dismissed", D),
    ("agent_settle", D),
    // Per chat (by local id), and one-time migrations of this PC's database.
    ("chat_prs", D),
    ("effort_default_medium", D),
    // Secrets and who may use them: never leave the PC.
    ("secret_asks", D),
    ("secret_grants", D),
    ("auto_handled", D),
    // The account's own state (account.rs, this file).
    ("account", D),
    ("account_ws", D),
    ("account_dir", D),
    ("account_keys", D),
    ("account_sync", D),
    ("account_sync_backup", D),
    // Per chat and per project.
    ("worktree:", D),
    ("worktree_move:", D),
    ("worktree_named:", D),
    ("worktree_note:", D),
    ("recap:", D),
    ("recap_users:", D),
    ("suggestion:", D),
    ("untrusted:", D),
    ("forks_of_", D),
];

/// Which side a key is on; unknown keys stay on the PC.
pub fn class(key: &str) -> Class {
    KEYS.iter().find(|(k, _)| *k == key || ((k.ends_with(':') || k.ends_with('_')) && key.starts_with(k))).map_or(D, |(_, c)| *c)
}

/// Keys changed on this PC since they were last sent: key → when (ms).
static DIRTY: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);
/// Per key: when this PC's value changed last, here or on another device (ms).
static AT: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);
/// Settings came from the account: the desktop reads them again.
pub static RELOAD: AtomicBool = AtomicBool::new(false);
/// The mark in `AT` that the first sync after signing in is done.
const SYNCED: &str = "~";
/// Values are capped like the service caps them.
const MAX_VALUE: usize = 16 << 10;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `Store::set` of any key: an account setting is marked to be sent.
pub fn changed(key: &str) {
    if class(key) == Class::Account && !cfg!(test) {
        let t = now_ms();
        DIRTY.lock().unwrap().insert(key.to_string(), t);
        AT.lock().unwrap().insert(key.to_string(), t);
        crate::account::poke_sync();
    }
}

pub fn load(s: &crate::store::Store) {
    *AT.lock().unwrap() = s.get("account_sync").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
}

/// Someone just signed in: this PC takes the account's settings, then adds what it lacks.
pub fn signed_in() {
    DIRTY.lock().unwrap().clear();
    AT.lock().unwrap().clear();
    if let Ok(s) = crate::store::Store::open() {
        s.set("account_sync", "{}");
    }
}

fn save_at(s: &crate::store::Store) {
    let at = AT.lock().unwrap().clone();
    s.set("account_sync", &serde_json::to_string(&at).unwrap_or_default());
}

/// Takes the account's values that are newer than this PC's: written without being sent back.
/// True when something changed.
pub fn apply(s: &crate::store::Store, remote: &Map<String, Value>) -> bool {
    let mut changed = false;
    let dirty = DIRTY.lock().unwrap().clone();
    let mut at = AT.lock().unwrap();
    for (k, e) in remote {
        if class(k) != Class::Account {
            continue; // never this PC's own keys, whatever the service holds
        }
        let t = e["at"].as_i64().unwrap_or(0);
        if t <= at.get(k).copied().unwrap_or(0) || dirty.get(k).is_some_and(|d| *d >= t) {
            continue;
        }
        let v = e["v"].as_str().unwrap_or("");
        let had = s.get(k).unwrap_or_default();
        if v.len() <= MAX_VALUE && had != v {
            backup(s, k, &had);
            s.set_quiet(k, v);
            changed = true;
        }
        at.insert(k.clone(), t);
    }
    drop(at);
    if changed {
        RELOAD.store(true, Ordering::SeqCst);
    }
    changed
}

/// Keeps what a key held before the account replaced it (kv `account_sync_backup`: key → the
/// last value this PC had of its own).
fn backup(s: &crate::store::Store, key: &str, had: &str) {
    if had.is_empty() {
        return;
    }
    let mut b: Map<String, Value> = s.get("account_sync_backup").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
    b.insert(key.to_string(), json!(had));
    s.set_quiet("account_sync_backup", &serde_json::to_string(&b).unwrap_or_default());
}

/// At the first sign-in: the account's values for the keys this PC never set (`own` are the
/// ones it has).
fn first_fill(own: &[&str], remote: Map<String, Value>) -> Map<String, Value> {
    remote.into_iter().filter(|(k, _)| !own.contains(&k.as_str())).collect()
}

/// One round with the service: a first sync after signing in, the keys changed here, and the
/// account's (with `pull`, or when something was sent).
pub fn sync(token: &str, pull: bool) -> Result<(), crate::account::Fail> {
    let Ok(s) = crate::store::Store::open() else { return Ok(()) };
    let first = AT.lock().unwrap().is_empty();
    if first {
        let v = crate::account::settings_call(token, None)?;
        let remote = v["settings"].as_object().cloned().unwrap_or_default();
        // This PC's own settings win and go up; the account's fill only what it never set.
        let t = now_ms();
        let own: Vec<&str> = KEYS.iter().filter(|(k, c)| *c == Class::Account && !k.ends_with(':') && !k.ends_with('_') && s.get(k).is_some_and(|v| !v.is_empty())).map(|(k, _)| *k).collect();
        let fill = first_fill(&own, remote);
        apply(&s, &fill);
        let mut dirty = DIRTY.lock().unwrap();
        let mut at = AT.lock().unwrap();
        for k in own {
            dirty.insert(k.to_string(), t);
            at.insert(k.to_string(), t);
        }
        // Done once, also for an account with nothing and a PC with defaults only.
        at.insert(SYNCED.into(), t);
        drop((dirty, at));
        save_at(&s);
    }
    let dirty = DIRTY.lock().unwrap().clone();
    if !dirty.is_empty() {
        let set: Map<String, Value> = dirty.iter().map(|(k, t)| (k.clone(), json!({ "v": s.get(k).unwrap_or_default().chars().take(MAX_VALUE).collect::<String>(), "at": t }))).collect();
        let v = crate::account::settings_call(token, Some(&json!({ "set": set })))?;
        // Sent: unless it changed again meanwhile.
        let mut d = DIRTY.lock().unwrap();
        for (k, t) in &dirty {
            if d.get(k) == Some(t) {
                d.remove(k);
            }
        }
        drop(d);
        apply(&s, &v["settings"].as_object().cloned().unwrap_or_default());
        save_at(&s);
    } else if pull && !first {
        let v = crate::account::settings_call(token, None)?;
        if apply(&s, &v["settings"].as_object().cloned().unwrap_or_default()) {
            save_at(&s);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes() {
        assert_eq!(class("theme"), Class::Account);
        assert_eq!(class("api_tokens"), Class::Device);
        assert_eq!(class("worktree:12"), Class::Device);
        assert_eq!(class("forks_of_3"), Class::Device);
        assert_eq!(class("something_new"), Class::Device, "unknown keys stay");
        let mut seen = std::collections::HashSet::new();
        assert!(KEYS.iter().all(|(k, _)| seen.insert(*k)), "a key listed twice");
    }

    /// Every kv key in the source is classified: a new setting has to pick a side.
    #[test]
    fn every_kv_key_is_classified() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut missing = vec![];
        // `store.get("key")`, `s.set(KEY, …)`: string literals and the constants they name.
        let mut consts: HashMap<String, String> = HashMap::new();
        let files: Vec<(String, String)> = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "rs")).map(|e| (e.file_name().to_string_lossy().to_string(), std::fs::read_to_string(e.path()).unwrap())).collect();
        for (_, src) in &files {
            for line in src.lines() {
                let l = line.trim();
                if let Some(rest) = l.strip_prefix("pub const ").or_else(|| l.strip_prefix("const ")) {
                    if let Some((name, val)) = rest.split_once(": &str = \"") {
                        consts.insert(name.trim().to_string(), val.trim_end_matches("\";").to_string());
                    }
                }
            }
        }
        // (Not this file: its own examples aren't keys.)
        for (file, src) in files.iter().filter(|(f, _)| f != "settingsync.rs") {
            for line in src.lines() {
                for recv in ["store.get(", "store.set(", "store.set_quiet(", "s.get(", "s.set(", "st.get(", "st.set("] {
                    for (i, _) in line.match_indices(recv) {
                        // `self.store.get(`, `store.get(` — but not `xs.get(` or `json.get(`.
                        let before = line[..i].chars().last();
                        if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                            continue;
                        }
                        let arg = line[i + recv.len()..].trim_start().trim_start_matches('&');
                        let key = if let Some(lit) = arg.strip_prefix('"') {
                            lit.split('"').next().unwrap_or("").to_string()
                        } else if let Some(f) = arg.strip_prefix("format!(\"") {
                            f.split(['{', '"']).next().unwrap_or("").to_string()
                        } else {
                            let name: String = arg.chars().take_while(|c| c.is_ascii_uppercase() || *c == '_').collect();
                            match consts.get(&name) {
                                Some(v) => v.clone(),
                                None => continue,
                            }
                        };
                        if key.is_empty() || !key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == ':') {
                            continue;
                        }
                        let listed = KEYS.iter().any(|(k, _)| *k == key || ((k.ends_with(':') || k.ends_with('_')) && key.starts_with(k)));
                        // JSON fields read with `s.get("…")` on a Value aren't kv keys.
                        const NOT_KV: &[&str] = &["id", "text", "state", "error", "url", "time", "files", "commit", "repo", "result", "update", "chats", "status"];
                        if !listed && !NOT_KV.contains(&key.as_str()) {
                            missing.push(format!("{file}: {key}"));
                        }
                    }
                }
            }
        }
        missing.sort();
        missing.dedup();
        assert!(missing.is_empty(), "kv keys not in settingsync::KEYS (pick Account or Device): {missing:?}");
    }

    #[test]
    fn first_sign_in_keeps_this_pcs_settings() {
        let remote: Map<String, Value> = serde_json::from_value(json!({ "theme": { "v": "light", "at": 9 }, "density": { "v": "compact", "at": 9 } })).unwrap();
        let fill = first_fill(&["theme"], remote);
        assert!(!fill.contains_key("theme"), "this PC's theme stays (and goes up)");
        assert!(fill.contains_key("density"), "a key it never set comes from the account");
    }

    #[test]
    fn replaced_values_are_backed_up() {
        let s = crate::store::Store::open_temp();
        s.set_quiet("voice_lang2", "pt");
        let remote: Map<String, Value> = serde_json::from_value(json!({ "voice_lang2": { "v": "en", "at": i64::MAX - 1 } })).unwrap();
        AT.lock().unwrap().remove("voice_lang2");
        apply(&s, &remote);
        assert_eq!(s.get("voice_lang2").as_deref(), Some("en"));
        let b: Value = serde_json::from_str(&s.get("account_sync_backup").unwrap()).unwrap();
        assert_eq!(b["voice_lang2"], "pt", "the PC's own value is kept");
        AT.lock().unwrap().remove("voice_lang2");
    }

    #[test]
    fn newest_wins() {
        let s = crate::store::Store::open_temp();
        AT.lock().unwrap().clear();
        DIRTY.lock().unwrap().clear();
        s.set_quiet("theme", "dark");
        AT.lock().unwrap().insert("theme".into(), 100);
        let remote: Map<String, Value> = serde_json::from_value(json!({ "theme": { "v": "light", "at": 50 }, "density": { "v": "compact", "at": 200 }, "api_tokens": { "v": "[]", "at": 999 } })).unwrap();
        assert!(apply(&s, &remote));
        assert_eq!(s.get("theme").as_deref(), Some("dark"), "older remote value loses");
        assert_eq!(s.get("density").as_deref(), Some("compact"), "newer remote value wins");
        assert_eq!(s.get("api_tokens"), None, "device keys never come from the account");
        let remote: Map<String, Value> = serde_json::from_value(json!({ "theme": { "v": "light", "at": 150 } })).unwrap();
        DIRTY.lock().unwrap().insert("theme".into(), 160);
        apply(&s, &remote);
        assert_eq!(s.get("theme").as_deref(), Some("dark"), "a newer change here, not sent yet, wins");
        DIRTY.lock().unwrap().clear();
        AT.lock().unwrap().clear();
    }
}
