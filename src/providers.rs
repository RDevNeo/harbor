//! Agent providers (T3 Code style): every coding-agent CLI on the machine is a
//! provider, and Claude Code contributes one account per profile directory
//! (`~/.claude`, `~/.claude2`, …). Discovery only reads files and PATH.

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::store::home;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Kind {
    Claude,
    Codex,
    Cursor,
    Grok,
    Gemini,
    Meta,
    OpenCode,
}

impl Kind {
    pub const ALL: [Kind; 7] = [Kind::Claude, Kind::Codex, Kind::Cursor, Kind::Grok, Kind::Gemini, Kind::Meta, Kind::OpenCode];

    pub fn label(self) -> &'static str {
        match self {
            Kind::Claude => "Claude",
            Kind::Codex => "Codex",
            Kind::Cursor => "Cursor",
            Kind::Grok => "Grok",
            Kind::Gemini => "Gemini",
            Kind::Meta => "Meta",
            Kind::OpenCode => "OpenCode",
        }
    }

    pub fn bin(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Codex => "codex",
            Kind::Cursor => "cursor-agent",
            Kind::Grok => "grok",
            Kind::Gemini => "gemini",
            Kind::Meta => "muse",
            Kind::OpenCode => "opencode",
        }
    }

    /// Interactive command that signs the CLI in; it runs in the built-in terminal.
    pub fn login_cmd(self) -> &'static [&'static str] {
        match self {
            Kind::Claude => &["/login"],
            Kind::Codex => &["login"],
            Kind::Cursor => &["login"],
            Kind::Grok => &["login"],
            Kind::Gemini => &[],
            Kind::Meta => &["login"],
            Kind::OpenCode => &["auth", "login"],
        }
    }

    pub fn install_hint(self) -> &'static str {
        match self {
            Kind::Claude => "curl -fsSL https://claude.ai/install.sh | bash",
            Kind::Codex => "npm i -g @openai/codex",
            Kind::Cursor => "curl https://cursor.com/install -fsS | bash",
            Kind::Grok => "npm i -g @xai-official/grok",
            Kind::Gemini => "npm i -g @google/gemini-cli",
            Kind::Meta => "curl -fsSL https://dev.meta.ai/install.sh | bash",
            Kind::OpenCode => "curl -fsSL https://opencode.ai/install | bash",
        }
    }

    /// The install hint as a shell script. npm installs say first that they need Node.js
    /// (instead of "npm: command not found"), and how to fix a global prefix that needs root.
    pub fn install_script(self) -> String {
        let hint = self.install_hint();
        if !hint.starts_with("npm ") {
            return hint.to_string();
        }
        let label = self.label();
        format!(
            "if ! command -v npm >/dev/null 2>&1; then\n\
             echo '{label} installs with npm, which comes with Node.js, and Node.js isn'\\''t installed.'\n\
             echo 'Install Node.js (https://nodejs.org, or your distribution'\\''s nodejs and npm packages), then try again.'\n\
             exit 1\n\
             fi\n\
             {hint} || {{ echo; echo 'If npm failed with EACCES, its global folder needs root. Use a folder of your own:'; \
             echo '  npm config set prefix ~/.npm-global   (then add ~/.npm-global/bin to your PATH)'; exit 1; }}"
        )
    }

}

#[derive(Clone, Debug)]
pub struct Window {
    pub label: String,
    pub percent: f32,
    /// When the window resets (Unix time), if known.
    pub resets_at: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Account {
    /// Stable id stored on chats: "claude", "claude2", "codex", "cursor", …
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub email: String,
    /// Two-letter badge shown on the provider icon (IG, FS, …).
    pub badge: String,
    pub plan: String,
    pub config_dir: Option<PathBuf>,
    pub bin: Option<PathBuf>,
    pub logged_in: Option<bool>,
    pub usage: Vec<Window>,
}

impl Account {
    pub fn installed(&self) -> bool {
        self.bin.is_some()
    }

    pub fn bin_str(&self) -> String {
        self.bin.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| self.kind.bin().into())
    }

    /// One line for menus: "Claude · IG" or "Codex".
    pub fn short(&self) -> String {
        if self.kind == Kind::Claude {
            format!("Claude · {}", self.badge)
        } else {
            self.kind.label().into()
        }
    }

