//! Harbor accounts: every device signs in with Google through Clerk, and the PCs and phones of a
//! workspace trust each other through the account service (`worker/`), not pairing codes.
//!
//! - **Sign-in.** Clerk is the OAuth provider (Google is its only sign-in method). The system
//!   browser opens Clerk's sign-in and comes back to a loopback port with a code, exchanged with
//!   PKCE: a public client, so no secret ships with Harbor. Clerk's tokens stay in
//!   `<state>/account.json` (owner-only), never in the database and never synced.
//! - **Harbor tokens.** With Clerk's access token the account service (`POST /v1/session`) says
//!   who this is, their workspaces, and gives a Harbor token: a JWT signed with Ed25519, bound
//!   to this device's TLS key, good for 7 days. Every PC checks a phone's token itself, offline,
//!   with the service's public key ([`admit`]): nothing is asked per request.
//! - **Workspaces.** Each account has its own and may be invited into others. A PC belongs to
//!   one (picked at sign-in when there are several). Its directory (the workspace's PCs with
//!   addresses and keys, members, their devices' keys) is fetched every 2 minutes and cached in
//!   kv `account_dir`, so the workspace's PCs link (mesh.rs) and its members' phones get in,
//!   also while the service can't be reached.
//! - **Option A.** Signing in on a PC that is in someone else's workspace gives nothing: the
//!   service won't move it and this PC drops the sign-in. Signing out keeps the PC in its
//!   workspace (only a member removes it), so the next person to sign in can't take it over.
//! - **Offline.** A session Clerk ended, Clerk or the service down: nothing stops. The hub and
//!   the agents go on with the cached identity and directory; the desktop asks to sign in again.
//! - **Settings** follow the account (settingsync.rs).
//!
//! The wire format (service and Clerk) is in android/PROTOCOL.md, "Accounts".

use crate::store;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Clerk's Frontend API of RDevNeo's Clerk app (OAuth endpoints). A placeholder until it exists.
pub const CLERK_URL: &str = "https://maximum-feline-2818.clerk.accounts.dev";
/// The OAuth application Harbor signs in with (a public client: PKCE, no secret).
pub const CLIENT_ID: &str = "FWUnta6BgUIwVT9O";
/// Harbor's account service (worker/).
pub const ACCOUNTS_URL: &str = "https://harbor-accounts.rdevneo.workers.dev";
/// The public keys the service signs Harbor tokens with: (kid, base64url Ed25519 key), from
/// `npm run keygen` in worker/. Empty: this build trusts the keys the service serves (over
/// HTTPS) at `/v1/keys`; a release build lists them here.
pub const KEYS: &[(&str, &str)] = &[("k1", "AKiosel0Qd-0CFV2NmRpLpM8zchoVP1iDrpt_OgyoII")];
const SCOPE: &str = "openid profile email offline_access";
const ISSUER: &str = "harbor-accounts";
/// A Harbor token lasts 7 days; a new one is asked for once a day.
const RENEW_AFTER: i64 = 24 * 3600;
const DIR_EVERY: Duration = Duration::from_secs(120);
const PC_EVERY: Duration = Duration::from_secs(300);
const SYNC_EVERY: Duration = Duration::from_secs(60);

/// `HARBOR_ACCOUNT_LOG=1`: what the account loop does, on stderr (test rigs).
fn log(what: impl FnOnce() -> String) {
    static ON: LazyLock<bool> = LazyLock::new(|| std::env::var("HARBOR_ACCOUNT_LOG").as_deref() == Ok("1"));
    if *ON {
        eprintln!("account: {}", what());
    }
}

fn conf(env: &str, default: &str) -> String {
    std::env::var(env).ok().map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

pub fn clerk_url() -> String {
    conf("HARBOR_CLERK_URL", CLERK_URL)
}

pub fn client_id() -> String {
    conf("HARBOR_CLERK_CLIENT_ID", CLIENT_ID)
}

pub fn service_url() -> String {
    conf("HARBOR_ACCOUNTS_URL", ACCOUNTS_URL)
}

/// This build talks to a real account service (not the placeholders): only then does the
/// desktop ask to sign in before anything else.
pub fn configured() -> bool {
    !clerk_url().contains("harbor.example") && !service_url().contains("harbor.example")
}

// ================================================================== state

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct Workspace {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// "owner" (invites and removes people) or "member".
    #[serde(default)]
    pub role: String,
    /// The account's own, made at its first sign-in.
    #[serde(default)]
    pub personal: bool,
}

impl Workspace {
    pub fn owner(&self) -> bool {
        self.role == "owner"
    }
}

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct Member {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub role: String,
}

/// A PC of a workspace as the directory lists it.
#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct Pc {
    pub fp: String,
    /// Its mesh id (mesh.rs `Me::id`).
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub addrs: Vec<String>,
    /// Who signed it into the workspace (account id, name).
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub owner_name: String,
    #[serde(default)]
    pub seen: i64,
    #[serde(default)]
    pub version: String,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct Invite {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub at: i64,
}

/// An invitation waiting for this account (`GET /v1/invites`): only Accept joins.
#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct PendingInvite {
    pub id: String,
    pub ws: String,
    #[serde(default)]
    pub ws_name: String,
    #[serde(default)]
    pub inviter_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub at: i64,
}

/// One workspace in the directory.
#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct Dir {
    #[serde(flatten)]
    pub ws: Workspace,
    #[serde(default)]
    pub members: Vec<Member>,
    #[serde(default)]
    pub pcs: Vec<Pc>,
    /// The TLS keys of every member's phones and PCs.
    #[serde(default)]
    pub devices: Vec<String>,
    /// Waiting invitations (owners only).
    #[serde(default)]
    pub invites: Vec<Invite>,
}

/// The directory as last fetched (kv `account_dir`): `at` is the service's clock, in ms.
#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct Directory {
    #[serde(default)]
    pub at: i64,
    #[serde(default)]
    pub workspaces: Vec<Dir>,
}

impl Directory {
    pub fn of(&self, ws: &str) -> Option<&Dir> {
        self.workspaces.iter().find(|d| d.ws.id == ws)
    }
}

/// Who is signed in here (kv `account`): no secrets.
#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct Account {
    pub id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub image: String,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
}

