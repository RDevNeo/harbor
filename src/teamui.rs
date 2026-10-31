//! The team panel beside a project's lead thread: subagents, wake-ups,
//! webhooks and chats from before projects had a single thread. Idle agents
//! settle into a collapsed "Settled (N)" group at the bottom, as in the sidebar.

use crate::widgets::Tip as _;
use crate::app::{App, Tab, View, ago};
use crate::icons as ic;
use crate::store::{self, Chat, Role};
use crate::team::{local_hm, until};
use crate::widgets::{self as w, Tone};
use eframe::egui::{self, CornerRadius, FontId, Frame, Margin, Rect, ScrollArea, Sense, Stroke, Ui, Vec2, pos2};
use std::collections::HashMap;

/// Agents idle this long settle on their own.
const SETTLE_AFTER: i64 = 30 * 60;

/// Settle and Unsettle decisions per agent (kv `agent_settle`: id → [settled, when]),
/// and whether the Settled group is open (kv `agents_settled_open`). Cached in the
/// egui context so the store is read once.
#[derive(Clone, Default)]
struct Settle {
    marks: HashMap<i64, (bool, i64)>,
    open: bool,
}

impl Settle {
    fn id() -> egui::Id {
        egui::Id::NULL.with("agent-settle")
    }

    fn load(ctx: &egui::Context, store: &store::Store) -> Self {
        ctx.data_mut(|d| {
            d.get_temp_mut_or_insert_with(Self::id(), || {
                let marks: HashMap<String, (bool, i64)> = store.get("agent_settle").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
                Settle {
                    marks: marks.into_iter().filter_map(|(k, v)| Some((k.parse().ok()?, v))).collect(),
                    open: store.get("agents_settled_open").as_deref() == Some("1"),
                }
            })
            .clone()
        })
    }

    fn save(&self, ctx: &egui::Context, store: &store::Store) {
        let marks: HashMap<String, (bool, i64)> = self.marks.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        store.set("agent_settle", &serde_json::to_string(&marks).unwrap_or_default());
        store.set("agents_settled_open", if self.open { "1" } else { "0" });
        ctx.data_mut(|d| d.insert_temp(Self::id(), self.clone()));
    }

    /// A Settle or Unsettle holds until the agent works again; without one (or
    /// after new work) an agent settles once idle for `SETTLE_AFTER`. An explicit
    /// Unsettle lasts as long again.
    fn settled(&self, c: &Chat, now: i64) -> bool {
        match self.marks.get(&c.id) {
            Some(&(true, at)) if c.updated <= at => true,
            Some(&(false, at)) if c.updated <= at => now - at > SETTLE_AFTER,
            _ => now - c.updated > SETTLE_AFTER,
        }
    }
}

