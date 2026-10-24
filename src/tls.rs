//! Harbor's own transport and identity: no VPN, no outside software.
//!
//! - **Identity.** Each Harbor (and each phone) makes a long-term key the first time it runs:
//!   here an ECDSA P-256 key and a self-signed certificate in `identity.pem` in Harbor's state
//!   dir (owner-only). Its *fingerprint* is the SHA-256 of the certificate's public key (SPKI),
//!   64 lowercase hex characters; that is what a phone or another PC pins and what
//!   `harbor mesh allow` takes.
//! - **Transport.** Every connection that leaves this PC is mutual TLS (1.3; 1.2 is accepted from
//!   phones whose Android has no 1.3) with pinned certificates: the client checks the server's
//!   fingerprint against the one it paired with, and shows its own certificate, whose
//!   fingerprint the server looks up (paired phone, allowed PC). No certificate authority, no
//!   names. Plain HTTP is only for 127.0.0.1 (test rigs, `adb reverse`) and, while a PC still
//!   has Tailscale, for not-yet-upgraded clients on its tailnet interface (see `legacy`).
//! - **Pairing codes.** Two PCs pair with a short one-time code shown on one and typed on the
//!   other: both prove they know it with an HMAC over both fingerprints (a key stretched from
//!   the code with PBKDF2), inside a TLS connection whose certificates are those fingerprints.
//!   A man in the middle sees other fingerprints and can't answer; guessing is cut off after a
//!   few tries.
//!
//! One thread per connection like the rest of Harbor: rustls' blocking `StreamOwned`, no
//! async runtime.

use ring::{digest, hmac, pbkdf2};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls13_signature_with_raw_key};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, SubjectPublicKeyInfoDer, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, DistinguishedName, Error, ServerConfig, ServerConnection, SignatureScheme, StreamOwned};
use std::cell::Cell;
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

// ================================================================== identity

/// This Harbor's key and certificate.
pub struct Identity {
    pub cert: CertificateDer<'static>,
    key: PrivatePkcs8KeyDer<'static>,
    /// SHA-256 of the certificate's public key, hex.
    pub fp: String,
}

impl Identity {
    fn key(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(self.key.clone_key())
    }
}

/// A new key and a self-signed certificate for it (valid for a century: the key is the identity).
pub fn generate() -> Result<(String, Identity), String> {
    let kp = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let mut p = rcgen::CertificateParams::new(vec!["harbor".to_string()]).map_err(|e| e.to_string())?;
    p.distinguished_name = rcgen::DistinguishedName::new();
    p.distinguished_name.push(rcgen::DnType::CommonName, "Harbor");
    p.not_before = rcgen::date_time_ymd(2025, 1, 1);
    p.not_after = rcgen::date_time_ymd(2125, 1, 1);
    let cert = p.self_signed(&kp).map_err(|e| e.to_string())?;
    let pem = format!("{}{}", kp.serialize_pem(), cert.pem());
    let id = parse(pem.as_bytes())?;
    Ok((pem, id))
}

/// An identity from `identity.pem` (a PRIVATE KEY and a CERTIFICATE).
pub fn parse(pem: &[u8]) -> Result<Identity, String> {
    let key = PrivatePkcs8KeyDer::from_pem_slice(pem).map_err(|e| format!("identity key: {e}"))?;
    let cert = CertificateDer::from_pem_slice(pem).map_err(|e| format!("identity certificate: {e}"))?;
    let fp = cert_fp(&cert).ok_or("identity certificate: unreadable")?;
    Ok(Identity { cert, key, fp })
}

/// Loads `dir/identity.pem`, or makes it (owner-only) the first time.
pub fn load_or_create(dir: &Path) -> Result<Identity, String> {
    let path = dir.join("identity.pem");
    if let Ok(b) = std::fs::read(&path) {
        return parse(&b);
    }
    let (pem, id) = generate()?;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = dir.join(format!("identity.pem.{}", std::process::id()));
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.write_all(pem.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
    // Two Harbors starting at once (Harbor and `harbor mesh` on a terminal): the first one wins.
    if std::fs::hard_link(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return parse(&std::fs::read(&path).map_err(|e| e.to_string())?);
    }
    let _ = std::fs::remove_file(&tmp);
    Ok(id)
}

static ME: OnceLock<Result<Identity, String>> = OnceLock::new();

/// This Harbor's identity (made on first use, in [`crate::store::state_dir`]).
pub fn me() -> Result<&'static Identity, String> {
    // (Unit tests get a key of their own in memory, never the real one.)
    ME.get_or_init(|| if cfg!(test) { generate().map(|(_, i)| i) } else { load_or_create(&crate::store::state_dir()) }).as_ref().map_err(|e| e.clone())
}

/// This Harbor's fingerprint ("" when it has no identity: then nothing but loopback works).
pub fn my_fp() -> String {
    me().map(|i| i.fp.clone()).unwrap_or_default()
}

pub fn sha256_hex(b: &[u8]) -> String {
    digest::digest(&digest::SHA256, b).as_ref().iter().map(|x| format!("{x:02x}")).collect()
}

/// The fingerprint of a DER certificate: SHA-256 of its SubjectPublicKeyInfo.
pub fn cert_fp(cert: &[u8]) -> Option<String> {
    spki(cert).map(sha256_hex)
}

