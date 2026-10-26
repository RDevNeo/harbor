//! The tray icon: a StatusNotifierItem (KDE/freedesktop SNI, what waybar, KDE, GNOME's
//! AppIndicator extension and others host) with a com.canonical.dbusmenu menu: Open Harbor,
//! Quit Harbor completely. Click it to open the window.
//!
//! It speaks D-Bus itself, on the session bus socket, with the little of the wire protocol
//! this needs (no D-Bus library, no async runtime): one thread, blocked on the socket.
//! Without a session bus or a tray host it just isn't there (`active()` stays false) and
//! comes up when a host appears (NameOwnerChanged of org.kde.StatusNotifierWatcher).

use eframe::egui;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};

static ACTIVE: AtomicBool = AtomicBool::new(false);

const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const ITEM_PATH: &str = "/StatusNotifierItem";
const MENU_PATH: &str = "/MenuBar";
const MENU_OPEN: i32 = 1;
const MENU_QUIT: i32 = 3;

/// A tray host shows Harbor's icon.
pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// Starts the tray thread (once per process image). Never fails: no bus, no tray.
pub fn start(ctx: &egui::Context) {
    if std::env::var_os("HARBOR_NO_TRAY").is_some() {
        return;
    }
    let ctx = ctx.clone();
    let _ = std::thread::Builder::new().name("tray".into()).spawn(move || {
        if let Err(e) = run(&ctx) {
            ACTIVE.store(false, Ordering::Relaxed);
            eprintln!("harbor: no tray icon: {e}");
        }
    });
}

