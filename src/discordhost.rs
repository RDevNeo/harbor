//! The Discord app's one background process (`harbor app discord-host`): it owns the engine that
//! runs Discord's page, decides when that runs, and is what `harbor app discord`, the Settings
//! card and the hub talk to, over a Unix socket in Harbor's private store. It stops itself a few
//! minutes after the engine stopped; the next user starts it again.
//!
//! Everything about Electron is behind [`Engine`]; the tools are the page's (discord/page), so
//! nothing here depends on either. When the engine runs is [`Policy`]: it starts on the first tool
//! call, freezes after a short idle, and thaws on the next call, as a laptop sleeps and wakes.
//! A thawed client reconnects by itself; a long freeze can cost a full login, and logging in often
//! is something Discord's spam filter looks at, so past a daily count it stops freezing.
//! Without swap a frozen client keeps most of its memory, so there idle means quitting, after a
//! longer wait because every start is a full login.
//!
//! At every page load the self-test checks what the tools need from Discord. A failure after a
//! Vencord update goes back to the last version that passed; if it still fails, Discord itself
//! changed and repair starts (discordrepair.rs).

use crate::discordfreeze::Held;
use crate::discordsetup as setup;
use crate::mcp::write_private;
use crate::store;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// A page load until the tools answer.
const START_WAIT: Duration = Duration::from_secs(120);
/// With the engine stopped this long and nobody asking, the host goes too.
const LINGER: i64 = 300;
/// The tool calls' limit, unless the call says otherwise.
const CALL_WAIT: Duration = Duration::from_secs(120);
/// A thaw until the page answers at all; the first after a full reclaim was seen taking 4 s.
const THAW_WAIT: Duration = Duration::from_secs(20);
/// What a screenshot gives a reconnect: the page's own limit, and a bit.
const LIVE_WAIT: Duration = Duration::from_secs(25);
/// From the page answering until it knows who's signed in.
const SESSION_WAIT: Duration = Duration::from_secs(45);
/// Sign-in gives up after this long.
const SIGNIN_WAIT: Duration = Duration::from_secs(15 * 60);

// ------------------------------------------------------------------ the engine

/// How the page runs. `Scratch` is repair's throwaway logged-out page.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Run,
    Signin,
    Scratch,
}

/// Runs Discord's page. A reboot or a crash just means [`Engine::start`] again: a client that's
/// gone can't be told from one that never ran.
pub trait Engine: Send + Sync {
    fn start(&self, mode: Mode, display: &Display) -> Result<(), String>;
    /// The page answers: the tools can be called.
    fn ready(&self) -> bool;
    /// It's there at all, frozen or not.
    fn alive(&self) -> bool;
    /// Quits cleanly (the session is on disk) and returns when it's gone.
    fn stop(&self);
    /// One request to the page; its answer.
    fn ask(&self, op: Value, wait: Duration) -> Result<Value, String>;
    /// Holds it still; says how ("cgroup" or "signals"). Nothing it does can run until [`Self::resume`].
    fn suspend(&self) -> Result<&'static str, String>;
    fn resume(&self);
    /// Gives up a suspended client's memory, until `stop`.
    fn reclaim(&self, stop: &AtomicBool);
}

/// The desktop a sign-in window would open on; empty: there is none.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Display {
    #[serde(default)]
    pub wayland: String,
    #[serde(default)]
    pub x11: String,
    #[serde(default)]
    pub runtime: String,
}

impl Display {
    pub fn here() -> Display {
        let v = |k: &str| std::env::var(k).unwrap_or_default();
        Display { wayland: v("WAYLAND_DISPLAY"), x11: v("DISPLAY"), runtime: v("XDG_RUNTIME_DIR") }
    }

    fn any(&self) -> bool {
        !self.wayland.is_empty() || !self.x11.is_empty()
    }
}

type Waiters = Arc<Mutex<HashMap<u64, Sender<Value>>>>;

/// Electron, driven over its stdin and stdout (JSON lines): when Harbor goes, stdin closes and the
/// shell quits, so it can't be orphaned. Its environment is built from nothing: the host may
/// have been started from an agent's, and the page gets none of that.
struct Electron {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    waiters: Waiters,
    ready: Arc<AtomicBool>,
    events: Sender<(Mode, Value)>,
    data: PathBuf,
    next: AtomicU64,
    /// Which start this is: what's left of an earlier one can't touch the current one's state.
    run: Arc<AtomicU64>,
    held: Mutex<Option<Arc<Held>>>,
}

impl Electron {
    fn new(data: PathBuf, events: Sender<(Mode, Value)>) -> Electron {
        Electron { child: Mutex::new(None), stdin: Mutex::new(None), waiters: Default::default(), ready: Default::default(), events, data, next: AtomicU64::new(1), run: Default::default(), held: Mutex::new(None) }
    }
}

