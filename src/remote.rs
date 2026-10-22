//! Remote devices that run agents: the user's PCs on Tailscale (`tailscale status`)
//! and SSH hosts added by hand. A chat pinned to one runs its Claude Code turns there,
//! over the system `ssh`, in that PC's folder and under that PC's Claude login. The
//! detached runner (detach.rs) runs `ssh` instead of `claude`, so the turn streams back,
//! takes mid-turn messages and survives a Harbor reload exactly like a local one.
//!
//! The bridge (bridge.rs) hands the remote agent this PC's MCP servers, Harbor's team
//! tools and, if allowed, commands on this PC, through an `ssh -R` port forward.

use crate::store;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// How old the Tailscale peer list may get while something shows it.
const REFRESH: Duration = Duration::from_secs(15);
/// The kv key the settings live under.
const KEY: &str = "remote_devices";

fn yes() -> bool {
    true
}

/// Settings › Devices, stored as JSON in the kv table.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    /// Tailscale devices are reached through `tailscale nc` (ssh's ProxyCommand), so
    /// they connect even without MagicDNS and work with Tailscale SSH on the device.
    #[serde(default = "yes")]
    pub tailscale: bool,
    /// Defaults for every device; empty / 0 leave it to ssh and ~/.ssh/config.
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub port: u16,
    /// Devices the user added or changed; Tailscale PCs not in here show with defaults.
    #[serde(default)]
    pub devices: Vec<Host>,
}

impl Default for Config {
    fn default() -> Self {
        Config { tailscale: true, user: String::new(), key: String::new(), port: 0, devices: vec![] }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Host {
    /// "ts:<MagicDNS label>" for Tailscale peers, "ssh:<n>" for hosts added by hand.
    pub id: String,
    /// Shown name; empty: the address.
    #[serde(default)]
    pub name: String,
    /// What ssh connects to: a MagicDNS name, an IP or a ~/.ssh/config alias.
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub port: u16,
    /// "" (by OS), a built-in icon name (see [`ICONS`]) or "file" (a copied image).
    #[serde(default)]
    pub icon: String,
    /// Folder agents start in. Empty: a project's path relative to home, mirrored on
    /// the device (~/Documents/app here → ~/Documents/app there), or ~ without one.
    #[serde(default)]
    pub dir: String,
    /// This PC's MCP servers and signed-in apps for agents there.
    #[serde(default = "yes")]
    pub bridge: bool,
    /// A `run_command` tool that runs shell commands on this PC.
    #[serde(default)]
    pub commands: bool,
    /// The agent works on the device's own files and shell. Off (the default): on this
    /// PC's project, through the bridge (workspace.rs), so edits and git stay together.
    #[serde(default)]
    pub device_files: bool,
    /// Not offered in the composer (Tailscale PCs can't be deleted, only hidden).
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub os: String,
    /// A Tailscale peer's other names (its IPs and machine name), for ~/.ssh/config.
    #[serde(skip)]
    pub aka: Vec<String>,
}

impl Host {
    pub fn label(&self) -> &str {
        match () {
            _ if !self.name.is_empty() => &self.name,
            // A MagicDNS name by its machine name: "desk.example.ts.net" → "desk".
            _ if self.tailscale() => self.host.split('.').next().unwrap_or(&self.host),
            _ => &self.host,
        }
    }

    pub fn tailscale(&self) -> bool {
        self.id.starts_with("ts:")
    }
}

/// Built-in icons a device can wear: name, glyph.
pub const ICONS: &[(&str, &str)] = &[
    ("monitor", crate::icons::MONITOR),
    ("laptop", crate::icons::LAPTOP),
    ("terminal", crate::icons::TERMINAL),
    ("house", crate::icons::HOUSE),
    ("globe", crate::icons::GLOBE),
    ("bot", crate::icons::BOT),
    ("hammer", crate::icons::HAMMER),
    ("gauge", crate::icons::GAUGE),
];

/// The glyph a device shows when it has no image.
pub fn glyph(h: &Host) -> &'static str {
    if let Some((_, g)) = ICONS.iter().find(|(n, _)| *n == h.icon) {
        return g;
    }
    match h.os.as_str() {
        "macOS" => crate::icons::LAPTOP,
        "" if !h.tailscale() => crate::icons::TERMINAL,
        _ => crate::icons::MONITOR,
    }
}

/// Where a device's custom image is copied to.
pub fn icon_path(id: &str) -> PathBuf {
    let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    store::data_dir().join("devices").join(safe)
}

/// This PC's name, as other devices know it.
pub fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname").map(|s| s.trim().to_string()).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "this PC".into())
}

