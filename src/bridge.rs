//! The bridge: this PC's MCP servers for an agent that runs on another device.
//!
//! A small HTTP server on 127.0.0.1 speaks MCP's streamable HTTP transport. Every
//! remote turn gets a grant (a random token in the URL path) naming the servers it may
//! use; `ssh -R` makes the port reachable on the device's own 127.0.0.1, and the remote
//! Claude Code's `--mcp-config` lists `http` servers pointing there:
//! - stdio servers run here, one process per turn and server; each request goes to it
//!   as a line on stdin and its answer comes back as the HTTP response (notifications the
//!   server sends about the request, like a `subscriptions/listen` stream, as events before
//!   it). A request waits a bounded time and only while its agent is connected: a server
//!   that never answers must not keep the connection, and with it the device's ssh, open;
//! - http servers are forwarded with curl and get their auth headers here, so tokens
//!   never leave this PC;
//! - `origin` is the bridge's own server: this PC's custom slash commands and skills as
//!   MCP prompts, `run_command` on this PC when the device is allowed it, and the
//!   project's shell and files here when the agent works on this PC's files
//!   (workspace.rs).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// First port tried; a stable one lets turns that outlive a reload find it again.
/// Not the phone API's (47930, api.rs): that one has no other port to go to.
const PORT: u16 = 47940;
/// The bridge's own server, as the remote agent sees it.
pub const ORIGIN: &str = "origin";
/// `run_command` output beyond this keeps only its end.
const OUTPUT_MAX: usize = 40_000;

/// What one remote turn may reach. Saved in the turn's folder (0600: it holds the
/// servers' tokens) so a Harbor that picks the turn up after a reload serves it again.
#[derive(Clone, Serialize, Deserialize)]
pub struct Grant {
    pub token: String,
    pub chat_id: i64,
    /// The project here: stdio servers and commands run in it.
    pub cwd: PathBuf,
    pub servers: Map<String, Value>,
    pub commands: bool,
    /// workspace.rs tools offered (empty: the agent works on the device's files).
    #[serde(default)]
    pub workspace: Vec<String>,
    /// The `machines` server (machines.rs: every PC's files), while the mesh has other PCs.
    /// Local turns get a grant just for it.
    #[serde(default)]
    pub machines: Option<crate::machines::Grant>,
}

/// How long a stdio server has to answer a request ([`TOOL_WAIT`] for a tool call); each
/// notification it sends about the request (progress) starts the wait again.
const WAIT: Duration = Duration::from_secs(if cfg!(test) { 2 } else { 60 });
const TOOL_WAIT: Duration = Duration::from_secs(if cfg!(test) { 4 } else { 3600 });
/// How often a request waiting for its answer looks whether its agent is still there.
const TICK: Duration = Duration::from_millis(100);
/// The `_meta` key a server stamps its `subscriptions/listen` notifications with: the id of
/// the listen request.
const SUBSCRIPTION: &str = "io.modelcontextprotocol/subscriptionId";

/// A stdio server's process, the `initialize` it got (replayed if it restarts), and the
/// last id the bridge gave a request on its way there.
#[derive(Default)]
struct Slot {
    proc: Option<Proc>,
    init: Option<Value>,
    next: u64,
}

/// A running stdio server. Requests reach it with ids of the bridge's own (agents reuse
/// theirs after a reconnect), written by a thread of its own; a reader thread hands each
/// answer, and the notifications about a request, to the connection waiting for it. So a
/// request that is never answered holds up nothing but its own connection.
struct Proc {
    child: Child,
    input: Sender<String>,
    waits: Arc<Mutex<Waits>>,
}

#[derive(Default)]
struct Waits {
    by_id: HashMap<u64, Wait>,
    /// When the server last wrote a line.
    heard: Option<Instant>,
}

/// A request waiting for its answer, with the agent's own id and progress token for it.
struct Wait {
    tx: Sender<Value>,
    id: Value,
    progress: Value,
    tool: bool,
}

struct Live {
    grant: Grant,
    slots: HashMap<String, Arc<Mutex<Slot>>>,
}

static GRANTS: LazyLock<Mutex<HashMap<String, Live>>> = LazyLock::new(Default::default);

/// Requests served at once (an agent's servers each hold one while they answer).
static CONNS: crate::api::Conns = crate::api::Conns::new(128);
/// The largest request body (a JSON-RPC message).
const MAX_BODY: usize = 32 << 20;

/// The bridge's port, started on first use.
pub fn port() -> Option<u16> {
    static P: OnceLock<Option<u16>> = OnceLock::new();
    *P.get_or_init(|| (PORT..PORT + 10).find_map(listen))
}

/// Serves the bridge on 127.0.0.1:`port` (0: any free port); the port bound.
fn listen(port: u16) -> Option<u16> {
    let listener = TcpListener::bind(("127.0.0.1", port)).ok()?;
    let port = listener.local_addr().ok()?.port();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let Some(slot) = CONNS.take() else { continue };
            std::thread::spawn(move || {
                handle(s);
                drop(slot);
            });
        }
    });
    Some(port)
}

/// The bridge port a turn's ssh forwards to (its `-R …:127.0.0.1:<port>` in cmd.json).
fn forwarded_port(dir: &Path) -> Option<u16> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("cmd.json")).ok()?).ok()?;
    let args: Vec<&str> = v["args"].as_array()?.iter().filter_map(|a| a.as_str()).collect();
    let i = args.iter().position(|a| *a == "-R")?;
    args.get(i + 1)?.rsplit(':').next()?.parse().ok()
}

pub fn token() -> std::io::Result<String> {
    crate::store::random_hex(18)
}

/// Serves `g` from now on; returns the bridge's port.
pub fn grant(g: Grant) -> Option<u16> {
    let port = port()?;
    GRANTS.lock().unwrap().entry(g.token.clone()).or_insert(Live { grant: g, slots: HashMap::new() });
    Some(port)
}

/// Stops serving a token and ends its servers.
pub fn revoke(token: &str) {
    let Some(live) = GRANTS.lock().unwrap().remove(token) else { return };
    // A slot is only held to start its server and send to it, so this doesn't wait on
    // requests still pending (they hear that their server is gone).
    for slot in live.slots.values() {
        slot.lock().unwrap().stop();
    }
}

pub fn save(dir: &Path, g: &Grant) {
    let _ = crate::mcp::write_private(&dir.join("bridge.json"), &serde_json::to_string(g).unwrap_or_default());
}

