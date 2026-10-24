//! Reachable from outside the home network: Harbor opens its own port on the router.
//!
//! Every 20 minutes (mappings last an hour) it asks the default gateway, in this order:
//! - **PCP** (RFC 6887, UDP 5351): a MAP of the API port for IPv4, and for each global IPv6
//!   address a pinhole in the router's IPv6 firewall;
//! - **NAT-PMP** (RFC 6886, UDP 5351): a TCP mapping and the router's public IPv4 address;
//! - **UPnP-IGD** (SSDP, then SOAP AddPortMapping/GetExternalIPAddress on WANIPConnection or
//!   WANPPPConnection).
//!
//! The first that works wins. A public address that is itself private or shared (100.64/10:
//! the provider's carrier-grade NAT) can't be reached from outside, and says so. IPv6 global
//! addresses are used as they are (they're in `tls::lan_addrs`); whether the router lets
//! connections in to them is only known once someone does: the listener notes when a known key
//! reaches this PC from a public address ([`reached`]).
//!
//! Safe to have on (kv `net_map`, on by default): from public addresses the listener only
//! answers keys it already knows (api.rs), so the port shows nothing to anyone else.

use serde_json::{Value, json};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, UdpSocket};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const LIFETIME: u32 = 3600;
const EVERY: Duration = Duration::from_secs(20 * 60);
const WAIT: Duration = Duration::from_millis(1500);

/// What this PC knows about being reachable from outside.
#[derive(Clone, Debug, Default)]
pub struct State {
    /// The mapping that works: (how, public address and port).
    pub mapped: Option<(String, SocketAddr)>,
    /// The router's public IPv4 address, when it said.
    pub public_v4: Option<Ipv4Addr>,
    /// IPv6 pinholes opened (PCP).
    pub pinholes: Vec<Ipv6Addr>,
    /// What each method answered, for Settings ("PCP: no answer", …).
    pub tried: Vec<(String, String)>,
    /// When it last looked (None: not yet).
    pub checked: Option<Instant>,
    /// The last time a known key reached this PC from a public address: (unix time, its address).
    pub outside: Option<(i64, IpAddr)>,
}

pub static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);

pub fn state() -> State {
    STATE.lock().unwrap().clone()
}

/// A known phone or PC reached the listener from a public address: proof it's reachable.
pub fn reached(from: IpAddr) {
    let mut s = STATE.lock().unwrap();
    let now = crate::store::now();
    if s.outside.is_none_or(|(at, _)| now - at > 60) {
        s.outside = Some((now, from));
        if let Ok(st) = crate::store::Store::open() {
            st.set("net_outside", &json!([now, from.to_string()]).to_string());
        }
    }
}

/// The public "ip:port" to tell phones and peers, when mapped and actually public.
pub fn public_addr() -> Option<String> {
    let s = STATE.lock().unwrap();
    s.mapped.as_ref().map(|(_, a)| a).filter(|a| is_public(a.ip())).map(|a| a.to_string())
}

/// Not private, not shared (CGNAT), not loopback: reachable from the internet if mapped.
pub fn is_public(ip: IpAddr) -> bool {
    !crate::tls::private_ip(ip) && !ip.is_unspecified() && !ip.is_multicast() && !matches!(ip, IpAddr::V4(v) if v.octets()[0] == 100 && (v.octets()[1] & 0xc0) == 64)
}

// ================================================================== gateways

/// The default IPv4 gateway, from /proc/net/route.
pub fn gateway_v4(route: &str) -> Option<Ipv4Addr> {
    route.lines().skip(1).find_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        (f.len() > 2 && f[1] == "00000000" && f[2] != "00000000").then(|| u32::from_str_radix(f[2], 16).ok()).flatten().map(|g| Ipv4Addr::from(u32::from_be(g)))
    })
}

/// The default IPv6 gateway (a link-local address) and its interface, from /proc/net/ipv6_route.
pub fn gateway_v6(route: &str) -> Option<(Ipv6Addr, String)> {
    route.lines().find_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 10 || f[0] != "00000000000000000000000000000000" || f[1] != "00" || f[4] == "00000000000000000000000000000000" || f[9] == "lo" {
            return None;
        }
        let b = (0..16).map(|i| u8::from_str_radix(&f[4][i * 2..i * 2 + 2], 16).ok()).collect::<Option<Vec<u8>>>()?;
        let a: [u8; 16] = b.try_into().ok()?;
        Some((Ipv6Addr::from(a), f[9].to_string()))
    })
}

