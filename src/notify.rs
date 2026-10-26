//! Notifications for what matters (android/PROTOCOL.md, "Notifications"): an agent needs you,
//! a lead chat's turn finished (sub-agents too, if asked), CI failed, a usage limit was hit or
//! came back, another PC of the mesh went offline.
//!
//! Every event becomes a [`Note`] in the hub's short list (a day, 200 at most). Phones take them
//! with their background pings and long-polls (phoneauth::alive, `since`), even with the app
//! closed, and show them as Android notifications. This PC shows its own as desktop
//! notifications (notify-send), only while Harbor's window isn't in front.
//!
//! Never spam: notes with the same key (one per chat, per project's CI, per account, per PC)
//! within [`COALESCE`] replace each other (a counter says how many), so a phone updates one
//! notification per chat, and the desktop replaces its popup rather than adding one.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// Notes with one key this close together are one (the newest, with a count).
pub const COALESCE: Duration = Duration::from_secs(90);
/// How long a note is kept for phones that check in late.
const KEEP_S: i64 = 24 * 3600;
const KEEP_N: usize = 200;
/// Without a key or the mouse on a focused Harbor window this long, you're away from the PC.
pub const AWAY_S: i64 = 120;

/// The kinds, as the wire, the settings and Android's channels name them.
pub const KINDS: [(&str, &str); 6] = [
    ("input", "An agent needs you"),
    ("done", "A lead chat finished"),
    ("agent", "A sub-agent finished"),
    ("ci", "CI or PR checks failed"),
    ("limit", "Usage limit hit or back"),
    ("pc", "Another PC went offline"),
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Note {
    /// Grows; phones ask for what's newer than the last they saw.
    pub id: u64,
    /// Unix seconds.
    pub at: i64,
    /// One of [`KINDS`].
    pub kind: String,
    /// What it coalesces by: "chat:<gid>", "ci:<repo>", "limit:<account>", "pc:<id>".
    pub key: String,
    pub title: String,
    pub body: String,
    /// The chat (global id) it opens, when it's about one; a reply goes there.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub chat: String,
    /// How many events it stands for (coalesced).
    pub count: u32,
    /// The user wasn't at this PC when it happened (no input on a focused window for
    /// [`AWAY_S`]): for "only when I'm away from the PC".
    pub away: bool,
    /// The chat takes a reply (Reply on the phone's notification).
    #[serde(default)]
    pub reply: bool,
    /// A web page it opens instead of a chat (a PR whose checks failed).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    /// An action besides Open and Reply: "continue" (a chat waiting after a usage limit).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub act: String,
    /// The PC it happened on (name), for notes from another PC of the mesh.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub from: String,
}

/// What the desktop shows (kv `notify`). Phones keep their own choices.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Prefs {
    /// Kind → on.
    #[serde(default)]
    pub kinds: HashMap<String, bool>,
    #[serde(default)]
    pub quiet: bool,
    /// Quiet hours, "HH:MM" local time; may wrap midnight.
    #[serde(default = "quiet_from")]
    pub quiet_from: String,
    #[serde(default = "quiet_to")]
    pub quiet_to: String,
    /// Desktop: only while away from the PC (the window hidden, or no input for a while).
    #[serde(default)]
    pub away_only: bool,
}

fn quiet_from() -> String {
    "22:00".into()
}
fn quiet_to() -> String {
    "07:00".into()
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { kinds: HashMap::new(), quiet: false, quiet_from: quiet_from(), quiet_to: quiet_to(), away_only: false }
    }
}

impl Prefs {
    /// Sub-agents are off unless asked for; everything else on.
    pub fn on(&self, kind: &str) -> bool {
        *self.kinds.get(kind).unwrap_or(&(kind != "agent"))
    }

    pub fn load(store: &crate::store::Store) -> Prefs {
        store.get("notify").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self, store: &crate::store::Store) {
        store.set("notify", &serde_json::to_string(self).unwrap_or_default());
        *PREFS.lock().unwrap() = Some(self.clone());
    }