fn saved(dir: &Path) -> Option<Grant> {
    serde_json::from_str(&std::fs::read_to_string(dir.join("bridge.json")).ok()?).ok()
}

/// A turn followed again (after a reload): its grant is served again, also on the port its
/// ssh forwards to when that isn't this run's (a turn started by an older build). When that
/// port is someone else's now (another local user took it while Harbor was away), the grant is
/// not served at all: whoever holds the port has seen its token.
pub fn resume(dir: &Path) {
    if let Some(g) = saved(dir) {
        let token = g.token.clone();
        let here = grant(g);
        static EXTRA: LazyLock<Mutex<Vec<u16>>> = LazyLock::new(Default::default);
        if let Some(p) = forwarded_port(dir).filter(|p| Some(*p) != here) {
            let mut extra = EXTRA.lock().unwrap();
            if !extra.contains(&p) {
                if listen(p).is_some() {
                    extra.push(p);
                } else {
                    eprintln!("harbor: a remote turn's bridge port 127.0.0.1:{p} is taken by another process; its MCP servers are cut off");
                    revoke(&token);
                }
            }
        }
    }
}

/// The turn in `dir` ended.
pub fn end(dir: &Path) {
    if let Some(g) = saved(dir) {
        revoke(&g.token);
    }
}

/// The `--mcp-config` for the remote agent: every granted server, plus `origin`, as
/// http servers at the forwarded port.
pub fn remote_config(g: &Grant, remote_port: u16) -> Value {
    let mut m = Map::new();
    let machines = g.machines.as_ref().map(|_| crate::machines::NAME);
    for name in g.servers.keys().map(String::as_str).chain([ORIGIN]).chain(machines) {
        m.insert(name.into(), json!({ "type": "http", "url": format!("http://127.0.0.1:{remote_port}/{}/{}", g.token, enc(name)) }));
    }
    json!({ "mcpServers": m })
}

// ---------------------------------------------------------------- http

/// A server name as one URL path segment ("Roblox Studio" → "Roblox%20Studio").
fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}


struct Req {
    method: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Req {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
}

/// The request's head, bounded in size and time; the body is read once its token is known.
fn read_head(r: &mut BufReader<crate::api::Timed>) -> Result<crate::api::Request, u16> {
    let head = crate::api::read_head_chunked(r).map_err(|(code, _)| code)?;
    r.get_mut().until = None;
    Ok(head)
}

fn read_body(r: &mut impl BufRead, head: &crate::api::Request) -> Result<Vec<u8>, u16> {
    if head.chunked { crate::api::read_chunked(r, MAX_BODY) } else { crate::api::read_body(r, head.len, MAX_BODY) }
}

fn respond(mut s: &TcpStream, code: u16, ctype: &str, body: &[u8]) {
    let reason = match code {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    let head = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nAllow: POST, DELETE\r\nConnection: close\r\n\r\n", body.len());
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
}

fn handle(s: TcpStream) {
    let mut r = BufReader::new(crate::api::Timed::new(&s, crate::api::HEAD_WAIT, Duration::from_secs(30)));
    let head = match read_head(&mut r) {
        Ok(h) => h,
        Err(code) => return respond(&s, code, "text/plain", b"bad request"),
    };
    // The path comes decoded: "<token>/<server name>".
    let path = head.path.trim_matches('/').to_string();
    let (token, server) = path.split_once('/').unwrap_or((&path, ""));
    let found = {
        let mut grants = GRANTS.lock().unwrap();
        grants.get_mut(token).and_then(|live| {
            let def = live.grant.servers.get(server).cloned();
            let mine = server == ORIGIN || server == crate::machines::NAME && live.grant.machines.is_some();
            (mine || def.is_some()).then(|| (live.grant.clone(), def, live.slots.entry(server.to_string()).or_default().clone()))
        })
    };
    let Some((grant, def, slot)) = found else {
        return respond(&s, 404, "text/plain", b"not found");
    };
    let body = match read_body(&mut r, &head) {
        Ok(b) => b,
        Err(code) => return respond(&s, code, "text/plain", b"bad body"),
    };
    let req = Req { method: head.method, headers: head.headers, body };
    let kind = def.as_ref().map(|d| d["type"].as_str().unwrap_or(if d.get("url").is_some() { "http" } else { "stdio" }).to_string());
    if kind.as_deref() == Some("http") {
        return forward(&s, &req, def.as_ref().unwrap());
    }
    match req.method.as_str() {
        "POST" => {}
        // Sessions here are the turn's: nothing to end early.
        "DELETE" => return respond(&s, 200, "text/plain", b""),
        // No server-initiated stream (allowed by the transport).
        _ => return respond(&s, 405, "text/plain", b""),
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&req.body) else {
        return respond(&s, 400, "application/json", json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }).to_string().as_bytes());
    };
    let one = |m: &Value, agent: &mut Agent| -> Option<Value> {
        match &def {
            None if server == crate::machines::NAME => crate::machines::mcp(grant.machines.as_ref()?, &grant.cwd, grant.chat_id, m),
            None => origin(&grant, m),
            Some(d) if kind.as_deref() == Some("stdio") => stdio(&grant, d, &slot, m, agent),
            Some(_) => m.get("id").map(|id| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "Harbor's bridge only carries stdio and http servers" } })),
        }
    };
    // Events only for a single request (a batch's answers come together).
    let sse = !msg.is_array() && req.header("accept").is_some_and(|a| a.contains("text/event-stream"));
    let mut agent = Agent { s: &s, sse, streaming: false, left: false };
    let out = match &msg {
        Value::Array(batch) => {
            let all: Vec<Value> = batch.iter().filter_map(|m| one(m, &mut agent)).collect();
            (!all.is_empty()).then_some(Value::Array(all))
        }
        m => one(m, &mut agent),
    };
    // Gone: nobody to answer, the connection just closes.
    if agent.left {
        return;
    }
    match out {
        Some(v) if agent.streaming => agent.event(&v),
        Some(v) => respond(&s, 200, "application/json", v.to_string().as_bytes()),
        None => respond(&s, 202, "application/json", b""),
    }
}

/// The connection a request came on, while the request waits for its answer.
struct Agent<'a> {
    s: &'a TcpStream,
    /// It takes an event stream as the answer.
    sse: bool,
    /// The stream's head went out: the answer follows as its last event.
    streaming: bool,
    /// The agent hung up.
    left: bool,
}