impl App {
    pub fn team_panel(&mut self, ui: &mut Ui, lead: &Chat) {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        let project = lead.repo_id.unwrap_or(0);
        ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 6.0;
            if self.paused.contains(&project) {
                Frame::new()
                    .fill(t.amber(100))
                    .stroke(Stroke::new(1.0, t.amber(400)))
                    .corner_radius(CornerRadius::same(crate::theme::RADIUS_LG))
                    .inner_margin(Margin::same(10))
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        w::text(ui, format!("{}  Automatic turns paused", ic::ALERT), "strong-14");
                        w::subtle(ui, "More than 60 in the last hour. Queued events are kept.", "label-12");
                        if w::btn(&format!("{}  Resume", ic::PLAY)).xs().show(ui).clicked() {
                            self.paused.remove(&project);
                            self.auto_turns.remove(&project);
                            let ids: Vec<i64> = self.chats.iter().filter(|c| c.repo_id == Some(project)).map(|c| c.id).collect();
                            for id in ids {
                                if !self.turns.contains_key(&id) {
                                    if let Some(q) = self.pending.remove(&id).filter(|q| !q.is_empty()) {
                                        self.start_turn(id, q.join("\n\n---\n\n"), vec![], &ctx);
                                    }
                                }
                            }
                        }
                    });
            }

            // ---- agents (working or queued ones never count as settled)
            let mut subs = self.subs_of(lead.id);
            subs.sort_by_key(|c| (!self.is_running(c.id), std::cmp::Reverse(c.updated)));
            let marks = Settle::load(&ctx, &self.store);
            let now = store::now();
            let (settled, active): (Vec<Chat>, Vec<Chat>) = subs.into_iter().partition(|c| self.settled_by(&marks, c, now));
            header(ui, ic::USERS, "Agents", active.len());
            if active.is_empty() {
                let hint = if settled.is_empty() { "The lead spawns subagents here as it delegates work." } else { "No agents working. Earlier ones are under Settled." };
                w::subtle(ui, hint, "label-13");
            }
            for c in &active {
                self.agent_card(ui, c, false);
            }

            // ---- processes
            let procs: Vec<usize> = (0..self.procs.len()).filter(|&i| self.procs[i].lead == lead.id).collect();
            if !procs.is_empty() {
                ui.add_space(8.0);
                header(ui, ic::ACTIVITY, "Processes", procs.len());
                for i in procs {
                    self.proc_card(ui, i);
                }
            }

            // ---- wake-ups
            let timers: Vec<_> = self.timers.iter().filter(|x| x.chat_id == lead.id).cloned().collect();
            ui.add_space(8.0);
            header(ui, ic::ALARM, "Wake-ups", timers.len());
            if timers.is_empty() {
                w::subtle(ui, "Ask the lead to check back later, e.g. \"look at the deploy in 20 minutes\".", "label-13");
            }
            for tm in &timers {
                w::card(ui).inner_margin(Margin::symmetric(10, 8)).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        ui.label(egui::RichText::new(ic::ALARM).size(15.0).color(t.subtle()));
                        w::text(ui, local_hm(tm.at), "heading-16").tip(format!("in {}", until(tm.at)));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.spacing_mut().item_spacing.x = 0.0;
                            if w::btn(ic::X).muted().icon_xs().show(ui).tip("Cancel").clicked() {
                                self.store.delete_timer(tm.id);
                                self.timers.retain(|x| x.id != tm.id);
                            }
                            if w::btn(ic::PLAY).muted().icon_xs().show(ui).tip("Wake now").clicked() {
                                if let Some(x) = self.timers.iter_mut().find(|x| x.id == tm.id) {
                                    x.at = store::now();
                                }
                                ctx.request_repaint();
                            }
                        });
                    });
                    w::subtle(ui, &tm.reason, "label-13");
                });
            }

            // ---- webhooks (they belong to a project)
            if lead.repo_id.is_none() {
                self.settled_agents(ui, &settled);
                return;
            }
            let hooks: Vec<_> = self.webhooks.iter().filter(|h| h.repo_id == project).cloned().collect();
            ui.add_space(8.0);
            header(ui, ic::WEBHOOK, "Webhooks", hooks.len());
            if hooks.is_empty() {
                w::subtle(ui, "Ask the lead for a webhook to react to GitHub, Vercel, Stripe…", "label-13");
            }
            for h in &hooks {
                let (local, public) = self.hook_url(&h.token);
                w::card(ui).inner_margin(Margin::symmetric(10, 8)).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        w::text(ui, &h.name, "strong-14");
                        w::badge(ui, if public.is_some() { "Public" } else { "Local" }, if public.is_some() { Tone::Green } else { Tone::Gray });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.spacing_mut().item_spacing.x = 0.0;
                            if w::btn(ic::TRASH).muted().icon_xs().show(ui).tip("Delete").clicked() {
                                self.store.delete_webhook(h.id);
                                self.webhooks = self.store.webhooks();
                                self.sync_tokens();
                            }
                            let url = public.clone().unwrap_or(local.clone());
                            if w::btn(ic::COPY).muted().icon_xs().show(ui).tip(format!("Copy {url}")).clicked() {
                                ui.ctx().copy_text(url);
                            }
                        });
                    });
                    let last = if h.last_hit > 0 { format!(" · last {}", ago(h.last_hit)) } else { String::new() };
                    w::subtle(ui, format!("{} calls{last}", h.hits), "label-12");
                    if !h.description.is_empty() {
                        w::subtle(ui, &h.description, "label-12");
                    }
                });
            }
            if !hooks.is_empty() && self.funnel.is_none() && crate::hookcert::public_base().is_none() {
                if w::btn("Enable public URLs…").xs().variant(w::Variant::Ghost).show(ui).clicked() {
                    self.open(View::Settings(Tab::Webhooks));
                }
            }

            // ---- earlier chats
            let old: Vec<Chat> = self.chats.iter().filter(|c| c.role == Role::Chat && c.repo_id == Some(project)).cloned().collect();
            if !old.is_empty() {
                ui.add_space(8.0);
                egui::CollapsingHeader::new(egui::RichText::new(format!("Earlier chats ({})", old.len())).text_style(crate::theme::ts("label-13")).color(t.subtle()))
                    .id_salt(("old", project))
                    .show(ui, |ui| {
                        for c in &old {
                            if w::menu_row(ui, false, ic::MESSAGE, &c.title, Some((&ago(c.updated), t.gray(800)))).clicked() {
                                self.open(View::Chat(c.id));
                            }
                        }
                    });
            }

            self.settled_agents(ui, &settled);
        });
    }

    /// "Settled (N) ───── ^" at the bottom of the panel, collapsed by default,
    /// drawn like the sidebar's Settled section.
    fn settled_agents(&mut self, ui: &mut Ui, settled: &[Chat]) {
        if settled.is_empty() {
            return;
        }
        let t = self.theme.t;
        let mut marks = Settle::load(ui.ctx(), &self.store);
        ui.add_space(8.0);
        let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 32.0), Sense::click());
        let p = ui.painter();
        let g = p.layout_no_wrap(format!("Settled ({})", settled.len()), FontId::proportional(13.0), t.subtle());
        let gw = g.size().x;
        p.galley(pos2(rect.left() + 2.0, rect.center().y - g.size().y / 2.0), g, t.subtle());
        let (x0, x1) = (rect.left() + 2.0 + gw + 10.0, rect.right() - 26.0);
        if x1 > x0 {
            p.hline(x0..=x1, rect.center().y, Stroke::new(1.0, if resp.hovered() { t.gray(600) } else { t.gray(500) }));
        }
        ic::glyph(p, pos2(rect.right() - 10.0, rect.center().y), if marks.open { ic::DOWN } else { ic::UP }, 14.0, t.subtle());
        if resp.on_hover_cursor(egui::CursorIcon::PointingHand).tip(format!("Agents idle for {} min or more", SETTLE_AFTER / 60)).clicked() {
            marks.open = !marks.open;
            marks.save(ui.ctx(), &self.store);
        }
        if marks.open {
            for c in settled {
                self.agent_card(ui, c, true);
            }
        }
    }

    /// Whether an agent sits under Settled in the team panel (the phone API asks too).
    pub fn agent_settled(&self, ctx: &egui::Context, c: &Chat) -> bool {
        self.settled_by(&Settle::load(ctx, &self.store), c, store::now())
    }

    fn settled_by(&self, marks: &Settle, c: &Chat, now: i64) -> bool {
        !self.is_running(c.id) && self.pending.get(&c.id).is_none_or(|q| q.is_empty()) && self.queued(c.id).is_empty() && self.paused(c.id).is_none() && marks.settled(c, now)
    }

    /// Settle (or Unsettle) an agent now; new work unsettles it again.
    fn set_agent_settled(&mut self, ctx: &egui::Context, id: i64, settled: bool) {
        let mut marks = Settle::load(ctx, &self.store);
        marks.marks.insert(id, (settled, store::now()));
        // Forget agents that no longer exist.
        marks.marks.retain(|id, _| self.chats.iter().any(|c| c.id == *id));
        marks.save(ctx, &self.store);
    }

    /// A running process (ended ones disappear): name, URL, command, output.
    fn proc_card(&mut self, ui: &mut Ui, i: usize) {
        let t = self.theme.t;
        let (id, name, cmd, url, tail) = {
            let p = &self.procs[i];
            (p.id, p.name.clone(), p.cmd.clone(), p.url.clone(), p.tail(30))
        };
        let open = self.expanded_procs.contains(&id);
        let mut action: Option<&str> = None;
        w::card(ui).inner_margin(Margin::symmetric(10, 8)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                w::dot(ui, t.green(700));
                w::text(ui, &name, "strong-14");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 0.0;
                    if w::btn(if open { ic::UP } else { ic::DOWN }).muted().icon_xs().show(ui).tip("Output").clicked() {
                        action = Some("logs");
                    }
                    if w::btn(ic::STOP).variant(w::Variant::Stop).icon_xs().show(ui).tip("Stop").clicked() {
                        action = Some("stop");
                    }
                    if url.is_some() && w::btn(ic::GLOBE).muted().icon_xs().show(ui).tip("Open in Harbor's browser").clicked() {
                        action = Some("open");
                    }
                });
            });
            if let Some(u) = &url {
                w::subtle(ui, u, "label-12-mono");
            }
            let g = w::truncated(ui, &cmd, FontId::monospace(12.0), t.subtle(), ui.available_width());
            ui.label(g);
            if open {
                w::well(ui).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ScrollArea::vertical().max_height(220.0).stick_to_bottom(true).show(ui, |ui| {
                        ui.label(egui::RichText::new(if tail.is_empty() { "(no output yet)".to_string() } else { tail.clone() }).text_style(crate::theme::ts("label-12-mono")));
                    });
                });
            }
        });
        match action {
            Some("logs") => {
                if open {
                    self.expanded_procs.remove(&id);
                } else {
                    self.expanded_procs.insert(id);
                }
            }
            Some("stop") => self.procs[i].stop(),
            Some("open") => self.open_browser(url),
            _ => {}
        }
    }

    fn agent_card(&mut self, ui: &mut Ui, c: &Chat, settled: bool) {
        let t = self.theme.t;
        let running = self.running_since(c.id).map(|s| s.elapsed().as_secs());
        let queued = self.pending.get(&c.id).map(|q| q.len()).unwrap_or(0);
        let acc = self.account(&c.account).cloned();
        let model = acc.as_ref().map(|a| self.model_label(a.kind, &c.model)).unwrap_or(c.model.clone());
        let h = 74.0;
        let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), h), Sense::click());
        let p = ui.painter();
        p.rect(
            rect,
            CornerRadius::same(crate::theme::RADIUS_LG),
            if resp.hovered() { t.gray(100) } else { t.bg100 },
            Stroke::new(1.0, if running.is_some() { t.blue(600) } else { t.border() }),
            egui::StrokeKind::Inside,
        );
        if let Some(a) = &acc {
            ic::account_mark(p, Rect::from_min_size(rect.min + Vec2::new(10.0, 10.0), Vec2::splat(18.0)), a.kind, &a.badge, &t);
        }
        let paused = self.paused(c.id).map(|p| p.at.map(crate::limits::when).unwrap_or_else(|| "usage limit".into()));
        let (status, col) = match (running, queued) {
            (Some(s), _) => (format!("working {}", w::minutes(s)), t.blue(900)),
            (None, _) if paused.is_some() => (format!("{} paused · {}", ic::CLOCK, paused.clone().unwrap_or_default()), t.amber(900)),
            (None, n) if n > 0 => (format!("{n} queued"), t.amber(900)),
            _ => (format!("idle · {}", ago(c.updated)), t.subtle()),
        };
        if let Some(s) = running {
            w::repaint_in(ui.painter(), rect, w::minute_step(s));
        }
        // On hover, Settle / Unsettle takes the status's place (idle agents only),
        // as in the sidebar.
        let hovered = ui.rect_contains_pointer(rect);
        let label = if settled { format!("{}  Unsettle", ic::UNARCHIVE) } else { format!("{}  Settle", ic::CHECK) };
        let settle_w = if hovered && running.is_none() && paused.is_none() { w::btn(&label).muted().xs().width(ui) } else { 0.0 };
        // Every line truncates to its room, so narrow cards never overlap.
        let status = w::truncated(ui, &status, FontId::proportional(12.0), col, (rect.width() * 0.45).max(40.0));
        let text_w = rect.width() - 46.0;
        let name = w::truncated(ui, &c.name, FontId::new(14.0, crate::theme::medium()), t.fg(), text_w - status.size().x.max(settle_w - 6.0) - 8.0);
        let model = w::truncated(ui, &model, FontId::monospace(12.0), t.subtle(), text_w);
        let p = ui.painter();
        p.galley(pos2(rect.left() + 36.0, rect.top() + 10.0), name, t.fg());
        if settle_w == 0.0 {
            p.galley(pos2(rect.right() - 10.0 - status.size().x, rect.top() + 11.0), status, col);
        }
        p.galley(pos2(rect.left() + 36.0, rect.top() + 29.0), model, t.subtle());
        let task = w::truncated(ui, &c.title, FontId::proportional(12.5), t.fg(), rect.width() - 20.0);
        ui.painter().galley(pos2(rect.left() + 10.0, rect.top() + 50.0), task, t.fg());
        if settle_w > 0.0 {
            let sr = Rect::from_min_size(pos2(rect.right() - 4.0 - settle_w, rect.top() + 4.0), Vec2::new(settle_w, 28.0));
            let tip = if settled { "Back to the active agents" } else { "Move to Settled" };
            if w::overlay(ui, sr, |ui| w::btn(&label).muted().xs().show(ui)).tip(tip).clicked() {
                let ctx = ui.ctx().clone();
                self.set_agent_settled(&ctx, c.id, !settled);
                return;
            }
        }
        if resp.hovered() && running.is_some() {
            let br = Rect::from_min_size(pos2(rect.right() - 34.0, rect.top() + 26.0), Vec2::splat(26.0));
            if w::overlay(ui, br, |ui| w::btn(ic::STOP).variant(w::Variant::Stop).icon_xs().show(ui)).tip("Stop").clicked() {
                self.pending.remove(&c.id);
                self.stop(c.id);
                return;
            }
        }
        let resp = resp.on_hover_cursor(egui::CursorIcon::PointingHand).tip(&c.title);
        if resp.clicked() {
            self.open(View::Chat(c.id));
        }
        resp.context_menu(|ui| {
            if ui.button(format!("{}  Delete agent", ic::TRASH)).clicked() {
                self.dialog = Some(crate::app::Dialog::DeleteChat(c.id));
            }
        });
    }
}

fn header(ui: &mut Ui, icon: &str, title: &str, n: usize) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        ui.label(egui::RichText::new(icon).size(14.0).color(w::tokens(ui).subtle()));
        w::text(ui, title, "heading-14");
        if n > 0 {
            w::subtle(ui, n.to_string(), "label-12-mono");
        }
    });
}
