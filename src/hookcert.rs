//! Webhooks from the internet without Tailscale Funnel: public HTTPS for `/hooks` only.
//!
//! Webhook senders (GitHub, Vercel, Linear…) won't pin Harbor's own key, so this listener has a
//! certificate they trust: Harbor gets one from Let's Encrypt itself (ACME, RFC 8555) with the
//! TLS-ALPN-01 challenge (RFC 8737), answered on this same listener, so no web server and no
//! port 80 are needed. Its name is the user's own (kv `hooks_name`) or, by default, one that
//! needs no account anywhere: the public address spelled as an sslip.io name
//! (203.0.113.7 → `203-0-113-7.sslip.io`, which resolves to that address).
//!
//! The listener (port 47911, every interface) answers nothing but `/hooks/<token>` of a live
//! webhook (control.rs `serve_hook`: per-token rate limit, GitHub's HMAC signature when sent,
//! 404 for anything else), and ACME's validation handshakes. Let's Encrypt checks on port 443,
//! so the router must send 443 here: Harbor asks it (portmap.rs); else the user forwards it.
//! Off by default (Settings › Webhooks, kv `hooks_public`): unlike the phone API this endpoint
//! answers anyone who knows a webhook's URL, which is what a webhook is.
//!
//! Without a certificate yet, the listener shows Harbor's own key; GitHub can still deliver
//! with "SSL verification" off, the signature (secret = the token) still checked.

use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::Write;
use std::net::{IpAddr, TcpListener};
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// The public webhook listener's port (the router maps 443 to it).
pub const PORT: u16 = 47911;
const LETS_ENCRYPT: &str = "https://acme-v02.api.letsencrypt.org/directory";
const ALPN_ACME: &[u8] = b"acme-tls/1";

/// What Settings shows.
#[derive(Clone, Debug, Default)]
pub struct Status {
    /// The name the certificate is (or will be) for.
    pub name: String,
    /// The public URL base, once a certificate is in: "https://<name>/hooks".
    pub base: Option<String>,
    /// How port 443 reaches this PC ("UPnP …", or why not).
    pub route: String,
    /// The last thing that went wrong, for the user.
    pub error: String,
    /// When the certificate runs out (unix time).
    pub expires: i64,
    pub busy: bool,
}

pub static STATUS: LazyLock<Mutex<Status>> = LazyLock::new(Default::default);

pub fn status() -> Status {
    STATUS.lock().unwrap().clone()
}

/// "https://<name>/hooks" when webhooks are public and have a certificate.
pub fn public_base() -> Option<String> {
    STATUS.lock().unwrap().base.clone()
}

// ================================================================== small helpers

/// base64url without padding (JOSE).
pub fn b64u(data: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        if c.len() > 1 {
            out.push(A[(n >> 6) as usize & 63] as char);
        }
        if c.len() > 2 {
            out.push(A[n as usize & 63] as char);
        }
    }
    out
}

/// The default name for a public address: an sslip.io name that resolves to it.
pub fn sslip_name(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v) => format!("{}.sslip.io", v.to_string().replace('.', "-")),
        IpAddr::V6(v) => format!("{}.sslip.io", v.to_string().replace(':', "-")),
    }
}

fn dir() -> PathBuf {
    crate::store::state_dir()
}

fn write_private(name: &str, data: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = dir().join(format!("{name}.{}", std::process::id()));
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    std::fs::rename(&tmp, dir().join(name))
}

// ================================================================== ACME account (JWS ES256)

/// The ACME account key (`acme-account.pem`), kept apart from Harbor's identity.
pub struct Account {
    key: ring::signature::EcdsaKeyPair,
    /// The account URL ("kid") once registered.
    pub kid: Option<String>,
}

