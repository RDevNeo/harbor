//! Remote devices that run agents: any PC with an SSH server and Claude Code (Linux, macOS,
//! BSD or Windows, with or without Harbor), added by hand or picked from ~/.ssh/config and
//! the PCs announcing ssh on the network (mDNS); the user's other PCs paired with this Harbor
//! (mesh.rs) and, while Tailscale is installed, its PCs too. ssh reaches the paired ones
//! through `harbor nc` (relay.rs): their network address, or another paired PC. Each device's
//! OS is found on its first connection and kept (`Host::os`): a POSIX shell gets a sh script,
//! Windows (cmd or PowerShell as OpenSSH's shell) a PowerShell one. A chat pinned to one runs its Claude Code turns there,
//! over the system `ssh`, in that PC's folder and as the account picked in Harbor (its
//! login travels on stdin, see oauth.rs; the device's own login only when the account
//! isn't signed in on this PC). The detached runner (detach.rs) runs `ssh` instead of
//! `claude`, so the turn streams back, takes mid-turn messages and survives a Harbor
//! reload exactly like a local one.
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

/// How old the list of PCs may get while something shows it.
const REFRESH: Duration = Duration::from_secs(15);
/// The kv key the settings live under.
const KEY: &str = "remote_devices";

fn yes() -> bool {
    true
}

/// Settings › Devices, stored as JSON in the kv table.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    /// (Before 0.14: "connect through Tailscale". PCs found by Harbor always go through
    /// `harbor nc` now; kept so old settings read.)
    #[serde(default = "yes")]
    pub tailscale: bool,
    /// Defaults for every device; empty / 0 leave it to ssh and ~/.ssh/config.
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub port: u16,
    /// Devices the user added or changed; PCs Harbor found that aren't in here show with defaults.
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
    /// A paired PC's peer id ("ts:<name>" for PCs paired before 0.13, "pc:<name>"), a Tailscale
    /// peer's "ts:<MagicDNS label>", or "ssh:<n>" for hosts added by hand.
    pub id: String,
    /// Shown name; empty: the address.
    #[serde(default)]
    pub name: String,
    /// What ssh connects to: an IP, a name or a ~/.ssh/config alias (found PCs: through `harbor nc`).
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
    /// Not offered in the composer (found PCs can't be deleted, only hidden).
    #[serde(default)]
    pub hidden: bool,
    /// "linux", "macOS", "windows", "freebsd"…: Tailscale's word, or what the device said
    /// when Harbor first connected ([`detect`]); empty until then (a POSIX shell is assumed).
    #[serde(default)]
    pub os: String,
    /// A found PC's other names (its IPs and machine name), for ~/.ssh/config.
    #[serde(skip)]
    pub aka: Vec<String>,
}

impl Host {
    pub fn label(&self) -> &str {
        match () {
            _ if !self.name.is_empty() => &self.name,
            // A found PC by its id's name, a MagicDNS name by its machine name.
            _ if self.found() => self.id.split_once(':').map(|(_, n)| n).unwrap_or(&self.host),
            _ => &self.host,
        }
    }

    /// A PC Harbor found (paired, or on Tailscale), not one added by hand.
    pub fn found(&self) -> bool {
        self.id.starts_with("ts:") || self.id.starts_with("pc:")
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
        "" if !h.found() => crate::icons::TERMINAL,
        _ => crate::icons::MONITOR,
    }
}

/// The OS as shown: "Linux", "macOS", "Windows", "FreeBSD"…
pub fn os_label(os: &str) -> String {
    match os {
        "linux" => "Linux".into(),
        "windows" => "Windows".into(),
        "freebsd" => "FreeBSD".into(),
        "openbsd" => "OpenBSD".into(),
        _ => os.to_string(),
    }
}

/// How a device's shell is spoken to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family {
    /// sh, bash, zsh, fish… (Linux, macOS, BSD): the command line goes to a login shell.
    Posix,
    /// Windows' OpenSSH: cmd or PowerShell as its shell; both start `powershell`.
    Windows,
}

pub fn family(os: &str) -> Family {
    if os.eq_ignore_ascii_case("windows") { Family::Windows } else { Family::Posix }
}

