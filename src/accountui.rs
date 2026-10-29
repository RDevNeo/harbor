//! Settings › Account and the sign-in page (account.rs): who is signed in on this PC, its
//! workspace, the workspace's people and PCs, invitations; and settings that came from the
//! account being applied here (settingsync.rs).

use crate::account::{self, Status};
use crate::app::App;
use crate::icons as ic;
use crate::pages::{rows, section};
use crate::widgets::{self as w, Tip as _, Tone};
use eframe::egui::{self, Align, Layout, Margin, Ui};

/// "3 min ago" for a unix time.
fn ago(t: i64) -> String {
    match crate::app::ago(t).as_str() {
        "now" => "just now".to_string(),
        a => format!("{a} ago"),
    }
}

impl App {
    /// Everything that isn't drawing: sign-in results and settings from the account.
    pub fn account_tick(&mut self, ctx: &egui::Context) {
        // Just signed in: phones and the workspace's other PCs can reach this one.
        if account::take_enable() {
            if !self.api.hub.enabled.load(std::sync::atomic::Ordering::SeqCst) {
                self.api_set_enabled(true, ctx);
            }
            if !self.api.hub.mesh.on.load(std::sync::atomic::Ordering::SeqCst) {
                self.mesh_set_enabled(true, ctx);
            }
        }
        if crate::settingsync::RELOAD.swap(false, std::sync::atomic::Ordering::SeqCst) {
            self.reload_settings(ctx);
        }
        if let Some(n) = account::take_notice() {
            crate::picker::show_toast(ctx, n);
        }
    }

    /// Settings changed on another device of the account (already in kv): what the window
    /// keeps in memory is read again.
    pub fn reload_settings(&mut self, ctx: &egui::Context) {
        let get = |k: &str| self.store.get(k).unwrap_or_default();
        let mode = crate::theme::Mode::parse(&get("theme"));
        if mode != self.theme.mode {
            self.theme.set_mode(mode, ctx);
        }
        crate::theme::set_compact(get("density") == "compact");
        self.keys = crate::keys::Keys::load(&self.store);
        self.order_by_activity = get("order_by_activity") == "1";
        self.fast = get("fast_mode") == "1";
        self.favorites = get("favorites").split(',').filter_map(|x| x.split_once('|')).map(|(a, m)| (a.to_string(), m.to_string())).collect();
        self.queue.default = None;
        let mut sel = self.draft.sel.clone();
        // Another PC's default account may not exist here: then this PC's defaults stay.
        let acct = self.store.get("default_account").filter(|a| self.account(a).is_some());
        if let Some(a) = acct {
            sel.account = a;
            for (k, v) in [("default_model", &mut sel.model), ("default_effort", &mut sel.effort), ("default_access", &mut sel.access)] {
                if let Some(x) = self.store.get(k).filter(|x| !x.is_empty()) {
                    *v = x;
                }
            }
        }
        self.draft.sel = sel;
        self.voice_load();
        ctx.request_repaint();
    }

