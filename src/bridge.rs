//! The bridge: this PC's MCP servers for an agent that runs on another device.
//!
//! A small HTTP server on 127.0.0.1 speaks MCP's streamable HTTP transport. Every
//! remote turn gets a grant (a random token in the URL path) naming the servers it may
//! use; `ssh -R` makes the port reachable on the device's own 127.0.0.1, and the remote
//! Claude Code's `--mcp-config` lists `http` servers pointing there:
//! - stdio servers run here, one process per turn and server; each request goes to it
//!   as a line on stdin and its answer comes back as the HTTP response;
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
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// First port tried; a stable one lets turns that outlive a reload find it again.
const PORT: u16 = 47930;
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
}

/// A stdio server's process, and the `initialize` it got (replayed if it restarts).
#[derive(Default)]
struct Slot {
    proc: Option<Proc>,
    init: Option<Value>,
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
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
    for slot in live.slots.values() {
        if let Some(mut p) = slot.lock().unwrap().proc.take() {
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }
}

pub fn save(dir: &Path, g: &Grant) {
    let _ = crate::mcp::write_private(&dir.join("bridge.json"), &serde_json::to_string(g).unwrap_or_default());
}

fn saved(dir: &Path) -> Option<Grant> {
    serde_json::from_str(&std::fs::read_to_string(dir.join("bridge.json")).ok()?).ok()
}

/// A turn followed again (after a reload): its grant is served again.
pub fn resume(dir: &Path) {
    if let Some(g) = saved(dir) {
        grant(g);
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
    for name in g.servers.keys().map(String::as_str).chain([ORIGIN]) {
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
            (server == ORIGIN || def.is_some()).then(|| (live.grant.clone(), def, live.slots.entry(server.to_string()).or_default().clone()))
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
    let one = |m: &Value| -> Option<Value> {
        match &def {
            None => origin(&grant, m),
            Some(d) if kind.as_deref() == Some("stdio") => stdio(&grant, d, &slot, m),
            Some(_) => m.get("id").map(|id| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "Harbor's bridge only carries stdio and http servers" } })),
        }
    };
    let out = match &msg {
        Value::Array(batch) => {
            let all: Vec<Value> = batch.iter().filter_map(one).collect();
            (!all.is_empty()).then_some(Value::Array(all))
        }
        m => one(m),
    };
    match out {
        Some(v) => respond(&s, 200, "application/json", v.to_string().as_bytes()),
        None => respond(&s, 202, "application/json", b""),
    }
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
    let (stdin, out) = (child.stdin.take()?, BufReader::new(child.stdout.take()?));
    Some(Proc { child, stdin, out })
}

