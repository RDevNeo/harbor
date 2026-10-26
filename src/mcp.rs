//! MCP servers and apps for the agents Harbor starts.
//!
//! Agents only reach what Harbor hands them: the local MCP servers below, plus
//! the apps the user signed in to in Harbor. Sign-ins live in Harbor's own store
//! (`<data>/apps`, 0700), never in the user's gh, Claude Code or Convex config,
//! and every agent process gets an environment that hides the user's own
//! credentials (gh keyring, git credential helpers, Convex and Supabase tokens).
//! The user's config files are only ever read.

use crate::store;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

// ------------------------------------------------------------------ catalogue

/// A local MCP server: a tool on this machine that every agent gets.
pub struct Local {
    /// Normalised name prefix it is found by in the user's config ("robloxstudio").
    pub id: &'static str,
    pub label: &'static str,
}

pub const LOCAL: &[Local] = &[
    Local { id: "discord", label: "Discord" },
    Local { id: "robloxstudio", label: "Roblox Studio" },
    Local { id: "omarchy", label: "Omarchy" },
    Local { id: "blender", label: "Blender" },
    Local { id: "playwright", label: "Playwright" },
];

pub enum Auth {
    /// `gh auth login` (device flow) into Harbor's own GH_CONFIG_DIR.
    Github,
    /// `convex login` (device flow) with HOME pointed at Harbor's store.
    Convex,
    /// MCP OAuth: discovery, dynamic client registration, PKCE, localhost callback.
    OAuth,
    /// A pasted API key, sent in this header; `get` is where to create one.
    Key { header: &'static str, get: &'static str },
}

pub enum Transport {
    Http(&'static str),
    Stdio(&'static [&'static str]),
}

/// An app: a service agents may only use after the user signs in to it in Harbor.
pub struct App {
    pub id: &'static str,
    pub label: &'static str,
    pub about: &'static str,
    pub auth: Auth,
    pub mcp: Transport,
}

pub const APPS: &[App] = &[
    App { id: "github", label: "GitHub", about: "Repos, issues, PRs; gh and git push", auth: Auth::Github, mcp: Transport::Http("https://api.githubcopilot.com/mcp/") },
    App { id: "vercel", label: "Vercel", about: "Projects, deployments, logs, docs", auth: Auth::OAuth, mcp: Transport::Http("https://mcp.vercel.com") },
    App { id: "linear", label: "Linear", about: "Issues, projects, cycles", auth: Auth::OAuth, mcp: Transport::Http("https://mcp.linear.app/mcp") },
    App { id: "sentry", label: "Sentry", about: "Errors, traces, releases", auth: Auth::OAuth, mcp: Transport::Http("https://mcp.sentry.dev/mcp") },
    App { id: "supabase", label: "Supabase", about: "Database, auth, edge functions", auth: Auth::OAuth, mcp: Transport::Http("https://mcp.supabase.com/mcp") },
    App {
        id: "context7",
        label: "Context7",
        about: "Up-to-date library docs",
        auth: Auth::Key { header: "CONTEXT7_API_KEY", get: "https://context7.com/dashboard" },
        mcp: Transport::Http("https://mcp.context7.com/mcp"),
    },
    App { id: "convex", label: "Convex", about: "Deployments, data and the convex CLI", auth: Auth::Convex, mcp: Transport::Stdio(&["npx", "-y", "convex@latest", "mcp", "start"]) },
];

pub fn app(id: &str) -> Option<&'static App> {
    APPS.iter().find(|a| a.id == id)
}

/// "Roblox Studio" → "robloxstudio".
fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

fn local_for(name: &str) -> Option<&'static Local> {
    let n = norm(name);
    LOCAL.iter().find(|l| n.starts_with(l.id))
}

// ------------------------------------------------------------------ store

/// `p`, created if missing and made owner-only (0700).
pub fn private_dir(p: PathBuf) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::create_dir_all(&p);
    let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700));
    p
}

/// Harbor's own credential store.
pub fn dir() -> PathBuf {
    private_dir(store::data_dir().join("apps"))
}

pub fn write_private(p: &Path, data: &str) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = p.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(data.as_bytes())?;
    drop(f);
    std::fs::rename(tmp, p)
}

