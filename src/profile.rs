//! Who is who, filled in: each PC detects its owner's name and GitHub login itself.
//!
//! The owner used to type both by hand (meshctx.rs), and PCs where nobody did said "owner not
//! set". Now each PC gathers what it can find about its person and its peers ([`gather`]):
//! the account's full name, `git config`, the GitHub logins signed in (`gh`, Harbor's apps),
//! the agent accounts' names and emails, its paired phones' names ("A13 de Ana"), the SSH
//! hosts, users and key comments it knows, the global CLAUDE.md, and what the mesh's PCs say
//! about themselves. One short Haiku question through the PC's own Claude account turns that
//! into a profile per PC ([`ask_model`]); without a signed-in account, plain rules do it
//! ([`heuristic`]). Only names, logins, emails and comments are read: never key material,
//! tokens or passwords ([`scrub`] drops anything that looks like one).
//!
//! What comes out is a *suggestion* (kv [`KEY`]): it fills in where nothing was typed,
//! everywhere the old fallbacks were used, and says "detected, not confirmed" until the user
//! confirms it (Settings › Devices, the phone's People and memory sheet, a one-time pop-up).
//! A value the user typed always wins and is never overwritten. Peers send their own
//! detection over `hello`/`/mesh/v1/phones` (`owner_suggested`); this PC's guesses about a
//! peer only show while that peer says nothing itself (one before this change).

use crate::store::{self, Store};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, Sender, channel};

/// kv: the last detection, a [`Detected`].
pub const KEY: &str = "owner_suggested";
/// Seconds after startup before the first detection.
const STARTUP_WAIT: u64 = 25;
/// kv: the suggestion the pop-up was closed for (`owner|github`).
pub const TOAST_KEY: &str = "owner_toast_dismissed";

const SYSTEM: &str = "You work out who owns which PC of a person's Harbor mesh (Harbor runs AI coding agents and links the owner's PCs and phones) from facts the PCs found about themselves. You have no tools. Answer with JSON only.";

const PROMPT: &str = "For every PC in <facts>, propose its owner's name (the person who uses it, as they would write it: \"Ana Souza\", not a login) and their GitHub login.

Rules:
- A PC that reports an owner itself (reported_owner, detected false) keeps it.
- The strongest signals for this_pc: git user.name, the full name, the GitHub logins signed in, the default agent account (default_profile) and its email. Other agent accounts, phones and SSH entries on a PC can belong to other people (a family member, a colleague who shares the PC): only use them for a PC's owner when they point at that PC.
- A phone named after a person (\"A13 de Ana\", \"Ana's Pixel\") names someone who uses that PC, not necessarily its owner.
- For another PC: SSH hosts whose alias, host or user matches its name, key comments naming it, and what it reports.
- Give a GitHub login only with evidence (a signed-in login, a users.noreply.github.com email, a remote or note naming it). Never invent one; use \"\" when unknown. Same for the owner.
- confidence: \"high\" when two independent signals agree, \"medium\" for one good signal, \"low\" for a guess.
- why: one short line naming the evidence (\"git user.name and gh login on this PC\").

Answer with only this JSON: {\"pcs\": {\"<pc id>\": {\"owner\": \"\", \"github\": \"\", \"confidence\": \"low\", \"why\": \"\"}}}";

/// One PC's proposed profile.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Proposal {
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub github: String,
    #[serde(default)]
    pub confidence: String,
    #[serde(default)]
    pub why: String,
}

/// A detection: this PC's own profile, its guesses about its peers, and how it was made.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Detected {
    #[serde(default)]
    pub me: Proposal,
    #[serde(default)]
    pub peers: BTreeMap<String, Proposal>,
    /// "claude-haiku-…" or "rules".
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub at: i64,
    /// What it saw (peers, phones, accounts): a change starts the next one.
    #[serde(default)]
    pub sig: String,
}

pub fn load(s: &Store) -> Option<Detected> {
    s.get(KEY).and_then(|t| serde_json::from_str(&t).ok())
}

// ================================================================ what a PC knows

/// Another PC, or this one, as the mesh has it.
#[derive(Clone, Debug, Default, Serialize)]
pub struct PcFacts {
    pub id: String,
    pub name: String,
    pub this_pc: bool,
    /// What it says about itself (empty: nothing, or an old Harbor).
    pub reported_owner: String,
    pub reported_github: String,
    /// Its own report is a detection it hasn't had confirmed.
    pub detected: bool,
    pub phones: Vec<String>,
    pub agent_accounts: Vec<String>,
}

/// An agent account signed in on this PC.
#[derive(Clone, Debug, Default, Serialize)]
pub struct AccountFacts {
    pub label: String,
    pub name: String,
    pub email: String,
    /// The PC's default profile (~/.claude): its person's own login.
    pub default_profile: bool,
}

/// What the app knows (taken on the UI thread); [`gather`] adds the files.
#[derive(Clone, Debug, Default)]
pub struct Inputs {
    pub pcs: Vec<PcFacts>,
    pub accounts: Vec<AccountFacts>,
    /// The account to ask: (binary, environment).
    pub ask: Option<(String, Vec<(String, Option<String>)>)>,
}

/// An SSH host entry: alias, host name (never an address) and user.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SshHost {
    pub alias: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub host: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub user: String,
}

