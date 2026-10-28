//! Follow-ups sent while a turn runs: Steer or Queue, as in T3 Code (issue #83).
//!
//! **Queue**: the message waits for the turn to end ("Up next"), then runs as the next
//! turn, one message per turn, in order. A Claude turn keeps its input open: the next
//! queued message is written into it right after its result, so Claude runs it in the
//! same process; other providers get it as a new turn once the process exits.
//! `--replay-user-messages` echoes each message as Claude takes it in; only then does it
//! join the transcript. Queued messages can be edited in place, reordered, removed or
//! promoted to a steer. Stop holds the queue until Resume (or the next message sent).
//!
//! **Steer**: the message reaches the running turn now. Claude gets it as a stream-json
//! user message with `priority: "now"`: the CLI ends what the turn is doing (running
//! commands go to the background) and takes it in; the segment cut short ends with its
//! own result, then the echo comes. Codex can't take input mid-turn: its turn is stopped
//! and the session resumes with the message. Other providers can't be steered, so their
//! follow-ups always queue (the hub serves `can_steer`, so the phone never guesses).
//!
//! Fallbacks, so a message is never lost: the turn just ended (Claude's input closed) →
//! it goes as the next turn; the write fails → back at the top of the queue, said so; the
//! turn exits without taking the steer in → a new turn with it (or held at the top of the
//! queue after a Stop). A message to a chat whose turn isn't running is a plain send.

use crate::agent::Event;
use crate::app::App;
use crate::icons as ic;
use crate::mentions::Mention;
use crate::store::{self, Item};
use crate::theme::RADIUS_LG;
use crate::widgets as w;
use eframe::egui::{self, Align2, CornerRadius, FontId, Sense, Shape, Stroke, StrokeKind, Ui, Vec2, pos2};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

/// What a follow-up does while the agent works.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Queue,
    Steer,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "queue" => Some(Mode::Queue),
            "steer" => Some(Mode::Steer),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Queue => "queue",
            Mode::Steer => "steer",
        }
    }

    pub fn opposite(self) -> Mode {
        match self {
            Mode::Queue => Mode::Steer,
            Mode::Steer => Mode::Queue,
        }
    }
}

/// How the running turn takes a steer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Steering {
    /// Into the live turn (Claude, `priority: "now"`).
    Active,
    /// Stop the turn and resume the session with the message (Codex).
    Restart,
    /// Can't: the follow-up queues.
    No,
}

pub const STEER: &str = "steer";
pub const PROMOTED: &str = "promoted";
const NOT_LANDED: &str = "Steer didn't land: queued";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Queued {
    /// Stable within this Harbor (the API's `queue/{id}`); 0 in snapshots before 0.69.
    #[serde(default)]
    pub id: u64,
    pub text: String,
    pub files: Vec<PathBuf>,
    pub mentions: Vec<Mention>,
    /// Written into the running turn, waiting for Claude to take it in.
    pub written: bool,
    /// Where it was written, when not on this PC (`Item::User::sender`).
    #[serde(default)]
    pub sender: String,
    /// The device that wrote it (its typing doesn't hold it back).
    #[serde(default)]
    pub device: String,
    /// A steer on its way into the turn: [`STEER`] or [`PROMOTED`]; empty when queued.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub intent: String,
    /// Why it's here when it wasn't queued as such ([`NOT_LANDED`]).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// The device editing it in its composer; empty when nobody is.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub editing: String,
}

impl Queued {
    /// What the agent gets: mentioned messages quoted first, then the text as `said`
    /// (slash.rs puts commands in for agents that don't expand them).
    fn prompt(&self, said: &str) -> String {
        let from = sent_from(&self.sender, &self.device, false);
        // A slash command only runs at the start: where it came from follows it.
        if said.starts_with('/') && !from.is_empty() {
            return format!("{}{said}\n\n{}", crate::mentions::prompt(&self.mentions), from.trim_end());
        }
        format!("{from}{}{said}", crate::mentions::prompt(&self.mentions))
    }

    fn steering(&self) -> bool {
        !self.intent.is_empty()
    }

    /// Its transcript item, once the agent has it.
    fn item(self) -> Item {
        Item::User {
            text: self.text,
            files: self.files.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            at: store::now(),
            mentions: self.mentions,
            sender: self.sender,
            intent: self.intent,
        }
    }
}

/// Where a message was written, for the agent (which otherwise takes the user to be at
/// this PC): a phone or another PC's Harbor says so, and with `back` so does this PC's
/// composer after a message from elsewhere. Empty for this PC's own messages.
pub fn sent_from(sender: &str, device: &str, back: bool) -> String {
    if sender.is_empty() {
        return if back { format!("[The user sent this from '{}', the PC running Harbor.]\n\n", crate::remote::hostname()) } else { String::new() };
    }
    if device.starts_with("tok:") {
        format!("[The user sent this from the Harbor app on their phone ('{sender}'), not from this PC.]\n\n")
    } else {
        format!("[The user sent this from Harbor on '{sender}', another PC, not from this one.]\n\n")
    }
}

/// A queued message being edited in this PC's composer: the draft set aside meanwhile.
struct Edit {
    chat: i64,
    id: u64,
    original: String,
    aside: (String, Vec<PathBuf>, Vec<Mention>),
}