fn run(ctx: &egui::Context) -> Result<(), String> {
    let mut bus = Bus::connect()?;
    bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", vec![])?;
    let name = format!("org.kde.StatusNotifierItem-{}-1", std::process::id());
    bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", vec![V::S(name.clone()), V::U(4)])?;
    let rule = format!("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='{WATCHER}'");
    bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch", vec![V::S(rule)])?;
    let register = |bus: &mut Bus| {
        let serial = bus.call(WATCHER, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem", vec![V::S(name.clone())]);
        serial.ok()
    };
    let mut pending = register(&mut bus);
    loop {
        let m = bus.read()?;
        match m.kind {
            // The watcher's answer to the registration.
            2 | 3 if m.reply_serial.is_some() && m.reply_serial == pending => {
                ACTIVE.store(m.kind == 2, Ordering::Relaxed);
                pending = None;
            }
            4 if m.member == "NameOwnerChanged" => {
                // A tray host (re)started: register with it; gone: no tray.
                if let (Some(V::S(n)), Some(V::S(new))) = (m.body.first(), m.body.get(2)) {
                    if n == WATCHER {
                        ACTIVE.store(false, Ordering::Relaxed);
                        if !new.is_empty() {
                            pending = register(&mut bus);
                        }
                    }
                }
            }
            1 => {
                let reply = handle(ctx, &m);
                if m.flags & 1 == 0 {
                    match reply {
                        Ok(body) => bus.send(2, &Header { dest: m.sender.clone(), reply_serial: Some(m.serial), ..Default::default() }, body)?,
                        Err(e) => bus.send(3, &Header { dest: m.sender.clone(), reply_serial: Some(m.serial), error: Some(e.into()), ..Default::default() }, vec![V::S(e.into())])?,
                    };
                }
            }
            _ => {}
        }
    }
}

/// Answers a method call: the item, its menu, properties, introspection.
fn handle(ctx: &egui::Context, m: &Msg) -> Result<Vec<V>, &'static str> {
    let s = |i: usize| match m.body.get(i) {
        Some(V::S(s)) => s.as_str(),
        _ => "",
    };
    let int = |i: usize| match m.body.get(i) {
        Some(V::I(n)) => *n,
        _ => 0,
    };
    match (m.path.as_str(), m.iface.as_str(), m.member.as_str()) {
        (_, "org.freedesktop.DBus.Peer", "Ping") => Ok(vec![]),
        (_, "org.freedesktop.DBus.Introspectable", "Introspect") => Ok(vec![V::S(introspect(&m.path))]),
        (ITEM_PATH, "org.freedesktop.DBus.Properties", "Get") => item_props().into_iter().find(|(k, _)| *k == s(1)).map(|(_, v)| vec![V::Var(Box::new(v))]).ok_or("org.freedesktop.DBus.Error.UnknownProperty"),
        (ITEM_PATH, "org.freedesktop.DBus.Properties", "GetAll") => Ok(vec![dict(if s(0) == "org.kde.StatusNotifierItem" { item_props() } else { vec![] })]),
        (MENU_PATH, "org.freedesktop.DBus.Properties", "Get") => menu_props().into_iter().find(|(k, _)| *k == s(1)).map(|(_, v)| vec![V::Var(Box::new(v))]).ok_or("org.freedesktop.DBus.Error.UnknownProperty"),
        (MENU_PATH, "org.freedesktop.DBus.Properties", "GetAll") => Ok(vec![dict(if s(0) == "com.canonical.dbusmenu" { menu_props() } else { vec![] })]),
        (ITEM_PATH, _, "Activate" | "SecondaryActivate") => {
            crate::background::show(ctx);
            Ok(vec![])
        }
        (ITEM_PATH, _, "ContextMenu" | "Scroll" | "ProvideXdgActivationToken") => Ok(vec![]),
        (MENU_PATH, _, "GetLayout") => Ok(vec![V::U(1), layout(int(0))]),
        (MENU_PATH, _, "GetGroupProperties") => {
            let ids: Vec<i32> = match m.body.first() {
                Some(V::A(_, ids)) if !ids.is_empty() => ids.iter().filter_map(|v| if let V::I(i) = v { Some(*i) } else { None }).collect(),
                _ => vec![0, MENU_OPEN, 2, MENU_QUIT],
            };
            Ok(vec![V::A("(ia{sv})".into(), ids.into_iter().map(|id| V::R(vec![V::I(id), dict(entry_props(id))])).collect())])
        }
        (MENU_PATH, _, "GetProperty") => entry_props(int(0)).into_iter().find(|(k, _)| *k == s(1)).map(|(_, v)| vec![V::Var(Box::new(v))]).ok_or("com.canonical.dbusmenu.Error.UnknownProperty"),
        (MENU_PATH, _, "Event") => {
            if s(1) == "clicked" {
                clicked(ctx, int(0));
            }
            Ok(vec![])
        }
        (MENU_PATH, _, "EventGroup") => {
            if let Some(V::A(_, events)) = m.body.first() {
                for e in events {
                    if let V::R(f) = e {
                        if let (Some(V::I(id)), Some(V::S(ev))) = (f.first(), f.get(1)) {
                            if ev == "clicked" {
                                clicked(ctx, *id);
                            }
                        }
                    }
                }
            }
            Ok(vec![V::A("i".into(), vec![])])
        }
        (MENU_PATH, _, "AboutToShow") => Ok(vec![V::B(false)]),
        (MENU_PATH, _, "AboutToShowGroup") => Ok(vec![V::A("i".into(), vec![]), V::A("i".into(), vec![])]),
        _ => Err("org.freedesktop.DBus.Error.UnknownMethod"),
    }
}

fn clicked(ctx: &egui::Context, id: i32) {
    match id {
        MENU_OPEN => crate::background::show(ctx),
        MENU_QUIT => crate::background::quit(ctx),
        _ => {}
    }
}