pub fn load(s: &store::Store) -> Config {
    s.get(KEY).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save(s: &store::Store, c: &Config) {
    s.set(KEY, &serde_json::to_string(c).unwrap_or_default());
}

// ---------------------------------------------------------------- tailscale

#[derive(Clone, Default)]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub dns: String,
    pub ip: String,
    pub ips: Vec<String>,
    pub host_name: String,
    pub os: String,
    pub online: bool,
}

#[derive(Clone, Default)]
pub struct Tailnet {
    pub installed: bool,
    /// BackendState: "Running", "Stopped", "NeedsLogin"…; empty if it didn't answer.
    pub state: String,
    pub me: String,
    pub peers: Vec<Peer>,
}

/// Tailscale's OS names for machines that can run agents (phones can't).
fn is_pc(os: &str) -> bool {
    matches!(os, "linux" | "macOS" | "windows" | "freebsd" | "openbsd")
}

/// Parses `tailscale status --json`: the PCs among the peers.
pub fn parse_status(v: &Value) -> Tailnet {
    let mut peers: Vec<Peer> = v["Peer"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .filter(|p| is_pc(p["OS"].as_str().unwrap_or("")))
        .map(|p| {
            let dns = p["DNSName"].as_str().unwrap_or("").trim_end_matches('.').to_string();
            let label = dns.split('.').next().unwrap_or("").to_string();
            let ips: Vec<String> = p["TailscaleIPs"].as_array().into_iter().flatten().filter_map(|x| x.as_str()).map(String::from).collect();
            let ip = ips.first().cloned().unwrap_or_default();
            let name = p["HostName"].as_str().unwrap_or("").to_string();
            let host_name = name.clone();
            Peer {
                id: format!("ts:{}", if label.is_empty() { &name } else { &label }),
                name: if label.is_empty() { name } else { label },
                dns,
                ip,
                ips,
                host_name,
                os: p["OS"].as_str().unwrap_or("").to_string(),
                online: p["Online"].as_bool().unwrap_or(false),
            }
        })
        .collect();
    peers.sort_by(|a, b| b.online.cmp(&a.online).then(a.name.cmp(&b.name)));
    Tailnet {
        installed: true,
        state: v["BackendState"].as_str().unwrap_or("").to_string(),
        me: v["Self"]["DNSName"].as_str().unwrap_or("").split('.').next().unwrap_or("").to_string(),
        peers,
    }
}

fn read_tailnet() -> Tailnet {
    if crate::providers::which("tailscale").is_none() {
        return Tailnet::default();
    }
    let out = Command::new("tailscale").args(["status", "--json"]).stdin(Stdio::null()).stderr(Stdio::null()).output();
    match out.ok().and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok()) {
        Some(v) => parse_status(&v),
        None => Tailnet { installed: true, ..Default::default() },
    }
}

static TAILNET: LazyLock<Mutex<Option<(Instant, Tailnet)>>> = LazyLock::new(Default::default);
static READING: AtomicBool = AtomicBool::new(false);

/// The tailnet as last read; a stale one is read again in the background (`ctx`
/// repaints when it's in). Never blocks the UI.
pub fn tailnet(ctx: &eframe::egui::Context) -> Tailnet {
    let cur = TAILNET.lock().unwrap().clone();
    if cur.as_ref().is_none_or(|(at, _)| at.elapsed() > REFRESH) {
        refresh(ctx);
    }
    cur.map(|(_, t)| t).unwrap_or_default()
}

pub fn refresh(ctx: &eframe::egui::Context) {
    if READING.swap(true, Ordering::SeqCst) {
        return;
    }
    let ctx = ctx.clone();
    std::thread::spawn(move || {
        let t = read_tailnet();
        *TAILNET.lock().unwrap() = Some((Instant::now(), t));
        READING.store(false, Ordering::SeqCst);
        ctx.request_repaint();
    });
}

