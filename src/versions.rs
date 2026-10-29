//! The Harbor version on every device the user has (#85): each PC of the mesh (its version,
//! managed install, latest release, update state, auto-update; offline ones with the version
//! they last ran) and each paired phone (its app's version, when and where it was last seen).
//!
//! One source for the agent (`machines` `list`, the who-is-who note), Settings › Devices and
//! the phone's PCs sheet (`GET /v1/versions`).

use serde_json::{json, Value};

/// One PC: what its Harbor says about itself (`update::info` there; null before 0.51).
#[derive(Clone, Debug, Default)]
pub struct PcVersion {
    pub id: String,
    pub name: String,
    pub me: bool,
    pub online: bool,
    /// Unix time of its last answer (0: never this PC's own).
    pub seen: i64,
    /// "" when unknown.
    pub version: String,
    pub update: Value,
}

/// One phone's app, as the hub last saw it.
#[derive(Clone, Debug, Default)]
pub struct PhoneVersion {
    pub name: String,
    /// versionCode (0: unknown, an app before 0.19 that doesn't say it).
    pub app: i64,
    /// Last call or background ping, here or on another PC (0: never seen).
    pub seen: i64,
    /// The PC it was last seen at ("" for this one).
    pub via: String,
    /// What the phone says it is (model, Android, ABIs, built-in browser; "" when unknown).
    pub platform: String,
}

/// "0.66.0" from versionCode 66000 (Cargo.toml's version is the APK's versionName).
pub fn code_name(code: i64) -> String {
    format!("{}.{}.{}", code / 1_000_000, code / 1000 % 1000, code % 1000)
}

/// The newest Harbor any PC runs or knows of.
pub fn newest(pcs: &[PcVersion]) -> String {
    let mut best = String::new();
    for p in pcs {
        for v in [p.version.as_str(), p.update["latest"].as_str().unwrap_or("")] {
            if !v.is_empty() && (best.is_empty() || crate::update::newer(v, &best)) {
                best = v.to_string();
            }
        }
    }
    best
}

fn ago(ts: i64) -> String {
    match crate::app::ago(ts).as_str() {
        "now" => "just now".into(),
        a => format!("{a} ago"),
    }
}

/// A PC's Harbor in a line: "0.66.0 (latest, updates automatically)", "0.64.1, 0.66.0
/// available", "0.64.1, offline (last seen 2d ago)", "0.48.0 (update status unknown, before 0.51)".
pub fn pc_line(p: &PcVersion, newest: &str) -> String {
    if !p.me && !p.online {
        let v = if p.version.is_empty() { "version unknown" } else { p.version.as_str() };
        return if p.seen > 0 { format!("{v}, offline (last seen {})", ago(p.seen)) } else { format!("{v}, offline") };
    }
    if p.version.is_empty() {
        return "version unknown".into();
    }
    let u = &p.update;
    if u.is_null() || u.get("managed").is_none() {
        // A Harbor before 0.51 says its version but nothing about its updates.
        let mut s = format!("{} (update status unknown, before 0.51)", p.version);
        if !newest.is_empty() && crate::update::newer(newest, &p.version) {
            s.push_str(&format!("; {newest} is out"));
        }
        return s;
    }
    let managed = u["managed"].as_bool() == Some(true);
    let latest = u["latest"].as_str().unwrap_or("");
    let mut bits: Vec<String> = vec![];
    let state = if !managed {
        "built from source, doesn't update itself".to_string()
    } else if u["installing"].as_bool() == Some(true) {
        format!("updating to {}", if latest.is_empty() { "a newer version" } else { latest })
    } else if u["ready"].as_bool() == Some(true) {
        format!("{latest} installed, restarts into it")
    } else if u["checking"].as_bool() == Some(true) {
        "checking for updates".into()
    } else if !latest.is_empty() {
        format!("{latest} available")
    } else if let Some(e) = u["error"].as_str().filter(|e| !e.is_empty()) {
        format!("update failed: {e}")
    } else if !newest.is_empty() && crate::update::newer(newest, &p.version) {
        format!("{newest} is out")
    } else if u["status"].as_str() == Some("up to date") || newest == p.version {
        "latest".into()
    } else {
        String::new()
    };
    if !state.is_empty() {
        bits.push(state);
    }
    if managed {
        match u["auto"].as_bool() {
            Some(true) => bits.push("updates automatically".into()),
            Some(false) => bits.push("auto-update off".into()),
            None => {}
        }
    }
    if bits.is_empty() {
        p.version.clone()
    } else if bits[0] == "latest" || !managed && bits.len() == 1 {
        format!("{} ({})", p.version, bits.join(", "))
    } else {
        format!("{}, {}", p.version, bits.join(", "))
    }
}