/// GH_CONFIG_DIR once GitHub is signed in.
fn gh_dir() -> PathBuf {
    private_dir(dir().join("github"))
}

/// GH_CONFIG_DIR while signed out: a placeholder token shadows gh's fallback to the
/// system keyring, where the user's own token lives.
fn gh_out_dir() -> PathBuf {
    let d = private_dir(dir().join("github-signed-out"));
    let hosts = d.join("hosts.yml");
    if !hosts.exists() {
        let _ = write_private(&hosts, "github.com:\n    oauth_token: sign-in-to-github-in-harbor\n    git_protocol: https\n    user: harbor\n");
    }
    d
}

/// HOME for `convex login`, so its config lands here instead of ~/.convex.
fn convex_home() -> PathBuf {
    private_dir(dir().join("convex"))
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Cred {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    /// Unix seconds; 0 = doesn't expire.
    #[serde(default)]
    expires_at: i64,
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
    #[serde(default)]
    token_endpoint: String,
    #[serde(default)]
    resource: String,
}

fn cred_path(id: &str) -> PathBuf {
    dir().join(format!("{id}.json"))
}

fn load(id: &str) -> Option<Cred> {
    serde_json::from_str(&std::fs::read_to_string(cred_path(id)).ok()?).ok().filter(|c: &Cred| !c.access_token.is_empty())
}

fn save(id: &str, c: &Cred) -> Result<(), String> {
    write_private(&cred_path(id), &serde_json::to_string_pretty(c).unwrap_or_default()).map_err(|e| e.to_string())
}

fn gh_token() -> Option<String> {
    let text = std::fs::read_to_string(gh_dir().join("hosts.yml")).ok()?;
    text.lines().find_map(|l| l.trim().strip_prefix("oauth_token:").map(|t| t.trim().to_string())).filter(|t| !t.is_empty())
}

fn convex_token() -> Option<String> {
    let text = std::fs::read_to_string(convex_home().join(".convex/config.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v["accessToken"].as_str().filter(|t| !t.is_empty()).map(String::from)
}

pub fn signed_in(id: &str) -> bool {
    match app(id).map(|a| &a.auth) {
        Some(Auth::Github) => gh_token().is_some(),
        Some(Auth::Convex) => convex_token().is_some(),
        Some(_) => load(id).is_some(),
        None => false,
    }
}

/// GitHub's signed-in login, for the card.
pub fn github_user() -> Option<String> {
    let text = std::fs::read_to_string(gh_dir().join("hosts.yml")).ok()?;
    text.lines().find_map(|l| l.trim().strip_prefix("user:").map(|u| u.trim().to_string())).filter(|u| !u.is_empty())
}

/// The app's token for an agent; OAuth tokens are refreshed when about to expire.
fn token(id: &str) -> Option<String> {
    match &app(id)?.auth {
        Auth::Github => gh_token(),
        Auth::Convex => convex_token(),
        Auth::Key { .. } => load(id).map(|c| c.access_token),
        Auth::OAuth => {
            let c = load(id)?;
            if c.expires_at > 0 && store::now() > c.expires_at - 120 {
                return refresh(id, &c).ok().map(|c| c.access_token);
            }
            Some(c.access_token)
        }
    }
}

pub fn sign_out(id: &str) {
    cancel(id);
    match app(id).map(|a| &a.auth) {
        Some(Auth::Github) => {
            let _ = std::fs::remove_file(gh_dir().join("hosts.yml"));
        }
        Some(Auth::Convex) => {
            let _ = std::fs::remove_file(convex_home().join(".convex/config.json"));
        }
        _ => {
            let _ = std::fs::remove_file(cred_path(id));
        }
    }
}

pub fn save_key(id: &str, key: &str) -> Result<(), String> {
    save(id, &Cred { access_token: key.trim().into(), ..Default::default() })
}

// ------------------------------------------------------------------ sign-in flows

/// A sign-in in progress: the device code to type and the page to type it on.
#[derive(Clone, Default)]
pub struct Pending {
    pub code: Option<String>,
    pub url: Option<String>,
}

struct Flow {
    pending: Pending,
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

static FLOWS: LazyLock<Mutex<HashMap<String, Flow>>> = LazyLock::new(Default::default);
static ERRORS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

pub fn pending(id: &str) -> Option<Pending> {
    FLOWS.lock().unwrap().get(id).map(|f| f.pending.clone())
}

pub fn error(id: &str) -> Option<String> {
    ERRORS.lock().unwrap().get(id).cloned()
}

pub fn dismiss(id: &str) {
    ERRORS.lock().unwrap().remove(id);
}

pub fn cancel(id: &str) {
    if let Some(f) = FLOWS.lock().unwrap().remove(id) {
        f.cancel.store(true, Ordering::Relaxed);
        if let Some(c) = f.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }
}

/// Starts the app's sign-in on a thread; progress shows through [`pending`] and [`error`].
pub fn sign_in(id: &'static str, ctx: eframe::egui::Context) {
    let Some(a) = app(id) else { return };
    let mut flows = FLOWS.lock().unwrap();
    if flows.contains_key(id) {
        return;
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let child: Arc<Mutex<Option<Child>>> = Default::default();
    flows.insert(id.into(), Flow { pending: Pending::default(), cancel: cancel.clone(), child: child.clone() });
    drop(flows);
    ERRORS.lock().unwrap().remove(id);
    std::thread::spawn(move || {
        let c2 = ctx.clone();
        let update = move |p: Pending| {
            if let Some(f) = FLOWS.lock().unwrap().get_mut(id) {
                f.pending = p;
            }
            c2.request_repaint();
        };
        let r = match (&a.auth, &a.mcp) {
            (Auth::Github, _) => device_login(id, gh_login_cmd(), &child, &update),
            (Auth::Convex, _) => device_login(id, convex_login_cmd(), &child, &update),
            (Auth::OAuth, Transport::Http(url)) => oauth_login(id, url, &cancel, &update),
            _ => Err("This app signs in with a key.".into()),
        };
        if !cancel.load(Ordering::Relaxed) {
            FLOWS.lock().unwrap().remove(id);
            if let Err(e) = r {
                ERRORS.lock().unwrap().insert(id.into(), e);
            }
        }
        ctx.request_repaint();
    });
}

fn gh_login_cmd() -> Command {
    let bin = crate::providers::which("gh").map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "gh".into());
    let d = gh_dir();
    let mut cmd = Command::new(bin);
    // --insecure-storage keeps the token in Harbor's hosts.yml: the keyring entry is the user's.
    cmd.args(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key", "--insecure-storage", "--scopes", "workflow"])
        .env("GH_CONFIG_DIR", &d)
        // Anything gh would write to the global git config lands here instead.
        .env("GIT_CONFIG_GLOBAL", d.join("gitconfig"))
        // Harbor opens the page itself, once it has shown the code.
        .env("GH_BROWSER", "true")
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN");
    cmd
}

fn convex_login_cmd() -> Command {
    let mut cmd = Command::new("npx");
    cmd.args(["-y", "convex@latest", "login", "--no-open", "--device-name", "Harbor", "--login-flow", "poll"])
        .current_dir(convex_home())
        .env("HOME", convex_home())
        // npx still uses the real cache, so this doesn't download convex again.
        .env("npm_config_cache", store::home().join(".npm"))
        .env_remove("CONVEX_OVERRIDE_ACCESS_TOKEN")
        .env_remove("CONVEX_DEPLOY_KEY");
    cmd
}

/// Runs a CLI's device login: shows its code, opens its page, waits for it to finish.
fn device_login(id: &str, mut cmd: Command, child: &Arc<Mutex<Option<Child>>>, update: &dyn Fn(Pending)) -> Result<(), String> {
    cmd.env("PATH", crate::providers::child_path()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut c = cmd.spawn().map_err(|e| e.to_string())?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    for s in [c.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), c.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)].into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for l in BufReader::new(s).lines().map_while(Result::ok) {
                let _ = tx.send(l);
            }
        });
    }
    drop(tx);
    *child.lock().unwrap() = Some(c);
    let mut p = Pending::default();
    let mut tail: Vec<String> = vec![];
    for line in rx {
        for w in line.split_whitespace() {
            let w = w.trim_matches(|c: char| "()[]<>,;'\"".contains(c)).trim_end_matches('.');
            if w.starts_with("https://") && p.url.is_none() {
                p.url = Some(w.to_string());
                crate::git::open_url(p.url.as_deref().unwrap());
                update(p.clone());
            } else if p.code.is_none() && is_code(w) {
                p.code = Some(w.to_string());
                update(p.clone());
            }
        }
        if !line.trim().is_empty() {
            tail.push(line.trim().to_string());
        }
    }
    let ok = child.lock().unwrap().take().and_then(|mut c| c.wait().ok()).is_some_and(|s| s.success());
    if ok && signed_in(id) {
        return Ok(());
    }
    let msg = tail.iter().rev().find(|l| l.contains("rror") || l.contains("failed") || l.contains("expired")).or(tail.last()).cloned();
    Err(msg.unwrap_or_else(|| "Sign-in was cancelled.".into()))
}

/// A device code: "62FA-3B18".
fn is_code(w: &str) -> bool {
    let w = w.trim_matches(['(', ')']);
    w.len() == 9 && w.as_bytes()[4] == b'-' && w.chars().enumerate().all(|(i, c)| i == 4 || c.is_ascii_uppercase() || c.is_ascii_digit())
}

// ------------------------------------------------------------------ MCP OAuth

/// One HTTP request through curl; the body goes over stdin so secrets stay out of argv.
fn http(method: &str, url: &str, ctype: Option<&str>, body: Option<&str>) -> Result<(u16, Value), String> {
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "-m", "30", "-X", method, "-H", "Accept: application/json", "-w", "\n%{http_code}"]);
    if let Some(t) = ctype {
        cmd.args(["-H", &format!("Content-Type: {t}"), "--data-binary", "@-"]);
    }
    cmd.arg(url).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut c = cmd.spawn().map_err(|e| format!("curl: {e}"))?;
    if let Some(mut sin) = c.stdin.take() {
        let _ = sin.write_all(body.unwrap_or("").as_bytes());
    }
    let out = c.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (body, code) = text.rsplit_once('\n').unwrap_or(("", &text));
    let code: u16 = code.trim().parse().unwrap_or(0);
    if code == 0 {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok((code, serde_json::from_str(body).unwrap_or(Value::String(body.chars().take(300).collect()))))
}