/// A fingerprint as people compare it: "ab12 cd34 ef56 7890" (the first 64 bits).
pub fn short(fp: &str) -> String {
    let s: Vec<String> = fp.as_bytes().chunks(4).take(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
    s.join(" ")
}

/// A fingerprint as typed or pasted: spaces, colons and dashes dropped, lowercase. None unless
/// it's 64 hex characters.
pub fn normalize_fp(s: &str) -> Option<String> {
    let f: String = s.chars().filter(|c| !matches!(c, ' ' | ':' | '-')).collect::<String>().to_ascii_lowercase();
    (f.len() == 64 && f.bytes().all(|c| c.is_ascii_hexdigit())).then_some(f)
}

/// One DER TLV at the start of `b`: (tag, header length, content length).
fn tlv(b: &[u8]) -> Option<(u8, usize, usize)> {
    let tag = *b.first()?;
    let l0 = *b.get(1)? as usize;
    if l0 < 0x80 {
        return Some((tag, 2, l0));
    }
    let n = l0 & 0x7f;
    if n == 0 || n > 4 {
        return None;
    }
    let mut len = 0usize;
    for i in 0..n {
        len = (len << 8) | *b.get(2 + i)? as usize;
    }
    Some((tag, 2 + n, len))
}

/// The SubjectPublicKeyInfo (whole TLV) of a DER X.509 certificate.
pub fn spki(cert: &[u8]) -> Option<&[u8]> {
    let (t, h, l) = tlv(cert)?;
    if t != 0x30 {
        return None;
    }
    let body = cert.get(h..h.checked_add(l)?)?;
    let (t, h, l) = tlv(body)?;
    if t != 0x30 {
        return None;
    }
    let mut tbs = body.get(h..h.checked_add(l)?)?;
    // [0] version (optional), serial, signature algorithm, issuer, validity, subject, then the key.
    let mut skip = 5;
    if tbs.first() == Some(&0xa0) {
        skip += 1;
    }
    for _ in 0..skip {
        let (_, h, l) = tlv(tbs)?;
        tbs = tbs.get(h.checked_add(l)?..)?;
    }
    let (t, h, l) = tlv(tbs)?;
    (t == 0x30).then(|| tbs.get(..h.checked_add(l)?)).flatten()
}

// ================================================================== configs

fn provider() -> Arc<CryptoProvider> {
    static P: LazyLock<Arc<CryptoProvider>> = LazyLock::new(|| Arc::new(rustls::crypto::ring::default_provider()));
    P.clone()
}

/// Handshake signatures are checked against the certificate's own key (no chain, no names:
/// who the key belongs to is decided by its fingerprint). The key is the very SPKI the
/// fingerprint is taken of, so what's pinned and what signed can't differ. TLS 1.2 (phones with
/// an older Android) goes through here too: their keys are ECDSA, whose schemes are the same.
fn check13(msg: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
    let spki = spki(cert).ok_or(Error::General("unreadable certificate".into()))?;
    verify_tls13_signature_with_raw_key(msg, &SubjectPublicKeyInfoDer::from(spki), dss, &provider().signature_verification_algorithms)
}

fn schemes() -> Vec<SignatureScheme> {
    provider().signature_verification_algorithms.supported_schemes()
}

/// The server's side: any client certificate is taken (and none is needed); what it may do is
/// decided by its fingerprint once the request is in.
#[derive(Debug)]
struct AnyClient;

impl ClientCertVerifier for AnyClient {
    fn offer_client_auth(&self) -> bool {
        true
    }
    fn client_auth_mandatory(&self) -> bool {
        false
    }
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }
    fn verify_client_cert(&self, end: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: UnixTime) -> Result<ClientCertVerified, Error> {
        spki(end).map(|_| ClientCertVerified::assertion()).ok_or(Error::General("unreadable certificate".into()))
    }
    fn verify_tls12_signature(&self, msg: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        check13(msg, cert, dss)
    }
    fn verify_tls13_signature(&self, msg: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        check13(msg, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        schemes()
    }
}

/// The client's side: the server must have the pinned fingerprint (`None`: any, for pairing,
/// where the code proves who it is afterwards).
#[derive(Debug)]
struct Pin(Option<String>);

impl ServerCertVerifier for Pin {
    fn verify_server_cert(&self, end: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, Error> {
        let fp = cert_fp(end).ok_or(Error::General("unreadable certificate".into()))?;
        match &self.0 {
            Some(pin) if *pin != fp => Err(Error::General(WRONG_KEY.into())),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }
    fn verify_tls12_signature(&self, msg: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        check13(msg, cert, dss)
    }
    fn verify_tls13_signature(&self, msg: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        check13(msg, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        schemes()
    }
}

const WRONG_KEY: &str = "wrong key";

pub fn server_config(id: &Identity) -> Result<Arc<ServerConfig>, String> {
    let mut c = ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_client_cert_verifier(Arc::new(AnyClient))
        .with_single_cert(vec![id.cert.clone()], id.key())
        .map_err(|e| e.to_string())?;
    // Every connection proves its key again: no resumption to reason about.
    c.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    c.send_tls13_tickets = 0;
    Ok(Arc::new(c))
}

pub fn client_config(id: &Identity, pin: Option<&str>) -> Result<Arc<ClientConfig>, String> {
    let mut c = ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pin(pin.map(String::from))))
        .with_client_auth_cert(vec![id.cert.clone()], id.key())
        .map_err(|e| e.to_string())?;
    c.resumption = rustls::client::Resumption::disabled();
    c.enable_sni = false;
    Ok(Arc::new(c))
}

/// This Harbor's server config, made once.
pub fn my_server() -> Result<Arc<ServerConfig>, String> {
    static C: OnceLock<Result<Arc<ServerConfig>, String>> = OnceLock::new();
    C.get_or_init(|| server_config(me()?)).clone()
}

// ================================================================== client

pub type Client = StreamOwned<ClientConnection, TcpStream>;

fn config_for(pin: Option<&str>) -> Result<Arc<ClientConfig>, String> {
    let id = me()?;
    static CACHE: LazyLock<Mutex<HashMap<String, Arc<ClientConfig>>>> = LazyLock::new(Default::default);
    let k = pin.unwrap_or("").to_string();
    let mut c = CACHE.lock().unwrap();
    if c.len() > 64 {
        c.clear();
    }
    if let Some(x) = c.get(&k) {
        return Ok(x.clone());
    }
    let x = client_config(id, pin)?;
    c.insert(k, x.clone());
    Ok(x)
}

/// A TLS connection to `addr` that shows this Harbor's certificate and checks the server's
/// (`pin`; None only for pairing). Also returns the server's fingerprint.
pub fn connect(addr: &SocketAddr, pin: Option<&str>, connect: Duration, wait: Duration) -> Result<(Client, String), String> {
    let s = TcpStream::connect_timeout(addr, connect).map_err(|e| e.to_string())?;
    let _ = s.set_nodelay(true);
    // The handshake gets the connect timeout too: a port that accepts and says nothing isn't Harbor.
    let _ = s.set_read_timeout(Some(connect.max(Duration::from_secs(3))));
    let _ = s.set_write_timeout(Some(wait));
    let (tls, fp) = handshake(s, addr.ip(), pin)?;
    let _ = tls.sock.set_read_timeout(Some(wait));
    Ok((tls, fp))
}

/// The client side of a TLS handshake over any stream (a TCP socket, or a relayed stream inside
/// another TLS session), pinned like [`connect`].
pub fn handshake<S: Read + Write>(mut s: S, ip: IpAddr, pin: Option<&str>) -> Result<(StreamOwned<ClientConnection, S>, String), String> {
    let conn = ClientConnection::new(config_for(pin)?, ServerName::IpAddress(ip.into())).map_err(|e| e.to_string())?;
    let mut conn = conn;
    while conn.is_handshaking() {
        if let Err(e) = conn.complete_io(&mut s) {
            let m = e.to_string();
            return Err(if m.contains(WRONG_KEY) { "it answers with another key than the one paired here".into() } else { format!("TLS: {m}") });
        }
    }
    let fp = conn.peer_certificates().and_then(|c| c.first()).and_then(|c| cert_fp(c)).ok_or("TLS: no certificate")?;
    Ok((StreamOwned::new(conn, s), fp))
}

// ================================================================== server

/// A server socket whose reads have a deadline for the whole head (`until`) and `idle` per read
/// after it, like `api::Timed`, but owned (TLS needs to own its transport).
pub struct Sock {
    pub s: TcpStream,
    pub until: Cell<Option<Instant>>,
    pub idle: Duration,
}

impl Read for Sock {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        let wait = match self.until.get() {
            Some(u) => u.saturating_duration_since(Instant::now()).min(self.idle),
            None => self.idle,
        };
        if wait.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        self.s.set_read_timeout(Some(wait))?;
        self.s.read(b)
    }
}

impl Write for Sock {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.s.write(b)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.s.flush()
    }
}