impl Agent<'_> {
    fn gone(&mut self) -> bool {
        self.left = self.left || hung_up(self.s);
        self.left
    }

    /// A message to the agent ahead of the answer, when it takes a stream.
    fn event(&mut self, v: &Value) {
        if !self.sse {
            return;
        }
        let mut w = self.s;
        if !self.streaming {
            self.streaming = true;
            let _ = w.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n");
        }
        let _ = w.write_all(format!("event: message\ndata: {v}\n\n").as_bytes());
    }
}

/// Whether the other end closed `s` (or broke it). A client that gives up closes its
/// connection, and ssh passes that on as the end of its input: the answer has nobody to go to.
#[allow(unsafe_code)] // poll(2)
fn hung_up(s: &TcpStream) -> bool {
    use std::os::fd::AsRawFd;
    let mut p = libc::pollfd { fd: s.as_raw_fd(), events: libc::POLLIN | libc::POLLRDHUP, revents: 0 };
    // SAFETY: one valid pollfd for the duration of the call; no wait.
    if unsafe { libc::poll(&mut p, 1, 0) } <= 0 {
        return false;
    }
    if p.revents & (libc::POLLRDHUP | libc::POLLHUP | libc::POLLERR) != 0 {
        return true;
    }
    // Readable: more bytes (it's there), or the end.
    let mut b = [0u8; 1];
    matches!(s.peek(&mut b), Ok(0) | Err(_))
}

// ---------------------------------------------------------------- stdio servers