fn dict(props: Vec<(&'static str, V)>) -> V {
    V::A("{sv}".into(), props.into_iter().map(|(k, v)| V::E(Box::new(V::S(k.into())), Box::new(V::Var(Box::new(v))))).collect())
}

fn item_props() -> Vec<(&'static str, V)> {
    let tip = if crate::background::hidden() { "Running in the background" } else { "Open" };
    vec![
        ("Category", V::S("ApplicationStatus".into())),
        ("Id", V::S("harbor".into())),
        ("Title", V::S("Harbor".into())),
        ("Status", V::S("Active".into())),
        ("WindowId", V::I(0)),
        ("IconName", V::S("harbor".into())),
        ("IconThemePath", V::S(String::new())),
        ("IconPixmap", pixmaps()),
        ("OverlayIconName", V::S(String::new())),
        ("AttentionIconName", V::S(String::new())),
        ("ToolTip", V::R(vec![V::S(String::new()), V::A("(iiay)".into(), vec![]), V::S("Harbor".into()), V::S(tip.into())])),
        ("ItemIsMenu", V::B(false)),
        ("Menu", V::O(MENU_PATH.into())),
    ]
}

fn menu_props() -> Vec<(&'static str, V)> {
    vec![("Version", V::U(3)), ("TextDirection", V::S("ltr".into())), ("Status", V::S("normal".into())), ("IconThemePath", V::A("s".into(), vec![]))]
}

fn entry_props(id: i32) -> Vec<(&'static str, V)> {
    match id {
        0 => vec![("children-display", V::S("submenu".into()))],
        MENU_OPEN => vec![("label", V::S("Open Harbor".into())), ("enabled", V::B(true)), ("visible", V::B(true))],
        MENU_QUIT => vec![("label", V::S("Quit Harbor completely".into())), ("enabled", V::B(true)), ("visible", V::B(true))],
        2 => vec![("type", V::S("separator".into())), ("visible", V::B(true))],
        _ => vec![],
    }
}

/// The menu as (ia{sv}av): the root and its three entries.
fn layout(parent: i32) -> V {
    let node = |id: i32, children: Vec<V>| V::R(vec![V::I(id), dict(entry_props(id)), V::A("v".into(), children)]);
    let entries = [MENU_OPEN, 2, MENU_QUIT].into_iter().map(|id| V::Var(Box::new(node(id, vec![])))).collect();
    if parent == 0 { node(0, entries) } else { node(parent, vec![]) }
}

fn introspect(path: &str) -> String {
    let body = match path {
        ITEM_PATH => r#"<interface name="org.kde.StatusNotifierItem"><method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method><method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method><method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method><method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method><property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/><property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/><property name="WindowId" type="i" access="read"/><property name="IconName" type="s" access="read"/><property name="IconThemePath" type="s" access="read"/><property name="IconPixmap" type="a(iiay)" access="read"/><property name="OverlayIconName" type="s" access="read"/><property name="AttentionIconName" type="s" access="read"/><property name="ToolTip" type="(sa(iiay)ss)" access="read"/><property name="ItemIsMenu" type="b" access="read"/><property name="Menu" type="o" access="read"/></interface>"#,
        MENU_PATH => r#"<interface name="com.canonical.dbusmenu"><method name="GetLayout"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/><arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/></method><method name="GetGroupProperties"><arg type="ai" direction="in"/><arg type="as" direction="in"/><arg type="a(ia{sv})" direction="out"/></method><method name="GetProperty"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method><method name="Event"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/></method><method name="EventGroup"><arg type="a(isvu)" direction="in"/><arg type="ai" direction="out"/></method><method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method><method name="AboutToShowGroup"><arg type="ai" direction="in"/><arg type="ai" direction="out"/><arg type="ai" direction="out"/></method><signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal><property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/><property name="Status" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/></interface>"#,
        _ => "",
    };
    format!(
        r#"<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd"><node><interface name="org.freedesktop.DBus.Introspectable"><method name="Introspect"><arg type="s" direction="out"/></method></interface><interface name="org.freedesktop.DBus.Properties"><method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method><method name="GetAll"><arg type="s" direction="in"/><arg type="a{{sv}}" direction="out"/></method></interface>{body}</node>"#
    )
}

/// Harbor's icon (packaging/harbor.svg: Lucide's anchor on a dark rounded square), drawn
/// here for hosts without the "harbor" theme icon: ARGB32 in network byte order.
fn pixmaps() -> V {
    V::A("(iiay)".into(), [22, 32, 48, 64].into_iter().map(|n| V::R(vec![V::I(n), V::I(n), V::A("y".into(), icon(n as usize).into_iter().map(V::Y).collect())])).collect())
}

fn icon(n: usize) -> Vec<u8> {
    let px = 512.0 / n as f32; // svg units per pixel
    let seg = |p: (f32, f32), a: (f32, f32), b: (f32, f32)| {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let t = (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
        ((p.0 - a.0 - t * dx).powi(2) + (p.1 - a.1 - t * dy).powi(2)).sqrt()
    };
    let mut out = Vec::with_capacity(n * n * 4);
    for y in 0..n {
        for x in 0..n {
            let (sx, sy) = ((x as f32 + 0.5) * px, (y as f32 + 0.5) * px);
            // Rounded square, radius 112.
            let (qx, qy) = ((sx - 256.0).abs() - (256.0 - 112.0), (sy - 256.0).abs() - (256.0 - 112.0));
            let d_box = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - 112.0;
            let bg = (0.5 - d_box / px).clamp(0.0, 1.0);
            // The anchor, in its 24-unit space (translate 88, scale 14), stroke 2.
            let p = ((sx - 88.0) / 14.0, (sy - 88.0) / 14.0);
            let ring = ((p.0 - 12.0).powi(2) + (p.1 - 5.0).powi(2)).sqrt();
            let arc = ((p.0 - 12.0).powi(2) + (p.1 - 12.0).powi(2)).sqrt();
            let d = [
                seg(p, (12.0, 22.0), (12.0, 8.0)),
                seg(p, (5.0, 12.0), (2.0, 12.0)),
                seg(p, (22.0, 12.0), (19.0, 12.0)),
                (ring - 3.0).abs(),
                if p.1 >= 12.0 { (arc - 10.0).abs() } else { f32::MAX },
            ]
            .into_iter()
            .fold(f32::MAX, f32::min);
            let fg = (0.5 - (d - 1.0) * 14.0 / px).clamp(0.0, 1.0) * bg;
            let c = (0x11 as f32 + (0xed - 0x11) as f32 * fg).round() as u8;
            out.extend_from_slice(&[(bg * 255.0).round() as u8, c, c, c]);
        }
    }
    out
}

// ------------------------------------------------------------------ D-Bus wire format

/// A D-Bus value. Arrays carry their element signature (empty arrays need it).
#[derive(Clone, Debug, PartialEq)]
enum V {
    Y(u8),
    B(bool),
    I(i32),
    U(u32),
    S(String),
    O(String),
    G(String),
    A(String, Vec<V>),
    R(Vec<V>),
    Var(Box<V>),
    E(Box<V>, Box<V>),
}

impl V {
    fn sig(&self) -> String {
        match self {
            V::Y(_) => "y".into(),
            V::B(_) => "b".into(),
            V::I(_) => "i".into(),
            V::U(_) => "u".into(),
            V::S(_) => "s".into(),
            V::O(_) => "o".into(),
            V::G(_) => "g".into(),
            V::A(e, _) => format!("a{e}"),
            V::R(f) => format!("({})", f.iter().map(V::sig).collect::<String>()),
            V::Var(_) => "v".into(),
            V::E(k, v) => format!("{{{}{}}}", k.sig(), v.sig()),
        }
    }
}

fn alignment(sig: &str) -> usize {
    match sig.as_bytes().first() {
        Some(b'n' | b'q') => 2,
        Some(b'b' | b'i' | b'u' | b's' | b'o' | b'a' | b'h') => 4,
        Some(b'x' | b't' | b'd' | b'(' | b'{') => 8,
        _ => 1,
    }
}

/// Length of the first complete type in a signature.
fn first_type(sig: &str) -> Option<usize> {
    let b = sig.as_bytes();
    match b.first()? {
        b'a' => Some(1 + first_type(&sig[1..])?),
        open @ (b'(' | b'{') => {
            let close = if *open == b'(' { b')' } else { b'}' };
            let mut i = 1;
            while *b.get(i)? != close {
                i += first_type(&sig[i..])?;
            }
            Some(i + 1)
        }
        _ => Some(1),
    }
}

fn types(mut sig: &str) -> Vec<&str> {
    let mut v = vec![];
    while let Some(n) = first_type(sig) {
        v.push(&sig[..n]);
        sig = &sig[n..];
    }
    v
}

#[derive(Default)]
struct W(Vec<u8>);

impl W {
    fn pad(&mut self, n: usize) {
        while self.0.len() % n != 0 {
            self.0.push(0);
        }
    }

    fn u32(&mut self, n: u32) {
        self.pad(4);
        self.0.extend_from_slice(&n.to_le_bytes());
    }

    fn put(&mut self, v: &V) {
        match v {
            V::Y(b) => self.0.push(*b),
            V::B(b) => self.u32(*b as u32),
            V::I(i) => self.u32(*i as u32),
            V::U(u) => self.u32(*u),
            V::S(s) | V::O(s) => {
                self.u32(s.len() as u32);
                self.0.extend_from_slice(s.as_bytes());
                self.0.push(0);
            }
            V::G(s) => {
                self.0.push(s.len() as u8);
                self.0.extend_from_slice(s.as_bytes());
                self.0.push(0);
            }
            V::A(elem, items) => {
                self.u32(0);
                let at = self.0.len() - 4;
                self.pad(alignment(elem));
                let start = self.0.len();
                for i in items {
                    self.put(i);
                }
                let n = (self.0.len() - start) as u32;
                self.0[at..at + 4].copy_from_slice(&n.to_le_bytes());
            }
            V::R(f) => {
                self.pad(8);
                for i in f {
                    self.put(i);
                }
            }
            V::E(k, v) => {
                self.pad(8);
                self.put(k);
                self.put(v);
            }
            V::Var(x) => {
                self.put(&V::G(x.sig()));
                self.put(x);
            }
        }
    }
}

struct R<'a> {
    b: &'a [u8],
    p: usize,
    be: bool,
}

impl R<'_> {
    fn align(&mut self, n: usize) {
        self.p = self.p.div_ceil(n) * n;
    }

    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.b.get(self.p..self.p.checked_add(n)?)?;
        self.p += n;
        Some(s)
    }

    fn u32(&mut self) -> Option<u32> {
        self.align(4);
        let b: [u8; 4] = self.take(4)?.try_into().ok()?;
        Some(if self.be { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) })
    }

    fn read(&mut self, t: &str, depth: u8) -> Option<V> {
        if depth > 32 {
            return None;
        }
        Some(match t.as_bytes().first()? {
            b'y' => V::Y(self.take(1)?[0]),
            b'b' => V::B(self.u32()? != 0),
            b'i' => V::I(self.u32()? as i32),
            b'u' | b'h' => V::U(self.u32()?),
            b'n' | b'q' => {
                self.align(2);
                self.take(2)?;
                V::U(0)
            }
            b'x' | b't' | b'd' => {
                self.align(8);
                self.take(8)?;
                V::U(0)
            }
            c @ (b's' | b'o') => {
                let n = self.u32()? as usize;
                let s = String::from_utf8_lossy(self.take(n)?).into_owned();
                self.take(1)?;
                if *c == b's' { V::S(s) } else { V::O(s) }
            }
            b'g' => {
                let n = self.take(1)?[0] as usize;
                let s = String::from_utf8_lossy(self.take(n)?).into_owned();
                self.take(1)?;
                V::G(s)
            }
            b'v' => {
                let V::G(s) = self.read("g", depth + 1)? else { return None };
                if first_type(&s)? != s.len() {
                    return None;
                }
                V::Var(Box::new(self.read(&s, depth + 1)?))
            }
            b'a' => {
                let elem = &t[1..];
                let n = self.u32()? as usize;
                self.align(alignment(elem));
                let end = self.p.checked_add(n).filter(|e| *e <= self.b.len())?;
                let mut items = vec![];
                while self.p < end {
                    items.push(self.read(elem, depth + 1)?);
                }
                V::A(elem.to_string(), items)
            }
            b'(' => {
                self.align(8);
                let inner = &t[1..t.len() - 1];
                V::R(types(inner).into_iter().map(|f| self.read(f, depth + 1)).collect::<Option<_>>()?)
            }
            b'{' => {
                self.align(8);
                let inner = types(&t[1..t.len() - 1]);
                let (k, v) = (inner.first()?, inner.get(1)?);
                V::E(Box::new(self.read(k, depth + 1)?), Box::new(self.read(v, depth + 1)?))
            }
            _ => return None,
        })
    }
}

