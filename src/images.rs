//! Image previews: thumbnails of image files (attachments, screenshots an agent
//! read or saved) and a lightbox to see one larger, inside Harbor. Files are
//! decoded off the UI thread, downscaled and kept as textures.
//!
//! Images are addressed by a key: a local path, or any name registered with
//! `put_bytes` (an image that isn't on this disk, e.g. on a remote device).
//!
//! - `thumbnail(ui, key, size)`: a click opens the lightbox.
//! - `strip(ui, keys, size)`: a wrapped row of thumbnails, browsable as a gallery.
//! - `attachment(ui, key, size)`: a thumbnail with a remove button; true when removed.
//! - `open(ctx, key)`, `open_gallery(ctx, keys, index)` (← → to browse),
//!   `lightbox(ctx)` (once per frame, after the rest), `is_open(ctx)`.

use crate::icons as ic;
use crate::theme::RADIUS_MD;
use crate::widgets as w;
use eframe::egui::{
    self, Color32, ColorImage, CornerRadius, CursorIcon, FontId, Id, Key, Rect, Response, Sense, Stroke, StrokeKind,
    TextureHandle, TextureOptions, Ui, Vec2, load::SizedTexture, pos2, vec2,
};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

const EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
/// Longest side of a thumbnail texture, in pixels (sharp up to ~190pt at 2x).
const THUMB_PX: u32 = 384;
/// Longest side of the lightbox texture.
const FULL_PX: u32 = 4096;
/// Files above this are not decoded.
const MAX_BYTES: u64 = 100 << 20;
/// Longest side and decoded size an image may declare; its header is checked before any
/// pixel buffer is allocated, so a tiny file can't ask for gigabytes.
const MAX_SIDE: u32 = 16384;
const MAX_ALLOC: u64 = 512 << 20;
const WORKERS: usize = 2;
/// Thumbnails kept without being drawn, before the unused ones are dropped.
const KEEP: usize = 96;

