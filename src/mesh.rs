//! Every PC is a hub: the Harbors on the user's own PCs keep a full copy of each other's
//! chats, so a phone (or the user at another desk) keeps working when one PC is off.
//!
//! - **One owner per chat.** A chat belongs to the PC it was created on (its "home"); the
//!   agent always runs there. Every other PC holds a copy (`Chat::home` names the owner,
//!   `Chat::home_id` is the chat's id there) that it never writes itself: messages, Stop,
//!   renames and run settings typed on another PC are forwarded to the home PC, which applies
//!   them as if typed on its own window and orders the transcript. The copies follow.
//! - **Replication is pull.** Each PC runs a worker per peer that long-polls the peer's
//!   `/mesh/v1/events`, then fetches the peer's own chats that changed (`/mesh/v1/chats`) and
//!   their items that changed (`/mesh/v1/chats/{id}/items`), with the same revisions the phone
//!   API uses (api.rs). After either side restarts the peer's epoch changes, the worker asks
//!   for the full list, and only chats whose digest differs are fetched again.
//! - **Off means read-only.** A copy whose home PC doesn't answer can be read but not
//!   written; it catches up when the PC is back.
//! - **Transport.** The phone API's listener (port 47930, Tailscale addresses only) serves
//!   `/mesh/v1/…` too. A peer is accepted when `tailscale whois` says its address belongs to
//!   the same Tailscale user as this PC: only the user's own devices. No tokens are involved.
//!   (For tests with several instances on one PC: `HARBOR_MESH_LOOPBACK=1` also accepts
//!   127.0.0.1, `HARBOR_MESH_PEERS=host:port,…` names the peers instead of Tailscale, and
//!   `HARBOR_MESH_ID`/`HARBOR_MESH_NAME` set this instance's identity.)
//!
//! Settings stay local to each PC and never travel. The wire format is in android/PROTOCOL.md.

use crate::api::{self, Call, Reply, err, ok};
use crate::app::App;
use crate::store::{self, Chat, Item, Role};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A peer's long-poll answers within this; the client waits a little longer.
const POLL: Duration = Duration::from_secs(20);
const CONNECT: Duration = Duration::from_secs(3);
/// A forwarded call (a send with its files) may take this long.
const CALL_WAIT: Duration = Duration::from_secs(60);
/// How long a `tailscale whois` answer is trusted.
const WHOIS_TTL: Duration = Duration::from_secs(120);
/// Copies of a streaming reply are written to disk at most this often.
const SAVE_EVERY: Duration = Duration::from_secs(2);
/// The kv key of what this PC knows about its peers (names and addresses, for when they're off).
const PEERS_KEY: &str = "mesh_peers";

// ================================================================== shared state

/// This PC in the mesh: "ts:<MagicDNS label>" and a name to show.
#[derive(Clone, Default, Debug, PartialEq)]
pub struct Me {
    pub id: String,
    pub name: String,
}

/// Another PC's Harbor.
#[derive(Clone, Default, Debug, serde::Serialize, serde::Deserialize)]
pub struct Peer {
    pub id: String,
    pub name: String,
    /// Where its listener answers ("<tailnet address>:47930").
    pub addr: String,
    /// Its MagicDNS name, for phones.
    #[serde(default)]
    pub dns: String,
    #[serde(skip)]
    pub online: bool,
    /// Unix time of its last answer.
    #[serde(default)]
    pub seen: i64,
    #[serde(default)]
    pub version: String,
    /// Its accounts: (id, short label, kind slug), for the footers of its chats.
    #[serde(default)]
    pub accounts: Vec<(String, String, String)>,
}

/// What the listener threads, the peer workers and the UI thread share (in `api::Hub`).
#[derive(Default)]
pub struct Shared {
    pub on: AtomicBool,
    started: AtomicBool,
    pub me: Mutex<Me>,
    pub peers: Mutex<HashMap<String, Peer>>,
    /// This PC's own chats deleted this run, with the revision they went at.
    gone: Mutex<Vec<(u64, i64)>>,
    /// Chats here that are copies of another PC's.
    pub foreign: Mutex<HashSet<i64>>,
    /// (peer, its chat id) → the copy's id here.
    pub ids: Mutex<HashMap<(String, i64), i64>>,
    /// Peer address → (when asked, its peer id when it's one of the user's devices).
    whois: Mutex<HashMap<IpAddr, (Instant, Option<String>)>>,
    /// The Tailscale user this PC is logged in as.
    user: Mutex<Option<i64>>,
}

impl Shared {
    pub fn me(&self) -> Me {
        self.me.lock().unwrap().clone()
    }

    pub fn peer(&self, id: &str) -> Option<Peer> {
        self.peers.lock().unwrap().get(id).cloned()
    }

    pub fn online(&self, id: &str) -> bool {
        self.peers.lock().unwrap().get(id).is_some_and(|p| p.online)
    }

    /// A peer's name to show, its id's label when it never answered.
    pub fn name_of(&self, id: &str) -> String {
        self.peer(id).map(|p| p.name).filter(|n| !n.is_empty()).unwrap_or_else(|| label(id))
    }

    pub fn local_id(&self, peer: &str, id: i64) -> Option<i64> {
        self.ids.lock().unwrap().get(&(peer.to_string(), id)).copied()
    }
}

/// "ts:desk" → "desk".
pub fn label(id: &str) -> String {
    id.split_once(':').map(|(_, l)| l).unwrap_or(id).to_string()
}

/// What the UI thread keeps.
#[derive(Default)]
pub struct Local {
    /// Per copy: its home PC's live state of it.
    pub status: HashMap<i64, Remote>,
    /// (peer, its chat id) → (peer epoch, revision its items were last fetched at).
    isince: HashMap<(String, i64), (u64, u64)>,
    /// Own chats: per item (fingerprint, revision), as `api::Local::items` but for raw items.
    items: HashMap<i64, Vec<(u64, u64)>>,
    looked: HashMap<i64, u64>,
    /// Own chats: (hub revision, digest) as last computed.
    digests: HashMap<i64, (u64, u64)>,
    /// Copies with items not yet written to disk, since when.
    dirty: HashMap<i64, Instant>,
    /// A forwarded call that failed, shown above the composer: (chat, text, when).
    pub error: Option<(i64, String, Instant)>,
    /// A chat created on another PC from here: opened when its copy arrives.
    pub open_when: Option<(String, i64, Instant)>,
    /// True while a peer's forwarded call runs (it never goes on to a third PC).
    in_call: bool,
}

/// A copy's live state as its home PC says it.
#[derive(Clone, Default, Debug)]
pub struct Remote {
    pub running: bool,
    /// Unix ms the running turn started at.
    pub since_ms: Option<i64>,
    pub queued: usize,
    /// The bars under the transcript (`App::api_status` on the home PC), ids mapped here.
    pub status: Value,
    /// Forks made from it: (item, fork's id here).
    pub forks: Vec<(usize, i64)>,
}

