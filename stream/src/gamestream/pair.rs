//! GameStream pairing (what `moonlight pair` does), with the PIN approved on the
//! host by its agent (`remote-pcs-agent pin PIN NAME`), the same way the
//! Remote Devices app pairs on first Connect.

use super::http::{Host, Identity, check_status, hex, server_cert_path, unhex, xml};
use openssl::hash::{MessageDigest, hash};
use openssl::sign::{Signer, Verifier};
use openssl::symm::{Cipher, Crypter, Mode};
use openssl::x509::X509;
use std::time::Duration;

fn aes(key: &[u8], data: &[u8], mode: Mode) -> Result<Vec<u8>, String> {
    let e = |e: openssl::error::ErrorStack| e.to_string();
    let mut c = Crypter::new(Cipher::aes_128_ecb(), mode, key, None).map_err(e)?;
    c.pad(false);
    let mut out = vec![0u8; data.len() + 16];
    let n = c.update(data, &mut out).map_err(e)?;
    out.truncate(n);
    Ok(out)
}

fn rand(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    let _ = openssl::rand::rand_bytes(&mut b);
    b
}

fn signature(c: &X509) -> Vec<u8> {
    c.signature().as_slice().to_vec()
}

/// Pair with the host. `approve` is called with the PIN once the host is waiting
/// for it (it blocks in getservercert until the PIN is entered), on another thread.
pub fn pair(host: &mut Host, id: &Identity, app_version: &str, pin: &str, approve: impl FnOnce() + Send + 'static) -> Result<(), String> {
    let gen7 = app_version.split('.').next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(7) >= 7;
    let (md, hlen) = if gen7 { (MessageDigest::sha256(), 32) } else { (MessageDigest::sha1(), 20) };
    let h = |d: &[u8]| hash(md, d).map(|x| x.to_vec()).map_err(|e| e.to_string());
    let salt = rand(16);
    let mut salted = salt.clone();
    salted.extend_from_slice(pin.as_bytes());
    let key = h(&salted)?[..16].to_vec();
    let base = "devicename=roth&updateState=1";
    let long = Duration::from_secs(60);
    let short = Duration::from_secs(10);

    // 1: send our certificate; the host waits here until the PIN is entered on it
    let t = std::thread::spawn(approve);
    let r = host.http(id, "pair", &format!("{base}&phrase=getservercert&salt={}&clientcert={}", hex(&salt), hex(&id.cert_pem)), long);
    let _ = t.join();
    let r = r?;
    check_status(&r)?;
    if xml(&r, "paired").as_deref() != Some("1") {
        return Err("pairing refused at stage 1".into());
    }
    let plain = xml(&r, "plaincert").map(|c| unhex(&c)).filter(|c| !c.is_empty()).ok_or("the host is already pairing with someone")?;
    let server = X509::from_pem(&plain).map_err(|e| e.to_string())?;
    let fail = |host: &Host, why: &str| -> String {
        let _ = host.http(id, "unpair", "", Duration::from_secs(5));
        why.to_string()
    };

    // 2: our challenge
    let challenge = rand(16);
    let r = host.http(id, "pair", &format!("{base}&clientchallenge={}", hex(&aes(&key, &challenge, Mode::Encrypt)?)), short)?;
    check_status(&r)?;
    if xml(&r, "paired").as_deref() != Some("1") {
        return Err(fail(host, "pairing failed at stage 2"));
    }
    let resp = aes(&key, &unhex(&xml(&r, "challengeresponse").unwrap_or_default()), Mode::Decrypt)?;
    if resp.len() < hlen + 16 {
        return Err(fail(host, "bad challenge response"));
    }
    let server_hash = resp[..hlen].to_vec();
    let client_secret = rand(16);
    let mut cr = resp[hlen..hlen + 16].to_vec();
    cr.extend(signature(&id.cert));
    cr.extend(&client_secret);
    let mut padded = h(&cr)?;
    padded.resize(32, 0);

    // 3: answer the host's challenge
    let r = host.http(id, "pair", &format!("{base}&serverchallengeresp={}", hex(&aes(&key, &padded, Mode::Encrypt)?)), short)?;
    check_status(&r)?;
    if xml(&r, "paired").as_deref() != Some("1") {
        return Err(fail(host, "pairing failed at stage 3"));
    }
    let secret = unhex(&xml(&r, "pairingsecret").unwrap_or_default());
    if secret.len() <= 16 {
        return Err(fail(host, "bad pairing secret"));
    }
    let (server_secret, server_sig) = secret.split_at(16);
    let pubkey = server.public_key().map_err(|e| e.to_string())?;
    let mut v = Verifier::new(MessageDigest::sha256(), &pubkey).map_err(|e| e.to_string())?;
    v.update(server_secret).map_err(|e| e.to_string())?;
    if !v.verify(server_sig).unwrap_or(false) {
        return Err(fail(host, "the host's signature doesn't match (MITM?)"));
    }
    let mut expected = challenge.clone();
    expected.extend(signature(&server));
    expected.extend(server_secret);
    if h(&expected)? != server_hash {
        return Err(fail(host, "wrong PIN"));
    }

    // 4: our secret, signed
    let mut s = Signer::new(MessageDigest::sha256(), &id.key).map_err(|e| e.to_string())?;
    s.update(&client_secret).map_err(|e| e.to_string())?;
    let mut cps = client_secret.clone();
    cps.extend(s.sign_to_vec().map_err(|e| e.to_string())?);
    let r = host.http(id, "pair", &format!("{base}&clientpairingsecret={}", hex(&cps)), short)?;
    check_status(&r)?;
    if xml(&r, "paired").as_deref() != Some("1") {
        return Err(fail(host, "pairing failed at stage 4"));
    }

    // 5: over HTTPS with the new pinned certificate
    host.server_cert = Some(server.clone());
    let r = host.https(id, "pair", &format!("{base}&phrase=pairchallenge"), short);
    if r.as_ref().map(|r| xml(r, "paired").as_deref() == Some("1")).unwrap_or(false) {
        let p = server_cert_path(&host.ip, host.http_port);
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        std::fs::write(&p, server.to_pem().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        host.server_cert = None;
        Err(fail(host, &format!("pairing failed at stage 5 ({})", r.err().unwrap_or_default())))
    }
}
