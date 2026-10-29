//! Whose instructions and memory a turn runs with, and the mesh's "who is who".
//!
//! A chat runs on its home PC, but the person driving it may sit at another PC of the mesh
//! (mesh.rs forwards their messages). Claude Code would load the home PC's own user context
//! (`~/.claude/CLAUDE.md`, its auto-memory, its settings) and save what it learns there:
//! someone else's instructions and memory, in someone else's folder. Instead:
//!
//! - **The commanding PC sends its context.** Every call it forwards to a chat's home PC
//!   carries `ctx` ([`outgoing`]): its default Claude profile's `CLAUDE.md`, the auto-memory
//!   of the chat's project as it has it, a few personal settings ([`SETTINGS`]), and a
//!   `memory_id` naming that memory folder there. Settings › Devices can stop sending it.
//! - **The home PC runs the turn in an overlay.** A chat commanded from another PC runs with
//!   `CLAUDE_CONFIG_DIR` at `<data>/guests/<peer>/` ([`apply`] writes the context there), the
//!   account's login passed as `CLAUDE_CODE_OAUTH_TOKEN`, lent to the overlay while the turn
//!   runs (oauth.rs `lend`).
//!   The host's own instructions, memory, skills and settings don't load. The host's GitHub
//!   and app sign-ins are its owner's: off for the guest unless both say the same GitHub login.
//! - **Memory goes home.** After the turn the overlay's memory folder is compared with what
//!   came ([`push`]); changes go to the commanding PC (`POST /mesh/v1/memory`), which writes
//!   them into the folder its `memory_id` names ([`accept_memory`]), nowhere else. A push
//!   that fails is retried after the next turn; until then the overlay's copy wins.
//! - **SSH devices** (remote.rs) run the same way without a home PC in between: the device's
//!   own profile is swapped for an empty one and the instructions and memory go in the
//!   system prompt ([`device_note`]).
//! - **Who is who.** Each PC says its owner and GitHub login (`hello`, `/mesh/v1/phones`);
//!   with the PCs, their phones and accounts this becomes a note every turn gets ([`people_note`]).

use crate::store::{self, Store};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The longest instructions file sent.
const INSTR_MAX: usize = 40_000;
/// Memory: one file, all files, and how many.
const MEM_FILE_MAX: usize = 64 * 1024;
const MEM_TOTAL_MAX: usize = 512 * 1024;
const MEM_FILES_MAX: usize = 100;
/// Claude Code settings that are the person's, not the PC's: only these travel (never
/// hooks, permissions, env or helpers, which would run things on the host).
pub const SETTINGS: &[&str] = &["language", "outputStyle", "alwaysThinkingEnabled", "includeCoAuthoredBy", "attribution", "autoMemoryEnabled"];
/// How long a memory folder handed out stays writable by the PC that got it.
const MEM_TTL: i64 = 30 * 86400;
/// kv: memory folders handed out, `{id: {dir, at}}`.
const MEM_KEY: &str = "ctx_memory";
/// kv: "0" = don't send this PC's instructions and memory with chats on other PCs.
pub const SEND_KEY: &str = "ctx_send";
/// kv: the owner's name and GitHub login as this PC tells the mesh (empty: guessed).
pub const OWNER_KEY: &str = "owner_name";
pub const GITHUB_KEY: &str = "owner_github";
/// kv: chats commanded from another PC, `{chat id: Guest}`.
const GUESTS_KEY: &str = "ctx_guests";
/// A memory file name: flat, Markdown.
fn mem_name_ok(n: &str) -> bool {
    n.len() <= 120 && n.ends_with(".md") && !n.starts_with('.') && n.chars().all(|c| c.is_ascii_alphanumeric() || "._- ".contains(c))
}

/// This PC's person's Claude profile: the default one (~/.claude), as a turn of the default
/// account sees it. Other profiles (~/.claude2…) may be other people's logins.
pub fn profile() -> PathBuf {
    store::home().join(".claude")
}

/// The auto-memory folder of `project` in the profile `config`.
pub fn memory_dir(config: &Path, project: &Path) -> PathBuf {
    config.join("projects").join(crate::movechat::project_slug(project)).join("memory")
}

/// `t`'s first `max` bytes at most, cut at a character boundary.
fn cut(t: &str, max: usize) -> &str {
    &t[..(0..=max.min(t.len())).rev().find(|i| t.is_char_boundary(*i)).unwrap_or(0)]
}

fn read_cap(p: &Path, max: usize) -> String {
    let t = std::fs::read_to_string(p).unwrap_or_default();
    if t.len() <= max {
        return t;
    }
    format!("{}\n[… cut]", cut(&t, max))
}

/// The memory files of a folder: name → text, within the limits.
pub fn read_memory(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut total = 0;
    let mut names: Vec<String> = std::fs::read_dir(dir).map(|d| d.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| mem_name_ok(n)).collect()).unwrap_or_default();
    names.sort();
    // The index first: it's what Claude Code loads.
    if let Some(i) = names.iter().position(|n| n == "MEMORY.md") {
        let n = names.remove(i);
        names.insert(0, n);
    }
    for n in names.into_iter().take(MEM_FILES_MAX) {
        let Ok(t) = std::fs::read_to_string(dir.join(&n)) else { continue };
        if t.len() > MEM_FILE_MAX || total + t.len() > MEM_TOTAL_MAX {
            continue;
        }
        total += t.len();
        out.insert(n, t);
    }
    out
}

fn settings_of(v: &Value) -> Map<String, Value> {
    SETTINGS.iter().filter_map(|k| v.get(*k).map(|x| (k.to_string(), x.clone()))).collect()
}

// ================================================================== the commanding PC

