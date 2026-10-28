//! Session recap and prompt suggestion, as Claude Code does them (2.1.303).
//!
//! Recap ("away summary"): once the user has been away from a chat for 3 minutes after its
//! turn ended, a one- or two-sentence summary of where the session stands, shown dim over the
//! composer until the next turn. Suggestion: after each turn, the prompt the user would likely
//! type next, shown as the empty composer's placeholder; Tab or → takes it (phones: Use).
//!
//! Claude Code runs both as a forked query on the main model's prompt cache. Harbor can't
//! fork the CLI's cache, so it asks Haiku with Claude Code's own prompts over a condensed
//! transcript, in the chat's own account, on a thread. Prompts, thresholds and filters are
//! Claude Code's. Results are kept per chat in the store and served to phones (api.rs
//! `status.recap` / `status.suggestion`).

use crate::app::{App, View};
use crate::store::{self, Item};
use eframe::egui::{self, Color32, Key, Modifiers, Rect, Ui};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

/// Claude Code's recap prompt, verbatim.
pub const RECAP_PROMPT: &str = "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.";

/// Claude Code's suggestion prompt, verbatim.
pub const SUGGEST_PROMPT: &str = "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think \"I was just about to type that\"?

EXAMPLES:
User asked \"fix the bug and run tests\", bug is fixed \u{2192} \"run the tests\"
After code written \u{2192} \"try it out\"
Claude offers options \u{2192} suggest the one the user would likely pick, based on conversation
Claude asks to continue \u{2192} \"yes\" or \"go ahead\"
Task complete, obvious follow-up \u{2192} \"commit this\" or \"push it\"
After error or misunderstanding \u{2192} silence (let them assess/correct)

Be specific: \"run the tests\" beats \"continue\".

