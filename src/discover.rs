//! Finding the user's other Harbors on the local network, without Tailscale or a daemon.
//!
//! While sharing is on, each Harbor announces itself every 30 s (and answers an "ask" at once)
//! with a small JSON datagram to the multicast group 239.255.71.30 and the broadcast address, UDP
//! port 47930 (shared by every Harbor on a PC: SO_REUSEADDR/SO_REUSEPORT):
//! `{"harbor":1,"t":"here"|"ask","id","name","fp","port","v"}`. Nothing in it is trusted: an
//! announcement only says "a Harbor with this key may be at this address". A paired PC's
//! address is tried (pinned to its key, so a false one costs one failed attempt), and an
//! unpaired one is listed in Settings › Devices to pair with a code.

use crate::mesh::Shared;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 71, 30);
pub const PORT: u16 = 47930;
/// How often a Harbor says it's here.
const EVERY: Duration = Duration::from_secs(30);
/// An announcement is forgotten after this.
pub const FRESH: Duration = Duration::from_secs(100);
const MAX_SEEN: usize = 64;

/// A Harbor heard on the network.
#[derive(Clone, Debug, PartialEq)]
pub struct Lan {
    pub fp: String,
    pub id: String,
    pub name: String,
    /// Where its API listens ("ip:port"): the datagram's source address and the port it says.
    pub addr: String,
    pub version: String,
    pub at: Instant,
}

/// Harbors heard lately, by fingerprint (shared with Settings).
pub static HEARD: LazyLock<Mutex<HashMap<String, Lan>>> = LazyLock::new(Default::default);

/// What a datagram says, when it's a Harbor's: (kind, the Harbor) with `from` as its address.
pub fn parse(data: &[u8], from: SocketAddr) -> Option<(String, Lan)> {
    if data.len() > 1400 {
        return None;
    }
    let v: Value = serde_json::from_slice(data).ok()?;
    if v["harbor"].as_i64() != Some(1) {
        return None;
    }
    let fp = crate::tls::normalize_fp(v["fp"].as_str()?)?;
    let port = u16::try_from(v["port"].as_u64()?).ok().filter(|p| *p != 0)?;
    let s = |k: &str| v[k].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(60).collect::<String>();
    let ip = crate::tls::canonical(from.ip());
    let lan = Lan { fp, id: s("id"), name: s("name"), addr: SocketAddr::new(ip, port).to_string(), version: s("v"), at: Instant::now() };
    Some((s("t"), lan))
}

/// The datagram this Harbor sends.
pub fn message(kind: &str, id: &str, name: &str, fp: &str, port: u16) -> Vec<u8> {
    serde_json::to_vec(&json!({ "harbor": 1, "t": kind, "id": id, "name": name, "fp": fp, "port": port, "v": crate::update::VERSION })).unwrap_or_default()
}

/// A UDP socket on `PORT` that several Harbors on one PC can share, with broadcast on.
#[allow(unsafe_code)] // SO_REUSEADDR/SO_REUSEPORT before bind: std can't
fn socket() -> std::io::Result<UdpSocket> {
    use std::os::fd::FromRawFd;
    unsafe {
        let fd = libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let sock = UdpSocket::from_raw_fd(fd);
        let one: libc::c_int = 1;
        for opt in [libc::SO_REUSEADDR, libc::SO_REUSEPORT] {
            libc::setsockopt(fd, libc::SOL_SOCKET, opt, &one as *const _ as *const libc::c_void, std::mem::size_of::<libc::c_int>() as libc::socklen_t);
        }
        let addr = libc::sockaddr_in { sin_family: libc::AF_INET as libc::sa_family_t, sin_port: PORT.to_be(), sin_addr: libc::in_addr { s_addr: 0 }, sin_zero: [0; 8] };
        if libc::bind(fd, &addr as *const _ as *const libc::sockaddr, std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        sock.set_broadcast(true)?;
        Ok(sock)
    }
}

/// Sends from interface `ip` (multicast leaves by the interface asked for).
#[allow(unsafe_code)] // IP_MULTICAST_IF: std can't
fn send_from(sock: &UdpSocket, ip: Ipv4Addr, data: &[u8]) {
    use std::os::fd::AsRawFd;
    let a = libc::in_addr { s_addr: u32::from(ip).to_be() };
    unsafe {
        libc::setsockopt(sock.as_raw_fd(), libc::IPPROTO_IP, libc::IP_MULTICAST_IF, &a as *const _ as *const libc::c_void, std::mem::size_of::<libc::in_addr>() as libc::socklen_t);
    }
    let _ = sock.send_to(data, (GROUP, PORT));
}

/// The IPv4 addresses of this PC's real interfaces (multicast is sent and joined on each).
fn v4_ifaces() -> Vec<Ipv4Addr> {
    crate::tls::lan_addrs().into_iter().filter_map(|a| match a {
        IpAddr::V4(v) if !crate::tls::tailnet_ip(a) => Some(v),
        _ => None,
    }).collect()
}

/// Starts announcing and listening (once). `port`: this Harbor's API port.
pub fn start(shared: Arc<crate::api::Hub>, port: u16) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let sock = match socket() {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("harbor: no network discovery (UDP {PORT}): {e}");
            return;
        }
    };
    let say = {
        let hub = shared.clone();
        move |kind: &str| {
            let me = hub.mesh.me();
            let fp = crate::tls::my_fp();
            if fp.is_empty() || !hub.mesh.on.load(std::sync::atomic::Ordering::Relaxed) {
                return None;
            }
            Some(message(kind, &me.id, &me.name, &fp, port))
        }
    };
    // Sender: now (asking), then every 30 s; joins the group on interfaces as they come.
    {
        let (sock, say) = (sock.clone(), say.clone());
        std::thread::spawn(move || {
            let mut joined: Vec<Ipv4Addr> = vec![];
            let mut first = true;
            loop {
                for ip in v4_ifaces() {
                    if !joined.contains(&ip) && sock.join_multicast_v4(&GROUP, &ip).is_ok() {
                        joined.push(ip);
                    }
                }
                if let Some(m) = say(if first { "ask" } else { "here" }) {
                    for ip in v4_ifaces() {
                        send_from(&sock, ip, &m);
                    }
                    let _ = sock.send_to(&m, (Ipv4Addr::BROADCAST, PORT));
                    first = false;
                }
                std::thread::sleep(EVERY);
            }
        });
    }
    // Receiver.
    std::thread::spawn(move || {
        let mut buf = [0u8; 1500];
        let mut last_answer = Instant::now() - EVERY;
        loop {
            let Ok((n, from)) = sock.recv_from(&mut buf) else {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            };
            let Some((kind, lan)) = parse(&buf[..n], from) else { continue };
            if lan.fp == crate::tls::my_fp() {
                continue;
            }
            heard(&shared.mesh, lan);
            // Someone just started (or a terminal asks): say it's here too, at most twice a second.
            if kind == "ask" && last_answer.elapsed() > Duration::from_millis(500) {
                last_answer = Instant::now();
                if let Some(m) = say("here") {
                    for ip in v4_ifaces() {
                        send_from(&sock, ip, &m);
                    }
                    let _ = sock.send_to(&m, (Ipv4Addr::BROADCAST, PORT));
                }
            }
        }
    });
}