pub fn is_image(path: &str) -> bool {
    Path::new(path).extension().and_then(|e| e.to_str()).is_some_and(|e| EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

// ---------------------------------------------------------------- cache

#[derive(Clone)]
enum Slot {
    Loading,
    Ready { tex: TextureHandle, dims: [usize; 2], stamp: Option<SystemTime> },
    Failed(String),
}

struct Job {
    key: String,
    full: bool,
}

#[derive(Default)]
struct Cache {
    /// Thumbnail per key, with the last time it was drawn.
    thumbs: HashMap<String, (Slot, f64)>,
    /// The lightbox's full-size image (one at a time).
    full: Option<(String, Slot)>,
    open: Option<String>,
    /// What ← → browse in the lightbox (just `open` for a single image).
    gallery: Vec<String>,
    bytes: HashMap<String, Arc<[u8]>>,
    queue: VecDeque<Job>,
    workers: usize,
}

type Shared = Arc<Mutex<Cache>>;

fn shared(ctx: &egui::Context) -> Shared {
    ctx.data_mut(|d| d.get_temp_mut_or_default::<Shared>(Id::NULL.with("images")).clone())
}

/// Drops every decoded image (a new window's renderer has none of their textures).
pub fn forget_all(ctx: &egui::Context) {
    ctx.data_mut(|d| d.remove_temp::<Shared>(Id::NULL.with("images")));
}

fn lock(s: &Shared) -> MutexGuard<'_, Cache> {
    s.lock().unwrap_or_else(|e| e.into_inner())
}

fn stamp(key: &str) -> Option<SystemTime> {
    std::fs::metadata(key).and_then(|m| m.modified()).ok()
}

/// Queues a decode; workers start on demand and stop when the queue is empty.
fn request(ctx: &egui::Context, s: &Shared, c: &mut Cache, job: Job) {
    if job.full {
        c.queue.push_front(job);
    } else {
        c.queue.push_back(job);
    }
    if c.workers < WORKERS {
        c.workers += 1;
        let (ctx, s) = (ctx.clone(), s.clone());
        std::thread::spawn(move || worker(ctx, s));
    }
}

fn worker(ctx: egui::Context, s: Shared) {
    loop {
        let (job, bytes) = {
            let mut c = lock(&s);
            let Some(job) = c.queue.pop_front() else {
                c.workers -= 1;
                return;
            };
            let bytes = c.bytes.get(&job.key).cloned();
            (job, bytes)
        };
        let st = if bytes.is_none() { stamp(&job.key) } else { None };
        let slot = match decode(&job.key, bytes, if job.full { FULL_PX } else { THUMB_PX }) {
            Ok((img, dims)) => {
                let name = format!("image-{}-{}", if job.full { "full" } else { "thumb" }, job.key);
                Slot::Ready { tex: ctx.load_texture(name, img, TextureOptions::LINEAR), dims, stamp: st }
            }
            Err(e) => Slot::Failed(e),
        };
        let mut c = lock(&s);
        if job.full {
            if c.full.as_ref().is_some_and(|(k, _)| *k == job.key) {
                c.full = Some((job.key, slot));
            }
        } else if let Some(e) = c.thumbs.get_mut(&job.key) {
            e.0 = slot;
        }
        drop(c);
        ctx.request_repaint();
    }
}

/// Decodes (first frame of a GIF, EXIF-rotated) and shrinks to `cap` pixels.
/// Returns the image and the original dimensions.
fn decode(key: &str, bytes: Option<Arc<[u8]>>, cap: u32) -> Result<(ColorImage, [usize; 2]), String> {
    use image::ImageDecoder;
    let mut reader = match &bytes {
        Some(b) => image::ImageReader::new(std::io::Cursor::new(b.to_vec())).with_guessed_format(),
        None => {
            let len = std::fs::metadata(key).map_err(|e| e.to_string())?.len();
            if len > MAX_BYTES {
                return Err(format!("too large ({} MB)", len >> 20));
            }
            std::fs::read(key).map(|b| image::ImageReader::new(std::io::Cursor::new(b))).map_err(|e| e.to_string())?.with_guessed_format()
        }
    }
    .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    reader.limits(limits);
    let mut dec = reader.into_decoder().map_err(|e| e.to_string())?;
    let (w, h) = dec.dimensions();
    if w.max(h) > MAX_SIDE || dec.total_bytes() > MAX_ALLOC {
        return Err(format!("too large ({w}×{h})"));
    }
    let orient = dec.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(dec).map_err(|e| e.to_string())?;
    img.apply_orientation(orient);
    let dims = [img.width() as usize, img.height() as usize];
    if img.width().max(img.height()) > cap {
        img = if cap == THUMB_PX { img.thumbnail(cap, cap) } else { img.resize(cap, cap, image::imageops::FilterType::Triangle) };
    }
    let rgba = img.to_rgba8();
    Ok((ColorImage::from_rgba_unmultiplied([rgba.width() as usize, rgba.height() as usize], rgba.as_raw()), dims))
}

/// The thumbnail's state, queueing it on first sight.
fn thumb(ctx: &egui::Context, key: &str) -> Slot {
    let s = shared(ctx);
    let mut c = lock(&s);
    let now = ctx.input(|i| i.time);
    if let Some(e) = c.thumbs.get_mut(key) {
        e.1 = now;
        return e.0.clone();
    }
    c.thumbs.insert(key.to_string(), (Slot::Loading, now));
    request(ctx, &s, &mut c, Job { key: key.to_string(), full: false });
    Slot::Loading
}

/// Registers an image that isn't a local file (its encoded bytes) under `key`,
/// replacing what was cached for it.
#[allow(dead_code)]
pub fn put_bytes(ctx: &egui::Context, key: &str, bytes: Vec<u8>) {
    let s = shared(ctx);
    let mut c = lock(&s);
    c.bytes.insert(key.to_string(), bytes.into());
    c.thumbs.remove(key);
    if c.full.as_ref().is_some_and(|(k, _)| k == key) {
        c.full = None;
    }
}

/// Drops what's cached for `key` (its file changed, or it's gone).
#[allow(dead_code)]
pub fn forget(ctx: &egui::Context, key: &str) {
    let s = shared(ctx);
    let mut c = lock(&s);
    c.bytes.remove(key);
    c.thumbs.remove(key);
    if c.full.as_ref().is_some_and(|(k, _)| k == key) {
        c.full = None;
    }
}

// ---------------------------------------------------------------- widgets

fn name(key: &str) -> String {
    Path::new(key).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| key.to_string())
}

