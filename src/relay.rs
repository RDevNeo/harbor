//! Reaching a PC through another one, and `harbor nc`.
//!
//! **Relay.** When a PC can't reach a peer directly (another network, a firewall) but a third
//! PC of the mesh can, it asks that one to open a raw TCP stream to the peer:
//! `POST /relay/v1/<peer fingerprint>/<port>` over the relay's own pinned TLS. The relay
//! answers `200` and from then on copies bytes both ways; the caller runs a second TLS session
//! inside, pinned to the peer's key, so the relay only ever sees ciphertext. Only paired keys may
//! ask (a PC on this PC's allowed list, or a paired phone with its token), only to a PC on this
//! PC's allowed list, at one of the addresses this PC knows for it, and never through a second
//! relay. Phones may only reach a peer's Harbor port; PCs any port of a peer (`harbor nc` uses
//! it for ssh).
//!
//! **`harbor nc <host> <port> [--device <id>]`.** ssh's ProxyCommand for remote devices, in place
//! of `tailscale nc`: a device that is one of the user's paired PCs (by its peer id, name or an
//! address) is reached at its addresses on the network, else through a paired PC that reaches
//! it; anything else is a plain TCP connection to `host` (and, while Tailscale is installed,
//! `tailscale nc` for tailnet names).

use crate::api;
use crate::mesh::{self, Allowed, Dest};
use crate::tls;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

const CONNECT: Duration = Duration::from_secs(3);
/// A relayed stream with no traffic this long is closed.
const IDLE: Duration = Duration::from_secs(15 * 60);

/// "host:port" candidates for a peer, at `port`: the IPs it's known by, its network's first.
pub fn targets(addrs: &[String], port: u16) -> Vec<SocketAddr> {
    let mut v: Vec<SocketAddr> = vec![];
    for a in addrs {
        if let Ok(sa) = a.parse::<SocketAddr>() {
            let t = SocketAddr::new(sa.ip(), port);
            if !v.contains(&t) {
                v.push(t);
            }
        }
    }
    v.sort_by_key(|a| tls::tailnet_ip(a.ip()));
    v
}

/// The first of `to` that accepts a TCP connection.
pub fn dial(to: &[SocketAddr]) -> Option<TcpStream> {
    to.iter().filter(|a| !unreachable(a)).find_map(|a| TcpStream::connect_timeout(a, CONNECT).ok())
}

/// Tests on one PC: `HARBOR_UNREACHABLE=ip:port,…` are addresses this instance can't reach
/// directly (as if on another network), so the relay is what's left.
pub fn unreachable(a: &SocketAddr) -> bool {
    std::env::var("HARBOR_UNREACHABLE").is_ok_and(|l| l.split(',').any(|x| x.trim().parse::<SocketAddr>().ok() == Some(*a)))
}

// ================================================================== the relay's side

