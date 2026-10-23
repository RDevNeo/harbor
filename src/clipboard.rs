//! The system clipboard, for text and images, both ways.
//!
//! On Wayland this goes through wl-clipboard (`wl-paste` / `wl-copy`), which uses the
//! data-control protocol: it reads whatever another app offers (any MIME type) and owns
//! what Harbor copies without needing a keyboard serial. egui's own Wayland backend
//! (smithay-clipboard) only sees the selection the compositor hands its private
//! wl_data_device, and on Hyprland a Ctrl+V from a terminal's copy came back empty.
//! Without Wayland or wl-clipboard (X11), arboard.
//!
//! eframe's own clipboard shortcuts are off (main.rs): `App::raw_input_hook` turns
//! Ctrl+C/X/V into egui's Copy/Cut/Paste events via `shortcuts`, and the `Plugin`
//! here takes egui's copy commands (`ctx.copy_text`, text selections) to the system.
//! Those copies, and the image viewer's, show a "Copied to clipboard" notification;
//! a device pane forwarding its PC's clipboard calls [`copy_text`] and stays quiet.

use eframe::egui::{self, Event, Key};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Text MIME types, best first.
const TEXT: [&str; 5] = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING", "TEXT"];
/// Image MIME types Harbor can attach, best first.
const IMAGES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

pub enum Clip {
    Text(String),
    /// Encoded image bytes (PNG, JPEG, WebP or GIF).
    Image(Vec<u8>),
}

fn wayland() -> bool {
    static WL: OnceLock<bool> = OnceLock::new();
    *WL.get_or_init(|| {
        std::env::var_os("WAYLAND_DISPLAY").is_some()
            && Command::new("wl-paste").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    })
}

fn arboard() -> &'static Mutex<Option<arboard::Clipboard>> {
    // Kept alive: on X11 the clipboard owner has to stay around to serve pastes.
    static CB: OnceLock<Mutex<Option<arboard::Clipboard>>> = OnceLock::new();
    CB.get_or_init(|| Mutex::new(arboard::Clipboard::new().ok()))
}

/// `wl-paste ARGS` with a timeout, so an app that never answers can't hang the UI.
fn wl_paste(args: &[&str]) -> Option<Vec<u8>> {
    let mut child = Command::new("wl-paste").args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut b = vec![];
        let _ = out.read_to_end(&mut b);
        let _ = tx.send(b);
    });
    let got = rx.recv_timeout(Duration::from_millis(1500)).ok();
    if got.is_none() {
        let _ = child.kill();
    }
    let ok = child.wait().is_ok_and(|s| s.success());
    got.filter(|_| ok)
}

fn wl_copy(args: &[&str], data: &[u8]) -> bool {
    let Ok(mut child) = Command::new("wl-copy").args(args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(data);
    }
    // wl-copy forks to serve the selection; the parent exits once it has read stdin.
    child.wait().is_ok_and(|s| s.success())
}

/// What's on the clipboard. Plain text wins when offered; otherwise an image; otherwise
/// a file manager's `text/uri-list` (as text, for the caller to turn into attachments).
pub fn read() -> Option<Clip> {
    if !wayland() {
        let mut cb = arboard().lock().unwrap_or_else(|e| e.into_inner());
        let cb = cb.as_mut()?;
        if let Ok(t) = cb.get_text() {
            return Some(Clip::Text(t));
        }
        let img = cb.get_image().ok()?;
        let mut png = vec![];
        image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())?
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        return Some(Clip::Image(png));
    }
    let types = String::from_utf8(wl_paste(&["--list-types"])?).ok()?;
    let types: Vec<&str> = types.lines().map(str::trim).collect();
    if let Some(m) = TEXT.iter().find(|m| types.contains(m)) {
        return String::from_utf8(wl_paste(&["--no-newline", "--type", m])?).ok().map(Clip::Text);
    }
    if let Some(m) = IMAGES.iter().find(|m| types.contains(m)) {
        return wl_paste(&["--type", m]).filter(|b| !b.is_empty()).map(Clip::Image);
    }
    if types.contains(&"text/uri-list") {
        return String::from_utf8(wl_paste(&["--no-newline", "--type", "text/uri-list"])?).ok().map(Clip::Text);
    }
    None
}

/// Any thread, any time (e.g. a device pane forwarding its PC's clipboard).
pub fn copy_text(text: String) {
    std::thread::spawn(move || {
        if wayland() && wl_copy(&[], text.as_bytes()) {
            return;
        }
        if let Some(cb) = arboard().lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = cb.set_text(text);
        }
    });
}

/// Copies an encoded image (any format `image` reads); it goes out as PNG.
pub fn copy_image(bytes: Vec<u8>) {
    std::thread::spawn(move || {
        let png = if bytes.starts_with(b"\x89PNG") {
            bytes
        } else {
            let Ok(img) = image::load_from_memory(&bytes) else { return };
            let mut png = vec![];
            if img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).is_err() {
                return;
            }
            png
        };
        if wayland() && wl_copy(&["--type", "image/png"], &png) {
            return;
        }
        let Ok(img) = image::load_from_memory(&png) else { return };
        let img = img.to_rgba8();
        let data = arboard::ImageData { width: img.width() as usize, height: img.height() as usize, bytes: img.into_raw().into() };
        if let Some(cb) = arboard().lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = cb.set_image(data);
        }
    });
}

/// The same notice again within this long is skipped (a held Ctrl+C, a double click).
const SAME_NOTICE: Duration = Duration::from_secs(1);
/// Characters of copied text shown in the notice.
const PREVIEW: usize = 60;