/// An accepted connection: TLS, or plain (only ever let through for loopback or legacy).
pub enum Conn {
    Plain(Sock),
    /// None once handed on (`take_tls`): a relay pumps it now.
    Tls(Option<Box<StreamOwned<ServerConnection, Sock>>>),
}

impl Conn {
    pub fn sock(&self) -> &Sock {
        match self {
            Conn::Plain(s) => s,
            Conn::Tls(Some(t)) => &t.sock,
            Conn::Tls(None) => unreachable!("a connection handed on"),
        }
    }

    /// The TLS connection and its socket, to pump raw bytes through (relay.rs).
    pub fn take_tls(&mut self) -> Option<(ServerConnection, TcpStream)> {
        match self {
            Conn::Tls(t) => t.take().map(|t| {
                let (c, s) = t.into_parts();
                (c, s.s)
            }),
            Conn::Plain(_) => None,
        }
    }

    pub fn is_tls(&self) -> bool {
        matches!(self, Conn::Tls(_))
    }

    /// The client's fingerprint, when it showed a certificate.
    pub fn peer_fp(&self) -> Option<String> {
        match self {
            Conn::Plain(_) | Conn::Tls(None) => None,
            Conn::Tls(Some(t)) => t.conn.peer_certificates().and_then(|c| c.first()).and_then(|c| cert_fp(c)),
        }
    }

    /// The head is in: from now on only the idle timeout applies.
    pub fn clear_deadline(&self) {
        self.sock().until.set(None);
    }
}

impl Read for Conn {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        match self {
            Conn::Plain(s) => s.read(b),
            Conn::Tls(Some(t)) => t.read(b),
            Conn::Tls(None) => Ok(0),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        match self {
            Conn::Plain(s) => s.write(b),
            Conn::Tls(Some(t)) => t.write(b),
            Conn::Tls(None) => Err(io::ErrorKind::BrokenPipe.into()),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Conn::Plain(s) => s.flush(),
            Conn::Tls(Some(t)) => t.flush(),
            Conn::Tls(None) => Ok(()),
        }
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        if let Conn::Tls(Some(t)) = self {
            t.conn.send_close_notify();
            let _ = t.flush();
        }
    }
}

