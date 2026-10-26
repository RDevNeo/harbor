//! The phone API: Harbor for Android drives this Harbor's chats over the network.
//!
//! A fourth listener like control.rs and bridge.rs: hand-written HTTP/1.1 on `std::net`, a
//! thread per connection, no async runtime. It listens on every interface on port 47930 (kv
//! `api_port`; `HARBOR_LISTEN=addr,…` picks addresses instead) and speaks mutual TLS with
//! pinned certificates (tls.rs) to everything but 127.0.0.1: a phone pins this PC's key from
//! the pairing QR and shows its own, which the hub binds to the pairing's token on first use.
//! Every request but `GET /app.apk` also carries `Authorization: Bearer <token>`; tokens are
//! made and revoked in Settings › Phones and kept in kv (`api_tokens`). A TLS client without a
//! known key gets nothing but the APK and PC pairing (mesh.rs). Plain HTTP is answered on
//! 127.0.0.1 only, and on this PC's Tailscale interface for clients that haven't upgraded yet
//! (`tls::legacy`).
//!
//! Calls that read or change chats go to the UI thread as `Incoming::Api` and are answered in
//! its update loop, so `App` keeps a single owner. `GET /v1/events` (the long-poll), uploads and
//! the APK are served from the connection's thread: the long-poll parks on [`Hub`]'s Condvar,
//! which the UI thread signals whenever a chat changes (`apply_event`, `persist`, [`App::api_tick`]).
//!
//! Revisions are one counter for the whole hub that starts at the hub's start time in ms, so it
//! keeps growing across restarts. Each chat remembers the revision of its last change and each
//! transcript item the revision it last changed at (a streaming reply is sent again as it grows).
//! The wire format is written down in android/PROTOCOL.md.

use crate::app::{App, Sel};
use crate::providers::{self, Kind};
use crate::store::{self, Item};
use eframe::egui;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 47930;
/// The longest a long-poll waits before answering with nothing new (clients time out at 25 s).
pub const POLL: Duration = Duration::from_secs(20);
/// How long a call waits for the UI thread.
const UI_WAIT: Duration = Duration::from_secs(30);
/// How long a long-poll that saw a change waits for more before answering.
const COALESCE: Duration = Duration::from_millis(150);
const MAX_JSON: usize = 2 << 20;
/// A phone's recording for `POST /v1/transcribe`: 10 minutes of 16 kHz mono 16-bit, and its header.
const MAX_AUDIO: usize = 16_000 * 2 * 600 + 4096;
/// The most a request's line and headers may take to arrive.
pub const HEAD_WAIT: Duration = Duration::from_secs(10);
const MAX_UPLOAD: usize = 200 << 20;
/// Tool inputs and results are cut to this on the wire (the desktop keeps them whole).
const CLIP: usize = 16 << 10;

// ================================================================== shared state

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Default)]
pub struct Token {
    pub token: String,
    /// What the phone calls itself (`X-Harbor-Device`), once it has connected.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub created: i64,
    /// The pairing it belongs to: a phone paired once gets a token from each PC in the mesh
    /// (mesh.rs), all with the same group, so removing the phone on one PC removes it on all.
    #[serde(default)]
    pub group: String,
    /// The fingerprint of the phone's key (tls.rs): bound on its first TLS call, and from then
    /// on the token only works with that key.
    #[serde(default)]
    pub fp: String,
    /// The pairing secret (hex), made when the phone paired with the codes confirmed on the PC
    /// (phoneauth.rs). Empty: a pairing from before three factors, which must upgrade.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret: String,
    /// The phone's presence key (SubjectPublicKeyInfo, hex): it signs each session's challenge.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub presence: String,
    /// The phone binds its calls to the TLS connection (exporter): every call must.
    #[serde(default)]
    pub binding: bool,
    /// Confirmed on the PC as a phone without a screen lock: two factors (TLS key and pairing
    /// secret), no presence key. Never set by the phone alone (phoneauth.rs).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nolock: bool,
    /// When the factors last changed (unix s): the other PCs of the mesh take the newest.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub keys_at: i64,
    /// A pairing code shown on the PC, not used yet: good for pairing only, for 10 minutes.
    #[serde(default)]
    pub ticket: bool,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

impl Token {
    /// Three factors: a session is needed for every call.
    pub fn three(&self) -> bool {
        !self.secret.is_empty() && !self.presence.is_empty()
    }

    /// Two factors: a phone without a screen lock, confirmed on the PC as one. Sessions too.
    pub fn two(&self) -> bool {
        !self.secret.is_empty() && self.presence.is_empty() && self.nolock
    }

    /// A pairing with a secret (two or three factors): every call needs a session.
    pub fn secured(&self) -> bool {
        self.three() || self.two()
    }

    /// 3, 2, or 0 for a pairing from before three factors.
    pub fn factors(&self) -> u8 {
        if self.three() {
            3
        } else if self.two() {
            2
        } else {
            0
        }
    }
}

#[derive(Default)]
struct Revs {
    rev: u64,
    /// The revision `/v1/state` last changed at.
    state: u64,
    chats: HashMap<i64, u64>,
    /// Who is typing in which chat, until when.
    typing: HashMap<i64, Vec<Typer>>,
    /// Which PCs have which chat open, until when (mesh.rs presence); `kind` is "focused" or
    /// "away" (its window isn't focused).
    viewing: HashMap<i64, Vec<Typer>>,
}

impl Revs {
    /// A new revision for `chat`, in the state too.
    fn mark(&mut self, chat: i64) {
        self.rev += 1;
        self.chats.insert(chat, self.rev);
        self.state = self.rev;
    }

    /// Drops typers whose lease ran out; true when any did (their chats are marked).
    fn prune(&mut self, now: Instant) -> bool {
        let mut gone = vec![];
        for map in [&mut self.typing, &mut self.viewing] {
            for (chat, v) in map.iter_mut() {
                let n = v.len();
                v.retain(|t| t.until > now);
                if v.len() != n {
                    gone.push(*chat);
                }
            }
            map.retain(|_, v| !v.is_empty());
        }
        for c in &gone {
            self.mark(*c);
        }
        !gone.is_empty()
    }

    fn next_expiry(&self) -> Option<Instant> {
        self.typing.values().chain(self.viewing.values()).flatten().map(|t| t.until).min()
    }
}

/// Someone typing in a chat: a phone, another client, or this PC's own composer.
#[derive(Clone, Debug, PartialEq)]
pub struct Typer {
    /// "tok:<8 hex>" for an API client (see [`device_id`]), "pc:<hostname>" for this PC.
    pub device: String,
    /// "phone" or "pc".
    pub kind: String,
    pub label: String,
    pub until: Instant,
}

/// How long one typing signal lasts (clients renew it every ~3 s).
pub const TYPING_TTL: Duration = Duration::from_secs(6);
/// How long a PC's "this chat is open here" lasts (renewed every few seconds while open).
pub const VIEWING_TTL: Duration = Duration::from_secs(15);

/// A client's device id: stable per token, without giving the token away.
pub fn device_id(token: &str) -> String {
    format!("tok:{:08x}", hash_of(&token) as u32)
}

/// This PC's own composer as a typer (its mesh id when given, see mesh.rs).
pub fn local_device() -> String {
    match std::env::var("HARBOR_MESH_ID") {
        Ok(id) if !id.is_empty() => format!("pc:{id}"),
        _ => format!("pc:{}", crate::remote::hostname()),
    }
}

/// Where the listener is reachable, for Settings › Phones and the pairing QR.
#[derive(Clone, Default)]
pub struct Net {
    /// This PC's addresses other devices may use (tls::lan_addrs), IPv4 first.
    pub addrs: Vec<String>,
    /// Addresses the listener holds.
    pub bound: Vec<String>,
    pub error: String,
}

impl Net {
    /// The address an app before 0.13 can use: it only reaches Tailscale's addresses.
    pub fn legacy_ip(&self) -> String {
        self.addrs.iter().find(|a| a.parse().is_ok_and(crate::tls::tailnet_ip)).or(self.addrs.first()).cloned().unwrap_or_default()
    }
}

/// This Harbor's hub, for code without the App at hand (remote.rs's device list).
pub static HUB: std::sync::OnceLock<Arc<Hub>> = std::sync::OnceLock::new();

/// How long something sent to a phone (Devices › Send) waits for its Harbor app.
pub const INBOX_TTL: Duration = Duration::from_secs(24 * 3600);

/// Progress for whoever sent a [`Parcel`]: (bytes the phone fetched, delivered, error).
pub type Report = Arc<dyn Fn(u64, bool, Option<String>) + Send + Sync>;

/// Something this PC sends to a phone's Harbor app (Devices › Send). It waits on the hub
/// until the app picks it up (`GET /v1/inbox`, see android/PROTOCOL.md), at most [`INBOX_TTL`].
pub struct Parcel {
    pub id: String,
    /// The pairing it's for ([`Token::group`]).
    pub group: String,
    /// "text" (onto the clipboard), "image" (saved and opened), "clip-image" (saved, onto the
    /// clipboard) or "file" (saved to Downloads).
    pub kind: &'static str,
    pub name: String,
    pub text: String,
    pub path: Option<PathBuf>,
    /// `path` is a copy made for this parcel: deleted with it.
    pub temp: bool,
    pub size: u64,
    pub at: Instant,
    pub report: Report,
}

impl Parcel {
    fn json(&self) -> Value {
        let mut v = json!({ "id": self.id, "kind": self.kind, "name": self.name, "size": self.size });
        if self.kind == "text" {
            v["text"] = json!(self.text);
        }
        v
    }

    fn finish(self, error: Option<String>) {
        if self.temp {
            if let Some(p) = &self.path {
                let _ = std::fs::remove_file(p);
            }
        }
        (self.report)(if error.is_none() { self.size } else { 0 }, error.is_none(), error);
    }
}

/// A phone paired here, one per pairing (for Devices and Settings › Phones).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct PairedPhone {
    pub group: String,
    pub name: String,
    /// When its app last called this PC or (`via`) another PC of the mesh (0: not seen).
    pub seen: i64,
    /// The address it called this PC from.
    pub ip: String,
    /// The PC it was last seen at, when that's another one (its name); "" for this PC.
    pub via: String,
    /// Its app's versionCode: what it says (`X-Harbor-App`, apps from 0.19), at least
    /// [`APP_INBOX`] for an app that picks up sends, 0 when unknown (an older app).
    pub app: i64,
    /// Its pairing's factors here (Token::factors): 2 for a phone without a screen lock.
    pub factors: u8,
    /// When its app last said it's alive from the background (`POST /v1/alive`), here or on
    /// another PC of the mesh (0: never): reachable, even with the app closed.
    pub alive: i64,
}

/// The first app version that picks up what PCs send (`GET /v1/inbox`, 0.17.0).
pub const APP_INBOX: i64 = 17000;

/// A phone as another PC of the mesh saw it (`GET /mesh/v1/phones` there).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Sighting {
    pub group: String,
    pub name: String,
    pub seen: i64,
    pub app: i64,
    /// Its last background ping there (0: none, or a PC before 0.37.1).
    pub alive: i64,
}

/// What the listener threads and the UI thread share.
pub struct Hub {
    pub enabled: AtomicBool,
    started: AtomicBool,
    pub port: Mutex<u16>,
    pub tokens: Mutex<Vec<Token>>,
    /// Token → (device name, last seen): this session only.
    pub seen: Mutex<HashMap<String, (String, i64)>>,
    /// Token → the address it last called from: this session only.
    pub ips: Mutex<HashMap<String, String>>,
    /// Token → its app's versionCode (see [`PairedPhone::app`]): this session only.
    pub apps: Mutex<HashMap<String, i64>>,
    /// Token → (unix s, the ping's own ms) of its app's last background ping (`POST /v1/alive`):
    /// this session only. Each ping's time must be later than the last (no replays).
    pub alive: Mutex<HashMap<String, (i64, u64)>>,
    /// Peer id → (its name, the phones it saw): the mesh's view of where phones are.
    pub elsewhere: Mutex<HashMap<String, (String, Vec<Sighting>)>>,
    /// What waits for phones' apps to pick it up (Devices › Send).
    pub inbox: Mutex<Vec<Parcel>>,
    revs: Mutex<Revs>,
    cv: Condvar,
    pub net: Mutex<Net>,
    /// The start revision of this run: revisions compare only within one epoch.
    pub epoch: u64,
    /// Sharing chats with the user's other PCs (mesh.rs).
    pub mesh: crate::mesh::Shared,
    /// A peer minted a phone token: the UI thread saves the list.
    pub tokens_dirty: AtomicBool,
    /// Pairings removed (groups), shared with peers so a removed phone is out everywhere.
    pub revoked: Mutex<Vec<String>>,
    /// Phones' sessions, handshakes and pairings waiting for a confirmation (phoneauth.rs).
    pub auth3: crate::phoneauth::State,
    /// Notifications for phones and this desktop (notify.rs).
    pub notes: crate::notify::Notes,
}

impl Hub {
    pub fn new(tokens: Vec<Token>, port: u16) -> Self {
        let base = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(1);
        Hub {
            enabled: AtomicBool::new(false),
            started: AtomicBool::new(false),
            port: Mutex::new(port),
            tokens: Mutex::new(tokens),
            seen: Mutex::new(HashMap::new()),
            alive: Mutex::new(HashMap::new()),
            ips: Mutex::new(HashMap::new()),
            apps: Mutex::new(HashMap::new()),
            elsewhere: Mutex::new(HashMap::new()),
            inbox: Mutex::new(vec![]),
            revs: Mutex::new(Revs { rev: base, state: base, ..Default::default() }),
            cv: Condvar::new(),
            net: Mutex::new(Net::default()),
            epoch: base,
            mesh: Default::default(),
            tokens_dirty: AtomicBool::new(false),
            revoked: Mutex::new(vec![]),
            auth3: Default::default(),
            notes: Default::default(),
        }
    }

    /// Phones or the mesh are on: the listener answers and changes are counted.
    pub fn active(&self) -> bool {
        self.enabled.load(Ordering::Relaxed) || self.mesh.on.load(Ordering::Relaxed)
    }

    pub fn mesh_revoked(&self, group: &str) -> bool {
        self.revoked.lock().unwrap().iter().any(|g| g == group)
    }

    pub fn rev(&self) -> u64 {
        self.revs.lock().unwrap().rev
    }

    /// A new revision for a changed chat (and/or the state); wakes the long-polls.
    pub fn touch(&self, chat: Option<i64>, state: bool) -> u64 {
        let mut r = self.revs.lock().unwrap();
        r.rev += 1;
        let rev = r.rev;
        if let Some(c) = chat {
            r.chats.insert(c, rev);
        }
        if state {
            r.state = rev;
        }
        drop(r);
        self.cv.notify_all();
        rev
    }

    /// A new revision that wakes nobody (items found changed while answering).
    pub fn bump(&self) -> u64 {
        let mut r = self.revs.lock().unwrap();
        r.rev += 1;
        r.rev
    }

    /// Someone starts, keeps or stops typing in `chat`. Starting and stopping wake the
    /// long-polls; a renewal only extends the lease. True when anything visible changed.
    pub fn set_typing(&self, chat: i64, device: &str, kind: &str, label: &str, on: bool) -> bool {
        self.lease(false, chat, device, kind, label, on)
    }

    /// A PC has `chat` open (`focused`: its window is in front), or closed it.
    pub fn set_viewing(&self, chat: i64, device: &str, label: &str, focused: bool, on: bool) -> bool {
        self.lease(true, chat, device, if focused { "focused" } else { "away" }, label, on)
    }

    /// Which PCs have `chat` open now.
    pub fn viewing(&self, chat: i64) -> Vec<Typer> {
        let now = Instant::now();
        self.revs.lock().unwrap().viewing.get(&chat).map(|v| v.iter().filter(|t| t.until > now).cloned().collect()).unwrap_or_default()
    }

    fn lease(&self, view: bool, chat: i64, device: &str, kind: &str, label: &str, on: bool) -> bool {
        let now = Instant::now();
        let ttl = if view { VIEWING_TTL } else { TYPING_TTL };
        let mut r = self.revs.lock().unwrap();
        let mut changed = r.prune(now);
        let map = if view { &mut r.viewing } else { &mut r.typing };
        let v = map.entry(chat).or_default();
        let at = v.iter().position(|t| t.device == device);
        match (at, on) {
            (Some(i), true) => {
                v[i].until = now + ttl;
                if v[i].label != label || v[i].kind != kind {
                    v[i].label = label.into();
                    v[i].kind = kind.into();
                    changed = true;
                }
            }
            (None, true) => {
                v.push(Typer { device: device.into(), kind: kind.into(), label: label.into(), until: now + ttl });
                changed = true;
            }
            (Some(i), false) => {
                v.remove(i);
                changed = true;
            }
            (None, false) => {}
        }
        map.retain(|_, v| !v.is_empty());
        if changed {
            r.mark(chat);
            drop(r);
            self.cv.notify_all();
        }
        changed
    }

    /// Who is typing in `chat` now.
    pub fn typing(&self, chat: i64) -> Vec<Typer> {
        let now = Instant::now();
        self.revs.lock().unwrap().typing.get(&chat).map(|v| v.iter().filter(|t| t.until > now).cloned().collect()).unwrap_or_default()
    }

    /// The soonest a typing lease runs out (for a repaint then).
    pub fn next_typing_expiry(&self) -> Option<Instant> {
        let mut r = self.revs.lock().unwrap();
        // Run-out leases go now (and wake the long-polls), so this never points at the past.
        if r.prune(Instant::now()) {
            self.cv.notify_all();
        }
        r.next_expiry()
    }

    pub fn chat_rev(&self, chat: i64) -> u64 {
        self.revs.lock().unwrap().chats.get(&chat).copied().unwrap_or(0)
    }

    /// The long-poll: as soon as anything changed after `since`, or after `wait`.
    pub fn wait(&self, since: u64, wait: Duration) -> (u64, Vec<i64>, bool) {
        let deadline = Instant::now() + wait;
        let mut r = self.revs.lock().unwrap();
        // A revision from the future: an older run of the hub, or a mixed-up client. Start over.
        if since > r.rev {
            return (r.rev, vec![], true);
        }
        loop {
            // A typing lease that runs out is a change too.
            if r.prune(Instant::now()) {
                self.cv.notify_all();
            }
            if r.rev > since {
                break;
            }
            let now = Instant::now();
            let left = deadline.saturating_duration_since(now);
            if left.is_zero() {
                break;
            }
            let until = r.next_expiry().map_or(left, |e| e.saturating_duration_since(now).max(Duration::from_millis(10)).min(left));
            r = self.cv.wait_timeout(r, until).unwrap().0;
        }
        if r.rev > since && !wait.is_zero() {
            // A streaming reply changes many times a second: one answer for a short burst.
            drop(r);
            std::thread::sleep(COALESCE);
            r = self.revs.lock().unwrap();
        }
        let mut chats: Vec<i64> = r.chats.iter().filter(|(_, v)| **v > since).map(|(k, _)| *k).collect();
        chats.sort();
        (r.rev, chats, r.state > since)
    }

    /// The pairing a token belongs to ("" for none).
    pub fn group_of(&self, token: &str) -> String {
        self.tokens.lock().unwrap().iter().find(|t| t.token == token).map(|t| t.group.clone()).unwrap_or_default()
    }

    /// The phones as this PC saw them, one per pairing (what `GET /mesh/v1/phones` tells peers).
    pub fn local_phones(&self) -> Vec<PairedPhone> {
        let tokens = self.tokens.lock().unwrap().clone();
        let seen = self.seen.lock().unwrap().clone();
        let ips = self.ips.lock().unwrap().clone();
        let apps = self.apps.lock().unwrap().clone();
        let alive = self.alive.lock().unwrap().clone();
        let mut out: Vec<PairedPhone> = vec![];
        for t in tokens.iter().filter(|t| !t.group.is_empty()) {
            let (named, at) = seen.get(&t.token).cloned().unwrap_or_default();
            let name = if !named.is_empty() { named } else { t.name.clone() };
            let ip = ips.get(&t.token).cloned().unwrap_or_default();
            let app = apps.get(&t.token).copied().unwrap_or(0);
            let pinged = alive.get(&t.token).map_or(0, |a| a.0);
            match out.iter_mut().find(|p| p.group == t.group) {
                Some(p) => {
                    p.app = p.app.max(app);
                    p.alive = p.alive.max(pinged);
                    p.factors = p.factors.max(t.factors());
                    if at > p.seen {
                        p.seen = at;
                        p.ip = ip;
                        if !name.is_empty() {
                            p.name = name;
                        }
                    } else if p.name.is_empty() {
                        p.name = name;
                    }
                }
                None => out.push(PairedPhone { group: t.group.clone(), name, seen: at, ip, app, via: String::new(), factors: t.factors(), alive: pinged }),
            }
        }
        out
    }