#[derive(Default, Debug)]
struct Msg {
    kind: u8,
    flags: u8,
    serial: u32,
    path: String,
    iface: String,
    member: String,
    sender: Option<String>,
    reply_serial: Option<u32>,
    body: Vec<V>,
}

#[derive(Default)]
struct Header {
    path: Option<String>,
    iface: Option<String>,
    member: Option<String>,
    dest: Option<String>,
    error: Option<String>,
    reply_serial: Option<u32>,
}

fn encode(kind: u8, serial: u32, h: &Header, body: &[V]) -> Vec<u8> {
    let mut b = W::default();
    for v in body {
        b.put(v);
    }
    let sig: String = body.iter().map(V::sig).collect();
    let mut fields = vec![];
    let mut field = |code: u8, v: V| fields.push(V::R(vec![V::Y(code), V::Var(Box::new(v))]));
    if let Some(p) = &h.path {
        field(1, V::O(p.clone()));
    }
    if let Some(i) = &h.iface {
        field(2, V::S(i.clone()));
    }
    if let Some(m) = &h.member {
        field(3, V::S(m.clone()));
    }
    if let Some(e) = &h.error {
        field(4, V::S(e.clone()));
    }
    if let Some(r) = h.reply_serial {
        field(5, V::U(r));
    }
    if let Some(d) = &h.dest {
        field(6, V::S(d.clone()));
    }
    if !sig.is_empty() {
        field(8, V::G(sig));
    }
    let mut w = W(vec![b'l', kind, 0, 1]);
    w.u32(b.0.len() as u32);
    w.u32(serial);
    w.put(&V::A("(yv)".into(), fields));
    w.pad(8);
    w.0.extend_from_slice(&b.0);
    w.0
}