/// `POST /relay/v1/<fp>/<port>` on the API listener (api.rs). Answers with an error, or with
/// `200` and then pumps the connection until either side closes.
pub fn serve(mut r: BufReader<tls::Conn>, from: &api::Peer, req: &api::Request, hub: &api::Hub) {
    let fail = |r: &mut BufReader<tls::Conn>, status: u16, msg: &str| api::send_json_to(r.get_mut(), status, &serde_json::json!({ "error": msg }));
    let segs = req.segments();
    let (Some(fp), Some(port)) = (segs.get(2).and_then(|f| tls::normalize_fp(f)), segs.get(3).and_then(|p| p.parse::<u16>().ok())) else {
        return fail(&mut r, 400, "bad relay request");
    };
    let api::Via::Tls(Some(caller)) = &from.via else { return fail(&mut r, 403, "a relay needs TLS and a key") };
    let pc = hub.mesh.allowed_fp(caller).is_some();
    let phone = !pc && hub.enabled.load(std::sync::atomic::Ordering::SeqCst) && req.bearer().is_some_and(|t| hub.auth(t, &from.via).is_ok());
    if !pc && !phone {
        return fail(&mut r, 403, "only paired PCs and phones may use this PC as a relay");
    }
    let Some(target) = hub.mesh.allowed_fp(&fp).filter(|_| fp != tls::my_fp() && fp != *caller) else {
        return fail(&mut r, 404, "that PC isn't paired with this one");
    };
    let known = hub.mesh.addrs_of_fp(&fp);
    let harbor_port = known.iter().chain(target.addrs.iter()).filter_map(|a| a.parse::<SocketAddr>().ok()).map(|a| a.port()).next().unwrap_or(api::DEFAULT_PORT);
    if phone && port != harbor_port {
        return fail(&mut r, 403, "a phone may only reach a PC's Harbor");
    }
    let Some(out) = dial(&targets(&known, port)) else {
        return fail(&mut r, 502, &format!("{} doesn't answer from here either", if target.name.is_empty() { "that PC" } else { &target.name }));
    };
    let _ = out.set_nodelay(true);
    let ok = r.get_mut().write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").and_then(|_| r.get_mut().flush());
    if ok.is_err() {
        return;
    }
    let pre = r.buffer().to_vec();
    let mut conn = r.into_inner();
    let Some((c, sock)) = conn.take_tls() else { return };
    use std::os::fd::AsRawFd;
    let fd = out.as_raw_fd();
    tls::pump(c, sock, &pre, fd, &mut &out, &mut &out, &|| drop(out.shutdown(std::net::Shutdown::Write)), IDLE);
}

// ================================================================== the caller's side

/// A raw stream to the PC with key `fp`, at `port`, through the PC at `via` (pinned to its key).
pub fn open(via: &Dest, fp: &str, port: u16, wait: Duration) -> Result<tls::Client, String> {
    let sock = via.addr.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("no address")?;
    let (mut s, _) = tls::connect(&sock, Some(&via.fp), CONNECT, wait)?;
    let head = format!("POST /relay/v1/{fp}/{port} HTTP/1.1\r\nHost: {}\r\nContent-Length: 0\r\n\r\n", via.addr);
    s.write_all(head.as_bytes()).and_then(|_| s.flush()).map_err(|e| e.to_string())?;
    // The answer's head, a byte at a time: what follows it belongs to the relayed stream.
    let mut head = Vec::new();
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 || s.read(&mut b).map_err(|e| e.to_string())? == 0 {
            return Err("the relay closed".into());
        }
        head.push(b[0]);
    }
    let text = String::from_utf8_lossy(&head);
    let status: u16 = text.split_whitespace().nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    if status != 200 {
        // An error answer has a JSON body after the head.
        let mut rest = String::new();
        let _ = BufReader::new(&mut s).take(4096).read_line(&mut rest);
        let msg = serde_json::from_str::<serde_json::Value>(&rest).ok().and_then(|v| v["error"].as_str().map(String::from));
        return Err(msg.unwrap_or_else(|| format!("the relay answered {status}")));
    }
    Ok(s)
}

// ================================================================== harbor nc

/// The paired PC a remote device is: by peer id, name, or one of its addresses.
pub fn find_pc<'a>(list: &'a [Allowed], device: &str, host: &str) -> Option<&'a Allowed> {
    let label = host.split('.').next().unwrap_or(host);
    let ip = host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().ok();
    list.iter().filter(|a| !a.fp.is_empty()).find(|a| {
        (!device.is_empty() && a.id == device)
            || (!a.id.is_empty() && a.id == host)
            || a.name.eq_ignore_ascii_case(label)
            || mesh::label(&a.id).eq_ignore_ascii_case(label)
            || ip.is_some_and(|ip| a.addrs.iter().any(|x| x.parse::<SocketAddr>().is_ok_and(|s| s.ip() == ip)))
    })
}

