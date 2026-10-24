//! Two listeners inside the app, both threads that sleep in `accept`:
//! - a Unix socket (private, 0600) where `harbor mcp` relays agents' tool calls;
//! - an HTTP port on 127.0.0.1 that only answers `/hooks/<token>` for webhooks (hookcert.rs
//!   serves the same requests over public HTTPS; Tailscale Funnel, when installed, can too).

use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const HOOK_PORT: u16 = 47920;

/// A tool call from an agent, answered by the UI thread through `reply`.
pub struct ToolCall {
    pub chat_id: i64,
    pub tool: String,
    pub args: Value,
    pub reply: Sender<(bool, String)>,
}

pub struct Hook {
    pub token: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

pub enum Incoming {
    Tool(ToolCall),
    Hook(Hook),
    /// A call from the phone API (api.rs), answered through its `reply`.
    Api(crate::api::Call),
    /// A second launch wants this window in front; `raised` when the compositor did it.
    Focus { raised: bool },
    /// From the workers that follow other PCs' Harbors (mesh.rs).
    Mesh(crate::mesh::Msg),
}

pub fn socket_path() -> PathBuf {
    if let Some(p) = std::env::var_os("HARBOR_SOCK") {
        return PathBuf::from(p);
    }
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    dir.join("harbor.sock")
}

pub fn start_socket(tx: Sender<Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    let path = socket_path();
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = UnixListener::bind(&path) else {
        eprintln!("harbor: cannot bind {}", path.display());
        return;
    };
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let tx = tx.clone();
            let wake = wake.clone();
            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                let mut line = String::new();
                let mut reader = BufReader::new(&stream);
                if reader.read_line(&mut line).is_err() {
                    return;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else { return };
                if v["focus"].as_bool() == Some(true) {
                    // Raised from here, not the UI thread: a window on a hidden workspace gets no frames.
                    let raised = crate::single::raise();
                    let _ = tx.send(Incoming::Focus { raised });
                    wake();
                    let mut w = &stream;
                    let _ = writeln!(w, "{}", serde_json::json!({ "ok": true }));
                    return;
                }
                let (rtx, rrx) = channel();
                let call = ToolCall {
                    chat_id: v["chat"].as_i64().unwrap_or(0),
                    tool: v["tool"].as_str().unwrap_or("").into(),
                    args: v["args"].clone(),
                    reply: rtx,
                };
                if tx.send(Incoming::Tool(call)).is_err() {
                    return;
                }
                wake();
                let (ok, text) = rrx.recv_timeout(Duration::from_secs(120)).unwrap_or((false, "Harbor did not answer".into()));
                let mut w = &stream;
                let _ = writeln!(w, "{}", serde_json::json!({ "ok": ok, "text": text }));
            });
        }
    });
}

/// Webhook requests served at once.
static HOOK_CONNS: crate::api::Conns = crate::api::Conns::new(32);
/// Requests one webhook may make per minute; more get 429 (senders retry later).
const HOOK_PER_MINUTE: usize = 30;
static HOOK_RATE: std::sync::LazyLock<Mutex<Rate>> = std::sync::LazyLock::new(Default::default);

/// Per webhook token: when its last requests came, for [`HOOK_PER_MINUTE`].
#[derive(Default)]
struct Rate(std::collections::HashMap<String, std::collections::VecDeque<std::time::Instant>>);

impl Rate {
    fn allow(&mut self, token: &str, now: std::time::Instant) -> bool {
        let minute = Duration::from_secs(60);
        self.0.retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < minute));
        let q = self.0.entry(token.to_string()).or_default();
        while q.front().is_some_and(|t| now.duration_since(*t) >= minute) {
            q.pop_front();
        }
        if q.len() >= HOOK_PER_MINUTE {
            return false;
        }
        q.push_back(now);
        true
    }
}

/// Starts the webhook listener; `tokens` is the live set of valid tokens.
/// Returns the bound port.
pub fn start_hooks(tx: Sender<Incoming>, tokens: Arc<Mutex<HashSet<String>>>, wake: impl Fn() + Send + Sync + Clone + 'static) -> Option<u16> {
    let listener = (HOOK_PORT..HOOK_PORT + 10).find_map(|p| TcpListener::bind(("127.0.0.1", p)).ok())?;
    let port = listener.local_addr().ok()?.port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let tx = tx.clone();
            let tokens = tokens.clone();
            let wake = wake.clone();
            let Some(slot) = HOOK_CONNS.take() else { continue };
            std::thread::spawn(move || {
                let _slot = slot;
                let mut w = &stream;
                let mut reader = BufReader::new(crate::api::Timed::new(&stream, crate::api::HEAD_WAIT, Duration::from_secs(10)));
                let head = crate::api::read_head_chunked(&mut reader);
                reader.get_mut().until = None;
                serve_hook(head, &mut reader, &mut w, &tokens, &tx, &wake);
            });
        }
    });
    Some(port)
}

