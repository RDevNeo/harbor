//! The two update pop-ups, top right under the bar, one above the other and never merged:
//! Harbor itself ("Harbor X.Y.Z is available": blue sparkles, Update / What's new) and the
//! provider CLIs ("Updates available: 2 providers": their logos, Update / Settings). Closing
//! one remembers the version(s) it offered (kv), so it shows again for the next ones. The
//! phone shows the same two as banners (api.rs `hub_update`, `provider_updates`).

use eframe::egui::{self, Align, Align2, CornerRadius, Layout, Rect, Sense, Vec2, pos2};

use crate::app::{App, Tab, View};
use crate::icons as ic;
use crate::provupdate;
use crate::theme::Tokens;
use crate::update::State;
use crate::widgets as w;

const WIDTH: f32 = 340.0;
/// How long "Codex is up to date" stays.
const DONE_FOR: std::time::Duration = std::time::Duration::from_secs(6);

pub const HARBOR_DISMISSED: &str = "update_toast_dismissed";
pub const PROVIDERS_DISMISSED: &str = "provider_updates_dismissed";

/// The release notes of a Harbor version.
pub fn notes_url(v: &str) -> String {
    format!("https://github.com/RDevNeo/harbor/releases/tag/v{v}")
}

enum Click {
    None,
    Primary,
    Secondary,
    Close,
}

/// One pop-up: an icon on the left (drawn by `icon`), a title, a line, two buttons and a close.
#[allow(clippy::too_many_arguments)]
fn toast(ctx: &egui::Context, t: &Tokens, id: &str, y: f32, icon: impl FnOnce(&egui::Painter, Rect), title: &str, body: &str, primary: Option<(&str, bool)>, secondary: &str) -> (Click, f32) {
    let mut click = Click::None;
    let r = egui::Area::new(egui::Id::NULL.with(id))
        .order(egui::Order::Foreground)
        .anchor(Align2::RIGHT_TOP, egui::vec2(-14.0, y))
        .show(ctx, |ui| {
            w::popover_frame(t).inner_margin(egui::Margin::same(12)).show(ui, |ui| {
                ui.set_width(WIDTH - 24.0);
                ui.horizontal_top(|ui| {
                    let (ir, _) = ui.allocate_exact_size(Vec2::splat(32.0), Sense::hover());
                    icon(ui.painter(), ir);
                    ui.add_space(8.0);
                    ui.vertical(|ui| {
                        ui.set_width(WIDTH - 24.0 - 40.0 - 30.0);
                        ui.spacing_mut().item_spacing.y = 2.0;
                        w::text(ui, title, "strong-14");
                        w::subtle(ui, body, "label-13");
                        ui.add_space(6.0);
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 6.0;
                            if let Some((label, enabled)) = primary {
                                if w::btn(label).xs().primary().enabled(enabled).show(ui).clicked() {
                                    click = Click::Primary;
                                }
                            }
                            if w::btn(secondary).xs().ghost().show(ui).clicked() {
                                click = Click::Secondary;
                            }
                        });
                    });
                    ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                        if w::btn(ic::X).muted().icon_xs().show(ui).on_hover_text("Dismiss").clicked() {
                            click = Click::Close;
                        }
                    });
                });
            });
        });
    (click, r.response.rect.height())
}

impl App {
    /// Both update pop-ups; called every frame.
    pub fn update_toasts(&mut self, ctx: &egui::Context) {
        provupdate::tick(ctx, &self.accounts);
        let t = self.theme.t;
        let mut y = 52.0;
        if let Some(h) = self.harbor_toast(ctx, &t, y) {
            y += h + 8.0;
        }
        self.provider_toast(ctx, &t, y);
    }

    /// The Harbor release on offer (an installed copy only): its version and whether it is
    /// installing.
    pub fn harbor_offer(&self) -> Option<(String, bool)> {
        if !crate::update::managed() {
            return None;
        }
        let (v, installing) = match crate::update::state() {
            State::Available(v) => (v, false),
            State::Installing(v) => (v, true),
            _ => return None,
        };
        Some((v, installing))
    }