/// A phone's app in a line: "app 0.66.0 (66000), seen 5m ago via desk", "app version unknown".
/// `served`: the versionCode of the app this PC serves (0: none).
pub fn phone_line(p: &PhoneVersion, served: i64) -> String {
    let mut s = match p.app {
        0 => "app version unknown (older than 0.17)".to_string(),
        a if a == crate::api::APP_INBOX => "app 0.17 or 0.18.0 (doesn't say which)".to_string(),
        a => format!("app {} ({a})", code_name(a)),
    };
    if served > p.app && p.app > 0 {
        s.push_str(&format!(", {} available", code_name(served)));
    }
    if p.seen > 0 {
        s.push_str(&format!(", seen {}", ago(p.seen)));
        if !p.via.is_empty() {
            s.push_str(&format!(" at {}", p.via));
        }
    } else {
        s.push_str(", not seen yet");
    }
    if !p.platform.is_empty() {
        s.push_str(&format!("; {}", p.platform));
    }
    s
}

/// The phone's own short form for who-is-who: "app 0.66.0" (None while unknown).
pub fn phone_short(app: i64) -> Option<String> {
    (app > 0 && app != crate::api::APP_INBOX).then(|| format!("app {}", code_name(app)))
}

/// Every PC (this one first) and phone the hub knows of.
pub fn gather(hub: &crate::api::Hub) -> (Vec<PcVersion>, Vec<PhoneVersion>) {
    let me = hub.mesh.me();
    let mut pcs = vec![PcVersion {
        id: me.id.clone(),
        name: if me.name.is_empty() { crate::remote::hostname() } else { me.name.clone() },
        me: true,
        online: true,
        seen: crate::store::now(),
        version: crate::update::VERSION.into(),
        update: crate::update::info(),
    }];
    let mesh_on = hub.mesh.on.load(std::sync::atomic::Ordering::Relaxed);
    if mesh_on {
        let mut peers: Vec<crate::mesh::Peer> = hub.mesh.peers.lock().unwrap().values().cloned().collect();
        peers.sort_by(|a, b| b.online.cmp(&a.online).then(a.name.cmp(&b.name)));
        pcs.extend(peers.into_iter().map(|p| PcVersion { id: p.id, name: p.name, me: false, online: p.online, seen: p.seen, version: p.version, update: p.update }));
    }
    let mut phones: Vec<PhoneVersion> = hub.paired_phones().into_iter().map(|p| PhoneVersion { name: if p.name.is_empty() { "Phone".into() } else { p.name }, app: p.app, seen: p.seen.max(p.alive), via: p.via, platform: p.platform }).collect();
    // Phones paired with another PC only.
    let known: std::collections::HashSet<String> = hub.local_phones().into_iter().map(|p| p.group).collect();
    let elsewhere = hub.elsewhere.lock().unwrap().clone();
    let mut extra: std::collections::HashMap<String, PhoneVersion> = Default::default();
    for (pc, sightings) in elsewhere.values() {
        for s in sightings.iter().filter(|s| !known.contains(&s.group)) {
            let e = extra.entry(s.group.clone()).or_default();
            e.app = e.app.max(s.app);
            if !s.platform.is_empty() && (e.platform.is_empty() || s.seen.max(s.alive) >= e.seen) {
                e.platform = s.platform.clone();
            }
            let seen = s.seen.max(s.alive);
            if seen >= e.seen {
                e.seen = seen;
                e.via = pc.clone();
                if !s.name.is_empty() {
                    e.name = s.name.clone();
                }
            }
        }
    }
    phones.extend(extra.into_values().map(|mut p| {
        if p.name.is_empty() {
            p.name = "Phone".into();
        }
        p
    }));
    phones.sort_by(|a, b| b.seen.cmp(&a.seen));
    (pcs, phones)
}

/// `GET /v1/versions`: the same lines the agent reads, for the phone's PCs sheet (from 0.68).
pub fn api_json(hub: &crate::api::Hub) -> Value {
    let (pcs, phones) = gather(hub);
    let newest = newest(&pcs);
    let served = crate::update::apk().map_or(0, |(_, c)| c);
    json!({
        "newest": newest,
        "pcs": pcs.iter().map(|p| json!({ "name": p.name, "self": p.me, "online": p.me || p.online, "seen": p.seen, "version": p.version, "line": pc_line(p, &newest) })).collect::<Vec<_>>(),
        "phones": phones.iter().map(|p| json!({ "name": p.name, "app": p.app, "app_version": if p.app > 0 { code_name(p.app) } else { String::new() }, "seen": p.seen, "via": p.via, "platform": p.platform, "line": phone_line(p, served) })).collect::<Vec<_>>(),
    })
}

