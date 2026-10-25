//! Three factors between a phone and this hub, and session keys that change every 10 minutes
//! (android/PROTOCOL.md, "Three factors").
//!
//! 1. The phone's TLS key (tls.rs): pinned mutual TLS, the key bound to the pairing. Checked on
//!    every connection.
//! 2. A pairing secret: an ECDH agreement made when the phone pairs, confirmed by the person at
//!    the PC with a 6-digit code both screens show. The phone keeps it encrypted under an Android
//!    Keystore key. Proven with an HMAC over a fresh challenge when a session starts.
//! 3. User presence: a second Keystore key on the phone that only signs after the user unlocked
//!    it (biometric or screen lock) within the last few minutes. The hub pins its public key at
//!    pairing and wants its signature over the session's challenge.
//!
//! A session's root key comes from a fresh ECDH plus the pairing secret. Its key chain moves one
//! step per 10-minute epoch (HKDF-Expand), the old link erased, so a key taken from memory
//! now opens nothing that came before. Every call then carries a MAC under the current epoch's
//! key, bound to the TLS connection it travels on (the exporter) and to a counter that is never
//! taken twice. Anything else gets one generic refusal.

use crate::api::{Hub, Peer, Request, Via};
use ring::{agreement, digest, hmac, signature};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

/// One epoch: the request key changes this often.
pub const EPOCH: Duration = Duration::from_secs(600);
/// Around a change both keys work this long (calls already on the way, clocks that differ a bit).
pub const GRACE: Duration = Duration::from_secs(30);
/// The epoch in force: [`EPOCH`], or `HARBOR_TEST_EPOCH_S` seconds (20 to 3600) for test rigs
/// that want to see keys change within minutes. Sessions tell the phone (`epoch_ms`).
pub fn epoch_len() -> Duration {
    static E: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *E.get_or_init(|| std::env::var("HARBOR_TEST_EPOCH_S").ok().and_then(|s| s.parse::<u64>().ok()).map_or(EPOCH, |s| Duration::from_secs(s.clamp(20, 3600))))
}

/// The grace around a change: [`GRACE`], at most a quarter of the epoch.
pub fn grace() -> Duration {
    GRACE.min(epoch_len() / 4)
}

/// A session nobody used for this long is gone (the phone starts a new one).
pub const IDLE: Duration = Duration::from_secs(30 * 60);
/// A session ends after this anyway: the presence key is asked again.
pub const MAX_AGE: Duration = Duration::from_secs(12 * 3600);
/// A pairing code (QR) not used within this long is void.
pub const TICKET_TTL: i64 = 600;
/// A session handshake's two calls must come within this.
const HELLO_TTL: Duration = Duration::from_secs(60);
/// How long a pairing waits for the person at the PC to confirm its code.
pub const CONFIRM_TTL: Duration = Duration::from_secs(180);
/// Failed session starts for one pairing before it's locked for [`LOCK_FOR`].
const LOCK_AFTER: u32 = 5;
const LOCK_FOR: Duration = Duration::from_secs(15 * 60);
/// Bad MACs a session takes before it's dropped.
const MAC_FAILS: u32 = 10;
/// Sessions at once per pairing (each PC of the mesh holds its own).
const PER_PAIRING: usize = 4;
/// The TLS exporter label both ends use.
pub const EXPORTER_LABEL: &[u8] = b"EXPORTER-harbor-v3";
/// What every refusal says, whatever the reason (the reason goes to the log).
pub const REFUSED: &str = "Not authorized. If this keeps happening, pair this phone again in Harbor › Settings › Phones.";

/// DER of a P-256 SubjectPublicKeyInfo up to its 65-byte uncompressed point.
const P256_SPKI: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

// ================================================================== primitives

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if !s.len().is_multiple_of(2) || s.len() > 1 << 14 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn unhex32(s: &str) -> Option<[u8; 32]> {
    unhex(s)?.try_into().ok()
}

/// A transcript hash: SHA-256 of the label, a zero byte, then each part with its length
/// (4 bytes, big-endian) in front, so no two lists of parts hash alike.
pub fn th(label: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut d = digest::Context::new(&digest::SHA256);
    d.update(label.as_bytes());
    d.update(&[0]);
    for p in parts {
        d.update(&(p.len() as u32).to_be_bytes());
        d.update(p);
    }
    d.finish().as_ref().try_into().unwrap()
}

pub fn hmac32(key: &[u8], msg: &[u8]) -> [u8; 32] {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), msg).as_ref().try_into().unwrap()
}

/// HKDF-SHA256 (RFC 5869), `len` bytes.
pub fn hkdf_n(salt: &[u8], ikm: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let prk = hmac32(salt, ikm);
    expand_n(&prk, info, len)
}

fn expand_n(prk: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let (mut out, mut t) = (Vec::with_capacity(len), Vec::new());
    let mut i = 1u8;
    while out.len() < len {
        let mut m = t.clone();
        m.extend_from_slice(info);
        m.push(i);
        t = hmac32(prk, &m).to_vec();
        out.extend_from_slice(&t);
        i += 1;
    }
    out.truncate(len);
    out
}

pub fn hkdf(salt: &[u8], ikm: &[u8], info: &str) -> [u8; 32] {
    hkdf_n(salt, ikm, info.as_bytes(), 32).try_into().unwrap()
}

/// HKDF-Expand to one 32-byte block.
pub fn expand(prk: &[u8; 32], info: &str) -> [u8; 32] {
    expand_n(prk, info.as_bytes(), 32).try_into().unwrap()
}

/// Constant-time equality.
pub fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && !a.is_empty() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

#[allow(unsafe_code)] // write_volatile
fn wipe(b: &mut [u8]) {
    for x in b.iter_mut() {
        // Volatile, so the compiler keeps the erase of a key that's dropped right after.
        unsafe { std::ptr::write_volatile(x, 0) };
    }
}

/// The uncompressed point of a P-256 public key given as SubjectPublicKeyInfo DER.
pub fn p256_point(spki: &[u8]) -> Option<&[u8]> {
    (spki.len() == 91 && spki[..26] == P256_SPKI && spki[26] == 4).then(|| &spki[26..])
}

pub fn p256_spki(point: &[u8]) -> Vec<u8> {
    let mut v = P256_SPKI.to_vec();
    v.extend_from_slice(point);
    v
}

/// A fresh ECDH key agreed with `peer` (SPKI): our public key (SPKI) and the shared secret.
pub fn ecdh(peer: &[u8]) -> Option<(Vec<u8>, [u8; 32])> {
    let point = p256_point(peer)?;
    let rng = ring::rand::SystemRandom::new();
    let mine = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).ok()?;
    let public = mine.compute_public_key().ok()?;
    let z = agreement::agree_ephemeral(mine, &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, point), |z| <[u8; 32]>::try_from(z).ok()).ok()??;
    Some((p256_spki(public.as_ref()), z))
}

/// An ECDSA P-256 / SHA-256 signature (ASN.1 DER, as Android's Keystore makes them) by `spki`.
pub fn sig_ok(spki: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    p256_point(spki).is_some_and(|p| signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_ASN1, p).verify(msg, sig).is_ok())
}

fn random32() -> Option<[u8; 32]> {
    crate::store::random_bytes(32).ok()?.try_into().ok()
}