    /// Within quiet hours at `minute` (minutes since local midnight).
    pub fn quiet_at(&self, minute: u32) -> bool {
        if !self.quiet {
            return false;
        }
        let (Some(a), Some(b)) = (hm(&self.quiet_from), hm(&self.quiet_to)) else { return false };
        if a == b {
            return false;
        }
        if a < b { minute >= a && minute < b } else { minute >= a || minute < b }
    }
}

/// "HH:MM" → minutes since midnight.
pub fn hm(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Minutes since local midnight now.
fn local_minute() -> u32 {
    #[allow(unsafe_code)] // localtime_r: the local zone, no crate for it
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        (tm.tm_hour * 60 + tm.tm_min) as u32
    }
}

/// The desktop's settings as last loaded or saved (read off the UI thread).
static PREFS: Mutex<Option<Prefs>> = Mutex::new(None);
/// Harbor's window is in front (focused and visible): no desktop popups then.
pub static FOCUSED: AtomicBool = AtomicBool::new(false);
/// When the user last used a focused Harbor window (unix s).
pub static AT_PC: AtomicI64 = AtomicI64::new(0);
/// Chats (gid) a desktop notification was clicked for: the UI thread opens them.
pub static OPEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The user is at this PC: Harbor's window is in front and was used within [`AWAY_S`].
pub fn at_pc() -> bool {
    FOCUSED.load(Ordering::Relaxed) && crate::store::now() - AT_PC.load(Ordering::Relaxed) < AWAY_S
}

/// The hub's notes.
pub struct Notes {
    list: Mutex<VecDeque<Note>>,
    next: AtomicU64,
    cv: Condvar,
}

impl Default for Notes {
    fn default() -> Self {
        // Ids start at the time the hub started (ms), so a phone that saw a note of an earlier
        // run doesn't wait for this run to catch up.
        let base = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_millis() as u64);
        Notes { list: Mutex::new(VecDeque::new()), next: AtomicU64::new(base), cv: Condvar::new() }
    }
}

impl Notes {
    /// Adds a note (coalesced with one of its key from within [`COALESCE`]); returns it as kept.
    pub fn push(&self, mut n: Note) -> Note {
        let now = crate::store::now();
        n.at = now;
        n.count = n.count.max(1);
        let mut l = self.list.lock().unwrap();
        if let Some(i) = l.iter().rposition(|o| o.key == n.key && now - o.at < COALESCE.as_secs() as i64) {
            let old = l.remove(i).unwrap();
            n.count += old.count;
            // An agent that needs you stays that, whatever finished after.
            if old.kind == "input" && n.kind != "input" && n.key == old.key {
                n.kind = old.kind;
                n.title = old.title;
            }
            n.away |= old.away;
        }
        n.id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        l.push_back(n.clone());
        while l.len() > KEEP_N || l.front().is_some_and(|o| now - o.at > KEEP_S) {
            l.pop_front();
        }
        drop(l);
        self.cv.notify_all();
        n
    }

    /// The notes newer than `since` (all kept ones for 0, or an id from the future: a restarted
    /// hub), and the newest id.
    pub fn since(&self, since: u64) -> (Vec<Note>, u64) {
        let l = self.list.lock().unwrap();
        let last = self.next.load(Ordering::SeqCst);
        let since = if since > last { 0 } else { since };
        (l.iter().filter(|n| n.id > since).cloned().collect(), last)
    }

    /// The newest id.
    pub fn last(&self) -> u64 {
        self.next.load(Ordering::SeqCst)
    }

    /// This PC's own notes newer than `since`, for the other PCs of the mesh (`from` empty;
    /// nor PCs going offline, which each PC says itself).
    pub fn own_since(&self, since: u64) -> (Vec<Note>, u64) {
        let (all, last) = self.since(since);
        (all.into_iter().filter(|n| n.from.is_empty() && n.kind != "pc").collect(), last)
    }

    /// Notes another PC of the mesh had (`from` its name): kept for phones, never shown here.
    pub fn relay(&self, from: &str, notes: Vec<Note>) {
        for mut n in notes {
            n.from = from.to_string();
            self.push(n);
        }
    }