#[derive(Default)]
pub struct State {
    chats: HashMap<i64, Vec<Queued>>,
    /// Chats whose queue a Stop holds until Resume.
    held: BTreeSet<i64>,
    next: u64,
    /// The mode of the message `send_to` handles now (None: queue); set by its caller.
    pub mode: Option<Mode>,
    /// kv `follow_up`, read once.
    default: Option<Mode>,
    edit: Option<Edit>,
    /// "Show all N queued" unfolded, per chat.
    unfolded: BTreeSet<i64>,
}

impl State {
    fn id(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    fn list(&mut self, chat: i64) -> &mut Vec<Queued> {
        self.chats.entry(chat).or_default()
    }

    fn find(&mut self, chat: i64, id: u64) -> Option<&mut Queued> {
        self.chats.get_mut(&chat)?.iter_mut().find(|q| q.id == id && !q.steering())
    }

    fn tidy(&mut self, chat: i64) {
        if self.chats.get(&chat).is_some_and(|q| q.is_empty()) {
            self.chats.remove(&chat);
            self.held.remove(&chat);
            self.unfolded.remove(&chat);
        }
    }

    /// Moves queued message `id` to position `to` among the queued ones (steers stay put).
    fn move_to(&mut self, chat: i64, id: u64, to: usize) -> bool {
        let Some(list) = self.chats.get_mut(&chat) else { return false };
        let Some(from) = list.iter().position(|q| q.id == id && !q.steering() && !q.written) else { return false };
        let m = list.remove(from);
        // Index among the waiting ones → index in the list.
        let slots: Vec<usize> = list.iter().enumerate().filter(|(_, q)| !q.steering() && !q.written).map(|(i, _)| i).collect();
        let at = match slots.get(to) {
            Some(i) => *i,
            None => slots.last().map(|i| i + 1).unwrap_or(list.len()),
        };
        list.insert(at, m);
        true
    }
}

impl App {
    /// Kv `follow_up`: what Enter does while the agent works (Steer unless set to Queue).
    pub fn follow_default(&mut self) -> Mode {
        if let Some(m) = self.queue.default {
            return m;
        }
        let m = self.store.get("follow_up").and_then(|s| Mode::parse(&s)).unwrap_or(Mode::Steer);
        self.queue.default = Some(m);
        m
    }

    /// The same without caching it (for `&self` callers like the API's status).
    pub fn follow_setting(&self) -> Mode {
        self.queue.default.unwrap_or_else(|| self.store.get("follow_up").and_then(|s| Mode::parse(&s)).unwrap_or(Mode::Steer))
    }

    pub fn set_follow_default(&mut self, m: Mode) {
        self.store.set("follow_up", m.as_str());
        self.queue.default = Some(m);
    }

    /// How the chat's running turn here takes a steer.
    pub fn steering(&self, chat: i64) -> Steering {
        match self.turns.get(&chat) {
            Some((t, _)) => t.steering(),
            None => Steering::No,
        }
    }

    /// Whether a follow-up can steer the chat's running turn (a copy: as its home PC says).
    pub fn can_steer(&self, chat: i64) -> bool {
        match self.mesh.status.get(&chat) {
            Some(r) => r.status["can_steer"].as_bool().unwrap_or(false),
            None => self.steering(chat) != Steering::No,
        }
    }

    /// Whether a Stop holds the chat's queue (a copy: as its home PC says).
    pub fn queue_held(&self, chat: i64) -> bool {
        match self.mesh.status.get(&chat) {
            Some(r) => r.status["held"].as_bool().unwrap_or(false),
            None => self.queue.held.contains(&chat) && !self.queued(chat).is_empty(),
        }
    }

    /// The queued messages (not steers) as the chat's PC has them, for drawing.
    fn shown_queue(&self, chat: i64) -> Vec<Queued> {
        match self.mesh.status.get(&chat) {
            Some(r) => r.status["queue"].as_array().into_iter().flatten().map(from_json).collect(),
            None => self.queued(chat).to_vec(),
        }
    }

    /// No queued message to edit or steer with in `chat` (the composer's Alt+↑).
    pub fn shown_queue_empty(&self, chat: i64) -> bool {
        self.shown_queue(chat).iter().all(|q| q.written || q.steering())
    }

    fn new_queued(&mut self, text: String, files: Vec<PathBuf>, mentions: Vec<Mention>) -> Queued {
        let (sender, device) = (self.sender.clone(), self.sending_device());
        Queued { id: self.queue.id(), text, files, mentions, written: false, sender, device, intent: String::new(), note: String::new(), editing: String::new() }
    }

    /// Called by `send_to` while the chat's turn runs: steers it or queues, per `mode`.
    pub fn follow_up(&mut self, chat: i64, text: String, files: Vec<PathBuf>, mentions: Vec<Mention>, mode: Mode, ctx: &egui::Context) {
        let q = self.new_queued(text, files, mentions);
        if mode == Mode::Steer && self.steering(chat) != Steering::No {
            self.steer(chat, q, STEER, ctx);
        } else {
            self.queue.list(chat).push(q);
            self.api_touch(chat);
        }
    }

    /// Queues a message behind the running turn (or behind someone typing elsewhere).
    pub fn enqueue(&mut self, chat: i64, text: String, files: Vec<PathBuf>, mentions: Vec<Mention>) {
        let q = self.new_queued(text, files, mentions);
        self.queue.list(chat).push(q);
        self.api_touch(chat);
    }

