//! Messages sent while a turn runs wait in a queue, as in Claude Code.
//!
//! A Claude turn keeps its input open: a queued message is written into it at the
//! next safe point, when a tool call starts (Claude takes it in once that tool is
//! done) or, if the turn ends first, right after its result (Claude then runs it
//! as the next turn in the same process). `--replay-user-messages` echoes each one
//! as Claude takes it in; only then does it join the transcript. The input closes
//! after a result when nothing is left to deliver. Providers that take no input
//! mid-turn get the queue, merged, as the next turn once the current one ends.
//!
//! Until written, a queued message can be edited or removed. Esc pulls the queue
//! back into the composer; a stopped turn returns its undelivered messages there
//! too. Ctrl+Enter interrupts the turn and sends queue and composer as one turn.

use crate::agent::Event;
use crate::app::App;
use crate::icons as ic;
use crate::mentions::Mention;
use crate::store::{self, Item};
use crate::theme::RADIUS_LG;
use crate::widgets as w;
use eframe::egui::{self, Align2, CornerRadius, FontId, Sense, Stroke, StrokeKind, Ui, Vec2, pos2};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Queued {
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
}

impl Queued {
    /// What the agent gets: mentioned messages quoted first, then the text as `said`
    /// (slash.rs puts commands in for agents that don't expand them).
    fn prompt(&self, said: &str) -> String {
        format!("{}{said}", crate::mentions::prompt(&self.mentions))
    }
}

#[derive(Default)]
pub struct State {
    chats: HashMap<i64, Vec<Queued>>,
}

impl App {
    /// Called by `send` while the chat's turn runs.
    pub fn enqueue(&mut self, chat_id: i64, text: String, files: Vec<PathBuf>, mentions: Vec<Mention>) {
        let (sender, device) = (self.sender.clone(), self.sending_device());
        self.queue.chats.entry(chat_id).or_default().push(Queued { text, files, mentions, written: false, sender, device });
        // A tool is running: Claude takes it in when that tool is done.
        if self.tool_running(chat_id) {
            self.deliver(chat_id);
        }
    }

    /// The queues, for the next process after a reload.
    pub fn queue_snapshot(&self) -> serde_json::Value {
        serde_json::to_value(&self.queue.chats).unwrap_or_default()
    }

    pub fn queue_restore(&mut self, v: &serde_json::Value) {
        if let Ok(chats) = serde_json::from_value::<HashMap<i64, Vec<Queued>>>(v.clone()) {
            self.queue.chats = chats;
        }
    }

/// Takes a chat's waiting messages out of the queue (a phone's Stop hands them back to it).
    pub fn take_queue(&mut self, chat_id: i64) -> Vec<Queued> {
        self.queue.chats.remove(&chat_id).unwrap_or_default()
    }

    pub fn queued(&self, chat_id: i64) -> &[Queued] {
        self.queue.chats.get(&chat_id).map(|q| q.as_slice()).unwrap_or_default()
    }

    fn tool_running(&self, chat_id: i64) -> bool {
        let Some(tr) = self.transcripts.get(&chat_id) else { return false };
        let since = tr.items.iter().rposition(|it| matches!(it, Item::User { .. })).unwrap_or(0);
        tr.items[since..].iter().any(|it| matches!(it, Item::Tool { result: None, .. }))
    }

    /// Writes the waiting messages into the running turn, if it takes input.
    fn deliver(&mut self, chat_id: i64) {
        let said: Vec<String> = self.queued(chat_id).iter().map(|q| self.slash_prompt(chat_id, &q.text)).collect();
        let Some((turn, _)) = self.turns.get(&chat_id) else { return };
        for (q, said) in self.queue.chats.get_mut(&chat_id).into_iter().flatten().zip(&said).filter(|(q, _)| !q.written) {
            if !turn.write(&q.prompt(said), &q.files) {
                return;
            }
            q.written = true;
        }
    }

