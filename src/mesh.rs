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
//! - **Transport.** The phone API's listener (port 47930) serves `/mesh/v1/…` too, over mutual
//!   TLS with pinned keys (tls.rs). A PC is let in when the fingerprint of its key is on the
//!   allowed list (kv `mesh_allowed`, Settings › Devices or `harbor mesh allow`), and each PC
//!   only follows peers on its own list: a link needs both sides to allow each other. Two PCs
//!   get onto each other's lists with a one-time pairing code (shown on one, typed on the
//!   other: `/mesh/v1/pair`). No tokens are involved.
//! - **Addresses.** A peer is known by its key, not where it is: it says its addresses in
//!   `hello`, PCs that call in leave theirs, and Tailscale's peer list is one more source while
//!   it's installed. Each is tried until one answers with the right key.
//! - **Upgrading from Tailscale (before 0.13).** PCs allowed by Tailscale node ID still get in
//!   over plain HTTP on the tailnet (WireGuard vouches for them, `tailscale whois` names them)
//!   until they swap keys: `POST /mesh/v1/enroll` sends this PC's fingerprint and answers with
//!   the peer's, both are written into the allowed entries, and from then on it's TLS only.
//!   (For tests with several instances on one PC: `HARBOR_MESH_LOOPBACK=1` also accepts plain
//!   127.0.0.1, `HARBOR_MESH_PEERS=host:port,…` adds addresses to try, and
//!   `HARBOR_MESH_ID`/`HARBOR_MESH_NAME` set this instance's identity.)
//!
//! Settings stay local to each PC and never travel. The wire format is in android/PROTOCOL.md.

use crate::widgets::Tip as _;
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
/// Largest side of an image of another PC's chat as this PC fetches it to draw (`home_image`).
pub const REMOTE_IMAGE_PX: u32 = 2048;
/// How long a pairing code is good for.
pub const CODE_TTL: i64 = 600;
/// Wrong guesses a pairing code takes before it's void.
const CODE_TRIES: i64 = 5;
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
    /// Its Tailscale node ID ("" for peers given by hand).
    #[serde(default)]
    pub node: String,
    /// Its phone access is on (Settings › Phones there): phones can fail over to it.
    #[serde(default)]
    pub phones: bool,
    /// The fingerprint of its key ("" for a peer still on plain HTTP over Tailscale, or a test's).
    #[serde(default)]
    pub fp: String,
    /// Every address it says it has ("host:port").
    #[serde(default)]
    pub addrs: Vec<String>,
    /// Reached through another PC (relay.rs), when it doesn't answer directly.
    #[serde(skip)]
    pub via: Option<Box<Dest>>,
    /// Its owner and GitHub login, as it says (meshctx.rs; empty before 0.44).
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub github: String,
    /// …and they are its own detection, not confirmed there yet (profile.rs; from 0.47).
    #[serde(default)]
    pub owner_suggested: bool,
    /// Its Harbor's version and updates (`update::info` there; null before 0.51).
    #[serde(skip)]
    pub update: Value,
    /// It takes chats moved from other PCs (movepc.rs; hello `moves`, false before it).
    #[serde(skip)]
    pub moves: bool,
}

impl Peer {
    pub fn dest(&self) -> Dest {
        Dest { addr: self.addr.clone(), fp: self.fp.clone(), via: self.via.clone() }
    }
}

/// Where a request goes: an address, and the key that must answer there ("" = plain HTTP,
/// only to 127.0.0.1 or a Tailscale address); `via`: through that PC (relay.rs), `addr` then
/// only gives the port.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Dest {
    pub addr: String,
    pub fp: String,
    pub via: Option<Box<Dest>>,
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
    /// Every chat here → its gid (phones' events name chats by gid).
    pub gids: Mutex<HashMap<i64, String>>,
    /// Copies → (home PC, id there).
    pub homes: Mutex<HashMap<i64, (String, i64)>>,
    /// Peer address → (when asked, the Tailscale node there).
    whois: Mutex<HashMap<IpAddr, (Instant, Option<Node>)>>,
    /// This PC's Tailscale node (its stable ID, user and tags), once read.
    pub node: Mutex<Option<Node>>,
    /// Nodes the user allowed (Settings › Devices, kv `mesh_allowed`).
    pub allowed: Mutex<Vec<Allowed>>,
    /// Harbors met that aren't linked (yet), by fingerprint or node: for Settings › Devices.
    pub seen: Mutex<HashMap<String, Seen>>,
    /// Addresses learned for allowed keys (calls from them, `HARBOR_MESH_PEERS`, Tailscale).
    pub hints: Mutex<HashMap<String, Vec<String>>>,
    /// Why a peer (by id) doesn't answer: `Down::Harbor` (its PC refused the connection, so
    /// Harbor isn't running there) or `Down::Pc` (no answer at all: off, asleep, out of reach).
    pub down: Mutex<HashMap<String, Down>>,
    /// This PC's `{owner, github}` (meshctx.rs), refreshed by the UI thread.
    pub about: Mutex<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Down {
    Harbor,
    Pc,
}

impl Down {
    /// On the wire (`/v1/hubs`, Devices): "harbor" or "pc".
    pub fn slug(self) -> &'static str {
        match self {
            Down::Harbor => "harbor",
            Down::Pc => "pc",
        }
    }

    /// From the errors of trying each address: one refused means the PC is up without Harbor.
    pub fn of(errors: &[String]) -> Down {
        if errors.iter().any(|e| e.contains("refused") || e.contains("os error 111")) { Down::Harbor } else { Down::Pc }
    }
}

impl Shared {
    pub fn down_of(&self, id: &str) -> Option<Down> {
        self.down.lock().unwrap().get(id).copied()
    }
}

/// A Tailscale node: its stable ID (`nXXXX…CNTRL`), MagicDNS label, user and whether it's tagged.
#[derive(Clone, Default, Debug, PartialEq)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub user: Option<i64>,
    pub tagged: bool,
}

/// A PC the user allowed to share chats with this PC: by the fingerprint of its key, or (allowed
/// before 0.13, until it upgrades) by its Tailscale node ID.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Allowed {
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub fp: String,
    /// Its peer id (as its `hello` says), once known.
    #[serde(default)]
    pub id: String,
    /// Where it was last reachable ("host:port"), so it's found again after a restart.
    #[serde(default)]
    pub addrs: Vec<String>,
}

impl Allowed {
    /// The key Settings and the CLI know it by.
    pub fn key(&self) -> &str {
        if !self.fp.is_empty() { &self.fp } else { &self.node }
    }
}

/// The id a peer allowed by key goes by here: its own when known.
pub fn peer_id(a: &Allowed) -> String {
    if !a.id.is_empty() {
        a.id.clone()
    } else {
        format!("fp:{}", &a.fp[..a.fp.len().min(16)])
    }
}

/// A Harbor met that isn't linked: it asked to link, or answered that it doesn't allow this PC (yet).
#[derive(Clone, Default, Debug)]
pub struct Seen {
    pub node: String,
    /// The fingerprint of its key, when it came over TLS.
    pub fp: String,
    pub name: String,
    /// Unix time it last asked this PC (and was refused: not allowed here).
    pub asked: i64,
    /// It answers, but hasn't allowed this PC.
    pub refuses: bool,
}

/// Whether node `n` may share chats with this PC (`me`): allowed by the user, or an untagged node
/// of the same Tailscale user as an untagged `me`.
pub fn admit(me: Option<&Node>, n: &Node, allowed: &[Allowed]) -> bool {
    if n.id.is_empty() {
        return false;
    }
    allowed.iter().any(|a| a.node == n.id) || me.is_some_and(|me| !me.tagged && !n.tagged && me.user.is_some() && me.user == n.user)
}