    /// Steers the running turn with `q`, with the fallbacks in the module doc.
    fn steer(&mut self, chat: i64, mut q: Queued, intent: &str, ctx: &egui::Context) {
        q.intent = intent.into();
        q.note.clear();
        q.editing.clear();
        self.api_touch(chat);
        match self.steering(chat) {
            // Not running any more: a plain new turn (that resumes a held queue, too).
            Steering::No if !self.turns.contains_key(&chat) => {
                q.intent.clear();
                self.queue.held.remove(&chat);
                self.send_queued(chat, vec![q], ctx);
            }
            // Can't be steered (or its input just closed: the turn is ending): it goes next.
            Steering::No => {
                q.intent.clear();
                let at = self.queued(chat).iter().take_while(|m| m.written).count();
                self.queue.list(chat).insert(at, q);
            }
            Steering::Active => {
                let said = self.slash_prompt(chat, &q.text);
                let wrote = self.turns.get(&chat).is_some_and(|(t, _)| t.write_now(&q.prompt(&said), &q.files));
                if wrote {
                    q.written = true;
                    self.queue.list(chat).push(q);
                } else {
                    q.intent.clear();
                    q.note = NOT_LANDED.into();
                    let at = self.queued(chat).iter().take_while(|m| m.written).count();
                    self.queue.list(chat).insert(at, q);
                }
            }
            Steering::Restart => {
                // Killed and waited for, so the resumed session is settled; its exit event is
                // dropped (it would otherwise end the new turn). What was queued keeps waiting.
                if let Some((turn, _)) = self.turns.remove(&chat) {
                    turn.stop_wait();
                    self.undo_swallow(chat);
                    if let Some(tr) = self.transcripts.get_mut(&chat) {
                        tr.items.push(Item::Error { text: "Interrupted by a steer.".into() });
                        tr.pending_text = None;
                        tr.pending_thinking = None;
                    }
                }
                self.send_queued(chat, vec![q], ctx);
            }
        }
    }

    /// The queues, for the next process after a reload.
    pub fn queue_snapshot(&self) -> Value {
        json!({ "chats": serde_json::to_value(&self.queue.chats).unwrap_or_default(), "held": self.queue.held })
    }

    pub fn queue_restore(&mut self, v: &Value) {
        // Before 0.69 the snapshot was the map alone.
        let (chats, held) = if v.get("chats").is_some() { (&v["chats"], v["held"].clone()) } else { (v, Value::Null) };
        if let Ok(chats) = serde_json::from_value::<HashMap<i64, Vec<Queued>>>(chats.clone()) {
            self.queue.chats = chats;
        }
        self.queue.held = serde_json::from_value(held).unwrap_or_default();
        self.queue.next = self.queue.chats.values().flatten().map(|q| q.id).max().unwrap_or(0);
        for q in self.queue.chats.values_mut().flatten() {
            q.editing.clear();
            if q.id == 0 {
                self.queue.next += 1;
                q.id = self.queue.next;
            }
        }
    }

    /// Takes a chat's waiting messages out of the queue (/clear-queue, an old phone's Stop).
    pub fn take_queue(&mut self, chat_id: i64) -> Vec<Queued> {
        let all = self.queue.chats.remove(&chat_id).unwrap_or_default();
        self.queue.held.remove(&chat_id);
        let (keep, out): (Vec<Queued>, Vec<Queued>) = all.into_iter().partition(|q| q.written && self.turns.contains_key(&chat_id));
        if !keep.is_empty() {
            self.queue.chats.insert(chat_id, keep);
        }
        self.api_touch(chat_id);
        out
    }

    pub fn queued(&self, chat_id: i64) -> &[Queued] {
        self.queue.chats.get(&chat_id).map(|q| q.as_slice()).unwrap_or_default()
    }

    /// Agent events that move the queue. True when the event is consumed here.
    pub fn queue_event(&mut self, chat_id: i64, ev: &Event) -> bool {
        match ev {
            Event::Result { .. } => {
                // A steer written but not taken in yet: this result ends the segment it cut
                // short; the steer's own turn comes next, and the queue waits for its end.
                let waiting = self.queued(chat_id).iter().any(|q| q.written);
                if !waiting && !self.queue.held.contains(&chat_id) {
                    self.deliver_next(chat_id);
                }
                // Nothing left to deliver: the input closes and Claude exits.
                if !self.queued(chat_id).iter().any(|q| q.written) {
                    if let Some((turn, _)) = self.turns.get(&chat_id) {
                        turn.close_input();
                    }
                }
            }
            Event::UserEcho(text) => {
                let q = self.queue.list(chat_id);
                let found = q.iter().position(|q| q.written && text.contains(q.text.trim()));
                // Replayed after a restart, a message Claude took in earlier has left the
                // queue already: it comes back as the text Claude got.
                if found.is_none() && !text.trim().is_empty() {
                    let tr = self.transcripts.entry(chat_id).or_default();
                    tr.items.push(Item::User { text: text.clone(), files: vec![], at: store::now(), mentions: vec![], sender: String::new(), intent: String::new() });
                    tr.pending_text = None;
                    tr.pending_thinking = None;
                }
                if let Some(i) = found {
                    let m = q.remove(i);
                    let tr = self.transcripts.entry(chat_id).or_default();
                    tr.items.push(m.item());
                    tr.pending_text = None;
                    tr.pending_thinking = None;
                    self.queue.tidy(chat_id);
                    self.persist(chat_id);
                    self.api_touch(chat_id);
                }
                return true;
            }
            _ => {}
        }
        false
    }