/// Answers one webhook request whose head was read (`head`); the body comes from `r`. Only
/// `/hooks/<token>` of a live webhook is answered; a GitHub-style `X-Hub-Signature-256` must
/// match an HMAC of the body keyed with the token (GitHub's webhook secret = the token).
pub fn serve_hook(head: Result<crate::api::Request, (u16, &'static str)>, r: &mut impl std::io::Read, w: &mut impl Write, tokens: &Mutex<HashSet<String>>, tx: &Sender<Incoming>, wake: &(impl Fn() + Send + Sync)) {
    let Ok(head) = head else {
        let _ = w.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let token = head.path.strip_prefix("/hooks/").unwrap_or("").trim_end_matches('/').to_string();
    let known = !token.is_empty() && tokens.lock().unwrap().contains(&token);
    if !known {
        let _ = w.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    if !HOOK_RATE.lock().unwrap().allow(&token, std::time::Instant::now()) {
        let _ = w.write_all(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    // Past 1 MB a body is cut (the agent sees 8000 characters of it anyway).
    let mut r = BufReader::new(r);
    let body = if head.chunked { crate::api::read_chunked(&mut r, 1 << 20) } else { crate::api::read_body(&mut r, head.len.min(1 << 20), 1 << 20) };
    let Ok(body) = body else {
        let _ = w.write_all(b"HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    if let Some(sig) = head.header("x-hub-signature-256") {
        if !signature_ok(&token, &body, sig) {
            let _ = w.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }
    }
    let _ = w.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}");
    let _ = w.flush();
    let (method, headers) = (head.method, head.headers);
    // Only headers that say what the event is; never auth headers.
    let keep = ["content-type", "user-agent", "x-github-event", "x-github-delivery", "x-gitlab-event", "x-vercel-event", "stripe-signature", "x-event-key", "x-request-id"];
    let headers = headers.into_iter().filter(|(k, _)| keep.contains(&k.as_str())).collect();
    let body = String::from_utf8_lossy(&body).into_owned();
    let _ = tx.send(Incoming::Hook(Hook { token, method, headers, body }));
    wake();
}

/// `sha256=<hex>` = HMAC-SHA256(token, body), compared in constant time.
pub fn signature_ok(token: &str, body: &[u8], sig: &str) -> bool {
    let Some(hex) = sig.trim().strip_prefix("sha256=") else { return false };
    let Some(want) = (0..hex.len() / 2).map(|i| u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()).collect::<Option<Vec<u8>>>() else { return false };
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, token.as_bytes());
    ring::hmac::verify(&key, body, &want).is_ok()
}

/// Public base URL when Tailscale Funnel serves /hooks to the local port.
pub fn funnel_base(port: u16) -> Option<String> {
    let out = std::process::Command::new("tailscale").args(["funnel", "status"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    if !text.contains("Funnel on") || !text.contains(&format!("127.0.0.1:{port}")) {
        return None;
    }
    let st = std::process::Command::new("tailscale").args(["status", "--json"]).output().ok()?;
    let v: Value = serde_json::from_slice(&st.stdout).ok()?;
    let dns = v["Self"]["DNSName"].as_str()?.trim_end_matches('.').to_string();
    Some(format!("https://{dns}/hooks"))
}

pub fn funnel_enable_cmd(port: u16) -> String {
    format!("tailscale funnel --bg --set-path /hooks http://127.0.0.1:{port}/hooks")
}

pub fn funnel_disable_cmd() -> String {
    "tailscale funnel --set-path /hooks off".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_signatures() {
        // HMAC-SHA256("tok", "{}"), as GitHub sends it with the secret "tok".
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, b"tok");
        let tag: String = ring::hmac::sign(&key, b"{}").as_ref().iter().map(|b| format!("{b:02x}")).collect();
        assert!(signature_ok("tok", b"{}", &format!("sha256={tag}")));
        assert!(!signature_ok("tok", b"{ }", &format!("sha256={tag}")));
        assert!(!signature_ok("other", b"{}", &format!("sha256={tag}")));
        assert!(!signature_ok("tok", b"{}", "sha1=00") && !signature_ok("tok", b"{}", "sha256=zz"));
    }

    #[test]
    fn webhooks_are_rate_limited_per_token() {
        let mut r = Rate::default();
        let t = std::time::Instant::now();
        for _ in 0..HOOK_PER_MINUTE {
            assert!(r.allow("a", t));
        }
        assert!(!r.allow("a", t + Duration::from_secs(30)));
        assert!(r.allow("b", t), "each webhook has its own budget");
        assert!(r.allow("a", t + Duration::from_secs(61)), "the window moves on");
    }
}