    fn harbor_toast(&mut self, ctx: &egui::Context, t: &Tokens, y: f32) -> Option<f32> {
        let (v, installing) = self.harbor_offer()?;
        if self.store.get(HARBOR_DISMISSED).as_deref() == Some(v.as_str()) {
            return None;
        }
        let busy = installing || self.reload_asked;
        let (title, body) = if busy {
            (format!("Updating Harbor to {v}…"), "It reloads in place when it's ready; running agents keep going.".to_string())
        } else {
            (format!("Harbor {v} is available"), format!("You have {}. Update installs it and reloads Harbor in place.", crate::update::VERSION))
        };
        let icon = |p: &egui::Painter, r: Rect| {
            p.rect_filled(r, CornerRadius::same(8), t.blue(200));
            ic::glyph(p, r.center(), ic::SPARKLES, 16.0, t.blue(900));
        };
        let (click, h) = toast(ctx, t, "harbor-update-toast", y, icon, &title, &body, Some((if busy { "Updating…" } else { "Update" }, !busy)), "What's new");
        match click {
            Click::Primary => self.update_clicked(ctx),
            Click::Secondary => crate::git::open_url(&notes_url(&v)),
            Click::Close => self.store.set(HARBOR_DISMISSED, &v),
            Click::None => {}
        }
        Some(h)
    }

    fn provider_toast(&mut self, ctx: &egui::Context, t: &Tokens, y: f32) {
        let st = provupdate::status();
        let done = st.done.as_ref().filter(|(_, at)| at.elapsed() < DONE_FOR).map(|(m, at)| {
            ctx.request_repaint_after(DONE_FOR.saturating_sub(at.elapsed()));
            m.clone()
        });
        let key = provupdate::key(&st.items);
        let offered = !st.items.is_empty() && self.store.get(PROVIDERS_DISMISSED).as_deref() != Some(key.as_str());
        if !st.updating && st.error.is_none() && done.is_none() && !offered {
            return;
        }
        let names = provupdate::names(&st.items);
        let n = st.items.len();
        let (title, body, primary) = if st.updating {
            ("Updating providers…".to_string(), format!("Updating {names}. Chats keep running."), Some(("Updating…", false)))
        } else if let Some(e) = &st.error {
            ("A provider update failed".to_string(), e.clone(), (!st.items.is_empty()).then_some(("Try again", true)))
        } else if offered {
            (format!("Updates available: {n} provider{}", if n == 1 { "" } else { "s" }), format!("{names} can be updated."), Some(("Update", true)))
        } else {
            (done.unwrap_or_default(), "Their new versions are in use from the next turn.".to_string(), None)
        };
        let kinds: Vec<_> = st.items.iter().map(|p| p.kind).take(3).collect();
        let icon = |p: &egui::Painter, r: Rect| {
            p.rect_filled(r, CornerRadius::same(8), t.gray(200));
            match kinds.as_slice() {
                [] => ic::glyph(p, r.center(), ic::BOT, 16.0, t.subtle()),
                [k] => ic::provider(p, r.shrink(7.0), *k, t),
                ks => {
                    // Overlapping logos, a little apart.
                    let step = 6.0;
                    let x0 = r.center().x - step * (ks.len() - 1) as f32 / 2.0;
                    for (i, k) in ks.iter().enumerate() {
                        let c = pos2(x0 + step * i as f32, r.center().y);
                        ic::provider(p, Rect::from_center_size(c, Vec2::splat(16.0)), *k, t);
                    }
                }
            }
        };
        let (click, _) = toast(ctx, t, "provider-update-toast", y, icon, &title, &body, primary, "Settings");
        match click {
            Click::Primary => {
                provupdate::update_all(ctx, &self.accounts);
            }
            Click::Secondary => self.open(View::Settings(Tab::Providers)),
            Click::Close => {
                self.store.set(PROVIDERS_DISMISSED, &key);
                provupdate::clear_outcome();
            }
            Click::None => {}
        }
    }
}
