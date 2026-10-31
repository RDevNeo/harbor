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
//! - `take_keys(ctx)` (early in the frame): the lightbox's ← → Esc, before a focused
//!   composer sees them.
//! - `in_card(ctx, seq)` / `take_opened(ctx)` / `widen(ctx, keys)`: a chat notes which card each
//!   image belongs to, then turns the clicked image's group into all of its card's images.

use crate::widgets::Tip as _;
use crate::icons as ic;
use crate::theme::RADIUS_MD;
use crate::widgets as w;
use eframe::egui::{
    self, Color32, ColorImage, CornerRadius, CursorIcon, FontId, Id, Key, Rect, Response, Sense, Stroke, StrokeKind,
    TextureHandle, TextureOptions, Ui, Vec2, load::SizedTexture, pos2, vec2,
};
use crate::media::Media;
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

const EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
/// Longest side of a thumbnail texture, in pixels (sharp up to ~190pt at 2x).
const THUMB_PX: u32 = 384;
/// Keys with this prefix are the larger copy an image or video poster shown inline in a reply.
const MID: &str = "mid:";
const MID_PX: u32 = 1280;
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
    /// The transcript card being drawn (see [`in_card`]).
    card: usize,
    /// The card of the image a click just opened (see [`take_opened`]).
    opened: Option<usize>,
    /// ← → Esc taken early in the frame (see [`take_keys`]): previous, next, close.
    keys: [bool; 3],
    bytes: HashMap<String, Arc<[u8]>>,
    queue: VecDeque<Job>,
    workers: usize,
    /// Where images drawn now come from: another PC's (see [`set_source`]).
    source: Option<Source>,
    /// Image → where to fetch it, for images of another PC's chat.
    remote: HashMap<String, Fetch>,
}

/// Fetches an image that isn't on this disk by its path there (encoded bytes), e.g. from the
/// PC a mirrored chat runs on (mesh.rs `home_image`). Runs on a decode worker; may block.
pub type Fetch = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

/// Where the images and videos of another PC's chat come from.
#[derive(Clone)]
pub struct Source {
    /// An image (a video's poster), at most `mesh::REMOTE_IMAGE_PX`.
    pub image: Fetch,
    /// A video's file, to play.
    pub video: Fetch,
}

/// Images and videos drawn until the next call come from another PC's chat (an attachment its
/// sender uploaded there, a screenshot its agent took). None for this PC's own chats.
pub fn set_source(ctx: &egui::Context, source: Option<Source>) {
    lock(&shared(ctx)).source = source;
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
    std::fs::metadata(crate::media::located(Path::new(key))).and_then(|m| m.modified()).ok()
}