    /// The page shown instead of everything else while nobody is signed in on this PC. Agents,
    /// the hub and the workspace's phones keep going behind it.
    pub fn signin_page(&mut self, ui: &mut Ui) {
        let t = self.theme.t;
        let st = account::status();
        egui::CentralPanel::default().frame(egui::Frame::new().fill(t.bg100)).show(ui, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space((ui.available_height() * 0.22).max(24.0));
                w::text(ui, "Sign in to Harbor", "heading-32");
                ui.add_space(6.0);
                w::subtle(ui, "Harbor works with your Google account: your PCs and phones find each other, the people you invite share them, and your settings follow you.", "copy-14");
                ui.add_space(20.0);
                if st.signing_in {
                    w::badge(ui, "Waiting for the browser…", Tone::Gray);
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        ui.add_space((ui.available_width() - 280.0).max(0.0) / 2.0);
                        if !st.url.is_empty() && w::btn(&format!("{}  Open the page again", ic::GLOBE)).sm().outline().show(ui).clicked() {
                            crate::git::open_url(&st.url);
                        }
                        if w::btn("Cancel").sm().show(ui).clicked() {
                            account::cancel_sign_in();
                        }
                    });
                } else if w::btn("Sign in with Google").primary().show(ui).clicked() {
                    account::sign_in();
                }
                if !st.error.is_empty() {
                    ui.add_space(12.0);
                    w::subtle(ui, &st.error, "label-13");
                }
                if !account::workspace().is_empty() {
                    ui.add_space(16.0);
                    w::subtle(ui, "This PC stays in its workspace while signed out: its people's phones and PCs still reach it.", "label-12");
                }
                ui.add_space(8.0);
                w::subtle(ui, "Agents and chats keep running in the background.", "label-12");
            });
        });
        if st.signing_in {
            ui.ctx().request_repaint_after(std::time::Duration::from_secs(1));
        }
    }

    pub fn account_tab(&mut self, ui: &mut Ui) {
        let st = account::status();
        self.account_banners(ui, &st);
        let Some(me) = account::account() else {
            rows(ui, |ui| {
                w::setting_row(ui, "Sign in with Google", "Every PC and phone signs in. Your PCs find each other through your workspace, and settings follow your account.", |ui| {
                    if st.signing_in {
                        if w::btn("Cancel").sm().show(ui).clicked() {
                            account::cancel_sign_in();
                        }
                    } else if w::btn("Sign in").sm().primary().show(ui).clicked() {
                        account::sign_in();
                    }
                });
            });
            if st.signing_in && !st.url.is_empty() {
                ui.add_space(6.0);
                ui.horizontal_wrapped(|ui| {
                    w::subtle(ui, "Waiting for the browser.", "label-13");
                    if w::btn("Open the page again").sm().outline().show(ui).clicked() {
                        crate::git::open_url(&st.url);
                    }
                });
            }
            if !account::configured() {
                ui.add_space(6.0);
                w::subtle(ui, "This build of Harbor has no account service set up (a development build).", "label-12");
            }
            return;
        };
        rows(ui, |ui| {
            let who = if me.name.is_empty() { me.email.clone() } else { me.name.clone() };
            w::setting_row(ui, &who, &format!("{} · signed in with Google. To use another account, sign out and sign in again.", me.email), |ui| {
                if w::btn("Sign out").sm().variant(w::Variant::GhostDestructive).show(ui).tip("Signs this PC out. It stays in its workspace, so its people's phones and PCs keep reaching it.").clicked() {
                    account::sign_out();
                }
            });
        });

        // Invitations to other workspaces: only Accept joins.
        let pending = account::invites();
        if !pending.is_empty() {
            section(ui, "Invitations");
            w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
                ui.set_width(ui.available_width());
                for (i, inv) in pending.iter().enumerate() {
                    if i > 0 {
                        w::separator(ui);
                    }
                    egui::Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.vertical(|ui| {
                                ui.spacing_mut().item_spacing.y = 1.0;
                                w::text(ui, format!("{}  {}", ic::USERS, if inv.ws_name.is_empty() { "A workspace" } else { &inv.ws_name }), "strong-14");
                                let by = if inv.inviter_name.is_empty() { String::new() } else { format!("{} invited ", inv.inviter_name) };
                                w::subtle(ui, format!("{by}{} · {}", inv.email, ago(inv.at)), "label-12");
                            });
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if w::btn("Decline").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() && !st.busy {
                                    account::decline_invite(inv.id.clone());
                                }
                                if w::btn("Accept").sm().primary().show(ui).tip("Join this workspace: its PCs and chats reach you on every device. This PC stays in its workspace.").clicked() && !st.busy {
                                    account::accept_invite(inv.id.clone());
                                }
                            });
                        });
                    });
                }
            });
        }

        let ws = account::workspace();
        let dir = account::directory();
        section(ui, "This PC's workspace");
        if st.pick || ws.is_empty() {
            w::subtle(ui, "Pick the workspace this PC belongs to: its people get all of this PC's chats.", "copy-14");
            ui.add_space(6.0);
            w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
                ui.set_width(ui.available_width());
                for (i, wsp) in me.workspaces.iter().enumerate() {
                    if i > 0 {
                        w::separator(ui);
                    }
                    egui::Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                        ui.horizontal(|ui| {
                            w::text(ui, format!("{}  {}", ic::USERS, wsp.name), "strong-14");
                            w::badge(ui, if wsp.owner() { "Owner" } else { "Member" }, Tone::Gray);
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if w::btn("Use this one").sm().primary().show(ui).clicked() && !st.busy {
                                    account::choose_workspace(wsp.id.clone());
                                }
                            });
                        });
                    });
                }
            });
            return;
        }
        let here = dir.of(&ws).cloned();
        let name = here.as_ref().map(|d| d.ws.name.clone()).or_else(|| me.workspaces.iter().find(|w| w.id == ws).map(|w| w.name.clone())).unwrap_or_default();
        let owner = here.as_ref().is_some_and(|d| d.ws.owner());
        let mut leave_pc = false;
        let mut move_to = None;
        rows(ui, |ui| {
            w::setting_row(ui, &name, "Everyone in this workspace controls all of its PCs and sees all of their chats, from their own PCs and phones.", |ui| {
                w::badge(ui, if owner { "Owner" } else { "Member" }, Tone::Gray);
            });
            let others: Vec<_> = me.workspaces.iter().filter(|w| w.id != ws).cloned().collect();
            if !others.is_empty() {
                w::separator(ui);
                w::setting_row(ui, "Move this PC", "To another workspace you're in. Its chats then belong to that workspace's people.", |ui| {
                    for o in &others {
                        if w::btn(&o.name).sm().outline().show(ui).clicked() {
                            move_to = Some(o.id.clone());
                        }
                    }
                });
            }
            w::separator(ui);
            w::setting_row(ui, "Take this PC out", "It leaves the workspace: its people's phones and PCs stop reaching it.", |ui| {
                if w::btn("Take out").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                    leave_pc = true;
                }
            });
        });
        if let Some(id) = move_to.filter(|_| !st.busy) {
            account::choose_workspace(id);
        }
        if leave_pc && !st.busy {
            account::leave_workspace();
        }
        let Some(d) = here else {
            ui.add_space(6.0);
            w::subtle(ui, "Fetching the workspace…", "label-13");
            return;
        };

        section(ui, "People");
        let mut remove = None;
        w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
            ui.set_width(ui.available_width());
            for (i, m) in d.members.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                egui::Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            let you = if m.id == me.id { " (you)" } else { "" };
                            w::text(ui, format!("{}  {}{you}", ic::USER_ROUND, if m.name.is_empty() { &m.email } else { &m.name }), "strong-14");
                            w::subtle(ui, &m.email, "label-12");
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let self_ = m.id == me.id;
                            if owner && !self_ && w::btn("Remove").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                                remove = Some(m.id.clone());
                            }
                            if self_ && !d.ws.personal && w::btn("Leave").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                                remove = Some(m.id.clone());
                            }
                            w::badge(ui, if m.role == "owner" { "Owner" } else { "Member" }, Tone::Gray);
                        });
                    });
                });
            }
        });
        if let Some(u) = remove.filter(|_| !st.busy) {
            account::remove_member(d.ws.id.clone(), u);
        }
        if owner {
            ui.add_space(8.0);
            let id = egui::Id::NULL.with("account-invite");
            let mut email: String = ui.ctx().data_mut(|x| x.get_temp(id)).unwrap_or_default();
            let mut send = false;
            ui.horizontal(|ui| {
                let r = w::input(ui, &mut email, "name@example.com", false, 260.0);
                send = r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                send |= w::btn(&format!("{}  Invite", ic::PLUS)).sm().primary().show(ui).clicked();
            });
            w::subtle(ui, "Once they sign in to Harbor with Google using that address, on a PC or phone, the invitation waits there; when they accept, they have full control of this workspace's PCs and chats. Only owners invite and remove people.", "label-12");
            if send && email.contains('@') && !st.busy {
                account::invite(d.ws.id.clone(), email.trim().to_lowercase());
                email.clear();
            }
            ui.ctx().data_mut(|x| x.insert_temp(id, email));
            if !d.invites.is_empty() {
                ui.add_space(6.0);
                let mut cancel = None;
                for inv in &d.invites {
                    ui.horizontal_wrapped(|ui| {
                        w::subtle(ui, format!("Invited {} · {}", inv.email, ago(inv.at)), "label-13");
                        if w::btn(ic::X).muted().icon_xs().show(ui).tip("Cancel the invitation").clicked() {
                            cancel = Some(inv.id.clone());
                        }
                    });
                }
                if let Some(c) = cancel.filter(|_| !st.busy) {
                    account::cancel_invite(d.ws.id.clone(), c);
                }
            }
        }

        section(ui, "PCs");
        let mine = crate::tls::my_fp();
        w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
            ui.set_width(ui.available_width());
            if d.pcs.is_empty() {
                egui::Frame::new().inner_margin(Margin::same(16)).show(ui, |ui| w::subtle(ui, "None yet.", "label-13"));
            }
            for (i, p) in d.pcs.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                egui::Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        w::text(ui, format!("{}  {}", ic::MONITOR, p.name), "strong-14");
                        if p.fp == mine {
                            w::badge(ui, "This PC", Tone::Green);
                        } else if self.api.hub.mesh.peers.lock().unwrap().values().any(|x| x.fp == p.fp && x.online) {
                            w::badge(ui, "Online", Tone::Green);
                        }
                    });
                    let by = if p.owner_name.is_empty() { String::new() } else { format!(" · added by {}", p.owner_name) };
                    let v = if p.version.is_empty() { String::new() } else { format!(" · Harbor {}", p.version) };
                    w::subtle(ui, format!("key {}{by}{v} · checked in {}", crate::tls::short(&p.fp), ago(p.seen)), "label-12");
                });
            }
        });

        let others: Vec<_> = dir.workspaces.iter().filter(|x| x.ws.id != ws).cloned().collect();
        if !others.is_empty() {
            section(ui, "Your other workspaces");
            let mut leave = None;
            w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
                ui.set_width(ui.available_width());
                for (i, o) in others.iter().enumerate() {
                    if i > 0 {
                        w::separator(ui);
                    }
                    egui::Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.vertical(|ui| {
                                ui.spacing_mut().item_spacing.y = 1.0;
                                w::text(ui, format!("{}  {}", ic::USERS, o.ws.name), "strong-14");
                                w::subtle(ui, format!("{} people · {} PCs", o.members.len(), o.pcs.len()), "label-12");
                            });
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if !o.ws.personal && w::btn("Leave").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                                    leave = Some(o.ws.id.clone());
                                }
                                w::badge(ui, if o.ws.owner() { "Owner" } else { "Member" }, Tone::Gray);
                            });
                        });
                    });
                }
            });
            if let Some(id) = leave.filter(|_| !st.busy) {
                account::remove_member(id, me.id.clone());
            }
        }
        if st.busy || st.signing_in {
            ui.ctx().request_repaint_after(std::time::Duration::from_millis(500));
        }
    }

    /// Sign-in ran out, the service can't be reached, an error: above the page.
    fn account_banners(&mut self, ui: &mut Ui, st: &Status) {
        let mut any = false;
        if st.expired && account::signed_in() {
            any = true;
            ui.horizontal_wrapped(|ui| {
                w::badge(ui, "Sign in again", Tone::Amber);
                w::subtle(ui, "Your sign-in ran out. Everything keeps working here; sign in again to sync settings and the workspace.", "label-13");
                if !st.signing_in && w::btn("Sign in").sm().primary().show(ui).clicked() {
                    account::sign_in();
                }
            });
        }
        if st.offline_since > 0 {
            any = true;
            ui.horizontal_wrapped(|ui| {
                w::badge(ui, "Offline", Tone::Gray);
                w::subtle(ui, format!("The account service hasn't answered since {}: working with what this PC has cached.", ago(st.offline_since)), "label-13");
            });
        }
        if !st.error.is_empty() {
            any = true;
            ui.horizontal_wrapped(|ui| {
                w::badge(ui, "Account", Tone::Red);
                w::subtle(ui, &st.error, "label-13");
            });
        }
        if st.synced_at > 0 {
            any = true;
            w::subtle(ui, format!("Synced {}.", ago(st.synced_at)), "label-12");
        }
        if any {
            ui.add_space(10.0);
        }
    }
}