    /// The phones paired here, one per pairing, with what the other PCs saw of them: last seen
    /// wherever it was most recent (and through which PC), the newest app it showed.
    /// Most recently seen first.
    pub fn paired_phones(&self) -> Vec<PairedPhone> {
        let mut out = self.local_phones();
        let elsewhere = self.elsewhere.lock().unwrap().clone();
        for p in out.iter_mut() {
            for (pc, sightings) in elsewhere.values() {
                for s in sightings.iter().filter(|s| s.group == p.group) {
                    p.app = p.app.max(s.app);
                    // Alive in the background there: online here too, "via" that PC when it's
                    // the newest word from the phone.
                    if s.alive > p.alive {
                        if s.alive > p.seen.max(p.alive) && s.seen <= p.seen {
                            p.via = pc.clone();
                        }
                        p.alive = s.alive;
                    }
                    if s.seen > p.seen {
                        p.seen = s.seen;
                        p.via = pc.clone();
                        if !s.name.is_empty() {
                            p.name = s.name.clone();
                        }
                    }
                }
            }
        }
        out.sort_by(|a, b| b.seen.cmp(&a.seen));
        out
    }

    /// Queues a parcel for a phone's app and wakes its long-poll.
    pub fn post(&self, p: Parcel) {
        self.prune_inbox();
        self.inbox.lock().unwrap().push(p);
        self.touch(None, false);
    }

    /// Parcels nobody picked up in time: given up on.
    fn prune_inbox(&self) {
        let old: Vec<Parcel> = {
            let mut inbox = self.inbox.lock().unwrap();
            let (old, keep) = std::mem::take(&mut *inbox).into_iter().partition(|p| p.at.elapsed() > INBOX_TTL);
            *inbox = keep;
            old
        };
        for p in old {
            p.finish(Some("The phone's Harbor app didn't pick it up within a day".into()));
        }
    }

    /// What waits for a pairing.
    pub fn inbox_for(&self, group: &str) -> Vec<Value> {
        self.prune_inbox();
        if group.is_empty() {
            return vec![];
        }
        self.inbox.lock().unwrap().iter().filter(|p| p.group == group).map(Parcel::json).collect()
    }

    /// The app has it (or gave up on it, with `error`): gone from the inbox.
    pub fn delivered(&self, group: &str, id: &str, error: Option<String>) -> bool {
        let p = {
            let mut inbox = self.inbox.lock().unwrap();
            let Some(i) = inbox.iter().position(|p| p.group == group && p.id == id) else { return false };
            inbox.remove(i)
        };
        p.finish(error);
        true
    }

    #[cfg(test)]
    fn known(&self, token: &str) -> bool {
        self.auth(token, &Via::Loopback).is_ok()
    }

    /// What `token` alone may do over this connection (phoneauth::Level). Over TLS the phone's
    /// key must be the one bound to the token, and a token not bound yet (a phone upgrading from
    /// before 0.13) is bound to the key it's first used with; a pairing code is bound when the
    /// pairing is confirmed. Plain: loopback always (test rigs, `adb reverse`); the legacy
    /// tailnet path only for tokens no key is bound to yet.
    pub fn auth(&self, token: &str, via: &Via) -> Result<crate::phoneauth::Level, &'static str> {
        use crate::phoneauth::Level;
        let mut tokens = self.tokens.lock().unwrap();
        // Every stored token is compared in full, so the time taken says nothing about it.
        let at = tokens.iter().enumerate().fold(None, |hit, (i, t)| if same(t.token.as_bytes(), token.as_bytes()) { Some(i) } else { hit });
        let Some(t) = at.map(|i| &mut tokens[i]) else { return Err("unknown token: pair this phone again in Harbor › Settings › Phones") };
        if t.ticket && store::now() - t.created > crate::phoneauth::TICKET_TTL {
            return Err("this pairing code has expired: make a new one in Harbor › Settings › Phones");
        }
        let level = if t.ticket {
            Level::Ticket
        } else if t.secured() {
            Level::Session
        } else {
            Level::Legacy
        };
        match via {
            Via::Loopback => Ok(Level::Loopback),
            Via::Tls(Some(_)) if t.ticket => Ok(Level::Ticket),
            Via::Tls(Some(fp)) if t.fp.is_empty() => {
                t.fp = fp.clone();
                self.tokens_dirty.store(true, Ordering::SeqCst);
                Ok(level)
            }
            Via::Tls(Some(fp)) if t.fp == *fp => Ok(level),
            Via::Tls(Some(_)) => Err("this pairing belongs to another phone: pair this one in Harbor › Settings › Phones"),
            Via::Tls(None) => Err("this app has no key of its own: update it"),
            Via::Legacy if t.fp.is_empty() && !t.ticket => Ok(Level::Legacy),
            Via::Legacy => Err("this phone now connects with its own key: update the app"),
            Via::Refused => Err("plain HTTP isn't answered here: use TLS"),
        }
    }
}

/// Constant-time equality.
fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

pub fn new_token() -> std::io::Result<String> {
    store::random_hex(24)
}

pub fn load_tokens(s: &store::Store) -> Vec<Token> {
    let mut v: Vec<Token> = s.get("api_tokens").and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    // Pairing codes nobody used in time.
    let n = v.len();
    v.retain(|t| !t.ticket || store::now() - t.created <= crate::phoneauth::TICKET_TTL);
    if v.len() != n {
        save_tokens(s, &v);
    }
    // Tokens from before pairings had groups: each its own.
    if v.iter().any(|t| t.group.is_empty()) {
        for t in v.iter_mut().filter(|t| t.group.is_empty()) {
            t.group = store::random_hex(16).unwrap_or_else(|_| t.token.clone());
        }
        save_tokens(s, &v);
    }
    v
}

/// Pairings removed on any PC of the mesh (their groups).
pub fn load_revoked(s: &store::Store) -> Vec<String> {
    s.get("api_revoked").and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_tokens(s: &store::Store, t: &[Token]) {
    s.set("api_tokens", &serde_json::to_string(t).unwrap_or_default());
}

/// What the UI thread keeps for the API: the hub and each transcript's item revisions.
pub struct Local {
    pub hub: Arc<Hub>,
    /// Chat → per item (its [`fingerprint`], revision it last changed at).
    items: HashMap<i64, Vec<(u64, u64)>>,
    /// Chat → its hub revision when `items` was last brought up to date: until the chat
    /// changes again, a call needn't look at its items at all.
    looked: HashMap<i64, u64>,
    /// Chat → hash of what `/v1/state` says about it; plus the projects/accounts part.
    chats: HashMap<i64, u64>,
    rest: u64,
    /// The open chat and a hash of its draft at the last frame (this PC typing).
    draft: Option<(i64, u64)>,
    /// Lead → hash of its team panel (`/v1/chats/{id}/team`), for leads with a team.
    teams: HashMap<i64, u64>,
    /// The pull requests and issues fetched for phones (ghapi.rs).
    pub gh: crate::ghapi::Shared,
    pub ui: PhonesUi,
}

#[derive(Default)]
pub struct PhonesUi {
    /// The token whose pairing QR is shown, with its textures (pairing, install).
    pub pairing: Option<(String, Option<egui::TextureHandle>, Option<egui::TextureHandle>)>,
    pub install_qr: Option<(String, egui::TextureHandle)>,
}

impl Local {
    pub fn new(hub: Arc<Hub>) -> Self {
        Local { hub, items: HashMap::new(), looked: HashMap::new(), chats: HashMap::new(), rest: 0, draft: None, teams: HashMap::new(), gh: Default::default(), ui: Default::default() }
    }
}

// ================================================================== HTTP

/// A request's head; the body is read afterwards by whoever handles it.
#[derive(Debug, Default, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    /// The request target exactly as sent (path and query): what a phone's MAC covers.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub len: usize,
    /// `Transfer-Encoding: chunked` (only [`read_head_chunked`] lets it through).
    pub chunked: bool,
}

impl Request {
    pub fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(h, _)| h == k).map(|(_, v)| v.as_str())
    }

    pub fn query(&self, k: &str) -> Option<&str> {
        self.query.iter().find(|(q, _)| q == k).map(|(_, v)| v.as_str())
    }

    pub fn bearer(&self) -> Option<&str> {
        let v = self.header("authorization")?;
        let (scheme, t) = v.split_once(' ')?;
        scheme.eq_ignore_ascii_case("bearer").then(|| t.trim()).filter(|t| !t.is_empty())
    }

    /// The path split at '/', without the empty first part: "/v1/chats/3" → ["v1","chats","3"].
    pub fn segments(&self) -> Vec<&str> {
        self.path.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect()
    }
}

/// %xx and '+' decoding of a query part.
pub fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(v) => {
                    out.push(v);
                    i += 3;
                    continue;
                }
                None => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Percent-encoding for a URI component.
pub fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|c| match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (c as char).to_string(),
            _ => format!("%{c:02X}"),
        })
        .collect()
}

pub fn line(r: &mut impl BufRead, max: usize) -> Result<String, (u16, &'static str)> {
    let mut buf = vec![];
    let n = r.by_ref().take(max as u64 + 1).read_until(b'\n', &mut buf).map_err(|_| (400, "unreadable request"))?;
    if n > max {
        return Err((431, "request header too long"));
    }
    if n == 0 {
        return Err((400, "empty request"));
    }
    Ok(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string())
}

/// Reads the request line and headers.
pub fn read_head(r: &mut impl BufRead) -> Result<Request, (u16, &'static str)> {
    let req = read_head_chunked(r)?;
    if req.chunked {
        return Err((411, "send a content-length"));
    }
    Ok(req)
}

/// [`read_head`] that also takes a chunked body (the caller reads it).
pub fn read_head_chunked(r: &mut impl BufRead) -> Result<Request, (u16, &'static str)> {
    let first = line(r, 8192)?;
    let mut parts = first.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next()) else {
        return Err((400, "bad request line"));
    };
    if !version.starts_with("HTTP/1.") || method.is_empty() || !target.starts_with('/') {
        return Err((400, "bad request line"));
    }
    let (path, q) = target.split_once('?').unwrap_or((target, ""));
    let query = q
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (url_decode(k), url_decode(v))
        })
        .collect();
    // Paths keep their '+' (only queries use it for spaces).
    let mut req = Request { method: method.to_ascii_uppercase(), path: decode_path(path), query, target: target.to_string(), ..Default::default() };
    for _ in 0..100 {
        let l = line(r, 8192)?;
        if l.is_empty() {
            return Ok(req);
        }
        let Some((k, v)) = l.split_once(':') else { return Err((400, "bad header")) };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_string());
        if k == "content-length" {
            req.len = v.parse().map_err(|_| (400, "bad content-length"))?;
        }
        if k == "transfer-encoding" && !v.eq_ignore_ascii_case("identity") {
            if !v.eq_ignore_ascii_case("chunked") {
                return Err((411, "send a content-length"));
            }
            req.chunked = true;
        }
        req.headers.push((k, v));
    }
    Err((431, "too many headers"))
}

/// A chunked body of at most `max` bytes; Err(413) past it, Err(400) when malformed.
pub fn read_chunked(r: &mut impl BufRead, max: usize) -> Result<Vec<u8>, u16> {
    let mut body = vec![];
    loop {
        let size = line(r, 1024).map_err(|_| 400u16)?;
        let n = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16).map_err(|_| 400u16)?;
        if n == 0 {
            // Trailers, up to the blank line.
            for _ in 0..100 {
                if line(r, 8192).map_err(|_| 400u16)?.is_empty() {
                    return Ok(body);
                }
            }
            return Err(400);
        }
        if n > max - body.len() {
            return Err(413);
        }
        // Read as it comes: a size alone never makes it allocate.
        if r.by_ref().take(n as u64).read_to_end(&mut body).map_err(|_| 400u16)? != n || !line(r, 16).map_err(|_| 400u16)?.is_empty() {
            return Err(400);
        }
    }
}

/// A body of `len` bytes (Content-Length) of at most `max`.
pub fn read_body(r: &mut impl Read, len: usize, max: usize) -> Result<Vec<u8>, u16> {
    if len > max {
        return Err(413);
    }
    let mut body = Vec::with_capacity(len);
    match r.take(len as u64).read_to_end(&mut body) {
        Ok(n) if n == len => Ok(body),
        _ => Err(400),
    }
}

/// How many connections a listener serves at once; more are closed straight away, so a
/// peer that opens many and sends nothing can't pile up threads.
pub struct Conns(std::sync::atomic::AtomicUsize, usize);

/// One connection's place in its [`Conns`], given back when dropped.
pub struct Conn(&'static Conns);

impl Conns {
    pub const fn new(max: usize) -> Self {
        Conns(std::sync::atomic::AtomicUsize::new(0), max)
    }

    pub fn take(&'static self) -> Option<Conn> {
        if self.0.fetch_add(1, Ordering::SeqCst) >= self.1 {
            self.0.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Conn(self))
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.0.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A socket read with a deadline for the whole request head (`until`), not just per read:
/// a peer that sends a byte now and then can't keep a connection forever. With `until`
/// cleared (the head is in, the caller knows who it is), only `idle` applies per read.
pub struct Timed<'a> {
    pub s: &'a TcpStream,
    pub until: Option<Instant>,
    pub idle: Duration,
}

impl<'a> Timed<'a> {
    /// `head` for the head, `idle` per read after it; writes time out after `idle` too.
    pub fn new(s: &'a TcpStream, head: Duration, idle: Duration) -> Self {
        let _ = s.set_write_timeout(Some(idle));
        Timed { s, until: Some(Instant::now() + head), idle }
    }
}

impl Read for Timed<'_> {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        let wait = match self.until {
            Some(u) => u.saturating_duration_since(Instant::now()).min(self.idle),
            None => self.idle,
        };
        if wait.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        self.s.set_read_timeout(Some(wait))?;
        let mut s = self.s;
        s.read(b)
    }
}

fn decode_path(p: &str) -> String {
    url_decode(&p.replace('+', "%2B"))
}

fn status_text(s: u16) -> &'static str {
    match s {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

pub fn response(status: u16, ctype: &str, len: usize, extra: &str) -> String {
    format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {ctype}\r\nContent-Length: {len}\r\nCache-Control: no-store\r\nConnection: close\r\n{extra}\r\n",
        status_text(status)
    )
}

pub fn send_json_to(w: &mut impl Write, status: u16, v: &Value) {
    send_json(w, status, v)
}

fn send_json(w: &mut impl Write, status: u16, v: &Value) {
    let body = serde_json::to_vec(v).unwrap_or_default();
    let _ = w.write_all(response(status, "application/json; charset=utf-8", body.len(), "").as_bytes());
    let _ = w.write_all(&body);
    let _ = w.flush();
}

/// An answer to a call: a status and its JSON body.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

pub fn ok(body: Value) -> Reply {
    Reply { status: 200, body }
}

pub fn err(status: u16, msg: impl Into<String>) -> Reply {
    Reply { status, body: json!({ "error": msg.into() }) }
}

/// A call for the UI thread.
#[derive(Clone)]
pub struct Call {
    pub method: String,
    pub path: Vec<String>,
    pub query: Vec<(String, String)>,
    pub body: Value,
    pub token: String,
    pub device: String,
    pub reply: Sender<Reply>,
    /// `X-Harbor-Ids: global`: chats by `gid` and projects by path in the answer, the same on
    /// every hub of the mesh (a phone that moves between hubs asks for these).
    pub global: bool,
}

impl Call {
    fn query(&self, k: &str) -> Option<&str> {
        self.query.iter().find(|(q, _)| q == k).map(|(_, v)| v.as_str())
    }
}

// ================================================================== listener

/// Starts the listener once (Phones turned on); later calls do nothing.
pub fn start(hub: Arc<Hub>, tx: Sender<crate::control::Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    if hub.started.swap(true, Ordering::SeqCst) {
        return;
    }
    // Keys known here, for handshakes from the internet (tls::KnownClient).
    {
        let hub = hub.clone();
        let _ = crate::tls::KNOWN.set(Box::new(move |fp: &str| hub.tokens.lock().unwrap().iter().any(|t| t.fp == fp) || hub.mesh.allowed_fp(fp).is_some()));
    }
    // The key is made now (not on the first phone), so the pairing QR can show it.
    if let Err(e) = crate::tls::my_server() {
        eprintln!("harbor: no TLS identity, only 127.0.0.1 will work: {e}");
    }
    // The router opens the port for the internet (portmap.rs), unless Settings says not to.
    if std::env::var("HARBOR_LISTEN").is_err() {
        crate::portmap::start(*hub.port.lock().unwrap(), || crate::store::Store::open().ok().and_then(|s| s.get("net_map")).as_deref() != Some("0"));
    }
    std::thread::spawn(move || {
        let port = *hub.port.lock().unwrap();
        let mut bound: Vec<String> = vec![];
        loop {
            // HARBOR_LISTEN=127.0.0.1 (test instances) or chosen addresses; else every interface.
            let want: Vec<String> = match std::env::var("HARBOR_LISTEN") {
                Ok(l) => l.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
                Err(_) => vec!["::".into(), "0.0.0.0".into()],
            };
            let mut error = String::new();
            let todo: Vec<String> = want.into_iter().filter(|ip| !bound.contains(ip)).collect();
            for ip in &todo {
                match TcpListener::bind((ip.as_str(), port)) {
                    Ok(l) => {
                        bound.push(ip.clone());
                        let (hub, tx, wake) = (hub.clone(), tx.clone(), wake.clone());
                        std::thread::spawn(move || accept(l, hub, tx, wake));
                    }
                    // "::" is dual-stack on most systems: then 0.0.0.0 is already ours.
                    Err(_) if ip == "0.0.0.0" && bound.iter().any(|b| b == "::") => bound.push(ip.clone()),
                    Err(e) => error = format!("{ip}:{port}: {e}"),
                }
            }
            let addrs = phone_addrs(port);
            let changed = hub.net.lock().unwrap().addrs != addrs;
            *hub.net.lock().unwrap() = Net { addrs, bound: bound.clone(), error };
            if changed {
                // New addresses (Wi-Fi, a new IPv6 prefix): phones reload the state and see them,
                // and the network hears it now.
                hub.touch(None, true);
                crate::discover::announce_now();
            }
            wake();
            // Addresses change (Wi-Fi, DHCP): look again now and then.
            std::thread::sleep(Duration::from_secs(20));
        }
    });
}

/// Where phones should try this PC, in order: its network's addresses (IPv4), the port the router
/// maps for the internet ("ip:port" when it's another port), then IPv6, then Tailscale's.
pub fn phone_addrs(port: u16) -> Vec<String> {
    let all = crate::tls::lan_addrs();
    let mut v: Vec<String> = all.iter().filter(|a| a.is_ipv4() && !crate::tls::tailnet_ip(**a)).map(|a| a.to_string()).collect();
    if let Some(p) = crate::portmap::public_addr().and_then(|p| p.parse::<std::net::SocketAddr>().ok()) {
        v.push(if p.port() == port { p.ip().to_string() } else { p.to_string() });
    }
    // A dynamic DNS name the user set (it follows the address when that changes).
    if let Some(n) = crate::portmap::public_name(port) {
        v.push(n);
    }
    v.extend(all.iter().filter(|a| a.is_ipv6() || crate::tls::tailnet_ip(**a)).map(|a| a.to_string()));
    v
}

/// Whether `/app.apk` is served: to anyone on this network, and from the internet only with a
/// session (or to a phone paired before three factors, so it can update and then upgrade).
fn apk_allowed(public: bool, who: &Result<(String, Option<crate::phoneauth::Level>), &str>) -> bool {
    !public || matches!(who, Ok((_, None | Some(crate::phoneauth::Level::Legacy))))
}

/// Who makes a call: the pairing token and, for a token alone, what it may do (None: a session
/// with all three factors).
pub fn caller(hub: &Hub, peer: &Peer, req: &Request) -> Result<(String, Option<crate::phoneauth::Level>), &'static str> {
    if req.header("x-harbor-session").is_some() {
        let Via::Tls(Some(fp)) = &peer.via else { return Err("a session without TLS") };
        let token = hub.auth3.verify(req, fp, &crate::tls::my_fp(), peer.x.as_ref())?;
        // Revoked meanwhile (here or on another PC of the mesh): its sessions end now.
        if !hub.tokens.lock().unwrap().iter().any(|t| t.token == token && t.secured() && t.fp == *fp) {
            hub.auth3.drop_token(&token);
            return Err("session of a removed pairing");
        }
        return Ok((token, None));
    }
    let t = req.bearer().ok_or("no token")?;
    hub.auth(t, &peer.via).map(|l| (t.to_string(), Some(l)))
}