/// This PC's own facts (files and commands).
#[derive(Clone, Debug, Default, Serialize)]
pub struct Local {
    pub hostname: String,
    pub os_user: String,
    pub full_name: String,
    pub git_name: String,
    pub git_email: String,
    pub github_logins: Vec<String>,
    pub ssh_hosts: Vec<SshHost>,
    /// Comments of the keys allowed to log in here (authorized_keys).
    pub authorized_key_comments: Vec<String>,
    /// Comments of this user's own public keys.
    pub own_key_comments: Vec<String>,
    /// Host names (not addresses) this user has connected to.
    pub known_hosts: Vec<String>,
    /// The start of the global CLAUDE.md, scrubbed.
    pub claude_md: String,
}

/// A word that could be a secret: key material, a token, a long random string.
fn secret_word(w: &str) -> bool {
    let w = w.trim_matches(|c: char| "\"'`,;()[]{}<>".contains(c));
    const PREFIXES: &[&str] = &["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk-", "xox", "AKIA", "eyJ", "AAAA", "glpat-", "npm_"];
    if w.len() >= 12 && PREFIXES.iter().any(|p| w.starts_with(p)) {
        return true;
    }
    // Long runs of base64/hex with digits mixed in (emails, paths and URLs are fine).
    let run = w.len() >= 24 && w.chars().all(|c| c.is_ascii_alphanumeric() || "+/=_-".contains(c));
    run && w.chars().any(|c| c.is_ascii_digit()) && w.chars().any(|c| c.is_ascii_alphabetic())
}

