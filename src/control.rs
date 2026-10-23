//! Two listeners inside the app, both threads that sleep in `accept`:
//! - a Unix socket (private, 0600) where `harbor mcp` relays agents' tool calls;
//! - an HTTP port on 127.0.0.1 that only answers `/hooks/<token>` for webhooks.
//!   Tailscale Funnel can publish exactly that path; nothing else is served.

use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
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
            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let mut reader = BufReader::new(&stream);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    return;
                }
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();
                let mut headers = vec![];
                let mut len = 0usize;
                loop {
                    let mut l = String::new();
                    if reader.read_line(&mut l).is_err() || l.trim().is_empty() {
                        break;
                    }
                    if let Some((k, v)) = l.split_once(':') {
                        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_string());
                        if k == "content-length" {
                            len = v.parse().unwrap_or(0);
                        }
                        headers.push((k, v));
                    }
                }
                let token = path.strip_prefix("/hooks/").unwrap_or("").trim_end_matches('/').split('?').next().unwrap_or("").to_string();
                let known = !token.is_empty() && tokens.lock().unwrap().contains(&token);
                let mut w = &stream;
                if !known {
                    let _ = w.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    return;
                }
                let mut body = vec![0u8; len.min(1 << 20)];
                let _ = reader.read_exact(&mut body);
                let _ = w.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}");
                // Only headers that say what the event is; never auth headers.
                let keep = ["content-type", "user-agent", "x-github-event", "x-github-delivery", "x-gitlab-event", "x-vercel-event", "stripe-signature", "x-event-key", "x-request-id"];
                let headers = headers.into_iter().filter(|(k, _)| keep.contains(&k.as_str())).collect();
                let body = String::from_utf8_lossy(&body).into_owned();
                let _ = tx.send(Incoming::Hook(Hook { token, method, headers, body }));
                wake();
            });
        }
    });
    Some(port)
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