    /// Writes the first waiting message into a Claude turn that just gave its result: Claude
    /// runs it next, in the same process.
    fn deliver_next(&mut self, chat_id: i64) {
        let Some(q) = self.queued(chat_id).iter().find(|q| !q.written) else { return };
        let said = self.slash_prompt(chat_id, &q.text);
        let prompt = q.prompt(&said);
        let id = q.id;
        let files = q.files.clone();
        let Some((turn, _)) = self.turns.get(&chat_id) else { return };
        if turn.write(&prompt, &files) {
            if let Some(q) = self.queue.chats.get_mut(&chat_id).and_then(|l| l.iter_mut().find(|q| q.id == id)) {
                q.written = true;
                q.editing.clear();
            }
            self.api_touch(chat_id);
        }
    }

    /// The user stopped the turn: its queue is held until Resume (or the next message).
    pub fn queue_stopped(&mut self, chat_id: i64) {
        if !self.queued(chat_id).is_empty() {
            self.queue.held.insert(chat_id);
            self.api_touch(chat_id);
        }
    }

    /// After a turn's exit: what the agent never took in waits again. A steer that didn't
    /// land goes out at once as a new turn (or, after a Stop, waits at the top, held).
    pub fn queue_exited(&mut self, chat_id: i64, stopped: bool, ctx: &egui::Context) {
        let Some(list) = self.queue.chats.get_mut(&chat_id) else { return };
        let mut steers = vec![];
        list.retain_mut(|q| {
            if !q.written {
                return true;
            }
            q.written = false;
            if q.steering() {
                steers.push(q.clone());
                return false;
            }
            true
        });
        self.api_touch(chat_id);
        if stopped {
            for mut s in steers.into_iter().rev() {
                s.intent.clear();
                s.note = NOT_LANDED.into();
                self.queue.list(chat_id).insert(0, s);
            }
            self.queue_stopped(chat_id);
            return;
        }
        if !steers.is_empty() && !self.turns.contains_key(&chat_id) && !self.is_foreign(chat_id) {
            for s in &mut steers {
                s.intent.clear();
            }
            self.send_queued(chat_id, steers, ctx);
            return;
        }
        // A turn the team started meanwhile: they wait for its end, first in line.
        for mut s in steers.into_iter().rev() {
            s.intent.clear();
            self.queue.list(chat_id).insert(0, s);
        }
        self.queue.tidy(chat_id);
    }

    /// Once per frame: an idle chat's next queued message goes out, unless a Stop holds the
    /// queue or someone else is typing in it (a message sent meanwhile waited; `locked_for`).
    pub fn queue_drain(&mut self, ctx: &egui::Context) {
        let ready: Vec<i64> = self
            .queue
            .chats
            .iter()
            .filter(|(id, q)| !q.is_empty() && !self.turns.contains_key(id) && !self.is_foreign(**id) && !self.queue.held.contains(id))
            .filter(|(id, q)| !self.locked_for(**id, &q[0].device) && self.moving_to(**id).is_none())
            .map(|(id, _)| *id)
            .collect();
        for id in ready {
            let Some(list) = self.queue.chats.get_mut(&id) else { continue };
            let first = list.remove(0);
            self.queue.tidy(id);
            self.api_touch(id);
            self.send_queued(id, vec![first], ctx);
        }
    }

    /// Starts one turn from messages (merged) and puts them in the transcript.
    fn send_queued(&mut self, chat_id: i64, q: Vec<Queued>, ctx: &egui::Context) {
        if q.is_empty() {
            return;
        }
        let prompts: Vec<String> = q.iter().map(|m| m.prompt(&self.slash_prompt(chat_id, &m.text))).collect();
        let tr = self.transcripts.entry(chat_id).or_default();
        if tr.items.is_empty() {
            tr.items = self.store.items(chat_id);
        }
        let mut files = vec![];
        for m in q {
            files.extend(m.files.iter().cloned());
            tr.items.push(m.item());
        }
        self.start_turn(chat_id, prompts.join("\n\n"), files, ctx);
    }

    // ------------------------------------------------------------ queue actions

    /// Resume after a Stop: the next queued message starts (`queue_drain`).
    pub fn queue_resume(&mut self, chat: i64) {
        if self.mesh_forward_pub(chat, "resume the queue", "POST", &["resume"], Value::Null) {
            return;
        }
        self.queue.held.remove(&chat);
        self.api_touch(chat);
    }

    pub fn queue_remove(&mut self, chat: i64, id: u64) -> bool {
        if self.mesh_forward_pub(chat, "remove the queued message", "DELETE", &["queue", &id.to_string()], Value::Null) {
            return true;
        }
        let Some(list) = self.queue.chats.get_mut(&chat) else { return false };
        let n = list.len();
        list.retain(|q| q.id != id || q.written || q.steering());
        let gone = list.len() != n;
        self.queue.tidy(chat);
        self.api_touch(chat);
        gone
    }

    /// Moves queued message `id` to position `to` (0 = next).
    pub fn queue_move(&mut self, chat: i64, id: u64, to: usize) -> bool {
        if self.mesh_forward_pub(chat, "reorder the queue", "POST", &["queue", &id.to_string(), "move"], json!({ "to": to })) {
            return true;
        }
        let moved = self.queue.move_to(chat, id, to);
        self.api_touch(chat);
        moved
    }

