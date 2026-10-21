//! The status line under a transcript: "Working…" while the chat's own turn runs,
//! or, once a lead has ended its turn, a calm "Waiting for N sub-agents" line.

use crate::app::App;
use crate::store::Role;
use crate::widgets as w;
use eframe::egui::{self, Color32, FontId, Sense, Stroke, Ui, Vec2, pos2, text::LayoutJob};

const DOT: f32 = 18.0;
const OVERLAP: f32 = 6.0;
const MAX_DOTS: usize = 4;

impl App {
    /// Nothing when the chat and its subagents are idle. Repaints come from the app's
    /// running-turn tick (500 ms) and agent events; the pulse steps on that tick.
    pub fn status_line(&mut self, ui: &mut Ui, id: i64) {
        self.queued_bubbles(ui, id);
        self.limit_line(ui, id);
        let own = self.turns.get(&id).map(|(_, s)| s.elapsed().as_secs());
        let lead = self.chat(id).is_some_and(|c| c.role == Role::Lead);
        let subs = if lead { self.running_subs(id) } else { vec![] };
        if own.is_none() && subs.is_empty() {
            return;
        }
        let t = self.theme.t;
        if let Some(secs) = own {
            let queued = self.queued(id).iter().any(|q| !q.written);
            ui.horizontal(|ui| {
                ui.spinner();
                let also = match subs.len() {
                    0 => String::new(),
                    1 => "  ·  1 sub-agent running".into(),
                    n => format!("  ·  {n} sub-agents running"),
                };
                w::subtle(ui, format!("Working… {}{also}  ·  {}", w::elapsed(secs), if queued { "Ctrl+Enter to send now  ·  Esc to edit queued" } else { "Esc to stop" }), "label-13");
            });
            return;
        }

        // Waiting: stacked agent initials, the lit one stepping on each tick.
        let n = subs.len();
        let queued: usize = self.subs_of(id).iter().filter(|c| !self.turns.contains_key(&c.id)).map(|c| self.pending.get(&c.id).map_or(0, |q| q.len())).sum();
        let font = FontId::proportional(13.0);
        let mut job = LayoutJob::default();
        let fmt = |c: Color32, f: FontId| egui::TextFormat { font_id: f, color: c, ..Default::default() };
        job.append("Waiting for ", 0.0, fmt(t.subtle(), font.clone()));
        job.append(&n.to_string(), 0.0, fmt(t.fg(), FontId::new(13.0, crate::theme::semibold())));
        job.append(if n == 1 { " sub-agent to finish" } else { " sub-agents to finish" }, 0.0, fmt(t.subtle(), font.clone()));
        if queued > 0 {
            job.append(&format!("  ·  {queued} queued"), 0.0, fmt(t.subtle(), font.clone()));
        }
        let galley = ui.painter().layout_job(job);
        let shown = n.min(MAX_DOTS);
        let dots_w = DOT + (shown - 1) as f32 * (DOT - OVERLAP);
        let size = Vec2::new(dots_w + 10.0 + galley.size().x, DOT.max(galley.size().y) + 4.0);

        let mut stop_all = false;
        ui.horizontal(|ui| {
            let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
            let p = ui.painter();
            let lit = (ui.input(|i| i.time) / 0.5) as usize % shown;
            let palette = [t.blue(700), t.green(700), t.amber(700), t.gray(700)];
            for (k, (c, _)) in subs.iter().take(shown).enumerate().rev() {
                let ctr = pos2(rect.left() + DOT / 2.0 + k as f32 * (DOT - OVERLAP), rect.center().y);
                let col = palette[(c.id as usize) % palette.len()];
                let on = k == lit;
                p.circle(ctr, DOT / 2.0, if on { col } else { col.gamma_multiply(0.45) }, Stroke::new(2.0, t.bg100));
                let initial: String = c.name.chars().next().map(|ch| ch.to_uppercase().collect()).unwrap_or_default();
                p.text(ctr, egui::Align2::CENTER_CENTER, initial, FontId::new(10.0, crate::theme::semibold()), if on { t.bg100 } else { t.fg().gamma_multiply(0.7) });
            }
            p.galley(pos2(rect.left() + dots_w + 10.0, rect.center().y - galley.size().y / 2.0), galley, t.subtle());
            let resp = resp.on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_ui(|ui| {
                ui.set_max_width(360.0);
                for (c, secs) in &subs {
                    ui.horizontal(|ui| {
                        w::text(ui, &c.name, "strong-14");
                        w::subtle(ui, w::elapsed(*secs), "label-12-mono");
                    });
                    w::subtle(ui, &c.title, "label-12");
                }
                ui.add_space(4.0);
                w::subtle(ui, "Click to open the Agents panel", "label-12");
            });
            if resp.clicked() && !self.team_showing() {
                self.open_team();
            }
            ui.add_space(6.0);
            if w::btn("Stop all").sm().muted().show(ui).on_hover_text("Stop every running sub-agent and clear their queues").clicked() {
                stop_all = true;
            }
        });
        if stop_all {
            self.dialog = Some(crate::app::Dialog::StopAll(id));
        }
    }
}
