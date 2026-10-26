// deny, not forbid: a few system calls std has no wrapper for allow unsafe code where they are.
#![deny(unsafe_code)]

mod addproject;
mod agent;
mod agentstrip;
mod api;
mod browser;
mod app;
mod autowork;
mod background;
mod bridge;
mod chat;
mod clipboard;
mod control;
mod detach;
mod devices;
mod discover;
mod favicon;
mod ghapi;
mod git;
mod hookcert;
mod icons;
mod fork;
mod images;
mod issuedetail;
mod issues;
mod keys;
mod limits;
mod listdetail;
mod mentions;
mod logos;
mod mcp;
mod mcpshim;
mod mesh;
mod meshctx;
mod machines;
mod movechat;
mod notices;
mod notify;
mod oauth;
mod pages;
mod phoneauth;
mod phonesui;
mod picker;
mod portmap;
mod prdetail;
mod procs;
mod prs;
mod providers;
mod provupdate;
mod queue;
mod relay;
mod profile;
mod recap;
mod reload;
mod remote;
mod remoteui;
mod sidebar;
mod single;
mod slash;
mod tags;
mod cost;
mod palette;
mod store;
mod surface;
mod team;
mod teamui;
mod terminal;
mod theme;
mod tls;
mod tray;
mod undo;
mod usage_ctl;
mod voice;
mod update;
mod view;
mod waiting;
mod widgets;
mod workspace;
mod worktree;

use eframe::egui;

fn main() -> eframe::Result {
    // Before anything is started: children older than this are a previous image's.
    let born = procs::uptime_ticks();
    let args: Vec<String> = std::env::args().collect();
    if matches!(args.get(1).map(String::as_str), Some("--version" | "-V")) {
        println!("harbor {}", update::version_label());
        return Ok(());
    }
    // From a terminal, also when a new version won't start: `harbor --update`, `harbor --restore-previous`.
    if let Some(code) = args.get(1).and_then(|a| update::cli(a)) {
        std::process::exit(code);
    }
    if args.get(1).map(String::as_str) == Some("mcp") {
        mcpshim::run(&args[2..]);
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("net") {
        std::process::exit(portmap::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("nc") {
        std::process::exit(relay::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("mesh") {
        std::process::exit(mesh::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("turn") {
        detach::run(&args[2..]);
        return Ok(());
    }
    let background = args.iter().any(|a| a == background::FLAG);
    // One Harbor per session: a second launch brings the running Harbor to the front (or opens
    // its window, when it runs in the background).
    if !single::acquire() {
        if background {
            // Autostart while it already runs: nothing to do.
        } else if single::focus_running() {
            eprintln!("harbor: already running, brought it to the front");
        } else {
            eprintln!("harbor: already running, but it didn't answer on {}", control::socket_path().display());
        }
        return Ok(());
    }
    if let Some(born) = born {
        procs::reap_inherited(born);
    }
    // One context and one App for the whole process: windows come and go (background.rs).
    let ctx = egui::Context::default();
    ctx.set_embed_viewports(false);
    ctx.options_mut(|o| o.max_passes = std::num::NonZeroUsize::new(2).unwrap_or(std::num::NonZeroUsize::MIN));
    theme::install_fonts(&ctx);
    ctx.add_plugin(clipboard::Plugin);
    let mut app = app::App::new(&ctx);
    tray::start(&ctx);
    let mut hidden = background;
    let mut closed = false;
    loop {
        if hidden && !background::run_hidden(&mut app, &ctx, closed) {
            break;
        }
        let options = eframe::NativeOptions {
            viewport: egui::ViewportBuilder::default()
                .with_title("Harbor")
                .with_app_id("harbor")
                .with_inner_size([1180.0, 780.0])
                .with_min_inner_size([640.0, 420.0]),
            // Ctrl+C/X/V go through src/clipboard.rs (wl-clipboard on Wayland) instead.
            clipboard_shortcuts: false,
            ..Default::default()
        };
        let shown = &mut app;
        eframe::run_native_ext(
            "Harbor",
            options,
            Some(ctx.clone()),
            Box::new(move |cc| {
                shown.window_opened(&cc.egui_ctx);
                Ok(Box::new(Window(shown)))
            }),
        )?;
        if background::quitting() || !app.keep_running() {
            break;
        }
        (hidden, closed) = (true, true);
    }
    Ok(())
}

/// The window's view of the App, which outlives it.
struct Window<'a>(&'a mut app::App);

impl eframe::App for Window<'_> {
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw: &mut egui::RawInput) {
        eframe::App::raw_input_hook(self.0, ctx, raw);
    }

    fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        eframe::App::logic(self.0, ctx, frame);
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        eframe::App::ui(self.0, ui, frame);
    }
}
