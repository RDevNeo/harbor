//! The phone API: Harbor for Android drives this Harbor's chats over the network.
//!
//! A fourth listener like control.rs and bridge.rs: hand-written HTTP/1.1 on `std::net`, a
//! thread per connection, no async runtime. It listens on every interface on port 47930 (kv
//! `api_port`; `HARBOR_LISTEN=addr,…` picks addresses instead) and speaks mutual TLS with
//! pinned certificates (tls.rs) to everything but 127.0.0.1: a phone pins this PC's key from
//! its workspace's directory and shows its own. Every request but `GET /app.apk` carries
//! `Authorization: Bearer <Harbor token>`: the phone's Google sign-in, signed by the account
//! service and bound to the phone's key, which this PC checks itself, offline (account.rs).
//! Only members of this PC's workspace get in. Pairing tokens from before accounts (kv
//! `api_tokens`) only let an old app update itself. Plain HTTP is answered on 127.0.0.1 only,
//! and on this PC's Tailscale interface for clients that haven't upgraded yet (`tls::legacy`).
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
pub const MAX_AUDIO: usize = 16_000 * 2 * 600 + 4096;
/// The most a request's line and headers may take to arrive.
pub const HEAD_WAIT: Duration = Duration::from_secs(10);
const MAX_UPLOAD: usize = 200 << 20;
/// Tool inputs and results are cut to this on the wire (the desktop keeps them whole).
const CLIP: usize = 16 << 10;

// ================================================================== shared state

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Default)]
pub struct Token {
    /// This PC's own handle for the phone (never shown to it): seen, inbox and Devices go by it.
    pub token: String,
    /// What the phone calls itself (`X-Harbor-Device`), once it has connected.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub created: i64,
    /// The phone: the fingerprint of its key for a signed-in phone (the same on every PC of the
    /// workspace), a pairing's group before accounts.
    #[serde(default)]
    pub group: String,
    /// The fingerprint of the phone's key (tls.rs).
    #[serde(default)]
    pub fp: String,
    /// The account signed in on the phone (account.rs): its id and name. Empty: a pairing from
    /// before accounts, good only for updating the app.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub account: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub account_name: String,
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
    /// Each chat's shared composer draft (0.64): what any device last wrote in it.
    drafts: HashMap<i64, SharedDraft>,
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
        // A draft held back by the debounce is due: announce it now.
        for (chat, v) in self.typing.iter_mut() {
            for t in v.iter_mut().filter(|t| t.held && t.quiet.is_some_and(|q| q <= now)) {
                t.held = false;
                t.quiet = Some(now + PREVIEW_GAP);
                gone.push(*chat);
            }
        }
        for (chat, d) in self.drafts.iter_mut().filter(|(_, d)| d.held && d.quiet.is_some_and(|q| q <= now)) {
            d.held = false;
            d.quiet = Some(now + PREVIEW_GAP);
            if !gone.contains(chat) {
                gone.push(*chat);
            }
        }
        for map in [&mut self.typing, &mut self.viewing] {
            for (chat, v) in map.iter_mut() {
                let n = v.len();
                v.retain(|t| t.until > now);
                if v.len() != n && !gone.contains(chat) {
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
        let drafts = self.drafts.values().filter(|d| d.held).filter_map(|d| d.quiet);
        let held = self.typing.values().flatten().filter(|t| t.held).filter_map(|t| t.quiet).chain(drafts);
        self.typing.values().chain(self.viewing.values()).flatten().map(|t| t.until).chain(held).min()
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
    /// What they have in their composer (the last [`PREVIEW_CHARS`]), "" when unknown.
    pub text: String,
    /// A draft change isn't announced again before this (the debounce, see [`PREVIEW_GAP`]).
    pub quiet: Option<Instant>,
    /// A draft change waits for `quiet` to be announced.
    pub held: bool,
}

impl Typer {
    pub fn new(device: &str, kind: &str, label: &str, text: &str, until: Instant) -> Typer {
        Typer { device: device.into(), kind: kind.into(), label: label.into(), until, text: text.into(), quiet: None, held: false }
    }
}

/// How long one typing signal lasts (clients renew it every ~3 s).
pub const TYPING_TTL: Duration = Duration::from_secs(6);
/// How long a PC's "this chat is open here" lasts (renewed every few seconds while open).
pub const VIEWING_TTL: Duration = Duration::from_secs(15);
/// Draft previews wake the long-polls at most this often per typer.
pub const PREVIEW_GAP: Duration = Duration::from_millis(400);
/// How much of a draft a typing report keeps: its end, where the cursor usually is.
pub const PREVIEW_CHARS: usize = 500;

/// The most text a shared draft keeps (its start goes beyond).
pub const DRAFT_CHARS: usize = 32_000;
/// The most files and mentions a shared draft holds.
pub const DRAFT_ITEMS: usize = 20;

/// A chat's shared composer draft: the same text, files and mentions in every device's
/// composer. Any device's edit replaces it (last writer wins; clients don't apply it over
/// their own edit of the last second); a send or an emptied composer clears it. It stays
/// after the typer's lease runs out (it's just a draft then), until the hub restarts.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SharedDraft {
    pub text: String,
    pub files: Vec<DraftFile>,
    /// Mentioned messages (`mentions::Mention` as JSON), an array.
    pub mentions: Vec<Value>,
    /// The device that wrote it ("" after a send) and its label.
    pub by: String,
    pub label: String,
    /// Grows with every change, across chats: a client applies a draft newer than the last it saw.
    pub rev: u64,
    quiet: Option<Instant>,
    held: bool,
}

/// A file in a shared draft: an upload on this hub (`id`, as `/v1/upload` answers it) and
/// its path here (for `/v1/image`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DraftFile {
    pub id: String,
    pub name: String,
    pub path: String,
}

impl DraftFile {
    pub fn of_upload(id: &str) -> Option<DraftFile> {
        let path = resolve_upload(id)?;
        let name = path.file_name()?.to_string_lossy().into_owned();
        Some(DraftFile { id: id.into(), name, path: path.to_string_lossy().into_owned() })
    }
}

impl SharedDraft {
    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.files.is_empty() && self.mentions.is_empty()
    }

    /// As the chats list and items replies carry it.
    pub fn json(&self) -> Value {
        json!({ "text": self.text, "files": self.files, "mentions": self.mentions, "by": self.by, "label": self.label, "rev": self.rev })
    }

    /// From `json` (another PC's status of its chat).
    pub fn from_json(v: &Value) -> Option<SharedDraft> {
        let rev = v["rev"].as_u64()?;
        let files = v["files"].as_array().into_iter().flatten().filter_map(|f| serde_json::from_value::<DraftFileIn>(f.clone()).ok()).map(|f| DraftFile { id: f.id, name: f.name, path: f.path }).collect();
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        Some(SharedDraft { text: s("text"), files, mentions: v["mentions"].as_array().cloned().unwrap_or_default(), by: s("by"), label: s("label"), rev, quiet: None, held: false })
    }
}

#[derive(Deserialize)]
struct DraftFileIn {
    id: String,
    name: String,
    #[serde(default)]
    path: String,
}

/// A composer edited this recently isn't overwritten by another device's draft.
pub const DRAFT_HOLD: Duration = Duration::from_secs(1);

#[derive(Debug, PartialEq)]
pub enum Apply {
    /// Into the composer now.
    Now,
    /// Not now (this composer was just edited); try again.
    Later,
    /// Never: this device wrote it.
    Skip,
}

/// Whether a newer shared draft goes into this device's composer (`me`; `edited`: its
/// composer's last edit). The phone follows the same rules (Chat.java).
pub fn should_apply(d: &SharedDraft, me: &str, edited: Option<Instant>, now: Instant) -> Apply {
    if d.by == me {
        Apply::Skip
    } else if edited.is_some_and(|e| now.saturating_duration_since(e) < DRAFT_HOLD) {
        Apply::Later
    } else {
        Apply::Now
    }
}

/// The end of a draft, at most [`PREVIEW_CHARS`] long.
pub fn preview_tail(text: &str) -> String {
    let n = text.chars().count();
    text.chars().skip(n.saturating_sub(PREVIEW_CHARS)).collect()
}

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
    /// The account signed in on it ("" for a pairing from before accounts).
    pub owner: String,
    /// What the phone says it is (`X-Harbor-Platform`, apps from 0.84): model, Android version,
    /// ABIs and whether its built-in browser runs ("" when unknown).
    pub platform: String,
    /// When its app last said it's alive from the background (`POST /v1/alive`), here or on
    /// another PC of the mesh (0: never): reachable, even with the app closed.
    pub alive: i64,
}