/// UV rect that crops a texture of `tex` size to fill `rect` (object-fit: cover).
fn cover(tex: Vec2, rect: Vec2) -> Rect {
    let (ta, ra) = (tex.x / tex.y.max(1.0), rect.x / rect.y.max(1.0));
    if ta > ra {
        let w = ra / ta;
        Rect::from_min_max(pos2((1.0 - w) / 2.0, 0.0), pos2((1.0 + w) / 2.0, 1.0))
    } else {
        let h = ta / ra;
        Rect::from_min_max(pos2(0.0, (1.0 - h) / 2.0), pos2(1.0, (1.0 + h) / 2.0))
    }
}

/// A rounded thumbnail of the image at `key`, cropped to `size`. Click: lightbox.
pub fn thumbnail(ui: &mut Ui, key: &str, size: Vec2) -> Response {
    thumb_in(ui, key, size, &[])
}

/// Thumbnails of `keys` in a wrapped row; a click opens them as a gallery.
pub fn strip(ui: &mut Ui, keys: &[String], size: Vec2) {
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = Vec2::splat(8.0);
        for k in keys {
            thumb_in(ui, k, size, keys);
        }
    });
}

/// `thumbnail`, opening `group` (when not empty) as the lightbox's gallery.
fn thumb_in(ui: &mut Ui, key: &str, size: Vec2, group: &[String]) -> Response {
    let t = w::tokens(ui);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    let mut tip = name(key);
    // Off-screen thumbnails (long transcripts) aren't decoded until scrolled to.
    if ui.is_rect_visible(rect) {
        let radius = CornerRadius::same(RADIUS_MD);
        let p = ui.painter();
        match thumb(ui.ctx(), key) {
            Slot::Ready { tex, dims, .. } => {
                egui::Image::from_texture(SizedTexture::from_handle(&tex))
                    .uv(cover(tex.size_vec2(), size))
                    .corner_radius(radius)
                    .paint_at(ui, rect);
                tip = format!("{tip}\n{} × {}", dims[0], dims[1]);
            }
            Slot::Loading => {
                p.rect_filled(rect, radius, t.gray(100));
                // The spinner asks for its own next step; the decoder repaints when done.
                w::spinner(p, rect.center(), 7.0, t.subtle());
            }
            Slot::Failed(e) => {
                p.rect_filled(rect, radius, t.gray(100));
                ic::glyph(p, rect.center(), ic::IMAGE, 18.0, t.subtle());
                tip = format!("{tip}\nCan't show this image: {e}");
            }
        }
        if resp.hovered() {
            ui.painter().rect_filled(rect, radius, Color32::from_white_alpha(14));
        }
        ui.painter().rect_stroke(rect, radius, Stroke::new(1.0, if resp.hovered() { t.gray(600) } else { t.border() }), StrokeKind::Inside);
    }
    let resp = resp.on_hover_cursor(CursorIcon::PointingHand).on_hover_text(tip);
    if resp.clicked() {
        match group.iter().position(|k| k == key) {
            Some(i) => open_gallery(ui.ctx(), group.to_vec(), i),
            None => open(ui.ctx(), key),
        }
    }
    resp
}