/// Messages from the peer workers to the UI thread.
pub enum Msg {
    /// A peer's chats changed: apply them; answer which need their items (home id, since).
    Chats { peer: String, epoch: u64, body: Value, reply: Sender<Vec<(i64, u64)>> },
    Items { peer: String, epoch: u64, home_id: i64, body: Value },
    /// A peer came or went.
    Peer,
    /// A forwarded call from this PC's window ended.
    Done { chat: i64, what: &'static str, reply: Reply, restore: Option<String> },
}

// ================================================================== identity

/// This PC's peer id and name from `tailscale status --json` (env overrides for tests).
pub fn read_me() -> (Me, Option<i64>) {
    let out = std::process::Command::new("tailscale").args(["status", "--json"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output();
    let v = out.ok().and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok()).unwrap_or_default();
    let (mut me, user) = parse_me(&v);
    if let Ok(id) = std::env::var("HARBOR_MESH_ID") {
        me.id = id;
    }
    if let Ok(n) = std::env::var("HARBOR_MESH_NAME") {
        me.name = n;
    }
    if me.id.is_empty() {
        me.id = format!("pc:{}", crate::remote::hostname());
    }
    if me.name.is_empty() {
        me.name = label(&me.id);
    }
    (me, user)
}

pub fn parse_me(v: &Value) -> (Me, Option<i64>) {
    let dns = v["Self"]["DNSName"].as_str().unwrap_or("");
    let l = dns.split('.').next().unwrap_or("");
    let me = if l.is_empty() { Me::default() } else { Me { id: format!("ts:{l}"), name: l.to_string() } };
    (me, v["Self"]["UserID"].as_i64())
}

/// `tailscale whois --json <ip>`: the node's peer id when it belongs to `user`.
pub fn parse_whois(v: &Value, user: i64) -> Option<String> {
    if v["UserProfile"]["ID"].as_i64() != Some(user) {
        return None;
    }
    let name = v["Node"]["Name"].as_str().unwrap_or("");
    let l = name.split('.').next().unwrap_or("");
    (!l.is_empty()).then(|| format!("ts:{l}"))
}

/// Which peer is calling from `ip`, if it's one of the user's own devices.
fn who(shared: &Shared, ip: IpAddr) -> Option<String> {
    if ip.is_loopback() {
        return (std::env::var("HARBOR_MESH_LOOPBACK").as_deref() == Ok("1")).then(|| "loopback".to_string());
    }
    if let Some((at, id)) = shared.whois.lock().unwrap().get(&ip) {
        if at.elapsed() < WHOIS_TTL {
            return id.clone();
        }
    }
    let user = *shared.user.lock().unwrap();
    let id = user.and_then(|u| {
        let out = std::process::Command::new("tailscale").args(["whois", "--json", &ip.to_string()]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().ok()?;
        parse_whois(&serde_json::from_slice(&out.stdout).ok()?, u)
    });
    shared.whois.lock().unwrap().insert(ip, (Instant::now(), id.clone()));
    id
}

// ================================================================== HTTP client

/// One request to a peer: (status, JSON body). Errors are for the user ("… didn't answer").
pub fn http(addr: &str, method: &str, path: &str, body: Option<(&str, &[u8])>, wait: Duration) -> Result<(u16, Value), String> {
    let sock = addr.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("no address")?;
    let s = TcpStream::connect_timeout(&sock, CONNECT).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(wait));
    let _ = s.set_write_timeout(Some(wait));
    let (ctype, data) = body.unwrap_or(("application/json", b""));
    let head = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", data.len());
    let mut w = &s;
    w.write_all(head.as_bytes()).and_then(|_| w.write_all(data)).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(&s);
    let mut line = String::new();
    r.read_line(&mut line).map_err(|e| e.to_string())?;
    let status: u16 = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("not Harbor")?;
    let mut len: Option<usize> = None;
    loop {
        let mut l = String::new();
        if r.read_line(&mut l).map_err(|e| e.to_string())? == 0 || l.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().ok();
            }
        }
    }
    let mut buf = vec![];
    match len {
        Some(n) if n <= 64 << 20 => {
            buf.resize(n, 0);
            r.read_exact(&mut buf).map_err(|e| e.to_string())?;
        }
        Some(_) => return Err("answer too large".into()),
        None => {
            r.take(64 << 20).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        }
    }
    let v = if buf.is_empty() { Value::Null } else { serde_json::from_slice(&buf).map_err(|e| e.to_string())? };
    Ok((status, v))
}

fn get(addr: &str, path: &str, wait: Duration) -> Result<Value, String> {
    match http(addr, "GET", path, None, wait)? {
        (200, v) => Ok(v),
        (s, v) => Err(format!("{s}: {}", v["error"].as_str().unwrap_or(""))),
    }
}

// ================================================================== server (a peer asks)

/// A `/mesh/…` request on the API listener (api.rs `serve`). Answers here or on the UI thread.
pub fn serve(stream: &TcpStream, req: &api::Request, r: &mut impl Read, hub: &api::Hub, tx: &Sender<crate::control::Incoming>, wake: &(impl Fn() + Send + Sync)) -> Reply {
    let shared = &hub.mesh;
    if !shared.on.load(Ordering::SeqCst) {
        return err(403, "this PC doesn't share its chats (Settings › Devices)");
    }
    let Some(ip) = stream.peer_addr().ok().map(|a| a.ip()) else { return err(403, "unknown peer") };
    let Some(peer) = who(shared, ip) else { return err(403, "not one of this user's devices") };
    let segs = req.segments();
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["mesh", "v1", "events"]) => {
            let since: u64 = req.query("since").and_then(|s| s.parse().ok()).unwrap_or(0);
            let epoch: u64 = req.query("epoch").and_then(|s| s.parse().ok()).unwrap_or(0);
            if epoch != hub.epoch {
                return ok(json!({ "epoch": hub.epoch, "rev": hub.rev() }));
            }
            let deadline = Instant::now() + POLL;
            let mut at = since;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                let (rev, chats, _) = hub.wait(at, left);
                let foreign = shared.foreign.lock().unwrap().clone();
                let own = chats.iter().any(|c| !foreign.contains(c));
                let gone = shared.gone.lock().unwrap().iter().any(|(r, _)| *r > since);
                if own || gone || left.is_zero() || rev <= at {
                    return ok(json!({ "epoch": hub.epoch, "rev": rev }));
                }
                // Only copies changed (another PC's chats): nothing this peer needs from here.
                at = rev;
            }
        }
        ("POST", ["mesh", "v1", "upload"]) => {
            let q = api::Request { query: vec![("name".into(), req.query("name").unwrap_or("file").into())], ..req.clone() };
            api::upload_to(r, &q, &api::uploads_dir())
        }
        ("POST", ["mesh", "v1", "mint"]) => {
            let body = read_json(r, req.len);
            mint(hub, &body)
        }
        ("POST", ["mesh", "v1", "revoke"]) => {
            let body = read_json(r, req.len);
            let groups: Vec<String> = body["groups"].as_array().into_iter().flatten().filter_map(|g| g.as_str().map(String::from)).collect();
            merge_revoked(hub, &groups);
            wake();
            ok(json!({ "ok": true }))
        }
        _ => {
            let body = read_json(r, req.len);
            let (rtx, rrx) = channel();
            let call = Call {
                method: req.method.clone(),
                path: segs.iter().map(|s| s.to_string()).collect(),
                query: req.query.clone(),
                body,
                token: String::new(),
                device: peer,
                reply: rtx,
            };
            if tx.send(crate::control::Incoming::Api(call)).is_err() {
                return err(503, "Harbor is closing");
            }
            wake();
            rrx.recv_timeout(CALL_WAIT).unwrap_or_else(|_| err(503, "Harbor did not answer in time"))
        }
    }
}

fn read_json(r: &mut impl Read, len: usize) -> Value {
    api::read_body(r, len, 4 << 20).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
}