const PHONES_SEEN: &str = "phones_seen";

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
    /// See [`PairedPhone::platform`] ("" from a PC before 0.84).
    pub platform: String,
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
    /// Token → what its phone says it is (`X-Harbor-Platform`): this session only.
    pub platforms: Mutex<HashMap<String, String>>,
    /// Token → (unix s, the ping's own ms) of its app's last background ping (`POST /v1/alive`):
    /// this session only. Each ping's time must be later than the last (no replays).
    pub alive: Mutex<HashMap<String, (i64, u64)>>,
    /// Peer id → (its name, the phones it saw): the mesh's view of where phones are.
    pub elsewhere: Mutex<HashMap<String, (String, Vec<Sighting>)>>,
    /// Pairing → the phone as this PC last saw it in an earlier run (kv `phones_seen`, 0.68):
    /// its last-seen time and app version outlive a restart.
    pub remembered: Mutex<HashMap<String, Sighting>>,
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
            platforms: Mutex::new(HashMap::new()),
            elsewhere: Mutex::new(HashMap::new()),
            remembered: Mutex::new(HashMap::new()),
            inbox: Mutex::new(vec![]),
            revs: Mutex::new(Revs { rev: base, state: base, ..Default::default() }),
            cv: Condvar::new(),
            net: Mutex::new(Net::default()),
            epoch: base,
            mesh: Default::default(),
            tokens_dirty: AtomicBool::new(false),
            revoked: Mutex::new(vec![]),
            notes: Default::default(),
        }
    }

    /// Phones or the mesh are on: the listener answers and changes are counted.
    pub fn active(&self) -> bool {
        self.enabled.load(Ordering::Relaxed) || self.mesh.on.load(Ordering::Relaxed)
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
    /// long-polls; a renewal only extends the lease. `text` is their draft (`None`: an older
    /// client, the draft isn't known); a new draft wakes the long-polls at most every
    /// [`PREVIEW_GAP`]. True when anything visible changed now.
    pub fn set_typing(&self, chat: i64, device: &str, kind: &str, label: &str, on: bool, text: Option<&str>) -> bool {
        self.lease(false, chat, device, kind, label, on, text.map(preview_tail).as_deref())
    }

    /// A PC has `chat` open (`focused`: its window is in front), or closed it.
    pub fn set_viewing(&self, chat: i64, device: &str, label: &str, focused: bool, on: bool) -> bool {
        self.lease(true, chat, device, if focused { "focused" } else { "away" }, label, on, None)
    }

    /// Which PCs have `chat` open now.
    pub fn viewing(&self, chat: i64) -> Vec<Typer> {
        let now = Instant::now();
        self.revs.lock().unwrap().viewing.get(&chat).map(|v| v.iter().filter(|t| t.until > now).cloned().collect()).unwrap_or_default()
    }

    #[allow(clippy::too_many_arguments)]
    fn lease(&self, view: bool, chat: i64, device: &str, kind: &str, label: &str, on: bool, text: Option<&str>) -> bool {
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
                if let Some(text) = text.filter(|t| *t != v[i].text) {
                    v[i].text = text.into();
                    if v[i].quiet.is_some_and(|q| q > now) {
                        v[i].held = true;
                    } else {
                        v[i].quiet = Some(now + PREVIEW_GAP);
                        changed = true;
                    }
                }
            }
            (None, true) => {
                let mut t = Typer::new(device, kind, label, text.unwrap_or(""), now + ttl);
                t.quiet = Some(now + PREVIEW_GAP);
                v.push(t);
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

    /// A device's composer for `chat` now holds this (`files`/`mentions` `None`: kept as
    /// they are, e.g. an older client that only knows text). New content wakes the
    /// long-polls at most every [`PREVIEW_GAP`]. True when that happened now.
    #[allow(clippy::too_many_arguments)]
    pub fn set_draft(&self, chat: i64, device: &str, label: &str, text: &str, files: Option<Vec<DraftFile>>, mentions: Option<Vec<Value>>) -> bool {
        let now = Instant::now();
        let mut r = self.revs.lock().unwrap();
        let mut changed = r.prune(now);
        let n = text.chars().count();
        let text: String = if n > DRAFT_CHARS { text.chars().skip(n - DRAFT_CHARS).collect() } else { text.to_string() };
        let old = r.drafts.get(&chat).cloned().unwrap_or_default();
        let mut d = SharedDraft { text, files: files.unwrap_or_else(|| old.files.clone()), mentions: mentions.unwrap_or_else(|| old.mentions.clone()), by: device.into(), label: label.into(), ..old.clone() };
        d.files.truncate(DRAFT_ITEMS);
        d.mentions.truncate(DRAFT_ITEMS);
        if (&d.text, &d.files, &d.mentions) == (&old.text, &old.files, &old.mentions) {
            drop(r);
            if changed {
                self.cv.notify_all();
            }
            return changed;
        }
        r.rev += 1;
        d.rev = r.rev;
        let now_too = !d.quiet.is_some_and(|q| q > now);
        if now_too {
            d.quiet = Some(now + PREVIEW_GAP);
            d.held = false;
            changed = true;
        } else {
            d.held = true;
        }
        r.drafts.insert(chat, d);
        if changed {
            r.mark(chat);
            drop(r);
            self.cv.notify_all();
        }
        now_too
    }

    /// A typing report: the lease, and the composer's content when it says (`draft`
    /// `{text, files?, mentions?}`, files as upload ids; an older client sends only `text`).
    /// True when anything visible changed now.
    #[allow(clippy::too_many_arguments)]
    pub fn report(&self, chat: i64, device: &str, kind: &str, label: &str, on: bool, draft: Option<&Value>) -> bool {
        let text = draft.and_then(|d| d["text"].as_str());
        let mut changed = self.set_typing(chat, device, kind, label, on, text);
        if let Some(d) = draft {
            // Only `text`: an older client (0.56); it doesn't stop typing on an empty composer.
            let text_only = d.get("files").is_none() && d.get("mentions").is_none();
            if !(text_only && !on) {
                let files = d["files"].as_array().map(|a| a.iter().filter_map(|f| f.as_str().or(f["id"].as_str())).filter_map(DraftFile::of_upload).collect());
                let mentions = d["mentions"].as_array().cloned();
                changed |= self.set_draft(chat, device, label, text.unwrap_or(""), files, mentions);
            }
        }
        changed
    }

    /// A message went out of `chat`: its draft empties in every composer (at once), and who
    /// was typing in it stops (it was that one shared draft: the message doesn't wait for them).
    pub fn clear_draft(&self, chat: i64) {
        let mut r = self.revs.lock().unwrap();
        let typers = r.typing.remove(&chat).is_some();
        if r.drafts.get(&chat).is_none_or(|d| d.is_empty()) {
            if typers {
                r.mark(chat);
                drop(r);
                self.cv.notify_all();
            }
            return;
        }
        r.rev += 1;
        let rev = r.rev;
        r.drafts.insert(chat, SharedDraft { rev, ..Default::default() });
        r.mark(chat);
        drop(r);
        self.cv.notify_all();
    }

    /// `chat`'s shared draft, if any device wrote one since the hub started.
    pub fn draft(&self, chat: i64) -> Option<SharedDraft> {
        self.revs.lock().unwrap().drafts.get(&chat).cloned()
    }

    /// Every chat's shared draft revision (cheap; for the desktop to spot new ones).
    pub fn draft_revs(&self) -> Vec<(i64, u64)> {
        self.revs.lock().unwrap().drafts.iter().map(|(c, d)| (*c, d.rev)).collect()
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
        let platforms = self.platforms.lock().unwrap().clone();
        let alive = self.alive.lock().unwrap().clone();
        let mut out: Vec<PairedPhone> = vec![];
        for t in tokens.iter().filter(|t| !t.group.is_empty()) {
            let (named, at) = seen.get(&t.token).cloned().unwrap_or_default();
            let name = if !named.is_empty() { named } else { t.name.clone() };
            let ip = ips.get(&t.token).cloned().unwrap_or_default();
            let app = apps.get(&t.token).copied().unwrap_or(0);
            let pinged = alive.get(&t.token).map_or(0, |a| a.0);
            let platform = platforms.get(&t.token).cloned().unwrap_or_default();
            match out.iter_mut().find(|p| p.group == t.group) {
                Some(p) => {
                    if !platform.is_empty() && (p.platform.is_empty() || at > p.seen) {
                        p.platform = platform;
                    }
                    p.app = p.app.max(app);
                    p.alive = p.alive.max(pinged);
                    if p.owner.is_empty() {
                        p.owner = t.account_name.clone();
                    }
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
                None => out.push(PairedPhone { group: t.group.clone(), name, seen: at, ip, app, via: String::new(), owner: t.account_name.clone(), alive: pinged, platform }),
            }
        }
        // Not seen in this run: what an earlier one saw.
        let remembered = self.remembered.lock().unwrap().clone();
        for p in out.iter_mut() {
            if let Some(r) = remembered.get(&p.group) {
                p.app = p.app.max(r.app);
                if p.seen == 0 {
                    p.seen = r.seen;
                    if p.name.is_empty() {
                        p.name = r.name.clone();
                    }
                }
                p.alive = p.alive.max(r.alive);
                if p.platform.is_empty() {
                    p.platform = r.platform.clone();
                }
            }
        }
        out
    }

    /// Reads what earlier runs saw of the phones (kv `phones_seen`).
    pub fn load_remembered(&self, s: &store::Store) {
        let v: Value = s.get(PHONES_SEEN).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let mut m = self.remembered.lock().unwrap();
        for (group, x) in v.as_object().into_iter().flatten() {
            m.insert(group.clone(), Sighting { group: group.clone(), name: x["name"].as_str().unwrap_or("").into(), seen: x["seen"].as_i64().unwrap_or(0), app: x["app"].as_i64().unwrap_or(0), alive: x["alive"].as_i64().unwrap_or(0), platform: x["platform"].as_str().unwrap_or("").into() });
        }
    }

    /// Keeps the phones' last-seen times and app versions for the next run: written when an
    /// app version or name changes, or a phone was seen 5 minutes past what's kept.
    pub fn remember_phones(&self, s: &store::Store) {
        let now: HashMap<String, Sighting> = self.local_phones().into_iter().filter(|p| p.seen > 0 || p.alive > 0 || p.app > 0).map(|p| (p.group.clone(), Sighting { group: p.group, name: p.name, seen: p.seen, app: p.app, alive: p.alive, platform: p.platform })).collect();
        let mut kept = self.remembered.lock().unwrap();
        let stale = now.len() != kept.len()
            || now.iter().any(|(g, n)| kept.get(g).is_none_or(|k| k.app != n.app || k.name != n.name || k.platform != n.platform || n.seen.max(n.alive) - k.seen.max(k.alive) >= 300));
        if !stale {
            return;
        }
        let v: serde_json::Map<String, Value> = now.iter().map(|(g, p)| (g.clone(), json!({ "name": p.name, "seen": p.seen, "app": p.app, "alive": p.alive, "platform": p.platform }))).collect();
        s.set(PHONES_SEEN, &Value::Object(v).to_string());
        *kept = now;
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

    /// A pairing token from before accounts: over loopback (test rigs, this PC's own tools) it
    /// still works in full; elsewhere it only lets the old app update itself
    /// ([`Level::Legacy`]), then the phone signs in with Google.
    pub fn auth(&self, token: &str, via: &Via) -> Result<Level, &'static str> {
        let tokens = self.tokens.lock().unwrap();
        // Every stored token is compared in full, so the time taken says nothing about it.
        // A signed-in phone's handle is never a credential.
        let hit = tokens.iter().filter(|t| t.account.is_empty()).fold(false, |hit, t| same(t.token.as_bytes(), token.as_bytes()) | hit);
        if !hit {
            return Err("unknown token: sign in with Google in Harbor for Android");
        }
        match via {
            Via::Loopback => Ok(Level::Loopback),
            Via::Tls(_) | Via::Legacy => Ok(Level::Legacy),
            Via::Refused => Err("plain HTTP isn't answered here: use TLS"),
        }
    }

    /// Who a phone's message comes from: "Pixel 8 (Sam Rig)" for a signed-in phone.
    pub fn caller_label(&self, token: &str, device: &str) -> String {
        let phone = if device.is_empty() { "Phone" } else { device };
        match self.tokens.lock().unwrap().iter().find(|t| t.token == token && !t.account_name.is_empty()) {
            Some(t) => format!("{phone} ({})", t.account_name),
            None => phone.to_string(),
        }
    }

    /// The handle of a signed-in phone (key `fp`, account `c`): made the first time it calls.
    pub fn account_phone(&self, c: &crate::account::Claims, fp: &str) -> String {
        let mut tokens = self.tokens.lock().unwrap();
        let name = if c.name.is_empty() { c.email.clone() } else { c.name.clone() };
        if let Some(t) = tokens.iter_mut().find(|t| !t.account.is_empty() && t.fp == fp) {
            if t.account != c.sub || t.account_name != name {
                (t.account, t.account_name) = (c.sub.clone(), name);
                self.tokens_dirty.store(true, Ordering::SeqCst);
            }
            return t.token.clone();
        }
        let token = new_token().unwrap_or_else(|_| format!("acct-{fp}"));
        tokens.push(Token { token: token.clone(), name: String::new(), created: store::now(), group: fp.to_string(), fp: fp.to_string(), account: c.sub.clone(), account_name: name });
        self.tokens_dirty.store(true, Ordering::SeqCst);
        token
    }
}

/// What a call with a pairing token from before accounts may do.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Level {
    /// Plain HTTP from this PC: everything.
    Loopback,
    /// From a phone: check for an update and download the app.
    Legacy,
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
    /// The open chat and a hash of its draft as last reported (this PC typing).
    draft: Option<(i64, u64)>,
    /// When the draft was last reported, and when a newer one is due (the debounce).
    draft_sent: Option<Instant>,
    pub draft_due: Option<Instant>,
    /// When each composer was last edited here, and the newest shared draft rev applied/seen.
    edited: HashMap<i64, Instant>,
    applied: HashMap<i64, u64>,
    /// Files attached here, as uploads of this hub (for other devices): path → upload id.
    uploads: HashMap<PathBuf, String>,
    /// Lead → hash of its team panel (`/v1/chats/{id}/team`), for leads with a team.
    teams: HashMap<i64, u64>,
    /// The pull requests and issues fetched for phones (ghapi.rs).
    pub gh: crate::ghapi::Shared,
    pub ui: PhonesUi,
}

#[derive(Default)]
pub struct PhonesUi {
    /// The app's download link as a QR code.
    pub install_qr: Option<(String, egui::TextureHandle)>,
}

impl Local {
    /// A file in the composer as an upload of this hub: itself when it is one, else a link
    /// (or copy) of it in the uploads folder, made once.
    fn upload_id(&mut self, path: &Path) -> Option<String> {
        if let Some(id) = self.uploads.get(path) {
            return Some(id.clone());
        }
        let dir = uploads_dir();
        let id = match path.strip_prefix(&dir) {
            Ok(rel) if resolve_upload(&rel.to_string_lossy()).is_some() => rel.to_string_lossy().into_owned(),
            _ => {
                let name = safe_name(&path.file_name()?.to_string_lossy());
                let sub = format!("d{:08x}", hash_of(&path) as u32);
                std::fs::create_dir_all(dir.join(&sub)).ok()?;
                let to = dir.join(&sub).join(&name);
                if !to.is_file() && std::fs::hard_link(path, &to).is_err() {
                    std::fs::copy(path, &to).ok()?;
                }
                format!("{sub}/{name}")
            }
        };
        self.uploads.insert(path.to_path_buf(), id.clone());
        Some(id)
    }

    pub fn new(hub: Arc<Hub>) -> Self {
        Local { hub, items: HashMap::new(), looked: HashMap::new(), chats: HashMap::new(), rest: 0, draft: None, draft_sent: None, draft_due: None, edited: HashMap::new(), applied: HashMap::new(), uploads: HashMap::new(), teams: HashMap::new(), gh: Default::default(), ui: Default::default() }
    }
}

// ================================================================== HTTP

/// A request's head; the body is read afterwards by whoever handles it.
#[derive(Debug, Default, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
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
    let mut req = Request { method: method.to_ascii_uppercase(), path: decode_path(path), query, ..Default::default() };
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
        let _ = crate::tls::KNOWN.set(Box::new(move |fp: &str| hub.tokens.lock().unwrap().iter().any(|t| t.fp == fp) || hub.mesh.allowed_fp(fp).is_some() || crate::account::known_device(fp)));
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

/// Whether `/app.apk` is served: to anyone on this network, and from the internet to a
/// signed-in phone (or one paired before accounts, so it can update and then sign in).
fn apk_allowed(public: bool, who: &Result<(String, Option<Level>), (u16, &str)>) -> bool {
    !public || matches!(who, Ok((_, None | Some(Level::Legacy))))
}

/// Who makes a call: a signed-in phone (its Harbor token, checked here offline, bound to the
/// TLS key of this connection: None), or a pairing token from before accounts at its level.
/// Refused: the status (401: sign in again, 403: not this PC's workspace) and why.
pub fn caller(hub: &Hub, peer: &Peer, req: &Request) -> Result<(String, Option<Level>), (u16, &'static str)> {
    let t = req.bearer().ok_or((401, "no token"))?;
    if crate::account::is_token(t) {
        let Via::Tls(Some(fp)) = &peer.via else { return Err((401, "a sign-in needs the phone's own key (TLS)")) };
        let c = crate::account::admit(t, fp).map_err(|e| (if e.contains("workspace") || e.contains("removed") { 403 } else { 401 }, e))?;
        return Ok((hub.account_phone(&c, fp), None));
    }
    hub.auth(t, &peer.via).map(|l| (t.to_string(), Some(l))).map_err(|e| (401, e))
}

/// What a phone paired before accounts is told (Harbor for Android before 0.85 shows it).
pub const OLD_PAIRING: &str = "This PC now uses Google accounts: update Harbor on this phone (Settings › Update), then sign in with Google.";
/// How long a background ping may wait for a notification, and how often the app pings.
pub const ALIVE_WAIT_MS: u64 = 240_000;
pub const ALIVE_EVERY_S: u64 = 900;

/// The sentence a refused phone gets.
fn refused_text(status: u16, why: &str) -> String {
    let mut w = why.to_string();
    if let Some(c) = w.get(..1) {
        w = c.to_uppercase() + &w[1..];
    }
    if status == 401 && !w.contains("sign in") { format!("{w}. Sign in again in Harbor for Android.") } else { format!("{w}.") }
}

/// Calls refused lately (unix s, why), newest last: Settings › Phones shows a few.
pub static REFUSED: Mutex<Vec<(i64, String)>> = Mutex::new(vec![]);

fn note_refused(ip: std::net::IpAddr, why: &str) {
    let mut log = REFUSED.lock().unwrap();
    let line = format!("{ip}: {why}");
    // The same refusal again (an app retrying): only its time moves.
    log.retain(|(_, l)| *l != line);
    log.push((store::now(), line));
    let n = log.len();
    if n > 20 {
        log.drain(..n - 20);
    }
}

/// `POST /v1/alive` from a signed-in phone: recorded for Devices, and the notifications since
/// `since` (0: none yet, it starts from now).
fn alive(hub: &Hub, token: &str, body: &Value) -> Value {
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    hub.alive.lock().unwrap().insert(token.to_string(), (store::now(), now_ms));
    let mut out = json!({ "ok": true, "every_s": ALIVE_EVERY_S });
    if let Some(since) = body["since"].as_u64() {
        let (notes, last) = if since == 0 { (vec![], hub.notes.last()) } else { hub.notes.wait(since, Duration::from_millis(body["wait_ms"].as_u64().unwrap_or(0).min(ALIVE_WAIT_MS))) };
        out["notes"] = json!(notes);
        out["last"] = json!(last);
    }
    out
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
            Via::Tls(Some(fp)) => hub.tokens.lock().unwrap().iter().any(|t| t.fp == *fp) || hub.mesh.allowed_fp(fp).is_some() || crate::account::known_device(fp),
            _ => false,
        };
        if !known {
            return;
        }
        crate::portmap::reached(ip);
    }
    let peer = Peer { ip, via };
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
    // A video of one of this PC's chats, the same way (`/v1/media` there).
    if segs == ["mesh", "v1", "media"] && req.method == "GET" {
        if !crate::mesh::admitted(hub, &peer, &req) {
            FAILS.hit(ip);
            return send_json(r.get_mut(), 403, &json!({ "error": "only for paired PCs" }));
        }
        return serve_media(r.get_mut(), req.query("path").unwrap_or(""));
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
    // Who calls: a signed-in phone, or a pairing from before accounts.
    let who = caller(hub, &peer, &req);
    if matches!(req.method.as_str(), "GET" | "HEAD") && segs == ["app.apk"] && apk_allowed(public, &who) {
        return serve_apk(r.get_mut(), req.method == "HEAD");
    }
    let (token, level) = match who {
        Ok(w) => w,
        Err((status, why)) => {
            FAILS.hit(ip);
            note_refused(ip, why);
            return send_json(r.get_mut(), status, &json!({ "error": refused_text(status, why), "signin": status == 401 }));
        }
    };
    if level == Some(Level::Legacy) {
        // A pairing from before accounts may still update the app, then sign in.
        if req.method == "GET" && segs == ["v1", "app"] {
            return send_json(r.get_mut(), 200, &app_info());
        }
        note_refused(ip, "a pairing from before accounts");
        return send_json(r.get_mut(), 401, &json!({ "error": OLD_PAIRING, "signin": true, "upgrade": true }));
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
    // What the phone is (0.84): "Samsung SM-A135M, Android 12 (SDK 31), ABIs armeabi-v7a, …".
    if let Some(p) = req.header("x-harbor-platform").map(|p| p.chars().filter(|c| !c.is_control()).take(240).collect::<String>()).filter(|p| !p.trim().is_empty()) {
        hub.platforms.lock().unwrap().insert(token.clone(), p);
    }
    let w = r.get_mut();
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["v1", "app"]) => send_json(w, 200, &app_info()),
        // Every PC's Harbor and every phone's app (versions.rs, 0.68).
        ("GET", ["v1", "versions"]) => send_json(w, 200, &crate::versions::api_json(hub)),
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
        ("GET", ["v1", "hubs"]) => send_json(w, 200, &crate::mesh::hubs(hub)),
        // The app, in the background: it's installed and can reach this PC (Devices), and takes
        // the notifications since `since`, waiting up to `wait_ms` for one (notify.rs).
        ("POST", ["v1", "alive"]) => {
            let body: Value = read_body(&mut r, req.len, 4096).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
            let reply = alive(hub, &token, &body);
            send_json(r.get_mut(), 200, &reply)
        }
        ("POST", ["v1", "chats", c, "typing"]) => {
            let Some(chat) = c.parse::<i64>().ok().or_else(|| hub.mesh.by_gid(c)) else { return send_json(w, 404, &json!({ "error": "no such chat" })) };
            let body: Value = read_body(&mut r, req.len, 512 << 10).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
            let w = r.get_mut();
            let on = body["typing"].as_bool().unwrap_or(true);
            // The composer's content: `draft` (0.64), only `text` (0.56), or neither (older:
            // just "is typing").
            let draft = match (&body["draft"], body["text"].as_str()) {
                (d @ Value::Object(_), _) => Some(d.clone()),
                (_, Some(t)) => Some(json!({ "text": t })),
                _ => None,
            };
            let kind = if body["kind"].as_str() == Some("pc") { "pc" } else { "phone" };
            let label = if !device.is_empty() {
                device.clone()
            } else {
                hub.tokens.lock().unwrap().iter().find(|t| t.token == token).map(|t| t.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| if kind == "pc" { "A PC".into() } else { "Phone".into() })
            };
            // Another PC's chat: its PC keeps who types in it (mesh.rs).
            if crate::mesh::forward_lease(hub, chat, false, &device_id(&token), kind, &label, on, draft.as_ref()) {
                return send_json(w, 200, &json!({ "ok": true }));
            }
            if hub.report(chat, &device_id(&token), kind, &label, on, draft.as_ref()) {
                wake(); // this PC's window shows it
            }
            send_json(w, 200, &json!({ "ok": true }));
        }
        ("GET", ["v1", "image"]) => {
            let path = req.query("path").unwrap_or("");
            let max = req.query("max").and_then(|m| m.parse().ok());
            // Another PC's chat (a copy here): its images are that PC's files.
            let chat = req.query("chat").and_then(|c| c.parse::<i64>().ok().or_else(|| hub.mesh.by_gid(c)));
            // Asked of its home PC first: the same path here (a /tmp/shot.png) may be another file.
            if let Some((ctype, bytes)) = chat.and_then(|c| crate::mesh::home_image(hub, c, path, max)) {
                let _ = w.write_all(response(200, &ctype, bytes.len(), "").as_bytes());
                let _ = w.write_all(&bytes);
                return;
            }
            serve_image(w, path, max)
        }
        ("GET", ["v1", "media"]) => {
            let path = req.query("path").unwrap_or("");
            let chat = req.query("chat").and_then(|c| c.parse::<i64>().ok().or_else(|| hub.mesh.by_gid(c)));
            // Asked of its home PC first: the same path here (a /tmp/shot.png) may be another file.
            if let Some((ctype, bytes)) = chat.and_then(|c| crate::mesh::home_media(hub, c, path)) {
                let _ = w.write_all(response(200, &ctype, bytes.len(), "").as_bytes());
                let _ = w.write_all(&bytes);
                return;
            }
            serve_media(w, path)
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
            // `cleanup` (0.55): default the hub's setting; `local=1`: transcribe here only.
            let cleanup = match req.query("cleanup") {
                Some("0") => false,
                Some("1") => true,
                _ => crate::dictate::cleanup_on(),
            };
            let local = req.query("local") == Some("1");
            // `commands=1` (0.76): a phone that knows `send` and line breaks in the text.
            let commands = req.query("commands") == Some("1");
            let samples = match crate::voice::wav_samples(&body) {
                Ok(s) => s,
                Err(e) => return send_json(r.get_mut(), 400, &json!({ "error": e })),
            };
            match crate::dictate::transcribe(&hub, &samples, &lang, cleanup, commands, local) {
                Ok(d) => {
                    let mut v = json!({ "text": d.text, "host": d.host });
                    if d.send {
                        v["send"] = json!(true);
                    }
                    if let Some(raw) = d.raw {
                        v["raw"] = json!(raw);
                    }
                    send_json(r.get_mut(), 200, &v)
                }
                Err(f) => send_json(r.get_mut(), 409, &json!({ "error": f.text() })),
            }
        }
        // The hub's voice (dictate.rs): engine, model, free memory, settings.
        ("GET", ["v1", "voice"]) => send_json(w, 200, &crate::dictate::status(&hub.mesh.me().name)),
        ("PUT", ["v1", "voice", "settings"]) | ("POST", ["v1", "voice", "cleanup"]) => {
            let v: Value = match read_body(&mut r, req.len, MAX_JSON) {
                Ok(b) if b.iter().all(u8::is_ascii_whitespace) => Value::Null,
                Ok(b) => match serde_json::from_slice(&b) {
                    Ok(v) => v,
                    Err(e) => return send_json(r.get_mut(), 400, &json!({ "error": format!("bad JSON: {e}") })),
                },
                Err(_) => return send_json(r.get_mut(), 413, &json!({ "error": "body too large" })),
            };
            if req.method == "PUT" {
                crate::dictate::set(None, v["cleanup"].as_bool(), v["keep_loaded_min"].as_u64(), true);
                let dict = v.get("dictionary").filter(|d| d.is_array()).map(crate::dictwords::parse);
                crate::dictate::set_words(v["commands"].as_bool(), dict, true);
                wake();
                send_json(r.get_mut(), 200, &crate::dictate::status(&hub.mesh.me().name))
            } else {
                let text = v["text"].as_str().unwrap_or("");
                send_json(r.get_mut(), 200, &json!({ "text": crate::dictate::cleanup_text(text) }))
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

/// A mention on a user's message, as the phone draws it: a message (author, snippet), or a
/// chat (`kind` "chat", its global id and title; from 0.69).
fn mention_json(m: &crate::mentions::Mention) -> Value {
    let mut v = json!({ "from": m.from, "text": m.snippet(), "excerpt": m.excerpt, "note": m.note.trim() });
    if m.is_chat() {
        v["kind"] = json!("chat");
        v["chat"] = json!(m.chat);
        v["title"] = json!(m.title);
    }
    v
}

fn app_info() -> Value {
    let code = crate::update::apk().map_or(0, |(_, c)| c);
    // `hub` (0.51): this PC's own Harbor version and updates, for the phone's PCs page.
    json!({ "version_code": code, "url": "/app.apk", "hub": crate::update::info() })
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
/// side. Only real image files (media.rs `check`); a video gives its poster, an SVG its
/// drawing as PNG. The token already lets its phone run agents on this PC.
fn serve_image(w: &mut impl Write, path: &str, max: Option<u32>) {
    let p = Path::new(path);
    // An https image still downloading into the cache: wait for it a little.
    crate::media::wait_for(p, Duration::from_secs(20));
    let video = match crate::media::check(p) {
        Ok(v) => v,
        Err(e) => return send_json(w, 404, &json!({ "error": format!("no such image: {e}") })),
    };
    let bytes = if video {
        crate::media::poster(p).and_then(|f| std::fs::read(f).ok())
    } else if crate::media::is_svg(path) {
        crate::media::svg_png(p, max.unwrap_or(1024).clamp(16, 2048))
    } else {
        std::fs::read(crate::media::located(p)).ok()
    };
    let Some(bytes) = bytes else {
        return send_json(w, 404, &json!({ "error": if video { "no preview of this video" } else { "unreadable image" } }));
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
            let ctype = match image::guess_format(&bytes) {
                Ok(image::ImageFormat::Png) => "image/png",
                Ok(image::ImageFormat::Jpeg) => "image/jpeg",
                Ok(image::ImageFormat::Gif) => "image/gif",
                Ok(image::ImageFormat::WebP) => "image/webp",
                _ => "application/octet-stream",
            };
            (bytes, ctype)
        }
    };
    let _ = w.write_all(response(200, ctype, body.len(), "").as_bytes());
    let _ = w.write_all(&body);
}

/// A video (or an image's original) a card shows (`media_url`), streamed as it is. Only real
/// image and video files (media.rs `check`), at most `media::MAX_VIDEO`.
fn serve_media(w: &mut impl Write, path: &str) {
    let p = Path::new(path);
    crate::media::wait_for(p, Duration::from_secs(20));
    if let Err(e) = crate::media::check(p) {
        return send_json(w, 404, &json!({ "error": format!("no such media: {e}") }));
    }
    let Ok(mut f) = std::fs::File::open(crate::media::located(p)) else { return send_json(w, 404, &json!({ "error": "unreadable file" })) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if w.write_all(response(200, crate::media::mime(path), len as usize, "").as_bytes()).is_err() {
        return;
    }
    let _ = std::io::copy(&mut (&mut f).take(len), w);
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
    /// A commit of the chat's project (commits.rs): the full sha; the item's `commits` has it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
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
            commit: None,
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
    let md = crate::chat::linkify(md);
    for ev in Parser::new_ext(&md, opts) {
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

pub fn file_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

/// Where the phone fetches an image a card shows (a ≤512 px JPEG; a video's poster).
pub fn image_url(path: &str) -> String {
    format!("/v1/image?path={}&max=512", url_encode(path))
}

/// Where the phone fetches a video (or an image's original file) a card shows.
pub fn media_url(path: &str) -> String {
    format!("/v1/media?path={}", url_encode(path))
}

/// An image or video a card shows large (PROTOCOL.md `media`).
fn media_json(m: &crate::media::Media) -> Value {
    let mut v = json!({
        "name": m.name(), "caption": m.caption, "kind": if m.video { "video" } else { "image" },
        "url": if m.video { media_url(&m.path) } else { image_url(&m.path) },
    });
    if m.video {
        v["poster"] = json!(image_url(&m.path));
    }
    v
}

/// One card of the shared projection (view.rs) for the phone: what the desktop draws for
/// that item, field for field. `find` lists the image files a text names.
/// A card's image addresses with `&chat=` (a gid or an id), so the PC answering can fetch an
/// image of another PC's chat from that PC (`/v1/image`).
fn with_chat(mut v: Value, chat: String) -> Value {
    for list in ["images", "media"] {
        if let Some(imgs) = v.get_mut(list).and_then(|i| i.as_array_mut()) {
            for i in imgs {
                for key in ["url", "poster"] {
                    if let Some(u) = i.get(key).and_then(|u| u.as_str()).map(String::from) {
                        i[key] = json!(format!("{u}&chat={}", url_encode(&chat)));
                    }
                }
            }
        }
    }
    v
}

/// `commits`: the commits a reply names (commits.rs), drawn as pills.
/// `links`: the chat links a reply names (chatlink.rs), resolved: link → `{title, chat, missing}`.
pub fn card_json(s: &crate::view::Shown, rev: u64, find: &mut dyn FnMut(&str) -> Vec<crate::media::Media>, commits: &HashMap<String, crate::commits::Commit>, links: &serde_json::Map<String, Value>) -> Value {
    use crate::view::Card;
    let all = crate::view::media(&s.card, find);
    // Every image, as older phones draw them (a strip); newer ones draw `media` large and the
    // rest of `images` as the strip.
    let images: Vec<Value> = all.iter().filter(|m| !m.video).map(|m| json!({ "name": if m.url.is_some() { m.name() } else { file_name(&m.path) }, "url": image_url(&m.path) })).collect();
    let mut media: Vec<Value> = all.iter().filter(|m| m.shown || m.video).map(media_json).collect();
    // Images on their own line in a reply: (path, how many of its `blocks` come before it).
    let mut placed: Vec<(String, usize)> = vec![];
    let mut v = match &s.card {
        Card::Hidden => json!({}),
        Card::User { text, files, mentions, at, sender, intent, .. } => {
            let mut v = json!({
                "text": text, "files": files.iter().map(|f| file_name(f)).collect::<Vec<_>>(), "images": images,
                "mentions": mentions.iter().map(mention_json).collect::<Vec<_>>(), "at": at,
                "sender": sender,
            });
            // It steered a running turn (queue.rs): the "Steer" caption over the bubble.
            if !intent.is_empty() {
                v["intent"] = json!(intent);
            }
            v
        }
        Card::Text { text, at, forkable } => {
            // A chat link reads as its chat's title, as on the desktop.
            let label = |md: &str| crate::chatlink::labelled(&crate::media::strip_refs(md), &|u| links.get(u).and_then(|l| l["title"].as_str()).unwrap_or(u).to_string()).into_owned();
            let md = label(text);
            let parts = crate::media::parts(text);
            if parts.len() > 1 {
                let mut n = 0;
                for p in parts {
                    match p {
                        crate::media::Part::Text(t) => n += blocks(&label(t)).len(),
                        crate::media::Part::Media(t) => placed.extend(find(t).into_iter().filter(|m| m.shown).map(|m| (m.path, n))),
                    }
                }
            }
            let mut b = blocks(&md);
            crate::commits::mark(&mut b, commits);
            let mut v = json!({ "markdown": text, "blocks": b, "images": images, "at": at, "forkable": forkable });
            if !commits.is_empty() {
                v["commits"] = crate::commits::wire(commits);
            }
            if !links.is_empty() {
                v["chat_links"] = Value::Object(links.clone());
            }
            v
        }
        Card::Thinking { text } => json!({ "text": text }),
        Card::Tool { label, summary, input, result, is_error } => json!({
            "label": label, "summary": summary, "input": clipped(input),
            "result": result.map(clipped), "done": result.is_some(), "is_error": is_error, "images": images,
        }),
        Card::ForkedFrom { chat, seq } => json!({ "chat": chat, "seq": seq }),
        // `chat` (this hub's id of that chat, null while it isn't here) is filled in by `chat_items`.
        Card::ChatLink { gid, text } => json!({ "gid": gid, "text": text }),
        Card::Notice { icon, text, detail, markdown, url } => json!({ "icon": icon, "text": text, "detail": clipped(detail), "detail_markdown": markdown, "url": url }),
        Card::Message { from, to, text } => json!({ "from": from, "to": to, "text": clipped(text) }),
        Card::Error { text } => json!({ "text": clipped(text) }),
    };
    for (m, j) in all.iter().filter(|m| m.shown || m.video).zip(media.iter_mut()) {
        if let Some((_, n)) = placed.iter().find(|(p, _)| *p == m.path) {
            j["after"] = json!(n);
        }
    }
    if !media.is_empty() {
        v["media"] = json!(media);
    }
    v["kind"] = json!(crate::view::kind(&s.card));
    // What a long-press offers (the desktop's hover bar), and the time it shows.
    let actions = crate::view::actions(&s.card);
    if !actions.is_empty() {
        v["actions"] = json!(actions.iter().map(|a| a.id()).collect::<Vec<_>>());
    }
    if let Some(at) = v["at"].as_i64().filter(|a| *a > 0) {
        v["time"] = json!(crate::team::clock(at));
    }
    v["seq"] = json!(s.seq);
    v["rev"] = json!(rev);
    if !s.forks_after.is_empty() {
        v["forks_after"] = json!(s.forks_after);
    }
    if let Some(g) = s.group {
        v["group"] = json!(g);
    }
    v
}

pub(crate) fn hash_of(v: &impl Hash) -> u64 {
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
        self.apply_drafts();
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
            let bars = (n, strip, self.paused(c.id).map(|p| p.at), self.queue_hash(c.id));
            let h = hash_of(&(&c.title, c.settled, c.updated, &c.account, &c.model, &c.effort, &c.access, &c.device, c.repo_id, (self.is_running(c.id), self.team_working(c)), self.queued_count(c.id), (bars, self.writable_chat(c), self.snoozed_label(c.id), self.chat_pr(c).map(|p| (p.number, p.state)))));
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

    /// What this PC's composer holds for `chat`: text, files, mentions; and a hash of it.
    fn composer_of(&self, chat: i64) -> (String, Vec<PathBuf>, Vec<crate::mentions::Mention>, u64) {
        let text = self.drafts.get(&chat).cloned().unwrap_or_default();
        let files = self.files.get(&chat).cloned().unwrap_or_default();
        let ms = self.mentions.drafts.get(&chat).cloned().unwrap_or_default();
        let h = hash_of(&(&text, &files, serde_json::to_string(&ms).unwrap_or_default()));
        (text, files, ms, h)
    }

    /// This PC's composer as a typer and the chat's shared draft: an edit to an open chat's
    /// composer renews the lease and sends what it holds (at most every [`PREVIEW_GAP`]); an
    /// emptied composer (sent or cleared) ends the lease and empties the draft everywhere.
    fn local_typing(&mut self) {
        let crate::app::View::Chat(id) = self.view else { return };
        let (text, files, ms, h) = self.composer_of(id);
        // Editing a queued message isn't typing a draft (queue.rs): nothing goes out.
        if self.queue_editing(id).is_some() {
            self.api.draft = Some((id, h));
            return;
        }
        if self.api.draft == Some((id, h)) {
            self.api.draft_due = None;
            return;
        }
        let was = self.api.draft;
        let me = local_device();
        if let Some((old, _)) = was.filter(|(old, _)| *old != id) {
            self.set_lease(old, false, &me, "pc", "", false, None);
        }
        // The first look at a chat isn't typing (a draft left from earlier).
        if was.is_none_or(|(old, _)| old != id) {
            self.api.draft = Some((id, h));
            return;
        }
        self.api.edited.insert(id, Instant::now());
        let empty = text.trim().is_empty() && files.is_empty() && ms.is_empty();
        // Keys in a burst: the draft goes out once the gap has passed (`typing_repaint` wakes then).
        if let Some(at) = self.api.draft_sent.filter(|at| !empty && at.elapsed() < PREVIEW_GAP) {
            self.api.draft_due = Some(at + PREVIEW_GAP);
            return;
        }
        self.api.draft = Some((id, h));
        self.api.draft_sent = Some(Instant::now());
        self.api.draft_due = None;
        let name = self.api.hub.mesh.me().name;
        let label = if name.is_empty() { crate::remote::hostname() } else { name };
        // Files go as uploads of this hub (another PC's chat keeps its own, see forward_lease).
        let ids: Vec<String> = if self.is_foreign(id) { vec![] } else { files.iter().filter_map(|f| self.api.upload_id(f)).collect() };
        let mut draft = json!({ "text": text, "mentions": ms });
        if !self.is_foreign(id) {
            draft["files"] = json!(ids);
        }
        self.set_lease(id, false, &me, "pc", &label, !empty, Some(&draft));
    }

    /// Other devices' shared drafts into this PC's composers: a draft newer than the last one
    /// seen, written elsewhere, unless this composer was edited in the last [`DRAFT_HOLD`]
    /// (it's tried again then; the newer of the two wins at the hub).
    fn apply_drafts(&mut self) {
        let mut fresh: Vec<(i64, SharedDraft)> = vec![];
        for (chat, rev) in self.api.hub.draft_revs() {
            if !self.is_foreign(chat) && rev > self.api.applied.get(&chat).copied().unwrap_or(0) {
                fresh.extend(self.api.hub.draft(chat).map(|d| (chat, d)));
            }
        }
        for (chat, r) in &self.mesh.status {
            if let Some(d) = r.draft.as_ref().filter(|d| d.rev > self.api.applied.get(chat).copied().unwrap_or(0)) {
                fresh.push((*chat, d.clone()));
            }
        }
        let me = local_device();
        for (chat, d) in fresh {
            // The composer holds a queued message being edited: the draft comes after.
            if self.queue_editing(chat).is_some() {
                continue;
            }
            match should_apply(&d, &me, self.api.edited.get(&chat).copied(), Instant::now()) {
                Apply::Skip => {
                    self.api.applied.insert(chat, d.rev);
                    continue;
                }
                Apply::Later => {
                    // A frame when the hold is over, to apply it then.
                    let at = self.api.edited.get(&chat).map(|e| *e + DRAFT_HOLD);
                    self.api.draft_due = self.api.draft_due.into_iter().chain(at).min();
                    continue;
                }
                Apply::Now => {}
            }
            self.api.applied.insert(chat, d.rev);
            // A cursor at the end of the old text stays at the end of the new one (else where it was).
            let old = self.drafts.get(&chat).map_or(0, |t| t.chars().count());
            let cid = egui::Id::NULL.with(("composer", chat));
            if let Some(mut st) = egui::text_edit::TextEditState::load(&self.ctx, cid) {
                let at = st.cursor.char_range().map(|r| r.primary.index.0);
                let n = d.text.chars().count();
                let to = if at.is_none_or(|a| a >= old) { n } else { at.unwrap_or(n).min(n) };
                st.cursor.set_char_range(Some(egui::text::CCursorRange::one(egui::text::CCursor::new(to))));
                st.store(&self.ctx, cid);
            }
            if d.text.is_empty() {
                self.drafts.remove(&chat);
            } else {
                self.drafts.insert(chat, d.text.clone());
            }
            // Another PC's chat: its files are that PC's; the files here stay.
            if !self.is_foreign(chat) {
                self.files.insert(chat, d.files.iter().map(|f| PathBuf::from(&f.path)).collect());
            }
            let ms: Vec<crate::mentions::Mention> = d.mentions.iter().filter_map(|m| serde_json::from_value(m.clone()).ok()).collect();
            self.mentions.drafts.insert(chat, ms);
            // Not an edit here: it doesn't go back out.
            if self.view == crate::app::View::Chat(chat) {
                let h = self.composer_of(chat).3;
                self.api.draft = Some((chat, h));
            }
        }
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
        // A commit pill's card (commits.rs): git runs on a thread, which answers.
        if self.commit_api(&call) {
            return;
        }
        // Workspace and branch calls: git runs on threads (worktree.rs), which may answer later.
        if let Some(r) = self.ws_api(&call, ctx) {
            if let Some(r) = r {
                let _ = call.reply.send(r);
            }
            return;
        }
        // What the phone sends says it came from the phone, and whose it is: a workspace has
        // several people, and chats record who started them.
        self.sender = self.api.hub.caller_label(&call.token, &call.device);
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
        // (A move says it moves there instead: movechat.rs. A mention only reads the copy. A
        // snooze and the main chat are this PC's sidebar's.)
        if call.method != "GET" && p.len() > 2 && p[1] == "chats" && !matches!(p.get(3), Some(&"move" | &"mention" | &"snooze" | &"main")) {
            if let Some(c) = self.chat_by_ref(p[2]).filter(|c| c.foreign()) {
                return err(409, format!("{} is off: this chat is read-only until it's back", self.home_name(c)));
            }
        }
        match (call.method.as_str(), p.as_slice()) {
            ("GET", ["v1", "state"]) => ok(self.api_state(ctx, &device_id(&call.token))),
            // The snooze sheet (0.78): the desktop menu's presets and what the typed `text` means,
            // in the phone's zone (`off`, seconds east of UTC; this PC's without it); `chat`
            // names a chat to say until when it's snoozed.
            ("GET", ["v1", "snooze"]) => {
                let now = store::now();
                let off = call.query("off").and_then(|s| s.parse().ok()).unwrap_or_else(|| crate::team::utc_offset(now));
                let text = call.query("text").unwrap_or("");
                let (until, preview) = crate::sidebar::snooze_preview(text, now, off);
                let presets: Vec<Value> = crate::sidebar::snooze_presets(now, off).iter().map(|(l, u)| json!({ "label": l, "until_ms": u * 1000 })).collect();
                let snoozed = call.query("chat").and_then(|c| self.ref_id(c)).and_then(|c| self.snooze_until(&format!("c{c}")));
                let snoozed = snoozed.map(|u| format!("until {}", crate::sidebar::snooze_label(u, now, off)));
                ok(json!({ "presets": presets, "text": text, "until_ms": until.map(|u| u * 1000), "preview": preview, "snoozed": snoozed }))
            }
            // Snoozes a chat out of this PC's sidebar, which the phone's drawer shows (0.78):
            // `{until_ms}` (a preset) or `{text, off?}` (the custom field). DELETE wakes it.
            ("POST", ["v1", "chats", c, "snooze"]) => {
                let Some(c) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                let now = store::now();
                let off = call.body["off"].as_i64().unwrap_or_else(|| crate::team::utc_offset(now));
                let until = match (call.body["until_ms"].as_i64(), call.body["text"].as_str()) {
                    (Some(ms), _) => match ms / 1000 {
                        u if u > now && u <= now + 366 * 86400 => u,
                        _ => return err(400, "pick a time within the next year"),
                    },
                    (None, Some(t)) => match crate::sidebar::parse_snooze(t, now, off) {
                        Some(u) => u,
                        None => return err(400, "Try 5h, 1h30m, 2d or 18:00"),
                    },
                    _ => return err(400, "until_ms or text"),
                };
                self.set_snooze(&format!("c{c}"), Some(until));
                ok(json!({ "ok": true, "snoozed_until_ms": until * 1000, "snoozed_label": self.snoozed_label(c) }))
            }
            ("DELETE", ["v1", "chats", c, "snooze"]) => {
                let Some(c) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                self.set_snooze(&format!("c{c}"), None);
                ok(json!({ "ok": true, "snoozed_until_ms": null, "snoozed_label": null }))
            }
            // "Make main chat" (0.88): the chat becomes its project's main chat in this PC's
            // sidebar (what the phone's drawer shows), the project row's own.
            ("POST", ["v1", "chats", c, "main"]) => {
                let Some(c) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                match self.make_main(c) {
                    Ok(()) => {
                        let chat = self.chat(c).map(|ch| self.chat_json(ch)).unwrap_or_default();
                        ok(json!({ "ok": true, "chat": chat }))
                    }
                    Err(e) => err(409, e),
                }
            }
            ("GET", ["v1", "chats", c, "items"]) => match self.ref_id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) => ok(self.api_items(c, call.query("since").and_then(|s| s.parse().ok()).unwrap_or(0))),
                None => err(404, "no such chat"),
            },
            // A long-press's Mention: what the composer's draft gets for item `seq` (mentions.rs).
            ("GET", ["v1", "chats", c, "mention"]) => match self.ref_id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) => match call.query("seq").and_then(|s| s.parse().ok()).and_then(|seq| self.api_mention(c, seq, None)) {
                    Some(m) => ok(json!({ "mention": m })),
                    None => err(404, "that message can't be mentioned"),
                },
                None => err(404, "no such chat"),
            },
            // The same with a body (0.74): `{seq, text?}`, `text` a selected part of the message.
            ("POST", ["v1", "chats", c, "mention"]) => match self.ref_id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) => match call.body["seq"].as_u64().and_then(|seq| self.api_mention(c, seq as usize, call.body["text"].as_str())) {
                    Some(m) => ok(json!({ "mention": m })),
                    None => err(404, "that message or text can't be mentioned"),
                },
                None => err(404, "no such chat"),
            },
            ("GET", ["v1", "chats", c, "team"]) => match self.ref_id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) => ok(self.api_team(c, ctx)),
                None => err(404, "no such chat"),
            },
            // "Move to PC…": the PCs the chat could move to, each with why not (movepc.rs).
            ("GET", ["v1", "chats", c, "move_targets"]) => match self.ref_id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) => ok(self.api_move_targets(c)),
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
                match call.query("trigger").unwrap_or("@") {
                    // `$`: chats to mention (chatmention.rs).
                    "$" => ok(self.api_chat_rows(crate::app::DRAFT, repo, call.query("q").unwrap_or(""))),
                    t => ok(self.api_tags_in(repo, t, call.query("q").unwrap_or(""), ctx)),
                }
            }
            // The composer's `@` files and `#` issues and PRs (tags.rs).
            ("GET", ["v1", "chats", c, "tags"]) => match self.ref_id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) if call.query("trigger") == Some("$") => {
                    let repo = self.chat(c).and_then(|x| x.repo_id);
                    ok(self.api_chat_rows(c, repo, call.query("q").unwrap_or("")))
                }
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
            // The phone's "Harbor X.Y.Z is available" banner and PCs page (and another PC's
            // Devices): the hub's Update button. With no release known yet (none checked since
            // start), it checks now and installs what it finds: 202, progress in `hub_update`.
            ("POST", ["v1", "hub", "update"]) => {
                if self.harbor_offer().is_some() {
                    self.update_requested(ctx);
                    ok(json!({ "ok": true }))
                } else if !crate::update::managed() {
                    err(409, "this Harbor was built from source, so it doesn't update itself")
                } else if crate::update::check_and_install(ctx) || crate::update::state() == crate::update::State::Checking {
                    self.update_requested(ctx);
                    Reply { status: 202, body: json!({ "ok": true, "checking": true }) }
                } else {
                    err(409, "Harbor is busy with another download: try again in a moment")
                }
            }
            // "Check for updates" (the phone's PCs page): the scheduled check, now. 202; the
            // result is in `GET /v1/app` `hub` and `hub_update`.
            ("POST", ["v1", "hub", "check"]) => {
                if !crate::update::managed() {
                    err(409, "this Harbor was built from source, so it doesn't update itself")
                } else {
                    crate::update::check(self.auto_update(), ctx);
                    Reply { status: 202, body: json!({ "ok": true, "checking": true }) }
                }
            }
            // Settings › Updates from another PC or the phone (0.53): `{"on": true}` updates
            // automatically from now on (and looks for a release at once), false asks first.
            ("POST", ["v1", "hub", "auto"]) => {
                let Some(on) = call.body["on"].as_bool() else { return err(400, "send {\"on\": true} or false") };
                self.store.set("auto_update", if on { "1" } else { "0" });
                crate::update::tick(on, ctx);
                if on && crate::update::managed() {
                    crate::update::check(true, ctx);
                }
                ok(json!({ "ok": true, "auto": on }))
            }
            // The "Up next" queue (queue.rs): steer with a queued message ("Send now" when
            // idle), reorder, edit in place, remove. Ids are the status' `queue[].id`.
            ("POST", ["v1", "chats", c, "queue", q, op]) => {
                let Some(c) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                let Ok(q) = q.parse::<u64>() else { return err(404, "no such queued message") };
                let done = match *op {
                    "steer" => self.queue_promote(c, q, ctx),
                    "move" => {
                        let Some(to) = call.body["to"].as_u64() else { return err(400, "send {\"to\": position}") };
                        self.queue_move(c, q, to as usize)
                    }
                    _ => return err(404, "no such queue action"),
                };
                if done { ok(json!({ "ok": true })) } else { err(404, "no such queued message (it may have started)") }
            }
            ("PATCH", ["v1", "chats", c, "queue", q]) => {
                let Some(c) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                let Ok(q) = q.parse::<u64>() else { return err(404, "no such queued message") };
                let text = call.body["text"].as_str().map(|t| t.trim().to_string());
                let mentions = call.body.get("mentions").and_then(|m| serde_json::from_value(m.clone()).ok());
                if self.queue_update(c, q, text, mentions, call.body["editing"].as_bool()) { ok(json!({ "ok": true })) } else { err(404, "no such queued message (it may have started)") }
            }
            ("DELETE", ["v1", "chats", c, "queue", q]) => {
                let Some(c) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                let Ok(q) = q.parse::<u64>() else { return err(404, "no such queued message") };
                if self.queue_remove(c, q) { ok(json!({ "ok": true })) } else { err(404, "no such queued message (it may have started)") }
            }
            ("POST", ["v1", "chats", c, action]) => {
                let Some(c) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                match *action {
                    "send" => self.api_send(c, &call.body, ctx),
                    "stop" => {
                        // `{"hold": true}` (0.71): the queue waits, held, for Resume. An older app
                        // gets what waited behind the turn back, for its composer.
                        let hold = call.body["hold"].as_bool() == Some(true);
                        let returned: Vec<Value> = if hold { vec![] } else { self.take_queue(c).into_iter().map(|q| json!({ "text": q.text, "files": q.files.iter().filter_map(|f| upload_id(f)).collect::<Vec<_>>() })).collect() };
                        self.stop(c);
                        ok(json!({ "ok": true, "returned": returned, "held": self.queue_held(c) }))
                    }
                    // Resume after a Stop held the queue: the next queued message starts.
                    "resume" => {
                        self.queue_resume(c);
                        ok(json!({ "ok": true }))
                    }
                    "fork" => self.api_fork(c, &call.body),
                    // "Move to project…": {"repo": project id, its path, or null for No project}.
                    "move" => self.api_move(c, &call.body),
                    // "Move to PC…": {"pc": a peer id from move_targets}. 202: the handoff runs;
                    // its outcome shows in the chat (a notice, or the chat's new home).
                    "move_pc" => {
                        let pc = call.body["pc"].as_str().unwrap_or("").to_string();
                        match self.move_pc(c, &pc, ctx) {
                            Ok(name) => Reply { status: 202, body: json!({ "ok": true, "moving": true, "to": name }) },
                            Err(e) => err(409, e),
                        }
                    }
                    // The slash menu's /plan and /default (slash.rs).
                    "slash" => self.api_slash_command(c, &call.body, ctx),
                    // The waiting bar's Stop all: the lead and its sub-agents; the lead's queue comes back.
                    "stop_all" => {
                        let hold = call.body["hold"].as_bool() == Some(true);
                        let returned: Vec<Value> = if hold { vec![] } else { self.take_queue(c).into_iter().map(|q| json!({ "text": q.text, "files": q.files.iter().filter_map(|f| upload_id(f)).collect::<Vec<_>>() })).collect() };
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
                    // The limit line's Continue on…: {"account": one of the limit's `targets`}.
                    "continue_on" => {
                        let to = call.body["account"].as_str().unwrap_or("").to_string();
                        if !self.switch_targets(c, false).contains(&to) {
                            return err(409, "that account can't take this chat now");
                        }
                        if self.continue_on(c, &to, "is at its usage limit", ctx) {
                            ok(json!({ "ok": true }))
                        } else {
                            err(409, "couldn't move the chat to that account")
                        }
                    }
                    // The folder line's Clone here (clone.rs): {"path": where to clone, or the clone that's there}.
                    "clone" => {
                        let path = call.body["path"].as_str().map(str::trim).unwrap_or("");
                        let path = match path.strip_prefix("~/") {
                            Some(rest) => store::home().join(rest),
                            None => PathBuf::from(path),
                        };
                        match self.clone_here(c, path) {
                            Ok(()) => ok(json!({ "ok": true })),
                            Err(e) => err(409, e),
                        }
                    }
                    // Run on <owner> goes through the mesh (mesh.rs answers it); here it's off.
                    "run_on" => err(409, "the PCs aren't sharing chats now: turn the mesh on, or start the chat on that PC"),
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
                // The sidebar placement names the same chats and projects.
                if let Some(t) = v.get_mut("tree") {
                    for pr in t.get_mut("projects").and_then(|p| p.as_array_mut()).into_iter().flatten() {
                        pr["id"] = path(&pr["id"]);
                        if pr.get("main").is_some() {
                            pr["main"] = gid(&pr["main"]);
                        }
                        for x in pr.get_mut("chats").and_then(|c| c.as_array_mut()).into_iter().flatten() {
                            *x = gid(x);
                        }
                    }
                    for k in ["threads", "settled", "snoozed"] {
                        for x in t.get_mut(k).and_then(|c| c.as_array_mut()).into_iter().flatten() {
                            *x = gid(x);
                        }
                    }
                }
            }
            ("GET", ["v1", "chats", _, "items"]) => {
                for it in v["items"].as_array_mut().into_iter().flatten() {
                    if let Some(f) = it.get_mut("forks_after").and_then(|f| f.as_array_mut()) {
                        for x in f.iter_mut() {
                            *x = gid(x);
                        }
                    }
                    if it["kind"] == "forked_from" || it["kind"] == "chat_link" {
                        it["chat"] = gid(&it["chat"]);
                    }
                    for l in it.get_mut("chat_links").and_then(|l| l.as_object_mut()).into_iter().flat_map(|l| l.values_mut()) {
                        l["chat"] = gid(&l["chat"]);
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
            ("PATCH", _) | ("POST", ["v1", "chats", _, "slash" | "move" | "main"]) => {
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

    /// A chat's shared composer draft (a copy: as its home PC says).
    pub fn shared_draft(&self, chat: i64) -> Option<SharedDraft> {
        match self.mesh.status.get(&chat) {
            Some(r) => r.draft.clone(),
            None => self.api.hub.draft(chat),
        }
    }

    /// A chat's shared draft as phones get it; another PC's chat leaves `files` out (they're
    /// that PC's uploads: a phone keeps its own files there).
    pub fn draft_json(&self, chat: i64) -> Value {
        let Some(d) = self.shared_draft(chat) else { return Value::Null };
        let mut v = d.json();
        if self.is_foreign(chat) {
            if let Some(o) = v.as_object_mut() {
                o.remove("files");
            }
        }
        v
    }

    /// Who is typing in a chat, as the wire says it.
    pub fn typing_json(&self, chat: i64) -> Vec<Value> {
        self.typers(chat)
            .into_iter()
            .map(|t| {
                let mut v = json!({ "device": t.device, "kind": t.kind, "label": t.label });
                if !t.text.is_empty() {
                    v["text"] = json!(t.text);
                }
                v
            })
            .collect()
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
        if c.started && kind == Kind::Claude {
            // Each place's own reason is in `device_why`; this one holds for all of them.
            if let Some(w) = self.relocate_blocker(c.id) {
                r.insert("device".into(), json!(w));
            }
        } else if c.started {
            r.insert("device".into(), json!("Only Claude chats move between devices for now"));
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
            // Its project's main chat (0.88), the project row's own: hubs that send it take
            // `POST /v1/chats/<id>/main`.
            "main": c.repo_id.is_some_and(|r| self.main_chat(r) == Some(c.id)),
            "typing": self.typing_json(c.id),
            "draft": self.draft_json(c.id),
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
                // A started Claude chat moves, its session with it (relocate.rs); other
                // providers run here only.
                "device": kind == Kind::Claude && (!c.started || self.relocate_blocker(c.id).is_none()),
                "fast": providers::has_fast(kind),
            },
            "allowed_accounts": allowed,
            "switch_reason": self.switch_reason(c, kind),
            // A started chat: why it can't move to each place it can't go to now, by device id
            // ("" this PC); and where it's moving to, while it is (both optional, 0.63).
            "device_why": self.device_why(c),
            "moving_to": self.moving_to(c.id),
            // It runs in a worktree of its own (worktree.rs): the folder's name, its path (null
            // for another PC's chat) and whether it's gone (optional, 0.66).
            "worktree": self.worktree_marker(c).map(|m| json!({ "name": m.name, "path": m.path.map(|p| p.to_string_lossy().into_owned()), "gone": m.gone })),
            // The pull request of the branch it works on (chatpr.rs): number, state, the
            // footer's label, title and url; null when it has none (optional, 0.83).
            "pr": self.chat_pr(c).map(|p| p.json()),
            // Snoozed out of this PC's sidebar until then, and that time as its row says it
            // ("Tomorrow, 9:00"); null when it isn't (optional, 0.78: there = /snooze answers).
            "snoozed_until_ms": self.snooze_until(&format!("c{}", c.id)).map(|u| u * 1000),
            "snoozed_label": self.snoozed_label(c.id),
        })
    }

    /// PATCH's account/model/effort/access/device/fast, with the desktop composer's rules.
    pub(crate) fn api_patch_run(&mut self, chat: i64, body: &Value, ctx: &egui::Context) -> Result<(), Reply> {
        let Some(c) = self.chat(chat).cloned() else { return Err(err(404, "no such chat")) };
        let net = crate::remote::tailnet(ctx);
        let hosts: Vec<crate::remote::Host> = crate::remote::devices(&self.remote, &net).into_iter().map(|(h, _)| h).collect();
        let ids: Vec<&str> = hosts.iter().map(|h| h.id.as_str()).collect();
        let allowed = self.allowed_accounts(chat);
        // A started chat moves to the device picked, its sessions with it (relocate.rs): checked
        // first, started after the rest applied.
        let moving = body["device"].as_str().filter(|d| c.started && !c.foreign() && *d != c.device).map(String::from);
        let mut body = body.clone();
        if let Some(d) = &moving {
            let devs = crate::remote::devices(&self.remote, &net);
            if let Some(w) = self.relocate_why(chat, d, &devs) {
                return Err(err(409, format!("can't move it there: {w}")));
            }
            if let Some(o) = body.as_object_mut() {
                o.remove("device");
            }
        }
        let checked = check_run(&c, &body, &self.accounts, &allowed, &|k| self.models_for(k).to_vec(), &ids)?;
        let Some((n, fast)) = checked else {
            if let Some(d) = moving {
                self.relocate(chat, &d, ctx).map_err(|e| err(409, e))?;
            }
            return Ok(());
        };
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
        if let Some(d) = moving {
            self.relocate(chat, &d, ctx).map_err(|e| err(409, e))?;
        }
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
        // Where each chat sits, as the desktop sidebar places it (sidebar.rs `tree`; older hubs leave it out).
        let t = self.sidebar_tree();
        let tree = json!({
            // `main` (0.88): the project's main chat, which is the project row itself (null: none yet).
            "projects": t.projects.iter().map(|p| json!({ "id": p.id, "snoozed": p.snoozed, "main": p.main, "chats": p.chats })).collect::<Vec<_>>(),
            "threads": t.threads,
            "settled": t.settled,
            // Snoozed chats, out of the lists above: a search shows them in their places (0.78).
            "snoozed": t.snoozed,
        });
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
            "tree": tree,
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
            // "Is this you?": this PC's detected owner, until confirmed (profile.rs; 0.47).
            "profile_check": self.profile_check_json(),
            // Whether this PC can transcribe a phone's recording (voice.rs), and why not.
            "voice": { "transcribe": true, "why": null, "lang": crate::voice::config().0 },
        })
    }

    /// The two update banners' data (notices.rs draws the same on the desktop): the Harbor
    /// release this hub can install, and its provider CLIs that are behind. Null when none.
    pub fn updates_json(&self) -> Value {
        // Updating automatically (0.53) the desktop shows no toast while it installs and waits
        // to swap in: the phone's banner neither.
        let hub = self.harbor_offer().filter(|(_, installing)| !self.harbor_silent(*installing)).map(|(v, installing)| {
            // `ready` (0.47.1): already installed on disk, Update only restarts into it.
            json!({ "version": v, "current": crate::update::VERSION, "installing": installing || self.reload_asked, "ready": self.harbor_ready().is_some(), "notes_url": crate::notices::notes_url(&v) })
        });
        // An Update asked before any release was known (0.51): checking first, version "".
        let hub = hub.or_else(|| {
            (self.reload_asked && crate::update::state() == crate::update::State::Checking)
                .then(|| json!({ "version": "", "current": crate::update::VERSION, "installing": true, "checking": true, "ready": false }))
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
        let items = &self.transcripts[&chat].items;
        let cards = crate::view::project(items, lead, &forks);
        // Every change to a chat goes through `api_touch`: nothing new since the last look,
        // nothing to hash (a phone asks again after each event, many times a second).
        let now = self.api.hub.chat_rev(chat);
        // Image addresses name the chat: a copy of another PC's chat fetches them from there.
        let gid = self.chat(chat).map(|c| c.gid.clone()).unwrap_or_default();
        // Where relative media paths in its replies start.
        let cwd = self.media_cwd(chat);
        let (dir, wake) = (self.commit_dir(chat), self.chat_waker(chat));
        // The chats each reply links to (chatlink.rs), as this PC finds them.
        let links: Vec<serde_json::Map<String, Value>> = cards
            .iter()
            .map(|c| match &c.card {
                crate::view::Card::Text { text, .. } => self.link_targets(text),
                _ => Default::default(),
            })
            .collect();
        let revs = self.api.items.entry(chat).or_default();
        let fresh = self.api.looked.get(&chat) == Some(&now) && revs.len() == items.len();
        // Commits a reply names (commits.rs): looked up on threads; the chat changes once known.
        let commits_of = |c: &crate::view::Shown| match &c.card {
            crate::view::Card::Text { text, .. } => crate::commits::of_text(dir.as_deref(), text, wake.clone()),
            _ => Default::default(),
        };
        let links_of = |c: &crate::view::Shown| &links[c.seq];
        // An item's version includes how it shows: forkable once its turn ends, a fork made
        // from it, the commits it names, the run of tool calls it folds into.
        let hashes: Vec<u64> = if fresh {
            vec![]
        } else {
            items
                .iter()
                .zip(&cards)
                .map(|(it, c)| {
                    let mut shas: Vec<String> = commits_of(c).values().map(|c| c.sha.clone()).collect();
                    shas.sort();
                    // A chat link changes when the chat it names arrives (from another PC).
                    let linked = matches!(c.card, crate::view::Card::ChatLink { gid, .. } if self.chats.iter().any(|x| x.gid == gid));
                    // …and so does a reply's chat link (that chat arrives, is renamed, is deleted).
                    let links = serde_json::to_string(links_of(c)).unwrap_or_default();
                    hash_of(&(fingerprint(it), crate::view::kind(&c.card), matches!(c.card, crate::view::Card::Text { forkable: true, .. }), &c.forks_after, shas, linked, c.group, links))
                })
                .collect()
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
            .map(|c| with_chat(card_json(c, revs[c.seq].1, &mut |t| crate::media::find(t, cwd.as_deref()), &commits_of(c), links_of(c)), if gid.is_empty() { chat.to_string() } else { gid.clone() }))
            .map(|mut v| {
                if v["kind"] == "chat_link" {
                    let to = v["gid"].as_str().and_then(|g| self.chats.iter().find(|c| c.gid == g)).map(|c| c.id);
                    v["chat"] = json!(to);
                }
                v
            })
            .collect();
        json!({
            "rev": self.api.hub.rev(),
            "count": items.len(),
            "running": self.is_running(chat),
            "queued": self.queued_count(chat),
            "typing": self.typing_json(chat),
            "draft": self.draft_json(chat),
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
        let queue = self.queue_json(chat);
        let working = self.turns.get(&chat).map(|(_, at)| {
            json!({ "since_ms": now_ms - at.elapsed().as_millis() as i64, "subagents": subs.len(), "text": format!("Working…{}", crate::waiting::subs_running(subs.len())) })
        });
        let waiting = (working.is_none() && !subs.is_empty()).then(|| {
            let agents: Vec<Value> = subs.iter().map(|(c, secs)| json!({ "id": c.id, "name": c.name, "title": c.title, "since_ms": now_ms - *secs as i64 * 1000 })).collect();
            json!({ "agents": agents, "queued": self.subs_queued(chat) })
        });
        let limit = self.limit_text(chat).map(|(text, cancel)| {
            // The line's Continue on…: other accounts of the provider, as the desktop lists them.
            let targets: Vec<Value> = self
                .switch_targets(chat, false)
                .iter()
                .map(|id| json!({ "id": id, "name": self.account(id).map(|a| format!("{} · {}", a.short(), a.email)).unwrap_or_else(|| id.clone()) }))
                .collect();
            json!({ "text": text, "can_cancel": cancel, "targets": targets })
        });
        json!({
            "queue": queue, "working": working, "waiting": waiting, "limit": limit, "agents": self.strip_json(chat), "folder": self.folder_json(chat),
            // Steer or Queue (queue.rs): whether the running turn takes a steer, a Stop holds
            // the queue, and this PC's own default (the phone keeps its own setting).
            "can_steer": self.can_steer(chat), "held": self.queue_held(chat), "follow_up": self.follow_setting().as_str(),
        })
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
        let before = self.queued(chat).iter().filter(|q| q.intent.is_empty()).count();
        let running = self.turns.contains_key(&chat);
        // Steer or Queue while its turn runs: the phone says which; an app before 0.71 queues.
        let mode = body["mode"].as_str().and_then(crate::queue::Mode::parse).unwrap_or(crate::queue::Mode::Queue);
        // Sent: the sender's draft preview goes (its client ends the lease too).
        if !self.sender_device.is_empty() {
            self.api.hub.set_typing(chat, &self.sender_device, "", "", false, None);
            self.api.hub.clear_draft(chat);
        }
        let mentions: Vec<crate::mentions::Mention> = serde_json::from_value(body["mentions"].clone()).unwrap_or_default();
        self.queue.mode = Some(mode);
        self.send_to(chat, text, files, mentions, ctx);
        let queued = self.queued(chat).iter().filter(|q| q.intent.is_empty()).count() > before;
        ok(json!({ "ok": true, "queued": queued, "steering": running && !queued && !self.is_foreign(chat) }))
    }

    fn api_create(&mut self, body: &Value, ctx: &egui::Context) -> Reply {
        self.api_create_in(body, ctx, None)
    }

    /// The project a new chat asks for (`project_id`, or `project` from another PC).
    pub(crate) fn api_create_repo(&mut self, body: &Value) -> Result<Option<i64>, Reply> {
        Ok(match &body["project_id"] {
            // From another PC (mesh.rs): the project by its folder, else its remote, else its name.
            // Unknown here but with a remote: listed by the other PC's folder, and cloned here
            // when the chat's first turn starts (clone.rs).
            Value::Null if body["project"].is_object() => {
                let p = &body["project"];
                let (path, name, remote) = (p["path"].as_str().unwrap_or(""), p["name"].as_str().unwrap_or(""), p["remote"].as_str().unwrap_or(""));
                match self.repo_for(path, name, remote).0 {
                    Some(r) => Some(r),
                    None if !remote.is_empty() && !path.is_empty() => {
                        let id = self.store.add_repo(std::path::Path::new(path)).map_err(|e| err(500, e.to_string()))?;
                        self.store.set_repo_remote(id, remote);
                        self.repos = self.store.repos();
                        Some(id)
                    }
                    None if remote.is_empty() => {
                        return Err(err(409, format!("{name} isn't a project on {} and has no Git remote to clone there: add its folder to Harbor on that PC first", crate::remote::hostname())));
                    }
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
    pub(crate) fn api_create_in(&mut self, body: &Value, ctx: &egui::Context, wt: Option<crate::worktree::Made>) -> Reply {
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
        // `main` (0.88): written on the project's page, so its main chat: the message goes to
        // it when the project has one (started meanwhile elsewhere), else this chat becomes it.
        let main = repo.filter(|_| body["main"].as_bool() == Some(true));
        if let Some(m) = main.and_then(|r| self.main_chat(r)) {
            if !text.is_empty() || !files.is_empty() {
                self.send_to(m, text, files, vec![], ctx);
            }
            let gid = self.chat(m).map(|c| c.gid.clone()).unwrap_or_default();
            return ok(json!({ "id": m, "gid": gid }));
        }
        let id = self.new_thread_with(repo, &text, sel);
        if main.is_some() {
            self.adopt_main(main, id);
        }
        self.ws_attach(id, wt);
        if let Some(c) = self.chat_mut(id) {
            c.effort = effort;
            c.access = access;
            c.device = device;
        }
        // Optional (0.57): the sidebar title, and the chat whose agent opened it (openchat.rs).
        if let Some(t) = body["title"].as_str().map(|t| t.trim().chars().take(80).collect::<String>()).filter(|t| !t.is_empty()) {
            if let Some(c) = self.chat_mut(id) {
                c.title = t;
            }
        }
        if let (Some(gid), Some(title)) = (body["opened_from"]["gid"].as_str(), body["opened_from"]["title"].as_str()) {
            self.notice(id, "chat", &crate::openchat::opened_by(title), &format!("{}{gid}", crate::openchat::LINK));
        }
        self.persist(id);
        if !text.is_empty() || !files.is_empty() {
            self.send_to(id, text, files, vec![], ctx);
        }
        let gid = self.chat(id).map(|c| c.gid.clone()).unwrap_or_default();
        ok(json!({ "id": id, "gid": gid }))
    }

    /// `text`: a part of the message the phone selected (an excerpt mention), else all of it.
    fn api_mention(&mut self, chat: i64, seq: usize, text: Option<&str>) -> Option<crate::mentions::Mention> {
        if !self.transcripts.contains_key(&chat) {
            let items = self.store.items(chat);
            self.transcripts.insert(chat, crate::app::Transcript { items, ..Default::default() });
        }
        let items = &self.transcripts[&chat].items;
        let shown = crate::view::project(items, false, &[]);
        if !crate::view::actions(&shown.get(seq)?.card).contains(&crate::view::Action::Mention) {
            return None;
        }
        match text {
            Some(t) => self.excerpt_of(chat, seq, t),
            None => self.mention_of(chat, seq),
        }
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
    fn the_app_from_the_internet_only_signed_in() {
        let t = |l: Option<Level>| Ok(("tok".to_string(), l));
        assert!(apk_allowed(false, &Err((401, "no token"))) && apk_allowed(false, &t(Some(Level::Loopback))), "this network: anyone");
        assert!(apk_allowed(true, &t(None)), "the internet: a signed-in phone");
        assert!(apk_allowed(true, &t(Some(Level::Legacy))), "or a pairing from before accounts, to update and sign in");
        assert!(!apk_allowed(true, &Err((401, "expired"))));
    }

    #[test]
    fn old_pairings_only_update_the_app() {
        let hub = Hub::new(vec![Token { token: "tok".into(), group: "g".repeat(16), ..Default::default() }], DEFAULT_PORT);
        assert_eq!(hub.auth("tok", &Via::Tls(Some("a".repeat(64)))), Ok(Level::Legacy));
        assert_eq!(hub.auth("tok", &Via::Legacy), Ok(Level::Legacy));
        assert_eq!(hub.auth("tok", &Via::Loopback), Ok(Level::Loopback), "127.0.0.1 is this PC");
        assert!(hub.auth("tok", &Via::Refused).is_err());
        assert!(hub.auth("nope", &Via::Loopback).is_err() && hub.auth("", &Via::Loopback).is_err());
    }

    #[test]
    fn signed_in_phones_get_a_handle_that_is_no_credential() {
        let hub = Hub::new(vec![], DEFAULT_PORT);
        let c = crate::account::Claims { sub: "user_1".into(), name: "Sam".into(), ..Default::default() };
        let fp = "f".repeat(64);
        let h = hub.account_phone(&c, &fp);
        assert_eq!(hub.account_phone(&c, &fp), h, "the same phone, the same handle");
        assert_eq!(hub.group_of(&h), fp, "a phone is its key on every PC");
        assert!(hub.tokens_dirty.load(Ordering::SeqCst));
        assert!(hub.auth(&h, &Via::Loopback).is_err(), "the handle never works as a bearer token");
        assert_eq!(hub.local_phones()[0].owner, "Sam");
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
        assert!(hub.set_typing(5, "tok:1", "phone", "Galaxy", true, None), "starting is a change");
        assert_eq!(hub.typing(5).iter().map(|t| (t.device.as_str(), t.kind.as_str(), t.label.as_str())).collect::<Vec<_>>(), [("tok:1", "phone", "Galaxy")]);
        let (_, chats, state) = hub.wait(r0, Duration::ZERO);
        assert_eq!((chats, state), (vec![5], true));
        let r1 = hub.rev();
        assert!(!hub.set_typing(5, "tok:1", "phone", "Galaxy", true, None), "a renewal only extends the lease");
        assert_eq!(hub.rev(), r1);
        assert!(hub.set_typing(5, "pc:desk", "pc", "desk", true, None));
        assert_eq!(hub.typing(5).len(), 2);
        assert!(hub.set_typing(5, "tok:1", "phone", "", false, None), "stopping is a change");
        assert!(!hub.set_typing(5, "tok:1", "phone", "", false, None));
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

    #[test]
    fn typing_drafts() {
        let hub = Arc::new(Hub::new(vec![], DEFAULT_PORT));
        assert!(hub.set_typing(5, "tok:1", "phone", "Galaxy", true, Some("Hel")), "starting is a change");
        assert_eq!(hub.typing(5)[0].text, "Hel");
        // Within the gap a new draft is kept but held back: no wake-up per key.
        let r1 = hub.rev();
        assert!(!hub.set_typing(5, "tok:1", "phone", "Galaxy", true, Some("Hell")));
        assert!(!hub.set_typing(5, "tok:1", "phone", "Galaxy", true, Some("Hello")));
        assert_eq!(hub.rev(), r1);
        assert_eq!(hub.typing(5)[0].text, "Hello", "readers see the newest draft");
        // The held draft is announced once the gap has passed, without anyone calling in.
        let due = hub.next_typing_expiry().unwrap();
        assert!(due <= Instant::now() + PREVIEW_GAP);
        let t = Instant::now();
        let (rev, chats, _) = hub.wait(r1, Duration::from_secs(5));
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        assert!(rev > r1);
        assert_eq!(chats, vec![5]);
        assert!(!hub.revs.lock().unwrap().typing[&5][0].held);
        // After the gap a change wakes at once; the same draft (a heartbeat) doesn't.
        hub.revs.lock().unwrap().typing.get_mut(&5).unwrap()[0].quiet = None;
        assert!(hub.set_typing(5, "tok:1", "phone", "Galaxy", true, Some("Hello!")));
        hub.revs.lock().unwrap().typing.get_mut(&5).unwrap()[0].quiet = None;
        assert!(!hub.set_typing(5, "tok:1", "phone", "Galaxy", true, Some("Hello!")));
        // An older client (no text) keeps the draft it had; stopping drops it.
        assert!(!hub.set_typing(5, "tok:1", "phone", "Galaxy", true, None));
        assert_eq!(hub.typing(5)[0].text, "Hello!");
        assert!(hub.set_typing(5, "tok:1", "phone", "", false, None));
        assert!(hub.typing(5).is_empty());
        assert!(hub.set_typing(5, "tok:1", "phone", "Galaxy", true, None));
        assert_eq!(hub.typing(5)[0].text, "", "a new lease starts without the old draft");
        // Only the end of a long draft is kept.
        let long = format!("{}é", "a".repeat(PREVIEW_CHARS + 20));
        assert!(hub.set_typing(6, "tok:2", "phone", "Pixel", true, Some(&long)));
        let kept = &hub.typing(6)[0].text;
        assert_eq!(kept.chars().count(), PREVIEW_CHARS);
        assert!(kept.ends_with('é'));
    }

    #[test]
    fn shared_drafts() {
        let hub = Arc::new(Hub::new(vec![], DEFAULT_PORT));
        let dir = uploads_dir().join("dtest01");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("shot.png"), b"x").unwrap();
        // A phone types: text, an upload, a mention. Unknown uploads are dropped.
        let d = json!({ "text": "Look at this", "files": ["dtest01/shot.png", "nope/x.png"], "mentions": [{ "item": 3, "from": "Claude", "text": "hi" }] });
        assert!(hub.report(7, "tok:1", "phone", "Galaxy", true, Some(&d)));
        let got = hub.draft(7).unwrap();
        assert_eq!((got.text.as_str(), got.by.as_str(), got.label.as_str()), ("Look at this", "tok:1", "Galaxy"));
        assert_eq!(got.files.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["dtest01/shot.png"]);
        assert!(got.files[0].path.ends_with("shot.png") && got.files[0].name == "shot.png");
        assert_eq!(got.mentions.len(), 1);
        assert_eq!(hub.typing(7)[0].text, "Look at this", "0.56 clients still see the text");
        let r1 = got.rev;
        // The same content again (a heartbeat): nothing changes.
        assert!(!hub.report(7, "tok:1", "phone", "Galaxy", true, Some(&d)));
        assert_eq!(hub.draft(7).unwrap().rev, r1);
        // Within the gap a change is kept (newest wins) but announced later.
        assert!(!hub.set_draft(7, "pc:desk", "desk", "Look at this one", Some(vec![DraftFile::of_upload("dtest01/shot.png").unwrap()]), Some(vec![])), "held");
        let got = hub.draft(7).unwrap();
        assert!(got.rev > r1);
        assert_eq!((got.text.as_str(), got.by.as_str(), got.mentions.len()), ("Look at this one", "pc:desk", 0));
        let since = hub.rev();
        let (_, chats, _) = hub.wait(since, Duration::from_secs(3));
        assert_eq!(chats, vec![7], "the held draft wakes the long-polls once the gap is over");
        // An older client only sends text: files and mentions stay; stopping keeps the draft.
        hub.revs.lock().unwrap().drafts.get_mut(&7).unwrap().quiet = None;
        assert!(hub.report(7, "tok:2", "phone", "Old", true, Some(&json!({ "text": "typed on 0.56" }))));
        assert!(hub.report(7, "tok:2", "phone", "", false, Some(&json!({ "text": "" }))));
        let got = hub.draft(7).unwrap();
        assert_eq!((got.text.as_str(), got.files.len()), ("typed on 0.56", 1));
        // A new client's emptied composer clears it everywhere.
        hub.revs.lock().unwrap().drafts.get_mut(&7).unwrap().quiet = None;
        assert!(hub.report(7, "tok:1", "phone", "", false, Some(&json!({ "text": "", "files": [], "mentions": [] }))));
        assert!(hub.draft(7).unwrap().is_empty());
        // A send clears it at once, with a newer rev (so composers empty too).
        hub.revs.lock().unwrap().drafts.get_mut(&7).unwrap().quiet = None;
        hub.report(7, "tok:1", "phone", "Galaxy", true, Some(&d));
        let before = hub.draft(7).unwrap().rev;
        hub.clear_draft(7);
        let got = hub.draft(7).unwrap();
        assert!(got.is_empty() && got.rev > before && got.by.is_empty());
        assert!(hub.typing(7).is_empty(), "the typers stop: the message doesn't wait for them");
        // The draft outlives the typer's lease.
        {
            let mut r = hub.revs.lock().unwrap();
            r.drafts.get_mut(&7).unwrap().quiet = None;
        }
        hub.report(7, "tok:1", "phone", "Galaxy", true, Some(&json!({ "text": "stays" })));
        hub.revs.lock().unwrap().typing.clear();
        assert!(hub.typing(7).is_empty());
        assert_eq!(hub.draft(7).unwrap().text, "stays");
        // Its wire form round-trips (another PC's status of its chat).
        let back = SharedDraft::from_json(&hub.draft(7).unwrap().json()).unwrap();
        assert_eq!((back.text.as_str(), back.rev), ("stays", hub.draft(7).unwrap().rev));
        assert!(SharedDraft::from_json(&Value::Null).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn draft_merge_rules() {
        let now = Instant::now();
        let d = SharedDraft { text: "x".into(), by: "tok:1".into(), rev: 3, ..Default::default() };
        assert_eq!(should_apply(&d, "tok:1", None, now), Apply::Skip, "its own draft");
        assert_eq!(should_apply(&d, "pc:desk", None, now), Apply::Now);
        assert_eq!(should_apply(&d, "pc:desk", Some(now - Duration::from_millis(300)), now), Apply::Later, "edited here just now");
        assert_eq!(should_apply(&d, "pc:desk", Some(now - DRAFT_HOLD - Duration::from_millis(1)), now), Apply::Now);
        let sent = SharedDraft { rev: 4, ..Default::default() };
        assert_eq!(should_apply(&sent, "pc:desk", None, now), Apply::Now, "a send empties every composer");
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
        // What the phone is (0.84), kept per pairing token; control characters dropped.
        call(port, "GET /v1/app HTTP/1.1\r\nAuthorization: Bearer tok\r\nX-Harbor-Platform: Samsung SM-A135M, Android 12 (SDK 31)\tABIs armeabi-v7a\r\n\r\n");
        assert_eq!(hub.platforms.lock().unwrap()["tok"], "Samsung SM-A135M, Android 12 (SDK 31)ABIs armeabi-v7a");
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
        assert_eq!(t[0].text, "", "a client without drafts");
        hub.revs.lock().unwrap().typing.get_mut(&4).unwrap()[0].quiet = None;
        let body = r#"{"typing":true,"text":"fix the build"}"#;
        call(port, &format!("POST /v1/chats/4/typing HTTP/1.1\r\nAuthorization: Bearer tok\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
        assert_eq!(hub.typing(4)[0].text, "fix the build");
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
        hub.elsewhere.lock().unwrap().insert("pc:acer".into(), ("acer".into(), vec![Sighting { group: "gc".into(), name: "A13".into(), seen: later, app: 16002, alive: 0, platform: String::new() }, Sighting { group: "zz".into(), name: "not ours".into(), seen: later, app: 1, alive: 0, platform: String::new() }]));
        let p = hub.paired_phones();
        assert_eq!(p.len(), 3, "only pairings this PC has");
        assert_eq!((p[0].group.as_str(), p[0].seen, p[0].via.as_str(), p[0].name.as_str(), p[0].app), ("gc", later, "acer", "A13", 16002));
        let a = p.iter().find(|p| p.group == "ga").unwrap();
        assert_eq!(a.via, "", "seen here last");
    }

    #[test]
    fn phone_versions_outlive_a_restart() {
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
        call(port, "GET /v1/app HTTP/1.1\r\nAuthorization: Bearer a\r\nX-Harbor-Device: Pixel\r\nX-Harbor-App: 66000\r\n\r\n");
        // The agent's and the phone's view: the app's version, phone b never seen.
        let v = crate::versions::api_json(&hub);
        let pixel = v["phones"].as_array().unwrap().iter().find(|p| p["name"] == "Pixel").cloned().unwrap();
        assert_eq!((pixel["app"].as_i64(), pixel["app_version"].as_str()), (Some(66000), Some("0.66.0")));
        assert!(pixel["line"].as_str().unwrap().starts_with("app 0.66.0 (66000), seen just now"), "{pixel}");
        assert_eq!(v["pcs"][0]["self"], json!(true));
        assert_eq!(v["pcs"][0]["version"], json!(crate::update::VERSION));
        assert!(crate::versions::text(&hub).contains("- Pixel: app 0.66.0 (66000)"));
        let s = store::Store::open_temp();
        hub.remember_phones(&s);
        // The next run: nothing heard yet, what the last one saw stays.
        let next = Hub::new(vec![tok("a2", "ga"), tok("b", "gb")], 0);
        next.load_remembered(&s);
        let p = next.local_phones();
        let a = p.iter().find(|p| p.group == "ga").unwrap();
        assert_eq!((a.name.as_str(), a.app, a.seen > 0), ("Pixel", 66000, true));
        assert_eq!(p.iter().find(|p| p.group == "gb").unwrap().seen, 0);
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
    fn blocks_linkify_bare_web_urls() {
        let b = blocks("See https://example.com/path, http://example.org. [named](https://example.net) and ftp://example.com.");
        let Block::Paragraph { spans } = &b[0] else { panic!("{b:?}") };
        let linked: Vec<_> = spans.iter().filter_map(|s| s.link.as_deref().map(|url| (s.text.as_str(), url))).collect();
        assert_eq!(linked, vec![("https://example.com/path", "https://example.com/path"), ("http://example.org", "http://example.org"), ("named", "https://example.net")]);
        assert!(spans.iter().any(|s| s.text.contains("ftp://example.com") && s.link.is_none()));
        let items = vec![Item::Text { text: "Open https://example.com/path".into(), at: 0 }];
        let cards = crate::view::project(&items, false, &[]);
        let wire = card_json(&cards[0], 1, &mut |_| vec![], &HashMap::new(), &Default::default());
        assert_eq!(wire["blocks"][0]["spans"][1]["link"], "https://example.com/path");
        assert_eq!(wire["markdown"], "Open https://example.com/path");
    }

    #[test]
    fn blocks_linkify_preserves_code_and_existing_links() {
        let md = "`https://inline.example`\n\n```text\nhttps://fenced.example\n```\n\n~~~\nhttps://tilde.example\n~~~\n\n    https://indented.example\n\n[https://label.example](https://target.example) <https://auto.example>";
        // Shared desktop/hub preprocessing must leave the original Markdown byte-for-byte.
        assert_eq!(crate::chat::linkify(md), md);
        let b = blocks(md);
        assert_eq!(b[0], Block::Paragraph { spans: vec![Span { code: true, ..s("https://inline.example") }] });
        for (i, host) in [(1, "fenced"), (2, "tilde"), (3, "indented")] {
            let Block::Code { text, .. } = &b[i] else { panic!("{b:?}") };
            assert_eq!(text, &format!("https://{host}.example"));
        }
        let Block::Paragraph { spans } = &b[4] else { panic!("{b:?}") };
        assert_eq!(spans[0].link.as_deref(), Some("https://target.example"));
        assert_eq!(spans[2].link.as_deref(), Some("https://auto.example"));
        // A literal backtick inside a code fence must not turn following code into prose.
        let md = "```\n` https://code.example\n```\n\nhttps://prose.example";
        assert_eq!(crate::chat::linkify(md), "```\n` https://code.example\n```\n\n<https://prose.example>");
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
            let cards = crate::view::project(&items, false, &[]);
            card_json(&cards[0], 9, &mut |_| vec![], &HashMap::new(), &Default::default())
        };
        let v = one(Item::User { text: "hi".into(), files: vec!["/a/b/photo.jpg".into(), "/a/notes.txt".into()], at: 5, mentions: vec![], sender: String::new(), intent: String::new() });
        assert_eq!((v["kind"].as_str(), v["seq"].as_u64(), v["rev"].as_u64()), (Some("user"), Some(0), Some(9)));
        assert_eq!(v["files"], json!(["notes.txt"]));
        assert_eq!(v["images"], json!([{ "name": "photo.jpg", "url": "/v1/image?path=%2Fa%2Fb%2Fphoto.jpg&max=512" }]));
        assert_eq!((v["actions"].clone(), v["time"].is_string()), (json!(["copy", "quote", "mention"]), true));
        let v = one(Item::Tool { id: "t".into(), name: "mcp__github__get_pr".into(), summary: "ls".into(), input: "x".repeat(CLIP * 2), result: None, is_error: false });
        assert_eq!((v["label"].as_str(), v["done"].as_bool()), (Some("github · get_pr"), Some(false)));
        assert!(v["input"].as_str().unwrap().len() < CLIP + 100);
        let v = one(Item::Text { text: "# H".into(), at: 0 });
        assert_eq!((v["markdown"].as_str(), v["blocks"][0]["type"].as_str()), (Some("# H"), Some("heading")));
        // A chat link reads as the chat's title, resolved in `chat_links`.
        let items = vec![Item::Text { text: "See harbor://chat/g-1 now".into(), at: 0 }];
        let cards = crate::view::project(&items, false, &[]);
        let links: serde_json::Map<String, Value> = [("harbor://chat/g-1".to_string(), json!({ "title": "Fix login", "chat": 4, "missing": "" }))].into_iter().collect();
        let l = card_json(&cards[0], 1, &mut |_| vec![], &HashMap::new(), &links);
        assert_eq!(l["blocks"][0]["spans"][1], json!({ "text": "Fix login", "link": "harbor://chat/g-1" }));
        assert_eq!(l["chat_links"]["harbor://chat/g-1"]["chat"], 4);
        // No time to show; no turn end after it yet, so no fork.
        assert_eq!((v["actions"].clone(), v.get("time")), (json!(["copy", "mention"]), None));
        let v = one(Item::Result { cost_usd: 0.0, duration_ms: 75_000, turns: 1, input_tokens: 0, output_tokens: 0, cached: 0, at: 0, account: String::new(), model: String::new() });
        // A turn's end: no usage line in the chat.
        assert_eq!((v["kind"].as_str(), v.get("text")), (Some("hidden"), None));
    }

    #[test]
    fn media_on_the_wire() {
        use crate::media::Media;
        let items = vec![Item::Text { text: "See ![Chart](out/c.png) and the run\n\n![](/v/run.mp4)\nAlso /tmp/x.png".into(), at: 1 }];
        let cards = crate::view::project(&items, false, &[]);
        let m = |path: &str, caption: &str, video: bool, shown: bool| Media { path: path.into(), caption: caption.into(), video, shown, url: None };
        let v = card_json(&cards[0], 3, &mut |_| vec![m("/p/out/c.png", "Chart", false, true), m("/v/run.mp4", "", true, true), m("/tmp/x.png", "", false, false)], &HashMap::new(), &Default::default());
        let v = with_chat(v, "g1".into());
        assert_eq!(v["media"], json!([
            { "name": "c.png", "caption": "Chart", "kind": "image", "url": "/v1/image?path=%2Fp%2Fout%2Fc.png&max=512&chat=g1" },
            { "name": "run.mp4", "caption": "", "kind": "video", "url": "/v1/media?path=%2Fv%2Frun.mp4&chat=g1", "poster": "/v1/image?path=%2Fv%2Frun.mp4&max=512&chat=g1" },
        ]));
        // Older apps still get every image in their strip.
        assert_eq!(v["images"].as_array().unwrap().len(), 2);
        // The text drawn leaves the media out; the markdown (copy) keeps it.
        assert!(!serde_json::to_string(&v["blocks"]).unwrap().contains("c.png"));
        assert!(v["markdown"].as_str().unwrap().contains("![Chart](out/c.png)"));
        // No media: no field.
        let plain = vec![Item::Text { text: "hi".into(), at: 1 }];
        let cards = crate::view::project(&plain, false, &[]);
        assert!(card_json(&cards[0], 1, &mut |_| vec![], &HashMap::new(), &Default::default()).get("media").is_none());
    }

    /// A reply showing a /tmp screenshot and a project-relative image: the addresses the phone
    /// (and another PC, `/mesh/v1/image` and `/media` serve the same) gets, and the bytes they
    /// serve, also once the /tmp file is deleted.
    #[test]
    fn a_replys_images_are_served_even_after_their_temp_file_is_gone() {
        let root = std::env::temp_dir().join(format!("harbor-reply-media-{}", std::process::id()));
        let (proj, tmp) = (root.join("proj"), root.join("tmp"));
        std::fs::create_dir_all(proj.join("out")).unwrap();
        std::fs::create_dir_all(&tmp).unwrap();
        let png = |w: u32, h: u32| {
            let mut out = std::io::Cursor::new(vec![]);
            image::RgbImage::new(w, h).write_to(&mut out, image::ImageFormat::Png).unwrap();
            out.into_inner()
        };
        std::fs::write(proj.join("out/chart.png"), png(40, 20)).unwrap();
        let shot = tmp.join("shot.png");
        std::fs::write(&shot, png(30, 30)).unwrap();
        let text = format!("The chart:\n\n![Weekly chart](out/chart.png)\n\nAnd the page:\n\n![Login page]({})", shot.display());
        let items = vec![Item::Text { text: text.clone(), at: 1 }];
        let cards = crate::view::project(&items, false, &[]);
        let v = with_chat(card_json(&cards[0], 1, &mut |t| crate::media::find(t, Some(&proj)), &HashMap::new(), &Default::default()), "g1".into());
        let media = v["media"].as_array().unwrap();
        assert_eq!(media.iter().map(|m| m["caption"].as_str().unwrap()).collect::<Vec<_>>(), ["Weekly chart", "Login page"]);
        // Each goes after the paragraph that introduces it.
        assert_eq!(media.iter().map(|m| m["after"].as_u64().unwrap()).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(v["blocks"].as_array().unwrap().len(), 2);
        let path_of = |url: &str| url_decode(url.split("path=").nth(1).unwrap().split('&').next().unwrap());
        let paths: Vec<String> = media.iter().map(|m| path_of(m["url"].as_str().unwrap())).collect();
        assert_eq!(paths, [proj.join("out/chart.png").to_string_lossy(), shot.to_string_lossy()]);
        let get = |path: &str, max: Option<u32>| {
            let mut out = vec![];
            serve_image(&mut out, path, max);
            out
        };
        let ok = |r: &[u8]| r.starts_with(b"HTTP/1.1 200");
        assert!(ok(&get(&paths[0], Some(512))) && ok(&get(&paths[1], Some(512))));
        // The reply ends: its files are kept; the agent cleans up /tmp; it still serves.
        crate::media::keep(&text, Some(&proj));
        let kept = crate::media::kept_path(&shot);
        let until = std::time::Instant::now() + Duration::from_secs(10);
        while !kept.is_file() && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::remove_file(&shot).unwrap();
        let full = get(&paths[1], None);
        assert!(ok(&full) && full.ends_with(&png(30, 30)), "{}", String::from_utf8_lossy(&full[..60.min(full.len())]));
        let mut file = vec![];
        serve_media(&mut file, &paths[1]);
        assert!(ok(&file) && String::from_utf8_lossy(&file).contains("image/png"));
        // A path no reply showed stays gone.
        assert!(get(&tmp.join("other.png").to_string_lossy(), None).starts_with(b"HTTP/1.1 404"));
        let _ = std::fs::remove_file(kept);
        let _ = std::fs::remove_file(crate::media::kept_path(&proj.join("out/chart.png")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The phone gets the desktop's projection of a chat, card for card: the same cards hidden,
    /// the same kinds in the same order, the same labels, dividers and images.
    #[test]
    fn the_phone_sees_what_the_desktop_draws() {
        use crate::view::{Card, kind, project};
        let items = crate::view::fixture();
        let forks = [(8, 42)];
        // What chat.rs draws: these cards, skipping the hidden ones.
        let desktop = project(&items, true, &forks);
        let phone: Vec<Value> = desktop.iter().map(|c| card_json(c, 1, &mut |_| vec![], &HashMap::new(), &Default::default())).collect();
        assert_eq!(phone.len(), items.len(), "one card per item, so seq stays the item's index");
        for (d, p) in desktop.iter().zip(&phone) {
            assert_eq!(p["kind"].as_str(), Some(kind(&d.card)));
            assert_eq!(p["seq"].as_u64(), Some(d.seq as u64));
            assert_eq!(p["forks_after"].as_array().map(|a| a.len()).unwrap_or(0), d.forks_after.len());
            // The long-press sheet offers what the hover bar does.
            let acts: Vec<&str> = crate::view::actions(&d.card).iter().map(|a| a.id()).collect();
            assert_eq!(p["actions"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>()).unwrap_or_default(), acts);
            match &d.card {
                Card::Text { text, forkable, .. } => assert_eq!((p["markdown"].as_str(), p["forkable"].as_bool()), (Some(*text), Some(*forkable))),
                Card::Tool { label, .. } => assert_eq!(p["label"].as_str(), Some(label.as_str())),
                Card::Message { from, to, text } => assert_eq!((p["from"].as_str(), p["to"].as_str(), p["text"].as_str()), (Some(*from), Some(*to), Some(*text))),
                Card::Notice { url, .. } => assert_eq!(p["url"].as_str(), *url),
                _ => {}
            }
        }
        let shown: Vec<&str> = phone.iter().filter(|p| p["kind"] != "hidden").map(|p| p["kind"].as_str().unwrap()).collect();
        assert_eq!(shown, ["user", "notice", "text", "message", "tool", "text", "notice", "error"]);
        assert_eq!(phone[9]["kind"], "hidden");
        assert_eq!(phone[8]["forks_after"], json!([42]));
    }
}
