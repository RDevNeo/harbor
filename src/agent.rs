//! Runs one agent turn as a short-lived child process and streams its events.
//!
//! Every provider is a CLI started per message in headless JSON mode. The
//! conversation lives in the provider's own session store and is continued by
//! id, so nothing stays resident between turns.

use crate::providers::{Account, Kind};
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::Sender;

pub enum Event {
    /// The provider's session id, needed to continue the conversation.
    Session(String),
    Mcp(Vec<(String, String)>),
    TextDelta(String),
    /// A finished text block: replaces the streaming one, or is appended.
    TextFinal(String),
    ThinkingDelta(String),
    ThinkingFinal(Option<String>),
    /// Insert or update a tool call by id.
    Tool { id: String, name: String, summary: String, input: String, result: Option<String>, is_error: bool },
    Result { cost_usd: Option<f64>, duration_ms: u64, turns: u64, input_tokens: u64, output_tokens: u64 },
    Error(String),
    Stderr(String),
    Exited { ok: bool },
    /// Claude took in a user message written to a running turn (`--replay-user-messages`).
    UserEcho(String),
    /// The account hit a usage limit: its window ("five_hour", "seven_day", …), when it
    /// resets (Unix time) if known, and the CLI's sentence.
    Limit { kind: String, resets_at: Option<i64>, text: String },
    /// Live quota seen in a Claude turn: per window, utilization (0–1) and reset time.
    Quota(Vec<(String, f64, i64)>),
}

/// A running agent turn. It runs detached (see detach.rs), so it outlives a reload.
pub struct Turn {
    dir: PathBuf,
    meta: crate::detach::Meta,
}

impl Turn {
    /// Writes a user message into the running turn; false once the input is closed
    /// (or the provider takes no input mid-turn).
    pub fn write(&self, prompt: &str, files: &[PathBuf]) -> bool {
        crate::detach::input_open(&self.dir) && crate::detach::write_input(&self.dir, &claude_message(prompt, files))
    }

    /// Ends the input: Claude exits once it is done with what it was given.
    pub fn close_input(&self) {
        crate::detach::close_input(&self.dir);
    }

    /// Stops the turn and every command it started.
    pub fn stop(&self) {
        // Marks it stopped on purpose, so a later Harbor doesn't take it for cut off.
        let _ = std::fs::write(self.dir.join("stopped"), "");
        if crate::detach::alive(self.meta.pid, self.meta.pid_start) {
            kill_tree(self.meta.pid);
        }
    }

    /// Stops the turn and waits until its process is gone, so its session file is final.
    pub fn stop_wait(&self) {
        self.stop();
        let t = std::time::Instant::now();
        while crate::detach::alive(self.meta.pid, self.meta.pid_start) && t.elapsed() < std::time::Duration::from_secs(3) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

/// Kills `pid` and everything under it. Agents run Bash commands in their own
/// sessions, so a process group would miss them; the tree is walked by parent pid,
/// freezing what it finds so nothing forks away before the kill. Harbor's own
/// processes (start_process) are children of Harbor, not of the agent, so they stay.
fn kill_tree(pid: u32) {
    let signal = |sig: &str, pids: &[u32]| {
        let _ = Command::new("kill").arg(sig).args(pids.iter().map(|p| p.to_string())).stderr(Stdio::null()).status();
    };
    let mut tree = vec![pid];
    for _ in 0..8 {
        signal("-STOP", &tree);
        let found = descendants(pid);
        if found.len() == tree.len() {
            break;
        }
        tree = found;
    }
    signal("-KILL", &tree);
}

/// `pid` and its descendants, from /proc.
fn descendants(pid: u32) -> Vec<u32> {
    let mut kids: std::collections::HashMap<u32, Vec<u32>> = Default::default();
    for e in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(p) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(e.path().join("stat")) else { continue };
        // "pid (comm) state ppid …": comm may hold spaces, so read after the last ')'.
        let ppid = stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(1)).and_then(|v| v.parse::<u32>().ok());
        if let Some(pp) = ppid {
            kids.entry(pp).or_default().push(p);
        }
    }
    let mut out = vec![pid];
    let mut i = 0;
    while i < out.len() {
        out.extend(kids.get(&out[i]).into_iter().flatten().copied());
        i += 1;
    }
    out
}

pub struct TurnSpec {
    pub chat_id: i64,
    pub cwd: PathBuf,
    pub prompt: String,
    pub files: Vec<PathBuf>,
    pub session_id: String,
    pub resume: bool,
    pub account: Account,
    pub model: String,
    pub effort: String,
    pub access: String,
    pub team: Option<Team>,
    /// Fast mode: Claude's fastMode setting, Codex's priority tier.
    pub fast: bool,
    /// Transcript length when the turn starts, for replaying it after a restart.
    pub base: usize,
    /// Runs on another device over ssh instead of on this PC.
    pub remote: Option<Remote>,
}

/// Where a remote turn runs (see remote.rs); Claude Code only.
pub struct Remote {
    /// ssh's options and destination.
    pub ssh: Vec<String>,
    pub host: String,
    /// The folder there, and shell lines run before the agent starts.
    pub dir: String,
    pub setup: Vec<String>,
    /// This PC's MCP servers and apps through the bridge (Harbor's team tools always go).
    pub bridge: bool,
    /// `run_command` on this PC.
    pub commands: bool,
    /// Shell, git and files on this PC (workspace.rs) instead of the device's.
    pub workspace: bool,
    /// The account's Claude login on this PC (an OAuth access token, oauth.rs): the
    /// first line of the turn's stdin, which the device's shell exports before Claude
    /// starts, so the turn runs as the account picked here. None: the account isn't
    /// signed in on this PC, and the turn runs under the device's own login.
    pub token: Option<String>,
    /// Told to the agent: where it runs and what that means for its tools.
    pub note: String,
}

/// Team wiring for a turn: role instructions and Harbor's tool server.
pub struct Team {
    /// "lead" or "sub".
    pub role: &'static str,
    pub system: String,
}

impl Team {
    fn server(&self, chat_id: i64) -> (String, Vec<String>) {
        // After a release swap the running binary reads "<path> (deleted)"; the new one is at <path>.
        let exe = crate::update::self_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "harbor".into());
        let args = vec!["mcp".into(), "--chat".into(), chat_id.to_string(), "--role".into(), self.role.into()];
        (exe, args)
    }

    /// Claude Code's entry for the `harbor` server.
    fn mcp_entry(&self, chat_id: i64) -> Value {
        let (exe, args) = self.server(chat_id);
        serde_json::json!({
            "type": "stdio", "command": exe, "args": args,
            "env": { "HARBOR_SOCK": crate::control::socket_path().to_string_lossy() }
        })
    }
}

fn is_image(p: &std::path::Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp")
    )
}

