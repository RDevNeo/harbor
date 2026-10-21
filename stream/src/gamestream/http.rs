//! Harbor's GameStream client identity (its own certificate, like any Moonlight)
//! and the host's HTTP(S) API: serverinfo, applist, launch/resume, pairing calls.
//! Plain HTTP on the host's port (47989 or 48989), HTTPS with our client
//! certificate on HttpsPort (port - 5), the host's certificate pinned after pairing.

use openssl::asn1::Asn1Time;
use openssl::bn::{BigNum, MsbOption};
use openssl::hash::MessageDigest;
use openssl::pkey::{PKey, Private};
use openssl::rsa::Rsa;
use openssl::ssl::{SslConnector, SslMethod, SslVerifyMode};
use openssl::x509::{X509, X509NameBuilder};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;

pub struct Identity {
    pub cert: X509,
    pub key: PKey<Private>,
    pub cert_pem: Vec<u8>,
    pub unique_id: String,
}

pub fn dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")
    });
    base.join("harbor/gamestream")
}

impl Identity {
    /// Load ~/.config/harbor/gamestream/{cert,key}.pem, creating them the first time.
    pub fn load() -> Result<Self, String> {
        let d = dir();
        let (cp, kp, up) = (d.join("cert.pem"), d.join("key.pem"), d.join("uniqueid"));
        if let (Ok(c), Ok(k)) = (std::fs::read(&cp), std::fs::read(&kp)) {
            let cert = X509::from_pem(&c).map_err(|e| e.to_string())?;
            let key = PKey::private_key_from_pem(&k).map_err(|e| e.to_string())?;
            let unique_id = std::fs::read_to_string(&up).unwrap_or_else(|_| "0123456789ABCDEF".into()).trim().to_string();
            return Ok(Self { cert, key, cert_pem: c, unique_id });
        }
        let e = |e: openssl::error::ErrorStack| e.to_string();
        let key = PKey::from_rsa(Rsa::generate(2048).map_err(e)?).map_err(e)?;
        let mut name = X509NameBuilder::new().map_err(e)?;
        name.append_entry_by_text("CN", "NVIDIA GameStream Client").map_err(e)?;
        let name = name.build();
        let mut b = X509::builder().map_err(e)?;
        b.set_version(2).map_err(e)?;
        let mut serial = BigNum::new().map_err(e)?;
        serial.rand(64, MsbOption::MAYBE_ZERO, false).map_err(e)?;
        let serial = serial.to_asn1_integer().map_err(e)?;
        b.set_serial_number(&serial).map_err(e)?;
        b.set_subject_name(&name).map_err(e)?;
        b.set_issuer_name(&name).map_err(e)?;
        b.set_pubkey(&key).map_err(e)?;
        let (nb, na) = (Asn1Time::days_from_now(0).map_err(e)?, Asn1Time::days_from_now(365 * 20).map_err(e)?);
        b.set_not_before(&nb).map_err(e)?;
        b.set_not_after(&na).map_err(e)?;
        b.sign(&key, MessageDigest::sha256()).map_err(e)?;
        let cert = b.build();
        let cert_pem = cert.to_pem().map_err(e)?;
        let mut uid = [0u8; 8];
        openssl::rand::rand_bytes(&mut uid).map_err(e)?;
        let unique_id = hex(&uid).to_uppercase();
        std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        let key_pem = key.private_key_to_pem_pkcs8().map_err(e)?;
        write_private(&kp, &key_pem)?;
        std::fs::write(&cp, &cert_pem).map_err(|e| e.to_string())?;
        std::fs::write(&up, &unique_id).map_err(|e| e.to_string())?;
        Ok(Self { cert, key, cert_pem, unique_id })
    }
}

fn write_private(p: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(p).map_err(|e| e.to_string())?;
    f.write_all(data).map_err(|e| e.to_string())
}

/// Where a host's pinned certificate lives (one per address:port, like Moonlight's records).
pub fn server_cert_path(ip: &str, port: u16) -> PathBuf {
    dir().join("servers").join(format!("{}_{port}.pem", ip.replace([':', '/'], "_")))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).filter_map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()).collect()
}

/// `<tag>value</tag>` from the host's XML replies (flat; good enough for GameStream).
pub fn xml(doc: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let s = doc.find(&open)? + open.len();
    let e = doc[s..].find(&format!("</{tag}>"))? + s;
    Some(doc[s..e].to_string())
}

/// The root's status_code attribute: 200 = fine.
pub fn check_status(doc: &str) -> Result<(), String> {
    let code = doc
        .find("status_code=\"")
        .map(|i| &doc[i + 13..])
        .and_then(|r| r.split('"').next())
        .and_then(|c| c.parse::<u32>().ok())
        .unwrap_or(200);
    if code == 200 {
        return Ok(());
    }
    let msg = doc.find("status_message=\"").map(|i| doc[i + 16..].split('"').next().unwrap_or("").to_string()).unwrap_or_default();
    Err(format!("host said {code}: {msg}"))
}

