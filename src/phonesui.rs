//! Settings › Phones: turns the phone API (api.rs) on, pairs Harbor for Android with a QR
//! code, lists the paired phones (revocable) and offers the app itself.

use crate::api::{self, Token, url_encode};
use crate::app::App;
use crate::icons as ic;
use crate::pages::{rows, section};
use crate::widgets::{self as w, Tone};
use eframe::egui::{self, Align, CornerRadius, Layout, Margin, Rect, Sense, Ui, Vec2, pos2};
use std::sync::atomic::Ordering;

/// The QR code, on white whatever the theme.
fn qr(ui: &mut Ui, tex: &egui::TextureHandle, side: f32) {
    let (r, _) = ui.allocate_exact_size(Vec2::splat(side), Sense::hover());
    ui.painter().rect_filled(r, CornerRadius::same(crate::theme::RADIUS_MD), egui::Color32::WHITE);
    ui.painter().image(tex.id(), r, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), egui::Color32::WHITE);
}

fn copy_line(ui: &mut Ui, text: &str) {
    ui.horizontal(|ui| {
        let t = crate::widgets::tokens(ui);
        let g = w::truncated(ui, text, egui::FontId::new(12.0, egui::FontFamily::Monospace), t.fg(), ui.available_width() - 40.0);
        ui.label(g);
        if w::btn(ic::COPY).muted().icon_sm().show(ui).on_hover_text("Copy").clicked() {
            ui.ctx().copy_text(text.to_string());
        }
    });
}