fn get_json(url: &str) -> Option<Value> {
    match http("GET", url, None, None) {
        Ok((200, v)) if v.is_object() => Some(v),
        _ => None,
    }
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn origin_and_path(url: &str) -> (String, String) {
    let rest = url.split_once("://").map(|x| x.1).unwrap_or(url);
    let (host, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, String::new()));
    let scheme = url.split_once("://").map(|x| x.0).unwrap_or("https");
    (format!("{scheme}://{host}"), path.trim_end_matches('/').to_string())
}

/// RFC 9728/8414 well-known URL: the suffix goes between origin and path.
fn well_known(url: &str, suffix: &str) -> [String; 2] {
    let (o, p) = origin_and_path(url);
    [format!("{o}/.well-known/{suffix}{p}"), format!("{o}/.well-known/{suffix}")]
}

fn random(n: usize) -> Result<Vec<u8>, String> {
    store::random_bytes(n).map_err(|e| format!("No randomness for the sign-in: {e}"))
}

fn b64url(data: &[u8]) -> String {
    crate::agent::base64(data).replace('+', "-").replace('/', "_").trim_end_matches('=').to_string()
}

fn oauth_login(id: &str, url: &str, cancel: &AtomicBool, update: &dyn Fn(Pending)) -> Result<(), String> {
    let rm = well_known(url, "oauth-protected-resource").iter().find_map(|u| get_json(u)).unwrap_or_default();
    let issuer = rm["authorization_servers"][0].as_str().map(String::from).unwrap_or_else(|| origin_and_path(url).0);
    let resource = rm["resource"].as_str().unwrap_or(url).to_string();
    let scope = rm["scopes_supported"].as_array().map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
    let meta = well_known(&issuer, "oauth-authorization-server")
        .iter()
        .chain(well_known(&issuer, "openid-configuration").iter())
        .find_map(|u| get_json(u))
        .ok_or("The service has no OAuth metadata.")?;
    let s = |k: &str| meta[k].as_str().unwrap_or("").to_string();
    let (authorize, token_ep, register) = (s("authorization_endpoint"), s("token_endpoint"), s("registration_endpoint"));
    if authorize.is_empty() || token_ep.is_empty() || register.is_empty() {
        return Err("The service doesn't allow new apps to register.".into());
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr().map_err(|e| e.to_string())?.port());
    let public = meta["token_endpoint_auth_methods_supported"].as_array().is_none_or(|a| a.iter().any(|m| m == "none"));
    let reg = json!({
        "client_name": "Harbor",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": if public { "none" } else { "client_secret_post" },
        "scope": scope,
    });
    let (code, client) = http("POST", &register, Some("application/json"), Some(&reg.to_string()))?;
    let client_id = client["client_id"].as_str().unwrap_or("").to_string();
    if !(200..300).contains(&code) || client_id.is_empty() {
        return Err(format!("Registering Harbor failed ({code}): {}", client["error_description"].as_str().or(client["error"].as_str()).unwrap_or("")));
    }
    let client_secret = client["client_secret"].as_str().unwrap_or("").to_string();
    let verifier = b64url(&random(32)?);
    let challenge = b64url(&sha256(verifier.as_bytes()));
    let state = b64url(&random(16)?);
    let q = form(&[
        ("response_type", "code"),
        ("client_id", &client_id),
        ("redirect_uri", &redirect),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", &state),
        ("scope", &scope),
        ("resource", &resource),
    ]);
    let auth_url = format!("{authorize}{}{q}", if authorize.contains('?') { '&' } else { '?' });
    crate::git::open_url(&auth_url);
    update(Pending { code: None, url: Some(auth_url) });
    let code = wait_callback(&listener, &state, cancel)?;
    let body = form(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect),
        ("client_id", &client_id),
        ("client_secret", &client_secret),
        ("code_verifier", &verifier),
        ("resource", &resource),
    ]);
    let (status, t) = http("POST", &token_ep, Some("application/x-www-form-urlencoded"), Some(&body))?;
    let mut c = Cred { client_id, client_secret, token_endpoint: token_ep, resource, ..Default::default() };
    apply_token(&mut c, status, &t)?;
    save(id, &c)
}