/// Lines that hold a secret go; secret-looking words in the others are blanked.
pub fn scrub(text: &str) -> String {
    text.lines()
        .filter(|l| {
            let low = l.to_lowercase();
            let names_secret = ["password", "passwd", "secret", "token", "api_key", "apikey", "private key", "bearer "].iter().any(|k| low.contains(k));
            let assigns = l.contains('=') || l.contains(':');
            !(names_secret && assigns) && !low.contains("begin ") && !low.contains("private key")
        })
        .map(|l| l.split(' ').map(|w| if secret_word(w) { "[redacted]" } else { w }).collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_address(h: &str) -> bool {
    h.parse::<std::net::IpAddr>().is_ok() || h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok()
}

/// `~/.ssh/config`: each `Host` with its `HostName` (names only) and `User`.
pub fn parse_ssh_config(text: &str) -> Vec<SshHost> {
    let mut out: Vec<SshHost> = vec![];
    // The entries the current `Host` line made (none for `Host *` or a `Match` block).
    let mut group = 0..0;
    for l in text.lines() {
        let l = l.trim();
        let mut it = l.splitn(2, |c: char| c.is_whitespace() || c == '=');
        let (k, v) = (it.next().unwrap_or("").to_lowercase(), it.next().unwrap_or("").trim().trim_start_matches('=').trim());
        match k.as_str() {
            "host" => {
                let start = out.len();
                for a in v.split_whitespace().filter(|a| !a.contains('*') && !a.contains('?') && !a.starts_with('!')) {
                    out.push(SshHost { alias: a.into(), ..Default::default() });
                }
                group = start..out.len();
            }
            "match" => group = out.len()..out.len(),
            "hostname" if !is_address(v) => out[group.clone()].iter_mut().for_each(|h| h.host = v.into()),
            "user" => out[group.clone()].iter_mut().for_each(|h| h.user = v.into()),
            _ => {}
        }
    }
    out.dedup();
    out.truncate(40);
    out
}

/// The comment of a public key line (`[options] type blob comment`): never the key itself.
pub fn key_comment(line: &str) -> Option<String> {
    let w: Vec<&str> = line.split_whitespace().collect();
    let i = w.iter().position(|t| t.starts_with("ssh-") || t.starts_with("ecdsa-") || t.starts_with("sk-ssh") || t.starts_with("sk-ecdsa"))?;
    let c = w.get(i + 2..)?.join(" ");
    let c = scrub(&c);
    (!c.trim().is_empty() && !c.contains("[redacted]")).then(|| c.trim().chars().take(80).collect())
}

/// `known_hosts`: the plain host names (hashed entries and addresses are skipped).
pub fn known_host_names(text: &str) -> Vec<String> {
    let mut v: Vec<String> = text
        .lines()
        .filter(|l| !l.starts_with('|') && !l.starts_with('#'))
        .filter_map(|l| l.split_whitespace().next())
        .flat_map(|h| h.split(','))
        .map(|h| h.trim_start_matches('[').split(']').next().unwrap_or("").to_string())
        .filter(|h| !h.is_empty() && !is_address(h) && h != "localhost")
        .collect();
    v.sort();
    v.dedup();
    v.truncate(30);
    v
}

/// The logins in a gh `hosts.yml` (`user:` lines and the `users:` map's keys).
pub fn gh_logins(text: &str) -> Vec<String> {
    let mut v = vec![];
    let mut in_users = false;
    for l in text.lines() {
        let t = l.trim();
        if let Some(u) = t.strip_prefix("user:") {
            v.push(u.trim().to_string());
        }
        if t == "users:" {
            in_users = true;
            continue;
        }
        if in_users {
            let indent = l.len() - l.trim_start().len();
            if indent >= 8 && t.ends_with(':') {
                v.push(t.trim_end_matches(':').to_string());
            } else if indent <= 4 {
                in_users = false;
            }
        }
    }
    v.retain(|u| valid_github(u));
    v.sort();
    v.dedup();
    v
}

fn valid_github(u: &str) -> bool {
    !u.is_empty() && u.len() <= 39 && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !u.starts_with('-')
}

fn read(p: impl AsRef<std::path::Path>) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

fn git_config(key: &str) -> String {
    std::process::Command::new("git")
        .args(["config", "--global", key])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// The user's full name from the password database (GECOS).
pub fn full_name() -> String {
    let user = std::env::var("USER").unwrap_or_default();
    read("/etc/passwd")
        .lines()
        .find_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            (f.len() > 4 && f[0] == user).then(|| f[4].split(',').next().unwrap_or("").trim().to_string())
        })
        .unwrap_or_default()
}

/// This PC's own facts.
pub fn gather() -> Local {
    let h = store::home();
    let ssh = h.join(".ssh");
    let mut github_logins = gh_logins(&read(h.join(".config/gh/hosts.yml")));
    github_logins.extend(crate::mcp::github_user());
    github_logins.sort();
    github_logins.dedup();
    let comments = |t: &str| -> Vec<String> {
        let mut v: Vec<String> = t.lines().filter_map(key_comment).collect();
        v.sort();
        v.dedup();
        v.truncate(30);
        v
    };
    let own: String = std::fs::read_dir(&ssh)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".pub"))
        .map(|e| read(e.path()))
        .collect::<Vec<_>>()
        .join("\n");
    let claude_md: String = scrub(&read(crate::meshctx::profile().join("CLAUDE.md"))).chars().take(3000).collect();
    Local {
        hostname: crate::remote::hostname(),
        os_user: std::env::var("USER").unwrap_or_default(),
        full_name: full_name(),
        git_name: git_config("user.name"),
        git_email: git_config("user.email"),
        github_logins,
        ssh_hosts: parse_ssh_config(&read(ssh.join("config"))),
        authorized_key_comments: comments(&read(ssh.join("authorized_keys"))),
        own_key_comments: comments(&own),
        known_hosts: known_host_names(&read(ssh.join("known_hosts"))),
        claude_md,
    }
}