impl Account {
    pub fn load_or_create() -> Result<Account, String> {
        let path = dir().join("acme-account.pem");
        let pem = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => {
                let kp = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
                let pem = kp.serialize_pem();
                write_private("acme-account.pem", pem.as_bytes()).map_err(|e| e.to_string())?;
                pem.into_bytes()
            }
        };
        Self::from_pem(&pem)
    }

    pub fn from_pem(pem: &[u8]) -> Result<Account, String> {
        use rustls::pki_types::pem::PemObject;
        let der = rustls::pki_types::PrivatePkcs8KeyDer::from_pem_slice(pem).map_err(|e| e.to_string())?;
        let key = ring::signature::EcdsaKeyPair::from_pkcs8(&ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING, der.secret_pkcs8_der(), &ring::rand::SystemRandom::new()).map_err(|e| e.to_string())?;
        Ok(Account { key, kid: None })
    }

    /// The public key as a JWK (members in the order RFC 7638's thumbprint needs).
    pub fn jwk(&self) -> String {
        use ring::signature::KeyPair;
        let p = self.key.public_key().as_ref(); // 0x04 || X || Y
        format!(r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#, b64u(&p[1..33]), b64u(&p[33..65]))
    }

    /// RFC 7638 thumbprint, for key authorizations.
    pub fn thumbprint(&self) -> String {
        b64u(ring::digest::digest(&ring::digest::SHA256, self.jwk().as_bytes()).as_ref())
    }

    /// A JWS for `url` (`payload` None: POST-as-GET).
    pub fn jws(&self, url: &str, nonce: &str, payload: Option<&Value>) -> Result<String, String> {
        let mut protected = json!({ "alg": "ES256", "nonce": nonce, "url": url });
        match &self.kid {
            Some(k) => protected["kid"] = json!(k),
            None => protected["jwk"] = serde_json::from_str(&self.jwk()).map_err(|e| e.to_string())?,
        }
        let p64 = b64u(protected.to_string().as_bytes());
        let b64 = payload.map(|p| b64u(p.to_string().as_bytes())).unwrap_or_default();
        let sig = self.key.sign(&ring::rand::SystemRandom::new(), format!("{p64}.{b64}").as_bytes()).map_err(|_| "can't sign")?;
        Ok(json!({ "protected": p64, "payload": b64, "signature": b64u(sig.as_ref()) }).to_string())
    }
}

// ================================================================== ACME client (over curl, like the rest of Harbor)

/// One HTTPS request: (status, headers lowercased, body).
fn curl(method: &str, url: &str, body: Option<&str>) -> Result<(u16, Vec<(String, String)>, String), String> {
    let mut c = std::process::Command::new("curl");
    c.args(["-sS", "--max-time", "30", "-D", "-", url]);
    if method != "HEAD" && method != "GET" {
        c.args(["-X", method]);
    }
    // Tests against a local ACME server (Pebble) bring their own CA.
    if let Ok(ca) = std::env::var("HARBOR_ACME_CA") {
        c.args(["--cacert", &ca]);
    }
    if method == "HEAD" {
        c.arg("-I");
    }
    if body.is_some() {
        c.args(["-H", "Content-Type: application/jose+json", "--data-binary", "@-"]);
    }
    c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("curl: {e}"))?;
    if let Some(b) = body {
        let _ = child.stdin.take().map(|mut i| i.write_all(b.as_bytes()));
    } else {
        drop(child.stdin.take());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("{url}: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    // Skip "100 Continue" heads; the last head is the answer's.
    let mut rest = text.as_str();
    loop {
        let (head, body) = rest.split_once("\r\n\r\n").unwrap_or((rest, ""));
        let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        if status == 100 {
            rest = body;
            continue;
        }
        let headers = head.lines().skip(1).filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
        return Ok((status, headers, body.to_string()));
    }
}

fn header<'a>(h: &'a [(String, String)], k: &str) -> Option<&'a str> {
    h.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str())
}

struct Acme {
    dir: Value,
    account: Account,
    nonce: String,
}

impl Acme {
    fn new(directory: &str) -> Result<Acme, String> {
        let (st, _, body) = curl("GET", directory, None)?;
        if st != 200 {
            return Err(format!("the ACME directory answered {st}"));
        }
        let dir: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let mut a = Acme { dir, account: Account::load_or_create()?, nonce: String::new() };
        a.fresh_nonce()?;
        Ok(a)
    }