/// How a connection reached the listener.
#[derive(Clone, Debug, PartialEq)]
pub enum Via {
    /// TLS, with the fingerprint of the client's key if it showed one.
    Tls(Option<String>),
    /// Plain HTTP from 127.0.0.1.
    Loopback,
    /// Plain HTTP over Tailscale from a client that hasn't upgraded (tls::legacy).
    Legacy,
    /// Plain HTTP from anywhere else: answered with an error only.
    Refused,
}

/// Who is on the other end of a connection.
#[derive(Clone, Debug)]
pub struct Peer {
    pub ip: std::net::IpAddr,
    pub via: Via,
    /// The TLS exporter of the connection (phoneauth::EXPORTER_LABEL).
    pub x: Option<[u8; 32]>,
}

/// Phones' connections at once (each long-polls on one).
static CONNS: Conns = Conns::new(64);
/// Failed authentications per address: past it, connections are closed without a word.
static FAILS: std::sync::LazyLock<crate::tls::Throttle> = std::sync::LazyLock::new(|| crate::tls::Throttle::new(30, Duration::from_secs(60)));

/// Connections at once per address (IPv6: per /64), so one device can't take every slot; from
/// the internet fewer, and all internet sources together at most [`PUBLIC`].
const PER_HOST: usize = 12;
const PER_PUBLIC_HOST: usize = 8;
static PUBLIC: Conns = Conns::new(24);
static HOSTS: std::sync::LazyLock<Mutex<HashMap<std::net::IpAddr, usize>>> = std::sync::LazyLock::new(Default::default);

/// A connection's place among its host's, given back when dropped.
pub struct HostSlot(std::net::IpAddr);

impl HostSlot {
    pub fn take(ip: std::net::IpAddr) -> Option<HostSlot> {
        let k = crate::tls::scope_key(ip);
        let mut h = HOSTS.lock().unwrap();
        let n = h.entry(k).or_insert(0);
        let cap = if crate::tls::private_ip(ip) { PER_HOST } else { PER_PUBLIC_HOST };
        if *n >= cap {
            return None;
        }
        *n += 1;
        Some(HostSlot(k))
    }
}

impl Drop for HostSlot {
    fn drop(&mut self) {
        let mut h = HOSTS.lock().unwrap();
        if let Some(n) = h.get_mut(&self.0) {
            *n -= 1;
            if *n == 0 {
                h.remove(&self.0);
            }
        }
    }
}

fn accept(l: TcpListener, hub: Arc<Hub>, tx: Sender<crate::control::Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    for stream in l.incoming().flatten() {
        if !hub.active() {
            continue; // dropped: closed without a word
        }
        let Some(ip) = stream.peer_addr().ok().map(|a| a.ip()) else { continue };
        let Some(host) = HostSlot::take(ip) else { continue };
        let public = if crate::tls::private_ip(ip) { None } else { Some(PUBLIC.take()) };
        if matches!(public, Some(None)) {
            continue; // the internet's share is full
        }
        let Some(slot) = CONNS.take() else { continue };
        let (hub, tx, wake) = (hub.clone(), tx.clone(), wake.clone());
        std::thread::spawn(move || {
            serve(stream, &hub, &tx, &wake);
            drop((slot, host, public));
        });
    }
}

fn serve(stream: TcpStream, hub: &Hub, tx: &Sender<crate::control::Incoming>, wake: &(impl Fn() + Send + Sync)) {
    let Ok(ip) = stream.peer_addr().map(|a| crate::tls::canonical(a.ip())) else { return };
    let local = stream.local_addr().map(|a| crate::tls::canonical(a.ip())).unwrap_or(ip);
    if FAILS.over(ip) {
        return;
    }
    // (HARBOR_TEST_PUBLIC: tests on one PC treat every source as the internet.)
    let public = !crate::tls::private_ip(ip) || std::env::var("HARBOR_TEST_PUBLIC").is_ok();
    // From the internet: the handshake needs a known key (tls::KnownClient), a shorter deadline,
    // and plain HTTP gets nothing at all.
    let config = || if public { crate::tls::my_public_server().ok() } else { crate::tls::my_server().ok() };
    let Ok(conn) = crate::tls::accept(stream, config, if public { Duration::from_secs(5) } else { HEAD_WAIT }, Duration::from_secs(30)) else {
        if public {
            FAILS.hit(ip);
        }
        return;
    };
    // Only this TLS connection has it: phones bind their calls' MACs to it (phoneauth.rs).
    let x = conn.exporter();
    let via = if conn.is_tls() {
        Via::Tls(conn.peer_fp())
    } else if ip.is_loopback() {
        Via::Loopback
    } else if crate::tls::legacy(local, ip) {
        Via::Legacy
    } else {
        Via::Refused
    };
    // From the open internet (a public IPv6, a forwarded port) only a key already known here
    // gets an answer: pairing and the APK are for the local network.
    if public {
        let known = match &via {
            Via::Tls(Some(fp)) => hub.tokens.lock().unwrap().iter().any(|t| t.fp == *fp) || hub.mesh.allowed_fp(fp).is_some(),
            _ => false,
        };
        if !known {
            return;
        }
        crate::portmap::reached(ip);
    }
    let peer = Peer { ip, via, x };
    let mut r = BufReader::new(conn);
    let req = match read_head(&mut r) {
        Ok(q) => q,
        Err((s, m)) => return send_json(r.get_mut(), s, &json!({ "error": m })),
    };
    r.get_ref().clear_deadline();
    if peer.via == Via::Refused {
        return send_json(r.get_mut(), 426, &json!({ "error": "Harbor answers other devices over TLS only" }));
    }
    let segs = req.segments();
    // A stream to another PC of the mesh through this one (relay.rs).
    if segs.first() == Some(&"relay") && req.method == "POST" {
        if !hub.mesh.on.load(Ordering::SeqCst) {
            return send_json(r.get_mut(), 403, &json!({ "error": "this PC doesn't share its chats (Settings › Devices)" }));
        }
        return crate::relay::serve(r, &peer, &req, hub);
    }
    // The phone app this PC serves, for a PC of the mesh whose is older (mesh.rs `phones_loop`).
    if segs == ["mesh", "v1", "app.apk"] && req.method == "GET" {
        let paired = matches!(&peer.via, Via::Tls(Some(fp)) if hub.mesh.allowed_fp(fp).is_some());
        if !paired || !hub.mesh.on.load(Ordering::SeqCst) {
            FAILS.hit(ip);
            return send_json(r.get_mut(), 403, &json!({ "error": "only for paired PCs" }));
        }
        return serve_apk(r.get_mut(), false);
    }
    // An image of one of this PC's chats, for a phone that reads it through another PC of the
    // mesh (`/v1/image` there): only paired PCs, only image files.
    if segs == ["mesh", "v1", "image"] && req.method == "GET" {
        if !crate::mesh::admitted(hub, &peer, &req) {
            FAILS.hit(ip);
            return send_json(r.get_mut(), 403, &json!({ "error": "only for paired PCs" }));
        }
        return serve_image(r.get_mut(), req.query("path").unwrap_or(""), req.query("max").and_then(|m| m.parse().ok()));
    }
    // Another PC's Harbor (mesh.rs): known by its key, not a token.
    if segs.first() == Some(&"mesh") {
        let reply = crate::mesh::serve(&peer, &req, &mut r, hub, tx, wake);
        if reply.status == 401 || reply.status == 403 {
            FAILS.hit(ip);
        }
        return send_json(r.get_mut(), reply.status, &reply.body);
    }
    if !hub.enabled.load(Ordering::SeqCst) {
        return; // phones are off: closed without a word
    }
    use crate::phoneauth::Level;
    // Who calls: a session (all three factors, every call MACed), or a token alone at its level.
    let who = caller(hub, &peer, &req);
    if matches!(req.method.as_str(), "GET" | "HEAD") && segs == ["app.apk"] && apk_allowed(public, &who) {
        return serve_apk(r.get_mut(), req.method == "HEAD");
    }
    let (token, level) = match who {
        Ok(w) => w,
        Err(why) => {
            FAILS.hit(ip);
            hub.auth3.note(ip, why);
            return send_json(r.get_mut(), 401, &json!({ "error": crate::phoneauth::REFUSED, "rekey": true }));
        }
    };
    if let Some(level) = level.filter(|l| *l != Level::Loopback) {
        // Pairing, the upgrade and starting a session: the token, the TLS key and the codes or
        // the session's proofs (phoneauth.rs).
        if req.method == "POST" && (matches!(segs.as_slice(), ["v1", "pair" | "session", _]) || segs == ["v1", "alive"]) {
            let Ok(body) = read_body(&mut r, req.len, 16 << 10) else { return send_json(r.get_mut(), 400, &json!({ "error": "bad body" })) };
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let reply = crate::phoneauth::serve(hub, &peer, peer.x.as_ref(), &req, &segs, &token, level, &body, wake);
            if reply.status == 401 {
                FAILS.hit(ip);
            }
            return send_json(r.get_mut(), reply.status, &reply.body);
        }
        // A pairing from before three factors may still update the app, then upgrade.
        if level == Level::Legacy && req.method == "GET" && segs == ["v1", "app"] {
            return send_json(r.get_mut(), 200, &app_info());
        }
        FAILS.hit(ip);
        hub.auth3.note(ip, if level == Level::Legacy { "a pairing from before three factors" } else { "a token without a session" });
        let body = if level == Level::Legacy {
            json!({ "error": "This PC now asks for three factors: open Harbor on the phone and confirm the code it shows here, in Settings › Phones.", "upgrade": true })
        } else {
            json!({ "error": crate::phoneauth::REFUSED, "rekey": true })
        };
        return send_json(r.get_mut(), 401, &body);
    }
    let device: String = req.header("x-harbor-device").unwrap_or("").chars().take(60).collect();
    let global = req.header("x-harbor-ids") == Some("global");
    hub.seen.lock().unwrap().insert(token.clone(), (device.clone(), store::now()));
    hub.ips.lock().unwrap().insert(token.clone(), ip.to_string());
    // Its app's version: said from 0.19; an app that picks up sends is 0.17 or newer.
    let said = req.header("x-harbor-app").and_then(|v| v.trim().parse::<i64>().ok()).filter(|c| *c > 0);
    let inbox = segs.first() == Some(&"v1") && segs.get(1) == Some(&"inbox");
    if said.is_some() || inbox {
        let mut apps = hub.apps.lock().unwrap();
        let had = apps.get(&token).copied().unwrap_or(0);
        apps.insert(token.clone(), said.unwrap_or(had.max(APP_INBOX)));
    }
    let w = r.get_mut();
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["v1", "app"]) => send_json(w, 200, &app_info()),
        ("GET", ["v1", "events"]) => {
            let since = req.query("since").and_then(|s| s.parse().ok()).unwrap_or(0);
            let (rev, chats, mut state) = hub.wait(since, POLL);
            let chats: Vec<Value> = if global {
                let gids = hub.mesh.gids.lock().unwrap();
                // A chat too new to have its gid listed: the phone reloads the state.
                state |= chats.iter().any(|c| !gids.contains_key(c));
                chats.iter().filter_map(|c| gids.get(c)).map(|g| json!(g)).collect()
            } else {
                chats.iter().map(|c| json!(c)).collect()
            };
            let inbox = hub.inbox_for(&hub.group_of(&token)).len();
            send_json(w, 200, &json!({ "rev": rev, "changed_chats": chats, "state_changed": state, "inbox": inbox }));
        }
        // What this PC sent the phone (Devices › Send).
        ("GET", ["v1", "inbox"]) => send_json(w, 200, &json!({ "items": hub.inbox_for(&hub.group_of(&token)) })),
        ("GET", ["v1", "inbox", id]) => serve_parcel(w, hub, &hub.group_of(&token), id),
        ("POST", ["v1", "inbox", id, "done"]) => {
            let body: Value = read_body(&mut r, req.len, 4096).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
            let error = body["error"].as_str().filter(|e| !e.is_empty()).map(|e| format!("On the phone: {}", e.chars().take(300).collect::<String>()));
            let found = hub.delivered(&hub.group_of(&token), id, error);
            send_json(r.get_mut(), if found { 200 } else { 404 }, &if found { json!({ "ok": true }) } else { json!({ "error": "nothing waits with that id" }) });
        }
        // The PCs of the mesh, with this phone's token on each (mesh.rs).
        ("GET", ["v1", "hubs"]) => send_json(w, 200, &crate::mesh::hubs(hub, &token, None)),
        // A phone without a screen lock has one now: its presence key, the third factor.
        ("POST", ["v1", "pair", "presence"]) => {
            let body: Value = read_body(&mut r, req.len, 4096).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
            let reply = crate::phoneauth::add_presence(hub, &peer, &req, &token, &body);
            send_json(r.get_mut(), reply.status, &reply.body)
        }
        // The phone hands each other PC its own pairing secret (derived from this one's).
        ("POST", ["v1", "hubs"]) => {
            let body: Value = read_body(&mut r, req.len, 64 << 10).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
            let empty = serde_json::Map::new();
            let secrets = body["secrets"].as_object().unwrap_or(&empty);
            send_json(r.get_mut(), 200, &crate::mesh::hubs(hub, &token, Some(secrets)));
        }
        ("POST", ["v1", "chats", c, "typing"]) => {
            let Some(chat) = c.parse::<i64>().ok().or_else(|| hub.mesh.by_gid(c)) else { return send_json(w, 404, &json!({ "error": "no such chat" })) };
            let body: Value = read_body(&mut r, req.len, 4096).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
            let w = r.get_mut();
            let on = body["typing"].as_bool().unwrap_or(true);
            let kind = if body["kind"].as_str() == Some("pc") { "pc" } else { "phone" };
            let label = if !device.is_empty() {
                device.clone()
            } else {
                hub.tokens.lock().unwrap().iter().find(|t| t.token == token).map(|t| t.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| if kind == "pc" { "A PC".into() } else { "Phone".into() })
            };
            // Another PC's chat: its PC keeps who types in it (mesh.rs).
            if crate::mesh::forward_lease(hub, chat, false, &device_id(&token), kind, &label, on) {
                return send_json(w, 200, &json!({ "ok": true }));
            }
            if hub.set_typing(chat, &device_id(&token), kind, &label, on) {
                wake(); // this PC's window shows it
            }
            send_json(w, 200, &json!({ "ok": true }));
        }
        ("GET", ["v1", "image"]) => {
            let path = req.query("path").unwrap_or("");
            let max = req.query("max").and_then(|m| m.parse().ok());
            // Another PC's chat (a copy here): its images are that PC's files.
            let chat = req.query("chat").and_then(|c| c.parse::<i64>().ok().or_else(|| hub.mesh.by_gid(c)));
            if !Path::new(path).is_file() {
                if let Some((ctype, bytes)) = chat.and_then(|c| crate::mesh::home_image(hub, c, path, max)) {
                    let _ = w.write_all(response(200, &ctype, bytes.len(), "").as_bytes());
                    let _ = w.write_all(&bytes);
                    return;
                }
            }
            serve_image(w, path, max)
        }
        // A phone without a recogniser of its own: its recording (WAV, 16-bit mono), transcribed
        // here with whisper.cpp (voice.rs), on this connection's thread.
        ("POST", ["v1", "transcribe"]) => {
            if req.len > MAX_AUDIO {
                return send_json(w, 413, &json!({ "error": "recording too long" }));
            }
            let mut body = vec![0u8; req.len];
            if r.read_exact(&mut body).is_err() {
                return send_json(r.get_mut(), 400, &json!({ "error": "short body" }));
            }
            let lang = req.query("lang").map(String::from).filter(|l| !l.is_empty() && l != "default").unwrap_or_else(|| crate::voice::config().0);
            let path = std::env::temp_dir().join(format!("harbor-phone-voice-{}.wav", crate::store::new_uuid()));
            let res = std::fs::write(&path, &body).map_err(|e| e.to_string()).and_then(|_| crate::voice::transcribe(&path, &lang));
            let _ = std::fs::remove_file(&path);
            match res {
                Ok(text) => send_json(r.get_mut(), 200, &json!({ "text": text })),
                Err(e) => send_json(r.get_mut(), 409, &json!({ "error": e })),
            }
        }
        ("POST", ["v1", "upload"]) => {
            let up = upload_to(&mut r, &upload_request(&req, |g| hub.mesh.by_gid(g)), &uploads_dir());
            send_json(r.get_mut(), up.status, &up.body);
        }
        _ => {
            if req.len > MAX_JSON {
                return send_json(w, 413, &json!({ "error": "body too large" }));
            }
            let mut body = vec![0u8; req.len];
            if r.read_exact(&mut body).is_err() {
                return send_json(r.get_mut(), 400, &json!({ "error": "short body" }));
            }
            let w = r.get_mut();
            let body = if body.iter().all(u8::is_ascii_whitespace) {
                Value::Null
            } else {
                match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(e) => return send_json(w, 400, &json!({ "error": format!("bad JSON: {e}") })),
                }
            };
            let (rtx, rrx) = channel();
            let call = Call {
                method: req.method.clone(),
                path: segs.iter().map(|s| s.to_string()).collect(),
                query: req.query.clone(),
                body,
                token,
                device,
                reply: rtx,
                global,
            };
            if tx.send(crate::control::Incoming::Api(call)).is_err() {
                return send_json(w, 503, &json!({ "error": "Harbor is closing" }));
            }
            wake();
            let reply = rrx.recv_timeout(UI_WAIT).unwrap_or_else(|_| err(503, "Harbor did not answer in time"));
            send_json(w, reply.status, &reply.body);
        }
    }
}

fn app_info() -> Value {
    let code = crate::update::apk().map_or(0, |(_, c)| c);
    json!({ "version_code": code, "url": "/app.apk" })
}

fn serve_apk(w: &mut impl Write, head_only: bool) {
    let Some((path, _)) = crate::update::apk() else {
        return send_json(w, 404, &json!({ "error": "this Harbor has no phone app yet (Settings › Phones › Download)" }));
    };
    let Ok(mut f) = std::fs::File::open(&path) else { return send_json(w, 404, &json!({ "error": "the app file is unreadable" })) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0) as usize;
    let head = response(200, "application/vnd.android.package-archive", len, "Content-Disposition: attachment; filename=\"harbor.apk\"\r\n");
    if w.write_all(head.as_bytes()).is_ok() && !head_only {
        let _ = std::io::copy(&mut f, w);
    }
}

/// A parcel's bytes, reporting to its sender how far the phone got.
fn serve_parcel(w: &mut impl Write, hub: &Hub, group: &str, id: &str) {
    let found = hub.inbox.lock().unwrap().iter().find(|p| p.group == group && p.id == id).map(|p| (p.path.clone(), p.report.clone()));
    let Some((Some(path), report)) = found else { return send_json(w, 404, &json!({ "error": "nothing waits with that id" })) };
    let Ok(mut f) = std::fs::File::open(&path) else { return send_json(w, 404, &json!({ "error": "the file is gone from the PC" })) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if w.write_all(response(200, "application/octet-stream", len as usize, "").as_bytes()).is_err() {
        return;
    }
    let (mut buf, mut sent, mut told) = (vec![0u8; 1 << 16], 0u64, Instant::now());
    while let Ok(n) = f.read(&mut buf) {
        if n == 0 || w.write_all(&buf[..n]).is_err() {
            break;
        }
        sent += n as u64;
        if told.elapsed() > Duration::from_millis(200) {
            report(sent, false, None);
            told = Instant::now();
        }
    }
    report(sent, false, None);
}

/// An image a card shows (`image_url`): the file, or a JPEG at most `max` px on its longer
/// side. Image files only; the token already lets its phone run agents on this PC.
fn serve_image(w: &mut impl Write, path: &str, max: Option<u32>) {
    let p = Path::new(path);
    if !p.is_absolute() || !crate::images::is_image(path) || !p.is_file() {
        return send_json(w, 404, &json!({ "error": "no such image" }));
    }
    let Some(bytes) = std::fs::read(p).ok().filter(|b| b.len() <= 40 << 20) else {
        return send_json(w, 404, &json!({ "error": "unreadable image" }));
    };
    let (body, ctype) = match max.map(|m| m.clamp(16, 2048)) {
        Some(m) => match image::load_from_memory(&bytes) {
            Ok(img) => {
                let small = if img.width() > m || img.height() > m { img.thumbnail(m, m) } else { img };
                let mut out = std::io::Cursor::new(vec![]);
                match image::DynamicImage::ImageRgb8(small.to_rgb8()).write_to(&mut out, image::ImageFormat::Jpeg) {
                    Ok(()) => (out.into_inner(), "image/jpeg"),
                    Err(_) => return send_json(w, 500, &json!({ "error": "could not scale the image" })),
                }
            }
            Err(_) => return send_json(w, 415, &json!({ "error": "not an image Harbor can read" })),
        },
        None => {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let ctype = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => "application/octet-stream",
            };
            (bytes, ctype)
        }
    };
    let _ = w.write_all(response(200, ctype, body.len(), "").as_bytes());
    let _ = w.write_all(&body);
}