/// Every device: the configured ones, then Tailscale PCs not configured yet (with
/// defaults). Each with whether it's online (None: unknown, an SSH host never tested).
pub fn devices(cfg: &Config, net: &Tailnet) -> Vec<(Host, Option<bool>)> {
    let mut v: Vec<(Host, Option<bool>)> = cfg
        .devices
        .iter()
        .map(|h| {
            let peer = net.peers.iter().find(|p| p.id == h.id);
            let online = match peer {
                Some(p) => Some(p.online),
                None => probe(&h.id).and_then(|p| p.ok),
            };
            (Host { aka: peer.map(aka).unwrap_or_default(), ..h.clone() }, online)
        })
        .collect();
    for p in &net.peers {
        if !cfg.devices.iter().any(|h| h.id == p.id) {
            let host = Host { id: p.id.clone(), host: if p.dns.is_empty() { p.ip.clone() } else { p.dns.clone() }, os: p.os.clone(), bridge: true, aka: aka(p), ..Default::default() };
            v.push((host, Some(p.online)));
        }
    }
    v
}

fn aka(p: &Peer) -> Vec<String> {
    let mut v = p.ips.clone();
    v.extend([p.dns.clone(), p.name.clone(), p.host_name.clone()].into_iter().filter(|s| !s.is_empty()));
    v
}

/// A device by id, configured or discovered.
pub fn find(cfg: &Config, net: &Tailnet, id: &str) -> Option<Host> {
    devices(cfg, net).into_iter().map(|(h, _)| h).find(|h| h.id == id)
}

// ---------------------------------------------------------------- ssh

/// POSIX shell quoting (ssh joins its arguments into one remote command line).
pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A remote path for the shell: a leading ~ stays expandable.
fn shell_path(p: &str) -> String {
    match p {
        "~" | "" => "\"$HOME\"".into(),
        _ => match p.strip_prefix("~/") {
            Some(rest) => format!("\"$HOME\"/{}", quote(rest)),
            None => quote(p),
        },
    }
}

fn expand(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => store::home().join(rest).to_string_lossy().into_owned(),
        None => p.to_string(),
    }
}

/// ssh's options for a device, up to (not including) the destination.
pub fn ssh_opts(cfg: &Config, h: &Host) -> Vec<String> {
    let mut v: Vec<String> = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    // Its own connection (no ControlMaster): its port forward lives and dies with it.
    v.extend(["-o".into(), "ControlMaster=no".into(), "-o".into(), "ControlPath=none".into()]);
    if cfg.tailscale && h.tailscale() && crate::providers::which("tailscale").is_some() {
        v.extend(["-o".into(), "ProxyCommand=tailscale nc %h %p".into()]);
    }
    let found = ssh_config_entry(h).unwrap_or_default();
    let port = ssh_port(cfg, h);
    if port != 0 {
        v.extend(["-p".into(), port.to_string()]);
    }
    if !cfg.key.trim().is_empty() {
        v.extend(["-i".into(), expand(cfg.key.trim()), "-o".into(), "IdentitiesOnly=yes".into()]);
    } else if !found.key.is_empty() {
        v.extend(["-i".into(), expand(&found.key)]);
    }
    let user = login(cfg, h).map(|(u, _)| u).unwrap_or_default();
    if !user.is_empty() {
        v.extend(["-l".into(), user.to_string()]);
    }
    v
}

/// The port ssh connects to (0: its default).
pub fn ssh_port(cfg: &Config, h: &Host) -> u16 {
    [h.port, cfg.port].into_iter().find(|p| *p != 0).or_else(|| ssh_config_entry(h).map(|e| e.port)).unwrap_or(0)
}

/// The user ssh logs in as and whether it comes from ~/.ssh/config (None: ssh's default).
pub fn login(cfg: &Config, h: &Host) -> Option<(String, bool)> {
    [h.user.trim(), cfg.user.trim()]
        .into_iter()
        .find(|u| !u.is_empty())
        .map(|u| (u.to_string(), false))
        .or_else(|| ssh_config_entry(h).map(|e| e.user).filter(|u| !u.is_empty()).map(|u| (u, true)))
}