NEVER SUGGEST:
- Evaluative (\"looks good\", \"thanks\")
- Questions (\"what about...?\")
- Claude-voice (\"Let me...\", \"I'll...\", \"Here's...\")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate \u{2014} including any sensitive topic (security incidents, credentials, harm, private data). Even when the user is doing legitimate security or cybersecurity work, do not predict potentially unsafe actions.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.";

const SYSTEM: &str = "You read the transcript of a session between a user and Claude Code, an AI coding agent, and do only what the last message asks. You have no tools.";
pub const MODEL: &str = "claude-haiku-5-5";
/// After a turn ends, how long the user has to be away before the recap (Claude Code: 3 min;
/// `HARBOR_TEST_RECAP_S` shortens it for test rigs).
fn delay() -> Duration {
    let s = std::env::var("HARBOR_TEST_RECAP_S").ok().and_then(|v| v.parse().ok()).unwrap_or(180);
    Duration::from_secs(s)
}
/// …and at least this long into the absence.
const MIN_AWAY: Duration = Duration::from_secs(2);
/// Claude Code stops once its prompt cache would be stale (0.9 × the 1 h TTL).
const STALE: Duration = Duration::from_secs(54 * 60);
/// A failed recap is tried again after this, at most `MAX_FAILS` times per turn.
const RETRY: Duration = Duration::from_secs(30);
const MAX_FAILS: u32 = 3;
const RECAP_CAP: usize = 400;
/// The first recaps say how to turn them off.
const HINTED: i64 = 3;
/// A phone that fetched the chat this recently has it open.
const PHONE_SEEN: Duration = Duration::from_secs(20);
const TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum What {
    Recap,
    Suggest,
}

#[derive(Default)]
struct Entry {
    /// When its last turn ended, while a recap is still due for it.
    turn_end: Option<Instant>,
    away_since: Option<Instant>,
    /// Bumped by every turn: results from before it are dropped.
    turn: u64,
    recap_busy: bool,
    fails: u32,
    retry_at: Option<Instant>,
}

pub struct State {
    entries: HashMap<i64, Entry>,
    /// What shows per chat (loaded from the store on first look): recap, suggestion.
    shown: std::cell::RefCell<HashMap<i64, (Option<String>, Option<String>)>>,
    phone_seen: HashMap<i64, Instant>,
    tx: Sender<(i64, What, u64, Result<String, String>)>,
    rx: Receiver<(i64, What, u64, Result<String, String>)>,
}

impl Default for State {
    fn default() -> Self {
        let (tx, rx) = channel();
        State { entries: HashMap::new(), shown: Default::default(), phone_seen: HashMap::new(), tx, rx }
    }
}

// ---------------------------------------------------------------- Claude Code's filters

/// Claude Code's clean-up of a suggestion: unwraps `<suggestion>…</suggestion>` and drops a
/// leading "Suggestion:" label.
pub fn clean(s: &str) -> String {
    let mut t = s.trim().to_string();
    for tag in ["suggestion", "response", "output", "answer", "result"] {
        let lower = t.to_lowercase();
        let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
        if lower.starts_with(&open) && lower.ends_with(&close) && t.len() >= open.len() + close.len() {
            let inner = &t[open.len()..t.len() - close.len()];
            if !inner.to_lowercase().contains(&close) {
                t = inner.to_string();
            }
            break;
        }
    }
    let lower = t.trim_start().to_lowercase();
    let start = t.len() - t.trim_start().len();
    let labels = [
        "suggested response", "suggested reply", "suggested input", "suggested prompt", "suggestion", "response", "reply", "answer", "output", "result",
    ];
    for l in labels {
        if let Some(rest) = lower.strip_prefix(l) {
            let rest_t = rest.trim_start();
            if let Some(after) = rest_t.strip_prefix(':').or_else(|| rest_t.strip_prefix('\u{ff1a}')) {
                let cut = lower.len() - after.len();
                t = t[start + cut..].to_string();
                break;
            }
        }
    }
    t.trim().to_string()
}

fn is_han(c: char) -> bool {
    matches!(c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF)
}

fn is_phonetic(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30FF | 0xFF70 | 0x0E00..=0x0EFF | 0x1780..=0x17FF | 0x1000..=0x109F)
}

fn is_hangul(c: char) -> bool {
    matches!(c as u32, 0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F)
}

/// Words as Claude Code counts them: a CJK character is half (Han) or a quarter (kana) of one.
pub fn words(s: &str) -> usize {
    let mut n = 0.0f64;
    for w in s.split_whitespace() {
        let (mut han, mut ph, mut hg, mut other) = (0, 0, 0, 0);
        for c in w.chars() {
            if is_han(c) {
                han += 1;
            } else if is_phonetic(c) {
                ph += 1;
            } else if is_hangul(c) {
                hg += 1;
            } else if c.is_alphanumeric() {
                other += 1;
            }
        }
        n += if han == 0 && ph == 0 { 1.0 } else { (if other + hg > 0 { 1.0 } else { 0.0 }) + han as f64 / 2.0 + ph as f64 / 4.0 };
    }
    n.ceil() as usize
}

/// Why Claude Code would drop this suggestion, or None to show it.
pub fn suppressed(s: &str) -> Option<&'static str> {
    if s.is_empty() {
        return Some("empty");
    }
    let t = s.to_lowercase();
    if t == "done" {
        return Some("done");
    }
    if t == "nothing found"
        || t == "nothing found."
        || t.starts_with("nothing to suggest")
        || t.starts_with("no suggestion")
        || t.contains("silence is")
        || ["stay silent", "stays silent", "staying silent"].iter().any(|p| t.contains(p))
        || t.trim_matches(|c: char| !c.is_alphanumeric()) == "silence"
    {
        return Some("meta_text");
    }
    if (s.starts_with('(') && s.ends_with(')')) || (s.starts_with('[') && s.ends_with(']')) {
        return Some("meta_wrapped");
    }
    if ["api error:", "prompt is too long", "request timed out", "invalid api key", "image was too large"].iter().any(|p| t.starts_with(p)) {
        return Some("error_message");
    }
    // `^\w+:\s`
    let head: String = s.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    if !head.is_empty() && s[head.len()..].starts_with(':') && s[head.len() + 1..].starts_with(char::is_whitespace) {
        return Some("prefixed_label");
    }
    let n = words(s);
    if n < 2 && !s.starts_with('/') {
        let cjk = s.chars().filter(|c| is_han(*c) || is_phonetic(*c) || is_hangul(*c)).count();
        let ok = if cjk > 0 {
            cjk >= 2
        } else {
            ["yes", "yeah", "yep", "yea", "yup", "sure", "ok", "okay", "push", "commit", "deploy", "stop", "continue", "check", "exit", "quit", "no"].contains(&t.as_str())
        };
        if !ok {
            return Some("too_few_words");
        }
    }
    if n > 12 {
        return Some("too_many_words");
    }
    if s.chars().count() >= 100 {
        return Some("too_long");
    }
    // `[.!?]\s+[A-Z]`
    let cs: Vec<char> = s.chars().collect();
    for i in 0..cs.len() {
        if matches!(cs[i], '.' | '!' | '?') {
            let mut j = i + 1;
            while j < cs.len() && cs[j].is_whitespace() {
                j += 1;
            }
            if j > i + 1 && j < cs.len() && cs[j].is_ascii_uppercase() {
                return Some("multiple_sentences");
            }
        }
    }
    if s.contains('\n') || s.contains('*') {
        return Some("has_formatting");
    }
    let evaluative = [
        "thanks", "thank you", "looks good", "sounds good", "that works", "that worked", "that's all", "nice", "great", "perfect", "makes sense", "awesome", "excellent",
    ];
    if evaluative.iter().any(|e| t.contains(e)) {
        return Some("evaluative");
    }
    let voice = [
        "let me", "i'll", "i've", "i'm", "i can", "i would", "i think", "i notice", "here's", "here is", "here are", "that's", "this is", "this will", "you can", "you should",
        "you could", "sure,", "of course", "certainly",
    ];
    if voice.iter().any(|v| t.starts_with(v)) {
        return Some("claude_voice");
    }
    None
}

/// At most `max` characters, cut at a word and ended with "…".
pub fn cap(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max - 1).collect();
    let cut = match cut.rfind(char::is_whitespace) {
        Some(i) if i > max / 2 => cut[..i].to_string(),
        _ => cut,
    };
    format!("{}\u{2026}", cut.trim_end())
}