/// An attachment: a thumbnail with a remove button in its corner. Returns true when removed.
pub fn attachment(ui: &mut Ui, key: &str, size: Vec2) -> bool {
    let r = thumbnail(ui, key, size);
    let xr = Rect::from_center_size(r.rect.right_top() + vec2(-10.0, 10.0), Vec2::splat(18.0));
    // Interacted after the thumbnail, so it's on top: its clicks don't open the lightbox.
    let x = ui.interact(xr, ui.scope_id().with(("remove-image", key)), Sense::click());
    let p = ui.painter();
    p.circle_filled(xr.center(), 9.0, Color32::from_black_alpha(if x.hovered() { 220 } else { 160 }));
    ic::glyph(p, xr.center(), ic::X, 11.0, Color32::WHITE);
    x.on_hover_cursor(CursorIcon::PointingHand).on_hover_text("Remove").clicked()
}

// ---------------------------------------------------------------- lightbox

/// Opens the lightbox on `key`.
pub fn open(ctx: &egui::Context, key: &str) {
    open_gallery(ctx, vec![key.to_string()], 0);
}

/// Opens the lightbox on `keys[index]`; ← → (or the side buttons) move through `keys`.
pub fn open_gallery(ctx: &egui::Context, keys: Vec<String>, index: usize) {
    let Some(key) = keys.get(index).cloned() else { return };
    lock(&shared(ctx)).gallery = keys;
    show(ctx, &key);
}

/// Points the lightbox at `key`, (re)loading it if the file changed since.
fn show(ctx: &egui::Context, key: &str) {
    let s = shared(ctx);
    let mut c = lock(&s);
    c.open = Some(key.to_string());
    let local = !c.bytes.contains_key(key);
    let now = if local { stamp(key) } else { None };
    // A screenshot taken again at the same path: refresh the thumbnail too.
    if let Some((Slot::Ready { stamp: Some(was), .. }, _)) = c.thumbs.get(key) {
        if now.is_some_and(|n| n != *was) {
            c.thumbs.get_mut(key).unwrap().0 = Slot::Loading;
            request(ctx, &s, &mut c, Job { key: key.to_string(), full: false });
        }
    }
    let fresh = match &c.full {
        Some((k, Slot::Ready { stamp, .. })) => k == key && (!local || *stamp == now),
        Some((k, Slot::Loading)) => k == key,
        _ => false,
    };
    if !fresh {
        c.full = Some((key.to_string(), Slot::Loading));
        request(ctx, &s, &mut c, Job { key: key.to_string(), full: true });
    }
}

pub fn is_open(ctx: &egui::Context) -> bool {
    lock(&shared(ctx)).open.is_some()
}

pub fn close(ctx: &egui::Context) {
    let s = shared(ctx);
    let mut c = lock(&s);
    c.open = None;
    c.gallery.clear();
    // The full-size texture is large; keep it only while it's shown.
    c.full = None;
}