    /// Like [`Self::since`], waiting up to `wait` for one.
    pub fn wait(&self, since: u64, wait: Duration) -> (Vec<Note>, u64) {
        let deadline = Instant::now() + wait;
        let mut l = self.list.lock().unwrap();
        loop {
            let last = self.next.load(Ordering::SeqCst);
            if since > last || l.back().is_some_and(|n| n.id > since) {
                break;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            l = self.cv.wait_timeout(l, left).unwrap().0;
        }
        drop(l);
        self.since(since)
    }
}

/// Wire form for phones (and other PCs of the mesh).
pub fn wire(notes: &[Note], last: u64) -> Value {
    json!({ "notes": notes, "last": last })
}

/// A note for an event here: kept for phones, and shown on this desktop when the settings say.
pub fn post(hub: &crate::api::Hub, kind: &str, key: String, title: String, body: String, chat: String, reply: bool) {
    push(hub, Note { kind: kind.into(), key, title, body, chat, reply, ..Default::default() }, true);
}

/// Keeps `n` for phones (and the mesh); `desk`: may pop up on this desktop too.
pub fn push(hub: &crate::api::Hub, mut n: Note, desk: bool) {
    n.body = n.body.chars().take(240).collect();
    n.away = !at_pc();
    let n = hub.notes.push(n);
    if desk {
        desktop(&n);
    }
}

/// Whether a reply asks the user something: its last line ends with a question mark.
pub fn asks(text: &str) -> bool {
    let last = text.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("");
    last.trim_end_matches(|c: char| matches!(c, '*' | '_' | '`' | ')' | ' ' | '"')).ends_with('?')
}

/// A short excerpt for a notification: the last paragraph, its markdown marks dropped.
pub fn excerpt(text: &str) -> String {
    let para = text.split("\n\n").map(str::trim).filter(|p| !p.is_empty()).last().unwrap_or("");
    let flat: String = para.lines().map(|l| l.trim().trim_start_matches(['#', '-', '*', '>']).trim()).collect::<Vec<_>>().join(" ");
    let flat = flat.replace("**", "").replace('`', "");
    if flat.chars().count() > 160 { format!("{}…", flat.chars().take(159).collect::<String>()) } else { flat }
}

impl crate::app::App {
    /// A turn ended: the lead (needs you when it asks something, failed, or finished), or a
    /// sub-agent. Copies of another PC's chats are that PC's to notify.
    pub fn note_turn(&mut self, id: i64, sub: bool, failed: bool, said: &str) {
        let Some(c) = self.chat(id) else { return };
        if !c.home.is_empty() || c.gid.is_empty() {
            return;
        }
        let who = match (sub, c.name.is_empty(), c.title.is_empty()) {
            (true, false, _) => c.name.clone(),
            (_, _, false) => c.title.clone(),
            _ => "A chat".into(),
        };
        let project = c.repo_id.and_then(|r| self.repo(r)).map(|r| r.name.clone());
        let gid = c.gid.clone();
        let (kind, title) = if sub {
            ("agent", format!("{who} finished"))
        } else if failed {
            ("done", format!("{who} stopped with an error"))
        } else if asks(said) {
            ("input", format!("{who} needs you"))
        } else {
            ("done", format!("{who} finished"))
        };
        let text = excerpt(said);
        let body = match project {
            Some(p) if !text.is_empty() => format!("{p} · {text}"),
            Some(p) => p,
            None => text,
        };
        post(&self.api.hub, kind, format!("chat:{gid}"), title, body, gid, true);
    }

    /// A usage limit stopped a chat: waiting for you needs you (Continue on the phone),
    /// continuing by itself later is news about the account.
    pub fn note_limit(&mut self, chat_id: i64, account: &str, waits: bool, text: &str) {
        let Some(c) = self.chat(chat_id) else { return };
        if !c.home.is_empty() {
            return;
        }
        let name = self.account(account).map(crate::limits::account_name).unwrap_or_else(|| account.to_string());
        let n = if waits {
            Note { kind: "input".into(), key: format!("chat:{}", c.gid), title: format!("{} waits for you", c.title), body: format!("{name}: {text}"), chat: c.gid.clone(), act: "continue".into(), ..Default::default() }
        } else {
            Note { kind: "limit".into(), key: format!("limit:{account}"), title: format!("{name} hit its usage limit"), body: format!("{}: {text}", c.title), chat: c.gid.clone(), ..Default::default() }
        };
        push(&self.api.hub, n, true);
    }