    /// An edit of a queued message, in place. `editing`: some device starts or ends editing it.
    pub fn queue_update(&mut self, chat: i64, id: u64, text: Option<String>, mentions: Option<Vec<Mention>>, editing: Option<bool>) -> bool {
        if self.is_foreign(chat) {
            let mut body = json!({});
            if let Some(t) = &text {
                body["text"] = json!(t);
            }
            if let Some(m) = &mentions {
                body["mentions"] = json!(m);
            }
            if let Some(e) = editing {
                body["editing"] = json!(e);
            }
            return self.mesh_forward_pub(chat, "edit the queued message", "PATCH", &["queue", &id.to_string()], body);
        }
        let device = self.sending_device();
        let Some(q) = self.queue.find(chat, id).filter(|q| !q.written) else { return false };
        if let Some(t) = text {
            q.text = t;
        }
        if let Some(m) = mentions {
            q.mentions = m;
        }
        match editing {
            Some(true) => q.editing = device,
            Some(false) => q.editing.clear(),
            None => {}
        }
        q.note.clear();
        self.api_touch(chat);
        true
    }

    /// "Steer" on a queued message: it steers the running turn now ("Send now" when idle).
    pub fn queue_promote(&mut self, chat: i64, id: u64, ctx: &egui::Context) -> bool {
        if self.mesh_forward_pub(chat, "steer with the queued message", "POST", &["queue", &id.to_string(), "steer"], Value::Null) {
            return true;
        }
        let Some(list) = self.queue.chats.get_mut(&chat) else { return false };
        let Some(i) = list.iter().position(|q| q.id == id && !q.written && !q.steering()) else { return false };
        let q = list.remove(i);
        if self.queue.edit.as_ref().is_some_and(|e| e.chat == chat && e.id == id) {
            self.queue_edit_end(ctx, false);
        }
        self.queue.tidy(chat);
        let intent = if self.turns.contains_key(&chat) { PROMOTED } else { STEER };
        self.steer(chat, q, intent, ctx);
        true
    }

    /// The `queue` of the chat status (PROTOCOL.md): waiting messages and steers in flight.
    pub fn queue_json(&self, chat: i64) -> Vec<Value> {
        let held = self.queue_held(chat);
        self.queued(chat)
            .iter()
            .map(|q| {
                let mut v = json!({
                    "id": q.id,
                    "text": q.text,
                    "files": q.files.iter().map(|f| crate::api::file_name(&f.to_string_lossy())).collect::<Vec<_>>(),
                    "sending": q.written,
                });
                if q.steering() {
                    v["intent"] = json!(q.intent);
                } else if held {
                    v["held"] = json!(true);
                }
                if !q.note.is_empty() {
                    v["note"] = json!(q.note);
                }
                if !q.editing.is_empty() {
                    v["editing"] = json!(true);
                }
                v
            })
            .collect()
    }

    /// Changes to the queue the phones should see (with its count and the turn state).
    pub fn queue_hash(&self, chat: i64) -> u64 {
        let q: Vec<_> = self.queued(chat).iter().map(|q| (q.id, &q.text, q.written, &q.intent, &q.note, q.editing.is_empty())).collect();
        crate::api::hash_of(&(q, self.queue.held.contains(&chat), self.steering(chat) != Steering::No))
    }

    // ------------------------------------------------------------ editing (desktop)

    /// The queued message this PC's composer edits in `chat`.
    pub fn queue_editing(&self, chat: i64) -> Option<u64> {
        self.queue.edit.as_ref().filter(|e| e.chat == chat).map(|e| e.id)
    }

    /// Pencil (or Alt+↑): the message goes into the composer, the draft aside meanwhile;
    /// it keeps its place in the queue.
    pub fn queue_edit_start(&mut self, chat: i64, id: u64, ctx: &egui::Context) {
        if self.queue.edit.is_some() {
            self.queue_edit_end(ctx, false);
        }
        let Some(m) = self.shown_queue(chat).into_iter().find(|q| q.id == id && !q.written) else { return };
        let aside = (self.drafts.remove(&chat).unwrap_or_default(), self.files.remove(&chat).unwrap_or_default(), self.mentions.drafts.remove(&chat).unwrap_or_default());
        self.queue.edit = Some(Edit { chat, id, original: m.text.clone(), aside });
        self.queue_update(chat, id, None, None, Some(true));
        let files = if self.is_foreign(chat) { vec![] } else { m.files };
        self.restore_draft(chat, m.text, files, m.mentions, ctx);
    }

    /// Ends the edit: `save` writes the composer into the message (✓ or Enter); either way
    /// the draft set aside comes back.
    pub fn queue_edit_end(&mut self, ctx: &egui::Context, save: bool) {
        let Some(e) = self.queue.edit.take() else { return };
        let text = self.drafts.remove(&e.chat).map(|s| s.trim().to_string()).unwrap_or_default();
        let files = self.files.remove(&e.chat).unwrap_or_default();
        let mentions = self.mentions.drafts.remove(&e.chat).unwrap_or_default();
        let here = self.shown_queue(e.chat).iter().any(|q| q.id == e.id && !q.written);
        // Saved empty: it's removed, as its × would.
        if here && save && text.is_empty() && files.is_empty() && mentions.is_empty() {
            self.queue_remove(e.chat, e.id);
            let (t, f, m) = e.aside;
            self.restore_draft(e.chat, t, f, m, ctx);
            return;
        }
        if here {
            if save && !self.is_foreign(e.chat) {
                if let Some(q) = self.queue.find(e.chat, e.id) {
                    q.files = files;
                }
            }
            self.queue_update(e.chat, e.id, save.then_some(text), save.then_some(mentions), Some(false));
            let (t, f, m) = e.aside;
            self.restore_draft(e.chat, t, f, m, ctx);
            return;
        }
        // It started or was removed meanwhile: changed text stays in the composer, ahead of
        // the draft set aside.
        let (t, f, m) = e.aside;
        self.restore_draft(e.chat, t, f, m, ctx);
        if text != e.original.trim() && !text.is_empty() {
            self.restore_draft(e.chat, text, files, mentions, ctx);
        }
    }