/// The `ctx` a forwarded call carries: this PC's person's instructions, the memory of
/// `project` (this PC's folder of the chat's project, or None), settings, and the id the
/// home PC sends memory back with. `{"v": 1, "off": true}` when the user doesn't send it.
pub fn outgoing(s: &Store, project: Option<&Path>) -> Value {
    let me = about(s);
    if s.get(SEND_KEY).as_deref() == Some("0") {
        return json!({ "v": 1, "off": true, "owner": me["owner"], "github": me["github"] });
    }
    let p = profile();
    let settings: Value = std::fs::read_to_string(p.join("settings.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    // A chat without a project runs in home there: its memory is home's here.
    let home = store::home();
    let dir = Some(memory_dir(&p, project.unwrap_or(&home)));
    let memory = dir.as_deref().map(read_memory).unwrap_or_default();
    let id = dir.as_deref().and_then(|d| register(s, d)).unwrap_or_default();
    json!({
        "v": 1,
        "instructions": read_cap(&p.join("CLAUDE.md"), INSTR_MAX),
        "memory": memory,
        "memory_id": id,
        "settings": settings_of(&settings),
        "owner": me["owner"],
        "github": me["github"],
    })
}

/// A stable id for memory folder `dir` (the same folder keeps its id), noted with the time.
fn register(s: &Store, dir: &Path) -> Option<String> {
    let mut m: Map<String, Value> = s.get(MEM_KEY).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let now = store::now();
    m.retain(|_, v| now - v["at"].as_i64().unwrap_or(0) < MEM_TTL);
    let d = dir.to_string_lossy().into_owned();
    let id = match m.iter().find(|(_, v)| v["dir"] == d.as_str()) {
        Some((id, _)) => id.clone(),
        None => store::random_hex(12).ok()?,
    };
    m.insert(id.clone(), json!({ "dir": d, "at": now }));
    s.set(MEM_KEY, &Value::Object(m).to_string());
    Some(id)
}

/// The memory ids handed out and still good: a call showing one is for a chat this PC
/// commanded (machines.rs lets those use its GitHub login).
pub fn issued_ids(s: &Store) -> std::collections::HashSet<String> {
    let m: Map<String, Value> = s.get(MEM_KEY).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let now = store::now();
    m.into_iter().filter(|(_, v)| now - v["at"].as_i64().unwrap_or(0) < MEM_TTL).map(|(k, _)| k).collect()
}

/// `POST /mesh/v1/memory` `{id, files: {name: text | null}}` from the PC a chat ran on:
/// written into (null: removed from) the memory folder `id` names here. How many changed.
pub fn accept_memory(s: &Store, body: &Value) -> Result<usize, String> {
    let m: Map<String, Value> = s.get(MEM_KEY).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let id = body["id"].as_str().unwrap_or("");
    let entry = m.get(id).filter(|v| !id.is_empty() && store::now() - v["at"].as_i64().unwrap_or(0) < MEM_TTL).ok_or("no such memory here")?;
    let dir = PathBuf::from(entry["dir"].as_str().unwrap_or(""));
    if !dir.is_absolute() {
        return Err("no such memory here".into());
    }
    let files = body["files"].as_object().ok_or("files is required")?;
    if files.len() > MEM_FILES_MAX {
        return Err("too many files".into());
    }
    let mut n = 0;
    for (name, text) in files {
        if !mem_name_ok(name) {
            continue;
        }
        let f = dir.join(name);
        match text.as_str() {
            Some(t) if t.len() <= MEM_FILE_MAX => {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                std::fs::write(&f, t).map_err(|e| e.to_string())?;
                n += 1;
            }
            None if text.is_null() => {
                if std::fs::remove_file(&f).is_ok() {
                    n += 1;
                }
            }
            _ => {}
        }
    }
    Ok(n)
}

// ================================================================== the home PC

/// A chat commanded from another PC: who, and the memory id to send changes back with.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Guest {
    /// The commanding PC's peer id and name.
    pub peer: String,
    pub name: String,
    /// Its owner and GitHub login, as it said.
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub github: String,
    #[serde(default)]
    pub memory_id: String,
    /// It sent no instructions or memory (turned off there, or a Harbor before 0.44).
    #[serde(default)]
    pub off: bool,
}

/// A peer id as one folder name.
fn folder(peer: &str) -> String {
    let s: String = peer.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).take(80).collect();
    if s.is_empty() { "unknown".into() } else { s }
}

/// The overlay profile (`CLAUDE_CONFIG_DIR`) turns commanded from `peer` run with.
pub fn overlay(peer: &str) -> PathBuf {
    let root = crate::mcp::private_dir(store::data_dir().join("guests"));
    crate::mcp::private_dir(root.join(folder(peer)))
}