impl App {
    pub fn phones_tab(&mut self, ui: &mut Ui) {
        let ctx = ui.ctx().clone();
        let hub = self.api.hub.clone();
        let mut on = hub.enabled.load(Ordering::SeqCst);
        let was = on;
        rows(ui, |ui| {
            w::setting_row(
                ui,
                "Phone access",
                "Harbor for Android lists, opens and starts this PC's chats over Tailscale. Harbor listens on this PC's tailnet address only, and answers paired phones only.",
                |ui| w::toggle(ui, &mut on),
            );
        });
        if on != was {
            self.api_set_enabled(on, &ctx);
        }
        let net = hub.net.lock().unwrap().clone();
        let port = *hub.port.lock().unwrap();
        // The phone reaches this PC by its MagicDNS name, or its tailnet IP without MagicDNS.
        let ip = net.ips.iter().find(|i| !i.contains(':')).cloned().unwrap_or_default();
        let host = if !net.dns.is_empty() { net.dns.clone() } else { ip.clone() };
        if on {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                if host.is_empty() {
                    w::badge(ui, "No tailnet", Tone::Amber);
                    w::subtle(ui, "Tailscale isn't running here, so phones can't reach this PC yet (it's checked again every 20 s).", "label-13");
                } else if net.bound.iter().any(|b| *b == ip || net.ips.contains(b)) {
                    w::badge(ui, "Listening", Tone::Green);
                    w::text(ui, format!("{host}:{port}"), "label-13-mono");
                } else {
                    w::badge(ui, "Starting", Tone::Gray);
                    w::text(ui, format!("{host}:{port}"), "label-13-mono");
                }
            });
            if !net.error.is_empty() {
                w::subtle(ui, format!("Couldn't listen on {}", net.error), "label-12");
            }
        }

        section(ui, "Pair a phone");
        w::subtle(ui, "Each phone gets its own key. Scan the code with the camera in Harbor for Android (Pair a PC), or type the details shown under it.", "copy-14");
        ui.add_space(8.0);
        if self.api.ui.pairing.is_none() {
            let b = w::btn(&format!("{}  Pair a phone", ic::PLUS)).primary().show(ui);
            if b.clicked() {
                let token = api::new_token();
                let mut tokens = hub.tokens.lock().unwrap();
                tokens.push(Token { token: token.clone(), name: String::new(), created: crate::store::now() });
                api::save_tokens(&self.store, &tokens);
                drop(tokens);
                self.api.ui.pairing = Some((token, None, None));
                if !on {
                    self.api_set_enabled(true, &ctx);
                }
            }
        }
        let name = crate::remote::hostname();
        let mut done = false;
        if let Some((token, tex, _)) = &mut self.api.ui.pairing {
            let uri = format!("harbor://pair?host={}&port={port}&token={token}&name={}&ip={}", url_encode(&host), url_encode(&name), url_encode(&ip));
            if host.is_empty() {
                w::subtle(ui, "Waiting for this PC's tailnet address…", "label-13");
            } else {
                let tex = tex.get_or_insert_with(|| ctx.load_texture(format!("phone-pair-{host}"), crate::devices::qr_image(&uri), egui::TextureOptions::NEAREST)).clone();
                w::card(ui).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal_top(|ui| {
                        qr(ui, &tex, 200.0);
                        ui.add_space(12.0);
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 4.0;
                            for (k, v) in [("PC", name.as_str()), ("Address", host.as_str()), ("Port", &port.to_string()), ("Key", token.as_str())] {
                                w::subtle(ui, k, "label-12");
                                copy_line(ui, v);
                            }
                            ui.add_space(6.0);
                            if w::btn("Done").outline().sm().show(ui).clicked() {
                                done = true;
                            }
                        });
                    });
                });
            }
        }
        if done {
            self.api.ui.pairing = None;
        }

        section(ui, "Paired phones");
        let tokens = hub.tokens.lock().unwrap().clone();
        let seen = hub.seen.lock().unwrap().clone();
        let mut revoke = None;
        w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
            ui.set_width(ui.available_width());
            if tokens.is_empty() {
                egui::Frame::new().inner_margin(Margin::same(16)).show(ui, |ui| w::subtle(ui, "None yet.", "label-13"));
            }
            for (i, t) in tokens.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                egui::Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            let label = if t.name.is_empty() { "Not connected yet".to_string() } else { t.name.clone() };
                            w::text(ui, format!("{}  {label}", ic::SMARTPHONE), "strong-14");
                            let last = match seen.get(&t.token) {
                                Some((_, at)) => format!(" · last seen {}", crate::app::ago(*at)),
                                None => String::new(),
                            };
                            w::subtle(ui, format!("Paired {} ago · key …{}{last}", crate::app::ago(t.created), &t.token[t.token.len().saturating_sub(6)..]), "label-12");
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if w::btn("Revoke").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                                revoke = Some(t.token.clone());
                            }
                        });
                    });
                });
            }
        });
        if let Some(tok) = revoke {
            let mut tokens = hub.tokens.lock().unwrap();
            tokens.retain(|t| t.token != tok);
            api::save_tokens(&self.store, &tokens);
            drop(tokens);
            hub.seen.lock().unwrap().remove(&tok);
            if self.api.ui.pairing.as_ref().is_some_and(|p| p.0 == tok) {
                self.api.ui.pairing = None;
            }
        }

        section(ui, "Install the app");
        let apk = crate::update::apk();
        match &apk {
            Some((_, code)) => {
                let v = if *code > 0 { format!("Harbor for Android (build {code})") } else { "Harbor for Android".into() };
                w::subtle(ui, format!("{v} is on this PC. Open the link on the phone, or scan the code with its camera, to install it. The app updates itself from here afterwards."), "copy-14");
            }
            None => {
                w::subtle(ui, "This PC doesn't have the app yet. Installed copies of Harbor get it with every update; this one can download it from the latest release.", "copy-14");
            }
        }
        ui.add_space(8.0);
        if apk.is_some() && !host.is_empty() && on {
            let url = format!("http://{host}:{port}/app.apk");
            if self.api.ui.install_qr.as_ref().is_none_or(|(u, _)| *u != url) {
                let tex = ctx.load_texture("phone-app-qr", crate::devices::qr_image(&url), egui::TextureOptions::NEAREST);
                self.api.ui.install_qr = Some((url.clone(), tex));
            }
            let tex = self.api.ui.install_qr.as_ref().unwrap().1.clone();
            w::card(ui).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal_top(|ui| {
                    qr(ui, &tex, 160.0);
                    ui.add_space(12.0);
                    ui.vertical(|ui| copy_line(ui, &url));
                });
            });
            ui.add_space(8.0);
        }
        let busy = crate::update::busy();
        ui.horizontal(|ui| {
            let label = if apk.is_some() { "Download the latest app" } else { "Download the app" };
            if w::btn(&format!("{}  {label}", ic::DOWNLOAD)).outline().sm().show(ui).clicked() && !busy {
                crate::update::download_apk(&ctx);
            }
            match crate::update::apk_result() {
                None if busy => {
                    w::subtle(ui, "Downloading…", "label-13");
                }
                Some(Ok(code)) => {
                    w::subtle(ui, format!("Build {code} is ready."), "label-13");
                }
                Some(Err(e)) => {
                    w::subtle(ui, e, "label-13");
                }
                None => {}
            }
        });
    }
}