fn spawn(g: &Grant, def: &Value) -> Option<Proc> {
    let mut cmd = Command::new(def["command"].as_str()?);
    cmd.args(def["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str()));
    // The same environment a local agent's servers get: credentials from Harbor's store.
    cmd.env("PATH", crate::providers::child_path());
    for (k, v) in crate::mcp::agent_env() {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    for (k, v) in def["env"].as_object().into_iter().flatten() {
        if let Some(v) = v.as_str() {
            cmd.env(k, v);
        }
    }
    if g.cwd.is_dir() {
        cmd.current_dir(&g.cwd);
    }
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let (Some(mut stdin), Some(out)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    // Written from a thread: a server that stops reading blocks only that thread.
    let (input, lines) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for l in lines {
            if stdin.write_all(l.as_bytes()).is_err() {
                break;
            }
        }
    });
    let waits = Arc::new(Mutex::new(Waits::default()));
    let (w, answers, cwd) = (waits.clone(), input.clone(), g.cwd.clone());
    std::thread::spawn(move || read_answers(out, &answers, &w, &cwd));
    Some(Proc { child, input, waits })
}

/// Reads a stdio server's output until it ends: answers go to the requests waiting for
/// them, notifications about a request (its progress, its subscription) to that request,
/// and the server's own requests (roots, ping) are answered here.
fn read_answers(out: ChildStdout, input: &Sender<String>, waits: &Mutex<Waits>, cwd: &Path) {
    for line in BufReader::new(out).lines() {
        let Ok(line) = line else { break };
        let mut w = waits.lock().unwrap();
        w.heard = Some(Instant::now());
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        match (v.get("method").and_then(|m| m.as_str()), v.get("id")) {
            (Some(m), Some(rid)) => {
                let answer = match m {
                    "roots/list" => json!({ "jsonrpc": "2.0", "id": rid, "result": { "roots": [{ "uri": format!("file://{}", cwd.display()), "name": "project" }] } }),
                    "ping" => json!({ "jsonrpc": "2.0", "id": rid, "result": {} }),
                    _ => json!({ "jsonrpc": "2.0", "id": rid, "error": { "code": -32601, "message": "not supported over Harbor's bridge" } }),
                };
                let _ = input.send(format!("{answer}\n"));
            }
            (Some(_), None) => {
                let p = &v["params"];
                let to = p["_meta"][SUBSCRIPTION].as_u64().or_else(|| {
                    let token = &p["progressToken"];
                    if token.is_null() { None } else { w.by_id.iter().find(|(_, x)| x.progress == *token).map(|(k, _)| *k) }
                });
                if let Some(x) = to.and_then(|k| w.by_id.get(&k)) {
                    let _ = x.tx.send(v);
                }
            }
            (None, Some(rid)) => {
                if let Some(x) = rid.as_u64().and_then(|k| w.by_id.remove(&k)) {
                    let _ = x.tx.send(v);
                }
            }
            _ => {}
        }
    }
    // It ended: whoever still waits hears so.
    waits.lock().unwrap().by_id.clear();
}

/// Writes `msg` to the server; a request goes under the bridge's id `mine`, and its answer
/// comes on the receiver. Err when the server isn't there to take it.
fn send(p: &Proc, msg: &Value, mine: Option<u64>) -> Result<Option<Receiver<Value>>, ()> {
    let mut msg = msg.clone();
    let rx = mine.map(|k| {
        let (tx, rx) = std::sync::mpsc::channel();
        let wait = Wait { tx, id: msg["id"].clone(), progress: msg["params"]["_meta"]["progressToken"].clone(), tool: msg["method"] == "tools/call" };
        p.waits.lock().unwrap().by_id.insert(k, wait);
        msg["id"] = json!(k);
        rx
    });
    if p.input.send(format!("{msg}\n")).is_err() {
        if let Some(k) = mine {
            p.waits.lock().unwrap().by_id.remove(&k);
        }
        return Err(());
    }
    Ok(rx)
}

/// A new process in the slot. One that replaces a server that died mid-turn comes back
/// initialized, as the agent left it (its answer bounded like any request's).
fn restart(g: &Grant, def: &Value, s: &mut Slot, reinit: bool) {
    s.stop();
    s.proc = spawn(g, def);
    let (Some(init), Some(p)) = (s.init.clone().filter(|_| reinit), s.proc.as_ref()) else { return };
    s.next += 1;
    let answered = send(p, &init, Some(s.next)).ok().flatten().is_some_and(|rx| rx.recv_timeout(WAIT).is_ok_and(|v| v.get("result").is_some()));
    if !answered || send(p, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), None).is_err() {
        s.stop();
    }
}

impl Slot {
    /// Ends the server's process; its reader then tells whoever still waits.
    fn stop(&mut self) {
        if let Some(mut p) = self.proc.take() {
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }
}

/// One message for a stdio server, and its answer (None for a notification, or when the
/// agent hung up meanwhile). The slot is held only to start the server and send; then the
/// request waits on its own, for at most [`WAIT`] ([`TOOL_WAIT`]; a `subscriptions/listen`
/// without a limit) and only while its agent is connected. A request given up on is
/// cancelled at the server, and a server that said
/// nothing at all meanwhile (and runs no tool call) is taken for stuck and stopped: the
/// next request starts it again.
fn stdio(g: &Grant, def: &Value, slot: &Mutex<Slot>, msg: &Value, agent: &mut Agent) -> Option<Value> {
    let err = |id: &Value, why: &str| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": why } });
    let id = msg.get("id").cloned();
    let mut msg = msg.clone();
    let (rx, mine, pid, waits, input) = {
        let mut s = slot.lock().unwrap();
        if msg["method"] == "initialize" {
            s.init = Some(msg.clone());
        }
        let mut sent = None;
        for _ in 0..2 {
            if !s.proc.as_mut().is_some_and(|p| p.child.try_wait().ok().flatten().is_none()) {
                restart(g, def, &mut s, msg["method"] != "initialize");
            }
            s.next += 1;
            let mine = s.next;
            let Some(p) = s.proc.as_ref() else { break };
            if msg["method"] == "notifications/cancelled" {
                // The agent names its own id; the server knows the bridge's. Whoever waits
                // for that answer stops.
                let mut w = p.waits.lock().unwrap();
                let theirs = msg["params"]["requestId"].clone();
                if let Some(k) = w.by_id.iter().find(|(_, x)| x.id == theirs).map(|(k, _)| *k) {
                    msg["params"]["requestId"] = json!(k);
                    if let Some(x) = w.by_id.remove(&k) {
                        let _ = x.tx.send(err(&json!(k), "cancelled"));
                    }
                }
            }
            match send(p, &msg, id.as_ref().map(|_| mine)) {
                Ok(rx) => {
                    sent = Some((rx, mine, p.child.id(), p.waits.clone(), p.input.clone()));
                    break;
                }
                // It was gone already: once more with a new one.
                Err(()) => s.stop(),
            }
        }
        match sent {
            Some(x) => x,
            None => return id.map(|id| err(&id, "the MCP server on the Harbor PC didn't start or exited")),
        }
    };
    let (Some(id), Some(rx)) = (id, rx) else { return None };
    let at = Instant::now();
    // A listen is answered only by its events, for as long as the agent wants them.
    let listen = msg["method"] == "subscriptions/listen";
    let limit = if msg["method"] == "tools/call" { TOOL_WAIT } else { WAIT };
    let mut until = at + limit;
    // Not to wait for anymore: the server drops it too.
    let forget = || {
        waits.lock().unwrap().by_id.remove(&mine);
        let _ = input.send(format!("{}\n", json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": mine, "reason": "the client is gone or it took too long" } })));
    };
    loop {
        match rx.recv_timeout(TICK) {
            // About this request (progress, a subscription's events): on to the agent, and
            // the wait starts again.
            Ok(mut v) if v.get("method").is_some() => {
                if v["params"]["_meta"].get(SUBSCRIPTION).is_some() {
                    v["params"]["_meta"][SUBSCRIPTION] = id.clone();
                }
                agent.event(&v);
                if agent.gone() {
                    forget();
                    return None;
                }
                until = Instant::now() + limit;
            }
            Ok(mut v) => {
                v["id"] = id;
                return Some(v);
            }
            Err(RecvTimeoutError::Disconnected) => return Some(err(&id, "the MCP server on the Harbor PC exited")),
            Err(RecvTimeoutError::Timeout) if agent.gone() => {
                forget();
                return None;
            }
            Err(RecvTimeoutError::Timeout) if !listen && Instant::now() >= until => {
                forget();
                let stuck = {
                    let w = waits.lock().unwrap();
                    w.heard.is_none_or(|h| h < at) && !w.by_id.values().any(|x| x.tool)
                };
                if stuck {
                    let mut s = slot.lock().unwrap();
                    if s.proc.as_ref().is_some_and(|p| p.child.id() == pid) {
                        s.stop();
                    }
                }
                return Some(err(&id, &format!("the MCP server on the Harbor PC didn't answer in {} s", limit.as_secs())));
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

// ---------------------------------------------------------------- http servers

/// Forwards the request to the server's URL with its headers (tokens) added here, and
/// streams the answer back (JSON or an event stream).
fn forward(s: &TcpStream, req: &Req, def: &Value) {
    let Some(url) = def["url"].as_str() else { return respond(s, 404, "text/plain", b"no url") };
    let mut lines: Vec<String> = def["headers"].as_object().into_iter().flatten().filter_map(|(k, v)| Some(format!("{k}: {}", v.as_str()?))).collect();
    for k in ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"] {
        if let Some(v) = req.header(k) {
            lines.push(format!("{k}: {v}"));
        }
    }
    // Headers through a private file, so tokens stay out of argv.
    let Ok(tag) = token() else { return respond(s, 502, "text/plain", b"bridge: no randomness for a file name") };
    let hfile = crate::mcp::dir().join(format!("bridge-{tag}.h"));
    if crate::mcp::write_private(&hfile, &(lines.join("\n") + "\n")).is_err() {
        return respond(s, 502, "text/plain", b"bridge: cannot write headers");
    }
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "-N", "-i", "-X", &req.method, "-H"]).arg(format!("@{}", hfile.display()));
    if !req.body.is_empty() {
        cmd.args(["--data-binary", "@-"]);
    }
    cmd.arg(url).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let Ok(mut c) = cmd.spawn() else {
        let _ = std::fs::remove_file(&hfile);
        return respond(s, 502, "text/plain", b"bridge: curl is missing");
    };
    if let Some(mut sin) = c.stdin.take() {
        let _ = sin.write_all(&req.body);
    }
    let mut out = BufReader::new(c.stdout.take().unwrap());
    // A stream that stays silent (an event stream with nothing to say) would only notice the
    // agent left on a write: curl stops as soon as it hangs up.
    let c = Arc::new(Mutex::new(c));
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Ok(peer) = s.try_clone() {
        let (c, done) = (c.clone(), done.clone());
        std::thread::spawn(move || {
            while !done.load(std::sync::atomic::Ordering::Relaxed) {
                if hung_up(&peer) {
                    let _ = c.lock().unwrap().kill();
                    break;
                }
                std::thread::sleep(TICK);
            }
        });
    }
    let stop = || {
        done.store(true, std::sync::atomic::Ordering::Relaxed);
        let mut c = c.lock().unwrap();
        let _ = c.kill();
        let _ = c.wait();
    };
    // Status and headers; skip interim responses (100 Continue).
    let (mut code, mut keep) = (0u16, vec![]);
    loop {
        let mut status = String::new();
        if out.read_line(&mut status).unwrap_or(0) == 0 {
            break;
        }
        code = status.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        keep.clear();
        loop {
            let mut l = String::new();
            if out.read_line(&mut l).unwrap_or(0) == 0 || l.trim().is_empty() {
                break;
            }
            if let Some((k, v)) = l.split_once(':') {
                let k = k.trim().to_ascii_lowercase();
                if matches!(k.as_str(), "content-type" | "mcp-session-id" | "www-authenticate") {
                    keep.push(format!("{k}: {}", v.trim()));
                }
            }
        }
        if !(100..200).contains(&code) {
            break;
        }
    }
    let _ = std::fs::remove_file(&hfile);
    if code == 0 {
        stop();
        return respond(s, 502, "text/plain", b"bridge: the server didn't answer");
    }
    let mut w = s;
    let head = format!("HTTP/1.1 {code} X\r\n{}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n", keep.join("\r\n"));
    let _ = w.write_all(head.as_bytes());
    // Copied as it comes, so an event stream reaches the agent as it is written.
    let mut buf = [0u8; 8192];
    while let Ok(n) = out.read(&mut buf) {
        if n == 0 || w.write_all(&buf[..n]).and_then(|_| w.flush()).is_err() {
            break;
        }
    }
    stop();
}

// ---------------------------------------------------------------- origin

fn origin(g: &Grant, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let p = &msg["params"];
    let result = match msg["method"].as_str().unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": p["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {}, "prompts": {} },
            "serverInfo": { "name": ORIGIN, "version": env!("CARGO_PKG_VERSION") },
            "instructions": format!(
                "You run on a remote device. '{}' is the PC running Harbor (the user is usually there; a message from a phone or another PC says so). Its prompts are the user's own slash commands and skills{}.",
                crate::remote::hostname(),
                if !g.workspace.is_empty() {
                    "; your workspace is there: its tools (bash, read, write, edit, glob, grep) work on the project there"
                } else if g.commands {
                    "; run_command runs a shell command there (not on the machine you run on)"
                } else {
                    ""
                }
            ),
        }),
        "tools/list" => {
            let mut tools = crate::workspace::tools(&g.workspace);
            if run_command_on(g) {
                tools.push(run_command_tool());
            }
            json!({ "tools": tools })
        }
        "tools/call" if run_command_on(g) && p["name"] == "run_command" => {
            let (ok, text) = run_command(g, &p["arguments"]);
            json!({ "content": [{ "type": "text", "text": text }], "isError": !ok })
        }
        "tools/call" if g.workspace.iter().any(|t| p["name"] == t.as_str()) => {
            let (ok, content) = crate::workspace::call(&g.cwd, g.chat_id, p["name"].as_str().unwrap_or(""), &p["arguments"]);
            json!({ "content": content, "isError": !ok })
        }
        "tools/call" => json!({ "content": [{ "type": "text", "text": "No such tool here (this device isn't allowed it on the Harbor PC)." }], "isError": true }),
        "prompts/list" => json!({ "prompts": prompts().iter().map(|c| json!({
            "name": c.name, "description": c.description,
            "arguments": [{ "name": "arguments", "description": "What to pass to it ($ARGUMENTS)", "required": false }],
        })).collect::<Vec<_>>() }),
        "prompts/get" => {
            let name = p["name"].as_str().unwrap_or("");
            let Some(c) = prompts().into_iter().find(|c| c.name == name) else {
                return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": format!("no prompt {name}") } }));
            };
            let text = crate::slash::with_args(&c.body, p["arguments"]["arguments"].as_str().unwrap_or(""));
            json!({ "description": c.description, "messages": [{ "role": "user", "content": { "type": "text", "text": text } }] })
        }
        "ping" => json!({}),
        _ => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } })),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// `run_command`, unless the workspace's bash does the same.