impl Engine for Electron {
    fn start(&self, mode: Mode, display: &Display) -> Result<(), String> {
        self.stop();
        let v = setup::Vencords::load();
        let page = setup::write_live_script()?;
        let cfg = json!({
            "mode": match mode { Mode::Run => "run", Mode::Signin => "signin", Mode::Scratch => "scratch" },
            "data": self.data,
            "page": page,
            "vencord": setup::vencord_dir(&v.current),
            // A rig's fake Discord; the shell's default is the real one.
            "url": std::env::var(if mode == Mode::Scratch { "HARBOR_DISCORD_SCRATCH_URL" } else { "HARBOR_DISCORD_URL" }).ok(),
        });
        // The running page gets a cgroup of its own, for freezing it. Without one it runs all the same.
        let mut cmd = match in_scope(mode) {
            Some(unit) => {
                let mut c = Command::new("systemd-run");
                c.args(["--user", "--scope", "--quiet", "--collect", "-p", "Delegate=yes", &format!("--unit={unit}"), "--"]).arg(setup::electron_bin());
                c
            }
            None => Command::new(setup::electron_bin()),
        };
        cmd.arg(setup::shell_dir()).env_clear().env("XDG_RUNTIME_DIR", runtime_dir());
        for k in ["HOME", "PATH", "LANG", "TZ"] {
            if let Ok(v) = std::env::var(k) {
                cmd.env(k, v);
            }
        }
        // Chromium only moves to a second cgroup of its own with a session bus: a rig's way to get one.
        if let Ok(v) = std::env::var("HARBOR_DISCORD_DBUS") {
            cmd.env("DBUS_SESSION_BUS_ADDRESS", v);
        }
        cmd.env("HARBOR_DISCORD", cfg.to_string());
        // A window can only open on a real desktop, and only sign-in has one. The rest has no
        // tie to a compositor, so it survives one restarting and needs no session at all.
        if mode == Mode::Signin && display.any() {
            if !display.runtime.is_empty() {
                cmd.env("XDG_RUNTIME_DIR", &display.runtime);
            }
            if !display.wayland.is_empty() {
                cmd.env("WAYLAND_DISPLAY", &display.wayland).arg("--ozone-platform=wayland");
            } else {
                cmd.env("DISPLAY", &display.x11).arg("--ozone-platform=x11");
            }
        } else {
            cmd.args(["--ozone-platform=headless", "--ozone-override-screen-size=1280,720"]);
        }
        let log = std::fs::File::create(setup::root().join(if mode == Mode::Scratch { "scratch.log" } else { "shell.log" })).map_err(|e| e.to_string())?;
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log).process_group(0);
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't start Electron: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let out = child.stdout.take().ok_or("no stdout")?;
        if mode == Mode::Run {
            let _ = write_private(&left_over_path(), &child.id().to_string());
        }
        *self.stdin.lock().unwrap() = Some(stdin);
        *self.child.lock().unwrap() = Some(child);
        self.ready.store(false, Ordering::SeqCst);
        let (waiters, ready, events, run) = (self.waiters.clone(), self.ready.clone(), self.events.clone(), self.run.clone());
        let this = run.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
                if run.load(Ordering::SeqCst) != this {
                    return;
                }
                if let Some(id) = m["id"].as_u64() {
                    if let Some(tx) = waiters.lock().unwrap().remove(&id) {
                        let _ = tx.send(m);
                    }
                } else {
                    if m["ev"] == "ready" {
                        ready.store(true, Ordering::SeqCst);
                    }
                    let _ = events.send((mode, m));
                }
            }
            if run.load(Ordering::SeqCst) == this {
                ready.store(false, Ordering::SeqCst);
                waiters.lock().unwrap().clear();
                let _ = events.send((mode, json!({ "ev": "gone" })));
            }
        });
        Ok(())
    }

    fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    fn alive(&self) -> bool {
        self.child.lock().unwrap().as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)))
    }

    fn stop(&self) {
        self.resume();
        let Some(mut c) = self.child.lock().unwrap().take() else { return };
        let _ = std::fs::remove_file(left_over_path());
        if matches!(c.try_wait(), Ok(None)) {
            let _ = self.ask(json!({ "op": "quit" }), Duration::from_secs(5));
        }
        *self.stdin.lock().unwrap() = None;
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until && !matches!(c.try_wait(), Ok(Some(_))) {
            std::thread::sleep(Duration::from_millis(50));
        }
        // The shell leads its own process group (`process_group(0)` above); whatever it left goes.
        if let Some(pid) = rustix::process::Pid::from_raw(c.id() as i32) {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
        let _ = c.wait();
    }

    fn ask(&self, mut op: Value, wait: Duration) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        op["id"] = json!(id);
        let (tx, rx) = channel();
        self.waiters.lock().unwrap().insert(id, tx);
        let sent = match self.stdin.lock().unwrap().as_mut() {
            Some(s) => writeln!(s, "{op}").is_ok(),
            None => false,
        };
        if !sent {
            self.waiters.lock().unwrap().remove(&id);
            return Err("Discord isn't running.".into());
        }
        match rx.recv_timeout(wait) {
            Ok(m) if m["ok"] == true => Ok(m["result"].clone()),
            Ok(m) => Err(m["error"].as_str().unwrap_or("Discord refused that.").to_string()),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                self.waiters.lock().unwrap().remove(&id);
                Err("Discord didn't answer in time.".into())
            }
            Err(_) => Err("Discord stopped.".into()),
        }
    }

    fn suspend(&self) -> Result<&'static str, String> {
        let leader = self.child.lock().unwrap().as_ref().map(|c| c.id() as i32).ok_or("Discord isn't running.")?;
        let h = Arc::new(crate::discordfreeze::freeze(leader)?);
        let word = h.word();
        *self.held.lock().unwrap() = Some(h);
        Ok(word)
    }

    fn resume(&self) {
        if let Some(h) = self.held.lock().unwrap().take() {
            crate::discordfreeze::thaw(&h);
        }
    }

    fn reclaim(&self, stop: &AtomicBool) {
        let h = self.held.lock().unwrap().clone();
        if let Some(h) = h {
            crate::discordfreeze::reclaim(&h, stop);
        }
    }
}

/// The scope a running page starts in, where systemd can make one.
fn in_scope(mode: Mode) -> Option<String> {
    if mode != Mode::Run || std::env::var_os("HARBOR_DISCORD_NO_CGROUP").is_some() {
        return None;
    }
    let ok = Command::new("systemd-run")
        .args(["--user", "--scope", "--quiet", "--collect", "true"])
        .env("XDG_RUNTIME_DIR", runtime_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    ok.is_ok_and(|s| s.success()).then(|| format!("harbor-discord-{}-{}", std::process::id(), store::now()))
}

/// Where systemd --user listens; the host may have been started without it in its environment.
fn runtime_dir() -> String {
    std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| format!("/run/user/{}", rustix::process::getuid().as_raw()))
}

/// The shell's pid while it runs: a host that died can't leave a frozen client behind for good.
fn left_over_path() -> PathBuf {
    setup::root().join("engine.pid")
}

// ------------------------------------------------------------------ when it runs

/// Full gateway logins (IDENTIFY) a day before freezing stops, and the client just stays running.
/// A judgement call: nobody has published a safe rate. A person's client does a few of these a day;
/// a thaw inside Discord's resume window doesn't count, one past it does.
pub const MAX_LOGINS: usize = 20;
/// Idle this long, so a burst of tool calls doesn't freeze and thaw between calls.
const FREEZE_AFTER: i64 = 120;

/// Without swap: frozen RAM stays around 320 MB, so an idle client quits. Each start is a login,
/// hence the longer wait and the lower limit.
const QUIT_AFTER: i64 = 30 * 60;
const MAX_QUIT_LOGINS: usize = 8;

/// What an idle client does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rest {
    Freeze,
    Quit,
}

/// When the engine rests.
#[derive(Clone, Copy)]
pub struct Policy {
    pub idle: i64,
    pub max_logins: usize,
    pub quit_idle: i64,
    pub max_quit_logins: usize,
}

const DAY: i64 = 24 * 3600;

impl Default for Policy {
    fn default() -> Self {
        // A rig's shorter waits and limits.
        let n = |k: &str, or: i64| std::env::var(k).ok().and_then(|s| s.parse().ok()).unwrap_or(or);
        Policy {
            idle: n("HARBOR_DISCORD_IDLE", FREEZE_AFTER),
            max_logins: n("HARBOR_DISCORD_MAX_LOGINS", MAX_LOGINS as i64) as usize,
            quit_idle: n("HARBOR_DISCORD_QUIT_IDLE", QUIT_AFTER),
            max_quit_logins: n("HARBOR_DISCORD_MAX_QUIT_LOGINS", MAX_QUIT_LOGINS as i64) as usize,
        }
    }
}

impl Policy {
    /// What a running engine should do now, if anything. `busy`: tool calls in flight, a
    /// waitForMessage among them. `logins`: when it last logged in; past the day's limit it stays
    /// running. `swap`: whether this PC has any (zram counts).
    pub fn rest(&self, now: i64, last_use: i64, busy: u32, logins: &[i64], swap: bool) -> Option<Rest> {
        let (idle, limit, rest) = if swap { (self.idle, self.max_logins, Rest::Freeze) } else { (self.quit_idle, self.max_quit_logins, Rest::Quit) };
        (busy == 0 && now - last_use >= idle && logins.iter().filter(|t| now - **t < DAY).count() < limit).then_some(rest)
    }
}

/// Whether /proc/meminfo's text shows any swap: a disk's, or zram.
fn swap_in(meminfo: &str) -> bool {
    meminfo.lines().find_map(|l| l.strip_prefix("SwapTotal:")).and_then(|v| v.split_whitespace().next()?.parse::<u64>().ok()).is_some_and(|kb| kb > 0)
}

/// Asked each time, as swap can come and go. A rig stands in for a PC without it.
fn has_swap() -> bool {
    std::env::var_os("HARBOR_DISCORD_NO_SWAP").is_none() && std::fs::read_to_string("/proc/meminfo").is_ok_and(|m| swap_in(&m))
}