/// The pairing secret the phone hands another PC of the mesh: that PC's own, derived from the
/// one it paired with, so no PC holds another's.
#[allow(dead_code)] // the phone's side (android Sec.java); here for the tests
pub fn hub_secret(root: &[u8; 32], hub_fp: &str) -> [u8; 32] {
    hkdf(hub_fp.as_bytes(), root, "harbor-hub-v3")
}

// ================================================================== the transcripts

fn flag(b: bool) -> &'static [u8] {
    if b { b"1" } else { b"0" }
}

/// What the phone's presence key signs when it pairs.
pub fn pair_presence_msg(hub_fp: &str, phone_fp: &str, token: &str, epk: &[u8], presence: &[u8], binding: bool, x: &[u8]) -> [u8; 32] {
    th("harbor-pair-v3 presence", &[hub_fp.as_bytes(), phone_fp.as_bytes(), token.as_bytes(), epk, presence, flag(binding), x])
}

/// The pairing's transcript: both ECDH keys, both TLS keys, the presence key, the connection.
#[allow(clippy::too_many_arguments)]
pub fn pair_transcript(hub_fp: &str, phone_fp: &str, token: &str, epk_p: &[u8], epk_h: &[u8], presence: &[u8], binding: bool, x: &[u8]) -> [u8; 32] {
    th("harbor-pair-v3", &[hub_fp.as_bytes(), phone_fp.as_bytes(), token.as_bytes(), epk_p, epk_h, presence, flag(binding), x])
}

/// The pairing secret and the 6-digit code both screens show.
pub fn pair_keys(t: &[u8; 32], z: &[u8; 32]) -> ([u8; 32], String) {
    let s = hkdf(t, z, "harbor-pair-v3 secret");
    let c = hkdf(t, z, "harbor-pair-v3 sas");
    (s, format!("{:06}", u32::from_be_bytes([c[0], c[1], c[2], c[3]]) % 1_000_000))
}

pub fn labelled(key: &[u8], label: &str, t: &[u8; 32]) -> [u8; 32] {
    let mut m = label.as_bytes().to_vec();
    m.extend_from_slice(t);
    hmac32(key, &m)
}

#[allow(clippy::too_many_arguments)]
pub fn session_transcript(hub_fp: &str, phone_fp: &str, token: &str, epk_p: &[u8], epk_h: &[u8], nonce: &[u8], challenge: &[u8], x: &[u8]) -> [u8; 32] {
    th("harbor-session-v3", &[hub_fp.as_bytes(), phone_fp.as_bytes(), token.as_bytes(), epk_p, epk_h, nonce, challenge, x])
}

/// What the presence key signs to start a session.
pub fn session_presence_msg(t2: &[u8; 32]) -> Vec<u8> {
    let mut m = b"harbor-session-v3 presence".to_vec();
    m.extend_from_slice(t2);
    m
}

pub fn session_root(t2: &[u8; 32], z: &[u8; 32], secret: &[u8; 32]) -> [u8; 32] {
    let mut ikm = z.to_vec();
    ikm.extend_from_slice(secret);
    let r = hkdf(t2, &ikm, "harbor-session-v3 root");
    wipe(&mut ikm);
    r
}

/// The text a request's MAC covers.
#[allow(clippy::too_many_arguments)]
pub fn request_msg(sid: &str, epoch: u64, ctr: u64, method: &str, target: &str, len: usize, phone_fp: &str, hub_fp: &str, x: Option<&[u8; 32]>) -> String {
    let x = x.map_or("-".to_string(), |x| hex(x));
    format!("harbor-req-v3\n{sid}\n{epoch}\n{ctr}\n{method}\n{target}\n{len}\n{phone_fp}\n{hub_fp}\n{x}")
}

// ================================================================== the ratchet

/// A session's keys: one chain link per epoch, each made from the one before and that one
/// erased. Only the previous epoch's request key stays, for [`GRACE`] after the change.
pub struct Ratchet {
    epoch: u64,
    chain: [u8; 32],
    prev: Option<(u64, [u8; 32])>,
}

impl Ratchet {
    pub fn new(root: [u8; 32]) -> Self {
        Ratchet { epoch: 0, chain: root, prev: None }
    }

    #[cfg(test)]
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    fn mac_key(chain: &[u8; 32]) -> [u8; 32] {
        expand(chain, "harbor-v3 mac")
    }

    fn next(chain: &[u8; 32]) -> [u8; 32] {
        expand(chain, "harbor-v3 chain")
    }

    /// On to epoch `e` (never back).
    pub fn advance(&mut self, e: u64) {
        while self.epoch < e {
            let k = Self::mac_key(&self.chain);
            let next = Self::next(&self.chain);
            let mut old = std::mem::replace(&mut self.chain, next);
            wipe(&mut old);
            if let Some((_, mut p)) = self.prev.replace((self.epoch, k)) {
                wipe(&mut p);
            }
            self.epoch += 1;
        }
    }

    /// The request key for epoch `want`, the hub being `into` the epoch `now`: the current
    /// epoch's, the previous one's for [`GRACE`] after the change, the next one's for [`GRACE`]
    /// before it. None otherwise.
    pub fn key(&mut self, now: u64, into: Duration, want: u64) -> Option<[u8; 32]> {
        self.advance(now);
        if into >= grace() {
            if let Some((_, mut p)) = self.prev.take() {
                wipe(&mut p);
            }
        }
        if want == self.epoch {
            Some(Self::mac_key(&self.chain))
        } else if want + 1 == self.epoch {
            self.prev.filter(|(e, _)| *e == want).map(|(_, k)| k)
        } else if want == self.epoch + 1 && epoch_len().saturating_sub(into) <= grace() {
            let mut n = Self::next(&self.chain);
            let k = Self::mac_key(&n);
            wipe(&mut n);
            Some(k)
        } else {
            None
        }
    }
}

impl Drop for Ratchet {
    fn drop(&mut self) {
        wipe(&mut self.chain);
        if let Some((_, p)) = &mut self.prev {
            wipe(p);
        }
    }
}

/// Request counters seen: the highest and the 128 below it. A counter is taken once.
#[derive(Default)]
pub struct Window {
    top: u64,
    bits: u128,
}

impl Window {
    pub fn take(&mut self, n: u64) -> bool {
        if n == 0 {
            return false;
        }
        if n > self.top {
            let shift = n - self.top;
            self.bits = if shift >= 128 { 0 } else { self.bits << shift };
            self.bits |= 1;
            self.top = n;
            return true;
        }
        let d = self.top - n;
        if d >= 128 || self.bits & (1u128 << d) != 0 {
            return false;
        }
        self.bits |= 1u128 << d;
        true
    }
}

// ================================================================== hub state

struct Session {
    token: String,
    phone_fp: String,
    bound: bool,
    start: Instant,
    last: Instant,
    ratchet: Ratchet,
    window: Window,
    fails: u32,
}

impl Session {
    /// The hub's epoch now, and how far into it.
    fn clock(&self, now: Instant) -> (u64, Duration) {
        let (t, len) = (now.saturating_duration_since(self.start), epoch_len());
        let e = t.as_millis() / len.as_millis();
        (e as u64, t - len * e as u32)
    }
}

struct Hello {
    token: String,
    phone_fp: String,
    epk_p: Vec<u8>,
    epk_h: Vec<u8>,
    nonce: Vec<u8>,
    challenge: [u8; 32],
    z: [u8; 32],
    at: Instant,
}