// ================================================================ rules

/// "ana-souza" → "Ana Souza"; logins that don't read as a name → "".
pub fn name_from_user(u: &str) -> String {
    const GENERIC: &[&str] = &["root", "user", "admin", "ubuntu", "pi", "debian", "arch", "guest", "git", "dev", "omarchy", "android"];
    let parts: Vec<&str> = u.split(['-', '_', '.']).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || u.chars().any(|c| c.is_ascii_digit()) || parts.iter().any(|p| GENERIC.contains(&p.to_lowercase().as_str())) {
        return String::new();
    }
    parts.iter().map(|p| {
        let mut c = p.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    }).collect::<Vec<_>>().join(" ")
}

/// The login in a GitHub noreply email (`123+login@users.noreply.github.com`).
fn noreply_login(email: &str) -> Option<String> {
    let local = email.strip_suffix("@users.noreply.github.com")?;
    let l = local.rsplit('+').next()?;
    valid_github(l).then(|| l.to_string())
}

fn confidence(n: usize) -> String {
    match n {
        0 => "",
        1 => "medium",
        _ => "high",
    }
    .into()
}

/// This PC's profile without a model: names from git, GECOS and the default account; the login
/// from gh / Harbor's sign-in / a noreply email.
pub fn heuristic_me(l: &Local, accounts: &[AccountFacts]) -> Proposal {
    let default_name = accounts.iter().find(|a| a.default_profile).map(|a| a.name.clone()).filter(|n| !n.is_empty() && !n.starts_with("Claude")).unwrap_or_default();
    let names = [(&l.git_name, "git user.name"), (&l.full_name, "the account's full name"), (&default_name, "the default Claude account")];
    let owner = names.iter().find(|(n, _)| !n.trim().is_empty()).map(|(n, _)| n.trim().to_string()).unwrap_or_default();
    let mut why: Vec<&str> = names.iter().filter(|(n, _)| !owner.is_empty() && first_word_eq(n, &owner)).map(|(_, w)| *w).collect();
    let mut gh = String::new();
    if let Some(g) = l.github_logins.first() {
        gh = g.clone();
        why.push("the GitHub login signed in here");
    } else if let Some(g) = noreply_login(&l.git_email) {
        gh = g;
        why.push("git's GitHub noreply email");
    }
    let n = why.len();
    Proposal { owner, github: gh, confidence: confidence(n.min(2)), why: if why.is_empty() { String::new() } else { format!("From {}", why.join(", ")) } }
}

fn first_word_eq(a: &str, b: &str) -> bool {
    let f = |s: &str| s.split_whitespace().next().unwrap_or("").to_lowercase();
    !f(a).is_empty() && f(a) == f(b)
}

/// A peer's profile without a model: the user of an SSH host whose alias or name matches the
/// PC's name ("ana-thinkpad" ↔ `Host thinkpad / User ana-souza`).
pub fn heuristic_peer(pc: &str, hosts: &[SshHost]) -> Proposal {
    const NOISE: &[&str] = &["omarchy", "desktop", "laptop", "mesh", "home", "local", "work"];
    let pc_low = pc.to_lowercase();
    let tokens: Vec<String> = pc_low.split(['-', '_', '.']).filter(|t| t.len() >= 4 && !NOISE.contains(t)).map(String::from).collect();
    let hit = |s: &str| {
        let s = s.to_lowercase();
        !s.is_empty() && tokens.iter().any(|t| s.contains(t.as_str()) || (s.len() >= 4 && t.contains(&s)))
    };
    for h in hosts {
        let host_first = h.host.split('.').next().unwrap_or("");
        if !(hit(&h.alias) || hit(host_first) || h.host.to_lowercase().starts_with(&pc_low)) {
            continue;
        }
        let owner = name_from_user(&h.user);
        // A user named like the PC ("aspire") is the machine, not a person.
        if owner.is_empty() || tokens.iter().any(|t| h.user.eq_ignore_ascii_case(t)) {
            continue;
        }
        return Proposal { owner, github: String::new(), confidence: "low".into(), why: format!("The SSH user on '{}' in this PC's ssh config", h.alias) };
    }
    Proposal::default()
}