// ------------------------------------------------------------------ pacing

/// What Discord's spam filter watches: joining and leaving servers, new DMs, bursts of uploads,
/// floods of messages. Each limit is a count in a window and a gap between two.
struct Limit {
    kind: &'static str,
    label: &'static str,
    gap: i64,
    hour: usize,
    day: usize,
}

const LIMITS: &[Limit] = &[
    Limit { kind: "join", label: "server joins", gap: 300, hour: 3, day: 6 },
    Limit { kind: "leave", label: "server leaves", gap: 300, hour: 3, day: 6 },
    Limit { kind: "dm", label: "new DMs", gap: 120, hour: 4, day: 10 },
    Limit { kind: "upload", label: "file uploads", gap: 20, hour: 15, day: 60 },
    Limit { kind: "send", label: "messages", gap: 1, hour: 120, day: 600 },
    Limit { kind: "react", label: "reactions", gap: 1, hour: 120, day: 600 },
];

/// Waits this short just happen; longer ones are the agent's to hear about.
const WAIT_UP_TO: i64 = 5;

#[derive(Debug, PartialEq)]
pub enum Pace {
    Go,
    Wait(i64),
    Refuse(String),
}

/// What's allowed now for `kind`, given when it last happened (`log`: unix seconds, any order).
fn pace(kind: &str, log: &[(String, i64)], now: i64) -> Pace {
    let Some(l) = LIMITS.iter().find(|l| l.kind == kind) else { return Pace::Go };
    let mut times: Vec<i64> = log.iter().filter(|(k, _)| k == kind).map(|(_, t)| *t).filter(|t| now - t < DAY).collect();
    times.sort();
    let hour = times.iter().filter(|t| now - **t < 3600).count();
    let refuse = |n: usize, what: &str, secs: i64| {
        Pace::Refuse(format!(
            "Paced: {n} {} in the last {what} is Harbor's limit, because Discord's spam filter watches these. The next one can go in about {} min. Tell the user instead of retrying.",
            l.label,
            (secs + 59) / 60
        ))
    };
    if times.len() >= l.day {
        return refuse(times.len(), "day", times[times.len() - l.day] + DAY - now);
    }
    if hour >= l.hour {
        return refuse(hour, "hour", times[times.len() - l.hour] + 3600 - now);
    }
    match times.last().map(|t| t + l.gap - now).filter(|left| *left > 0) {
        None => Pace::Go,
        Some(left) if left <= WAIT_UP_TO => Pace::Wait(left),
        Some(left) => Pace::Refuse(format!(
            "Paced: Harbor spaces out {} because Discord's spam filter watches them. The next one can go in about {}. Tell the user instead of retrying.",
            l.label,
            if left < 60 { format!("{left} s") } else { format!("{} min", (left + 59) / 60) }
        )),
    }
}

/// What a tool call counts as, before it's made.
fn pace_kind(name: &str, args: &Value) -> Option<&'static str> {
    let apply = args["apply"] == true;
    match name {
        "discord_join" if apply => Some("join"),
        "discord_leave" if apply => Some("leave"),
        "discord_send" if args["files"].as_array().is_some_and(|f| !f.is_empty()) => Some("upload"),
        "discord_send" => Some("send"),
        "discord_react" => Some("react"),
        _ => None,
    }
}

fn pace_path() -> PathBuf {
    setup::root().join("pace.json")
}