    /// Once per frame: an edit whose message left the queue ends.
    pub fn queue_edit_check(&mut self, ctx: &egui::Context) {
        let Some((chat, id)) = self.queue.edit.as_ref().map(|e| (e.chat, e.id)) else { return };
        if !self.shown_queue(chat).iter().any(|q| q.id == id && !q.written) {
            self.queue_edit_end(ctx, false);
        }
    }

    /// Alt+↑ with the caret at the start: edit the latest queued message.
    pub fn queue_edit_last(&mut self, chat: i64, ctx: &egui::Context) -> bool {
        let Some(id) = self.shown_queue(chat).iter().rev().find(|q| !q.written && q.intent.is_empty()).map(|q| q.id) else { return false };
        self.queue_edit_start(chat, id, ctx);
        true
    }

    /// Ctrl+Shift+Enter: the oldest queued message steers the turn.
    pub fn queue_steer_first(&mut self, chat: i64, ctx: &egui::Context) -> bool {
        let Some(id) = self.shown_queue(chat).iter().find(|q| !q.written && q.intent.is_empty()).map(|q| q.id) else { return false };
        self.queue_promote(chat, id, ctx)
    }

    // ------------------------------------------------------------ drawing

    /// Steers on their way in: the user's bubble, captioned "Steering…" until the agent
    /// takes it in (then it's a transcript item, captioned "Steer").
    pub fn steering_bubbles(&mut self, ui: &mut Ui, chat_id: i64) {
        let t = self.theme.t;
        let steers: Vec<Queued> = self.shown_queue(chat_id).into_iter().filter(|q| q.steering()).collect();
        for m in &steers {
            ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 4.0;
                        w::subtle(ui, "Steering…", "label-12");
                        let (r, _) = ui.allocate_exact_size(Vec2::splat(12.0), Sense::hover());
                        w::spinner(ui.painter(), r.center(), 4.5, t.subtle());
                    });
                });
                let max = (ui.available_width() * 0.75).max(200.0);
                let text = if m.text.is_empty() { format!("{} attachment(s)", m.files.len()) } else { m.text.clone() };
                let galley = ui.painter().layout(text, FontId::proportional(14.0), t.fg(), max - 24.0);
                let size = Vec2::new(galley.size().x + 24.0, galley.size().y + 16.0);
                let (rect, _) = ui.allocate_exact_size(size, Sense::hover());
                ui.painter().rect(rect, CornerRadius::same(RADIUS_LG), t.gray(100), Stroke::new(1.0, t.border()), StrokeKind::Inside);
                ui.painter().galley(pos2(rect.left() + 12.0, rect.top() + 8.0), galley, t.fg());
            });
            ui.add_space(6.0);
        }
    }

    /// "Up next": the queued messages under the running turn, as dashed bubbles; under
    /// each on hover, its place (right-click: move up or down), Edit, Steer (Send now when
    /// idle) and Remove. A message already written into the turn is "Sending", no controls.
    pub fn queued_bubbles(&mut self, ui: &mut Ui, chat_id: i64) {
        let q: Vec<Queued> = self.shown_queue(chat_id).into_iter().filter(|q| !q.steering()).collect();
        if q.is_empty() {
            return;
        }
        let t = self.theme.t;
        let held = self.queue_held(chat_id);
        let running = self.is_running(chat_id);
        let steerable = running && self.can_steer(chat_id) && !held;
        let editing = self.queue_editing(chat_id);
        let waiting = q.iter().filter(|m| !m.written).count();
        // Header: "Up next · 3 queued", and why it waits after a Stop.
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            let label = format!("Up next · {} queued{}", q.len(), if held { " · paused" } else { "" });
            w::subtle(ui, label, "label-12");
            ic::glyph(ui.painter(), ui.cursor().right_center() - Vec2::new(8.0, 0.0), ic::LIST_ORDERED, 13.0, t.subtle());
            ui.add_space(16.0);
        });
        ui.add_space(4.0);
        let fold = q.len() > 3 && !self.queue.unfolded.contains(&chat_id);
        let shown = if fold { 2 } else { q.len() };
        let mut action: Option<(u64, &str)> = None;
        let mut moves: Option<(u64, usize)> = None;
        let mut pos = 0usize;
        for m in q.iter().take(shown) {
            let place = if m.written { None } else { Some(pos) };
            if !m.written {
                pos += 1;
            }
            let mine = editing == Some(m.id);
            ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
                let max = (ui.available_width() * 0.75).max(200.0);
                let font = FontId::proportional(14.0);
                let text = if m.text.is_empty() { format!("{} attachment(s)", m.files.len()) } else { m.text.clone() };
                let ink = if mine { t.fg() } else { t.subtle() };
                let top = if m.written { 23.0 } else { 8.0 };
                let galley = ui.painter().layout(text, font, ink, max - 24.0);
                let size = Vec2::new(galley.size().x + 24.0, galley.size().y + top + 8.0);
                let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
                let p = ui.painter();
                if m.written {
                    p.rect(rect, CornerRadius::same(RADIUS_LG), t.gray(100), Stroke::new(1.0, t.border()), StrokeKind::Inside);
                    p.text(pos2(rect.left() + 12.0, rect.top() + 7.0), Align2::LEFT_TOP, "Sending", FontId::proportional(11.5), t.subtle());
                } else {
                    let line = if mine || !m.editing.is_empty() { Stroke::new(1.0, t.primary()) } else { Stroke::new(1.0, t.subtle().gamma_multiply(0.6)) };
                    dashed_rect(p, rect.shrink(0.5), RADIUS_LG as f32, line);
                }
                p.galley(pos2(rect.left() + 12.0, rect.top() + top), galley, ink);
                if m.written {
                    return;
                }
                // The row under the bubble.
                let hover_row = ui.rect_contains_pointer(rect.expand2(Vec2::new(0.0, 26.0)));
                let row_h = 28.0;
                let (row, _) = ui.allocate_exact_size(Vec2::new(rect.width().max(200.0), row_h), Sense::hover());
                if !m.note.is_empty() {
                    ui.painter().text(pos2(row.left(), row.center().y), Align2::LEFT_CENTER, &m.note, FontId::proportional(11.5), t.destructive());
                }
                if mine || !m.editing.is_empty() {
                    let mut x = row.right();
                    if mine {
                        let r = egui::Rect::from_min_max(pos2(x - 60.0, row.top()), pos2(x, row.bottom()));
                        if w::overlay(ui, r, |ui| w::btn("Cancel").muted().xs().show(ui)).on_hover_text("Cancel the edit (Esc)").clicked() {
                            action = Some((m.id, "cancel"));
                        }
                        x -= 64.0;
                    }
                    let who = if mine { "Editing in the composer" } else { "Being edited on another device" };
                    ui.painter().text(pos2(x - 4.0, row.center().y), Align2::RIGHT_CENTER, who, FontId::proportional(11.5), t.subtle());
                    return;
                }
                if !(hover_row || resp.hovered()) {
                    if waiting > 1 {
                        if let Some(n) = place {
                            ui.painter().text(pos2(row.right() - 4.0, row.center().y), Align2::RIGHT_CENTER, (n + 1).to_string(), FontId::proportional(11.5), t.subtle());
                        }
                    }
                    return;
                }
                let mut x = row.right();
                let mut button = |ui: &mut Ui, icon: &str, label: Option<&str>, tip: &str, act: &'static str, on: bool| {
                    let text = match label {
                        Some(l) => format!("{icon}  {l}"),
                        None => icon.to_string(),
                    };
                    let b = if label.is_some() { w::btn(&text).muted().xs() } else { w::btn(&text).muted().icon_xs() };
                    let wdt = b.width(ui);
                    let r = egui::Rect::from_min_max(pos2(x - wdt, row.top()), pos2(x, row.bottom()));
                    x -= wdt + 2.0;
                    let resp = w::overlay(ui, r, |ui| b.enabled(on).show(ui)).on_hover_text(tip);
                    if resp.clicked() && on {
                        action = Some((m.id, act));
                    }
                };
                button(ui, ic::X, None, "Remove from queue", "remove", true);
                let first = place == Some(0);
                let (label, tip) = if running {
                    ("Steer", if first { "Send as a steer instead (Ctrl+Shift+Enter)" } else { "Send as a steer instead" })
                } else {
                    ("Send now", "Send it now")
                };
                let on = !running || steerable;
                button(ui, ic::CORNER_UP_RIGHT, Some(label), if running && !steerable { "The agent can't be steered now: it waits for the turn to end" } else { tip }, "steer", on);
                let last = place == Some(waiting.saturating_sub(1));
                button(ui, ic::COMPOSE, None, if last { "Edit in the composer (Alt+↑)" } else { "Edit in the composer" }, "edit", true);
                if waiting > 1 {
                    let r = egui::Rect::from_min_max(pos2(x - 28.0, row.top()), pos2(x, row.bottom()));
                    let g = w::overlay(ui, r, |ui| w::btn(ic::GRIP).muted().icon_xs().show(ui)).on_hover_text("Right-click to move it up or down");
                    let n = place.unwrap_or(0);
                    g.context_menu(|ui| {
                        if n > 0 && ui.button("Move up").clicked() {
                            moves = Some((m.id, n - 1));
                            ui.close();
                        }
                        if n + 1 < waiting && ui.button("Move down").clicked() {
                            moves = Some((m.id, n + 1));
                            ui.close();
                        }
                    });
                }
            });
            ui.add_space(4.0);
        }
        if fold {
            ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
                let label = format!("Show all {} queued  {}", q.len(), ic::DOWN);
                if w::btn(&label).muted().xs().show(ui).clicked() {
                    self.queue.unfolded.insert(chat_id);
                }
            });
        }
        ui.add_space(4.0);
        if let Some((id, to)) = moves {
            self.queue_move(chat_id, id, to);
        }
        let ctx = ui.ctx().clone();
        match action {
            Some((id, "remove")) => {
                self.queue_remove(chat_id, id);
            }
            Some((id, "edit")) => self.queue_edit_start(chat_id, id, &ctx),
            Some((_, "cancel")) => self.queue_edit_end(&ctx, false),
            Some((id, "steer")) => {
                self.queue_promote(chat_id, id, &ctx);
            }
            _ => {}
        }
    }
}

