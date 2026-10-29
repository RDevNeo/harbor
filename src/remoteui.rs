//! Devices in the UI: the composer's "runs on" picker and Settings › Devices
//! (your paired PCs, SSH defaults, every device's name, icon, folder and bridge).

use crate::widgets::Tip as _;
use crate::app::{App, Popup, Sel, Tab, View};
use crate::icons as ic;
use crate::pages::{rows, section};
use crate::providers::{Account, Kind};
use crate::remote::{self, Host};
use crate::store::Chat;
use crate::theme::{self, RADIUS_MD, Tokens};
use crate::widgets::{self as w, Tone};
use eframe::egui::{self, Align, Align2, Color32, CornerRadius, CursorIcon, FontId, Frame, Layout, Margin, Painter, Rect, Response, ScrollArea, Sense, TextureId, Ui, Vec2, pos2};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct State {
    /// The device whose settings are unfolded.
    open: Option<String>,
    add_name: String,
    add_host: String,
    add_user: String,
    /// Devices whose picked image was just copied in (by the file chooser's thread).
    picked: Arc<Mutex<Vec<String>>>,
    /// Their images, by device id, decoded on a thread (set None: the file didn't decode).
    pub(crate) icons: HashMap<String, Arc<std::sync::OnceLock<Option<egui::TextureHandle>>>>,
}

/// A device's mark: its image or glyph, with a dot when its online state is known.
fn paint_mark(p: &Painter, rect: Rect, glyph: &str, tex: Option<TextureId>, online: Option<bool>, fg: Color32, t: &Tokens) {
    match tex {
        Some(id) => {
            let r = rect.shrink(rect.width() * 0.06);
            p.image(id, r, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), Color32::WHITE);
        }
        None => ic::glyph(p, rect.center(), glyph, rect.height() * 0.94, fg),
    }
    if let Some(on) = online {
        let c = pos2(rect.right() - 1.0, rect.bottom() - 1.0);
        let r = (rect.width() * 0.17).max(2.5);
        p.circle_filled(c, r + 1.5, t.bg100);
        p.circle_filled(c, r, if on { t.green(700) } else { t.gray(600) });
    }
}

/// A menu row with a device mark (as `w::menu_item`), dimmed when it can't be picked.
fn device_row(ui: &mut Ui, mark: impl Fn(&Painter, Rect, Color32), label: &str, desc: &str, checked: bool, enabled: bool) -> Response {
    let t = w::tokens(ui);
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 44.0), if enabled { Sense::click() } else { Sense::hover() });
    let p = ui.painter();
    if resp.hovered() && enabled {
        p.rect_filled(rect, CornerRadius::same(RADIUS_MD), t.gray(100));
    }
    let a = if enabled { 1.0 } else { 0.45 };
    let x = rect.left() + 10.0;
    mark(p, Rect::from_center_size(pos2(x + 7.0, rect.top() + 16.0), Vec2::splat(16.0)), w::alpha(t.subtle(), a));
    p.text(pos2(x + 24.0, rect.top() + 7.0), Align2::LEFT_TOP, label, FontId::new(14.0, theme::medium()), w::alpha(t.fg(), a));
    p.text(pos2(x + 24.0, rect.top() + 25.0), Align2::LEFT_TOP, desc, FontId::proportional(12.0), w::alpha(t.subtle(), a));
    if checked {
        ic::glyph(p, pos2(rect.right() - 16.0, rect.top() + 16.0), ic::CHECK, 16.0, t.fg());
    }
    if enabled { resp.on_hover_cursor(CursorIcon::PointingHand) } else { resp }
}

fn where_(h: &Host, online: Option<bool>) -> String {
    let state = match online {
        Some(true) => "Online · ",
        Some(false) => "Offline · ",
        None => "",
    };
    format!("{state}{}", h.host)
}

impl App {
    /// The image of a device with a custom icon (loaded once, off the UI thread).
    fn device_tex(&mut self, ctx: &egui::Context, h: &Host) -> Option<TextureId> {
        if h.icon != "file" {
            return None;
        }
        let e = self.devices_ui.icons.entry(h.id.clone()).or_insert_with(|| {
            let slot = Arc::new(std::sync::OnceLock::new());
            let (slot2, ctx, id) = (slot.clone(), ctx.clone(), h.id.clone());
            std::thread::spawn(move || {
                let tex = crate::favicon::decode(&remote::icon_path(&id)).map(|img| ctx.load_texture(format!("device-{id}"), img, egui::TextureOptions::LINEAR));
                let _ = slot2.set(tex);
                ctx.request_repaint();
            });
            slot
        });
        e.get().and_then(|t| t.as_ref()).map(|t| t.id())
    }