/// Every PC's profile without a model.
pub fn heuristic(l: &Local, inp: &Inputs) -> BTreeMap<String, Proposal> {
    inp.pcs
        .iter()
        .map(|p| (p.id.clone(), if p.this_pc { heuristic_me(l, &inp.accounts) } else { heuristic_peer(&p.name, &l.ssh_hosts) }))
        .collect()
}

// ================================================================ the model

/// The facts as the model reads them (nothing secret: [`scrub`]bed names and comments).
pub fn facts(l: &Local, inp: &Inputs) -> Value {
    json!({ "pcs": inp.pcs, "this_pc": { "facts": l, "agent_accounts": inp.accounts } })
}

fn clean_field(s: &str, max: usize) -> String {
    scrub(s).replace("[redacted]", "").chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

/// The model's answer: `{pcs: {id: Proposal}}` (or the map alone), for known PCs only, cleaned.
pub fn parse_answer(text: &str, ids: &[String]) -> Option<BTreeMap<String, Proposal>> {
    let (a, b) = (text.find('{')?, text.rfind('}')?);
    let v: Value = serde_json::from_str(text.get(a..=b)?).ok()?;
    let map = v.get("pcs").unwrap_or(&v).as_object()?;
    let mut out = BTreeMap::new();
    for (id, p) in map {
        if !ids.contains(id) {
            continue;
        }
        let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("");
        let gh = s("github").trim().trim_start_matches('@').to_string();
        let conf = s("confidence").to_lowercase();
        out.insert(id.clone(), Proposal {
            owner: clean_field(s("owner"), 80),
            github: if valid_github(&gh) { gh } else { String::new() },
            confidence: if ["high", "medium", "low"].contains(&conf.as_str()) { conf } else { "low".into() },
            why: clean_field(s("why"), 200),
        });
    }
    Some(out)
}

/// The model's answer where it has one, the rules' where it left a field empty.
pub fn merge(model: &BTreeMap<String, Proposal>, rules: &BTreeMap<String, Proposal>) -> BTreeMap<String, Proposal> {
    let mut out = rules.clone();
    for (id, m) in model {
        let r = out.entry(id.clone()).or_default();
        let both = |a: &str, b: &str| if a.is_empty() { b.to_string() } else { a.to_string() };
        *r = Proposal {
            owner: both(&m.owner, &r.owner),
            github: both(&m.github, &r.github),
            confidence: if m.owner.is_empty() { r.confidence.clone() } else { m.confidence.clone() },
            why: both(&m.why, &r.why),
        };
    }
    out
}

/// One detection, on a worker thread: the facts, the rules, then the model when there's one.
pub fn detect(inp: Inputs, sig: String) -> Detected {
    let l = gather();
    let rules = heuristic(&l, &inp);
    let ids: Vec<String> = inp.pcs.iter().map(|p| p.id.clone()).collect();
    let (all, by) = match &inp.ask {
        Some((bin, env)) => {
            let prompt = format!("<facts>\n{}\n</facts>\n\n{PROMPT}", serde_json::to_string_pretty(&facts(&l, &inp)).unwrap_or_default());
            match crate::recap::ask(bin.clone(), env.clone(), SYSTEM, prompt).ok().and_then(|t| parse_answer(&t, &ids)) {
                Some(m) => (merge(&m, &rules), crate::recap::MODEL.to_string()),
                None => (rules, "rules".into()),
            }
        }
        None => (rules, "rules".into()),
    };
    let me_id = inp.pcs.iter().find(|p| p.this_pc).map(|p| p.id.clone()).unwrap_or_default();
    let mut d = Detected { by, at: store::now(), sig, ..Default::default() };
    for (id, p) in all {
        if id == me_id {
            d.me = p;
        } else if !p.owner.is_empty() || !p.github.is_empty() {
            d.peers.insert(id, p);
        }
    }
    d
}

// ================================================================ the app

pub struct State {
    /// The startup run is done (or wasn't needed).
    started: bool,
    /// The first tick: the startup run waits a little for the peers to link.
    born: Option<std::time::Instant>,
    pub running: bool,
    /// "Detect again" (desktop or phone): run at the next tick.
    pub want: bool,
    tx: Sender<Detected>,
    rx: Receiver<Detected>,
}

impl Default for State {
    fn default() -> Self {
        let (tx, rx) = channel();
        State { started: false, born: None, running: false, want: false, tx, rx }
    }
}

/// What a detection depends on: a change (a peer or phone paired) starts another one.
fn signature(pcs: &[PcFacts], accounts: &[AccountFacts]) -> String {
    let mut parts: Vec<String> = pcs.iter().map(|p| format!("{}:{}:{}", p.id, p.reported_owner.is_empty(), p.phones.join("+"))).collect();
    parts.extend(accounts.iter().map(|a| a.email.clone()));
    parts.sort();
    format!("{:x}", parts.join("|").bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3)))
}