/// Sends one message to the server and waits for its answer (None for notifications).
/// Requests the server makes meanwhile (roots, ping) are answered here.
fn exchange(g: &Grant, p: &mut Proc, msg: &Value) -> Result<Option<Value>, ()> {
    writeln!(p.stdin, "{msg}").and_then(|_| p.stdin.flush()).map_err(|_| ())?;
    let Some(id) = msg.get("id") else { return Ok(None) };
    loop {
        let mut line = String::new();
        if p.out.read_line(&mut line).map_err(|_| ())? == 0 {
            return Err(());
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        match (v.get("method").and_then(|m| m.as_str()), v.get("id")) {
            (Some(m), Some(rid)) => {
                let answer = match m {
                    "roots/list" => json!({ "jsonrpc": "2.0", "id": rid, "result": { "roots": [{ "uri": format!("file://{}", g.cwd.display()), "name": "project" }] } }),
                    "ping" => json!({ "jsonrpc": "2.0", "id": rid, "result": {} }),
                    _ => json!({ "jsonrpc": "2.0", "id": rid, "error": { "code": -32601, "message": "not supported over Harbor's bridge" } }),
                };
                writeln!(p.stdin, "{answer}").map_err(|_| ())?;
            }
            (Some(_), None) => {}
            (None, Some(rid)) if rid == id => return Ok(Some(v)),
            _ => {}
        }
    }
}

fn stdio(g: &Grant, def: &Value, slot: &Mutex<Slot>, msg: &Value) -> Option<Value> {
    let mut s = slot.lock().unwrap();
    if msg["method"] == "initialize" {
        s.init = Some(msg.clone());
    }
    for attempt in 0..2 {
        if s.proc.as_mut().is_none_or(|p| p.child.try_wait().ok().flatten().is_some()) {
            s.proc = spawn(g, def);
            // A server that died mid-turn comes back initialized, as the agent left it.
            if let (Some(init), Some(p)) = (s.init.clone(), s.proc.as_mut()) {
                if msg["method"] != "initialize" {
                    let mut init = init;
                    init["id"] = json!("harbor-reinit");
                    let ok = exchange(g, p, &init).is_ok() && exchange(g, p, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_ok();
                    if !ok {
                        s.proc = None;
                    }
                }
            }
        }
        let Some(p) = s.proc.as_mut() else { break };
        match exchange(g, p, msg) {
            Ok(r) => return r,
            Err(()) if attempt == 0 => s.proc = None,
            Err(()) => break,
        }
    }
    let id = msg.get("id")?;
    Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "the MCP server on the Harbor PC didn't start or exited" } }))
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
        let _ = c.kill();
        let _ = c.wait();
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
    let _ = c.kill();
    let _ = c.wait();
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
                "You run on a remote device. '{}' is the PC running Harbor, where the user is. Its prompts are the user's own slash commands and skills{}.",
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
            let args = p["arguments"]["arguments"].as_str().unwrap_or("");
            let text = if c.body.contains("$ARGUMENTS") {
                c.body.replace("$ARGUMENTS", args)
            } else if args.is_empty() {
                c.body.clone()
            } else {
                format!("{}\n\nArguments: {args}", c.body)
            };
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
/// was stopped, Err(why) when it didn't start.
pub fn shell(script: &str, cwd: &Path, limit: Duration) -> (Result<i32, String>, String) {
    let mut cmd = shell_command(script, cwd);
    let mut child = match cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
        Ok(c) => c,
        Err(e) => return (Err(format!("cannot run it in {}: {e}", cwd.display())), String::new()),
    };
    let mut out = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = out.read_to_end(&mut b);
        b
    });
    let t = Instant::now();
    let status = loop {
        if let Ok(Some(st)) = child.try_wait() {
            break Ok(st.code().unwrap_or(-1));
        }
        if t.elapsed() > limit {
            let _ = Command::new("kill").args(["-KILL", &format!("-{}", child.id())]).status();
            let _ = child.wait();
            break Err(String::new());
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    let bytes = reader.join().unwrap_or_default();
    (status, tail(String::from_utf8_lossy(&bytes).into_owned(), OUTPUT_MAX))
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

/// The last `max` bytes of `text`, saying how much was cut.
pub fn tail(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let cut = text.len() - max;
    let cut = (cut..text.len()).find(|i| text.is_char_boundary(*i)).unwrap_or(cut);
    format!("[… {cut} bytes cut]\n{}", &text[cut..])
}

/// A user command or skill offered as an MCP prompt.
struct Prompt {
    name: String,
    description: String,
    body: String,
}

/// Front matter's `description:`, and the text after it.
fn split_front(text: &str) -> (String, String) {
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some((front, body)) = rest.split_once("\n---") {
            let desc = front.lines().find_map(|l| l.strip_prefix("description:")).map(|d| d.trim().trim_matches('"').to_string()).unwrap_or_default();
            return (desc, body.trim_start_matches(['-', '\n']).to_string());
        }
    }
    (String::new(), text.to_string())
}

fn md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            md_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "md") {
            out.push(p);
        }
    }
}

/// ~/.claude/commands (as `name`, folders joined with `_`) and ~/.claude/skills (as
/// `skill_<name>`). Skills' other files stay here; the prompt says where.
fn prompts() -> Vec<Prompt> {
    let base = crate::store::home().join(".claude");
    let mut v = vec![];
    let cdir = base.join("commands");
    let mut files = vec![];
    md_files(&cdir, &mut files);
    files.sort();
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        let rel = f.strip_prefix(&cdir).unwrap_or(&f).with_extension("");
        let name: String = rel.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        let (desc, body) = split_front(&text);
        let description = if desc.is_empty() { body.lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(120).collect() } else { desc };
        v.push(Prompt { name, description, body });
    }
    let mut skills: Vec<PathBuf> = std::fs::read_dir(base.join("skills")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.join("SKILL.md").is_file()).collect();
    skills.sort();
    for d in skills {
        let Ok(text) = std::fs::read_to_string(d.join("SKILL.md")) else { continue };
        let (desc, body) = split_front(&text);
        let name = format!("skill_{}", d.file_name().unwrap_or_default().to_string_lossy());
        let body = format!("Follow this skill. Its other files are on the Harbor PC in {} (the origin read tool, or run_command, reads them when this device has it).\n\n{body}", d.display());
        v.push(Prompt { name, description: desc, body });
    }
    v
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
    fn serves_stdio_and_origin_and_refuses_unknown_tokens() {
        // A stdio "server" that answers every request line with its own id.
        let echo = r#"while read -r l; do id=$(printf '%s' "$l" | sed -n 's/.*"id":\([0-9]*\).*/\1/p'); [ -n "$id" ] && printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id"; done"#;
        let mut servers = Map::new();
        servers.insert("echo".into(), json!({ "type": "stdio", "command": "sh", "args": ["-c", echo] }));
        let g = Grant { token: token().unwrap(), chat_id: 1, cwd: std::env::temp_dir(), servers, commands: true, workspace: vec![] };
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
        let g = Grant { token: token().unwrap(), chat_id: 1, cwd: std::env::temp_dir(), servers: Map::new(), commands: false, workspace: vec![] };
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

    #[test]
    fn front_matter() {
        let (d, b) = split_front("---\ndescription: Do it\n---\nBody $ARGUMENTS\n");
        assert_eq!((d.as_str(), b.as_str()), ("Do it", "Body $ARGUMENTS\n"));
    }
}