pub fn uploads_dir() -> PathBuf {
    store::data_dir().join("uploads")
}

/// A safe file name: the last path part, no control characters, at most 100 characters.
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let s: String = base.chars().filter(|c| !c.is_control()).take(100).collect();
    let s = s.trim().trim_start_matches('.').to_string();
    if s.is_empty() { "file".into() } else { s }
}

/// An upload's `chat` as this hub's id: the app names chats by gid (`X-Harbor-Ids: global`).
/// A chat it doesn't know files the upload under pending/; a send names it by its id anyway.
fn upload_request(req: &Request, by_gid: impl Fn(&str) -> Option<i64>) -> Request {
    let mut q = req.clone();
    q.query.retain_mut(|(k, v)| {
        if k != "chat" || v.parse::<i64>().is_ok() {
            return true;
        }
        match by_gid(v) {
            Some(id) => {
                *v = id.to_string();
                true
            }
            None => false,
        }
    });
    q
}

pub fn upload_to(r: &mut impl Read, req: &Request, base: &Path) -> Reply {
    if req.len > MAX_UPLOAD {
        return err(413, "files up to 200 MB");
    }
    let sub = match req.query("chat").map(|c| c.parse::<i64>()) {
        Some(Ok(c)) => c.to_string(),
        Some(Err(_)) => return err(400, "bad chat id"),
        None => "pending".into(),
    };
    let dir = base.join(&sub);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return err(500, e.to_string());
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let name = safe_name(req.query("name").unwrap_or("file"));
    // Never over another upload, even one of the same name in the same millisecond.
    let mut n = 0;
    let (file, created) = loop {
        let file = if n == 0 { format!("{stamp}-{name}") } else { format!("{stamp}-{n}-{name}") };
        match std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(&file)) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && n < 1000 => n += 1,
            r => break (file, r),
        }
    };
    let path = dir.join(&file);
    let res = created.and_then(|mut f| {
        let n = std::io::copy(&mut r.take(req.len as u64), &mut f)?;
        if n as usize != req.len { Err(std::io::Error::other("short body")) } else { Ok(()) }
    });
    match res {
        Ok(()) => Reply { status: 201, body: json!({ "id": format!("{sub}/{file}"), "path": path.to_string_lossy() }) },
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            err(400, format!("upload failed: {e}"))
        }
    }
}

/// The upload id of a file under uploads/ (None for other files).
pub fn upload_id(f: &Path) -> Option<String> {
    let rel = f.strip_prefix(uploads_dir()).ok()?;
    let id = rel.to_str()?.to_string();
    resolve_upload(&id).map(|_| id)
}

/// The file of an upload id ("<chat or pending>/<file>"); None for anything outside uploads/.
pub fn resolve_upload(id: &str) -> Option<PathBuf> {
    let p = Path::new(id);
    let parts: Vec<_> = p.components().collect();
    if parts.len() != 2 || !parts.iter().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return None;
    }
    let f = uploads_dir().join(p);
    f.is_file().then_some(f)
}

// ================================================================== markdown → blocks

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
pub struct Span {
    pub text: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub code: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub strike: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Heading { level: u8, spans: Vec<Span> },
    Paragraph { spans: Vec<Span> },
    Code { lang: String, text: String },
    List { ordered: bool, start: u64, items: Vec<Vec<Block>> },
    Quote { blocks: Vec<Block> },
    Rule,
    /// The first row is the header.
    Table { rows: Vec<Vec<Vec<Span>>> },
}

enum Container {
    Blocks(Vec<Block>),
    Quote(Vec<Block>),
    List { ordered: bool, start: u64, items: Vec<Vec<Block>> },
    Item(Vec<Block>),
}

#[derive(PartialEq)]
enum Inline {
    Para,
    Heading(u8),
    Cell,
}

#[derive(Default)]
struct Conv {
    stack: Vec<Container>,
    inline: Option<(Inline, Vec<Span>)>,
    code: Option<(String, String)>,
    table: Option<Vec<Vec<Vec<Span>>>>,
    bold: u32,
    italic: u32,
    strike: u32,
    links: Vec<String>,
}

impl Conv {
    fn push_block(&mut self, b: Block) {
        match self.stack.last_mut() {
            Some(Container::Blocks(v) | Container::Quote(v) | Container::Item(v)) => v.push(b),
            Some(Container::List { items, .. }) => items.push(vec![b]),
            None => self.stack.push(Container::Blocks(vec![b])),
        }
    }

    fn flush(&mut self) {
        let Some((kind, spans)) = self.inline.take() else { return };
        match kind {
            Inline::Cell => {
                if let Some(row) = self.table.as_mut().and_then(|t| t.last_mut()) {
                    row.push(spans);
                }
            }
            _ if spans.iter().all(|s| s.text.trim().is_empty()) => {}
            Inline::Para => self.push_block(Block::Paragraph { spans }),
            Inline::Heading(level) => self.push_block(Block::Heading { level, spans }),
        }
    }

    fn span(&mut self, text: &str, code: bool) {
        if let Some((_, t)) = &mut self.code {
            t.push_str(text);
            return;
        }
        // Text straight in a list item (a tight list) is a paragraph of its own.
        let (_, spans) = self.inline.get_or_insert((Inline::Para, vec![]));
        let s = Span {
            text: text.to_string(),
            bold: self.bold > 0,
            italic: self.italic > 0,
            code,
            strike: self.strike > 0,
            link: self.links.last().cloned(),
        };
        match spans.last_mut() {
            Some(l) if Span { text: String::new(), ..l.clone() } == Span { text: String::new(), ..s.clone() } => l.text.push_str(&s.text),
            _ => spans.push(s),
        }
    }
}

/// Markdown as the block model the phone draws with native views.
pub fn blocks(md: &str) -> Vec<Block> {
    use pulldown_cmark::{CodeBlockKind, Event as E, Options, Parser, Tag, TagEnd};
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut c = Conv { stack: vec![Container::Blocks(vec![])], ..Default::default() };
    for ev in Parser::new_ext(md, opts) {
        match ev {
            E::Start(tag) => match tag {
                Tag::Paragraph | Tag::HtmlBlock => {
                    c.flush();
                    c.inline = Some((Inline::Para, vec![]));
                }
                Tag::Heading { level, .. } => {
                    c.flush();
                    c.inline = Some((Inline::Heading(level as u8), vec![]));
                }
                Tag::BlockQuote(_) => {
                    c.flush();
                    c.stack.push(Container::Quote(vec![]));
                }
                Tag::CodeBlock(kind) => {
                    c.flush();
                    let lang = match kind {
                        CodeBlockKind::Fenced(info) => info.split([' ', ',', '{']).next().unwrap_or("").to_string(),
                        CodeBlockKind::Indented => String::new(),
                    };
                    c.code = Some((lang, String::new()));
                }
                Tag::List(start) => {
                    c.flush();
                    c.stack.push(Container::List { ordered: start.is_some(), start: start.unwrap_or(1), items: vec![] });
                }
                Tag::Item => {
                    c.flush();
                    c.stack.push(Container::Item(vec![]));
                }
                Tag::Table(_) => {
                    c.flush();
                    c.table = Some(vec![]);
                }
                Tag::TableHead | Tag::TableRow => {
                    if let Some(t) = &mut c.table {
                        t.push(vec![]);
                    }
                }
                Tag::TableCell => c.inline = Some((Inline::Cell, vec![])),
                Tag::Emphasis => c.italic += 1,
                Tag::Strong => c.bold += 1,
                Tag::Strikethrough => c.strike += 1,
                Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. } => c.links.push(dest_url.to_string()),
                _ => {}
            },
            E::End(tag) => match tag {
                TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::HtmlBlock | TagEnd::TableCell => c.flush(),
                TagEnd::BlockQuote(_) => {
                    c.flush();
                    if let Some(Container::Quote(blocks)) = c.stack.pop() {
                        c.push_block(Block::Quote { blocks });
                    }
                }
                TagEnd::CodeBlock => {
                    if let Some((lang, mut text)) = c.code.take() {
                        if text.ends_with('\n') {
                            text.pop();
                        }
                        c.push_block(Block::Code { lang, text });
                    }
                }
                TagEnd::List(_) => {
                    c.flush();
                    if let Some(Container::List { ordered, start, items }) = c.stack.pop() {
                        c.push_block(Block::List { ordered, start, items });
                    }
                }
                TagEnd::Item => {
                    c.flush();
                    if let Some(Container::Item(blocks)) = c.stack.pop() {
                        match c.stack.last_mut() {
                            Some(Container::List { items, .. }) => items.push(blocks),
                            _ => blocks.into_iter().for_each(|b| c.push_block(b)),
                        }
                    }
                }
                TagEnd::Table => {
                    c.flush();
                    if let Some(rows) = c.table.take() {
                        c.push_block(Block::Table { rows });
                    }
                }
                TagEnd::Emphasis => c.italic = c.italic.saturating_sub(1),
                TagEnd::Strong => c.bold = c.bold.saturating_sub(1),
                TagEnd::Strikethrough => c.strike = c.strike.saturating_sub(1),
                TagEnd::Link | TagEnd::Image => {
                    c.links.pop();
                }
                _ => {}
            },
            E::Text(t) | E::Html(t) | E::InlineHtml(t) => c.span(&t, false),
            E::Code(t) | E::InlineMath(t) | E::DisplayMath(t) => c.span(&t, true),
            E::SoftBreak => c.span(" ", false),
            E::HardBreak => c.span("\n", false),
            E::Rule => {
                c.flush();
                c.push_block(Block::Rule);
            }
            E::TaskListMarker(done) => c.span(if done { "☑ " } else { "☐ " }, false),
            E::FootnoteReference(t) => c.span(&format!("[^{t}]"), false),
        }
    }
    c.flush();
    // Whatever a broken document left open folds into its parent.
    while c.stack.len() > 1 {
        match c.stack.pop() {
            Some(Container::Quote(blocks)) => c.push_block(Block::Quote { blocks }),
            Some(Container::List { ordered, start, items }) => c.push_block(Block::List { ordered, start, items }),
            Some(Container::Item(blocks) | Container::Blocks(blocks)) => blocks.into_iter().for_each(|b| c.push_block(b)),
            None => {}
        }
    }
    match c.stack.pop() {
        Some(Container::Blocks(v)) => v,
        _ => vec![],
    }
}

// ================================================================== items on the wire

fn clipped(s: &str) -> String {
    if s.len() <= CLIP {
        return s.to_string();
    }
    crate::app::clip(s, CLIP)
}

fn file_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

/// Where the phone fetches an image a card shows (a ≤512 px JPEG).
pub fn image_url(path: &str) -> String {
    format!("/v1/image?path={}&max=512", url_encode(path))
}

/// One card of the shared projection (view.rs) for the phone: what the desktop draws for
/// that item, field for field. `find` lists the image files a text names.
/// A card's image addresses with `&chat=` (a gid or an id), so the PC answering can fetch an
/// image of another PC's chat from that PC (`/v1/image`).
fn with_chat(mut v: Value, chat: String) -> Value {
    if let Some(imgs) = v.get_mut("images").and_then(|i| i.as_array_mut()) {
        for i in imgs {
            if let Some(u) = i.get("url").and_then(|u| u.as_str()).map(String::from) {
                i["url"] = json!(format!("{u}&chat={}", url_encode(&chat)));
            }
        }
    }
    v
}

pub fn card_json(s: &crate::view::Shown, rev: u64, find: &mut dyn FnMut(&str) -> Vec<String>) -> Value {
    use crate::view::Card;
    let images: Vec<Value> = crate::view::images(&s.card, find).iter().map(|p| json!({ "name": file_name(p), "url": image_url(p) })).collect();
    let mut v = match &s.card {
        Card::Hidden => json!({}),
        Card::User { text, files, mentions, at, sender, .. } => json!({
            "text": text, "files": files.iter().map(|f| file_name(f)).collect::<Vec<_>>(), "images": images,
            "mentions": mentions.iter().map(|m| json!({ "from": m.from, "text": m.snippet() })).collect::<Vec<_>>(), "at": at,
            "sender": sender,
        }),
        Card::Text { text, at, forkable } => json!({ "markdown": text, "blocks": blocks(text), "images": images, "at": at, "forkable": forkable }),
        Card::Thinking { text } => json!({ "text": text }),
        Card::Tool { label, summary, input, result, is_error } => json!({
            "label": label, "summary": summary, "input": clipped(input),
            "result": result.map(clipped), "done": result.is_some(), "is_error": is_error, "images": images,
        }),
        Card::Footer { text, at } => json!({ "text": text, "at": at }),
        Card::ForkedFrom { chat, seq } => json!({ "chat": chat, "seq": seq }),
        Card::Notice { icon, text, detail, markdown, url } => json!({ "icon": icon, "text": text, "detail": clipped(detail), "detail_markdown": markdown, "url": url }),
        Card::Message { from, to, text } => json!({ "from": from, "to": to, "text": clipped(text) }),
        Card::Error { text } => json!({ "text": clipped(text) }),
    };
    v["kind"] = json!(crate::view::kind(&s.card));
    v["seq"] = json!(s.seq);
    v["rev"] = json!(rev);
    if !s.forks_after.is_empty() {
        v["forks_after"] = json!(s.forks_after);
    }
    v
}

fn hash_of(v: &impl Hash) -> u64 {
    let mut h = DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

/// What tells an item's versions apart, without serializing it: a tool's input and result
/// are set once (a result arrives, it doesn't grow), so their lengths stand in for them;
/// replies and thinking grow while they stream; the rest are small.
pub fn fingerprint(it: &Item) -> u64 {
    match it {
        Item::Tool { id, name, summary, input, result, is_error } => hash_of(&(id, name, summary, input.len(), result.as_ref().map(String::len), is_error)),
        Item::Text { text, at } => hash_of(&(1u8, text, at)),
        Item::Thinking { text } => hash_of(&(2u8, text)),
        other => hash_of(&serde_json::to_string(other).unwrap_or_default()),
    }
}

fn kind_slug(k: Kind) -> String {
    k.label().to_ascii_lowercase()
}

/// A device's icon as a name the phone knows.
fn icon_name(h: &crate::remote::Host) -> &'static str {
    if let Some((n, _)) = crate::remote::ICONS.iter().find(|(n, _)| *n == h.icon) {
        return n;
    }
    match h.os.as_str() {
        "macOS" => "laptop",
        "" if !h.found() => "terminal",
        _ => "monitor",
    }
}

/// A chat's run settings after a PATCH of account/model/effort/access/device/fast, checked
/// with the desktop composer's rules: `allowed` are the accounts it may switch to (see
/// `App::allowed_accounts`), `devices` the ids of the devices there are. Ok(None): nothing
/// asked; Ok(Some((chat, fast))): the changed chat and the hub-wide fast flag to set.
pub fn check_run(
    c: &store::Chat,
    body: &Value,
    accounts: &[providers::Account],
    allowed: &[String],
    models_for: &dyn Fn(Kind) -> Vec<providers::Model>,
    devices: &[&str],
) -> Result<Option<(store::Chat, Option<bool>)>, Reply> {
    let field = |k: &str| -> Result<Option<String>, Reply> {
        match &body[k] {
            Value::Null => Ok(None),
            Value::String(s) => Ok(Some(s.clone())),
            _ => Err(err(400, format!("{k} must be a string"))),
        }
    };
    let (account, model, effort, access, device) = (field("account")?, field("model")?, field("effort")?, field("access")?, field("device")?);
    let fast = match &body["fast"] {
        Value::Null => None,
        Value::Bool(b) => Some(*b),
        _ => return Err(err(400, "fast must be true or false")),
    };
    if [&account, &model, &effort, &access, &device].iter().all(|f| f.is_none()) && fast.is_none() {
        return Ok(None);
    }
    let kind_of = |id: &str| accounts.iter().find(|a| a.id == id).map(|a| a.kind);
    let old_kind = kind_of(&c.account).unwrap_or(Kind::Claude);
    let mut n = c.clone();
    if let Some(a) = account {
        let Some(acc) = accounts.iter().find(|x| x.id == a && x.installed()) else { return Err(err(400, format!("no account {a}"))) };
        if !allowed.contains(&a) {
            let why = if c.role == store::Role::Lead { "a lead runs on Claude".to_string() } else { format!("a started chat stays on {}", old_kind.label()) };
            return Err(err(409, format!("can't switch to {}: {why}", acc.short())));
        }
        n.account = a;
    }
    let kind = kind_of(&n.account).unwrap_or(Kind::Claude);
    let models = models_for(kind);
    match model {
        Some(m) if !models.is_empty() && !models.iter().any(|x| x.id == m) => return Err(err(400, format!("{} has no model {m}", kind.label()))),
        Some(m) => n.model = m,
        // Another provider without a model asked for: its first one, as the picker shows it.
        None if kind != old_kind => n.model = models.iter().find(|m| !m.more).or(models.first()).map(|m| m.id.clone()).unwrap_or_default(),
        None => {}
    }
    // Effort and access stay valid for the provider, as `App::set_sel` keeps them.
    match effort {
        Some(e) if !e.is_empty() && !providers::efforts(kind).iter().any(|x| x.0 == e) => return Err(err(400, format!("{} has no effort {e}", kind.label()))),
        Some(e) => n.effort = e,
        None if !n.effort.is_empty() && !providers::efforts(kind).iter().any(|x| x.0 == n.effort) => n.effort = providers::default_effort(kind).into(),
        None => {}
    }
    match access {
        Some(a) if !providers::access(kind).iter().any(|x| x.0 == a) => return Err(err(400, format!("{} has no access level {a}", kind.label()))),
        Some(a) => n.access = a,
        None if !providers::access(kind).iter().any(|x| x.0 == n.access) => n.access = providers::access(kind)[0].0.into(),
        None => {}
    }
    if let Some(d) = device.filter(|d| *d != c.device) {
        if c.started {
            return Err(err(409, "a started chat stays on the device it started on; start a new chat to use another"));
        }
        if !d.is_empty() && kind != Kind::Claude {
            return Err(err(400, "only Claude chats run on another device"));
        }
        if !d.is_empty() && !devices.contains(&d.as_str()) {
            return Err(err(400, format!("no device {d}")));
        }
        n.device = d;
    }
    if fast == Some(true) && !providers::has_fast(kind) {
        return Err(err(400, format!("{} has no fast mode", kind.label())));
    }
    Ok(Some((n, fast)))
}

// ================================================================== the UI thread's side

impl App {
    /// A chat changed (items or turn): long-polls wake.
    pub fn api_touch(&self, chat: i64) {
        if self.api.hub.active() {
            self.api.hub.touch(Some(chat), false);
        }
    }