// ---------------------------------------------------------------- ~/.ssh/config

/// A `Host` block of ~/.ssh/config: what Harbor borrows when it connects by another name
/// (ssh only applies a block to the alias typed, and Harbor dials the MagicDNS name).
#[derive(Clone, Default, Debug, PartialEq)]
pub struct SshEntry {
    pub aliases: Vec<String>,
    pub host_name: String,
    pub user: String,
    pub port: u16,
    pub key: String,
}

/// Parses ssh_config text: `Host` blocks with plain aliases (wildcard patterns are
/// skipped), following `Include` of plain files through `read` (path relative to ~/.ssh).
pub fn parse_ssh_config(text: &str, read: &dyn Fn(&str) -> Option<String>, depth: u8) -> Vec<SshEntry> {
    let mut out: Vec<SshEntry> = vec![];
    // The block being read; None outside one (top level or under `Match`).
    let mut cur: Option<SshEntry> = None;
    let push = |cur: &mut Option<SshEntry>, out: &mut Vec<SshEntry>| {
        if let Some(mut e) = cur.take().filter(|e| !e.aliases.is_empty()) {
            if e.host_name.is_empty() {
                e.host_name = e.aliases[0].clone();
            }
            out.push(e);
        }
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, rest) = line.split_once(|c: char| c.is_whitespace() || c == '=').unwrap_or((line, ""));
        let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim();
        let val = rest.split_whitespace().next().unwrap_or("").trim_matches('"').to_string();
        match k.to_ascii_lowercase().as_str() {
            "host" => {
                push(&mut cur, &mut out);
                let aliases = rest.split_whitespace().map(|a| a.trim_matches('"')).filter(|a| !a.contains(['*', '?', '!'])).map(String::from).collect();
                cur = Some(SshEntry { aliases, ..Default::default() });
            }
            "match" => {
                push(&mut cur, &mut out);
            }
            "include" if depth < 4 => {
                push(&mut cur, &mut out);
                for f in rest.split_whitespace().filter(|f| !f.contains(['*', '?'])) {
                    if let Some(t) = read(f) {
                        out.extend(parse_ssh_config(&t, read, depth + 1));
                    }
                }
            }
            // The first value of an option wins, as in ssh.
            key => {
                if let Some(e) = cur.as_mut() {
                    match key {
                        "hostname" if e.host_name.is_empty() => e.host_name = val,
                        "user" if e.user.is_empty() => e.user = val,
                        "port" if e.port == 0 => e.port = val.parse().unwrap_or(0),
                        "identityfile" if e.key.is_empty() => e.key = val,
                        _ => {}
                    }
                }
            }
        }
    }
    push(&mut cur, &mut out);
    out
}

/// The first entry whose HostName (or alias) is one of `names`.
pub fn match_ssh_entry<'a>(entries: &'a [SshEntry], names: &[&str]) -> Option<&'a SshEntry> {
    let is = |s: &str| names.iter().any(|n| !n.is_empty() && n.eq_ignore_ascii_case(s));
    entries.iter().find(|e| is(&e.host_name)).or_else(|| entries.iter().find(|e| e.aliases.iter().any(|a| is(a))))
}

static SSH_CONFIG: LazyLock<Mutex<Option<(Instant, Vec<SshEntry>)>>> = LazyLock::new(Default::default);

fn ssh_config() -> Vec<SshEntry> {
    let mut g = SSH_CONFIG.lock().unwrap();
    if let Some((_, v)) = g.as_ref().filter(|(at, _)| at.elapsed() < Duration::from_secs(10)) {
        return v.clone();
    }
    let dir = store::home().join(".ssh");
    let read = |f: &str| std::fs::read_to_string(if f.starts_with('/') { PathBuf::from(f) } else if let Some(r) = f.strip_prefix("~/") { store::home().join(r) } else { dir.join(f) }).ok();
    let v = read("config").map(|t| parse_ssh_config(&t, &read, 0)).unwrap_or_default();
    *g = Some((Instant::now(), v.clone()));
    v
}