/// Records a Harbor heard; a paired one's address becomes one more to try.
pub fn heard(shared: &Shared, lan: Lan) {
    if shared.allowed_fp(&lan.fp).is_some() {
        shared.hint(&lan.fp, lan.addr.clone());
    }
    let mut h = HEARD.lock().unwrap();
    h.retain(|_, l| l.at.elapsed() < FRESH);
    if h.len() < MAX_SEEN || h.contains_key(&lan.fp) {
        h.insert(lan.fp.clone(), lan);
    }
}

/// Harbors heard lately that aren't paired with this one (for Settings › Devices).
pub fn unpaired(shared: &Shared) -> Vec<Lan> {
    let mut v: Vec<Lan> = HEARD.lock().unwrap().values().filter(|l| l.at.elapsed() < FRESH && shared.allowed_fp(&l.fp).is_none()).cloned().collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

/// For `harbor mesh` on a terminal: asks the network and listens for `wait`.
pub fn ask(wait: Duration) -> Vec<Lan> {
    let Ok(sock) = socket() else { return vec![] };
    let m = serde_json::to_vec(&json!({ "harbor": 1, "t": "ask", "fp": "0".repeat(64), "port": 1 })).unwrap_or_default();
    for ip in v4_ifaces() {
        let _ = sock.join_multicast_v4(&GROUP, &ip);
        send_from(&sock, ip, &m);
    }
    let _ = sock.send_to(&m, (Ipv4Addr::BROADCAST, PORT));
    let end = Instant::now() + wait;
    let mut out: HashMap<String, Lan> = HashMap::new();
    let mut buf = [0u8; 1500];
    while Instant::now() < end {
        let _ = sock.set_read_timeout(Some(end.saturating_duration_since(Instant::now()).max(Duration::from_millis(10))));
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            if let Some((kind, l)) = parse(&buf[..n], from) {
                if kind == "here" && l.fp != crate::tls::my_fp() {
                    out.insert(l.fp.clone(), l);
                }
            }
        }
    }
    let mut v: Vec<Lan> = out.into_values().collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn announcements() {
        let fp = "a".repeat(64);
        let m = message("here", "pc:desk", "desk", &fp, 47931);
        let from: SocketAddr = "10.0.0.5:47930".parse().unwrap();
        let (kind, l) = parse(&m, from).unwrap();
        assert_eq!((kind.as_str(), l.fp.as_str(), l.id.as_str(), l.name.as_str(), l.addr.as_str()), ("here", fp.as_str(), "pc:desk", "desk", "10.0.0.5:47931"));
        // Not ours, or broken: ignored.
        assert!(parse(b"hello", from).is_none());
        assert!(parse(br#"{"harbor":1,"fp":"zz","port":1}"#, from).is_none());
        assert!(parse(br#"{"harbor":2,"fp":"aaaa","port":1}"#, from).is_none());
        assert!(parse(format!(r#"{{"harbor":1,"fp":"{fp}","port":0}}"#).as_bytes(), from).is_none(), "no port");
        assert!(parse(&vec![b' '; 2000], from).is_none());
        let named = format!(r#"{{"harbor":1,"t":"here","fp":"{fp}","port":5,"name":"a\nb{}"}}"#, "x".repeat(100));
        assert_eq!(parse(named.as_bytes(), from).unwrap().1.name.len(), 60, "names are cut and cleaned");
        // A paired PC's announcement is an address to try; an unpaired one is listed.
        let shared = Shared::default();
        *shared.allowed.lock().unwrap() = vec![crate::mesh::Allowed { fp: fp.clone(), ..Default::default() }];
        heard(&shared, l.clone());
        assert_eq!(shared.hints.lock().unwrap()[&fp], ["10.0.0.5:47931"]);
        assert!(unpaired(&shared).iter().all(|x| x.fp != fp));
        let other = Lan { fp: "b".repeat(64), ..l };
        heard(&shared, other.clone());
        assert!(unpaired(&shared).iter().any(|x| x.fp == other.fp));
    }
}
