//! The status line under a transcript: "Working…" while the chat's own turn runs. A lead
//! waiting for its sub-agents shows them in the agent strip over the composer instead.

use crate::app::App;
use crate::store::Role;
use crate::widgets as w;
use eframe::egui::{Sense, Ui, Vec2};

impl App {
    /// Nothing when the chat's own turn is idle. While shown, the spinner asks for its own
    /// next step (see `w::repaint_in`).
    pub fn status_line(&mut self, ui: &mut Ui, id: i64) {
        // Steers on their way in sit with the turn; "Up next" comes last (queue.rs).
        self.steering_bubbles(ui, id);
        self.limit_line(ui, id);
        self.folder_ui(ui, id);
        let own = self.turns.get(&id).map(|(_, s)| s.elapsed().as_secs());
        let lead = self.chat(id).is_some_and(|c| c.role == Role::Lead);
        let subs = if lead { self.running_subs(id) } else { vec![] };
        if let Some(secs) = own {
            ui.horizontal(|ui| {
                // Harbor's spinner steps at 4 fps; egui's would repaint every frame.
                let (r, _) = ui.allocate_exact_size(Vec2::splat(16.0), Sense::hover());
                w::spinner(ui.painter(), r.center(), 6.5, ui.visuals().strong_text_color());
                let also = subs_running(subs.len());
                w::subtle(ui, format!("Working… {}{also}  ·  Esc to stop", w::elapsed(secs)), "label-13");
            });
        }
        self.queued_bubbles(ui, id);
        // Waiting only for sub-agents: the agent strip over the composer shows them (agentstrip.rs).
    }

    /// Messages waiting for a lead's idle sub-agents (the agent strip's "· 2 queued").
    pub fn subs_queued(&self, lead: i64) -> usize {
        self.subs_of(lead).iter().filter(|c| !self.turns.contains_key(&c.id)).map(|c| self.pending.get(&c.id).map_or(0, |q| q.len())).sum()
    }
}

/// What follows "Working… 12s" while sub-agents run too ("" with none). The phone shows it too.
pub fn subs_running(n: usize) -> String {
    match n {
        0 => String::new(),
        1 => "  ·  1 sub-agent running".into(),
        n => format!("  ·  {n} sub-agents running"),
    }
}