impl Drop for Hello {
    fn drop(&mut self) {
        wipe(&mut self.z);
    }
}

/// A phone that wants to pair (or to upgrade a pairing from before 0.19): waits for the person
/// at the PC to compare the codes and confirm.
#[derive(Clone)]
pub struct Pending {
    pub token: String,
    pub phone_fp: String,
    pub name: String,
    pub code: String,
    /// It upgrades a pairing that worked with the TLS key alone.
    pub upgrade: bool,
    pub at: Instant,
    /// The PC's answer: confirmed or refused.
    pub decided: Option<bool>,
    secret: [u8; 32],
    presence: Vec<u8>,
    binding: bool,
    transcript: [u8; 32],
}

/// How a phone stands, for Settings › Phones.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Status {
    /// Open sessions.
    pub sessions: usize,
    /// The newest session's epoch and the time to its next key.
    pub epoch: u64,
    pub next_key: Duration,
    /// Locked after failed session starts, for this long still.
    pub locked: Option<Duration>,
}

#[derive(Default)]
pub struct State {
    sessions: Mutex<HashMap<String, Session>>,
    hellos: Mutex<HashMap<String, Hello>>,
    pub pending: Mutex<Vec<Pending>>,
    decided: std::sync::Condvar,
    /// Pairing token → (failed starts, since, locked until).
    locks: Mutex<HashMap<String, (u32, Instant, Option<Instant>)>>,
    /// Recent refusals (unix s, what), newest last, for Settings › Phones.
    pub log: Mutex<VecDeque<(i64, String)>>,
}

/// Why a call was refused (for the log; the phone only ever hears [`REFUSED`]).
pub type Why = &'static str;

impl State {
    pub fn note(&self, ip: std::net::IpAddr, why: &str) {
        eprintln!("harbor: phone refused ({why}) from {ip}");
        let mut l = self.log.lock().unwrap();
        l.push_back((crate::store::now(), format!("{why} ({ip})")));
        while l.len() > 20 {
            l.pop_front();
        }
    }

    /// A call's MAC: its session, the TLS key and connection it came over, the epoch's key and
    /// a counter not used before. The pairing token it belongs to.
    pub fn verify(&self, req: &Request, phone_fp: &str, hub_fp: &str, x: Option<&[u8; 32]>) -> Result<String, Why> {
        self.verify_at(req, phone_fp, hub_fp, x, Instant::now())
    }

    pub fn verify_at(&self, req: &Request, phone_fp: &str, hub_fp: &str, x: Option<&[u8; 32]>, now: Instant) -> Result<String, Why> {
        let sid = req.header("x-harbor-session").ok_or("no session")?;
        let auth = req.header("x-harbor-auth").ok_or("no MAC")?;
        let mut parts = auth.splitn(3, '.');
        let (Some(e), Some(n), Some(mac)) = (parts.next().and_then(|e| e.parse::<u64>().ok()), parts.next().and_then(|n| n.parse::<u64>().ok()), parts.next().and_then(unhex)) else {
            return Err("malformed MAC");
        };
        let mut all = self.sessions.lock().unwrap();
        let s = all.get_mut(sid).ok_or("unknown or expired session")?;
        if now.saturating_duration_since(s.last) > IDLE || now.saturating_duration_since(s.start) > MAX_AGE {
            all.remove(sid);
            return Err("session expired");
        }
        if s.phone_fp != phone_fp {
            return Err("session used with another TLS key");
        }
        if s.bound && x.is_none() {
            return Err("session needs a TLS connection");
        }
        let (now_e, into) = s.clock(now);
        let Some(mut key) = s.ratchet.key(now_e, into, e) else {
            return Err("MAC for another epoch");
        };
        let msg = request_msg(sid, e, n, &req.method, &req.target, req.len, phone_fp, hub_fp, if s.bound { x } else { None });
        let mut want = hmac32(&key, msg.as_bytes());
        wipe(&mut key);
        let good = same(&want, &mac);
        wipe(&mut want);
        if !good {
            s.fails += 1;
            if s.fails >= MAC_FAILS {
                all.remove(sid);
            }
            return Err("bad MAC");
        }
        if !s.window.take(n) {
            return Err("replayed request");
        }
        s.last = now;
        Ok(s.token.clone())
    }

    /// Ends every session of a token (revoked, paired again).
    pub fn drop_token(&self, token: &str) {
        self.sessions.lock().unwrap().retain(|_, s| s.token != token);
        self.hellos.lock().unwrap().retain(|_, h| h.token != token);
        self.pending.lock().unwrap().retain(|p| p.token != token);
        self.decided.notify_all();
    }

    pub fn status(&self, token: &str) -> Status {
        let now = Instant::now();
        let mut st = Status::default();
        let all = self.sessions.lock().unwrap();
        let mine: Vec<&Session> = all.values().filter(|s| s.token == token && now.saturating_duration_since(s.last) <= IDLE).collect();
        st.sessions = mine.len();
        if let Some(s) = mine.iter().max_by_key(|s| s.start) {
            let (e, into) = s.clock(now);
            st.epoch = e;
            st.next_key = epoch_len().saturating_sub(into);
        }
        drop(all);
        if let Some((_, _, Some(until))) = self.locks.lock().unwrap().get(token) {
            if *until > now {
                st.locked = Some(*until - now);
            }
        }
        st
    }

    fn locked(&self, token: &str, now: Instant) -> bool {
        matches!(self.locks.lock().unwrap().get(token), Some((_, _, Some(until))) if *until > now)
    }

    /// A failed session start: past [`LOCK_AFTER`] within [`LOCK_FOR`], the pairing is locked.
    fn failed(&self, token: &str, now: Instant) {
        let mut l = self.locks.lock().unwrap();
        let e = l.entry(token.to_string()).or_insert((0, now, None));
        if now.saturating_duration_since(e.1) > LOCK_FOR {
            *e = (0, now, None);
        }
        e.0 += 1;
        if e.0 >= LOCK_AFTER {
            e.2 = Some(now + LOCK_FOR);
        }
    }

    pub fn unlock(&self, token: &str) {
        self.locks.lock().unwrap().remove(token);
    }

    /// The PC's answer to a pairing that waits.
    pub fn decide(&self, token: &str, yes: bool) {
        for p in self.pending.lock().unwrap().iter_mut().filter(|p| p.token == token) {
            p.decided = Some(yes);
        }
        self.decided.notify_all();
    }

    /// Pairings waiting for the PC, oldest first (expired ones dropped).
    pub fn waiting(&self) -> Vec<Pending> {
        let mut p = self.pending.lock().unwrap();
        p.retain(|p| p.at.elapsed() < CONFIRM_TTL);
        p.iter().filter(|p| p.decided.is_none()).cloned().collect()
    }

    fn prune(&self, now: Instant) {
        self.hellos.lock().unwrap().retain(|_, h| now.saturating_duration_since(h.at) < HELLO_TTL);
        self.sessions.lock().unwrap().retain(|_, s| now.saturating_duration_since(s.last) <= IDLE && now.saturating_duration_since(s.start) <= MAX_AGE);
    }
}

// ================================================================== the calls