// ---------------------------------------------------------------- the transcript

/// The user's own messages (Claude Code's "real user messages").
pub fn user_count(items: &[Item]) -> usize {
    items.iter().filter(|i| matches!(i, Item::User { .. })).count()
}

/// Claude's messages: replies and tool calls.
pub fn assistant_count(items: &[Item]) -> usize {
    items.iter().filter(|i| matches!(i, Item::Text { .. } | Item::Tool { .. })).count()
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// The conversation as plain text for the model: the first request, then as much of the end
/// as fits in about `budget` characters.
pub fn context(items: &[Item], budget: usize) -> String {
    let line = |it: &Item| -> Option<String> {
        Some(match it {
            Item::User { text, .. } => format!("User: {}", clip(text, 2000)),
            Item::Text { text, .. } => format!("Claude: {}", clip(text, 2000)),
            Item::Tool { name, summary, is_error, .. } => {
                format!("[{}{}{}]", crate::view::tool_label(name), if summary.is_empty() { String::new() } else { format!(": {}", clip(summary, 160)) }, if *is_error { " (failed)" } else { "" })
            }
            Item::Error { text } => format!("[error: {}]", clip(text.lines().next().unwrap_or(""), 200)),
            Item::Message { from, to, text } => format!("{from} \u{2192} {to}: {}", clip(text, 1000)),
            Item::Notice { text, .. } => format!("[{}]", clip(text, 200)),
            Item::Thinking { .. } | Item::Result { .. } => return None,
        })
    };
    let first = items.iter().position(|i| matches!(i, Item::User { .. }));
    let mut tail: Vec<String> = vec![];
    let mut used = 0;
    let mut cut = false;
    for (i, it) in items.iter().enumerate().rev() {
        if Some(i) == first {
            break;
        }
        let Some(l) = line(it) else { continue };
        if used + l.len() > budget && !tail.is_empty() {
            cut = true;
            break;
        }
        used += l.len() + 1;
        tail.push(l);
    }
    tail.reverse();
    let mut out = vec![];
    if let Some(f) = first.and_then(|f| line(&items[f])) {
        out.push(f);
    }
    if cut {
        out.push("[… earlier part of the session left out …]".into());
    }
    out.extend(tail);
    out.join("\n")
}

fn full_prompt(items: &[Item], ask: &str) -> String {
    format!("<transcript>\n{}\n</transcript>\n\n{ask}", context(items, 12_000))
}

/// One question to Haiku through the account's Claude Code: no tools, servers, hooks or session.
/// Also profile.rs's who-is-who detection, with its own system prompt.
pub fn ask(bin: String, env: Vec<(String, Option<String>)>, system: &str, prompt: String) -> Result<String, String> {
    ask_within(bin, env, system, prompt, TIMEOUT)
}

/// [`ask`] with its own time limit (dictation cleanup: a few seconds).
pub fn ask_within(bin: String, env: Vec<(String, Option<String>)>, system: &str, prompt: String, timeout: Duration) -> Result<String, String> {
    let dir = store::data_dir().join("recap");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(bin);
    cmd.current_dir(&dir)
        .args(["-p", "--model", MODEL, "--output-format", "json", "--no-session-persistence", "--tools", "", "--strict-mcp-config"])
        .args(["--setting-sources", "user", "--settings", r#"{"disableAllHooks":true}"#, "--system-prompt", system])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (k, v) in env {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(prompt.as_bytes());
    }
    let mut out = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(o) = out.as_mut() {
            let _ = std::io::Read::read_to_string(o, &mut s);
        }
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let text = reader.join().unwrap_or_default();
    let v: Value = serde_json::from_str(text.trim()).map_err(|_| "no answer".to_string())?;
    if v["is_error"].as_bool() == Some(true) {
        return Err(v["result"].as_str().unwrap_or("error").to_string());
    }
    Ok(v["result"].as_str().unwrap_or("").trim().to_string())
}

// ---------------------------------------------------------------- the app's side

fn on(store: &store::Store, key: &str) -> bool {
    store.get(key).as_deref() != Some("0")
}

impl App {
    pub fn recap_enabled(&self) -> bool {
        on(&self.store, "recap_enabled")
    }

    pub fn suggest_enabled(&self) -> bool {
        on(&self.store, "suggest_enabled")
    }

    /// A phone fetched the chat (api.rs): it counts as being looked at.
    pub fn recap_seen(&mut self, chat: i64) {
        self.recap.phone_seen.insert(chat, Instant::now());
    }

    /// The chat is in front of the user: on this PC's focused window, or open on a phone.
    fn watched(&self, chat: i64) -> bool {
        let ord = std::sync::atomic::Ordering::Relaxed;
        let here = crate::agent::SHOWN_CHAT.load(ord) == chat && crate::agent::FOCUSED.load(ord) && self.view == View::Chat(chat);
        here || self.recap.phone_seen.get(&chat).is_some_and(|t| t.elapsed() < PHONE_SEEN)
    }

    /// The stored recap and suggestion of a chat ("gid\ntext": ids can come back after a delete).
    pub(crate) fn recap_load(&self, chat: i64) -> (Option<String>, Option<String>) {
        if !self.recap.shown.borrow().contains_key(&chat) {
            let gid = self.chat(chat).map(|c| c.gid.clone()).unwrap_or_default();
            let get = |k: &str| {
                self.store.get(&format!("{k}:{chat}")).and_then(|v| v.split_once('\n').filter(|(g, t)| *g == gid && !t.is_empty()).map(|(_, t)| t.to_string()))
            };
            let v = (get("recap"), get("suggestion"));
            self.recap.shown.borrow_mut().insert(chat, v);
        }
        self.recap.shown.borrow()[&chat].clone()
    }

    fn recap_store(&mut self, chat: i64, what: What, text: Option<String>) {
        let gid = self.chat(chat).map(|c| c.gid.clone()).unwrap_or_default();
        let key = match what {
            What::Recap => "recap",
            What::Suggest => "suggestion",
        };
        self.store.set(&format!("{key}:{chat}"), &text.as_ref().map(|t| format!("{gid}\n{t}")).unwrap_or_default());
        self.recap_load(chat);
        let mut shown = self.recap.shown.borrow_mut();
        let slot = shown.get_mut(&chat).unwrap();
        match what {
            What::Recap => slot.0 = text,
            What::Suggest => slot.1 = text,
        }
        drop(shown);
        self.api_touch(chat);
    }

    /// What shows for a chat: its recap and suggestion. Another PC's chat: as its home says.
    pub fn recap_shown(&self, chat: i64) -> (Option<String>, Option<String>) {
        if let Some(r) = self.mesh.status.get(&chat) {
            let s = |k: &str| r.status[k].as_str().filter(|t| !t.is_empty()).map(str::to_string);
            return (s("recap"), s("suggestion"));
        }
        let (recap_on, suggest_on) = (self.recap_enabled(), self.suggest_enabled());
        let running = self.is_running(chat);
        let (r, s) = self.recap_load(chat);
        (r.filter(|_| recap_on && !running), s.filter(|_| suggest_on && !running))
    }

    /// `api_status` plus the recap and suggestion: what phones and other PCs get.
    pub fn status_json(&self, chat: i64) -> Value {
        let mut v = self.api_status(chat);
        self.recap_status(chat, &mut v);
        v
    }

    /// The phone's copy (PROTOCOL.md `status.recap`, `status.suggestion`).
    pub fn recap_status(&self, chat: i64, status: &mut Value) {
        let (r, s) = self.recap_shown(chat);
        if let Some(r) = r {
            status["recap"] = json!(r);
        }
        if let Some(s) = s {
            status["suggestion"] = json!(s);
        }
    }

    fn recap_account(&self, chat: i64) -> Option<crate::providers::Account> {
        let c = self.chat(chat)?;
        let a = self.account(&c.account)?;
        // Claude Code only; not at (or near) a usage limit.
        if a.kind != crate::providers::Kind::Claude || self.blocked(&a.id).is_some() || self.paused(chat).is_some() {
            return None;
        }
        if self.limits.quota.get(&a.id).is_some_and(|q| q.iter().any(|(_, used, _)| *used >= 0.9)) {
            return None;
        }
        Some(a.clone())
    }

    fn recap_spawn(&mut self, chat: i64, what: What, ctx: &egui::Context) -> bool {
        let Some(a) = self.recap_account(chat) else { return false };
        let items = match self.transcripts.get(&chat) {
            Some(t) => t.items.clone(),
            None => self.store.items(chat),
        };
        let prompt = full_prompt(&items, if what == What::Recap { RECAP_PROMPT } else { SUGGEST_PROMPT });
        let turn = self.recap.entries.entry(chat).or_default().turn;
        let tx = self.recap.tx.clone();
        let ctx = ctx.clone();
        let (bin, env) = (a.bin_str(), a.env());
        std::thread::spawn(move || {
            let r = ask(bin, env, SYSTEM, prompt);
            let _ = tx.send((chat, what, turn, r));
            ctx.request_repaint();
        });
        true
    }

    /// A turn ended: the suggestion now; the recap once the user has been away a while.
    pub fn recap_exited(&mut self, chat: i64, stopped: bool, ctx: &egui::Context) {
        let Some(c) = self.chat(chat) else { return };
        // Claude Code: the main thread only (not sub-agents), this PC's own chats.
        if c.foreign() || c.role == store::Role::Sub {
            return;
        }
        let plan = c.access == "plan";
        let e = self.recap.entries.entry(chat).or_default();
        e.turn += 1;
        e.turn_end = Some(Instant::now());
        e.away_since = None;
        e.fails = 0;
        e.retry_at = None;
        e.recap_busy = false;
        if stopped || plan || !self.suggest_enabled() {
            return;
        }
        let items = self.transcripts.get(&chat).map(|t| &t.items[..]).unwrap_or(&[]);
        // Not this early, and not after an error (let them assess it).
        if assistant_count(items) < 2 || matches!(items.last(), Some(Item::Error { .. })) {
            return;
        }
        self.recap_spawn(chat, What::Suggest, ctx);
    }

    /// Once per frame: results in, a new turn hides what showed, recaps that are due go out.
    pub fn recap_tick(&mut self, ctx: &egui::Context) {
        while let Ok((chat, what, turn, r)) = self.recap.rx.try_recv() {
            if self.recap.entries.get(&chat).is_none_or(|e| e.turn != turn) {
                continue;
            }
            let running = self.is_running(chat);
            match (what, r) {
                (What::Suggest, Ok(s)) => {
                    let s = clean(&s);
                    if suppressed(&s).is_none() && !running {
                        self.recap_store(chat, What::Suggest, Some(s));
                    }
                }
                (What::Suggest, Err(_)) => {}
                (What::Recap, r) => {
                    let text = r.map(|t| t.trim().to_string()).ok().filter(|t| !t.is_empty());
                    let e = self.recap.entries.get_mut(&chat).unwrap();
                    e.recap_busy = false;
                    match text {
                        Some(t) if !running => {
                            e.turn_end = None;
                            let n = self.store.get("recap_count").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
                            self.store.set("recap_count", &(n + 1).to_string());
                            let t = cap(&t, RECAP_CAP);
                            let t = if n < HINTED { format!("{t} (disable recaps in Settings)") } else { t };
                            let users = self.transcripts.get(&chat).map(|tr| user_count(&tr.items)).unwrap_or(0);
                            self.store.set(&format!("recap_users:{chat}"), &users.to_string());
                            self.recap_store(chat, What::Recap, Some(t));
                        }
                        Some(_) => {}
                        None => {
                            e.fails += 1;
                            e.retry_at = Some(Instant::now() + RETRY);
                        }
                    }
                }
            }
        }
        // A turn started: what showed was about before it.
        let running: Vec<i64> = self.recap.shown.borrow().iter().filter(|(_, (r, s))| r.is_some() || s.is_some()).map(|(id, _)| *id).filter(|id| self.is_running(*id)).collect();
        for id in running {
            self.recap_store(id, What::Recap, None);
            self.recap_store(id, What::Suggest, None);
            if let Some(e) = self.recap.entries.get_mut(&id) {
                e.turn += 1;
                e.turn_end = None;
            }
        }
        if !self.recap_enabled() {
            return;
        }
        let now = Instant::now();
        let due: Vec<i64> = self.recap.entries.iter().filter(|(_, e)| e.turn_end.is_some() && !e.recap_busy).map(|(id, _)| *id).collect();
        let mut next: Option<Duration> = None;
        for id in due {
            let watched = self.watched(id);
            let e = self.recap.entries.get_mut(&id).unwrap();
            let end = e.turn_end.unwrap();
            if now.duration_since(end) > STALE || e.fails >= MAX_FAILS {
                e.turn_end = None;
                continue;
            }
            if watched {
                e.away_since = None;
                // A phone's look runs out without any event here: wake then.
                if let Some(t) = self.recap.phone_seen.get(&id).and_then(|t| PHONE_SEEN.checked_sub(t.elapsed())) {
                    next = Some(next.map_or(t, |n: Duration| n.min(t)));
                }
                continue;
            }
            let away = *e.away_since.get_or_insert(now);
            let at = (end + delay()).max(away + MIN_AWAY).max(e.retry_at.unwrap_or(now));
            if at > now {
                next = Some(next.map_or(at - now, |n: Duration| n.min(at - now)));
                continue;
            }
            if self.recap_wanted(id) {
                if self.recap_spawn(id, What::Recap, ctx) {
                    self.recap.entries.get_mut(&id).unwrap().recap_busy = true;
                }
            } else {
                // Not for this turn (too early in the session, a draft, sub-agents at work…).
                self.recap.entries.get_mut(&id).unwrap().turn_end = None;
            }
        }
        if let Some(n) = next {
            ctx.request_repaint_after(n + Duration::from_millis(50));
        }
    }

    /// Claude Code's checks when the recap is due.
    fn recap_wanted(&mut self, chat: i64) -> bool {
        if self.is_running(chat) || self.drafts.get(&chat).is_some_and(|d| !d.trim().is_empty()) {
            return false;
        }
        if self.chat(chat).is_some_and(|c| c.role == store::Role::Lead) && !self.running_subs(chat).is_empty() {
            return false;
        }
        if self.recap_load(chat).0.is_some() {
            return false;
        }
        let users = self.transcripts.get(&chat).map(|t| user_count(&t.items)).unwrap_or_else(|| user_count(&self.store.items(chat)));
        if users < 3 {
            return false;
        }
        match self.store.get(&format!("recap_users:{chat}")).and_then(|v| v.parse::<usize>().ok()) {
            Some(before) if before <= users => users - before >= 2,
            _ => true,
        }
    }

    /// The recap over the composer: "recap: …", dim, the text in italics.
    pub fn recap_line(&mut self, ui: &mut Ui, chat: i64) {
        let Some(text) = self.recap_shown(chat).0 else { return };
        let t = self.theme.t;
        let mut job = egui::text::LayoutJob::default();
        let font = |f: egui::FontFamily| egui::FontId::new(13.0, f);
        job.append("recap: ", 0.0, egui::TextFormat { font_id: font(crate::theme::semibold()), color: t.subtle(), ..Default::default() });
        job.append(&text, 0.0, egui::TextFormat { font_id: font(egui::FontFamily::Proportional), color: t.subtle(), italics: true, ..Default::default() });
        // Wraps within the composer's width; never widens it.
        job.wrap.max_width = (ui.available_width() - 12.0).max(40.0);
        egui::Frame::new().inner_margin(egui::Margin { left: 6, right: 6, top: 0, bottom: 6 }).show(ui, |ui| {
            ui.add(egui::Label::new(job).wrap_mode(egui::TextWrapMode::Wrap));
        });
    }

    /// The suggestion for the composer of `chat`, while it's empty.
    pub fn ghost(&self, chat: i64, draft: &str) -> Option<String> {
        if !draft.is_empty() {
            return None;
        }
        self.recap_shown(chat).1
    }

    pub fn recap_rows(&mut self, ui: &mut Ui) {
        let (mut recap, mut suggest) = (self.recap_enabled(), self.suggest_enabled());
        crate::pages::rows(ui, |ui| {
            crate::widgets::setting_row(
                ui,
                "Session recap",
                "When you come back to a chat a few minutes after its turn ended, a one-line summary of where it stands shows over the composer, like Claude Code's. Claude chats only; it uses a little of the chat account's usage (Haiku).",
                |ui| crate::widgets::toggle(ui, &mut recap),
            );
            crate::widgets::separator(ui);
            crate::widgets::setting_row(
                ui,
                "Prompt suggestions",
                "After each turn, the message you'd likely send next shows grayed in the empty composer. Tab or \u{2192} takes it, Enter then sends; on a phone, tap Use. Claude chats only (Haiku).",
                |ui| crate::widgets::toggle(ui, &mut suggest),
            );
        });
        if recap != self.recap_enabled() {
            self.store.set("recap_enabled", if recap { "1" } else { "0" });
        }
        if suggest != self.suggest_enabled() {
            self.store.set("suggest_enabled", if suggest { "1" } else { "0" });
        }
    }
}

/// Tab or → in the focused, empty composer takes the suggestion (cursor at its end).
pub fn accept_keys(ui: &mut Ui, id: egui::Id, draft: &mut String, ghost: Option<&str>) {
    let Some(g) = ghost else { return };
    if !draft.is_empty() || !ui.memory(|m| m.has_focus(id)) {
        return;
    }
    if ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Tab) || i.consume_key(Modifiers::NONE, Key::ArrowRight)) {
        *draft = g.to_string();
        let mut state = egui::text_edit::TextEditState::load(ui.ctx(), id).unwrap_or_default();
        state.cursor.set_char_range(Some(egui::text::CCursorRange::one(egui::text::CCursor::new(g.chars().count()))));
        state.store(ui.ctx(), id);
    }
}