    fn fresh_nonce(&mut self) -> Result<(), String> {
        let url = self.dir["newNonce"].as_str().ok_or("no newNonce")?.to_string();
        let (_, h, _) = curl("HEAD", &url, None)?;
        self.nonce = header(&h, "replay-nonce").ok_or("no nonce")?.to_string();
        Ok(())
    }

    /// A signed POST; retried once on a stale nonce.
    fn post(&mut self, url: &str, payload: Option<&Value>) -> Result<(u16, Vec<(String, String)>, Value), String> {
        for _ in 0..2 {
            let body = self.account.jws(url, &self.nonce, payload)?;
            let (st, h, text) = curl("POST", url, Some(&body))?;
            if let Some(n) = header(&h, "replay-nonce") {
                self.nonce = n.to_string();
            }
            let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if st == 400 && v["type"].as_str().is_some_and(|t| t.ends_with(":badNonce")) {
                continue;
            }
            if st >= 400 {
                return Err(v["detail"].as_str().map(String::from).unwrap_or_else(|| format!("{url} answered {st}")));
            }
            return Ok((st, h, v));
        }
        Err("the ACME server kept refusing the nonce".into())
    }

    fn register(&mut self) -> Result<(), String> {
        let url = self.dir["newAccount"].as_str().ok_or("no newAccount")?.to_string();
        let (_, h, _) = self.post(&url, Some(&json!({ "termsOfServiceAgreed": true })))?;
        self.account.kid = Some(header(&h, "location").ok_or("no account URL")?.to_string());
        Ok(())
    }

    /// Polls a URL (POST-as-GET) until its status leaves `pending`/`processing`.
    fn wait(&mut self, url: &str) -> Result<Value, String> {
        for _ in 0..30 {
            let (_, _, v) = self.post(url, None)?;
            match v["status"].as_str() {
                Some("pending") | Some("processing") => std::thread::sleep(Duration::from_secs(2)),
                _ => return Ok(v),
            }
        }
        Err("the ACME server took too long".into())
    }
}

/// The certificate the challenge handshake shows: for `name`, with the key authorization's digest.
pub fn challenge_cert(name: &str, key_auth: &str) -> Result<Arc<rustls::sign::CertifiedKey>, String> {
    let kp = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let mut p = rcgen::CertificateParams::new(vec![name.to_string()]).map_err(|e| e.to_string())?;
    let digest = ring::digest::digest(&ring::digest::SHA256, key_auth.as_bytes());
    p.custom_extensions = vec![rcgen::CustomExtension::new_acme_identifier(digest.as_ref())];
    let cert = p.self_signed(&kp).map_err(|e| e.to_string())?;
    certified(vec![cert.der().clone()], kp.serialize_der())
}

fn certified(chain: Vec<rustls::pki_types::CertificateDer<'static>>, pkcs8: Vec<u8>) -> Result<Arc<rustls::sign::CertifiedKey>, String> {
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(pkcs8.into());
    let signer = rustls::crypto::ring::sign::any_supported_type(&key).map_err(|e| e.to_string())?;
    Ok(Arc::new(rustls::sign::CertifiedKey::new(chain, signer)))
}

