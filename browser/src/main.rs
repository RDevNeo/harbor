//! harbor-browser: Servo rendering off-screen for Harbor's browser panel.
//!
//! Harbor starts it when the panel opens and kills it when the panel closes, so
//! the engine's memory only exists while a page is shown.
//!
//! Protocol (one JSON object per line):
//! - stdin:  {"t":"load","url"} {"t":"back"} {"t":"forward"} {"t":"reload"}
//!           {"t":"resize","w","h"} {"t":"move","x","y"} {"t":"button","x","y","button","down"}
//!           {"t":"wheel","x","y","dx","dy"} {"t":"key","key","code","down","ctrl","shift","alt","meta"}
//!           {"t":"focus","on"} {"t":"acks","on"} {"t":"got"}
//! - stdout: {"t":"frame","w","h","buf"} {"t":"url"} {"t":"title"} {"t":"loading"} {"t":"nav","back","forward"} {"t":"cursor"}
//! Frames are raw RGBA written to `<frames>.0` / `<frames>.1` (alternating, so the
//! reader never sees a half-written one); "buf" says which. After {"t":"acks","on":true}
//! the next frame is painted only once Harbor answered "got" for the previous one.

use dpi::PhysicalSize;
use euclid::Scale;
use serde_json::{Value, json};
use servo::{
    Cursor, DevicePoint, EventLoopWaker, InputEvent, KeyboardEvent, LoadStatus, MouseButton, MouseButtonAction, MouseButtonEvent,
    MouseMoveEvent, RenderingContext, ServoBuilder, SoftwareRenderingContext, WebView, WebViewBuilder, WebViewDelegate,
    WebViewPoint, WheelDelta, WheelEvent, WheelMode,
};
use std::cell::Cell;
use std::io::{BufRead, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::rc::Rc;
use std::str::FromStr;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;
use url::Url;

enum Wake {
    Servo,
    Cmd(Value),
    Quit,
}

#[derive(Clone)]
struct Waker(Sender<Wake>);

impl EventLoopWaker for Waker {
    fn clone_box(&self) -> Box<dyn EventLoopWaker> {
        Box::new(self.clone())
    }
    fn wake(&self) {
        let _ = self.0.send(Wake::Servo);
    }
}

fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

#[derive(Default)]
struct Delegate {
    dirty: Cell<bool>,
}

impl WebViewDelegate for Delegate {
    fn notify_new_frame_ready(&self, _: WebView) {
        self.dirty.set(true);
    }
    fn notify_url_changed(&self, _: WebView, url: Url) {
        emit(json!({ "t": "url", "url": url.as_str() }));
    }
    fn notify_page_title_changed(&self, _: WebView, title: Option<String>) {
        emit(json!({ "t": "title", "title": title.unwrap_or_default() }));
    }
    fn notify_load_status_changed(&self, _: WebView, status: LoadStatus) {
        emit(json!({ "t": "loading", "on": !matches!(status, LoadStatus::Complete) }));
    }
    fn notify_history_changed(&self, wv: WebView, _: Vec<Url>, _: usize) {
        emit(json!({ "t": "nav", "back": wv.can_go_back(), "forward": wv.can_go_forward() }));
    }
    fn notify_cursor_changed(&self, _: WebView, cursor: Cursor) {
        emit(json!({ "t": "cursor", "name": format!("{cursor:?}") }));
    }
}

/// "localhost:3000" → http, "example.com" → https, anything else → a search.
fn normalize(input: &str) -> Option<Url> {
    let s = input.trim();
    if let Ok(u) = Url::parse(s) {
        if matches!(u.scheme(), "http" | "https" | "file" | "about" | "data") {
            return Some(u);
        }
    }
    let local = s.starts_with("localhost") || s.starts_with("127.") || s.starts_with("0.0.0.0") || s.starts_with('[');
    if local {
        return Url::parse(&format!("http://{s}")).ok();
    }
    if s.contains('.') && !s.contains(' ') {
        return Url::parse(&format!("https://{s}")).ok();
    }
    Url::parse_with_params("https://duckduckgo.com/", &[("q", s)]).ok()
}

fn f(v: &Value, k: &str) -> f32 {
    v[k].as_f64().unwrap_or(0.0) as f32
}

fn main() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let args: Vec<String> = std::env::args().collect();
    let frames = args.get(1).cloned().unwrap_or_else(|| "/dev/shm/harbor-browser".into());
    let start = args.get(2).and_then(|u| normalize(u)).unwrap_or_else(|| Url::parse("about:blank").unwrap());
    let w: u32 = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(1024).max(1);
    let h: u32 = args.get(4).and_then(|v| v.parse().ok()).unwrap_or(768).max(1);
    let scale: f32 = args.get(5).and_then(|v| v.parse().ok()).unwrap_or(1.0);

    let (tx, rx): (Sender<Wake>, Receiver<Wake>) = channel();
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let _ = tx.send(Wake::Cmd(v));
                }
            }
            // Harbor closed the pipe: the panel is gone.
            let _ = tx.send(Wake::Quit);
        });
    }

    let ctx = Rc::new(SoftwareRenderingContext::new(PhysicalSize::new(w, h)).expect("software rendering context"));
    let _ = ctx.make_current();
    let servo = ServoBuilder::default().event_loop_waker(Box::new(Waker(tx.clone()))).build();
    let delegate = Rc::new(Delegate::default());
    let webview = WebViewBuilder::new(&servo, ctx.clone())
        .url(start)
        .hidpi_scale_factor(Scale::new(scale))
        .delegate(delegate.clone())
        .build();
    webview.show();
    webview.set_focused(true);

    let mut buf = 0u8;
    // With acks (Harbor's {"t":"acks"}), a frame is painted only after the previous one was
    // taken ({"t":"got"}): a hidden or busy panel costs no painting, copies or animation ticks.
    let (mut acks, mut waiting) = (false, false);
    let point = |v: &Value| WebViewPoint::Device(DevicePoint::new(f(v, "x"), f(v, "y")));
    'run: loop {
        // Sleep until Servo or Harbor has something; animations get a frame tick.
        let first = if webview.animating() && !(acks && waiting) { rx.recv_timeout(Duration::from_millis(16)).ok() } else { rx.recv().ok() };
        let mut msgs: Vec<Wake> = first.into_iter().collect();
        msgs.extend(rx.try_iter());
        for m in msgs {
            match m {
                Wake::Quit => break 'run,
                Wake::Servo => {}
                Wake::Cmd(c) => match c["t"].as_str().unwrap_or("") {
                    "load" => {
                        if let Some(u) = normalize(c["url"].as_str().unwrap_or("")) {
                            webview.load(u);
                        }
                    }
                    "back" => {
                        webview.go_back(1);
                    }
                    "forward" => {
                        webview.go_forward(1);
                    }
                    "reload" => webview.reload(),
                    "acks" => acks = c["on"].as_bool().unwrap_or(true),
                    "got" => waiting = false,
                    "resize" => {
                        let size = PhysicalSize::new(c["w"].as_u64().unwrap_or(w as u64).max(1) as u32, c["h"].as_u64().unwrap_or(h as u64).max(1) as u32);
                        // resize() resizes the rendering context too; doing that first
                        // would make Servo see no change and skip the relayout.
                        webview.resize(size);
                        // Servo doesn't announce a new frame for a resize; paint anyway.
                        delegate.dirty.set(true);
                    }
                    "focus" => webview.set_focused(c["on"].as_bool().unwrap_or(true)),
                    "move" => {
                        webview.notify_input_event(InputEvent::MouseMove(MouseMoveEvent::new(point(&c))));
                    }
                    "button" => {
                        let button = match c["button"].as_u64().unwrap_or(0) {
                            1 => MouseButton::Secondary,
                            2 => MouseButton::Auxiliary,
                            _ => MouseButton::Primary,
                        };
                        let action = if c["down"].as_bool().unwrap_or(false) { MouseButtonAction::Down } else { MouseButtonAction::Up };
                        webview.notify_input_event(InputEvent::MouseButton(MouseButtonEvent::new(action, button, point(&c))));
                    }
                    "wheel" => {
                        let delta = WheelDelta { x: f(&c, "dx") as f64, y: f(&c, "dy") as f64, z: 0.0, mode: WheelMode::DeltaPixel };
                        webview.notify_input_event(InputEvent::Wheel(WheelEvent::new(delta, point(&c))));
                    }
                    "key" => {
                        let name = c["key"].as_str().unwrap_or("");
                        let key = keyboard_types::Key::from_str(name).unwrap_or_else(|_| keyboard_types::Key::Character(name.to_string()));
                        let code = keyboard_types::Code::from_str(c["code"].as_str().unwrap_or("")).unwrap_or(keyboard_types::Code::Unidentified);
                        let mut mods = keyboard_types::Modifiers::empty();
                        for (k, m) in [
                            ("ctrl", keyboard_types::Modifiers::CONTROL),
                            ("shift", keyboard_types::Modifiers::SHIFT),
                            ("alt", keyboard_types::Modifiers::ALT),
                            ("meta", keyboard_types::Modifiers::META),
                        ] {
                            if c[k].as_bool().unwrap_or(false) {
                                mods |= m;
                            }
                        }
                        let ev = keyboard_types::KeyboardEvent {
                            state: if c["down"].as_bool().unwrap_or(true) { keyboard_types::KeyState::Down } else { keyboard_types::KeyState::Up },
                            key,
                            code,
                            location: keyboard_types::Location::Standard,
                            modifiers: mods,
                            repeat: false,
                            is_composing: false,
                        };
                        webview.notify_input_event(InputEvent::Keyboard(KeyboardEvent::new(ev)));
                    }
                    _ => {}
                },
            }
        }
        servo.spin_event_loop();
        if !(acks && waiting) && delegate.dirty.take() {
            webview.paint();
            let size = ctx.size2d().to_i32();
            if let Some(img) = ctx.read_to_image(euclid::Box2D::from_size(size)) {
                let path = format!("{frames}.{buf}");
                // owner-only: the file shows the page
                let file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path);
                if file.and_then(|mut f| f.write_all(img.as_raw())).is_ok() {
                    emit(json!({ "t": "frame", "w": img.width(), "h": img.height(), "buf": buf }));
                    buf ^= 1;
                    waiting = acks;
                }
            }
        }
    }
    for b in 0..2 {
        let _ = std::fs::remove_file(format!("{frames}.{b}"));
    }
}