/// For the agent (`machines` `list`): a "Harbor versions" section.
pub fn text(hub: &crate::api::Hub) -> String {
    let (pcs, phones) = gather(hub);
    let newest = newest(&pcs);
    let served = crate::update::apk().map_or(0, |(_, c)| c);
    let mut out = format!("Harbor versions (newest known: {}):", if newest.is_empty() { "unknown" } else { &newest });
    for p in &pcs {
        out.push_str(&format!("\n- {}{}: Harbor {}", p.name, if p.me { " (this PC)" } else { "" }, pc_line(p, &newest)));
    }
    if phones.is_empty() {
        out.push_str("\nPhones: none paired");
    } else {
        out.push_str("\nPhones:");
        for p in &phones {
            out.push_str(&format!("\n- {}: {}", p.name, phone_line(p, served)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pc(v: &str, update: Value) -> PcVersion {
        PcVersion { name: "desk".into(), online: true, version: v.into(), update, ..Default::default() }
    }

    #[test]
    fn pc_lines() {
        let up = json!({ "managed": true, "latest": null, "status": "up to date", "auto": true });
        assert_eq!(pc_line(&pc("0.66.0", up.clone()), "0.66.0"), "0.66.0 (latest, updates automatically)");
        assert_eq!(pc_line(&pc("0.64.1", json!({ "managed": true, "latest": "0.66.0", "auto": false })), "0.66.0"), "0.64.1, 0.66.0 available, auto-update off");
        assert_eq!(pc_line(&pc("0.64.1", json!({ "managed": true, "latest": null, "auto": true })), "0.66.0"), "0.64.1, 0.66.0 is out, updates automatically");
        assert_eq!(pc_line(&pc("0.64.1", json!({ "managed": true, "latest": "0.66.0", "installing": true })), ""), "0.64.1, updating to 0.66.0");
        assert_eq!(pc_line(&pc("0.64.1", json!({ "managed": true, "latest": "0.66.0", "ready": true })), ""), "0.64.1, 0.66.0 installed, restarts into it");
        assert_eq!(pc_line(&pc("0.66.0", json!({ "managed": false })), "0.66.0"), "0.66.0 (built from source, doesn't update itself)");
        assert_eq!(pc_line(&pc("0.48.0", Value::Null), "0.66.0"), "0.48.0 (update status unknown, before 0.51); 0.66.0 is out");
        assert_eq!(pc_line(&pc("", Value::Null), ""), "version unknown");
        let off = PcVersion { online: false, seen: crate::store::now() - 7200, version: "0.64.1".into(), ..Default::default() };
        assert_eq!(pc_line(&off, "0.66.0"), "0.64.1, offline (last seen 2h ago)");
        assert_eq!(pc_line(&PcVersion::default(), ""), "version unknown, offline");
        let ps = [pc("0.64.1", json!({ "latest": "0.66.0" })), pc("0.65.0", Value::Null)];
        assert_eq!(newest(&ps), "0.66.0");
    }

    #[test]
    fn phone_lines() {
        let now = crate::store::now();
        assert_eq!(code_name(66001), "0.66.1");
        assert_eq!(phone_line(&PhoneVersion { name: "p".into(), app: 66000, seen: now, via: String::new(), platform: String::new() }, 66000), "app 0.66.0 (66000), seen just now");
        assert_eq!(phone_line(&PhoneVersion { name: "p".into(), app: 64001, seen: now - 300, via: "lab".into(), platform: String::new() }, 66000), "app 0.64.1 (64001), 0.66.0 available, seen 5m ago at lab");
        let p = PhoneVersion { name: "p".into(), app: 84000, seen: now, via: String::new(), platform: "Samsung SM-A135M, Android 12 (SDK 31), ABIs armeabi-v7a".into() };
        assert_eq!(phone_line(&p, 0), "app 0.84.0 (84000), seen just now; Samsung SM-A135M, Android 12 (SDK 31), ABIs armeabi-v7a");
        assert_eq!(phone_line(&PhoneVersion::default(), 0), "app version unknown (older than 0.17), not seen yet");
        assert_eq!(phone_short(0), None);
        assert_eq!(phone_short(66000).as_deref(), Some("app 0.66.0"));
    }
}