    /// Each frame: whether Harbor is in front and used (for popups and "away"), chats whose
    /// desktop notification was clicked, and a PR refresh every 10 minutes for failed checks.
    pub fn notify_tick(&mut self, ctx: &eframe::egui::Context, front: bool) {
        static STARTED: std::sync::Once = std::sync::Once::new();
        STARTED.call_once(|| init(&self.store, ctx));
        FOCUSED.store(front, Ordering::Relaxed);
        if front && ctx.input(|i| !i.events.is_empty() || i.pointer.is_moving()) {
            AT_PC.store(crate::store::now(), Ordering::Relaxed);
        }
        let open: Vec<String> = std::mem::take(&mut *OPEN.lock().unwrap());
        for gid in open {
            let id = self.chats.iter().find(|c| c.gid == gid).map(|c| c.id);
            if let Some(id) = id {
                self.open(crate::app::View::Chat(id));
            }
            crate::background::show(ctx);
            ctx.send_viewport_cmd(eframe::egui::ViewportCommand::Focus);
        }
        static LAST_PRS: AtomicI64 = AtomicI64::new(0);
        let now = crate::store::now();
        let p = PREFS.lock().unwrap().clone().unwrap_or_default();
        // CI: phones may want it even when this desktop doesn't, so on unless off here and no
        // phone is paired.
        let ci = p.on("ci") || !self.api.hub.tokens.lock().unwrap().is_empty();
        if ci && !self.prs.loading && now - LAST_PRS.load(Ordering::Relaxed) >= 600 {
            LAST_PRS.store(now, Ordering::Relaxed);
            if has_gh() {
                self.load_prs();
            }
        }
    }

    /// PCs of the mesh that went offline (or came back): their transitions only, not the
    /// start of Harbor or the mesh being turned off.
    pub fn note_peers(&mut self, peers: &HashMap<String, crate::mesh::Peer>) {
        static ONLINE: Mutex<Option<HashMap<String, bool>>> = Mutex::new(None);
        let on = self.api.hub.mesh.on.load(Ordering::Relaxed);
        let mut seen = ONLINE.lock().unwrap();
        let m = seen.get_or_insert_with(HashMap::new);
        for p in peers.values() {
            let was = m.insert(p.id.clone(), p.online);
            let name = if p.name.is_empty() { "A PC".to_string() } else { p.name.clone() };
            match was {
                Some(true) if !p.online && on => post(&self.api.hub, "pc", format!("pc:{}", p.id), format!("{name} went offline"), "Harbor there doesn't answer any more.".into(), String::new(), false),
                Some(false) if p.online && on && WENT.lock().unwrap().contains(&p.id) => {
                    post(&self.api.hub, "pc", format!("pc:{}", p.id), format!("{name} is back online"), String::new(), String::new(), false)
                }
                _ => {}
            }
            let mut went = WENT.lock().unwrap();
            if p.online {
                went.retain(|x| *x != p.id);
            } else if was == Some(true) && on {
                went.push(p.id.clone());
            }
        }
    }

    /// New PR lists: the user's open PRs whose checks just failed (once per head commit). The
    /// first list after start only says what failed already.
    pub fn note_checks(&mut self, f: &crate::prs::Fetched) {
        static FAILED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);
        let mut g = FAILED.lock().unwrap();
        let primed = g.is_some();
        let set = g.get_or_insert_with(Default::default);
        for pr in f.items.iter().filter(|p| p.state == crate::prs::PrState::Open && p.checks == crate::prs::Checks::Failing && (f.viewer.is_empty() || p.author == f.viewer)) {
            let mark = format!("{}#{}@{}", pr.repo, pr.number, pr.head);
            if set.insert(mark) && primed {
                let n = Note {
                    kind: "ci".into(),
                    key: format!("ci:{}#{}", pr.repo, pr.number),
                    title: format!("Checks failed on #{} in {}", pr.number, pr.repo.rsplit('/').next().unwrap_or(&pr.repo)),
                    body: pr.title.clone(),
                    url: pr.url.clone(),
                    ..Default::default()
                };
                push(&self.api.hub, n, true);
            }
        }
    }