fn apply_token(c: &mut Cred, status: u16, t: &Value) -> Result<(), String> {
    let access = t["access_token"].as_str().unwrap_or("");
    if !(200..300).contains(&status) || access.is_empty() {
        return Err(format!("Sign-in failed ({status}): {}", t["error_description"].as_str().or(t["error"].as_str()).unwrap_or("")));
    }
    c.access_token = access.into();
    if let Some(r) = t["refresh_token"].as_str() {
        c.refresh_token = r.into();
    }
    c.expires_at = t["expires_in"].as_i64().map(|s| store::now() + s).unwrap_or(0);
    Ok(())
}

fn refresh(id: &str, c: &Cred) -> Result<Cred, String> {
    if c.refresh_token.is_empty() {
        return Err("expired".into());
    }
    let body = form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &c.refresh_token),
        ("client_id", &c.client_id),
        ("client_secret", &c.client_secret),
        ("resource", &c.resource),
    ]);
    let (status, t) = http("POST", &c.token_endpoint, Some("application/x-www-form-urlencoded"), Some(&body))?;
    let mut n = c.clone();
    apply_token(&mut n, status, &t)?;
    save(id, &n)?;
    Ok(n)
}

/// Refreshes OAuth tokens in the background, so turns rarely wait on it.
fn keep_fresh() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| {
            loop {
                for a in APPS.iter().filter(|a| matches!(a.auth, Auth::OAuth)) {
                    if let Some(c) = load(a.id) {
                        if c.expires_at > 0 && c.expires_at - store::now() < 15 * 60 {
                            let _ = refresh(a.id, &c);
                        }
                    }
                }
                std::thread::sleep(Duration::from_secs(300));
            }
        });
    });
}