fn decode(buf: &[u8]) -> Option<Msg> {
    let be = match buf.first()? {
        b'l' => false,
        b'B' => true,
        _ => return None,
    };
    let mut r = R { b: buf, p: 4, be };
    let body_len = r.u32()? as usize;
    let serial = r.u32()?;
    let V::A(_, fields) = r.read("a(yv)", 0)? else { return None };
    r.align(8);
    let mut m = Msg { kind: buf[1], flags: *buf.get(2)?, serial, ..Default::default() };
    let mut sig = String::new();
    for f in fields {
        let V::R(f) = f else { continue };
        let (Some(V::Y(code)), Some(V::Var(v))) = (f.first(), f.get(1)) else { continue };
        match (code, v.as_ref()) {
            (1, V::O(s)) => m.path = s.clone(),
            (2, V::S(s)) => m.iface = s.clone(),
            (3, V::S(s)) => m.member = s.clone(),
            (5, V::U(n)) => m.reply_serial = Some(*n),
            (7, V::S(s)) => m.sender = Some(s.clone()),
            (8, V::G(s)) => sig = s.clone(),
            _ => {}
        }
    }
    let start = r.p;
    let end = start.checked_add(body_len).filter(|e| *e <= buf.len())?;
    // Body alignment counts from the start of the message.
    let mut body = R { b: &buf[..end], p: start, be };
    m.body = types(&sig).into_iter().map(|t| body.read(t, 0)).collect::<Option<_>>().unwrap_or_default();
    Some(m)
}