/// One line of `text` for the notice: its first non-blank line, trimmed and cut to
/// [`PREVIEW`] characters, "…" when anything was left out. None for blank text.
fn preview(text: &str) -> Option<String> {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut s: String = first.chars().take(PREVIEW).collect();
    if first.chars().count() > PREVIEW || text.trim() != first {
        s.push('…');
    }
    Some(s)
}

/// Whether a notice with `body` should show at `now`, remembering it in `last`.
fn fresh(last: &mut Option<(String, Instant)>, body: &str, now: Instant) -> bool {
    if last.as_ref().is_some_and(|(b, at)| b == body && now.duration_since(*at) < SAME_NOTICE) {
        return false;
    }
    *last = Some((body.to_string(), now));
    true
}

/// Tells the user something reached the clipboard ("Copied to clipboard" + `body`).
fn notice(body: &str) {
    static LAST: Mutex<Option<(String, Instant)>> = Mutex::new(None);
    if fresh(&mut LAST.lock().unwrap_or_else(|e| e.into_inner()), body, Instant::now()) {
        crate::limits::notify("Copied to clipboard", body);
    }
}

/// An image copied by the user (the image viewer): [`copy_image`] with the notice.
pub fn copy_image_noticed(bytes: Vec<u8>) {
    copy_image(bytes);
    notice("Image");
}

fn copy_color_image(img: &egui::ColorImage) {
    let [w, h] = img.size;
    let rgba: Vec<u8> = img.pixels.iter().flat_map(|c| c.to_srgba_unmultiplied()).collect();
    let mut png = vec![];
    if image::RgbaImage::from_raw(w as u32, h as u32, rgba)
        .is_some_and(|i| i.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).is_ok())
    {
        copy_image(png);
    }
}

/// Turns the clipboard keys into egui's Copy / Cut / Paste events, reading the clipboard
/// for a paste: Ctrl+C / Ctrl+Insert copy, Ctrl+X cuts, Ctrl+V / Ctrl+Shift+V /
/// Shift+Insert paste. In a terminal pane (`in_terminal`) Ctrl+Shift+C stays a key (there
/// is no selection to copy) and Ctrl+C is a Copy, which the pane sends as ^C. In the
/// browser or device pane (`keep_copy_keys`) Ctrl+C/X stay keys, so the page or the device
/// copies its own selection; Ctrl+V there still pastes the PC's clipboard (Paste / PasteImage).
pub fn shortcuts(raw: &mut egui::RawInput, in_terminal: bool, keep_copy_keys: bool) {
    let mut out = Vec::with_capacity(raw.events.len());
    for e in std::mem::take(&mut raw.events) {
        let Event::Key { key, pressed: true, modifiers: m, .. } = &e else {
            out.push(e);
            continue;
        };
        let ctrl = m.ctrl && !m.alt;
        if *key == Key::Paste || (ctrl && *key == Key::V) || (m.shift && !m.ctrl && *key == Key::Insert) {
            match read() {
                Some(Clip::Text(t)) if !t.is_empty() => out.push(Event::Paste(t.replace("\r\n", "\n"))),
                Some(Clip::Image(b)) => {
                    if let Ok(img) = image::load_from_memory(&b) {
                        let img = img.to_rgba8();
                        let size = [img.width() as usize, img.height() as usize];
                        out.push(Event::PasteImage(std::sync::Arc::new(egui::ColorImage::from_rgba_unmultiplied(size, &img))));
                    }
                }
                _ => {}
            }
        } else if keep_copy_keys && ctrl && matches!(key, Key::C | Key::X) {
            out.push(e);
        } else if *key == Key::Copy || (ctrl && *key == Key::C && !(m.shift && in_terminal)) || (ctrl && !m.shift && *key == Key::Insert) {
            out.push(Event::Copy);
        } else if *key == Key::Cut || (ctrl && !m.shift && *key == Key::X) {
            out.push(Event::Cut);
        } else {
            out.push(e);
        }
    }
    raw.events = out;
}

/// Sends what egui copies (`ctx.copy_text`, Ctrl+C in a text field) to the system clipboard.
pub struct Plugin;

impl egui::plugin::Plugin for Plugin {
    fn debug_name(&self) -> &'static str {
        "harbor-clipboard"
    }

    fn output_hook(&mut self, _ctx: &egui::Context, output: &mut egui::FullOutput) {
        output.platform_output.commands.retain(|c| match c {
            egui::OutputCommand::CopyText(t) => {
                if let Some(p) = preview(t) {
                    notice(&p);
                }
                copy_text(t.clone());
                false
            }
            egui::OutputCommand::CopyImage(img) => {
                copy_color_image(img);
                notice("Image");
                false
            }
            _ => true,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_is_one_short_line() {
        assert_eq!(preview("  https://example.com/x \n"), Some("https://example.com/x".into()));
        assert_eq!(preview("\n  first\nsecond"), Some("first…".into()));
        assert_eq!(preview(&"a".repeat(80)), Some(format!("{}…", "a".repeat(60))));
        assert_eq!(preview(" \n\t"), None);
    }

    #[test]
    fn same_notice_within_a_second_is_skipped() {
        let mut last = None;
        let t = Instant::now();
        assert!(fresh(&mut last, "a", t));
        assert!(!fresh(&mut last, "a", t + Duration::from_millis(500)));
        assert!(fresh(&mut last, "b", t + Duration::from_millis(600)));
        assert!(fresh(&mut last, "b", t + Duration::from_millis(1700)));
    }
}