    /// Once per frame: what `/v1/state` would say, per chat and for the rest; changes wake.
    pub fn api_tick(&mut self) {
        if !self.api.hub.active() {
            return;
        }
        self.local_typing();
        let mut subs: HashMap<i64, usize> = HashMap::new();
        for c in self.chats.iter().filter(|c| c.role == store::Role::Sub && self.turns.contains_key(&c.id)) {
            if let Some(p) = c.parent {
                *subs.entry(p).or_default() += 1;
            }
        }
        let mut seen = HashMap::with_capacity(self.chats.len());
        let mut changed = vec![];
        for c in &self.chats {
            // A lead's bars (waiting for sub-agents, a usage limit) change with it too.
            let n = subs.get(&c.id).copied().unwrap_or(0);
            let strip = if n > 0 { self.strip_key(c.id) } else { vec![] };
            let bars = (n, strip, self.paused(c.id).map(|p| p.at), self.queued(c.id).iter().filter(|q| q.written).count());
            let h = hash_of(&(&c.title, c.settled, c.updated, &c.account, &c.model, &c.effort, &c.access, &c.device, c.repo_id, (self.is_running(c.id), self.team_working(c)), self.queued_count(c.id), (bars, self.writable_chat(c))));
            if self.api.chats.get(&c.id) != Some(&h) {
                changed.push(c.id);
            }
            seen.insert(c.id, h);
        }
        let gone: Vec<i64> = self.api.chats.keys().filter(|k| !seen.contains_key(k)).copied().collect();
        // This PC's own chats deleted (by any path): peers drop their copies.
        for id in &gone {
            if !self.api.hub.mesh.foreign.lock().unwrap().contains(id) {
                self.mesh_gone(*id);
            }
        }
        let gone = !gone.is_empty();
        // Chats came or went: phones' gids follow.
        if gone || self.api.chats.len() != seen.len() {
            self.mesh_index();
        }
        let rest = hash_of(&(
            self.repos.iter().map(|r| (r.id, &r.name)).collect::<Vec<_>>(),
            self.order_by_activity,
            self.accounts.iter().map(|a| (&a.id, a.logged_in, a.usage.iter().map(|u| (&u.label, (u.percent * 100.0) as i32)).collect::<Vec<_>>())).collect::<Vec<_>>(),
            self.fast,
            self.models.values().map(|m| m.len()).sum::<usize>(),
            self.updates_json().to_string(),
        ));
        let rest_changed = rest != self.api.rest;
        self.api.rest = rest;
        self.api.chats = seen;
        let teams = self.team_hashes();
        let hub = &self.api.hub;
        for id in &changed {
            hub.touch(Some(*id), true);
        }
        if (gone || rest_changed) && changed.is_empty() {
            hub.touch(None, true);
        }
        // A team that changed changes its lead, so a phone showing that team refetches it.
        let old = &self.api.teams;
        for id in teams.keys().chain(old.keys().filter(|k| !teams.contains_key(k))) {
            if teams.get(id) != old.get(id) && !changed.contains(id) {
                hub.touch(Some(*id), false);
            }
        }
        self.api.teams = teams;
    }

    /// Per lead, a hash of what its team panel shows; leads without a team are left out.
    fn team_hashes(&self) -> HashMap<i64, u64> {
        let mut parts: HashMap<i64, DefaultHasher> = HashMap::new();
        for c in self.chats.iter().filter(|c| c.role == store::Role::Sub) {
            if let Some(lead) = c.parent {
                (c.id, &c.name, &c.title, self.is_running(c.id), self.queued_count(c.id), self.paused(c.id).is_some()).hash(parts.entry(lead).or_default());
            }
        }
        for p in &self.procs {
            (p.id, &p.name, &p.url).hash(parts.entry(p.lead).or_default());
        }
        for t in &self.timers {
            (t.id, t.at, &t.reason).hash(parts.entry(t.chat_id).or_default());
        }
        if !self.webhooks.is_empty() {
            for c in self.chats.iter().filter(|c| c.role != store::Role::Sub && c.repo_id.is_some()) {
                for h in self.webhooks.iter().filter(|h| Some(h.repo_id) == c.repo_id) {
                    (h.id, &h.name, &h.description, h.hits, h.last_hit, self.funnel.is_some()).hash(parts.entry(c.id).or_default());
                }
            }
        }
        parts.into_iter().map(|(k, h)| (k, h.finish())).collect()
    }

    /// This PC's composer as a typer: an edit to an open chat's draft renews the lease, an
    /// emptied draft (sent or cleared) ends it.
    fn local_typing(&mut self) {
        let crate::app::View::Chat(id) = self.view else { return };
        let draft = self.drafts.get(&id).map(|d| d.trim().to_string()).unwrap_or_default();
        let h = hash_of(&draft);
        if self.api.draft == Some((id, h)) {
            return;
        }
        let was = self.api.draft.replace((id, h));
        let me = local_device();
        if let Some((old, _)) = was.filter(|(old, _)| *old != id) {
            self.set_lease(old, false, &me, "pc", "", false);
        }
        // The first look at a chat isn't typing (a draft left from earlier).
        if was.is_none_or(|(old, _)| old != id) {
            return;
        }
        let name = self.api.hub.mesh.me().name;
        let label = if name.is_empty() { crate::remote::hostname() } else { name };
        self.set_lease(id, false, &me, "pc", &label, !draft.is_empty());
    }

    pub fn queued_count(&self, id: i64) -> usize {
        // Only copies have a status from their home PC.
        if let Some(r) = self.mesh.status.get(&id) {
            return r.queued;
        }
        self.queued(id).len() + self.pending.get(&id).map_or(0, |p| p.len())
    }

    /// Settings › Phones' switch; on starts the listener (once per run).
    pub fn api_set_enabled(&mut self, on: bool, ctx: &egui::Context) {
        self.store.set("api_enabled", if on { "1" } else { "0" });
        self.api.hub.enabled.store(on, Ordering::SeqCst);
        if on {
            let wake = {
                let ctx = ctx.clone();
                move || ctx.request_repaint()
            };
            start(self.api.hub.clone(), self.inc_tx.clone(), wake);
            self.api_activated();
        }
    }

    /// Phones or the mesh just turned on.
    pub fn api_activated(&mut self) {
        // Chats changed while it was off without a word to the hub: look at them again.
        self.api.looked.clear();
        self.api_tick();
        self.api.hub.touch(None, true);
    }

    pub fn handle_api(&mut self, call: Call, ctx: &egui::Context) {
        // The phone's name, once it says it.
        if !call.device.is_empty() {
            let mut tokens = self.api.hub.tokens.lock().unwrap();
            if let Some(t) = tokens.iter_mut().find(|t| t.token == call.token && t.name != call.device) {
                t.name = call.device.clone();
                let all = tokens.clone();
                drop(tokens);
                save_tokens(&self.store, &all);
            }
        }
        if call.path.first().map(String::as_str) == Some("mesh") {
            // Another PC's Issues page asks this PC's `gh` (ghapi.rs): a thread may answer.
            if call.path.get(2).is_some_and(|s| s == "issues") {
                if let Some(r) = self.api_github(&call, ctx) {
                    let _ = call.reply.send(r);
                }
                return;
            }
            let r = self.mesh_route(&call, ctx);
            // 0: a thread answers (a forwarded GitHub call).
            if r.status != 0 {
                let _ = call.reply.send(r);
            }
            return;
        }
        // A copy of another PC's chat: the call goes there.
        let Some(call) = self.mesh_proxy(call) else { return };
        // Pull requests and issues: this PC's GitHub, through `gh` (slow: a thread may answer).
        if call.path.get(1).is_some_and(|s| s == "prs" || s == "issues") {
            if let Some(r) = self.api_github(&call, ctx) {
                let _ = call.reply.send(r);
            }
            return;
        }
        // Workspace and branch calls: git runs on threads (worktree.rs), which may answer later.
        if let Some(r) = self.ws_api(&call, ctx) {
            if let Some(r) = r {
                let _ = call.reply.send(r);
            }
            return;
        }
        // What the phone sends says it came from the phone.
        self.sender = if call.device.is_empty() { "Phone".into() } else { call.device.clone() };
        self.sender_device = device_id(&call.token);
        let mut r = self.api_route(&call, ctx);
        self.sender.clear();
        self.sender_device.clear();
        if call.global && r.status < 300 {
            self.globalize(&call, &mut r.body);
        }
        let _ = call.reply.send(r);
    }