impl crate::app::App {
    fn profile_inputs(&self) -> Inputs {
        let mut pcs: Vec<PcFacts> = self
            .mesh_pcs()
            .into_iter()
            .map(|p| PcFacts {
                id: p.id.clone(),
                name: p.name.clone(),
                this_pc: p.me,
                // This PC's own report is what was typed (the detection is what's being made).
                reported_owner: if p.me { self.store.get(crate::meshctx::OWNER_KEY).unwrap_or_default() } else if p.guessed { String::new() } else { p.owner.clone() },
                reported_github: if p.me { self.store.get(crate::meshctx::GITHUB_KEY).unwrap_or_default() } else if p.guessed { String::new() } else { p.github.clone() },
                detected: !p.me && p.suggested && !p.guessed,
                phones: p.phones.clone(),
                agent_accounts: p.accounts.clone(),
            })
            .collect();
        pcs.iter_mut().for_each(|p| p.reported_owner = p.reported_owner.trim().to_string());
        let accounts: Vec<AccountFacts> = self
            .accounts
            .iter()
            .filter(|a| a.installed() && (a.logged_in != Some(false)))
            .map(|a| AccountFacts { label: a.short(), name: a.name.clone(), email: a.email.clone(), default_profile: a.id == "claude" })
            .collect();
        // The PC's own Claude login (~/.claude, its person's), not one at its limit.
        let ask = self
            .accounts
            .iter()
            .find(|a| a.id == "claude" && a.installed() && a.logged_in == Some(true))
            .filter(|a| self.blocked(&a.id).is_none() && !self.limits.quota.get(&a.id).is_some_and(|q| q.iter().any(|(_, used, _)| *used >= 0.9)))
            .filter(|_| std::env::var("HARBOR_PROFILE_RULES").is_err())
            .map(|a| (a.bin_str(), a.env()));
        Inputs { pcs, accounts, ask }
    }

