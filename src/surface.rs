//! Surfaces: two panes, right and bottom, that can be open at the same time and
//! host browsers, terminals and devices (the list, a device's screen, its files) as tabs. A pane can be maximized; an
//! empty one shows "Open a surface".

use crate::app::App;
use crate::browser::{self, Browser};
use crate::devices;
use crate::icons as ic;
use crate::terminal::Terminal;
use crate::widgets as w;
use eframe::egui::{self, Align, Align2, CornerRadius, FontId, Frame, Id, Key, Layout, Margin, Rect, Sense, Ui, Vec2, pos2};
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq)]
pub enum Dock {
    Right,
    Bottom,
}

impl Dock {
    pub fn idx(self) -> usize {
        match self {
            Dock::Right => 0,
            Dock::Bottom => 1,
        }
    }
}

/// Keyboard-focus id of a pane's terminal grid.
pub fn term_id(d: Dock) -> Id {
    Id::NULL.with(("term-grid", d.idx()))
}

#[derive(Default)]
pub struct Pane {
    pub surfaces: Vec<Surface>,
    pub active: usize,
    pub open: bool,
    chooser_focus: bool,
    pub term_focus: bool,
}

pub enum Surface {
    /// "Open a surface": the picker, shown in an empty tab.
    Chooser,
    /// The engine only runs while the panel is visible; `url` survives restarts.
    Browser { engine: Option<Browser>, url: String },
    Terminal(Terminal),
    /// The PCs and phones paired with this Harbor.
    Devices(Box<devices::List>),
    /// A PC's files over ssh.
    Files(Box<devices::Files>),
}

impl Surface {
    fn icon(&self) -> &'static str {
        match self {
            Surface::Chooser => ic::PLUS,
            Surface::Browser { .. } => ic::GLOBE,
            Surface::Terminal(_) => ic::TERMINAL,
            Surface::Devices(_) => ic::SMARTPHONE,
            Surface::Files(_) => ic::FOLDER,
        }
    }

    fn title(&self) -> String {
        match self {
            Surface::Chooser => "New".into(),
            Surface::Browser { engine, url } => {
                let t = engine.as_ref().map(|b| b.title.clone()).filter(|t| !t.is_empty() && t != "Error loading page");
                t.unwrap_or_else(|| url.trim_start_matches("http://").trim_start_matches("https://").trim_end_matches('/').to_string())
            }
            Surface::Terminal(t) => t.title.clone(),
            Surface::Devices(_) => "Devices".into(),
            Surface::Files(f) => f.title(),
        }
    }

    pub fn is_browser(&self) -> bool {
        matches!(self, Surface::Browser { .. })
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Surface::Terminal(_))
    }
}