    /// Agent events that move the queue. True when the event is consumed here.
    pub fn queue_event(&mut self, chat_id: i64, ev: &Event) -> bool {
        match ev {
            Event::Tool { result: None, .. } => self.deliver(chat_id),
            Event::Result { .. } => {
                // Whatever still waits becomes the next turn in the same process;
                // with nothing left, the input closes and Claude exits.
                self.deliver(chat_id);
                let waiting = self.queued(chat_id).iter().any(|q| q.written);
                if !waiting {
                    if let Some((turn, _)) = self.turns.get(&chat_id) {
                        turn.close_input();
                    }
                }
            }
            Event::UserEcho(text) => {
                let q = self.queue.chats.entry(chat_id).or_default();
                let found = q.iter().position(|q| q.written && text.contains(q.text.trim()));
                // Replayed after a restart, a message Claude took in earlier has left the
                // queue already: it comes back as the text Claude got.
                if found.is_none() && !text.trim().is_empty() {
                    let tr = self.transcripts.entry(chat_id).or_default();
                    tr.items.push(Item::User { text: text.clone(), files: vec![], at: store::now(), mentions: vec![], sender: String::new() });
                    tr.pending_text = None;
                    tr.pending_thinking = None;
                }
                if let Some(i) = found {
                    let m = q.remove(i);
                    let tr = self.transcripts.entry(chat_id).or_default();
                    tr.items.push(Item::User {
                        text: m.text,
                        files: m.files.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                        at: store::now(),
                        mentions: m.mentions,
                        sender: m.sender,
                    });
                    tr.pending_text = None;
                    tr.pending_thinking = None;
                    self.persist(chat_id);
                }
                return true;
            }
            _ => {}
        }
        false
    }

    /// After a turn's exit: a stopped turn hands its queue back to the composer;
    /// otherwise what is left goes out as the next turn.
    pub fn queue_exited(&mut self, chat_id: i64, stopped: bool, ctx: &egui::Context) {
        if self.queued(chat_id).is_empty() {
            return;
        }
        if stopped {
            self.unqueue(chat_id, ctx);
            return;
        }
        // A turn the team started meanwhile takes it, or it waits for that one.
        if self.turns.contains_key(&chat_id) {
            for q in self.queue.chats.get_mut(&chat_id).into_iter().flatten() {
                q.written = false;
            }
            self.deliver(chat_id);
            return;
        }
        let q = self.queue.chats.remove(&chat_id).unwrap_or_default();
        self.send_queued(chat_id, q, ctx);
    }

    /// Once per frame: an idle chat's queue goes out once nobody else is typing in it (a
    /// message sent while another device was typing waited for that; see `locked_for`).
    pub fn queue_drain(&mut self, ctx: &egui::Context) {
        let ready: Vec<i64> = self
            .queue
            .chats
            .iter()
            .filter(|(id, q)| !q.is_empty() && !self.turns.contains_key(id) && !self.is_foreign(**id))
            .filter(|(id, q)| !self.locked_for(**id, &q[0].device))
            .map(|(id, _)| *id)
            .collect();
        for id in ready {
            let q = self.queue.chats.remove(&id).unwrap_or_default();
            self.send_queued(id, q, ctx);
        }
    }

