//! The phone API: Harbor for Android drives this Harbor's chats over the tailnet.
//!
//! A fourth listener like control.rs and bridge.rs: hand-written HTTP/1.1 on `std::net`, a
//! thread per connection, no async runtime. It binds to this PC's Tailscale addresses (from
//! `tailscale status --json`) and 127.0.0.1, never to 0.0.0.0, on port 47930 (kv `api_port`).
//! Every request but `GET /app.apk` carries `Authorization: Bearer <token>`; tokens are made
//! and revoked in Settings › Phones and kept in kv (`api_tokens`). WireGuard encrypts the hop.
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
const POLL: Duration = Duration::from_secs(20);
/// How long a call waits for the UI thread.
const UI_WAIT: Duration = Duration::from_secs(30);
/// How long a long-poll that saw a change waits for more before answering.
const COALESCE: Duration = Duration::from_millis(150);
const MAX_JSON: usize = 2 << 20;
/// The most a request's line and headers may take to arrive.
pub const HEAD_WAIT: Duration = Duration::from_secs(10);
const MAX_UPLOAD: usize = 200 << 20;
/// Tool inputs and results are cut to this on the wire (the desktop keeps them whole).
const CLIP: usize = 16 << 10;

// ================================================================== shared state

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
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
}

#[derive(Default)]
struct Revs {
    rev: u64,
    /// The revision `/v1/state` last changed at.
    state: u64,
    chats: HashMap<i64, u64>,
    /// Who is typing in which chat, until when.
    typing: HashMap<i64, Vec<Typer>>,
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
        for (chat, v) in self.typing.iter_mut() {
            let n = v.len();
            v.retain(|t| t.until > now);
            if v.len() != n {
                gone.push(*chat);
            }
        }
        self.typing.retain(|_, v| !v.is_empty());
        for c in &gone {
            self.mark(*c);
        }
        !gone.is_empty()
    }

    fn next_expiry(&self) -> Option<Instant> {
        self.typing.values().flatten().map(|t| t.until).min()
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

/// A client's device id: stable per token, without giving the token away.
pub fn device_id(token: &str) -> String {
    format!("tok:{:08x}", hash_of(&token) as u32)
}

/// This PC's own composer as a typer.
pub fn local_device() -> String {
    format!("pc:{}", crate::remote::hostname())
}

/// Where the listener is reachable, for Settings › Phones.
#[derive(Clone, Default)]
pub struct Net {
    /// MagicDNS name, without the trailing dot ("desk.example.ts.net").
    pub dns: String,
    pub ips: Vec<String>,
    /// Addresses the listener holds.
    pub bound: Vec<String>,
    pub error: String,
}

/// What the listener threads and the UI thread share.
pub struct Hub {
    pub enabled: AtomicBool,
    started: AtomicBool,
    pub port: Mutex<u16>,
    pub tokens: Mutex<Vec<Token>>,
    /// Token → (device name, last seen): this session only.
    pub seen: Mutex<HashMap<String, (String, i64)>>,
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
            revs: Mutex::new(Revs { rev: base, state: base, ..Default::default() }),
            cv: Condvar::new(),
            net: Mutex::new(Net::default()),
            epoch: base,
            mesh: Default::default(),
            tokens_dirty: AtomicBool::new(false),
            revoked: Mutex::new(vec![]),
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
        let now = Instant::now();
        let mut r = self.revs.lock().unwrap();
        let mut changed = r.prune(now);
        let v = r.typing.entry(chat).or_default();
        let at = v.iter().position(|t| t.device == device);
        match (at, on) {
            (Some(i), true) => {
                v[i].until = now + TYPING_TTL;
                if v[i].label != label || v[i].kind != kind {
                    v[i].label = label.into();
                    v[i].kind = kind.into();
                    changed = true;
                }
            }
            (None, true) => {
                v.push(Typer { device: device.into(), kind: kind.into(), label: label.into(), until: now + TYPING_TTL });
                changed = true;
            }
            (Some(i), false) => {
                v.remove(i);
                changed = true;
            }
            (None, false) => {}
        }
        r.typing.retain(|_, v| !v.is_empty());
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

    fn known(&self, token: &str) -> bool {
        // Every stored token is compared in full, so the time taken says nothing about it.
        self.tokens.lock().unwrap().iter().fold(false, |ok, t| ok | same(t.token.as_bytes(), token.as_bytes()))
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
        Local { hub, items: HashMap::new(), looked: HashMap::new(), chats: HashMap::new(), rest: 0, draft: None, ui: Default::default() }
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
    std::thread::spawn(move || {
        let port = *hub.port.lock().unwrap();
        let mut bound: Vec<String> = vec![];
        loop {
            // HARBOR_LISTEN=127.0.0.1: only there (test instances stay off the tailnet).
            let only: Option<Vec<String>> = std::env::var("HARBOR_LISTEN").ok().map(|l| l.split(',').map(|s| s.trim().to_string()).collect());
            let (dns, ips) = if only.is_some() { Default::default() } else { tailnet_self() };
            let mut want = only.clone().unwrap_or_else(|| vec!["127.0.0.1".to_string()]);
            want.extend(ips.iter().cloned());
            let mut error = String::new();
            let todo: Vec<String> = want.into_iter().filter(|ip| !bound.contains(ip)).collect();
            for ip in &todo {
                match TcpListener::bind((ip.as_str(), port)) {
                    Ok(l) => {
                        bound.push(ip.clone());
                        let (hub, tx, wake) = (hub.clone(), tx.clone(), wake.clone());
                        std::thread::spawn(move || accept(l, hub, tx, wake));
                    }
                    Err(e) => error = format!("{ip}:{port}: {e}"),
                }
            }
            *hub.net.lock().unwrap() = Net { dns, ips: ips.clone(), bound: bound.clone(), error };
            wake();
            // Tailscale may come up (or change address) after Harbor: look again now and then.
            let all = ips.iter().all(|ip| bound.contains(ip)) && !ips.is_empty();
            std::thread::sleep(Duration::from_secs(if all { 120 } else { 20 }));
        }
    });
}

/// This PC's MagicDNS name and Tailscale IPs.
fn tailnet_self() -> (String, Vec<String>) {
    let out = std::process::Command::new("tailscale").args(["status", "--json"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output();
    let Some(v) = out.ok().and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok()) else { return Default::default() };
    parse_self(&v)
}

pub fn parse_self(v: &Value) -> (String, Vec<String>) {
    if v["BackendState"].as_str().is_some_and(|s| s != "Running") {
        return Default::default();
    }
    let dns = v["Self"]["DNSName"].as_str().unwrap_or("").trim_end_matches('.').to_string();
    let ips = v["Self"]["TailscaleIPs"].as_array().into_iter().flatten().filter_map(|x| x.as_str()).map(String::from).collect();
    (dns, ips)
}

/// Phones' connections at once (each long-polls on one).
static CONNS: Conns = Conns::new(64);

fn accept(l: TcpListener, hub: Arc<Hub>, tx: Sender<crate::control::Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    for stream in l.incoming().flatten() {
        if !hub.active() {
            continue; // dropped: closed without a word
        }
        let Some(slot) = CONNS.take() else { continue };
        let (hub, tx, wake) = (hub.clone(), tx.clone(), wake.clone());
        std::thread::spawn(move || {
            serve(stream, &hub, &tx, &wake);
            drop(slot);
        });
    }
}

fn serve(stream: TcpStream, hub: &Hub, tx: &Sender<crate::control::Incoming>, wake: &(impl Fn() + Send + Sync)) {
    let mut w = &stream;
    let mut r = BufReader::new(Timed::new(&stream, HEAD_WAIT, Duration::from_secs(30)));
    let req = match read_head(&mut r) {
        Ok(q) => q,
        Err((s, m)) => return send_json(&mut w, s, &json!({ "error": m })),
    };
    r.get_mut().until = None;
    let segs = req.segments();
    // Another PC's Harbor (mesh.rs): known by its Tailscale identity, not a token.
    if segs.first() == Some(&"mesh") {
        let reply = crate::mesh::serve(&stream, &req, &mut r, hub, tx, wake);
        return send_json(&mut w, reply.status, &reply.body);
    }
    if !hub.enabled.load(Ordering::SeqCst) {
        return; // phones are off: closed without a word
    }
    if matches!(req.method.as_str(), "GET" | "HEAD") && segs == ["app.apk"] {
        return serve_apk(&mut w, req.method == "HEAD");
    }
    let Some(token) = req.bearer().filter(|t| hub.known(t)).map(String::from) else {
        return send_json(&mut w, 401, &json!({ "error": "unknown token: pair this phone again in Harbor › Settings › Phones" }));
    };
    let device: String = req.header("x-harbor-device").unwrap_or("").chars().take(60).collect();
    let global = req.header("x-harbor-ids") == Some("global");
    hub.seen.lock().unwrap().insert(token.clone(), (device.clone(), store::now()));
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["v1", "app"]) => send_json(&mut w, 200, &app_info()),
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
            send_json(&mut w, 200, &json!({ "rev": rev, "changed_chats": chats, "state_changed": state }));
        }
        // The PCs of the mesh, with this phone's token on each (mesh.rs).
        ("GET", ["v1", "hubs"]) => send_json(&mut w, 200, &crate::mesh::hubs(hub, &token)),
        ("POST", ["v1", "chats", c, "typing"]) => {
            let Some(chat) = c.parse::<i64>().ok() else { return send_json(&mut w, 404, &json!({ "error": "no such chat" })) };
            let body: Value = read_body(&mut r, req.len, 4096).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
            let on = body["typing"].as_bool().unwrap_or(true);
            let kind = if body["kind"].as_str() == Some("pc") { "pc" } else { "phone" };
            let label = if !device.is_empty() {
                device.clone()
            } else {
                hub.tokens.lock().unwrap().iter().find(|t| t.token == token).map(|t| t.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| if kind == "pc" { "A PC".into() } else { "Phone".into() })
            };
            if hub.set_typing(chat, &device_id(&token), kind, &label, on) {
                wake(); // this PC's window shows it
            }
            send_json(&mut w, 200, &json!({ "ok": true }));
        }
        ("GET", ["v1", "image"]) => serve_image(&mut w, req.query("path").unwrap_or(""), req.query("max").and_then(|m| m.parse().ok())),
        ("POST", ["v1", "upload"]) => {
            let r = upload_to(&mut r, &req, &uploads_dir());
            send_json(&mut w, r.status, &r.body);
        }
        _ => {
            if req.len > MAX_JSON {
                return send_json(&mut w, 413, &json!({ "error": "body too large" }));
            }
            let mut body = vec![0u8; req.len];
            if r.read_exact(&mut body).is_err() {
                return send_json(&mut w, 400, &json!({ "error": "short body" }));
            }
            let body = if body.iter().all(u8::is_ascii_whitespace) {
                Value::Null
            } else {
                match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(e) => return send_json(&mut w, 400, &json!({ "error": format!("bad JSON: {e}") })),
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
                return send_json(&mut w, 503, &json!({ "error": "Harbor is closing" }));
            }
            wake();
            let r = rrx.recv_timeout(UI_WAIT).unwrap_or_else(|_| err(503, "Harbor did not answer in time"));
            send_json(&mut w, r.status, &r.body);
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
        "" if !h.tailscale() => "terminal",
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
            let bars = (subs.get(&c.id).copied().unwrap_or(0), self.paused(c.id).map(|p| p.at), self.queued(c.id).iter().filter(|q| q.written).count());
            let h = hash_of(&(&c.title, c.settled, c.updated, &c.account, &c.model, &c.effort, &c.access, &c.device, c.repo_id, self.is_running(c.id), self.queued_count(c.id), (bars, self.writable_chat(c))));
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
            self.accounts.iter().map(|a| (&a.id, a.logged_in, a.usage.iter().map(|u| (&u.label, (u.percent * 100.0) as i32)).collect::<Vec<_>>())).collect::<Vec<_>>(),
            self.fast,
            self.models.values().map(|m| m.len()).sum::<usize>(),
        ));
        let rest_changed = rest != self.api.rest;
        self.api.rest = rest;
        self.api.chats = seen;
        let hub = &self.api.hub;
        for id in &changed {
            hub.touch(Some(*id), true);
        }
        if (gone || rest_changed) && changed.is_empty() {
            hub.touch(None, true);
        }
    }

    /// This PC's composer as a typer: an edit to an open chat's draft renews the lease, an
    /// emptied draft (sent or cleared) ends it.
    fn local_typing(&mut self) {
        let crate::app::View::Chat(id) = self.view else { return };
        let draft = self.drafts.get(&id).map(|d| d.trim()).unwrap_or("");
        let h = hash_of(&draft);
        if self.api.draft == Some((id, h)) {
            return;
        }
        let was = self.api.draft.replace((id, h));
        let me = local_device();
        if let Some((old, _)) = was.filter(|(old, _)| *old != id) {
            self.api.hub.set_typing(old, &me, "pc", "", false);
        }
        // The first look at a chat isn't typing (a draft left from earlier).
        if was.is_none_or(|(old, _)| old != id) {
            return;
        }
        let label = crate::remote::hostname();
        self.api.hub.set_typing(id, &me, "pc", &label, !draft.is_empty());
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
            let r = self.mesh_route(&call, ctx);
            let _ = call.reply.send(r);
            return;
        }
        // A copy of another PC's chat: the call goes there.
        let Some(call) = self.mesh_proxy(call) else { return };
        // What the phone sends says it came from the phone.
        self.sender = if call.device.is_empty() { "Phone".into() } else { call.device.clone() };
        let mut r = self.api_route(&call, ctx);
        self.sender.clear();
        if call.global && r.status < 300 {
            self.globalize(&call, &mut r.body);
        }
        let _ = call.reply.send(r);
    }

    pub fn api_route(&mut self, call: &Call, ctx: &egui::Context) -> Reply {
        let p: Vec<&str> = call.path.iter().map(String::as_str).collect();
        // A copy is written on its home PC only (mesh.rs forwards it there while it answers).
        if call.method != "GET" && p.len() > 2 && p[1] == "chats" {
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
            ("POST", ["v1", "chats"]) => self.api_create(&call.body, ctx),
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
    fn globalize(&self, call: &Call, v: &mut Value) {
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
            }
            ("POST", ["v1", "chats"]) | ("POST", ["v1", "chats", _, "fork"]) => v["id"] = gid(&v["id"]),
            ("PATCH", _) => {
                if v["chat"].is_object() {
                    chat(&mut v["chat"]);
                }
            }
            _ => {}
        }
    }

    /// A chat's id here from the phone's reference (its id here or its global id).
    fn ref_id(&self, r: &str) -> Option<i64> {
        self.chat_by_ref(r).map(|c| c.id)
    }

    /// Who is typing in a chat, as the wire says it.
    fn typing_json(&self, chat: i64) -> Vec<Value> {
        self.api.hub.typing(chat).into_iter().map(|t| json!({ "device": t.device, "kind": t.kind, "label": t.label })).collect()
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

    pub fn chat_json(&self, c: &store::Chat) -> Value {
        let kind = self.account(&c.account).map_or(Kind::Claude, |a| a.kind);
        let allowed = self.allowed_accounts(c.id);
        json!({
            "id": c.id, "project_id": c.repo_id, "title": c.title, "device": c.device, "account": c.account,
            "model": c.model, "effort": c.effort, "access": c.access, "fast": self.fast, "settled": c.settled,
            "running": self.is_running(c.id), "queued": self.queued_count(c.id),
            "updated_ms": c.updated * 1000, "rev": self.api.hub.chat_rev(c.id),
            // The same chat on every PC of the mesh; the PC it runs on and whether it can be written now.
            "gid": c.gid,
            "home": if c.foreign() { c.home.clone() } else { self.api.hub.mesh.me().id },
            "home_name": self.home_name(c),
            "writable": self.writable_chat(c),
            "role": match c.role { store::Role::Lead => "lead", store::Role::Sub => "sub", store::Role::Chat => "chat" },
            "parent": c.parent,
            "typing": self.typing_json(c.id),
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
    fn api_patch_run(&mut self, chat: i64, body: &Value, ctx: &egui::Context) -> Result<(), Reply> {
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
        let projects: Vec<Value> = self.repos.iter().map(|r| json!({ "id": r.id, "name": r.name, "path": r.path.to_string_lossy() })).collect();
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
        let mut access = serde_json::Map::new();
        for k in Kind::ALL {
            let ms: Vec<Value> = self.models_for(k).iter().map(|m| json!({ "id": m.id, "label": m.label, "more": m.more })).collect();
            models.insert(kind_slug(k), json!(ms));
            efforts.insert(kind_slug(k), json!(providers::efforts(k).iter().map(|e| json!({ "id": e.0, "label": e.1, "desc": e.2 })).collect::<Vec<_>>()));
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
        json!({
            "version": crate::update::VERSION,
            "hub_id": me.id,
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
            "access": access,
            "devices": devices,
            "fast": self.fast,
            "defaults": { "account": s.account, "model": s.model, "effort": s.effort, "access": s.access, "device": s.device, "project_id": self.draft.repo },
            "app": app_info().as_object().map(|o| json!({ "version_code": o["version_code"], "url": o["url"] })).unwrap_or_default(),
        })
    }

    /// The cards of a chat (the desktop's projection, view.rs) changed after `since`, finding
    /// what changed by hashing each item with how it shows.
    pub fn api_items(&mut self, chat: i64, since: u64) -> Value {
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
        let out: Vec<Value> = cards.iter().filter(|c| revs[c.seq].1 > since).map(|c| card_json(c, revs[c.seq].1, &mut crate::images::find_paths)).collect();
        json!({
            "rev": self.api.hub.rev(),
            "count": items.len(),
            "running": self.is_running(chat),
            "queued": self.queued_count(chat),
            "typing": self.typing_json(chat),
            "status": self.api_status(chat),
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
        json!({ "queue": queue, "working": working, "waiting": waiting, "limit": limit })
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
        let busy = self.turns.contains_key(&chat);
        let mentions: Vec<crate::mentions::Mention> = serde_json::from_value(body["mentions"].clone()).unwrap_or_default();
        self.send_to(chat, text, files, mentions, ctx);
        ok(json!({ "ok": true, "queued": busy }))
    }

    fn api_create(&mut self, body: &Value, ctx: &egui::Context) -> Reply {
        let repo = match &body["project_id"] {
            // From another PC (mesh.rs): the project by its folder, else by its name.
            Value::Null if body["project"].is_object() => {
                let (path, name) = (body["project"]["path"].as_str().unwrap_or(""), body["project"]["name"].as_str().unwrap_or(""));
                match self.repos.iter().find(|r| r.path.to_string_lossy() == path).or_else(|| self.repos.iter().find(|r| r.name == name)) {
                    Some(r) => Some(r.id),
                    None => return err(409, format!("{name} isn't a project on {} yet", crate::remote::hostname())),
                }
            }
            Value::Null => None,
            // A project by its folder (phones that move between hubs know it that way).
            Value::String(p) => match self.repos.iter().find(|r| r.path.to_string_lossy() == *p) {
                Some(r) => Some(r.id),
                None => return err(400, "no such project"),
            },
            v => match v.as_i64().filter(|r| self.repo(*r).is_some()) {
                Some(r) => Some(r),
                None => return err(400, "no such project"),
            },
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
        let hub = Hub::new(vec![Token { token: "s3cret".into(), name: String::new(), created: 0, group: String::new() }], DEFAULT_PORT);
        assert!(hub.known("s3cret"));
        assert!(!hub.known("s3cre"));
        assert!(!hub.known("s3cretx"));
        assert!(!hub.known(""));
        let r = head("GET / HTTP/1.1\r\nauthorization: bearer  s3cret \r\n\r\n").unwrap();
        assert_eq!(r.bearer(), Some("s3cret"));
        assert_eq!(head("GET / HTTP/1.1\r\nAuthorization: Basic s3cret\r\n\r\n").unwrap().bearer(), None);
        assert_eq!(head("GET / HTTP/1.1\r\nAuthorization: Bearer\r\n\r\n").unwrap().bearer(), None);
        let empty = Hub::new(vec![Token { token: String::new(), name: String::new(), created: 0, group: String::new() }], DEFAULT_PORT);
        assert!(!empty.known(""));
        assert_eq!(new_token().unwrap().len(), 48);
        assert_ne!(new_token().unwrap(), new_token().unwrap());
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

    #[test]
    fn tailnet_self() {
        let v = json!({ "BackendState": "Running", "Self": { "DNSName": "desk.example.ts.net.", "TailscaleIPs": ["203.0.113.7", "fd7a::1"] } });
        assert_eq!(parse_self(&v), ("desk.example.ts.net".to_string(), vec!["203.0.113.7".to_string(), "fd7a::1".to_string()]));
        assert_eq!(parse_self(&json!({ "BackendState": "Stopped", "Self": { "DNSName": "x." } })).1.len(), 0);
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
        let hub = Arc::new(Hub::new(vec![Token { token: "tok".into(), name: String::new(), created: 0, group: String::new() }], 0));
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
        let v = one(Item::Result { cost_usd: 0.0, duration_ms: 75_000, turns: 1, input_tokens: 0, output_tokens: 0, at: 0, account: String::new(), model: String::new() });
        assert_eq!((v["kind"].as_str(), v["text"].as_str()), (Some("footer"), Some("75.0s · 0k in · 0 out")));
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
        assert_eq!(phone[9]["text"], "Claude · AB · Opus 5.5 · 4.3s · 189k in · 304 out · $3.9634");
        assert_eq!(phone[8]["forks_after"], json!([42]));
    }
}