/// The address this PC uses towards `to` (its source address for that route).
fn local_to(to: IpAddr) -> Option<IpAddr> {
    let s = UdpSocket::bind(if to.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).ok()?;
    s.connect((to, 9)).ok()?;
    s.local_addr().ok().map(|a| a.ip())
}

// ================================================================== NAT-PMP

/// The router's public IPv4 address (NAT-PMP opcode 0).
pub fn pmp_public(gw: Ipv4Addr) -> Result<Ipv4Addr, String> {
    let r = udp_ask(SocketAddr::new(gw.into(), 5351), &[0, 0], 12)?;
    pmp_public_parse(&r)
}

pub fn pmp_public_parse(r: &[u8]) -> Result<Ipv4Addr, String> {
    if r.len() < 12 || r[0] != 0 || r[1] != 128 {
        return Err("not a NAT-PMP answer".into());
    }
    match u16::from_be_bytes([r[2], r[3]]) {
        0 => Ok(Ipv4Addr::new(r[8], r[9], r[10], r[11])),
        c => Err(format!("refused (code {c})")),
    }
}

pub fn pmp_request(port: u16, lifetime: u32) -> Vec<u8> {
    let mut m = vec![0u8, 2, 0, 0];
    m.extend(port.to_be_bytes());
    m.extend(port.to_be_bytes());
    m.extend(lifetime.to_be_bytes());
    m
}

/// The external port of a NAT-PMP TCP mapping answer.
pub fn pmp_map_parse(r: &[u8]) -> Result<u16, String> {
    if r.len() < 16 || r[0] != 0 || r[1] != 130 {
        return Err("not a NAT-PMP answer".into());
    }
    match u16::from_be_bytes([r[2], r[3]]) {
        0 => Ok(u16::from_be_bytes([r[10], r[11]])),
        c => Err(format!("refused (code {c})")),
    }
}

// ================================================================== PCP

fn v6_of(ip: IpAddr) -> [u8; 16] {
    match ip {
        IpAddr::V4(v) => v.to_ipv6_mapped().octets(),
        IpAddr::V6(v) => v.octets(),
    }
}

/// A PCP MAP request for TCP `port` from `client` (its IPv4 or IPv6 address), with `nonce`.
pub fn pcp_request(client: IpAddr, port: u16, lifetime: u32, nonce: [u8; 12]) -> Vec<u8> {
    let mut m = vec![2u8, 1, 0, 0];
    m.extend(lifetime.to_be_bytes());
    m.extend(v6_of(client));
    m.extend(nonce);
    m.extend([6u8, 0, 0, 0]);
    m.extend(port.to_be_bytes());
    m.extend(port.to_be_bytes());
    // Suggested external address: any, of the client's family.
    m.extend(if client.is_ipv4() { v6_of(IpAddr::V4(Ipv4Addr::UNSPECIFIED)) } else { [0u8; 16] });
    m
}

/// A PCP MAP answer: (external address, external port).
pub fn pcp_parse(r: &[u8], nonce: [u8; 12]) -> Result<SocketAddr, String> {
    if r.len() < 60 || r[0] != 2 || r[1] != 0x81 {
        return Err("not a PCP answer".into());
    }
    if r[3] != 0 {
        return Err(format!("refused (code {})", r[3]));
    }
    if r[24..36] != nonce {
        return Err("answer to another request".into());
    }
    let port = u16::from_be_bytes([r[42], r[43]]);
    let a: [u8; 16] = r[44..60].try_into().map_err(|_| "short")?;
    let ip = Ipv6Addr::from(a);
    Ok(SocketAddr::new(ip.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(ip)), port))
}

fn pcp_map(gw: IpAddr, client: IpAddr, port: u16, lifetime: u32) -> Result<SocketAddr, String> {
    let n = crate::store::random_bytes(12).map_err(|e| e.to_string())?;
    let nonce: [u8; 12] = n.try_into().map_err(|_| "no nonce")?;
    let r = udp_ask(SocketAddr::new(gw, 5351), &pcp_request(client, port, lifetime, nonce), 1100)?;
    pcp_parse(&r, nonce)
}