fn run_command_on(g: &Grant) -> bool {
    g.commands && !g.workspace.iter().any(|t| t == "bash")
}

fn run_command_tool() -> Value {
    json!({
        "name": "run_command",
        "description": format!("Run a shell command on {}, the PC running Harbor (not the machine you run on): its files, tools and sign-ins. Returns the output and exit code.", crate::remote::hostname()),
        "inputSchema": { "type": "object", "properties": {
            "command": { "type": "string", "description": "Shell command (bash)" },
            "cwd": { "type": "string", "description": "Folder there; relative paths are from the project (default: the project)" },
            "timeout": { "type": "integer", "description": "Seconds before it is stopped (default 120, at most 600)" },
        }, "required": ["command"] },
    })
}

fn run_command(g: &Grant, a: &Value) -> (bool, String) {
    let Some(command) = a["command"].as_str().filter(|c| !c.trim().is_empty()) else { return (false, "command is required".into()) };
    let cwd = crate::workspace::resolve(&g.cwd, a["cwd"].as_str().unwrap_or(""));
    let secs = a["timeout"].as_u64().unwrap_or(120).clamp(1, 600);
    let (status, text) = shell(&format!("exec 2>&1\n{command}"), &cwd, Duration::from_secs(secs));
    match status {
        Ok(code) => (code == 0, format!("{text}\n[exit {code}]")),
        Err(e) if e.is_empty() => (false, format!("{text}\n[stopped after {secs} s]")),
        Err(e) => (false, e),
    }
}