/// Draws the lightbox when one is open, and drops thumbnails not drawn lately.
/// Call once per frame, after the rest of the UI. Esc, the X or a click outside closes it.
pub fn lightbox(ctx: &egui::Context) {
    let s = shared(ctx);
    let (key, full, small, gallery) = {
        let mut c = lock(&s);
        if c.thumbs.len() > KEEP {
            let now = ctx.input(|i| i.time);
            c.thumbs.retain(|_, (slot, used)| matches!(slot, Slot::Loading) || now - *used < 30.0);
        }
        let Some(key) = c.open.clone() else { return };
        let full = c.full.as_ref().filter(|(k, _)| *k == key).map(|(_, s)| s.clone());
        let small = c.thumbs.get(&key).map(|(s, _)| s.clone());
        (key, full, small, c.gallery.clone())
    };
    let mut shut = ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, Key::Escape));
    let at = gallery.iter().position(|k| *k == key).unwrap_or(0);
    let n = gallery.len();
    let mut go: Option<usize> = None;
    if n > 1 {
        ctx.input_mut(|i| {
            if i.consume_key(egui::Modifiers::NONE, Key::ArrowLeft) {
                go = Some((at + n - 1) % n);
            }
            if i.consume_key(egui::Modifiers::NONE, Key::ArrowRight) {
                go = Some((at + 1) % n);
            }
        });
    }
    let screen = ctx.content_rect();
    egui::Area::new(Id::NULL.with("lightbox")).order(egui::Order::Foreground).fixed_pos(screen.min).show(ctx, |ui| {
        let back = ui.interact(screen, Id::NULL.with("lightbox-back"), Sense::click());
        ui.painter().rect_filled(screen, 0.0, Color32::from_black_alpha(220));
        let room = Rect::from_min_max(screen.min + vec2(48.0, 56.0), screen.max - vec2(48.0, 64.0));
        // The full image once decoded; until then the thumbnail, stretched.
        let shown = match (&full, &small) {
            (Some(Slot::Ready { tex, dims, .. }), _) => Some((tex.clone(), *dims, false)),
            (Some(Slot::Loading) | None, Some(Slot::Ready { tex, dims, .. })) => Some((tex.clone(), *dims, true)),
            _ => None,
        };
        let failed = match (&full, &small) {
            (Some(Slot::Failed(e)), _) | (_, Some(Slot::Failed(e))) => Some(e.clone()),
            _ => None,
        };
        let mut caption = if n > 1 { format!("{}  ·  {} of {n}", name(&key), at + 1) } else { name(&key) };
        if let Some((tex, dims, loading)) = shown {
            let natural = vec2(dims[0] as f32, dims[1] as f32) / ctx.pixels_per_point();
            let scale = (room.width() / natural.x).min(room.height() / natural.y).min(1.0);
            let rect = Rect::from_center_size(room.center(), natural * scale);
            egui::Image::from_texture(SizedTexture::from_handle(&tex)).corner_radius(CornerRadius::same(RADIUS_MD)).paint_at(ui, rect);
            // Clicks on the image itself don't close.
            ui.interact(rect, Id::NULL.with("lightbox-image"), Sense::click());
            if loading {
                w::spinner(ui.painter(), rect.center(), 12.0, Color32::WHITE);
            }
            caption = format!("{caption}  ·  {} × {}", dims[0], dims[1]);
        } else if let Some(e) = failed {
            ui.painter().text(room.center(), egui::Align2::CENTER_CENTER, format!("Can't show this image: {e}"), FontId::proportional(14.0), Color32::from_gray(220));
        } else {
            w::spinner(ui.painter(), room.center(), 12.0, Color32::WHITE);
        }
        let g = ui.painter().layout_no_wrap(caption, FontId::proportional(13.0), Color32::from_gray(210));
        ui.painter().galley(pos2(screen.center().x - g.size().x / 2.0, screen.bottom() - 40.0), g, Color32::from_gray(210));
        // Top right: copy path (local files), copy image and close.
        let bar = Rect::from_min_max(pos2(screen.right() - 340.0, screen.top() + 12.0), pos2(screen.right() - 12.0, screen.top() + 44.0));
        let mut child = ui.new_child(egui::UiBuilder::new().max_rect(bar).layout(egui::Layout::right_to_left(egui::Align::Center)));
        child.spacing_mut().item_spacing.x = 6.0;
        if w::btn(ic::X).icon_sm().show(&mut child).on_hover_text("Close (Esc)").clicked() {
            shut = true;
        }
        if Path::new(&key).is_absolute() && w::btn(&format!("{}  Copy path", ic::COPY)).sm().show(&mut child).clicked() {
            ctx.copy_text(key.clone());
        }
        // Copy image (also Ctrl+C): the encoded bytes go to the system clipboard as PNG.
        let copy = w::btn(&format!("{}  Copy image", ic::IMAGE)).sm().show(&mut child).clicked()
            || ctx.input(|i| i.events.iter().any(|e| matches!(e, egui::Event::Copy)));
        if copy {
            let bytes = lock(&s).bytes.get(&key).map(|b| b.to_vec()).or_else(|| std::fs::read(&key).ok());
            if let Some(b) = bytes {
                crate::clipboard::copy_image_noticed(b);
            }
        }
        if n > 1 {
            for (dx, glyph, to, tip) in [(32.0, ic::LEFT, (at + n - 1) % n, "Previous (←)"), (-32.0, ic::RIGHT, (at + 1) % n, "Next (→)")] {
                let x = if dx > 0.0 { screen.left() + dx } else { screen.right() + dx };
                let r = Rect::from_center_size(pos2(x, room.center().y), Vec2::splat(32.0));
                let mut child = ui.new_child(egui::UiBuilder::new().max_rect(r));
                if w::btn(glyph).icon().show(&mut child).on_hover_text(tip).clicked() {
                    go = Some(to);
                }
            }
        }
        if back.clicked() {
            shut = true;
        }
    });
    if shut {
        close(ctx);
    } else if let Some(i) = go {
        show(ctx, &gallery[i]);
    }
}

