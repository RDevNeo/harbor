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
}

#[derive(Default)]
struct Revs {
    rev: u64,
    /// The revision `/v1/state` last changed at.
    state: u64,
    chats: HashMap<i64, u64>,
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
            revs: Mutex::new(Revs { rev: base, state: base, chats: HashMap::new() }),
            cv: Condvar::new(),
            net: Mutex::new(Net::default()),
        }
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
    fn bump(&self) -> u64 {
        let mut r = self.revs.lock().unwrap();
        r.rev += 1;
        r.rev
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
        while r.rev <= since {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            r = self.cv.wait_timeout(r, left).unwrap().0;
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
    s.get("api_tokens").and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_tokens(s: &store::Store, t: &[Token]) {
    s.set("api_tokens", &serde_json::to_string(t).unwrap_or_default());
}

/// What the UI thread keeps for the API: the hub and each transcript's item revisions.
pub struct Local {
    pub hub: Arc<Hub>,
    /// Chat → per item (hash of its JSON, revision it last changed at).
    items: HashMap<i64, Vec<(u64, u64)>>,
    /// Chat → hash of what `/v1/state` says about it; plus the projects/accounts part.
    chats: HashMap<i64, u64>,
    rest: u64,
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
        Local { hub, items: HashMap::new(), chats: HashMap::new(), rest: 0, ui: Default::default() }
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

fn line(r: &mut impl BufRead, max: usize) -> Result<String, (u16, &'static str)> {
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
            return Err((411, "send a content-length"));
        }
        req.headers.push((k, v));
    }
    Err((431, "too many headers"))
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
            let (dns, ips) = tailnet_self();
            let mut want = vec!["127.0.0.1".to_string()];
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

fn accept(l: TcpListener, hub: Arc<Hub>, tx: Sender<crate::control::Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    for stream in l.incoming().flatten() {
        if !hub.enabled.load(Ordering::SeqCst) {
            continue; // dropped: closed without a word
        }
        let (hub, tx, wake) = (hub.clone(), tx.clone(), wake.clone());
        std::thread::spawn(move || serve(stream, &hub, &tx, &wake));
    }
}

fn serve(stream: TcpStream, hub: &Hub, tx: &Sender<crate::control::Incoming>, wake: &(impl Fn() + Send + Sync)) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut w = &stream;
    let mut r = BufReader::new(&stream);
    let req = match read_head(&mut r) {
        Ok(q) => q,
        Err((s, m)) => return send_json(&mut w, s, &json!({ "error": m })),
    };
    let segs = req.segments();
    if matches!(req.method.as_str(), "GET" | "HEAD") && segs == ["app.apk"] {
        return serve_apk(&mut w, req.method == "HEAD");
    }
    let Some(token) = req.bearer().filter(|t| hub.known(t)).map(String::from) else {
        return send_json(&mut w, 401, &json!({ "error": "unknown token: pair this phone again in Harbor › Settings › Phones" }));
    };
    let device: String = req.header("x-harbor-device").unwrap_or("").chars().take(60).collect();
    hub.seen.lock().unwrap().insert(token.clone(), (device.clone(), store::now()));
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["v1", "app"]) => send_json(&mut w, 200, &app_info()),
        ("GET", ["v1", "events"]) => {
            let since = req.query("since").and_then(|s| s.parse().ok()).unwrap_or(0);
            let (rev, chats, state) = hub.wait(since, POLL);
            send_json(&mut w, 200, &json!({ "rev": rev, "changed_chats": chats, "state_changed": state }));
        }
        ("POST", ["v1", "upload"]) => {
            let r = upload(&mut r, &req, &uploads_dir());
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

fn upload(r: &mut impl Read, req: &Request, base: &Path) -> Reply {
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

/// One transcript item for the phone. Results and agent messages are notices.
pub fn item_json(seq: usize, rev: u64, it: &Item) -> Value {
    let mut v = match it {
        Item::User { text, files, at, .. } => json!({ "kind": "user", "text": text, "files": files.iter().map(|f| file_name(f)).collect::<Vec<_>>(), "at": at }),
        Item::Text { text, at } => json!({ "kind": "text", "markdown": text, "blocks": blocks(text), "at": at }),
        Item::Thinking { text } => json!({ "kind": "thinking", "text": text }),
        Item::Tool { name, summary, input, result, is_error, .. } => json!({
            "kind": "tool", "name": name, "summary": summary, "input": clipped(input),
            "result": result.as_deref().map(clipped), "done": result.is_some(), "is_error": is_error,
        }),
        Item::Error { text } => json!({ "kind": "error", "text": text }),
        Item::Notice { icon, text, detail } => json!({ "kind": "notice", "icon": icon, "text": text, "detail": detail }),
        Item::Result { duration_ms, cost_usd, at, .. } => {
            let secs = duration_ms / 1000;
            let took = if secs >= 60 { format!("{}m {}s", secs / 60, secs % 60) } else { format!("{secs}s") };
            let cost = if *cost_usd > 0.0 { format!(" · ${cost_usd:.2}") } else { String::new() };
            json!({ "kind": "notice", "icon": "result", "text": format!("Done · {took}{cost}"), "detail": "", "at": at })
        }
        Item::Message { from, to, text } => json!({ "kind": "notice", "icon": "message", "text": format!("{from} → {to}"), "detail": text }),
    };
    v["seq"] = json!(seq);
    v["rev"] = json!(rev);
    v
}

fn hash_of(v: &impl Hash) -> u64 {
    let mut h = DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
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

// ================================================================== the UI thread's side

impl App {
    /// A chat changed (items or turn): long-polls wake.
    pub fn api_touch(&self, chat: i64) {
        if self.api.hub.enabled.load(Ordering::Relaxed) {
            self.api.hub.touch(Some(chat), false);
        }
    }

    /// Once per frame: what `/v1/state` would say, per chat and for the rest; changes wake.
    pub fn api_tick(&mut self) {
        if !self.api.hub.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut seen = HashMap::with_capacity(self.chats.len());
        let mut changed = vec![];
        for c in &self.chats {
            let h = hash_of(&(&c.title, c.settled, c.updated, &c.account, &c.model, &c.effort, &c.access, &c.device, c.repo_id, self.turns.contains_key(&c.id), self.queued_count(c.id)));
            if self.api.chats.get(&c.id) != Some(&h) {
                changed.push(c.id);
            }
            seen.insert(c.id, h);
        }
        let gone = self.api.chats.keys().any(|k| !seen.contains_key(k));
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

    fn queued_count(&self, id: i64) -> usize {
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
            self.api_tick();
            self.api.hub.touch(None, true);
        }
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
        let r = self.api_route(&call, ctx);
        let _ = call.reply.send(r);
    }

    fn api_route(&mut self, call: &Call, ctx: &egui::Context) -> Reply {
        let p: Vec<&str> = call.path.iter().map(String::as_str).collect();
        let id = |s: &str| s.parse::<i64>().ok();
        match (call.method.as_str(), p.as_slice()) {
            ("GET", ["v1", "state"]) => ok(self.api_state(ctx)),
            ("GET", ["v1", "chats", c, "items"]) => match id(c).filter(|c| self.chat(*c).is_some()) {
                Some(c) => ok(self.api_items(c, call.query("since").and_then(|s| s.parse().ok()).unwrap_or(0))),
                None => err(404, "no such chat"),
            },
            ("POST", ["v1", "chats"]) => self.api_create(&call.body, ctx),
            ("POST", ["v1", "chats", c, action]) => {
                let Some(c) = id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                match *action {
                    "send" => self.api_send(c, &call.body, ctx),
                    "stop" => {
                        // What waited behind the turn goes back to the phone, not to the desktop's composer.
                        let returned: Vec<Value> = self.take_queue(c).into_iter().map(|q| json!({ "text": q.text, "files": q.files.iter().filter_map(|f| upload_id(f)).collect::<Vec<_>>() })).collect();
                        self.stop(c);
                        ok(json!({ "ok": true, "returned": returned }))
                    }
                    "fork" => self.api_fork(c, &call.body),
                    _ => err(404, "unknown action"),
                }
            }
            ("PATCH", ["v1", "chats", c]) => {
                let Some(c) = id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                if let Some(t) = call.body["title"].as_str() {
                    let t = t.trim();
                    if t.is_empty() {
                        return err(400, "empty title");
                    }
                    if let Some(ch) = self.chat_mut(c) {
                        ch.title = t.chars().take(200).collect();
                    }
                    self.persist(c);
                }
                if let Some(s) = call.body["settled"].as_bool() {
                    self.set_chat_settled(c, s);
                }
                ok(json!({ "ok": true }))
            }
            ("DELETE", ["v1", "chats", c]) => {
                let Some(c) = id(c).filter(|c| self.chat(*c).is_some()) else { return err(404, "no such chat") };
                self.stop(c);
                self.store.delete_chat(c);
                self.chats.retain(|x| x.id != c);
                self.transcripts.remove(&c);
                self.api.items.remove(&c);
                if self.view == crate::app::View::Chat(c) {
                    self.view = crate::app::View::Draft;
                }
                ok(json!({ "ok": true }))
            }
            (_, ["v1", ..]) => err(404, "unknown call"),
            _ => err(404, "not found"),
        }
    }

    pub fn api_state(&self, ctx: &egui::Context) -> Value {
        let projects: Vec<Value> = self.repos.iter().map(|r| json!({ "id": r.id, "name": r.name, "path": r.path.to_string_lossy() })).collect();
        let hub = &self.api.hub;
        let chats: Vec<Value> = self
            .chats
            .iter()
            .map(|c| {
                json!({
                    "id": c.id, "project_id": c.repo_id, "title": c.title, "device": c.device, "account": c.account,
                    "model": c.model, "effort": c.effort, "access": c.access, "fast": self.fast, "settled": c.settled,
                    "running": self.turns.contains_key(&c.id), "queued": self.queued_count(c.id),
                    "updated_ms": c.updated * 1000, "rev": hub.chat_rev(c.id),
                    "role": match c.role { store::Role::Lead => "lead", store::Role::Sub => "sub", store::Role::Chat => "chat" },
                    "parent": c.parent,
                })
            })
            .collect();
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
        let mut devices = vec![json!({ "id": "", "label": crate::remote::hostname(), "icon": "monitor", "online": true })];
        let net = crate::remote::tailnet(ctx);
        for (h, online) in crate::remote::devices(&self.remote, &net) {
            if !h.hidden {
                devices.push(json!({ "id": h.id, "label": h.label(), "icon": icon_name(&h), "online": online }));
            }
        }
        let s = &self.draft.sel;
        json!({
            "version": crate::update::VERSION,
            "hub_name": crate::remote::hostname(),
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

    /// The items of a chat changed after `since`, finding what changed by hashing each one.
    pub fn api_items(&mut self, chat: i64, since: u64) -> Value {
        if !self.transcripts.contains_key(&chat) {
            let items = self.store.items(chat);
            self.transcripts.insert(chat, crate::app::Transcript { items, ..Default::default() });
        }
        let items = &self.transcripts[&chat].items;
        let hashes: Vec<u64> = items.iter().map(|it| hash_of(&serde_json::to_string(it).unwrap_or_default())).collect();
        let revs = self.api.items.entry(chat).or_default();
        revs.truncate(hashes.len());
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
        let out: Vec<Value> = items.iter().enumerate().filter(|(i, _)| revs[*i].1 > since).map(|(i, it)| item_json(i, revs[i].1, it)).collect();
        json!({
            "rev": self.api.hub.rev(),
            "count": items.len(),
            "running": self.turns.contains_key(&chat),
            "queued": self.queued_count(chat),
            "items": out,
        })
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
        self.send_to(chat, text, files, vec![], ctx);
        ok(json!({ "ok": true, "queued": busy }))
    }

    fn api_create(&mut self, body: &Value, ctx: &egui::Context) -> Reply {
        let repo = match &body["project_id"] {
            Value::Null => None,
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
        ok(json!({ "id": id }))
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
            Some(id) => ok(json!({ "id": id })),
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
    fn decodes_urls() {
        assert_eq!(url_decode("a%2Fb+c%zz%4"), "a/b c%zz%4");
        assert_eq!(url_decode("%E2%9C%93"), "✓");
        assert_eq!(url_encode("a b/é"), "a%20b%2F%C3%A9");
        // Paths keep '+'.
        assert_eq!(head("GET /a+b%20c HTTP/1.1\r\n\r\n").unwrap().path, "/a+b c");
    }

    #[test]
    fn auth() {
        let hub = Hub::new(vec![Token { token: "s3cret".into(), name: String::new(), created: 0 }], DEFAULT_PORT);
        assert!(hub.known("s3cret"));
        assert!(!hub.known("s3cre"));
        assert!(!hub.known("s3cretx"));
        assert!(!hub.known(""));
        let r = head("GET / HTTP/1.1\r\nauthorization: bearer  s3cret \r\n\r\n").unwrap();
        assert_eq!(r.bearer(), Some("s3cret"));
        assert_eq!(head("GET / HTTP/1.1\r\nAuthorization: Basic s3cret\r\n\r\n").unwrap().bearer(), None);
        assert_eq!(head("GET / HTTP/1.1\r\nAuthorization: Bearer\r\n\r\n").unwrap().bearer(), None);
        let empty = Hub::new(vec![Token { token: String::new(), name: String::new(), created: 0 }], DEFAULT_PORT);
        assert!(!empty.known(""));
        assert_eq!(new_token().unwrap().len(), 48);
        assert_ne!(new_token().unwrap(), new_token().unwrap());
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
        let hub = Arc::new(Hub::new(vec![Token { token: "tok".into(), name: String::new(), created: 0 }], 0));
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
        let r = upload(&mut cur, &req, &base);
        assert_eq!(r.status, 201, "{:?}", r.body);
        let id = r.body["id"].as_str().unwrap();
        assert!(id.starts_with("12/") && id.ends_with("-photo.jpg"), "{id}");
        assert_eq!(std::fs::read(base.join(id)).unwrap(), b"abcd");
        // A body shorter than its length leaves nothing behind.
        let mut cur = std::io::Cursor::new(format!("{raw}ab").into_bytes());
        let req = read_head(&mut cur).unwrap();
        assert_eq!(upload(&mut cur, &req, &base).status, 400);
        assert_eq!(std::fs::read_dir(base.join("12")).unwrap().count(), 1);
        let mut cur = std::io::Cursor::new(b"POST /v1/upload?chat=x HTTP/1.1\r\nContent-Length: 0\r\n\r\n".to_vec());
        let req = read_head(&mut cur).unwrap();
        assert_eq!(upload(&mut cur, &req, &base).status, 400);
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
        let v = item_json(3, 9, &Item::User { text: "hi".into(), files: vec!["/a/b/photo.jpg".into()], at: 5, mentions: vec![] });
        assert_eq!(v["kind"], "user");
        assert_eq!(v["files"], json!(["photo.jpg"]));
        assert_eq!((v["seq"].as_u64(), v["rev"].as_u64()), (Some(3), Some(9)));
        let v = item_json(0, 1, &Item::Tool { id: "t".into(), name: "Bash".into(), summary: "ls".into(), input: "x".repeat(CLIP * 2), result: None, is_error: false });
        assert_eq!(v["done"], false);
        assert!(v["input"].as_str().unwrap().len() < CLIP + 100);
        let v = item_json(0, 1, &Item::Text { text: "# H".into(), at: 0 });
        assert_eq!(v["markdown"], "# H");
        assert_eq!(v["blocks"][0]["type"], "heading");
        let v = item_json(0, 1, &Item::Result { cost_usd: 0.0, duration_ms: 75_000, turns: 1, input_tokens: 0, output_tokens: 0, at: 0, account: String::new(), model: String::new() });
        assert_eq!((v["kind"].as_str(), v["text"].as_str()), (Some("notice"), Some("Done · 1m 15s")));
    }
}