/// A queued message from a status' `queue` (another PC's, for its copy here).
fn from_json(m: &Value) -> Queued {
    Queued {
        id: m["id"].as_u64().unwrap_or(0),
        text: m["text"].as_str().unwrap_or("").into(),
        files: m["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(PathBuf::from).collect(),
        mentions: vec![],
        written: m["sending"].as_bool().unwrap_or(false),
        sender: String::new(),
        device: String::new(),
        intent: m["intent"].as_str().unwrap_or("").into(),
        note: m["note"].as_str().unwrap_or("").into(),
        editing: if m["editing"].as_bool() == Some(true) { "elsewhere".into() } else { String::new() },
    }
}

/// A 1 px dashed outline with rounded corners (the "Up next" bubbles).
fn dashed_rect(p: &egui::Painter, r: egui::Rect, radius: f32, stroke: Stroke) {
    let mut pts = vec![];
    let corner = |c: egui::Pos2, from: f32| (0..=6).map(move |i| c + Vec2::angled(from + i as f32 / 6.0 * std::f32::consts::FRAC_PI_2) * radius);
    let rr = radius;
    pts.extend(corner(pos2(r.right() - rr, r.top() + rr), -std::f32::consts::FRAC_PI_2));
    pts.extend(corner(pos2(r.right() - rr, r.bottom() - rr), 0.0));
    pts.extend(corner(pos2(r.left() + rr, r.bottom() - rr), std::f32::consts::FRAC_PI_2));
    pts.extend(corner(pos2(r.left() + rr, r.top() + rr), std::f32::consts::PI));
    pts.push(pts[0]);
    p.extend(Shape::dashed_line(&pts, stroke, 4.0, 3.0));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(id: u64, text: &str) -> Queued {
        Queued { id, text: text.into(), files: vec![], mentions: vec![], written: false, sender: String::new(), device: String::new(), intent: String::new(), note: String::new(), editing: String::new() }
    }

    #[test]
    fn sent_from_says_where_the_user_is() {
        assert_eq!(sent_from("", "pc:me", false), "");
        assert!(sent_from("", "pc:me", true).contains("the PC running Harbor"));
        assert!(sent_from("Pixel", "tok:0000abcd", false).contains("phone ('Pixel')"));
        assert!(sent_from("desk", "pc:desk", false).contains("Harbor on 'desk', another PC"));
        // A queued slash command still starts its prompt.
        let m = Queued { sender: "Pixel".into(), device: "tok:1".into(), ..q(1, "/review") };
        let p = m.prompt("/review");
        assert!(p.starts_with("/review\n\n[The user sent this"), "{p}");
        let m = Queued { text: "hi".into(), ..m };
        assert!(m.prompt("hi").ends_with("not from this PC.]\n\nhi"));
    }

    #[test]
    fn queue_moves_skip_steers_and_written() {
        let mut s = State::default();
        let mut sending = q(1, "sending");
        sending.written = true;
        let mut steer = q(2, "steer");
        steer.intent = STEER.into();
        steer.written = true;
        s.chats.insert(7, vec![sending, steer, q(3, "a"), q(4, "b"), q(5, "c")]);
        let order = |s: &State| s.chats[&7].iter().map(|q| q.id).collect::<Vec<_>>();
        assert!(s.move_to(7, 5, 0));
        assert_eq!(order(&s), [1, 2, 5, 3, 4]);
        assert!(s.move_to(7, 5, 9), "past the end: last");
        assert_eq!(order(&s), [1, 2, 3, 4, 5]);
        assert!(!s.move_to(7, 2, 0), "a steer isn't reordered");
        assert!(!s.move_to(7, 1, 0), "nor one being written");
        assert!(s.find(7, 2).is_none(), "steers aren't edited");
        assert_eq!(s.find(7, 4).map(|q| q.text.clone()).as_deref(), Some("b"));
    }

    #[test]
    fn modes_round_trip() {
        for m in [Mode::Queue, Mode::Steer] {
            assert_eq!(Mode::parse(m.as_str()), Some(m));
            assert_eq!(m.opposite().opposite(), m);
        }
        assert_eq!(Mode::parse("later"), None);
    }

    #[test]
    fn queued_item_keeps_the_intent() {
        let mut m = q(1, "also print the square");
        m.intent = PROMOTED.into();
        let Item::User { text, intent, .. } = m.item() else { panic!() };
        assert_eq!((text.as_str(), intent.as_str()), ("also print the square", "promoted"));
    }

    #[test]
    fn old_snapshots_restore_with_ids() {
        // Before 0.69: the map alone, no ids.
        let old = json!({ "4": [{ "text": "a", "files": [], "mentions": [], "written": false }, { "text": "b", "files": [], "mentions": [], "written": false }] });
        let mut st = State::default();
        let (chats, _) = (old.clone(), ());
        st.chats = serde_json::from_value(chats).unwrap();
        assert_eq!(st.chats[&4].len(), 2);
        let snap = json!({ "chats": { "4": [{ "id": 9, "text": "a", "files": [], "mentions": [], "written": false }] }, "held": [4] });
        assert!(snap.get("chats").is_some() && old.get("chats").is_none());
        let held: BTreeSet<i64> = serde_json::from_value(snap["held"].clone()).unwrap();
        assert!(held.contains(&4));
    }
}