/// One UDP question, waiting up to 1.5 s for the answer (two tries).
fn udp_ask(to: SocketAddr, msg: &[u8], max: usize) -> Result<Vec<u8>, String> {
    let s = UdpSocket::bind(if to.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).map_err(|e| e.to_string())?;
    s.connect(to).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(WAIT)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; max.max(64)];
    for _ in 0..2 {
        let _ = s.send(msg);
        if let Ok(n) = s.recv(&mut buf) {
            buf.truncate(n);
            return Ok(buf);
        }
    }
    Err("no answer".into())
}

// ================================================================== UPnP-IGD

/// The control URLs of a gateway's WAN connection service: (service type, control URL).
pub fn igd_service(desc: &str, base: &str) -> Option<(String, String)> {
    for st in ["urn:schemas-upnp-org:service:WANIPConnection:2", "urn:schemas-upnp-org:service:WANIPConnection:1", "urn:schemas-upnp-org:service:WANPPPConnection:1"] {
        let Some(at) = desc.find(&format!("<serviceType>{st}</serviceType>")) else { continue };
        let rest = &desc[at..];
        let end = rest.find("</service>").unwrap_or(rest.len());
        let block = &rest[..end];
        let url = block.split("<controlURL>").nth(1)?.split("</controlURL>").next()?.trim();
        let full = if url.starts_with("http") { url.to_string() } else { format!("{}/{}", base.trim_end_matches('/'), url.trim_start_matches('/')) };
        return Some((st.to_string(), full));
    }
    None
}

/// "http://host:port" of a URL.
fn base_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let host = rest.split('/').next()?;
    Some(format!("http://{host}"))
}

/// A tiny HTTP/1.1 client for the router's own pages (plain HTTP on the LAN, as UPnP is).
fn http(url: &str, soap: Option<(&str, &str)>) -> Result<String, String> {
    let rest = url.strip_prefix("http://").ok_or("not http")?;
    let (host, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
    let addr: SocketAddr = if host.contains(':') { host.parse().map_err(|_| "bad host")? } else { format!("{host}:80").parse().map_err(|_| "bad host")? };
    // Only the gateway's own LAN address: nothing a router's answer names elsewhere is fetched.
    if !crate::tls::private_ip(addr.ip()) {
        return Err("not on this network".into());
    }
    let mut s = TcpStream::connect_timeout(&addr, WAIT).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(4)));
    use std::io::{Read, Write};
    let req = match soap {
        Some((action, body)) => format!("POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nSOAPAction: \"{action}\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()),
        None => format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
    };
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut out = vec![];
    let _ = s.take(256 << 10).read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).into_owned();
    let status = text.split_whitespace().nth(1).unwrap_or("");
    if status != "200" {
        return Err(format!("answered {status}"));
    }
    Ok(text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default())
}

fn soap(st: &str, action: &str, args: &str) -> String {
    format!(r#"<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="{st}">{args}</u:{action}></s:Body></s:Envelope>"#)
}

fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    xml.split(&format!("<{name}>")).nth(1)?.split(&format!("</{name}>")).next()
}

/// Finds the gateway's UPnP description URL (SSDP M-SEARCH from `from`).
fn ssdp(from: Ipv4Addr) -> Result<String, String> {
    let s = UdpSocket::bind((from, 0)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
    for st in ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", "urn:schemas-upnp-org:device:InternetGatewayDevice:2"] {
        let m = format!("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n");
        let _ = s.send_to(m.as_bytes(), "239.255.255.250:1900");
    }
    let mut buf = [0u8; 2048];
    let end = Instant::now() + Duration::from_secs(3);
    while Instant::now() < end {
        let Ok((n, _)) = s.recv_from(&mut buf) else { break };
        let t = String::from_utf8_lossy(&buf[..n]);
        if let Some(l) = t.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("location")).map(|(_, v)| v.trim().to_string())) {
            return Ok(l);
        }
    }
    Err("no answer".into())
}