    /// Whether a detection is due: once at startup while unconfirmed, after a peer or phone
    /// paired (the signature changed) while there's something to fill, or when asked.
    /// Every frame: a finished detection is saved; "Detect again" starts one. `full` (every
    /// 10 s): also checks whether one is due.
    pub fn profile_tick(&mut self, ctx: &eframe::egui::Context, full: bool) {
        while let Ok(d) = self.profile.rx.try_recv() {
            self.profile.running = false;
            self.store.set(KEY, &serde_json::to_string(&d).unwrap_or_default());
            *self.api.hub.mesh.about.lock().unwrap() = crate::meshctx::about(&self.store);
            self.share_publish();
            ctx.request_repaint();
        }
        if self.profile.running || !(full || self.profile.want) {
            return;
        }
        // Peers link in the first seconds: one detection after that, not one before and after.
        let born = *self.profile.born.get_or_insert_with(std::time::Instant::now);
        if !self.profile.want && born.elapsed() < std::time::Duration::from_secs(STARTUP_WAIT) {
            return;
        }
        let inp = self.profile_inputs();
        let sig = signature(&inp.pcs, &inp.accounts);
        let last = load(&self.store);
        let unconfirmed = !crate::meshctx::confirmed(&self.store);
        let peer_unknown = inp.pcs.iter().any(|p| !p.this_pc && p.reported_owner.is_empty());
        let due = self.profile.want
            || (!self.profile.started && unconfirmed)
            || ((unconfirmed || peer_unknown) && last.as_ref().is_none_or(|d| d.sig != sig));
        self.profile.started = true;
        if !due {
            return;
        }
        self.profile.want = false;
        self.profile.running = true;
        let tx = self.profile.tx.clone();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(detect(inp, sig));
            ctx.request_repaint();
        });
    }

    /// The one-time pop-up over the window while this PC's profile is a detection nobody has
    /// confirmed: Confirm, or Review (Settings › Devices).
    pub fn profile_toast(&mut self, ctx: &eframe::egui::Context, t: &crate::theme::Tokens, y: f32) -> Option<f32> {
        let (key, title, body) = self.profile_check()?;
        if self.store.get(TOAST_KEY).as_deref() == Some(key.as_str()) {
            return None;
        }
        let icon = |p: &eframe::egui::Painter, r: eframe::egui::Rect| {
            p.rect_filled(r, eframe::egui::CornerRadius::same(8), t.gray(200));
            crate::icons::glyph(p, r.center(), crate::icons::USERS, 16.0, t.subtle());
        };
        use crate::notices::Click;
        let (click, h) = crate::notices::toast(ctx, t, "profile-toast", y, icon, &title, &body, Some(("Confirm", true)), "Review");
        match click {
            Click::Primary => {
                crate::meshctx::confirm(&self.store);
                *self.api.hub.mesh.about.lock().unwrap() = crate::meshctx::about(&self.store);
                self.share_publish();
            }
            Click::Secondary => {
                self.store.set(TOAST_KEY, &key);
                self.open(crate::app::View::Settings(crate::app::Tab::Devices));
            }
            Click::Close => self.store.set(TOAST_KEY, &key),
            Click::None => {}
        }
        Some(h)
    }

    /// The unconfirmed profile to ask about (`key`, title, line), the same for the phone's
    /// banner (`profile_check` in `/v1/state`). None once confirmed or with nothing detected.
    pub fn profile_check(&self) -> Option<(String, String, String)> {
        let s = &self.store;
        if crate::meshctx::confirmed(s) {
            return None;
        }
        let d = load(s)?;
        let (owner, gh) = (crate::meshctx::owner(s), crate::meshctx::github(s));
        if owner.is_empty() {
            return None;
        }
        let who = if gh.is_empty() { owner.clone() } else { format!("{owner} · GitHub {gh}") };
        let why = if d.me.why.is_empty() { String::new() } else { format!(" {}.", d.me.why.trim_end_matches('.')) };
        Some((format!("{owner}|{gh}"), "Is this you?".into(), format!("Harbor detected {who} as this PC's owner.{why} Agents and your other PCs see it.")))
    }

    pub fn profile_check_json(&self) -> Value {
        match self.profile_check() {
            Some((key, title, body)) => json!({ "key": key, "title": title, "body": body }),
            None => Value::Null,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_config_names_only() {
        let c = "Host thinkpad ana\n    HostName 2001:db8::7\n    User sam-lee\nHost mac\n  HostName sams-laptop.local\n  User samlee\nHost *\n  User x\n";
        let h = parse_ssh_config(c);
        assert_eq!(h[0], SshHost { alias: "thinkpad".into(), host: "".into(), user: "sam-lee".into() });
        assert_eq!(h[1].user, "sam-lee");
        assert_eq!(h[2], SshHost { alias: "mac".into(), host: "sams-laptop.local".into(), user: "samlee".into() });
        assert_eq!(h.len(), 3);
    }

    #[test]
    fn secrets_never_pass() {
        let blob = "AAAAC3NzaC1lZDI1NTE5AAAAIEqhynrPCgtXyZ0123456789abcdef";
        assert_eq!(key_comment(&format!("ssh-ed25519 {blob} sam@desk")).as_deref(), Some("sam@desk"));
        assert_eq!(key_comment(&format!("command=\"x\" ssh-rsa {blob} laptop key")).as_deref(), Some("laptop key"));
        assert_eq!(key_comment(&format!("ssh-ed25519 {blob}")), None);
        assert_eq!(key_comment("not a key"), None);
        let md = "Answer in English.\nGITHUB_TOKEN=ghp_abcdefghijklmnop1234\nmy password: hunter2\nuse key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 here\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ1234567890\n";
        let s = scrub(md);
        assert!(s.contains("Answer in English."));
        for bad in ["ghp_", "hunter2", "sk-ant", "PRIVATE", "b3BlbnNz"] {
            assert!(!s.contains(bad), "{bad} leaked: {s}");
        }
        assert!(scrub("mail sam@example.org at ~/work/repo").contains("sam@example.org"));
        let k = known_host_names("desk,2001:db8::2 ssh-ed25519 AAAA\n|1|hashed= ssh-rsa AAAA\n[mac.local]:2222 ssh-rsa AAAA\n2001:db8::4 ssh-rsa AAAA\n");
        assert_eq!(k, vec!["desk".to_string(), "mac.local".to_string()]);
        // The model's answer is cleaned too.
        let a = parse_answer(&format!(r#"{{"pcs":{{"pc:a":{{"owner":"Sam ghp_{blob}","github":"@sam-gh","confidence":"HIGH","why":"git"}},"pc:x":{{"owner":"Eve"}},"pc:b":{{"owner":"Alex","github":"not valid!"}}}}}}"#), &["pc:a".into(), "pc:b".into()]).unwrap();
        assert_eq!(a["pc:a"], Proposal { owner: "Sam".into(), github: "sam-gh".into(), confidence: "high".into(), why: "git".into() });
        assert_eq!((a["pc:b"].owner.as_str(), a["pc:b"].github.as_str(), a.contains_key("pc:x")), ("Alex", "", false));
    }

    #[test]
    fn gh_hosts_and_names() {
        let y = "github.com:\n    git_protocol: https\n    users:\n        sam-gh:\n            oauth_token: x\n        other:\n    user: sam-gh\n";
        assert_eq!(gh_logins(y), vec!["other".to_string(), "sam-gh".to_string()]);
        assert_eq!(name_from_user("ana-souza"), "Ana Souza");
        assert_eq!(name_from_user("u0_a289"), "");
        assert_eq!(name_from_user("root"), "");
        assert_eq!(noreply_login("123+sam-gh@users.noreply.github.com").as_deref(), Some("sam-gh"));
    }

    #[test]
    fn rules_for_this_pc_and_peers() {
        let l = Local { git_name: "Sam Lee".into(), full_name: "".into(), github_logins: vec!["samlee".into()], ssh_hosts: parse_ssh_config("Host thinkpad\n User alex-kim\nHost aspire\n User aspire\n"), ..Default::default() };
        let acc = [AccountFacts { name: "Sam".into(), default_profile: true, ..Default::default() }];
        let me = heuristic_me(&l, &acc);
        assert_eq!((me.owner.as_str(), me.github.as_str(), me.confidence.as_str()), ("Sam Lee", "samlee", "high"));
        assert_eq!(heuristic_peer("alex-thinkpad", &l.ssh_hosts).owner, "Alex Kim");
        assert_eq!(heuristic_peer("home-aspire", &l.ssh_hosts), Proposal::default(), "a user named like the PC is no person");
        // The model wins where it says something; the rules fill the rest.
        let rules: BTreeMap<String, Proposal> = [("a".to_string(), me.clone())].into();
        let model: BTreeMap<String, Proposal> = [("a".to_string(), Proposal { owner: "Samuel Lee".into(), confidence: "high".into(), why: "w".into(), ..Default::default() })].into();
        let m = merge(&model, &rules);
        assert_eq!((m["a"].owner.as_str(), m["a"].github.as_str()), ("Samuel Lee", "samlee"));
    }
}