pub struct Host {
    pub ip: String,
    pub http_port: u16,
    pub https_port: u16,
    pub server_cert: Option<X509>,
}

fn query(id: &Identity, args: &str) -> String {
    let mut uuid = [0u8; 16];
    let _ = openssl::rand::rand_bytes(&mut uuid);
    format!("uniqueid={}&uuid={}{}{}", id.unique_id, hex(&uuid), if args.is_empty() { "" } else { "&" }, args)
}

fn read_response(mut s: impl Read) -> Result<String, String> {
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).or_else(|e| if buf.is_empty() { Err(e.to_string()) } else { Ok(0) })?;
    let text = String::from_utf8_lossy(&buf).to_string();
    let (head, body) = text.split_once("\r\n\r\n").ok_or("bad HTTP reply")?;
    let status = head.split_whitespace().nth(1).unwrap_or("0");
    if status != "200" {
        return Err(format!("HTTP {status}"));
    }
    // Sunshine answers with a plain body (Content-Length) or chunks.
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let mut out = String::new();
        let mut rest = body;
        while let Some((len, tail)) = rest.split_once("\r\n") {
            let n = usize::from_str_radix(len.trim(), 16).unwrap_or(0);
            if n == 0 || tail.len() < n {
                break;
            }
            out.push_str(&tail[..n]);
            rest = &tail[n..].trim_start_matches("\r\n");
        }
        return Ok(out);
    }
    Ok(body.to_string())
}

fn connect(ip: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let addr = (ip, port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("bad address")?;
    let s = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("{ip}:{port}: {e}"))?;
    s.set_read_timeout(Some(timeout)).ok();
    s.set_write_timeout(Some(Duration::from_secs(5))).ok();
    Ok(s)
}

impl Host {
    pub fn new(ip: &str, port: u16) -> Self {
        let server_cert = std::fs::read(server_cert_path(ip, port)).ok().and_then(|p| X509::from_pem(&p).ok());
        Self { ip: ip.into(), http_port: port, https_port: port.saturating_sub(5), server_cert }
    }

    pub fn http(&self, id: &Identity, cmd: &str, args: &str, timeout: Duration) -> Result<String, String> {
        let mut s = connect(&self.ip, self.http_port, timeout)?;
        let req = format!("GET /{cmd}?{} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n", query(id, args), self.ip, self.http_port);
        s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        read_response(s)
    }

    /// HTTPS with our certificate; the host's must be the pinned one.
    pub fn https(&self, id: &Identity, cmd: &str, args: &str, timeout: Duration) -> Result<String, String> {
        let pinned = self.server_cert.as_ref().ok_or("not paired")?.to_der().map_err(|e| e.to_string())?;
        let mut b = SslConnector::builder(SslMethod::tls_client()).map_err(|e| e.to_string())?;
        b.set_certificate(&id.cert).map_err(|e| e.to_string())?;
        b.set_private_key(&id.key).map_err(|e| e.to_string())?;
        b.set_verify_callback(SslVerifyMode::PEER, move |_ok, ctx| {
            // Only the leaf matters: it must be exactly the certificate we pinned at pairing.
            ctx.error_depth() > 0 || ctx.current_cert().and_then(|c| c.to_der().ok()).is_some_and(|d| d == pinned)
        });
        let conn = b.build().configure().map_err(|e| e.to_string())?.verify_hostname(false).use_server_name_indication(false);
        let tcp = connect(&self.ip, self.https_port, timeout)?;
        let mut s = conn.connect(&self.ip, tcp).map_err(|e| format!("TLS: {e}"))?;
        let req = format!("GET /{cmd}?{} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n", query(id, args), self.ip, self.https_port);
        s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        read_response(s)
    }

    /// serverinfo over HTTPS when paired (it then reports PairStatus for real), else HTTP.
    pub fn server_info(&mut self, id: &Identity) -> Result<String, String> {
        let plain = self.http(id, "serverinfo", "", Duration::from_secs(5))?;
        check_status(&plain)?;
        if let Some(p) = xml(&plain, "HttpsPort").and_then(|p| p.parse().ok()).filter(|p| *p != 0) {
            self.https_port = p;
        }
        if self.server_cert.is_some() {
            if let Ok(s) = self.https(id, "serverinfo", "", Duration::from_secs(5)) {
                if check_status(&s).is_ok() {
                    return Ok(s);
                }
            }
            // our pinned certificate (or our pairing) went stale
            return Ok(plain.replace("<PairStatus>1</PairStatus>", "<PairStatus>0</PairStatus>"));
        }
        Ok(plain)
    }
}