    /// Environment a child process of this account needs.
    pub fn env(&self) -> Vec<(String, Option<String>)> {
        let mut v = vec![("PATH".to_string(), Some(child_path()))];
        if self.kind == Kind::Claude {
            v.push((
                "CLAUDE_CONFIG_DIR".into(),
                self.config_dir.as_ref().map(|d| d.to_string_lossy().into_owned()),
            ));
        }
        v
    }
}

#[derive(Clone, Debug)]
pub struct Model {
    pub id: String,
    pub label: String,
    /// Shown under "Legacy models" / "More models".
    pub more: bool,
}

fn m(id: &str, label: &str, more: bool) -> Model {
    Model { id: id.into(), label: label.into(), more }
}

// ------------------------------------------------------------------ PATH

/// GUI launches often miss the shell's PATH additions; add the usual tool dirs.
pub fn child_path() -> String {
    let h = home();
    let mut dirs: Vec<String> = std::env::var("PATH").unwrap_or_default().split(':').map(String::from).collect();
    for extra in [".local/bin", ".local/share/mise/shims", ".cargo/bin", ".bun/bin", ".opencode/bin", ".npm-global/bin"] {
        let p = h.join(extra).to_string_lossy().into_owned();
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    dirs.join(":")
}

pub fn which(bin: &str) -> Option<PathBuf> {
    child_path().split(':').map(|d| Path::new(d).join(bin)).find(|p| p.is_file())
}

// ------------------------------------------------------------------ discovery

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn badge_from(email: &str, fallback: &str) -> String {
    let local = email.split('@').next().unwrap_or("");
    let letters: String = local.chars().filter(|c| c.is_ascii_alphabetic()).take(2).collect();
    if letters.len() == 2 { letters.to_uppercase() } else { fallback.into() }
}

fn claude_account(id: &str, dir: PathBuf, json: PathBuf, n: usize) -> Account {
    let j = read_json(&json);
    let oauth = j.as_ref().map(|j| j["oauthAccount"].clone()).unwrap_or(Value::Null);
    let email = oauth["emailAddress"].as_str().unwrap_or("").to_string();
    let name = oauth["displayName"].as_str().filter(|s| !s.is_empty()).map(String::from)
        .unwrap_or_else(|| if n == 1 { "Claude".into() } else { format!("Claude {n}") });
    let creds = dir.join(".credentials.json");
    Account {
        id: id.into(),
        kind: Kind::Claude,
        name,
        badge: badge_from(&email, &format!("C{n}")),
        email,
        plan: String::new(),
        config_dir: (n > 1).then_some(dir),
        bin: which("claude"),
        logged_in: Some(creds.exists() || !oauth.is_null()),
        usage: vec![],
    }
}

pub fn discover() -> Vec<Account> {
    let h = home();
    let mut out = vec![claude_account("claude", h.join(".claude"), h.join(".claude.json"), 1)];
    let mut extra: Vec<(usize, PathBuf)> = std::fs::read_dir(&h)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let n: usize = name.strip_prefix(".claude")?.parse().ok()?;
            e.path().is_dir().then_some((n, e.path()))
        })
        .collect();
    extra.sort();
    for (n, dir) in extra {
        let json = dir.join(".claude.json");
        out.push(claude_account(&format!("claude{n}"), dir, json, n));
    }

    for kind in Kind::ALL.into_iter().skip(1) {
        let bin = which(kind.bin());
        let logged_in = match kind {
            Kind::Codex => Some(h.join(".codex/auth.json").exists()),
            Kind::Meta => Some(h.join(".config/muse/auth.json").exists()),
            Kind::Gemini => Some(h.join(".gemini/oauth_creds.json").exists() || std::env::var("GEMINI_API_KEY").is_ok()),
            Kind::Grok => Some(h.join(".grok/auth.json").exists() || std::env::var("XAI_API_KEY").is_ok()),
            _ => None,
        };
        out.push(Account {
            id: kind.label().to_lowercase(),
            kind,
            name: kind.label().into(),
            email: String::new(),
            badge: String::new(),
            plan: String::new(),
            config_dir: None,
            bin,
            logged_in,
            usage: vec![],
        });
    }
    apply_usage(&mut out);
    out
}