    /// Starts one turn from queued messages (merged) and puts them in the transcript.
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
            tr.items.push(Item::User {
                text: m.text,
                files: m.files.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                at: store::now(),
                mentions: m.mentions,
                sender: m.sender,
            });
        }
        self.start_turn(chat_id, prompts.join("\n\n"), files, ctx);
    }

    /// Esc: the queue goes back to the composer (the turn keeps running). False when
    /// nothing was waiting.
    pub fn unqueue(&mut self, chat_id: i64, ctx: &egui::Context) -> bool {
        let q = self.queue.chats.remove(&chat_id).unwrap_or_default();
        if q.is_empty() {
            return false;
        }
        // Already written ones stay with Claude; only a stopped turn returns them.
        let (keep, back): (Vec<Queued>, Vec<Queued>) = q.into_iter().partition(|m| m.written && self.turns.contains_key(&chat_id));
        if !keep.is_empty() {
            self.queue.chats.insert(chat_id, keep);
        }
        if back.is_empty() {
            return false;
        }
        let text = back.iter().map(|m| m.text.as_str()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
        let files = back.iter().flat_map(|m| m.files.iter().cloned()).collect();
        let mentions = back.into_iter().flat_map(|m| m.mentions).collect();
        self.restore_draft(chat_id, text, files, mentions, ctx);
        true
    }

    /// Ctrl+Enter: interrupts the turn (its output stays) and sends the queue plus
    /// the composer as one new turn.
    pub fn send_now(&mut self, ctx: &egui::Context) {
        let key = self.key();
        if !self.turns.contains_key(&key) {
            self.send(ctx);
            return;
        }
        let mut q = self.queue.chats.remove(&key).unwrap_or_default();
        let text = self.drafts.remove(&key).map(|s| s.trim().to_string()).unwrap_or_default();
        let files = self.files.remove(&key).unwrap_or_default();
        let mentions = self.mentions.drafts.remove(&key).unwrap_or_default();
        if !text.is_empty() || !files.is_empty() || !mentions.is_empty() {
            q.push(Queued { text, files, mentions, written: false, sender: String::new(), device: String::new() });
        }
        if q.is_empty() {
            return;
        }
        // Killed and waited for, so the next turn resumes a settled session; its exit
        // event is dropped (it would otherwise end the new turn).
        if let Some((turn, _)) = self.turns.remove(&key) {
            turn.stop_wait();
            self.undo_swallow(key);
            if let Some(tr) = self.transcripts.get_mut(&key) {
                tr.items.push(Item::Error { text: "Interrupted.".into() });
                tr.pending_text = None;
                tr.pending_thinking = None;
            }
        }
        self.send_queued(key, q, ctx);
        self.focus_composer = true;
    }

    /// The queued messages under the running turn: dimmed bubbles; on hover, edit
    /// (back to the composer) and remove, until Claude has them.
    pub fn queued_bubbles(&mut self, ui: &mut Ui, chat_id: i64) {
        // A copy: the shared queue as its home PC has it (changed there, shown here).
        let copy = self.mesh.status.get(&chat_id).map(|r| {
            r.status["queue"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| Queued {
                    text: m["text"].as_str().unwrap_or("").into(),
                    files: m["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(PathBuf::from).collect(),
                    mentions: vec![],
                    written: m["sending"].as_bool().unwrap_or(false),
                    sender: String::new(),
                    device: String::new(),
                })
                .collect::<Vec<_>>()
        });
        let shared = copy.is_some();
        let q = copy.unwrap_or_else(|| self.queued(chat_id).to_vec());
        if q.is_empty() {
            return;
        }
        let t = self.theme.t;
        let mut action = None;
        for (i, m) in q.iter().enumerate() {
            ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
                let max = (ui.available_width() * 0.75).max(200.0);
                let label = if m.written { "Sending" } else { "Queued" };
                let font = FontId::proportional(14.0);
                let text = if m.text.is_empty() { format!("{} attachment(s)", m.files.len()) } else { m.text.clone() };
                let galley = ui.painter().layout(text, font, t.fg().gamma_multiply(0.55), max - 24.0);
                let size = Vec2::new(galley.size().x + 24.0, galley.size().y + 30.0);
                let (rect, resp) = ui.allocate_exact_size(size, Sense::hover());
                let p = ui.painter();
                p.rect(rect, CornerRadius::same(RADIUS_LG), t.gray(100), Stroke::new(1.0, t.border()), StrokeKind::Inside);
                p.text(pos2(rect.left() + 12.0, rect.top() + 7.0), Align2::LEFT_TOP, label, FontId::proportional(11.5), t.subtle());
                p.galley(pos2(rect.left() + 12.0, rect.top() + 23.0), galley, t.fg());
                if resp.hovered() && !m.written && !shared {
                    let mut x = rect.right() - 26.0;
                    for (icon, tip, act) in [(ic::X, "Remove", 0), (ic::COMPOSE, "Edit", 1)] {
                        let br = egui::Rect::from_min_size(pos2(x, rect.top() + 3.0), Vec2::splat(22.0));
                        if w::overlay(ui, br, |ui| w::btn(icon).muted().icon_sm().show(ui)).on_hover_text(tip).clicked() {
                            action = Some((i, act));
                        }
                        x -= 24.0;
                    }
                }
            });
            ui.add_space(6.0);
        }
        if let Some((i, act)) = action {
            let Some(list) = self.queue.chats.get_mut(&chat_id) else { return };
            if i < list.len() && !list[i].written {
                let m = list.remove(i);
                if act == 1 {
                    self.restore_draft(chat_id, m.text, m.files, m.mentions, ui.ctx());
                }
            }
        }
    }
}