// ---------------------------------------------------------------- paths in text

/// Local image files mentioned in `text` (absolute or `~/` paths that exist), at
/// most four. Cached per text, so calling it every frame is cheap.
pub fn paths_in(ctx: &egui::Context, text: &str) -> Vec<String> {
    ctx.memory_mut(|m| m.caches.cache::<egui::cache::FrameCache<Vec<String>, Finder>>().get(text).clone())
}

/// [`paths_in`] without the frame cache (off the UI's frames, for the phone API).
pub fn find_paths(text: &str) -> Vec<String> {
    use egui::cache::ComputerMut;
    Finder.compute(text)
}

#[derive(Default)]
struct Finder;

impl<'a> egui::cache::ComputerMut<&'a str, Vec<String>> for Finder {
    fn compute(&mut self, text: &'a str) -> Vec<String> {
        let mut out: Vec<String> = vec![];
        let lower = text.to_ascii_lowercase();
        if !EXTS.iter().any(|e| lower.contains(&format!(".{e}"))) {
            return out;
        }
        // Split on what can't be part of a path here: quotes, brackets, JSON escapes, markdown.
        let tokens = text.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '(' | ')' | '<' | '>' | '[' | ']' | ',' | '=' | '\\' | '|' | '*'));
        for tok in tokens {
            let tok = tok.trim_end_matches(['.', ':', ';', '!', '?']);
            let tok = tok.strip_prefix("file://").unwrap_or(tok);
            if !is_image(tok) {
                continue;
            }
            let path = match tok.strip_prefix("~/") {
                Some(rest) => crate::store::home().join(rest),
                None if tok.starts_with('/') => PathBuf::from(tok),
                None => continue,
            };
            let p = path.to_string_lossy().into_owned();
            if !out.contains(&p) && path.is_file() {
                out.push(p);
                if out.len() == 4 {
                    break;
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        image::RgbaImage::new(w, h).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
        out
    }

    #[test]
    fn decodes_a_normal_png() {
        let (img, dims) = decode("t.png", Some(png(64, 64).into()), THUMB_PX).unwrap();
        assert_eq!(dims, [64, 64]);
        assert_eq!(img.size, [64, 64]);
    }

    #[test]
    fn refuses_huge_declared_dimensions_before_allocating() {
        // A 1x1 PNG whose IHDR (CRC fixed up) declares 2^26 x 2^30 pixels.
        let mut b = png(1, 1);
        b[16..20].copy_from_slice(&(1u32 << 26).to_be_bytes());
        b[20..24].copy_from_slice(&(1u32 << 30).to_be_bytes());
        let crc = b[12..29].iter().fold(!0u32, |mut c, &x| {
            c ^= x as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            c
        });
        b[29..33].copy_from_slice(&(!crc).to_be_bytes());
        assert!(decode("t.png", Some(b.into()), THUMB_PX).is_err());
    }
}