/// Every overlay profile here (their sessions may be resumed by the chat's next turn).
pub fn overlays() -> Vec<PathBuf> {
    std::fs::read_dir(store::data_dir().join("guests")).map(|d| d.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default()
}

/// What the overlay's memory folder held when it came (name → hash), and whether changes
/// made there since haven't reached the commanding PC yet.
#[derive(Default, Serialize, Deserialize)]
struct MemState {
    id: String,
    base: BTreeMap<String, u64>,
    #[serde(default)]
    pending: bool,
}

fn state_file(mem: &Path) -> PathBuf {
    mem.with_file_name("harbor-memory.json")
}

fn load_state(mem: &Path) -> MemState {
    std::fs::read_to_string(state_file(mem)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_state(mem: &Path, st: &MemState) {
    if let Some(d) = mem.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(state_file(mem), serde_json::to_string(st).unwrap_or_default());
}

fn hash(t: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in t.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// The `ctx` of a call from `peer` (`name`), for a chat working in `cwd` here: written into
/// the peer's overlay. Its instructions, settings and memory replace what was there, except
/// memory changes that haven't reached the peer yet (those stay, and go with the next push).
pub fn apply(peer: &str, name: &str, ctx: &Value, cwd: &Path) -> Guest {
    let o = overlay(peer);
    let s = |k: &str| ctx[k].as_str().unwrap_or("").chars().take(80).collect::<String>();
    let off = ctx.is_null() || ctx["off"].as_bool() == Some(true);
    let g = Guest { peer: peer.into(), name: name.into(), owner: s("owner"), github: s("github"), memory_id: s("memory_id"), off };
    let instr = ctx["instructions"].as_str().unwrap_or("");
    let claude_md = o.join("CLAUDE.md");
    if instr.trim().is_empty() {
        let _ = std::fs::remove_file(&claude_md);
    } else {
        let _ = std::fs::write(&claude_md, cut(instr, INSTR_MAX + 16));
    }
    // Only the person's own settings, checked again here: hooks and the like would run on this PC.
    let _ = std::fs::write(o.join("settings.json"), Value::Object(settings_of(&ctx["settings"])).to_string());
    let mem = memory_dir(&o, cwd);
    let mut st = load_state(&mem);
    let incoming: BTreeMap<String, String> = ctx["memory"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(n, t)| mem_name_ok(n) && t.as_str().is_some_and(|t| t.len() <= MEM_FILE_MAX))
        .take(MEM_FILES_MAX)
        .map(|(n, t)| (n.clone(), t.as_str().unwrap_or("").to_string()))
        .collect();
    let _ = std::fs::create_dir_all(&mem);
    let here = read_memory(&mem);
    let changed: Vec<&String> = if st.pending && st.id == g.memory_id { here.keys().filter(|n| st.base.get(*n) != Some(&hash(&here[*n]))).collect() } else { vec![] };
    for n in here.keys().filter(|n| !incoming.contains_key(*n) && !changed.contains(n)) {
        let _ = std::fs::remove_file(mem.join(n));
    }
    for (n, t) in &incoming {
        if !changed.contains(&n) {
            let _ = std::fs::write(mem.join(n), t);
        }
    }
    st.base = incoming.iter().map(|(n, t)| (n.clone(), hash(t))).collect();
    st.pending = !changed.is_empty();
    st.id = g.memory_id.clone();
    save_state(&mem, &st);
    g
}

/// The overlay's memory changes since it came: `{name: text | null}`.
fn changes(mem: &Path, st: &MemState) -> Map<String, Value> {
    let now = read_memory(mem);
    let mut out = Map::new();
    for (n, t) in &now {
        if st.base.get(n) != Some(&hash(t)) {
            out.insert(n.clone(), json!(t));
        }
    }
    for n in st.base.keys().filter(|n| !now.contains_key(*n)) {
        out.insert(n.clone(), Value::Null);
    }
    out
}

/// After a turn of `g`'s chat (in `cwd` here): memory it saved goes to the commanding PC, on
/// a thread. Kept as pending when that PC doesn't take it (sent with the next turn's push).
pub fn push(dest: crate::mesh::Dest, g: Guest, cwd: PathBuf) {
    if g.memory_id.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let mem = memory_dir(&overlay(&g.peer), &cwd);
        let mut st = load_state(&mem);
        if st.id != g.memory_id {
            return;
        }
        let files = changes(&mem, &st);
        if files.is_empty() {
            return;
        }
        st.pending = true;
        save_state(&mem, &st);
        let body = serde_json::to_vec(&json!({ "id": g.memory_id, "files": files })).unwrap_or_default();
        match crate::mesh::http(&dest, "POST", "/mesh/v1/memory", Some(("application/json", &body)), std::time::Duration::from_secs(20)) {
            Ok((200, _)) => {
                for (n, t) in &files {
                    match t.as_str() {
                        Some(t) => st.base.insert(n.clone(), hash(t)),
                        None => st.base.remove(n),
                    };
                }
                st.pending = false;
                save_state(&mem, &st);
            }
            r => eprintln!("harbor: memory for {} not sent back yet: {:?}", g.name, r.map(|(s, _)| s)),
        }
    });
}

/// The chats commanded from other PCs, as saved.
pub fn load_guests(s: &Store) -> std::collections::HashMap<i64, Guest> {
    s.get(GUESTS_KEY).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_guests(s: &Store, g: &std::collections::HashMap<i64, Guest>) {
    s.set(GUESTS_KEY, &serde_json::to_string(g).unwrap_or_default());
}

/// Told to a guest turn's agent: whose chat it is and what that means here.
pub fn guest_note(g: &Guest, me: &str, signed_in: bool) -> String {
    let who = if g.owner.is_empty() { format!("the person at '{}'", g.name) } else { format!("{} (at '{}')", g.owner, g.name) };
    let mut s = format!("This chat is commanded from another PC of the user's Harbor mesh: you work for {who}, not for the owner of '{me}', the PC you run on. ");
    if g.off {
        s.push_str(&format!("'{}' sent no user instructions or memory, so none are loaded; '{me}'s own aren't either. ", g.name));
    } else {
        s.push_str(&format!("The user instructions, auto-memory and settings loaded are theirs, sent by Harbor from '{}'; memory you save goes back there. ", g.name));
    }
    s.push_str(&format!("'{me}' only lends its compute, files and tools: paths are '{me}' paths."));
    if !signed_in {
        s.push_str(&format!(" '{me}'s GitHub and app sign-ins belong to its owner, so they are off in this chat (gh is signed out)."));
    }
    s
}

// ================================================================== SSH devices

/// The folder (relative to home) a device keeps this PC's empty profile in, so its own
/// user instructions and memory don't load for this PC's chats.
pub fn device_profile(my_id: &str) -> String {
    format!(".local/state/harbor/guests/{}", folder(my_id))
}

/// Told to an agent on an SSH device (its own profile swapped for an empty one): this PC's
/// person's instructions and memory, and where to save memory (on this PC through the
/// workspace tools, when it works on this PC's files).
pub fn device_note(project: Option<&Path>, workspace: bool) -> String {
    let p = profile();
    let host = crate::remote::hostname();
    let mut s = String::new();
    let instr = read_cap(&p.join("CLAUDE.md"), 20_000);
    if !instr.trim().is_empty() {
        s.push_str(&format!("The user's own instructions (their global CLAUDE.md on '{host}'; the device's are not loaded):\n\n{}", instr.trim()));
    }
    if let Some(pr) = project {
        let dir = memory_dir(&p, pr);
        let index = read_cap(&dir.join("MEMORY.md"), 20_000);
        let save = if workspace {
            format!("Save new memories there with the workspace tools (mcp__origin__write/edit), one file per memory plus a line in MEMORY.md")
        } else {
            "This chat can't write there (it works on the device's files), so don't save memories".to_string()
        };
        s.push_str(&format!(
            "\n\nThe user's auto-memory for this project is on '{host}' in {} (the device's own memory is off). {save}.{}",
            dir.display(),
            if index.trim().is_empty() { " It's empty so far.".to_string() } else { format!(" Its index, MEMORY.md:\n\n{}", index.trim()) }
        ));
    }
    s.trim().to_string()
}

// ================================================================== who is who

/// This PC's owner as it tells the mesh: what the user typed (Settings › Devices, the phone),
/// else what profile.rs detected, else the account's full name.
pub fn owner(s: &Store) -> String {
    // Signed in (account.rs): the account's own name beats any guess.
    pick(s.get(OWNER_KEY), crate::account::owner_name().or_else(|| crate::profile::load(s).map(|d| d.me.owner)), crate::profile::full_name)
}

/// The GitHub login: typed, else detected, else Harbor's GitHub sign-in.
pub fn github(s: &Store) -> String {
    let t = |v: Option<String>| v.map(|t| t.trim().trim_start_matches('@').to_string());
    pick(t(s.get(GITHUB_KEY)), t(crate::profile::load(s).map(|d| d.me.github)), || crate::mcp::github_user().unwrap_or_default())
}

/// Typed beats detected beats the fallback; blanks don't count.
pub fn pick(typed: Option<String>, detected: Option<String>, fallback: impl FnOnce() -> String) -> String {
    let ok = |v: Option<String>| v.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    ok(typed).or_else(|| ok(detected)).unwrap_or_else(fallback)
}

/// The user has said who owns this PC: typed a name, confirmed the detected one, or signed in
/// (then nothing needs detecting).
pub fn confirmed(s: &Store) -> bool {
    s.get(OWNER_KEY).is_some_and(|t| !t.trim().is_empty()) || crate::account::signed_in()
}

/// Confirm: what shows now (detected or fallback) becomes the user's own, in the fields that
/// are still empty; a typed value stays as it is.
pub fn confirm(s: &Store) {
    let (o, g) = (owner(s), github(s));
    if !confirmed(s) && !o.is_empty() {
        s.set(OWNER_KEY, &o);
    }
    if s.get(GITHUB_KEY).is_none_or(|t| t.trim().is_empty()) && !g.is_empty() {
        s.set(GITHUB_KEY, &g);
    }
}

/// `{owner, github, owner_suggested}` for `hello` and `/mesh/v1/phones` (`owner_suggested`:
/// detected, not confirmed yet; from 0.47).
pub fn about(s: &Store) -> Value {
    let o = owner(s);
    json!({ "owner": o, "github": github(s), "owner_suggested": !o.is_empty() && !confirmed(s) })
}

/// One PC of the mesh, for the agent and the people lists.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Pc {
    pub id: String,
    pub name: String,
    #[serde(rename = "self")]
    pub me: bool,
    pub online: bool,
    pub owner: String,
    pub github: String,
    pub phones: Vec<String>,
    pub accounts: Vec<String>,
    /// Owner and login are a detection nobody has confirmed (profile.rs).
    pub suggested: bool,
    /// …made by this PC about a peer that says nothing itself.
    pub guessed: bool,
    /// The detection's evidence, where this PC has it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub why: String,
    /// Its Harbor in a line (versions.rs): "0.66.0 (latest, updates automatically)".
    #[serde(skip_serializing_if = "String::is_empty")]
    pub harbor: String,
    /// Phone name → "app 0.66.0", for the phones whose app said its version.
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub phone_apps: std::collections::BTreeMap<String, String>,
}

/// "Sam (detected, not confirmed)" and the like.
fn owner_label(p: &Pc) -> String {
    match (p.guessed, p.suggested) {
        (true, _) => format!("{} (guessed here, not confirmed)", p.owner),
        (_, true) => format!("{} (detected, not confirmed)", p.owner),
        _ => p.owner.clone(),
    }
}

/// One PC in a line: owner, GitHub, phones, accounts.
pub fn pc_line(p: &Pc) -> String {
    let mut parts = vec![if p.owner.is_empty() { "Owner not set".to_string() } else { owner_label(p) }];
    if !p.github.is_empty() {
        parts.push(format!("GitHub {}", p.github));
    }
    if !p.phones.is_empty() {
        parts.push(format!("phones: {}", p.phones.join(", ")));
    }
    if !p.accounts.is_empty() {
        parts.push(p.accounts.join(", "));
    }
    if !p.me && !p.online {
        parts.push("offline".into());
    }
    parts.join(" · ")
}

/// Told to every turn while the mesh has other PCs: who has which PC, phone and accounts.
pub fn people_note(pcs: &[Pc]) -> String {
    if pcs.len() < 2 {
        return String::new();
    }
    let mut s = String::from("Harbor mesh, who is who (each PC's Harbor says its owner; PCs share chats; \"not confirmed\" ones were detected from the PC's accounts and settings):");
    for p in pcs {
        let mut parts = vec![];
        parts.push(if p.owner.is_empty() { "owner not set".to_string() } else { format!("owner {}", owner_label(p)) });
        if !p.github.is_empty() {
            parts.push(format!("GitHub {}", p.github));
        }
        if !p.harbor.is_empty() {
            parts.push(format!("Harbor {}", p.harbor));
        }
        if !p.phones.is_empty() {
            let phones: Vec<String> = p.phones.iter().map(|n| match p.phone_apps.get(n) { Some(a) => format!("{n} ({a})"), None => n.clone() }).collect();
            parts.push(format!("phones: {}", phones.join(", ")));
        }
        if !p.accounts.is_empty() {
            parts.push(format!("agent accounts: {}", p.accounts.join(", ")));
        }
        let state = if p.me { " (this PC, where you run)" } else if p.online { "" } else { " (offline)" };
        s.push_str(&format!("\n- {}{state}: {}", p.name, parts.join("; ")));
    }
    s.push_str("\nThe files, shell and GitHub of the other PCs are reachable with the mcp__machines__* tools (pass `machine`; `list` shows what each PC's owner allows this chat there).");
    s
}

// ================================================================== the app

impl crate::app::App {
    /// In `send_to`: a message another PC forwarded makes the chat run with that PC's
    /// context (written into its overlay now); one typed here or on this PC's phones makes
    /// it this PC's again.
    pub fn ctx_adopt(&mut self, chat_id: i64) {
        let me = self.mesh_pcs().first().map(|p| p.name.clone()).unwrap_or_default();
        let (changed, said) = match self.mesh.call_ctx.clone() {
            Some((peer, name, ctx)) => {
                let Some(chat) = self.chat(chat_id).cloned() else { return };
                let g = apply(&peer, &name, &ctx, &self.chat_cwd(&chat));
                let who = if g.owner.is_empty() { name.clone() } else { format!("{} ({name})", g.owner) };
                let said = match self.guests.get(&chat_id) {
                    Some(old) if old.peer == g.peer && old.off == g.off => None,
                    _ if g.off => Some(format!("Runs for {who}, without user instructions or memory")),
                    _ => Some(format!("Runs with the instructions and memory of {who}")),
                };
                (self.guests.insert(chat_id, g.clone()) != Some(g), said)
            }
            None => match self.guests.remove(&chat_id) {
                Some(_) => (true, Some(format!("Runs with {me}'s own instructions and memory again"))),
                None => (false, None),
            },
        };
        if changed {
            save_guests(&self.store, &self.guests);
        }
        if let Some(text) = said {
            self.notice(chat_id, "users", &text, "A chat driven from another PC uses that PC's person's CLAUDE.md, memory and language here; memory it saves goes back there. A message written on this PC or its phones makes it this PC's again.");
        }
    }

    /// The chat commanded from another PC that `chat` belongs to (itself, or its lead).
    pub fn guest_of(&self, chat: &crate::store::Chat) -> Option<&Guest> {
        self.guests.get(&chat.id).or_else(|| chat.parent.and_then(|p| self.guests.get(&p)))
    }

    /// The user context and mesh note for a turn of `chat` (`remote`: it runs on an SSH device).
    pub fn turn_context(&self, chat: &crate::store::Chat, remote: bool) -> crate::agent::Context {
        let pcs = self.mesh_pcs();
        let me = pcs.first().map(|p| p.name.clone()).unwrap_or_default();
        let mut c = crate::agent::Context { note: people_note(&pcs), ..Default::default() };
        // Every PC's files (machines.rs) while there are other PCs; the chat's mode limits them.
        if pcs.len() > 1 {
            let lead = chat.role == crate::store::Role::Lead;
            let guest = self.guest_of(chat);
            c.machines = Some(crate::machines::Grant {
                chat: chat.gid.clone(),
                project: chat.repo_id.and_then(|r| self.repo(r)).map(|r| r.name.clone()).unwrap_or_default(),
                tools: crate::workspace::for_access(&chat.access, lead),
                commander: guest.map(|g| g.peer.clone()).unwrap_or_default(),
                memory_id: guest.map(|g| g.memory_id.clone()).unwrap_or_default(),
            });
        }
        if let Some(g) = self.guest_of(chat) {
            let host = github(&self.store);
            let same = !g.github.is_empty() && g.github.eq_ignore_ascii_case(&host);
            if !remote {
                c.overlay = Some(overlay(&g.peer));
                c.signed_in = same;
            }
            c.note = format!("{}\n\n{}", guest_note(g, &me, same || remote), c.note).trim().to_string();
        }
        c
    }

    /// A turn ended: memory a chat commanded from another PC saved goes back there.
    pub fn ctx_after_turn(&mut self, id: i64) {
        let Some(chat) = self.chat(id).cloned() else { return };
        let Some(g) = self.guest_of(&chat).cloned() else { return };
        if !chat.device.is_empty() {
            return;
        }
        let Some(peer) = self.api.hub.mesh.peer(&g.peer).filter(|p| p.online) else { return };
        push(peer.dest(), g, self.chat_cwd(&chat));
    }

    /// Settings › Devices › People and memory: who this PC's owner is, whether their context
    /// travels with their chats on other PCs, and who is who across the mesh.
    pub fn people_ui(&mut self, ui: &mut eframe::egui::Ui) {
        use crate::pages::{rows, section};
        use crate::widgets as w;
        section(ui, "People and memory");
        let mut name = self.store.get(OWNER_KEY).unwrap_or_default();
        let mut gh = self.store.get(GITHUB_KEY).unwrap_or_default();
        let mut send = self.store.get(SEND_KEY).as_deref() != Some("0");
        let mut github_out = crate::machines::github_on(&self.store);
        let before = (name.clone(), gh.clone(), send, github_out);
        let pcs = self.mesh_pcs();
        let check = self.profile_check();
        let detected = crate::profile::load(&self.store);
        let (shown_owner, shown_gh) = (owner(&self.store), github(&self.store));
        let (mut confirm_now, mut edit) = (false, false);
        let mut detect = false;
        rows(ui, |ui| {
            // A detection nobody has confirmed: what it found, and why.
            if check.is_some() {
                let who = if shown_gh.is_empty() { shown_owner.clone() } else { format!("{shown_owner} · GitHub {shown_gh}") };
                let why = detected.as_ref().map(|d| d.me.why.clone()).filter(|w| !w.is_empty()).map(|w| format!(" {}.", w.trim_end_matches('.'))).unwrap_or_default();
                w::setting_row(ui, "Detected, confirm?", &format!("{who}.{why} Agents and your other PCs see it as this PC's owner."), |ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    confirm_now = w::btn("Confirm").sm().primary().show(ui).clicked();
                    edit = w::btn("Edit").sm().show(ui).clicked();
                });
                w::separator(ui);
            }
            if edit {
                name = shown_owner.clone();
                gh = shown_gh.clone();
            }
            w::setting_row(ui, "Your name", "How this PC's owner shows to agents and to your other PCs (who is who). Empty: the detected name.", |ui| {
                let r = w::input(ui, &mut name, &shown_owner, false, 200.0);
                if edit {
                    r.request_focus();
                }
            });
            w::separator(ui);
            w::setting_row(ui, "Your GitHub login", "Empty: the detected login, else the account signed in under Settings › Integrations › Apps.", |ui| {
                w::input(ui, &mut gh, &shown_gh, false, 160.0);
            });
            w::separator(ui);
            let status = if self.profile.running {
                "Detecting…".to_string()
            } else {
                match &detected {
                    Some(d) => format!("Last run {} ({}).", crate::app::ago(d.at), if d.by == "rules" { "rules only: no Claude account to ask".to_string() } else { d.by.clone() }),
                    None => "Not run yet.".into(),
                }
            };
            w::setting_row(
                ui,
                "Detect who is who",
                &format!("Reads names and logins on this PC (git, gh, agent accounts, phones, SSH hosts and key comments, CLAUDE.md; never keys or tokens) and asks this PC's own Claude account for each PC's owner. A name you typed always stays. {status}"),
                |ui| detect = w::btn("Detect again").sm().enabled(!self.profile.running).show(ui).clicked(),
            );
            w::separator(ui);
            w::setting_row(
                ui,
                "Send my instructions and memory",
                "A chat you drive from here that runs on another PC uses your global CLAUDE.md, your memory of its project and your language settings instead of that PC owner's, and memory it saves comes back here. Off: it runs with no user instructions or memory at all.",
                |ui| w::toggle(ui, &mut send),
            );
            w::separator(ui);
            w::setting_row(
                ui,
                "My chats on other PCs may use my GitHub here",
                "A chat you drive from here that runs on another PC can run gh on this PC with Harbor's GitHub sign-in, so its issues and pull requests are yours. Off: only PCs you let do everything (Its chats may, above) get it.",
                |ui| w::toggle(ui, &mut github_out),
            );
            if pcs.len() > 1 {
                for p in &pcs {
                    w::separator(ui);
                    let title = format!("{}  {}{}", crate::icons::MONITOR, p.name, if p.me { " (this PC)" } else { "" });
                    let line = if p.why.is_empty() { pc_line(p) } else { format!("{}\n{}", pc_line(p), p.why) };
                    w::setting_row(ui, &title, &line, |_| {});
                }
            }
        });
        if confirm_now {
            confirm(&self.store);
            *self.api.hub.mesh.about.lock().unwrap() = about(&self.store);
            self.share_publish();
            return;
        }
        if detect {
            self.profile.want = true;
        }
        if (name.clone(), gh.clone(), send, github_out) != before {
            self.store.set(OWNER_KEY, &name);
            self.store.set(GITHUB_KEY, &gh);
            self.store.set(SEND_KEY, if send { "1" } else { "0" });
            self.store.set(crate::machines::GITHUB_KEY, if github_out { "1" } else { "0" });
            *self.api.hub.mesh.about.lock().unwrap() = about(&self.store);
            self.share_publish();
        }
    }

    /// `GET /v1/people`: the who is who, and this PC's own entries (phone's Settings › People).
    pub fn api_people(&self) -> Value {
        json!({
            "pcs": self.mesh_pcs().iter().map(|p| {
                let mut v = serde_json::to_value(p).unwrap_or_default();
                v["line"] = json!(pc_line(p));
                // What its chats may do here (machines.rs); not for this PC itself.
                if !p.me {
                    let l = crate::machines::level_for(&self.store, &p.id);
                    v["share"] = json!(l.slug());
                    v["share_label"] = json!(crate::machines::short(l));
                }
                v
            }).collect::<Vec<_>>(),
            "levels": crate::machines::Level::ALL.iter().map(|l| json!({ "id": l.slug(), "label": l.label(), "about": crate::machines::about_level(*l) })).collect::<Vec<_>>(),
            "me": {
                "owner": self.store.get(OWNER_KEY).unwrap_or_default(),
                "owner_hint": owner(&self.store),
                "github": self.store.get(GITHUB_KEY).unwrap_or_default(),
                "github_hint": github(&self.store),
                // profile.rs (0.47): the detection, whether the user has confirmed, a run going.
                "suggested": crate::profile::load(&self.store).map(|d| json!({ "owner": d.me.owner, "github": d.me.github, "confidence": d.me.confidence, "why": d.me.why, "by": d.by, "at": d.at })),
                "confirmed": confirmed(&self.store),
                "detecting": self.profile.running || self.profile.want,
                "check": self.profile_check_json(),
                "send_context": self.store.get(SEND_KEY).as_deref() != Some("0"),
                "share_github": crate::machines::github_on(&self.store),
            },
        })
    }

    /// `PATCH /v1/people` `{owner?, github?, send_context?, share_github?, share?, op?}`
    /// (`op`: "confirm" the detected profile, "detect" again).
    pub fn api_people_set(&mut self, body: &Value) {
        match body["op"].as_str() {
            Some("confirm") => confirm(&self.store),
            Some("detect") => self.profile.want = true,
            _ => {}
        }
        if let Some(o) = body["owner"].as_str() {
            self.store.set(OWNER_KEY, &o.chars().take(80).collect::<String>());
        }
        if let Some(g) = body["github"].as_str() {
            self.store.set(GITHUB_KEY, &g.chars().take(60).collect::<String>());
        }
        if let Some(b) = body["send_context"].as_bool() {
            self.store.set(SEND_KEY, if b { "1" } else { "0" });
        }
        if let Some(b) = body["share_github"].as_bool() {
            self.store.set(crate::machines::GITHUB_KEY, if b { "1" } else { "0" });
        }
        // `{share: {pc, level}}`: what that PC's chats may do here (machines.rs).
        if let (Some(pc), Some(l)) = (body["share"]["pc"].as_str(), body["share"]["level"].as_str().and_then(crate::machines::Level::parse)) {
            if self.api.hub.mesh.peer(pc).is_some() {
                crate::machines::set_level(&self.store, pc, l);
            }
        }
        self.share_publish();
        *self.api.hub.mesh.about.lock().unwrap() = about(&self.store);
    }

    /// This PC and the mesh's other PCs, with owners, phones and accounts.
    pub fn mesh_pcs(&self) -> Vec<Pc> {
        let shared = &self.api.hub.mesh;
        let me = shared.me();
        let name = if me.name.is_empty() { crate::remote::hostname() } else { me.name };
        let local = self.api.hub.local_phones();
        let phones: Vec<String> = local.iter().map(|p| p.name.clone()).filter(|n| !n.is_empty()).collect();
        let phone_apps = local.iter().filter(|p| !p.name.is_empty()).filter_map(|p| crate::versions::phone_short(p.app).map(|a| (p.name.clone(), a))).collect();
        // Each PC's Harbor version and updates in a line.
        let (versions, _) = crate::versions::gather(&self.api.hub);
        let newest = crate::versions::newest(&versions);
        let harbor_of = |id: &str| versions.iter().find(|v| v.id == id).map(|v| crate::versions::pc_line(v, &newest)).unwrap_or_default();
        let accounts: Vec<String> = self.accounts.iter().filter(|a| a.installed()).map(|a| a.short()).collect();
        let detected = crate::profile::load(&self.store);
        let mine = about(&self.store);
        let suggested = mine["owner_suggested"].as_bool().unwrap_or(false);
        let why = detected.as_ref().filter(|_| suggested).map(|d| d.me.why.clone()).unwrap_or_default();
        let harbor = versions.first().map(|v| crate::versions::pc_line(v, &newest)).unwrap_or_default();
        let mut v = vec![Pc { id: me.id, name, me: true, online: true, owner: owner(&self.store), github: github(&self.store), phones, accounts, suggested, guessed: false, why, harbor, phone_apps }];
        if !shared.on.load(std::sync::atomic::Ordering::Relaxed) {
            return v;
        }
        let elsewhere = self.api.hub.elsewhere.lock().unwrap().clone();
        for p in self.mesh_hosts() {
            let sightings = elsewhere.get(&p.id).map(|(_, s)| s.clone()).unwrap_or_default();
            let phones = sightings.iter().map(|x| x.name.clone()).filter(|n| !n.is_empty()).collect();
            let phone_apps = sightings.iter().filter(|x| !x.name.is_empty()).filter_map(|x| crate::versions::phone_short(x.app).map(|a| (x.name.clone(), a))).collect();
            let accounts = p.accounts.iter().map(|a| a.1.clone()).collect();
            let mut pc = Pc { id: p.id.clone(), name: p.name.clone(), me: false, online: p.online, owner: p.owner.clone(), github: p.github.clone(), phones, accounts, suggested: p.owner_suggested, harbor: harbor_of(&p.id), phone_apps, ..Default::default() };
            // A peer that says nothing (before 0.44, or nothing found there): this PC's guess.
            if pc.owner.is_empty() && pc.github.is_empty() {
                if let Some(g) = detected.as_ref().and_then(|d| d.peers.get(&p.id)) {
                    (pc.owner, pc.github, pc.why, pc.suggested, pc.guessed) = (g.owner.clone(), g.github.clone(), g.why.clone(), true, true);
                }
            }
            v.push(pc);
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_names_and_settings() {
        assert!(mem_name_ok("MEMORY.md") && mem_name_ok("user_role.md"));
        assert_eq!(cut("aé", 2), "a");
        assert!(!mem_name_ok("../x.md") && !mem_name_ok("a/b.md") && !mem_name_ok(".hidden.md") && !mem_name_ok("x.sh"));
        let s = settings_of(&json!({ "language": "en", "hooks": { "Stop": [] }, "env": { "X": "1" }, "permissions": {} }));
        assert_eq!(Value::Object(s), json!({ "language": "en" }));
    }

    #[test]
    fn typed_beats_detected() {
        assert_eq!(pick(Some(" Sam ".into()), Some("Samuel".into()), || "gecos".into()), "Sam");
        assert_eq!(pick(Some("  ".into()), Some("Samuel".into()), || "gecos".into()), "Samuel");
        assert_eq!(pick(None, Some("".into()), || "gecos".into()), "gecos");
        let s = Store::open_temp();
        let d = crate::profile::Detected { me: crate::profile::Proposal { owner: "Samuel Lee".into(), github: "samlee".into(), ..Default::default() }, ..Default::default() };
        s.set(crate::profile::KEY, &serde_json::to_string(&d).unwrap());
        assert_eq!((owner(&s), github(&s)), ("Samuel Lee".to_string(), "samlee".to_string()));
        assert_eq!(about(&s)["owner_suggested"], json!(true));
        // The user typed a GitHub login: it stays; Confirm fills only the empty name.
        s.set(GITHUB_KEY, "@sam-gh");
        assert_eq!(github(&s), "sam-gh");
        confirm(&s);
        assert_eq!((s.get(OWNER_KEY).unwrap().as_str(), s.get(GITHUB_KEY).unwrap().as_str()), ("Samuel Lee", "@sam-gh"));
        assert!(confirmed(&s) && about(&s)["owner_suggested"] == json!(false));
        // A later detection never overwrites what the user has.
        let d2 = crate::profile::Detected { me: crate::profile::Proposal { owner: "Someone Else".into(), github: "else".into(), ..Default::default() }, ..Default::default() };
        s.set(crate::profile::KEY, &serde_json::to_string(&d2).unwrap());
        confirm(&s);
        assert_eq!((owner(&s), github(&s)), ("Samuel Lee".to_string(), "sam-gh".to_string()));
    }

    #[test]
    fn people_note_lists_pcs() {
        assert_eq!(people_note(&[Pc { name: "desk".into(), me: true, ..Default::default() }]), "");
        let n = people_note(&[
            Pc { name: "desk".into(), me: true, online: true, owner: "Sam".into(), github: "sam-gh".into(), phones: vec!["Pixel".into(), "Tab".into()], harbor: "0.66.0 (latest)".into(), phone_apps: [("Pixel".to_string(), "app 0.66.0".to_string())].into(), ..Default::default() },
            Pc { name: "laptop".into(), owner: "Alex".into(), ..Default::default() },
        ]);
        assert!(n.contains("- desk (this PC, where you run): owner Sam; GitHub sam-gh; Harbor 0.66.0 (latest); phones: Pixel (app 0.66.0), Tab"), "{n}");
        assert!(n.contains("- laptop (offline): owner Alex"));
        let g = Pc { name: "lap".into(), owner: "Alex".into(), suggested: true, guessed: true, ..Default::default() };
        assert_eq!(pc_line(&g), "Alex (guessed here, not confirmed) · offline");
    }

    #[test]
    fn overlay_round_trip() {
        let peer = format!("pc:test-{}", store::random_hex(4).unwrap());
        let cwd = std::env::temp_dir().join(format!("harbor-ctx-{}", store::random_hex(4).unwrap()));
        std::fs::create_dir_all(&cwd).unwrap();
        let ctx = json!({ "v": 1, "instructions": "Answer in English.", "memory": { "MEMORY.md": "- [a](a.md)\n", "a.md": "A", "../evil.md": "x" },
                          "memory_id": "m1", "settings": { "language": "en", "hooks": {} }, "owner": "Sam" });
        let g = apply(&peer, "laptop", &ctx, &cwd);
        assert_eq!((g.owner.as_str(), g.memory_id.as_str(), g.off), ("Sam", "m1", false));
        let o = overlay(&peer);
        assert_eq!(std::fs::read_to_string(o.join("CLAUDE.md")).unwrap(), "Answer in English.");
        assert_eq!(std::fs::read_to_string(o.join("settings.json")).unwrap(), r#"{"language":"en"}"#);
        let mem = memory_dir(&o, &cwd);
        assert_eq!(read_memory(&mem).len(), 2);
        // The agent saves a memory and drops one: those are the changes.
        std::fs::write(mem.join("b.md"), "B").unwrap();
        std::fs::remove_file(mem.join("a.md")).unwrap();
        let mut st = load_state(&mem);
        assert_eq!(Value::Object(changes(&mem, &st)), json!({ "a.md": null, "b.md": "B" }));
        // Not sent yet: the next ctx keeps them.
        st.pending = true;
        save_state(&mem, &st);
        apply(&peer, "laptop", &ctx, &cwd);
        assert_eq!(std::fs::read_to_string(mem.join("b.md")).unwrap(), "B");
        assert!(mem.join("a.md").exists(), "a file the peer still has comes back");
        // Sent: the next ctx is the truth.
        let mut st = load_state(&mem);
        st.pending = false;
        save_state(&mem, &st);
        let g = apply(&peer, "laptop", &json!({ "v": 1, "off": true }), &cwd);
        assert!(g.off && !o.join("CLAUDE.md").exists() && read_memory(&mem).is_empty());
        let _ = std::fs::remove_dir_all(&o);
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