    /// The composer's device control: "This PC" or the chat's device, with its dot.
    pub fn device_trigger(&mut self, ui: &mut Ui, compact: bool, sel: &Sel) -> Response {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        let net = remote::tailnet(&ctx);
        let found = remote::devices(&self.remote, &net).into_iter().find(|(h, _)| h.id == sel.device);
        // Another PC's chat runs on that PC, whatever it's set to there.
        let copy = match self.view {
            View::Chat(id) => self.chat(id).filter(|c| c.foreign()).map(|c| c.home.clone()),
            _ => None,
        };
        let hub = self.api.hub.mesh.peer(copy.as_deref().unwrap_or(&sel.device)).or_else(|| copy.as_ref().map(|h| crate::mesh::Peer { id: h.clone(), name: crate::mesh::label(h), ..Default::default() }));
        let found = if copy.is_some() { None } else { found };
        let (label, glyph, tex, online) = match &found {
            _ if copy.is_some() => (hub.as_ref().map(|p| p.name.clone()).unwrap_or_default(), ic::MONITOR, None, hub.as_ref().map(|p| p.online)),
            _ if sel.device.is_empty() => ("This PC".to_string(), ic::HOUSE, None, None),
            None if hub.is_some() => (hub.as_ref().map(|p| p.name.clone()).unwrap_or_default(), ic::MONITOR, None, hub.as_ref().map(|p| p.online)),
            None => ("Missing device".to_string(), ic::ALERT, None, None),
            Some((h, o)) => (h.label().to_string(), remote::glyph(h), self.device_tex(&ctx, h), *o),
        };
        let paint = move |p: &Painter, r: Rect, fg: Color32| paint_mark(p, r, glyph, tex, online, fg, &t);
        let r = w::trigger(ui, w::Lead::Paint(&paint), if compact { "" } else { &label }, self.popup == Some(Popup::Device));
        let tip = match &found {
            _ if hub.is_some() => format!("Runs in Harbor on {}", hub.as_ref().map(|p| p.name.as_str()).unwrap_or("")),
            Some((h, o)) => format!("Runs on {} · {}", h.label(), where_(h, *o)),
            None if sel.device.is_empty() => "Runs on this PC".into(),
            None => "This chat's device was removed in Settings › Devices".into(),
        };
        r.tip(tip)
    }