/// Plan and 5-hour/weekly windows from the agents-usage-monitor cache, if present.
fn apply_usage(accounts: &mut [Account]) {
    let p = home().join(".local/state/omarchy/agents-usage-monitor/usage.json");
    let Some(j) = read_json(&p) else { return };
    let Some(list) = j["providers"].as_array() else { return };
    for prov in list {
        let id = prov["id"].as_str().unwrap_or("");
        if let Some(a) = accounts.iter_mut().find(|a| a.id == id) {
            a.plan = prov["plan"].as_str().unwrap_or("").into();
            a.usage = prov["windows"]
                .as_array()
                .map(|w| {
                    w.iter()
                        .map(|x| Window {
                            label: x["label"].as_str().unwrap_or("").into(),
                            percent: x["percent"].as_f64().unwrap_or(0.0) as f32,
                            resets_at: x["resetsAt"].as_str().and_then(|t| {
                                let out = std::process::Command::new("date").args(["-d", t, "+%s"]).output().ok()?;
                                String::from_utf8_lossy(&out.stdout).trim().parse().ok()
                            }),
                        })
                        .collect()
                })
                .unwrap_or_default();
            if a.email.is_empty() {
                a.email = prov["account"].as_str().unwrap_or("").into();
            }
        }
    }
}

// ------------------------------------------------------------------ models

pub fn claude_models() -> Vec<Model> {
    vec![
        m("claude-fable-5-1", "Fable 5.1", false),
        m("claude-opus-5-5", "Opus 5.5", false),
        m("claude-sonnet-5-5", "Sonnet 5.5", false),
        m("claude-haiku-5-5", "Haiku 5.5", true),
    ]
}

/// Codex: newest model of each family (Sol, Astra, Luna, …) from the newest
/// generation is listed; everything else is legacy.
pub fn codex_models() -> Vec<Model> {
    let Some(j) = read_json(&home().join(".codex/models_cache.json")) else {
        return vec![m("", "Default", false)];
    };
    let mut all: Vec<(String, String, i64)> = j["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|x| x["visibility"] == "list")
        .map(|x| {
            (
                x["slug"].as_str().unwrap_or("").to_string(),
                x["display_name"].as_str().unwrap_or("").to_string(),
                x["priority"].as_i64().unwrap_or(99),
            )
        })
        .collect();
    all.sort_by_key(|x| x.2);
    let version = |slug: &str| -> f32 {
        slug.trim_start_matches("gpt-").split('-').next().and_then(|v| v.parse().ok()).unwrap_or(0.0)
    };
    let family = |slug: &str| slug.rsplit('-').next().unwrap_or("").to_string();
    let top_major = all.iter().map(|x| version(&x.0).floor() as i32).max().unwrap_or(0);
    let mut best: HashMap<String, f32> = HashMap::new();
    for (slug, _, _) in &all {
        let e = best.entry(family(slug)).or_insert(0.0);
        *e = e.max(version(slug));
    }
    all.into_iter()
        .map(|(slug, label, _)| {
            let v = version(&slug);
            let main = best.get(&family(&slug)) == Some(&v) && v.floor() as i32 == top_major;
            Model { id: slug, label, more: !main }
        })
        .collect()
}

/// Cursor: parsed from `cursor-agent models` (run off the UI thread).
pub fn cursor_models(bin: &Path) -> Vec<Model> {
    let out = std::process::Command::new(bin).arg("models").env("PATH", child_path()).output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let mut v: Vec<Model> = text
        .lines()
        .filter_map(|l| {
            let (id, label) = l.split_once(" - ")?;
            let id = id.trim();
            (!id.contains(' ')).then(|| {
                let label = label.replace("(current, default)", "").replace("(current)", "").replace("(default)", "");
                m(id, label.trim(), false)
            })
        })
        .collect();
    for (i, x) in v.iter_mut().enumerate() {
        x.more = i >= 4;
    }
    if v.is_empty() {
        v.push(m("auto", "Auto", false));
    }
    v
}

pub fn static_models(kind: Kind) -> Vec<Model> {
    match kind {
        Kind::Claude => claude_models(),
        Kind::Codex => codex_models(),
        Kind::Cursor => vec![m("auto", "Auto", false)],
        _ => vec![m("", "Default", false)],
    }
}

// ------------------------------------------------------------------ effort & access

pub fn efforts(kind: Kind) -> &'static [(&'static str, &'static str, &'static str)] {
    match kind {
        Kind::Claude => &[
            ("low", "Low", ""),
            ("medium", "Medium", ""),
            ("high", "High", ""),
            ("xhigh", "Extra High", ""),
            ("max", "Max", ""),
            ("ultracode", "Ultracode", "xhigh effort plus multi-agent workflow orchestration"),
            ("ultrathink", "Ultrathink", ""),
        ],
        Kind::Codex => &[
            ("low", "Low", ""),
            ("medium", "Medium", ""),
            ("high", "High", ""),
            ("xhigh", "Extra High", ""),
            ("max", "Max", ""),
            ("ultra", "Ultra", "Maximum reasoning with automatic task delegation"),
        ],
        Kind::Meta => &[("minimal", "Minimal", ""), ("low", "Low", ""), ("medium", "Medium", ""), ("high", "High", ""), ("max", "Max", "")],
        _ => &[],
    }
}

