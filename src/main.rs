// deny, not forbid: src/yuv.rs (raw GL for video) is the one module allowed unsafe code.
#![deny(unsafe_code)]

mod addproject;
mod agent;
mod api;
mod browser;
mod app;
mod autowork;
mod bridge;
mod chat;
mod clipboard;
mod control;
mod detach;
mod devices;
mod favicon;
mod git;
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
mod oauth;
mod pages;
mod phonesui;
mod prdetail;
mod procs;
mod prs;
mod providers;
mod queue;
mod reload;
mod remote;
mod remoteui;
mod sidebar;
mod single;
mod store;
mod stream;
mod surface;
mod team;
mod teamui;
mod terminal;
mod theme;
mod tls;
mod undo;
mod usage_ctl;
mod update;
mod view;
mod waiting;
mod widgets;
mod workspace;
mod yuv;

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
    if args.get(1).map(String::as_str) == Some("mesh") {
        std::process::exit(mesh::cli(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("turn") {
        detach::run(&args[2..]);
        return Ok(());
    }
    // One window per session: a second launch brings the running Harbor to the front.
    if !single::acquire() {
        if single::focus_running() {
            eprintln!("harbor: already running, brought it to the front");
        } else {
            eprintln!("harbor: already running, but it didn't answer on {}", control::socket_path().display());
        }
        return Ok(());
    }
    if let Some(born) = born {
        procs::reap_inherited(born);
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
    eframe::run_native(
        "Harbor",
        options,
        Box::new(|cc| {
            theme::install_fonts(&cc.egui_ctx);
            cc.egui_ctx.add_plugin(clipboard::Plugin);
            Ok(Box::new(app::App::new(&cc.egui_ctx)))
        }),
    )
}