/// The OS word for what a device says of itself: `uname -s` ("Darwin", "Linux"…) or the
/// Windows probe's "Windows".
pub fn os_from(sys: &str) -> String {
    match sys.split_whitespace().next().unwrap_or("") {
        "" => String::new(),
        "Darwin" => "macOS".into(),
        w if w.eq_ignore_ascii_case("windows") || w.starts_with("MINGW") || w.starts_with("MSYS") || w.starts_with("CYGWIN") => "windows".into(),
        w => w.to_ascii_lowercase(),
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
    let peers: Vec<Peer> = v["Peer"]
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
    // Two peers with one id (a node shared in from another tailnet with the same first label,
    // or a HostName a peer chose): the one in this PC's own tailnet keeps it, the others go by
    // their full DNS name, and one with no DNS name isn't offered. Never the first that matches.
    let mine = v["Self"]["DNSName"].as_str().unwrap_or("").trim_end_matches('.').split_once('.').map(|x| x.1.to_string()).unwrap_or_default();
    let ids: Vec<String> = peers.iter().map(|p| p.id.clone()).collect();
    let own = |p: &Peer| !mine.is_empty() && p.dns.split_once('.').is_some_and(|x| x.1 == mine);
    let keeps: Vec<bool> = peers
        .iter()
        .map(|p| ids.iter().filter(|i| **i == p.id).count() == 1 || (own(p) && peers.iter().filter(|q| q.id == p.id && own(q)).count() == 1))
        .collect();
    let mut peers: Vec<Peer> = peers
        .into_iter()
        .zip(keeps)
        .filter_map(|(mut p, keep)| {
            if !keep {
                if p.dns.is_empty() {
                    return None;
                }
                p.id = format!("ts:{}", p.dns);
            }
            Some(p)
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

/// The PCs paired with this Harbor (keys on the allowed list), with what the mesh knows of them.
pub fn paired_pcs(allowed: &[crate::mesh::Allowed], peers: &HashMap<String, crate::mesh::Peer>) -> Vec<Peer> {
    allowed
        .iter()
        .filter(|a| !a.fp.is_empty() && !a.id.is_empty())
        .map(|a| {
            let p = peers.get(&a.id);
            let mut ips: Vec<String> = a.addrs.iter().chain(p.map(|p| p.addrs.iter()).into_iter().flatten()).filter_map(|x| x.parse::<std::net::SocketAddr>().ok()).map(|x| x.ip().to_string()).collect();
            ips.dedup();
            // The network's address first: ssh shows it, `harbor nc` tries them all.
            ips.sort_by_key(|i| i.parse().is_ok_and(crate::tls::tailnet_ip));
            let name = if a.name.is_empty() { crate::mesh::label(&a.id) } else { a.name.clone() };
            Peer {
                id: a.id.clone(),
                name: name.clone(),
                dns: String::new(),
                ip: ips.first().cloned().unwrap_or_default(),
                ips,
                host_name: crate::mesh::label(&a.id),
                os: "linux".into(),
                online: p.is_some_and(|p| p.online),
            }
        })
        .collect()
}

/// Every PC Harbor knows of: the paired ones, then (while it's installed) Tailscale's others.
fn read_tailnet() -> Tailnet {
    let mut net = match crate::api::HUB.get() {
        Some(hub) => {
            let allowed = hub.mesh.allowed.lock().unwrap().clone();
            let peers = hub.mesh.peers.lock().unwrap().clone();
            Tailnet { peers: paired_pcs(&allowed, &peers), ..Default::default() }
        }
        None => Tailnet::default(),
    };
    if crate::providers::which("tailscale").is_some() {
        let out = Command::new("tailscale").args(["status", "--json"]).stdin(Stdio::null()).stderr(Stdio::null()).output();
        let ts = match out.ok().and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok()) {
            Some(v) => parse_status(&v),
            None => Tailnet { installed: true, ..Default::default() },
        };
        net.installed = true;
        net.state = ts.state;
        net.me = ts.me;
        for p in ts.peers {
            if !net.peers.iter().any(|q| q.id == p.id) {
                net.peers.push(p);
            }
        }
    }
    net
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

/// Every device: the configured ones, then found PCs not configured yet (with
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
            // An OS just found by a test shows before the settings take it.
            let os = if h.os.is_empty() { probe(&h.id).map(|p| p.os).unwrap_or_default() } else { h.os.clone() };
            (Host { aka: peer.map(aka).unwrap_or_default(), os, ..h.clone() }, online)
        })
        .collect();
    // A Tailscale peer that is a device added by hand (the same machine) shows once, as that.
    let by_hand: Vec<String> = cfg.devices.iter().filter(|h| !h.found()).flat_map(|h| [first_label(&h.host), ssh_config_entry(h).map(|e| first_label(&e.host_name)).unwrap_or_default()]).filter(|n| !n.is_empty()).collect();
    for p in &net.peers {
        let added = p.id.starts_with("ts:") && [&p.name, &p.host_name, &p.dns].iter().any(|n| !n.is_empty() && by_hand.contains(&first_label(n)));
        if !cfg.devices.iter().any(|h| h.id == p.id) && !added {
            let host = Host { id: p.id.clone(), host: if p.dns.is_empty() { p.ip.clone() } else { p.dns.clone() }, name: if p.dns.is_empty() { p.name.clone() } else { String::new() }, os: p.os.clone(), bridge: true, aka: aka(p), ..Default::default() };
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
    // PCs Harbor found go through `harbor nc`: their network address, or another paired PC.
    if h.found() {
        if let Some(exe) = crate::update::self_exe() {
            v.extend(["-o".into(), format!("ProxyCommand={} nc --device {} %h %p", quote(&exe.to_string_lossy()), quote(&h.id))]);
        }
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

// ---------------------------------------------------------------- old Tailscale devices

/// A first label, lower case ("work-laptop" for "Work-Laptop.local").
fn first_label(s: &str) -> String {
    s.trim().split('.').next().unwrap_or("").to_ascii_lowercase()
}

/// An address that only answers while Tailscale runs: a MagicDNS name or a 100.64/10 IP.
fn tailnet_only(host: &str) -> bool {
    let h = host.trim().trim_end_matches('.');
    h.ends_with(".ts.net") || h.parse::<std::net::IpAddr>().is_ok_and(crate::tls::tailnet_ip)
}

/// Moves devices that were Tailscale peers (not PCs paired with this Harbor) onto plain ssh,
/// so they work without Tailscale: each becomes the hand-added device of the same machine
/// (one dialed by an ~/.ssh/config alias whose HostName or name is the peer's machine name),
/// an existing one or a new one with the old one's settings. Returns (old id, new id) for
/// the chats pinned to it. A peer with no such alias stays as it was.
pub fn migrate(cfg: &mut Config, allowed: &[crate::mesh::Allowed], entries: &[SshEntry]) -> Vec<(String, String)> {
    let mut moved = vec![];
    let old: Vec<Host> = cfg.devices.iter().filter(|h| h.id.starts_with("ts:") && tailnet_only(&h.host) && crate::relay::find_pc(allowed, &h.id, "").is_none()).cloned().collect();
    for h in old {
        let names: Vec<String> = [first_label(h.id.trim_start_matches("ts:")), first_label(&h.host)].into_iter().filter(|n| !n.is_empty()).collect();
        let is = |e: &SshEntry| !tailnet_only(&e.host_name) && (names.contains(&first_label(&e.host_name)) || e.aliases.iter().any(|a| names.contains(&a.to_ascii_lowercase())));
        let Some(e) = entries.iter().find(|e| is(e)) else { continue };
        // A device already added for it (by the alias, its HostName or the machine name).
        let same = |d: &Host| !d.found() && (e.aliases.iter().any(|a| a.eq_ignore_ascii_case(d.host.trim())) || first_label(&d.host) == first_label(&e.host_name) || names.contains(&first_label(&d.host)));
        let to = match cfg.devices.iter().find(|d| same(d)) {
            Some(d) => d.id.clone(),
            None => {
                let n = (1..).find(|n| !cfg.devices.iter().any(|d| d.id == format!("ssh:{n}"))).unwrap_or(1);
                let id = format!("ssh:{n}");
                let name = if h.name.is_empty() { h.id.trim_start_matches("ts:").to_string() } else { h.name.clone() };
                cfg.devices.push(Host { id: id.clone(), name, host: e.aliases[0].clone(), aka: vec![], ..h.clone() });
                id
            }
        };
        cfg.devices.retain(|d| d.id != h.id);
        moved.push((h.id.clone(), to));
    }
    moved
}

/// [`migrate`] with this PC's ~/.ssh/config.
pub fn migrate_here(cfg: &mut Config, allowed: &[crate::mesh::Allowed]) -> Vec<(String, String)> {
    migrate(cfg, allowed, &ssh_config())
}

// ---------------------------------------------------------------- nearby PCs

/// A PC the Add form offers: an ~/.ssh/config alias, or one announcing ssh on the network.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Nearby {
    /// Shown name: the alias, or the name the PC announces.
    pub name: String,
    /// What ssh dials: the alias, else the announced host name.
    pub host: String,
    pub user: String,
    pub port: u16,
    /// "ssh config", "network" or "ssh config · network".
    pub source: String,
    /// Its other names and IPs, to tell it's already a device.
    pub aka: Vec<String>,
}

/// Hosts in ~/.ssh/config that are code forges, not PCs.
fn forge(e: &SshEntry) -> bool {
    let h = e.host_name.to_ascii_lowercase();
    ["github.com", "gitlab.com", "bitbucket.org", "ssh.dev.azure.com", "codeberg.org"].iter().any(|f| h == *f || h.ends_with(&format!(".{f}"))) || e.user == "git"
}

/// Decodes avahi's `\DDD` escapes (decimal bytes) in a service name.
fn avahi_unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() && b[i + 1..i + 4].iter().all(u8::is_ascii_digit) {
            out.push(s[i + 1..i + 4].parse::<u16>().unwrap_or(63).min(255) as u8);
            i += 4;
        } else if b[i] == b'\\' && i + 1 < b.len() {
            out.push(b[i + 1]);
            i += 2;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses `avahi-browse -ptr` of `_ssh._tcp` / `_sftp-ssh._tcp`: (name, host name, address,
/// port) of each resolved one, once per host.
pub fn parse_avahi(text: &str) -> Vec<(String, String, String, u16)> {
    let mut v: Vec<(String, String, String, u16)> = vec![];
    for l in text.lines().filter(|l| l.starts_with("=;")) {
        let f: Vec<&str> = l.split(';').collect();
        if f.len() < 9 {
            continue;
        }
        let (name, host, ip, port) = (avahi_unescape(f[3]), f[6].trim_end_matches('.').to_string(), f[7].to_string(), f[8].parse().unwrap_or(22));
        // IPv4 first: a link-local IPv6 needs its interface to be dialed.
        match v.iter_mut().find(|x| x.1.eq_ignore_ascii_case(&host)) {
            Some(x) if x.2.contains(':') && !ip.contains(':') => x.2 = ip,
            Some(_) => {}
            None => v.push((name, host, ip, port)),
        }
    }
    v
}

/// The Add form's offers from ~/.ssh/config `entries` and the network's `announced` (see
/// [`parse_avahi`]): one per machine, the alias when there is one (it has the login).
pub fn nearby_from(entries: &[SshEntry], announced: &[(String, String, String, u16)], me: &[String]) -> Vec<Nearby> {
    // This PC itself (its name, addresses, localhost) isn't offered.
    let mine = |host: &str| host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()) || me.iter().any(|m| m.eq_ignore_ascii_case(host) || (host.parse::<std::net::IpAddr>().is_err() && first_label(m) == first_label(host)));
    let mut v: Vec<Nearby> = entries
        .iter()
        .filter(|e| !forge(e) && !e.aliases.is_empty() && !mine(&e.host_name))
        .map(|e| Nearby { name: e.aliases[0].clone(), host: e.aliases[0].clone(), user: String::new(), port: 0, source: "ssh config".into(), aka: e.aliases.iter().cloned().chain([e.host_name.clone()]).collect() })
        .collect();
    for (name, host, ip, port) in announced {
        if mine(host) || mine(ip) {
            continue;
        }
        let same = |n: &Nearby| n.aka.iter().any(|a| a.eq_ignore_ascii_case(host) || a == ip || first_label(a) == first_label(host));
        match v.iter_mut().find(|n| same(n)) {
            Some(n) => {
                n.source = "ssh config · network".into();
                n.aka.extend([host.clone(), ip.clone()]);
            }
            None => v.push(Nearby { name: name.clone(), host: host.clone(), user: String::new(), port: if *port == 22 { 0 } else { *port }, source: "network".into(), aka: vec![host.clone(), ip.clone()] }),
        }
    }
    v
}

/// Whether an offer is a device already (by any of its names).
pub fn is_device(n: &Nearby, devs: &[(Host, Option<bool>)]) -> bool {
    let ip = |s: &str| s.parse::<std::net::IpAddr>().is_ok();
    // The same name, or two host names of one machine ("mac" ≠ "mac.example": only names).
    let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b) || (!ip(a) && !ip(b) && first_label(a) == first_label(b));
    let offer: Vec<&str> = std::iter::once(n.host.as_str()).chain(n.aka.iter().map(String::as_str)).filter(|s| !s.is_empty()).collect();
    devs.iter().any(|(h, _)| {
        let names: Vec<String> = std::iter::once(h.host.clone()).chain(h.aka.iter().cloned()).chain(ssh_config_entry(h).map(|e| e.host_name)).filter(|s| !s.is_empty()).collect();
        names.iter().any(|m| offer.iter().any(|a| same(m, a)))
    })
}

static NEARBY: LazyLock<Mutex<Option<(Instant, Vec<Nearby>)>>> = LazyLock::new(Default::default);
static BROWSING: AtomicBool = AtomicBool::new(false);

/// The Add form's offers, read again in the background when a minute old (`avahi-browse`,
/// when it's installed, answers from avahi's cache in about a second).
pub fn nearby(ctx: &eframe::egui::Context) -> Vec<Nearby> {
    let cur = NEARBY.lock().unwrap().clone();
    if cur.as_ref().is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(60)) && !BROWSING.swap(true, Ordering::SeqCst) {
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let mut text = String::new();
            if crate::providers::which("avahi-browse").is_some() {
                for svc in ["_ssh._tcp", "_sftp-ssh._tcp"] {
                    if let Ok(o) = Command::new("avahi-browse").args(["-ptr", svc]).stdin(Stdio::null()).stderr(Stdio::null()).output() {
                        text.push_str(&String::from_utf8_lossy(&o.stdout));
                    }
                }
            }
            let me: Vec<String> = std::iter::once(hostname()).chain(crate::tls::lan_addrs().iter().map(|a| a.to_string())).collect();
            let v = nearby_from(&ssh_config(), &parse_avahi(&text), &me);
            *NEARBY.lock().unwrap() = Some((Instant::now(), v));
            BROWSING.store(false, Ordering::SeqCst);
            ctx.request_repaint();
        });
    }
    cur.map(|(_, v)| v).unwrap_or_default()
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

/// What runs on the device before the agent, in its shell's own words.
#[derive(Clone, Debug, PartialEq)]
pub enum Setup {
    /// Takes the account's Claude login (an OAuth access token, the next stdin line; see
    /// oauth.rs) into `CLAUDE_CODE_OAUTH_TOKEN`, which Claude Code uses over the login saved
    /// on the device. Never an argument: ssh's command line shows in `ps` on both PCs.
    Token,
    /// Takes the next stdin line (the `--mcp-config` JSON, whose URLs hold the bridge's token)
    /// into an owner-only temp file, removed when the turn ends; [`MCP_CONFIG_ARG`] names it.
    /// Never an argument: anyone on either PC could read it in `ps` and use the bridge.
    Mcp,
    /// A Claude profile (~/.claude2…, relative to home) used there too when the device has
    /// it, so its settings and sessions there stay with the account.
    Profile(String),
    /// Claude Code resumes only sessions of the folder it runs in, so this session, started
    /// in another folder there (the chat moved between this PC's files and the device's) or
    /// in another Claude profile there (the chat switched account), is copied to this one's.
    Session(String),
    /// A line for a POSIX device's shell as it is (ignored on Windows).
    #[cfg_attr(not(test), allow(dead_code))]
    Sh(String),
}

/// How a turn starts on a device: ssh's remote command, and what goes on stdin before the
/// rest of the turn's input (Windows: the script itself, see [`launch`]).
#[derive(Clone, Debug, PartialEq)]
pub struct Launch {
    pub command: String,
    pub input: String,
}

/// The command for a device of `family` that enters `dir`, runs the `setup` and starts
/// `argv` (its CLI found as a terminal there would, or where its installers put it) on the
/// connection's stdin.
pub fn launch(family: Family, dir: &str, setup: &[Setup], argv: &[String]) -> Launch {
    match family {
        Family::Posix => Launch { command: remote_command(dir, setup, argv), input: String::new() },
        // cmd caps a command line at 8191 characters and the agent's prompt alone can be
        // longer: a short fixed command reads the script from the first stdin line.
        Family::Windows => Launch { command: ps_command(PS_BOOT), input: format!("{}\n", crate::agent::base64(ps_script(dir, setup, argv).as_bytes())) },
    }
}

/// The command ssh runs on a POSIX device: a login shell (so PATH has the CLI, as in a
/// terminal there) that enters `dir`, runs the `setup` lines, finds the CLI (see
/// [`path_lookup`]) and starts `argv` on the connection's stdin. A watchdog stops the
/// agent when the connection goes away (ssh gives a command without a terminal no
/// SIGHUP), so stopping a turn here stops it there.
pub fn remote_command(dir: &str, setup: &[Setup], argv: &[String]) -> String {
    let mut s = format!("cd {} 2>/dev/null || {{ echo \"harbor: the folder {} doesn't exist on $(hostname)\" >&2; exit 97; }}\n", shell_path(dir), dir.replace(['"', '$', '`', '\\'], ""));
    for l in setup {
        s.push_str(&sh_setup(l));
        s.push('\n');
    }
    s.push_str(&path_require(argv.first().map(String::as_str).unwrap_or("claude")));
    s.push_str(&argv.iter().map(|a| if a == MCP_CONFIG_ARG { "\"$HARBOR_MCP_CONFIG\"".to_string() } else { quote(a) }).collect::<Vec<_>>().join(" "));
    s.push_str(
        " <&0 &\nc=$!\n( while kill -0 $PPID 2>/dev/null; do sleep 2; done; pkill -TERM -P $c; kill -TERM $c ) >/dev/null 2>&1 &\nw=$!\nwait $c; s=$?\nkill $w 2>/dev/null\nexit $s\n",
    );
    format!("if command -v bash >/dev/null 2>&1; then exec bash -lc {0}; else exec sh -lc {0}; fi", quote(&s))
}

/// A [`Setup`] as a POSIX shell line. The shell reads a pipe byte by byte, so the agent's
/// `<&0` gets the rest of the input intact.
pub fn sh_setup(s: &Setup) -> String {
    match s {
        Setup::Token => "IFS= read -r CLAUDE_CODE_OAUTH_TOKEN && export CLAUDE_CODE_OAUTH_TOKEN".into(),
        Setup::Mcp => r#"IFS= read -r HARBOR_MCP; HARBOR_MCP_CONFIG=$(umask 077; mktemp) && printf '%s\n' "$HARBOR_MCP" > "$HARBOR_MCP_CONFIG" && trap 'rm -f "$HARBOR_MCP_CONFIG"' EXIT; unset HARBOR_MCP"#.into(),
        Setup::Profile(rel) => {
            let p = format!("\"$HOME\"/{}", quote(rel));
            format!("[ -d {p} ] && export CLAUDE_CONFIG_DIR={p}")
        }
        Setup::Session(id) => {
            let f = quote(&format!("{id}.jsonl"));
            format!(
                "c=\"${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects\"; d=\"$c/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')\"; [ -e \"$d\"/{f} ] || {{ s=$(ls \"$c\"/*/{f} 2>/dev/null | head -n1); [ -n \"$s\" ] || s=$(ls \"$HOME\"/.claude*/projects/*/{f} 2>/dev/null | head -n1); [ -n \"$s\" ] && mkdir -p \"$d\" && cp \"$s\" \"$d\"/; }}"
            )
        }
        Setup::Sh(l) => l.clone(),
    }
}

/// Where the CLI's installers put it, for a device whose login shell isn't bash (a Mac:
/// zsh, so `bash -l` sees none of ~/.zprofile's PATH): the native installer, the CLI's
/// own local install, Homebrew, bun, npm, mise and volta.
const CLI_DIRS: [&str; 8] = ["$HOME/.local/bin", "$HOME/.claude/local", "/opt/homebrew/bin", "/usr/local/bin", "$HOME/.bun/bin", "$HOME/.npm-global/bin", "$HOME/.local/share/mise/shims", "$HOME/.volta/bin"];

/// Shell lines for the device: when `bin` isn't on the PATH, the first of [`CLI_DIRS`]
/// holding it is put in front; failing that, where a zsh login shell finds it (its
/// stdin is /dev/null, so it can't eat the connection's input). PATH stays exported.
pub fn path_lookup(bin: &str) -> String {
    let b = quote(bin);
    let dirs = CLI_DIRS.iter().map(|d| format!("\"{d}\"")).collect::<Vec<_>>().join(" ");
    format!(
        "command -v {b} >/dev/null 2>&1 || for d in {dirs}; do [ -x \"$d\"/{b} ] && {{ PATH=\"$d:$PATH\"; break; }}; done\n\
         command -v {b} >/dev/null 2>&1 || ! command -v zsh >/dev/null 2>&1 || {{ p=$(zsh -lic 'command -v '{b} </dev/null 2>/dev/null | tail -n1); [ -n \"$p\" ] && [ -x \"$p\" ] && PATH=\"$(dirname \"$p\"):$PATH\"; }}\n\
         export PATH\n"
    )
}

/// [`path_lookup`], then a clear word and exit 98 when `bin` still isn't there (the
/// agent's own "command not found" names no machine and no fix).
fn path_require(bin: &str) -> String {
    let shown = bin.replace(['"', '$', '`', '\\'], "");
    let name = if bin == "claude" { "Claude Code".to_string() } else { shown };
    format!("{}command -v {} >/dev/null 2>&1 || {{ echo \"harbor: {name} isn't on the PATH of a login shell on $(hostname); install it or add it to ~/.bash_profile\" >&2; exit 98; }}\n", path_lookup(bin), quote(bin))
}

/// The argument [`launch`] turns into the path of the file [`Setup::Mcp`] wrote.
pub const MCP_CONFIG_ARG: &str = "@harbor-mcp-config";

/// The profile setup for an account whose Claude config lives in a profile folder under home
/// (~/.claude2…); none for the default one.
pub fn profile_setup(config_dir: Option<&std::path::Path>) -> Vec<Setup> {
    let Some(rel) = config_dir.and_then(|d| d.strip_prefix(store::home()).ok()).filter(|r| !r.as_os_str().is_empty()) else { return vec![] };
    vec![Setup::Profile(rel.to_string_lossy().into_owned())]
}

// ---------------------------------------------------------------- windows

/// PowerShell quoting: a single-quoted string (PowerShell takes the typographic single
/// quotes for quotes too, so they're doubled as well).
pub fn ps_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// A command line that runs a PowerShell script whatever OpenSSH's shell is there (cmd,
/// Windows PowerShell, pwsh, or a bash): `powershell` with the script UTF-16 and base64, so
/// no shell on the way reads a character of it.
pub fn ps_command(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    format!("powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}", crate::agent::base64(&utf16))
}

/// The fixed command of a Windows turn: reads stdin's first line byte by byte (a buffered
/// reader would take the agent's input with it), decodes it (base64 UTF-8) and runs it.
/// `HarborLine` reads the next lines the same way.
const PS_BOOT: &str = "$ProgressPreference='SilentlyContinue';$HarborIn=[Console]::OpenStandardInput();function HarborLine{$b=New-Object System.Collections.Generic.List[byte];while(($c=$HarborIn.ReadByte()) -ge 0 -and $c -ne 10){if($c -ne 13){$b.Add([byte]$c)}};[Text.Encoding]::UTF8.GetString($b.ToArray())};. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((HarborLine)))))";

/// A path for PowerShell: ~ is the user's profile folder; `/` works as a separator there.
fn ps_path(p: &str) -> String {
    match p {
        "~" | "" => "$HOME".into(),
        _ => match p.strip_prefix("~/") {
            Some(rest) => format!("(Join-Path $HOME {})", ps_quote(rest)),
            None => ps_quote(p),
        },
    }
}

/// Where the CLI's Windows installers put it: the native installer, npm, bun, scoop, winget,
/// mise and volta.
const WIN_CLI_DIRS: [&str; 7] = [
    "$env:USERPROFILE\\.local\\bin",
    "$env:APPDATA\\npm",
    "$env:USERPROFILE\\.bun\\bin",
    "$env:USERPROFILE\\scoop\\shims",
    "$env:LOCALAPPDATA\\Microsoft\\WinGet\\Links",
    "$env:LOCALAPPDATA\\mise\\shims",
    "$env:LOCALAPPDATA\\Volta\\bin",
];

/// PowerShell lines that set `$HarborExe` (and `$HarborPre`, arguments before the agent's) to
/// `bin`: from the PATH, else the first of [`WIN_CLI_DIRS`] with `bin`.exe or .cmd. An npm
/// .cmd shim is skipped for `node cli.js` (cmd would reread the arguments' quotes and `%`).
fn ps_lookup(bin: &str) -> String {
    let b = ps_quote(bin);
    let dirs = WIN_CLI_DIRS.iter().map(|d| format!("\"{d}\"")).collect::<Vec<_>>().join(",");
    let names = format!("{},{}", ps_quote(&format!("{bin}.exe")), ps_quote(&format!("{bin}.cmd")));
    format!(
        "$HarborExe=$null;$HarborPre=@()\n\
         $c=Get-Command {b} -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n\
         if($c){{$HarborExe=$c.Path}}else{{foreach($d in @({dirs})){{foreach($n in @({names})){{$f=Join-Path $d $n;if(Test-Path -LiteralPath $f){{$HarborExe=$f;break}}}};if($HarborExe){{break}}}}}}\n\
         if($HarborExe -and $HarborExe -match '\\.(cmd|bat)$'){{$js=Join-Path (Split-Path $HarborExe) 'node_modules\\@anthropic-ai\\claude-code\\cli.js';$node=Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1;if($node -and (Test-Path -LiteralPath $js)){{$HarborPre=@($js);$HarborExe=$node.Path}}}}\n\
         if($HarborExe){{$env:PATH=(Split-Path $HarborExe)+';'+$env:PATH}}\n"
    )
}

/// A [`Setup`] as PowerShell (stdin lines through the boot's `HarborLine`).
fn ps_setup(s: &Setup) -> String {
    match s {
        Setup::Token => "$env:CLAUDE_CODE_OAUTH_TOKEN=(HarborLine)".into(),
        // The user's temp folder is theirs alone (its ACL), as mktemp's file is on POSIX.
        Setup::Mcp => "$HarborMcp=[IO.Path]::GetTempFileName();$HarborClean+=$HarborMcp;[IO.File]::WriteAllText($HarborMcp,(HarborLine)+\"`n\");$env:HARBOR_MCP_CONFIG=$HarborMcp".into(),
        Setup::Profile(rel) => format!("$p=Join-Path $HOME {};if(Test-Path -LiteralPath $p -PathType Container){{$env:CLAUDE_CONFIG_DIR=$p}}", ps_quote(rel)),
        Setup::Session(id) => {
            let f = ps_quote(&format!("{id}.jsonl"));
            format!(
                "$c=Join-Path $(if($env:CLAUDE_CONFIG_DIR){{$env:CLAUDE_CONFIG_DIR}}else{{Join-Path $HOME '.claude'}}) 'projects';$d=Join-Path $c ((Get-Location).ProviderPath -replace '[^A-Za-z0-9]','-')\n\
                 if(-not (Test-Path -LiteralPath (Join-Path $d {f}))){{$s=Get-ChildItem -Path $c -Directory -ErrorAction SilentlyContinue | ForEach-Object {{Join-Path $_.FullName {f}}} | Where-Object {{Test-Path -LiteralPath $_}} | Select-Object -First 1\n\
                 if(-not $s){{$s=Get-ChildItem -Path $HOME -Directory -Filter '.claude*' -Force -ErrorAction SilentlyContinue | ForEach-Object {{Get-ChildItem -Path (Join-Path $_.FullName 'projects') -Directory -ErrorAction SilentlyContinue}} | ForEach-Object {{Join-Path $_.FullName {f}}} | Where-Object {{Test-Path -LiteralPath $_}} | Select-Object -First 1}}\n\
                 if($s){{New-Item -ItemType Directory -Force -Path $d | Out-Null;Copy-Item -LiteralPath $s -Destination $d}}}}"
            )
        }
        Setup::Sh(_) => String::new(),
    }
}

/// The PowerShell script of a Windows turn (run by [`PS_BOOT`]): enters `dir`, runs the
/// setup, finds the CLI and starts it with `argv`'s arguments quoted as Windows programs
/// read them (CommandLineToArgvW; PowerShell 5's own passing drops inner quotes), on the
/// connection's stdin and stdout (inherited). Exit 97 / 98 as on POSIX.
pub fn ps_script(dir: &str, setup: &[Setup], argv: &[String]) -> String {
    let bin = argv.first().map(String::as_str).unwrap_or("claude");
    let shown = dir.replace(['"', '$', '`'], "");
    let name = if bin == "claude" { "Claude Code".to_string() } else { bin.replace(['"', '$', '`'], "") };
    let mut s = format!(
        "$ErrorActionPreference='Stop';$HarborClean=@();$HarborCode=1\n\
         try{{Set-Location -LiteralPath {}}}catch{{[Console]::Error.WriteLine(\"harbor: the folder {shown} doesn't exist on $env:COMPUTERNAME\");exit 97}}\n\
         try{{\n",
        ps_path(dir)
    );
    for l in setup {
        let l = ps_setup(l);
        if !l.is_empty() {
            s.push_str(&l);
            s.push('\n');
        }
    }
    s.push_str(&ps_lookup(bin));
    s.push_str(&format!("if(-not $HarborExe){{[Console]::Error.WriteLine(\"harbor: {name} isn't on the PATH on $env:COMPUTERNAME; install it (irm https://claude.ai/install.ps1 | iex) or add its folder to your user PATH\");exit 98}}\n"));
    let args = argv.iter().skip(1).map(|a| if a == MCP_CONFIG_ARG { "$env:HARBOR_MCP_CONFIG".to_string() } else { ps_quote(a) }).collect::<Vec<_>>().join(",");
    s.push_str(&format!(
        "$HarborArgs=@($HarborPre)+@({args})\n\
         function HarborQ($a){{if($a -ne '' -and $a -notmatch '[\\s\"]'){{return $a}};'\"'+(($a -replace '(\\\\*)\"','$1$1\\\"') -replace '(\\\\+)$','$1$1')+'\"'}}\n\
         $p=New-Object System.Diagnostics.Process\n\
         $p.StartInfo.FileName=$HarborExe\n\
         $p.StartInfo.Arguments=(($HarborArgs | ForEach-Object {{HarborQ ([string]$_)}}) -join ' ')\n\
         $p.StartInfo.UseShellExecute=$false\n\
         $p.StartInfo.WorkingDirectory=(Get-Location).ProviderPath\n\
         [void]$p.Start();$p.WaitForExit();$HarborCode=$p.ExitCode\n\
         }}finally{{$HarborClean | ForEach-Object {{Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue}}}}\n\
         exit $HarborCode\n"
    ));
    s
}

/// Windows' rule for one argument on a command line (what `HarborQ` in [`ps_script`] does),
/// for the tests: quotes when it's empty or has blanks or quotes; backslashes doubled only
/// before a quote.
#[cfg(test)]
fn win_arg(a: &str) -> String {
    if !a.is_empty() && !a.contains([' ', '\t', '\n', '\r', '"']) && !a.chars().any(char::is_whitespace) {
        return a.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in a.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

// ---------------------------------------------------------------- test connection

#[derive(Clone)]
pub struct Probe {
    pub running: bool,
    /// None while running.
    pub ok: Option<bool>,
    pub text: String,
    /// The OS the device said it runs ([`os_from`]); empty when it didn't answer.
    pub os: String,
}

static PROBES: LazyLock<Mutex<HashMap<String, Probe>>> = LazyLock::new(Default::default);

pub fn probe(id: &str) -> Option<Probe> {
    PROBES.lock().unwrap().get(id).cloned()
}

/// Connects to the device and checks for Claude Code there (in the background). A device
/// of unknown OS is asked as a POSIX one first, then as Windows (one connection for most).
pub fn test(cfg: &Config, h: &Host, ctx: &eframe::egui::Context) {
    let (cfg, h, ctx) = (cfg.clone(), h.clone(), ctx.clone());
    PROBES.lock().unwrap().insert(h.id.clone(), Probe { running: true, ok: None, text: "Connecting…".into(), os: String::new() });
    std::thread::spawn(move || {
        let p = run_probe(&cfg, &h);
        PROBES.lock().unwrap().insert(h.id.clone(), p);
        ctx.request_repaint();
    });
}

/// [`test`] for a device not tested yet this session (an SSH host added by hand: its online
/// dot and OS come from it).
pub fn test_once(cfg: &Config, h: &Host, ctx: &eframe::egui::Context) {
    if !h.found() && !h.host.trim().is_empty() && probe(&h.id).is_none() {
        test(cfg, h, ctx);
    }
}

/// The OS of a device as it says (empty: it didn't answer), blocking.
#[cfg(test)]
pub fn detect(cfg: &Config, h: &Host) -> String {
    run_probe(cfg, h).os
}

fn run_probe(cfg: &Config, h: &Host) -> Probe {
    let first = family(&h.os);
    let out = test_command(cfg, h, first).output();
    // ssh's own failures exit 255; anything else that didn't answer is a shell that didn't
    // read the script: the other family's.
    let other = match &out {
        Ok(o) if !String::from_utf8_lossy(&o.stdout).contains("HARBOR_OK") && o.status.code() != Some(255) => Some(if first == Family::Posix { Family::Windows } else { Family::Posix }),
        _ => None,
    };
    let p = probe_result(out);
    match other {
        Some(f) => {
            let q = probe_result(test_command(cfg, h, f).output());
            if q.ok == Some(true) { q } else { p }
        }
        None => p,
    }
}

fn test_command(cfg: &Config, h: &Host, f: Family) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.args(ssh_opts(cfg, h)).arg(&h.host);
    // The same lookup as a turn's (`launch`), so the test tells the same truth.
    match f {
        Family::Posix => {
            let script = format!("echo HARBOR_OK; uname -sm\n{}v=$(claude --version 2>/dev/null) && echo \"claude $v\" || echo \"no claude\"", path_lookup("claude"));
            cmd.arg(format!("if command -v bash >/dev/null 2>&1; then exec bash -lc {}; else echo HARBOR_OK; uname -sm; echo \"no bash\"; fi", quote(&script)));
        }
        Family::Windows => {
            let script = format!(
                "[Console]::Out.WriteLine('HARBOR_OK');[Console]::Out.WriteLine(\"Windows $env:PROCESSOR_ARCHITECTURE\")\n{}if($HarborExe){{$v=& $HarborExe @($HarborPre+'--version') 2>$null | Select-Object -First 1;[Console]::Out.WriteLine(\"claude $v\")}}else{{[Console]::Out.WriteLine('no claude')}}",
                ps_lookup("claude")
            );
            cmd.arg(ps_command(&script));
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd
}

fn probe_result(out: std::io::Result<std::process::Output>) -> Probe {
    match out {
        Err(e) => Probe { running: false, ok: Some(false), text: format!("ssh: {e}"), os: String::new() },
        Ok(o) => {
            let out = String::from_utf8_lossy(&o.stdout);
            if out.contains("HARBOR_OK") {
                let lines: Vec<&str> = out.lines().map(str::trim).skip_while(|l| !l.contains("HARBOR_OK")).skip(1).collect();
                let sys = lines.first().copied().unwrap_or("");
                let cli = lines.get(1).copied().unwrap_or("");
                let ok = cli.starts_with("claude ") && cli.len() > "claude ".len();
                let text = if ok { format!("Connected · {sys} · {cli}") } else { format!("Connected · {sys} · Claude Code isn't installed there") };
                // Reachable but without the CLI still counts as online; the text says why.
                Probe { running: false, ok: Some(true), text, os: os_from(sys) }
            } else {
                let err = String::from_utf8_lossy(&o.stderr);
                let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no answer").trim().to_string();
                Probe { running: false, ok: Some(false), text: last, os: String::new() }
            }
        }
    }
}

/// Takes the OS the devices said into the settings (for a device whose OS isn't known, or
/// changed); whether anything changed.
pub fn adopt_os(cfg: &mut Config) -> bool {
    let probes = PROBES.lock().unwrap();
    let mut changed = false;
    for h in cfg.devices.iter_mut() {
        if let Some(p) = probes.get(&h.id).filter(|p| !p.os.is_empty() && p.os != h.os) {
            // A found PC keeps Tailscale's or the mesh's word unless it had none.
            if !h.found() || h.os.is_empty() {
                h.os = p.os.clone();
                changed = true;
            }
        }
    }
    changed
}

/// Opens a terminal on the device (for `claude /login` there, or a look around).
pub fn shell_argv(cfg: &Config, h: &Host, cmd: Option<&str>) -> Vec<String> {
    // Interactive: ssh may ask for a password or a host key here.
    let opts = ssh_opts(cfg, h);
    let mut out = vec!["ssh".to_string(), "-t".into()];
    out.extend(opts[2..].iter().cloned());
    out.push(h.host.clone());
    if let Some(c) = cmd {
        match family(&h.os) {
            Family::Posix => out.push(format!("bash -lc {}", quote(c))),
            // `c` is the CLI and its arguments ("claude /login").
            Family::Windows => {
                let mut words = c.split_whitespace();
                let bin = words.next().unwrap_or("claude");
                let args = words.map(ps_quote).collect::<Vec<_>>().join(" ");
                out.push(ps_command(&format!("{}if($HarborExe){{& $HarborExe @HarborPre {args}}}else{{Write-Host \"{bin} isn't installed here\"}}", ps_lookup(bin))));
            }
        }
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
    fn tailscale_ids_are_never_ambiguous() {
        // A look-alike shared in from another tailnet, online while the own one is off.
        let st = |peers: &str| parse_status(&serde_json::from_str(&format!(r#"{{"Self":{{"DNSName":"me.mytail.ts.net."}},"Peer":{{{peers}}}}}"#)).unwrap());
        let net = st(r#""a":{"HostName":"desk","DNSName":"desk.mytail.ts.net.","OS":"linux","Online":false},
                        "b":{"HostName":"desk","DNSName":"desk.other.ts.net.","OS":"linux","Online":true}"#);
        let cfg = Config::default();
        assert_eq!(find(&cfg, &net, "ts:desk").unwrap().host, "desk.mytail.ts.net");
        assert_eq!(find(&cfg, &net, "ts:desk.other.ts.net").unwrap().host, "desk.other.ts.net");
        // No DNS name: its HostName is the peer's own choice, so it can't take an id.
        let net = st(r#""a":{"HostName":"desk","DNSName":"desk.mytail.ts.net.","OS":"linux","Online":false},
                        "b":{"HostName":"desk","DNSName":"","OS":"linux","Online":true}"#);
        assert_eq!(net.peers.len(), 1);
        assert_eq!(find(&cfg, &net, "ts:desk").unwrap().host, "desk.mytail.ts.net");
        // Neither in this tailnet: neither is "desk".
        let net = st(r#""a":{"HostName":"desk","DNSName":"desk.one.ts.net.","OS":"linux"},
                        "b":{"HostName":"desk","DNSName":"desk.two.ts.net.","OS":"linux"}"#);
        assert!(find(&cfg, &net, "ts:desk").is_none());
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

    /// The Test button's connection to real devices added by hand (any OS), logins from
    /// ~/.ssh/config: `HARBOR_TEST_DEVICES=desk,192.0.2.7 cargo test -- --ignored devices_connect --nocapture`.
    #[test]
    #[ignore]
    fn devices_connect() {
        let cfg = Config::default();
        for name in std::env::var("HARBOR_TEST_DEVICES").unwrap_or_default().split(',').filter(|s| !s.is_empty()) {
            let h = Host { id: format!("ssh:{name}"), host: name.into(), ..Default::default() };
            let p = run_probe(&cfg, &h);
            let who = Command::new("ssh").args(ssh_opts(&cfg, &h)).arg(&h.host).arg("whoami").stdin(Stdio::null()).output().unwrap();
            println!("{name}: login {:?} · {} · os {} · whoami {}", login(&cfg, &h), p.text, p.os, String::from_utf8_lossy(&who.stdout).trim());
            assert_eq!(p.ok, Some(true), "{name}: {}", p.text);
            assert!(!p.os.is_empty(), "{name}: no OS");
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
        let script = remote_command("/", &[Setup::Sh("export X=1".into())], &["sh".into(), "-c".into(), "echo \"$X $(cat)\"".into()]);
        let out = Command::new("sh").arg("-c").arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().and_then(|mut c| {
            use std::io::Write;
            c.stdin.take().unwrap().write_all(b"in")?;
            c.wait_with_output()
        });
        assert_eq!(String::from_utf8_lossy(&out.unwrap().stdout).trim(), "1 in");
    }

    /// The account's login goes first on stdin and comes out as an environment variable
    /// of the agent; what follows it (the stream-json messages) reaches the agent intact.
    #[test]
    fn token_setup_takes_the_first_stdin_line() {
        let setup = [Setup::Token, Setup::Sh("export X=1".into())];
        let script = remote_command("/", &setup, &["sh".into(), "-c".into(), "printf '%s|%s|' \"$CLAUDE_CODE_OAUTH_TOKEN\" \"$X\"; cat".into()]);
        assert!(!script.contains("sk-ant-oat01"));
        let run = |input: &str| {
            let out = Command::new("sh").arg("-c").arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).env_remove("CLAUDE_CODE_OAUTH_TOKEN").spawn().and_then(|mut c| {
                use std::io::Write;
                c.stdin.take().unwrap().write_all(input.as_bytes())?;
                c.wait_with_output()
            });
            String::from_utf8_lossy(&out.unwrap().stdout).into_owned()
        };
        assert_eq!(run("sk-ant-oat01-abc\n{\"type\":\"user\"}\n{\"n\":2}\n"), "sk-ant-oat01-abc|1|{\"type\":\"user\"}\n{\"n\":2}\n");
        // Without a login line (the account isn't signed in here) nothing is read.
        let plain = remote_command("/", &[Setup::Sh("export X=1".into())], &["sh".into(), "-c".into(), "printf '%s|%s|' \"$CLAUDE_CODE_OAUTH_TOKEN\" \"$X\"; cat".into()]);
        let out = Command::new("sh").arg("-c").arg(&plain).stdin(Stdio::piped()).stdout(Stdio::piped()).env_remove("CLAUDE_CODE_OAUTH_TOKEN").spawn().and_then(|mut c| {
            use std::io::Write;
            c.stdin.take().unwrap().write_all(b"{\"n\":1}\n")?;
            c.wait_with_output()
        });
        assert_eq!(String::from_utf8_lossy(&out.unwrap().stdout), "|1|{\"n\":1}\n");
    }

    /// The MCP config (it holds the bridge's token) comes after the login on stdin, reaches
    /// the agent as an owner-only file named by `--mcp-config`, and is gone after the turn.
    #[test]
    fn mcp_config_travels_on_stdin() {
        let setup = [Setup::Token, Setup::Mcp];
        let argv: Vec<String> = ["sh", "-c", "printf '%s|%s|%s|%s|' \"$CLAUDE_CODE_OAUTH_TOKEN\" \"$1\" \"$(cat \"$1\")\" \"$(stat -c %a \"$1\")\"; cat", "sh", MCP_CONFIG_ARG].iter().map(|s| s.to_string()).collect();
        let script = remote_command("/", &setup, &argv);
        assert!(!script.contains("secret-grant"));
        let out = Command::new("sh").arg("-c").arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).env_remove("CLAUDE_CODE_OAUTH_TOKEN").spawn().and_then(|mut c| {
            use std::io::Write;
            c.stdin.take().unwrap().write_all(b"sk-ant-oat01-abc\n{\"url\":\"http://127.0.0.1:1/secret-grant/origin\"}\n{\"type\":\"user\"}\n")?;
            c.wait_with_output()
        });
        let out = String::from_utf8_lossy(&out.unwrap().stdout).into_owned();
        let parts: Vec<&str> = out.split('|').collect();
        assert_eq!(parts[0], "sk-ant-oat01-abc");
        assert_eq!(parts[2], "{\"url\":\"http://127.0.0.1:1/secret-grant/origin\"}");
        assert_eq!(parts[3], "600");
        assert_eq!(parts[4], "{\"type\":\"user\"}\n");
        assert!(!parts[1].is_empty() && !std::path::Path::new(parts[1]).exists(), "the config file outlived the turn: {}", parts[1]);
    }

    /// A CLI that a bash login shell doesn't see (a Mac's PATH lives in zsh files) is
    /// found where its installers put it; one that isn't anywhere ends the turn with a
    /// line that names the machine, not bash's "command not found".
    #[test]
    fn remote_command_finds_the_cli_off_the_login_path() {
        let home = std::env::temp_dir().join(format!("harbor-home-{}", crate::bridge::token().unwrap()));
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        let cli = home.join(".local/bin/harbor-fake-cli");
        std::fs::write(&cli, "#!/bin/sh\necho \"fake $1 $(cat)\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run = |argv: &[&str]| {
            let script = remote_command("/", &[], &argv.iter().map(|a| a.to_string()).collect::<Vec<_>>());
            let out = Command::new("sh").arg("-c").arg(&script).env("HOME", &home).env("PATH", "/usr/bin:/bin").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().and_then(|mut c| {
                use std::io::Write;
                c.stdin.take().unwrap().write_all(b"in")?;
                c.wait_with_output()
            });
            let out = out.unwrap();
            (out.status.code(), String::from_utf8_lossy(&out.stdout).trim().to_string(), String::from_utf8_lossy(&out.stderr).trim().to_string())
        };
        assert_eq!(run(&["harbor-fake-cli", "--version"]), (Some(0), "fake --version in".into(), String::new()));
        let (code, out, err) = run(&["harbor-missing-cli"]);
        assert_eq!((code, out.as_str()), (Some(98), ""));
        assert!(err.ends_with("install it or add it to ~/.bash_profile"), "{err}");
        assert!(err.starts_with("harbor: harbor-missing-cli isn't on the PATH of a login shell on "), "{err}");
        // Claude by its product name, and the Test button's script with the same lookup.
        assert!(path_require("claude").contains("harbor: Claude Code isn't on the PATH"));
        let probe = test_command(&Config::default(), &Host::default(), Family::Posix);
        let arg = probe.get_args().last().unwrap().to_string_lossy().into_owned();
        assert!(arg.contains("HARBOR_OK") && arg.contains("/opt/homebrew/bin") && arg.contains("zsh -lic"));
        // A zsh login shell is asked last, with no stdin to swallow.
        assert!(path_lookup("claude").contains("</dev/null"));
        let _ = std::fs::remove_dir_all(&home);
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

    #[test]
    fn os_words() {
        assert_eq!(os_from("Darwin arm64"), "macOS");
        assert_eq!(os_from("Linux x86_64"), "linux");
        assert_eq!(os_from("FreeBSD amd64"), "freebsd");
        assert_eq!(os_from("Windows AMD64"), "windows");
        assert_eq!(os_from("MINGW64_NT-10.0-22631 x86_64"), "windows");
        assert_eq!(os_from(""), "");
        assert_eq!((family("windows"), family("macOS"), family("")), (Family::Windows, Family::Posix, Family::Posix));
        assert_eq!(os_label("windows"), "Windows");
    }

    /// The Test button tells the OS whichever way the device answered.
    #[test]
    fn probe_reads_the_os() {
        let out = |stdout: &str, code: i32| {
            use std::os::unix::process::ExitStatusExt;
            Ok(std::process::Output { status: std::process::ExitStatus::from_raw(code << 8), stdout: stdout.as_bytes().to_vec(), stderr: b"boom\n".to_vec() })
        };
        let p = probe_result(out("motd\nHARBOR_OK\r\nWindows AMD64\r\nclaude 2.1.0 (Claude Code)\r\n", 0));
        assert_eq!((p.ok, p.os.as_str(), p.text.as_str()), (Some(true), "windows", "Connected · Windows AMD64 · claude 2.1.0 (Claude Code)"));
        let p = probe_result(out("HARBOR_OK\nDarwin arm64\nno claude\n", 0));
        assert_eq!((p.ok, p.os.as_str()), (Some(true), "macOS"));
        assert!(p.text.ends_with("Claude Code isn't installed there"));
        // A Windows box with no CLI prints an empty version.
        assert!(!probe_result(out("HARBOR_OK\nWindows ARM64\nclaude \n", 0)).text.contains("· claude"));
        let p = probe_result(out("", 1));
        assert_eq!((p.ok, p.os.as_str(), p.text.as_str()), (Some(false), "", "boom"));
    }

    #[test]
    fn powershell_quoting() {
        assert_eq!(ps_quote("it's"), "'it''s'");
        assert_eq!(ps_quote("a\u{2019}b"), "'a\u{2019}\u{2019}b'");
        assert_eq!(ps_quote("$env:X `n \"q\""), "'$env:X `n \"q\"'");
        assert_eq!(ps_path("~"), "$HOME");
        assert_eq!(ps_path("~/Documents/my app"), "(Join-Path $HOME 'Documents/my app')");
        assert_eq!(ps_path("D:\\work"), "'D:\\work'");
        assert_eq!(win_arg("plain"), "plain");
        assert_eq!(win_arg(""), "\"\"");
        assert_eq!(win_arg("a b"), "\"a b\"");
        assert_eq!(win_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(win_arg("C:\\dir\\"), "C:\\dir\\");
        assert_eq!(win_arg("C:\\my dir\\"), "\"C:\\my dir\\\\\"");
        assert_eq!(win_arg("\\\\\"x"), "\"\\\\\\\\\\\"x\"");
    }

    /// cmd's command line is at most 8191 characters: a Windows turn's command is the same
    /// short line however long its prompt, and nothing secret is in it.
    #[test]
    fn windows_turn_command_is_short_and_fixed() {
        let long = "x".repeat(20_000);
        let argv: Vec<String> = ["claude", "-p", "--append-system-prompt", &long, "--mcp-config", MCP_CONFIG_ARG].iter().map(|s| s.to_string()).collect();
        let a = launch(Family::Windows, "~/Documents/app", &[Setup::Token, Setup::Mcp], &argv);
        let b = launch(Family::Windows, "~", &[], &["claude".into()]);
        assert_eq!(a.command, b.command);
        assert!(a.command.len() < 2000, "{}", a.command.len());
        assert!(a.command.starts_with("powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "));
        // The encoded command is UTF-16LE base64 of the boot script.
        let b64 = a.command.rsplit(' ').next().unwrap();
        let bytes = unbase64(b64);
        let u16s: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16(&u16s).unwrap(), PS_BOOT);
        // The script is the first stdin line, and only one line.
        assert!(a.input.ends_with('\n') && a.input.matches('\n').count() == 1);
        let script = String::from_utf8(unbase64(a.input.trim_end())).unwrap();
        assert_eq!(script, ps_script("~/Documents/app", &[Setup::Token, Setup::Mcp], &argv));
        let at = |n: &str| script.find(n).unwrap_or_else(|| panic!("{n:?} not in {script}"));
        assert!(at("Set-Location -LiteralPath (Join-Path $HOME 'Documents/app')") < at("$env:CLAUDE_CODE_OAUTH_TOKEN=(HarborLine)"));
        assert!(at("$env:CLAUDE_CODE_OAUTH_TOKEN=") < at("$env:HARBOR_MCP_CONFIG=$HarborMcp"));
        assert!(at("$env:HARBOR_MCP_CONFIG=$HarborMcp") < at("Get-Command 'claude'"));
        assert!(script.contains("'--mcp-config',$env:HARBOR_MCP_CONFIG)"));
        // Where Windows installers put the CLI, npm's shim run through node.
        for d in ["$env:USERPROFILE\\.local\\bin", "$env:APPDATA\\npm", "'claude.exe','claude.cmd'", "node_modules\\@anthropic-ai\\claude-code\\cli.js"] {
            assert!(script.contains(d), "{d}");
        }
        // POSIX setup lines don't leak into PowerShell.
        assert!(!ps_script("~", &[Setup::Sh("export X=1".into())], &["claude".into()]).contains("export X"));
    }

    #[test]
    fn windows_terminal_and_probe_go_through_powershell() {
        let h = Host { id: "ssh:1".into(), host: "winbox".into(), os: "windows".into(), ..Default::default() };
        let argv = shell_argv(&Config::default(), &h, Some("claude /login"));
        assert_eq!(argv[argv.len() - 2], "winbox");
        assert!(argv.last().unwrap().starts_with("powershell -NoLogo"));
        assert!(!argv.last().unwrap().contains("bash"));
        // No command: ssh's own shell there.
        assert_eq!(shell_argv(&Config::default(), &h, None).last().unwrap(), "winbox");
        let t = test_command(&Config::default(), &h, Family::Windows);
        assert!(t.get_args().last().unwrap().to_string_lossy().starts_with("powershell "));
    }

    fn unbase64(s: &str) -> Vec<u8> {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = vec![];
        let mut acc = 0u32;
        let mut bits = 0;
        for c in s.bytes().filter(|c| *c != b'=') {
            acc = acc << 6 | T.iter().position(|t| *t == c).unwrap() as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
            }
        }
        out
    }

    /// PowerShell for the Windows tests: `HARBOR_TEST_PWSH` (a pwsh binary; PowerShell 7 runs
    /// on Linux too), else `pwsh` on the PATH; None skips them.
    fn pwsh() -> Option<PathBuf> {
        std::env::var_os("HARBOR_TEST_PWSH").map(PathBuf::from).or_else(|| crate::providers::which("pwsh")).filter(|p| p.exists())
    }

    /// A Windows turn run for real by PowerShell (7, on this PC): the script comes off stdin,
    /// the login and the MCP config are the next lines, the agent gets every argument exactly
    /// (quotes, backslashes, newlines, non-ASCII) and the rest of stdin intact, its exit code
    /// is the turn's, and the MCP file is gone afterwards.
    #[test]
    fn windows_turn_runs_under_powershell() {
        let Some(pwsh) = pwsh() else {
            eprintln!("skipped: no pwsh (set HARBOR_TEST_PWSH)");
            return;
        };
        let root = std::env::temp_dir().join(format!("harbor-ps-{}", crate::bridge::token().unwrap()));
        let (bin, work) = (root.join("bin"), root.join("my work"));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        // `powershell` is what ssh runs there.
        std::os::unix::fs::symlink(&pwsh, bin.join("powershell")).unwrap();
        let cli = bin.join("harbor-fake-cli");
        std::fs::write(&cli, "#!/usr/bin/env python3\nimport json,os,sys\nm=sys.argv[-1]\nprint(json.dumps({'argv':sys.argv[1:],'token':os.environ.get('CLAUDE_CODE_OAUTH_TOKEN'),'mcp':open(m).read(),'mode':oct(os.stat(m).st_mode&0o777),'cwd':os.getcwd(),'stdin':sys.stdin.read()}))\nsys.exit(7)\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let tricky = ["-p", "it's \"quoted\"", "back\\slash\\", "C:\\my dir\\", "", "line one\nline two", "naïve ✓ ‘curly’", "$env:PATH %OS% `tick`", "a\\\\\"b"];
        let mut argv: Vec<String> = vec!["harbor-fake-cli".into()];
        argv.extend(tricky.iter().map(|s| s.to_string()));
        argv.push(MCP_CONFIG_ARG.into());
        let l = launch(Family::Windows, &work.to_string_lossy(), &[Setup::Token, Setup::Mcp], &argv);
        let path = format!("{}:/usr/bin:/bin", bin.display());
        let run = |command: &str, input: &str| {
            let mut c = Command::new("sh").arg("-c").arg(command).env("PATH", &path).env("HOME", &root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).env_remove("CLAUDE_CODE_OAUTH_TOKEN").spawn().unwrap();
            use std::io::Write;
            c.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
            let o = c.wait_with_output().unwrap();
            (o.status.code(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
        };
        let input = format!("{}sk-ant-oat01-abc\n{{\"mcpServers\":{{}}}}\n{{\"type\":\"user\"}}\n{{\"n\":2}}\n", l.input);
        let (code, out, err) = run(&l.command, &input);
        assert_eq!(code, Some(7), "{out}\n{err}");
        let v: Value = serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("{e}: {out}\n{err}"));
        let got: Vec<String> = v["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
        assert_eq!(got[..tricky.len()], tricky.map(String::from));
        assert_eq!(v["token"], "sk-ant-oat01-abc");
        assert_eq!(v["mcp"], "{\"mcpServers\":{}}\n");
        assert_eq!(v["mode"], "0o600");
        assert_eq!(v["stdin"], "{\"type\":\"user\"}\n{\"n\":2}\n");
        assert_eq!(std::fs::canonicalize(v["cwd"].as_str().unwrap()).unwrap(), std::fs::canonicalize(&work).unwrap());
        assert!(!std::path::Path::new(got.last().unwrap()).exists(), "the MCP config outlived the turn");
        // No folder, no CLI: the same words and codes as on POSIX.
        let l = launch(Family::Windows, "/nowhere/at-all", &[], &argv);
        let (code, _, err) = run(&l.command, &l.input);
        assert_eq!(code, Some(97), "{err}");
        assert!(err.contains("harbor: the folder /nowhere/at-all doesn't exist on"), "{err}");
        let l = launch(Family::Windows, "~", &[], &["harbor-missing-cli".into()]);
        let (code, _, err) = run(&l.command, &l.input);
        assert_eq!(code, Some(98), "{err}");
        assert!(err.contains("harbor: harbor-missing-cli isn't on the PATH on"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A resumed session is copied into the folder's projects (and a profile picked) by the
    /// PowerShell lines as by the sh ones.
    #[test]
    fn windows_session_and_profile_setup() {
        let Some(pwsh) = pwsh() else { return };
        let root = std::env::temp_dir().join(format!("harbor-pss-{}", crate::bridge::token().unwrap()));
        let work = root.join("my work");
        std::fs::create_dir_all(root.join(".claude2/projects/-elsewhere")).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(root.join(".claude2/projects/-elsewhere/abc.jsonl"), "{}").unwrap();
        let script = format!(
            "Set-Location -LiteralPath {}\n{}\n{}\n[Console]::Out.WriteLine($env:CLAUDE_CONFIG_DIR)",
            ps_quote(&work.to_string_lossy()),
            ps_setup(&Setup::Profile(".claude2".into())),
            ps_setup(&Setup::Session("abc".into()))
        );
        let o = Command::new(&pwsh).args(["-NoProfile", "-NonInteractive", "-Command", &script]).env("HOME", &root).env_remove("CLAUDE_CONFIG_DIR").output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), root.join(".claude2").to_string_lossy());
        let slug: String = work.canonicalize().unwrap().to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        assert!(root.join(".claude2/projects").join(slug).join("abc.jsonl").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tailscale_devices_move_to_ssh() {
        let cfg_text = "Host mac\n  HostName Mac-Air.local\n  User me\nHost acer\n  HostName 192.0.2.3\nHost gh\n  HostName github.com\n  User git\n";
        let entries = parse_ssh_config(cfg_text, &|_| None, 0);
        let ts = |id: &str, host: &str| Host { id: id.into(), name: "My Mac".into(), host: host.into(), os: "macOS".into(), bridge: true, icon: "laptop".into(), ..Default::default() };
        let paired = vec![crate::mesh::Allowed { fp: "f".into(), id: "ts:home-desk".into(), name: "home-desk".into(), ..Default::default() }];
        // A peer with an alias for its machine: a new SSH device with its settings.
        let mut cfg = Config { devices: vec![ts("ts:mac-air", "mac-air.example.ts.net"), ts("ts:home-desk", "home-desk.example.ts.net"), ts("ts:nobox", "nobox.example.ts.net")], ..Default::default() };
        let moved = migrate(&mut cfg, &paired, &entries);
        assert_eq!(moved, [("ts:mac-air".to_string(), "ssh:1".to_string())]);
        let m = cfg.devices.iter().find(|d| d.id == "ssh:1").unwrap();
        assert_eq!((m.host.as_str(), m.name.as_str(), m.os.as_str(), m.icon.as_str()), ("mac", "My Mac", "macOS", "laptop"));
        // A paired PC and a peer without an alias stay.
        assert!(cfg.devices.iter().any(|d| d.id == "ts:home-desk") && cfg.devices.iter().any(|d| d.id == "ts:nobox"));
        assert!(migrate(&mut cfg, &paired, &entries).is_empty(), "twice is once");
        // Already added by hand (the alias): its chats go there, nothing is added.
        let mut cfg = Config { devices: vec![ts("ts:mac-air", "mac-air.example.ts.net"), Host { id: "ssh:4".into(), host: "mac".into(), ..Default::default() }], ..Default::default() };
        assert_eq!(migrate(&mut cfg, &paired, &entries), [("ts:mac-air".to_string(), "ssh:4".to_string())]);
        assert_eq!(cfg.devices.len(), 1);
    }

    /// A Tailscale peer that is a device added by hand doesn't show twice.
    #[test]
    fn tailscale_peer_of_a_device_shows_once() {
        let net = Tailnet { peers: vec![Peer { id: "ts:work-laptop".into(), name: "work-laptop".into(), dns: "work-laptop.example.ts.net".into(), online: true, ..Default::default() }, Peer { id: "ts:other".into(), name: "other".into(), ..Default::default() }], ..Default::default() };
        let cfg = Config { devices: vec![Host { id: "ssh:1".into(), host: "Work-Laptop.local".into(), ..Default::default() }], ..Default::default() };
        assert_eq!(devices(&cfg, &net).iter().map(|(h, _)| h.id.as_str()).collect::<Vec<_>>(), ["ssh:1", "ts:other"]);
    }

    #[test]
    fn nearby_pcs() {
        let avahi = "+;wlo1;IPv6;Mac\\226\\128\\153s\\032Air;SSH Remote Terminal;local\n\
            =;wlo1;IPv6;Mac\\226\\128\\153s\\032Air;SSH Remote Terminal;local;Mac-Air.local;fe80::1;22;\n\
            =;wlo1;IPv4;Mac\\226\\128\\153s\\032Air;SSH Remote Terminal;local;Mac-Air.local;192.0.2.6;22;\n\
            =;wlo1;IPv4;Mac\\226\\128\\153s\\032Air;SFTP File Transfer;local;Mac-Air.local;192.0.2.6;22;\n\
            =;wlo1;IPv4;nas;SSH Remote Terminal;local;nas.local;192.0.2.9;2222;\n\
            =;wlo1;IPv4;me;SSH Remote Terminal;local;thispc.local;192.0.2.2;22;\n";
        let a = parse_avahi(avahi);
        assert_eq!(a.len(), 3);
        assert_eq!(a[0], ("Mac\u{2019}s Air".to_string(), "Mac-Air.local".to_string(), "192.0.2.6".to_string(), 22));
        let entries = parse_ssh_config("Host mac\n  HostName Mac-Air.local\nHost gh\n  HostName github.com\n  User git\nHost box\n  HostName 192.0.2.4\nHost self\n  HostName 192.0.2.2\nHost lo\n  HostName localhost\n", &|_| None, 0);
        let n = nearby_from(&entries, &a, &["thispc".into(), "192.0.2.2".into()]);
        assert_eq!(n.iter().map(|n| (n.host.as_str(), n.source.as_str(), n.port)).collect::<Vec<_>>(), [("mac", "ssh config · network", 0), ("box", "ssh config", 0), ("nas.local", "network", 2222)]);
        // Offers that are devices already don't show.
        let devs = vec![(Host { id: "ssh:1".into(), host: "box".into(), ..Default::default() }, None), (Host { id: "pc:nas".into(), host: "192.0.2.50".into(), aka: vec!["nas".into()], ..Default::default() }, None)];
        assert!(is_device(&n[1], &devs) && is_device(&n[2], &devs) && !is_device(&n[0], &devs));
    }
}