    pub fn api_route(&mut self, call: &Call, ctx: &egui::Context) -> Reply {
        let p: Vec<&str> = call.path.iter().map(String::as_str).collect();
        // A copy is written on its home PC only (mesh.rs forwards it there while it answers).
        // (A move says it moves there instead: movechat.rs.)
        if call.method != "GET" && p.len() > 2 && p[1] == "chats" && p.get(3) != Some(&"move") {
            if let Some(c) = self.chat_by_ref(p[2]).filter(|c| c.foreign()) {
                return err(409, format!("{} is off: this chat is read-only until it's back", self.home_name(c)));
            }
        }
        match (call.method.as_str(), p.as_slice()) {
            ("GET", ["v1", "state"]) => ok(self.api_state(ctx, &device_id(&call.token))),
            ("GET", ["v1", "chats", c, "items"]) => match self.ref_id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) => ok(self.api_items(c, call.query("since").and_then(|s| s.parse().ok()).unwrap_or(0))),
                None => err(404, "no such chat"),
            },
            ("GET", ["v1", "chats", c, "team"]) => match self.ref_id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) => ok(self.api_team(c, ctx)),
                None => err(404, "no such chat"),
            },
            ("GET", ["v1", "chats", c, "slash"]) => match self.ref_id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) => ok(self.api_slash(c, ctx)),
                None => err(404, "no such chat"),
            },
            // A new chat's composer (no chat yet): the same, by project and run settings.
            ("GET", ["v1", "slash"]) => {
                let q = |k: &str| call.query(k).unwrap_or("").to_string();
                let repo = self.project_ref(&q("project"));
                ok(self.api_slash_draft(&q("account"), &q("device"), &q("access"), repo, ctx))
            }
            ("GET", ["v1", "tags"]) => {
                let repo = self.project_ref(call.query("project").unwrap_or(""));
                ok(self.api_tags_in(repo, call.query("trigger").unwrap_or("@"), call.query("q").unwrap_or(""), ctx))
            }
            // The composer's `@` files and `#` issues and PRs (tags.rs).
            ("GET", ["v1", "chats", c, "tags"]) => match self.ref_id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) => ok(self.api_tags(c, call.query("trigger").unwrap_or("@"), call.query("q").unwrap_or(""), ctx)),
                None => err(404, "no such chat"),
            },
            // Settings › Usage's breakdown (cost.rs).
            ("GET", ["v1", "usage"]) => ok(self.api_usage(ctx)),
            // Who is who across the mesh, and whose instructions travel (meshctx.rs).
            ("GET", ["v1", "people"]) => ok(self.api_people()),
            ("PATCH", ["v1", "people"]) => {
                self.api_people_set(&call.body);
                ok(self.api_people())
            }
            // The command palette (palette.rs); `chat` is the one the phone has open.
            ("GET", ["v1", "palette"]) => {
                let chat = call.query("chat").and_then(|c| self.ref_id(c));
                ok(self.api_palette(call.query("q").unwrap_or(""), chat))
            }
            ("POST", ["v1", "palette", "run"]) => {
                let chat = call.body["chat"].as_str().map(String::from).or_else(|| call.body["chat"].as_i64().map(|c| c.to_string())).and_then(|c| self.ref_id(&c));
                self.api_palette_run(&call.body, chat, ctx)
            }
            ("POST", ["v1", "chats"]) => self.api_create(&call.body, ctx),
            // The phone's "Updates available" banner: updates the hub's provider CLIs.
            ("POST", ["v1", "providers", "update"]) => {
                if crate::provupdate::update_all(ctx, &self.accounts) {
                    ok(json!({ "ok": true }))
                } else {
                    err(409, "no provider update to install")
                }
            }
            // The phone's "Harbor X.Y.Z is available" banner: the hub's Update button.
            ("POST", ["v1", "hub", "update"]) => {
                if self.harbor_offer().is_some() {
                    self.update_clicked(ctx);
                    ok(json!({ "ok": true }))
                } else {
                    err(409, "Harbor is up to date")
                }
            }
            ("POST", ["v1", "chats", c, action]) => {
                let Some(c) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                match *action {
                    "send" => self.api_send(c, &call.body, ctx),
                    "stop" => {
                        // What waited behind the turn goes back to the phone, not to the desktop's composer.
                        let returned: Vec<Value> = self.take_queue(c).into_iter().map(|q| json!({ "text": q.text, "files": q.files.iter().filter_map(|f| upload_id(f)).collect::<Vec<_>>() })).collect();
                        self.stop(c);
                        ok(json!({ "ok": true, "returned": returned }))
                    }
                    "fork" => self.api_fork(c, &call.body),
                    // "Move to project…": {"repo": project id, its path, or null for No project}.
                    "move" => self.api_move(c, &call.body),
                    // The slash menu's /plan and /default (slash.rs).
                    "slash" => self.api_slash_command(c, &call.body, ctx),
                    // The waiting bar's Stop all: the lead and its sub-agents; the lead's queue comes back.
                    "stop_all" => {
                        let returned: Vec<Value> = self.take_queue(c).into_iter().map(|q| json!({ "text": q.text, "files": q.files.iter().filter_map(|f| upload_id(f)).collect::<Vec<_>>() })).collect();
                        self.stop_all(c);
                        ok(json!({ "ok": true, "returned": returned }))
                    }
                    // The usage-limit line's Continue now and Cancel.
                    "continue" => {
                        self.continue_chat(c, true, ctx);
                        ok(json!({ "ok": true }))
                    }
                    "cancel_limit" => {
                        self.cancel_limit(c);
                        ok(json!({ "ok": true }))
                    }
                    _ => err(404, "unknown action"),
                }
            }
            ("PATCH", ["v1", "chats", c]) => {
                let Some(c) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                let title = call.body["title"].as_str().map(str::trim);
                if title == Some("") {
                    return err(400, "empty title");
                }
                // Run settings first: they are checked as a whole, and nothing changes if one fails.
                if let Err(r) = self.api_patch_run(c, &call.body, ctx) {
                    return r;
                }
                if let Some(t) = title {
                    if let Some(ch) = self.chat_mut(c) {
                        ch.title = t.chars().take(200).collect();
                    }
                    self.persist(c);
                }
                if let Some(s) = call.body["settled"].as_bool() {
                    self.set_chat_settled(c, s);
                }
                let chat = self.chat(c).map(|ch| self.chat_json(ch)).unwrap_or_default();
                ok(json!({ "ok": true, "chat": chat }))
            }
            ("DELETE", ["v1", "chats", c]) => {
                let Some(c) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                self.stop(c);
                self.ws_drop(c, ctx);
                self.store.delete_chat(c);
                self.chats.retain(|x| x.id != c);
                self.transcripts.remove(&c);
                self.api.items.remove(&c);
                self.api.looked.remove(&c);
                if self.view == crate::app::View::Chat(c) {
                    self.view = crate::app::View::Draft;
                }
                ok(json!({ "ok": true }))
            }
            (_, ["v1", ..]) => err(404, "unknown call"),
            _ => err(404, "not found"),
        }
    }

    /// An answer with chats by gid and projects by path instead of this hub's ids.
    pub(crate) fn globalize(&self, call: &Call, v: &mut Value) {
        let gid = |id: &Value| id.as_i64().and_then(|i| self.chat(i)).map(|c| json!(c.gid)).unwrap_or(Value::Null);
        let path = |id: &Value| id.as_i64().and_then(|r| self.repo(r)).map(|r| json!(r.path.to_string_lossy())).unwrap_or(Value::Null);
        let chat = |c: &mut Value| {
            c["id"] = gid(&c["id"]);
            c["parent"] = gid(&c["parent"]);
            c["project_id"] = path(&c["project_id"]);
        };
        let p: Vec<&str> = call.path.iter().map(String::as_str).collect();
        match (call.method.as_str(), p.as_slice()) {
            ("GET", ["v1", "state"]) => {
                for pr in v["projects"].as_array_mut().into_iter().flatten() {
                    pr["id"] = pr["path"].clone();
                }
                for c in v["chats"].as_array_mut().into_iter().flatten() {
                    chat(c);
                }
                v["defaults"]["project_id"] = path(&v["defaults"]["project_id"]);
            }
            ("GET", ["v1", "chats", _, "items"]) => {
                for it in v["items"].as_array_mut().into_iter().flatten() {
                    if let Some(f) = it.get_mut("forks_after").and_then(|f| f.as_array_mut()) {
                        for x in f.iter_mut() {
                            *x = gid(x);
                        }
                    }
                    if it["kind"] == "forked_from" {
                        it["chat"] = gid(&it["chat"]);
                    }
                }
                // (get_mut: indexing a null part mutably would turn it into an object.)
                for a in v.get_mut("status").and_then(|s| s.get_mut("waiting")).and_then(|w| w.get_mut("agents")).and_then(|a| a.as_array_mut()).into_iter().flatten() {
                    a["id"] = gid(&a["id"]);
                }
                // The agent strip's rows open their chats.
                for a in v.get_mut("status").and_then(|s| s.get_mut("agents")).and_then(|w| w.get_mut("rows")).and_then(|a| a.as_array_mut()).into_iter().flatten() {
                    a["id"] = gid(&a["id"]);
                }
            }
            ("GET", ["v1", "chats", _, "team"]) => {
                v["lead"] = gid(&v["lead"]);
                v["project_id"] = path(&v["project_id"]);
                for a in v.get_mut("agents").and_then(|a| a.as_array_mut()).into_iter().flatten() {
                    a["id"] = gid(&a["id"]);
                }
            }
            ("POST", ["v1", "chats"]) | ("POST", ["v1", "chats", _, "fork"]) => v["id"] = gid(&v["id"]),
            ("GET", ["v1", "palette"]) => {
                for s in v["sections"].as_array_mut().into_iter().flatten() {
                    for it in s["items"].as_array_mut().into_iter().flatten() {
                        if it["kind"] == "chat" {
                            it["chat"] = gid(&it["chat"]);
                        } else if it["kind"] == "new_chat" {
                            it["project"] = path(&it["project"]);
                        }
                    }
                }
            }
            ("POST", ["v1", "palette", "run"]) => v["open"] = gid(&v["open"]),
            ("PATCH", _) | ("POST", ["v1", "chats", _, "slash" | "move"]) => {
                if v["chat"].is_object() {
                    chat(&mut v["chat"]);
                }
                // /fork's new chat.
                if v["id"].is_i64() {
                    v["id"] = gid(&v["id"]);
                }
            }
            _ => {}
        }
    }

    /// `POST /v1/chats/<id>/move`: the chat and its sub-agents to another project.
    fn api_move(&mut self, c: i64, body: &Value) -> Reply {
        let Some(r) = body.get("repo").or_else(|| body.get("project_id")) else { return err(400, "say the project: {\"repo\": id, path or null}") };
        let repo = match r {
            Value::Null => None,
            Value::String(p) => match self.repos.iter().find(|x| x.path.to_string_lossy() == p.trim_end_matches('/')) {
                Some(x) => Some(x.id),
                None => return err(404, "no such project"),
            },
            v => match v.as_i64().filter(|r| self.repo(*r).is_some()) {
                Some(r) => Some(r),
                None => return err(404, "no such project"),
            },
        };
        match self.move_chat(c, repo) {
            Ok(()) => {
                let moved: Vec<i64> = std::iter::once(c).chain(self.subs_of(c).into_iter().map(|s| s.id)).collect();
                let chat = self.chat(c).map(|ch| self.chat_json(ch)).unwrap_or_default();
                ok(json!({ "ok": true, "chat": chat, "moved": moved }))
            }
            Err(e) => err(409, e),
        }
    }

    /// A chat's id here from the phone's reference (its id here or its global id).
    pub(crate) fn ref_id(&self, r: &str) -> Option<i64> {
        self.chat_by_ref(r).map(|c| c.id)
    }

    /// Who is typing in a chat, as the wire says it.
    pub fn typing_json(&self, chat: i64) -> Vec<Value> {
        self.typers(chat).into_iter().map(|t| json!({ "device": t.device, "kind": t.kind, "label": t.label })).collect()
    }

    /// The accounts a chat may switch to: a started chat stays on its provider, a lead on Claude.
    pub fn allowed_accounts(&self, chat: i64) -> Vec<String> {
        let locked = self.locked_kind_of(chat);
        self.accounts.iter().filter(|a| a.installed() && locked.is_none_or(|k| a.kind == k)).map(|a| a.id.clone()).collect()
    }

    /// Why a run setting can't change now, for each that can't (the phone greys it out with this).
    fn switch_reason(&self, c: &store::Chat, kind: Kind) -> Value {
        let mut r = serde_json::Map::new();
        if !self.allowed_accounts(c.id).iter().any(|a| *a != c.account) {
            let why = if c.role == store::Role::Lead { "A project's lead runs on Claude".to_string() } else if c.started { format!("A started chat stays on {}", kind.label()) } else { "No other account".to_string() };
            r.insert("account".into(), json!(why));
        }
        if providers::efforts(kind).is_empty() {
            r.insert("effort".into(), json!(format!("{} has no effort levels", kind.label())));
        }
        if providers::access(kind).len() <= 1 {
            r.insert("access".into(), json!(format!("{} has one access level", kind.label())));
        }
        if c.started {
            r.insert("device".into(), json!("A started chat stays on the device it started on"));
        } else if kind != Kind::Claude {
            r.insert("device".into(), json!("Only Claude chats run on another device"));
        }
        if !providers::has_fast(kind) {
            r.insert("fast".into(), json!(format!("{} has no fast mode", kind.label())));
        }
        Value::Object(r)
    }

    /// A chat works while its own turn runs, or (a lead) while a sub-agent runs or has work queued.
    pub fn team_working(&self, c: &store::Chat) -> bool {
        if c.role != store::Role::Lead {
            return self.is_running(c.id);
        }
        self.team_started(c.id).is_some() || self.subs_queued(c.id) > 0
    }

    pub fn chat_json(&self, c: &store::Chat) -> Value {
        let kind = self.account(&c.account).map_or(Kind::Claude, |a| a.kind);
        let allowed = self.allowed_accounts(c.id);
        json!({
            "id": c.id, "project_id": c.repo_id, "title": c.title, "device": c.device, "account": c.account,
            "model": c.model, "effort": c.effort, "access": c.access, "fast": self.fast, "settled": c.settled,
            "running": self.is_running(c.id), "queued": self.queued_count(c.id),
            // Busy as the desktop sidebar says it: its own turn or any of its sub-agents' (or
            // work queued for them), so a lead waiting on its team still shows as working.
            "working": self.team_working(c),
            "updated_ms": c.updated * 1000, "rev": self.api.hub.chat_rev(c.id),
            // The same chat on every PC of the mesh; the PC it runs on and whether it can be written now.
            "gid": c.gid,
            "home": if c.foreign() { c.home.clone() } else { self.api.hub.mesh.me().id },
            "home_name": self.home_name(c),
            "writable": self.writable_chat(c),
            "role": match c.role { store::Role::Lead => "lead", store::Role::Sub => "sub", store::Role::Chat => "chat" },
            "parent": c.parent,
            "typing": self.typing_json(c.id),
            // Finished while nobody had it open, not opened since (the sidebar's blue dot), and
            // whether that last turn failed (optional, 0.42).
            "unread": self.unread.contains(&c.id),
            "failed": self.failed.contains(&c.id),
            // Other PCs with the chat open (mesh.rs): "focused" or "away".
            "viewing": self.viewers(c.id).into_iter().map(|t| json!({ "device": t.device, "kind": t.kind, "label": t.label })).collect::<Vec<_>>(),
            "switchable": {
                "account": allowed.iter().any(|a| *a != c.account),
                "model": true,
                "effort": !providers::efforts(kind).is_empty(),
                "access": providers::access(kind).len() > 1,
                // A started chat's session lives on its device; other providers run here only.
                "device": !c.started && kind == Kind::Claude,
                "fast": providers::has_fast(kind),
            },
            "allowed_accounts": allowed,
            "switch_reason": self.switch_reason(c, kind),
        })
    }

    /// PATCH's account/model/effort/access/device/fast, with the desktop composer's rules.
    pub(crate) fn api_patch_run(&mut self, chat: i64, body: &Value, ctx: &egui::Context) -> Result<(), Reply> {
        let Some(c) = self.chat(chat).cloned() else { return Err(err(404, "no such chat")) };
        let net = crate::remote::tailnet(ctx);
        let hosts: Vec<crate::remote::Host> = crate::remote::devices(&self.remote, &net).into_iter().map(|(h, _)| h).collect();
        let ids: Vec<&str> = hosts.iter().map(|h| h.id.as_str()).collect();
        let allowed = self.allowed_accounts(chat);
        let Some((n, fast)) = check_run(&c, body, &self.accounts, &allowed, &|k| self.models_for(k).to_vec(), &ids)? else { return Ok(()) };
        // Checked: apply. A Tailscale PC picked once is kept, as the desktop's device menu does.
        if let Some(h) = hosts.iter().find(|h| h.id == n.device && n.device != c.device) {
            if !self.remote.devices.iter().any(|x| x.id == h.id) {
                self.remote.devices.push(h.clone());
                crate::remote::save(&self.store, &self.remote);
            }
        }
        if let Some(f) = fast.filter(|f| *f != self.fast) {
            self.fast = f;
            self.store.set("fast_mode", if f { "1" } else { "0" });
        }
        if let Some(ch) = self.chat_mut(chat) {
            *ch = n;
        }
        self.persist(chat);
        Ok(())
    }

    pub fn api_state(&self, ctx: &egui::Context, you: &str) -> Value {
        // In the desktop sidebar's order: by hand, or by last activity when it's set so.
        let mut repos: Vec<&store::Repo> = self.repos.iter().collect();
        if self.order_by_activity {
            repos.sort_by_key(|r| std::cmp::Reverse(self.activity(r.id)));
        }
        let projects: Vec<Value> = repos.iter().map(|r| json!({ "id": r.id, "name": r.name, "path": r.path.to_string_lossy() })).collect();
        let hub = &self.api.hub;
        let chats: Vec<Value> = self.chats.iter().map(|c| self.chat_json(c)).collect();
        let accounts: Vec<Value> = self
            .accounts
            .iter()
            .filter(|a| a.installed())
            .map(|a| {
                json!({
                    "id": a.id, "label": a.short(), "name": a.name, "kind": kind_slug(a.kind),
                    "signed_in": a.logged_in.unwrap_or(true),
                    "can_start": a.kind == Kind::Claude,
                    // Window.percent is a 0–1 fraction; the phone gets 0–100 like the desktop shows.
                    "usage": a.usage.iter().map(|u| json!({ "label": u.label, "percent": (u.percent * 1000.0).round() / 10.0 })).collect::<Vec<_>>(),
                })
            })
            .collect();
        let mut models = serde_json::Map::new();
        let mut efforts = serde_json::Map::new();
        // What an empty effort means per provider (the CLI's own default), so the phone shows and
        // sends that instead of the first level.
        let mut default_efforts = serde_json::Map::new();
        let mut access = serde_json::Map::new();
        for k in Kind::ALL {
            let ms: Vec<Value> = self.models_for(k).iter().map(|m| json!({ "id": m.id, "label": m.label, "more": m.more })).collect();
            models.insert(kind_slug(k), json!(ms));
            efforts.insert(kind_slug(k), json!(providers::efforts(k).iter().map(|e| json!({ "id": e.0, "label": e.1, "desc": e.2 })).collect::<Vec<_>>()));
            default_efforts.insert(kind_slug(k), json!(providers::default_effort(k)));
            access.insert(kind_slug(k), json!(providers::access(k).iter().map(|e| json!({ "id": e.0, "label": e.1, "desc": e.2 })).collect::<Vec<_>>()));
        }
        let here = self.api.hub.mesh.me().name;
        let mut devices = vec![json!({ "id": "", "label": if here.is_empty() { crate::remote::hostname() } else { here }, "icon": "monitor", "online": true })];
        let net = crate::remote::tailnet(ctx);
        for (h, online) in crate::remote::devices(&self.remote, &net) {
            if !h.hidden {
                devices.push(json!({ "id": h.id, "label": h.label(), "icon": icon_name(&h), "online": online }));
            }
        }
        // The PCs of the mesh: as devices a new chat can start on, and as hubs the phone may use.
        let me = self.api.hub.mesh.me();
        let mesh_on = self.api.hub.mesh.on.load(Ordering::Relaxed);
        let peers = if mesh_on { self.mesh_hosts() } else { vec![] };
        let mut hubs = vec![json!({ "id": me.id, "name": me.name, "online": true })];
        for p in &peers {
            hubs.push(json!({ "id": p.id, "name": p.name, "online": p.online }));
            match devices.iter_mut().find(|d| d["id"] == p.id.as_str()) {
                Some(d) => {
                    d["hub"] = json!(true);
                    d["online"] = json!(p.online);
                }
                None => devices.push(json!({ "id": p.id, "label": p.name, "icon": "monitor", "online": p.online, "hub": true })),
            }
        }
        let s = &self.draft.sel;
        let updates = self.updates_json();
        json!({
            "version": crate::update::VERSION,
            "hub_id": me.id,
            // This PC's key and where it answers: a phone keeps its pairing up to date with these.
            "hub_fp": crate::tls::my_fp(),
            "hub_addrs": hub.net.lock().unwrap().addrs.clone(),
            "hub_port": *hub.port.lock().unwrap(),
            "mesh": mesh_on,
            "hubs": hubs,
            "hub_name": if me.name.is_empty() { crate::remote::hostname() } else { me.name.clone() },
            "you": you,
            "rev": hub.rev(),
            "projects": projects,
            "chats": chats,
            "accounts": accounts,
            "models": models,
            "efforts": efforts,
            "default_efforts": default_efforts,
            "access": access,
            "devices": devices,
            "fast": self.fast,
            "defaults": { "account": s.account, "model": s.model, "effort": s.effort, "access": s.access, "device": s.device, "project_id": self.draft.repo },
            "app": app_info().as_object().map(|o| json!({ "version_code": o["version_code"], "url": o["url"] })).unwrap_or_default(),
            "hub_update": updates["hub_update"],
            "provider_updates": updates["provider_updates"],
            // Whether this PC can transcribe a phone's recording (voice.rs), and why not.
            "voice": { "transcribe": crate::voice::missing().is_none(), "why": crate::voice::missing(), "lang": crate::voice::config().0 },
        })
    }

    /// The two update banners' data (notices.rs draws the same on the desktop): the Harbor
    /// release this hub can install, and its provider CLIs that are behind. Null when none.
    pub fn updates_json(&self) -> Value {
        let hub = self.harbor_offer().map(|(v, installing)| {
            json!({ "version": v, "current": crate::update::VERSION, "installing": installing || self.reload_asked, "notes_url": crate::notices::notes_url(&v) })
        });
        let st = crate::provupdate::status();
        let providers = (!st.items.is_empty() || st.updating || st.error.is_some()).then(|| {
            json!({
                "items": st.items.iter().map(|p| json!({ "kind": kind_slug(p.kind), "label": p.kind.label(), "logo": crate::provupdate::logo_file(p.kind), "current": p.current, "latest": p.latest })).collect::<Vec<_>>(),
                "names": crate::provupdate::names(&st.items),
                "key": crate::provupdate::key(&st.items),
                "updating": st.updating,
                "error": st.error,
            })
        });
        json!({ "hub_update": hub, "provider_updates": providers })
    }

    /// The cards of a chat (the desktop's projection, view.rs) changed after `since`, finding
    /// what changed by hashing each item with how it shows.
    pub fn api_items(&mut self, chat: i64, since: u64) -> Value {
        self.recap_seen(chat);
        // Opened on a phone: read, as when it's opened here.
        if self.unread.remove(&chat) | self.failed.remove(&chat) {
            self.api.hub.bump();
        }
        if !self.transcripts.contains_key(&chat) {
            let items = self.store.items(chat);
            self.transcripts.insert(chat, crate::app::Transcript { items, ..Default::default() });
        }
        let forks = match self.mesh.status.get(&chat) {
            Some(r) => r.forks.clone(),
            None => self.forks_of(chat),
        };
        let lead = self.chat(chat).is_some_and(|c| c.role == store::Role::Lead);
        let who = |account: &str, model: &str| self.footer_who(chat, account, model);
        let items = &self.transcripts[&chat].items;
        let cards = crate::view::project(items, lead, &forks, &who);
        // Every change to a chat goes through `api_touch`: nothing new since the last look,
        // nothing to hash (a phone asks again after each event, many times a second).
        let now = self.api.hub.chat_rev(chat);
        // Image addresses name the chat: a copy of another PC's chat fetches them from there.
        let gid = self.chat(chat).map(|c| c.gid.clone()).unwrap_or_default();
        let revs = self.api.items.entry(chat).or_default();
        let fresh = self.api.looked.get(&chat) == Some(&now) && revs.len() == items.len();
        // An item's version includes how it shows: hidden later (a lead's turn delegating),
        // forkable once its turn ends, a fork made from it.
        let hashes: Vec<u64> = if fresh {
            vec![]
        } else {
            items.iter().zip(&cards).map(|(it, c)| hash_of(&(fingerprint(it), crate::view::kind(&c.card), matches!(c.card, crate::view::Card::Text { forkable: true, .. }), &c.forks_after))).collect()
        };
        if !fresh {
            self.api.looked.insert(chat, now);
        }
        revs.truncate(if fresh { revs.len() } else { hashes.len() });
        let stale = hashes.iter().enumerate().any(|(i, h)| revs.get(i).is_none_or(|(old, _)| old != h));
        if stale {
            let rev = self.api.hub.bump();
            for (i, h) in hashes.iter().enumerate() {
                match revs.get_mut(i) {
                    Some(r) if r.0 == *h => {}
                    Some(r) => *r = (*h, rev),
                    None => revs.push((*h, rev)),
                }
            }
        }
        let out: Vec<Value> = cards
            .iter()
            .filter(|c| revs[c.seq].1 > since)
            .map(|c| with_chat(card_json(c, revs[c.seq].1, &mut crate::images::find_paths), if gid.is_empty() { chat.to_string() } else { gid.clone() }))
            .collect();
        json!({
            "rev": self.api.hub.rev(),
            "count": items.len(),
            "running": self.is_running(chat),
            "queued": self.queued_count(chat),
            "typing": self.typing_json(chat),
            "status": self.status_json(chat),
            // Its tokens and cost so far (cost.rs), for the header; optional.
            "usage": self.usage_json(chat),
            "items": out,
        })
    }

    /// The bars under the desktop's transcript (waiting.rs, limits.rs, queue.rs), for the phone.
    pub fn api_status(&self, chat: i64) -> Value {
        // A copy: as its home PC says it.
        if let Some(r) = self.mesh.status.get(&chat) {
            return r.status.clone();
        }
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let lead = self.chat(chat).is_some_and(|c| c.role == store::Role::Lead);
        let subs = if lead { self.running_subs(chat) } else { vec![] };
        let queue: Vec<Value> = self
            .queued(chat)
            .iter()
            .map(|q| json!({ "text": q.text, "files": q.files.iter().map(|f| file_name(&f.to_string_lossy())).collect::<Vec<_>>(), "sending": q.written }))
            .collect();
        let working = self.turns.get(&chat).map(|(_, at)| {
            json!({ "since_ms": now_ms - at.elapsed().as_millis() as i64, "subagents": subs.len(), "text": format!("Working…{}", crate::waiting::subs_running(subs.len())) })
        });
        let waiting = (working.is_none() && !subs.is_empty()).then(|| {
            let agents: Vec<Value> = subs.iter().map(|(c, secs)| json!({ "id": c.id, "name": c.name, "title": c.title, "since_ms": now_ms - *secs as i64 * 1000 })).collect();
            json!({ "agents": agents, "queued": self.subs_queued(chat) })
        });
        let limit = self.limit_text(chat).map(|(text, cancel)| json!({ "text": text, "can_cancel": cancel }));
        json!({ "queue": queue, "working": working, "waiting": waiting, "limit": limit, "agents": self.strip_json(chat) })
    }

    /// The team panel of a chat's lead (a subagent's is its lead's), as teamui.rs draws it.
    /// A copy of another PC's chat has its processes, wake-ups and webhooks there (`home`).
    pub fn api_team(&self, chat: i64, ctx: &egui::Context) -> Value {
        let lead = self.chat(chat).filter(|c| c.role == store::Role::Sub).and_then(|c| c.parent).unwrap_or(chat);
        let lc = self.chat(lead);
        let repo = lc.and_then(|c| c.repo_id);
        let home = lc.filter(|c| c.foreign()).map(|c| self.home_name(c)).unwrap_or_default();
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let since = |at: Instant| now_ms - at.elapsed().as_millis() as i64;
        let mut subs = self.subs_of(lead);
        subs.sort_by_key(|c| (!self.is_running(c.id), std::cmp::Reverse(c.updated)));
        let agents: Vec<Value> = subs
            .iter()
            .map(|c| {
                let acc = self.account(&c.account);
                json!({
                    "id": c.id, "name": c.name, "title": c.title,
                    "account": acc.map(|a| a.short()).unwrap_or_default(),
                    "model": acc.map(|a| self.model_label(a.kind, &c.model)).unwrap_or_else(|| c.model.clone()),
                    "running": self.is_running(c.id),
                    "started_ms": self.running_since(c.id).map(since),
                    "queued": self.queued_count(c.id),
                    "paused": self.paused(c.id).map(|p| p.at.map(crate::limits::when).unwrap_or_else(|| "usage limit".into())),
                    "settled": self.agent_settled(ctx, c),
                    "updated_ms": c.updated * 1000,
                    "usage": Some(self.chat_usage_known(c.id)).filter(|u| !u.is_empty()).map(|u| u.compact()),
                })
            })
            .collect();
        let processes: Vec<Value> = self
            .procs
            .iter()
            .filter(|p| p.lead == lead)
            .map(|p| json!({ "id": p.id, "name": p.name, "cmd": p.cmd, "url": p.url, "started_ms": since(p.started) }))
            .collect();
        let wakeups: Vec<Value> = self.timers.iter().filter(|t| t.chat_id == lead).map(|t| json!({ "id": t.id, "at_ms": t.at * 1000, "reason": t.reason })).collect();
        let webhooks: Vec<Value> = self
            .webhooks
            .iter()
            .filter(|h| home.is_empty() && Some(h.repo_id) == repo)
            .map(|h| {
                let (local, public) = self.hook_url(&h.token);
                json!({
                    "id": h.id, "name": h.name, "description": h.description, "hits": h.hits, "last_ms": h.last_hit * 1000,
                    "public": public.is_some(), "url": public.unwrap_or(local),
                })
            })
            .collect();
        json!({ "lead": lead, "project_id": repo, "home": home, "agents": agents, "processes": processes, "wakeups": wakeups, "webhooks": webhooks })
    }

    fn api_files(body: &Value) -> Result<Vec<PathBuf>, Reply> {
        let mut v = vec![];
        for f in body["files"].as_array().into_iter().flatten() {
            let id = f.as_str().unwrap_or("");
            v.push(resolve_upload(id).ok_or_else(|| err(400, format!("unknown upload {id}")))?);
        }
        Ok(v)
    }

    fn api_send(&mut self, chat: i64, body: &Value, ctx: &egui::Context) -> Reply {
        let text = body["text"].as_str().unwrap_or("").trim().to_string();
        let files = match Self::api_files(body) {
            Ok(f) => f,
            Err(r) => return r,
        };
        if text.is_empty() && files.is_empty() {
            return err(400, "nothing to send");
        }
        let before = self.queued(chat).len();
        let mentions: Vec<crate::mentions::Mention> = serde_json::from_value(body["mentions"].clone()).unwrap_or_default();
        self.send_to(chat, text, files, mentions, ctx);
        ok(json!({ "ok": true, "queued": self.queued(chat).len() > before }))
    }

    fn api_create(&mut self, body: &Value, ctx: &egui::Context) -> Reply {
        self.api_create_in(body, ctx, None)
    }

    /// The project a new chat asks for (`project_id`, or `project` from another PC).
    pub(crate) fn api_create_repo(&self, body: &Value) -> Result<Option<i64>, Reply> {
        Ok(match &body["project_id"] {
            // From another PC (mesh.rs): the project by its folder, else by its name.
            Value::Null if body["project"].is_object() => {
                let (path, name) = (body["project"]["path"].as_str().unwrap_or(""), body["project"]["name"].as_str().unwrap_or(""));
                match self.repos.iter().find(|r| r.path.to_string_lossy() == path).or_else(|| self.repos.iter().find(|r| r.name == name)) {
                    Some(r) => Some(r.id),
                    None => return Err(err(409, format!("{name} isn't a project on {} yet", crate::remote::hostname()))),
                }
            }
            Value::Null => None,
            // A project by its folder (phones that move between hubs know it that way).
            Value::String(p) => match self.repos.iter().find(|r| r.path.to_string_lossy() == *p) {
                Some(r) => Some(r.id),
                None => return Err(err(400, "no such project")),
            },
            v => match v.as_i64().filter(|r| self.repo(*r).is_some()) {
                Some(r) => Some(r),
                None => return Err(err(400, "no such project")),
            },
        })
    }

    /// `POST /v1/chats`, in worktree `wt` (made by worktree.rs) when given.
    pub(crate) fn api_create_in(&mut self, body: &Value, ctx: &egui::Context, wt: Option<PathBuf>) -> Reply {
        let repo = match self.api_create_repo(body) {
            Ok(r) => r,
            Err(r) => return r,
        };
        let d = self.draft.sel.clone();
        let str_or = |k: &str, d: &str| body[k].as_str().map(String::from).unwrap_or_else(|| d.to_string());
        let account = str_or("account", &d.account);
        let Some(kind) = self.account(&account).map(|a| a.kind) else { return err(400, format!("no account {account}")) };
        // As on the desktop, a new chat is a project's lead, and leads run on Claude.
        if kind != Kind::Claude {
            return err(400, format!("new chats start on a Claude account; {} works as a subagent", kind.label()));
        }
        let effort = str_or("effort", if kind == self.account(&d.account).map_or(Kind::Claude, |a| a.kind) { &d.effort } else { "" });
        if !effort.is_empty() && !providers::efforts(kind).iter().any(|e| e.0 == effort) {
            return err(400, format!("{} has no effort {effort}", kind.label()));
        }
        let access = str_or("access", "full");
        if !providers::access(kind).iter().any(|a| a.0 == access) {
            return err(400, format!("{} has no access level {access}", kind.label()));
        }
        let device = str_or("device", "");
        let text = body["text"].as_str().unwrap_or("").trim().to_string();
        let files = match Self::api_files(body) {
            Ok(f) => f,
            Err(r) => return r,
        };
        if let Some(f) = body["fast"].as_bool().filter(|f| *f != self.fast) {
            self.fast = f;
            self.store.set("fast_mode", if f { "1" } else { "0" });
        }
        let model = str_or("model", if account == d.account { &d.model } else { "" });
        let sel = Sel { account, model, effort: effort.clone(), access: access.clone(), device: device.clone() };
        let id = self.new_thread_with(repo, &text, sel);
        self.ws_attach(id, wt);
        if let Some(c) = self.chat_mut(id) {
            c.effort = effort;
            c.access = access;
            c.device = device;
        }
        self.persist(id);
        if !text.is_empty() || !files.is_empty() {
            self.send_to(id, text, files, vec![], ctx);
        }
        let gid = self.chat(id).map(|c| c.gid.clone()).unwrap_or_default();
        ok(json!({ "id": id, "gid": gid }))
    }

    fn api_fork(&mut self, chat: i64, body: &Value) -> Reply {
        let Some(seq) = body["seq"].as_u64().map(|s| s as usize) else { return err(400, "seq is required") };
        if !self.transcripts.contains_key(&chat) {
            let items = self.store.items(chat);
            self.transcripts.insert(chat, crate::app::Transcript { items, ..Default::default() });
        }
        let ok_seq = crate::fork::forkable(&self.transcripts[&chat].items).get(seq).copied().flatten().is_some();
        if !ok_seq {
            return err(409, "only the last reply of a finished turn can be forked");
        }
        let before = self.chats.iter().map(|c| c.id).max().unwrap_or(0);
        // fork_from opens the new chat; the desktop stays where it was.
        let (view, focus) = (self.view, self.focus_composer);
        self.fork_from(chat, seq);
        self.view = view;
        self.focus_composer = focus;
        match self.chats.iter().map(|c| c.id).max().filter(|m| *m > before) {
            Some(id) => ok(json!({ "id": id, "gid": self.chat(id).map(|c| c.gid.clone()).unwrap_or_default() })),
            None => err(500, "the fork failed"),
        }
    }
}

