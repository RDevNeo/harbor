//! Esc as "undo send": a message whose turn has produced nothing yet goes back to
//! the composer, as if it was never sent.
//!
//! - Queued behind a running turn: the queue comes back (see queue.rs); the
//!   running turn goes on.
//! - Started, with no reply text and no tool call yet (thinking only counts as
//!   nothing within the first few seconds): the turn is killed and rewound.
//!
//! Session consistency: a Claude turn writes the user message to its session
//! JSONL as soon as it starts, so a later `--resume` would still see it. Harbor
//! remembers the file's length before the turn and, once the process is gone,
//! truncates it back (or deletes it for a session this turn created), restoring the
//! chat's session id and started flag too. Claude Code's own rewind branches the
//! message tree instead; cutting the tail leaves the same conversation for the
//! next `--resume`. Other providers keep sessions Harbor can't rewind safely, so
//! there only queued messages are undone and a started turn just stops.

use crate::app::{App, Dialog};
use crate::providers::Kind;
use crate::mentions::Mention;
use crate::store::{Item, Role};
use crate::widgets as w;
use eframe::egui;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Thinking alone still counts as "nothing yet" for this long.
const GRACE: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct State {
    /// Per chat, the message that started the running turn.
    started: HashMap<i64, Started>,
    /// Chats whose undone turn hasn't reported its exit yet: their events are dropped.
    swallow: HashSet<i64>,
}

struct Sent {
    /// Index of its `Item::User` in the transcript.
    item: usize,
    at: i64,
    text: String,
    files: Vec<PathBuf>,
    mentions: Vec<Mention>,
}

pub struct Started {
    sent: Sent,
    /// The turn's start, to tell it from later turns.
    turn: Instant,
    /// Queued prompts that went into this turn ahead of the message.
    consumed: Vec<String>,
    session_id: String,
    was_started: bool,
    /// The Claude session file and its length before the turn (None: not there yet).
    jsonl: Option<(Option<PathBuf>, Option<u64>)>,
}

/// The Claude session file for `sid` under the account's config dir, if it exists: the
/// newest copy (a moved chat leaves its old one behind, movechat.rs).
pub fn session_file(config: &Option<PathBuf>, sid: &str) -> Option<PathBuf> {
    crate::movechat::session_copies(config, sid).into_iter().next()
}