struct Bus {
    s: UnixStream,
    serial: u32,
}

impl Bus {
    fn connect() -> Result<Self, String> {
        let addr = std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap_or_default();
        let mut s = None;
        for a in addr.split(';') {
            let Some(params) = a.strip_prefix("unix:") else { continue };
            for kv in params.split(',') {
                if let Some(p) = kv.strip_prefix("path=") {
                    s = UnixStream::connect(unescape(p)).ok();
                } else if let Some(n) = kv.strip_prefix("abstract=") {
                    use std::os::linux::net::SocketAddrExt;
                    s = std::os::unix::net::SocketAddr::from_abstract_name(unescape(n).as_bytes()).ok().and_then(|a| UnixStream::connect_addr(&a).ok());
                }
            }
            if s.is_some() {
                break;
            }
        }
        if s.is_none() && addr.is_empty() {
            if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
                s = UnixStream::connect(std::path::Path::new(&dir).join("bus")).ok();
            }
        }
        let mut s = s.ok_or("no D-Bus session bus")?;
        // SASL EXTERNAL with our uid, hex-encoded.
        let uid = rustix::process::getuid().as_raw().to_string();
        let hex: String = uid.bytes().map(|b| format!("{b:02x}")).collect();
        s.write_all(format!("\0AUTH EXTERNAL {hex}\r\n").as_bytes()).map_err(|e| e.to_string())?;
        let mut line = String::new();
        BufReader::new(&s).read_line(&mut line).map_err(|e| e.to_string())?;
        if !line.starts_with("OK ") {
            return Err(format!("D-Bus refused the login: {}", line.trim()));
        }
        s.write_all(b"BEGIN\r\n").map_err(|e| e.to_string())?;
        Ok(Self { s, serial: 0 })
    }

    fn send(&mut self, kind: u8, h: &Header, body: Vec<V>) -> Result<u32, String> {
        self.serial += 1;
        self.s.write_all(&encode(kind, self.serial, h, &body)).map_err(|e| e.to_string())?;
        Ok(self.serial)
    }

    /// Sends a method call; the answer comes through `read` like everything else.
    fn call(&mut self, dest: &str, path: &str, iface: &str, member: &str, body: Vec<V>) -> Result<u32, String> {
        let h = Header { path: Some(path.into()), iface: Some(iface.into()), member: Some(member.into()), dest: Some(dest.into()), ..Default::default() };
        self.send(1, &h, body)
    }

    fn read(&mut self) -> Result<Msg, String> {
        loop {
            let mut fixed = [0u8; 16];
            self.s.read_exact(&mut fixed).map_err(|e| e.to_string())?;
            let be = fixed[0] == b'B';
            let n = |b: &[u8]| {
                let b: [u8; 4] = b.try_into().unwrap_or_default();
                (if be { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) }) as usize
            };
            let (body, fields) = (n(&fixed[4..8]), n(&fixed[12..16]));
            let total = (16 + fields).div_ceil(8) * 8 + body;
            if total > 64 << 20 {
                return Err("D-Bus message too large".into());
            }
            let mut buf = fixed.to_vec();
            buf.resize(total, 0);
            self.s.read_exact(&mut buf[16..]).map_err(|e| e.to_string())?;
            if let Some(m) = decode(&buf) {
                return Ok(m);
            }
        }
    }
}