    /// The device menu above the composer; returns whether it should close. A started chat of
    /// this PC moves where it's picked, its sessions with it (relocate.rs); places it can't go
    /// to now are greyed out with why.
    pub fn device_menu(&mut self, ctx: &egui::Context) -> bool {
        let t = self.theme.t;
        let sel = self.sel();
        let kind = self.account(&sel.account).map(|a| a.kind).unwrap_or(Kind::Claude);
        let chat = match self.view {
            View::Chat(id) => self.chat(id).filter(|c| c.started).cloned(),
            _ => None,
        };
        // Another PC's started chat runs in that PC's Harbor: it stays as it is from here.
        let locked = chat.as_ref().is_some_and(|c| c.foreign());
        let moving = chat.as_ref().filter(|c| !c.foreign()).map(|c| c.id);
        let net = remote::tailnet(ctx);
        let all = remote::devices(&self.remote, &net);
        let devs: Vec<(Host, Option<bool>)> = all.iter().filter(|(h, _)| !h.hidden || h.id == sel.device).cloned().collect();
        // SSH hosts get their online dot (and OS) from one test per session.
        for (h, _) in &devs {
            remote::test_once(&self.remote, h, ctx);
        }
        if remote::adopt_os(&mut self.remote) {
            remote::save(&self.store, &self.remote);
        }
        let texs: Vec<Option<TextureId>> = devs.iter().map(|(h, _)| self.device_tex(ctx, h)).collect();
        let me = remote::hostname();
        // PCs running Harbor with chats shared (mesh.rs): a chat picked there starts in that Harbor.
        let hubs = self.mesh_hosts();
        let only_hubs: Vec<crate::mesh::Peer> = hubs.iter().filter(|p| !devs.iter().any(|(h, _)| h.id == p.id)).cloned().collect();
        // A started chat: why it can't go to each place (None: it can).
        let why = |id: &str| moving.and_then(|c| self.relocate_why(c, id, &all));
        let here_why = why("");
        let dev_why: Vec<Option<String>> = devs.iter().map(|(h, _)| why(&h.id)).collect();
        let hub_why: Vec<Option<String>> = only_hubs.iter().map(|p| why(&p.id)).collect();
        let started = moving.is_some();
        let (pick, close) = w::popover(ctx, "device", self.popup_anchor, 300.0, true, &t, |ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            w::menu_label(ui, "Runs on");
            let mut pick: Option<Option<String>> = None;
            let here = sel.device.is_empty();
            let desc = here_why.clone().unwrap_or_else(|| me.clone());
            let r = device_row(ui, |p, r, fg| paint_mark(p, r, ic::HOUSE, None, None, fg, &t), "This PC", &desc, here, (!locked || here) && here_why.is_none());
            if r.clicked() {
                pick = Some(Some(String::new()));
            }
            ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                for (((h, online), tex), no) in devs.iter().zip(&texs).zip(&dev_why) {
                    let current = h.id == sel.device;
                    let ok = kind == Kind::Claude && (!locked || current) && no.is_none();
                    let glyph = remote::glyph(h);
                    let hub = hubs.iter().find(|p| p.id == h.id);
                    let ok = ok && hub.is_none_or(|p| p.online);
                    let desc = match hub {
                        _ if kind != Kind::Claude => "Claude Code only".to_string(),
                        _ if no.is_some() => no.clone().unwrap_or_default(),
                        Some(p) if p.online && started => "Harbor · the chat moves there".to_string(),
                        Some(p) if p.online => "Harbor · starts the chat there".to_string(),
                        Some(_) => "Harbor · off".to_string(),
                        None => where_(h, *online),
                    };
                    let r = device_row(ui, |p, r, fg| paint_mark(p, r, glyph, *tex, *online, fg, &t), h.label(), &desc, current, ok);
                    let r = if locked && !current { r.tip("This chat runs in another PC's Harbor: change where it runs there.") } else { r };
                    if r.clicked() {
                        pick = Some(Some(h.id.clone()));
                    }
                }
                for (p, no) in only_hubs.iter().zip(&hub_why) {
                    let current = p.id == sel.device;
                    let ok = kind == Kind::Claude && !locked && p.online && no.is_none();
                    let desc = match no {
                        Some(w) => w.clone(),
                        None if !p.online => "Harbor · off".into(),
                        None if started => "Harbor · the chat moves there".into(),
                        None => "Harbor · starts the chat there".into(),
                    };
                    let online = Some(p.online);
                    if device_row(ui, |pa, r, fg| paint_mark(pa, r, ic::MONITOR, None, online, fg, &t), &p.name, &desc, current, ok).clicked() {
                        pick = Some(Some(p.id.clone()));
                    }
                }
            });
            if devs.is_empty() {
                w::subtle(ui, "  No other PCs yet: pair one in Settings › Devices, or add one by SSH.", "label-12");
                ui.add_space(4.0);
            }
            w::menu_separator(ui);
            if w::menu_item(ui, ic::SETTINGS, "Manage devices…", None, false).clicked() {
                pick = Some(None);
            }
            pick
        });
        match pick {
            // A started chat moves there (on a thread); the outcome is a notice in it.
            Some(Some(id)) if moving.is_some() => {
                self.popup = None;
                if id != sel.device {
                    let chat = moving.unwrap_or_default();
                    match self.relocate(chat, &id, ctx) {
                        Ok(name) => crate::picker::show_toast(ctx, format!("Moving to {name}…")),
                        Err(e) => crate::picker::show_toast(ctx, format!("Couldn't move this chat: {e}")),
                    }
                }
            }
            Some(Some(id)) => {
                // A found PC picked for the first time is saved, so the chat finds it even
                // before the list is read again after a restart.
                if let Some((h, _)) = devs.iter().find(|(h, _)| h.id == id) {
                    if !self.remote.devices.iter().any(|d| d.id == id) {
                        self.remote.devices.push(h.clone());
                        remote::save(&self.store, &self.remote);
                    }
                }
                self.set_sel(Sel { device: id, ..sel });
                self.popup = None;
            }
            Some(None) => {
                self.popup = None;
                self.open(View::Settings(Tab::Devices));
            }
            None => {}
        }
        close
    }

    /// How a chat's turn reaches its device; None for this PC.
    pub fn remote_spec(&self, chat: &Chat, account: &Account, ctx: &egui::Context) -> Result<Option<crate::agent::Remote>, String> {
        if chat.device.is_empty() {
            return Ok(None);
        }
        let net = remote::tailnet(ctx);
        let h = remote::find(&self.remote, &net, &chat.device).ok_or("This chat's device isn't in Settings › Devices anymore. Add it again, or start a new chat on this PC.")?;
        if account.kind != Kind::Claude {
            return Err(format!("Only Claude Code runs on other devices so far; this chat uses {}.", account.kind.label()));
        }
        let project = chat.repo_id.and_then(|r| self.repo(r)).map(|r| r.dir().to_path_buf());
        let dir = remote::remote_dir(&h, project.as_deref());
        // Not known yet (a device added before Harbor asked): POSIX this time, and asked now.
        if h.os.is_empty() {
            remote::test_once(&self.remote, &h, ctx);
        }
        let os = if h.os.is_empty() { String::new() } else { format!("It runs {}. ", remote::os_label(&h.os)) };
        // Read only stays read only: no commands on this PC either.
        let commands = h.commands && chat.access != "plan";
        let note = format!(
            "You run on the device '{}', started over SSH by Harbor on '{}', in {dir}. {os}The user talks to you through Harbor, usually at that PC; a message written on a phone or another PC says where it came from. {}Harbor's own tools (processes, agents, webhooks) act on the Harbor PC. {}",
            h.label(),
            remote::hostname(),
            if h.device_files { "Files, shell, git and builds are that device's. " } else { "" },
            match (h.bridge, commands && h.device_files) {
                (true, true) => "Your MCP servers are the Harbor PC's, through a bridge; the `origin` server's run_command runs shell commands on the Harbor PC.",
                (true, false) => "Your MCP servers are the Harbor PC's, through a bridge.",
                (false, _) => "",
            }
        );
        // The account's login as of now (refreshed if it's about to expire).
        let token = crate::oauth::token(account.config_dir.as_deref());
        // With this PC's login the device's own profile (its user's instructions and memory)
        // is swapped for an empty one, and this PC's person's go in the note (meshctx.rs).
        // A chat commanded from another PC gets neither: its instructions are on that PC.
        let (setup, note) = match &token {
            Some(_) => {
                let mine = if self.guest_of(chat).is_some() { String::new() } else { crate::meshctx::device_note(project.as_deref(), !h.device_files) };
                (vec![remote::Setup::Guest(crate::meshctx::device_profile(&self.api.hub.mesh.me().id))], format!("{}\n\n{mine}", note.trim_end()))
            }
            None => (remote::profile_setup(account.config_dir.as_deref()), note),
        };
        Ok(Some(crate::agent::Remote {
            ssh: remote::ssh_opts(&self.remote, &h),
            host: h.host.clone(),
            name: h.label().to_string(),
            family: remote::family(&h.os),
            dir,
            setup,
            bridge: h.bridge,
            commands,
            workspace: !h.device_files,
            token,
            note: note.trim().to_string(),
        }))
    }

    // ------------------------------------------------------------ settings

    pub fn devices_tab(&mut self, ui: &mut Ui) {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        let net = remote::tailnet(&ctx);
        let before = self.remote.clone();
        let picked = std::mem::take(&mut *self.devices_ui.picked.lock().unwrap());
        for id in picked {
            self.devices_ui.icons.remove(&id);
            if let Some(h) = remote::find(&self.remote, &net, &id) {
                self.upsert(Host { icon: "file".into(), ..h });
            }
        }

        self.mesh_settings(ui);
        section(ui, "SSH");
        let mut port = if self.remote.port == 0 { String::new() } else { self.remote.port.to_string() };
        rows(ui, |ui| {
            w::setting_row(ui, "User", "Your user on the devices. Empty: ssh's default (your ~/.ssh/config, or this PC's user).", |ui| {
                w::input(ui, &mut self.remote.user, &crate::store::home().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), false, 180.0);
            });
            w::separator(ui);
            w::setting_row(ui, "Key", "Identity file. Empty: ssh's own keys and agent.", |ui| {
                w::input(ui, &mut self.remote.key, "~/.ssh/id_ed25519", true, 220.0);
            });
            w::separator(ui);
            w::setting_row(ui, "Port", "Empty: 22, or what ~/.ssh/config says.", |ui| {
                w::input(ui, &mut port, "22", true, 80.0);
            });
        });
        self.remote.port = port.trim().parse().unwrap_or(0);

        ui.add_space(12.0);
        section(ui, "Devices");
        remote::adopt_os(&mut self.remote);
        let devs = remote::devices(&self.remote, &net);
        for (h, _) in &devs {
            remote::test_once(&self.remote, h, &ctx);
        }
        w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing.y = 0.0;
            if devs.is_empty() {
                Frame::new().inner_margin(Margin::same(16)).show(ui, |ui| w::subtle(ui, "None yet. PCs you pair with this one appear here by themselves; add any other one by SSH below.", "label-13"));
            }
            for (i, (h, online)) in devs.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                self.device_card(ui, &ctx, &t, h, *online);
            }
        });

        ui.add_space(12.0);
        section(ui, "Add a device by SSH");
        w::card(ui).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                let st = &mut self.devices_ui;
                w::input(ui, &mut st.add_name, "Name", false, 140.0);
                w::input(ui, &mut st.add_host, "host, IP or ssh alias", true, 200.0);
                w::input(ui, &mut st.add_user, "user (optional)", true, 130.0);
                let ok = !st.add_host.trim().is_empty();
                if w::btn(&format!("{}  Add", ic::PLUS)).sm().primary().enabled(ok).show(ui).clicked() {
                    let st = &mut self.devices_ui;
                    let (name, host, user) = (st.add_name.trim().to_string(), st.add_host.trim().to_string(), st.add_user.trim().to_string());
                    st.add_name.clear();
                    st.add_host.clear();
                    st.add_user.clear();
                    self.add_ssh_device(&ctx, name, host, user, 0);
                }
            });
            // PCs to add in one click: ~/.ssh/config's hosts and those announcing ssh here.
            let offers: Vec<remote::Nearby> = remote::nearby(&ctx).into_iter().filter(|n| !remote::is_device(n, &devs)).collect();
            if !offers.is_empty() {
                ui.add_space(10.0);
                w::subtle(ui, "On your network and in ~/.ssh/config", "label-12");
                ui.add_space(4.0);
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = Vec2::new(6.0, 6.0);
                    for n in offers {
                        let tip = format!("Add {} ({}) and test it", n.host, n.source);
                        if w::btn(&format!("{}  {}", ic::PLUS, n.name)).sm().outline().show(ui).tip(tip).clicked() {
                            let name = if n.name == n.host { String::new() } else { n.name.clone() };
                            self.add_ssh_device(&ctx, name, n.host.clone(), n.user.clone(), n.port);
                        }
                    }
                });
            }
        });

        ui.add_space(12.0);
        w::subtle(
            ui,
            "A chat picks its device in the composer and stays on it. The agent works in that PC's folder (a project's path is mirrored there unless the device sets a folder) as the chat's Claude account (its login is sent along; the device's own login is used only when the account isn't signed in on this PC), and pushes through its own git. Any PC works: Linux, macOS (Remote Login on) or Windows (OpenSSH Server on), with or without Harbor. It needs Claude Code and key-based ssh; nothing else is installed on it, and Tailscale is optional.",
            "label-12",
        );
        ui.add_space(4.0);
        w::subtle(
            ui,
            "The MCP bridge runs this PC's MCP servers and apps here and forwards them to the device over the same ssh connection (ssh -R), so their sign-ins never leave this PC. Your slash commands and skills come along as prompts of the `origin` server. Harbor's processes still start on this PC. A turn ends if the connection drops.",
            "label-12",
        );
        if self.remote != before {
            remote::save(&self.store, &self.remote);
        }
    }

    /// Adds a device by SSH (Settings › Devices), opens its settings and tests it.
    fn add_ssh_device(&mut self, ctx: &egui::Context, name: String, host: String, user: String, port: u16) {
        let n = (1..).find(|n| !self.remote.devices.iter().any(|d| d.id == format!("ssh:{n}"))).unwrap_or(1);
        let h = Host { id: format!("ssh:{n}"), name, host, user, port, bridge: true, ..Default::default() };
        self.devices_ui.open = Some(h.id.clone());
        remote::test(&self.remote, &h, ctx);
        self.remote.devices.push(h);
    }

    /// Adds or replaces a device in the settings.
    fn upsert(&mut self, h: Host) {
        match self.remote.devices.iter_mut().find(|d| d.id == h.id) {
            Some(d) => *d = h,
            None => self.remote.devices.push(h),
        }
    }

    fn device_card(&mut self, ui: &mut Ui, ctx: &egui::Context, t: &Tokens, h: &Host, online: Option<bool>) {
        let mut e = h.clone();
        let open = self.devices_ui.open.as_deref() == Some(h.id.as_str());
        let probe = remote::probe(&h.id);
        let tex = self.device_tex(ctx, h);
        let mut remove = false;
        Frame::new().inner_margin(Margin::symmetric(16, 12)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                let (r, _) = ui.allocate_exact_size(Vec2::splat(32.0), Sense::hover());
                paint_mark(ui.painter(), r.shrink(5.0), remote::glyph(h), tex, online, t.fg(), t);
                ui.add_space(6.0);
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 1.0;
                    ui.horizontal(|ui| {
                        w::text(ui, h.label(), "strong-14");
                        w::badge(ui, if h.found() { "Your PC" } else { "SSH" }, Tone::Gray);
                        match online {
                            Some(true) => w::badge(ui, "Online", Tone::Green),
                            Some(false) => w::badge(ui, "Offline", Tone::Gray),
                            None => ui.label(""),
                        };
                        if h.hidden {
                            w::badge(ui, "Hidden", Tone::Amber);
                        }
                    });
                    let os = if h.os.is_empty() { String::new() } else { format!(" · {}", remote::os_label(&h.os)) };
                    let user = remote::login(&self.remote, h).map(|(u, _)| format!("{u}@")).unwrap_or_default();
                    w::subtle(ui, format!("{user}{}{os}", h.host), "label-13");
                    if let Some(p) = &probe {
                        let col = match p.ok {
                            Some(true) if p.text.contains("claude ") => t.green(900),
                            Some(true) => t.amber(900),
                            Some(false) => t.red(900),
                            None => t.subtle(),
                        };
                        ui.label(egui::RichText::new(&p.text).text_style(theme::ts("label-12")).color(col));
                    }
                });
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let label = if h.found() { if h.hidden { "Show" } else { "Hide" } } else { "Remove" };
                    if w::btn(label).sm().variant(if h.found() { w::Variant::Ghost } else { w::Variant::GhostDestructive }).show(ui).clicked() {
                        if h.found() {
                            e.hidden = !e.hidden;
                        } else {
                            remove = true;
                        }
                    }
                    if w::btn(if open { "Done" } else { "Edit" }).sm().ghost().show(ui).clicked() {
                        self.devices_ui.open = if open { None } else { Some(h.id.clone()) };
                    }
                    let busy = probe.as_ref().is_some_and(|p| p.running);
                    if w::btn("Test").sm().outline().enabled(!busy).show(ui).clicked() {
                        remote::test(&self.remote, h, ctx);
                    }
                });
            });
            if open {
                ui.add_space(10.0);
                self.device_editor(ui, ctx, &mut e);
            }
        });
        if remove {
            self.remote.devices.retain(|d| d.id != h.id);
            let _ = std::fs::remove_file(remote::icon_path(&h.id));
            return;
        }
        if e != *h {
            self.upsert(e);
        }
    }

    fn device_editor(&mut self, ui: &mut Ui, ctx: &egui::Context, e: &mut Host) {
        let t = self.theme.t;
        w::well(ui).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing.y = 8.0;
            let field = |ui: &mut Ui, label: &str, add: &mut dyn FnMut(&mut Ui)| {
                ui.horizontal(|ui| {
                    // A fixed label column, so the fields line up.
                    let (r, _) = ui.allocate_exact_size(Vec2::new(100.0, 30.0), Sense::hover());
                    ui.painter().text(r.left_center(), Align2::LEFT_CENTER, label, FontId::proportional(13.0), t.subtle());
                    add(ui);
                });
            };
            let fw = (ui.available_width() - 130.0).clamp(120.0, 320.0);
            field(ui, "Name", &mut |ui| {
                w::input(ui, &mut e.name, &e.host.clone(), false, fw);
            });
            field(ui, "Address", &mut |ui| {
                w::input(ui, &mut e.host, "host, IP or ssh alias", true, fw);
            });
            let mut port = if e.port == 0 { String::new() } else { e.port.to_string() };
            // What applies when the field is empty: the global setting or ~/.ssh/config.
            let shown = Host { user: String::new(), port: 0, ..e.clone() };
            let hint = match remote::login(&self.remote, &shown) {
                Some((u, true)) => format!("{u} (from ~/.ssh/config)"),
                Some((u, false)) => u,
                None => "default".into(),
            };
            let port_hint = match remote::ssh_port(&self.remote, &shown) {
                0 => "port".to_string(),
                p => p.to_string(),
            };
            field(ui, "User · port", &mut |ui| {
                w::input(ui, &mut e.user, &hint, true, fw - 90.0);
                w::input(ui, &mut port, &port_hint, true, 80.0);
            });
            e.port = port.trim().parse().unwrap_or(0);
            field(ui, "Folder", &mut |ui| {
                w::input(ui, &mut e.dir, "mirrors this PC's project path", true, fw);
            });
            field(ui, "Icon", &mut |ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                if w::btn("Auto").sm().outline().pressed(e.icon.is_empty()).show(ui).clicked() {
                    e.icon.clear();
                }
                for (name, g) in remote::ICONS {
                    if w::btn(g).muted().icon_xs().pressed(e.icon == *name).show(ui).tip(*name).clicked() {
                        e.icon = name.to_string();
                    }
                }
                ui.add_space(4.0);
                if w::btn(&format!("{}  Image…", ic::IMAGE)).sm().outline().pressed(e.icon == "file").show(ui).clicked() {
                    let (id, done, ctx) = (e.id.clone(), self.devices_ui.picked.clone(), ctx.clone());
                    std::thread::spawn(move || {
                        let opts = crate::picker::Opts { title: "Device icon", filter: Some(("Images", crate::picker::IMAGES)), ..Default::default() };
                        let Some(file) = crate::picker::pick(opts).pop() else { return };
                        let dst = remote::icon_path(&id);
                        let _ = std::fs::create_dir_all(dst.parent().unwrap());
                        if std::fs::copy(&file, &dst).is_ok() {
                            done.lock().unwrap().push(id);
                            ctx.request_repaint();
                        }
                    });
                }
            });
            ui.add_space(2.0);
            let mut shown = !e.hidden;
            w::separator(ui);
            ui.horizontal(|ui| {
                w::toggle(ui, &mut shown);
                w::text(ui, "In the composer", "label-13");
                ui.add_space(12.0);
                w::toggle(ui, &mut e.bridge).tip("This PC's MCP servers and signed-in apps, through the ssh connection");
                w::text(ui, "MCP bridge", "label-13");
                ui.add_space(12.0);
                w::toggle(ui, &mut e.commands).tip("A run_command tool: the agent there can run shell commands on this PC");
                w::text(ui, "Commands on this PC", "label-13");
            });
            let mut here = !e.device_files;
            ui.horizontal(|ui| {
                w::toggle(ui, &mut here).tip("The agent there edits, builds and commits this PC's project: its shell, git and file tools run here (in the chat's mode). Off: it works on the device's own copy");
                w::text(ui, "Work on this PC's files (shell, git and files run here)", "label-13");
            });
            e.device_files = !here;
            e.hidden = !shown;
            if e.commands || here {
                ui.label(
                    egui::RichText::new(format!(
                        "{}  The agent on {} can run any command{} on this PC, as you.",
                        ic::ALERT,
                        e.label(),
                        if here { " and change any file" } else { "" }
                    ))
                        .text_style(theme::ts("label-12"))
                        .color(t.amber(900)),
                );
            }
            ui.horizontal(|ui| {
                if w::btn(&format!("{}  Terminal there", ic::TERMINAL)).sm().outline().show(ui).clicked() {
                    let argv = remote::shell_argv(&self.remote, e, None);
                    self.open_terminal(ctx, &format!("ssh · {}", e.label()), crate::store::home(), argv, vec![]);
                }
                if w::btn("Sign in to Claude there").sm().ghost().show(ui).clicked() {
                    let argv = remote::shell_argv(&self.remote, e, Some("claude /login"));
                    self.open_terminal(ctx, &format!("Claude · {}", e.label()), crate::store::home(), argv, vec![]);
                }
            });
        });
    }
}