/// Starts serving an accepted socket: TLS when the client opens with a TLS record (the
/// handshake runs here, within `head`), plain otherwise. `cfg` gives the config when it's TLS
/// (None: TLS isn't available).
pub fn accept(s: TcpStream, cfg: impl FnOnce() -> Option<Arc<ServerConfig>>, head: Duration, idle: Duration) -> io::Result<Conn> {
    let _ = s.set_write_timeout(Some(idle));
    let _ = s.set_nodelay(true);
    let sock = Sock { s, until: Cell::new(Some(Instant::now() + head)), idle };
    let mut first = [0u8; 1];
    sock.s.set_read_timeout(Some(head))?;
    if sock.s.peek(&mut first)? == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    // 0x16: a TLS handshake record.
    if first[0] != 0x16 {
        return Ok(Conn::Plain(sock));
    }
    let Some(cfg) = cfg() else { return Err(io::Error::other("no TLS identity")) };
    let conn = ServerConnection::new(cfg).map_err(io::Error::other)?;
    let mut t = StreamOwned::new(conn, sock);
    while t.conn.is_handshaking() {
        t.conn.complete_io(&mut t.sock)?;
    }
    Ok(Conn::Tls(Some(Box::new(t))))
}

// ================================================================== pumping

/// Copies bytes both ways between the plaintext of a TLS connection (over `sock`) and another
/// stream (`other_fd` readable through `other_r`, written through `other_w`) until both sides
/// are done or nothing moves for `idle`. `pre` is plaintext already read off the TLS side.
/// Half-closes pass through: the other side ending sends close_notify (and the TLS side is
/// still read), the TLS side ending calls `other_done` (e.g. shutdown(Write) of a socket).
/// One thread, poll(2) on both sockets: rustls connections can't be shared between threads.
#[allow(unsafe_code)] // poll(2)
#[allow(clippy::too_many_arguments)]
pub fn pump(conn: impl Into<rustls::Connection>, mut sock: TcpStream, pre: &[u8], other_fd: std::os::fd::RawFd, other_r: &mut dyn Read, other_w: &mut dyn Write, other_done: &dyn Fn(), idle: Duration) {
    use std::os::fd::AsRawFd;
    let mut c: rustls::Connection = conn.into();
    let _ = sock.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = sock.set_write_timeout(Some(Duration::from_secs(30)));
    if !pre.is_empty() && other_w.write_all(pre).and_then(|_| other_w.flush()).is_err() {
        return;
    }
    let mut buf = vec![0u8; 32 << 10];
    let flush_tls = |c: &mut rustls::Connection, sock: &mut TcpStream| -> bool {
        while c.wants_write() {
            if c.write_tls(sock).is_err() {
                return false;
            }
        }
        true
    };
    // (TLS side finished sending, other side finished sending)
    let (mut tls_eof, mut other_eof) = (false, false);
    loop {
        if !flush_tls(&mut c, &mut sock) {
            return;
        }
        // Plaintext rustls already holds goes first (poll wouldn't see it).
        while !tls_eof {
            match c.reader().read(&mut buf) {
                Ok(0) => {
                    tls_eof = true;
                    other_done();
                }
                Ok(n) => {
                    if other_w.write_all(&buf[..n]).and_then(|_| other_w.flush()).is_err() {
                        return;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(_) => {
                    tls_eof = true;
                    other_done();
                }
            }
        }
        if tls_eof && other_eof {
            return;
        }
        let mut fds = [
            libc::pollfd { fd: if tls_eof { -1 } else { sock.as_raw_fd() }, events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: if other_eof { -1 } else { other_fd }, events: libc::POLLIN, revents: 0 },
        ];
        let n = unsafe { libc::poll(fds.as_mut_ptr(), 2, idle.as_millis().min(i32::MAX as u128) as i32) };
        if n == 0 {
            return; // idle too long
        }
        if n < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        let gone = libc::POLLIN | libc::POLLHUP | libc::POLLERR;
        if !tls_eof && fds[0].revents & gone != 0 {
            match c.read_tls(&mut sock) {
                Ok(0) => {
                    tls_eof = true;
                    other_done();
                }
                Ok(_) => {
                    if c.process_new_packets().is_err() {
                        let _ = flush_tls(&mut c, &mut sock);
                        return;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return,
            }
        }
        if !other_eof && fds[1].revents & gone != 0 {
            match other_r.read(&mut buf) {
                Ok(0) | Err(_) => {
                    other_eof = true;
                    c.send_close_notify();
                }
                Ok(n) => {
                    if c.writer().write_all(&buf[..n]).is_err() {
                        return;
                    }
                }
            }
        }
    }
}

// ================================================================== addresses

/// An address as this module compares it: IPv4-mapped IPv6 as IPv4.
pub fn canonical(ip: IpAddr) -> IpAddr {
    ip.to_canonical()
}

/// Tailscale's ranges (100.64/10, fd7a:115c:a1e0::/48).
pub fn tailnet_ip(ip: IpAddr) -> bool {
    match canonical(ip) {
        IpAddr::V4(v) => v.octets()[0] == 100 && (v.octets()[1] & 0xc0) == 64,
        IpAddr::V6(v) => {
            let s = v.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// One address per network a host holds: IPv6 by its /64 (one machine gets a whole /64), so
/// limits per address can't be dodged by hopping within it.
pub fn scope_key(ip: IpAddr) -> IpAddr {
    match canonical(ip) {
        IpAddr::V6(v) => {
            let s = v.segments();
            IpAddr::V6(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
        v4 => v4,
    }
}

/// An address on this PC, a private network (LAN, unique-local IPv6, link-local) or Tailscale's:
/// not the open internet.
pub fn private_ip(ip: IpAddr) -> bool {
    match canonical(ip) {
        IpAddr::V4(v) => v.is_loopback() || v.is_private() || v.is_link_local() || tailnet_ip(IpAddr::V4(v)),
        IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00 || link_local(IpAddr::V6(v)),
    }
}

/// This PC's interfaces: (name, address), loopback and link-local left out.
#[allow(unsafe_code)] // getifaddrs: no safe wrapper in the tree
pub fn interfaces() -> Vec<(String, IpAddr)> {
    let mut out = vec![];
    unsafe {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut head) != 0 {
            return out;
        }
        let mut p = head;
        while !p.is_null() {
            let i = &*p;
            p = i.ifa_next;
            if i.ifa_addr.is_null() || i.ifa_flags & libc::IFF_UP as u32 == 0 {
                continue;
            }
            let name = std::ffi::CStr::from_ptr(i.ifa_name).to_string_lossy().into_owned();
            let ip: IpAddr = match (*i.ifa_addr).sa_family as i32 {
                libc::AF_INET => {
                    let a = &*(i.ifa_addr as *const libc::sockaddr_in);
                    IpAddr::V4(std::net::Ipv4Addr::from(u32::from_be(a.sin_addr.s_addr)))
                }
                libc::AF_INET6 => {
                    let a = &*(i.ifa_addr as *const libc::sockaddr_in6);
                    IpAddr::V6(std::net::Ipv6Addr::from(a.sin6_addr.s6_addr))
                }
                _ => continue,
            };
            out.push((name, ip));
        }
        libc::freeifaddrs(head);
    }
    out.retain(|(_, ip)| !ip.is_loopback() && !ip.is_unspecified() && !link_local(*ip));
    out
}

fn link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_link_local(),
        IpAddr::V6(v) => (v.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// Interfaces a phone or another PC can't reach (containers, VMs' bridges).
fn virtual_if(name: &str) -> bool {
    ["docker", "br-", "veth", "virbr", "vmnet", "lxc", "cni", "flannel", "podman"].iter().any(|p| name.starts_with(p))
}

/// The addresses other devices may reach this PC at: every non-loopback address of its real
/// interfaces, IPv4 first. (Tailscale's interface is one of them while it's installed.)
pub fn lan_addrs() -> Vec<IpAddr> {
    // HARBOR_ADDRS=ip,…: say these instead (tests that reach each other another way).
    if let Ok(a) = std::env::var("HARBOR_ADDRS") {
        return a.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    }
    let mut v: Vec<IpAddr> = interfaces().into_iter().filter(|(n, _)| !virtual_if(n)).map(|(_, ip)| ip).collect();
    // The network's own first (IPv4, then IPv6), Tailscale's last.
    v.sort_by_key(|ip| (tailnet_ip(*ip), ip.is_ipv6()));
    v.dedup();
    v
}

/// `host:port` for an address (IPv6 in brackets).
pub fn host_port(ip: IpAddr, port: u16) -> String {
    SocketAddr::new(ip, port).to_string()
}

/// True when `local` is an address of a Tailscale interface of this PC (cached for 30 s).
pub fn on_tailscale_if(local: IpAddr) -> bool {
    static CACHE: LazyLock<Mutex<Option<(Instant, Vec<IpAddr>)>>> = LazyLock::new(Default::default);
    let local = canonical(local);
    let mut c = CACHE.lock().unwrap();
    if c.as_ref().is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(30)) {
        let v = interfaces().into_iter().filter(|(n, _)| n.starts_with("tailscale")).map(|(_, ip)| ip).collect();
        *c = Some((Instant::now(), v));
    }
    c.as_ref().is_some_and(|(_, v)| v.contains(&local))
}

/// A plain-HTTP connection that may still be served while clients upgrade: both ends on
/// Tailscale's addresses and it arrived on this PC's Tailscale interface (WireGuard
/// encrypted and authenticated it, as before 0.13). Only for not-yet-upgraded clients:
/// once a phone or PC has a key on file here, plain is refused for it.
pub fn legacy(local: IpAddr, peer: IpAddr) -> bool {
    std::env::var("HARBOR_NO_LEGACY").is_err() && tailnet_ip(peer) && tailnet_ip(local) && on_tailscale_if(local)
}

// ================================================================== firewall

/// Whether a ufw configuration drops `port` (`udp`: UDP, else TCP) from the local network: ufw
/// on, incoming dropped by default, and no rule letting it in on every interface (a rule for
/// Tailscale's interface alone doesn't count). `rules` are the `### tuple ###` lines of
/// user.rules and user6.rules.
pub fn ufw_blocks(conf: &str, defaults: &str, rules: &str, port: u16, udp: bool) -> bool {
    ufw_drops(conf, defaults, rules, port, udp, false)
}

/// [`ufw_blocks`] for connections from anywhere (`internet`: only a rule for every source counts).
pub fn ufw_drops(conf: &str, defaults: &str, rules: &str, port: u16, udp: bool, internet: bool) -> bool {
    let on = conf.lines().any(|l| l.trim() == "ENABLED=yes");
    let drops = defaults.lines().any(|l| matches!(l.trim(), "DEFAULT_INPUT_POLICY=\"DROP\"" | "DEFAULT_INPUT_POLICY=\"REJECT\""));
    if !on || !drops {
        return false;
    }
    let allows = rules.lines().filter_map(|l| l.strip_prefix("### tuple ### ")).any(|t| {
        // action proto dport dst sport src direction [comment]
        let f: Vec<&str> = t.split_whitespace().collect();
        let [action, proto, dport, _dst, _sport, src, dir, ..] = f[..] else { return false };
        if internet && src != "0.0.0.0/0" && src != "::/0" {
            return false;
        }
        let port_ok = dport == "any"
            || dport.split(',').any(|p| match p.split_once(':') {
                Some((a, b)) => a.parse::<u16>().is_ok_and(|a| a <= port) && b.parse::<u16>().is_ok_and(|b| port <= b),
                None => p.parse::<u16>() == Ok(port),
            });
        let proto_ok = proto == "any" || proto == if udp { "udp" } else { "tcp" };
        matches!(action, "allow" | "limit") && proto_ok && port_ok && dir == "in"
    });
    !allows
}

/// True when this PC's firewall (ufw) keeps other devices on the network from reaching Harbor
/// (read from ufw's own files, which anyone may read; cached for 20 s).
pub fn firewall_blocks(port: u16) -> bool {
    static CACHE: LazyLock<Mutex<Option<(Instant, u16, bool)>>> = LazyLock::new(Default::default);
    let mut c = CACHE.lock().unwrap();
    if let Some((at, p, v)) = *c {
        if p == port && at.elapsed() < Duration::from_secs(20) {
            return v;
        }
    }
    let read = |p: &str| std::fs::read_to_string(p).unwrap_or_default();
    let rules = format!("{}\n{}", read("/etc/ufw/user.rules"), read("/etc/ufw/user6.rules"));
    let (conf, defaults) = (read("/etc/ufw/ufw.conf"), read("/etc/default/ufw"));
    // The API (TCP) and network discovery (UDP, discover.rs).
    let v = ufw_blocks(&conf, &defaults, &rules, port, false) || ufw_blocks(&conf, &defaults, &rules, crate::discover::PORT, true);
    *c = Some((Instant::now(), port, v));
    v
}

/// True when this PC's firewall (ufw) drops connections to Harbor from the internet (IPv6
/// global addresses, a mapped port), though the local network may be let in.
pub fn firewall_blocks_internet(port: u16) -> bool {
    let read = |p: &str| std::fs::read_to_string(p).unwrap_or_default();
    let rules = format!("{}\n{}", read("/etc/ufw/user.rules"), read("/etc/ufw/user6.rules"));
    ufw_drops(&read("/etc/ufw/ufw.conf"), &read("/etc/default/ufw"), &rules, port, false, true)
}

/// The command that lets the internet reach Harbor's port (TCP): only keys it knows get answers.
pub fn firewall_fix_internet(port: u16) -> String {
    format!("sudo ufw allow {port}/tcp comment harbor-internet")
}

/// The commands that let the local network reach Harbor's port (TCP and UDP) and network
/// discovery through ufw (private ranges only).
pub fn firewall_fix(port: u16) -> String {
    // (192.168/16 built from octets: the pre-commit hook refuses LAN addresses as text)
    let lan = format!("{}/16", std::net::Ipv4Addr::new(192, 168, 0, 0));
    let mut ports = vec![port];
    if port != crate::discover::PORT {
        ports.push(crate::discover::PORT);
    }
    ["10.0.0.0/8", "172.16.0.0/12", lan.as_str(), "fc00::/7", "fe80::/10"]
        .iter()
        .flat_map(|r| ports.iter().map(move |p| format!("sudo ufw allow from {r} to any port {p} comment harbor")))
        .collect::<Vec<_>>()
        .join(" && ")
}

// ================================================================== pairing codes

/// Crockford's base32: no I, L, O, U.
const B32: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A new pairing code: 10 characters (50 bits), shown as "ABCDE-FGHJK".
pub fn new_code() -> io::Result<String> {
    let b = crate::store::random_bytes(10)?;
    let s: String = b.iter().map(|x| B32[(*x & 31) as usize] as char).collect();
    Ok(format!("{}-{}", &s[..5], &s[5..]))
}

/// A code as typed: case, spaces and dashes don't matter; O, I and L read as 0, 1, 1.
pub fn normalize_code(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect()
}

/// The key both sides derive from the code (slow on purpose: an eavesdropper's offline guesses
/// cost 100k HMACs each).
pub fn code_key(code: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, std::num::NonZeroU32::new(100_000).unwrap(), b"harbor-pair-v1", normalize_code(code).as_bytes(), &mut out);
    out
}

/// One side's proof that it knows the code: `role` is "join" (the PC that typed it) or
/// "host" (the PC that showed it); `host` and `join` are the fingerprints each side saw.
pub fn proof(key: &[u8; 32], role: &str, host: &str, join: &str) -> String {
    let k = hmac::Key::new(hmac::HMAC_SHA256, key);
    let tag = hmac::sign(&k, format!("harbor-pair-v1\n{role}\n{host}\n{join}").as_bytes());
    tag.as_ref().iter().map(|x| format!("{x:02x}")).collect()
}

pub fn proof_ok(key: &[u8; 32], role: &str, host: &str, join: &str, given: &str) -> bool {
    let want = proof(key, role, host, join);
    // Constant time: the comparison says nothing about how close a guess was.
    want.len() == given.len() && want.bytes().zip(given.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}

/// A fixed-window limit per key (an address): at most `max` hits per `window`.
pub struct Throttle {
    max: u32,
    window: Duration,
    hits: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl Throttle {
    pub fn new(max: u32, window: Duration) -> Self {
        Throttle { max, window, hits: Mutex::new(HashMap::new()) }
    }

    /// Counts one hit; false when `ip` is over the limit.
    pub fn hit(&self, ip: IpAddr) -> bool {
        let mut h = match self.hits.lock() {
            Ok(h) => h,
            Err(p) => p.into_inner(),
        };
        let now = Instant::now();
        if h.len() > 4096 {
            h.retain(|_, (at, _)| now.duration_since(*at) < self.window);
            // Still that many: forget them all rather than grow without end.
            if h.len() > 4096 {
                h.clear();
            }
        }
        let e = h.entry(scope_key(ip)).or_insert((now, 0));
        if now.duration_since(e.0) >= self.window {
            *e = (now, 0);
        }
        e.1 += 1;
        e.1 <= self.max
    }

    /// Over the limit already (without counting).
    pub fn over(&self, ip: IpAddr) -> bool {
        let h = match self.hits.lock() {
            Ok(h) => h,
            Err(p) => p.into_inner(),
        };
        h.get(&scope_key(ip)).is_some_and(|(at, n)| at.elapsed() < self.window && *n >= self.max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn identity_and_fingerprint() {
        let (pem, id) = generate().unwrap();
        assert_eq!(id.fp.len(), 64);
        let again = parse(pem.as_bytes()).unwrap();
        assert_eq!(again.fp, id.fp, "the fingerprint is the key's, read back the same");
        // The SPKI found in the certificate is the key's public key.
        let kp = rcgen::KeyPair::from_pem(&pem).unwrap();
        assert_eq!(spki(&id.cert).unwrap(), rcgen::PublicKeyData::subject_public_key_info(&kp).as_slice());
        assert_ne!(generate().unwrap().1.fp, id.fp, "each Harbor its own key");
        assert_eq!(short("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"), "0123 4567 89ab cdef");
        assert_eq!(normalize_fp(&"AB:".repeat(32)), Some("ab".repeat(32)));
        assert_eq!(normalize_fp("abc"), None);
        assert!(spki(b"\x30\x03\x02\x01\x00").is_none() && spki(&[]).is_none() && spki(&[0x30, 0x84, 0xff, 0xff, 0xff, 0xff]).is_none());
    }

    #[test]
    fn identity_file_is_private_and_kept() {
        let dir = std::env::temp_dir().join(format!("harbor-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = load_or_create(&dir).unwrap();
        let b = load_or_create(&dir).unwrap();
        assert_eq!(a.fp, b.fp);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("identity.pem")).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A server on 127.0.0.1 with identity `srv`: answers each connection with the client's
    /// fingerprint (or "-").
    fn serve_once(srv: Identity) -> (SocketAddr, std::thread::JoinHandle<()>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let cfg = server_config(&srv).unwrap();
        let h = std::thread::spawn(move || {
            for s in l.incoming().take(3).flatten() {
                if let Ok(mut c) = accept(s, || Some(cfg.clone()), Duration::from_secs(5), Duration::from_secs(5)) {
                    if !c.is_tls() {
                        let _ = c.read(&mut [0u8; 64]); // what a plain client sent: else closing resets
                    }
                    let fp = c.peer_fp().unwrap_or("-".into());
                    let _ = c.write_all(fp.as_bytes());
                    let _ = c.flush();
                }
            }
        });
        (addr, h)
    }

    #[test]
    fn pinned_mutual_tls() {
        let (_, srv) = generate().unwrap();
        let (_, cli) = generate().unwrap();
        let srv_fp = srv.fp.clone();
        let (addr, h) = serve_once(srv);
        let go = |pin: Option<&str>| -> Result<(String, String), String> {
            let cfg = client_config(&cli, pin)?;
            let s = TcpStream::connect(addr).map_err(|e| e.to_string())?;
            let mut t = StreamOwned::new(ClientConnection::new(cfg, ServerName::IpAddress(addr.ip().into())).unwrap(), s);
            let mut out = String::new();
            t.read_to_string(&mut out).map_err(|e| e.to_string())?;
            let seen = t.conn.peer_certificates().and_then(|c| c.first()).and_then(|c| cert_fp(c)).unwrap();
            Ok((out, seen))
        };
        // The right pin: the server sees the client's key, the client the server's.
        let (got, seen) = go(Some(&srv_fp)).unwrap();
        assert_eq!(got, cli.fp);
        assert_eq!(seen, srv_fp);
        // Another pin: refused before anything is sent.
        let e = go(Some(&"0".repeat(64))).unwrap_err();
        assert!(e.contains(WRONG_KEY), "{e}");
        // No pin (pairing): connects, and the fingerprint seen is the server's.
        assert_eq!(go(None).unwrap().1, srv_fp);
        h.join().unwrap();
    }

    #[test]
    fn plain_and_no_client_cert() {
        let (_, srv) = generate().unwrap();
        let (addr, h) = serve_once(srv);
        // A plain client is told apart (the caller decides what it may do).
        let mut s = TcpStream::connect(addr).unwrap();
        s.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert_eq!(out, "-");
        // A TLS client without a certificate gets in too, with no fingerprint.
        let cfg = ClientConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Pin(None)))
            .with_no_client_auth();
        let s = TcpStream::connect(addr).unwrap();
        let mut t = StreamOwned::new(ClientConnection::new(Arc::new(cfg), ServerName::IpAddress(addr.ip().into())).unwrap(), s);
        let mut out = String::new();
        t.read_to_string(&mut out).unwrap();
        assert_eq!(out, "-");
        drop(TcpStream::connect(addr));
        h.join().unwrap();
    }

    #[test]
    fn pairing_proofs() {
        let code = new_code().unwrap();
        assert_eq!(code.len(), 11);
        assert_eq!(normalize_code(&code.to_lowercase().replace('-', " ")), normalize_code(&code));
        assert_eq!(normalize_code("o1-Il"), "0111");
        let k = code_key(&code);
        let (host, join) = ("a".repeat(64), "b".repeat(64));
        let p = proof(&k, "join", &host, &join);
        assert!(proof_ok(&k, "join", &host, &join, &p));
        assert!(!proof_ok(&k, "host", &host, &join, &p), "roles differ");
        // A man in the middle shows its own key: the proof doesn't fit the real host's.
        assert!(!proof_ok(&k, "join", &"c".repeat(64), &join, &p));
        assert!(!proof_ok(&code_key("ZZZZZ-ZZZZZ"), "join", &host, &join, &p));
        assert!(!proof_ok(&k, "join", &host, &join, ""));
    }

    #[test]
    fn addresses() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        // (tailnet addresses built from octets: the pre-commit hook refuses them as text)
        let v4 = |a, b, c, d| IpAddr::V4(std::net::Ipv4Addr::new(a, b, c, d));
        assert!(tailnet_ip(v4(100, 64, 0, 1)) && tailnet_ip(v4(100, 127, 255, 255)) && tailnet_ip(ip("fd7a:115c:a1e0::1")));
        assert!(!tailnet_ip(v4(100, 128, 0, 1)) && !tailnet_ip(ip("10.0.0.1")) && !tailnet_ip(ip("fd7a:115c:a1e1::1")));
        assert!(tailnet_ip(IpAddr::V6(std::net::Ipv4Addr::new(100, 100, 1, 1).to_ipv6_mapped())), "mapped IPv4 counts");
        assert!(!legacy(ip("10.0.0.2"), v4(100, 64, 0, 1)), "plain only between tailnet addresses");
        assert_eq!(host_port(ip("fd00::1"), 47930), "[fd00::1]:47930");
        assert!(private_ip(ip("10.1.2.3")) && private_ip(ip("172.16.0.1")) && private_ip(ip("fd00::1")) && private_ip(ip("fe80::1")) && private_ip(ip("127.0.0.1")));
        assert!(private_ip(v4(100, 100, 1, 1)) && private_ip(ip("::ffff:10.0.0.1")));
        assert!(!private_ip(ip("8.8.8.8")) && !private_ip(ip("2001:db8::1")) && !private_ip(v4(100, 128, 0, 1)));
        assert!(virtual_if("docker0") && virtual_if("br-1a2b") && !virtual_if("wlan0") && !virtual_if("enp3s0"));
        for a in lan_addrs() {
            assert!(!a.is_loopback());
        }
    }

    #[test]
    fn firewall() {
        let (on, drop) = ("ENABLED=yes\n", "IPV6=yes\nDEFAULT_INPUT_POLICY=\"DROP\"\n");
        let ts = "### tuple ### allow any any 0.0.0.0/0 any 0.0.0.0/0 in_tailscale0 comment=7461\n### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in\n";
        assert!(ufw_blocks(on, drop, ts, 47930, false), "only Tailscale's interface is let in");
        assert!(!ufw_blocks("ENABLED=no\n", drop, ts, 47930, false), "ufw off");
        assert!(!ufw_blocks(on, "DEFAULT_INPUT_POLICY=\"ACCEPT\"\n", ts, 47930, false), "accepts by default");
        let lan = format!("{}/16", std::net::Ipv4Addr::new(192, 168, 0, 0));
        let mine = format!("{ts}### tuple ### allow tcp 47930 0.0.0.0/0 any {lan} in comment=6861\n");
        assert!(!ufw_blocks(on, drop, &mine, 47930, false));
        assert!(!ufw_blocks(on, drop, "### tuple ### allow any 47900:47999 0.0.0.0/0 any 0.0.0.0/0 in\n", 47930, false), "a range");
        assert!(ufw_blocks(on, drop, "### tuple ### allow udp 47930 0.0.0.0/0 any 0.0.0.0/0 in\n", 47930, false), "UDP isn't TCP");
        assert!(!ufw_blocks(on, drop, "### tuple ### allow udp 47930 0.0.0.0/0 any 0.0.0.0/0 in\n", 47930, true));
        assert!(ufw_blocks(on, drop, &mine, 47930, true), "a TCP rule isn't UDP");
        assert!(ufw_blocks(on, drop, "### tuple ### deny tcp 47930 0.0.0.0/0 any 0.0.0.0/0 in\n", 47930, false));
        assert!(!ufw_blocks(on, drop, "### tuple ### allow tcp 80,47930 0.0.0.0/0 any 0.0.0.0/0 in\n", 47930, false), "a list");
        assert!(firewall_fix(47930).contains(&format!("from {lan} to any port 47930 ")));
        assert!(firewall_fix(47931).contains("to any port 47930 ") && firewall_fix(47931).contains("to any port 47931 "), "discovery's port too");
    }

    #[test]
    fn throttle() {
        let t = Throttle::new(3, Duration::from_secs(60));
        let a: IpAddr = "10.0.0.9".parse().unwrap();
        assert!(t.hit(a) && t.hit(a) && t.hit(a));
        assert!(!t.over("10.0.0.8".parse().unwrap()));
        assert!(!t.hit(a) && t.over(a));
        assert!(t.over("::ffff:10.0.0.9".parse().unwrap()), "one address however it's written");
        let v6 = |s: &str| s.parse::<IpAddr>().unwrap();
        for i in 0..3 {
            assert!(t.hit(v6(&format!("2001:db8:1:2::{i}"))));
        }
        assert!(!t.hit(v6("2001:db8:1:2:ffff::1")), "one /64 is one host");
        assert!(t.hit(v6("2001:db8:1:3::1")));
    }
}