fn pace_log() -> Vec<(String, i64)> {
    std::fs::read_to_string(pace_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn pace_note(kind: &str) {
    let now = store::now();
    let mut log = pace_log();
    log.retain(|(_, t)| now - t < DAY);
    log.push((kind.into(), now));
    let _ = write_private(&pace_path(), &serde_json::to_string(&log).unwrap_or_default());
}

// ------------------------------------------------------------------ the host's state

#[derive(Clone, Copy, PartialEq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Stopped,
    Setup,
    Starting,
    Ready,
    /// Going into a freeze, or coming out: calls wait for what's next.
    Moving,
    Frozen,
    Signin,
}

/// How a sign-in is going, for the card and the hub.
#[derive(Clone, Default, Serialize)]
struct Signin {
    active: bool,
    /// What to draw as a QR code; none yet, or the window took over.
    qr: Option<String>,
    scanned: bool,
    captcha: bool,
    /// The real window is open: password, 2FA and captcha happen there.
    window: bool,
    /// What's happening, in words.
    note: String,
    error: Option<String>,
}

/// What survives the host (`state.json`).
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Saved {
    /// Recent full logins (unix seconds).
    #[serde(default)]
    logins: Vec<i64>,
    /// When the engine last stopped: a wait after that catches up on what it missed.
    #[serde(default)]
    stopped: i64,
    /// Shown until tools work again.
    #[serde(default)]
    pub attention: String,
    /// Repair attempts per failure ("build:missing,missing").
    #[serde(default)]
    pub attempts: HashMap<String, u32>,
    /// What the last self-test said was missing.
    #[serde(default)]
    pub failing: Vec<String>,
    #[serde(default)]
    pub tested: i64,
    /// Discord's build at the last test.
    #[serde(default)]
    pub build: String,
}

fn saved_path() -> PathBuf {
    setup::root().join("state.json")
}

pub fn load_saved() -> Saved {
    std::fs::read_to_string(saved_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

struct St {
    phase: Phase,
    /// Setup's progress.
    setup: String,
    error: Option<String>,
    signin: Signin,
    last_use: i64,
    busy: u32,
    /// Tools the last self-test says can't work, with what's missing.
    broken: HashMap<String, Vec<String>>,
    saved: Saved,
    /// A wait may use this once: the engine wasn't running from then until it came back.
    catch_up: Option<i64>,
    /// How the client is frozen, and since when.
    held: &'static str,
    frozen_at: i64,
    /// Tells reclaim a call wants the client back.
    reclaiming: Arc<AtomicBool>,
    /// CONNECTION_OPENs this page has counted so far.
    opens: u64,
    /// A newer Vencord is here: the next idle restarts instead of freezing.
    restart: bool,
    /// The chat view's internals have been judged in this page.
    chat_tested: bool,
    repairing: bool,
    signin_at: i64,
    /// The desktop the sign-in started from.
    display: Display,
}

pub struct Host {
    st: Mutex<St>,
    moved: Condvar,
    engine: Box<dyn Engine>,
    /// Repair's logged-out page, while it runs.
    scratch: Box<dyn Engine>,
    policy: Policy,
    /// When someone last wanted something (a status check doesn't count).
    touched: AtomicU64,
}

/// What the page's self-test said.
pub struct Test {
    pub missing: Vec<String>,
    pub tools: HashMap<String, Vec<String>>,
    pub build: String,
    /// Names and statuses, safe to show repair: nothing else of the page's comes through.
    pub report: Value,
}

/// What to do about a self-test's result.
enum Next {
    Run,
    Restart,
}

/// The signed-in account (`account.json`): its name for the card. The session itself is in the
/// profile, so this holds no secret.
#[derive(Serialize, Deserialize, Clone)]
pub struct Account {
    pub id: String,
    pub username: String,
    pub name: String,
    #[serde(default)]
    pub at: i64,
}

fn account_path() -> PathBuf {
    setup::root().join("account.json")
}

pub fn account() -> Option<Account> {
    serde_json::from_str(&std::fs::read_to_string(account_path()).ok()?).ok()
}

/// A note for Harbor's notifications: the running app picks these up (discord.rs `watch`).
pub fn notice(title: &str, body: &str) {
    let line = json!({ "title": title, "body": body, "at": store::now() }).to_string();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(setup::root().join("notices.jsonl")) {
        let _ = writeln!(f, "{line}");
    }
}

impl Host {
    fn set(&self, f: impl FnOnce(&mut St)) {
        f(&mut self.st.lock().unwrap());
        self.moved.notify_all();
    }

    fn get<T>(&self, f: impl FnOnce(&St) -> T) -> T {
        f(&self.st.lock().unwrap())
    }

    fn save(&self) {
        let s = self.get(|st| st.saved.clone());
        let _ = write_private(&saved_path(), &serde_json::to_string_pretty(&s).unwrap_or_default());
    }

    pub fn set_attention(&self, text: &str) {
        self.set(|st| st.saved.attention = text.into());
        self.save();
    }

    pub fn saved(&self) -> Saved {
        self.get(|st| st.saved.clone())
    }

    pub fn note_attempt(&self, sig: &str) -> u32 {
        let n = self.get(|st| st.saved.attempts.get(sig).copied().unwrap_or(0)) + 1;
        self.set(|st| {
            st.saved.attempts.insert(sig.into(), n);
        });
        self.save();
        n
    }

    pub fn repairing(&self, on: bool) {
        self.set(|st| st.repairing = on);
    }

    pub fn saved_repairing(&self) -> bool {
        self.get(|st| st.repairing)
    }

    /// A passing self-test after repair: the failure is over.
    pub fn judge_after_repair(self: &Arc<Self>, t: Test) {
        self.judge(t);
    }

    pub fn scratch_ask(&self, op: Value) -> Result<Value, String> {
        self.scratch.ask(op, Duration::from_secs(45))
    }

    // -------------------------------------------------------------- lifecycle

    /// The page is up and answering: started if it wasn't, thawed if it's frozen.
    fn ensure(self: &Arc<Self>) -> Result<(), String> {
        let mut st = self.st.lock().unwrap();
        loop {
            match st.phase {
                Phase::Ready => return Ok(()),
                Phase::Signin | Phase::Setup => return Err("Discord is signing in on this PC. Try again when that's done.".into()),
                Phase::Starting | Phase::Moving => {
                    let (s, wait) = self.moved.wait_timeout(st, START_WAIT).unwrap();
                    st = s;
                    if wait.timed_out() {
                        return Err("Discord is taking too long to start.".into());
                    }
                }
                Phase::Frozen => {
                    st.phase = Phase::Moving;
                    st.reclaiming.store(true, Ordering::Relaxed);
                    drop(st);
                    return self.thaw();
                }
                Phase::Stopped => {
                    if account().is_none() {
                        return Err("Discord isn't signed in here: sign in under Settings › Integrations › Apps.".into());
                    }
                    st.phase = Phase::Starting;
                    st.error = None;
                    drop(st);
                    return self.cold_start();
                }
            }
        }
    }

    /// From nothing: a first call, a reboot, a crash, a thaw that didn't come back.
    fn cold_start(self: &Arc<Self>) -> Result<(), String> {
        let r = self.boot();
        self.set(|st| {
            st.phase = if r.is_ok() { Phase::Ready } else { Phase::Stopped };
            st.error = r.as_ref().err().cloned();
        });
        r
    }

    /// Wakes the client as Discord wakes after a laptop sleeps: the page checks its connection and
    /// reconnects, and live tools wait for that in the page. One that doesn't answer starts over.
    fn thaw(self: &Arc<Self>) -> Result<(), String> {
        self.engine.resume();
        let state = self.engine.ask(json!({ "op": "thawed" }), THAW_WAIT);
        self.set(|st| st.held = "");
        match state {
            Ok(s) if s["path"].as_str().is_some_and(|p| p.starts_with("/login")) => {
                self.session_ended();
                self.set(|st| st.phase = Phase::Stopped);
                Err("Discord ended this session: sign in again under Settings › Integrations › Apps.".into())
            }
            Ok(_) => {
                self.set(|st| {
                    st.phase = Phase::Ready;
                    st.last_use = store::now();
                });
                Ok(())
            }
            Err(_) => {
                self.engine.stop();
                self.set(|st| st.phase = Phase::Starting);
                self.cold_start()
            }
        }
    }

    /// Holds the idle client still and gives up its memory. Saved first: a frozen client can be
    /// lost with the PC, and it mustn't take the newest of the profile with it.
    fn freeze(self: &Arc<Self>) {
        {
            let mut st = self.st.lock().unwrap();
            if st.phase != Phase::Ready || st.busy > 0 {
                return;
            }
            st.phase = Phase::Moving;
        }
        let _ = self.engine.ask(json!({ "op": "flush" }), Duration::from_secs(5));
        let done = self.engine.suspend();
        let stop = Arc::new(AtomicBool::new(false));
        let now = store::now();
        self.set(|st| match done {
            Ok(how) => {
                st.phase = Phase::Frozen;
                st.held = how;
                st.frozen_at = now;
                st.catch_up.get_or_insert(now);
                st.reclaiming = stop.clone();
            }
            // Not this time: it stays running, and idle asks again.
            Err(_) => {
                st.phase = Phase::Ready;
                st.last_use = now;
            }
        });
        if self.get(|st| st.phase == Phase::Frozen) {
            let me = self.clone();
            std::thread::spawn(move || me.engine.reclaim(&stop));
        }
    }

    /// Adds the logins the page has seen since the last look.
    fn count_logins(&self) {
        let Ok(g) = self.engine.ask(json!({ "op": "gateway" }), Duration::from_secs(5)) else { return };
        let page = g["opens"].as_u64().unwrap_or(0);
        let now = store::now();
        self.set(|st| {
            let seen = if page < st.opens { 0 } else { st.opens };
            st.saved.logins.retain(|t| now - t < DAY);
            st.saved.logins.extend((seen..page).map(|_| now));
            st.opens = page;
        });
        self.save();
    }

    /// Starts the engine and judges what came up. A failed self-test can restart it on another
    /// Vencord, at most twice.
    fn boot(self: &Arc<Self>) -> Result<(), String> {
        let say = |s: String| self.set(|st| st.setup = s);
        setup::ensure_electron(&say)?;
        setup::ensure_shell(&say)?;
        setup::ensure_vencord(&say)?;
        setup::check_vencord(false);
        self.set(|st| st.restart = false);
        for _ in 0..3 {
            self.start_page()?;
            let test = self.selftest()?;
            match self.judge(test) {
                Next::Run => return Ok(()),
                Next::Restart => self.engine.stop(),
            }
        }
        Err("Discord tools need attention".into())
    }

    fn start_page(self: &Arc<Self>) -> Result<(), String> {
        self.set(|st| {
            st.broken.clear();
            st.chat_tested = false;
            st.catch_up = Some(st.saved.stopped).filter(|t| *t > 0);
            st.opens = 0;
            st.last_use = store::now();
        });
        self.engine.start(Mode::Run, &Display::default())?;
        let until = Instant::now() + START_WAIT;
        while !self.engine.ready() {
            if Instant::now() > until {
                self.engine.stop();
                return Err("Discord's page didn't come up.".into());
            }
            if self.get(|st| st.error.is_some()) {
                self.engine.stop();
                return Err(self.get(|st| st.error.clone()).unwrap_or_default());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // The page knows the user once the gateway says who it is; a dead session falls back to
        // the login page. Neither in time: it's the connection, and the session may be fine.
        let until = Instant::now() + SESSION_WAIT;
        while Instant::now() < until {
            let state = self.engine.ask(json!({ "op": "state" }), Duration::from_secs(10))?;
            if !state["user"].is_null() {
                // A page that came up signed in logged in, seen or not.
                let now = store::now();
                self.set(|st| {
                    st.saved.logins.retain(|t| now - t < DAY);
                    st.saved.logins.push(now);
                    st.opens = 1;
                });
                self.save();
                return Ok(());
            }
            if state["path"].as_str().is_some_and(|p| p.starts_with("/login")) {
                self.session_ended();
                return Err("Discord ended this session: sign in again under Settings › Integrations › Apps.".into());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        self.engine.stop();
        Err("Discord didn't connect. Check this PC's connection and try again.".into())
    }

    /// Discord logged this session out. The tools go; the card offers sign-in again.
    fn session_ended(self: &Arc<Self>) {
        let _ = std::fs::remove_file(account_path());
        self.set_attention("Discord signed this session out. Sign in again to use it.");
        notice("Discord signed out", "Discord ended Harbor's session. Sign in again under Settings › Integrations › Apps.");
        let me = self.clone();
        std::thread::spawn(move || me.stop_page());
    }

    pub fn stop_page(&self) {
        // Calls wait for what comes next instead of finding it half gone.
        self.set(|st| st.phase = Phase::Moving);
        self.engine.stop();
        self.set(|st| {
            st.phase = Phase::Stopped;
            st.saved.stopped = store::now();
        });
        self.save();
    }

    /// The page's self-test, reduced to names and statuses.
    pub fn selftest(&self) -> Result<Test, String> {
        let r = self.engine.ask(json!({ "op": "selftest" }), Duration::from_secs(30))?;
        Ok(read_test(&r, &setup::base_script().unwrap_or_default()))
    }

    /// Passed: this Vencord is good, and whatever was wrong is over. Failed: back to the last good
    /// Vencord; a newer one, in case that's Vencord's fix; else repair.
    fn judge(self: &Arc<Self>, t: Test) -> Next {
        let failed = !t.missing.is_empty();
        self.set(|st| {
            st.broken = t.tools.clone();
            st.saved.failing = t.missing.clone();
            st.saved.tested = store::now();
            st.saved.build = t.build.clone();
        });
        if !failed {
            let mut v = setup::Vencords::load();
            v.passed();
            v.save();
            self.set(|st| {
                st.saved.attention.clear();
                st.saved.attempts.clear();
            });
            self.save();
            return Next::Run;
        }
        let mut v = setup::Vencords::load();
        if v.rollback() {
            v.save();
            return Next::Restart;
        }
        if setup::check_vencord(true) {
            return Next::Restart;
        }
        self.save();
        crate::discordrepair::start(self.clone(), t);
        Next::Run
    }

    /// The chat view's internals exist once a channel has been open: judged then, once a page.
    fn test_chat_view(self: &Arc<Self>) {
        if std::mem::replace(&mut self.st.lock().unwrap().chat_tested, true) {
            return;
        }
        let me = self.clone();
        self.set(|st| st.busy += 1);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            let t = me.selftest();
            me.set(|st| st.busy -= 1);
            if let Ok(t) = t {
                me.judge_running(t);
            }
        });
    }

    /// [`Self::judge`] for a page already in use: a restart goes through Starting.
    fn judge_running(self: &Arc<Self>, t: Test) {
        if let Next::Restart = self.judge(t) {
            self.engine.stop();
            self.set(|st| st.phase = Phase::Stopped);
            let _ = self.ensure();
        }
    }

    /// Puts the tool script back in the page after repair changed it.
    pub fn reinject(&self) -> Result<(), String> {
        setup::write_live_script()?;
        self.engine.ask(json!({ "op": "inject" }), Duration::from_secs(20)).map(|_| ())
    }

    pub fn scratch_start(&self) -> Result<(), String> {
        self.scratch.start(Mode::Scratch, &Display::default())?;
        let until = Instant::now() + START_WAIT;
        while !self.scratch.ready() {
            if Instant::now() > until {
                self.scratch.stop();
                return Err("The scratch page didn't come up.".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    pub fn scratch_stop(&self) {
        self.scratch.stop();
        let _ = std::fs::remove_dir_all(setup::root().join("scratch"));
    }

    /// The client is up and counts as in use until [`Self::leave`]: it can't freeze in between.
    fn enter(self: &Arc<Self>) -> Result<(), String> {
        loop {
            self.ensure()?;
            let mut st = self.st.lock().unwrap();
            if st.phase == Phase::Ready {
                st.busy += 1;
                st.last_use = store::now();
                return Ok(());
            }
        }
    }

    fn leave(&self) {
        self.set(|st| {
            st.busy -= 1;
            st.last_use = store::now();
        });
    }

    /// A request about the page itself. Anything shown of it comes after the reconnect, like the
    /// tools that read it.
    fn page_op(self: &Arc<Self>, req: &Value) -> Result<Value, String> {
        self.enter()?;
        let r = self.engine.ask(json!({ "op": "settled" }), LIVE_WAIT).and_then(|_| self.engine.ask(req.clone(), Duration::from_secs(30)));
        self.leave();
        r
    }

    /// Reads a tool's arguments and runs it.
    fn call(self: &Arc<Self>, name: &str, mut args: Value) -> Result<Value, String> {
        self.enter()?;
        let r = self.run_tool(name, &mut args);
        self.leave();
        let v = r?;
        match name {
            "discord_join" if v["joined"] == true => pace_note("join"),
            "discord_leave" if v["left"] == true => pace_note("leave"),
            "discord_dm_open" if v["created"] == true => pace_note("dm"),
            "discord_send" | "discord_react" if v["paced"] != true => {
                if let Some(k) = pace_kind(name, &args) {
                    pace_note(k);
                }
            }
            _ => {}
        }
        if v["paced"] == true && name == "discord_dm_open" {
            if let Pace::Refuse(why) = pace("dm", &pace_log(), store::now()) {
                return Ok(json!({ "paced": true, "note": why }));
            }
        }
        if matches!(name, "discord_open" | "discord_view" | "discord_dm_open" | "discord_send") {
            self.test_chat_view();
        }
        Ok(v)
    }

    fn run_tool(self: &Arc<Self>, name: &str, args: &mut Value) -> Result<Value, String> {
        if let Some(missing) = self.get(|st| st.broken.get(name).cloned()) {
            let doing = if self.get(|st| st.repairing) { "Harbor is repairing it; try again in a few minutes." } else { "Discord tools need attention." };
            return Err(format!("This tool can't work right now: Discord changed {}. {doing}", missing.join(", ")));
        }
        // New DMs are only known in the page: it refuses one when the pace says so.
        if name == "discord_dm_open" {
            args["_allowNew"] = json!(pace("dm", &pace_log(), store::now()) == Pace::Go);
        }
        if let Some(k) = pace_kind(name, args) {
            match pace(k, &pace_log(), store::now()) {
                Pace::Go => {}
                Pace::Wait(s) => std::thread::sleep(Duration::from_secs(s as u64)),
                Pace::Refuse(why) => return Ok(json!({ "paced": true, "note": why })),
            }
        }
        if name == "discord_waitForMessage" {
            if let Some(t) = self.st.lock().unwrap().catch_up.take() {
                args["_since"] = json!(t * 1000);
            }
        }
        let wait = call_wait(name, args);
        let r = self.engine.ask(json!({ "op": "call", "name": name, "args": args }), wait)?;
        Ok(serde_json::from_str(r.as_str().unwrap_or("null")).unwrap_or(Value::Null))
    }

    // -------------------------------------------------------------- sign-in

    fn signin(self: &Arc<Self>, display: Display) -> Result<(), String> {
        {
            let mut st = self.st.lock().unwrap();
            if matches!(st.phase, Phase::Signin | Phase::Setup | Phase::Starting) {
                return Err("Discord is busy; try again in a moment.".into());
            }
            st.phase = Phase::Setup;
            st.signin = Signin { active: true, note: "Getting Discord ready…".into(), ..Default::default() };
            st.error = None;
        }
        self.moved.notify_all();
        let me = self.clone();
        std::thread::spawn(move || {
            me.engine.stop();
            let say = |s: String| me.set(|st| st.signin.note = s);
            let r = setup::ensure_electron(&say).and_then(|_| setup::ensure_shell(&say)).and_then(|_| setup::ensure_vencord(&say).map(|_| ()));
            let r = r.and_then(|_| me.engine.start(Mode::Signin, &display));
            me.set(|st| match r {
                Ok(()) => {
                    st.phase = Phase::Signin;
                    st.signin.note = "Loading sign-in…".into();
                    st.signin_at = store::now();
                    st.display = display.clone();
                }
                Err(e) => {
                    st.phase = Phase::Stopped;
                    st.signin.active = false;
                    st.signin.error = Some(e);
                }
            });
        });
        Ok(())
    }

    /// The real window: password, 2FA, captcha.
    fn window(&self) -> Result<(), String> {
        if self.get(|st| st.phase != Phase::Signin) {
            return Err("No sign-in is going on.".into());
        }
        if !self.get(|st| st.display.any()) {
            return Err("This PC has no desktop to open the sign-in window on: use the QR code, or sign in from the PC itself.".into());
        }
        self.engine.ask(json!({ "op": "show" }), Duration::from_secs(10))?;
        self.set(|st| {
            st.signin.window = true;
            st.signin.qr = None;
            st.signin.note = "Finish in Discord's window".into();
        });
        Ok(())
    }

    fn cancel(&self) {
        if self.get(|st| st.signin.active) {
            self.engine.stop();
            self.set(|st| {
                st.signin = Signin::default();
                st.phase = Phase::Stopped;
            });
        }
    }

    /// Ends the session at Discord when it can, and removes the profile either way.
    fn signout(self: &Arc<Self>) {
        let _ = std::fs::remove_file(account_path());
        self.set(|st| {
            st.saved.attention.clear();
            st.saved.failing.clear();
            st.saved.attempts.clear();
        });
        self.save();
        let frozen = self.get(|st| st.phase == Phase::Frozen);
        let running = frozen || self.get(|st| st.phase == Phase::Ready);
        self.set(|st| st.phase = Phase::Setup);
        let me = self.clone();
        std::thread::spawn(move || {
            me.engine.resume();
            if !running && me.engine.start(Mode::Run, &Display::default()).is_ok() {
                let until = Instant::now() + Duration::from_secs(40);
                while !me.engine.ready() && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            let _ = me.engine.ask(json!({ "op": "logout" }), Duration::from_secs(10));
            me.engine.stop();
            let _ = std::fs::remove_dir_all(setup::profile());
            me.set(|st| st.phase = Phase::Stopped);
        });
    }

    fn event(self: &Arc<Self>, mode: Mode, m: Value) {
        if mode == Mode::Scratch {
            return;
        }
        match m["ev"].as_str().unwrap_or("") {
            "fatal" => self.set(|st| st.error = m["error"].as_str().map(String::from)),
            "qr" => self.set(|st| {
                if !st.signin.window {
                    st.signin.qr = m["url"].as_str().filter(|u| !u.is_empty()).map(String::from);
                    if st.signin.qr.is_some() {
                        st.signin.note = "Scan with the Discord app".into();
                    }
                }
            }),
            "login-page" => {
                let (scanned, captcha) = (m["scanned"] == true, m["captcha"] == true);
                self.set(|st| {
                    st.signin.scanned = scanned;
                    st.signin.captcha = captcha;
                    if scanned {
                        st.signin.note = "Confirm on your phone".into();
                    }
                });
                // A person solves it, in the real page.
                if captcha && self.get(|st| st.signin.active && !st.signin.window) {
                    let me = self.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = me.window() {
                            me.set(|st| st.signin.note = format!("Discord wants a captcha. {e}"));
                        }
                    });
                }
            }
            "signed-in" => {
                let u = &m["user"];
                let a = Account {
                    id: u["id"].as_str().unwrap_or("").into(),
                    username: u["username"].as_str().unwrap_or("").into(),
                    name: u["name"].as_str().unwrap_or("").into(),
                    at: store::now(),
                };
                let _ = write_private(&account_path(), &serde_json::to_string_pretty(&a).unwrap_or_default());
                let me = self.clone();
                std::thread::spawn(move || {
                    // Sign-in's page goes: the next tool call starts the hidden one.
                    me.engine.stop();
                    me.set(|st| {
                        st.signin = Signin::default();
                        st.phase = Phase::Stopped;
                        st.saved.attention.clear();
                    });
                    me.save();
                });
            }
            "window-closed" => {
                let me = self.clone();
                std::thread::spawn(move || me.cancel());
            }
            "signed-out" if mode == Mode::Run && self.get(|st| st.phase == Phase::Ready) => self.session_ended(),
            // A page that reloaded by itself may be a new Discord.
            "ready" if mode == Mode::Run && self.get(|st| st.phase == Phase::Ready) => {
                let me = self.clone();
                self.set(|st| st.busy += 1);
                std::thread::spawn(move || {
                    me.set(|st| st.chat_tested = false);
                    let t = me.selftest();
                    me.set(|st| st.busy -= 1);
                    if let Ok(t) = t {
                        me.judge_running(t);
                    }
                });
            }
            "gone" => self.set(|st| {
                if matches!(st.phase, Phase::Ready | Phase::Frozen | Phase::Signin) {
                    st.phase = Phase::Stopped;
                    st.saved.stopped = store::now();
                    if st.signin.active {
                        st.signin = Signin { error: Some("Discord's sign-in stopped. Try again.".into()), ..Default::default() };
                    }
                }
            }),
            _ => {}
        }
    }

    fn status(&self) -> Value {
        let st = self.st.lock().unwrap();
        status_json(Some(&st), &st.saved)
    }

    /// One request from the socket.
    fn handle(self: &Arc<Self>, req: &Value) -> Value {
        let op = req["op"].as_str().unwrap_or("");
        if op != "status" {
            self.touched.store(store::now() as u64, Ordering::Relaxed);
        }
        let r: Result<Value, String> = match op {
            "status" => Ok(self.status()),
            "call" => self.call(req["name"].as_str().unwrap_or(""), req["args"].clone()),
            "rect" | "capture" => self.page_op(req),
            "signin" if req["accept"] != true => Err("Sign-in needs the warning accepted first.".into()),
            "signin" => self.signin(serde_json::from_value(req["display"].clone()).unwrap_or_default()).map(|_| json!({})),
            "window" => self.window().map(|_| json!({})),
            "cancel" => {
                self.cancel();
                Ok(json!({}))
            }
            "signout" => {
                self.signout();
                Ok(json!({}))
            }
            "stop" => {
                self.stop_page();
                Ok(json!({}))
            }
            _ => crate::discordrepair::handle(self, op, req),
        };
        match r {
            Ok(v) => json!({ "ok": true, "result": v }),
            Err(e) => json!({ "ok": false, "error": e }),
        }
    }
}

/// How long a tool may take: waits as long as they ask, uploads and typing pauses a while.
fn call_wait(name: &str, args: &Value) -> Duration {
    let ms = match name {
        "discord_waitForMessage" => args["timeoutMs"].as_u64().unwrap_or(60_000).min(600_000) + 5_000,
        "discord_onboarding" => 125_000,
        "discord_send" => args["typingMs"].as_u64().unwrap_or(if args["typing"] == true { 6_000 } else { 0 }) + 62_000,
        _ => return CALL_WAIT,
    };
    Duration::from_millis(ms)
}

/// The self-test's answer, keeping only names the unedited script has and known statuses: edited
/// tool code can't pass anything else (a message, say) to repair through it.
pub fn read_test(r: &Value, base: &str) -> Test {
    let known = |k: &str| base.contains(&format!("{k}:")) || base.contains(&format!("\"{k}\":"));
    let mut needs = serde_json::Map::new();
    let mut missing = vec![];
    for (k, v) in r["needs"].as_object().into_iter().flatten() {
        let s = v.as_str().unwrap_or("");
        if !known(k) || !matches!(s, "ok" | "missing" | "optional" | "later") {
            continue;
        }
        if s == "missing" {
            missing.push(k.clone());
        }
        needs.insert(k.clone(), json!(s));
    }
    // A page without Vencord has none of it, whatever the table above could say.
    if r["vencord"] != true {
        missing.push("Vencord".into());
    }
    missing.sort();
    let mut tools = HashMap::new();
    for (k, v) in r["tools"].as_object().into_iter().flatten() {
        let names: Vec<String> = v.as_array().into_iter().flatten().filter_map(|n| n.as_str()).filter(|n| known(n)).map(String::from).collect();
        if k.starts_with("discord_") && known(k) && !names.is_empty() {
            tools.insert(k.clone(), names);
        }
    }
    let build: String = r["build"].as_str().unwrap_or("").chars().filter(char::is_ascii_alphanumeric).take(64).collect();
    let report = json!({ "needs": needs, "missing": missing, "tools": tools, "build": build });
    Test { missing, tools, build, report }
}

/// The status the card and the hub show; `st` None: the host isn't running.
fn status_json(st: Option<&St>, saved: &Saved) -> Value {
    let now = store::now();
    let v = setup::Vencords::load();
    json!({
        "phase": st.map(|s| s.phase).unwrap_or(Phase::Stopped),
        "setup": st.map(|s| s.setup.clone()).unwrap_or_default(),
        "error": st.and_then(|s| s.error.clone()),
        "signin": st.map(|s| s.signin.clone()).unwrap_or_default(),
        "account": account(),
        "attention": saved.attention,
        "failing": saved.failing,
        "repairing": st.is_some_and(|s| s.repairing),
        "busy": st.map(|s| s.busy).unwrap_or(0),
        "held": st.map(|s| s.held).unwrap_or(""),
        "logins_today": saved.logins.iter().filter(|t| now - **t < DAY).count(),
        "vencord": v.current,
        "electron": setup::ELECTRON,
    })
}

/// [`status_json`] from what's on disk.
pub fn status_offline() -> Value {
    status_json(None, &load_saved())
}

// ------------------------------------------------------------------ the process

/// `harbor app discord-host`: one per user, held by a lock on `h.lock`.
pub fn run() -> i32 {
    let root = setup::root();
    let Ok(lock) = std::fs::File::create(root.join("h.lock")) else { return 1 };
    // Taken: another host, or one on its way out as this one started; that one's gone in a moment.
    let until = Instant::now() + Duration::from_secs(2);
    while lock.try_lock().is_err() {
        if Instant::now() > until {
            return 0;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let sock = setup::socket();
    let _ = std::fs::remove_file(&sock);
    let Ok(listener) = UnixListener::bind(&sock) else { return 1 };
    // A host that died left its client, frozen perhaps: this one starts clean.
    if let Some(pid) = std::fs::read_to_string(left_over_path()).ok().and_then(|p| p.trim().parse::<i32>().ok()) {
        let shell = setup::shell_dir();
        if std::fs::read_to_string(format!("/proc/{pid}/cmdline")).is_ok_and(|c| c.contains(shell.to_string_lossy().as_ref())) {
            crate::discordfreeze::kill_left_over(pid);
        }
        let _ = std::fs::remove_file(left_over_path());
    }
    let (tx, rx) = channel();
    let scratch_dir = root.join("scratch");
    let _ = std::fs::remove_dir_all(&scratch_dir);
    let host = Arc::new(Host {
        st: Mutex::new(St::new()),
        moved: Condvar::new(),
        engine: Box::new(Electron::new(setup::profile(), tx.clone())),
        scratch: Box::new(Electron::new(scratch_dir, tx)),
        policy: Policy::default(),
        touched: AtomicU64::new(store::now() as u64),
    });
    {
        let h = host.clone();
        std::thread::spawn(move || {
            for (mode, m) in rx {
                h.event(mode, m);
            }
        });
    }
    {
        let h = host.clone();
        std::thread::spawn(move || h.watch(lock, sock));
    }
    for conn in listener.incoming().flatten() {
        let h = host.clone();
        std::thread::spawn(move || serve(h, conn));
    }
    0
}

fn serve(h: Arc<Host>, conn: UnixStream) {
    let Ok(read) = conn.try_clone() else { return };
    let mut out = conn;
    let mut line = String::new();
    if BufReader::new(read).read_line(&mut line).is_err() {
        return;
    }
    let Ok(req) = serde_json::from_str::<Value>(&line) else { return };
    let reply = h.handle(&req);
    let _ = writeln!(out, "{reply}");
}

impl Host {
    /// The clock: idle freezes, sign-in's time limit, and the host's own end.
    fn watch(self: Arc<Self>, _lock: std::fs::File, sock: PathBuf) {
        loop {
            std::thread::sleep(Duration::from_secs(if self.policy.idle < 60 { 1 } else { 10 }));
            let now = store::now();
            let (phase, last, busy, repairing, signin_at) = self.get(|st| (st.phase, st.last_use, st.busy, st.repairing, st.signin_at));
            let wait = if has_swap() { self.policy.idle } else { self.policy.quit_idle };
            if phase == Phase::Ready && !repairing && busy == 0 && now - last >= wait {
                self.idle(now, last);
            }
            if phase == Phase::Signin && now - signin_at > SIGNIN_WAIT.as_secs() as i64 {
                self.cancel();
            }
            // Frozen children keep the pipe open, so a dead client doesn't look like one by itself.
            if matches!(phase, Phase::Ready | Phase::Frozen) && !self.engine.alive() {
                self.stop_page();
            }
            let quiet = now - self.touched.load(Ordering::Relaxed) as i64;
            let gone = phase == Phase::Stopped && !repairing && quiet > LINGER.min(self.policy.idle.max(5));
            // A new Harbor came: only a new host runs its shell.
            let replaced = matches!(phase, Phase::Stopped | Phase::Frozen) && !repairing && std::env::current_exe().is_ok_and(|p| p.to_string_lossy().ends_with(" (deleted)"));
            if gone || replaced {
                self.engine.stop();
                let _ = std::fs::remove_file(&sock);
                std::process::exit(0);
            }
        }
    }

    /// Nothing has used the client for a while: look for a new Vencord, then rest, unless the day's
    /// logins are used up. A new Vencord needs a fresh page, so that goes first.
    fn idle(self: &Arc<Self>, now: i64, last: i64) {
        self.count_logins();
        if setup::check_vencord(false) {
            self.set(|st| st.restart = true);
        }
        if self.get(|st| st.restart) {
            self.stop_page();
            return;
        }
        let logins = self.get(|st| st.saved.logins.clone());
        match self.policy.rest(now, last, 0, &logins, has_swap()) {
            Some(Rest::Freeze) => self.freeze(),
            Some(Rest::Quit) => self.stop_page(),
            None => {}
        }
    }
}

impl St {
    fn new() -> St {
        St {
            phase: Phase::Stopped,
            setup: String::new(),
            error: None,
            signin: Signin::default(),
            signin_at: 0,
            display: Display::default(),
            last_use: 0,
            busy: 0,
            broken: HashMap::new(),
            saved: load_saved(),
            catch_up: None,
            held: "",
            frozen_at: 0,
            reclaiming: Default::default(),
            opens: 0,
            restart: false,
            chat_tested: false,
            repairing: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY: Policy = Policy { idle: FREEZE_AFTER, max_logins: MAX_LOGINS, quit_idle: QUIT_AFTER, max_quit_logins: MAX_QUIT_LOGINS };

    #[test]
    fn with_swap_it_freezes_after_idle_unless_busy_or_past_the_days_logins() {
        let (p, now) = (POLICY, 1_000_000);
        // A burst of calls doesn't freeze between calls.
        assert_eq!(p.rest(now, now - 119, 0, &[], true), None);
        assert_eq!(p.rest(now, now - 120, 0, &[], true), Some(Rest::Freeze));
        // A pending waitForMessage is a call in flight.
        assert_eq!(p.rest(now, now - 9999, 1, &[], true), None);
        // Past 20 logins it stays running until the day is over; older ones don't count.
        assert_eq!(p.rest(now, now - 9999, 0, &vec![now - 10; MAX_LOGINS - 1], true), Some(Rest::Freeze));
        assert_eq!(p.rest(now, now - 9999, 0, &vec![now - 10; MAX_LOGINS], true), None);
        assert_eq!(p.rest(now, now - 9999, 0, &vec![now - DAY - 1; MAX_LOGINS], true), Some(Rest::Freeze));
    }

    #[test]
    fn without_swap_it_quits_later_and_never_freezes() {
        let (p, now) = (POLICY, 1_000_000);
        // Past the freeze wait, nothing yet: a frozen client would keep its memory here.
        assert_eq!(p.rest(now, now - 120, 0, &[], false), None);
        assert_eq!(p.rest(now, now - 1799, 0, &[], false), None);
        assert_eq!(p.rest(now, now - 1800, 0, &[], false), Some(Rest::Quit));
        assert_eq!(p.rest(now, now - 9999, 1, &[], false), None);
        // Every start is a login: the 8th of the day stays running.
        assert_eq!(p.rest(now, now - 9999, 0, &vec![now - 10; MAX_QUIT_LOGINS - 1], false), Some(Rest::Quit));
        assert_eq!(p.rest(now, now - 9999, 0, &vec![now - 10; MAX_QUIT_LOGINS], false), None);
        assert_eq!(p.rest(now, now - 9999, 0, &vec![now - DAY - 1; MAX_QUIT_LOGINS], false), Some(Rest::Quit));
    }

    #[test]
    fn reads_swap_from_meminfo() {
        assert!(swap_in("MemTotal:  8000 kB\nSwapTotal:  11500 kB\nSwapFree:  1 kB\n"));
        assert!(!swap_in("MemTotal:  8000 kB\nSwapTotal:  0 kB\nSwapFree:  0 kB\n"));
        assert!(!swap_in("MemTotal:  8000 kB\n"));
    }

    #[test]
    fn pace_holds_back_joins_dms_and_bursts() {
        let log = |k: &str, ago: &[i64], now: i64| ago.iter().map(|a| (k.to_string(), now - a)).collect::<Vec<_>>();
        let now = 1_000_000;
        assert_eq!(pace("join", &[], now), Pace::Go);
        // Five minutes between joins, three an hour, six a day.
        assert!(matches!(pace("join", &log("join", &[60], now), now), Pace::Refuse(_)));
        assert_eq!(pace("join", &log("join", &[301], now), now), Pace::Go);
        assert!(matches!(pace("join", &log("join", &[400, 800, 1200], now), now), Pace::Refuse(_)));
        assert!(matches!(pace("join", &log("join", &[4000, 8000, 12000, 16000, 20000, 24000], now), now), Pace::Refuse(_)));
        // New DMs and uploads have their own counts.
        assert_eq!(pace("dm", &log("join", &[60], now), now), Pace::Go);
        assert!(matches!(pace("dm", &log("dm", &[121, 500, 900, 1300], now), now), Pace::Refuse(_)));
        assert!(matches!(pace("upload", &log("upload", &[5], now), now), Pace::Refuse(_)));
        // A second between messages just waits.
        assert_eq!(pace("send", &log("send", &[0], now), now), Pace::Wait(1));
        // Anything else isn't paced.
        assert_eq!(pace("other", &[], now), Pace::Go);
        // A refusal says when.
        let Pace::Refuse(why) = pace("join", &log("join", &[60], now), now) else { panic!() };
        assert!(why.contains("4 min"), "{why}");
    }

    #[test]
    fn dry_runs_and_reads_arent_paced() {
        assert_eq!(pace_kind("discord_join", &json!({ "invite": "x" })), None);
        assert_eq!(pace_kind("discord_join", &json!({ "apply": true })), Some("join"));
        assert_eq!(pace_kind("discord_leave", &json!({})), None);
        assert_eq!(pace_kind("discord_send", &json!({ "content": "hi" })), Some("send"));
        assert_eq!(pace_kind("discord_send", &json!({ "files": [{}] })), Some("upload"));
        assert_eq!(pace_kind("discord_history", &json!({})), None);
    }

    #[test]
    fn the_self_test_answer_carries_only_known_names_and_statuses() {
        let base = "GuildStore: { x },\n\"source:a\": { y },\ndiscord_view: { z },";
        let r = json!({
            "vencord": true,
            "build": "abc123 and a message",
            "needs": { "GuildStore": "missing", "source:a": "ok", "someone said hello": "ok", "ChannelStore": "secret text" },
            "tools": { "discord_view": ["GuildStore", "leak"], "discord_leak": ["GuildStore"] },
        });
        let t = read_test(&r, base);
        assert_eq!(t.missing, vec!["GuildStore".to_string()]);
        assert_eq!(t.tools.len(), 1);
        assert_eq!(t.tools["discord_view"], vec!["GuildStore".to_string()]);
        assert_eq!(t.build, "abc123andamessage");
        assert!(!t.report.to_string().contains("hello"));
        assert!(!t.report.to_string().contains("secret"));
        // No Vencord at all counts as missing.
        assert_eq!(read_test(&json!({}), base).missing, vec!["Vencord".to_string()]);
    }

    #[test]
    fn waits_get_the_time_they_ask_for() {
        assert_eq!(call_wait("discord_waitForMessage", &json!({ "timeoutMs": 600_000 })), Duration::from_secs(605));
        assert_eq!(call_wait("discord_waitForMessage", &json!({})), Duration::from_secs(65));
        assert_eq!(call_wait("discord_history", &json!({})), CALL_WAIT);
    }
}