/// The ~/.ssh/config entry for a device dialed by a name ssh wouldn't match it under.
fn ssh_config_entry(h: &Host) -> Option<SshEntry> {
    let mut names: Vec<&str> = vec![h.host.trim()];
    names.extend(h.aka.iter().map(|s| s.as_str()));
    // A label like "home-desk" for "home-desk.example.ts.net".
    names.push(h.host.split('.').next().unwrap_or(""));
    let entries = ssh_config();
    match_ssh_entry(&entries, &names).cloned()
}

/// The folder a chat's agent starts in on the device (see [`Host::dir`]); home when
/// it works on this PC's files (the project needn't be there).
pub fn remote_dir(h: &Host, project: Option<&std::path::Path>) -> String {
    let dir = h.dir.trim().trim_end_matches('/');
    if !h.device_files {
        return "~".into();
    }
    match project {
        Some(p) if !dir.is_empty() => format!("{dir}/{}", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
        Some(p) => match p.strip_prefix(store::home()) {
            Ok(rel) if !rel.as_os_str().is_empty() => format!("~/{}", rel.display()),
            Ok(_) => "~".into(),
            Err(_) => p.to_string_lossy().into_owned(),
        },
        None if !dir.is_empty() => dir.to_string(),
        None => "~".into(),
    }
}

/// The command ssh runs on the device: a login shell (so PATH has the CLI, as in a
/// terminal there) that enters `dir`, runs the `setup` lines and starts `argv` on the
/// connection's stdin. A watchdog stops the agent when the connection goes away (ssh
/// gives a command without a terminal no SIGHUP), so stopping a turn here stops it there.
pub fn remote_command(dir: &str, setup: &[String], argv: &[String]) -> String {
    let mut s = format!("cd {} 2>/dev/null || {{ echo \"harbor: the folder {} doesn't exist on $(hostname)\" >&2; exit 97; }}\n", shell_path(dir), dir.replace(['"', '$', '`', '\\'], ""));
    for l in setup {
        s.push_str(l);
        s.push('\n');
    }
    s.push_str(&argv.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" "));
    s.push_str(
        " <&0 &\nc=$!\n( while kill -0 $PPID 2>/dev/null; do sleep 2; done; pkill -TERM -P $c; kill -TERM $c ) >/dev/null 2>&1 &\nw=$!\nwait $c; s=$?\nkill $w 2>/dev/null\nexit $s\n",
    );
    format!("if command -v bash >/dev/null 2>&1; then exec bash -lc {0}; else exec sh -lc {0}; fi", quote(&s))
}

/// A Claude profile (~/.claude2…) used on the device too when it has one there.
pub fn profile_setup(config_dir: Option<&std::path::Path>) -> Vec<String> {
    let Some(rel) = config_dir.and_then(|d| d.strip_prefix(store::home()).ok()).filter(|r| !r.as_os_str().is_empty()) else { return vec![] };
    let p = format!("\"$HOME\"/{}", quote(&rel.to_string_lossy()));
    vec![format!("[ -d {p} ] && export CLAUDE_CONFIG_DIR={p}")]
}

// ---------------------------------------------------------------- test connection

#[derive(Clone)]
pub struct Probe {
    pub running: bool,
    /// None while running.
    pub ok: Option<bool>,
    pub text: String,
}

static PROBES: LazyLock<Mutex<HashMap<String, Probe>>> = LazyLock::new(Default::default);

pub fn probe(id: &str) -> Option<Probe> {
    PROBES.lock().unwrap().get(id).cloned()
}

/// Connects to the device and checks for Claude Code there (in the background).
pub fn test(cfg: &Config, h: &Host, ctx: &eframe::egui::Context) {
    let mut cmd = test_command(cfg, h);
    let (id, ctx) = (h.id.clone(), ctx.clone());
    PROBES.lock().unwrap().insert(id.clone(), Probe { running: true, ok: None, text: "Connecting…".into() });
    std::thread::spawn(move || {
        let p = probe_result(cmd.output());
        PROBES.lock().unwrap().insert(id, p);
        ctx.request_repaint();
    });
}