fn mime(p: &std::path::Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    }
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                s.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// Prompt text plus a list of attached paths the CLI can't take natively.
fn prompt_with_paths(prompt: &str, paths: &[&PathBuf]) -> String {
    if paths.is_empty() {
        return prompt.into();
    }
    let list: Vec<String> = paths.iter().map(|p| format!("- {}", p.display())).collect();
    format!("{prompt}\n\nAttached files:\n{}", list.join("\n"))
}

/// One stream-json user message for Claude: images inline, other files as paths.
fn claude_message(prompt: &str, files: &[PathBuf]) -> String {
    let mut content = vec![];
    for img in files.iter().filter(|p| is_image(p)) {
        if let Ok(bytes) = std::fs::read(img) {
            content.push(serde_json::json!({
                "type": "image",
                "source": { "type": "base64", "media_type": mime(img), "data": base64(&bytes) }
            }));
        }
    }
    let others: Vec<&PathBuf> = files.iter().filter(|p| !is_image(p)).collect();
    content.push(serde_json::json!({ "type": "text", "text": prompt_with_paths(prompt, &others) }));
    let msg = serde_json::json!({ "type": "user", "message": { "role": "user", "content": content } });
    format!("{msg}\n")
}

/// Builds the command line and the bytes to write to stdin, per provider, and the
/// bridge grant of a remote turn.
fn build(spec: &TurnSpec) -> std::io::Result<(Command, Option<String>, Option<crate::bridge::Grant>)> {
    if spec.remote.is_some() && spec.account.kind != Kind::Claude {
        return Err(std::io::Error::other(format!("only Claude Code runs on other devices so far, not {}", spec.account.kind.label())));
    }
    // CLIs without a system-prompt flag get the team instructions in the first message.
    let owned;
    let spec = if spec.team.is_some() && spec.account.kind != Kind::Claude && !spec.resume {
        owned = TurnSpec {
            prompt: format!("{}\n\n---\n\n{}", spec.team.as_ref().unwrap().system, spec.prompt),
            team: spec.team.as_ref().map(|t| Team { role: t.role, system: t.system.clone() }),
            fast: spec.fast,
            files: spec.files.clone(),
            cwd: spec.cwd.clone(),
            session_id: spec.session_id.clone(),
            account: spec.account.clone(),
            model: spec.model.clone(),
            effort: spec.effort.clone(),
            access: spec.access.clone(),
            remote: None,
            ..*spec
        };
        &owned
    } else {
        spec
    };
    let a = &spec.account;
    let mut cmd = Command::new(a.bin_str());
    cmd.current_dir(&spec.cwd);
    // Credentials only from Harbor's own sign-ins (Settings > Integrations > Apps).
    for (k, v) in a.env().into_iter().chain(crate::mcp::agent_env()) {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    let images: Vec<&PathBuf> = spec.files.iter().filter(|p| is_image(p)).collect();
    let others: Vec<&PathBuf> = spec.files.iter().filter(|p| !is_image(p)).collect();
    let all: Vec<&PathBuf> = spec.files.iter().collect();
    let model = (!spec.model.is_empty()).then_some(spec.model.as_str());
    // Claude Code keywords: "ultracode" is xhigh plus the word, "ultrathink" only the word.
    let (effort, keyword) = match spec.effort.as_str() {
        "ultracode" => (Some("xhigh"), Some("ultracode")),
        "ultrathink" => (None, Some("ultrathink")),
        "" => (None, None),
        e => (Some(e), None),
    };
    let user_prompt = match keyword {
        Some(k) => format!("{}\n\n{k}", spec.prompt),
        None => spec.prompt.clone(),
    };
    let mut stdin = None;
    // A remote turn's servers go through the bridge, at a port forwarded to the device.
    let mut grant = None;
    let mut remote_mcp: Option<String> = None;
    let remote_port = 20000 + u16::from_str_radix(&crate::bridge::token()?[..4], 16).unwrap_or(0) % 40000;

    match a.kind {
        Kind::Claude | Kind::Grok => {
            if a.kind == Kind::Claude {
                cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json"])
                    .args(["--verbose", "--include-partial-messages", "--replay-user-messages"]);
                let mode = match spec.access.as_str() {
                    "edits" => "acceptEdits",
                    "plan" => "plan",
                    _ => "bypassPermissions",
                };
                match &spec.team {
                    Some(t) if t.role == "lead" => {
                        // The lead answers simple things itself (read, search, quick checks,
                        // start a dev server) and delegates real work; it has no edit tools.
                        cmd.args(["--permission-mode", "bypassPermissions"]);
                        cmd.args(["--tools", "Read,Glob,Grep,Bash,WebFetch,WebSearch"]);
                    }
                    _ => {
                        cmd.args(["--permission-mode", mode]);
                    }
                }
                // Working on this PC's files: the device's own file and shell tools are off,
                // and the bridge's stand in (only those this access allows).
                let lead = spec.team.as_ref().is_some_and(|t| t.role == "lead");
                let workspace = match &spec.remote {
                    Some(r) if r.workspace => crate::workspace::for_access(&spec.access, lead),
                    _ => vec![],
                };
                let mut note = spec.remote.as_ref().map(|r| r.note.clone()).unwrap_or_default();
                if !workspace.is_empty() {
                    let allowed = workspace.iter().map(|t| format!("mcp__{}__{t}", crate::bridge::ORIGIN)).collect::<Vec<_>>().join(",");
                    cmd.arg(format!("--disallowedTools={}", crate::workspace::REPLACED)).arg(format!("--allowedTools={allowed}"));
                    note = format!("{note}\n\n{}", crate::workspace::note(&workspace, &spec.cwd)).trim().to_string();
                }
                match (&spec.team, note.as_str()) {
                    (Some(t), "") => cmd.args(["--append-system-prompt", &t.system]),
                    (Some(t), n) => cmd.args(["--append-system-prompt", &format!("{}\n\n{n}", t.system)]),
                    (None, "") => &mut cmd,
                    (None, n) => cmd.args(["--append-system-prompt", n]),
                };
                // Only Harbor's servers: not the user's global, project or claude.ai ones.
                let harbor = spec.team.as_ref().map(|t| ("harbor", t.mcp_entry(spec.chat_id)));
                match &spec.remote {
                    None => {
                        cmd.arg("--strict-mcp-config").arg("--mcp-config").arg(crate::mcp::claude_config(spec.chat_id, harbor));
                    }
                    Some(r) => {
                        let servers = if r.bridge { crate::mcp::claude_servers(harbor) } else { harbor.map(|(k, v)| (k.to_string(), v)).into_iter().collect() };
                        let g = crate::bridge::Grant { token: crate::bridge::token()?, chat_id: spec.chat_id, cwd: spec.cwd.clone(), servers, commands: r.commands && spec.access != "plan", workspace: workspace.clone() };
                        // The config holds the grant's token: it goes on stdin, not on a command line.
                        cmd.arg("--strict-mcp-config").arg("--mcp-config").arg(crate::remote::MCP_CONFIG_ARG);
                        remote_mcp = Some(crate::bridge::remote_config(&g, remote_port).to_string());
                        grant = Some(g);
                    }
                }
                if let Some(e) = effort {
                    cmd.args(["--effort", e]);
                }
                if spec.fast {
                    cmd.args(["--settings", r#"{"fastMode":true}"#]);
                }
                stdin = Some(claude_message(&user_prompt, &spec.files));
            } else {
                cmd.args(["--output-format", "streaming-messages-json", "--include-partial-messages"]);
                match spec.access.as_str() {
                    "edits" => cmd.args(["--permission-mode", "acceptEdits"]),
                    "plan" => cmd.args(["--permission-mode", "plan"]),
                    _ => cmd.arg("--always-approve"),
                };
                cmd.args(["-p", &prompt_with_paths(&spec.prompt, &all)]);
            }
            if let Some(m) = model {
                cmd.args(["--model", m]);
            }
            if spec.resume {
                cmd.args(["--resume", &spec.session_id]);
            } else {
                cmd.args(["--session-id", &spec.session_id]);
            }
        }
        Kind::Codex => {
            cmd.arg("exec");
            if spec.resume {
                cmd.args(["resume", "--json", "--skip-git-repo-check"]);
            } else {
                cmd.args(["--json", "--skip-git-repo-check"]);
            }
            match spec.access.as_str() {
                "edits" => cmd.args(["-c", "sandbox_mode=\"workspace-write\"", "-c", "approval_policy=\"never\""]),
                "plan" => cmd.args(["-c", "sandbox_mode=\"read-only\"", "-c", "approval_policy=\"never\""]),
                _ => cmd.arg("--dangerously-bypass-approvals-and-sandbox"),
            };
            if let Some(m) = model {
                cmd.args(["-m", m]);
            }
            if let Some(e) = effort {
                cmd.args(["-c", &format!("model_reasoning_effort=\"{e}\"")]);
            }
            if spec.fast {
                cmd.args(["-c", "service_tier=\"priority\""]);
            }
            cmd.args(crate::mcp::codex_args());
            if let Some(t) = &spec.team {
                let (exe, args) = t.server(spec.chat_id);
                let toml_list = args.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>().join(",");
                cmd.args(["-c", &format!("mcp_servers.harbor.command={exe:?}")]);
                cmd.args(["-c", &format!("mcp_servers.harbor.args=[{toml_list}]")]);
                cmd.args(["-c", &format!("mcp_servers.harbor.env={{HARBOR_SOCK={:?}}}", crate::control::socket_path().to_string_lossy())]);
            }
            for img in &images {
                cmd.arg("-i").arg(img);
            }
            if spec.resume {
                cmd.arg(&spec.session_id);
            }
            cmd.arg(prompt_with_paths(&spec.prompt, &others));
        }
        Kind::Cursor => {
            cmd.args(["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust"]);
            if spec.access == "full" {
                cmd.arg("--force");
            }
            cmd.args(["--model", model.unwrap_or("auto")]);
            if spec.resume {
                cmd.args(["--resume", &spec.session_id]);
            }
            cmd.arg(prompt_with_paths(&spec.prompt, &all));
        }
        Kind::Gemini => {
            cmd.args(["-o", "stream-json"]);
            let mode = match spec.access.as_str() {
                "edits" => "auto_edit",
                "plan" => "plan",
                _ => "yolo",
            };
            cmd.args(["--approval-mode", mode]);
            if let Some(m) = model {
                cmd.args(["-m", m]);
            }
            if spec.resume {
                cmd.args(["--resume", &spec.session_id]);
            }
            cmd.args(["-p", &prompt_with_paths(&spec.prompt, &all)]);
        }
        Kind::Meta => {
            cmd.args(["exec", "--json", "--session-id", &spec.session_id]);
            if spec.access == "full" {
                cmd.arg("--disable-approval");
            }
            if let Some(m) = model {
                cmd.args(["--model", m]);
            }
            if let Some(e) = effort {
                cmd.args(["--reasoning-effort", e]);
            }
            for img in &images {
                cmd.arg("--image").arg(img);
            }
            cmd.arg(prompt_with_paths(&spec.prompt, &others));
        }
        Kind::OpenCode => {
            cmd.args(["run", "--format", "json"]);
            if let Some(m) = model {
                cmd.args(["--model", m]);
            }
            if spec.resume {
                cmd.args(["--session", &spec.session_id]);
            }
            cmd.arg(prompt_with_paths(&spec.prompt, &all));
        }
    }
    if let (Some(r), Some(g)) = (&spec.remote, &grant) {
        let port = crate::bridge::grant(g.clone()).ok_or_else(|| std::io::Error::other("Harbor's MCP bridge couldn't open a port on 127.0.0.1"))?;
        // The device's own `claude` (from its login shell's PATH), with the same arguments.
        let argv: Vec<String> = std::iter::once("claude".to_string()).chain(cmd.get_args().map(|a| a.to_string_lossy().into_owned())).collect();
        // The login first (it's the first stdin line), the MCP config next, then the profile
        // and the session.
        let mut setup = vec![];
        let mut lines = String::new();
        if let Some(t) = &r.token {
            setup.push(crate::remote::token_setup());
            lines.push_str(&format!("{t}\n"));
        }
        if let Some(c) = &remote_mcp {
            setup.push(crate::remote::mcp_setup());
            lines.push_str(&format!("{c}\n"));
        }
        if !lines.is_empty() {
            stdin = Some(format!("{lines}{}", stdin.unwrap_or_default()));
        }
        setup.extend(r.setup.iter().cloned());
        if spec.resume {
            setup.push(session_here(&spec.session_id));
        }
        let mut ssh = Command::new("ssh");
        ssh.args(&r.ssh)
            .args(["-o", "ExitOnForwardFailure=yes", "-R", &format!("127.0.0.1:{remote_port}:127.0.0.1:{port}")])
            .arg(&r.host)
            .arg(crate::remote::remote_command(&r.dir, &setup, &argv));
        ssh.current_dir(if spec.cwd.is_dir() { spec.cwd.clone() } else { crate::store::home() });
        ssh.env("PATH", crate::providers::child_path());
        cmd = ssh;
    }
    Ok((cmd, stdin, grant))
}

/// A shell line for the device: Claude Code resumes only sessions of the folder it runs
/// in, so one started in another folder there (the chat moved between this PC's files
/// and the device's) is copied to this one's first. The same for one in another Claude
/// profile there (~/.claude2…): the chat switched account, and the profile with it.
fn session_here(id: &str) -> String {
    let f = crate::remote::quote(&format!("{id}.jsonl"));
    format!(
        "c=\"${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects\"; d=\"$c/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')\"; [ -e \"$d\"/{f} ] || {{ s=$(ls \"$c\"/*/{f} 2>/dev/null | head -n1); [ -n \"$s\" ] || s=$(ls \"$HOME\"/.claude*/projects/*/{f} 2>/dev/null | head -n1); [ -n \"$s\" ] && mkdir -p \"$d\" && cp \"$s\" \"$d\"/; }}"
    )
}

/// The chat on screen (0: none), set by the UI each frame: its events repaint at once,
/// other chats' events coalesce into one frame per [`HIDDEN_WAKE`].
pub static SHOWN_CHAT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
pub const HIDDEN_WAKE: std::time::Duration = std::time::Duration::from_secs(1);

/// Whether the window has keyboard focus, set by the UI each frame: live output
/// (a streaming chat, a terminal) repaints a few times a second while it's unfocused.
pub static FOCUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Spawns the turn; events go to `tx` tagged with the chat id, `wake` repaints the UI
/// (`wake(true)` once the turn has ended).
pub fn start(spec: TurnSpec, tx: Sender<(i64, Event)>, wake: impl Fn(bool) + Send + Sync + 'static) -> std::io::Result<Turn> {
    let (cmd, input, grant) = build(&spec)?;
    let meta = crate::detach::Meta {
        chat_id: spec.chat_id,
        kind: spec.account.kind.label().to_string(),
        started: crate::store::now(),
        base: spec.base,
        pid: 0,
        pid_start: 0,
    };
    // Claude's input stays open for messages sent mid-turn (closed after its result).
    let (dir, meta) = match crate::detach::spawn(&cmd, input.as_deref(), spec.account.kind == Kind::Claude, meta) {
        Ok(x) => x,
        Err(e) => {
            if let Some(g) = &grant {
                crate::bridge::revoke(&g.token);
            }
            return Err(e);
        }
    };
    if let Some(g) = &grant {
        crate::bridge::save(&dir, g);
    }
    Ok(follow(dir, meta, tx, wake))
}

/// Picks up a turn an earlier Harbor started: its output is replayed from the start.
pub fn reattach(dir: PathBuf, meta: crate::detach::Meta, tx: Sender<(i64, Event)>, wake: impl Fn(bool) + Send + Sync + 'static) -> Turn {
    follow(dir, meta, tx, wake)
}

/// Streams the turn's events to `tx` (tagged with the chat id) as its output grows;
/// `wake` repaints the UI (`wake(true)` once the turn has ended).
fn follow(dir: PathBuf, meta: crate::detach::Meta, tx: Sender<(i64, Event)>, wake: impl Fn(bool) + Send + Sync + 'static) -> Turn {
    let id = meta.chat_id;
    let kind = Kind::ALL.into_iter().find(|k| k.label() == meta.kind).unwrap_or(Kind::Claude);
    // A remote turn picked up after a reload: its MCP servers are served again.
    crate::bridge::resume(&dir);
    {
        let (dir, meta) = (dir.clone(), meta.clone());
        std::thread::spawn(move || {
            let mut st = ParseState::default();
            // Claude reports the process's total cost; one process can run several turns.
            let mut spent = 0.0;
            // The first message Claude echoes is the turn's own prompt.
            let mut first_echo = true;
            let ok = crate::detach::follow(
                &dir,
                &meta,
                |line| {
                    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
                    let evs = match kind {
                        Kind::Claude | Kind::Grok => parse_claude(&v),
                        Kind::Codex => parse_codex(&v),
                        Kind::Cursor => parse_cursor(&v),
                        Kind::Gemini => parse_gemini(&v),
                        Kind::Meta => parse_muse(&v, &mut st),
                        Kind::OpenCode => parse_opencode(&v, &mut st),
                    };
                    if evs.is_empty() {
                        return;
                    }
                    for mut ev in evs {
                        match &mut ev {
                            Event::Result { cost_usd: Some(c), .. } => {
                                let total = *c;
                                *c -= spent;
                                spent = total;
                            }
                            Event::UserEcho(_) if first_echo => {
                                first_echo = false;
                                continue;
                            }
                            _ => {}
                        }
                        let _ = tx.send((id, ev));
                    }
                    wake(false);
                },
                |line| {
                    if !line.trim().is_empty() {
                        let _ = tx.send((id, Event::Stderr(line.to_string())));
                        wake(false);
                    }
                },
            );
            crate::bridge::end(&dir);
            let _ = tx.send((id, Event::Exited { ok }));
            wake(true);
            // Its events are out: the folder is done. (A reload or quit ends this thread
            // before here, so a running turn's folder stays for the next Harbor.)
            let _ = std::fs::remove_dir_all(&dir);
        });
    }
    Turn { dir, meta }
}

// ------------------------------------------------------------------ parsers

#[derive(Default)]
struct ParseState {
    session_sent: bool,
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

pub fn tool_summary(input: &Value) -> String {
    for k in ["command", "file_path", "filePath", "path", "pattern", "url", "query", "description", "prompt"] {
        if let Some(t) = input[k].as_str() {
            return t.lines().next().unwrap_or("").chars().take(120).collect();
        }
    }
    let t = input.to_string();
    if t == "{}" || t == "null" { String::new() } else { t.chars().take(120).collect() }
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn text_of(c: &Value) -> String {
    match c {
        Value::String(t) => t.clone(),
        Value::Array(a) => a
            .iter()
            .map(|b| match b["type"].as_str() {
                Some("text") => s(&b["text"]),
                Some(other) => format!("[{other}]"),
                None => b.as_str().map(String::from).unwrap_or_default(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn tool_result(id: String, result: String, is_error: bool) -> Event {
    Event::Tool { id, name: String::new(), summary: String::new(), input: String::new(), result: Some(result), is_error }
}

/// Claude Code stream-json (Grok's headless format is the same shape).
fn parse_claude(v: &Value) -> Vec<Event> {
    if !v["parent_tool_use_id"].is_null() {
        return vec![];
    }
    match v["type"].as_str().unwrap_or_default() {
        "system" if v["subtype"] == "init" => {
            let mcp = v["mcp_servers"]
                .as_array()
                .map(|a| a.iter().map(|m| (s(&m["name"]), s(&m["status"]))).collect())
                .unwrap_or_default();
            let mut e = vec![Event::Mcp(mcp)];
            if let Some(id) = v["session_id"].as_str().filter(|x| !x.is_empty()) {
                e.push(Event::Session(id.into()));
            }
            e
        }
        "stream_event" => {
            let e = &v["event"];
            match (e["type"].as_str(), e["delta"]["type"].as_str()) {
                (Some("content_block_delta"), Some("text_delta")) => vec![Event::TextDelta(s(&e["delta"]["text"]))],
                (Some("content_block_delta"), Some("thinking_delta")) => vec![Event::ThinkingDelta(s(&e["delta"]["thinking"]))],
                _ => vec![],
            }
        }
        // A limit hit: Claude writes a synthetic assistant message instead of a reply.
        "assistant" if v["error"] == "rate_limit" => {
            let q = &v["quotaLimits"];
            let text = v["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").map(|b| s(&b["text"])).collect::<Vec<_>>().join(" ");
            vec![Event::Limit { kind: s(&q["rateLimitType"]), resets_at: q["resetsAt"].as_i64(), text }]
        }
        "rate_limit_event" => {
            let info = &v["rate_limit_info"];
            let windows: Vec<(String, f64, i64)> = info["unifiedWindows"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, w)| (k.clone(), w["utilization"].as_f64().unwrap_or(0.0), w["resetsAt"].as_i64().unwrap_or(0)))
                .collect();
            let mut e = vec![];
            if !windows.is_empty() {
                e.push(Event::Quota(windows));
            }
            if info["status"] == "rejected" {
                e.push(Event::Limit { kind: s(&info["rateLimitType"]), resets_at: info["resetsAt"].as_i64(), text: String::new() });
            }
            e
        }
        "assistant" => v["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| match b["type"].as_str() {
                Some("text") => Some(Event::TextFinal(s(&b["text"]))),
                Some("thinking") => Some(Event::ThinkingFinal(Some(s(&b["thinking"])))),
                Some("tool_use") => Some(Event::Tool {
                    id: s(&b["id"]),
                    name: s(&b["name"]),
                    summary: tool_summary(&b["input"]),
                    input: pretty(&b["input"]),
                    result: None,
                    is_error: false,
                }),
                _ => None,
            })
            .collect(),
        "user" if v["isReplay"].as_bool() == Some(true) => {
            let text: Vec<String> = v["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").map(|b| s(&b["text"])).collect();
            vec![Event::UserEcho(text.join("\n"))]
        }
        "user" => v["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "tool_result")
            .map(|b| tool_result(s(&b["tool_use_id"]), text_of(&b["content"]), b["is_error"].as_bool().unwrap_or(false)))
            .collect(),
        "result" => {
            let u = &v["usage"];
            let mut e = vec![];
            if v["is_error"].as_bool() == Some(true) || v["subtype"] != "success" {
                e.push(Event::Error(v["result"].as_str().map(String::from).unwrap_or_else(|| s(&v["subtype"]))));
            }
            e.push(Event::Result {
                cost_usd: v["total_cost_usd"].as_f64().filter(|c| *c > 0.0),
                duration_ms: v["duration_ms"].as_u64().unwrap_or(0),
                turns: v["num_turns"].as_u64().unwrap_or(0),
                input_tokens: u["input_tokens"].as_u64().unwrap_or(0)
                    + u["cache_read_input_tokens"].as_u64().unwrap_or(0)
                    + u["cache_creation_input_tokens"].as_u64().unwrap_or(0),
                output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
            });
            e
        }
        _ => vec![],
    }
}

/// `codex exec --json`: thread/turn/item events.
fn parse_codex(v: &Value) -> Vec<Event> {
    let item = &v["item"];
    match v["type"].as_str().unwrap_or_default() {
        "thread.started" => vec![Event::Session(s(&v["thread_id"]))],
        "item.started" | "item.updated" | "item.completed" => {
            let done = v["type"] == "item.completed";
            let id = s(&item["id"]);
            match item["type"].as_str().unwrap_or_default() {
                "agent_message" if done => vec![Event::TextFinal(s(&item["text"]))],
                "reasoning" if done => vec![Event::ThinkingFinal(Some(s(&item["text"])))],
                "command_execution" => {
                    let full = s(&item["command"]);
                    let cmd = full
                        .strip_prefix("/usr/bin/bash -lc ")
                        .or_else(|| full.strip_prefix("bash -lc "))
                        .map(|c| c.trim_matches('\'').to_string())
                        .unwrap_or(full.clone());
                    let failed = item["exit_code"].as_i64().is_some_and(|c| c != 0);
                    vec![Event::Tool {
                        id,
                        name: "Shell".into(),
                        summary: cmd.lines().next().unwrap_or("").into(),
                        input: cmd,
                        result: done.then(|| s(&item["aggregated_output"])),
                        is_error: failed,
                    }]
                }
                "file_change" => {
                    let paths: Vec<String> = item["changes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|c| format!("{} {}", s(&c["kind"]), s(&c["path"])))
                        .collect();
                    vec![Event::Tool {
                        id,
                        name: "Edit".into(),
                        summary: paths.first().cloned().unwrap_or_default(),
                        input: paths.join("\n"),
                        result: done.then(|| s(&item["status"])),
                        is_error: item["status"] == "failed",
                    }]
                }
                "mcp_tool_call" => vec![Event::Tool {
                    id,
                    name: format!("{}.{}", s(&item["server"]), s(&item["tool"])),
                    summary: tool_summary(&item["arguments"]),
                    input: pretty(&item["arguments"]),
                    result: done.then(|| text_of(&item["result"]["content"])),
                    is_error: item["status"] == "failed",
                }],
                "web_search" => vec![Event::Tool {
                    id,
                    name: "WebSearch".into(),
                    summary: s(&item["query"]),
                    input: s(&item["query"]),
                    result: done.then(String::new),
                    is_error: false,
                }],
                "error" if done => vec![Event::Error(s(&item["message"]))],
                _ => vec![],
            }
        }
        "turn.completed" => {
            let u = &v["usage"];
            vec![Event::Result {
                cost_usd: None,
                duration_ms: 0,
                turns: 1,
                input_tokens: u["input_tokens"].as_u64().unwrap_or(0),
                output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
            }]
        }
        "turn.failed" => vec![Event::Error(s(&v["error"]["message"]))],
        "error" => vec![Event::Error(s(&v["message"]))],
        _ => vec![],
    }
}

/// `cursor-agent -p --output-format stream-json --stream-partial-output`.
fn parse_cursor(v: &Value) -> Vec<Event> {
    match v["type"].as_str().unwrap_or_default() {
        "system" if v["subtype"] == "init" => vec![Event::Session(s(&v["session_id"]))],
        "thinking" => match v["subtype"].as_str() {
            Some("delta") => vec![Event::ThinkingDelta(s(&v["text"]))],
            Some("completed") => vec![Event::ThinkingFinal(None)],
            _ => vec![],
        },
        "assistant" => {
            let text = text_of(&v["message"]["content"]);
            // Partial chunks carry a timestamp; the block summary carries a model_call_id or none.
            let fin = v.get("model_call_id").is_some() || v.get("timestamp_ms").is_none();
            if fin { vec![Event::TextFinal(text)] } else { vec![Event::TextDelta(text)] }
        }
        "tool_call" => {
            // The object also carries metadata keys; the call itself is the `*ToolCall` one.
            let Some((key, call)) = v["tool_call"].as_object().and_then(|o| o.iter().find(|(k, _)| k.ends_with("ToolCall"))) else {
                return vec![];
            };
            let name = key.trim_end_matches("ToolCall");
            let name = name.get(..1).unwrap_or("").to_uppercase() + name.get(1..).unwrap_or("");
            let done = v["subtype"] == "completed";
            let r = &call["result"];
            let (result, is_error) = if !done {
                (None, false)
            } else if let Some(ok) = r.get("success") {
                let out = ["interleavedOutput", "stdout", "content", "output"]
                    .iter()
                    .find_map(|k| ok[*k].as_str().map(String::from))
                    .unwrap_or_else(|| pretty(ok));
                (Some(out), ok["exitCode"].as_i64().is_some_and(|c| c != 0))
            } else {
                (Some(text_of(&r["error"]).trim_matches('"').to_string()), true)
            };
            vec![Event::Tool {
                id: s(&v["call_id"]),
                name,
                summary: tool_summary(&call["args"]),
                input: pretty(&call["args"]),
                result,
                is_error,
            }]
        }
        "result" => {
            let u = &v["usage"];
            let mut e = vec![];
            if v["is_error"].as_bool() == Some(true) {
                e.push(Event::Error(s(&v["result"])));
            }
            e.push(Event::Result {
                cost_usd: None,
                duration_ms: v["duration_ms"].as_u64().unwrap_or(0),
                turns: 1,
                input_tokens: u["inputTokens"].as_u64().unwrap_or(0) + u["cacheReadTokens"].as_u64().unwrap_or(0),
                output_tokens: u["outputTokens"].as_u64().unwrap_or(0),
            });
            e
        }
        _ => vec![],
    }
}

/// `gemini -o stream-json`: init/message/tool_use/tool_result/result.
fn parse_gemini(v: &Value) -> Vec<Event> {
    match v["type"].as_str().unwrap_or_default() {
        "init" => vec![Event::Session(s(&v["session_id"]))],
        "message" if v["role"] == "assistant" => {
            let t = text_of(&v["content"]);
            if v["delta"].as_bool() == Some(true) { vec![Event::TextDelta(t)] } else { vec![Event::TextFinal(t)] }
        }
        "tool_use" => vec![Event::Tool {
            id: s(&v["tool_id"]),
            name: s(&v["tool_name"]),
            summary: tool_summary(&v["parameters"]),
            input: pretty(&v["parameters"]),
            result: None,
            is_error: false,
        }],
        "tool_result" => vec![tool_result(
            s(&v["tool_id"]),
            v["output"].as_str().map(String::from).unwrap_or_else(|| s(&v["error"]["message"])),
            v["status"] == "error",
        )],
        "error" => vec![Event::Error(s(&v["message"]))],
        "result" => {
            let st = &v["stats"];
            let mut e = vec![];
            if v["status"] == "error" {
                e.push(Event::Error(s(&v["error"]["message"])));
            }
            e.push(Event::Result {
                cost_usd: None,
                duration_ms: st["duration_ms"].as_u64().unwrap_or(0),
                turns: 1,
                input_tokens: st["input_tokens"].as_u64().unwrap_or(0),
                output_tokens: st["output_tokens"].as_u64().unwrap_or(0),
            });
            e
        }
        _ => vec![],
    }
}

/// `muse exec --json`: MSP records; text arrives as run.output.delta.
fn parse_muse(v: &Value, st: &mut ParseState) -> Vec<Event> {
    let p = &v["payload"];
    let ty = v["payload_type"].as_str().unwrap_or_default();
    let mut e = vec![];
    if !st.session_sent && v["stream"]["kind"] == "session" {
        st.session_sent = true;
        e.push(Event::Session(s(&v["stream"]["id"])));
    }
    match ty {
        "run.output.delta" => e.push(Event::TextDelta(s(&p["text"]))),
        "run.terminal.completed" => {
            if let Some(t) = p["text"].as_str() {
                e.push(Event::TextFinal(t.into()));
            }
            if let Some(r) = p["reason"].as_str() {
                e.push(Event::Error(r.into()));
            }
        }
        "task.lifecycle.failed" => e.push(Event::Error(s(&p["event"]["reason"]))),
        "run.usage" => {
            let (i, o) = p["models"].as_array().into_iter().flatten().fold((0, 0), |(i, o), m| {
                (i + m["input_tokens"].as_u64().unwrap_or(0), o + m["output_tokens"].as_u64().unwrap_or(0))
            });
            e.push(Event::Result { cost_usd: None, duration_ms: 0, turns: p["calls"].as_u64().unwrap_or(1), input_tokens: i, output_tokens: o });
        }
        t if t.starts_with("tool.") || t.contains(".tool.") => {
            let id = p["call_id"].as_str().or(p["tool_call_id"].as_str()).or(p["id"].as_str()).unwrap_or("").to_string();
            let name = p["name"].as_str().or(p["tool_name"].as_str()).or(p["tool"].as_str()).unwrap_or("Tool").to_string();
            let args = if p["arguments"].is_null() { &p["input"] } else { &p["arguments"] };
            let done = t.ends_with("completed") || t.ends_with("result") || t.ends_with("finished");
            e.push(Event::Tool {
                id,
                name,
                summary: tool_summary(args),
                input: pretty(args),
                result: done.then(|| text_of(if p["output"].is_null() { &p["result"] } else { &p["output"] })),
                is_error: t.ends_with("failed"),
            });
        }
        _ => {}
    }
    e
}

/// `opencode run --format json`: events with a `part` and a `sessionID`.
fn parse_opencode(v: &Value, st: &mut ParseState) -> Vec<Event> {
    let mut e = vec![];
    let sid = v["sessionID"].as_str().or(v["part"]["sessionID"].as_str());
    if let (false, Some(id)) = (st.session_sent, sid) {
        st.session_sent = true;
        e.push(Event::Session(id.into()));
    }
    let part = &v["part"];
    match v["type"].as_str().unwrap_or_default() {
        "text" => e.push(Event::TextFinal(s(&part["text"]))),
        "reasoning" => e.push(Event::ThinkingFinal(Some(s(&part["text"])))),
        "tool_use" | "tool" => {
            let state = &part["state"];
            let done = state["status"] == "completed" || state["status"] == "error";
            e.push(Event::Tool {
                id: s(&part["callID"]),
                name: s(&part["tool"]),
                summary: tool_summary(&state["input"]),
                input: pretty(&state["input"]),
                result: done.then(|| text_of(&state["output"])),
                is_error: state["status"] == "error",
            });
        }
        "step_finish" => {
            let t = &part["tokens"];
            e.push(Event::Result {
                cost_usd: part["cost"].as_f64().filter(|c| *c > 0.0),
                duration_ms: 0,
                turns: 1,
                input_tokens: t["input"].as_u64().unwrap_or(0) + t["cache"]["read"].as_u64().unwrap_or(0),
                output_tokens: t["output"].as_u64().unwrap_or(0),
            });
        }
        "error" => e.push(Event::Error(
            v["error"]["data"]["message"].as_str().or(v["error"]["message"].as_str()).unwrap_or("error").into(),
        )),
        _ => {}
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumed_sessions_follow_the_folder() {
        let root = std::env::temp_dir().join(format!("harbor-sess-{}", crate::bridge::token().unwrap()));
        let (cfg, work) = (root.join("cfg"), root.join("my work"));
        std::fs::create_dir_all(cfg.join("projects/-elsewhere")).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(cfg.join("projects/-elsewhere/abc.jsonl"), "{}").unwrap();
        let st = Command::new("sh").arg("-c").arg(session_here("abc")).current_dir(&work).env("CLAUDE_CONFIG_DIR", &cfg).status().unwrap();
        assert!(st.success());
        let slug: String = work.canonicalize().unwrap().to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        assert!(cfg.join("projects").join(slug).join("abc.jsonl").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A remote turn carries the account's login: first on stdin, exported by the first
    /// setup line, before the profile and the session lines; never in ssh's arguments.
    #[test]
    fn remote_turn_sends_the_login_on_stdin() {
        let account = crate::providers::Account {
            id: "claude2".into(),
            kind: Kind::Claude,
            name: "Claude 2".into(),
            email: String::new(),
            badge: "C2".into(),
            plan: String::new(),
            config_dir: Some(crate::store::home().join(".claude2")),
            bin: None,
            logged_in: Some(true),
            usage: vec![],
        };
        let remote = |token: Option<&str>| Remote {
            ssh: vec!["-o".into(), "BatchMode=yes".into()],
            host: "box".into(),
            dir: "~".into(),
            setup: crate::remote::profile_setup(account.config_dir.as_deref()),
            bridge: false,
            commands: false,
            workspace: false,
            token: token.map(String::from),
            note: String::new(),
        };
        let spec = |token: Option<&str>| TurnSpec {
            chat_id: 999_996,
            cwd: std::env::temp_dir(),
            prompt: "hi".into(),
            files: vec![],
            session_id: "abc".into(),
            resume: true,
            account: account.clone(),
            model: String::new(),
            effort: String::new(),
            access: "full".into(),
            team: None,
            fast: false,
            base: 0,
            remote: Some(remote(token)),
        };
        let (cmd, input, grant) = build(&spec(Some("sk-ant-oat01-secret"))).unwrap();
        crate::bridge::revoke(&grant.unwrap().token);
        let input = input.unwrap();
        let (first, rest) = input.split_once('\n').unwrap();
        assert_eq!(first, "sk-ant-oat01-secret");
        assert!(rest.starts_with('{') && rest.contains("\"type\":\"user\"") && rest.ends_with('\n'), "{rest}");
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let script = args.last().unwrap();
        assert!(!args.iter().any(|a| a.contains("sk-ant-oat01")));
        let at = |needle: &str| script.find(needle).unwrap_or_else(|| panic!("{needle:?} not in {script}"));
        let (login, profile, session, claude) = (at("read -r CLAUDE_CODE_OAUTH_TOKEN"), at("export CLAUDE_CONFIG_DIR="), at("/projects"), at("--input-format"));
        assert!(login < profile && profile < session && session < claude);
        // Not signed in here: no line reads stdin, the message comes first.
        let (cmd, input, grant) = build(&spec(None)).unwrap();
        crate::bridge::revoke(&grant.unwrap().token);
        assert!(input.unwrap().starts_with('{'));
        assert!(!cmd.get_args().any(|a| a.to_string_lossy().contains("CLAUDE_CODE_OAUTH_TOKEN")));
    }

    /// A real Claude turn on "another device" (ssh to this PC), with the bridge:
    /// `cargo test -- --ignored remote_turn_over_ssh --nocapture`. Needs key-based ssh
    /// to 127.0.0.1 and a signed-in Claude Code.
    #[test]
    #[ignore]
    fn remote_turn_over_ssh() {
        let account = crate::providers::discover().into_iter().find(|a| a.id == "claude").expect("a claude account");
        let cfg = crate::remote::Config::default();
        let host = crate::remote::Host { id: "ssh:1".into(), host: "127.0.0.1".into(), bridge: true, commands: true, ..Default::default() };
        let mut ssh = crate::remote::ssh_opts(&cfg, &host);
        ssh.extend(["-o".into(), "UserKnownHostsFile=/tmp/harbor-dev-kh".into()]);
        let cwd = std::env::temp_dir();
        let spec = TurnSpec {
            chat_id: 999_999,
            cwd: cwd.clone(),
            prompt: "Call the run_command tool of the origin MCP server with the command `echo bridged-$((6*7))`, then answer with only its first output line.".into(),
            files: vec![],
            session_id: crate::store::new_uuid(),
            resume: false,
            account,
            model: "claude-haiku-5-5".into(),
            effort: String::new(),
            access: "full".into(),
            team: None,
            fast: false,
            base: 0,
            remote: Some(Remote { ssh, host: host.host.clone(), dir: "/tmp".into(), setup: vec![], bridge: true, commands: true, workspace: false, token: None, note: "You run on a test device.".into() }),
        };
        let (mut cmd, input, grant) = build(&spec).unwrap();
        let grant = grant.unwrap();
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        {
            use std::io::Write;
            let mut sin = child.stdin.take().unwrap();
            sin.write_all(input.unwrap().as_bytes()).unwrap();
            // Kept open like the runner does, closed after the result.
            let out = child.stdout.take().unwrap();
            let mut servers = vec![];
            let mut answer = String::new();
            for line in std::io::BufRead::lines(std::io::BufReader::new(out)).map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v["type"] == "system" && v["subtype"] == "init" {
                    servers = v["mcp_servers"].as_array().cloned().unwrap_or_default();
                    eprintln!("mcp servers: {servers:?}");
                }
                if v["type"] == "result" {
                    answer = v["result"].as_str().unwrap_or("").to_string();
                    break;
                }
            }
            drop(sin);
            eprintln!("answer: {answer}");
            assert!(servers.iter().any(|s| s["name"] == "origin" && s["status"] == "connected"));
            assert!(answer.contains("bridged-42"));
        }
        let _ = child.wait();
        crate::bridge::revoke(&grant.token);
    }

    /// A real turn on "another device" that works on this PC's files: git and edits go
    /// through the origin tools, the device's own are off. Needs what the test above does:
    /// `cargo test -- --ignored remote_turn_works_here --nocapture`.
    #[test]
    #[ignore]
    fn remote_turn_works_here() {
        let account = crate::providers::discover().into_iter().find(|a| a.id == "claude").expect("a claude account");
        let host = crate::remote::Host { id: "ssh:1".into(), host: "127.0.0.1".into(), bridge: false, ..Default::default() };
        let mut ssh = crate::remote::ssh_opts(&crate::remote::Config::default(), &host);
        ssh.extend(["-o".into(), "UserKnownHostsFile=/tmp/harbor-dev-kh".into()]);
        let repo = std::env::temp_dir().join(format!("harbor-ws-e2e-{}", &crate::bridge::token().unwrap()[..8]));
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join("hello.txt"), "hello world\n").unwrap();
        let git = |args: &[&str]| Command::new("git").args(args).current_dir(&repo).output().unwrap();
        git(&["init", "-q"]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "init", "--allow-empty"]);
        git(&["add", "."]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hello"]);
        let spec = TurnSpec {
            chat_id: 999_998,
            cwd: repo.clone(),
            prompt: "Run `git status --short --branch` in the project, then change 'world' to 'harbor' in hello.txt with the edit tool, then run `git diff --stat`. Answer with only the first line git status printed.".into(),
            files: vec![],
            session_id: crate::store::new_uuid(),
            resume: false,
            account,
            model: "claude-haiku-5-5".into(),
            effort: String::new(),
            access: "full".into(),
            team: None,
            fast: false,
            base: 0,
            remote: Some(Remote { ssh, host: host.host.clone(), dir: crate::remote::remote_dir(&host, Some(&repo)), setup: vec![], bridge: false, commands: false, workspace: true, token: None, note: "You run on a test device.".into() }),
        };
        let (mut cmd, input, grant) = build(&spec).unwrap();
        let grant = grant.unwrap();
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        let mut sin = child.stdin.take().unwrap();
        {
            use std::io::Write;
            sin.write_all(input.unwrap().as_bytes()).unwrap();
        }
        let (mut tools, mut used, mut answer, mut remote_cwd) = (vec![], vec![], String::new(), String::new());
        for line in std::io::BufRead::lines(std::io::BufReader::new(child.stdout.take().unwrap())).map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v["type"] == "system" && v["subtype"] == "init" {
                tools = v["tools"].as_array().into_iter().flatten().filter_map(|t| t.as_str()).map(String::from).collect();
                remote_cwd = s(&v["cwd"]);
            }
            if v["type"] == "assistant" {
                for b in v["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "tool_use") {
                    used.push(s(&b["name"]));
                }
            }
            if v["type"] == "result" {
                answer = s(&v["result"]);
                break;
            }
        }
        drop(sin);
        let _ = child.wait();
        crate::bridge::revoke(&grant.token);
        eprintln!("cwd there: {remote_cwd}\ntools: {tools:?}\nused: {used:?}\nanswer: {answer}");
        for t in ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "LSP", "Monitor"] {
            assert!(!tools.iter().any(|x| x == t), "{t} wasn't disallowed");
        }
        assert!(tools.iter().any(|x| x == "mcp__origin__bash") && tools.iter().any(|x| x == "mcp__origin__edit"));
        assert!(used.iter().any(|x| x == "mcp__origin__bash") && used.iter().any(|x| x == "mcp__origin__edit"));
        assert_eq!(std::fs::read_to_string(repo.join("hello.txt")).unwrap(), "hello harbor\n");
        assert!(answer.contains("## "), "git status' branch line: {answer}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// Read only (plan) on this PC's files, from a real device:
    /// `HARBOR_TEST_DEVICE=acer cargo test -- --ignored remote_turn_reads_here --nocapture`
    /// (an ssh alias; default 127.0.0.1). The file only exists here.
    #[test]
    #[ignore]
    fn remote_turn_reads_here() {
        let account = crate::providers::discover().into_iter().find(|a| a.id == "claude").expect("a claude account");
        let dest = std::env::var("HARBOR_TEST_DEVICE").unwrap_or_else(|_| "127.0.0.1".into());
        let host = crate::remote::Host { id: "ssh:1".into(), host: dest.clone(), ..Default::default() };
        let mut ssh = crate::remote::ssh_opts(&crate::remote::Config::default(), &host);
        if dest == "127.0.0.1" {
            ssh.extend(["-o".into(), "UserKnownHostsFile=/tmp/harbor-dev-kh".into()]);
        }
        let secret = crate::bridge::token().unwrap();
        let dir = std::env::temp_dir().join(format!("harbor-ws-ro-{}", &secret[..8]));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.txt"), format!("the word is {}\n", &secret[..10])).unwrap();
        let spec = TurnSpec {
            chat_id: 999_997,
            cwd: dir.clone(),
            prompt: "Read note.txt in the project and answer with only the word after 'the word is'.".into(),
            files: vec![],
            session_id: crate::store::new_uuid(),
            resume: false,
            account,
            model: "claude-haiku-5-5".into(),
            effort: String::new(),
            access: "plan".into(),
            team: None,
            fast: false,
            base: 0,
            remote: Some(Remote { ssh, host: dest, dir: crate::remote::remote_dir(&host, Some(&dir)), setup: vec![], bridge: false, commands: false, workspace: true, token: None, note: "You run on a test device.".into() }),
        };
        let (mut cmd, input, grant) = build(&spec).unwrap();
        let grant = grant.unwrap();
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        let mut sin = child.stdin.take().unwrap();
        {
            use std::io::Write;
            sin.write_all(input.unwrap().as_bytes()).unwrap();
        }
        let (mut tools, mut answer, mut there) = (vec![], String::new(), String::new());
        for line in std::io::BufRead::lines(std::io::BufReader::new(child.stdout.take().unwrap())).map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v["type"] == "system" && v["subtype"] == "init" {
                tools = v["tools"].as_array().into_iter().flatten().filter_map(|t| t.as_str()).filter(|t| t.starts_with("mcp__") || ["Bash", "Read", "Edit", "Write"].contains(t)).map(String::from).collect();
                there = s(&v["cwd"]);
            }
            if v["type"] == "result" {
                answer = s(&v["result"]);
                break;
            }
        }
        drop(sin);
        let _ = child.wait();
        crate::bridge::revoke(&grant.token);
        let _ = std::fs::remove_dir_all(&dir);
        eprintln!("cwd there: {there}\ntools: {tools:?}\nanswer: {answer}");
        assert_eq!(tools, ["mcp__origin__glob", "mcp__origin__grep", "mcp__origin__read"]);
        assert!(answer.contains(&secret[..10]));
    }
}
