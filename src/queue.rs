//! Messages sent while a turn runs steer it: the agent gets them as soon as it can take
//! them, with no queue for the user to manage.
//!
//! Claude keeps its input open during a turn, and a message is written into it at once.
//! Claude Code takes it in at the next tool boundary, as soon as the running tool calls
//! are done and before it asks the model again ("The user sent a new message while you
//! were working"), so it changes the rest of the turn. A reply with no tool call left
//! (plain text to the end) has no such boundary: the message then runs right after the
//! result as the next turn of the same process. That is still the fastest steer that
//! loses nothing: interrupting would cut off a reply that's about to end and restart the
//! CLI. `--replay-user-messages` echoes each message as Claude takes it in; until then it
//! shows under the transcript, marked "Steering…", and joins the transcript with the
//! echo. The input closes after a result when nothing is left to deliver; a message sent
//! after that (the turn is ending) starts the next turn once it has exited.
//!
//! The other CLIs Harbor runs (Codex `exec`, Cursor, Gemini, Grok, OpenCode, Meta) take
//! one prompt per process and have no way in mid-turn, so a message interrupts the turn
//! (its output so far stays) and resumes the same session with it, telling the agent it
//! was interrupted to be steered. A turn that already has its result just ends, and the
//! message starts the next one.
//!
//! A stopped turn hands back to the composer what it hadn't taken in yet.

use crate::agent::Event;
use crate::app::App;
use crate::mentions::Mention;
use crate::store::{self, Item};
use crate::theme::{self, RADIUS_LG};
use crate::widgets as w;
use eframe::egui::{self, Align, CornerRadius, Frame, Layout, Margin, RichText, Ui, Vec2};
use std::collections::HashMap;
use std::path::PathBuf;

/// A message on its way into the running turn.
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
    /// The device that wrote it.
    #[serde(default)]
    pub device: String,
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

/// How a message sent while a turn runs reaches the agent.
#[derive(Debug, PartialEq)]
pub enum Route {
    /// Into the running turn's input (Claude).
    Write,
    /// The turn is ending: the message starts the next one.
    Wait,
    /// The CLI takes nothing mid-turn: stop it and resume the session with the message.
    Interrupt,
}

/// `steerable`: the agent reads input mid-turn; `open`: its input still takes messages;
/// `finished`: the turn has its result already.
pub fn route(steerable: bool, open: bool, finished: bool) -> Route {
    match (steerable, open, finished) {
        (true, true, _) => Route::Write,
        (true, false, _) | (false, _, true) => Route::Wait,
        (false, _, false) => Route::Interrupt,
    }
}

/// Whether the transcript's last turn has its result (nothing after the last message).
pub fn finished(items: &[Item]) -> bool {
    let since = items.iter().rposition(|it| matches!(it, Item::User { .. })).unwrap_or(0);
    items[since..].iter().any(|it| matches!(it, Item::Result { .. }))
}

/// The prompt that resumes an interrupted turn: the agent learns why it stopped.
pub fn steer_prompt(prompt: &str) -> String {
    format!("[Harbor interrupted your previous turn so the user could steer you with this message. Continue from where you stopped, following it.]\n\n{prompt}")
}

#[derive(Default)]
pub struct State {
    chats: HashMap<i64, Vec<Queued>>,
}

impl App {
    /// Called by `send_to` while the chat's turn runs: the message steers it.
    pub fn steer(&mut self, chat_id: i64, text: String, files: Vec<PathBuf>, mentions: Vec<Mention>, ctx: &egui::Context) {
        let (sender, device) = (self.sender.clone(), self.sending_device());
        let q = Queued { text, files, mentions, written: false, sender, device };
        let Some((turn, _)) = self.turns.get(&chat_id) else { return };
        let done = self.transcripts.get(&chat_id).is_some_and(|t| finished(&t.items));
        match route(turn.steerable(), turn.input_open(), done) {
            Route::Write | Route::Wait => {
                self.queue.chats.entry(chat_id).or_default().push(q);
                self.deliver(chat_id);
            }
            Route::Interrupt => {
                let mut q = vec![q];
                // Anything still waiting goes along (from a Harbor before steering).
                q.splice(0..0, self.queue.chats.remove(&chat_id).unwrap_or_default());
                self.interrupt(chat_id, q, ctx);
            }
        }
    }

    /// The messages on their way, for the next process after a reload.
    pub fn queue_snapshot(&self) -> serde_json::Value {
        serde_json::to_value(&self.queue.chats).unwrap_or_default()
    }

