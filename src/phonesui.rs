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
        // Phones that wait for the codes to be compared here (pairing, or upgrading a pairing
        // from before three factors).
        let waiting = hub.auth3.waiting();
        if !waiting.is_empty() {
            ui.add_space(4.0);
            w::text(ui, "Confirm a phone", "heading-16");
            ui.add_space(6.0);
            for p in &waiting {
                w::card(ui).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    let who = if p.name.is_empty() { "A phone" } else { p.name.as_str() };
                    let what = if p.upgrade { "asks to upgrade its pairing to three factors" } else { "wants to pair with this PC" };
                    w::text(ui, format!("{}  {who} {what}", ic::SMARTPHONE), "strong-14");
                    w::subtle(ui, format!("Its key {}. Confirm only if the phone shows this same code:", crate::tls::short(&p.phone_fp)), "label-13");
                    ui.add_space(4.0);
                    w::text(ui, format!("{} {}", &p.code[..3], &p.code[3..]), "heading-32");
                    ui.add_space(6.0);
                    ui.horizontal(|ui| {
                        if w::btn("Confirm").primary().sm().show(ui).clicked() {
                            hub.auth3.decide(&p.token, true);
                            if self.api.ui.pairing.as_ref().is_some_and(|q| q.0 == p.token) {
                                self.api.ui.pairing = None;
                            }
                        }
                        if w::btn("Reject").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                            hub.auth3.decide(&p.token, false);
                        }
                        let left = crate::phoneauth::CONFIRM_TTL.saturating_sub(p.at.elapsed()).as_secs();
                        w::subtle(ui, format!("{}:{:02} left", left / 60, left % 60), "label-12");
                    });
                });
                ui.add_space(6.0);
            }
            ctx.request_repaint_after(std::time::Duration::from_secs(1));
        }

        rows(ui, |ui| {
            w::setting_row(
                ui,
                "Phone access",
                "Harbor for Android lists, opens and starts this PC's chats over your network. Every connection is encrypted with this PC's key and the phone's own, paired by the QR code below: Harbor answers paired phones only.",
                |ui| w::toggle(ui, &mut on),
            );
        });
        if on != was {
            self.api_set_enabled(on, &ctx);
        }
        let net = hub.net.lock().unwrap().clone();
        let port = *hub.port.lock().unwrap();
        let fp = crate::tls::my_fp();
        // The phone tries each of this PC's addresses; an app before 0.13 only the first
        // (`host`, `ip`), which must be a Tailscale one for it.
        let host = net.legacy_ip();
        let shown: Vec<String> = net.addrs.iter().take(6).cloned().collect();
        if on {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                if net.addrs.is_empty() {
                    w::badge(ui, "No network", Tone::Amber);
                    w::subtle(ui, "This PC has no network address right now (it's checked again every 20 s).", "label-13");
                } else if !net.bound.is_empty() {
                    w::badge(ui, "Listening", Tone::Green);
                    w::text(ui, format!("{} · port {port}", shown.join("  ")), "label-13-mono");
                } else {
                    w::badge(ui, "Starting", Tone::Gray);
                    w::text(ui, format!("port {port}"), "label-13-mono");
                }
            });
            if !net.error.is_empty() {
                w::subtle(ui, format!("Couldn't listen on {}", net.error), "label-12");
            }
            if crate::tls::firewall_blocks(port) {
                ui.add_space(6.0);
                ui.horizontal(|ui| {
                    w::badge(ui, "Firewall", Tone::Amber);
                    w::subtle(ui, format!("This PC's firewall (ufw) drops port {port}: phones on your network can't reach it."), "label-13");
                    if w::btn("Allow on the local network").sm().primary().show(ui).clicked() {
                        self.open_firewall(&ctx);
                    }
                });
            }
        }

        if on {
            self.outside_section(ui);
        }

        section(ui, "Pair a phone");
        w::subtle(ui, "Each phone gets its own key. Scan the code with the phone's camera app, or tap + in Harbor for Android to scan it, paste the link or type the details shown beside it. The phone then shows a 6-digit code: confirm it here. It also asks for its screen lock or fingerprint, which it needs again when a session starts.", "copy-14");
        ui.add_space(8.0);
        // A code nobody used in time is void.
        let expired = self.api.ui.pairing.as_ref().is_some_and(|(tok, _, _)| !hub.tokens.lock().unwrap().iter().any(|t| t.token == *tok && t.ticket && crate::store::now() - t.created <= crate::phoneauth::TICKET_TTL));
        if expired {
            let tok = self.api.ui.pairing.take().map(|p| p.0).unwrap_or_default();
            let mut tokens = hub.tokens.lock().unwrap();
            tokens.retain(|t| !(t.token == tok && t.ticket));
            api::save_tokens(&self.store, &tokens);
            drop(tokens);
            w::subtle(ui, "The last pairing code expired or was used by two phones at once. Make a new one.", "label-13");
            ui.add_space(6.0);
        }
        if self.api.ui.pairing.is_none() {
            let b = w::btn(&format!("{}  Pair a phone", ic::PLUS)).primary().show(ui);
            if let Some(token) = b.clicked().then(api::new_token).and_then(|t| t.map_err(|e| eprintln!("harbor: no key for a phone: {e}")).ok()) {
                let mut tokens = hub.tokens.lock().unwrap();
                // A pairing code: good for pairing only, for 10 minutes, once.
                tokens.retain(|t| !t.ticket || crate::store::now() - t.created <= crate::phoneauth::TICKET_TTL);
                tokens.push(Token { token: token.clone(), created: crate::store::now(), group: crate::store::random_hex(16).unwrap_or_else(|_| token.clone()), ticket: true, ..Default::default() });
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
            let uri = format!("harbor://pair?v=3&host={}&port={port}&token={token}&name={}&ip={}&fp={fp}&addrs={}", url_encode(&host), url_encode(&name), url_encode(&host), url_encode(&shown.join(",")));
            if host.is_empty() || fp.is_empty() {
                w::subtle(ui, if fp.is_empty() { "This PC has no key (see the log): phones can't pair." } else { "Waiting for this PC's network address…" }, "label-13");
            } else {
                let tex = tex.get_or_insert_with(|| ctx.load_texture(format!("phone-pair-{host}"), crate::devices::qr_image(&uri), egui::TextureOptions::NEAREST)).clone();
                w::card(ui).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal_top(|ui| {
                        qr(ui, &tex, 200.0);
                        ui.add_space(12.0);
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 4.0;
                            let addrs = shown.join(" ");
                            for (k, v) in [("PC", name.as_str()), ("Addresses", addrs.as_str()), ("Port", &port.to_string()), ("Token", token.as_str()), ("PC key", fp.as_str())] {
                                w::subtle(ui, k, "label-12");
                                copy_line(ui, v);
                            }
                            let left = hub.tokens.lock().unwrap().iter().find(|t| t.token == *token).map_or(0, |t| (crate::phoneauth::TICKET_TTL - (crate::store::now() - t.created)).max(0));
                            w::subtle(ui, format!("Good once, for {} more min.", (left + 59) / 60), "label-12");
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
            // Not used: void now.
            if let Some((tok, _, _)) = self.api.ui.pairing.take() {
                let mut tokens = hub.tokens.lock().unwrap();
                tokens.retain(|t| !(t.token == tok && t.ticket));
                api::save_tokens(&self.store, &tokens);
            }
        }
        if self.api.ui.pairing.is_some() {
            ctx.request_repaint_after(std::time::Duration::from_secs(5));
        }

        section(ui, "Paired phones");
        let tokens: Vec<Token> = hub.tokens.lock().unwrap().iter().filter(|t| !t.ticket).cloned().collect();
        let phones = hub.paired_phones();
        let mut revoke = None;
        let mut unlock = None;
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
                            // Seen here or on another PC of the mesh, and its app's version.
                            let phone = phones.iter().find(|p| p.group == t.group && !t.group.is_empty());
                            let mut last = match phone.filter(|p| p.seen > 0) {
                                Some(p) => {
                                    let via = if p.via.is_empty() { String::new() } else { format!(" via {}", p.via) };
                                    match crate::app::ago(p.seen).as_str() {
                                        "now" => format!(" · seen just now{via}"),
                                        a => format!(" · last seen {a} ago{via}"),
                                    }
                                }
                                None => String::new(),
                            };
                            if let Some((note, _)) = phone.and_then(|p| crate::devices::app_note(p.app, p.seen)) {
                                last.push_str(&format!(" · {note}"));
                            }
                            let when = match crate::app::ago(t.created).as_str() {
                                "now" => "just now".to_string(),
                                a => format!("{a} ago"),
                            };
                            let key = if t.fp.is_empty() { "no key yet".to_string() } else { format!("key {}", crate::tls::short(&t.fp)) };
                            w::subtle(ui, format!("Paired {when} · {key}{last}"), "label-12");
                            let st = hub.auth3.status(&t.token);
                            ui.horizontal(|ui| {
                                if !t.three() {
                                    w::badge(ui, "Needs upgrade", Tone::Amber);
                                    w::subtle(ui, "Paired before three factors: it gets nothing until you confirm its code here (open Harbor on the phone).", "label-12");
                                } else if let Some(left) = st.locked {
                                    w::badge(ui, "Locked", Tone::Red);
                                    w::subtle(ui, format!("Too many failed sign-ins: locked for {} more min.", left.as_secs() / 60 + 1), "label-12");
                                } else {
                                    w::badge(ui, "3 factors", Tone::Green);
                                    let s = if st.sessions > 0 {
                                        let secs = st.next_key.as_secs();
                                        format!("Connected · key {} · next key in {}:{:02}{}", st.epoch + 1, secs / 60, secs % 60, if t.binding { " · bound to TLS" } else { "" })
                                    } else {
                                        "No session open".to_string()
                                    };
                                    w::subtle(ui, s, "label-12");
                                }
                            });
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if w::btn("Revoke").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                                revoke = Some(t.token.clone());
                            }
                            if hub.auth3.status(&t.token).locked.is_some() && w::btn("Unlock").sm().outline().show(ui).clicked() {
                                unlock = Some(t.token.clone());
                            }
                        });
                    });
                });
            }
        });
        if let Some(tok) = unlock {
            hub.auth3.unlock(&tok);
        }
        let log: Vec<(i64, String)> = hub.auth3.log.lock().unwrap().iter().rev().take(4).cloned().collect();
        if !log.is_empty() {
            ui.add_space(6.0);
            w::subtle(ui, "Recently refused", "label-12");
            for (at, what) in log {
                w::subtle(ui, format!("{} ago · {what}", crate::app::ago(at)), "label-12-mono");
            }
        }
        if !tokens.is_empty() {
            ctx.request_repaint_after(std::time::Duration::from_secs(1));
        }
        if let Some(tok) = revoke {
            // Its sessions end at once.
            hub.auth3.drop_token(&tok);
            // The phone's keys on the other PCs go too (mesh.rs).
            if let Some(g) = hub.tokens.lock().unwrap().iter().find(|t| t.token == tok).map(|t| t.group.clone()).filter(|g| !g.is_empty()) {
                self.mesh_revoke(&g);
            }
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
                w::subtle(ui, format!("{v} is on this PC. To install it, scan the code with the phone's camera (it downloads the latest release); the app updates itself from this PC afterwards."), "copy-14");
            }
            None => {
                w::subtle(ui, "This PC doesn't have the app yet. Installed copies of Harbor get it with every update; this one can download it from the latest release.", "copy-14");
            }
        }
        ui.add_space(8.0);
        if on {
            // Not from this PC: a phone's browser can't check this PC's key, and nothing here is
            // served in plain HTTP to the network.
            let url = "https://github.com/RDevNeo/harbor/releases/latest/download/harbor-android.apk".to_string();
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

impl App {
    /// "From outside your network": whether the router opened Harbor's port (portmap.rs), IPv6,
    /// proof that a paired device got in from the internet, and the firewall.
    pub fn outside_section(&mut self, ui: &mut Ui) {
        let ctx = ui.ctx().clone();
        let port = *self.api.hub.port.lock().unwrap();
        section(ui, "From outside your network");
        let mut map = self.store.get("net_map").as_deref() != Some("0");
        let was = map;
        let mut fix = false;
        rows(ui, |ui| {
            w::setting_row(
                ui,
                "Open a port on my router",
                "Asks your router (UPnP, NAT-PMP or PCP) to let your phone on mobile data and your PCs elsewhere reach this PC. From the internet, Harbor answers only phones and PCs paired with it.",
                |ui| w::toggle(ui, &mut map),
            );
            w::separator(ui);
            let mut fwd = self.store.get("net_forward").unwrap_or_default();
            let before = fwd.clone();
            w::setting_row(ui, "Port forward on my router", &format!("If you forwarded a port on your router to this PC's port {port} by hand, its number outside. Harbor then tells your phone this network's public address with it."), |ui| {
                w::input(ui, &mut fwd, "e.g. 47930", true, 90.0);
            });
            if fwd != before && (fwd.trim().is_empty() || fwd.trim().parse::<u16>().is_ok_and(|p| p != 0)) {
                self.store.set("net_forward", fwd.trim());
            }
            w::separator(ui);
            let mut name = self.store.get("net_name").unwrap_or_default();
            let before = name.clone();
            w::setting_row(ui, "Public name", "A dynamic DNS name that follows your home's public address (your router's DDNS, for example). Phones keep it, so they find this PC after the address changes.", |ui| {
                w::input(ui, &mut name, "home.example.org", true, 200.0);
            });
            if name != before && (name.trim().is_empty() || crate::portmap::valid_name(name.trim())) {
                self.store.set("net_name", name.trim());
            }
            for (title, detail, good) in crate::portmap::summary(port) {
                w::separator(ui);
                w::setting_row(ui, &title, &detail, |ui| {
                    w::badge(ui, if good { "Yes" } else { "No" }, if good { Tone::Green } else { Tone::Gray });
                });
            }
            if crate::tls::firewall_blocks_internet(port) {
                w::separator(ui);
                w::setting_row(ui, "The firewall blocks the internet", &format!("This PC's firewall (ufw) drops port {port} from outside your network, even where the router lets it in."), |ui| {
                    if w::btn("Allow from the internet").sm().outline().show(ui).clicked() {
                        fix = true;
                    }
                });
            }
        });
        if map != was {
            self.store.set("net_map", if map { "1" } else { "0" });
        }
        if fix {
            let cmd = format!("{} && echo && echo 'Done: paired devices can reach Harbor from the internet where your router lets them.'", crate::tls::firewall_fix_internet(port));
            self.open_terminal(&ctx, "Firewall", crate::store::home(), vec!["bash".into(), "-lc".into(), cmd], vec![]);
        }
        ctx.request_repaint_after(std::time::Duration::from_secs(5));
    }

    /// Opens a terminal that lets the local network through ufw to Harbor's port (it asks for
    /// the password there).
    pub fn open_firewall(&mut self, ctx: &egui::Context) {
        let port = *self.api.hub.port.lock().unwrap();
        let cmd = format!("{} && echo && echo 'Done: other devices on your network can reach Harbor now.'", crate::tls::firewall_fix(port));
        self.open_terminal(ctx, "Firewall", crate::store::home(), vec!["bash".into(), "-lc".into(), cmd], vec![]);
    }

    /// A frame when the next typing lease runs out, so the sidebar's ✎ goes on time.
    pub fn typing_repaint(&self, ctx: &egui::Context) {
        if let Some(e) = self.api.hub.next_typing_expiry() {
            ctx.request_repaint_after(e.saturating_duration_since(std::time::Instant::now()) + std::time::Duration::from_millis(50));
        }
    }

    /// Who is typing in `chat` on another device (this PC's own composer left out).
    pub fn others_typing(&self, chat: i64) -> Vec<api::Typer> {
        let me = api::local_device();
        self.typers(chat).into_iter().filter(|t| t.device != me).collect()
    }

    /// "✎ Galaxy A13 is typing…" above the composer while another device writes in this chat.
    pub fn typing_line(&self, ui: &mut Ui, chat: i64) {
        let who = self.others_typing(chat);
        let Some(soonest) = who.iter().map(|t| t.until).min() else { return };
        let names: Vec<&str> = who.iter().map(|t| t.label.as_str()).collect();
        let text = match names.as_slice() {
            [one] => format!("{}  {one} is typing…", ic::PEN_LINE),
            [a, b] => format!("{}  {a} and {b} are typing…", ic::PEN_LINE),
            _ => format!("{}  {} people are typing…", ic::PEN_LINE, names.len()),
        };
        ui.horizontal(|ui| {
            ui.add_space(6.0);
            w::subtle(ui, text, "label-12");
        });
        ui.add_space(4.0);
        // The line goes when the lease runs out, even if nothing else repaints.
        ui.ctx().request_repaint_after(soonest.saturating_duration_since(std::time::Instant::now()) + std::time::Duration::from_millis(50));
    }
}