    /// Settings › Notifications.
    pub fn notifications_tab(&mut self, ui: &mut eframe::egui::Ui) {
        use crate::widgets as w;
        let mut p = PREFS.lock().unwrap().clone().unwrap_or_else(|| Prefs::load(&self.store));
        let before = p.clone();
        crate::pages::section(ui, "Notify me when");
        crate::pages::rows(ui, |ui| {
            for (i, (kind, label)) in KINDS.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                let desc = match *kind {
                    "input" => "A lead chat asks you something, or waits for you after a usage limit.",
                    "done" => "A lead chat's turn ends (once its sub-agents are done too), or stops with an error.",
                    "agent" => "Each sub-agent's turn. Off by default: the lead tells you.",
                    "ci" => "Checks fail on one of your open pull requests (looked at every 10 minutes).",
                    "limit" => "An account hits its usage limit or your cap, or comes back.",
                    _ => "Another PC of your mesh stops answering, or answers again.",
                };
                let mut on = p.on(kind);
                w::setting_row(ui, label, desc, |ui| w::toggle(ui, &mut on));
                p.kinds.insert(kind.to_string(), on);
            }
        });
        crate::pages::section(ui, "When");
        crate::pages::rows(ui, |ui| {
            w::setting_row(ui, "Only when I'm away from this PC", "Harbor's window is hidden, or nobody used it for 2 minutes. Without this, whenever the window isn't in front.", |ui| {
                w::toggle(ui, &mut p.away_only)
            });
            w::separator(ui);
            w::setting_row(ui, "Quiet hours", "No desktop notifications in this time (phones have their own).", |ui| w::toggle(ui, &mut p.quiet));
            if p.quiet {
                w::separator(ui);
                w::setting_row(ui, "From – to", "24-hour time, e.g. 22:00 to 07:00.", |ui| {
                    ui.horizontal(|ui| {
                        ui.add(eframe::egui::TextEdit::singleline(&mut p.quiet_from).desired_width(56.0));
                        w::subtle(ui, "to", "label-13");
                        ui.add(eframe::egui::TextEdit::singleline(&mut p.quiet_to).desired_width(56.0));
                    })
                    .response
                });
            }
        });
        crate::pages::section(ui, "Phones");
        crate::pages::rows(ui, |ui| {
            w::setting_row(
                ui,
                "Harbor for Android",
                "Paired phones get the same notifications, even with the app closed, and choose their own in the app's Settings › Notifications (with Reply and Open). Phones only see what this PC and the others of your mesh noticed.",
                |ui| {
                    let r = w::btn("Send a test").sm().outline().show(ui);
                    if r.clicked() {
                        let n = Note { kind: "test".into(), key: "test".into(), title: "Test from Harbor".into(), body: "Notifications work.".into(), ..Default::default() };
                        let n = self.api.hub.notes.push(Note { away: !at_pc(), ..n });
                        test_popup(&n);
                    }
                    r
                },
            );
        });
        if p != before {
            p.save(&self.store);
        }
    }

    /// The limit reset and the chat continues (desktop: only with "Notify me when work resumes").
    pub fn note_resumed(&mut self, chat_id: i64, account: &str, text: &str) {
        let Some(c) = self.chat(chat_id) else { return };
        let name = self.account(account).map(crate::limits::account_name).unwrap_or_else(|| account.to_string());
        let n = Note { kind: "limit".into(), key: format!("limit:{account}"), title: format!("{name}: usage limit reset"), body: format!("{} · {text}", c.title), chat: c.gid.clone(), ..Default::default() };
        let desk = self.limit_settings().3;
        push(&self.api.hub, n, desk);
    }
}