/// Gets a certificate for `name` (TLS-ALPN-01 answered by the listener through [`CHALLENGE`]):
/// (chain PEM, key PEM).
pub fn obtain(directory: &str, name: &str) -> Result<(String, String), String> {
    let mut a = Acme::new(directory)?;
    a.register()?;
    let new_order = a.dir["newOrder"].as_str().ok_or("no newOrder")?.to_string();
    let (_, h, order) = a.post(&new_order, Some(&json!({ "identifiers": [{ "type": "dns", "value": name }] })))?;
    let order_url = header(&h, "location").ok_or("no order URL")?.to_string();
    for auth in order["authorizations"].as_array().cloned().unwrap_or_default() {
        let auth = auth.as_str().ok_or("bad authorization")?.to_string();
        let (_, _, az) = a.post(&auth, None)?;
        if az["status"] == "valid" {
            continue;
        }
        let ch = az["challenges"].as_array().into_iter().flatten().find(|c| c["type"] == "tls-alpn-01").cloned().ok_or("the ACME server offers no TLS-ALPN-01 challenge")?;
        let key_auth = format!("{}.{}", ch["token"].as_str().ok_or("no token")?, a.account.thumbprint());
        *CHALLENGE.lock().unwrap() = Some((name.to_ascii_lowercase(), challenge_cert(name, &key_auth)?));
        let url = ch["url"].as_str().ok_or("no challenge URL")?.to_string();
        a.post(&url, Some(&json!({})))?;
        let done = a.wait(&auth);
        *CHALLENGE.lock().unwrap() = None;
        let done = done?;
        if done["status"] != "valid" {
            let why = done["challenges"].as_array().into_iter().flatten().find_map(|c| c["error"]["detail"].as_str().map(String::from)).unwrap_or_else(|| "validation failed".into());
            return Err(format!("Let's Encrypt couldn't reach {name}:443 ({why})"));
        }
    }
    // The certificate's own key, and its request.
    let kp = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let p = rcgen::CertificateParams::new(vec![name.to_string()]).map_err(|e| e.to_string())?;
    let csr = p.serialize_request(&kp).map_err(|e| e.to_string())?;
    let fin = order["finalize"].as_str().ok_or("no finalize URL")?.to_string();
    a.post(&fin, Some(&json!({ "csr": b64u(csr.der()) })))?;
    let order = a.wait(&order_url)?;
    let cert_url = order["certificate"].as_str().ok_or_else(|| format!("the order ended {}", order["status"]))?.to_string();
    let body = a.account.jws(&cert_url, &a.nonce, None)?;
    let (st, _, pem) = curl("POST", &cert_url, Some(&body))?;
    if st != 200 || !pem.contains("BEGIN CERTIFICATE") {
        return Err(format!("the certificate download answered {st}"));
    }
    Ok((pem, kp.serialize_pem()))
}

// ================================================================== the listener

/// A pending TLS-ALPN-01 challenge: (name, its certificate).
pub static CHALLENGE: LazyLock<Mutex<Option<(String, Arc<rustls::sign::CertifiedKey>)>>> = LazyLock::new(Default::default);
/// The certificate webhooks are served with (None: Harbor's own key).
static CERT: LazyLock<Mutex<Option<Arc<rustls::sign::CertifiedKey>>>> = LazyLock::new(Default::default);

#[derive(Debug)]
struct Resolver;

impl rustls::server::ResolvesServerCert for Resolver {
    fn resolve(&self, hello: rustls::server::ClientHello<'_>) -> Option<Arc<rustls::sign::CertifiedKey>> {
        let acme = hello.alpn().is_some_and(|mut a| a.any(|p| p == ALPN_ACME));
        if acme {
            let sni = hello.server_name().unwrap_or("").to_ascii_lowercase();
            return CHALLENGE.lock().unwrap().as_ref().filter(|(n, _)| *n == sni).map(|(_, c)| c.clone());
        }
        if let Some(c) = CERT.lock().unwrap().clone() {
            return Some(c);
        }
        let id = crate::tls::me().ok()?;
        certified(vec![id.cert.clone()], id_key_der()?).ok()
    }
}

fn id_key_der() -> Option<Vec<u8>> {
    use rustls::pki_types::pem::PemObject;
    let pem = std::fs::read(dir().join("identity.pem")).ok()?;
    rustls::pki_types::PrivatePkcs8KeyDer::from_pem_slice(&pem).ok().map(|k| k.secret_pkcs8_der().to_vec())
}

fn server_config() -> Arc<rustls::ServerConfig> {
    let mut c = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .expect("TLS versions")
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(Resolver));
    c.alpn_protocols = vec![ALPN_ACME.to_vec(), b"http/1.1".to_vec()];
    Arc::new(c)
}