/// The effort each CLI uses when none is passed, from its own settings.
pub fn default_effort(kind: Kind) -> &'static str {
    static CLAUDE: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    static CODEX: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    let pick = |v: Option<String>, fallback: &'static str| -> &'static str {
        v.and_then(|v| efforts(kind).iter().find(|e| e.0 == v).map(|e| e.0)).unwrap_or(fallback)
    };
    match kind {
        Kind::Claude => CLAUDE.get_or_init(|| {
            let v = read_json(&home().join(".claude/settings.json")).and_then(|j| j["effortLevel"].as_str().map(String::from));
            pick(v, "high")
        }),
        Kind::Codex => CODEX.get_or_init(|| {
            let text = std::fs::read_to_string(home().join(".codex/config.toml")).unwrap_or_default();
            let v = text.lines().find_map(|l| l.strip_prefix("model_reasoning_effort").map(|r| r.trim_start_matches([' ', '=']).trim().trim_matches('"').to_string()));
            pick(v, "medium")
        }),
        Kind::Meta => "high",
        _ => "",
    }
}

pub fn effort_label(kind: Kind, e: &str) -> &'static str {
    let e = if e.is_empty() { default_effort(kind) } else { e };
    efforts(kind).iter().find(|x| x.0 == e).map(|x| x.1).unwrap_or("Default")
}

/// Providers with a fast tier: Claude Code's fastMode, Codex's priority service tier.
pub fn has_fast(kind: Kind) -> bool {
    matches!(kind, Kind::Claude | Kind::Codex)
}

/// Access levels: key, label, description. "full" = no approvals.
pub fn access(kind: Kind) -> &'static [(&'static str, &'static str, &'static str)] {
    const FULL: (&str, &str, &str) = ("full", "Full access", "Runs commands and edits files without asking");
    const EDITS: (&str, &str, &str) = ("edits", "Auto-edit", "Edits files; risky commands are refused");
    const PLAN: (&str, &str, &str) = ("plan", "Read only", "Reads and plans, changes nothing");
    match kind {
        Kind::Claude | Kind::Codex | Kind::Grok | Kind::Gemini => &[FULL, EDITS, PLAN],
        Kind::Cursor | Kind::Meta => &[FULL, ("ask", "Default", "The CLI's own approval rules")],
        Kind::OpenCode => &[FULL],
    }
}

pub fn access_label(kind: Kind, a: &str) -> &'static str {
    access(kind).iter().find(|x| x.0 == a).map(|x| x.1).unwrap_or("Full access")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_install_needs_node() {
        assert_eq!(Kind::Claude.install_script(), Kind::Claude.install_hint());
        let s = Kind::Codex.install_script();
        assert!(s.starts_with("if ! command -v npm") && s.contains("Node.js") && s.contains("npm i -g @openai/codex ||"));
        // Runs as a script: without npm on PATH it explains instead of failing on npm.
        let out = std::process::Command::new("/bin/sh").args(["-c", &s]).env("PATH", "/nonexistent").output().unwrap();
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("Codex installs with npm"));
    }
}