// ================================================================== tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_images_name_their_chat() {
        let v = with_chat(json!({ "kind": "user", "images": [{ "name": "a.png", "url": "/v1/image?path=%2Fx%2Fa.png&max=512" }] }), "g 1".into());
        assert_eq!(v["images"][0]["url"], "/v1/image?path=%2Fx%2Fa.png&max=512&chat=g%201");
        // Cards without images stay as they are.
        assert_eq!(with_chat(json!({ "kind": "text" }), "1".into()), json!({ "kind": "text" }));
    }

    fn head(s: &str) -> Result<Request, (u16, &'static str)> {
        read_head(&mut std::io::Cursor::new(s.as_bytes().to_vec()))
    }

    #[test]
    fn parses_requests() {
        let r = head("GET /v1/chats/12/items?since=40&x=a%20b+c HTTP/1.1\r\nHost: h\r\nAuthorization: Bearer abc\r\nContent-Length: 5\r\n\r\nhello").unwrap();
        assert_eq!(r.method, "GET");
        assert_eq!(r.path, "/v1/chats/12/items");
        assert_eq!(r.segments(), ["v1", "chats", "12", "items"]);
        assert_eq!(r.query("since"), Some("40"));
        assert_eq!(r.query("x"), Some("a b c"));
        assert_eq!(r.len, 5);
        assert_eq!(r.bearer(), Some("abc"));
        assert_eq!(r.header("host"), Some("h"));
    }

    #[test]
    fn rejects_bad_requests() {
        assert_eq!(head("").unwrap_err().0, 400);
        assert_eq!(head("GARBAGE\r\n\r\n").unwrap_err().0, 400);
        assert_eq!(head("GET nopath HTTP/1.1\r\n\r\n").unwrap_err().0, 400);
        assert_eq!(head("GET / SPDY/3\r\n\r\n").unwrap_err().0, 400);
        assert_eq!(head("POST / HTTP/1.1\r\nContent-Length: x\r\n\r\n").unwrap_err().0, 400);
        assert_eq!(head("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap_err().0, 411);
        let long = format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(9000));
        assert_eq!(head(&long).unwrap_err().0, 431);
        let many = format!("GET / HTTP/1.1\r\n{}\r\n", "A: b\r\n".repeat(101));
        assert_eq!(head(&many).unwrap_err().0, 431);
        // A head cut short (no blank line) is an error, not a hang.
        assert!(head("GET / HTTP/1.1\r\nHost: h\r\n").is_err());
    }

    #[test]
    fn bounds_bodies_and_connections() {
        let chunked = |s: &str, max| read_chunked(&mut std::io::Cursor::new(s.as_bytes().to_vec()), max);
        assert_eq!(chunked("5\r\nhello\r\n6;x=y\r\n world\r\n0\r\nTrailer: t\r\n\r\n", 100).unwrap(), b"hello world");
        // A size alone is refused before anything is allocated or read.
        assert_eq!(chunked("100000000000\r\n", 1 << 20), Err(413));
        assert_eq!(chunked("5\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n", 8), Err(413));
        assert_eq!(chunked("5\r\nhel", 100), Err(400));
        assert_eq!(chunked("zz\r\n", 100), Err(400));
        let body = |s: &str, len, max| read_body(&mut std::io::Cursor::new(s.as_bytes().to_vec()), len, max);
        assert_eq!(body("hello", 5, 5).unwrap(), b"hello");
        assert_eq!(body("hello", 6, 10), Err(400));
        assert_eq!(body("hello", 1 << 40, 10), Err(413));
        assert_eq!(head("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap_err().0, 411);
        assert!(read_head_chunked(&mut std::io::Cursor::new(b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec())).unwrap().chunked);
        static TWO: Conns = Conns::new(2);
        let (a, b) = (TWO.take(), TWO.take());
        assert!(a.is_some() && b.is_some() && TWO.take().is_none());
        drop(a);
        assert!(TWO.take().is_some());
    }

    #[test]
    fn head_has_a_deadline_however_slow_the_peer() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let peer = std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            // A byte every 100 ms: each read is quick, the head never ends.
            for _ in 0..30 {
                if s.write_all(b"G").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let (s, _) = l.accept().unwrap();
        let t = Instant::now();
        let mut r = BufReader::new(Timed::new(&s, Duration::from_millis(500), Duration::from_secs(5)));
        assert!(read_head(&mut r).is_err());
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        drop(s);
        peer.join().unwrap();
    }

    #[test]
    fn fingerprints_see_what_changes() {
        let tool = |result: Option<&str>| Item::Tool { id: "t1".into(), name: "Bash".into(), summary: "ls".into(), input: "{}".into(), result: result.map(String::from), is_error: false };
        assert_ne!(fingerprint(&tool(None)), fingerprint(&tool(Some("a\nb"))));
        assert_eq!(fingerprint(&tool(Some("a\nb"))), fingerprint(&tool(Some("a\nb"))));
        let text = |t: &str| Item::Text { text: t.into(), at: 1 };
        assert_ne!(fingerprint(&text("Hel")), fingerprint(&text("Hello")));
        assert_ne!(fingerprint(&text("x")), fingerprint(&Item::Thinking { text: "x".into() }));
        assert_ne!(fingerprint(&Item::Error { text: "a".into() }), fingerprint(&Item::Error { text: "b".into() }));
    }

    #[test]
    fn decodes_urls() {
        assert_eq!(url_decode("a%2Fb+c%zz%4"), "a/b c%zz%4");
        assert_eq!(url_decode("%E2%9C%93"), "✓");
        assert_eq!(url_encode("a b/é"), "a%20b%2F%C3%A9");
        // Paths keep '+'.
        assert_eq!(head("GET /a+b%20c HTTP/1.1\r\n\r\n").unwrap().path, "/a+b c");
    }

    #[test]
    fn auth() {
        let hub = Hub::new(vec![Token { token: "s3cret".into(), name: String::new(), created: 0, group: String::new(), fp: String::new(), ..Default::default() }], DEFAULT_PORT);
        assert!(hub.known("s3cret"));
        assert!(!hub.known("s3cre"));
        assert!(!hub.known("s3cretx"));
        assert!(!hub.known(""));
        let r = head("GET / HTTP/1.1\r\nauthorization: bearer  s3cret \r\n\r\n").unwrap();
        assert_eq!(r.bearer(), Some("s3cret"));
        assert_eq!(head("GET / HTTP/1.1\r\nAuthorization: Basic s3cret\r\n\r\n").unwrap().bearer(), None);
        assert_eq!(head("GET / HTTP/1.1\r\nAuthorization: Bearer\r\n\r\n").unwrap().bearer(), None);
        let empty = Hub::new(vec![Token { token: String::new(), name: String::new(), created: 0, group: String::new(), fp: String::new(), ..Default::default() }], DEFAULT_PORT);
        assert!(!empty.known(""));
        assert_eq!(new_token().unwrap().len(), 48);
        assert_ne!(new_token().unwrap(), new_token().unwrap());
    }

    #[test]
    fn the_app_from_the_internet_only_with_a_session() {
        use crate::phoneauth::Level;
        let t = |l: Option<Level>| Ok(("tok".to_string(), l));
        assert!(apk_allowed(false, &Err("no token")) && apk_allowed(false, &t(Some(Level::Ticket))), "this network: anyone");
        assert!(apk_allowed(true, &t(None)), "the internet: a session");
        assert!(apk_allowed(true, &t(Some(Level::Legacy))), "or a pairing from before three factors, to update and upgrade");
        assert!(!apk_allowed(true, &Err("bad MAC")) && !apk_allowed(true, &t(Some(Level::Session))) && !apk_allowed(true, &t(Some(Level::Ticket))));
    }

    #[test]
    fn tokens_bind_to_the_phone_key() {
        let hub = Hub::new(vec![Token { token: "tok".into(), name: String::new(), created: 0, group: "g".repeat(16), fp: String::new(), ..Default::default() }], DEFAULT_PORT);
        let (a, b) = ("a".repeat(64), "b".repeat(64));
        // Not bound yet: plain over the tailnet still works (a phone before 0.13).
        assert!(hub.auth("tok", &Via::Legacy).is_ok());
        assert!(hub.auth("tok", &Via::Tls(None)).is_err(), "TLS needs the phone's key");
        assert!(hub.auth("tok", &Via::Refused).is_err());
        // The first key it's used with is its key from then on.
        assert!(hub.auth("tok", &Via::Tls(Some(a.clone()))).is_ok());
        assert_eq!(hub.tokens.lock().unwrap()[0].fp, a);
        assert!(hub.tokens_dirty.load(Ordering::SeqCst), "the binding is saved");
        assert!(hub.auth("tok", &Via::Tls(Some(a.clone()))).is_ok());
        assert!(hub.auth("tok", &Via::Tls(Some(b.clone()))).is_err(), "another phone with the same token");
        assert!(hub.auth("tok", &Via::Legacy).is_err(), "no going back to plain once it has a key");
        assert!(hub.auth("tok", &Via::Loopback).is_ok(), "127.0.0.1 is this PC");
        assert!(hub.auth("nope", &Via::Tls(Some(a))).is_err());
        assert!(hub.auth("", &Via::Loopback).is_err());
    }

    #[test]
    fn viewing_leases_are_apart_from_typing() {
        let hub = Hub::new(vec![], DEFAULT_PORT);
        assert!(hub.set_viewing(3, "pc:laptop", "laptop", true, true), "opening is a change");
        assert!(!hub.set_viewing(3, "pc:laptop", "laptop", true, true), "a renewal isn't");
        assert!(hub.set_viewing(3, "pc:laptop", "laptop", false, true), "the window going to the back is");
        assert_eq!(hub.viewing(3).iter().map(|t| t.kind.as_str()).collect::<Vec<_>>(), ["away"]);
        assert!(hub.typing(3).is_empty(), "viewing isn't typing");
        assert!(hub.set_viewing(3, "pc:laptop", "", false, false));
        assert!(hub.viewing(3).is_empty());
    }

    #[test]
    fn typing_leases() {
        let hub = Arc::new(Hub::new(vec![], DEFAULT_PORT));
        let r0 = hub.rev();
        assert!(hub.set_typing(5, "tok:1", "phone", "Galaxy", true), "starting is a change");
        assert_eq!(hub.typing(5).iter().map(|t| (t.device.as_str(), t.kind.as_str(), t.label.as_str())).collect::<Vec<_>>(), [("tok:1", "phone", "Galaxy")]);
        let (_, chats, state) = hub.wait(r0, Duration::ZERO);
        assert_eq!((chats, state), (vec![5], true));
        let r1 = hub.rev();
        assert!(!hub.set_typing(5, "tok:1", "phone", "Galaxy", true), "a renewal only extends the lease");
        assert_eq!(hub.rev(), r1);
        assert!(hub.set_typing(5, "pc:desk", "pc", "desk", true));
        assert_eq!(hub.typing(5).len(), 2);
        assert!(hub.set_typing(5, "tok:1", "phone", "", false), "stopping is a change");
        assert!(!hub.set_typing(5, "tok:1", "phone", "", false));
        assert_eq!(hub.typing(5).len(), 1);
        assert!(hub.typing(6).is_empty());
        // A lease that runs out wakes a waiting long-poll without anyone calling in.
        {
            let mut r = hub.revs.lock().unwrap();
            for t in r.typing.values_mut().flatten() {
                t.until = Instant::now() + Duration::from_millis(80);
            }
        }
        let since = hub.rev();
        let t = Instant::now();
        let (rev, chats, state) = hub.wait(since, Duration::from_secs(5));
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        assert!(rev > since);
        assert_eq!((chats, state), (vec![5], true));
        assert!(hub.typing(5).is_empty());
        assert_eq!(hub.next_typing_expiry(), None);
        assert_eq!(device_id("abc"), device_id("abc"));
        assert_ne!(device_id("abc"), device_id("abd"));
        assert!(device_id("abc").starts_with("tok:") && device_id("abc").len() == 12);
    }

    fn account(id: &str, kind: Kind) -> providers::Account {
        providers::Account {
            id: id.into(), kind, name: id.into(), email: String::new(), badge: "AB".into(), plan: String::new(),
            config_dir: None, bin: Some(PathBuf::from("/bin/true")), logged_in: Some(true), usage: vec![],
        }
    }

    fn chat(account: &str, started: bool, role: store::Role) -> store::Chat {
        store::Chat {
            id: 1, repo_id: None, title: "t".into(), session_id: "s".into(), started, account: account.into(), model: "claude-opus-5-5".into(),
            effort: "high".into(), access: "full".into(), settled: false, updated: 0, role, parent: None, name: "lead".into(), device: String::new(),
            gid: String::new(), home: String::new(), home_id: 0,
        }
    }

    #[test]
    fn run_settings_follow_the_desktop_rules() {
        let accounts = vec![account("claude", Kind::Claude), account("claude2", Kind::Claude), account("codex", Kind::Codex)];
        let models = |k: Kind| providers::static_models(k);
        let devs = ["ts:laptop"];
        let all: Vec<String> = accounts.iter().map(|a| a.id.clone()).collect();
        let claude: Vec<String> = vec!["claude".into(), "claude2".into()];
        let run = |c: &store::Chat, allowed: &[String], b: Value| check_run(c, &b, &accounts, allowed, &models, &devs);
        let lead = chat("claude", false, store::Role::Lead);
        assert!(matches!(run(&lead, &claude, json!({ "title": "x" })), Ok(None)), "nothing asked");
        // Another Claude account: fine; another provider: 409 (a lead runs on Claude).
        let (n, _) = run(&lead, &claude, json!({ "account": "claude2" })).unwrap().unwrap();
        assert_eq!((n.account.as_str(), n.model.as_str()), ("claude2", "claude-opus-5-5"));
        assert_eq!(run(&lead, &claude, json!({ "account": "codex" })).unwrap_err().status, 409);
        assert_eq!(run(&lead, &claude, json!({ "account": "nope" })).unwrap_err().status, 400);
        // A sub that hasn't started may change provider: its model, effort and access follow.
        let sub = store::Chat { effort: "ultracode".into(), access: "plan".into(), ..chat("claude", false, store::Role::Sub) };
        let (n, _) = run(&sub, &all, json!({ "account": "codex" })).unwrap().unwrap();
        assert_eq!(n.account, "codex");
        assert!(models(Kind::Codex).iter().any(|m| m.id == n.model), "{}", n.model);
        assert!(providers::efforts(Kind::Codex).iter().any(|e| e.0 == n.effort), "{}", n.effort);
        assert_eq!(n.access, "plan");
        // Values are checked against the provider's lists.
        assert_eq!(run(&lead, &claude, json!({ "model": "gpt-9" })).unwrap_err().status, 400);
        assert_eq!(run(&lead, &claude, json!({ "effort": "warp" })).unwrap_err().status, 400);
        assert_eq!(run(&lead, &claude, json!({ "access": "root" })).unwrap_err().status, 400);
        assert_eq!(run(&lead, &claude, json!({ "effort": 3 })).unwrap_err().status, 400);
        let (n, fast) = run(&lead, &claude, json!({ "effort": "max", "access": "edits", "fast": true })).unwrap().unwrap();
        assert_eq!((n.effort.as_str(), n.access.as_str(), fast), ("max", "edits", Some(true)));
        // Devices: before the first turn only, Claude only, known ones only.
        let (n, _) = run(&lead, &claude, json!({ "device": "ts:laptop" })).unwrap().unwrap();
        assert_eq!(n.device, "ts:laptop");
        assert_eq!(run(&lead, &claude, json!({ "device": "ts:gone" })).unwrap_err().status, 400);
        let started = chat("claude", true, store::Role::Lead);
        assert_eq!(run(&started, &claude, json!({ "device": "ts:laptop" })).unwrap_err().status, 409);
        assert!(run(&started, &claude, json!({ "device": "" })).is_ok(), "its own device again is no change");
        let codex = chat("codex", false, store::Role::Sub);
        assert_eq!(run(&codex, &all, json!({ "device": "ts:laptop" })).unwrap_err().status, 400);
        // One bad field and nothing is applied: the error comes before any change.
        assert!(run(&lead, &claude, json!({ "effort": "max", "access": "root" })).is_err());
    }

    #[test]
    fn revisions_and_long_poll() {
        let hub = Arc::new(Hub::new(vec![], DEFAULT_PORT));
        let r0 = hub.rev();
        assert!(r0 > 1_600_000_000_000, "starts at the clock");
        // Nothing new: waits out the timeout and says so.
        let (rev, chats, state) = hub.wait(r0, Duration::from_millis(30));
        assert_eq!((rev, chats.len(), state), (r0, 0, false));
        let h = hub.clone();
        let t = std::thread::spawn(move || h.wait(r0, Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(50));
        let r1 = hub.touch(Some(7), false);
        let (rev, chats, state) = t.join().unwrap();
        assert_eq!((rev, chats, state), (r1, vec![7], false));
        hub.touch(None, true);
        let (_, chats, state) = hub.wait(r1, Duration::ZERO);
        assert_eq!((chats.len(), state), (0, true));
        // From the future (an older run): answered at once, state first.
        let (_, _, state) = hub.wait(hub.rev() + 1000, Duration::from_secs(5));
        assert!(state);
    }

    #[test]
    fn names_and_uploads() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\x\\photo.jpg"), "photo.jpg");
        assert_eq!(safe_name(".hidden"), "hidden");
        assert_eq!(safe_name(""), "file");
        assert!(resolve_upload("../x").is_none());
        assert!(resolve_upload("/etc/passwd").is_none());
        assert!(resolve_upload("pending/../../x").is_none());
        assert!(resolve_upload("a/b/c").is_none());
    }

    /// One request over a real socket: (status, JSON body).
    fn call(port: u16, raw: &str) -> (u16, Value) {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        let (head, body) = out.split_once("\r\n\r\n").unwrap();
        let status = head.split(' ').nth(1).unwrap().parse().unwrap();
        assert!(head.contains(&format!("Content-Length: {}", body.len())), "{head}");
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    #[test]
    fn http_end_to_end() {
        let hub = Arc::new(Hub::new(vec![Token { token: "tok".into(), name: String::new(), created: 0, group: String::new(), fp: String::new(), ..Default::default() }], 0));
        hub.enabled.store(true, Ordering::SeqCst);
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = channel();
        {
            let hub = hub.clone();
            std::thread::spawn(move || accept(l, hub, tx, || {}));
        }
        // The UI thread's part: echoes what it was asked.
        std::thread::spawn(move || {
            while let Ok(crate::control::Incoming::Api(c)) = rx.recv() {
                let _ = c.reply.send(ok(json!({ "method": c.method, "path": c.path, "body": c.body, "device": c.device })));
            }
        });
        let (st, v) = call(port, "GET /v1/state HTTP/1.1\r\n\r\n");
        assert_eq!(st, 401);
        assert!(v["error"].is_string());
        assert_eq!(call(port, "GET /v1/state HTTP/1.1\r\nAuthorization: Bearer nope\r\n\r\n").0, 401);
        let body = r#"{"title":"x"}"#;
        let (st, v) = call(port, &format!("PATCH /v1/chats/4 HTTP/1.1\r\nAuthorization: Bearer tok\r\nX-Harbor-Device: Pixel\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
        assert_eq!(st, 200);
        assert_eq!(v, json!({ "method": "PATCH", "path": ["v1", "chats", "4"], "body": { "title": "x" }, "device": "Pixel" }));
        assert_eq!(hub.seen.lock().unwrap()["tok"].0, "Pixel");
        assert_eq!(call(port, "POST /v1/chats HTTP/1.1\r\nAuthorization: Bearer tok\r\nContent-Length: 3\r\n\r\n{x}").0, 400);
        let (st, v) = call(port, "GET /v1/app HTTP/1.1\r\nAuthorization: Bearer tok\r\n\r\n");
        assert_eq!((st, v["url"].as_str()), (200, Some("/app.apk")));
        // The APK needs no token, also for a HEAD first (404 here when this PC has none).
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(b"HEAD /app.apk HTTP/1.1\r\n\r\n").unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 200") || out.starts_with("HTTP/1.1 404"), "{out}");
        // Typing is answered on the connection's thread (no UI round trip).
        let (st, _) = call(port, "POST /v1/chats/4/typing HTTP/1.1\r\nAuthorization: Bearer tok\r\nX-Harbor-Device: Pixel\r\nContent-Length: 2\r\n\r\n{}");
        assert_eq!(st, 200);
        let t = hub.typing(4);
        assert_eq!((t[0].label.as_str(), t[0].kind.as_str(), t[0].device.clone()), ("Pixel", "phone", device_id("tok")));
        let body = r#"{"typing":false}"#;
        call(port, &format!("POST /v1/chats/4/typing HTTP/1.1\r\nAuthorization: Bearer tok\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
        assert!(hub.typing(4).is_empty());
        // The long-poll returns as soon as a chat changes.
        let since = hub.rev();
        let h = hub.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            h.touch(Some(9), false);
        });
        let t = Instant::now();
        let (st, v) = call(port, &format!("GET /v1/events?since={since} HTTP/1.1\r\nAuthorization: Bearer tok\r\n\r\n"));
        assert_eq!(st, 200);
        assert!(t.elapsed() < Duration::from_secs(5));
        assert_eq!(v["changed_chats"], json!([9]));
        assert_eq!(v["state_changed"], false);
        assert_eq!(v["rev"].as_u64(), Some(since + 1));
        // Off: connections are closed without an answer.
        hub.enabled.store(false, Ordering::SeqCst);
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _ = c.write_all(b"GET /v1/app HTTP/1.1\r\nAuthorization: Bearer tok\r\n\r\n");
        let mut out = String::new();
        let _ = c.read_to_string(&mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn the_phone_inbox() {
        let tok = |t: &str, g: &str| Token { token: t.into(), name: String::new(), created: 0, group: g.into(), fp: String::new(), ..Default::default() };
        let hub = Arc::new(Hub::new(vec![tok("a", "ga"), tok("b", "gb")], 0));
        hub.enabled.store(true, Ordering::SeqCst);
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, _rx) = channel();
        {
            let hub = hub.clone();
            std::thread::spawn(move || accept(l, hub, tx, || {}));
        }
        let log: Arc<Mutex<Vec<(u64, bool, Option<String>)>>> = Default::default();
        let report = |log: &Arc<Mutex<Vec<(u64, bool, Option<String>)>>>| -> Report {
            let log = log.clone();
            Arc::new(move |sent, done, e| log.lock().unwrap().push((sent, done, e)))
        };
        let dir = std::env::temp_dir().join(format!("harbor-inbox-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.bin");
        std::fs::write(&file, b"hello phone").unwrap();
        let since = hub.rev();
        hub.post(Parcel { id: "t1".into(), group: "ga".into(), kind: "text", name: "Text".into(), text: "copied".into(), path: None, temp: false, size: 0, at: Instant::now(), report: report(&log) });
        hub.post(Parcel { id: "f1".into(), group: "ga".into(), kind: "file", name: "note.bin".into(), text: String::new(), path: Some(file.clone()), temp: true, size: 11, at: Instant::now(), report: report(&log) });
        // A post wakes the phone's long-poll, which says how much waits.
        let (st, v) = call(port, &format!("GET /v1/events?since={since} HTTP/1.1\r\nAuthorization: Bearer a\r\n\r\n"));
        assert_eq!((st, v["inbox"].as_u64()), (200, Some(2)));
        let (_, v) = call(port, "GET /v1/inbox HTTP/1.1\r\nAuthorization: Bearer a\r\n\r\n");
        assert_eq!(v["items"], json!([{ "id": "t1", "kind": "text", "name": "Text", "size": 0, "text": "copied" }, { "id": "f1", "kind": "file", "name": "note.bin", "size": 11 }]));
        // Another pairing sees none of it, and can't fetch or end it.
        assert_eq!(call(port, "GET /v1/inbox HTTP/1.1\r\nAuthorization: Bearer b\r\n\r\n").1["items"], json!([]));
        assert_eq!(call(port, "GET /v1/inbox/f1 HTTP/1.1\r\nAuthorization: Bearer b\r\n\r\n").0, 404);
        assert_eq!(call(port, "POST /v1/inbox/f1/done HTTP/1.1\r\nAuthorization: Bearer b\r\nContent-Length: 0\r\n\r\n").0, 404);
        // The bytes, with progress for the sender.
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(b"GET /v1/inbox/f1 HTTP/1.1\r\nAuthorization: Bearer a\r\n\r\n").unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 200") && out.ends_with("\r\n\r\nhello phone"), "{out}");
        assert_eq!(log.lock().unwrap().last(), Some(&(11, false, None)));
        // Picked up: gone, delivered, its temp copy deleted.
        assert_eq!(call(port, "POST /v1/inbox/f1/done HTTP/1.1\r\nAuthorization: Bearer a\r\nContent-Length: 2\r\n\r\n{}").0, 200);
        assert_eq!(log.lock().unwrap().last(), Some(&(11, true, None)));
        assert!(!file.exists());
        let body = r#"{"error":"no space"}"#;
        call(port, &format!("POST /v1/inbox/t1/done HTTP/1.1\r\nAuthorization: Bearer a\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
        assert_eq!(log.lock().unwrap().last(), Some(&(0, false, Some("On the phone: no space".into()))));
        assert_eq!(call(port, "GET /v1/inbox HTTP/1.1\r\nAuthorization: Bearer a\r\n\r\n").1["items"], json!([]));
        // Nobody came for a day: given up on.
        hub.post(Parcel { id: "o1".into(), group: "ga".into(), kind: "text", name: "Text".into(), text: "x".into(), path: None, temp: false, size: 0, at: Instant::now() - INBOX_TTL - Duration::from_secs(1), report: report(&log) });
        assert!(hub.inbox_for("ga").is_empty());
        assert!(log.lock().unwrap().last().unwrap().2.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn paired_phones_one_per_pairing() {
        let tok = |t: &str, g: &str, n: &str| Token { token: t.into(), name: n.into(), created: 0, group: g.into(), fp: String::new(), ..Default::default() };
        let hub = Hub::new(vec![tok("a1", "ga", ""), tok("a2", "ga", "Pixel"), tok("b", "gb", "")], 0);
        hub.seen.lock().unwrap().insert("a1".into(), ("Pixel 8".into(), 50));
        hub.ips.lock().unwrap().insert("a1".into(), "192.0.2.7".into());
        let p = hub.paired_phones();
        assert_eq!(p.len(), 2);
        assert_eq!((p[0].group.as_str(), p[0].name.as_str(), p[0].seen, p[0].ip.as_str()), ("ga", "Pixel 8", 50, "192.0.2.7"));
        assert_eq!((p[1].group.as_str(), p[1].seen), ("gb", 0));
    }

    #[test]
    fn phones_seen_elsewhere_and_their_apps() {
        let tok = |t: &str, g: &str| Token { token: t.into(), name: String::new(), created: 0, group: g.into(), fp: String::new(), ..Default::default() };
        let hub = Arc::new(Hub::new(vec![tok("a", "ga"), tok("b", "gb"), tok("c", "gc")], 0));
        hub.enabled.store(true, Ordering::SeqCst);
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = channel();
        {
            let hub = hub.clone();
            std::thread::spawn(move || accept(l, hub, tx, || {}));
        }
        std::thread::spawn(move || {
            while let Ok(crate::control::Incoming::Api(c)) = rx.recv() {
                let _ = c.reply.send(ok(json!({})));
            }
        });
        // An app from 0.19 says its version; one that picks up sends is at least 0.17.
        call(port, "GET /v1/app HTTP/1.1\r\nAuthorization: Bearer a\r\nX-Harbor-App: 18001\r\n\r\n");
        call(port, "GET /v1/inbox HTTP/1.1\r\nAuthorization: Bearer b\r\n\r\n");
        let local = hub.local_phones();
        let app = |g: &str| local.iter().find(|p| p.group == g).unwrap().app;
        assert_eq!((app("ga"), app("gb"), app("gc")), (18001, APP_INBOX, 0));
        // Another PC saw phone c more recently (with a newer app): online there, via that PC.
        let later = store::now() + 1;
        hub.elsewhere.lock().unwrap().insert("pc:acer".into(), ("acer".into(), vec![Sighting { group: "gc".into(), name: "A13".into(), seen: later, app: 16002, alive: 0 }, Sighting { group: "zz".into(), name: "not ours".into(), seen: later, app: 1, alive: 0 }]));
        let p = hub.paired_phones();
        assert_eq!(p.len(), 3, "only pairings this PC has");
        assert_eq!((p[0].group.as_str(), p[0].seen, p[0].via.as_str(), p[0].name.as_str(), p[0].app), ("gc", later, "acer", "A13", 16002));
        let a = p.iter().find(|p| p.group == "ga").unwrap();
        assert_eq!(a.via, "", "seen here last");
    }

    #[test]
    fn uploads_land_in_their_folder() {
        let base = std::env::temp_dir().join(format!("harbor-api-up-{}", std::process::id()));
        let raw = "GET /v1/upload?name=..%2Fphoto.jpg&chat=12 HTTP/1.1\r\nContent-Length: 4\r\n\r\n";
        let mut cur = std::io::Cursor::new(format!("{raw}abcd").into_bytes());
        let req = read_head(&mut cur).unwrap();
        let r = upload_to(&mut cur, &req, &base);
        assert_eq!(r.status, 201, "{:?}", r.body);
        let id = r.body["id"].as_str().unwrap();
        assert!(id.starts_with("12/") && id.ends_with("-photo.jpg"), "{id}");
        assert_eq!(std::fs::read(base.join(id)).unwrap(), b"abcd");
        // A body shorter than its length leaves nothing behind.
        let mut cur = std::io::Cursor::new(format!("{raw}ab").into_bytes());
        let req = read_head(&mut cur).unwrap();
        assert_eq!(upload_to(&mut cur, &req, &base).status, 400);
        assert_eq!(std::fs::read_dir(base.join("12")).unwrap().count(), 1);
        let mut cur = std::io::Cursor::new(b"POST /v1/upload?chat=x HTTP/1.1\r\nContent-Length: 0\r\n\r\n".to_vec());
        let req = read_head(&mut cur).unwrap();
        assert_eq!(upload_to(&mut cur, &req, &base).status, 400);
        // The app names its chat by gid: the hub's own id, or pending/ for one it doesn't know.
        let gid = |g: &str| (g == "4e47-gid").then_some(7);
        let raw = |chat: &str| format!("POST /v1/upload?name=a.png&chat={chat} HTTP/1.1\r\nContent-Length: 2\r\n\r\nab");
        for (chat, dir) in [("4e47-gid", "7/"), ("12", "12/"), ("someone-else", "pending/")] {
            let mut cur = std::io::Cursor::new(raw(chat).into_bytes());
            let req = upload_request(&read_head(&mut cur).unwrap(), gid);
            let r = upload_to(&mut cur, &req, &base);
            assert!(r.status == 201 && r.body["id"].as_str().unwrap().starts_with(dir), "{chat}: {:?}", r.body);
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    fn s(text: &str) -> Span {
        Span { text: text.into(), ..Default::default() }
    }

    #[test]
    fn block_model() {
        let b = blocks("# Title\n\nSome **bold** and *it* and `code` and [a link](https://x.y).\n\n---\n\n```rust\nfn main() {}\n```\n");
        assert_eq!(b[0], Block::Heading { level: 1, spans: vec![s("Title")] });
        let Block::Paragraph { spans } = &b[1] else { panic!("{b:?}") };
        assert_eq!(spans[0], s("Some "));
        assert_eq!(spans[1], Span { bold: true, ..s("bold") });
        assert_eq!(spans[3], Span { italic: true, ..s("it") });
        assert_eq!(spans[5], Span { code: true, ..s("code") });
        assert_eq!(spans[7], Span { link: Some("https://x.y".into()), ..s("a link") });
        assert_eq!(b[2], Block::Rule);
        assert_eq!(b[3], Block::Code { lang: "rust".into(), text: "fn main() {}".into() });
    }

    #[test]
    fn block_lists_quotes_tables() {
        let b = blocks("- one\n- two\n  1. a\n  2. b\n\n> quoted\n> more\n\n| A | B |\n|---|---|\n| 1 | **2** |\n");
        let Block::List { ordered: false, items, .. } = &b[0] else { panic!("{b:?}") };
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], vec![Block::Paragraph { spans: vec![s("one")] }]);
        assert_eq!(items[1][0], Block::Paragraph { spans: vec![s("two")] });
        let Block::List { ordered: true, start: 1, items: sub } = &items[1][1] else { panic!("{:?}", items[1]) };
        assert_eq!(sub.len(), 2);
        assert_eq!(b[1], Block::Quote { blocks: vec![Block::Paragraph { spans: vec![s("quoted more")] }] });
        let Block::Table { rows } = &b[2] else { panic!("{b:?}") };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], vec![vec![s("A")], vec![s("B")]]);
        assert_eq!(rows[1][1], vec![Span { bold: true, ..s("2") }]);
        // Ordered list start and task markers.
        let b = blocks("3. x\n4. y\n\n- [x] done\n");
        assert!(matches!(&b[0], Block::List { ordered: true, start: 3, .. }));
        let Block::List { items, .. } = &b[1] else { panic!() };
        assert_eq!(items[0], vec![Block::Paragraph { spans: vec![s("☑ done")] }]);
        // Serialized as the phone reads it: a "type" tag, default flags left out.
        let v = serde_json::to_value(&blocks("**b**")).unwrap();
        assert_eq!(v, json!([{ "type": "paragraph", "spans": [{ "text": "b", "bold": true }] }]));
        assert_eq!(serde_json::to_value(Block::Rule).unwrap(), json!({ "type": "rule" }));
        assert!(blocks("").is_empty());
    }

    #[test]
    fn items_on_the_wire() {
        let one = |it: Item| {
            let items = vec![it];
            let cards = crate::view::project(&items, false, &[], &|_: &str, _: &str| String::new());
            card_json(&cards[0], 9, &mut |_| vec![])
        };
        let v = one(Item::User { text: "hi".into(), files: vec!["/a/b/photo.jpg".into(), "/a/notes.txt".into()], at: 5, mentions: vec![], sender: String::new() });
        assert_eq!((v["kind"].as_str(), v["seq"].as_u64(), v["rev"].as_u64()), (Some("user"), Some(0), Some(9)));
        assert_eq!(v["files"], json!(["notes.txt"]));
        assert_eq!(v["images"], json!([{ "name": "photo.jpg", "url": "/v1/image?path=%2Fa%2Fb%2Fphoto.jpg&max=512" }]));
        let v = one(Item::Tool { id: "t".into(), name: "mcp__github__get_pr".into(), summary: "ls".into(), input: "x".repeat(CLIP * 2), result: None, is_error: false });
        assert_eq!((v["label"].as_str(), v["done"].as_bool()), (Some("github · get_pr"), Some(false)));
        assert!(v["input"].as_str().unwrap().len() < CLIP + 100);
        let v = one(Item::Text { text: "# H".into(), at: 0 });
        assert_eq!((v["markdown"].as_str(), v["blocks"][0]["type"].as_str()), (Some("# H"), Some("heading")));
        let v = one(Item::Result { cost_usd: 0.0, duration_ms: 75_000, turns: 1, input_tokens: 0, output_tokens: 0, cached: 0, at: 0, account: String::new(), model: String::new() });
        assert_eq!((v["kind"].as_str(), v["text"].as_str()), (Some("footer"), Some("75.0s · 0 in · 0 out")));
    }

    /// The phone gets the desktop's projection of a chat, card for card: the same cards hidden,
    /// the same kinds in the same order, the same footer text, labels, dividers and images.
    #[test]
    fn the_phone_sees_what_the_desktop_draws() {
        use crate::view::{Card, kind, project};
        let items = crate::view::fixture();
        let who = |a: &str, _m: &str| if a == "claude" { "Claude · AB · Opus 5.5 · ".to_string() } else { String::new() };
        let forks = [(8, 42)];
        // What chat.rs draws: these cards, skipping the hidden ones.
        let desktop = project(&items, true, &forks, &who);
        let phone: Vec<Value> = desktop.iter().map(|c| card_json(c, 1, &mut |_| vec![])).collect();
        assert_eq!(phone.len(), items.len(), "one card per item, so seq stays the item's index");
        for (d, p) in desktop.iter().zip(&phone) {
            assert_eq!(p["kind"].as_str(), Some(kind(&d.card)));
            assert_eq!(p["seq"].as_u64(), Some(d.seq as u64));
            assert_eq!(p["forks_after"].as_array().map(|a| a.len()).unwrap_or(0), d.forks_after.len());
            match &d.card {
                Card::Footer { text, .. } => assert_eq!(p["text"].as_str(), Some(text.as_str())),
                Card::Text { text, forkable, .. } => assert_eq!((p["markdown"].as_str(), p["forkable"].as_bool()), (Some(*text), Some(*forkable))),
                Card::Tool { label, .. } => assert_eq!(p["label"].as_str(), Some(label.as_str())),
                Card::Message { from, to, text } => assert_eq!((p["from"].as_str(), p["to"].as_str(), p["text"].as_str()), (Some(*from), Some(*to), Some(*text))),
                Card::Notice { url, .. } => assert_eq!(p["url"].as_str(), *url),
                _ => {}
            }
        }
        let shown: Vec<&str> = phone.iter().filter(|p| p["kind"] != "hidden").map(|p| p["kind"].as_str().unwrap()).collect();
        assert_eq!(shown, ["user", "message", "tool", "text", "footer", "notice", "error"]);
        assert_eq!(phone[9]["text"], "Claude · AB · Opus 5.5 · 4.3s · 189k in (180k cached) · 304 out · $3.96");
        assert_eq!(phone[8]["forks_after"], json!([42]));
    }
}