fn test_command(cfg: &Config, h: &Host) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.args(ssh_opts(cfg, h)).arg(&h.host);
    cmd.arg(r#"if command -v bash >/dev/null 2>&1; then exec bash -lc 'echo HARBOR_OK; uname -sm; v=$(claude --version 2>/dev/null) && echo "claude $v" || echo "no claude"'; else echo HARBOR_OK; uname -sm; echo "no bash"; fi"#);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd
}

fn probe_result(out: std::io::Result<std::process::Output>) -> Probe {
    match out {
        Err(e) => Probe { running: false, ok: Some(false), text: format!("ssh: {e}") },
        Ok(o) => {
            let out = String::from_utf8_lossy(&o.stdout);
            if out.contains("HARBOR_OK") {
                let lines: Vec<&str> = out.lines().skip_while(|l| !l.contains("HARBOR_OK")).skip(1).collect();
                let sys = lines.first().copied().unwrap_or("");
                let cli = lines.get(1).copied().unwrap_or("");
                let ok = cli.starts_with("claude ");
                let text = if ok { format!("Connected · {sys} · {cli}") } else { format!("Connected · {sys} · Claude Code isn't installed there") };
                // Reachable but without the CLI still counts as online; the text says why.
                Probe { running: false, ok: Some(true), text }
            } else {
                let err = String::from_utf8_lossy(&o.stderr);
                let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no answer").trim().to_string();
                Probe { running: false, ok: Some(false), text: last }
            }
        }
    }
}