/// Waits for the browser to come back to the loopback redirect; returns the code.
fn wait_callback(listener: &std::net::TcpListener, state: &str, cancel: &AtomicBool) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let until = Instant::now() + Duration::from_secs(600);
    while Instant::now() < until {
        if cancel.load(Ordering::Relaxed) {
            return Err("Sign-in was cancelled.".into());
        }
        let Ok((mut s, _)) = listener.accept() else {
            std::thread::sleep(Duration::from_millis(150));
            continue;
        };
        let _ = s.set_nonblocking(false);
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        let _ = BufReader::new(&s).read_line(&mut line);
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let Some((path, query)) = target.split_once('?') else {
            let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        };
        if path != "/callback" {
            continue;
        }
        let params: HashMap<String, String> = query.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (dec(k), dec(v))).collect();
        let ok = params.get("state").map(String::as_str) == Some(state) && params.contains_key("code");
        let msg = if ok { "Signed in. You can close this tab and go back to Harbor." } else { "Sign-in failed. Go back to Harbor and try again." };
        let html = format!("<!doctype html><meta charset=utf-8><title>Harbor</title><body style=\"font:16px system-ui;padding:40px\">{msg}</body>");
        let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len());
        if ok {
            return Ok(params["code"].clone());
        }
        let e = params.get("error_description").or(params.get("error")).cloned().unwrap_or_else(|| "state mismatch".into());
        return Err(format!("Sign-in failed: {e}"));
    }
    Err("Sign-in timed out.".into())
}

fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                if let (Some(h), Some(l)) = (hex_digit(b[i + 1]), hex_digit(b[i + 2])) {
                    out.push(h << 4 | l);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One ASCII hex digit's value. Works on bytes, so non-ASCII input never panics.
fn hex_digit(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// SHA-256, for the PKCE challenge.
fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[4 * i], block[4 * i + 1], block[4 * i + 2], block[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    let mut out = [0u8; 32];
    for i in 0..8 {
        out[4 * i..4 * i + 4].copy_from_slice(&h[i].to_be_bytes());
    }
    out
}

// ------------------------------------------------------------------ local servers

/// Locals the user turned off for agents.
fn off_path() -> PathBuf {
    dir().join("mcp-off.json")
}

pub fn is_off(id: &str) -> bool {
    let list: Vec<String> = std::fs::read_to_string(off_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    list.iter().any(|x| x == id)
}

pub fn toggle_off(id: &str) {
    let mut list: Vec<String> = std::fs::read_to_string(off_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if list.iter().any(|x| x == id) {
        list.retain(|x| x != id);
    } else {
        list.push(id.into());
    }
    let _ = write_private(&off_path(), &serde_json::to_string(&list).unwrap_or_default());
}

type Defs = Vec<(&'static Local, Option<(String, Value)>)>;

/// Each local server's name and definition from the user's Claude Code config(s), read
/// only; Playwright falls back to the published package. Cached for a few seconds.
pub fn locals() -> Defs {
    static CACHE: LazyLock<Mutex<Option<(Instant, Defs)>>> = LazyLock::new(Default::default);
    let mut c = CACHE.lock().unwrap();
    if let Some((at, d)) = c.as_ref() {
        if at.elapsed() < Duration::from_secs(5) {
            return d.clone();
        }
    }
    let h = store::home();
    let mut files = vec![h.join(".claude.json")];
    let mut extra: Vec<PathBuf> = std::fs::read_dir(&h)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().strip_prefix(".claude").is_some_and(|n| n.parse::<u32>().is_ok()))
        .map(|e| e.path().join(".claude.json"))
        .collect();
    extra.sort();
    files.extend(extra);
    let servers: Vec<(String, Value)> = files
        .iter()
        .filter_map(|f| serde_json::from_str::<Value>(&std::fs::read_to_string(f).ok()?).ok())
        .flat_map(|j| j["mcpServers"].as_object().cloned().unwrap_or_default())
        .collect();
    let d: Defs = LOCAL
        .iter()
        .map(|l| {
            let found = servers.iter().find(|(n, _)| local_for(n).is_some_and(|x| x.id == l.id)).cloned();
            let found = found.or_else(|| {
                (l.id == "playwright").then(|| ("playwright".into(), json!({ "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless"] })))
            });
            (l, found)
        })
        .collect();
    *c = Some((Instant::now(), d.clone()));
    d
}

// ------------------------------------------------------------------ agent wiring

/// Environment for an agent process and everything it starts: credentials come only
/// from Harbor's store. Not a sandbox (the agent runs as the user), but gh, git, the
/// Convex and Supabase CLIs and their MCP servers no longer find the user's sign-ins.
pub fn agent_env() -> Vec<(String, Option<String>)> {
    keep_fresh();
    agent_env_now()
}

/// [`agent_env`] without starting the token refresher: for a turn's runner, which sets
/// it itself so the tokens never land in the turn's `cmd.json`.
pub fn agent_env_now() -> Vec<(String, Option<String>)> {
    agent_env_as(true)
}

/// [`agent_env_now`]; `signed_in` false: as if nothing were signed in (a chat commanded from
/// another PC, whose person isn't this PC's owner: meshctx.rs).
pub fn agent_env_as(signed_in: bool) -> Vec<(String, Option<String>)> {
    let mut v: Vec<(String, Option<String>)> = vec![];
    for k in ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS", "CONVEX_DEPLOY_KEY", "VERCEL_TOKEN"] {
        v.push((k.into(), None));
    }
    let mut set = |k: &str, val: String| v.push((k.into(), Some(val)));
    let gh = signed_in && gh_token().is_some();
    set("GH_CONFIG_DIR", (if gh { gh_dir() } else { gh_out_dir() }).to_string_lossy().into_owned());
    set("GIT_TERMINAL_PROMPT", "0".into());
    // Command-line scope comes last, so the empty helper resets the user's helpers, and
    // GitHub SSH remotes go through HTTPS, where only Harbor's helper answers.
    let helper = if gh {
        let bin = crate::providers::which("gh").map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "gh".into());
        format!("!'{bin}' auth git-credential")
    } else {
        "!f() { test \"$1\" = get && echo 'Harbor: GitHub is not signed in. Sign in under Settings > Integrations > Apps.' >&2; }; f".into()
    };
    let git = [
        ("credential.helper", String::new()),
        ("credential.https://github.com.helper", String::new()),
        ("credential.https://gist.github.com.helper", String::new()),
        ("credential.https://github.com.helper", helper),
        ("url.https://github.com/.insteadOf", "git@github.com:".into()),
        ("url.https://github.com/.insteadOf", "ssh://git@github.com/".into()),
    ];
    set("GIT_CONFIG_COUNT", git.len().to_string());
    for (i, (k, val)) in git.into_iter().enumerate() {
        set(&format!("GIT_CONFIG_KEY_{i}"), k.into());
        set(&format!("GIT_CONFIG_VALUE_{i}"), val);
    }
    // Set even when signed out: an invalid token wins over ~/.convex and the keyring.
    set("CONVEX_OVERRIDE_ACCESS_TOKEN", convex_token().filter(|_| signed_in).unwrap_or_else(|| "sign-in-to-convex-in-harbor".into()));
    set("SUPABASE_ACCESS_TOKEN", token("supabase").filter(|_| signed_in).unwrap_or_else(|| "sign-in-to-supabase-in-harbor".into()));
    for a in APPS.iter().filter(|a| signed_in && matches!(a.mcp, Transport::Http(_))) {
        if let Some(t) = token(a.id) {
            set(&token_var(a.id), t);
        }
    }
    v
}

/// The env var Codex reads an app's token from.
fn token_var(id: &str) -> String {
    format!("HARBOR_TOKEN_{}", id.to_uppercase())
}

/// Claude Code's `--mcp-config` file for a turn (used with `--strict-mcp-config`): the
/// local servers that are on, the signed-in apps and `extra` (Harbor's team server).
/// Written 0600 into Harbor's store, since it holds tokens.
pub fn claude_config(chat_id: i64, extra: Vec<(&str, Value)>, apps: bool) -> PathBuf {
    let mut m = claude_servers(None);
    for (k, v) in extra {
        m.insert(k.into(), v);
    }
    // A chat commanded from another PC doesn't get this PC's owner's sign-ins (meshctx.rs).
    if !apps {
        m.retain(|k, _| app(k).is_none());
    }
    let p = private_dir(dir().join("run")).join(format!("claude-{chat_id}.json"));
    let _ = write_private(&p, &json!({ "mcpServers": m }).to_string());
    p
}

/// The servers of [`claude_config`], by name.
pub fn claude_servers(extra: Option<(&str, Value)>) -> Map<String, Value> {
    let mut m = Map::new();
    for (l, def) in locals() {
        if let Some((name, v)) = def.filter(|_| !is_off(l.id)) {
            m.insert(name, v);
        }
    }
    for a in APPS {
        let Some(tok) = token(a.id) else { continue };
        let v = match (&a.mcp, &a.auth) {
            (Transport::Http(url), Auth::Key { header, .. }) => json!({ "type": "http", "url": url, "headers": { *header: tok } }),
            (Transport::Http(url), _) => json!({ "type": "http", "url": url, "headers": { "Authorization": format!("Bearer {tok}") } }),
            (Transport::Stdio(argv), _) => json!({ "type": "stdio", "command": argv[0], "args": argv[1..], "env": { "CONVEX_OVERRIDE_ACCESS_TOKEN": tok } }),
        };
        m.insert(a.id.into(), v);
    }
    if let Some((k, v)) = extra {
        m.insert(k.into(), v);
    }
    m
}

/// `-c` overrides for `codex exec`: servers in ~/.codex/config.toml that aren't local
/// tools are turned off, and signed-in apps are added (tokens via env, see [`agent_env`]).
pub fn codex_args() -> Vec<String> {
    let home = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| store::home().join(".codex"));
    let text = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    let mut keys: Vec<String> = vec![];
    for l in text.lines() {
        let Some(rest) = l.trim().strip_prefix("[mcp_servers.") else { continue };
        let key = if let Some(q) = rest.strip_prefix('"') {
            q.split_once('"').map(|(k, _)| format!("\"{k}\"")).unwrap_or_default()
        } else {
            rest.split(['.', ']']).next().unwrap_or("").to_string()
        };
        if !key.is_empty() && !keys.contains(&key) {
            keys.push(key);
        }
    }
    let mut v = vec![];
    let mut c = |s: String| {
        v.push("-c".to_string());
        v.push(s);
    };
    for k in &keys {
        if !local_for(k.trim_matches('"')).is_some_and(|l| !is_off(l.id)) {
            c(format!("mcp_servers.{k}.enabled=false"));
        }
    }
    for a in APPS {
        if token(a.id).is_none() {
            continue;
        }
        let id = a.id;
        match (&a.mcp, &a.auth) {
            (Transport::Http(url), auth) => {
                c(format!("mcp_servers.{id}.url={url:?}"));
                match auth {
                    Auth::Key { header, .. } => c(format!("mcp_servers.{id}.env_http_headers={{{header}={:?}}}", token_var(id))),
                    _ => c(format!("mcp_servers.{id}.bearer_token_env_var={:?}", token_var(id))),
                }
            }
            (Transport::Stdio(argv), _) => {
                let args = argv[1..].iter().map(|a| format!("{a:?}")).collect::<Vec<_>>().join(",");
                c(format!("mcp_servers.{id}.command={:?}", argv[0]));
                c(format!("mcp_servers.{id}.args=[{args}]"));
                c(format!("mcp_servers.{id}.env_vars=[\"CONVEX_OVERRIDE_ACCESS_TOKEN\"]"));
            }
        }
        c(format!("mcp_servers.{id}.enabled=true"));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dec_survives_non_ascii_after_percent() {
        assert_eq!(dec("%1\u{e9}"), "%1\u{e9}");
        assert_eq!(dec("%\u{e9}"), "%\u{e9}");
        assert_eq!(dec("a%41+b%2"), "aA b%2");
        assert_eq!(dec("%C3%A9"), "\u{e9}");
    }

    #[test]
    fn sha256_matches_known_vectors() {
        let hex = |b: [u8; 32]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(hex(sha256(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(hex(sha256(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(hex(sha256(&[b'a'; 1000])), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    }

    #[test]
    fn device_codes_and_names() {
        assert!(is_code("62FA-3B18") && is_code("(VZGR-TRNQ)") && !is_code("https://x"));
        assert_eq!(local_for("Roblox Studio").map(|l| l.id), Some("robloxstudio"));
        assert_eq!(local_for("blender-mcp").map(|l| l.id), Some("blender"));
        assert!(local_for("convex").is_none() && local_for("github").is_none());
        assert_eq!(dec("a%20b+c%3D"), "a b c=");
    }
}
