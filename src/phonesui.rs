//! Settings › Phones: turns the phone API (api.rs) on, lists the phones signed in with Google
//! that reached this PC (a lost one can be signed out) and offers the app itself. There's no
//! pairing: a phone signs in with an account of this PC's workspace (account.rs).

use crate::widgets::Tip as _;
use crate::api::{self, Token};
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
        if w::btn(ic::COPY).muted().icon_xs().show(ui).tip("Copy").clicked() {
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
                "Harbor for Android lists, opens and starts this PC's chats over your network. Every connection is encrypted with this PC's key and the phone's own, and Harbor answers only phones signed in with Google by people in this PC's workspace.",
                |ui| w::toggle(ui, &mut on),
            );
        });
        if on != was {
            self.api_set_enabled(on, &ctx);
        }
        let net = hub.net.lock().unwrap().clone();
        let port = *hub.port.lock().unwrap();
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

        section(ui, "Add a phone");
        let mine = crate::account::my_dir();
        match &mine {
            Some(d) => w::subtle(ui, format!("Install Harbor for Android (below) and sign in with Google there, with an account in this PC's workspace, “{}”. The phone finds this PC and the workspace's other PCs on its own: no code to scan or confirm. To add someone else, invite them in Settings › Account.", d.ws.name), "copy-14"),
            None if crate::account::workspace().is_empty() => w::subtle(ui, "Sign in on this PC first (Settings › Account): phones reach the PCs of their account's workspaces.", "copy-14"),
            None => w::subtle(ui, "Install Harbor for Android (below) and sign in with Google there, with an account in this PC's workspace.", "copy-14"),
        };
        if crate::account::workspace().is_empty() {
            ui.add_space(6.0);
            if w::btn(&format!("{}  Open Settings › Account", ic::USER_ROUND)).sm().outline().show(ui).clicked() {
                self.open(crate::app::View::Settings(crate::app::Tab::Account));
            }
        }

        section(ui, "Phones");
        let tokens: Vec<Token> = hub.tokens.lock().unwrap().iter().filter(|t| !t.account.is_empty()).cloned().collect();
        let old = hub.tokens.lock().unwrap().iter().filter(|t| t.account.is_empty()).count();
        let phones = hub.paired_phones();
        let me = crate::account::account();
        let owner = mine.as_ref().is_some_and(|d| d.ws.owner());
        let mut sign_out = None;
        w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
            ui.set_width(ui.available_width());
            if tokens.is_empty() {
                egui::Frame::new().inner_margin(Margin::same(16)).show(ui, |ui| w::subtle(ui, "No phone has connected yet.", "label-13"));
            }
            for (i, t) in tokens.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                egui::Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            let label = if t.name.is_empty() { "Phone".to_string() } else { t.name.clone() };
                            w::text(ui, format!("{}  {label}", ic::SMARTPHONE), "strong-14");
                            // Seen here or on another PC of the mesh, and its app's version.
                            let phone = phones.iter().find(|p| p.group == t.group && !t.group.is_empty());
                            let mut last = match phone.filter(|p| p.seen.max(p.alive) > 0) {
                                Some(p) => {
                                    let via = if p.via.is_empty() { String::new() } else { format!(" via {}", p.via) };
                                    let now = crate::store::now();
                                    // Open now, or reachable with the app in the background (its pings).
                                    if now - p.seen < crate::devices::PHONE_OPEN_SECS {
                                        format!(" · Harbor open{via}")
                                    } else if now - p.alive < crate::devices::PHONE_ALIVE_SECS {
                                        format!(" · online{via}, app in the background (checked in {})", match crate::app::ago(p.alive).as_str() {
                                            "now" => "just now".to_string(),
                                            a => format!("{a} ago"),
                                        })
                                    } else {
                                        match crate::app::ago(p.seen.max(p.alive)).as_str() {
                                            "now" => format!(" · seen just now{via}"),
                                            a => format!(" · last seen {a} ago{via}"),
                                        }
                                    }
                                }
                                None => String::new(),
                            };
                            if let Some((note, _)) = phone.and_then(|p| crate::devices::app_note(p.app, p.seen)) {
                                last.push_str(&format!(" · {note}"));
                            }
                            let who = if t.account_name.is_empty() { "Signed in".to_string() } else { format!("Signed in as {}", t.account_name) };
                            w::subtle(ui, format!("{who} · key {}{last}", crate::tls::short(&t.fp)), "label-12");
                        });
                        // The phone's own account, or an owner of the workspace, may sign it out.
                        let may = me.as_ref().is_some_and(|a| a.id == t.account) || owner;
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if may && w::btn("Sign out").sm().variant(w::Variant::GhostDestructive).show(ui).tip("Signs this phone out of the account: every PC refuses it from their next directory update (a few minutes). For a lost phone.").clicked() {
                                sign_out = Some(t.fp.clone());
                            }
                        });
                    });
                });
            }
        });
        if let Some(fp) = sign_out {
            crate::account::remove_device(fp.clone());
            hub.tokens.lock().unwrap().retain(|t| t.fp != fp || t.account.is_empty());
            hub.tokens_dirty.store(true, Ordering::SeqCst);
        }
        if old > 0 {
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                w::subtle(ui, format!("{old} phone pairing{} from before Google accounts: they can only update the app, then sign in.", if old == 1 { "" } else { "s" }), "label-12");
                if w::btn("Remove").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                    let mut tokens = hub.tokens.lock().unwrap();
                    tokens.retain(|t| !t.account.is_empty());
                    api::save_tokens(&self.store, &tokens);
                }
            });
        }
        let log: Vec<(i64, String)> = api::REFUSED.lock().unwrap().iter().rev().take(4).cloned().collect();
        if !log.is_empty() {
            ui.add_space(6.0);
            w::subtle(ui, "Recently refused", "label-12");
            for (at, what) in log {
                w::subtle(ui, format!("{} ago · {what}", crate::app::ago(at)), "label-12-mono");
            }
        }
        if !tokens.is_empty() {
            ctx.request_repaint_after(std::time::Duration::from_secs(5));
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
    /// Also when this PC's own held-back draft is due (`local_typing`).
    pub fn typing_repaint(&self, ctx: &egui::Context) {
        if let Some(e) = self.api.hub.next_typing_expiry().into_iter().chain(self.api.draft_due).min() {
            ctx.request_repaint_after(e.saturating_duration_since(std::time::Instant::now()) + std::time::Duration::from_millis(50));
        }
    }

    /// Who is typing in `chat` on another device (this PC's own composer left out).
    pub fn others_typing(&self, chat: i64) -> Vec<api::Typer> {
        let me = api::local_device();
        self.typers(chat).into_iter().filter(|t| t.device != me).collect()
    }

    /// "✎ Galaxy A13" for the composer's corner while other devices write in this chat (its
    /// shared draft is theirs then), or None.
    /// Also when the soonest of their leases runs out (the label goes then).
    pub fn typing_label(&self, chat: i64) -> Option<(String, std::time::Instant)> {
        let who = self.others_typing(chat);
        let soonest = who.iter().map(|t| t.until).min()?;
        let names: Vec<&str> = who.iter().map(|t| t.label.as_str()).collect();
        Some((format!("{}  {}", ic::PEN_LINE, names.join(", ")), soonest))
    }
}