/// What the desktop shows about the account (Settings › Account, the sign-in page, banners).
#[derive(Clone, Default, Debug)]
pub struct Status {
    /// A sign-in waits for the browser; the URL to open by hand.
    pub signing_in: bool,
    pub url: String,
    pub error: String,
    /// Clerk ended this PC's session: sign in again. Everything keeps working meanwhile.
    pub expired: bool,
    /// The service didn't answer since then (unix s; 0: it did).
    pub offline_since: i64,
    /// Signed in, in several workspaces, and this PC is in none: the user picks one.
    pub pick: bool,
    /// The last directory fetched (unix s).
    pub synced_at: i64,
    /// An action from Settings is running (invite, remove…).
    pub busy: bool,
    /// Something to tell once ("You joined …"), taken by the desktop's toast.
    pub notice: String,
}

#[derive(Default)]
pub struct Live {
    pub account: Option<Account>,
    /// This PC's workspace (kv `account_ws`): kept across a sign-out.
    pub ws: String,
    pub dir: Directory,
    /// Invitations waiting for this account to accept or decline them.
    pub invites: Vec<PendingInvite>,
    /// Keys fetched from the service (only used while no keys ship, see [`KEYS`]).
    pub fetched_keys: Vec<(String, Vec<u8>)>,
    pub status: Status,
}

pub static LIVE: LazyLock<RwLock<Live>> = LazyLock::new(Default::default);
/// Wakes the loop: 1 = settings changed here (sent after a short pause), 2 = everything now.
static POKE: LazyLock<(Mutex<u8>, Condvar)> = LazyLock::new(Default::default);
static CANCEL: AtomicBool = AtomicBool::new(false);
/// Ask for a new Harbor token at the next turn of the loop (workspaces changed).
static RENEW: AtomicBool = AtomicBool::new(false);
/// The desktop should turn phones and PC sharing on (just signed in).
pub static ENABLE: AtomicBool = AtomicBool::new(false);
static WAKE: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>> = std::sync::OnceLock::new();

fn wake_ui() {
    if let Some(w) = WAKE.get() {
        w();
    }
}

/// Wakes the account loop now (a sign-in, an action in Settings): everything is fetched again.
pub fn poke() {
    let (m, cv) = &*POKE;
    *m.lock().unwrap() = 2;
    cv.notify_all();
}

/// A setting changed here: it goes to the account after a short pause (a burst of changes,
/// one call).
pub fn poke_sync() {
    let (m, cv) = &*POKE;
    let mut g = m.lock().unwrap();
    *g = (*g).max(1);
    cv.notify_all();
}

pub fn status() -> Status {
    LIVE.read().unwrap().status.clone()
}

fn set_status(f: impl FnOnce(&mut Status)) {
    f(&mut LIVE.write().unwrap().status);
    wake_ui();
}

pub fn account() -> Option<Account> {
    LIVE.read().unwrap().account.clone()
}

pub fn signed_in() -> bool {
    LIVE.read().unwrap().account.is_some()
}

/// This PC's workspace id ("" when it's in none).
pub fn workspace() -> String {
    LIVE.read().unwrap().ws.clone()
}

pub fn directory() -> Directory {
    LIVE.read().unwrap().dir.clone()
}

/// Invitations waiting for this account.
pub fn invites() -> Vec<PendingInvite> {
    let l = LIVE.read().unwrap();
    if l.account.is_some() { l.invites.clone() } else { vec![] }
}

/// This PC's workspace as the directory has it.
pub fn my_dir() -> Option<Dir> {
    let l = LIVE.read().unwrap();
    l.dir.of(&l.ws).cloned()
}

/// The desktop shows only the sign-in page: nobody signed in on a configured build.
/// (`HARBOR_TEST_NO_SIGNIN=1`: test rigs that don't sign in.)
pub fn gate() -> bool {
    configured() && !signed_in() && std::env::var("HARBOR_TEST_NO_SIGNIN").as_deref() != Ok("1")
}

/// The other PCs of this PC's workspace, as entries of the mesh's allowed list: they link
/// with this one without pairing (mesh.rs).
pub fn mesh_peers() -> Vec<crate::mesh::Allowed> {
    let l = LIVE.read().unwrap();
    let mine = crate::tls::my_fp();
    let Some(d) = l.dir.of(&l.ws) else { return vec![] };
    d.pcs.iter().filter(|p| !p.fp.is_empty() && p.fp != mine).map(|p| crate::mesh::Allowed { node: String::new(), name: p.name.clone(), fp: p.fp.clone(), id: p.id.clone(), addrs: p.addrs.clone() }).collect()
}

/// A key this PC's workspace knows (a PC or a member's device): it may complete a TLS handshake
/// from the internet (tls::KnownClient).
pub fn known_device(fp: &str) -> bool {
    let l = LIVE.read().unwrap();
    l.dir.of(&l.ws).is_some_and(|d| d.devices.iter().any(|x| x == fp) || d.pcs.iter().any(|p| p.fp == fp))
}

/// The owner name this PC says it has (meshctx.rs): the signed-in account's.
pub fn owner_name() -> Option<String> {
    LIVE.read().unwrap().account.as_ref().map(|a| if a.name.is_empty() { a.email.clone() } else { a.name.clone() }).filter(|n| !n.is_empty())
}

// ================================================================== Harbor tokens

/// What a Harbor token says (see android/PROTOCOL.md, "Accounts").
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Claims {
    #[serde(default)]
    pub iss: String,
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub ws: Vec<String>,
    /// The fingerprint of the device's TLS key: the token works only with it.
    #[serde(default)]
    pub dev: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub iat: i64,
    #[serde(default)]
    pub exp: i64,
}

pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => continue,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

pub fn b64url(data: &[u8]) -> String {
    crate::agent::base64(data).replace('+', "-").replace('/', "_").trim_end_matches('=').to_string()
}

/// The keys tokens may be signed with: `HARBOR_ACCOUNTS_KEYS` (tests), else the shipped ones,
/// else the ones fetched from the service.
fn keys_now(l: &Live) -> Vec<(String, Vec<u8>)> {
    let parse = |list: Vec<(String, String)>| list.into_iter().filter_map(|(k, x)| b64url_decode(&x).filter(|b| b.len() == 32).map(|b| (k, b))).collect::<Vec<_>>();
    if let Ok(v) = std::env::var("HARBOR_ACCOUNTS_KEYS") {
        return parse(v.split(',').filter_map(|e| e.trim().split_once(':')).map(|(k, x)| (k.to_string(), x.to_string())).collect());
    }
    if !KEYS.is_empty() {
        return parse(KEYS.iter().map(|(k, x)| (k.to_string(), x.to_string())).collect());
    }
    l.fetched_keys.clone()
}