fn upnp(local: Ipv4Addr, port: u16) -> Result<(Option<Ipv4Addr>, SocketAddr), String> {
    let loc = ssdp(local)?;
    let desc = http(&loc, None)?;
    let base = tag(&desc, "URLBase").map(String::from).or_else(|| base_of(&loc)).ok_or("bad description")?;
    let (st, ctl) = igd_service(&desc, &base).ok_or("no WAN connection service")?;
    let args = format!(
        "<NewRemoteHost></NewRemoteHost><NewExternalPort>{port}</NewExternalPort><NewProtocol>TCP</NewProtocol><NewInternalPort>{port}</NewInternalPort><NewInternalClient>{local}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>Harbor</NewPortMappingDescription><NewLeaseDuration>{LIFETIME}</NewLeaseDuration>"
    );
    http(&ctl, Some((&format!("{st}#AddPortMapping"), &soap(&st, "AddPortMapping", &args))))?;
    let ext = http(&ctl, Some((&format!("{st}#GetExternalIPAddress"), &soap(&st, "GetExternalIPAddress", "")))).ok();
    let ip = ext.as_deref().and_then(|x| tag(x, "NewExternalIPAddress")).and_then(|x| x.trim().parse::<Ipv4Addr>().ok());
    Ok((ip, SocketAddr::new(IpAddr::V4(ip.unwrap_or(Ipv4Addr::UNSPECIFIED)), port)))
}

// ================================================================== the loop

/// Tries each method once; the state says what happened.
pub fn check(port: u16) -> State {
    let mut st = State { checked: Some(Instant::now()), outside: STATE.lock().unwrap().outside, ..Default::default() };
    let route = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
    if let Some(gw) = gateway_v4(&route) {
        let local = match local_to(IpAddr::V4(gw)) {
            Some(IpAddr::V4(l)) => l,
            _ => Ipv4Addr::UNSPECIFIED,
        };
        match pcp_map(IpAddr::V4(gw), IpAddr::V4(local), port, LIFETIME) {
            Ok(a) => {
                st.tried.push(("PCP".into(), format!("mapped as {a}")));
                st.mapped = Some(("PCP".into(), a));
            }
            Err(e) => st.tried.push(("PCP".into(), e)),
        }
        if st.mapped.is_none() {
            match pmp_public(gw).and_then(|ip| udp_ask(SocketAddr::new(gw.into(), 5351), &pmp_request(port, LIFETIME), 16).and_then(|r| pmp_map_parse(&r)).map(|p| (ip, p))) {
                Ok((ip, p)) => {
                    st.public_v4 = Some(ip);
                    st.tried.push(("NAT-PMP".into(), format!("mapped as {ip}:{p}")));
                    st.mapped = Some(("NAT-PMP".into(), SocketAddr::new(ip.into(), p)));
                }
                Err(e) => st.tried.push(("NAT-PMP".into(), e)),
            }
        }
        if st.mapped.is_none() && !local.is_unspecified() {
            match upnp(local, port) {
                Ok((ip, a)) => {
                    st.public_v4 = ip;
                    st.tried.push(("UPnP".into(), format!("mapped as {a}")));
                    st.mapped = Some(("UPnP".into(), a));
                }
                Err(e) => st.tried.push(("UPnP".into(), e)),
            }
        }
        if let Some((_, a)) = &st.mapped {
            if let IpAddr::V4(v) = a.ip() {
                st.public_v4 = Some(v);
            }
        }
    } else {
        st.tried.push(("IPv4".into(), "no default gateway".into()));
    }
    // IPv6: a pinhole for each global address, where the router speaks PCP.
    let route6 = std::fs::read_to_string("/proc/net/ipv6_route").unwrap_or_default();
    let globals: Vec<Ipv6Addr> = crate::tls::lan_addrs().into_iter().filter_map(|a| match a {
        IpAddr::V6(v) if is_public(a) => Some(v),
        _ => None,
    }).collect();
    if let (Some((gw6, dev)), false) = (gateway_v6(&route6), globals.is_empty()) {
        // The router's link-local address needs its interface's index.
        let scope = std::fs::read_to_string(format!("/sys/class/net/{dev}/ifindex")).ok().and_then(|t| t.trim().parse::<u32>().ok()).unwrap_or(0);
        let to = SocketAddr::V6(std::net::SocketAddrV6::new(gw6, 5351, 0, scope));
        for g in &globals {
            let Ok(n) = crate::store::random_bytes(12) else { break };
            let Ok(nonce) = <[u8; 12]>::try_from(n) else { break };
            match udp_ask(to, &pcp_request(IpAddr::V6(*g), port, LIFETIME, nonce), 1100).and_then(|r| pcp_parse(&r, nonce)) {
                Ok(_) => st.pinholes.push(*g),
                Err(e) => {
                    st.tried.push(("PCP (IPv6)".into(), e));
                    break;
                }
            }
        }
    }
    st
}