pub fn load_allowed(s: &store::Store) -> Vec<Allowed> {
    s.get("mesh_allowed").and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Changes the allowed list: kv `mesh_allowed` is the truth (`harbor mesh` on a terminal writes
/// it too), so it's read, changed and written back, and the copy in memory follows.
pub fn update_allowed(shared: &Shared, f: impl FnOnce(&mut Vec<Allowed>)) {
    let mut mem = shared.allowed.lock().unwrap();
    // (Unit tests keep it in memory: never the real database.)
    let store = if cfg!(test) { None } else { store::Store::open().ok() };
    let mut list = store.as_ref().map(load_allowed).unwrap_or_else(|| mem.clone());
    f(&mut list);
    if let Some(s) = &store {
        s.set("mesh_allowed", &serde_json::to_string(&list).unwrap_or_default());
    }
    *mem = list;
}

/// Addresses as given by a peer: valid "host:port"s only, at most 12.
fn clean_addrs<'a>(v: impl IntoIterator<Item = &'a Value>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for a in v.into_iter().filter_map(|a| a.as_str()) {
        if let Ok(sa) = a.parse::<std::net::SocketAddr>() {
            let sa = std::net::SocketAddr::new(crate::tls::canonical(sa.ip()), sa.port());
            if !sa.ip().is_unspecified() && !sa.ip().is_multicast() && !out.contains(&sa.to_string()) {
                out.push(sa.to_string());
            }
        }
        if out.len() >= 12 {
            break;
        }
    }
    out
}

/// This PC's addresses as peers should try them ("host:port"): its network's, the port its router
/// maps for the internet, IPv6, Tailscale's.
pub fn my_addrs(port: u16) -> Vec<String> {
    api::phone_addrs(port)
        .into_iter()
        .map(|a| match a.parse::<std::net::IpAddr>() {
            Ok(ip) => crate::tls::host_port(ip, port),
            Err(_) => a,
        })
        .collect()
}

impl Shared {
    pub fn admits(&self, n: &Node) -> bool {
        admit(self.node.lock().unwrap().as_ref(), n, &self.allowed.lock().unwrap())
    }

    /// The allowed entry of a key.
    pub fn allowed_fp(&self, fp: &str) -> Option<Allowed> {
        if fp.is_empty() {
            return None;
        }
        self.allowed.lock().unwrap().iter().find(|a| a.fp == fp).cloned()
    }

    /// The allowed entry of a Tailscale node that already has a key on file (then plain is over).
    fn upgraded(&self, node: &str) -> Option<Allowed> {
        self.allowed.lock().unwrap().iter().find(|a| a.node == node && !a.fp.is_empty()).cloned()
    }

    /// One more address to try for a key.
    pub fn hint(&self, fp: &str, addr: String) {
        let mut h = self.hints.lock().unwrap();
        let v = h.entry(fp.to_string()).or_default();
        if !v.contains(&addr) {
            v.insert(0, addr);
            v.truncate(8);
        }
    }

    /// Where a key may answer: where it last did, what it said, what was learned. Deduplicated.
    pub fn addrs_of_fp(&self, fp: &str) -> Vec<String> {
        let mut v: Vec<String> = vec![];
        if let Some(p) = self.peers.lock().unwrap().values().find(|p| p.fp == fp) {
            v.push(p.addr.clone());
            v.extend(p.addrs.iter().cloned());
        }
        if let Some(a) = self.allowed_fp(fp) {
            v.extend(a.addrs);
        }
        v.extend(self.hints.lock().unwrap().get(fp).cloned().unwrap_or_default());
        let mut out: Vec<String> = vec![];
        for a in v {
            if !a.is_empty() && !out.contains(&a) {
                out.push(a);
            }
        }
        // The network the PCs share first; Tailscale's addresses (while it's there) after them.
        out.sort_by_key(|a| a.parse::<std::net::SocketAddr>().is_ok_and(|s| crate::tls::tailnet_ip(s.ip())));
        out
    }

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

    /// A chat here by its gid.
    pub fn by_gid(&self, gid: &str) -> Option<i64> {
        self.gids.lock().unwrap().iter().find(|(_, g)| *g == gid).map(|(id, _)| *id)
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
    /// Meanwhile: the calling PC (id, name) and the `ctx` it sent (meshctx.rs).
    pub call_ctx: Option<(String, String, Value)>,
    /// Settings › Devices: the PC whose "its chats may" menu is open, and where.
    pub share_menu: Option<(String, eframe::egui::Rect)>,
    /// Settings › Devices › Update: peer id → (the version it ran, when asked).
    pub updating: HashMap<String, (String, Instant)>,
    /// Leases sent for copies: (chat, viewing) → (on, kind, when), to send renewals sparingly.
    leases: HashMap<(i64, bool), (bool, String, u64, Instant)>,
    /// The chat this PC last said it has open: (chat, focused, when).
    viewing: Option<(i64, bool, Instant)>,
    /// When kv `mesh_allowed`/`mesh_enabled` were last read (they may change from a terminal).
    reread: Option<Instant>,
    /// Settings › Devices' pairing.
    pub pair: PairUi,
}

/// Pairing in Settings › Devices: the code shown here, or a code typed for another PC.
#[derive(Default)]
pub struct PairUi {
    pub shown: Option<PairCode>,
    polled: Option<Instant>,
    pub addr: String,
    pub code: String,
    /// The typed code's outcome, from its thread.
    pub result: Arc<Mutex<Option<Result<String, String>>>>,
    pub busy: Arc<AtomicBool>,
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
    /// Who types in it and which PCs have it open, as its home PC keeps them.
    pub typing: Vec<api::Typer>,
    pub viewing: Vec<api::Typer>,
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

/// The output of `tailscale status --json`, when Tailscale is installed (it's optional: an
/// extra source of addresses, and how PCs allowed before 0.13 are recognised until they upgrade).
pub fn tailscale_status() -> Option<Value> {
    crate::providers::which("tailscale")?;
    let out = std::process::Command::new("tailscale").args(["status", "--json"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().ok()?;
    serde_json::from_slice::<Value>(&out.stdout).ok()
}

/// This PC's peer id and name (env overrides for tests). The id is kept in kv `mesh_id` the first
/// time: chats copied to other PCs name their home by it, so it never changes, with or without
/// Tailscale (PCs that had it keep "ts:<name>").
pub fn read_me() -> (Me, Option<Node>) {
    let v = tailscale_status().unwrap_or_default();
    let (mut me, node) = parse_me(&v);
    let store = store::Store::open().ok();
    match std::env::var("HARBOR_MESH_ID") {
        Ok(id) => me.id = id,
        Err(_) => match store.as_ref().and_then(|s| s.get("mesh_id")).filter(|i| !i.is_empty()) {
            Some(id) => me.id = id,
            None => {
                if me.id.is_empty() {
                    me.id = format!("pc:{}", crate::remote::hostname());
                }
                if let Some(s) = &store {
                    s.set("mesh_id", &me.id);
                }
            }
        },
    }
    me.name = std::env::var("HARBOR_MESH_NAME").unwrap_or_else(|_| label(&me.id));
    *HELLO.lock().unwrap() = (me.id.clone(), me.name.clone());
    (me, node)
}

/// Who this PC says it is on its requests to peers (for their Settings when they don't know it).
static HELLO: std::sync::LazyLock<Mutex<(String, String)>> = std::sync::LazyLock::new(Default::default);

pub fn parse_me(v: &Value) -> (Me, Option<Node>) {
    let s = &v["Self"];
    let dns = s["DNSName"].as_str().unwrap_or("");
    let l = dns.split('.').next().unwrap_or("");
    let me = if l.is_empty() { Me::default() } else { Me { id: format!("ts:{l}"), name: l.to_string() } };
    let node = s["ID"].as_str().filter(|i| !i.is_empty()).map(|id| Node {
        id: id.to_string(),
        label: l.to_string(),
        user: s["UserID"].as_i64(),
        tagged: s["Tags"].as_array().is_some_and(|t| !t.is_empty()),
    });
    (me, node)
}

/// `tailscale whois --json <ip>`: the node at that address.
pub fn parse_whois(v: &Value) -> Option<Node> {
    let n = &v["Node"];
    let id = n["StableID"].as_str().filter(|i| !i.is_empty())?;
    let label = n["Name"].as_str().unwrap_or("").split('.').next().unwrap_or("").to_string();
    let tagged = n["Tags"].as_array().is_some_and(|t| !t.is_empty());
    Some(Node { id: id.to_string(), label, user: v["UserProfile"]["ID"].as_i64().or(n["User"].as_i64()), tagged })
}

/// A peer in `tailscale status --json`: its node.
pub fn status_node(p: &Value) -> Option<Node> {
    let id = p["ID"].as_str().filter(|i| !i.is_empty())?;
    let label = p["DNSName"].as_str().unwrap_or("").split('.').next().unwrap_or("").to_string();
    Some(Node { id: id.to_string(), label, user: p["UserID"].as_i64(), tagged: p["Tags"].as_array().is_some_and(|t| !t.is_empty()) })
}

/// Who is calling: Ok((its peer id, its Tailscale node on the legacy path)) when it may share
/// chats with this PC; Err when not (it's remembered as asking, for Settings).
/// A PC of the mesh this one admits (as `/mesh/…` calls are), with sharing on.
pub fn admitted(hub: &api::Hub, p: &api::Peer, req: &api::Request) -> bool {
    hub.mesh.on.load(Ordering::SeqCst) && who(&hub.mesh, p, req).is_ok()
}

fn who(shared: &Shared, p: &api::Peer, req: &api::Request) -> Result<(String, Option<Node>), ()> {
    let says = |k: &str| req.header(k).unwrap_or("").chars().take(60).collect::<String>();
    match &p.via {
        api::Via::Loopback => {
            if std::env::var("HARBOR_MESH_LOOPBACK").as_deref() == Ok("1") {
                // (Test instances: who they say they are, so each has its own id as over TLS.)
                let id = says("x-harbor-id");
                Ok((if id.is_empty() { "loopback".to_string() } else { id }, None))
            } else {
                Err(())
            }
        }
        api::Via::Tls(Some(fp)) => {
            if let Some(a) = shared.allowed_fp(fp) {
                // It's here: one more place to find it (at the port it's known to listen on).
                let port = a.addrs.iter().chain(shared.addrs_of_fp(fp).iter()).filter_map(|x| x.parse::<std::net::SocketAddr>().ok()).map(|x| x.port()).next().unwrap_or(api::DEFAULT_PORT);
                shared.hint(fp, crate::tls::host_port(p.ip, port));
                return Ok((peer_id(&a), None));
            }
            let mut seen = shared.seen.lock().unwrap();
            if seen.len() < 64 || seen.contains_key(fp) {
                let s = seen.entry(fp.clone()).or_default();
                s.fp = fp.clone();
                let name = says("x-harbor-name");
                if !name.is_empty() {
                    s.name = name;
                }
                s.asked = store::now();
            }
            Err(())
        }
        api::Via::Legacy => {
            let ip = p.ip;
            let cached = shared.whois.lock().unwrap().get(&ip).filter(|(at, _)| at.elapsed() < WHOIS_TTL).map(|(_, n)| n.clone());
            let node = match cached {
                Some(n) => n,
                None => {
                    let out = std::process::Command::new("tailscale").args(["whois", "--json", &ip.to_string()]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output();
                    let n = out.ok().and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok()).and_then(|v| parse_whois(&v));
                    shared.whois.lock().unwrap().insert(ip, (Instant::now(), n.clone()));
                    n
                }
            };
            let Some(n) = node else { return Err(()) };
            if shared.admits(&n) {
                let id = shared.upgraded(&n.id).map(|a| peer_id(&a)).unwrap_or_else(|| format!("ts:{}", n.label));
                return Ok((id, Some(n)));
            }
            let mut seen = shared.seen.lock().unwrap();
            let s = seen.entry(n.id.clone()).or_default();
            s.node = n.id.clone();
            s.name = n.label.clone();
            s.asked = store::now();
            Err(())
        }
        _ => Err(()),
    }
}

// ================================================================== HTTP client

/// One request to a peer: (status, JSON body). Errors are for the user ("… didn't answer").
/// With a fingerprint it's TLS, and only that key may answer; without one it's plain HTTP,
/// which is only ever sent to 127.0.0.1 (tests) or a Tailscale address (PCs not upgraded yet).
pub fn http(dest: &Dest, method: &str, path: &str, body: Option<(&str, &[u8])>, wait: Duration) -> Result<(u16, Value), String> {
    let (status, _, buf) = http_raw(dest, method, path, body, wait)?;
    let v = if buf.is_empty() { Value::Null } else { serde_json::from_slice(&buf).map_err(|e| e.to_string())? };
    Ok((status, v))
}

/// [`http`] with the answer as it came: status, content type and bytes (an image).
pub fn http_raw(dest: &Dest, method: &str, path: &str, body: Option<(&str, &[u8])>, wait: Duration) -> Result<(u16, String, Vec<u8>), String> {
    let sock = dest.addr.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("no address")?;
    if let Some(via) = &dest.via {
        // Through another PC: a raw stream to the peer, then TLS with the peer inside it.
        if dest.fp.is_empty() || via.via.is_some() {
            return Err("not sent: a relay needs the peer's key, and only one relay".into());
        }
        let outer = crate::relay::open(via, &dest.fp, sock.port(), wait)?;
        let (inner, _) = crate::tls::handshake(outer, sock.ip(), Some(&dest.fp))?;
        return exchange(inner, &dest.addr, method, path, body);
    }
    if dest.fp.is_empty() {
        let ip = crate::tls::canonical(sock.ip());
        if !ip.is_loopback() && !crate::tls::tailnet_ip(ip) {
            return Err("not sent: no key on file for this PC (pair it again)".into());
        }
        let s = TcpStream::connect_timeout(&sock, CONNECT).map_err(|e| e.to_string())?;
        let _ = s.set_read_timeout(Some(wait));
        let _ = s.set_write_timeout(Some(wait));
        return exchange(s, &dest.addr, method, path, body);
    }
    if crate::relay::unreachable(&sock) {
        return Err("unreachable (HARBOR_UNREACHABLE)".into());
    }
    let (s, _) = crate::tls::connect(&sock, Some(&dest.fp), CONNECT, wait)?;
    exchange(s, &dest.addr, method, path, body)
}

/// How often each PC asks the others where they saw the phones.
const PHONES_EVERY: Duration = Duration::from_secs(15);

/// Asks each PC of the mesh where it saw the phones (`GET /mesh/v1/phones`), so a phone that
/// talks to another PC shows online here too, and takes the phone app from a PC that serves a
/// newer one: a phone whose app only asks the PC it talks to then finds the update there.
fn phones_loop(hub: Arc<api::Hub>) {
    let mut tried: HashMap<String, (i64, Instant)> = HashMap::new();
    // Per peer: the last of its notifications taken (notify.rs).
    let mut notes_at: HashMap<String, u64> = HashMap::new();
    loop {
        std::thread::sleep(PHONES_EVERY);
        if !hub.mesh.on.load(Ordering::SeqCst) {
            continue;
        }
        let peers: Vec<Peer> = hub.mesh.peers.lock().unwrap().values().filter(|p| p.online && !p.fp.is_empty()).cloned().collect();
        let mut seen = HashMap::new();
        for p in peers {
            // (a peer before 0.19 has no such call: 404, nothing to learn)
            let Ok((200, v)) = http(&p.dest(), "GET", "/mesh/v1/phones", None, Duration::from_secs(8)) else { continue };
            let sightings: Vec<api::Sighting> = v["phones"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| api::Sighting {
                    group: s["group"].as_str().unwrap_or("").into(),
                    name: s["name"].as_str().unwrap_or("").chars().take(60).collect(),
                    seen: s["seen"].as_i64().unwrap_or(0).min(store::now()),
                    app: s["app"].as_i64().unwrap_or(0),
                    alive: s["alive"].as_i64().unwrap_or(0).min(store::now()),
                })
                .filter(|s| !s.group.is_empty())
                .collect();
            seen.insert(p.id.clone(), (p.name.clone(), sightings));
            // Who owns it (0.44): it may change while the link stays up.
            if let (Some(o), Some(g)) = (v["owner"].as_str(), v["github"].as_str()) {
                if let Some(x) = hub.mesh.peers.lock().unwrap().get_mut(&p.id) {
                    x.owner = o.chars().take(80).collect();
                    x.github = g.chars().take(60).collect();
                    x.owner_suggested = v["owner_suggested"].as_bool().unwrap_or(false);
                }
            }
            // Its notifications, for the phones that ask this PC (a peer before 0.40: 404).
            let since = notes_at.get(&p.id).copied().unwrap_or(0);
            if let Ok((200, v)) = http(&p.dest(), "GET", &format!("/mesh/v1/notes?since={since}"), None, Duration::from_secs(8)) {
                let notes: Vec<crate::notify::Note> = serde_json::from_value(v["notes"].clone()).unwrap_or_default();
                if since > 0 && !notes.is_empty() {
                    hub.notes.relay(&p.name, notes);
                }
                if let Some(last) = v["last"].as_u64() {
                    notes_at.insert(p.id.clone(), last);
                }
            }
            let theirs = v["apk"].as_i64().unwrap_or(0);
            let mine = crate::update::apk().map_or(0, |(_, c)| c);
            // A newer app there: fetched once per version and PC (again after 10 minutes on failure).
            if theirs > mine && tried.get(&p.id).is_none_or(|(c, at)| *c != theirs || at.elapsed() > Duration::from_secs(600)) {
                tried.insert(p.id.clone(), (theirs, Instant::now()));
                match fetch_apk(&p.dest(), theirs) {
                    Ok(()) => eprintln!("harbor: phone app {theirs} taken from {}", p.name),
                    Err(e) => eprintln!("harbor: phone app {theirs} from {}: {e}", p.name),
                }
            }
        }
        *hub.elsewhere.lock().unwrap() = seen;
    }
}

/// The phone app a PC serves (`GET /mesh/v1/app.apk`) into this PC's, as versionCode `code`.
fn fetch_apk(dest: &Dest, code: i64) -> Result<(), String> {
    let sock = dest.addr.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("no address")?;
    if dest.fp.is_empty() {
        return Err("no key on file for that PC".into());
    }
    let wait = Duration::from_secs(60);
    let mut s: Box<dyn ReadWrite> = match &dest.via {
        Some(via) if via.via.is_none() => {
            let outer = crate::relay::open(via, &dest.fp, sock.port(), wait)?;
            Box::new(crate::tls::handshake(outer, sock.ip(), Some(&dest.fp))?.0)
        }
        Some(_) => return Err("only one relay".into()),
        None => Box::new(crate::tls::connect(&sock, Some(&dest.fp), CONNECT, wait)?.0),
    };
    let (id, name) = HELLO.lock().unwrap().clone();
    let head = format!("GET /mesh/v1/app.apk HTTP/1.1\r\nHost: {}\r\nX-Harbor-Id: {}\r\nX-Harbor-Name: {}\r\nConnection: close\r\n\r\n", dest.addr, id.replace(['\r', '\n'], ""), name.replace(['\r', '\n'], ""));
    s.write_all(head.as_bytes()).and_then(|_| s.flush()).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).map_err(|e| e.to_string())?;
    if line.split_whitespace().nth(1) != Some("200") {
        return Err(format!("answered {}", line.trim()));
    }
    let mut len: Option<u64> = None;
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
    let len = len.filter(|n| (1..=200 << 20).contains(n)).ok_or("no size, or too large")?;
    let mut bytes = Vec::with_capacity(len as usize);
    r.take(len).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 != len || !bytes.starts_with(b"PK\x03\x04") {
        return Err("not an APK".into());
    }
    crate::update::put_apk(&bytes, code)
}

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

/// Writes a request and reads its answer on an open connection.
fn exchange(mut s: impl Read + Write, host: &str, method: &str, path: &str, body: Option<(&str, &[u8])>) -> Result<(u16, String, Vec<u8>), String> {
    let (ctype, data) = body.unwrap_or(("application/json", b""));
    let (id, name) = HELLO.lock().unwrap().clone();
    let me = format!("X-Harbor-Id: {}\r\nX-Harbor-Name: {}\r\n", id.replace(['\r', '\n'], ""), name.replace(['\r', '\n'], ""));
    let head = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\n{me}Content-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", data.len());
    s.write_all(head.as_bytes()).and_then(|_| s.write_all(data)).and_then(|_| s.flush()).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).map_err(|e| e.to_string())?;
    let status: u16 = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("not Harbor")?;
    let mut len: Option<usize> = None;
    let mut ctype = String::new();
    loop {
        let mut l = String::new();
        if r.read_line(&mut l).map_err(|e| e.to_string())? == 0 || l.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().ok();
            } else if k.trim().eq_ignore_ascii_case("content-type") {
                ctype = v.trim().to_string();
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
    Ok((status, ctype, buf))
}

/// An image of a chat that runs on another PC (`/v1/image` here for a copy): fetched from that
/// PC, since its paths are that PC's files. None when the PC is off or has no such image.
pub fn home_image(hub: &api::Hub, chat: i64, path: &str, max: Option<u32>) -> Option<(String, Vec<u8>)> {
    let (home, _) = hub.mesh.homes.lock().unwrap().get(&chat).cloned()?;
    let p = hub.mesh.peer(&home).filter(|p| p.online)?;
    let q = format!("/mesh/v1/image?path={}{}", api::url_encode(path), max.map(|m| format!("&max={m}")).unwrap_or_default());
    match http_raw(&p.dest(), "GET", &q, None, Duration::from_secs(20)) {
        Ok((200, ctype, bytes)) if ctype.starts_with("image/") => Some((ctype, bytes)),
        _ => None,
    }
}

/// A video of a chat that runs on another PC (`/v1/media` here for a copy), the same way: at
/// most what one mesh answer carries (64 MB).
pub fn home_media(hub: &api::Hub, chat: i64, path: &str) -> Option<(String, Vec<u8>)> {
    let (home, _) = hub.mesh.homes.lock().unwrap().get(&chat).cloned()?;
    let p = hub.mesh.peer(&home).filter(|p| p.online)?;
    let q = format!("/mesh/v1/media?path={}", api::url_encode(path));
    match http_raw(&p.dest(), "GET", &q, None, Duration::from_secs(120)) {
        Ok((200, ctype, bytes)) if ctype.starts_with("video/") || ctype.starts_with("image/") => Some((ctype, bytes)),
        _ => None,
    }
}

fn get(dest: &Dest, path: &str, wait: Duration) -> Result<Value, String> {
    match http(dest, "GET", path, None, wait)? {
        (200, v) => Ok(v),
        (s, v) => Err(format!("{s}: {}", v["error"].as_str().unwrap_or(""))),
    }
}

// ================================================================== server (a peer asks)

/// A `/mesh/…` request on the API listener (api.rs `serve`). Answers here or on the UI thread.
pub fn serve(from: &api::Peer, req: &api::Request, r: &mut impl Read, hub: &api::Hub, tx: &Sender<crate::control::Incoming>, wake: &(impl Fn() + Send + Sync)) -> Reply {
    let shared = &hub.mesh;
    if !shared.on.load(Ordering::SeqCst) {
        return err(403, "this PC doesn't share its chats (Settings › Devices)");
    }
    let segs = req.segments();
    // Pairing with a code: any PC that shows a key may try (a few times).
    if segs == ["mesh", "v1", "pair"] && req.method == "POST" {
        return pair_serve(from, req, r, hub);
    }
    let (peer, node) = match who(shared, from, req) {
        Ok(p) => p,
        // A Harbor that isn't allowed here (yet): it may show this PC in its Settings as waiting.
        Err(_) => {
            let me = shared.me().name;
            return Reply { status: 403, body: json!({ "error": format!("{me} doesn't share chats with this PC yet: pair them in Settings › Devices"), "harbor": true, "name": me }) };
        }
    };
    // A PC on the legacy tailnet path whose key is on file here: it may say hello and swap
    // keys again (its answer may have been lost), nothing more in plain HTTP.
    if let Some(n) = &node {
        let up = shared.upgraded(&n.id);
        match (req.method.as_str(), segs.as_slice()) {
            ("POST", ["mesh", "v1", "enroll"]) => return enroll(hub, n, &read_json(r, req.len)),
            ("GET", ["mesh", "v1", "hello"]) => {}
            _ if up.is_some() => return err(403, "this PC has your key on file: connect over TLS"),
            _ => {}
        }
    }
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
        // This PC's notifications since `since` (notify.rs), so a phone that asks any PC hears
        // of every PC's chats. 0: only the newest id.
        ("GET", ["mesh", "v1", "notes"]) => {
            let since = req.query("since").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let (notes, last) = if since == 0 { (vec![], hub.notes.last()) } else { hub.notes.own_since(since) };
            ok(crate::notify::wire(&notes, last))
        }
        // Where this PC saw the phones (Devices on the others), and the phone app it serves.
        ("GET", ["mesh", "v1", "phones"]) => {
            let phones: Vec<Value> = hub.local_phones().iter().filter(|p| p.seen > 0 || p.alive > 0).map(|p| json!({ "group": p.group, "name": p.name, "seen": p.seen, "app": p.app, "alive": p.alive })).collect();
            let about = shared.about.lock().unwrap().clone();
            ok(json!({ "phones": phones, "apk": crate::update::apk().map_or(0, |(_, c)| c), "owner": about["owner"], "github": about["github"], "owner_suggested": about["owner_suggested"] }))
        }
        // Voice (dictate.rs): how this PC is doing, and a recording to transcribe here (never
        // forwarded again).
        ("GET", ["mesh", "v1", "voice"]) => ok(crate::dictate::status(&shared.me().name)),
        ("POST", ["mesh", "v1", "transcribe"]) => match api::read_body(r, req.len, api::MAX_AUDIO) {
            Ok(body) => {
                let (status, body) = crate::dictate::serve_peer(hub, &body, req.query("lang").unwrap_or("auto"));
                Reply { status, body }
            }
            Err(_) => err(413, "recording too long"),
        },
        ("POST", ["mesh", "v1", "upload"]) => {
            let q = api::Request { query: vec![("name".into(), req.query("name").unwrap_or("file").into())], ..req.clone() };
            api::upload_to(r, &q, &api::uploads_dir())
        }
        // Devices › Send on that PC: text or an image for the clipboard, an image or a file.
        ("POST", ["mesh", "v1", "deliver"]) => {
            let from = shared.name_of(&peer);
            crate::devices::receive(&from, req.query("kind").unwrap_or(""), req.query("name").unwrap_or("file"), r, req.len)
        }
        ("POST", ["mesh", "v1", "mint"]) => {
            let body = read_json(r, req.len);
            mint(hub, &body)
        }
        ("POST", ["mesh", "v1", "lease"]) => {
            let b = read_json(r, req.len);
            let Some(chat) = b["chat"].as_i64().filter(|c| !shared.foreign.lock().unwrap().contains(c)) else { return err(404, "no such chat") };
            let s = |k: &str| b[k].as_str().unwrap_or("").chars().take(60).collect::<String>();
            let on = b["on"].as_bool().unwrap_or(false);
            let changed = if b["view"].as_bool() == Some(true) {
                hub.set_viewing(chat, &s("device"), &s("label"), s("kind") != "away", on)
            } else {
                hub.set_typing(chat, &s("device"), &s("kind"), &s("label"), on, b["text"].as_str())
            };
            if changed {
                wake();
            }
            ok(json!({ "ok": true }))
        }
        // Every PC's files (machines.rs): what this PC shares with the caller, and one tool call.
        ("GET", ["mesh", "v1", "share"]) => crate::machines::serve_share(&peer),
        ("POST", ["mesh", "v1", "tool"]) => crate::machines::serve_tool(&peer, &read_json(r, req.len)),
        ("POST", ["mesh", "v1", "revoke"]) => {
            let body = read_json(r, req.len);
            let groups: Vec<String> = body["groups"].as_array().into_iter().flatten().filter_map(|g| g.as_str().map(String::from)).collect();
            merge_revoked(hub, &groups);
            wake();
            ok(json!({ "ok": true }))
        }
        // A chat handed over from its home PC (movepc.rs): it may fetch a branch first, and it's
        // taken only within the deadline stamped here, by this PC's own clock.
        ("POST", ["mesh", "v1", "adopt"]) => {
            let mut body = read_json(r, req.len);
            if body.is_object() {
                body["deadline_ms"] = json!(crate::movepc::deadline_ms());
            }
            to_ui(req, &segs, body, peer, tx, wake, crate::movepc::SERVE_WAIT)
        }
        _ => {
            let body = read_json(r, req.len);
            to_ui(req, &segs, body, peer, tx, wake, CALL_WAIT)
        }
    }
}

/// A peer's call answered on the UI thread (`App::mesh_route`), within `wait`.
#[allow(clippy::too_many_arguments)]
fn to_ui(req: &api::Request, segs: &[&str], body: Value, peer: String, tx: &Sender<crate::control::Incoming>, wake: &(impl Fn() + Send + Sync), wait: Duration) -> Reply {
    let (rtx, rrx) = channel();
    let call = Call {
        method: req.method.clone(),
        path: segs.iter().map(|s| s.to_string()).collect(),
        query: req.query.clone(),
        body,
        token: String::new(),
        device: peer,
        reply: rtx,
        global: false,
    };
    if tx.send(crate::control::Incoming::Api(call)).is_err() {
        return err(503, "Harbor is closing");
    }
    wake();
    rrx.recv_timeout(wait).unwrap_or_else(|_| err(503, "Harbor did not answer in time"))
}

fn read_json(r: &mut impl Read, len: usize) -> Value {
    api::read_body(r, len, 4 << 20).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
}

/// What this PC tells a peer about itself when keys are swapped.
fn about_me(hub: &api::Hub) -> Value {
    let me = hub.mesh.me();
    let port = *hub.port.lock().unwrap();
    json!({ "fp": crate::tls::my_fp(), "id": me.id, "name": me.name, "addrs": my_addrs(port), "port": port })
}

/// `POST /mesh/v1/enroll` from a PC allowed by Tailscale node (over the tailnet, so WireGuard
/// vouches for it): its key goes into its allowed entry (made if it was allowed as the same
/// Tailscale user), and this PC's key goes back. A different key than one already on file is
/// refused: that takes pairing again.
fn enroll(hub: &api::Hub, n: &Node, body: &Value) -> Reply {
    let Some(fp) = body["fp"].as_str().and_then(crate::tls::normalize_fp) else { return err(400, "no key") };
    if fp == crate::tls::my_fp() {
        return err(400, "that's this PC's own key");
    }
    if let Some(a) = hub.mesh.upgraded(&n.id).filter(|a| a.fp != fp) {
        return err(409, format!("another key is on file for {}: pair the PCs again", a.name));
    }
    let id: String = body["id"].as_str().unwrap_or("").chars().take(80).collect();
    let addrs = clean_addrs(body["addrs"].as_array().into_iter().flatten());
    update_allowed(&hub.mesh, |list| {
        // A key can't belong to two entries.
        list.retain(|a| a.fp != fp || a.node == n.id);
        match list.iter_mut().find(|a| a.node == n.id) {
            Some(a) => {
                a.fp = fp.clone();
                // (Asked again with less: what's known stays.)
                if !id.is_empty() {
                    a.id = id.clone();
                }
                if !addrs.is_empty() {
                    a.addrs = addrs.clone();
                }
            }
            None => list.push(Allowed { node: n.id.clone(), name: n.label.clone(), fp: fp.clone(), id: id.clone(), addrs: addrs.clone() }),
        }
    });
    ok(about_me(hub))
}

/// Pairing attempts per address (on top of the code's own limit).
static PAIR_TRIES: std::sync::LazyLock<crate::tls::Throttle> = std::sync::LazyLock::new(|| crate::tls::Throttle::new(10, Duration::from_secs(60)));

/// The pairing code this PC shows (kv `mesh_pair`, written by Settings › Devices or
/// `harbor mesh pair`): the code, when it runs out (unix s), wrong guesses so far.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PairCode {
    pub code: String,
    pub expires: i64,
    #[serde(default)]
    pub tries: i64,
    /// Set when a PC paired with it: its name (the code is used up).
    #[serde(default)]
    pub paired: String,
}

pub fn load_code(s: &store::Store) -> Option<PairCode> {
    s.get("mesh_pair").and_then(|t| serde_json::from_str(&t).ok())
}

/// A new pairing code, saved for the listener; sharing turns on.
pub fn new_code(s: &store::Store) -> std::io::Result<PairCode> {
    let c = PairCode { code: crate::tls::new_code()?, expires: store::now() + CODE_TTL, tries: 0, paired: String::new() };
    s.set("mesh_pair", &serde_json::to_string(&c).unwrap_or_default());
    s.set("mesh_enabled", "1");
    Ok(c)
}

/// `POST /mesh/v1/pair`: a PC typed this PC's code. It proves it knows the code for the two keys
/// of this very connection (`tls::proof`); this PC answers with its own proof, and each adds
/// the other to its allowed list. The code is good once, for 10 minutes, and 5 wrong guesses.
fn pair_serve(from: &api::Peer, req: &api::Request, r: &mut impl Read, hub: &api::Hub) -> Reply {
    let api::Via::Tls(Some(theirs)) = &from.via else { return err(403, "pairing needs TLS and a key") };
    if !crate::tls::private_ip(from.ip) {
        return err(403, "pairing is for your own network");
    }
    if !PAIR_TRIES.hit(from.ip) {
        return err(429, "too many tries: wait a minute");
    }
    let body = read_json(r, req.len);
    let Ok(store) = store::Store::open() else { return err(503, "Harbor's database is busy") };
    let Some(mut code) = load_code(&store).filter(|c| c.paired.is_empty() && c.expires > store::now() && c.tries < CODE_TRIES) else {
        return err(404, "no pairing code is shown on this PC (or it ran out): show a new one");
    };
    let mine = crate::tls::my_fp();
    let key = crate::tls::code_key(&code.code);
    if theirs == &mine || !crate::tls::proof_ok(&key, "join", &mine, theirs, body["proof"].as_str().unwrap_or("")) {
        code.tries += 1;
        store.set("mesh_pair", &serde_json::to_string(&code).unwrap_or_default());
        return err(403, "wrong code");
    }
    let name: String = body["name"].as_str().unwrap_or("").chars().take(60).collect();
    let id: String = body["id"].as_str().unwrap_or("").chars().take(80).collect();
    let mut addrs = clean_addrs(body["addrs"].as_array().into_iter().flatten());
    // Where it called from, at its port, goes first.
    let port = body["port"].as_u64().and_then(|p| u16::try_from(p).ok()).unwrap_or(api::DEFAULT_PORT);
    let here = crate::tls::host_port(from.ip, port);
    addrs.retain(|a| *a != here);
    addrs.insert(0, here);
    let fp = theirs.clone();
    update_allowed(&hub.mesh, |list| {
        // Paired again (a new key, the same PC): the old entry goes.
        list.retain(|a| a.fp != fp && (id.is_empty() || a.id != id));
        list.push(Allowed { node: String::new(), name: name.clone(), fp: fp.clone(), id: id.clone(), addrs: addrs.clone() });
    });
    code.paired = if name.is_empty() { "a PC".into() } else { name };
    store.set("mesh_pair", &serde_json::to_string(&code).unwrap_or_default());
    let mut me = about_me(hub);
    me["proof"] = json!(crate::tls::proof(&key, "host", &mine, theirs));
    ok(me)
}

/// The other side of pairing: this PC typed `code` shown on the PC at `addr` ("host[:port]").
/// On success both PCs have each other on their allowed lists; returns the entry made here.
pub fn pair_join(shared: &Shared, addr: &str, code: &str, port: u16) -> Result<Allowed, String> {
    let code = crate::tls::normalize_code(code);
    if code.len() != 10 {
        return Err("a pairing code has 10 letters and digits".into());
    }
    let addr = addr.trim();
    let target = match (addr.parse::<std::net::SocketAddr>(), addr.parse::<std::net::IpAddr>()) {
        (Ok(sa), _) => sa.to_string(),
        (_, Ok(ip)) => crate::tls::host_port(ip, api::DEFAULT_PORT),
        _ if addr.contains(':') => addr.to_string(),
        _ => format!("{addr}:{}", api::DEFAULT_PORT),
    };
    let sock = target.to_socket_addrs().map_err(|e| format!("{target}: {e}"))?.next().ok_or("no address")?;
    let (s, host) = crate::tls::connect(&sock, None, CONNECT, Duration::from_secs(20)).map_err(|e| format!("{target} didn't answer: {e}"))?;
    let mine = crate::tls::my_fp();
    let key = crate::tls::code_key(&code);
    let (id, name) = HELLO.lock().unwrap().clone();
    let body = json!({ "proof": crate::tls::proof(&key, "join", &host, &mine), "id": id, "name": name, "addrs": my_addrs(port), "port": port });
    let data = serde_json::to_vec(&body).unwrap_or_default();
    let (status, _, buf) = exchange(s, &target, "POST", "/mesh/v1/pair", Some(("application/json", &data)))?;
    let v: Value = serde_json::from_slice(&buf).unwrap_or(Value::Null);
    if status != 200 {
        return Err(v["error"].as_str().map(String::from).unwrap_or_else(|| format!("{target} answered {status}")));
    }
    if !crate::tls::proof_ok(&key, "host", &host, &mine, v["proof"].as_str().unwrap_or("")) {
        return Err("the PC that answered doesn't know the code: not paired".into());
    }
    let mut addrs = clean_addrs(v["addrs"].as_array().into_iter().flatten());
    let used = sock.to_string();
    addrs.retain(|a| *a != used);
    addrs.insert(0, used);
    let a = Allowed { node: String::new(), name: v["name"].as_str().unwrap_or("").chars().take(60).collect(), fp: host.clone(), id: v["id"].as_str().unwrap_or("").chars().take(80).collect(), addrs };
    let entry = a.clone();
    update_allowed(shared, |list| {
        list.retain(|x| x.fp != entry.fp && (entry.id.is_empty() || x.id != entry.id));
        list.push(entry);
    });
    Ok(a)
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
    // The phone's key, as the PC it paired with has it: the token here is bound to it at once.
    let fp = body["fp"].as_str().and_then(crate::tls::normalize_fp).unwrap_or_default();
    // Three factors: this PC's own pairing secret (the phone derived it for this PC's key and
    // sent it over its session with the asking PC) and the phone's presence key.
    let secret = body["secret"].as_str().filter(|s| s.len() == 64 && crate::phoneauth::unhex(s).is_some()).unwrap_or("").to_string();
    let presence = body["presence"].as_str().filter(|p| crate::phoneauth::unhex(p).is_some_and(|k| crate::phoneauth::p256_point(&k).is_some())).unwrap_or("").to_string();
    let binding = body["binding"].as_bool().unwrap_or(false);
    // A phone without a screen lock: two factors, confirmed so on the PC that asks.
    let nolock = body["nolock"].as_bool().unwrap_or(false) && presence.is_empty();
    let keys_at = body["keys_at"].as_i64().unwrap_or(0);
    if (secret.is_empty() != (presence.is_empty() && !nolock)) || (!secret.is_empty() && fp.is_empty()) {
        return err(400, "bad pairing secret");
    }
    let mut tokens = hub.tokens.lock().unwrap();
    if let Some(t) = tokens.iter_mut().find(|t| t.group == group) {
        if t.fp.is_empty() && !fp.is_empty() {
            t.fp = fp.clone();
            hub.tokens_dirty.store(true, Ordering::SeqCst);
        } else if !fp.is_empty() && t.fp != fp {
            return err(409, "this pairing belongs to another phone");
        }
        if !secret.is_empty() {
            if !t.secured() {
                (t.secret, t.presence, t.binding, t.nolock, t.keys_at) = (secret, presence, binding, nolock, keys_at);
                hub.tokens_dirty.store(true, Ordering::SeqCst);
            } else if t.secret != secret {
                return err(409, "this pairing has other keys here");
            } else if (t.presence != presence || t.nolock != nolock) && keys_at > t.keys_at {
                // Its factors changed on the asking PC since (a screen lock set, or removed and
                // the change confirmed there): the newest wins.
                (t.presence, t.binding, t.nolock, t.keys_at) = (presence, binding, nolock, keys_at);
                hub.auth3.drop_token(&t.token);
                hub.tokens_dirty.store(true, Ordering::SeqCst);
            }
        }
        return ok(json!({ "token": t.token }));
    }
    let Ok(token) = api::new_token() else { return err(500, "no randomness") };
    tokens.push(api::Token { token: token.clone(), name, created: store::now(), group: group.to_string(), fp, secret, presence, binding, nolock, keys_at, ticket: false });
    hub.tokens_dirty.store(true, Ordering::SeqCst);
    ok(json!({ "token": token }))
}

/// A typing or viewing lease for a copy goes to its home PC (on a thread). False when the
/// chat is this PC's own.
#[allow(clippy::too_many_arguments)]
pub fn forward_lease(hub: &api::Hub, chat: i64, view: bool, device: &str, kind: &str, label: &str, on: bool, text: Option<&str>) -> bool {
    let Some((home, hid)) = hub.mesh.homes.lock().unwrap().get(&chat).cloned() else { return false };
    let Some(p) = hub.mesh.peer(&home).filter(|p| p.online) else { return true };
    let mut body = json!({ "chat": hid, "view": view, "device": device, "kind": kind, "label": label, "on": on });
    if let Some(t) = text {
        body["text"] = json!(t);
    }
    let body = serde_json::to_vec(&body).unwrap_or_default();
    std::thread::spawn(move || {
        let _ = http(&p.dest(), "POST", "/mesh/v1/lease", Some(("application/json", &body)), Duration::from_secs(5));
    });
    true
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

/// "host:port" addresses as phones list them: the port of the first, and each address as its
/// bare IP at that port, or "ip:port" / "[ipv6]:port" when it has a port of its own (a router's
/// forward to this PC may use another port outside).
fn ips_and_port(addrs: &[String]) -> (Vec<String>, u16) {
    let sa: Vec<std::net::SocketAddr> = addrs.iter().filter_map(|a| a.parse().ok()).collect();
    let port = sa.first().map(|a| a.port()).unwrap_or(0);
    let mut out: Vec<String> = vec![];
    for a in &sa {
        let e = if a.port() == port { a.ip().to_string() } else { a.to_string() };
        if !out.contains(&e) {
            out.push(e);
        }
    }
    (out, port)
}

/// `GET /v1/hubs` for a phone: this PC and the mesh's others, with a token for the phone on
/// each one that answers (minted there for the phone's pairing group, bound to the phone's
/// key), and each PC's key and addresses. A three-factor pairing gets tokens only from
/// `POST /v1/hubs`, which brings each PC's pairing secret (`secrets`: fingerprint → hex);
/// a GET then lists the PCs with `provision: true` and no token.
pub fn hubs(hub: &api::Hub, token: &str, secrets: Option<&serde_json::Map<String, Value>>) -> Value {
    let (group, name, fp, three, presence, binding, nolock, keys_at) = hub
        .tokens
        .lock()
        .unwrap()
        .iter()
        .find(|t| t.token == token)
        .map(|t| (t.group.clone(), t.name.clone(), t.fp.clone(), t.secured(), t.presence.clone(), t.binding, t.two(), t.keys_at))
        .unwrap_or_default();
    let me = hub.mesh.me();
    let net = hub.net.lock().unwrap().clone();
    let port = *hub.port.lock().unwrap();
    let ip = net.legacy_ip();
    let mut out = vec![json!({ "id": me.id, "name": me.name, "host": ip, "ip": ip, "port": port, "fp": crate::tls::my_fp(), "addrs": net.addrs, "online": true, "phones": true, "token": token, "self": true })];
    if hub.mesh.on.load(Ordering::Relaxed) && !group.is_empty() {
        let peers: Vec<Peer> = hub.mesh.peers.lock().unwrap().values().cloned().collect();
        // Asked all at once: a PC that's off costs one timeout, not one each.
        let asks: Vec<_> = peers
            .into_iter()
            .map(|p| {
                let secret = if three { secrets.and_then(|s| s.get(&p.fp)).and_then(|s| s.as_str()).filter(|s| s.len() == 64).map(String::from) } else { None };
                let ask = !three || secret.is_some();
                let mut body = json!({ "group": group, "name": name, "fp": fp });
                if let Some(s) = secret {
                    body["secret"] = json!(s);
                    body["presence"] = json!(presence);
                    body["binding"] = json!(binding);
                    body["nolock"] = json!(nolock);
                    body["keys_at"] = json!(keys_at);
                }
                let body = serde_json::to_vec(&body).unwrap_or_default();
                std::thread::spawn(move || {
                    // A PC with phone access off would drop the phone: no token for it.
                    let tok = if ask && p.online && p.phones {
                        http(&p.dest(), "POST", "/mesh/v1/mint", Some(("application/json", &body)), Duration::from_secs(6)).ok().filter(|(s, _)| *s == 200).and_then(|(_, v)| v["token"].as_str().map(String::from))
                    } else {
                        None
                    };
                    (p, tok)
                })
            })
            .collect();
        for a in asks {
            let Ok((p, tok)) = a.join() else { continue };
            let mut all = vec![p.addr.clone()];
            all.extend(p.addrs.iter().filter(|a| **a != p.addr).cloned());
            let (ips, port) = ips_and_port(&all);
            let ip = ips.iter().find(|i| i.parse().is_ok_and(crate::tls::tailnet_ip)).or(ips.iter().find(|i| i.parse::<std::net::IpAddr>().is_ok())).cloned().unwrap_or_default();
            let provision = three && tok.is_none() && p.online && p.phones;
            let mut e = json!({ "id": p.id, "name": p.name, "host": ip, "ip": ip, "port": port, "fp": p.fp, "addrs": ips, "online": p.online, "phones": p.phones, "token": tok, "provision": provision, "seen": p.seen });
            if let Some(d) = hub.mesh.down_of(&p.id).filter(|_| !p.online) {
                e["down"] = json!(d.slug());
            }
            out.push(e);
        }
    }
    json!({ "hubs": out })
}

// ================================================================== client (workers)

/// A peer to follow: by key (TLS to whichever of its addresses answers), a Tailscale node not
/// upgraded yet (plain HTTP to its tailnet address, until keys are swapped), or an address
/// given by hand for a test on 127.0.0.1.
#[derive(Clone, Debug)]
enum Target {
    Key(String),
    Legacy { addr: String, node: Node, ts_id: String, dns: String },
    Plain(String),
}

impl Target {
    fn key(&self) -> String {
        match self {
            Target::Key(fp) => format!("fp:{fp}"),
            Target::Legacy { node, .. } => format!("node:{}", node.id),
            Target::Plain(a) => format!("addr:{a}"),
        }
    }
}

/// Starts the peer workers once (sharing turned on); later calls do nothing.
pub fn start(hub: Arc<api::Hub>, tx: Sender<crate::control::Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    if hub.mesh.started.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        if hub.mesh.node.lock().unwrap().is_none() {
            let (me, node) = read_me();
            *hub.mesh.me.lock().unwrap() = me;
            *hub.mesh.node.lock().unwrap() = node;
        }
        let port = *hub.port.lock().unwrap();
        crate::discover::start(hub.clone(), port);
        {
            let hub = hub.clone();
            std::thread::spawn(move || phones_loop(hub));
        }
        let running: Arc<Mutex<HashSet<String>>> = Default::default();
        let mut ts: (Option<Instant>, Option<Value>) = (None, None);
        let mut probed: HashMap<String, Instant> = HashMap::new();
        loop {
            if hub.mesh.on.load(Ordering::SeqCst) {
                let port = *hub.port.lock().unwrap();
                // Tailscale's peer list (optional), at most every 30 s.
                if ts.0.is_none_or(|t| t.elapsed() > Duration::from_secs(30)) {
                    ts = (Some(Instant::now()), if std::env::var("HARBOR_MESH_PEERS").is_ok() { None } else { tailscale_status() });
                }
                for t in targets(&hub.mesh, port, ts.1.as_ref(), &mut probed) {
                    let k = t.key();
                    if running.lock().unwrap().insert(k.clone()) {
                        let (hub, tx, wake, running) = (hub.clone(), tx.clone(), wake.clone(), running.clone());
                        std::thread::spawn(move || {
                            worker(hub, t, tx, wake);
                            running.lock().unwrap().remove(&k);
                        });
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

/// The peers to follow now. Also turns `HARBOR_MESH_PEERS` addresses that aren't loopback into
/// hints: each is asked for its key once in a while, and kept for that key if it's allowed.
fn targets(shared: &Shared, port: u16, ts: Option<&Value>, probed: &mut HashMap<String, Instant>) -> Vec<Target> {
    let allowed = shared.allowed.lock().unwrap().clone();
    let mine = crate::tls::my_fp();
    let mut v: Vec<Target> = allowed.iter().filter(|a| !a.fp.is_empty() && a.fp != mine).map(|a| Target::Key(a.fp.clone())).collect();
    for a in std::env::var("HARBOR_MESH_PEERS").unwrap_or_default().split(',').map(str::trim).filter(|a| !a.is_empty()) {
        let Some(sa) = a.to_socket_addrs().ok().and_then(|mut x| x.next()) else { continue };
        if sa.ip().is_loopback() && std::env::var("HARBOR_MESH_LOOPBACK").as_deref() == Ok("1") {
            v.push(Target::Plain(a.to_string()));
        } else if probed.get(a).is_none_or(|t| t.elapsed() > Duration::from_secs(30)) {
            probed.insert(a.to_string(), Instant::now());
            if let Ok((_, fp)) = crate::tls::connect(&sa, None, CONNECT, Duration::from_secs(3)) {
                if allowed.iter().any(|x| x.fp == fp) {
                    shared.hint(&fp, sa.to_string());
                }
            }
        }
    }
    if let Some(s) = ts {
        let nodes: HashMap<String, Node> = s["Peer"].as_object().into_iter().flatten().filter_map(|(_, p)| status_node(p)).map(|n| (n.label.clone(), n)).collect();
        for p in crate::remote::parse_status(s).peers.iter().filter(|p| p.os == "linux") {
            let (Some(ip), Some(n)) = (p.ips.iter().find(|i| !i.contains(':')), nodes.get(&p.name)) else { continue };
            let addr = format!("{ip}:{port}");
            match allowed.iter().find(|a| a.node == n.id && !a.fp.is_empty()) {
                // Upgraded: its tailnet address is one more to try, over TLS.
                Some(a) => shared.hint(&a.fp, addr),
                None => v.push(Target::Legacy { addr, node: n.clone(), ts_id: p.id.clone(), dns: p.dns.clone() }),
            }
        }
    }
    v
}

/// Keeps this PC's copies of one peer's chats up to date, for as long as it's a peer.
fn worker(hub: Arc<api::Hub>, target: Target, tx: Sender<crate::control::Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    let shared = &hub.mesh;
    let mut backoff = Duration::from_secs(2);
    let mut known: Option<String> = match &target {
        Target::Legacy { ts_id, .. } => Some(ts_id.clone()),
        Target::Key(fp) => shared.allowed_fp(fp).map(|a| peer_id(&a)),
        Target::Plain(_) => None,
    };
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
        // Where to find it, and whether to follow it (a link needs both sides to allow).
        let (dests, mine, node) = match &target {
            Target::Key(fp) => {
                if shared.allowed_fp(fp).is_none() {
                    offline(&known);
                    return; // taken off the list
                }
                (shared.addrs_of_fp(fp).into_iter().map(|addr| Dest { addr, fp: fp.clone(), via: None }).collect::<Vec<_>>(), true, None)
            }
            Target::Legacy { addr, node, .. } => {
                if shared.upgraded(&node.id).is_some() {
                    return; // keys swapped: its Key worker takes over
                }
                (vec![Dest { addr: addr.clone(), fp: String::new(), via: None }], shared.admits(node), Some(node.clone()))
            }
            Target::Plain(addr) => (vec![Dest { addr: addr.clone(), fp: String::new(), via: None }], true, None),
        };
        let mut answer: Result<(u16, Value), String> = Err("no address known for it yet".into());
        let mut dest = Dest::default();
        let port = dests.first().and_then(|d| d.addr.parse::<std::net::SocketAddr>().ok()).map(|a| a.port()).unwrap_or(api::DEFAULT_PORT);
        // Not reachable from here: through each other PC that is (relay.rs).
        let relays: Vec<Dest> = match &target {
            Target::Key(fp) => shared.peers.lock().unwrap().values().filter(|p| p.online && !p.fp.is_empty() && p.fp != *fp && p.via.is_none()).map(|p| p.dest()).collect(),
            _ => vec![],
        };
        let fp = dests.first().map(|d| d.fp.clone()).unwrap_or_default();
        let at = std::net::SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), port).to_string();
        let mut direct_errors = vec![];
        for d in dests.into_iter().chain(relays.into_iter().map(|r| Dest { addr: at.clone(), fp: fp.clone(), via: Some(Box::new(r)) })) {
            answer = http(&d, "GET", "/mesh/v1/hello", None, Duration::from_secs(8));
            if answer.is_ok() {
                dest = d;
                break;
            }
            if let (None, Err(e)) = (&d.via, &answer) {
                direct_errors.push(e.clone());
            }
        }
        // Why it doesn't answer, for Devices and phones (shown only while it's offline).
        if let Some(id) = &known {
            let now = if answer.is_ok() { None } else { Some(Down::of(&direct_errors)) };
            let mut down = shared.down.lock().unwrap();
            if down.get(id).copied() != now {
                match now {
                    Some(d) => down.insert(id.clone(), d),
                    None => down.remove(id),
                };
                drop(down);
                let _ = tx.send(crate::control::Incoming::Mesh(Msg::Peer));
                wake();
            }
        }
        let hello = match answer {
            Ok((200, h)) if mine => h,
            answer => {
                // A Harbor answers either way: remember it for Settings › Devices.
                if let (Some(n), Ok((status, body))) = (&node, &answer) {
                    if *status == 200 || body["harbor"].as_bool() == Some(true) {
                        let mut seen = shared.seen.lock().unwrap();
                        let s = seen.entry(n.id.clone()).or_default();
                        s.node = n.id.clone();
                        s.name = n.label.clone();
                        s.refuses = *status != 200;
                    }
                }
                if let (Target::Key(fp), Ok((403, _))) = (&target, &answer) {
                    let mut seen = shared.seen.lock().unwrap();
                    let s = seen.entry(fp.clone()).or_default();
                    s.fp = fp.clone();
                    s.name = shared.allowed_fp(fp).map(|a| a.name).unwrap_or_default();
                    s.refuses = true;
                }
                offline(&known);
                std::thread::sleep(if mine { backoff } else { Duration::from_secs(15) });
                backoff = (backoff * 2).min(Duration::from_secs(10));
                continue;
            }
        };
        if let Some(n) = &node {
            if let Some(s) = shared.seen.lock().unwrap().get_mut(&n.id) {
                s.refuses = false;
            }
            // Before 0.13 on the other side there's no key to swap: it stays on plain HTTP.
            if hello["fp"].as_str().is_some_and(|f| !f.is_empty()) && upgrade(&hub, &dest, n, &hello) {
                return;
            }
        }
        if let Target::Key(fp) = &target {
            if let Some(s) = shared.seen.lock().unwrap().get_mut(fp) {
                s.refuses = false;
            }
        }
        let id = match &target {
            Target::Legacy { ts_id, .. } => ts_id.clone(),
            _ => hello["id"].as_str().unwrap_or("").to_string(),
        };
        if id.is_empty() || id == shared.me().id {
            return; // this PC itself
        }
        known = Some(id.clone());
        backoff = Duration::from_secs(2);
        let epoch = hello["epoch"].as_u64().unwrap_or(0);
        let groups: Vec<String> = hello["revoked"].as_array().into_iter().flatten().filter_map(|g| g.as_str().map(String::from)).collect();
        merge_revoked(&hub, &groups);
        let addrs = {
            let port = hello["port"].as_u64().and_then(|p| u16::try_from(p).ok());
            let mut a = clean_addrs(hello["addrs"].as_array().into_iter().flatten());
            // Peers before 0.13 say only where they were reached.
            if (a.is_empty() || port.is_none()) && dest.via.is_none() {
                a.insert(0, dest.addr.clone());
            }
            a
        };
        if let Target::Key(fp) = &target {
            // What it says now goes on file, so it's found after a restart (written when changed).
            let name: String = hello["name"].as_str().unwrap_or("").chars().take(60).collect();
            let a = shared.allowed_fp(fp).unwrap_or_default();
            // (Reached through a relay: `dest.addr` is no address of it.)
            let mut keep = if dest.via.is_none() { vec![dest.addr.clone()] } else { vec![] };
            keep.extend(addrs.iter().filter(|x| **x != dest.addr).cloned());
            if a.id != id || a.name != name || a.addrs != keep {
                update_allowed(shared, |list| {
                    if let Some(e) = list.iter_mut().find(|e| e.fp == *fp) {
                        e.id = id.clone();
                        e.name = name.clone();
                        e.addrs = keep.clone();
                    }
                });
            }
        }
        {
            let mut peers = shared.peers.lock().unwrap();
            let p = peers.entry(id.clone()).or_default();
            p.id = id.clone();
            p.name = hello["name"].as_str().unwrap_or("").to_string();
            p.addr = if dest.via.is_some() { p.addr.clone() } else { dest.addr.clone() };
            p.fp = dest.fp.clone();
            p.via = dest.via.clone();
            p.addrs = addrs;
            if let Target::Legacy { dns, .. } = &target {
                if !dns.is_empty() {
                    p.dns = dns.clone();
                }
            }
            p.online = true;
            p.seen = store::now();
            p.node = node.as_ref().map(|n| n.id.clone()).unwrap_or_default();
            // Peers from before 0.12.2 don't say: as before, taken as on.
            p.phones = hello["phones"].as_bool().unwrap_or(true);
            p.version = hello["version"].as_str().unwrap_or("").to_string();
            p.owner = hello["owner"].as_str().unwrap_or("").chars().take(80).collect();
            p.github = hello["github"].as_str().unwrap_or("").chars().take(60).collect();
            p.owner_suggested = hello["owner_suggested"].as_bool().unwrap_or(false);
            p.update = hello.get("update").cloned().unwrap_or(Value::Null);
            p.moves = hello["moves"].as_u64().is_some_and(|v| v >= crate::movepc::VERSION);
            p.accounts = hello["accounts"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|a| (a["id"].as_str().unwrap_or("").into(), a["short"].as_str().unwrap_or("").into(), a["kind"].as_str().unwrap_or("").into()))
                .collect();
        }
        let _ = tx.send(crate::control::Incoming::Mesh(Msg::Peer));
        wake();
        let still = || match &target {
            Target::Key(fp) => shared.allowed_fp(fp).is_some(),
            Target::Legacy { node, .. } => shared.admits(node) && shared.upgraded(&node.id).is_none(),
            Target::Plain(_) => true,
        };
        let _ = sync(&hub, &dest, &id, epoch, &still, &tx, &wake);
        offline(&known);
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Swaps keys with a PC allowed by Tailscale node that has 0.13 (its hello has a key): its key
/// goes into its allowed entry here once it has taken this PC's. True when done.
fn upgrade(hub: &api::Hub, dest: &Dest, n: &Node, hello: &Value) -> bool {
    let body = serde_json::to_vec(&about_me(hub)).unwrap_or_default();
    let Ok((200, v)) = http(dest, "POST", "/mesh/v1/enroll", Some(("application/json", &body)), Duration::from_secs(10)) else { return false };
    let Some(fp) = v["fp"].as_str().and_then(crate::tls::normalize_fp).filter(|f| Some(f.as_str()) == hello["fp"].as_str()) else { return false };
    let id: String = v["id"].as_str().unwrap_or("").chars().take(80).collect();
    let mut addrs = clean_addrs(v["addrs"].as_array().into_iter().flatten());
    if !addrs.contains(&dest.addr) {
        addrs.push(dest.addr.clone());
    }
    update_allowed(&hub.mesh, |list| {
        list.retain(|a| a.fp != fp || a.node == n.id);
        match list.iter_mut().find(|a| a.node == n.id) {
            Some(a) => {
                a.fp = fp.clone();
                a.id = id.clone();
                a.addrs = addrs.clone();
            }
            None => list.push(Allowed { node: n.id.clone(), name: n.label.clone(), fp: fp.clone(), id: id.clone(), addrs: addrs.clone() }),
        }
    });
    true
}

/// Follows a peer until it stops answering or restarts (its epoch changes).
fn sync(hub: &api::Hub, dest: &Dest, id: &str, epoch: u64, still: &dyn Fn() -> bool, tx: &Sender<crate::control::Incoming>, wake: &(impl Fn() + Send + Sync)) -> Result<(), String> {
    let mut since = 0u64;
    loop {
        // The user took the peer off the allowed list: stop following it.
        if !still() {
            return Ok(());
        }
        let chats = get(dest, &format!("/mesh/v1/chats?since={since}&epoch={epoch}"), Duration::from_secs(30))?;
        if chats["epoch"].as_u64() != Some(epoch) {
            return Ok(());
        }
        let rev = chats["rev"].as_u64().unwrap_or(0);
        // Its Harbor's updates, as they are now (Settings › Devices shows them, 0.51).
        if let Some(u) = chats.get("update") {
            let mut peers = hub.mesh.peers.lock().unwrap();
            if let Some(p) = peers.get_mut(id).filter(|p| p.update != *u) {
                p.update = u.clone();
                drop(peers);
                let _ = tx.send(crate::control::Incoming::Mesh(Msg::Peer));
                wake();
            }
        }
        // Its phone access, as it is now (it can be turned on from here, see mesh_settings).
        if let Some(on) = chats["phones"].as_bool() {
            let mut peers = hub.mesh.peers.lock().unwrap();
            if let Some(p) = peers.get_mut(id).filter(|p| p.phones != on) {
                p.phones = on;
                drop(peers);
                let _ = tx.send(crate::control::Incoming::Mesh(Msg::Peer));
                wake();
            }
        }
        let (rtx, rrx) = channel();
        tx.send(crate::control::Incoming::Mesh(Msg::Chats { peer: id.to_string(), epoch, body: chats, reply: rtx })).map_err(|e| e.to_string())?;
        wake();
        let wants = rrx.recv_timeout(Duration::from_secs(60)).map_err(|e| e.to_string())?;
        for (hid, isince) in wants {
            let body = get(dest, &format!("/mesh/v1/chats/{hid}/items?since={isince}&epoch={epoch}"), Duration::from_secs(60))?;
            if body["epoch"].as_u64() != Some(epoch) {
                return Ok(());
            }
            tx.send(crate::control::Incoming::Mesh(Msg::Items { peer: id.to_string(), epoch, home_id: hid, body })).map_err(|e| e.to_string())?;
            wake();
        }
        since = rev;
        let ev = get(dest, &format!("/mesh/v1/events?since={since}&epoch={epoch}"), POLL + Duration::from_secs(10))?;
        if ev["epoch"].as_u64() != Some(epoch) {
            return Ok(());
        }
    }
}

/// A call forwarded to a chat's home PC, on a thread of its own: its files go first (as
/// uploads there), then the call. `done` gets the answer, or a 503 when the PC is off.
pub fn forward(dest: Dest, name: String, method: &str, path: Vec<String>, mut body: Value, files: Vec<PathBuf>, sender: (String, String), ctx: Value, done: impl FnOnce(Reply) + Send + 'static) {
    let method = method.to_string();
    let (sender, device) = sender;
    std::thread::spawn(move || {
        let off = || err(503, format!("{name} is off or unreachable: the chat is read-only until it's back"));
        let mut ids = vec![];
        for f in &files {
            let Ok(data) = std::fs::read(f) else { return done(err(400, format!("can't read {}", f.display()))) };
            let fname = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
            match http(&dest, "POST", &format!("/mesh/v1/upload?name={}", api::url_encode(&fname)), Some(("application/octet-stream", &data)), CALL_WAIT) {
                Ok((201, v)) => ids.push(v["id"].clone()),
                Ok((s, v)) => return done(Reply { status: s, body: v }),
                Err(_) => return done(off()),
            }
        }
        if !files.is_empty() {
            body["files"] = json!(ids);
        }
        let mut call = json!({ "method": method, "path": path, "body": body, "sender": sender, "device": device });
        // Whose instructions and memory a turn it starts runs with (meshctx.rs).
        if !ctx.is_null() {
            call["ctx"] = ctx;
        }
        let data = serde_json::to_vec(&call).unwrap_or_default();
        match http(&dest, "POST", "/mesh/v1/call", Some(("application/json", &data)), CALL_WAIT) {
            Ok((status, body)) => done(Reply { status, body }),
            Err(_) => done(off()),
        }
    });
}

/// `harbor mesh …` on a terminal (or over SSH): sharing on/off, pairing and which PCs are
/// allowed. The running Harbor picks changes up within seconds. Returns the exit code.
pub fn cli(args: &[String]) -> i32 {
    const USAGE: &str = "usage: harbor mesh status | on | off | pair | join <address> <code> | allow <PC>… | remove <PC>…
  pair             show a one-time code; type it on the other PC (Settings › Devices, or harbor mesh join)
  join <PC> <code>  pair with the PC that shows <code>: its name on this network, or its address
  <PC>: the fingerprint of its key (`harbor mesh status` on it), its name if it's listed here,
        or its Tailscale name / node ID (PCs from before 0.13)";
    let Ok(store) = store::Store::open() else {
        eprintln!("harbor: can't open the database");
        return 1;
    };
    let me = match crate::tls::me() {
        Ok(i) => i.fp.clone(),
        Err(e) => {
            eprintln!("harbor: no key for this PC: {e}");
            return 1;
        }
    };
    let (who, _) = read_me();
    let port: u16 = store.get("api_port").and_then(|p| p.parse().ok()).unwrap_or(api::DEFAULT_PORT);
    let mut list = load_allowed(&store);
    let save = |list: &Vec<Allowed>| store.set("mesh_allowed", &serde_json::to_string(list).unwrap_or_default());
    // Tailscale's nodes, for PCs allowed by node before 0.13 (only when it's installed).
    let nodes = || -> Vec<(Node, String)> {
        let st = tailscale_status().unwrap_or_default();
        st["Peer"].as_object().into_iter().flatten().filter_map(|(_, p)| Some((status_node(p)?, p["OS"].as_str().unwrap_or("").to_string()))).collect()
    };
    match args.first().map(String::as_str) {
        Some("on") | Some("off") => {
            store.set("mesh_enabled", if args[0] == "on" { "1" } else { "0" });
            println!("sharing chats with your other PCs: {}", args[0]);
        }
        Some("pair") => {
            let Ok(code) = new_code(&store) else {
                eprintln!("harbor: no randomness for a code");
                return 1;
            };
            println!("Pairing code: {}   (good for 10 minutes, once)", code.code);
            println!("On the other PC, in Harbor › Settings › Devices › Pair with a code, or:");
            for a in crate::tls::lan_addrs() {
                println!("  harbor mesh join {} {}", crate::tls::host_port(a, port), code.code);
            }
            println!("This PC's key: {}", crate::tls::short(&me));
            println!("Waiting (Harbor must be running here with sharing on; Ctrl+C to stop waiting)…");
            while store::now() < code.expires {
                std::thread::sleep(Duration::from_secs(1));
                match load_code(&store) {
                    Some(c) if c.code == code.code && !c.paired.is_empty() => {
                        println!("paired with {}", c.paired);
                        return 0;
                    }
                    Some(c) if c.code == code.code && c.tries >= CODE_TRIES => {
                        eprintln!("harbor: too many wrong tries: the code is void");
                        return 1;
                    }
                    Some(c) if c.code == code.code => {}
                    _ => {
                        eprintln!("harbor: another code replaced this one");
                        return 1;
                    }
                }
            }
            eprintln!("harbor: the code ran out");
            return 1;
        }
        Some("join") if args.len() == 3 => {
            let shared = Shared::default();
            *shared.allowed.lock().unwrap() = list;
            // A name: the Harbor of that name on this network.
            let mut target = args[1].clone();
            if target.parse::<std::net::IpAddr>().is_err() && target.parse::<std::net::SocketAddr>().is_err() && !target.contains('.') {
                let heard = crate::discover::ask(Duration::from_millis(1500));
                match heard.iter().find(|l| l.name.eq_ignore_ascii_case(&target) || label(&l.id).eq_ignore_ascii_case(&target)) {
                    Some(l) => target = l.addr.clone(),
                    None => {
                        eprintln!("harbor: no Harbor called {target} on this network (give its address)");
                        return 1;
                    }
                }
            }
            match pair_join(&shared, &target, &args[2], port) {
                Ok(a) => {
                    store.set("mesh_enabled", "1");
                    println!("paired with {} (key {}); sharing is on", if a.name.is_empty() { &args[1] } else { &a.name }, crate::tls::short(&a.fp));
                }
                Err(e) => {
                    eprintln!("harbor: {e}");
                    return 1;
                }
            }
        }
        Some("allow") | Some("remove") if args.len() > 1 => {
            let allow = args[0] == "allow";
            let ts = nodes();
            for q in &args[1..] {
                if let Some(fp) = crate::tls::normalize_fp(q) {
                    if fp == me {
                        eprintln!("harbor: that's this PC's own key");
                        return 1;
                    }
                    let had = list.iter().any(|a| a.fp == fp);
                    list.retain(|a| a.fp != fp);
                    if allow {
                        list.push(Allowed { fp: fp.clone(), ..Default::default() });
                    }
                    println!("{} {}", if allow { "allowed" } else if had { "removed" } else { "not listed:" }, crate::tls::short(&fp));
                    continue;
                }
                // Listed already: by name or id.
                if let Some(i) = list.iter().position(|a| a.name.eq_ignore_ascii_case(q) || a.id == *q || label(&a.id).eq_ignore_ascii_case(q) || (!a.node.is_empty() && a.node == *q)) {
                    if allow {
                        println!("{} is allowed already", q);
                    } else {
                        let a = list.remove(i);
                        println!("removed {} {}", a.name, crate::tls::short(a.key()));
                    }
                    continue;
                }
                let Some(n) = ts.iter().map(|(n, _)| n).find(|n| n.id == *q || n.label.eq_ignore_ascii_case(q)).cloned() else {
                    eprintln!("harbor: no PC {q}: give the fingerprint of its key (`harbor mesh status` on it), or pair with `harbor mesh pair`");
                    return 1;
                };
                list.retain(|a| a.node != n.id);
                if allow {
                    list.push(Allowed { node: n.id.clone(), name: n.label.clone(), ..Default::default() });
                }
                println!("{} {} ({})", if allow { "allowed" } else { "removed" }, n.label, n.id);
            }
            save(&list);
        }
        Some("status") | None => {
            let on = store.get("mesh_enabled").as_deref() == Some("1");
            println!("this PC: {} ({})", who.name, who.id);
            println!("key:     {me}");
            println!("sharing: {}", if on { "on" } else { "off" });
            let addrs: Vec<String> = crate::tls::lan_addrs().into_iter().map(|a| crate::tls::host_port(a, port)).collect();
            println!("listens: {}", if addrs.is_empty() { "(no network)".to_string() } else { addrs.join("  ") });
            if crate::tls::firewall_blocks(port) {
                println!("firewall: ufw drops port {port} from the network; to let your devices in:\n  {}", crate::tls::firewall_fix(port));
            }
            let heard = crate::discover::ask(Duration::from_millis(1500));
            if !heard.is_empty() {
                println!("Harbors on this network:");
                for l in &heard {
                    let paired = list.iter().any(|a| a.fp == l.fp);
                    println!("  {:<20} {}  key {}{}", l.name, l.addr, crate::tls::short(&l.fp), if paired { "  (paired)" } else { "" });
                }
            }
            println!("allowed PCs:");
            if list.is_empty() {
                println!("  none (pair one: harbor mesh pair)");
            }
            for a in &list {
                let name = if a.name.is_empty() { label(&a.id) } else { a.name.clone() };
                let how = if a.fp.is_empty() { format!("Tailscale node {} (until it upgrades to 0.13)", a.node) } else { format!("key {}", crate::tls::short(&a.fp)) };
                println!("  {:<20} {how}  {}", name, a.addrs.join(" "));
            }
        }
        _ => {
            eprintln!("{USAGE}");
            return 2;
        }
    }
    0
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
                let _ = http(&p.dest(), "POST", "/mesh/v1/revoke", Some(("application/json", &body)), Duration::from_secs(10));
            });
        }
    }

    /// At startup: what's known of the peers and of the copies here.
    pub fn mesh_load(&mut self) {
        *self.api.hub.revoked.lock().unwrap() = api::load_revoked(&self.store);
        *self.api.hub.mesh.allowed.lock().unwrap() = load_allowed(&self.store);
        let mut peers = load_peers(&self.store);
        for c in self.chats.iter().filter(|c| c.foreign()) {
            peers.entry(c.home.clone()).or_insert_with(|| Peer { id: c.home.clone(), name: label(&c.home), ..Default::default() });
        }
        for p in peers.values_mut() {
            p.online = false;
        }
        *self.shared().peers.lock().unwrap() = peers;
        self.mesh_index();
        self.move_pc_load();
        // Who this PC is (its Tailscale name), off the UI thread.
        let hub = self.api.hub.clone();
        std::thread::spawn(move || {
            let (me, node) = read_me();
            *hub.mesh.me.lock().unwrap() = me;
            *hub.mesh.node.lock().unwrap() = node;
        });
    }

    /// Rebuilds the copies' index and the gids (after chats came or went).
    pub fn mesh_index(&self) {
        let mut foreign = HashSet::new();
        let mut ids = HashMap::new();
        for c in self.chats.iter().filter(|c| c.foreign()) {
            foreign.insert(c.id);
            ids.insert((c.home.clone(), c.home_id), c.id);
        }
        *self.shared().foreign.lock().unwrap() = foreign;
        *self.shared().ids.lock().unwrap() = ids;
        *self.shared().homes.lock().unwrap() = self.chats.iter().filter(|c| c.foreign()).map(|c| (c.id, (c.home.clone(), c.home_id))).collect();
        *self.shared().gids.lock().unwrap() = self.chats.iter().map(|c| (c.id, c.gid.clone())).collect();
    }

    /// Why a chat of this PC can't run in its project: the folder isn't here (a project
    /// another PC shares, listed here by its path there). Said before a turn starts, so
    /// the agent's tools don't fail on every call in a folder that doesn't exist.
    pub fn missing_folder(&self, chat: &Chat) -> Option<String> {
        if let Some(w) = self.worktree_of(chat).filter(|w| !w.is_dir()) {
            return Some(format!("This thread's worktree ({}) is gone. Start a new chat in the project to go on.", w.display()));
        }
        let r = self.repo(chat.repo_id?)?;
        if r.path.is_dir() {
            return None;
        }
        let owner = self.chats.iter().find(|c| c.repo_id == Some(r.id) && c.foreign()).map(|c| self.shared().name_of(&c.home));
        Some(match owner {
            Some(o) => format!(
                "{}'s folder ({}) isn't on this PC: it's on {o}. Start the chat with {o} as its device, or clone the project here.",
                r.name,
                r.path.display()
            ),
            None => format!("{}'s folder ({}) isn't on this PC. Clone or move the project back, or pick another project.", r.name, r.path.display()),
        })
    }

    /// True when the chat is a copy of another PC's.
    pub fn is_foreign(&self, id: i64) -> bool {
        self.chat(id).is_some_and(|c| c.foreign())
    }

    /// A copy can be written while its home PC answers; this PC's own chats always.
    pub fn writable(&self, id: i64) -> bool {
        self.chat(id).is_none_or(|c| self.writable_chat(c))
    }

    pub fn writable_chat(&self, c: &Chat) -> bool {
        !c.foreign() || self.shared().online(&c.home)
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

    /// Who types in a chat now (a copy: as its home PC says).
    pub fn typers(&self, chat: i64) -> Vec<api::Typer> {
        match self.mesh.status.get(&chat) {
            Some(r) => r.typing.iter().filter(|t| t.until > Instant::now()).cloned().collect(),
            None => self.api.hub.typing(chat),
        }
    }

    /// Which other PCs have a chat open now.
    pub fn viewers(&self, chat: i64) -> Vec<api::Typer> {
        let me = api::local_device();
        let all = match self.mesh.status.get(&chat) {
            Some(r) => r.viewing.iter().filter(|t| t.until > Instant::now()).cloned().collect(),
            None => self.api.hub.viewing(chat),
        };
        all.into_iter().filter(|t| t.device != me).collect()
    }

    /// A typing or viewing lease of this PC (or a phone through it): kept here for this PC's
    /// chats, sent to the home PC for copies (renewals at most every few seconds).
    #[allow(clippy::too_many_arguments)]
    pub fn set_lease(&mut self, chat: i64, view: bool, device: &str, kind: &str, label: &str, on: bool, text: Option<&str>) {
        if !self.is_foreign(chat) {
            if view {
                self.api.hub.set_viewing(chat, device, label, kind != "away", on);
            } else {
                self.api.hub.set_typing(chat, device, kind, label, on, text);
            }
            return;
        }
        let key = (chat, view);
        let every = if view { Duration::from_secs(5) } else { Duration::from_millis(2500) };
        // A new draft goes out at once (the caller debounces it).
        let th = api::hash_of(&text);
        let same = self.mesh.leases.get(&key).is_some_and(|(o, k, h, at)| *o == on && k == kind && *h == th && at.elapsed() < every);
        if same {
            return;
        }
        self.mesh.leases.insert(key, (on, kind.to_string(), th, Instant::now()));
        forward_lease(&self.api.hub, chat, view, device, kind, label, on, text);
    }

    /// True when someone other than `device` types in the chat: a message from `device` waits.
    pub fn locked_for(&self, chat: i64, device: &str) -> bool {
        self.typers(chat).iter().any(|t| t.device != device)
    }

    /// Who sends the message being handled: the phone, the PC that forwarded it, or this PC.
    pub fn sending_device(&self) -> String {
        if self.sender_device.is_empty() { api::local_device() } else { self.sender_device.clone() }
    }

    /// Once per frame: this PC has its open chat in view (renewed while open).
    fn mesh_viewing(&mut self) {
        if !self.api.hub.mesh.on.load(Ordering::Relaxed) {
            return;
        }
        let open = match self.view {
            crate::app::View::Chat(id) => Some(id),
            _ => None,
        };
        let focused = crate::agent::FOCUSED.load(Ordering::Relaxed);
        let me = api::local_device();
        let name = self.shared().me().name;
        if let Some((old, _, _)) = self.mesh.viewing.filter(|(o, _, _)| Some(*o) != open) {
            self.set_lease(old, true, &me, "away", &name, false, None);
            self.mesh.viewing = None;
        }
        let Some(id) = open else { return };
        let due = self.mesh.viewing.is_none_or(|(_, f, at)| f != focused || at.elapsed() >= Duration::from_secs(5));
        if due {
            self.set_lease(id, true, &me, if focused { "focused" } else { "away" }, &name, true, None);
            self.mesh.viewing = Some((id, focused, Instant::now()));
        }
    }

    /// Once per frame: copies written to disk now and then, the chat waiting to open.
    pub fn mesh_tick(&mut self, ctx: &eframe::egui::Context) {
        // Who is who: a detection that finished, or one that's due (profile.rs).
        let full = self.mesh.reread.is_none_or(|t| t.elapsed() >= Duration::from_secs(10));
        self.profile_tick(ctx, full);
        // Settings changed from outside (`harbor mesh …` on a terminal, over SSH) apply live.
        if self.mesh.reread.is_none_or(|t| t.elapsed() >= Duration::from_secs(10)) {
            self.mesh.reread = Some(Instant::now());
            *self.api.hub.mesh.allowed.lock().unwrap() = load_allowed(&self.store);
            *self.api.hub.mesh.about.lock().unwrap() = crate::meshctx::about(&self.store);
            self.share_publish();
            let on = self.store.get("mesh_enabled").as_deref() == Some("1");
            if on != self.api.hub.mesh.on.load(Ordering::Relaxed) {
                self.mesh_set_enabled(on, ctx);
            }
            ctx.request_repaint_after(Duration::from_secs(10));
        }
        self.mesh_viewing();
        // An idle window draws no frames: wake for the next renewal of "this chat is open here".
        if self.mesh.viewing.is_some() {
            ctx.request_repaint_after(Duration::from_secs(5));
        }
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

    pub fn handle_mesh(&mut self, m: Msg, ctx: &eframe::egui::Context) {
        match m {
            Msg::Peer => {
                let peers = self.shared().peers.lock().unwrap().clone();
                self.note_peers(&peers);
                self.store.set(PEERS_KEY, &serde_json::to_string(&peers).unwrap_or_default());
                // Copies turn read-only or writable: phones see it in the state.
                let ids: Vec<i64> = self.chats.iter().filter(|c| c.foreign()).map(|c| c.id).collect();
                for id in ids {
                    self.api_touch(id);
                }
                self.api.hub.touch(None, true);
            }
            Msg::Chats { peer, epoch, body, reply } => {
                // A chat handed to this peer whose answer was lost: its list settles it first.
                self.move_pc_reconcile(&peer, &body, ctx);
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
                } else if what == "start the chat" || what == "fork the chat" {
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
        // (get_mut: indexing a null part mutably would turn it into an object.)
        if let Some(agents) = status.get_mut("waiting").and_then(|w| w.get_mut("agents")).and_then(|a| a.as_array_mut()) {
            for a in agents {
                let local = a["id"].as_i64().and_then(|h| self.shared().local_id(peer, h)).unwrap_or(0);
                a["id"] = json!(local);
            }
        }
        let leases = |k: &str, ttl: Duration| -> Vec<api::Typer> {
            m[k].as_array()
                .into_iter()
                .flatten()
                .map(|t| {
                    let s = |k: &str| t[k].as_str().unwrap_or("");
                    api::Typer::new(s("device"), s("kind"), s("label"), &api::preview_tail(s("text")), Instant::now() + ttl)
                })
                .collect()
        };
        let (typing, viewing) = (leases("typing", api::TYPING_TTL), leases("viewing", api::VIEWING_TTL));
        self.mesh.status.insert(
            id,
            Remote { running: m["running"].as_bool().unwrap_or(false), since_ms: m["since_ms"].as_i64(), queued: m["queued"].as_u64().unwrap_or(0) as usize, status, forks, typing, viewing },
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
                let phones = self.api.hub.enabled.load(Ordering::Relaxed);
                let port = *self.api.hub.port.lock().unwrap();
                let about = crate::meshctx::about(&self.store);
                ok(json!({ "id": me.id, "name": me.name, "version": crate::update::VERSION, "epoch": epoch, "accounts": accounts, "revoked": revoked, "phones": phones, "fp": crate::tls::my_fp(), "addrs": my_addrs(port), "port": port, "owner": about["owner"], "github": about["github"], "owner_suggested": about["owner_suggested"], "update": crate::update::info(), "moves": crate::movepc::VERSION }))
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
                let phones = self.api.hub.enabled.load(Ordering::Relaxed);
                ok(json!({ "epoch": epoch, "rev": rev, "full": full, "chats": chats, "gone": gone, "phones": phones, "update": crate::update::info() }))
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
                    global: false,
                };
                if inner.path.first().map(String::as_str) != Some("v1") {
                    return err(400, "not a call");
                }
                let sender: String = call.body["sender"].as_str().unwrap_or("").chars().take(60).collect();
                self.sender = if sender.is_empty() { self.shared().name_of(&call.device) } else { sender };
                self.sender_device = call.body["device"].as_str().unwrap_or("").chars().take(60).collect();
                self.mesh.in_call = true;
                // A turn this starts runs with the caller's instructions and memory (meshctx.rs).
                self.mesh.call_ctx = Some((call.device.clone(), self.shared().name_of(&call.device), call.body["ctx"].clone()));
                // Pull requests and issues (ghapi.rs) may answer from a thread: status 0 here.
                let mut r = if inner.path.get(1).is_some_and(|s| s == "prs" || s == "issues") {
                    self.api_github(&inner, ctx).unwrap_or(Reply { status: 0, body: Value::Null })
                } else {
                    self.api_route(&inner, ctx)
                };
                self.mesh.call_ctx = None;
                self.mesh.in_call = false;
                self.sender.clear();
                self.sender_device.clear();
                // A new chat: the caller waits for its copy by this PC's id.
                if r.status < 300 && r.body["id"].is_i64() {
                    r.body["home"] = json!(self.shared().me().id);
                }
                r
            }
            // Memory an agent saved in a chat this PC commanded on another PC (meshctx.rs).
            ("POST", ["mesh", "v1", "memory"]) => match crate::meshctx::accept_memory(&self.store, &call.body) {
                Ok(n) => ok(json!({ "ok": true, "changed": n })),
                Err(e) => err(404, e),
            },
            // A chat moving here from its home PC (movepc.rs): can it come, and the handoff
            // (answered from a thread).
            ("POST", ["mesh", "v1", "adopt", "check"]) => self.move_pc_check(&call.device, &call.body),
            ("POST", ["mesh", "v1", "adopt"]) => self.move_pc_adopt(call, ctx),
            // Settings › Devices on another PC: "Enable" next to this PC's "phone access off".
            ("POST", ["mesh", "v1", "phones"]) => {
                self.api_set_enabled(true, ctx);
                ok(json!({ "ok": true }))
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
            "status": self.status_json(c.id), "forks": forks,
            "typing": self.typing_json(c.id),
            "viewing": self.api.hub.viewing(c.id).into_iter().map(|t| json!({ "device": t.device, "kind": t.kind, "label": t.label })).collect::<Vec<_>>(),
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
        let ctx = if starts_turn(method, tail) { self.ctx_for(c.repo_id) } else { Value::Null };
        forward(peer.dest(), name, method, path, body, files, (self.shared().me().name, api::local_device()), ctx, move |reply| {
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

    pub fn mesh_fork(&mut self, chat: i64, seq: usize) -> bool {
        self.mesh_forward(chat, "fork the chat", "POST", &["fork"], json!({ "seq": seq }), vec![], None)
    }

    /// "Move to PC…" for a copy: its home PC hands it over (movepc.rs).
    pub fn mesh_move_pc(&mut self, chat: i64, pc: &str) -> bool {
        self.mesh_forward(chat, "move the chat", "POST", &["move_pc"], json!({ "pc": pc }), vec![], None)
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
        let ctx = self.ctx_for(self.draft.repo);
        forward(peer.dest(), peer.name, "POST", vec!["v1".into(), "chats".into()], body, files.to_vec(), (self.shared().me().name, api::local_device()), ctx, move |reply| {
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
        // A new chat on a peer's Harbor.
        let global = call.global;
        if call.method == "POST" && p == ["v1", "chats"] {
            let device = call.body["device"].as_str().unwrap_or("").to_string();
            let Some(peer) = self.shared().peer(&device) else { return Some(call) };
            if !peer.online {
                let _ = call.reply.send(err(409, format!("{} is off: pick a PC that's on", peer.name)));
                return None;
            }
            let mut body = call.body.clone();
            body["device"] = json!("");
            let repo = match &call.body["project_id"] {
                Value::String(p) => self.repos.iter().find(|r| r.path.to_string_lossy() == *p),
                v => v.as_i64().and_then(|r| self.repo(r)),
            };
            body["project"] = repo.map(|r| json!({ "name": r.name, "path": r.path.to_string_lossy() })).unwrap_or(Value::Null);
            let ctx = self.ctx_for(repo.map(|r| r.id));
            if let Some(o) = body.as_object_mut() {
                o.remove("project_id");
            }
            let files = files_of(&body);
            let sender = self.phone_name(&call);
            let shared = self.api.hub.clone();
            let reply = call.reply.clone();
            let home = peer.id.clone();
            forward(peer.dest(), peer.name, "POST", vec!["v1".into(), "chats".into()], strip_files(body), files, sender, ctx, move |r| {
                let _ = reply.send(map_new(&shared, &home, r, global));
            });
            return None;
        }
        if !for_home(&call.method, &p) {
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
        // "Move to PC…" is its home's to do; a home before it would only say "unknown call".
        if matches!(p.get(3), Some(&"move_pc" | &"move_targets")) && !peer.moves {
            let _ = call.reply.send(err(409, format!("{name} runs an older Harbor that can't move chats: update it first")));
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
        let repo_path = repo.and_then(|r| self.repo(r)).map(|r| r.path.to_string_lossy().into_owned());
        let parent_gid = parent.and_then(|p| self.chat(p)).map(|p| p.gid.clone());
        let fork = p.get(3) == Some(&"fork");
        let ctx = if starts_turn(&call.method, &p[3..]) { self.ctx_for(repo) } else { Value::Null };
        forward(peer.dest(), name, &call.method, path, strip_files(call.body.clone()), files, sender, ctx, move |mut r| {
            if fork {
                r = map_new(&shared, &home, r, global);
            }
            // The chat as the home PC answers it, with this PC's ids.
            if let Some(ch) = r.body.get_mut("chat").filter(|c| c.is_object()) {
                if global {
                    ch["id"] = json!(gid);
                    ch["project_id"] = json!(repo_path);
                    ch["parent"] = json!(parent_gid);
                } else {
                    ch["id"] = json!(local);
                    ch["project_id"] = json!(repo);
                    ch["parent"] = json!(parent);
                }
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

    /// A phone's message through this PC: its name for "from …", its device id for the typing lock.
    /// What this PC shares with other PCs' chats, for the listener threads (machines.rs).
    pub fn share_publish(&self) {
        let projects = self.repos.iter().filter(|r| r.path.is_dir()).map(|r| (r.name.clone(), r.path.clone())).collect();
        crate::machines::publish(&self.store, projects);
    }

    /// This PC's instructions and memory for a call that may start a turn on another PC, with
    /// the memory of `repo` as this PC has it (meshctx.rs).
    pub fn ctx_for(&self, repo: Option<i64>) -> Value {
        let ctx = crate::meshctx::outgoing(&self.store, repo.and_then(|r| self.repo(r)).map(|r| r.path.as_path()));
        // Its memory id may be new: the listener threads know it at once (machines.rs).
        self.share_publish();
        ctx
    }

    fn phone_name(&self, call: &Call) -> (String, String) {
        let me = self.shared().me().name;
        let phone = if call.device.is_empty() { "Phone".to_string() } else { call.device.clone() };
        (format!("{phone} via {me}"), api::device_id(&call.token))
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

    /// Allows a PC (by key, or a Tailscale node from before 0.13) to share chats with this PC,
    /// or takes it off the list.
    pub fn mesh_allow(&mut self, key: &str, name: &str, allow: bool) {
        let key = key.to_string();
        let name = name.to_string();
        update_allowed(self.shared(), |list| {
            list.retain(|a| a.key() != key && a.node != key);
            if allow {
                match crate::tls::normalize_fp(&key) {
                    Some(fp) => list.push(Allowed { fp, name, ..Default::default() }),
                    None => list.push(Allowed { node: key.clone(), name, ..Default::default() }),
                }
            }
        });
        self.shared().whois.lock().unwrap().clear();
    }

    /// The top bar's badges: the other PCs that have this chat open.
    pub fn mesh_badges(&self, ui: &mut eframe::egui::Ui, chat: i64) {
        let t = self.theme.t;
        let viewers = self.viewers(chat);
        for v in viewers.iter().rev() {
            let away = v.kind == "away";
            let col = if away { t.subtle().gamma_multiply(0.6) } else { t.subtle() };
            let text = eframe::egui::RichText::new(format!("{}  {}", crate::icons::MONITOR, v.label)).text_style(crate::theme::ts("label-12")).color(col);
            let tip = if away { format!("Open on {} (not in front)", v.label) } else { format!("Open on {}", v.label) };
            ui.label(text).tip(tip);
        }
        if let Some(soonest) = viewers.iter().map(|v| v.until).min() {
            ui.ctx().request_repaint_after(soonest.saturating_duration_since(Instant::now()) + Duration::from_millis(50));
        }
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
        let my_fp = crate::tls::my_fp();
        let peers = self.mesh_hosts();
        let allowed = self.shared().allowed.lock().unwrap().clone();
        let seen = self.shared().seen.lock().unwrap().clone();
        // Every PC worth a row: allowed ones, Harbors met, and linked peers (by key, else node or id).
        let mut keys: Vec<(String, String)> = allowed.iter().map(|a| (a.key().to_string(), if a.name.is_empty() { label(&a.id) } else { a.name.clone() })).collect();
        for s in seen.values() {
            let k = if s.fp.is_empty() { s.node.clone() } else { s.fp.clone() };
            if !keys.iter().any(|(n, _)| *n == k) {
                keys.push((k, s.name.clone()));
            }
        }
        for p in &peers {
            let key = if !p.fp.is_empty() { p.fp.clone() } else if !p.node.is_empty() { p.node.clone() } else { p.id.clone() };
            if !keys.iter().any(|(n, _)| *n == key) {
                keys.push((key, p.name.clone()));
            }
        }
        // Harbors heard on this network (discover.rs) that aren't paired: to pair with a code.
        let lan = crate::discover::unpaired(self.shared());
        for l in &lan {
            if !keys.iter().any(|(n, _)| *n == l.fp) {
                keys.push((l.fp.clone(), l.name.clone()));
            }
        }
        let mut pair_with: Option<(String, String)> = None;
        let mut change: Option<(String, String, bool)> = None;
        let mut enable: Option<Peer> = None;
        let mut update_peers: Vec<Peer> = vec![];
        // The newest Harbor any of them knows of: a PC behind it gets an Update button (its
        // `/v1/hub/update` checks for itself when it hasn't yet).
        let mut newest = crate::update::VERSION.to_string();
        let mine = crate::update::info();
        for v in std::iter::once(mine["latest"].as_str().unwrap_or("")).chain(peers.iter().flat_map(|p| [p.version.as_str(), p.update["latest"].as_str().unwrap_or("")])) {
            if crate::update::newer(v, &newest) {
                newest = v.to_string();
            }
        }
        self.mesh.updating.retain(|id, (was, at)| at.elapsed() < Duration::from_secs(180) && peers.iter().any(|p| p.id == *id && p.version == *was));
        let updating = self.mesh.updating.clone();
        let busy = |p: &Peer| updating.contains_key(&p.id) || p.update["installing"].as_bool() == Some(true) || p.update["checking"].as_bool() == Some(true);
        let behind = |p: &Peer| p.online && p.update["managed"].as_bool() == Some(true) && crate::update::newer(&newest, &p.version);
        let behind_all: Vec<Peer> = peers.iter().filter(|p| behind(p) && !busy(p)).cloned().collect();
        // PCs that ask before updating (`update.auto`, from 0.53): Auto-update turns it on there.
        let mut auto_peers: Vec<Peer> = vec![];
        let mut auto_all = false;
        let asks = |p: &Peer| p.online && p.update["managed"].as_bool() == Some(true) && p.update["auto"].as_bool() == Some(false);
        let asks_all: Vec<Peer> = peers.iter().filter(|p| asks(p)).cloned().collect();
        let mut enable_here = false;
        let phones_here = self.api.hub.enabled.load(Ordering::Relaxed);
        let mut fix_firewall = false;
        let shares = crate::machines::levels(&self.store);
        let mut share_click: Option<(String, eframe::egui::Rect)> = None;
        rows(ui, |ui| {
            w::setting_row(
                ui,
                "Share chats with my other PCs",
                "Every PC with Harbor and this on keeps a copy of every chat and can write in any of them; the agent runs on the PC the chat was started on. Your phone keeps working through any PC that's on. Pair two PCs once with a code (below); they talk over your network, encrypted, and only with each other's keys.",
                |ui| w::toggle(ui, &mut on),
            );
            w::separator(ui);
            w::setting_row(ui, &format!("{}  {} (this PC)", crate::icons::MONITOR, me.name), &format!("Harbor {} · key {}", crate::update::VERSION, crate::tls::short(&my_fp)), |ui| {
                if w::btn(crate::icons::COPY).muted().icon_xs().show(ui).tip("Copy this PC's full key").clicked() {
                    ui.ctx().copy_text(my_fp.clone());
                }
                if on && behind_all.len() > 1 && w::btn("Update all PCs").sm().outline().show(ui).tip("Install the newest Harbor on every other PC that's behind").clicked() {
                    update_peers = behind_all.clone();
                }
                if on && !asks_all.is_empty() && w::btn("Auto-update all PCs").sm().outline().show(ui).tip("Settings › Updates › Automatically on this PC and every other one: new versions install in the background and swap in while nobody uses Harbor there").clicked() {
                    auto_peers = asks_all.clone();
                    auto_all = true;
                }
                if on && !phones_here && w::btn("Enable phone access").sm().outline().show(ui).clicked() {
                    enable_here = true;
                }
            });
            let port = *self.api.hub.port.lock().unwrap();
            if on && crate::tls::firewall_blocks(port) {
                w::separator(ui);
                w::setting_row(ui, "The firewall blocks your other PCs", &format!("This PC's firewall (ufw) drops port {port}, so other PCs and phones on the network can't reach Harbor here."), |ui| {
                    if w::btn("Allow on the local network").sm().primary().show(ui).clicked() {
                        fix_firewall = true;
                    }
                });
            }
            if on {
                for (key, name) in &keys {
                    w::separator(ui);
                    let by_fp = crate::tls::normalize_fp(key).is_some();
                    let peer = peers.iter().find(|p| (!p.fp.is_empty() && p.fp == *key) || (!p.node.is_empty() && p.node == *key) || p.id == *key);
                    let s = seen.get(key);
                    let entry = allowed.iter().find(|a| a.key() == key.as_str());
                    let listed = entry.is_some();
                    let auto = !listed && peer.is_some();
                    let (badge, tone) = match (peer, listed || auto) {
                        (Some(p), _) if p.online => ("Sharing", Tone::Green),
                        (_, true) if s.is_some_and(|s| s.refuses) => ("Waiting", Tone::Amber),
                        (_, true) => ("Off", Tone::Gray),
                        _ => ("Not paired", Tone::Gray),
                    };
                    let mut desc = match (peer, listed || auto) {
                        (Some(p), _) if p.online => {
                            let status = if updating.contains_key(&p.id) { "updating…" } else { p.update["status"].as_str().unwrap_or("") };
                            let mut d = format!("Harbor {}", p.version);
                            if !status.is_empty() {
                                d.push_str(&format!(" · {status}"));
                            }
                            if behind(p) && !busy(p) && !status.contains(newest.as_str()) {
                                d.push_str(&format!(" · {newest} is out"));
                            }
                            if p.update["managed"].as_bool() == Some(true) && p.update["auto"].as_bool() == Some(true) {
                                d.push_str(" · updates automatically");
                            }
                            d
                        }
                        (_, true) if s.is_some_and(|s| s.refuses) => format!("Allowed here, but {name} doesn't allow {} (pair them again)", me.name),
                        (Some(p), true) if p.seen > 0 => match crate::app::ago(p.seen).as_str() {
                            "now" => "Last seen just now".into(),
                            a => format!("Last seen {a} ago"),
                        },
                        (_, true) => "Allowed · not answering (off, or Harbor isn't sharing there)".into(),
                        _ if s.is_some_and(|s| s.asked > 0) => "Asks to share chats with this PC: pair it with a code to allow it".into(),
                        _ => "Runs Harbor with sharing on".into(),
                    };
                    let heard = lan.iter().find(|l| l.fp == *key);
                    if let Some(l) = heard {
                        desc = format!("On this network at {} · Harbor {} · pair it with a code", l.addr, l.version);
                    }
                    if by_fp {
                        desc.push_str(&format!(" · key {}", crate::tls::short(key)));
                    } else if entry.is_some_and(|e| !e.node.is_empty()) || s.is_some_and(|s| !s.node.is_empty()) {
                        desc.push_str(" · on Tailscale, switches to its own key once both PCs have Harbor 0.13");
                    }
                    let phones_off = peer.is_some_and(|p| p.online && !p.phones);
                    if phones_off {
                        desc.push_str(" · phone access off: your phone can't use it when this PC is off");
                    }
                    if let Some(p) = peer {
                        match self.chats.iter().filter(|c| c.home == p.id).count() {
                            0 => {}
                            1 => desc.push_str(" · 1 chat copied here"),
                            n => desc.push_str(&format!(" · {n} chats copied here")),
                        }
                    }
                    if let Some(p) = peer.filter(|p| !p.owner.is_empty()) {
                        desc.push_str(&format!(" · owner {}", p.owner));
                    }
                    w::setting_row(ui, &format!("{}  {name}", crate::icons::MONITOR), &desc, |ui| {
                        // What its chats may do with this PC's files (machines.rs).
                        if let Some(p) = peer {
                            let l = shares.get(&p.id).copied().unwrap_or(crate::machines::DEFAULT);
                            let open = self.mesh.share_menu.as_ref().is_some_and(|(id, _)| *id == p.id);
                            let r = w::trigger(ui, w::Lead::Icon(crate::icons::FOLDER), crate::machines::short(l), open).tip("What chats from this PC may do with this PC's files, shell and GitHub");
                            if r.clicked() {
                                share_click = Some((p.id.clone(), r.rect));
                            }
                        }
                        // Peers given by hand (tests) have nothing to allow.
                        let real = !key.contains(':');
                        if real && listed && w::btn("Remove").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                            change = Some((key.clone(), name.clone(), false));
                        }
                        // Only a Tailscale node can be allowed by a click (Tailscale vouched for
                        // it); anything else met on the network pairs with a code.
                        if real && !by_fp && !listed && !auto && w::btn("Allow").sm().primary().show(ui).clicked() {
                            change = Some((key.clone(), name.clone(), true));
                        }
                        if let Some(l) = heard.filter(|_| !listed) {
                            if w::btn("Pair").sm().primary().show(ui).clicked() {
                                pair_with = Some((l.addr.clone(), l.name.clone()));
                            }
                        }
                        if let Some(p) = peer.filter(|p| behind(p)) {
                            let b = busy(p);
                            if w::btn(if b { "Updating…" } else { "Update" }).sm().primary().enabled(!b).show(ui).tip(&format!("Install Harbor {newest} there; it reloads in place, its running agents keep going")).clicked() {
                                update_peers = vec![p.clone()];
                            }
                        }
                        if let Some(p) = peer.filter(|p| asks(p)) {
                            if w::btn("Auto-update").sm().outline().show(ui).tip("Turn on Settings › Updates › Automatically there: new versions install in the background and swap in while nobody uses Harbor on it").clicked() {
                                auto_peers = vec![p.clone()];
                            }
                        }
                        if phones_off && w::btn("Enable phone access").sm().outline().show(ui).clicked() {
                            if let Some(p) = peer {
                                enable = Some(p.clone());
                            }
                        }
                        w::badge(ui, badge, tone);
                    });
                }
                if keys.is_empty() {
                    w::separator(ui);
                    w::setting_row(ui, "No other PCs yet", "Turn this on in Harbor on your other PC too, then pair them with a code below.", |_| {});
                }
            }
        });
        if let Some((key, name, allow)) = change {
            self.mesh_allow(&key, &name, allow);
        }
        if let Some((id, rect)) = share_click {
            self.mesh.share_menu = if self.mesh.share_menu.as_ref().is_some_and(|(o, _)| *o == id) { None } else { Some((id, rect)) };
        }
        if let Some((id, anchor)) = self.mesh.share_menu.clone() {
            let t = w::tokens(ui);
            let cur = shares.get(&id).copied().unwrap_or(crate::machines::DEFAULT);
            let (pick, close) = w::popover(&ctx, "share-level", anchor, 330.0, false, &t, |ui| {
                w::menu_label(ui, "Its chats may");
                let mut pick = None;
                for l in crate::machines::Level::ALL {
                    if w::menu_item(ui, "", l.label(), Some(crate::machines::about_level(l)), l == cur).clicked() {
                        pick = Some(l);
                    }
                }
                pick
            });
            if let Some(l) = pick {
                crate::machines::set_level(&self.store, &id, l);
                self.share_publish();
            }
            if pick.is_some() || close {
                self.mesh.share_menu = None;
            }
        }
        if fix_firewall {
            self.open_firewall(&ctx);
        }
        if let Some((addr, name)) = pair_with {
            self.mesh.pair.addr = addr;
            *self.mesh.pair.result.lock().unwrap() = Some(Ok(format!("Now show a code on {name} (Settings › Devices › Show a code) and type it below.")));
        }
        if enable_here {
            self.api_set_enabled(true, &ctx);
        }
        for p in update_peers {
            // Its own Update button, as a phone presses it (`/v1/hub/update`, through the mesh).
            self.mesh.updating.insert(p.id.clone(), (p.version.clone(), Instant::now()));
            std::thread::spawn(move || {
                let call = serde_json::to_vec(&json!({ "method": "POST", "path": ["v1", "hub", "update"], "body": {} })).unwrap_or_default();
                if let Ok((status, v)) = http(&p.dest(), "POST", "/mesh/v1/call", Some(("application/json", &call)), Duration::from_secs(15)) {
                    if status >= 300 {
                        eprintln!("harbor: updating {}: {}", p.name, v["error"].as_str().unwrap_or("refused"));
                    }
                }
            });
        }
        if auto_all {
            // "Auto-update all PCs": this one too.
            self.store.set("auto_update", "1");
        }
        for p in auto_peers {
            // Its Settings › Updates › Automatically (`/v1/hub/auto`, through the mesh); its next
            // hello says so.
            std::thread::spawn(move || {
                let call = serde_json::to_vec(&json!({ "method": "POST", "path": ["v1", "hub", "auto"], "body": { "on": true } })).unwrap_or_default();
                if let Ok((status, v)) = http(&p.dest(), "POST", "/mesh/v1/call", Some(("application/json", &call)), Duration::from_secs(15)) {
                    if status >= 300 {
                        eprintln!("harbor: auto-updates on {}: {}", p.name, v["error"].as_str().unwrap_or("refused"));
                    }
                }
            });
        }
        if let Some(p) = enable {
            // Asks that PC to turn its phone access on; its next hello says so.
            std::thread::spawn(move || {
                let call = serde_json::to_vec(&json!({})).unwrap_or_default();
                let _ = http(&p.dest(), "POST", "/mesh/v1/phones", Some(("application/json", &call)), Duration::from_secs(10));
            });
        }
        if on != was {
            self.mesh_set_enabled(on, &ctx);
        }
        self.mesh_pair_ui(ui);
        if on {
            self.outside_section(ui);
        }
        self.people_ui(ui);
        ui.add_space(12.0);
    }

    /// Settings › Devices › Pair a PC: show a code here, or type one shown on another PC.
    fn mesh_pair_ui(&mut self, ui: &mut eframe::egui::Ui) {
        use crate::pages::{rows, section};
        use crate::widgets::{self as w, Tone};
        let ctx = ui.ctx().clone();
        section(ui, "Pair a PC");
        let port = *self.api.hub.port.lock().unwrap();
        // The shown code as the listener left it (used, or wrongly guessed too often).
        if self.mesh.pair.shown.is_some() && self.mesh.pair.polled.is_none_or(|t| t.elapsed() >= Duration::from_secs(1)) {
            self.mesh.pair.polled = Some(Instant::now());
            self.mesh.pair.shown = load_code(&self.store).filter(|c| self.mesh.pair.shown.as_ref().is_some_and(|s| s.code == c.code));
        }
        if self.mesh.pair.shown.is_some() {
            ctx.request_repaint_after(Duration::from_secs(1));
        }
        let mut show = false;
        let mut cancel = false;
        let mut join = false;
        rows(ui, |ui| match self.mesh.pair.shown.clone() {
            Some(c) if !c.paired.is_empty() => {
                w::setting_row(ui, &format!("Paired with {}", c.paired), "Both PCs allow each other now: their chats show up here in a moment.", |ui| {
                    if w::btn("Done").sm().outline().show(ui).clicked() {
                        cancel = true;
                    }
                });
            }
            Some(c) if c.tries >= CODE_TRIES || c.expires <= store::now() => {
                let why = if c.tries >= CODE_TRIES { "Too many wrong tries: the code is void." } else { "The code ran out." };
                w::setting_row(ui, why, "Show a new one to pair.", |ui| {
                    if w::btn("New code").sm().primary().show(ui).clicked() {
                        show = true;
                    }
                });
            }
            Some(c) => {
                let left = (c.expires - store::now()).max(0);
                let addrs: Vec<String> = crate::tls::lan_addrs().into_iter().map(|a| crate::tls::host_port(a, port)).collect();
                w::setting_row(
                    ui,
                    &format!("Code  {}", c.code),
                    &format!("On the other PC: Settings › Devices › Enter a code, with this PC's address {} · good for {}:{:02} more, once", addrs.first().cloned().unwrap_or_else(|| "(no network)".into()), left / 60, left % 60),
                    |ui| {
                        if w::btn("Cancel").sm().outline().show(ui).clicked() {
                            cancel = true;
                        }
                        w::badge(ui, "Waiting", Tone::Amber);
                    },
                );
                if addrs.len() > 1 {
                    w::separator(ui);
                    w::subtle(ui, format!("This PC's other addresses: {}", addrs[1..].join("  ")), "label-12");
                }
            }
            None => {
                w::setting_row(ui, "Show a code", "Shows a one-time code here to type on your other PC.", |ui| {
                    if w::btn("Show a code").sm().primary().show(ui).clicked() {
                        show = true;
                    }
                });
            }
        });
        ui.add_space(8.0);
        let busy = self.mesh.pair.busy.load(Ordering::Relaxed);
        let result = self.mesh.pair.result.lock().unwrap().clone();
        rows(ui, |ui| {
            w::setting_row(ui, "Enter a code", "The address and code another PC shows under Show a code.", |_| {});
            w::separator(ui);
            ui.horizontal(|ui| {
                ui.add_space(12.0);
                w::input(ui, &mut self.mesh.pair.addr, "Its address (e.g. 10.0.0.12)", true, 200.0);
                w::input(ui, &mut self.mesh.pair.code, "Code", true, 140.0);
                let ready = !busy && !self.mesh.pair.addr.trim().is_empty() && crate::tls::normalize_code(&self.mesh.pair.code).len() == 10;
                if w::btn(if busy { "Pairing…" } else { "Pair" }).sm().primary().enabled(ready).show(ui).clicked() {
                    join = true;
                }
            });
            match &result {
                Some(Ok(m)) => {
                    w::separator(ui);
                    w::subtle(ui, format!("  {m}"), "label-13");
                }
                Some(Err(e)) => {
                    w::separator(ui);
                    w::subtle(ui, format!("  Not paired: {e}"), "label-13");
                }
                None => {}
            }
        });
        if show {
            match new_code(&self.store) {
                Ok(c) => {
                    self.mesh.pair.shown = Some(c);
                    self.mesh_set_enabled(true, &ctx);
                }
                Err(e) => *self.mesh.pair.result.lock().unwrap() = Some(Err(format!("no code: {e}"))),
            }
        }
        if cancel {
            if self.mesh.pair.shown.as_ref().is_some_and(|c| c.paired.is_empty()) {
                self.store.set("mesh_pair", "");
            }
            self.mesh.pair.shown = None;
        }
        if join {
            let (addr, code) = (self.mesh.pair.addr.trim().to_string(), self.mesh.pair.code.clone());
            let (result, busy, hub) = (self.mesh.pair.result.clone(), self.mesh.pair.busy.clone(), self.api.hub.clone());
            busy.store(true, Ordering::SeqCst);
            *result.lock().unwrap() = None;
            self.mesh_set_enabled(true, &ctx);
            std::thread::spawn(move || {
                let r = pair_join(&hub.mesh, &addr, &code, port).map(|a| format!("Paired with {}: its chats show up here in a moment.", if a.name.is_empty() { addr.clone() } else { a.name }));
                *result.lock().unwrap() = Some(r);
                busy.store(false, Ordering::SeqCst);
                ctx.request_repaint();
            });
            self.mesh.pair.code.clear();
        }
    }
}

/// A forwarded call about a chat (`tail` after `/v1/chats/{id}`) that may start a turn: it
/// carries this PC's instructions and memory (meshctx.rs).
fn starts_turn(method: &str, tail: &[&str]) -> bool {
    method == "POST" && matches!(tail.first(), Some(&"send") | Some(&"continue") | Some(&"continue_on") | Some(&"slash"))
}

/// A phone's call about a chat (`/v1/chats/{id}/…`) that the chat's home PC answers for a
/// copy: writes, and the slash menu's list (the commands, skills and agent are there).
fn for_home(method: &str, p: &[&str]) -> bool {
    if p.len() < 3 || p[0] != "v1" || p[1] != "chats" {
        return false;
    }
    // A copy doesn't move from here (movechat.rs says so).
    (matches!(method, "POST" | "PATCH" | "DELETE") && p.get(3) != Some(&"move")) || (method == "GET" && matches!(p.get(3), Some(&"slash" | &"commit" | &"move_targets")))
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
pub fn map_new(hub: &api::Hub, home: &str, mut r: Reply, global: bool) -> Reply {
    let Some(hid) = r.body["id"].as_i64().filter(|_| r.status < 300) else { return r };
    if global {
        // The gid is the same here: no need to wait for the copy.
        r.body["id"] = r.body["gid"].clone();
        return r;
    }
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
    fn why_a_peer_is_down() {
        assert_eq!(Down::of(&["Connection refused (os error 111)".into()]), Down::Harbor);
        assert_eq!(Down::of(&["connection timed out".into(), "Connection refused (os error 111)".into()]), Down::Harbor, "one address answered: the PC is up");
        assert_eq!(Down::of(&["connection timed out".into(), "No route to host (os error 113)".into()]), Down::Pc);
        assert_eq!(Down::of(&[]), Down::Pc);
    }

    #[test]
    fn identity_from_tailscale() {
        let v = json!({ "Self": { "DNSName": "desk.example.ts.net.", "UserID": 42, "ID": "nDESK", "Tags": ["tag:home"] } });
        let (me, node) = parse_me(&v);
        assert_eq!(me, Me { id: "ts:desk".into(), name: "desk".into() });
        assert_eq!(node, Some(Node { id: "nDESK".into(), label: "desk".into(), user: Some(42), tagged: true }));
        assert_eq!(parse_me(&json!({})).0, Me::default());
        let p = json!({ "ID": "nLAP", "DNSName": "laptop.example.ts.net.", "UserID": 7 });
        assert_eq!(status_node(&p), Some(Node { id: "nLAP".into(), label: "laptop".into(), user: Some(7), tagged: false }));
    }

    #[test]
    fn who_gets_in() {
        let whois = |id: &str, user: i64, tags: Value| json!({ "Node": { "StableID": id, "Name": format!("{id}.example.ts.net."), "Tags": tags }, "UserProfile": { "ID": user } });
        let me = Node { id: "nME".into(), label: "me".into(), user: Some(42), tagged: false };
        let same = parse_whois(&whois("nA", 42, json!(null))).unwrap();
        let other = parse_whois(&whois("nB", 7, json!(null))).unwrap();
        let tagged = parse_whois(&whois("nC", 42, json!(["tag:home"]))).unwrap();
        assert_eq!((same.label.as_str(), same.user, same.tagged), ("nA", Some(42), false));
        assert!(admit(Some(&me), &same, &[]), "an untagged node of the same user gets in by itself");
        assert!(!admit(Some(&me), &other, &[]), "another user's node needs the user's Allow");
        assert!(!admit(Some(&me), &tagged, &[]), "a tagged node too");
        let allowed = vec![Allowed { node: "nB".into(), name: "b".into(), ..Default::default() }, Allowed { node: "nC".into(), name: "c".into(), ..Default::default() }];
        assert!(admit(Some(&me), &other, &allowed) && admit(Some(&me), &tagged, &allowed));
        // A tagged PC (no user of its own) lets in only what it allowed.
        let tagged_me = Node { tagged: true, ..me.clone() };
        assert!(!admit(Some(&tagged_me), &same, &[]));
        assert!(admit(Some(&tagged_me), &same, &[Allowed { node: "nA".into(), name: String::new(), ..Default::default() }]));
        assert!(!admit(None, &Node::default(), &allowed), "no node id: never");
        assert_eq!(parse_whois(&json!({})), None);
    }

    #[test]
    fn allowed_list_reads_entries_from_before_keys() {
        // 0.12's kv mesh_allowed: node and name only.
        let old: Vec<Allowed> = serde_json::from_str(r#"[{"node":"nB","name":"laptop"}]"#).unwrap();
        assert_eq!(old[0], Allowed { node: "nB".into(), name: "laptop".into(), ..Default::default() });
        assert_eq!(old[0].key(), "nB");
        let fp = "c".repeat(64);
        let a = Allowed { fp: fp.clone(), ..Default::default() };
        assert_eq!(a.key(), fp);
        assert_eq!(peer_id(&a), format!("fp:{}", "c".repeat(16)));
        assert_eq!(peer_id(&Allowed { id: "ts:laptop".into(), ..a }), "ts:laptop");
    }

    #[test]
    fn peers_addresses_are_checked() {
        let v = json!(["10.0.0.5:47930", "[fd00::5]:47930", "nonsense", "0.0.0.0:1", "10.0.0.5:47930", "[::ffff:10.0.0.6]:47931", "224.0.0.1:5"]);
        assert_eq!(clean_addrs(v.as_array().unwrap()), ["10.0.0.5:47930", "[fd00::5]:47930", "10.0.0.6:47931"]);
        let (ips, port) = ips_and_port(&["10.0.0.5:47931".into(), "[fd00::5]:47931".into(), "10.0.0.5:47931".into(), "203.0.113.7:47940".into()]);
        assert_eq!((ips, port), (vec!["10.0.0.5".to_string(), "fd00::5".to_string(), "203.0.113.7:47940".to_string()], 47931), "a forward's own port is kept");
    }

    #[test]
    fn who_by_key() {
        let shared = Shared::default();
        let fp = "d".repeat(64);
        *shared.allowed.lock().unwrap() = vec![Allowed { fp: fp.clone(), id: "pc:laptop".into(), name: "laptop".into(), addrs: vec!["10.0.0.7:47931".into()], ..Default::default() }];
        let req = api::Request::default();
        let ip: std::net::IpAddr = "10.0.0.8".parse().unwrap();
        let at = |via| api::Peer { ip, via, x: None };
        assert_eq!(who(&shared, &at(api::Via::Tls(Some(fp.clone()))), &req), Ok(("pc:laptop".to_string(), None)));
        // It called from a new address: kept as a hint, at the port it listens on.
        assert_eq!(shared.hints.lock().unwrap()[&fp], ["10.0.0.8:47931"]);
        assert!(who(&shared, &at(api::Via::Tls(Some("e".repeat(64)))), &req).is_err(), "a key not on the list");
        assert!(shared.seen.lock().unwrap().contains_key(&"e".repeat(64)), "remembered for Settings");
        assert!(who(&shared, &at(api::Via::Tls(None)), &req).is_err());
        assert!(who(&shared, &at(api::Via::Refused), &req).is_err());
        // A Dest without a key is never sent anywhere but loopback or Tailscale.
        let e = http(&Dest { addr: "10.0.0.9:47930".into(), fp: String::new(), via: None }, "GET", "/mesh/v1/hello", None, Duration::from_secs(1)).unwrap_err();
        assert!(e.contains("not sent"), "{e}");
    }

    /// A PC allowed by Tailscale node before 0.13 swaps keys over the tailnet, and from then on
    /// only TLS with that key gets in.
    #[test]
    fn upgrade_from_tailscale() {
        let hub = api::Hub::new(vec![], api::DEFAULT_PORT);
        hub.mesh.on.store(true, Ordering::SeqCst);
        let ip = std::net::IpAddr::V4(std::net::Ipv4Addr::new(100, 90, 1, 2));
        let node = Node { id: "nB".into(), label: "laptop".into(), user: None, tagged: true };
        hub.mesh.whois.lock().unwrap().insert(ip, (Instant::now(), Some(node.clone())));
        *hub.mesh.allowed.lock().unwrap() = vec![Allowed { node: "nB".into(), name: "laptop".into(), ..Default::default() }];
        let (tx, _rx) = channel();
        let ask = |via: api::Via, method: &str, path: &str, body: Value| {
            let data = serde_json::to_vec(&body).unwrap();
            let req = api::Request { method: method.into(), path: path.into(), len: data.len(), ..Default::default() };
            serve(&api::Peer { ip, via, x: None }, &req, &mut std::io::Cursor::new(data), &hub, &tx, &|| {})
        };
        let fp = "b".repeat(64);
        let r = ask(api::Via::Legacy, "POST", "/mesh/v1/enroll", json!({ "fp": fp, "id": "ts:laptop", "addrs": ["10.0.0.5:47930", "junk"] }));
        assert_eq!(r.status, 200, "{:?}", r.body);
        let a = hub.mesh.allowed.lock().unwrap()[0].clone();
        assert_eq!((a.node.as_str(), a.fp.as_str(), a.id.as_str(), a.addrs.clone()), ("nB", fp.as_str(), "ts:laptop", vec!["10.0.0.5:47930".to_string()]));
        // Plain is over for it: only hello and the swap again (idempotent), the rest needs TLS.
        assert_eq!(ask(api::Via::Legacy, "GET", "/mesh/v1/events", Value::Null).status, 403);
        assert_eq!(ask(api::Via::Legacy, "POST", "/mesh/v1/enroll", json!({ "fp": fp })).status, 200);
        assert_eq!(ask(api::Via::Legacy, "POST", "/mesh/v1/enroll", json!({ "fp": "c".repeat(64) })).status, 409, "another key takes pairing again");
        assert_eq!(hub.mesh.allowed.lock().unwrap()[0].fp, fp);
        // Over TLS its key is who it is (same peer id as before, so its chats stay its chats).
        assert_eq!(who(&hub.mesh, &api::Peer { ip, via: api::Via::Tls(Some(fp.clone())), x: None }, &api::Request::default()), Ok(("ts:laptop".to_string(), None)));
        assert!(who(&hub.mesh, &api::Peer { ip, via: api::Via::Tls(Some("c".repeat(64))), x: None }, &api::Request::default()).is_err());
        // A node nobody allowed can't swap keys.
        let other = std::net::IpAddr::V4(std::net::Ipv4Addr::new(100, 90, 1, 3));
        hub.mesh.whois.lock().unwrap().insert(other, (Instant::now(), Some(Node { id: "nX".into(), label: "x".into(), user: None, tagged: true })));
        let data = serde_json::to_vec(&json!({ "fp": "e".repeat(64) })).unwrap();
        let req = api::Request { method: "POST".into(), path: "/mesh/v1/enroll".into(), len: data.len(), ..Default::default() };
        assert_eq!(serve(&api::Peer { ip: other, via: api::Via::Legacy, x: None }, &req, &mut std::io::Cursor::new(data), &hub, &tx, &|| {}).status, 403);
        // Pairing needs TLS and a key.
        assert_eq!(ask(api::Via::Legacy, "POST", "/mesh/v1/pair", json!({})).status, 403);
    }

    #[test]
    fn labels() {
        assert_eq!(label("ts:desk"), "desk");
        assert_eq!(label("desk"), "desk");
    }

    #[test]
    fn a_copys_home_answers_writes_and_its_slash_menu() {
        for (method, path) in [("POST", "v1/chats/7/send"), ("PATCH", "v1/chats/7"), ("DELETE", "v1/chats/7"), ("POST", "v1/chats/7/slash"), ("GET", "v1/chats/7/slash"), ("GET", "v1/chats/7/commit/35cbb88")] {
            assert!(for_home(method, &path.split('/').collect::<Vec<_>>()), "{method} {path}");
        }
        for (method, path) in [("GET", "v1/chats/7/items"), ("GET", "v1/chats/7/team"), ("GET", "v1/state"), ("POST", "v1/chats"), ("POST", "v1/upload")] {
            assert!(!for_home(method, &path.split('/').collect::<Vec<_>>()), "{method} {path}");
        }
    }
}