/// Runs `script` in a login bash in `cwd`, with an agent's environment, for at most
/// `limit`: its exit code and output (the end, past [`OUTPUT_MAX`]); Err("") when it
/// was stopped, Err(why) when it didn't start. Background processes it leaves holding
/// the output are stopped with it (they'd keep the call from ever returning).
pub fn shell(script: &str, cwd: &Path, limit: Duration) -> (Result<i32, String>, String) {
    let mut cmd = shell_command(script, cwd);
    let mut child = match cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
        Ok(c) => c,
        Err(e) => return (Err(format!("cannot run it in {}: {e}", cwd.display())), String::new()),
    };
    let mut out = child.stdout.take().unwrap();
    // Only the end is kept, however much it prints.
    let kept = Arc::new(Mutex::new(Tail::default()));
    let (done_tx, done) = std::sync::mpsc::channel();
    let k = kept.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = out.read(&mut buf) {
            if n == 0 {
                break;
            }
            k.lock().unwrap().push(&buf[..n]);
        }
        let _ = done_tx.send(());
    });
    let pid = child.id();
    let group = || {
        let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
    };
    let t = Instant::now();
    let status = loop {
        if let Ok(Some(st)) = child.try_wait() {
            break Ok(st.code().unwrap_or(-1));
        }
        if t.elapsed() > limit {
            group();
            let _ = child.wait();
            break Err(String::new());
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    // The output ends when everything holding it is gone: a moment for that, then the group goes.
    let mut note = "";
    if done.recv_timeout(Duration::from_millis(500)).is_err() {
        group();
        note = "\n[stopped the background processes still holding the output; redirect the output of ones that should keep running]";
        let _ = done.recv_timeout(Duration::from_secs(2));
    }
    let text = kept.lock().unwrap().text(OUTPUT_MAX);
    (status, text + note)
}

/// The last bytes of an output and how many were dropped before them.
#[derive(Default)]
struct Tail {
    bytes: Vec<u8>,
    cut: usize,
}

impl Tail {
    fn push(&mut self, b: &[u8]) {
        self.bytes.extend_from_slice(b);
        // Trimmed now and then, not on every read.
        if self.bytes.len() > 2 * OUTPUT_MAX {
            let drop = self.bytes.len() - OUTPUT_MAX;
            self.bytes.drain(..drop);
            self.cut += drop;
        }
    }

    fn text(&self, max: usize) -> String {
        let start = self.bytes.len().saturating_sub(max);
        // Not from the middle of a character.
        let start = (start..self.bytes.len()).find(|i| self.bytes[*i] & 0xC0 != 0x80).unwrap_or(self.bytes.len());
        let cut = self.cut + start;
        let text = String::from_utf8_lossy(&self.bytes[start..]).into_owned();
        if cut == 0 { text } else { format!("[… {cut} bytes cut]\n{text}") }
    }
}

/// `bash -lc script` in `cwd` in its own process group (stopped as a whole).
pub fn shell_command(script: &str, cwd: &Path) -> Command {
    let mut cmd = Command::new("bash");
    cmd.arg("-lc").arg(script).current_dir(cwd).env("PATH", crate::providers::child_path());
    for (k, v) in crate::mcp::agent_env() {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

/// A user command or skill offered as an MCP prompt.
struct Prompt {
    name: String,
    description: String,
    body: String,
}

/// ~/.claude/commands (as `name`, folders joined with `_`) and ~/.claude/skills (as
/// `skill_<folder>`). Skills' other files stay here; the prompt says where.
fn prompts() -> Vec<Prompt> {
    let ident = |s: &str| -> String { s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect() };
    crate::slash::scan(&crate::store::home().join(".claude"))
        .into_iter()
        .map(|l| match &l.skill {
            None => Prompt { name: ident(&l.name), description: l.description, body: l.body },
            Some(d) => Prompt {
                name: format!("skill_{}", d.file_name().unwrap_or_default().to_string_lossy()),
                description: l.description,
                body: format!("Follow this skill. Its other files are on the Harbor PC in {} (the origin read tool, or run_command, reads them when this device has it).\n\n{}", d.display(), l.body),
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(port: u16, path: &str, body: &str) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let code = out.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        (code, out.split_once("\r\n\r\n").map(|x| x.1.to_string()).unwrap_or_default())
    }

    #[test]
    fn resume_drops_a_grant_whose_forward_port_is_taken() {
        // Someone else holds the port the turn's ssh forwards to: its token isn't served.
        let squat = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = squat.local_addr().unwrap().port();
        let dir = std::env::temp_dir().join(format!("harbor-bridge-resume-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fwd = format!("127.0.0.1:20001:127.0.0.1:{p}");
        std::fs::write(dir.join("cmd.json"), json!({ "args": ["ssh", "-R", fwd, "host"] }).to_string()).unwrap();
        let g = Grant { token: token().unwrap(), chat_id: 1, cwd: std::env::temp_dir(), servers: Map::new(), commands: true, workspace: vec![], machines: None };
        save(&dir, &g);
        resume(&dir);
        assert!(!GRANTS.lock().unwrap().contains_key(&g.token));
        // Free, it is served there again.
        drop(squat);
        resume(&dir);
        assert!(GRANTS.lock().unwrap().contains_key(&g.token));
        revoke(&g.token);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn serves_stdio_and_origin_and_refuses_unknown_tokens() {
        // A stdio "server" that answers every request line with its own id.
        let echo = r#"while read -r l; do id=$(printf '%s' "$l" | sed -n 's/.*"id":\([0-9]*\).*/\1/p'); [ -n "$id" ] && printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id"; done"#;
        let mut servers = Map::new();
        servers.insert("echo".into(), json!({ "type": "stdio", "command": "sh", "args": ["-c", echo] }));
        let g = Grant { token: token().unwrap(), chat_id: 1, cwd: std::env::temp_dir(), servers, commands: true, workspace: vec![], machines: None };
        let port = grant(g.clone()).unwrap();
        let (code, body) = post(port, &format!("/{}/echo", g.token), r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#);
        assert_eq!(code, 200);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["id"], 7);
        let (code, _) = post(port, &format!("/{}/echo", g.token), r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert_eq!(code, 202);
        let (_, body) = post(port, &format!("/{}/origin", g.token), r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"echo hi"}}}"#);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert!(v["result"]["content"][0]["text"].as_str().unwrap().starts_with("hi\n"));
        assert_eq!(post(port, "/nope/echo", "{}").0, 404);
        // Read only: no run_command (and no workspace tools that write or run).
        let ro = Grant { token: token().unwrap(), commands: false, workspace: crate::workspace::for_access("plan", false), ..g.clone() };
        grant(ro.clone());
        let (_, body) = post(port, &format!("/{}/origin", ro.token), r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        let names: Vec<String> = serde_json::from_str::<Value>(&body).unwrap()["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["read", "glob", "grep"]);
        let (_, body) = post(port, &format!("/{}/origin", ro.token), r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"echo hi"}}}"#);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"]["isError"], true);
        revoke(&ro.token);
        revoke(&g.token);
        assert_eq!(post(port, &format!("/{}/echo", g.token), "{}").0, 404);
        let cfg = remote_config(&g, 50000);
        assert_eq!(cfg["mcpServers"]["origin"]["url"], format!("http://127.0.0.1:50000/{}/origin", g.token));
        assert_eq!(crate::api::url_decode(&enc("Roblox Studio/x+y")), "Roblox Studio/x+y");
        assert_eq!(enc("Roblox Studio"), "Roblox%20Studio");
    }

    fn raw(port: u16, req: &[u8]) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _ = s.write_all(req);
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn bounds_requests() {
        let g = Grant { token: token().unwrap(), chat_id: 1, cwd: std::env::temp_dir(), servers: Map::new(), commands: false, workspace: vec![], machines: None };
        let port = grant(g.clone()).unwrap();
        // A chunk size alone allocates nothing: unknown token first, then too large.
        let huge = b"POST /nope/origin HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n100000000000\r\n";
        assert!(raw(port, huge).starts_with("HTTP/1.1 404"));
        let huge = format!("POST /{}/origin HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n100000000000\r\n", g.token);
        assert!(raw(port, huge.as_bytes()).starts_with("HTTP/1.1 413"));
        let big = format!("POST /{}/origin HTTP/1.1\r\nContent-Length: {}\r\n\r\n", g.token, 64 << 20);
        assert!(raw(port, big.as_bytes()).starts_with("HTTP/1.1 413"));
        let long = format!("POST /{}/origin HTTP/1.1\r\nX: {}\r\n\r\n", g.token, "a".repeat(9000));
        assert!(raw(port, long.as_bytes()).starts_with("HTTP/1.1 431"));
        // Chunked still works.
        let body = r#"{"jsonrpc":"2.0","id":4,"method":"ping"}"#;
        let ok = format!("POST /{}/origin HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", g.token, body.len());
        let out = raw(port, ok.as_bytes());
        assert!(out.starts_with("HTTP/1.1 200") && out.contains("\"id\":4"), "{out}");
        revoke(&g.token);
    }

    /// Sends a request and leaves the connection open (an agent waiting for its answer).
    fn ask(port: u16, path: &str, body: &str, accept: &str) -> TcpStream {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAccept: {accept}\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        s
    }

    /// What's left on the connection, until the bridge closes it (Err: it didn't in time).
    fn rest(mut s: TcpStream) -> std::io::Result<String> {
        let mut out = String::new();
        s.read_to_string(&mut out).map(|_| out)
    }

    /// Whether the bridge's end of the connection from local port `peer` sits in CLOSE_WAIT:
    /// the agent left and the bridge never closed (what kept a device's ssh open).
    fn close_wait(port: u16, peer: u16) -> bool {
        let want = format!("0100007F:{port:04X} 0100007F:{peer:04X} 08");
        std::fs::read_to_string("/proc/net/tcp").unwrap().lines().any(|l| l.split_whitespace().skip(1).take(3).collect::<Vec<_>>().join(" ") == want)
    }

    fn wait_for(what: &str, ok: impl Fn() -> bool) {
        let t = Instant::now();
        while !ok() {
            assert!(t.elapsed() < Duration::from_secs(5), "{what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn a_stdio_server_that_never_answers_holds_up_nothing() {
        let dir = std::env::temp_dir().join(format!("harbor-bridge-hang-{}", token().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let (log, pids) = (dir.join("log"), dir.join("pids"));
        // Answers everything but `hang`; a listen gets only its acknowledgement, as a server
        // of the 2026-07-28 protocol does.
        let script = format!(
            r#"echo $$ >> '{}'
while read -r l; do
  printf '%s\n' "$l" >> '{}'
  id=$(printf '%s' "$l" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  m=$(printf '%s' "$l" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$m" in
    hang) ;;
    subscriptions/listen) printf '{{"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{{"_meta":{{"{SUBSCRIPTION}":%s}}}}}}\n' "$id" ;;
    *) [ -n "$id" ] && printf '{{"jsonrpc":"2.0","id":%s,"result":{{"ok":true}}}}\n' "$id" ;;
  esac
done"#,
            pids.display(),
            log.display()
        );
        let mut servers = Map::new();
        servers.insert("slow".into(), json!({ "type": "stdio", "command": "sh", "args": ["-c", script] }));
        let g = Grant { token: token().unwrap(), chat_id: 1, cwd: std::env::temp_dir(), servers, commands: false, workspace: vec![], machines: None };
        let port = grant(g.clone()).unwrap();
        let path = format!("/{}/slow", g.token);
        let json = "application/json, text/event-stream";
        let (code, body) = post(port, &path, r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}"#);
        assert_eq!((code, serde_json::from_str::<Value>(&body).unwrap()["id"].clone()), (200, json!(0)));

        // A request it never answers doesn't hold up the next one (the agent's ids come back).
        let hung = ask(port, &path, r#"{"jsonrpc":"2.0","id":"a-1","method":"hang"}"#, json);
        std::thread::sleep(Duration::from_millis(300));
        let t = Instant::now();
        let (code, body) = post(port, &path, r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#);
        assert_eq!((code, serde_json::from_str::<Value>(&body).unwrap()["id"].clone()), (200, json!(7)));
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());

        // The agent hangs up as ssh passes it on (an end of input, no reset): the bridge closes
        // its side at once (no CLOSE_WAIT holding the ssh session open) and the server hears
        // the request is off.
        let peer = hung.local_addr().unwrap().port();
        hung.shutdown(std::net::Shutdown::Write).unwrap();
        let t = Instant::now();
        assert_eq!(rest(hung).expect("the bridge closes the connection"), "");
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        assert!(!close_wait(port, peer), "the bridge's end sits in CLOSE_WAIT");
        wait_for("the server hears of the cancel", || std::fs::read_to_string(&log).unwrap_or_default().contains("notifications/cancelled"));

        // A listen streams its acknowledgement, under the agent's own id, and stays open
        // (past any request's wait) until the agent leaves.
        let mut listen = ask(port, &path, r#"{"jsonrpc":"2.0","id":42,"method":"subscriptions/listen","params":{"notifications":{}}}"#, json);
        let mut head = vec![0u8; 4096];
        let n = listen.read(&mut head).unwrap();
        let head = String::from_utf8_lossy(&head[..n]).to_string();
        assert!(head.starts_with("HTTP/1.1 200") && head.contains("text/event-stream"), "{head}");
        let head = if head.contains("data: ") { head } else { head + &rest_line(&mut listen) };
        assert!(head.contains(&format!("\"{SUBSCRIPTION}\":42")), "{head}");
        listen.set_read_timeout(Some(WAIT + Duration::from_millis(500))).unwrap();
        let mut more = [0u8; 256];
        let quiet = listen.read(&mut more);
        assert!(quiet.as_ref().is_err_and(|e| matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)), "{quiet:?} {}", String::from_utf8_lossy(&more));
        listen.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        let peer = listen.local_addr().unwrap().port();
        listen.shutdown(std::net::Shutdown::Write).unwrap();
        assert!(rest(listen).is_ok());
        assert!(!close_wait(port, peer), "the listen's end sits in CLOSE_WAIT");

        // Still connected, an unanswered request ends with an error after its time; a server
        // that said nothing at all meanwhile is stopped, and the next request starts it again.
        let t = Instant::now();
        let out = rest(ask(port, &path, r#"{"jsonrpc":"2.0","id":9,"method":"hang"}"#, "application/json")).unwrap();
        assert!(t.elapsed() >= WAIT && out.contains("\"id\":9") && out.contains("didn't answer"), "{out}");
        let (_, body) = post(port, &path, r#"{"jsonrpc":"2.0","id":10,"method":"tools/list"}"#);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"]["ok"], true);
        assert_eq!(std::fs::read_to_string(&pids).unwrap().lines().count(), 2);
        // It came back initialized, as the agent left it.
        assert_eq!(std::fs::read_to_string(&log).unwrap().matches("\"method\":\"initialize\"").count(), 2);

        revoke(&g.token);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ending_a_turn_waits_for_nothing_and_leaves_the_next_ones_grant() {
        // A stopped turn whose server never answers a request still pending, and the chat's
        // next turn, already running.
        let mut servers = Map::new();
        servers.insert("slow".into(), json!({ "type": "stdio", "command": "sh", "args": ["-c", "while read -r l; do :; done"] }));
        let a = Grant { token: token().unwrap(), chat_id: 3, cwd: std::env::temp_dir(), servers, commands: false, workspace: vec![], machines: None };
        let b = Grant { token: token().unwrap(), ..a.clone() };
        let root = std::env::temp_dir().join(format!("harbor-bridge-end-{}", token().unwrap()));
        let (da, db) = (root.join("3-1"), root.join("3-2"));
        for (d, g) in [(&da, &a), (&db, &b)] {
            std::fs::create_dir_all(d).unwrap();
            save(d, g);
            grant(g.clone());
        }
        let port = port().unwrap();
        let pending = ask(port, &format!("/{}/slow", a.token), r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}"#, "application/json");
        std::thread::sleep(Duration::from_millis(300));
        let t = Instant::now();
        end(&da);
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
        // Its request hears that the server is gone.
        assert!(rest(pending).unwrap().contains("exited"));
        assert_eq!(post(port, &format!("/{}/slow", a.token), "{}").0, 404);
        let (code, body) = post(port, &format!("/{}/origin", b.token), r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#);
        assert_eq!((code, serde_json::from_str::<Value>(&body).unwrap()["id"].clone()), (200, json!(2)));
        end(&db);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The next line on the connection (an event that came in its own packet).
    fn rest_line(s: &mut TcpStream) -> String {
        let mut b = vec![0u8; 4096];
        let n = s.read(&mut b).unwrap_or(0);
        String::from_utf8_lossy(&b[..n]).to_string()
    }

    #[test]
    fn a_silent_http_stream_ends_when_its_agent_leaves() {
        // An http server that never answers the first request, and opens an event stream for
        // the second that goes silent after a first comment (curl passes the head on with it).
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let sport = server.local_addr().unwrap().port();
        let (tx, curl_left) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for answer in [&b""[..], b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n: hi\n\n"] {
                let (mut c, _) = server.accept().unwrap();
                let mut b = [0u8; 4096];
                let _ = c.read(&mut b);
                c.write_all(answer).unwrap();
                // Until curl goes away.
                while c.read(&mut b).is_ok_and(|n| n > 0) {}
                let _ = tx.send(());
            }
        });
        let mut servers = Map::new();
        servers.insert("web".into(), json!({ "type": "http", "url": format!("http://127.0.0.1:{sport}/mcp") }));
        let g = Grant { token: token().unwrap(), chat_id: 1, cwd: std::env::temp_dir(), servers, commands: false, workspace: vec![], machines: None };
        let port = grant(g.clone()).unwrap();
        let open = || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "GET /{}/web HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n", g.token).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
            s
        };
        let leave = |s: TcpStream| {
            let peer = s.local_addr().unwrap().port();
            s.shutdown(std::net::Shutdown::Write).unwrap();
            let t = Instant::now();
            assert!(rest(s).is_ok(), "the bridge closes the connection");
            assert!(!close_wait(port, peer), "the bridge's end sits in CLOSE_WAIT");
            curl_left.recv_timeout(Duration::from_secs(3)).expect("curl was stopped");
            assert!(t.elapsed() < Duration::from_secs(3));
        };
        // Gone before the server said anything.
        let s = open();
        std::thread::sleep(Duration::from_millis(300));
        leave(s);
        // Gone while the stream is quiet.
        let mut s = open();
        let mut head = [0u8; 1024];
        let n = s.read(&mut head).unwrap();
        assert!(String::from_utf8_lossy(&head[..n]).starts_with("HTTP/1.1 200"));
        leave(s);
        revoke(&g.token);
    }

    #[test]
    fn finds_the_forwarded_port() {
        let dir = std::env::temp_dir().join(format!("harbor-fwd-{}", token().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cmd.json"), json!({ "program": "ssh", "args": ["-o", "BatchMode=yes", "-R", "127.0.0.1:31234:127.0.0.1:47931", "host", "cmd"] }).to_string()).unwrap();
        assert_eq!(forwarded_port(&dir), Some(47931));
        std::fs::write(dir.join("cmd.json"), json!({ "program": "claude", "args": ["-p"] }).to_string()).unwrap();
        assert_eq!(forwarded_port(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
        assert_ne!(PORT, crate::api::DEFAULT_PORT);
    }

    #[test]
    fn shell_keeps_the_end_and_returns_despite_background_children() {
        let dir = std::env::temp_dir();
        let (st, text) = shell("head -c 3000000 /dev/zero | tr '\\0' a; echo; echo last", &dir, Duration::from_secs(20));
        assert_eq!(st, Ok(0));
        assert!(text.starts_with("[… ") && text.ends_with("\nlast\n") && text.len() < OUTPUT_MAX + 100, "{}", &text[..80]);
        let t = Instant::now();
        let (st, text) = shell("sleep 300 & echo started", &dir, Duration::from_secs(20));
        assert_eq!(st, Ok(0));
        assert!(text.starts_with("started\n") && text.contains("stopped the background processes"), "{text}");
        assert!(t.elapsed() < Duration::from_secs(5));
        let (st, _) = shell("sleep 300", &dir, Duration::from_secs(1));
        assert_eq!(st, Err(String::new()));
        assert!(t.elapsed() < Duration::from_secs(9));
    }
}
