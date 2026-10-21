//! In-app terminal: a PTY running a shell (or a given command), parsed by
//! `vt100` and drawn as a monospace grid. Only exists while a tab is open.

use crate::theme::Tokens;
use eframe::egui::{self, Color32, CornerRadius, FontId, Key, Rect, Sense, Ui, Vec2, pos2};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::num::NonZeroU16;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct Terminal {
    pub title: String,
    pub cwd: PathBuf,
    parser: Arc<Mutex<vt100::Parser>>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    alive: Arc<AtomicBool>,
    size: (u16, u16),
    scroll: usize,
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
        // Reap it, or a closed tab leaves a zombie behind (it dies within a few ms).
        for _ in 0..20 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

fn nz(n: u16) -> NonZeroU16 {
    NonZeroU16::new(n.max(1)).unwrap()
}

impl Terminal {
    /// `argv` empty runs the user's shell.
    pub fn spawn(
        title: &str,
        cwd: &Path,
        argv: &[String],
        env: &[(String, Option<String>)],
        wake: impl Fn() + Send + 'static,
    ) -> Result<Self, String> {
        let (rows, cols) = (24u16, 80u16);
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut cmd = if argv.is_empty() {
            CommandBuilder::new(shell)
        } else {
            let mut c = CommandBuilder::new(&argv[0]);
            c.args(&argv[1..]);
            c
        };
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in env {
            match v {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            }
        }
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let parser = Arc::new(Mutex::new(vt100::Parser::new(nz(rows), nz(cols), 5000)));
        let alive = Arc::new(AtomicBool::new(true));
        {
            let parser = parser.clone();
            let alive = alive.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 16384];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            parser.lock().unwrap().process(&buf[..n]);
                            wake();
                        }
                    }
                }
                alive.store(false, Ordering::Relaxed);
                wake();
            });
        }
        Ok(Self {
            title: title.into(),
            cwd: cwd.into(),
            parser,
            writer,
            master: pair.master,
            child,
            alive,
            size: (rows, cols),
            scroll: 0,
        })
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub fn write(&mut self, bytes: &[u8]) {
        let _ = self.writer.write_all(bytes);
        let _ = self.writer.flush();
    }

    fn resize(&mut self, rows: u16, cols: u16) {
        if (rows, cols) == self.size || rows < 2 || cols < 4 {
            return;
        }
        self.size = (rows, cols);
        let _ = self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        self.parser.lock().unwrap().set_size(nz(rows), nz(cols));
    }

    /// Draws the grid in the available space and handles input while focused.
    pub fn ui(&mut self, ui: &mut Ui, t: &Tokens, id: egui::Id) {
        let font = FontId::monospace(13.0);
        let (cw, rh) = ui.ctx().fonts_mut(|f| (f.glyph_width(&font, 'M'), f.row_height(&font)));
        let avail = ui.available_size();
        let cols = ((avail.x - 8.0) / cw).floor().max(4.0) as u16;
        let rows = ((avail.y - 4.0) / rh).floor().max(2.0) as u16;
        self.resize(rows, cols);

        let (_, rect) = ui.allocate_space(avail);
        let resp = ui.interact(rect, id, Sense::click()).on_hover_cursor(egui::CursorIcon::Text);
        if resp.clicked() {
            resp.request_focus();
        }
        let focused = resp.has_focus();
        if focused {
            ui.memory_mut(|m| {
                m.set_focus_lock_filter(
                    id,
                    egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: true },
                )
            });
            self.handle_input(ui);
        }
        if resp.hovered() {
            let dy = ui.input(|i| i.smooth_scroll_delta.y);
            if dy != 0.0 {
                let lines = (dy / rh).round() as i64;
                let p = self.parser.lock().unwrap();
                if p.screen().alternate_screen() {
                    drop(p);
                    let seq: &[u8] = if lines > 0 { b"\x1b[A" } else { b"\x1b[B" };
                    for _ in 0..lines.unsigned_abs().min(10) {
                        self.write(seq);
                    }
                } else {
                    drop(p);
                    self.scroll = (self.scroll as i64 + lines).max(0) as usize;
                }
            }
        }
        self.paint(ui, rect, t, &font, cw, rh, focused);
    }

    fn handle_input(&mut self, ui: &mut Ui) {
        let events = ui.input(|i| i.events.clone());
        let app_cursor = self.parser.lock().unwrap().screen().application_cursor();
        let bracketed = self.parser.lock().unwrap().screen().bracketed_paste();
        let ctrl_c_key = events.iter().any(|e| {
            matches!(e, egui::Event::Key { key: Key::C, pressed: true, modifiers, .. } if modifiers.ctrl && !modifiers.shift)
        });
        let mut out: Vec<u8> = vec![];
        for e in events {
            match e {
                egui::Event::Text(s) => out.extend_from_slice(s.as_bytes()),
                egui::Event::Paste(s) => {
                    if bracketed {
                        out.extend_from_slice(b"\x1b[200~");
                        out.extend_from_slice(s.as_bytes());
                        out.extend_from_slice(b"\x1b[201~");
                    } else {
                        out.extend_from_slice(s.as_bytes());
                    }
                }
                egui::Event::Copy if !ctrl_c_key => out.push(0x03),
                egui::Event::Cut => out.push(0x18),
                egui::Event::Key { key, pressed: true, modifiers, .. } => {
                    let arrow = |c: u8| if app_cursor { vec![0x1b, b'O', c] } else { vec![0x1b, b'[', c] };
                    let seq: Vec<u8> = match key {
                        Key::Enter => vec![b'\r'],
                        Key::Backspace => if modifiers.alt { vec![0x1b, 0x7f] } else { vec![0x7f] },
                        Key::Tab => if modifiers.shift { b"\x1b[Z".to_vec() } else { vec![b'\t'] },
                        Key::Escape => vec![0x1b],
                        Key::ArrowUp => arrow(b'A'),
                        Key::ArrowDown => arrow(b'B'),
                        Key::ArrowRight => arrow(b'C'),
                        Key::ArrowLeft => arrow(b'D'),
                        Key::Home => arrow(b'H'),
                        Key::End => arrow(b'F'),
                        Key::PageUp => b"\x1b[5~".to_vec(),
                        Key::PageDown => b"\x1b[6~".to_vec(),
                        Key::Delete => b"\x1b[3~".to_vec(),
                        Key::Insert => b"\x1b[2~".to_vec(),
                        k if modifiers.ctrl && !modifiers.shift => {
                            let name = k.name();
                            if name.len() == 1 && name.as_bytes()[0].is_ascii_alphabetic() {
                                vec![name.as_bytes()[0].to_ascii_uppercase() - b'A' + 1]
                            } else {
                                match k {
                                    Key::OpenBracket => vec![0x1b],
                                    Key::Backslash => vec![0x1c],
                                    Key::CloseBracket => vec![0x1d],
                                    _ => vec![],
                                }
                            }
                        }
                        _ => vec![],
                    };
                    out.extend(seq);
                }
                _ => {}
            }
        }
        if !out.is_empty() {
            self.scroll = 0;
            self.write(&out);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn paint(&mut self, ui: &Ui, rect: Rect, t: &Tokens, font: &FontId, cw: f32, rh: f32, focused: bool) {
        let painter = ui.painter_at(rect);
        let bg = t.bg200;
        painter.rect_filled(rect, CornerRadius::ZERO, bg);
        let mut p = self.parser.lock().unwrap();
        p.screen_mut().set_scrollback(self.scroll);
        self.scroll = p.screen().scrollback();
        let screen = p.screen();
        let (rows, cols) = screen.size();
        let origin = rect.min + Vec2::new(4.0, 2.0);
        let ansi = ansi_palette(t);
        let color = |c: vt100::Color, default: Color32| match c {
            vt100::Color::Default => default,
            vt100::Color::Idx(i) => idx_color(i, &ansi),
            vt100::Color::Rgb(r, g, b) => Color32::from_rgb(r, g, b),
        };
        for r in 0..rows.get() {
            let y = origin.y + r as f32 * rh;
            let mut c = 0u16;
            while c < cols.get() {
                let Some(cell) = screen.cell(r, c) else { break };
                let (mut fg, mut cbg) = (color(cell.fgcolor(), t.fg()), color(cell.bgcolor(), bg));
                if cell.inverse() {
                    std::mem::swap(&mut fg, &mut cbg);
                }
                if cell.dim() {
                    fg = fg.gamma_multiply(0.6);
                }
                // Collect a run of cells with identical style.
                let start = c;
                let mut text = String::new();
                let key = (cell.fgcolor(), cell.bgcolor(), cell.inverse(), cell.bold(), cell.dim(), cell.underline());
                while c < cols.get() {
                    let Some(cc) = screen.cell(r, c) else { break };
                    if (cc.fgcolor(), cc.bgcolor(), cc.inverse(), cc.bold(), cc.dim(), cc.underline()) != key {
                        break;
                    }
                    if !cc.is_wide_continuation() {
                        let s = cc.contents();
                        text.push_str(if s.is_empty() { " " } else { s });
                    }
                    c += 1;
                }
                let x0 = origin.x + start as f32 * cw;
                let w = (c - start) as f32 * cw;
                if cbg != bg {
                    painter.rect_filled(Rect::from_min_size(pos2(x0, y), Vec2::new(w, rh)), CornerRadius::ZERO, cbg);
                }
                if !text.trim().is_empty() {
                    let f = if key.3 { FontId::new(font.size, egui::FontFamily::Monospace) } else { font.clone() };
                    painter.text(pos2(x0, y), egui::Align2::LEFT_TOP, &text, f, fg);
                    if key.5 {
                        painter.hline(x0..=x0 + w, y + rh - 1.0, egui::Stroke::new(1.0, fg));
                    }
                }
            }
        }
        if self.scroll == 0 && !screen.hide_cursor() && self.alive() {
            let (cr, cc) = screen.cursor_position();
            let cur = Rect::from_min_size(pos2(origin.x + cc as f32 * cw, origin.y + cr as f32 * rh), Vec2::new(cw, rh));
            if focused {
                painter.rect_filled(cur, CornerRadius::ZERO, t.fg().gamma_multiply(0.7));
                if let Some(cell) = screen.cell(cr, cc) {
                    painter.text(cur.min, egui::Align2::LEFT_TOP, cell.contents(), font.clone(), bg);
                }
            } else {
                painter.rect_stroke(cur, CornerRadius::ZERO, egui::Stroke::new(1.0, t.fg().gamma_multiply(0.6)), egui::StrokeKind::Inside);
            }
        }
        if self.scroll > 0 {
            let label = format!("↑ {} lines", self.scroll);
            painter.text(rect.right_top() + Vec2::new(-10.0, 6.0), egui::Align2::RIGHT_TOP, label, FontId::proportional(12.0), t.subtle());
        }
        p.screen_mut().set_scrollback(0);
    }
}

/// ANSI 16 from the rengaf scales, so terminal output matches the app.
fn ansi_palette(t: &Tokens) -> [Color32; 16] {
    let (magenta, cyan) = if t.dark {
        (Color32::from_rgb(0xc0, 0x84, 0xfc), Color32::from_rgb(0x4f, 0xd1, 0xe0))
    } else {
        (Color32::from_rgb(0x8b, 0x3f, 0xd6), Color32::from_rgb(0x0e, 0x7f, 0x90))
    };
    [
        t.gray(500), t.red(900), t.green(900), t.amber(900), t.blue(900), magenta, cyan, t.gray(1000),
        t.gray(700), t.red(700), t.green(700), t.amber(700), t.blue(700), magenta, cyan, t.gray(1000),
    ]
}

fn idx_color(i: u8, ansi: &[Color32; 16]) -> Color32 {
    match i {
        0..16 => ansi[i as usize],
        16..232 => {
            let i = i - 16;
            let v = |x: u8| if x == 0 { 0 } else { 55 + x * 40 };
            Color32::from_rgb(v(i / 36), v((i / 6) % 6), v(i % 6))
        }
        _ => {
            let g = 8 + (i - 232) * 10;
            Color32::from_rgb(g, g, g)
        }
    }
}