/// What a bearer token alone may do.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Level {
    /// Plain HTTP from 127.0.0.1: this PC itself (test rigs, `adb reverse`), as before.
    Loopback,
    /// A pairing code not used yet: pairing only.
    Ticket,
    /// A pairing from before three factors: the app's update and the upgrade (pairing again
    /// with the codes confirmed here) only.
    Legacy,
    /// A three-factor pairing: starting a session only.
    Session,
}

fn reply(status: u16, body: Value) -> crate::api::Reply {
    crate::api::Reply { status, body }
}

fn refuse() -> crate::api::Reply {
    reply(401, json!({ "error": REFUSED, "rekey": true }))
}

fn field(body: &Value, k: &str) -> Option<Vec<u8>> {
    body[k].as_str().and_then(unhex)
}

/// `/v1/pair/…` and `/v1/session/…` (android/PROTOCOL.md). `token` passed [`Hub::auth`] at
/// `level`; the phone's TLS key is `peer`'s. The reason of a refusal goes to the log.
pub fn serve(hub: &Hub, peer: &Peer, x: Option<&[u8; 32]>, req: &Request, segs: &[&str], token: &str, level: Level, body: &Value, wake: &dyn Fn()) -> crate::api::Reply {
    let now = Instant::now();
    let st = &hub.auth3;
    st.prune(now);
    let Via::Tls(Some(phone_fp)) = &peer.via else {
        st.note(peer.ip, "three factors need TLS with the phone's key");
        return refuse();
    };
    let hub_fp = crate::tls::my_fp();
    let r = match (req.method.as_str(), segs, level) {
        ("POST", ["v1", "pair", "start"], Level::Ticket | Level::Legacy) => pair_start(hub, phone_fp, &hub_fp, x, token, level, body, wake),
        ("POST", ["v1", "pair", "finish"], Level::Ticket | Level::Legacy) => pair_finish(hub, phone_fp, token, body),
        ("POST", ["v1", "session", "hello"], Level::Session) => session_hello(hub, phone_fp, token, body, now),
        ("POST", ["v1", "session", "open"], Level::Session) => session_open(hub, phone_fp, &hub_fp, x, token, body, now),
        _ => Err("not allowed at this pairing's level"),
    };
    r.unwrap_or_else(|why| {
        st.note(peer.ip, why);
        refuse()
    })
}

#[allow(clippy::too_many_arguments)]
fn pair_start(hub: &Hub, phone_fp: &str, hub_fp: &str, x: Option<&[u8; 32]>, token: &str, level: Level, body: &Value, wake: &dyn Fn()) -> Result<crate::api::Reply, Why> {
    let (Some(epk), Some(presence), Some(psig)) = (field(body, "epk"), field(body, "presence"), field(body, "psig")) else { return Err("bad pairing request") };
    let binding = body["binding"].as_bool().unwrap_or(false);
    if binding && x.is_none() {
        return Err("binding asked without TLS");
    }
    let xb: &[u8] = if binding { x.map_or(&[], |x| &x[..]) } else { &[] };
    if p256_point(&presence).is_none() {
        return Err("bad presence key");
    }
    if !sig_ok(&presence, &pair_presence_msg(hub_fp, phone_fp, token, &epk, &presence, binding, xb), &psig) {
        return Err("bad presence signature at pairing");
    }
    // A pairing from before three factors: only the phone whose key it already has may upgrade it.
    let bound = hub.tokens.lock().unwrap().iter().find(|t| t.token == token).map(|t| t.fp.clone()).unwrap_or_default();
    if level == Level::Legacy && bound != phone_fp {
        return Err("upgrade from another TLS key");
    }
    let (epk_h, mut z) = ecdh(&epk).ok_or("bad ECDH key")?;
    let t = pair_transcript(hub_fp, phone_fp, token, &epk, &epk_h, &presence, binding, xb);
    let (secret, code) = pair_keys(&t, &z);
    wipe(&mut z);
    let name: String = body["name"].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(60).collect();
    {
        let mut p = hub.auth3.pending.lock().unwrap();
        // Two phones with one code: someone else has it. Neither gets in; the PC shows why.
        if p.iter().any(|q| q.token == token && q.phone_fp != phone_fp) {
            p.retain(|q| q.token != token);
            drop(p);
            if level == Level::Ticket {
                hub.tokens.lock().unwrap().retain(|t| t.token != token);
                hub.tokens_dirty.store(true, Ordering::SeqCst);
            }
            hub.auth3.note(std::net::IpAddr::from([0, 0, 0, 0]), "two phones used one pairing code: it's void");
            wake();
            return Err("pairing code used by two phones");
        }
        p.retain(|q| q.token != token);
        let who = if name.is_empty() { "A phone".to_string() } else { name.clone() };
        p.push(Pending { token: token.into(), phone_fp: phone_fp.into(), name, code, upgrade: level == Level::Legacy, at: Instant::now(), decided: None, secret, presence, binding, transcript: t });
        if !cfg!(test) {
            crate::limits::notify("Confirm a phone", &format!("{who} wants to pair with Harbor: compare its code in Settings › Phones."));
        }
    }
    wake();
    Ok(reply(200, json!({ "epk": hex(&epk_h), "wait_ms": CONFIRM_TTL.as_millis() as u64 })))
}

fn pair_finish(hub: &Hub, phone_fp: &str, token: &str, body: &Value) -> Result<crate::api::Reply, Why> {
    let proof = field(body, "proof").ok_or("bad pairing proof")?;
    let deadline = Instant::now() + crate::api::POLL;
    let st = &hub.auth3;
    let mut p = st.pending.lock().unwrap();
    loop {
        let Some(i) = p.iter().position(|q| q.token == token && q.phone_fp == phone_fp) else { return Err("no pairing waits for this phone") };
        if p[i].at.elapsed() > CONFIRM_TTL {
            p.remove(i);
            return Err("pairing not confirmed in time");
        }
        if !same(&labelled(&p[i].secret, "harbor-pair-v3 phone", &p[i].transcript), &proof) {
            p.remove(i);
            return Err("bad pairing proof");
        }
        match p[i].decided {
            Some(false) => {
                p.remove(i);
                return Ok(reply(403, json!({ "error": "The PC refused this pairing." })));
            }
            Some(true) => {
                let q = p.remove(i);
                drop(p);
                {
                    let mut tokens = hub.tokens.lock().unwrap();
                    let Some(t) = tokens.iter_mut().find(|t| t.token == token) else { return Err("pairing removed meanwhile") };
                    t.fp = q.phone_fp.clone();
                    t.secret = hex(&q.secret);
                    t.presence = hex(&q.presence);
                    t.binding = q.binding;
                    t.ticket = false;
                    if !q.name.is_empty() {
                        t.name = q.name.clone();
                    }
                }
                hub.tokens_dirty.store(true, Ordering::SeqCst);
                st.sessions.lock().unwrap().retain(|_, s| s.token != token);
                st.unlock(token);
                return Ok(reply(200, json!({ "status": "paired", "proof": hex(&labelled(&q.secret, "harbor-pair-v3 hub", &q.transcript)) })));
            }
            None => {}
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Ok(reply(200, json!({ "status": "waiting" })));
        }
        p = st.decided.wait_timeout(p, left).unwrap().0;
    }
}