/// Ports something listens on locally (dev servers), from /proc/net/tcp{,6}.
pub fn listening_ports() -> Vec<u16> {
    let mut ports = vec![];
    for f in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = std::fs::read_to_string(f) else { continue };
        for l in text.lines().skip(1) {
            let cols: Vec<&str> = l.split_whitespace().collect();
            if cols.len() < 4 || cols[3] != "0A" {
                continue; // not LISTEN
            }
            let Some((addr, port)) = cols[1].split_once(':') else { continue };
            let Ok(port) = u16::from_str_radix(port, 16) else { continue };
            // Loopback or any-address only: 127.0.0.1, 0.0.0.0, ::1, ::
            let local = matches!(addr, "0100007F" | "00000000") || addr.chars().all(|c| c == '0') || addr.ends_with("01000000") && addr.starts_with("0000");
            let harbor = (crate::control::HOOK_PORT..crate::control::HOOK_PORT + 10).contains(&port);
            if local && port >= 1024 && !harbor && !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    ports.sort();
    ports.truncate(10);
    ports
}

/// The shortest step between frames woken by a terminal's output (30 fps).
const TERM_STEP: std::time::Duration = std::time::Duration::from_millis(33);

impl App {
    fn wake(ctx: &egui::Context) -> impl Fn() + Send + Sync + Clone + 'static {
        let ctx = ctx.clone();
        move || ctx.request_repaint()
    }

    /// A terminal's output wakes at most every [`TERM_STEP`] (4 fps while the window is
    /// unfocused): a build or a TUI writing nonstop would otherwise repaint the whole
    /// window at the refresh rate. Output after a quiet spell (an echoed key) shows at once.
    fn term_wake(ctx: &egui::Context) -> impl Fn() + Send + 'static {
        let ctx = ctx.clone();
        // When the last woken frame was drawn, or will be.
        let frame = std::sync::Mutex::new(None::<std::time::Instant>);
        move || {
            let now = std::time::Instant::now();
            let step = crate::app::live_step(TERM_STEP);
            let mut frame = frame.lock().unwrap();
            match *frame {
                Some(at) if at > now => {}
                Some(at) if now < at + step => {
                    *frame = Some(at + step);
                    ctx.request_repaint_after(at + step - now);
                }
                _ => {
                    *frame = Some(now);
                    ctx.request_repaint();
                }
            }
        }
    }

    pub fn pane(&self, d: Dock) -> &Pane {
        &self.panes[d.idx()]
    }

    pub(crate) fn pane_mut(&mut self, d: Dock) -> &mut Pane {
        &mut self.panes[d.idx()]
    }

    pub fn pane_showing(&self, d: Dock) -> bool {
        self.pane(d).open
    }

    /// Some pane's terminal is waiting to take keyboard focus.
    pub fn term_focus_pending(&self) -> bool {
        self.panes.iter().any(|p| p.open && p.term_focus)
    }

    fn show_surface(&mut self, d: Dock, i: usize) {
        let p = self.pane_mut(d);
        p.active = i.min(p.surfaces.len().saturating_sub(1));
        p.open = true;
        match p.surfaces.get(p.active) {
            Some(Surface::Chooser) => p.chooser_focus = true,
            Some(Surface::Terminal(_)) => {
                p.term_focus = true;
                self.focus_composer = false;
            }
            _ => {}
        }
    }

    /// Hides a pane. Its browser engines stop (their URL is kept); terminals keep running.
    pub fn hide_pane(&mut self, d: Dock) {
        if self.surface_max == Some(d) {
            self.surface_max = None;
        }
        let p = self.pane_mut(d);
        p.open = false;
        for s in &mut p.surfaces {
            if let Surface::Browser { engine, .. } = s {
                *engine = None;
            }
        }
    }

    fn place(&mut self, d: Dock, s: Surface) {
        let p = self.pane_mut(d);
        // An empty chooser tab is replaced by what was picked in it.
        if matches!(p.surfaces.get(p.active), Some(Surface::Chooser)) {
            let a = p.active;
            p.surfaces[a] = s;
        } else {
            p.surfaces.push(s);
            p.active = p.surfaces.len() - 1;
        }
        let i = self.pane(d).active;
        self.show_surface(d, i);
    }

    /// Terminals open in the bottom pane.
    pub fn open_terminal(&mut self, ctx: &egui::Context, title: &str, cwd: PathBuf, argv: Vec<String>, env: Vec<(String, Option<String>)>) {
        self.open_terminal_in(Dock::Bottom, ctx, title, cwd, argv, env);
    }

    fn open_terminal_in(&mut self, d: Dock, ctx: &egui::Context, title: &str, cwd: PathBuf, argv: Vec<String>, mut env: Vec<(String, Option<String>)>) {
        if !env.iter().any(|(k, _)| k == "PATH") {
            env.push(("PATH".into(), Some(crate::providers::child_path())));
        }
        match Terminal::spawn(title, &cwd, &argv, &env, Self::term_wake(ctx)) {
            Ok(t) => self.place(d, Surface::Terminal(t)),
            Err(e) => eprintln!("terminal: {e}"),
        }
    }

    /// The browser lives in the right pane (or wherever one is already open).
    pub fn open_browser(&mut self, url: Option<String>) {
        self.open_browser_in(Dock::Right, url);
    }

    fn open_browser_in(&mut self, d: Dock, url: Option<String>) {
        let url = url.unwrap_or_else(|| self.store.get("browser_last").unwrap_or_else(|| "localhost:3000".into()));
        for dock in [d, Dock::Right, Dock::Bottom] {
            if let Some(i) = self.pane(dock).surfaces.iter().position(|s| s.is_browser()) {
                if let Surface::Browser { engine, url: u } = &mut self.pane_mut(dock).surfaces[i] {
                    match engine {
                        Some(b) => b.load(&url),
                        None => *u = url,
                    }
                }
                self.show_surface(dock, i);
                return;
            }
        }
        self.place(d, Surface::Browser { engine: None, url });
    }

    /// Ctrl+`: the current project's shell in the bottom pane.
    pub fn toggle_terminal(&mut self, ctx: &egui::Context) {
        let d = Dock::Bottom;
        let p = self.pane(d);
        if p.open && p.surfaces.get(p.active).is_some_and(|s| s.is_terminal()) {
            self.hide_pane(d);
            return;
        }
        let cwd = self.cwd_of(self.current_repo());
        if let Some(i) = self.pane(d).surfaces.iter().position(|s| matches!(s, Surface::Terminal(t) if t.cwd == cwd && t.alive())) {
            self.show_surface(d, i);
        } else {
            let title = cwd.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "~".into());
            self.open_terminal_in(d, ctx, &title, cwd, vec![], vec![]);
        }
    }

    /// Ctrl+B: the browser in the right pane.
    pub fn toggle_browser(&mut self) {
        let d = Dock::Right;
        let p = self.pane(d);
        if p.open && p.surfaces.get(p.active).is_some_and(|s| s.is_browser()) {
            self.hide_pane(d);
        } else {
            self.open_browser(None);
        }
    }

    /// The top bar's panel buttons: each pane opens and closes on its own.
    pub fn toggle_dock(&mut self, d: Dock) {
        if self.pane(d).open {
            self.hide_pane(d);
            return;
        }
        if self.pane(d).surfaces.is_empty() {
            self.pane_mut(d).surfaces.push(Surface::Chooser);
        }
        let i = self.pane(d).active;
        self.show_surface(d, i);
    }

    fn close_surface(&mut self, d: Dock, i: usize) {
        let p = self.pane_mut(d);
        if i < p.surfaces.len() {
            p.surfaces.remove(i);
        }
        if p.surfaces.is_empty() {
            p.active = 0;
            self.hide_pane(d);
        } else {
            p.active = p.active.min(p.surfaces.len() - 1);
        }
    }

    fn open_devices_in(&mut self, d: Dock, ctx: &egui::Context) {
        for dock in [d, Dock::Right, Dock::Bottom] {
            if let Some(i) = self.pane(dock).surfaces.iter().position(|s| matches!(s, Surface::Devices(_))) {
                self.show_surface(dock, i);
                return;
            }
        }
        self.place(d, Surface::Devices(Box::new(devices::List::new(Self::wake(ctx)))));
    }

    /// A paired PC as Settings › Devices knows it (its ssh login, `harbor nc`); before that list
    /// is read, the PC with the defaults.
    fn device_host(&self, ctx: &egui::Context, dev: &devices::Device) -> Option<crate::remote::Host> {
        if dev.phone() {
            return None;
        }
        crate::remote::find(&self.remote, &crate::remote::tailnet(ctx), &dev.key)
            .or_else(|| Some(crate::remote::Host { id: dev.key.clone(), name: dev.name.clone(), host: dev.ip.clone(), bridge: true, ..Default::default() }))
    }

    fn device_action(&mut self, d: Dock, ctx: &egui::Context, a: devices::Action) {
        match a {
            devices::Action::Terminal(dev) => {
                if let Some(h) = self.device_host(ctx, &dev) {
                    let argv = crate::remote::shell_argv(&self.remote, &h, None);
                    self.open_terminal(ctx, &dev.name, crate::store::home(), argv, vec![]);
                }
            }
            devices::Action::Files(dev) => {
                let Some(h) = self.device_host(ctx, &dev) else { return };
                let ssh = devices::ssh_args(&self.remote, &h);
                let s = Surface::Files(Box::new(devices::Files::new(dev, ssh, None, Self::wake(ctx))));
                let p = self.pane_mut(d);
                p.surfaces.push(s);
                let i = p.surfaces.len() - 1;
                self.show_surface(d, i);
            }
        }
    }

    // ---- for hot reload

    pub fn restore_devices(&mut self, d: Dock, ctx: &egui::Context) {
        self.restore_surface(d, Surface::Devices(Box::new(devices::List::new(Self::wake(ctx)))));
    }

    pub fn restore_files(&mut self, d: Dock, ctx: &egui::Context, dev: devices::Device, path: String) {
        // (a PC no longer paired doesn't come back)
        let Some(h) = self.device_host(ctx, &dev) else { return };
        let ssh = devices::ssh_args(&self.remote, &h);
        self.restore_surface(d, Surface::Files(Box::new(devices::Files::new(dev, ssh, Some(path), Self::wake(ctx)))));
    }

    pub fn restore_surface(&mut self, d: Dock, s: Surface) {
        self.pane_mut(d).surfaces.push(s);
    }

    pub fn restore_terminal(&mut self, d: Dock, ctx: &egui::Context, title: &str, cwd: PathBuf) {
        let env = vec![("PATH".to_string(), Some(crate::providers::child_path()))];
        if let Ok(t) = Terminal::spawn(title, &cwd, &[], &env, Self::term_wake(ctx)) {
            self.pane_mut(d).surfaces.push(Surface::Terminal(t));
        }
    }

    pub fn set_pane_state(&mut self, d: Dock, open: bool, active: usize) {
        let p = self.pane_mut(d);
        p.active = active.min(p.surfaces.len().saturating_sub(1));
        p.open = open && !p.surfaces.is_empty();
    }

    /// Ends a pane's terminals and browser engines (their Drop reaps the processes).
    pub fn drop_surfaces(&mut self, d: Dock) {
        self.pane_mut(d).surfaces.clear();
    }

    fn remember_url(&mut self, url: &str) {
        if url.is_empty() || url == "about:blank" {
            return;
        }
        self.store.set("browser_last", url);
        let mut recent: Vec<String> = serde_json::from_str(&self.store.get("browser_recent").unwrap_or_default()).unwrap_or_default();
        recent.retain(|u| u != url);
        recent.insert(0, url.to_string());
        recent.truncate(8);
        self.store.set("browser_recent", &serde_json::to_string(&recent).unwrap_or_default());
    }

    // ------------------------------------------------------------ pane

    pub fn pane_ui(&mut self, ui: &mut Ui, d: Dock) {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        if self.pane(d).surfaces.is_empty() {
            let p = self.pane_mut(d);
            p.surfaces.push(Surface::Chooser);
            p.active = 0;
            p.chooser_focus = true;
        }
        // ---- header: +, tabs | maximize, close
        let mut close_tab: Option<usize> = None;
        Frame::new().inner_margin(Margin::symmetric(8, 6)).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                if w::btn(ic::PLUS).muted().icon_sm().show(ui).on_hover_text("Open a surface").clicked() {
                    let p = self.pane_mut(d);
                    p.surfaces.push(Surface::Chooser);
                    p.active = p.surfaces.len() - 1;
                    p.chooser_focus = true;
                }
                let n = self.pane(d).surfaces.len();
                for i in 0..n {
                    let p = self.pane(d);
                    if matches!(p.surfaces[i], Surface::Chooser) && n == 1 {
                        continue;
                    }
                    let (icon, title, active) = (p.surfaces[i].icon(), p.surfaces[i].title(), i == p.active);
                    match tab(ui, icon, &title, active, d) {
                        TabClick::Open => self.show_surface(d, i),
                        TabClick::Close => close_tab = Some(i),
                        TabClick::None => {}
                    }
                }
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 4.0;
                    if w::btn(ic::X).muted().icon_sm().show(ui).on_hover_text("Close panel").clicked() {
                        self.hide_pane(d);
                    }
                    let max = self.surface_max == Some(d);
                    let (icon, tip) = if max { (ic::MINIMIZE, "Restore") } else { (ic::MAXIMIZE, "Maximize") };
                    if w::btn(icon).muted().icon_sm().show(ui).on_hover_text(tip).clicked() {
                        self.surface_max = if max { None } else { Some(d) };
                    }
                });
            });
        });
        if let Some(i) = close_tab {
            self.close_surface(d, i);
            return;
        }
        if !self.pane(d).open {
            return;
        }

        // ---- body
        let mut servers: Vec<String> = self.procs.iter().filter_map(|p| p.url.clone()).collect();
        let i = self.pane(d).active;
        if matches!(self.pane(d).surfaces[i], Surface::Browser { .. }) {
            // Harbor's own processes first, then anything else listening locally.
            for port in listening_ports() {
                if !servers.iter().any(|s| s.contains(&format!(":{port}"))) {
                    servers.push(format!("http://localhost:{port}/"));
                }
            }
        }
        let term_focus = std::mem::take(&mut self.pane_mut(d).term_focus);
        let mut remember: Option<String> = None;
        let mut device_action: Option<devices::Action> = None;
        match &mut self.panes[d.idx()].surfaces[i] {
            Surface::Chooser => self.chooser(ui, d),
            Surface::Terminal(term) => {
                if term_focus {
                    ui.memory_mut(|m| m.request_focus(term_id(d)));
                }
                term.ui(ui, &t, term_id(d));
            }
            Surface::Devices(list) => device_action = list.ui(ui, &t),
            Surface::Files(files) => files.ui(ui, &t),
            Surface::Browser { engine, url } => {
                if engine.as_mut().is_some_and(|b| !b.alive()) {
                    *engine = None;
                }
                if engine.is_none() && browser::helper_path().is_some() {
                    *engine = Browser::spawn(url, Self::wake(&ctx)).ok();
                }
                match engine {
                    Some(b) => {
                        let action = b.ui(ui, &t, &servers, Id::NULL.with(("browser-page", d.idx())));
                        match &action {
                            Some(browser::Action::Load(u)) => b.load(u),
                            Some(browser::Action::External(u)) => crate::git::open_url(u),
                            None => {}
                        }
                        if !b.url.is_empty() && b.url != *url {
                            *url = b.url.clone();
                            remember = Some(b.url.clone());
                        }
                    }
                    None => {
                        let (build, close) = browser::missing_ui(ui, &t);
                        if close {
                            self.close_surface(d, i);
                        }
                        if build {
                            if let Some(dir) = browser::source_dir() {
                                let cmd = "mise exec rust -- cargo build --release 2>/dev/null || cargo build --release; echo; echo 'Done: switch back to the Browser tab.'".to_string();
                                self.open_terminal(&ctx, "Build browser", dir, vec!["bash".into(), "-lc".into(), cmd], vec![]);
                            } else {
                                crate::update::install_browser(&ctx);
                            }
                        }
                    }
                }
            }
        }
        if let Some(u) = remember {
            self.remember_url(&u);
        }
        if let Some(a) = device_action {
            self.device_action(d, &ctx, a);
        }
    }

    /// "Open a surface": Browser (B, with a menu of dev servers and recent URLs),
    /// Terminal (T) and Devices (M).
    fn chooser(&mut self, ui: &mut Ui, d: Dock) {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        let h = ui.available_height();
        ui.add_space((h * 0.4 - 90.0).max(16.0));
        let width = 380.0f32.min(ui.available_width() - 32.0);
        let mut pick: Option<char> = None;
        // The chooser holds keyboard focus (so B/T/M work) until something else takes it.
        let focus_id = Id::NULL.with(("surface-chooser", d.idx()));
        let focus = ui.interact(ui.max_rect(), focus_id, Sense::focusable_noninteractive());
        if std::mem::take(&mut self.pane_mut(d).chooser_focus) {
            focus.request_focus();
            self.focus_composer = false;
        }
        ui.vertical_centered(|ui| {
            ui.label(egui::RichText::new("Open a surface").text_style(crate::theme::ts("label-14")).color(t.subtle()));
            ui.add_space(10.0);
            let items = [('B', ic::GLOBE, "Browser"), ('T', ic::TERMINAL, "Terminal"), ('M', ic::SMARTPHONE, "Devices")];
            for (k, icon, label) in items {
                let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 38.0), Sense::click());
                let p = ui.painter();
                if resp.hovered() {
                    p.rect_filled(rect, CornerRadius::same(crate::theme::RADIUS_MD), t.gray(100));
                }
                ic::glyph(p, pos2(rect.left() + 18.0, rect.center().y), icon, 16.0, t.fg());
                p.text(pos2(rect.left() + 38.0, rect.center().y), Align2::LEFT_CENTER, label, FontId::proportional(14.5), t.fg());
                w::kbd(ui, pos2(rect.right() - 4.0, rect.center().y), &k.to_string(), true);
                if k == 'B' {
                    let cr = Rect::from_center_size(pos2(rect.right() - 46.0, rect.center().y), Vec2::splat(26.0));
                    let c = ui.interact(cr, Id::NULL.with(("browser-chevron", d.idx())), Sense::click());
                    if c.hovered() {
                        ui.painter().rect_filled(cr, CornerRadius::same(4), t.gray(200));
                    }
                    ic::glyph(ui.painter(), cr.center(), ic::DOWN, 14.0, t.subtle());
                    if c.on_hover_text("Dev servers and recent pages").clicked() {
                        self.surface_menu = if self.surface_menu.is_some() { None } else { Some((d, cr)) };
                    } else if resp.clicked() {
                        pick = Some(k);
                    }
                } else if resp.clicked() {
                    pick = Some(k);
                }
                resp.on_hover_cursor(egui::CursorIcon::PointingHand);
            }
        });
        let free = ctx.memory(|m| m.focused().is_none() || m.focused() == Some(focus_id));
        if pick.is_none() && free && self.popup.is_none() && self.surface_menu.is_none() {
            pick = ctx.input_mut(|i| {
                [('B', Key::B), ('T', Key::T), ('M', Key::M)].into_iter().find(|(_, k)| i.consume_key(egui::Modifiers::NONE, *k)).map(|(c, _)| c)
            });
        }
        if let Some((md, anchor)) = self.surface_menu.filter(|(md, _)| *md == d) {
            let mut chosen: Option<String> = None;
            let recent: Vec<String> = serde_json::from_str(&self.store.get("browser_recent").unwrap_or_default()).unwrap_or_default();
            let ports = listening_ports();
            let ((), close) = w::popover(&ctx, "browser-menu", anchor, 260.0, false, &t, |ui| {
                w::subtle(ui, "  Dev servers", "label-12");
                if ports.is_empty() {
                    w::subtle(ui, "  Nothing listening on localhost", "label-13");
                }
                for p in &ports {
                    if w::menu_item(ui, ic::GLOBE, &format!("localhost:{p}"), None, false).clicked() {
                        chosen = Some(format!("localhost:{p}"));
                    }
                }
                if !recent.is_empty() {
                    w::separator(ui);
                    w::subtle(ui, "  Recent", "label-12");
                    for u in &recent {
                        let short: String = u.trim_start_matches("http://").trim_start_matches("https://").chars().take(40).collect();
                        if w::menu_item(ui, ic::GLOBE, &short, None, false).clicked() {
                            chosen = Some(u.clone());
                        }
                    }
                }
            });
            if let Some(u) = chosen {
                self.surface_menu = None;
                self.open_browser_in(md, Some(u));
                return;
            }
            if close {
                self.surface_menu = None;
            }
        }
        match pick {
            Some('B') => self.open_browser_in(d, None),
            Some('T') => {
                let cwd = self.cwd_of(self.current_repo());
                let title = cwd.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "~".into());
                self.open_terminal_in(d, &ctx, &title, cwd, vec![], vec![]);
            }
            Some('M') => self.open_devices_in(d, &ctx),
            _ => {}
        }
    }
}