/// Loads a certificate saved before (`hooks-cert.pem`, `hooks-key.pem`): (name, expiry).
pub fn load_saved() -> Option<(String, i64)> {
    use rustls::pki_types::pem::PemObject;
    let chain: Vec<rustls::pki_types::CertificateDer<'static>> = rustls::pki_types::CertificateDer::pem_file_iter(dir().join("hooks-cert.pem")).ok()?.filter_map(|c| c.ok()).collect();
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from_pem_file(dir().join("hooks-key.pem")).ok()?;
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir().join("hooks-cert.json")).ok()?).ok()?;
    let ck = certified(chain, key.secret_pkcs8_der().to_vec()).ok()?;
    *CERT.lock().unwrap() = Some(ck);
    Some((meta["name"].as_str()?.to_string(), meta["expires"].as_i64()?))
}

/// Starts the public listener once (every interface, [`PORT`]).
fn listen(tokens: Arc<Mutex<HashSet<String>>>, tx: Sender<crate::control::Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    static CONNS: crate::api::Conns = crate::api::Conns::new(32);
    let cfg = server_config();
    for host in ["::", "0.0.0.0"] {
        let Ok(l) = TcpListener::bind((host, PORT)) else { continue };
        let (cfg, tokens, tx, wake) = (cfg.clone(), tokens.clone(), tx.clone(), wake.clone());
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                // Off: closed without a word.
                if !ON.load(std::sync::atomic::Ordering::Relaxed) {
                    continue;
                }
                let Some(host) = s.peer_addr().ok().and_then(|a| crate::api::HostSlot::take(a.ip())) else { continue };
                let Some(slot) = CONNS.take() else { continue };
                let (cfg, tokens, tx, wake) = (cfg.clone(), tokens.clone(), tx.clone(), wake.clone());
                std::thread::spawn(move || {
                    let _slot = (slot, host);
                    let Ok(mut c) = crate::tls::accept(s, || Some(cfg), crate::api::HEAD_WAIT, Duration::from_secs(10)) else { return };
                    if !c.is_tls() {
                        let _ = c.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        return;
                    }
                    let mut r = std::io::BufReader::new(c);
                    let head = crate::api::read_head_chunked(&mut r);
                    r.get_ref().clear_deadline();
                    let mut out = Vec::new();
                    crate::control::serve_hook(head, &mut r, &mut out, &tokens, &tx, &wake);
                    let _ = r.get_mut().write_all(&out);
                    let _ = r.get_mut().flush();
                });
            }
        });
    }
}

static ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Keeps public webhooks going while kv `hooks_public` is on: the listener, port 443 on the router,
/// the name, and a certificate renewed 30 days before it runs out. Checks every 20 minutes, and
/// at once after `kick`.
pub fn start(tokens: Arc<Mutex<HashSet<String>>>, tx: Sender<crate::control::Incoming>, wake: impl Fn() + Send + Sync + Clone + 'static) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let saved = load_saved();
        loop {
            let store = crate::store::Store::open().ok();
            let on = store.as_ref().and_then(|s| s.get("hooks_public")).as_deref() == Some("1");
            ON.store(on, std::sync::atomic::Ordering::SeqCst);
            if on {
                // The port is only opened once it's wanted.
                listen(tokens.clone(), tx.clone(), wake.clone());
                round(store.as_ref(), &saved);
            } else {
                *STATUS.lock().unwrap() = Status::default();
            }
            wake();
            let (lock, cv) = &*KICK;
            let g = lock.lock().unwrap();
            let _ = cv.wait_timeout(g, Duration::from_secs(20 * 60));
        }
    });
}

static KICK: LazyLock<(Mutex<()>, std::sync::Condvar)> = LazyLock::new(Default::default);

/// Look again now (Settings changed, or Check): also retries a certificate at once.
pub fn kick() {
    FORCE.store(true, std::sync::atomic::Ordering::SeqCst);
    KICK.1.notify_all();
}

static FORCE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// When getting a certificate last failed: it's tried again 6 hours later (or on Check), so a
/// PC that can't be reached doesn't run into Let's Encrypt's limits on failed validations.
static FAILED: LazyLock<Mutex<Option<std::time::Instant>>> = LazyLock::new(Default::default);