/// The suggestion is grayer than the usual placeholder and typed text.
pub fn tint_hint(ui: &Ui, id: egui::Id) {
    let c = crate::widgets::tokens(ui).gray(700);
    ui.data_mut(|d| d.insert_temp(id.with("hint-color"), c));
}

/// The "⇥ Tab" tag at the right end of the composer's first line while the suggestion shows.
/// Also keeps Tab (and the arrows) from moving focus next frame, as the slash and tag menus
/// do: egui picks the focus move before `accept_keys` sees the key, by the filter the focused
/// widget left last frame, and the composer's TextEdit resets it each frame.
pub fn tab_tag(ui: &Ui, id: egui::Id, text_rect: Rect) {
    ui.memory_mut(|m| m.set_focus_lock_filter(id, egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: false }));
    let t = crate::widgets::tokens(ui);
    let font = egui::FontId::new(12.0, egui::FontFamily::Proportional);
    let galley = ui.painter().layout_no_wrap("\u{21e5} Tab".into(), font, t.gray(800));
    let size = galley.size() + egui::vec2(10.0, 4.0);
    let line = ui.text_style_height(&crate::theme::ts("copy-14"));
    let rect = Rect::from_min_size(egui::pos2(text_rect.right() - size.x, text_rect.top() + (line - size.y) / 2.0), size);
    ui.painter().rect(rect, 4.0, if t.dark { t.gray(200) } else { t.gray(100) }, egui::Stroke::new(1.0, t.border()), egui::StrokeKind::Inside);
    ui.painter().galley(rect.center() - galley.size() / 2.0, galley, Color32::PLACEHOLDER);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_like_claude_code() {
        assert_eq!(clean("<suggestion>run the tests</suggestion>"), "run the tests");
        assert_eq!(clean("Suggestion: run the tests"), "run the tests");
        assert_eq!(clean("  suggested reply：push it "), "push it");
        assert_eq!(clean("commit this"), "commit this");
    }

    #[test]
    fn filters_like_claude_code() {
        for (s, why) in [
            ("", "empty"),
            ("done", "done"),
            ("Nothing to suggest here", "meta_text"),
            ("(silence)", "meta_text"),
            ("[none]", "meta_wrapped"),
            ("API Error: overloaded", "error_message"),
            ("Note: run it", "prefixed_label"),
            ("tests", "too_few_words"),
            ("one two three four five six seven eight nine ten eleven twelve thirteen", "too_many_words"),
            ("Run the tests. Then push", "multiple_sentences"),
            ("run **all** tests", "has_formatting"),
            ("looks good, push it", "evaluative"),
            ("Let me run the tests", "claude_voice"),
        ] {
            assert_eq!(suppressed(s), Some(why), "{s:?}");
        }
        for ok in ["run the tests", "yes", "push", "/commit", "commit this and push it", "try it out"] {
            assert_eq!(suppressed(ok), None, "{ok:?}");
        }
    }

    #[test]
    fn counts_words_and_caps() {
        assert_eq!(words("run the tests"), 3);
        assert_eq!(words("テストを実行"), 2);
        let long = "word ".repeat(120);
        let c = cap(long.trim(), 400);
        assert!(c.chars().count() <= 400 && c.ends_with('\u{2026}'));
        assert_eq!(cap("short", 400), "short");
    }

    #[test]
    fn context_keeps_the_request_and_the_end() {
        let mut items = vec![Item::User { text: "build the login page".into(), files: vec![], at: 0, mentions: vec![], sender: String::new(), intent: String::new() }];
        for i in 0..400 {
            items.push(Item::Text { text: format!("step {i} done with some words to fill the line"), at: 0 });
        }
        items.push(Item::User { text: "now add tests".into(), files: vec![], at: 0, mentions: vec![], sender: String::new(), intent: String::new() });
        let c = context(&items, 2000);
        assert!(c.starts_with("User: build the login page\n[… earlier"));
        assert!(c.ends_with("User: now add tests"));
        assert!(c.len() < 2600);
        assert_eq!(user_count(&items), 2);
        assert_eq!(assistant_count(&items), 400);
    }
}