/// A peer asks for a token for a phone paired with it (`group`: the pairing both share).
/// The same group always gets the same token here, so asking again changes nothing.
fn mint(hub: &api::Hub, body: &Value) -> Reply {
    let group = body["group"].as_str().unwrap_or("").trim();
    if group.len() < 16 {
        return err(400, "bad group");
    }
    if hub.mesh_revoked(group) {
        return err(410, "this phone was removed");
    }
    let name: String = body["name"].as_str().unwrap_or("").chars().take(60).collect();
    let mut tokens = hub.tokens.lock().unwrap();
    if let Some(t) = tokens.iter().find(|t| t.group == group) {
        return ok(json!({ "token": t.token }));
    }
    let Ok(token) = api::new_token() else { return err(500, "no randomness") };
    tokens.push(api::Token { token: token.clone(), name, created: store::now(), group: group.to_string() });
    hub.tokens_dirty.store(true, Ordering::SeqCst);
    ok(json!({ "token": token }))
}

/// Pairings removed on another PC: their phones' tokens here go too.
pub fn merge_revoked(hub: &api::Hub, groups: &[String]) {
    let mut revoked = hub.revoked.lock().unwrap();
    let new: Vec<&String> = groups.iter().filter(|g| g.len() >= 16 && !revoked.contains(g)).collect();
    if new.is_empty() {
        return;
    }
    revoked.extend(new.iter().map(|g| g.to_string()));
    hub.tokens.lock().unwrap().retain(|t| !new.contains(&&t.group));
    hub.tokens_dirty.store(true, Ordering::SeqCst);
}

// ================================================================== client (workers)

/// Starts discovery and the peer workers once (sharing turned on); later calls do nothing.
pub fn start(hub: Arc<api::Hub>, tx: Sender<crate::control::Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    if hub.mesh.started.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let (me, user) = read_me();
        *hub.mesh.me.lock().unwrap() = me;
        *hub.mesh.user.lock().unwrap() = user;
        let mut running: HashSet<String> = HashSet::new();
        loop {
            if hub.mesh.on.load(Ordering::SeqCst) {
                let port = *hub.port.lock().unwrap();
                for (addr, id, dns) in candidates(port) {
                    if running.insert(addr.clone()) {
                        let (hub, tx, wake) = (hub.clone(), tx.clone(), wake.clone());
                        std::thread::spawn(move || worker(hub, addr, id, dns, tx, wake));
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(20));
        }
    });
}