/// A Harbor token's claims, when one of `keys` signed it and it hasn't run out.
pub fn verify_with(token: &str, keys: &[(String, Vec<u8>)], now: i64) -> Result<Claims, &'static str> {
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(s), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return Err("not a Harbor token") };
    let header: Value = b64url_decode(h).and_then(|b| serde_json::from_slice(&b).ok()).ok_or("not a Harbor token")?;
    if header["alg"] != "EdDSA" {
        return Err("not a Harbor token");
    }
    let kid = header["kid"].as_str().unwrap_or("");
    let sig = b64url_decode(s).ok_or("not a Harbor token")?;
    let signed = &token.as_bytes()[..h.len() + 1 + p.len()];
    let good = keys.iter().filter(|(k, _)| kid.is_empty() || k == kid).any(|(_, key)| ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key).verify(signed, &sig).is_ok());
    if !good {
        return Err("the account service didn't sign this token");
    }
    let c: Claims = b64url_decode(p).and_then(|b| serde_json::from_slice(&b).ok()).ok_or("not a Harbor token")?;
    if c.iss != ISSUER || c.sub.is_empty() {
        return Err("not a Harbor token");
    }
    if c.exp <= now {
        return Err("this sign-in ran out: open Harbor on the phone to sign in again");
    }
    Ok(c)
}

/// Whether a valid token's account may use a PC of workspace `ws`, given its cached directory:
/// the token must name the workspace, and a directory newer than the token must still list the
/// account and its device (else it was removed, or signed out of that device, meanwhile).
pub fn decide(c: &Claims, ws: &str, dir: &Directory) -> Result<(), &'static str> {
    if ws.is_empty() {
        return Err("this PC isn't in a workspace: sign in on it first");
    }
    if !c.ws.iter().any(|w| w == ws) {
        return Err("this PC belongs to a workspace you aren't in: ask its owner to invite you");
    }
    if let Some(d) = dir.of(ws).filter(|_| dir.at > c.iat * 1000) {
        if !d.members.iter().any(|m| m.id == c.sub) {
            return Err("you were removed from this PC's workspace");
        }
        if !d.devices.iter().any(|x| *x == c.dev) {
            return Err("this device was signed out of the account");
        }
    }
    Ok(())
}

/// A phone's call with Harbor token `token` over a TLS connection with client key `fp`.
pub fn admit(token: &str, fp: &str) -> Result<Claims, &'static str> {
    let l = LIVE.read().unwrap();
    let c = verify_with(token, &keys_now(&l), store::now())?;
    if c.kind != "phone" {
        return Err("not a phone's sign-in");
    }
    if c.dev != fp {
        return Err("this sign-in belongs to another device");
    }
    decide(&c, &l.ws, &l.dir)?;
    Ok(c)
}

/// Looks like a Harbor token (a JWT), not an old pairing token (hex).
pub fn is_token(s: &str) -> bool {
    s.starts_with("eyJ") && s.matches('.').count() == 2
}

// ================================================================== HTTP

/// One request through curl. Everything, the token included, goes in curl's config on stdin,
/// so nothing secret is on a command line.
fn curl(method: &str, url: &str, bearer: Option<&str>, body: Option<(&str, &str)>) -> Result<(u16, Value), String> {
    let q = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r");
    let mut cfg = format!("url = \"{}\"\nrequest = \"{method}\"\nheader = \"Accept: application/json\"\n", q(url));
    if let Some(b) = bearer {
        cfg += &format!("header = \"Authorization: Bearer {}\"\n", q(b));
    }
    if let Some((ctype, data)) = body {
        cfg += &format!("header = \"Content-Type: {ctype}\"\ndata-raw = \"{}\"\n", q(data));
    }
    let mut c = Command::new("curl").args(["-sS", "-m", "20", "-w", "\n%{http_code}", "-K", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("curl: {e}"))?;
    if let Some(mut sin) = c.stdin.take() {
        let _ = sin.write_all(cfg.as_bytes());
    }
    let out = c.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (body, code) = text.rsplit_once('\n').unwrap_or(("", &text));
    let code: u16 = code.trim().parse().unwrap_or(0);
    if code == 0 {
        return Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(200).collect());
    }
    Ok((code, serde_json::from_str(body).unwrap_or_else(|_| Value::String(body.chars().take(300).collect()))))
}

#[derive(Debug, PartialEq)]
pub enum Fail {
    /// Clerk or the service ended this sign-in: sign in again.
    Expired,
    /// Refused, with the service's sentence.
    Refused(String, Value),
    /// No answer (no network, the service down).
    Offline(String),
}

impl Fail {
    pub fn text(&self) -> String {
        match self {
            Fail::Expired => "Your sign-in ran out: sign in again.".into(),
            Fail::Refused(e, _) => e.clone(),
            Fail::Offline(e) => format!("The account service didn't answer ({e})."),
        }
    }
}

fn service(method: &str, path: &str, bearer: &str, body: Option<&Value>) -> Result<Value, Fail> {
    let data = body.map(|b| b.to_string());
    let (code, v) = curl(method, &format!("{}{path}", service_url()), Some(bearer), data.as_deref().map(|d| ("application/json", d))).map_err(Fail::Offline)?;
    match code {
        200..=299 => Ok(v),
        401 => Err(Fail::Expired),
        500.. => Err(Fail::Offline(format!("HTTP {code}"))),
        _ => Err(Fail::Refused(v["error"].as_str().map(String::from).unwrap_or_else(|| format!("The account service refused ({code}).")), v)),
    }
}

// ================================================================== Clerk's tokens

/// Clerk's tokens and the Harbor token (`<state>/account.json`, owner-only).
#[derive(Clone, Default, Serialize, Deserialize)]
struct Secrets {
    #[serde(default)]
    access: String,
    #[serde(default)]
    refresh: String,
    /// Unix s.
    #[serde(default)]
    access_exp: i64,
    #[serde(default)]
    token: String,
    #[serde(default)]
    token_exp: i64,
    #[serde(default)]
    token_at: i64,
}