/// `harbor nc [--device <id>] <host> <port>`: stdin/stdout to that port. Returns the exit code.
pub fn cli(args: &[String]) -> i32 {
    let mut device = String::new();
    let mut rest: Vec<&String> = vec![];
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--device" {
            device = it.next().cloned().unwrap_or_default();
        } else {
            rest.push(a);
        }
    }
    let (Some(host), Some(port)) = (rest.first(), rest.get(1).and_then(|p| p.parse::<u16>().ok())) else {
        eprintln!("usage: harbor nc [--device <id>] <host> <port>");
        return 2;
    };
    let list = crate::store::Store::open().map(|s| mesh::load_allowed(&s)).unwrap_or_default();
    if let Some(pc) = find_pc(&list, &device, host) {
        if let Some(s) = dial(&targets(&pc.addrs, port)) {
            return plain(s);
        }
        // Not from here: through another paired PC that reaches it.
        for via in list.iter().filter(|a| !a.fp.is_empty() && a.fp != pc.fp) {
            for addr in &via.addrs {
                let d = Dest { addr: addr.clone(), fp: via.fp.clone(), via: None };
                if let Ok(s) = open(&d, &pc.fp, port, Duration::from_secs(30)) {
                    let (c, sock) = s.into_parts();
                    let stdin = std::io::stdin();
                    tls::pump(c, sock, &[], 0, &mut stdin.lock(), &mut std::io::stdout().lock(), &|| {}, IDLE);
                    return 0;
                }
            }
        }
        eprintln!("harbor nc: {} doesn't answer, directly or through your other PCs", if pc.name.is_empty() { host } else { &pc.name });
        return 1;
    }
    let to: Vec<SocketAddr> = (host.trim_start_matches('[').trim_end_matches(']'), port).to_socket_addrs().map(|a| a.collect()).unwrap_or_default();
    if let Some(s) = dial(&to) {
        return plain(s);
    }
    // A tailnet name while Tailscale is still installed (optional, as before).
    if crate::providers::which("tailscale").is_some() {
        use std::os::unix::process::CommandExt;
        let e = std::process::Command::new("tailscale").args(["nc", host, &port.to_string()]).exec();
        eprintln!("harbor nc: {e}");
        return 1;
    }
    eprintln!("harbor nc: can't reach {host}:{port}");
    1
}

/// Copies stdin to the socket and the socket to stdout until either ends.
fn plain(s: TcpStream) -> i32 {
    let _ = s.set_nodelay(true);
    let Ok(mut w) = s.try_clone() else { return 1 };
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut w);
        let _ = w.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut &s, &mut std::io::stdout().lock());
    drop(up);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_pc_a_device_is() {
        let a = Allowed { fp: "a".repeat(64), id: "ts:desk".into(), name: "desk".into(), addrs: vec!["10.0.0.5:47930".into()], ..Default::default() };
        let b = Allowed { fp: "b".repeat(64), id: "pc:laptop".into(), name: "Laptop".into(), addrs: vec!["[fd00::7]:47931".into()], ..Default::default() };
        let old = Allowed { node: "nX".into(), name: "old".into(), ..Default::default() };
        let list = vec![a, b, old];
        assert_eq!(find_pc(&list, "ts:desk", "desk.example.ts.net").map(|p| p.name.as_str()), Some("desk"), "by device id");
        assert_eq!(find_pc(&list, "", "desk.example.ts.net").map(|p| p.name.as_str()), Some("desk"), "by its MagicDNS label");
        assert_eq!(find_pc(&list, "", "laptop").map(|p| p.name.as_str()), Some("Laptop"), "by name");
        assert_eq!(find_pc(&list, "", "fd00::7").map(|p| p.name.as_str()), Some("Laptop"), "by address");
        assert_eq!(find_pc(&list, "", "10.0.0.5").map(|p| p.id.as_str()), Some("ts:desk"));
        assert!(find_pc(&list, "", "old").is_none(), "a PC without a key isn't reached this way");
        assert!(find_pc(&list, "", "elsewhere.example.org").is_none());
        let t = targets(&["[fd7a:115c:a1e0::1]:47930".into(), "10.0.0.5:47930".into(), "junk".into()], 22);
        assert_eq!(t.iter().map(|a| a.to_string()).collect::<Vec<_>>(), ["10.0.0.5:22", "[fd7a:115c:a1e0::1]:22"], "the network's first, Tailscale's last");
    }
}