// ------------------------------------------------------------------ desktop

/// Per key: (notify-send's id, when it last popped up, the notify-send waiting for a click).
static SHOWN: Mutex<Option<HashMap<String, (u32, Instant, u32)>>> = Mutex::new(None);
/// A key pops up again at most this often; in between its notification is replaced quietly.
const REPOP: Duration = Duration::from_secs(30);

/// Shows `n` as a desktop notification unless Harbor is in front, it's off in the settings, it's
/// quiet hours, or (away only) the user is at the PC. Clicking it opens the chat.
fn desktop(n: &Note) {
    if cfg!(test) || FOCUSED.load(Ordering::Relaxed) {
        return;
    }
    let p = PREFS.lock().unwrap().clone().unwrap_or_default();
    if !p.on(&n.kind) || p.quiet_at(local_minute()) || (p.away_only && !n.away) {
        return;
    }
    let (replace, quiet) = {
        let mut s = SHOWN.lock().unwrap();
        let m = s.get_or_insert_with(HashMap::new);
        match m.get(&n.key) {
            Some((id, at, pid)) => {
                // The one it replaces waits for a click that can't come any more.
                if *pid > 0 {
                    #[allow(unsafe_code)] // kill(2) of our own child
                    unsafe {
                        libc::kill(*pid as i32, libc::SIGTERM);
                    }
                }
                (Some(*id), at.elapsed() < REPOP)
            }
            None => (None, false),
        }
    };
    let title = if n.count > 1 { format!("{} ({})", n.title, n.count) } else { n.title.clone() };
    let (key, body, chat) = (n.key.clone(), n.body.clone(), n.chat.clone());
    let urgency = if n.kind == "input" { "critical" } else { "normal" };
    std::thread::spawn(move || {
        let mut c = std::process::Command::new("notify-send");
        c.args(["-a", "Harbor", "-p", "-u", urgency]);
        if let Some(id) = replace {
            c.arg(format!("--replace-id={id}"));
        }
        if quiet {
            // Replaced without a new sound or popup where the daemon honours it.
            c.args(["-h", "boolean:suppress-sound:true", "-h", "boolean:transient:true"]);
        }
        if !chat.is_empty() {
            c.args(["-A", "default=Open"]);
        }
        c.args([&title, &body]).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        let Ok(mut child) = c.spawn() else { return };
        let pid = child.id();
        let Some(out) = child.stdout.take() else { return };
        use std::io::BufRead;
        let mut lines = std::io::BufReader::new(out).lines();
        if let Some(Ok(id)) = lines.next() {
            if let Ok(id) = id.trim().parse::<u32>() {
                let mut s = SHOWN.lock().unwrap();
                let m = s.get_or_insert_with(HashMap::new);
                let at = if quiet { m.get(&key).map_or(Instant::now(), |x| x.1) } else { Instant::now() };
                m.insert(key.clone(), (id, at, pid));
            }
        }
        // Clicked (the default action): open the chat in the window.
        if let Some(Ok(a)) = lines.next() {
            if a.trim() == "default" && !chat.is_empty() {
                OPEN.lock().unwrap().push(chat);
                if let Some(ctx) = CTX.lock().unwrap().as_ref() {
                    ctx.request_repaint();
                }
            }
        }
        let _ = child.wait();
        // Done: nothing to end when it's replaced.
        if let Some(e) = SHOWN.lock().unwrap().as_mut().and_then(|m| m.get_mut(&key)).filter(|e| e.2 == pid) {
            e.2 = 0;
        }
    });
}

/// GitHub's CLI is on PATH (the PR list needs it).
fn has_gh() -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("gh").is_file()))
}

/// PCs that went offline (their "back online" is worth a note).
static WENT: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Settings' test: shown here whatever the window and the settings.
fn test_popup(n: &Note) {
    let (t, b) = (n.title.clone(), n.body.clone());
    std::thread::spawn(move || {
        let _ = std::process::Command::new("notify-send").args(["-a", "Harbor", &t, &b]).status();
    });
}