fn secrets_path() -> PathBuf {
    crate::mcp::private_dir(store::state_dir()).join("account.json")
}

fn load_secrets() -> Secrets {
    std::fs::read_to_string(secrets_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_secrets(s: &Secrets) {
    if let Err(e) = crate::mcp::write_private(&secrets_path(), &serde_json::to_string(s).unwrap_or_default()) {
        eprintln!("harbor: couldn't save the sign-in: {e}");
    }
}

/// The Harbor token this PC has now (for the account service and Settings), if any.
fn harbor_token() -> Option<String> {
    let s = load_secrets();
    (!s.token.is_empty() && s.token_exp > store::now()).then_some(s.token)
}

fn token_reply(s: &mut Secrets, status: u16, t: &Value) -> Result<(), Fail> {
    let access = t["access_token"].as_str().unwrap_or("");
    if status == 400 || status == 401 {
        return Err(Fail::Expired);
    }
    if !(200..300).contains(&status) || access.is_empty() {
        return Err(Fail::Offline(format!("Clerk answered {status}")));
    }
    s.access = access.into();
    if let Some(r) = t["refresh_token"].as_str().filter(|r| !r.is_empty()) {
        s.refresh = r.into();
    }
    s.access_exp = store::now() + t["expires_in"].as_i64().unwrap_or(3600);
    Ok(())
}

/// A Clerk access token good for a while yet: refreshed when it's about to run out.
fn fresh_access(s: &mut Secrets) -> Result<String, Fail> {
    if !s.access.is_empty() && s.access_exp - store::now() > 300 {
        return Ok(s.access.clone());
    }
    if s.refresh.is_empty() {
        return Err(Fail::Expired);
    }
    let body = crate::mcp::form(&[("grant_type", "refresh_token"), ("refresh_token", &s.refresh), ("client_id", &client_id())]);
    let (status, t) = curl("POST", &format!("{}/oauth/token", clerk_url()), None, Some(("application/x-www-form-urlencoded", &body))).map_err(Fail::Offline)?;
    token_reply(s, status, &t)?;
    save_secrets(s);
    Ok(s.access.clone())
}

/// What `POST /v1/session` answered.
struct Session {
    account: Account,
    token: String,
    exp: i64,
    /// This PC's workspace as the service has it: (id, name, its owner, whether this account is
    /// a member of it).
    pc: Option<(String, String, String, bool)>,
    invites: Vec<PendingInvite>,
}

/// The proof that this PC holds its TLS key, for the service: a signature over the time and
/// the access token's hash.
fn device_proof(access: &str) -> Result<Value, Fail> {
    let id = crate::tls::me().map_err(|e| Fail::Refused(format!("This PC has no key: {e}"), Value::Null))?;
    let ts = store::now();
    let msg = format!("harbor-device-v1\n{ts}\n{}", crate::tls::sha256_hex(access.as_bytes()));
    let sig = id.sign(msg.as_bytes()).ok_or_else(|| Fail::Refused("This PC couldn't sign with its key.".into(), Value::Null))?;
    let spki = id.spki().ok_or_else(|| Fail::Refused("This PC's key is unreadable.".into(), Value::Null))?;
    Ok(json!({ "kind": "pc", "name": crate::remote::hostname(), "spki": crate::agent::base64(spki), "ts": ts, "sig": crate::agent::base64(&sig) }))
}

fn session(access: &str) -> Result<Session, Fail> {
    let body = json!({ "device": device_proof(access)?, "app": env!("CARGO_PKG_VERSION") });
    let v = service("POST", "/v1/session", access, Some(&body))?;
    let s = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
    let a = &v["account"];
    let workspaces = v["workspaces"].as_array().into_iter().flatten().filter_map(|w| serde_json::from_value::<Workspace>(w.clone()).ok()).collect();
    let account = Account { id: s(a, "id"), email: s(a, "email"), name: s(a, "name"), image: s(a, "image"), workspaces };
    let token = s(&v, "token");
    if account.id.is_empty() || token.is_empty() {
        return Err(Fail::Offline("an answer without an account".into()));
    }
    let pc = v["pc"].as_object().map(|p| {
        let g = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        (g("ws"), g("ws_name"), g("owner"), p.get("member").and_then(Value::as_bool).unwrap_or(false))
    });
    let invites = v["invites"].as_array().into_iter().flatten().filter_map(|i| serde_json::from_value(i.clone()).ok()).collect();
    Ok(Session { account, token, exp: v["exp"].as_i64().unwrap_or(store::now() + 7 * 86400), pc, invites })
}

// ================================================================== sign-in

/// Signs in with Google in the browser (on a thread); Settings and the sign-in page show
/// [`status`]. A sign-in already waiting is left alone.
pub fn sign_in() {
    {
        let mut l = LIVE.write().unwrap();
        if l.status.signing_in {
            return;
        }
        l.status.signing_in = true;
        l.status.error.clear();
        l.status.url.clear();
    }
    CANCEL.store(false, Ordering::SeqCst);
    wake_ui();
    std::thread::spawn(|| {
        let r = sign_in_flow();
        set_status(|s| {
            s.signing_in = false;
            s.url.clear();
            match r {
                Ok(()) => {
                    s.error.clear();
                    s.expired = false;
                }
                Err(e) => s.error = e,
            }
        });
        poke();
    });
}

pub fn cancel_sign_in() {
    CANCEL.store(true, Ordering::SeqCst);
}

fn sign_in_flow() -> Result<(), String> {
    if !configured() && std::env::var("HARBOR_CLERK_URL").is_err() {
        return Err("This build of Harbor has no account service set up.".into());
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr().map_err(|e| e.to_string())?.port());
    let rand = |n| store::random_bytes(n).map_err(|e| format!("No randomness for the sign-in: {e}"));
    let verifier = b64url(&rand(32)?);
    let challenge = b64url(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()).as_ref());
    let state = b64url(&rand(16)?);
    let q = crate::mcp::form(&[
        ("response_type", "code"),
        ("client_id", &client_id()),
        ("redirect_uri", &redirect),
        ("scope", SCOPE),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", &state),
        // Signing in again (another Google account) shows the account chooser, not the last one.
        ("prompt", "login"),
    ]);
    let url = format!("{}/oauth/authorize?{q}", clerk_url());
    crate::git::open_url(&url);
    set_status(|s| s.url = url.clone());
    let code = crate::mcp::wait_callback(&listener, "/callback", &state, &CANCEL)?;
    let body = crate::mcp::form(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", &redirect), ("client_id", &client_id()), ("code_verifier", &verifier)]);
    let (status, t) = curl("POST", &format!("{}/oauth/token", clerk_url()), None, Some(("application/x-www-form-urlencoded", &body)))?;
    let mut sec = Secrets::default();
    token_reply(&mut sec, status, &t).map_err(|e| if e == Fail::Expired { format!("Clerk refused the sign-in: {}", t["error_description"].as_str().or(t["error"].as_str()).unwrap_or("")) } else { e.text() })?;
    let s = session(&sec.access).map_err(|e| e.text())?;
    // Option A: someone else's PC stays theirs.
    if let Some((_, ws_name, owner, false)) = &s.pc {
        let whose = if owner.is_empty() { format!("“{ws_name}”") } else { format!("“{ws_name}” ({owner})") };
        return Err(format!("This PC belongs to {whose}. Signing in here gives you nothing without an invite: ask its owner to invite {}, then sign in again.", if s.account.email.is_empty() { "you".to_string() } else { s.account.email.clone() }));
    }
    sec.token = s.token.clone();
    sec.token_exp = s.exp;
    sec.token_at = store::now();
    save_secrets(&sec);
    let ws = {
        let l = LIVE.read().unwrap();
        match &s.pc {
            Some((ws, _, _, true)) => ws.clone(),
            _ if s.account.workspaces.iter().any(|w| w.id == l.ws) => l.ws.clone(),
            _ if s.account.workspaces.len() == 1 => s.account.workspaces[0].id.clone(),
            _ => String::new(),
        }
    };
    let pick = ws.is_empty() && s.account.workspaces.len() > 1;
    // Everything before the account is published: a running Harbor (this one's loop, or the
    // desktop when this is `harbor account login`) takes over from there.
    crate::settingsync::signed_in();
    if !ws.is_empty() {
        let _ = register(&sec.token, &ws);
    }
    set_account(Some(s.account.clone()), Some(ws.clone()));
    set_status(|st| st.pick = pick);
    LIVE.write().unwrap().invites = s.invites;
    ENABLE.store(true, Ordering::SeqCst);
    Ok(())
}

/// Saves who is signed in (None: signed out) and this PC's workspace (None: unchanged).
fn set_account(a: Option<Account>, ws: Option<String>) {
    let store = if cfg!(test) { None } else { store::Store::open().ok() };
    let mut l = LIVE.write().unwrap();
    if let Some(s) = &store {
        // The workspace first: whoever reads kv never sees an account without it.
        if let Some(ws) = &ws {
            s.set("account_ws", ws);
        }
        s.set("account", &a.as_ref().map(|a| serde_json::to_string(a).unwrap_or_default()).unwrap_or_default());
    }
    l.account = a;
    if let Some(ws) = ws {
        if ws != l.ws {
            l.dir = Directory::default();
            if let Some(s) = &store {
                s.set("account_dir", "");
            }
        }
        l.ws = ws;
    }
    drop(l);
    wake_ui();
}

/// Signs this PC out: Clerk's tokens and the identity go. The PC stays in its workspace and
/// keeps serving its members with what it has cached (Option A: only a member takes it out).
pub fn sign_out() {
    save_secrets(&Secrets::default());
    let _ = std::fs::remove_file(secrets_path());
    set_account(None, None);
    set_status(|s| {
        s.expired = false;
        s.pick = false;
        s.error.clear();
    });
}

/// Puts this PC in workspace `ws` (Settings › Account, the picker after sign-in).
pub fn choose_workspace(ws: String) {
    run_action(move |token| {
        register(&token, &ws)?;
        set_account(account(), Some(ws.clone()));
        set_status(|s| s.pick = false);
        Ok(())
    });
}

/// Takes this PC out of its workspace (a member may; the directory forgets it).
pub fn leave_workspace() {
    run_action(|token| {
        let fp = crate::tls::my_fp();
        match service("DELETE", &format!("/v1/pcs/{fp}"), &token, None) {
            Ok(_) | Err(Fail::Refused(..)) => {}
            Err(e) => return Err(e),
        }
        set_account(account(), Some(String::new()));
        set_status(|s| s.pick = account().is_some_and(|a| a.workspaces.len() > 1));
        Ok(())
    });
}

pub fn invite(ws: String, email: String) {
    run_action(move |token| {
        service("POST", &format!("/v1/workspaces/{ws}/invites"), &token, Some(&json!({ "email": email.trim() })))?;
        // No email goes out: the invitation waits in their Harbor.
        let note = format!("Invited {}: they'll see it in Harbor when they sign in with that Google account.", email.trim());
        set_status(|st| st.notice = note);
        Ok(())
    });
}

/// Accepts an invitation made to this account: it joins that workspace (the PC stays in its
/// own; Settings › Account moves it). Nothing else changes here: chats and running turns stay.
pub fn accept_invite(id: String) {
    answer_invite(id, true);
}

pub fn decline_invite(id: String) {
    answer_invite(id, false);
}

fn answer_invite(id: String, accept: bool) {
    run_action(move |token| {
        let v = service("POST", &format!("/v1/invites/{id}/{}", if accept { "accept" } else { "decline" }), &token, None)?;
        LIVE.write().unwrap().invites.retain(|i| i.id != id);
        if let Some(name) = v["joined"]["name"].as_str() {
            let note = format!("You joined {name}. Its PCs and chats reach you on your phone; to move this PC there, use Settings › Account.");
            set_status(|st| st.notice = note);
        }
        // A token that names the new workspace.
        RENEW.store(true, Ordering::SeqCst);
        Ok(())
    });
}

fn fetch_invites(token: &str) -> Result<(), Fail> {
    let v = service("GET", "/v1/invites", token, None)?;
    let list: Vec<PendingInvite> = v["invites"].as_array().into_iter().flatten().filter_map(|i| serde_json::from_value(i.clone()).ok()).collect();
    let mut l = LIVE.write().unwrap();
    if l.invites != list {
        l.invites = list;
        drop(l);
        wake_ui();
    }
    Ok(())
}

pub fn cancel_invite(ws: String, id: String) {
    run_action(move |token| service("DELETE", &format!("/v1/workspaces/{ws}/invites/{id}"), &token, None).map(|_| ()));
}

/// Removes a member (an owner), or the account itself from a workspace it was invited to.
pub fn remove_member(ws: String, user: String) {
    run_action(move |token| {
        service("DELETE", &format!("/v1/workspaces/{ws}/members/{user}"), &token, None)?;
        RENEW.store(true, Ordering::SeqCst);
        Ok(())
    });
}

/// Signs a device of the account out (a lost phone): PCs refuse its token once their directory
/// no longer lists it.
pub fn remove_device(fp: String) {
    run_action(move |token| service("DELETE", &format!("/v1/devices/{fp}"), &token, None).map(|_| ()));
}

/// An action from Settings on a thread; then the directory is fetched again.
fn run_action(f: impl FnOnce(String) -> Result<(), Fail> + Send + 'static) {
    set_status(|s| {
        s.busy = true;
        s.error.clear();
    });
    std::thread::spawn(move || {
        let r = match harbor_token() {
            Some(t) => f(t),
            None => Err(Fail::Expired),
        };
        set_status(|s| {
            s.busy = false;
            match &r {
                Err(Fail::Expired) => s.expired = true,
                Err(e) => s.error = e.text(),
                Ok(()) => {}
            }
        });
        if let Some(t) = harbor_token() {
            let _ = fetch_directory(&t);
            let _ = fetch_invites(&t);
        }
        poke();
    });
}

/// `POST /v1/pcs`: this PC's entry in its workspace's directory (also Option A's check).
fn register(token: &str, ws: &str) -> Result<(), Fail> {
    let hub = crate::api::HUB.get();
    // From a terminal (no hub running here): the same id and port the desktop uses.
    let me = hub.map(|h| h.mesh.me()).filter(|m| !m.id.is_empty()).unwrap_or_else(|| crate::mesh::read_me().0);
    let kv_port = || store::Store::open().ok().and_then(|s| s.get("api_port")).and_then(|p| p.parse().ok());
    let port = hub.map(|h| *h.port.lock().unwrap()).or_else(kv_port).unwrap_or(crate::api::DEFAULT_PORT);
    let name = if me.name.is_empty() { crate::remote::hostname() } else { me.name.clone() };
    let mut addrs = crate::mesh::my_addrs(port);
    addrs.truncate(16);
    let body = json!({ "ws": ws, "id": me.id, "name": name, "addrs": addrs, "version": env!("CARGO_PKG_VERSION") });
    match service("POST", "/v1/pcs", token, Some(&body)) {
        Ok(_) => Ok(()),
        Err(Fail::Refused(e, v)) => {
            // Someone else's PC (Option A): this account doesn't get it.
            if v["ws"].is_string() {
                set_status(|s| s.error = e.clone());
            }
            Err(Fail::Refused(e, v))
        }
        Err(e) => Err(e),
    }
}

fn fetch_directory(token: &str) -> Result<(), Fail> {
    let v = service("GET", "/v1/directory", token, None)?;
    let dir: Directory = serde_json::from_value(v).map_err(|e| Fail::Offline(format!("an odd directory: {e}")))?;
    let store = store::Store::open().ok();
    if let Some(s) = &store {
        s.set("account_dir", &serde_json::to_string(&dir).unwrap_or_default());
    }
    let mut l = LIVE.write().unwrap();
    // Workspaces joined or left since the token: a new one names them.
    if let Some(a) = l.account.as_mut() {
        let ids: Vec<&str> = dir.workspaces.iter().map(|d| d.ws.id.as_str()).collect();
        if ids.len() != a.workspaces.len() || a.workspaces.iter().any(|w| !ids.contains(&w.id.as_str())) {
            RENEW.store(true, Ordering::SeqCst);
        }
        a.workspaces = dir.workspaces.iter().map(|d| d.ws.clone()).collect();
        if let Some(s) = &store {
            s.set("account", &serde_json::to_string(&*a).unwrap_or_default());
        }
    }
    // This PC's workspace is gone (it was removed, or this account left it): out of it.
    if !l.ws.is_empty() && dir.of(&l.ws).is_none() && l.account.is_some() {
        l.ws.clear();
        if let Some(s) = &store {
            s.set("account_ws", "");
        }
        l.status.pick = l.account.as_ref().is_some_and(|a| a.workspaces.len() > 1);
    }
    l.dir = dir;
    l.status.synced_at = store::now();
    drop(l);
    wake_ui();
    Ok(())
}

fn fetch_keys() {
    if !KEYS.is_empty() || std::env::var("HARBOR_ACCOUNTS_KEYS").is_ok() {
        return;
    }
    let Ok((200, v)) = curl("GET", &format!("{}/v1/keys", service_url()), None, None) else { return };
    let keys: Vec<(String, String)> = v["keys"].as_array().into_iter().flatten().filter(|k| k["alg"] == "EdDSA").filter_map(|k| Some((k["kid"].as_str()?.to_string(), k["x"].as_str()?.to_string()))).collect();
    if keys.is_empty() {
        return;
    }
    if let Ok(s) = store::Store::open() {
        s.set("account_keys", &serde_json::to_string(&keys).unwrap_or_default());
    }
    LIVE.write().unwrap().fetched_keys = keys.into_iter().filter_map(|(k, x)| b64url_decode(&x).filter(|b| b.len() == 32).map(|b| (k, b))).collect();
}

// ================================================================== the loop

/// Loads what's cached and starts the account loop (once).
pub fn start(s: &store::Store, wake: impl Fn() + Send + Sync + 'static) {
    let _ = WAKE.set(Box::new(wake));
    load(s);
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| {
            let mut t = Timers::default();
            loop {
                tick(&mut t);
                let (m, cv) = &*POKE;
                let g = m.lock().unwrap();
                let (mut g, _) = cv.wait_timeout_while(g, Duration::from_secs(20), |p| *p == 0).unwrap();
                let why = std::mem::take(&mut *g);
                drop(g);
                if why == 2 {
                    t = Timers { keys: t.keys, ..Default::default() };
                } else if why == 1 {
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        });
    });
}

/// What's cached: who is signed in, this PC's workspace and directory, the keys.
fn load(s: &store::Store) {
    {
        let mut l = LIVE.write().unwrap();
        l.account = s.get("account").and_then(|v| serde_json::from_str::<Account>(&v).ok()).filter(|a| !a.id.is_empty());
        l.ws = s.get("account_ws").unwrap_or_default();
        l.dir = s.get("account_dir").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
        let keys: Vec<(String, String)> = s.get("account_keys").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
        l.fetched_keys = keys.into_iter().filter_map(|(k, x)| b64url_decode(&x).filter(|b| b.len() == 32).map(|b| (k, b))).collect();
        l.status.pick = l.account.as_ref().is_some_and(|a| l.ws.is_empty() && a.workspaces.len() > 1);
    }
    crate::settingsync::load(s);
}

#[derive(Default)]
struct Timers {
    keys: Option<Instant>,
    dir: Option<Instant>,
    pc: Option<Instant>,
    pull: Option<Instant>,
    addrs: Vec<String>,
}

fn due(at: Option<Instant>, every: Duration) -> bool {
    at.is_none_or(|t| t.elapsed() >= every)
}

/// The account as kv has it now: `harbor account login|logout` on a terminal changes it under
/// a running Harbor, which follows within a turn of the loop.
fn follow_kv(t: &mut Timers) {
    let Ok(s) = store::Store::open() else { return };
    let kv = s.get("account").and_then(|v| serde_json::from_str::<Account>(&v).ok()).filter(|a| !a.id.is_empty());
    let ws = s.get("account_ws").unwrap_or_default();
    let changed = {
        let l = LIVE.read().unwrap();
        l.account.as_ref().map(|a| &a.id) != kv.as_ref().map(|a| &a.id) || l.ws != ws
    };
    if changed {
        log(|| format!("kv changed: account {:?} ws {ws:?}", kv.as_ref().map(|a| a.email.clone())));
        let came = kv.is_some() && !signed_in();
        {
            let mut l = LIVE.write().unwrap();
            l.account = kv;
            if l.ws != ws {
                l.dir = s.get("account_dir").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
            }
            l.ws = ws;
        }
        if came {
            crate::settingsync::load(&s);
            ENABLE.store(true, Ordering::SeqCst);
        }
        *t = Timers { keys: t.keys, ..Default::default() };
        wake_ui();
    }
}

fn tick(t: &mut Timers) {
    follow_kv(t);
    log(|| format!("tick: signed in {} ws {:?}", signed_in(), workspace()));
    if due(t.keys, Duration::from_secs(6 * 3600)) && (signed_in() || !workspace().is_empty()) {
        t.keys = Some(Instant::now());
        fetch_keys();
    }
    if !signed_in() {
        return;
    }
    let mut sec = load_secrets();
    let now = store::now();
    if sec.token.is_empty() || now - sec.token_at > RENEW_AFTER || sec.token_exp - now < 2 * 86400 || RENEW.swap(false, Ordering::SeqCst) {
        match fresh_access(&mut sec).and_then(|a| session(&a)) {
            Ok(s) => {
                sec.token = s.token;
                sec.token_exp = s.exp;
                sec.token_at = now;
                save_secrets(&sec);
                set_account(Some(s.account), None);
                LIVE.write().unwrap().invites = s.invites;
                set_status(|st| {
                    st.expired = false;
                    st.offline_since = 0;
                });
            }
            Err(Fail::Expired) => set_status(|st| st.expired = true),
            Err(Fail::Offline(_)) => set_status(|st| st.offline_since = if st.offline_since == 0 { now } else { st.offline_since }),
            Err(e) => set_status(|st| st.error = e.text()),
        }
    }
    if sec.token.is_empty() || sec.token_exp <= now {
        return;
    }
    let token = sec.token.clone();
    let result = |r: Result<(), Fail>| match r {
        Ok(()) => set_status(|st| st.offline_since = 0),
        Err(Fail::Expired) => RENEW.store(true, Ordering::SeqCst),
        Err(Fail::Offline(_)) => set_status(|st| st.offline_since = if st.offline_since == 0 { now } else { st.offline_since }),
        Err(_) => {}
    };
    let ws = workspace();
    let hub = crate::api::HUB.get();
    let addrs = crate::mesh::my_addrs(hub.map(|h| *h.port.lock().unwrap()).unwrap_or(crate::api::DEFAULT_PORT));
    if !ws.is_empty() && (due(t.pc, PC_EVERY) || addrs != t.addrs) {
        t.pc = Some(Instant::now());
        t.addrs = addrs;
        let r = register(&token, &ws);
        log(|| format!("register: {r:?}"));
        result(r);
    }
    if due(t.dir, DIR_EVERY) {
        t.dir = Some(Instant::now());
        let r = fetch_directory(&token).and_then(|_| fetch_invites(&token));
        log(|| format!("directory: {r:?}"));
        result(r);
    }
    let pull = due(t.pull, SYNC_EVERY);
    if pull {
        t.pull = Some(Instant::now());
    }
    let r = crate::settingsync::sync(&token, pull);
    if r.is_err() || pull {
        log(|| format!("settings: {r:?}"));
    }
    result(r);
}

/// `GET`/`PUT /v1/settings` for settingsync.rs.
pub fn settings_call(token: &str, body: Option<&Value>) -> Result<Value, Fail> {
    match body {
        Some(b) => service("PUT", "/v1/settings", token, Some(b)),
        None => service("GET", "/v1/settings", token, None),
    }
}

/// For the desktop's tick: this account's sign-in just completed (phones and PC sharing go on).
pub fn take_enable() -> bool {
    ENABLE.swap(false, Ordering::SeqCst)
}

/// A notice for the desktop's toast, once.
pub fn take_notice() -> Option<String> {
    let mut l = LIVE.write().unwrap();
    (!l.status.notice.is_empty()).then(|| std::mem::take(&mut l.status.notice))
}

// ================================================================== CLI

/// `harbor account [status|login|logout]`: who is signed in on this PC, its workspace and
/// directory; signing in from a terminal (a PC without a screen, over SSH: the URL is printed
/// to open anywhere that reaches this PC's loopback, e.g. through `ssh -L`).
pub fn cli(args: &[String]) -> i32 {
    let Ok(s) = store::Store::open() else {
        eprintln!("harbor: can't open the database");
        return 1;
    };
    match args.first().map(String::as_str).unwrap_or("status") {
        "login" => {
            load(&s);
            std::thread::spawn(|| {
                let mut shown = String::new();
                loop {
                    let st = status();
                    if !st.url.is_empty() && st.url != shown {
                        shown = st.url.clone();
                        println!("Sign in with Google in the browser that opened, or open:\n{shown}");
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            });
            match sign_in_flow() {
                Ok(()) => {
                    let a = account().unwrap_or_default();
                    println!("Signed in as {} <{}>.", a.name, a.email);
                    if workspace().is_empty() && a.workspaces.len() > 1 {
                        println!("Pick this PC's workspace in Harbor › Settings › Account: {}", a.workspaces.iter().map(|w| w.name.as_str()).collect::<Vec<_>>().join(", "));
                    }
                    0
                }
                Err(e) => {
                    eprintln!("harbor: {e}");
                    1
                }
            }
        }
        "logout" => {
            load(&s);
            sign_out();
            println!("Signed out. This PC stays in its workspace.");
            0
        }
        "status" => {
            let a = s.get("account").and_then(|v| serde_json::from_str::<Account>(&v).ok()).filter(|a| !a.id.is_empty());
            let ws = s.get("account_ws").unwrap_or_default();
            let dir: Directory = s.get("account_dir").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
            println!("service:   {}{}", service_url(), if configured() { "" } else { " (placeholder: not set up)" });
            match &a {
                Some(a) => println!("account:   {} <{}> ({})", a.name, a.email, a.id),
                None => println!("account:   not signed in"),
            }
            let name = |id: &str| dir.of(id).map(|d| d.ws.name.clone()).or_else(|| a.as_ref().and_then(|a| a.workspaces.iter().find(|w| w.id == id).map(|w| w.name.clone()))).unwrap_or_default();
            println!("workspace: {}", if ws.is_empty() { "none".to_string() } else { format!("{} ({ws})", name(&ws)) });
            if let Some(d) = dir.of(&ws) {
                println!("members:   {}", d.members.iter().map(|m| format!("{} <{}> {}", m.name, m.email, m.role)).collect::<Vec<_>>().join(", "));
                for p in &d.pcs {
                    println!("pc:        {} {} {}", p.name, crate::tls::short(&p.fp), p.addrs.join(" "));
                }
                println!("devices:   {}", d.devices.len());
            }
            println!("this pc:   {}", crate::tls::my_fp());
            0
        }
        _ => {
            eprintln!("usage: harbor account [status|login|logout]\nOr sign in and out in Harbor › Settings › Account.");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;

    fn key() -> (ring::signature::Ed25519KeyPair, Vec<(String, Vec<u8>)>) {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let kp = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let public = kp.public_key().as_ref().to_vec();
        (kp, vec![("k1".into(), public)])
    }

    fn token(kp: &ring::signature::Ed25519KeyPair, claims: Value) -> String {
        let h = b64url(br#"{"alg":"EdDSA","typ":"JWT","kid":"k1"}"#);
        let p = b64url(claims.to_string().as_bytes());
        let input = format!("{h}.{p}");
        let sig = kp.sign(input.as_bytes());
        format!("{input}.{}", b64url(sig.as_ref()))
    }

    fn claims(now: i64) -> Value {
        json!({ "iss": "harbor-accounts", "sub": "user_1", "email": "sam@example.com", "name": "Sam", "ws": ["org_a"], "dev": "phonefp", "kind": "phone", "iat": now - 10, "exp": now + 3600 })
    }

    #[test]
    fn tokens_verify_offline() {
        let (kp, keys) = key();
        let now = 1_800_000_000;
        let t = token(&kp, claims(now));
        assert!(is_token(&t));
        let c = verify_with(&t, &keys, now).unwrap();
        assert_eq!((c.sub.as_str(), c.dev.as_str(), c.ws.clone()), ("user_1", "phonefp", vec!["org_a".to_string()]));
        assert!(verify_with(&t, &keys, now + 7200).is_err(), "expired");
        let (_, other) = key();
        assert!(verify_with(&t, &other, now).is_err(), "another key");
        // A changed payload breaks the signature.
        let mut parts: Vec<String> = t.split('.').map(String::from).collect();
        let mut c2 = claims(now);
        c2["ws"] = json!(["org_b"]);
        parts[1] = b64url(c2.to_string().as_bytes());
        assert!(verify_with(&parts.join("."), &keys, now).is_err(), "tampered");
        let mut c3 = claims(now);
        c3["iss"] = json!("someone");
        assert!(verify_with(&token(&kp, c3), &keys, now).is_err(), "issuer");
        assert!(verify_with("abc", &keys, now).is_err() && !is_token("0123abcd"));
    }

    #[test]
    fn workspace_and_revocation() {
        let now = 1_800_000_000;
        let c: Claims = serde_json::from_value(claims(now)).unwrap();
        let empty = Directory::default();
        assert!(decide(&c, "", &empty).is_err(), "a PC in no workspace takes nobody");
        assert!(decide(&c, "org_b", &empty).is_err(), "Option A: another workspace's PC");
        assert!(decide(&c, "org_a", &empty).is_ok(), "no directory yet: the token decides");
        let member = Member { id: "user_1".into(), ..Default::default() };
        let mut dir = Directory { at: (now - 100) * 1000, workspaces: vec![Dir { ws: Workspace { id: "org_a".into(), ..Default::default() }, members: vec![], devices: vec![], ..Default::default() }] };
        assert!(decide(&c, "org_a", &dir).is_ok(), "an older directory doesn't overrule a newer token");
        dir.at = (now + 100) * 1000;
        assert!(decide(&c, "org_a", &dir).is_err(), "removed after the token was made");
        dir.workspaces[0].members.push(member);
        assert!(decide(&c, "org_a", &dir).is_err(), "device signed out");
        dir.workspaces[0].devices.push("phonefp".into());
        assert!(decide(&c, "org_a", &dir).is_ok());
    }

    #[test]
    fn base64url_round_trip() {
        for n in 0..40 {
            let b: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(b64url_decode(&b64url(&b)).unwrap(), b);
        }
        assert!(b64url_decode("a b").is_none());
    }
}