fn round(store: Option<&crate::store::Store>, saved: &Option<(String, i64)>) {
    let mut st = STATUS.lock().unwrap().clone();
    st.busy = true;
    st.error.clear();
    *STATUS.lock().unwrap() = st.clone();
    // Port 443 outside → the listener here.
    let mapped = crate::portmap::map_to(PORT, 443);
    let public: Option<IpAddr> = match &mapped {
        Ok((how, a)) if a.port() == 443 && crate::portmap::is_public(a.ip()) => {
            st.route = format!("{how}: {}:443 → this PC", a.ip());
            Some(a.ip())
        }
        Ok((how, a)) => {
            st.route = format!("{how} mapped {a}, but Let's Encrypt needs port 443 on a public address");
            None
        }
        Err(e) => {
            st.route = format!("Your router didn't open port 443 ({e}). Forward TCP 443 to this PC, port {PORT}, on the router.");
            None
        }
    };
    let name = store.and_then(|s| s.get("hooks_name")).filter(|n| !n.trim().is_empty()).map(|n| n.trim().to_ascii_lowercase()).or_else(|| public.map(sslip_name)).or_else(|| saved.as_ref().map(|(n, _)| n.clone())).unwrap_or_default();
    st.name = name.clone();
    let have = load_saved();
    let now = crate::store::now();
    let fresh = have.as_ref().is_some_and(|(n, exp)| *n == name && *exp - now > 30 * 86400);
    let forced = FORCE.swap(false, std::sync::atomic::Ordering::SeqCst);
    let waiting = FAILED.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_secs(6 * 3600)) && !forced;
    if !name.is_empty() && !fresh && waiting {
        st.error = format!("{} (tried again later, or press Check)", STATUS.lock().unwrap().error.trim_end_matches(" (tried again later, or press Check)"));
    } else if !name.is_empty() && !fresh {
        let directory = std::env::var("HARBOR_ACME_DIR").unwrap_or_else(|_| LETS_ENCRYPT.to_string());
        match obtain(&directory, &name) {
            Ok((chain, key)) => {
                let expires = now + 90 * 86400;
                let ok = write_private("hooks-cert.pem", chain.as_bytes()).and_then(|_| write_private("hooks-key.pem", key.as_bytes())).and_then(|_| write_private("hooks-cert.json", json!({ "name": name, "expires": expires }).to_string().as_bytes()));
                if let Err(e) = ok {
                    st.error = format!("couldn't save the certificate: {e}");
                }
            }
            Err(e) => {
                eprintln!("harbor: no certificate for public webhooks: {e}");
                *FAILED.lock().unwrap() = Some(std::time::Instant::now());
                st.error = e;
            }
        }
    } else if name.is_empty() {
        st.error = "no public address to name: the router doesn't map port 443, and no name is set".into();
    }
    match load_saved() {
        Some((n, exp)) if n == name => {
            st.base = Some(format!("https://{n}/hooks"));
            st.expires = exp;
        }
        _ => st.base = None,
    }
    st.busy = false;
    *STATUS.lock().unwrap() = st;
}