/// Where peers may be: (address, peer id from Tailscale, MagicDNS name).
fn candidates(port: u16) -> Vec<(String, Option<String>, String)> {
    let mut v: Vec<(String, Option<String>, String)> = std::env::var("HARBOR_MESH_PEERS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(|a| (a.to_string(), None, String::new()))
        .collect();
    // Peers given by hand (tests): only those.
    if !v.is_empty() {
        return v;
    }
    let out = std::process::Command::new("tailscale").args(["status", "--json"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output();
    if let Some(s) = out.ok().and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok()) {
        for p in crate::remote::parse_status(&s).peers.iter().filter(|p| p.os == "linux") {
            if let Some(ip) = p.ips.iter().find(|i| !i.contains(':')) {
                v.push((format!("{ip}:{port}"), Some(p.id.clone()), p.dns.clone()));
            }
        }
    }
    v
}

/// Keeps this PC's copies of one peer's chats up to date, for as long as Harbor runs.
fn worker(hub: Arc<api::Hub>, addr: String, ts_id: Option<String>, dns: String, tx: Sender<crate::control::Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    let shared = &hub.mesh;
    let mut backoff = Duration::from_secs(2);
    let mut known: Option<String> = ts_id.clone();
    let offline = |id: &Option<String>| {
        if let Some(id) = id {
            let mut peers = shared.peers.lock().unwrap();
            if let Some(p) = peers.get_mut(id).filter(|p| p.online) {
                p.online = false;
                drop(peers);
                let _ = tx.send(crate::control::Incoming::Mesh(Msg::Peer));
                wake();
            }
        }
    };
    loop {
        if !shared.on.load(Ordering::SeqCst) {
            offline(&known);
            std::thread::sleep(Duration::from_secs(3));
            continue;
        }
        let hello = match get(&addr, "/mesh/v1/hello", Duration::from_secs(8)) {
            Ok(h) => h,
            Err(_) => {
                offline(&known);
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(30));
                continue;
            }
        };
        let id = ts_id.clone().unwrap_or_else(|| hello["id"].as_str().unwrap_or("").to_string());
        if id.is_empty() || id == shared.me().id {
            return; // this PC itself
        }
        known = Some(id.clone());
        backoff = Duration::from_secs(2);
        let epoch = hello["epoch"].as_u64().unwrap_or(0);
        let groups: Vec<String> = hello["revoked"].as_array().into_iter().flatten().filter_map(|g| g.as_str().map(String::from)).collect();
        merge_revoked(&hub, &groups);
        {
            let mut peers = shared.peers.lock().unwrap();
            let p = peers.entry(id.clone()).or_default();
            p.id = id.clone();
            p.name = hello["name"].as_str().unwrap_or("").to_string();
            p.addr = addr.clone();
            if !dns.is_empty() {
                p.dns = dns.clone();
            }
            p.online = true;
            p.seen = store::now();
            p.version = hello["version"].as_str().unwrap_or("").to_string();
            p.accounts = hello["accounts"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|a| (a["id"].as_str().unwrap_or("").into(), a["short"].as_str().unwrap_or("").into(), a["kind"].as_str().unwrap_or("").into()))
                .collect();
        }
        let _ = tx.send(crate::control::Incoming::Mesh(Msg::Peer));
        wake();
        let _ = sync(&hub, &addr, &id, epoch, &tx, &wake);
        offline(&known);
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Follows a peer until it stops answering or restarts (its epoch changes).
fn sync(hub: &api::Hub, addr: &str, id: &str, epoch: u64, tx: &Sender<crate::control::Incoming>, wake: &(impl Fn() + Send + Sync)) -> Result<(), String> {
    let mut since = 0u64;
    loop {
        let chats = get(addr, &format!("/mesh/v1/chats?since={since}&epoch={epoch}"), Duration::from_secs(30))?;
        if chats["epoch"].as_u64() != Some(epoch) {
            return Ok(());
        }
        let rev = chats["rev"].as_u64().unwrap_or(0);
        let (rtx, rrx) = channel();
        tx.send(crate::control::Incoming::Mesh(Msg::Chats { peer: id.to_string(), epoch, body: chats, reply: rtx })).map_err(|e| e.to_string())?;
        wake();
        let wants = rrx.recv_timeout(Duration::from_secs(60)).map_err(|e| e.to_string())?;
        for (hid, isince) in wants {
            let body = get(addr, &format!("/mesh/v1/chats/{hid}/items?since={isince}&epoch={epoch}"), Duration::from_secs(60))?;
            if body["epoch"].as_u64() != Some(epoch) {
                return Ok(());
            }
            tx.send(crate::control::Incoming::Mesh(Msg::Items { peer: id.to_string(), epoch, home_id: hid, body })).map_err(|e| e.to_string())?;
            wake();
        }
        since = rev;
        let ev = get(addr, &format!("/mesh/v1/events?since={since}&epoch={epoch}"), POLL + Duration::from_secs(10))?;
        if ev["epoch"].as_u64() != Some(epoch) {
            return Ok(());
        }
        let _ = hub;
    }
}

/// A call forwarded to a chat's home PC, on a thread of its own: its files go first (as
/// uploads there), then the call. `done` gets the answer, or a 503 when the PC is off.
pub fn forward(addr: String, name: String, method: &str, path: Vec<String>, mut body: Value, files: Vec<PathBuf>, sender: String, done: impl FnOnce(Reply) + Send + 'static) {
    let method = method.to_string();
    std::thread::spawn(move || {
        let off = || err(503, format!("{name} is off or unreachable: the chat is read-only until it's back"));
        let mut ids = vec![];
        for f in &files {
            let Ok(data) = std::fs::read(f) else { return done(err(400, format!("can't read {}", f.display()))) };
            let fname = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
            match http(&addr, "POST", &format!("/mesh/v1/upload?name={}", api::url_encode(&fname)), Some(("application/octet-stream", &data)), CALL_WAIT) {
                Ok((201, v)) => ids.push(v["id"].clone()),
                Ok((s, v)) => return done(Reply { status: s, body: v }),
                Err(_) => return done(off()),
            }
        }
        if !files.is_empty() {
            body["files"] = json!(ids);
        }
        let call = json!({ "method": method, "path": path, "body": body, "sender": sender });
        let data = serde_json::to_vec(&call).unwrap_or_default();
        match http(&addr, "POST", "/mesh/v1/call", Some(("application/json", &data)), CALL_WAIT) {
            Ok((status, body)) => done(Reply { status, body }),
            Err(_) => done(off()),
        }
    });
}

pub fn load_peers(s: &store::Store) -> HashMap<String, Peer> {
    s.get(PEERS_KEY).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

// ================================================================== the UI thread's side

impl App {
    fn shared(&self) -> &Shared {
        &self.api.hub.mesh
    }

    /// Settings › Devices' switch: share chats with the user's other PCs.
    pub fn mesh_set_enabled(&mut self, on: bool, ctx: &eframe::egui::Context) {
        self.store.set("mesh_enabled", if on { "1" } else { "0" });
        self.api.hub.mesh.on.store(on, Ordering::SeqCst);
        if on {
            let wake = {
                let ctx = ctx.clone();
                move || ctx.request_repaint()
            };
            api::start(self.api.hub.clone(), self.inc_tx.clone(), wake.clone());
            start(self.api.hub.clone(), self.inc_tx.clone(), wake);
            self.api_activated();
        }
    }

    /// A phone removed here: its tokens on the other PCs go too (now on those that answer,
    /// and on the others when they next say hello).
    pub fn mesh_revoke(&mut self, group: &str) {
        merge_revoked(&self.api.hub, &[group.to_string()]);
        let body = serde_json::to_vec(&json!({ "groups": [group] })).unwrap_or_default();
        for p in self.mesh_hosts().into_iter().filter(|p| p.online) {
            let body = body.clone();
            std::thread::spawn(move || {
                let _ = http(&p.addr, "POST", "/mesh/v1/revoke", Some(("application/json", &body)), Duration::from_secs(10));
            });
        }
    }

    /// At startup: what's known of the peers and of the copies here.
    pub fn mesh_load(&mut self) {
        *self.api.hub.revoked.lock().unwrap() = api::load_revoked(&self.store);
        let mut peers = load_peers(&self.store);
        for c in self.chats.iter().filter(|c| c.foreign()) {
            peers.entry(c.home.clone()).or_insert_with(|| Peer { id: c.home.clone(), name: label(&c.home), ..Default::default() });
        }
        for p in peers.values_mut() {
            p.online = false;
        }
        *self.shared().peers.lock().unwrap() = peers;
        self.mesh_index();
    }

    /// Rebuilds the copies' index (after chats came or went).
    fn mesh_index(&self) {
        let mut foreign = HashSet::new();
        let mut ids = HashMap::new();
        for c in self.chats.iter().filter(|c| c.foreign()) {
            foreign.insert(c.id);
            ids.insert((c.home.clone(), c.home_id), c.id);
        }
        *self.shared().foreign.lock().unwrap() = foreign;
        *self.shared().ids.lock().unwrap() = ids;
    }

    /// True when the chat is a copy of another PC's.
    pub fn is_foreign(&self, id: i64) -> bool {
        self.chat(id).is_some_and(|c| c.foreign())
    }

    /// A copy can be written while its home PC answers; this PC's own chats always.
    pub fn writable(&self, id: i64) -> bool {
        match self.chat(id) {
            Some(c) if c.foreign() => self.shared().online(&c.home),
            _ => true,
        }
    }

    /// The name of the PC a chat runs on (this PC's name for its own).
    pub fn home_name(&self, c: &Chat) -> String {
        if c.foreign() { self.shared().name_of(&c.home) } else { self.shared().me().name }
    }

    /// When a chat's turn started, here or on its home PC.
    pub fn running_since(&self, id: i64) -> Option<Instant> {
        if let Some((_, at)) = self.turns.get(&id) {
            return Some(*at);
        }
        let r = self.mesh.status.get(&id).filter(|r| r.running)?;
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let ago = (now_ms - r.since_ms.unwrap_or(now_ms)).max(0) as u64;
        Instant::now().checked_sub(Duration::from_millis(ago)).or(Some(Instant::now()))
    }

    pub fn is_running(&self, id: i64) -> bool {
        self.running_since(id).is_some()
    }

    /// A turn footer's "account · model · " for a chat: a copy's account is its home PC's.
    pub fn footer_who(&self, chat: i64, account: &str, model: &str) -> String {
        if let Some(c) = self.chat(chat).filter(|c| c.foreign()) {
            let Some(p) = self.shared().peer(&c.home) else { return String::new() };
            let Some((_, short, kind)) = p.accounts.iter().find(|(id, _, _)| id == account) else { return String::new() };
            let k = crate::providers::Kind::ALL.into_iter().find(|k| k.label().eq_ignore_ascii_case(kind)).unwrap_or(crate::providers::Kind::Claude);
            return format!("{short} · {} · ", self.model_label(k, model));
        }
        self.account(account).map(|a| format!("{} · {} · ", a.short(), self.model_label(a.kind, model))).unwrap_or_default()
    }

    /// Once per frame: copies written to disk now and then, the chat waiting to open.
    pub fn mesh_tick(&mut self) {
        if self.api.hub.tokens_dirty.swap(false, Ordering::SeqCst) {
            let all = self.api.hub.tokens.lock().unwrap().clone();
            api::save_tokens(&self.store, &all);
            let revoked = self.api.hub.revoked.lock().unwrap().clone();
            self.store.set("api_revoked", &serde_json::to_string(&revoked).unwrap_or_default());
        }
        let due: Vec<i64> = self.mesh.dirty.iter().filter(|(id, at)| at.elapsed() >= SAVE_EVERY || !self.is_running(**id)).map(|(id, _)| *id).collect();
        for id in due {
            self.mesh.dirty.remove(&id);
            if let Some(t) = self.transcripts.get(&id) {
                let items = t.items.clone();
                self.store.save_items(id, &items);
            }
        }
        if let Some((peer, hid, at)) = self.mesh.open_when.clone() {
            if let Some(id) = self.shared().local_id(&peer, hid) {
                self.mesh.open_when = None;
                self.open(crate::app::View::Chat(id));
            } else if at.elapsed() > Duration::from_secs(20) {
                self.mesh.open_when = None;
            }
        }
    }

    pub fn handle_mesh(&mut self, m: Msg) {
        match m {
            Msg::Peer => {
                let peers = self.shared().peers.lock().unwrap().clone();
                self.store.set(PEERS_KEY, &serde_json::to_string(&peers).unwrap_or_default());
                // Copies turn read-only or writable: phones see it in the state.
                let ids: Vec<i64> = self.chats.iter().filter(|c| c.foreign()).map(|c| c.id).collect();
                for id in ids {
                    self.api_touch(id);
                }
                self.api.hub.touch(None, true);
            }
            Msg::Chats { peer, epoch, body, reply } => {
                let wants = self.mesh_apply_chats(&peer, epoch, &body);
                let _ = reply.send(wants);
            }
            Msg::Items { peer, epoch, home_id, body } => self.mesh_apply_items(&peer, epoch, home_id, &body),
            Msg::Done { chat, what, reply, restore } => {
                if reply.status >= 300 {
                    let e = reply.body["error"].as_str().unwrap_or("it didn't work").to_string();
                    self.mesh.error = Some((chat, format!("Couldn't {what}: {e}"), Instant::now()));
                    if let Some(text) = restore.filter(|t| !t.is_empty()) {
                        let d = self.drafts.entry(chat).or_default();
                        if d.trim().is_empty() {
                            *d = text;
                        }
                    }
                } else if what == "start the chat" {
                    if let Some(hid) = reply.body["id"].as_i64() {
                        self.mesh.open_when = Some((reply.body["home"].as_str().unwrap_or("").to_string(), hid, Instant::now()));
                    }
                }
            }
        }
    }

    /// A peer's list of its chats: copies made or updated here, deleted ones removed.
    fn mesh_apply_chats(&mut self, peer: &str, epoch: u64, body: &Value) -> Vec<(i64, u64)> {
        let full = body["full"].as_bool().unwrap_or(false);
        let mut wants = vec![];
        let mut listed = HashSet::new();
        for m in body["chats"].as_array().into_iter().flatten() {
            let Some(hid) = m["id"].as_i64() else { continue };
            listed.insert(hid);
            let Some(local) = self.mesh_upsert(peer, m) else { continue };
            let since = self.mesh.isince.get(&(peer.to_string(), hid)).filter(|(e, _)| *e == epoch).map(|(_, r)| *r).unwrap_or(0);
            let need = if full {
                let digest = m["digest"].as_str().and_then(|d| u64::from_str_radix(d, 16).ok());
                let mine = match self.transcripts.get(&local) {
                    Some(t) => store::digest(&t.items),
                    None => store::digest(&self.store.items(local)),
                };
                digest != Some(mine)
            } else {
                true
            };
            if need {
                // A copy that differs after a restart of either side is fetched whole.
                wants.push((hid, if full && since == 0 { 0 } else { since }));
            }
        }
        let gone: Vec<i64> = if full {
            self.chats.iter().filter(|c| c.home == peer && !listed.contains(&c.home_id)).map(|c| c.id).collect()
        } else {
            body["gone"].as_array().into_iter().flatten().filter_map(|g| g.as_i64()).filter_map(|h| self.shared().local_id(peer, h)).collect()
        };
        for id in gone {
            self.mesh_drop(id);
        }
        self.mesh_index();
        wants
    }

    /// Removes a copy (its home PC deleted the chat).
    fn mesh_drop(&mut self, id: i64) {
        self.store.delete_chat(id);
        self.chats.retain(|c| c.id != id);
        self.transcripts.remove(&id);
        self.mesh.status.remove(&id);
        self.mesh.dirty.remove(&id);
        if self.view == crate::app::View::Chat(id) {
            self.view = crate::app::View::Draft;
        }
    }

    /// The project a copy goes in: this PC's with the same folder, else the same name, else
    /// a new entry for the home PC's folder.
    fn mesh_repo(&mut self, p: &Value) -> Option<i64> {
        let path = p["path"].as_str()?;
        let name = p["name"].as_str().unwrap_or("");
        if let Some(r) = self.repos.iter().find(|r| r.path.to_string_lossy() == path) {
            return Some(r.id);
        }
        if let Some(r) = self.repos.iter().find(|r| !name.is_empty() && r.name == name) {
            return Some(r.id);
        }
        let id = self.store.add_repo(std::path::Path::new(path)).ok()?;
        self.repos = self.store.repos();
        Some(id)
    }

    /// Makes or updates the copy of a peer's chat; its id here.
    fn mesh_upsert(&mut self, peer: &str, m: &Value) -> Option<i64> {
        let hid = m["id"].as_i64()?;
        let gid = m["gid"].as_str().unwrap_or("").to_string();
        let existing = self.shared().local_id(peer, hid).or_else(|| self.chats.iter().find(|c| !gid.is_empty() && c.gid == gid).map(|c| c.id));
        if let Some(c) = existing.and_then(|id| self.chat(id)) {
            if !c.foreign() {
                return None; // this PC's own chat, echoed back: never overwritten
            }
        }
        let repo = if m["project"].is_null() { None } else { self.mesh_repo(&m["project"]) };
        let parent = m["parent"].as_i64().and_then(|p| self.shared().local_id(peer, p));
        let s = |k: &str| m[k].as_str().unwrap_or("").to_string();
        let mut c = Chat {
            id: existing.unwrap_or(0),
            repo_id: repo,
            title: s("title"),
            session_id: String::new(),
            started: m["started"].as_bool().unwrap_or(false),
            account: s("account"),
            model: s("model"),
            effort: s("effort"),
            access: s("access"),
            settled: m["settled"].as_bool().unwrap_or(false),
            updated: m["updated"].as_i64().unwrap_or(0),
            role: Role::parse(m["role"].as_str().unwrap_or("chat")),
            parent,
            name: s("name"),
            device: s("device"),
            gid,
            home: peer.to_string(),
            home_id: hid,
        };
        let id = match existing {
            Some(id) => {
                if let Some(old) = self.chat_mut(id) {
                    *old = c.clone();
                }
                self.store.save_chat(&c);
                id
            }
            None => {
                c = self.store.create_chat(c);
                let id = c.id;
                self.chats.push(c);
                id
            }
        };
        self.shared().ids.lock().unwrap().insert((peer.to_string(), hid), id);
        self.shared().foreign.lock().unwrap().insert(id);
        let forks = m["forks"].as_array().into_iter().flatten().filter_map(|f| Some((f[0].as_u64()? as usize, self.shared().local_id(peer, f[1].as_i64()?)?))).collect();
        let mut status = m["status"].clone();
        // The waiting bar's agents are the home PC's chats: their ids here.
        if let Some(agents) = status["waiting"]["agents"].as_array_mut() {
            for a in agents {
                let local = a["id"].as_i64().and_then(|h| self.shared().local_id(peer, h)).unwrap_or(0);
                a["id"] = json!(local);
            }
        }
        self.mesh.status.insert(
            id,
            Remote { running: m["running"].as_bool().unwrap_or(false), since_ms: m["since_ms"].as_i64(), queued: m["queued"].as_u64().unwrap_or(0) as usize, status, forks },
        );
        self.api_touch(id);
        Some(id)
    }

    /// A peer's items for a copy: changed ones replaced, new ones added, the rest cut.
    fn mesh_apply_items(&mut self, peer: &str, epoch: u64, hid: i64, body: &Value) {
        let Some(id) = self.shared().local_id(peer, hid) else { return };
        if !self.transcripts.contains_key(&id) {
            let items = self.store.items(id);
            self.transcripts.insert(id, crate::app::Transcript { items, ..Default::default() });
        }
        let count = body["count"].as_u64().unwrap_or(0) as usize;
        let tr = self.transcripts.get_mut(&id).unwrap();
        tr.items.truncate(count);
        let mut whole = true;
        for e in body["items"].as_array().into_iter().flatten() {
            let (Some(seq), Ok(item)) = (e["seq"].as_u64().map(|s| s as usize), serde_json::from_value::<Item>(e["item"].clone())) else { continue };
            match seq.cmp(&tr.items.len()) {
                std::cmp::Ordering::Less => tr.items[seq] = item,
                std::cmp::Ordering::Equal => tr.items.push(item),
                std::cmp::Ordering::Greater => whole = false,
            }
        }
        whole &= tr.items.len() == count;
        let rev = if whole { body["rev"].as_u64().unwrap_or(0) } else { 0 };
        self.mesh.isince.insert((peer.to_string(), hid), (epoch, rev));
        self.mesh.dirty.entry(id).or_insert_with(Instant::now);
        self.api_touch(id);
    }

    // ---------------------------------------------------------------- serving peers

    /// A peer's call (`/mesh/v1/…` but events, uploads and tokens), on the UI thread.
    pub fn mesh_route(&mut self, call: &Call, ctx: &eframe::egui::Context) -> Reply {
        let p: Vec<&str> = call.path.iter().map(String::as_str).collect();
        let epoch = self.api.hub.epoch;
        let q = |k: &str| call.query.iter().find(|(x, _)| x == k).and_then(|(_, v)| v.parse::<u64>().ok()).unwrap_or(0);
        match (call.method.as_str(), p.as_slice()) {
            ("GET", ["mesh", "v1", "hello"]) => {
                let me = self.shared().me();
                let accounts: Vec<Value> = self.accounts.iter().filter(|a| a.installed()).map(|a| json!({ "id": a.id, "short": a.short(), "kind": a.kind.label().to_ascii_lowercase() })).collect();
                let revoked = self.api.hub.revoked.lock().unwrap().clone();
                ok(json!({ "id": me.id, "name": me.name, "version": crate::update::VERSION, "epoch": epoch, "accounts": accounts, "revoked": revoked }))
            }
            ("GET", ["mesh", "v1", "chats"]) => {
                let since = q("since");
                let full = since == 0 || q("epoch") != epoch;
                let rev = self.api.hub.rev();
                let mut own: Vec<Chat> = self.chats.iter().filter(|c| !c.foreign()).filter(|c| full || self.api.hub.chat_rev(c.id) > since).cloned().collect();
                // Leads before their subagents, so a copy's parent is there when it arrives.
                own.sort_by_key(|c| (c.role == Role::Sub, c.id));
                let chats: Vec<Value> = own.iter().map(|c| self.mesh_chat_json(c, full)).collect();
                let gone: Vec<i64> = if full { vec![] } else { self.shared().gone.lock().unwrap().iter().filter(|(r, _)| *r > since).map(|(_, id)| *id).collect() };
                ok(json!({ "epoch": epoch, "rev": rev, "full": full, "chats": chats, "gone": gone }))
            }
            ("GET", ["mesh", "v1", "chats", c, "items"]) => {
                let Some(c) = c.parse::<i64>().ok().filter(|c| self.chat(*c).is_some_and(|x| !x.foreign())) else { return err(404, "no such chat") };
                let since = if q("epoch") == epoch { q("since") } else { 0 };
                ok(self.mesh_items_json(c, since))
            }
            ("POST", ["mesh", "v1", "call"]) => {
                let inner = Call {
                    method: call.body["method"].as_str().unwrap_or("GET").to_string(),
                    path: call.body["path"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect(),
                    query: vec![],
                    body: call.body["body"].clone(),
                    token: String::new(),
                    device: String::new(),
                    reply: call.reply.clone(),
                };
                if inner.path.first().map(String::as_str) != Some("v1") {
                    return err(400, "not a call");
                }
                let sender: String = call.body["sender"].as_str().unwrap_or("").chars().take(60).collect();
                self.sender = if sender.is_empty() { self.shared().name_of(&call.device) } else { sender };
                self.mesh.in_call = true;
                let mut r = self.api_route(&inner, ctx);
                self.mesh.in_call = false;
                self.sender.clear();
                // A new chat: the caller waits for its copy by this PC's id.
                if r.status < 300 && r.body["id"].is_i64() {
                    r.body["home"] = json!(self.shared().me().id);
                }
                r
            }
            _ => err(404, "unknown mesh call"),
        }
    }

    /// One of this PC's chats as peers copy it.
    fn mesh_chat_json(&mut self, c: &Chat, digest: bool) -> Value {
        let project = c.repo_id.and_then(|r| self.repo(r)).map(|r| json!({ "name": r.name, "path": r.path.to_string_lossy() }));
        let (count, digest) = if digest {
            let rev = self.api.hub.chat_rev(c.id);
            let cached = self.mesh.digests.get(&c.id).filter(|(r, _)| *r == rev && rev != 0).map(|(_, d)| *d);
            let (n, d) = match (cached, self.transcripts.get(&c.id)) {
                (_, Some(t)) => (t.items.len(), store::digest(&t.items)),
                (Some(d), None) => (self.store.items(c.id).len(), d),
                (None, None) => {
                    let items = self.store.items(c.id);
                    (items.len(), store::digest(&items))
                }
            };
            self.mesh.digests.insert(c.id, (rev, d));
            (n, json!(format!("{d:016x}")))
        } else {
            (self.transcripts.get(&c.id).map_or(0, |t| t.items.len()), Value::Null)
        };
        let since_ms = self.turns.get(&c.id).map(|(_, at)| {
            let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            now_ms - at.elapsed().as_millis() as i64
        });
        let forks: Vec<Value> = self.forks_of(c.id).into_iter().map(|(seq, f)| json!([seq, f])).collect();
        json!({
            "id": c.id, "gid": c.gid, "title": c.title, "project": project, "account": c.account, "model": c.model,
            "effort": c.effort, "access": c.access, "device": c.device, "settled": c.settled, "updated": c.updated,
            "role": c.role.as_str(), "parent": c.parent, "name": c.name, "started": c.started,
            "count": count, "digest": digest,
            "running": self.turns.contains_key(&c.id), "since_ms": since_ms, "queued": self.queued_count(c.id),
            "status": self.api_status(c.id), "forks": forks,
        })
    }

    /// One of this PC's chats' items changed after `since` (all for 0), raw, by seq.
    fn mesh_items_json(&mut self, chat: i64, since: u64) -> Value {
        if !self.transcripts.contains_key(&chat) {
            let items = self.store.items(chat);
            self.transcripts.insert(chat, crate::app::Transcript { items, ..Default::default() });
        }
        let items = &self.transcripts[&chat].items;
        let now = self.api.hub.chat_rev(chat);
        let revs = self.mesh.items.entry(chat).or_default();
        let fresh = self.mesh.looked.get(&chat) == Some(&now) && revs.len() == items.len() && now != 0;
        if !fresh {
            self.mesh.looked.insert(chat, now);
            let fps: Vec<u64> = items.iter().map(api::fingerprint).collect();
            revs.truncate(fps.len());
            if fps.iter().enumerate().any(|(i, f)| revs.get(i).is_none_or(|(old, _)| old != f)) {
                let rev = self.api.hub.bump();
                for (i, f) in fps.iter().enumerate() {
                    match revs.get_mut(i) {
                        Some(r) if r.0 == *f => {}
                        Some(r) => *r = (*f, rev),
                        None => revs.push((*f, rev)),
                    }
                }
            }
        }
        let out: Vec<Value> = items.iter().enumerate().filter(|(i, _)| since == 0 || revs[*i].1 > since).map(|(i, it)| json!({ "seq": i, "item": it })).collect();
        json!({ "epoch": self.api.hub.epoch, "rev": self.api.hub.rev(), "count": items.len(), "items": out })
    }

    /// One of this PC's chats was deleted: peers drop their copies.
    pub fn mesh_gone(&self, id: i64) {
        let rev = self.api.hub.touch(None, true);
        let mut g = self.shared().gone.lock().unwrap();
        g.push((rev, id));
        if g.len() > 1000 {
            g.remove(0);
        }
    }

    // ---------------------------------------------------------------- forwarding

    /// Forwards a call about a copy to its home PC. False for this PC's own chats.
    fn mesh_forward(&mut self, chat: i64, what: &'static str, method: &str, tail: &[&str], body: Value, files: Vec<PathBuf>, restore: Option<String>) -> bool {
        let Some(c) = self.chat(chat).filter(|c| c.foreign()).cloned() else { return false };
        let peer = self.shared().peer(&c.home).unwrap_or_default();
        let name = self.shared().name_of(&c.home);
        if !peer.online {
            self.mesh.error = Some((chat, format!("Couldn't {what}: {name} is off, so this chat is read-only until it's back"), Instant::now()));
            if let Some(text) = restore.filter(|t| !t.is_empty()) {
                self.drafts.entry(chat).or_default().push_str(&text);
            }
            return true;
        }
        let mut path = vec!["v1".to_string(), "chats".to_string(), c.home_id.to_string()];
        path.extend(tail.iter().map(|s| s.to_string()));
        let tx = self.inc_tx.clone();
        forward(peer.addr, name, method, path, body, files, self.shared().me().name, move |reply| {
            let _ = tx.send(crate::control::Incoming::Mesh(Msg::Done { chat, what, reply, restore }));
        });
        true
    }

    /// The desktop's message for a copy goes to its home PC. False for own chats.
    pub fn mesh_send(&mut self, chat: i64, text: &str, files: &[PathBuf], mentions: &[crate::mentions::Mention]) -> bool {
        let body = json!({ "text": text, "mentions": mentions });
        self.mesh_forward(chat, "send", "POST", &["send"], body, files.to_vec(), Some(text.to_string()))
    }

    pub fn mesh_stop(&mut self, chat: i64) -> bool {
        self.mesh_forward(chat, "stop", "POST", &["stop"], Value::Null, vec![], None)
    }

    pub fn mesh_patch(&mut self, chat: i64, body: Value) -> bool {
        self.mesh_forward(chat, "change the chat", "PATCH", &[], body, vec![], None)
    }

    pub fn mesh_delete(&mut self, chat: i64) -> bool {
        self.mesh_forward(chat, "delete the chat", "DELETE", &[], Value::Null, vec![], None)
    }

    /// Mesh peers that can take a new chat now (they run Harbor and answer).
    pub fn mesh_hosts(&self) -> Vec<Peer> {
        let mut v: Vec<Peer> = self.shared().peers.lock().unwrap().values().cloned().collect();
        v.sort_by(|a, b| b.online.cmp(&a.online).then(a.name.cmp(&b.name)));
        v
    }

    /// The draft's first message starts a chat on another PC's Harbor (the Device picked is
    /// a peer). False when the device isn't one.
    pub fn mesh_create(&mut self, text: &str, files: &[PathBuf]) -> bool {
        let sel = self.draft.sel.clone();
        let Some(peer) = self.shared().peer(&sel.device) else { return false };
        let restore = Some(text.to_string());
        if !peer.online {
            self.mesh.error = Some((crate::app::DRAFT, format!("{} is off: pick a PC that's on", peer.name), Instant::now()));
            self.drafts.entry(crate::app::DRAFT).or_default().push_str(text);
            return true;
        }
        let project = self.draft.repo.and_then(|r| self.repo(r)).map(|r| json!({ "name": r.name, "path": r.path.to_string_lossy() }));
        let body = json!({
            "project": project, "account": sel.account, "model": sel.model, "effort": sel.effort, "access": sel.access,
            "device": "", "text": text,
        });
        let tx = self.inc_tx.clone();
        forward(peer.addr, peer.name, "POST", vec!["v1".into(), "chats".into()], body, files.to_vec(), self.shared().me().name, move |reply| {
            let _ = tx.send(crate::control::Incoming::Mesh(Msg::Done { chat: crate::app::DRAFT, what: "start the chat", reply, restore }));
        });
        true
    }

    // ---------------------------------------------------------------- phones through this PC

    /// A phone's call about a copy (or a new chat on another PC): forwarded to that PC on a
    /// thread, answered from there. Gives the call back when it's for this PC.
    pub fn mesh_proxy(&mut self, call: Call) -> Option<Call> {
        if self.mesh.in_call || !self.api.hub.mesh.on.load(Ordering::Relaxed) {
            return Some(call);
        }
        let p: Vec<&str> = call.path.iter().map(String::as_str).collect();
        let mutating = matches!(call.method.as_str(), "POST" | "PATCH" | "DELETE");
        // A new chat on a peer's Harbor.
        if call.method == "POST" && p == ["v1", "chats"] {
            let device = call.body["device"].as_str().unwrap_or("").to_string();
            let Some(peer) = self.shared().peer(&device) else { return Some(call) };
            if !peer.online {
                let _ = call.reply.send(err(409, format!("{} is off: pick a PC that's on", peer.name)));
                return None;
            }
            let mut body = call.body.clone();
            body["device"] = json!("");
            body["project"] = call.body["project_id"].as_i64().and_then(|r| self.repo(r)).map(|r| json!({ "name": r.name, "path": r.path.to_string_lossy() })).unwrap_or(Value::Null);
            if let Some(o) = body.as_object_mut() {
                o.remove("project_id");
            }
            let files = files_of(&body);
            let sender = self.phone_name(&call);
            let shared = self.api.hub.clone();
            let reply = call.reply.clone();
            let home = peer.id.clone();
            forward(peer.addr, peer.name, "POST", vec!["v1".into(), "chats".into()], strip_files(body), files, sender, move |r| {
                let _ = reply.send(map_new(&shared, &home, r));
            });
            return None;
        }
        if !mutating || p.len() < 3 || p[0] != "v1" || p[1] != "chats" {
            return Some(call);
        }
        let Some(c) = self.chat_by_ref(p[2]).filter(|c| c.foreign()).cloned() else { return Some(call) };
        if p.get(3) == Some(&"typing") {
            return Some(call);
        }
        let peer = self.shared().peer(&c.home).unwrap_or_default();
        let name = self.shared().name_of(&c.home);
        if !peer.online {
            let _ = call.reply.send(err(409, format!("{name} is off: this chat is read-only until it's back")));
            return None;
        }
        let mut path = vec!["v1".to_string(), "chats".to_string(), c.home_id.to_string()];
        path.extend(p[3..].iter().map(|s| s.to_string()));
        let files = files_of(&call.body);
        let sender = self.phone_name(&call);
        let shared = self.api.hub.clone();
        let reply = call.reply.clone();
        let home = c.home.clone();
        let (local, repo, parent, gid) = (c.id, c.repo_id, c.parent, c.gid.clone());
        let fork = p.get(3) == Some(&"fork");
        forward(peer.addr, name, &call.method, path, strip_files(call.body.clone()), files, sender, move |mut r| {
            if fork {
                r = map_new(&shared, &home, r);
            }
            // The chat as the home PC answers it, with this PC's ids.
            if let Some(ch) = r.body.get_mut("chat").filter(|c| c.is_object()) {
                ch["id"] = json!(local);
                ch["project_id"] = json!(repo);
                ch["parent"] = json!(parent);
                ch["gid"] = json!(gid);
            }
            // Messages handed back: their files are the home PC's uploads, not this one's.
            if let Some(ret) = r.body.get_mut("returned").and_then(|v| v.as_array_mut()) {
                for q in ret {
                    q["files"] = json!([]);
                }
            }
            let _ = reply.send(r);
        });
        None
    }

    fn phone_name(&self, call: &Call) -> String {
        let me = self.shared().me().name;
        let phone = if call.device.is_empty() { "Phone".to_string() } else { call.device.clone() };
        format!("{phone} via {me}")
    }

    /// A chat by the phone's reference: its id here or its global id.
    pub fn chat_by_ref(&self, r: &str) -> Option<&Chat> {
        match r.parse::<i64>() {
            Ok(id) => self.chat(id),
            Err(_) => self.chats.iter().find(|c| c.gid == r),
        }
    }
}

// ================================================================== window

impl App {
    /// Above the composer: a forwarded call that failed, and for another PC's chat where it
    /// runs. True when the chat is read-only now (its PC is off): that note replaces the composer.
    pub fn mesh_composer(&mut self, ui: &mut eframe::egui::Ui) -> bool {
        use crate::widgets as w;
        use eframe::egui::{CornerRadius, Frame, Margin, Stroke};
        let key = self.key();
        if let Some((chat, text, at)) = self.mesh.error.clone() {
            if chat == key && at.elapsed() < Duration::from_secs(12) {
                ui.horizontal(|ui| {
                    ui.add_space(6.0);
                    ui.label(eframe::egui::RichText::new(format!("{}  {text}", crate::icons::ALERT)).text_style(crate::theme::ts("label-12")).color(self.theme.t.red(900)));
                });
                ui.add_space(4.0);
                ui.ctx().request_repaint_after(Duration::from_secs(12).saturating_sub(at.elapsed()));
            } else if at.elapsed() >= Duration::from_secs(12) {
                self.mesh.error = None;
            }
        }
        let crate::app::View::Chat(id) = self.view else { return false };
        let Some(c) = self.chat(id).filter(|c| c.foreign()).cloned() else { return false };
        let name = self.home_name(&c);
        if self.writable(id) {
            ui.horizontal(|ui| {
                ui.add_space(6.0);
                w::subtle(ui, format!("{}  Runs on {name}", crate::icons::MONITOR), "label-12");
            });
            ui.add_space(4.0);
            return false;
        }
        let t = self.theme.t;
        Frame::new()
            .fill(t.bg200)
            .stroke(Stroke::new(1.0, t.border()))
            .corner_radius(CornerRadius::same(16))
            .inner_margin(Margin::same(16))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                w::subtle(ui, format!("{}  {name} is off. This chat runs there, so it's read-only until {name} is back; then it catches up.", crate::icons::MONITOR), "label-14");
            });
        true
    }

    /// Settings › Devices: sharing chats with the user's other PCs, and how each one is.
    pub fn mesh_settings(&mut self, ui: &mut eframe::egui::Ui) {
        use crate::pages::{rows, section};
        use crate::widgets::{self as w, Tone};
        let ctx = ui.ctx().clone();
        section(ui, "Your PCs");
        let mut on = self.api.hub.mesh.on.load(Ordering::Relaxed);
        let was = on;
        let me = self.shared().me();
        let peers = self.mesh_hosts();
        rows(ui, |ui| {
            w::setting_row(
                ui,
                "Share chats with my other PCs",
                "Every PC with Harbor and this on keeps a copy of every chat and can write in any of them; the agent runs on the PC the chat was started on. Your phone keeps working through any PC that's on. Only your own devices on Tailscale (same Tailscale account) are let in.",
                |ui| w::toggle(ui, &mut on),
            );
            if on {
                for p in &peers {
                    w::separator(ui);
                    let (badge, tone) = if p.online { ("On", Tone::Green) } else { ("Off", Tone::Gray) };
                    let mut desc = if p.online { format!("Harbor {}", p.version) } else if p.seen > 0 { format!("Last seen {} ago", crate::app::ago(p.seen)) } else { "Not seen yet".into() };
                    let copies = self.chats.iter().filter(|c| c.home == p.id).count();
                    if copies > 0 {
                        desc.push_str(&format!(" · {copies} chats copied here"));
                    }
                    w::setting_row(ui, &format!("{}  {}", crate::icons::MONITOR, p.name), &desc, |ui| {
                        w::badge(ui, badge, tone);
                    });
                }
                if peers.is_empty() {
                    w::separator(ui);
                    w::setting_row(ui, "No other PCs yet", &format!("Turn this on in Harbor on your other PCs (same Tailscale account). This PC is {}.", me.name), |_| {});
                }
            }
        });
        if on != was {
            self.mesh_set_enabled(on, &ctx);
        }
        ui.add_space(12.0);
    }
}

/// The upload files of a phone's body, as files here.
fn files_of(body: &Value) -> Vec<PathBuf> {
    body["files"].as_array().into_iter().flatten().filter_map(|f| api::resolve_upload(f.as_str()?)).collect()
}

fn strip_files(mut body: Value) -> Value {
    if let Some(o) = body.as_object_mut() {
        o.remove("files");
    }
    body
}

/// A chat made on another PC: its id there becomes the copy's id here once it arrives.
fn map_new(hub: &api::Hub, home: &str, mut r: Reply) -> Reply {
    let Some(hid) = r.body["id"].as_i64().filter(|_| r.status < 300) else { return r };
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if let Some(id) = hub.mesh.local_id(home, hid) {
            r.body["id"] = json!(id);
            return r;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // Not copied yet: the phone finds it in the next state by its gid.
    r.body["id"] = Value::Null;
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_from_tailscale() {
        let v = json!({ "Self": { "DNSName": "desk.example.ts.net.", "UserID": 42 } });
        let (me, user) = parse_me(&v);
        assert_eq!(me, Me { id: "ts:desk".into(), name: "desk".into() });
        assert_eq!(user, Some(42));
        assert_eq!(parse_me(&json!({})).0, Me::default());
    }

    #[test]
    fn only_the_users_own_devices() {
        let mine = json!({ "Node": { "Name": "laptop.example.ts.net." }, "UserProfile": { "ID": 42 } });
        let theirs = json!({ "Node": { "Name": "other.example.ts.net." }, "UserProfile": { "ID": 7 } });
        assert_eq!(parse_whois(&mine, 42).as_deref(), Some("ts:laptop"));
        assert_eq!(parse_whois(&theirs, 42), None);
        assert_eq!(parse_whois(&json!({}), 42), None);
    }

    #[test]
    fn labels() {
        assert_eq!(label("ts:desk"), "desk");
        assert_eq!(label("desk"), "desk");
    }
}