enum TabClick {
    None,
    Open,
    Close,
}

/// A panel tab: icon, title and a close button (shown on hover or when active).
fn tab(ui: &mut Ui, icon: &str, title: &str, active: bool, d: Dock) -> TabClick {
    let t = w::tokens(ui);
    let title: String = title.chars().take(26).collect();
    let g = ui.painter().layout_no_wrap(title, FontId::proportional(13.0), t.fg());
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(g.size().x + 58.0, 28.0), Sense::click());
    let hover = ui.rect_contains_pointer(rect);
    let p = ui.painter();
    if active || hover {
        p.rect_filled(rect, CornerRadius::same(crate::theme::RADIUS_MD), if active { t.gray(200) } else { t.gray(100) });
    }
    ic::glyph(p, pos2(rect.left() + 14.0, rect.center().y), icon, 14.0, if active { t.fg() } else { t.subtle() });
    p.galley(pos2(rect.left() + 28.0, rect.center().y - g.size().y / 2.0), g, if active { t.fg() } else { t.subtle() });
    let xr = Rect::from_center_size(pos2(rect.right() - 14.0, rect.center().y), Vec2::splat(20.0));
    let x = ui.interact(xr, Id::NULL.with(("tab-x", d.idx(), rect.min.x as i32)), Sense::click());
    if active || hover {
        if x.hovered() {
            ui.painter().rect_filled(xr, CornerRadius::same(4), t.gray(300));
        }
        ic::glyph(ui.painter(), xr.center(), ic::X, 12.0, t.subtle());
    }
    if x.clicked() {
        TabClick::Close
    } else if resp.middle_clicked() {
        TabClick::Close
    } else if resp.clicked() {
        TabClick::Open
    } else {
        TabClick::None
    }
}