/// The window's context, to wake the UI thread for a clicked notification.
pub static CTX: Mutex<Option<eframe::egui::Context>> = Mutex::new(None);

/// Loads the desktop's settings at start.
pub fn init(store: &crate::store::Store, ctx: &eframe::egui::Context) {
    *PREFS.lock().unwrap() = Some(Prefs::load(store));
    *CTX.lock().unwrap() = Some(ctx.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(kind: &str, key: &str, title: &str) -> Note {
        Note { kind: kind.into(), key: key.into(), title: title.into(), ..Default::default() }
    }

    #[test]
    fn notes_coalesce_per_key() {
        let n = Notes::default();
        let (_, start) = n.since(0);
        let a = n.push(note("done", "chat:1", "api finished"));
        let b = n.push(note("done", "chat:1", "api finished again"));
        n.push(note("ci", "ci:repo", "CI failed"));
        let (all, last) = n.since(start);
        assert_eq!(all.len(), 2, "one per key");
        assert!(b.id > a.id && last >= b.id);
        assert_eq!(all[0].count, 2);
        assert_eq!(all[0].title, "api finished again");
        assert_eq!(n.since(last).0.len(), 0);
        assert_eq!(n.since(last + 1000).0.len(), 2, "an id from the future: everything kept");
        // Needing you isn't covered up by what finished after.
        n.push(note("input", "chat:2", "api needs you"));
        let c = n.push(note("done", "chat:2", "api finished"));
        assert_eq!((c.kind.as_str(), c.title.as_str(), c.count), ("input", "api needs you", 2));
    }

    #[test]
    fn waiting_returns_when_one_comes() {
        let n = std::sync::Arc::new(Notes::default());
        let (_, last) = n.since(0);
        let m = n.clone();
        let t = std::thread::spawn(move || m.wait(last, Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(100));
        n.push(note("done", "chat:1", "x"));
        let (got, _) = t.join().unwrap();
        assert_eq!(got.len(), 1);
        let t0 = Instant::now();
        assert!(n.wait(n.since(0).1, Duration::from_millis(200)).0.is_empty());
        assert!(t0.elapsed() >= Duration::from_millis(190));
    }

    #[test]
    fn questions_and_excerpts() {
        assert!(asks("Done.\n\nShould I also update the docs?"));
        assert!(asks("Which one do you want: **A** or **B?**"));
        assert!(!asks("Fixed it. Tests pass."));
        assert!(!asks("Is it ok? Yes.\n\nShipped."), "only the last line counts");
        assert_eq!(excerpt("First part.\n\n## Summary\n- **Fixed** the `parser`"), "Summary Fixed the parser");
        assert!(excerpt(&"x".repeat(500)).chars().count() <= 160);
    }

    #[test]
    fn the_mesh_gets_only_this_pcs_own_notes() {
        let n = Notes::default();
        let start = n.last();
        n.push(note("done", "chat:1", "a"));
        n.push(note("pc", "pc:x", "x went offline"));
        n.relay("desk", vec![note("done", "chat:2", "b")]);
        let (own, _) = n.own_since(start);
        assert_eq!(own.iter().map(|x| x.key.as_str()).collect::<Vec<_>>(), ["chat:1"]);
        assert_eq!(n.since(start).0.len(), 3, "phones get them all");
        assert_eq!(n.since(start).0[2].from, "desk");
    }

    #[test]
    fn prefs_and_quiet_hours() {
        let mut p = Prefs::default();
        assert!(p.on("done") && p.on("input") && !p.on("agent"), "sub-agents off unless asked");
        assert!(!p.quiet_at(23 * 60), "quiet hours off by default");
        p.quiet = true;
        assert!(p.quiet_at(23 * 60) && p.quiet_at(3 * 60) && !p.quiet_at(12 * 60), "22:00–07:00 wraps midnight");
        p.quiet_from = "13:00".into();
        p.quiet_to = "14:30".into();
        assert!(p.quiet_at(13 * 60 + 10) && !p.quiet_at(14 * 60 + 30));
        assert_eq!(hm("7:05"), Some(425));
        assert_eq!(hm("25:00"), None);
    }
}