/// D-Bus address values escape bytes as %xx.
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(x) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(x);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_round_trip() {
        let body = vec![V::U(1), layout(0), dict(item_props())];
        let h = Header { path: Some(MENU_PATH.into()), iface: Some("com.canonical.dbusmenu".into()), member: Some("GetLayout".into()), dest: Some(":1.7".into()), ..Default::default() };
        let buf = encode(1, 9, &h, &body);
        let m = decode(&buf).expect("decodes");
        assert_eq!((m.kind, m.serial, m.path.as_str(), m.member.as_str()), (1, 9, MENU_PATH, "GetLayout"));
        assert_eq!(m.body, body);
    }

    #[test]
    fn signatures() {
        assert_eq!(types("ia{sv}av"), vec!["i", "a{sv}", "av"]);
        assert_eq!(types("a(isvu)u"), vec!["a(isvu)", "u"]);
        assert_eq!(layout(0).sig(), "(ia{sv}av)");
        assert_eq!(first_type("(ii"), None);
    }

    #[test]
    fn menu_clicks_route() {
        let m = Msg { kind: 1, path: MENU_PATH.into(), iface: "com.canonical.dbusmenu".into(), member: "GetGroupProperties".into(), body: vec![V::A("i".into(), vec![V::I(MENU_QUIT)]), V::A("s".into(), vec![])], ..Default::default() };
        let r = handle(&egui::Context::default(), &m).unwrap();
        let V::A(_, items) = &r[0] else { panic!() };
        assert_eq!(items.len(), 1);
        assert!(format!("{items:?}").contains("Quit Harbor completely"));
    }

    #[test]
    fn icon_is_square_argb() {
        let px = icon(32);
        assert_eq!(px.len(), 32 * 32 * 4);
        assert_eq!(px[0], 0, "transparent corner");
        let mid = (16 * 32 + 16) * 4;
        assert_eq!(px[mid], 255, "opaque middle");
    }

    #[test]
    fn address_unescapes() {
        assert_eq!(unescape("/run/user/1000/bus"), "/run/user/1000/bus");
        assert_eq!(unescape("/tmp/a%20b"), "/tmp/a b");
    }
}