    pub fn queue_restore(&mut self, v: &serde_json::Value) {
        if let Ok(chats) = serde_json::from_value::<HashMap<i64, Vec<Queued>>>(v.clone()) {
            self.queue.chats = chats;
        }
    }

    /// Takes a chat's messages that the agent hasn't taken in (a phone's Stop hands them back to it).
    pub fn take_queue(&mut self, chat_id: i64) -> Vec<Queued> {
        self.queue.chats.remove(&chat_id).unwrap_or_default()
    }

    pub fn queued(&self, chat_id: i64) -> &[Queued] {
        self.queue.chats.get(&chat_id).map(|q| q.as_slice()).unwrap_or_default()
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

    /// Agent events that move the messages on their way. True when the event is consumed here.
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

    /// After a turn's exit: a stopped turn hands back what it hadn't taken in;
    /// otherwise that goes out as the next turn.
    pub fn queue_exited(&mut self, chat_id: i64, stopped: bool, ctx: &egui::Context) {
        if self.queued(chat_id).is_empty() {
            return;
        }
        if stopped {
            self.hand_back(chat_id, ctx);
            return;
        }
        // A turn the team started meanwhile takes it.
        if self.turns.contains_key(&chat_id) {
            for q in self.queue.chats.get_mut(&chat_id).into_iter().flatten() {
                q.written = false;
            }
            self.deliver(chat_id);
            return;
        }
        let q = self.queue.chats.remove(&chat_id).unwrap_or_default();
        self.send_queued(chat_id, q, None, ctx);
    }

    /// Once per frame: messages left for an idle chat (after a reload, say) go out.
    pub fn queue_drain(&mut self, ctx: &egui::Context) {
        let ready: Vec<i64> = self.queue.chats.iter().filter(|(id, q)| !q.is_empty() && !self.turns.contains_key(id) && !self.is_foreign(**id)).map(|(id, _)| *id).collect();
        for id in ready {
            let q = self.queue.chats.remove(&id).unwrap_or_default();
            self.send_queued(id, q, None, ctx);
        }
    }

    /// Starts one turn from the messages (merged) and puts them in the transcript;
    /// `wrap` frames the prompt (an interrupted turn says why).
    fn send_queued(&mut self, chat_id: i64, q: Vec<Queued>, wrap: Option<fn(&str) -> String>, ctx: &egui::Context) {
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
        let prompt = prompts.join("\n\n");
        let prompt = match wrap {
            Some(f) => f(&prompt),
            None => prompt,
        };
        self.start_turn(chat_id, prompt, files, ctx);
    }

    /// A stopped turn: what it hadn't taken in goes back to the composer.
    fn hand_back(&mut self, chat_id: i64, ctx: &egui::Context) {
        let back = self.queue.chats.remove(&chat_id).unwrap_or_default();
        if back.is_empty() {
            return;
        }
        let text = back.iter().map(|m| m.text.as_str()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
        let files = back.iter().flat_map(|m| m.files.iter().cloned()).collect();
        let mentions = back.into_iter().flat_map(|m| m.mentions).collect();
        self.restore_draft(chat_id, text, files, mentions, ctx);
    }

    /// Steers a CLI that takes nothing mid-turn: the turn is stopped (its output stays)
    /// and the same session resumes with the messages.
    fn interrupt(&mut self, chat_id: i64, q: Vec<Queued>, ctx: &egui::Context) {
        // Killed and waited for, so the next turn resumes a settled session; its exit
        // event is dropped (it would otherwise end the new turn).
        if let Some((turn, _)) = self.turns.remove(&chat_id) {
            turn.stop_wait();
            self.undo_swallow(chat_id);
            if let Some(tr) = self.transcripts.get_mut(&chat_id) {
                tr.items.push(Item::Error { text: "Interrupted to steer.".into() });
                tr.pending_text = None;
                tr.pending_thinking = None;
            }
        }
        self.send_queued(chat_id, q, Some(steer_prompt), ctx);
    }

    /// The messages the agent hasn't taken in yet, under the running turn: the user's
    /// own bubbles, marked "Steering…" until they join the transcript.
    pub fn steering_bubbles(&mut self, ui: &mut Ui, chat_id: i64) {
        // A copy: as its home PC has them.
        let copy = self.mesh.status.get(&chat_id).map(|r| {
            r.status["queue"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| (m["text"].as_str().unwrap_or("").to_string(), m["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(str::to_string).collect::<Vec<_>>()))
                .collect::<Vec<_>>()
        });
        let q = copy.unwrap_or_else(|| self.queued(chat_id).iter().map(|m| (m.text.clone(), m.files.iter().map(|f| f.to_string_lossy().into_owned()).collect())).collect());
        let t = self.theme.t;
        for (text, files) in q {
            let avail = ui.available_width();
            ui.allocate_ui_with_layout(Vec2::new(avail, 0.0), Layout::right_to_left(Align::Min), |ui| {
                Frame::new().fill(t.gray(100)).corner_radius(CornerRadius::same(RADIUS_LG)).inner_margin(Margin::symmetric(14, 10)).show(ui, |ui| {
                    // Hug the text, as the transcript's bubbles do (chat.rs), at most 80%.
                    let font = ui.style().text_styles.get(&theme::ts("copy-14")).cloned().unwrap_or_default();
                    let mut need = text.lines().map(|l| ui.painter().layout_no_wrap(l.to_string(), font.clone(), egui::Color32::WHITE).size().x).fold(0.0, f32::max);
                    if !files.is_empty() {
                        need = need.max(220.0);
                    }
                    ui.set_max_width((need + 2.0).min(avail * 0.8 - 28.0).max(40.0));
                    ui.vertical(|ui| {
                        if !text.is_empty() {
                            ui.add(egui::Label::new(RichText::new(&text).text_style(theme::ts("copy-14"))).wrap());
                        }
                        for f in &files {
                            let name = std::path::Path::new(f).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                            ui.label(RichText::new(format!("{}  {name}", crate::icons::CLIP)).text_style(theme::ts("label-12")).color(t.subtle()));
                        }
                    });
                });
            });
            ui.add_space(-4.0);
            ui.allocate_ui_with_layout(Vec2::new(avail, 0.0), Layout::right_to_left(Align::Min), |ui| {
                w::subtle(ui, "Steering…", "label-12");
            });
            ui.add_space(6.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sent_from_says_where_the_user_is() {
        assert_eq!(sent_from("", "pc:me", false), "");
        assert!(sent_from("", "pc:me", true).contains("the PC running Harbor"));
        assert!(sent_from("Pixel", "tok:0000abcd", false).contains("phone ('Pixel')"));
        assert!(sent_from("desk", "pc:desk", false).contains("Harbor on 'desk', another PC"));
        // A queued slash command still starts its prompt.
        let q = Queued { text: "/review".into(), files: vec![], mentions: vec![], written: false, sender: "Pixel".into(), device: "tok:1".into() };
        let p = q.prompt("/review");
        assert!(p.starts_with("/review\n\n[The user sent this"), "{p}");
        let q = Queued { text: "hi".into(), ..q };
        assert!(q.prompt("hi").ends_with("not from this PC.]\n\nhi"));
    }

    #[test]
    fn a_message_takes_the_fastest_way_in() {
        // Claude reads its input mid-turn: written at once, whatever the turn is doing.
        assert_eq!(route(true, true, false), Route::Write);
        assert_eq!(route(true, true, true), Route::Write);
        // Its input closed after the result: the turn is ending, the message starts the next.
        assert_eq!(route(true, false, true), Route::Wait);
        // The other CLIs: interrupted and resumed with it, unless their turn is done anyway.
        assert_eq!(route(false, false, false), Route::Interrupt);
        assert_eq!(route(false, false, true), Route::Wait);
    }

    #[test]
    fn finished_is_the_last_turns_result() {
        let user = |t: &str| Item::User { text: t.into(), files: vec![], at: 0, mentions: vec![], sender: String::new() };
        let result = || Item::Result { cost_usd: 0.0, duration_ms: 0, turns: 1, input_tokens: 0, output_tokens: 0, cached: 0, at: 0, account: String::new(), model: String::new() };
        let text = || Item::Text { text: "ok".into(), at: 0 };
        assert!(!finished(&[]));
        assert!(!finished(&[user("a"), text()]));
        assert!(finished(&[user("a"), text(), result()]));
        // A new message after the result: its turn hasn't finished.
        assert!(!finished(&[user("a"), result(), user("b"), text()]));
    }

    #[test]
    fn an_interrupted_agent_hears_why() {
        let p = steer_prompt("use tabs");
        assert!(p.starts_with("[Harbor interrupted your previous turn"), "{p}");
        assert!(p.ends_with("\n\nuse tabs"));
    }
}