/// Queues a decode; workers start on demand and stop when the queue is empty.
fn request(ctx: &egui::Context, s: &Shared, c: &mut Cache, job: Job) {
    let real = job.key.strip_prefix(MID).unwrap_or(&job.key);
    if let Some(src) = c.source.as_ref().map(|s| s.image.clone()) {
        if !c.bytes.contains_key(real) && !c.remote.contains_key(real) {
            c.remote.insert(real.to_string(), src);
        }
    }
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
        let (real, cap) = match job.key.strip_prefix(MID) {
            Some(k) => (k, MID_PX),
            None => (job.key.as_str(), if job.full { FULL_PX } else { THUMB_PX }),
        };
        let bytes = bytes.or_else(|| lock(&s).bytes.get(real).cloned());
        let (bytes, away) = match bytes {
            Some(b) => (Some(b), Ok(())),
            None => match fetched(&s, real) {
                Some(Ok(b)) => (Some(b), Ok(())),
                Some(Err(e)) => (None, Err(e)),
                None => (None, Ok(())),
            },
        };
        let st = if bytes.is_none() { stamp(real) } else { None };
        let slot = match away.and_then(|_| decode(real, bytes, cap)) {
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

/// The bytes of an image of another PC's chat, fetched from that PC and kept, so the
/// thumbnail, the inline size and the lightbox fetch it once. None for a file of this PC (or
/// one that PC didn't give but that's here).
fn fetched(s: &Shared, key: &str) -> Option<Result<Arc<[u8]>, String>> {
    let fetch = lock(s).remote.get(key).cloned()?;
    let Some(bytes) = fetch(key) else {
        if crate::media::located(Path::new(key)).exists() {
            lock(s).remote.remove(key);
            return None;
        }
        return Some(Err("the PC this chat runs on is off or doesn't have it".into()));
    };
    let bytes: Arc<[u8]> = bytes.into();
    lock(s).bytes.insert(key.to_string(), bytes.clone());
    Some(Ok(bytes))
}

/// Decodes (first frame of a GIF, EXIF-rotated) and shrinks to `cap` pixels.
/// Returns the image and the original dimensions. A video gives its poster (ffmpeg), an SVG
/// its drawing (rsvg-convert).
fn decode(key: &str, bytes: Option<Arc<[u8]>>, cap: u32) -> Result<(ColorImage, [usize; 2]), String> {
    use image::ImageDecoder;
    let bytes = match bytes {
        None if crate::media::is_video(key) => {
            crate::media::check(Path::new(key))?;
            let poster = crate::media::poster(Path::new(key)).ok_or("no preview (ffmpeg isn't installed)")?;
            Some(std::fs::read(poster).map_err(|e| e.to_string())?.into())
        }
        None if crate::media::is_svg(key) => {
            crate::media::check(Path::new(key))?;
            Some(crate::media::svg_png(Path::new(key), cap.min(2048)).ok_or("can't draw this SVG (rsvg-convert isn't installed)")?.into())
        }
        b => b,
    };
    let mut reader = match &bytes {
        Some(b) => image::ImageReader::new(std::io::Cursor::new(b.to_vec())).with_guessed_format(),
        None => {
            let file = crate::media::located(Path::new(key));
            let len = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
            if len > MAX_BYTES {
                return Err(format!("too large ({} MB)", len >> 20));
            }
            std::fs::read(&file).map(|b| image::ImageReader::new(std::io::Cursor::new(b))).map_err(|e| e.to_string())?.with_guessed_format()
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
    let resp = resp.on_hover_cursor(CursorIcon::PointingHand).tip(tip);
    if resp.clicked() {
        open_clicked(ui.ctx(), key, group);
    }
    resp
}

/// A click on `key`: the lightbox on `group` (or `key` alone), noted for [`take_opened`].
fn open_clicked(ctx: &egui::Context, key: &str, group: &[String]) {
    match group.iter().position(|k| k == key) {
        Some(i) => open_gallery(ctx, group.to_vec(), i),
        None => open(ctx, key),
    }
    let s = shared(ctx);
    let mut c = lock(&s);
    c.opened = Some(c.card);
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
    x.on_hover_cursor(CursorIcon::PointingHand).tip("Remove").clicked()
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
    c.keys = [false; 3];
    // The full-size texture is large; keep it only while it's shown.
    c.full = None;
}

/// While the lightbox is open, takes ← → and Esc for it. Call at the start of the frame: the
/// lightbox draws last, and by then a focused composer would have had → (it takes a suggestion).
pub fn take_keys(ctx: &egui::Context) {
    if !is_open(ctx) {
        return;
    }
    let none = egui::Modifiers::NONE;
    let keys = ctx.input_mut(|i| [i.consume_key(none, Key::ArrowLeft), i.consume_key(none, Key::ArrowRight), i.consume_key(none, Key::Escape)]);
    let s = shared(ctx);
    let mut c = lock(&s);
    for (held, now) in c.keys.iter_mut().zip(keys) {
        *held |= now;
    }
}

/// Images drawn until the next call belong to transcript card `seq`.
pub fn in_card(ctx: &egui::Context, seq: usize) {
    lock(&shared(ctx)).card = seq;
}

/// The card ([`in_card`]) of the thumbnail or inline image a click opened since the last call.
pub fn take_opened(ctx: &egui::Context) -> Option<usize> {
    lock(&shared(ctx)).opened.take()
}

/// Browses `keys` (all the images of the clicked card, in order) from the open image, when
/// it's one of them. Call while that chat's [`set_source`] holds: images not drawn yet come from there too.
pub fn widen(ctx: &egui::Context, keys: Vec<String>) {
    let s = shared(ctx);
    let mut c = lock(&s);
    if !c.open.as_ref().is_some_and(|k| keys.contains(k)) {
        return;
    }
    if let Some(src) = c.source.as_ref().map(|s| s.image.clone()) {
        for k in &keys {
            if !c.bytes.contains_key(k) && !c.remote.contains_key(k) {
                c.remote.insert(k.clone(), src.clone());
            }
        }
    }
    c.gallery = keys;
}

/// Where ← (`dir` -1) or → (1) goes from `at` of `n`: nowhere past either end.
fn step(at: usize, n: usize, dir: isize) -> Option<usize> {
    at.checked_add_signed(dir).filter(|i| *i < n)
}

/// Draws the lightbox when one is open, and drops thumbnails not drawn lately.
/// Call once per frame, after the rest of the UI. Esc, the X or a click outside closes it.
pub fn lightbox(ctx: &egui::Context) {
    // Not taken earlier this frame (take_keys): taken now.
    take_keys(ctx);
    let s = shared(ctx);
    let (key, full, small, gallery, [prev, next, esc]) = {
        let mut c = lock(&s);
        if c.thumbs.len() > KEEP {
            let now = ctx.input(|i| i.time);
            c.thumbs.retain(|_, (slot, used)| matches!(slot, Slot::Loading) || now - *used < 30.0);
        }
        let Some(key) = c.open.clone() else { return };
        let full = c.full.as_ref().filter(|(k, _)| *k == key).map(|(_, s)| s.clone());
        let small = c.thumbs.get(&key).map(|(s, _)| s.clone());
        (key, full, small, c.gallery.clone(), std::mem::take(&mut c.keys))
    };
    let mut shut = esc;
    let at = gallery.iter().position(|k| *k == key).unwrap_or(0);
    let n = gallery.len();
    let mut go: Option<usize> = None;
    if prev {
        go = step(at, n, -1);
    }
    if next {
        go = step(at, n, 1).or(go);
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
        let mut caption = name(&key);
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
        if w::btn(ic::X).secondary().icon_xs().show(&mut child).tip("Close (Esc)").clicked() {
            shut = true;
        }
        if Path::new(&key).is_absolute() && w::btn(&format!("{}  Copy path", ic::COPY)).secondary().xs().show(&mut child).clicked() {
            ctx.copy_text(key.clone());
        }
        // Copy image (also Ctrl+C): the encoded bytes go to the system clipboard as PNG.
        let copy = w::btn(&format!("{}  Copy image", ic::IMAGE)).secondary().xs().show(&mut child).clicked()
            || ctx.input(|i| i.events.iter().any(|e| matches!(e, egui::Event::Copy)));
        if copy {
            let bytes = lock(&s).bytes.get(&key).map(|b| b.to_vec()).or_else(|| std::fs::read(&key).ok());
            if let Some(b) = bytes {
                crate::clipboard::copy_image_noticed(b);
            }
        }
        if n > 1 {
            // Top left, across from the buttons: where this image is in the gallery, "3 / 7".
            let t = w::tokens(ui);
            let g = ui.painter().layout_no_wrap(format!("{} / {n}", at + 1), FontId::proportional(13.0), t.fg());
            let pill = Rect::from_center_size(pos2(screen.left() + 12.0 + (g.size().x + 20.0) / 2.0, bar.center().y), vec2(g.size().x + 20.0, 28.0));
            ui.painter().rect_filled(pill, CornerRadius::same(RADIUS_MD), t.gray(100));
            ui.painter().rect_stroke(pill, CornerRadius::same(RADIUS_MD), Stroke::new(1.0, t.border()), StrokeKind::Inside);
            ui.painter().galley(pill.center() - g.size() / 2.0, g, t.fg());
            // A side's button only while there's an image that way.
            for (dx, glyph, dir, tip) in [(32.0, ic::LEFT, -1, "Previous (←)"), (-32.0, ic::RIGHT, 1, "Next (→)")] {
                let Some(to) = step(at, n, dir) else { continue };
                let x = if dx > 0.0 { screen.left() + dx } else { screen.right() + dx };
                let r = Rect::from_center_size(pos2(x, room.center().y), Vec2::splat(32.0));
                let mut child = ui.new_child(egui::UiBuilder::new().max_rect(r));
                if w::btn(glyph).secondary().icon_sm().show(&mut child).tip(tip).clicked() {
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

// ---------------------------------------------------------------- media in replies

/// The media a text shows or names (media.rs `find`, relative paths against `cwd`). Cached
/// per text, so calling it every frame is cheap; a finished download looks again.
pub fn media_in(ctx: &egui::Context, text: &str, cwd: &str) -> Vec<Media> {
    let g = crate::media::GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    ctx.memory_mut(|m| m.caches.cache::<egui::cache::FrameCache<Vec<Media>, Finder>>().get((text, cwd, g)).clone())
}

#[derive(Default)]
struct Finder;

impl<'a> egui::cache::ComputerMut<(&'a str, &'a str, u64), Vec<Media>> for Finder {
    fn compute(&mut self, (text, cwd, _): (&'a str, &'a str, u64)) -> Vec<Media> {
        crate::media::find(text, (!cwd.is_empty()).then(|| Path::new(cwd)))
    }
}

/// Room for a shown image or video in a reply of `width`.
pub fn inline_size(width: f32) -> Vec2 {
    vec2(width.min(480.0), 300.0)
}

/// A "can't load" card in `rect` with Retry; true when Retry was clicked.
fn cant_load(ui: &mut Ui, rect: Rect, id: Id, why: &str) -> bool {
    let t = w::tokens(ui);
    let radius = CornerRadius::same(RADIUS_MD);
    ui.painter().rect_filled(rect, radius, t.gray(100));
    ui.painter().rect_stroke(rect, radius, Stroke::new(1.0, t.border()), StrokeKind::Inside);
    let mut child = ui.new_child(egui::UiBuilder::new().id_salt(id).max_rect(Rect::from_min_max(rect.min + vec2(12.0, 0.0), rect.max - vec2(8.0, 0.0))).layout(egui::Layout::right_to_left(egui::Align::Center)));
    child.spacing_mut().item_spacing.x = 8.0;
    let retry = w::btn(&format!("{}  Retry", ic::REFRESH)).secondary().xs().show(&mut child).clicked();
    child.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
        ui.label(egui::RichText::new(ic::ALERT).size(14.0).color(t.subtle()));
        let why = if why.contains("os error 2") { "file not found" } else { why };
        ui.add(egui::Label::new(egui::RichText::new(format!("Can't load: {why}")).text_style(crate::theme::ts("label-13")).color(t.subtle())).truncate()).on_hover_text(why.to_string());
    });
    retry
}

/// An image shown in a reply: its own aspect within `max`, a click opens `group` in the
/// lightbox. A missing or broken file draws as "can't load" with Retry.
pub fn inline(ui: &mut Ui, key: &str, max: Vec2, group: &[String]) -> Response {
    let mid = format!("{MID}{key}");
    let slot = thumb(ui.ctx(), &mid);
    let size = match &slot {
        Slot::Ready { tex, .. } => {
            let s = tex.size_vec2() / ui.ctx().pixels_per_point();
            s * (max.x / s.x).min(max.y / s.y).min(1.0)
        }
        Slot::Failed(_) => vec2(max.x.min(360.0), 44.0),
        Slot::Loading => vec2(max.x, max.x * 0.5625).min(max),
    };
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    if !ui.is_rect_visible(rect) {
        return resp;
    }
    let t = w::tokens(ui);
    let radius = CornerRadius::same(RADIUS_MD);
    match slot {
        Slot::Ready { tex, dims, .. } => {
            egui::Image::from_texture(SizedTexture::from_handle(&tex)).corner_radius(radius).paint_at(ui, rect);
            if resp.hovered() {
                ui.painter().rect_filled(rect, radius, Color32::from_white_alpha(10));
            }
            ui.painter().rect_stroke(rect, radius, Stroke::new(1.0, if resp.hovered() { t.gray(600) } else { t.border() }), StrokeKind::Inside);
            let resp = resp.on_hover_cursor(CursorIcon::PointingHand).tip(format!("{}\n{} × {}", name(key), dims[0], dims[1]));
            if resp.clicked() {
                open_clicked(ui.ctx(), key, group);
            }
            resp
        }
        Slot::Loading => {
            ui.painter().rect_filled(rect, radius, t.gray(100));
            w::spinner(ui.painter(), rect.center(), 8.0, t.subtle());
            resp
        }
        Slot::Failed(e) => {
            if cant_load(ui, rect, Id::NULL.with(("media-retry", key)), &e) {
                forget(ui.ctx(), &mid);
                forget(ui.ctx(), key);
            }
            resp
        }
    }
}

/// media.rs `check` of a file, looked at again every few seconds (not on every frame).
fn checked(ctx: &egui::Context, key: &str) -> Result<bool, String> {
    let id = Id::NULL.with(("media-check", key));
    let now = ctx.input(|i| i.time);
    if let Some((at, r)) = ctx.data(|d| d.get_temp::<(f64, Result<bool, String>)>(id)) {
        if now - at < 5.0 {
            return r;
        }
    }
    let r = crate::media::check(Path::new(key));
    ctx.data_mut(|d| d.insert_temp(id, (now, r.clone())));
    r
}

/// A placeholder while a shown image or video downloads.
pub fn downloading(ui: &mut Ui, max: Vec2) {
    let t = w::tokens(ui);
    let (rect, _) = ui.allocate_exact_size(vec2(max.x.min(360.0), max.x.min(360.0) * 0.5625), Sense::hover());
    ui.painter().rect_filled(rect, CornerRadius::same(RADIUS_MD), t.gray(100));
    w::spinner(ui.painter(), rect.center(), 8.0, t.subtle());
    ui.ctx().request_repaint_after(std::time::Duration::from_millis(400));
}

/// "Can't load" for a download that failed; true when Retry was clicked.
pub fn failed(ui: &mut Ui, key: &str, max: Vec2, why: &str) -> bool {
    let (rect, _) = ui.allocate_exact_size(vec2(max.x.min(360.0), 44.0), Sense::hover());
    let retry = cant_load(ui, rect, Id::NULL.with(("media-retry", key)), why);
    if retry {
        forget(ui.ctx(), &format!("{MID}{key}"));
    }
    retry
}

/// A video shown in a reply: its poster (or a dark card without ffmpeg) with a play button;
/// a click plays it in the system's player.
pub fn video(ui: &mut Ui, key: &str, max: Vec2) -> Response {
    let mid = format!("{MID}{key}");
    // Another PC's chat: its PC checks the file (its poster comes from there, or says why not).
    let away = lock(&shared(ui.ctx())).source.as_ref().map(|s| s.video.clone()).filter(|_| !crate::media::located(Path::new(key)).exists());
    // A file that isn't there (or isn't a video) can't play: say so, like a broken image.
    if let Err(e) = if away.is_some() { Ok(true) } else { checked(ui.ctx(), key) } {
        let (rect, resp) = ui.allocate_exact_size(vec2(max.x.min(360.0), 44.0), Sense::hover());
        if cant_load(ui, rect, Id::NULL.with(("media-retry", key)), &e) {
            forget(ui.ctx(), &mid);
            ui.ctx().data_mut(|d| d.insert_temp(Id::NULL.with(("media-check", key)), (f64::NEG_INFINITY, Ok::<bool, String>(false))));
        }
        return resp;
    }
    let slot = thumb(ui.ctx(), &mid);
    let size = match &slot {
        Slot::Ready { tex, .. } => {
            let s = tex.size_vec2() / ui.ctx().pixels_per_point();
            s * (max.x / s.x).min(max.y / s.y).min(1.0)
        }
        _ => vec2(max.x.min(360.0), max.x.min(360.0) * 0.5625),
    };
    let (rect, resp) = ui.allocate_exact_size(size.max(vec2(160.0, 90.0)), Sense::click());
    if ui.is_rect_visible(rect) {
        let t = w::tokens(ui);
        let radius = CornerRadius::same(RADIUS_MD);
        let p = ui.painter();
        p.rect_filled(rect, radius, Color32::from_gray(24));
        match &slot {
            Slot::Ready { tex, .. } => {
                egui::Image::from_texture(SizedTexture::from_handle(tex)).uv(cover(tex.size_vec2(), rect.size())).corner_radius(radius).paint_at(ui, rect);
            }
            Slot::Loading => w::spinner(ui.painter(), rect.center() + vec2(0.0, 34.0), 7.0, Color32::from_gray(200)),
            Slot::Failed(_) => {}
        }
        let p = ui.painter();
        let c = rect.center();
        p.circle_filled(c, 24.0, Color32::from_black_alpha(if resp.hovered() { 210 } else { 150 }));
        ic::glyph(p, c + vec2(2.0, 0.0), ic::PLAY, 22.0, Color32::WHITE);
        let label = p.layout_no_wrap(name(key), FontId::proportional(12.0), Color32::from_gray(230));
        let at = pos2(rect.left() + 10.0, rect.bottom() - 10.0 - label.size().y);
        p.rect_filled(Rect::from_min_size(at - vec2(6.0, 3.0), label.size() + vec2(12.0, 6.0)), CornerRadius::same(4), Color32::from_black_alpha(150));
        p.galley(at, label, Color32::from_gray(230));
        p.rect_stroke(rect, radius, Stroke::new(1.0, if resp.hovered() { t.gray(600) } else { t.border() }), StrokeKind::Inside);
    }
    let resp = resp.on_hover_cursor(CursorIcon::PointingHand).tip(format!("{}\nPlay in your video player", name(key)));
    if resp.clicked() {
        match away {
            // Fetched from its PC into a file here first.
            Some(fetch) => {
                let key = key.to_string();
                std::thread::spawn(move || {
                    if let Some(file) = fetch(&key).and_then(|b| crate::media::save_remote(&key, &b)) {
                        crate::git::open_url(&file.to_string_lossy());
                    }
                });
            }
            None => crate::git::open_url(&crate::media::located(Path::new(key)).to_string_lossy()),
        }
    }
    resp
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
    fn the_viewer_stops_at_either_end_and_widens_to_the_card() {
        assert_eq!((step(0, 3, -1), step(0, 3, 1), step(2, 3, 1), step(2, 3, -1)), (None, Some(1), None, Some(1)));
        assert_eq!(step(0, 1, 1), None);
        let ctx = egui::Context::default();
        let keys = |v: &[&str]| v.iter().map(|s| format!("/x/{s}.png")).collect::<Vec<_>>();
        // Its large images, then all five of its card's: the viewer stays on the one opened.
        in_card(&ctx, 7);
        open_clicked(&ctx, "/x/d.png", &keys(&["c", "d"]));
        assert_eq!((take_opened(&ctx), take_opened(&ctx)), (Some(7), None));
        widen(&ctx, keys(&["a", "b", "c", "d", "e"]));
        let s = shared(&ctx);
        let c = lock(&s);
        assert_eq!((c.open.as_deref(), c.gallery.len()), (Some("/x/d.png"), 5));
        drop(c);
        // A list without the open image (another chat's) changes nothing.
        widen(&ctx, keys(&["z"]));
        assert_eq!(lock(&shared(&ctx)).gallery.len(), 5);
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

    /// A thumbnail's state once its decode is done.
    fn settled(ctx: &egui::Context, key: &str) -> Slot {
        for _ in 0..500 {
            match thumb(ctx, key) {
                Slot::Loading => std::thread::sleep(std::time::Duration::from_millis(10)),
                s => return s,
            }
        }
        panic!("{key} never loaded");
    }

    #[test]
    fn images_of_another_pcs_chat_come_from_that_pc() {
        // The sender attached a picture on their PC; the chat's home PC keeps it under a path of
        // its own, which this PC doesn't have: drawing it fetches it from there, once.
        let ctx = egui::Context::default();
        let asked = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = asked.clone();
        let image: Fetch = Arc::new(move |p: &str| {
            log.lock().unwrap().push(p.to_string());
            (p == "/home-pc/uploads/1-photo.png").then(|| png(40, 30))
        });
        set_source(&ctx, Some(Source { image, video: Arc::new(|_: &str| None) }));
        assert!(matches!(settled(&ctx, "/home-pc/uploads/1-photo.png"), Slot::Ready { dims: [40, 30], .. }));
        assert!(matches!(settled(&ctx, &format!("{MID}/home-pc/uploads/1-photo.png")), Slot::Ready { dims: [40, 30], .. }));
        assert_eq!(*asked.lock().unwrap(), ["/home-pc/uploads/1-photo.png"]);
        // Gone there too (or the PC is off): says why instead of a bare missing file.
        match settled(&ctx, "/home-pc/uploads/2-gone.png") {
            Slot::Failed(e) => assert!(e.contains("off"), "{e}"),
            _ => panic!("drew an image the PC doesn't have"),
        }
        // A path that PC doesn't have but this one does is read here; this PC's own chats fetch
        // nothing.
        let dir = std::env::temp_dir().join(format!("harbor-img-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let local = dir.join("here.png");
        std::fs::write(&local, png(8, 8)).unwrap();
        assert!(matches!(settled(&ctx, local.to_str().unwrap()), Slot::Ready { dims: [8, 8], .. }));
        set_source(&ctx, None);
        assert!(matches!(settled(&ctx, "/home-pc/uploads/3-other.png"), Slot::Failed(_)));
        assert_eq!(asked.lock().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