/// Keeps the mapping alive while `on()` says so (kv `net_map`); checks every 20 minutes.
pub fn start(port: u16, on: impl Fn() -> bool + Send + 'static) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if let Some((at, ip)) = crate::store::Store::open().ok().and_then(|s| s.get("net_outside")).and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| Some((v[0].as_i64()?, v[1].as_str()?.parse::<IpAddr>().ok()?))) {
        STATE.lock().unwrap().outside = Some((at, ip));
    }
    std::thread::spawn(move || loop {
        if on() {
            let s = check(port);
            let outside = STATE.lock().unwrap().outside;
            *STATE.lock().unwrap() = State { outside, ..s };
        } else {
            let mut s = STATE.lock().unwrap();
            s.mapped = None;
            s.pinholes.clear();
            s.tried = vec![("Router".into(), "off (Settings)".into())];
        }
        std::thread::sleep(EVERY);
    });
}

/// Settings' lines about reaching this PC from outside: (title, detail, good?).
pub fn summary(port: u16) -> Vec<(String, String, bool)> {
    let s = state();
    let mut v = vec![];
    match (&s.mapped, s.checked) {
        (Some((how, a)), _) if is_public(a.ip()) => v.push(("IPv4: open".into(), format!("{how} on your router maps {a} to this PC"), true)),
        (Some((how, a)), _) => v.push(("IPv4: behind your provider's shared address".into(), format!("{how} mapped {a}, but that address is itself behind your provider's NAT, so it can't be reached from the internet"), false)),
        (None, None) => v.push(("IPv4: checking…".into(), "Asking your router to open a port".into(), false)),
        (None, Some(_)) => {
            let why = s.tried.iter().map(|(m, r)| format!("{m}: {r}")).collect::<Vec<_>>().join(" · ");
            v.push(("IPv4: not reachable from the internet".into(), format!("Your router didn't open port {port} ({why}). A port forward to this PC on the router would do it."), false));
        }
    }
    let globals: Vec<IpAddr> = crate::tls::lan_addrs().into_iter().filter(|a| a.is_ipv6() && is_public(*a)).collect();
    match (globals.first(), &s.outside) {
        (_, Some((at, ip))) => v.push(("Reached from the internet".into(), format!("A paired device reached this PC from {ip}, {} ago", crate::app::ago(*at)), true)),
        (Some(g), None) if !s.pinholes.is_empty() => v.push(("IPv6: open".into(), format!("This PC is {g}; your router opened it (PCP)"), true)),
        (Some(g), None) => v.push(("IPv6: not confirmed".into(), format!("This PC has a global IPv6 address ({g}). Whether your router lets connections in is known once your phone reaches it on mobile data."), false)),
        (None, None) => v.push(("IPv6: none".into(), "This PC has no global IPv6 address.".into(), false)),
    }
    v
}