impl App {
    /// Called by `send` before it starts a turn: what undoing it must restore.
    pub fn undo_snapshot(&self, chat_id: i64, item: usize, text: &str, files: &[PathBuf], mentions: &[Mention], consumed: &[String]) -> Option<Started> {
        let chat = self.chat(chat_id)?;
        let acc = self.account(&chat.account)?;
        let jsonl = (acc.kind == Kind::Claude).then(|| {
            // The copy the turn will write: a moved chat's is brought to its folder first.
            if chat.started && !chat.session_id.is_empty() && chat.device.is_empty() {
                let _ = crate::movechat::ensure_session(&acc.config_dir, &chat.session_id, &self.chat_cwd(&chat));
            }
            let path = (chat.started && !chat.session_id.is_empty()).then(|| session_file(&acc.config_dir, &chat.session_id)).flatten();
            let len = path.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len());
            (path, len)
        });
        Some(Started {
            sent: Sent {
                item,
                at: self.user_at(chat_id, item),
                text: text.into(),
                files: files.to_vec(),
                mentions: mentions.to_vec(),
            },
            turn: Instant::now(),
            consumed: consumed.to_vec(),
            session_id: chat.session_id.clone(),
            was_started: chat.started,
            jsonl,
        })
    }

    /// Called by `send` after `start_turn`: the snapshot belongs to the turn now running.
    pub fn undo_started(&mut self, chat_id: i64, snap: Option<Started>) {
        match (snap, self.turns.get(&chat_id)) {
            (Some(mut s), Some((_, at))) => {
                s.turn = *at;
                self.undo.started.insert(chat_id, s);
            }
            _ => {
                self.undo.started.remove(&chat_id);
            }
        }
    }

    fn user_at(&self, chat_id: i64, item: usize) -> i64 {
        match self.transcripts.get(&chat_id).and_then(|t| t.items.get(item)) {
            Some(Item::User { at, .. }) => *at,
            _ => 0,
        }
    }

    /// Drops the chat's events up to the exit of the turn just killed.
    pub fn undo_swallow(&mut self, chat_id: i64) {
        self.undo.swallow.insert(chat_id);
    }

    /// True for events of a turn that was undone: they are dropped, up to its exit.
    pub fn undo_swallows(&mut self, chat_id: i64, ev: &crate::agent::Event) -> bool {
        if !self.undo.swallow.contains(&chat_id) {
            return false;
        }
        if matches!(ev, crate::agent::Event::Exited { .. }) {
            self.undo.swallow.remove(&chat_id);
        }
        true
    }

    /// Esc in a chat: undo the last send if nothing came of it yet, else stop.
    pub fn esc(&mut self, chat_id: i64, ctx: &egui::Context) {
        if !self.try_undo(chat_id, ctx) {
            self.stop(chat_id);
        }
    }

    /// The composer's Stop: like Esc, but it stops even with messages queued, and a
    /// lead with subagents running asks first whether to stop the whole team.
    pub fn stop_pressed(&mut self, chat_id: i64, ctx: &egui::Context) {
        // Queued messages go back to the composer, and the turn still stops.
        if !self.unqueue(chat_id, ctx) && self.try_undo(chat_id, ctx) {
            return;
        }
        if self.chat(chat_id).is_some_and(|c| c.role == Role::Lead) && !self.running_subs(chat_id).is_empty() {
            self.dialog = Some(Dialog::StopAll(chat_id));
        } else {
            self.stop(chat_id);
        }
    }

    /// Stops the lead and its running subagents, and clears their queues.
    pub fn stop_all(&mut self, lead: i64) {
        for c in self.subs_of(lead) {
            self.pending.remove(&c.id);
            self.stop(c.id);
        }
        self.pending.remove(&lead);
        self.stop(lead);
    }

    /// The body of the "Stop all" confirmation (Esc or a click outside cancels).
    pub fn stop_all_dialog(&mut self, ui: &mut egui::Ui, lead: i64, close: &mut bool) {
        let n = self.running_subs(lead).len();
        let subs = if n == 1 { "1 running sub-agent".to_string() } else { format!("{n} running sub-agents") };
        let title = if self.turns.contains_key(&lead) { format!("Stop the main agent and {subs}?") } else { format!("Stop {subs}?") };
        w::text(ui, title, "heading-20");
        ui.add_space(4.0);
        w::subtle(ui, "Sub-agent queues are cleared; your queued messages come back to the composer. Finished work and transcripts stay.", "copy-14");
        ui.add_space(16.0);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
            if w::btn("Stop all").variant(w::Variant::Destructive).show(ui).clicked() {
                self.stop_all(lead);
                *close = true;
            }
            if w::btn("Cancel").outline().show(ui).clicked() {
                *close = true;
            }
        });
        // Nothing left to stop (they finished meanwhile): the question is moot.
        if n == 0 && !self.turns.contains_key(&lead) {
            *close = true;
        }
    }

    /// Undoes the last send if nothing came of it yet; false when there is none.
    fn try_undo(&mut self, chat_id: i64, ctx: &egui::Context) -> bool {
        // Queued messages come back first; the turn goes on.
        if self.unqueue(chat_id, ctx) {
            return true;
        }
        // Only Claude turns can be rewound (see above); others just stop.
        let undoable = match (self.undo.started.get(&chat_id), self.turns.get(&chat_id)) {
            (Some(s), Some((_, at))) => s.turn == *at && s.jsonl.is_some() && self.nothing_yet(chat_id, s),
            _ => false,
        };
        let Some(s) = self.undo.started.remove(&chat_id).filter(|_| undoable) else { return false };
        self.rewind(chat_id, s, ctx);
        true
    }

    /// No reply text, no tool call, no result since the message; thinking only briefly.
    fn nothing_yet(&self, chat_id: i64, s: &Started) -> bool {
        let Some(tr) = self.transcripts.get(&chat_id) else { return false };
        let Some(i) = self.find_user(chat_id, &s.sent) else { return false };
        let mut thinking = false;
        for it in &tr.items[i + 1..] {
            match it {
                Item::Thinking { .. } => thinking = true,
                Item::Text { .. } | Item::Tool { .. } | Item::Result { .. } | Item::Error { .. } => return false,
                _ => {}
            }
        }
        !thinking || s.turn.elapsed() < GRACE
    }

    /// Where the message's item is now (indices shift when earlier items go).
    fn find_user(&self, chat_id: i64, s: &Sent) -> Option<usize> {
        let items = &self.transcripts.get(&chat_id)?.items;
        let is = |it: &Item| matches!(it, Item::User { text, at, .. } if *text == s.text && *at == s.at);
        if items.get(s.item).is_some_and(is) {
            return Some(s.item);
        }
        items.iter().rposition(is)
    }

    /// Removes the message's item and the thinking that followed it.
    fn remove_user_item(&mut self, chat_id: i64, s: &Sent) {
        let Some(i) = self.find_user(chat_id, s) else { return };
        let tr = self.transcripts.get_mut(&chat_id).unwrap();
        tr.items.remove(i);
        let mut k = i;
        while k < tr.items.len() {
            if matches!(tr.items[k], Item::Thinking { .. }) {
                tr.items.remove(k);
            } else {
                k += 1;
            }
        }
        tr.pending_text = None;
        tr.pending_thinking = None;
        self.persist(chat_id);
    }

    /// Kills the turn, cuts its session file back and takes the message out.
    fn rewind(&mut self, chat_id: i64, s: Started, ctx: &egui::Context) {
        let Some((turn, _)) = self.turns.remove(&chat_id) else { return };
        turn.stop_wait();
        self.undo.swallow.insert(chat_id);
        let config = self.chat(chat_id).and_then(|c| self.account(&c.account)).and_then(|a| a.config_dir.clone());
        match s.jsonl {
            Some((Some(path), Some(len))) => {
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&path) {
                    let _ = f.set_len(len);
                }
            }
            // The turn created the file (a new session, or a resumed one with no file yet).
            Some(_) => {
                if let Some(p) = session_file(&config, &s.session_id) {
                    let _ = std::fs::remove_file(p);
                }
            }
            None => {}
        }
        if let Some(c) = self.chat_mut(chat_id) {
            c.session_id = s.session_id.clone();
            c.started = s.was_started;
        }
        self.remove_user_item(chat_id, &s.sent);
        // The turn ended as a stop (frees a subagent slot); queued prompts it took wait again.
        let later = self.pending.remove(&chat_id).unwrap_or_default();
        self.after_turn(chat_id, true, ctx);
        let mut q = s.consumed;
        q.extend(later);
        q.extend(self.pending.remove(&chat_id).unwrap_or_default());
        if !q.is_empty() {
            self.pending.insert(chat_id, q);
        }
        self.restore_draft(chat_id, s.sent.text, s.sent.files, s.sent.mentions, ctx);
    }

    /// Puts an undone message back in the chat's composer (with its attachments and
    /// mentions), cursor at the end. A draft typed since stays, after the restored text.
    pub fn restore_draft(&mut self, chat_id: i64, text: String, files: Vec<PathBuf>, mentions: Vec<Mention>, ctx: &egui::Context) {
        let draft = self.drafts.remove(&chat_id).unwrap_or_default();
        let joined = if draft.trim().is_empty() { text } else { format!("{text}\n{draft}") };
        let mut f = files;
        f.extend(self.files.remove(&chat_id).unwrap_or_default());
        if !f.is_empty() {
            self.files.insert(chat_id, f);
        }
        let mut m = mentions;
        for x in self.mentions.drafts.remove(&chat_id).unwrap_or_default() {
            if !m.iter().any(|y| y.item == x.item) {
                m.push(x);
            }
        }
        if !m.is_empty() {
            self.mentions.drafts.insert(chat_id, m);
        }
        let id = egui::Id::NULL.with(("composer", chat_id));
        let mut state = egui::text_edit::TextEditState::load(ctx, id).unwrap_or_default();
        let end = joined.chars().count();
        state.cursor.set_char_range(Some(egui::text::CCursorRange::one(egui::text::CCursor::new(end))));
        state.store(ctx, id);
        self.drafts.insert(chat_id, joined);
        self.focus_composer = true;
    }
}