/// Opens a terminal on the device (for `claude /login` there, or a look around).
pub fn shell_argv(cfg: &Config, h: &Host, cmd: Option<&str>) -> Vec<String> {
    // Interactive: ssh may ask for a password or a host key here.
    let opts = ssh_opts(cfg, h);
    let mut out = vec!["ssh".to_string(), "-t".into()];
    out.extend(opts[2..].iter().cloned());
    out.push(h.host.clone());
    if let Some(c) = cmd {
        out.push(format!("bash -lc {}", quote(c)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tailscale_status() {
        let v: Value = serde_json::from_str(
            r#"{"BackendState":"Running","Self":{"DNSName":"me.tail.ts.net."},"Peer":{
                "a":{"HostName":"Box","DNSName":"box.tail.ts.net.","OS":"linux","Online":true,"TailscaleIPs":["100.1.2.3"]},
                "b":{"HostName":"Phone","DNSName":"phone.tail.ts.net.","OS":"android","Online":true,"TailscaleIPs":["100.1.2.4"]},
                "c":{"HostName":"Mac Air","DNSName":"mac-air.tail.ts.net.","OS":"macOS","Online":false,"TailscaleIPs":["100.1.2.5"]}}}"#,
        )
        .unwrap();
        let t = parse_status(&v);
        assert_eq!(t.state, "Running");
        assert_eq!(t.me, "me");
        assert_eq!(t.peers.len(), 2);
        assert_eq!((t.peers[0].id.as_str(), t.peers[0].dns.as_str(), t.peers[0].online), ("ts:box", "box.tail.ts.net", true));
        assert_eq!((t.peers[1].id.as_str(), t.peers[1].os.as_str()), ("ts:mac-air", "macOS"));
    }

    #[test]
    fn ssh_config_entries() {
        let text = "Host *\n  User nobody\nHost desk pc-*\n    HostName 10.0.0.11\n    User desk\n    User other\n    IdentityFile ~/.ssh/id_ed25519\n\
            Include extra\nHost laptop sam\n  HostName=10.0.0.95\n  User sam-work\nMatch all\n  User ignored\nHost a13\n  Port 8022\n";
        let read = |f: &str| (f == "extra").then(|| "Host box\n  HostName box.tail.ts.net\n  User boxer\n".to_string());
        let e = parse_ssh_config(text, &read, 0);
        assert_eq!(e.iter().map(|e| e.aliases.join(",")).collect::<Vec<_>>(), ["desk", "box", "laptop,sam", "a13"]);
        assert_eq!((e[0].user.as_str(), e[0].key.as_str()), ("desk", "~/.ssh/id_ed25519"));
        assert_eq!((e[3].host_name.as_str(), e[3].port), ("a13", 8022));
        let m = |names: &[&str]| match_ssh_entry(&e, names).map(|e| e.user.clone());
        assert_eq!(m(&["home-desk.tail.ts.net", "10.0.0.11"]), Some("desk".into()));
        assert_eq!(m(&["fd7a::1", "10.0.0.95"]), Some("sam-work".into()));
        assert_eq!(m(&["BOX.tail.ts.net"]), Some("boxer".into()));
        assert_eq!(m(&["sam"]), Some("sam-work".into()));
        assert_eq!(m(&["elsewhere", ""]), None);
    }

    /// The Test button's connection to real devices, logins from ~/.ssh/config:
    /// `HARBOR_TEST_DEVICES=home-desk,work-laptop cargo test -- --ignored devices_connect --nocapture`.
    #[test]
    #[ignore]
    fn devices_connect() {
        let net = read_tailnet();
        let cfg = Config::default();
        for name in std::env::var("HARBOR_TEST_DEVICES").unwrap_or_default().split(',').filter(|s| !s.is_empty()) {
            let h = find(&cfg, &net, &format!("ts:{name}")).expect("a Tailscale peer by that name");
            let p = probe_result(test_command(&cfg, &h).output());
            let who = Command::new("ssh").args(ssh_opts(&cfg, &h)).arg(&h.host).arg("whoami").stdin(Stdio::null()).output().unwrap();
            println!("{name}: login {:?} · {} · whoami {}", login(&cfg, &h), p.text, String::from_utf8_lossy(&who.stdout).trim());
            assert_eq!(p.ok, Some(true), "{name}: {}", p.text);
        }
    }

    #[test]
    fn remote_dirs() {
        let home = store::home();
        assert_eq!(remote_dir(&Host::default(), Some(&home.join("Documents/app"))), "~");
        let h = Host { device_files: true, ..Default::default() };
        assert_eq!(remote_dir(&h, Some(&home.join("Documents/app"))), "~/Documents/app");
        assert_eq!(remote_dir(&h, None), "~");
        let h = Host { dir: "~/work/".into(), device_files: true, ..Default::default() };
        assert_eq!(remote_dir(&h, Some(&home.join("Documents/app"))), "~/work/app");
        assert_eq!(remote_dir(&h, None), "~/work");
        assert_eq!(shell_path("~/a b"), "\"$HOME\"/'a b'");
        assert_eq!(shell_path("/srv/x"), "'/srv/x'");
    }

    #[test]
    fn remote_command_runs_in_a_login_shell() {
        let c = remote_command("~/p", &[], &["claude".into(), "-p".into(), "it's".into()]);
        assert!(c.starts_with("if command -v bash"));
        assert!(c.contains("exec bash -lc '"));
        // The script round-trips through sh: run it with `true` as the agent.
        let script = remote_command("/", &["export X=1".into()], &["sh".into(), "-c".into(), "echo \"$X $(cat)\"".into()]);
        let out = Command::new("sh").arg("-c").arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().and_then(|mut c| {
            use std::io::Write;
            c.stdin.take().unwrap().write_all(b"in")?;
            c.wait_with_output()
        });
        assert_eq!(String::from_utf8_lossy(&out.unwrap().stdout).trim(), "1 in");
    }

    /// Stopping a turn kills its local ssh; the agent on the device must go too.
    /// `cargo test -- --ignored agent_there_stops_with_ssh` (needs ssh to 127.0.0.1).
    #[test]
    #[ignore]
    fn agent_there_stops_with_ssh() {
        let h = Host { id: "ssh:1".into(), host: "127.0.0.1".into(), ..Default::default() };
        let running = || Command::new("pgrep").args(["-f", "sleep 347"]).output().is_ok_and(|o| o.status.success());
        let mut c = Command::new("ssh")
            .args(ssh_opts(&Config::default(), &h))
            .args(["-o", "UserKnownHostsFile=/tmp/harbor-dev-kh"])
            .arg(&h.host)
            .arg(remote_command("/tmp", &[], &["sleep".into(), "347".into()]))
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_secs(3));
        assert!(running(), "the agent didn't start there");
        c.kill().unwrap();
        let _ = c.wait();
        let t = Instant::now();
        while running() && t.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(!running(), "the agent outlived its ssh");
    }
}