fn session_hello(hub: &Hub, phone_fp: &str, token: &str, body: &Value, now: Instant) -> Result<crate::api::Reply, Why> {
    let st = &hub.auth3;
    if st.locked(token, now) {
        return Err("pairing locked after failed session starts");
    }
    let (Some(epk_p), Some(nonce)) = (field(body, "epk"), field(body, "nonce")) else { return Err("bad session hello") };
    if nonce.len() != 32 {
        return Err("bad session nonce");
    }
    let (epk_h, z) = ecdh(&epk_p).ok_or("bad ECDH key")?;
    let challenge = random32().ok_or("no randomness")?;
    let hid = crate::store::random_hex(16).map_err(|_| "no randomness")?;
    let mut h = st.hellos.lock().unwrap();
    // A few at once per pairing at most (each PC's sessions start on their own).
    if h.values().filter(|x| x.token == token).count() >= PER_PAIRING {
        let oldest = h.iter().filter(|(_, x)| x.token == token).min_by_key(|(_, x)| x.at).map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            h.remove(&k);
        }
    }
    h.insert(hid.clone(), Hello { token: token.into(), phone_fp: phone_fp.into(), epk_p, epk_h: epk_h.clone(), nonce, challenge, z, at: now });
    Ok(reply(200, json!({ "hid": hid, "epk": hex(&epk_h), "challenge": hex(&challenge) })))
}

fn session_open(hub: &Hub, phone_fp: &str, hub_fp: &str, x: Option<&[u8; 32]>, token: &str, body: &Value, now: Instant) -> Result<crate::api::Reply, Why> {
    let st = &hub.auth3;
    if st.locked(token, now) {
        return Err("pairing locked after failed session starts");
    }
    let hid = body["hid"].as_str().unwrap_or("");
    let Some(h) = st.hellos.lock().unwrap().remove(hid) else { return Err("unknown session hello") };
    if h.token != token || h.phone_fp != phone_fp || now.saturating_duration_since(h.at) > HELLO_TTL {
        return Err("session hello from another pairing, key or time");
    }
    let (secret, presence, binding) = hub.tokens.lock().unwrap().iter().find(|t| t.token == token).map(|t| (unhex32(&t.secret), unhex(&t.presence), t.binding)).ok_or("pairing removed")?;
    let (Some(mut secret), Some(presence)) = (secret, presence) else { return Err("pairing without three factors") };
    if binding && x.is_none() {
        wipe(&mut secret);
        return Err("session needs a TLS connection");
    }
    let xb: &[u8] = if binding { x.map_or(&[], |x| &x[..]) } else { &[] };
    let t2 = session_transcript(hub_fp, phone_fp, token, &h.epk_p, &h.epk_h, &h.nonce, &h.challenge, xb);
    // Factor 2: the pairing secret.
    let proof_ok = field(body, "proof").is_some_and(|p| same(&labelled(&secret, "harbor-session-v3 proof", &t2), &p));
    // Factor 3: the user unlocked the phone just now.
    let sig_good = field(body, "sig").is_some_and(|s| sig_ok(&presence, &session_presence_msg(&t2), &s));
    if !proof_ok || !sig_good {
        wipe(&mut secret);
        st.failed(token, now);
        return Err(if !proof_ok { "bad pairing-secret proof" } else { "bad presence signature" });
    }
    let root = session_root(&t2, &h.z, &secret);
    wipe(&mut secret);
    let hub_proof = labelled(&root, "harbor-session-v3 hub", &t2);
    let sid = crate::store::random_hex(16).map_err(|_| "no randomness")?;
    let mut all = st.sessions.lock().unwrap();
    let mine: Vec<(String, Instant)> = all.iter().filter(|(_, s)| s.token == token).map(|(k, s)| (k.clone(), s.last)).collect();
    if mine.len() >= PER_PAIRING {
        if let Some((k, _)) = mine.iter().min_by_key(|(_, l)| *l) {
            all.remove(k);
        }
    }
    all.insert(sid.clone(), Session { token: token.into(), phone_fp: phone_fp.into(), bound: binding, start: now, last: now, ratchet: Ratchet::new(root), window: Window::default(), fails: 0 });
    drop(all);
    st.unlock(token);
    Ok(reply(200, json!({ "sid": sid, "epoch_ms": epoch_len().as_millis() as u64, "grace_ms": grace().as_millis() as u64, "idle_ms": IDLE.as_millis() as u64, "max_ms": MAX_AGE.as_millis() as u64, "proof": hex(&hub_proof) })))
}

// ================================================================== tests

#[cfg(test)]
pub mod tests {
    use super::*;
    use ring::signature::KeyPair;

    /// A phone, in Rust: its presence key and what it does in each step.
    pub struct Phone {
        pub fp: String,
        presence: signature::EcdsaKeyPair,
        pub secret: [u8; 32],
    }

    impl Phone {
        pub fn new(fp: &str) -> Phone {
            let rng = ring::rand::SystemRandom::new();
            let pk = signature::EcdsaKeyPair::generate_pkcs8(&signature::ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
            let presence = signature::EcdsaKeyPair::from_pkcs8(&signature::ECDSA_P256_SHA256_ASN1_SIGNING, pk.as_ref(), &rng).unwrap();
            Phone { fp: fp.into(), presence, secret: [0; 32] }
        }
        pub fn presence_spki(&self) -> Vec<u8> {
            p256_spki(self.presence.public_key().as_ref())
        }
        pub fn sign(&self, m: &[u8]) -> Vec<u8> {
            self.presence.sign(&ring::rand::SystemRandom::new(), m).unwrap().as_ref().to_vec()
        }
    }

    /// An ephemeral key whose agreement is done by hand (ring's are single use).
    pub fn eph() -> (agreement::EphemeralPrivateKey, Vec<u8>) {
        let k = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &ring::rand::SystemRandom::new()).unwrap();
        let p = p256_spki(k.compute_public_key().unwrap().as_ref());
        (k, p)
    }