/// For tests and `harbor hooks`: serves one name's TLS-ALPN-01 challenge on a given listener.
#[cfg(test)]
pub fn test_config() -> Arc<rustls::ServerConfig> {
    server_config()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url() {
        assert_eq!(b64u(b""), "");
        assert_eq!(b64u(b"f"), "Zg");
        assert_eq!(b64u(b"fo"), "Zm8");
        assert_eq!(b64u(b"foo"), "Zm9v");
        assert_eq!(b64u(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn names() {
        assert_eq!(sslip_name("203.0.113.7".parse().unwrap()), "203-0-113-7.sslip.io");
        assert_eq!(sslip_name("2001:db8::7".parse().unwrap()), "2001-db8--7.sslip.io");
    }

    #[test]
    fn jws_and_thumbprint() {
        let kp = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let a = Account::from_pem(kp.serialize_pem().as_bytes()).unwrap();
        let jwk: Value = serde_json::from_str(&a.jwk()).unwrap();
        assert_eq!((jwk["kty"].as_str(), jwk["crv"].as_str()), (Some("EC"), Some("P-256")));
        assert_eq!(a.thumbprint().len(), 43, "base64url of 32 bytes");
        let j: Value = serde_json::from_str(&a.jws("https://acme.example/new-acct", "n0nce", Some(&json!({ "a": 1 }))).unwrap()).unwrap();
        // The signature checks out against the JWK's key.
        let input = format!("{}.{}", j["protected"].as_str().unwrap(), j["payload"].as_str().unwrap());
        let sig = b64d(j["signature"].as_str().unwrap());
        use ring::signature::KeyPair;
        let pk = ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, a.key.public_key().as_ref().to_vec());
        assert!(pk.verify(input.as_bytes(), &sig).is_ok());
        let prot: Value = serde_json::from_slice(&b64d(j["protected"].as_str().unwrap())).unwrap();
        assert_eq!(prot["alg"], "ES256");
        assert!(prot["jwk"].is_object() && prot["kid"].is_null(), "no account yet: the key itself");
        // POST-as-GET: an empty payload.
        let g: Value = serde_json::from_str(&a.jws("https://acme.example/x", "n", None).unwrap()).unwrap();
        assert_eq!(g["payload"], "");
    }

    fn b64d(s: &str) -> Vec<u8> {
        let a = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut bits = 0u32;
        let mut n = 0;
        let mut out = vec![];
        for c in s.bytes() {
            bits = bits << 6 | a.iter().position(|x| *x == c).unwrap() as u32;
            n += 6;
            if n >= 8 {
                n -= 8;
                out.push((bits >> n) as u8);
            }
        }
        out
    }

    /// The challenge handshake: a client offering acme-tls/1 for the name gets the challenge
    /// certificate (with the acmeIdentifier extension); other names get nothing.
    #[test]
    fn tls_alpn_challenge() {
        let cert = challenge_cert("hooks.example.org", "token.thumb").unwrap();
        *CHALLENGE.lock().unwrap() = Some(("hooks.example.org".into(), cert.clone()));
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let cfg = test_config();
        std::thread::spawn(move || {
            for s in l.incoming().take(2).flatten() {
                let _ = crate::tls::accept(s, || Some(cfg.clone()), Duration::from_secs(5), Duration::from_secs(5));
            }
        });
        let shake = |name: &str| -> Option<Vec<u8>> {
            let mut c = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_protocol_versions(&[&rustls::version::TLS13])
                .unwrap()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(AnyCert))
                .with_no_client_auth();
            c.alpn_protocols = vec![ALPN_ACME.to_vec()];
            let mut conn = rustls::ClientConnection::new(Arc::new(c), rustls::pki_types::ServerName::try_from(name.to_string()).unwrap()).ok()?;
            let mut s = std::net::TcpStream::connect(addr).ok()?;
            while conn.is_handshaking() {
                conn.complete_io(&mut s).ok()?;
            }
            assert_eq!(conn.alpn_protocol(), Some(ALPN_ACME));
            conn.peer_certificates().map(|c| c[0].to_vec())
        };
        let got = shake("hooks.example.org").unwrap();
        assert_eq!(got, cert.cert[0].to_vec());
        // The acmeIdentifier extension (OID 1.3.6.1.5.5.7.1.31) carries the digest.
        let digest = ring::digest::digest(&ring::digest::SHA256, b"token.thumb");
        assert!(got.windows(32).any(|w| w == digest.as_ref()));
        assert!(shake("other.example.org").is_none());
        *CHALLENGE.lock().unwrap() = None;
    }

    #[derive(Debug)]
    struct AnyCert;
    impl rustls::client::danger::ServerCertVerifier for AnyCert {
        fn verify_server_cert(&self, _: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>], _: &rustls::pki_types::ServerName<'_>, _: &[u8], _: rustls::pki_types::UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
        }
    }
}