/// `harbor net`: asks the router now and says whether this PC is reachable from outside.
pub fn cli() -> i32 {
    let port: u16 = crate::store::Store::open().ok().and_then(|s| s.get("api_port")).and_then(|p| p.parse().ok()).unwrap_or(crate::api::DEFAULT_PORT);
    if let Some((at, ip)) = crate::store::Store::open().ok().and_then(|s| s.get("net_outside")).and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| Some((v[0].as_i64()?, v[1].as_str()?.parse::<IpAddr>().ok()?))) {
        STATE.lock().unwrap().outside = Some((at, ip));
    }
    println!("asking the router about port {port}…");
    let s = check(port);
    for (how, r) in &s.tried {
        println!("  {how:<11} {r}");
    }
    *STATE.lock().unwrap() = s;
    for (title, detail, _) in summary(port) {
        println!("{title}\n  {detail}");
    }
    if crate::tls::firewall_blocks_internet(port) {
        println!("firewall: ufw drops port {port} from the internet; to let paired devices in:\n  {}", crate::tls::firewall_fix_internet(port));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateways() {
        let r = "Iface\tDestination\tGateway \tFlags\nwlan0\t00000000\t0100000A\t0003\t0\t0\t600\t00000000\t0\t0\t0\nwlan0\t0000000A\t00000000\t0001\n";
        assert_eq!(gateway_v4(r), Some(Ipv4Addr::new(10, 0, 0, 1)));
        assert_eq!(gateway_v4("Iface\n"), None);
        let r6 = "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000258 00000001 00000000 00000003 wlan0\n";
        assert_eq!(gateway_v6(r6), Some(("fe80::1".parse().unwrap(), "wlan0".into())));
    }

    #[test]
    fn nat_pmp() {
        assert_eq!(pmp_request(47930, 3600), vec![0, 2, 0, 0, 0xbb, 0x3a, 0xbb, 0x3a, 0, 0, 0x0e, 0x10]);
        assert_eq!(pmp_public_parse(&[0, 128, 0, 0, 0, 0, 0, 1, 203, 0, 113, 7]), Ok(Ipv4Addr::new(203, 0, 113, 7)));
        assert!(pmp_public_parse(&[0, 128, 0, 3, 0, 0, 0, 1, 0, 0, 0, 0]).is_err());
        assert_eq!(pmp_map_parse(&[0, 130, 0, 0, 0, 0, 0, 1, 0xbb, 0x3a, 0xbb, 0x3b, 0, 0, 0x0e, 0x10]), Ok(47931));
    }

    #[test]
    fn pcp() {
        let nonce = [7u8; 12];
        let m = pcp_request(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)), 47930, 3600, nonce);
        assert_eq!(m.len(), 60);
        assert_eq!(&m[..4], &[2, 1, 0, 0]);
        assert_eq!(&m[8..24], &Ipv4Addr::new(10, 0, 0, 5).to_ipv6_mapped().octets());
        assert_eq!(m[36], 6, "TCP");
        // An answer: opcode with the response bit, result 0, the same nonce, port and address.
        let mut r = vec![2u8, 0x81, 0, 0];
        r.extend(3600u32.to_be_bytes());
        r.extend([0u8; 16]);
        r.extend(nonce);
        r.extend([6, 0, 0, 0]);
        r.extend(47930u16.to_be_bytes());
        r.extend(47930u16.to_be_bytes());
        r.extend(Ipv4Addr::new(203, 0, 113, 7).to_ipv6_mapped().octets());
        assert_eq!(pcp_parse(&r, nonce), Ok("203.0.113.7:47930".parse().unwrap()));
        assert!(pcp_parse(&r, [1u8; 12]).is_err(), "another request's answer");
        r[3] = 8;
        assert!(pcp_parse(&r, nonce).unwrap_err().contains("code 8"));
    }

    #[test]
    fn upnp_description() {
        let d = r#"<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service></serviceList>
            <deviceList><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></deviceList></device></root>"#;
        assert_eq!(igd_service(d, "http://10.0.0.1:5000"), Some(("urn:schemas-upnp-org:service:WANIPConnection:1".into(), "http://10.0.0.1:5000/ctl/IPConn".into())));
        assert_eq!(igd_service("<root/>", "http://x"), None);
        assert_eq!(base_of("http://10.0.0.1:5000/rootDesc.xml").as_deref(), Some("http://10.0.0.1:5000"));
        assert_eq!(tag("<a><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></a>", "NewExternalIPAddress"), Some("203.0.113.7"));
    }

    #[test]
    fn public_or_not() {
        assert!(is_public("203.0.113.7".parse().unwrap()) && is_public("2001:db8::1".parse().unwrap()));
        assert!(!is_public("10.0.0.1".parse().unwrap()) && !is_public(IpAddr::V4(Ipv4Addr::new(100, 70, 1, 1))), "private and shared");
        assert!(!is_public("fd00::1".parse().unwrap()));
    }
}