    pub fn agree(k: agreement::EphemeralPrivateKey, peer: &[u8]) -> [u8; 32] {
        agreement::agree_ephemeral(k, &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, p256_point(peer).unwrap()), |z| <[u8; 32]>::try_from(z).unwrap()).unwrap()
    }

    #[test]
    fn hkdf_matches_rfc5869() {
        // RFC 5869 A.1
        let ikm = [0x0bu8; 22];
        let salt = unhex("000102030405060708090a0b0c").unwrap();
        let info = unhex("f0f1f2f3f4f5f6f7f8f9").unwrap();
        let okm = hkdf_n(&salt, &ikm, &info, 42);
        assert_eq!(hex(&okm), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
    }

    #[test]
    fn transcript_hash_has_lengths() {
        assert_ne!(th("x", &[b"ab", b"c"]), th("x", &[b"a", b"bc"]));
        assert_ne!(th("x", &[b"a"]), th("y", &[b"a"]));
    }

    /// Fixed values the Java side (android/test/SecTest.java) must reproduce exactly.
    #[test]
    fn vectors_for_the_phone() {
        let t = th("harbor-test", &[b"one", b"", b"three"]);
        let (s, code) = pair_keys(&[1; 32], &[2; 32]);
        let mut r = Ratchet::new(hkdf(&[3; 32], &[4; 32], "harbor-session-v3 root"));
        let k0 = r.key(0, Duration::ZERO, 0).unwrap();
        r.advance(3);
        let k3 = r.key(3, Duration::from_secs(100), 3).unwrap();
        let msg = request_msg("sid", 3, 7, "GET", "/v1/state?x=1", 0, "aa", "bb", Some(&[5; 32]));
        let mac = hmac32(&k3, msg.as_bytes());
        // Printed so a change here is copied into SecTest.java on purpose.
        println!("VEC th={} s={} code={code} k0={} k3={} mac={} hubsecret={}", hex(&t), hex(&s), hex(&k0), hex(&k3), hex(&mac), hex(&hub_secret(&[6; 32], "cc")));
        assert_eq!(hex(&t), VEC_TH);
        assert_eq!(hex(&s), VEC_S);
        assert_eq!(code, VEC_CODE);
        assert_eq!(hex(&k0), VEC_K0);
        assert_eq!(hex(&k3), VEC_K3);
        assert_eq!(hex(&mac), VEC_MAC);
        assert_eq!(hex(&hub_secret(&[6; 32], "cc")), VEC_HUBSECRET);
    }

    const VEC_TH: &str = "af7369f5bac5c613b958471530d69b638f0be097c6b131b91fd55b3576e787a3";
    const VEC_S: &str = "cd966abbfc7ca130ce3c947df356376ba6852ee20f3724c8afcd635441bff309";
    const VEC_CODE: &str = "547386";
    const VEC_K0: &str = "e6b49459350050f2c0c6ea10a589ec82e565579adc99f05a00ba18fad774146e";
    const VEC_K3: &str = "7c342e37a39cace52b8281c6ea32c3125608190ff09969cfbb5750608ed66f3f";
    const VEC_MAC: &str = "78d83b9c1472be6f7cfabe8d2c59f7a155de2b26ed7c880cd877dc81fe863ad2";
    const VEC_HUBSECRET: &str = "849c6eb3ca9b030f2bb199862c4e88aaa29cf7460dfeb1b09daaca05f9e60571";

    #[test]
    fn ratchet_moves_forward_with_grace() {
        let mut a = Ratchet::new([9; 32]);
        let mut b = Ratchet::new([9; 32]);
        let k0 = a.key(0, Duration::from_secs(10), 0).unwrap();
        assert!(a.key(0, Duration::from_secs(10), 1).is_none(), "the next epoch's key only shortly before it");
        let early1 = a.key(0, EPOCH - Duration::from_secs(5), 1).unwrap();
        let k1 = b.key(1, Duration::from_secs(1), 1).unwrap();
        assert_eq!(early1, k1, "lead: the next key ahead of time is the same key");
        assert_ne!(k0, k1);
        // Just after the change the old key still works, then it's gone for good.
        assert_eq!(a.key(1, Duration::from_secs(5), 0), Some(k0));
        assert_eq!(a.key(1, GRACE, 0), None, "erased after the grace");
        assert_eq!(a.key(1, Duration::from_secs(1), 0), None, "and doesn't come back");
        // Never backwards, and two epochs back is out.
        a.advance(5);
        assert_eq!(a.epoch(), 5);
        assert!(a.key(5, Duration::from_secs(1), 3).is_none());
        assert!(a.key(5, Duration::from_secs(1), 1).is_none());
        // Jumping ahead several epochs gives the same chain as stepping one by one.
        let mut c = Ratchet::new([9; 32]);
        for e in 0..=5 {
            c.advance(e);
        }
        assert_eq!(a.key(5, Duration::from_secs(40), 5), c.key(5, Duration::from_secs(40), 5));
    }

    #[test]
    fn window_takes_each_counter_once() {
        let mut w = Window::default();
        assert!(!w.take(0));
        assert!(w.take(1));
        assert!(!w.take(1), "replay");
        assert!(w.take(5));
        assert!(w.take(3), "out of order is fine");
        assert!(!w.take(3));
        assert!(w.take(200));
        assert!(!w.take(5), "too old");
        assert!(w.take(150));
        assert!(!w.take(150));
    }

    fn request(method: &str, target: &str, sid: &str, auth: &str) -> Request {
        let (path, q) = target.split_once('?').unwrap_or((target, ""));
        let _ = q;
        Request {
            method: method.into(),
            path: path.into(),
            target: target.into(),
            headers: vec![("x-harbor-session".into(), sid.into()), ("x-harbor-auth".into(), auth.into())],
            ..Default::default()
        }
    }

    fn state_with_session(root: [u8; 32], start: Instant, bound: bool) -> State {
        let st = State::default();
        st.sessions.lock().unwrap().insert("s1".into(), Session { token: "tok".into(), phone_fp: "pfp".into(), bound, start, last: start, ratchet: Ratchet::new(root), window: Window::default(), fails: 0 });
        st
    }

    fn signed(root: [u8; 32], e: u64, n: u64, method: &str, target: &str, x: Option<&[u8; 32]>) -> String {
        let mut r = Ratchet::new(root);
        r.advance(e);
        let k = r.key(e, Duration::from_secs(60), e).unwrap();
        format!("{e}.{n}.{}", hex(&hmac32(&k, request_msg("s1", e, n, method, target, 0, "pfp", "hfp", x).as_bytes())))
    }

    #[test]
    fn requests_need_a_good_mac() {
        let t0 = Instant::now();
        let root = [7; 32];
        let x = [1u8; 32];
        let st = state_with_session(root, t0, true);
        let at = |s: u64| t0 + Duration::from_secs(s);
        let ok = request("GET", "/v1/state", "s1", &signed(root, 0, 1, "GET", "/v1/state", Some(&x)));
        assert_eq!(st.verify_at(&ok, "pfp", "hfp", Some(&x), at(5)), Ok("tok".into()));
        assert_eq!(st.verify_at(&ok, "pfp", "hfp", Some(&x), at(6)), Err("replayed request"));
        // Another connection (exporter), path, method, TLS key or session: refused.
        let r2 = request("GET", "/v1/state", "s1", &signed(root, 0, 2, "GET", "/v1/state", Some(&x)));
        assert_eq!(st.verify_at(&r2, "pfp", "hfp", Some(&[2; 32]), at(7)), Err("bad MAC"));
        assert_eq!(st.verify_at(&r2, "pfp", "hfp", None, at(7)), Err("session needs a TLS connection"));
        assert_eq!(st.verify_at(&r2, "other", "hfp", Some(&x), at(7)), Err("session used with another TLS key"));
        let mut moved = r2.clone();
        moved.target = "/v1/hubs".into();
        assert_eq!(st.verify_at(&moved, "pfp", "hfp", Some(&x), at(7)), Err("bad MAC"));
        let mut posted = r2.clone();
        posted.method = "DELETE".into();
        assert_eq!(st.verify_at(&posted, "pfp", "hfp", Some(&x), at(7)), Err("bad MAC"));
        let mut lost = r2.clone();
        lost.headers[0].1 = "nope".into();
        assert_eq!(st.verify_at(&lost, "pfp", "hfp", Some(&x), at(7)), Err("unknown or expired session"));
        assert_eq!(st.verify_at(&r2, "pfp", "hfp", Some(&x), at(8)), Ok("tok".into()), "the right one still works");
        // A wrong root (a guess, a key from another session) never fits.
        let forged = request("GET", "/v1/state", "s1", &signed([8; 32], 0, 3, "GET", "/v1/state", Some(&x)));
        assert_eq!(st.verify_at(&forged, "pfp", "hfp", Some(&x), at(9)), Err("bad MAC"));
    }

    #[test]
    fn epochs_rotate_with_grace() {
        let t0 = Instant::now();
        let root = [7; 32];
        let x = [1u8; 32];
        let st = state_with_session(root, t0, true);
        let at = |s: u64| t0 + Duration::from_secs(s);
        let req = |e, n| request("GET", "/v1/events?since=1", "s1", &signed(root, e, n, "GET", "/v1/events?since=1", Some(&x)));
        // Keep the session alive across epochs (idle timeout is 30 min).
        assert!(st.verify_at(&req(0, 1), "pfp", "hfp", Some(&x), at(1)).is_ok());
        assert!(st.verify_at(&req(1, 2), "pfp", "hfp", Some(&x), at(400)).is_err(), "epoch 1's key isn't out yet");
        assert!(st.verify_at(&req(1, 3), "pfp", "hfp", Some(&x), at(580)).is_ok(), "shortly before the change: the next key");
        assert!(st.verify_at(&req(0, 4), "pfp", "hfp", Some(&x), at(610)).is_ok(), "shortly after: the old key");
        assert!(st.verify_at(&req(1, 5), "pfp", "hfp", Some(&x), at(640)).is_ok());
        assert_eq!(st.verify_at(&req(0, 6), "pfp", "hfp", Some(&x), at(645)), Err("MAC for another epoch"), "old key erased after the grace");
        assert!(st.verify_at(&req(2, 7), "pfp", "hfp", Some(&x), at(1300)).is_ok());
        assert!(st.verify_at(&req(3, 8), "pfp", "hfp", Some(&x), at(1900)).is_ok());
        // Idle past the limit: gone.
        assert_eq!(st.verify_at(&req(6, 9), "pfp", "hfp", Some(&x), at(1900 + IDLE.as_secs() + 1)), Err("session expired"));
    }

    #[test]
    fn too_many_bad_macs_end_the_session() {
        let t0 = Instant::now();
        let st = state_with_session([7; 32], t0, false);
        let bad = request("GET", "/v1/state", "s1", &format!("0.1.{}", hex(&[0; 32])));
        for _ in 0..MAC_FAILS {
            assert_eq!(st.verify_at(&bad, "pfp", "hfp", None, t0), Err("bad MAC"));
        }
        assert_eq!(st.verify_at(&bad, "pfp", "hfp", None, t0), Err("unknown or expired session"));
    }

    // ---------------------------------------------------------------- the whole handshake

    use crate::api::{Hub, Peer, Token, Via};

    fn hub_with(tokens: Vec<Token>) -> Hub {
        Hub::new(tokens, 0)
    }

    fn peer(fp: &str, x: [u8; 32]) -> Peer {
        Peer { ip: "10.0.0.5".parse().unwrap(), via: Via::Tls(Some(fp.into())), x: Some(x) }
    }

    fn post(path: &str) -> Request {
        Request { method: "POST".into(), path: path.into(), target: path.into(), ..Default::default() }
    }

    fn call(hub: &Hub, p: &Peer, path: &str, token: &str, body: Value) -> crate::api::Reply {
        let req = post(path);
        let segs: Vec<&str> = req.path.trim_matches('/').split('/').collect();
        let level = hub.auth(token, &p.via).unwrap();
        serve(hub, p, p.x.as_ref(), &req, &segs, token, level, &body, &|| {})
    }

    /// Pairs `phone` with a ticket (or upgrades a legacy token) up to the code; returns it.
    fn start_pairing(hub: &Hub, phone: &mut Phone, p: &Peer, token: &str) -> (crate::api::Reply, String, [u8; 32]) {
        let hub_fp = crate::tls::my_fp();
        let (k, epk) = eph();
        let presence = phone.presence_spki();
        let x = p.x.unwrap();
        let psig = phone.sign(&pair_presence_msg(&hub_fp, &phone.fp, token, &epk, &presence, true, &x));
        let r = call(hub, p, "/v1/pair/start", token, json!({ "epk": hex(&epk), "presence": hex(&presence), "binding": true, "psig": hex(&psig), "name": "Pixel" }));
        if r.status != 200 {
            return (r, String::new(), [0; 32]);
        }
        let epk_h = unhex(r.body["epk"].as_str().unwrap()).unwrap();
        let z = agree(k, &epk_h);
        let t = pair_transcript(&hub_fp, &phone.fp, token, &epk, &epk_h, &presence, true, &x);
        let (secret, code) = pair_keys(&t, &z);
        phone.secret = secret;
        (r, code, t)
    }

    fn open_session(hub: &Hub, phone: &Phone, p: &Peer, token: &str, secret: [u8; 32], signer: &Phone) -> crate::api::Reply {
        let hub_fp = crate::tls::my_fp();
        let (k, epk) = eph();
        let nonce = [3u8; 32];
        let h = call(hub, p, "/v1/session/hello", token, json!({ "epk": hex(&epk), "nonce": hex(&nonce) }));
        assert_eq!(h.status, 200, "{:?}", h.body);
        let epk_h = unhex(h.body["epk"].as_str().unwrap()).unwrap();
        let ch = unhex(h.body["challenge"].as_str().unwrap()).unwrap();
        let z = agree(k, &epk_h);
        let t2 = session_transcript(&hub_fp, &phone.fp, token, &epk, &epk_h, &nonce, &ch, &p.x.unwrap());
        let proof = labelled(&secret, "harbor-session-v3 proof", &t2);
        let sig = signer.sign(&session_presence_msg(&t2));
        let r = call(hub, p, "/v1/session/open", token, json!({ "hid": h.body["hid"], "proof": hex(&proof), "sig": hex(&sig) }));
        if r.status == 200 {
            let root = session_root(&t2, &z, &secret);
            assert_eq!(r.body["proof"].as_str().unwrap(), hex(&labelled(&root, "harbor-session-v3 hub", &t2)), "the hub proves it too");
        }
        r
    }

    fn ticket(tok: &str) -> Token {
        Token { token: tok.into(), group: "g".repeat(16), created: crate::store::now(), ticket: true, ..Default::default() }
    }

    #[test]
    fn pairing_needs_the_code_confirmed_on_the_pc() {
        let hub = hub_with(vec![ticket("t1")]);
        let mut phone = Phone::new(&"a".repeat(64));
        let p = peer(&phone.fp, [1; 32]);
        let (r, code, t) = start_pairing(&hub, &mut phone, &p, "t1");
        assert_eq!(r.status, 200);
        let w = hub.auth3.waiting();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].code, code, "both screens show the same code");
        assert_eq!(w[0].name, "Pixel");
        // Nothing works with the ticket but pairing.
        assert_eq!(call(&hub, &p, "/v1/session/hello", "t1", json!({})).status, 401);
        // A wrong proof voids the attempt.
        let bad = call(&hub, &p, "/v1/pair/finish", "t1", json!({ "proof": hex(&[0; 32]) }));
        assert_eq!(bad.status, 401);
        let (_, code, t2) = start_pairing(&hub, &mut phone, &p, "t1");
        assert_ne!(t, t2, "a fresh agreement each time");
        assert_eq!(hub.auth3.waiting()[0].code, code);
        hub.auth3.decide("t1", true);
        let proof = labelled(&phone.secret, "harbor-pair-v3 phone", &t2);
        let done = call(&hub, &p, "/v1/pair/finish", "t1", json!({ "proof": hex(&proof) }));
        assert_eq!(done.body["status"], "paired");
        assert_eq!(done.body["proof"].as_str().unwrap(), hex(&labelled(&phone.secret, "harbor-pair-v3 hub", &t2)));
        let tok = hub.tokens.lock().unwrap()[0].clone();
        assert!(tok.three() && !tok.ticket && tok.binding);
        assert_eq!(tok.fp, phone.fp, "bound to the phone's TLS key");
        assert_eq!(tok.secret, hex(&phone.secret));
        assert_eq!(hub.auth("t1", &p.via), Ok(Level::Session));
        // With all three factors a session opens.
        let s = open_session(&hub, &phone, &p, "t1", phone.secret, &phone);
        assert_eq!(s.status, 200, "{:?}", s.body);
        assert_eq!(hub.auth3.status("t1").sessions, 1);
    }

    #[test]
    fn a_refused_pairing_gets_nothing() {
        let hub = hub_with(vec![ticket("t1")]);
        let mut phone = Phone::new(&"a".repeat(64));
        let p = peer(&phone.fp, [1; 32]);
        let (_, _, t) = start_pairing(&hub, &mut phone, &p, "t1");
        hub.auth3.decide("t1", false);
        let r = call(&hub, &p, "/v1/pair/finish", "t1", json!({ "proof": hex(&labelled(&phone.secret, "harbor-pair-v3 phone", &t)) }));
        assert_eq!(r.status, 403);
        assert!(!hub.tokens.lock().unwrap()[0].three());
    }

    #[test]
    fn two_phones_with_one_code_void_it() {
        let hub = hub_with(vec![ticket("t1")]);
        let (mut a, mut b) = (Phone::new(&"a".repeat(64)), Phone::new(&"b".repeat(64)));
        let (pa, pb) = (peer(&a.fp, [1; 32]), peer(&b.fp, [2; 32]));
        assert_eq!(start_pairing(&hub, &mut a, &pa, "t1").0.status, 200);
        assert_eq!(start_pairing(&hub, &mut b, &pb, "t1").0.status, 401);
        assert!(hub.tokens.lock().unwrap().is_empty(), "the code is void");
        assert!(hub.auth3.waiting().is_empty());
    }

    #[test]
    fn pairing_checks_the_presence_signature() {
        let hub = hub_with(vec![ticket("t1")]);
        let phone = Phone::new(&"a".repeat(64));
        let other = Phone::new(&"a".repeat(64));
        let p = peer(&phone.fp, [1; 32]);
        let (_, epk) = eph();
        let presence = phone.presence_spki();
        let psig = other.sign(&pair_presence_msg(&crate::tls::my_fp(), &phone.fp, "t1", &epk, &presence, true, &[1; 32]));
        let r = call(&hub, &p, "/v1/pair/start", "t1", json!({ "epk": hex(&epk), "presence": hex(&presence), "binding": true, "psig": hex(&psig) }));
        assert_eq!(r.status, 401);
        assert!(hub.auth3.waiting().is_empty());
    }

    /// A hub with "tok" paired with three factors to `phone`.
    fn paired() -> (Hub, Phone, Peer) {
        let hub = hub_with(vec![ticket("tok")]);
        let mut phone = Phone::new(&"a".repeat(64));
        let p = peer(&phone.fp, [1; 32]);
        let (_, _, t) = start_pairing(&hub, &mut phone, &p, "tok");
        hub.auth3.decide("tok", true);
        assert_eq!(call(&hub, &p, "/v1/pair/finish", "tok", json!({ "proof": hex(&labelled(&phone.secret, "harbor-pair-v3 phone", &t)) })).status, 200);
        (hub, phone, p)
    }

    #[test]
    fn each_factor_is_needed() {
        let (hub, phone, p) = paired();
        // 1. Another TLS key with the token: refused before any handshake.
        assert!(hub.auth("tok", &Via::Tls(Some("c".repeat(64)))).is_err());
        assert!(hub.auth("tok", &Via::Tls(None)).is_err());
        // 2. Without the pairing secret.
        let r = open_session(&hub, &phone, &p, "tok", [0x55; 32], &phone);
        assert_eq!(r.status, 401);
        assert_eq!(r.body["error"], REFUSED, "one generic refusal");
        // 3. Without the presence key (another key signs).
        let thief = Phone::new(&phone.fp);
        assert_eq!(open_session(&hub, &phone, &p, "tok", phone.secret, &thief).status, 401);
        // A hello from one key doesn't open for another.
        let (_, epk) = eph();
        let h = call(&hub, &p, "/v1/session/hello", "tok", json!({ "epk": hex(&epk), "nonce": hex(&[3; 32]) }));
        let mut q = p.clone();
        q.x = Some([9; 32]);
        let r = call(&hub, &q, "/v1/session/open", "tok", json!({ "hid": h.body["hid"], "proof": "00", "sig": "00" }));
        assert_eq!(r.status, 401);
        // All three: in.
        assert_eq!(open_session(&hub, &phone, &p, "tok", phone.secret, &phone).status, 200);
        // A session's proof is bound to the TLS connection it opened on: replaying an open on
        // another connection fails (the exporter differs), see open_session's transcript.
        assert_eq!(hub.auth3.status("tok").sessions, 1);
    }

    #[test]
    fn failed_starts_lock_the_pairing() {
        let (hub, phone, p) = paired();
        for _ in 0..LOCK_AFTER {
            assert_eq!(open_session(&hub, &phone, &p, "tok", [0x55; 32], &phone).status, 401);
        }
        assert!(hub.auth3.status("tok").locked.is_some());
        let h = call(&hub, &p, "/v1/session/hello", "tok", json!({ "epk": hex(&eph().1), "nonce": hex(&[3; 32]) }));
        assert_eq!(h.status, 401, "locked: even the right factors wait");
        hub.auth3.unlock("tok");
        assert_eq!(open_session(&hub, &phone, &p, "tok", phone.secret, &phone).status, 200);
    }

    #[test]
    fn a_legacy_pairing_upgrades_only_from_its_key() {
        let legacy = Token { token: "old".into(), group: "g".repeat(16), fp: "a".repeat(64), ..Default::default() };
        let hub = hub_with(vec![legacy]);
        let mut phone = Phone::new(&"a".repeat(64));
        let p = peer(&phone.fp, [1; 32]);
        assert_eq!(hub.auth("old", &p.via), Ok(Level::Legacy));
        assert_eq!(call(&hub, &p, "/v1/session/hello", "old", json!({})).status, 401, "no session without the upgrade");
        let (r, code, t) = start_pairing(&hub, &mut phone, &p, "old");
        assert_eq!(r.status, 200);
        let w = hub.auth3.waiting();
        assert!(w[0].upgrade);
        assert_eq!(w[0].code, code);
        hub.auth3.decide("old", true);
        assert_eq!(call(&hub, &p, "/v1/pair/finish", "old", json!({ "proof": hex(&labelled(&phone.secret, "harbor-pair-v3 phone", &t)) })).status, 200);
        assert_eq!(hub.auth("old", &p.via), Ok(Level::Session));
    }

    #[test]
    fn tickets_expire() {
        let mut t = ticket("t1");
        t.created -= TICKET_TTL + 1;
        let hub = hub_with(vec![t]);
        assert!(hub.auth("t1", &Via::Tls(Some("a".repeat(64)))).is_err());
    }
}
