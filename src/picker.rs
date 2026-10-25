//! Native file dialogs: zenity (GTK) first, then kdialog (KDE). Without either the click
//! would do nothing, so a toast says what to install instead.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use eframe::egui;

pub const IMAGES: &[&str] = &["*.png", "*.svg", "*.ico", "*.jpg", "*.jpeg", "*.webp", "*.gif"];
pub const NO_PICKER: &str = "No file picker found: install zenity (or kdialog on KDE).";
const SHOW_FOR: Duration = Duration::from_secs(8);

static ERROR: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static CTX: Mutex<Option<egui::Context>> = Mutex::new(None);

#[derive(Clone, Copy, Default)]
pub struct Opts<'a> {
    pub title: &'a str,
    pub multiple: bool,
    /// Name and glob patterns, e.g. ("Images", IMAGES).
    pub filter: Option<(&'a str, &'a [&'a str])>,
    /// Folder the dialog starts in.
    pub dir: Option<&'a Path>,
}

fn zenity_args(o: &Opts) -> Vec<String> {
    let mut a = vec!["--file-selection".to_string(), "--separator=\n".into(), format!("--title={}", o.title)];
    if o.multiple {
        a.push("--multiple".into());
    }
    if let Some((name, pats)) = o.filter {
        a.push(format!("--file-filter={name} | {}", pats.join(" ")));
    }
    if let Some(d) = o.dir {
        a.push(format!("--filename={}/", d.display()));
    }
    a
}

fn kdialog_args(o: &Opts) -> Vec<String> {
    let start = o.dir.map(|d| d.display().to_string()).unwrap_or_else(|| ".".into());
    let mut a = vec!["--getopenfilename".to_string(), start];
    if let Some((name, pats)) = o.filter {
        a.push(format!("{name} ({})", pats.join(" ")));
    }
    if o.multiple {
        a.extend(["--multiple".into(), "--separate-output".into()]);
    }
    a.extend(["--title".into(), o.title.into()]);
    a
}

fn paths(stdout: &[u8]) -> Vec<PathBuf> {
    String::from_utf8_lossy(stdout).lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect()
}

/// Blocks until the user picks (call it off the UI thread). Empty when cancelled, or when no
/// picker is installed (then the toast explains).
pub fn pick(o: Opts) -> Vec<PathBuf> {
    for (bin, args) in [("zenity", zenity_args(&o)), ("kdialog", kdialog_args(&o))] {
        match Command::new(bin).args(&args).output() {
            Ok(out) if out.status.success() => return paths(&out.stdout),
            Ok(_) => return Vec::new(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return fail(format!("Couldn't open the file picker ({bin}): {e}")),
        }
    }
    fail(NO_PICKER.into())
}

fn fail(msg: String) -> Vec<PathBuf> {
    eprintln!("harbor: {msg}");
    *ERROR.lock().unwrap() = Some((msg, Instant::now()));
    if let Some(ctx) = CTX.lock().unwrap().as_ref() {
        ctx.request_repaint();
    }
    Vec::new()
}

/// Shows the last picker error for a few seconds; called every frame.
pub fn toast(ctx: &egui::Context, t: &crate::theme::Tokens) {
    CTX.lock().unwrap().get_or_insert_with(|| ctx.clone());
    let mut err = ERROR.lock().unwrap();
    let Some((msg, at)) = err.as_ref() else { return };
    let left = SHOW_FOR.saturating_sub(at.elapsed());
    if left.is_zero() {
        *err = None;
        return;
    }
    ctx.request_repaint_after(left);
    let msg = msg.clone();
    drop(err);
    egui::Area::new(egui::Id::NULL.with("picker-toast"))
        .order(egui::Order::Tooltip)
        .anchor(egui::Align2::CENTER_BOTTOM, egui::vec2(0.0, -24.0))
        .show(ctx, |ui| {
            crate::widgets::popover_frame(t).show(ui, |ui| ui.label(egui::RichText::new(&msg).color(t.fg())));
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_args() {
        let dir = Path::new("/tmp/x");
        let o = Opts { title: "Icon", multiple: false, filter: Some(("Images", &["*.png", "*.svg"])), dir: Some(dir) };
        assert_eq!(zenity_args(&o), ["--file-selection", "--separator=\n", "--title=Icon", "--file-filter=Images | *.png *.svg", "--filename=/tmp/x/"]);
        assert_eq!(kdialog_args(&o), ["--getopenfilename", "/tmp/x", "Images (*.png *.svg)", "--title", "Icon"]);
        let m = Opts { title: "Attach", multiple: true, ..Default::default() };
        assert_eq!(kdialog_args(&m), ["--getopenfilename", ".", "--multiple", "--separate-output", "--title", "Attach"]);
        assert_eq!(paths(b"/a b\n\n/c\n"), [PathBuf::from("/a b"), PathBuf::from("/c")]);
    }
}
