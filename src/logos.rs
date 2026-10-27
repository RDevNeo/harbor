//! App logos for integrations: simple-icons rendered to 48×48 alpha masks at
//! build time (assets/logos/*.a8), tinted with the brand colour when drawn.
//! Apps simple-icons lacks fall back to a lucide glyph.

use crate::icons as ic;
use crate::theme::Tokens;
use eframe::egui::{self, Color32, ColorImage, Painter, Rect, TextureHandle, TextureOptions, Ui, pos2};

enum Mark {
    Mask(&'static str, &'static [u8], u32),
    Glyph(&'static str, Option<u32>),
}

macro_rules! mask {
    ($n:literal, $c:expr) => {
        Mark::Mask($n, include_bytes!(concat!("../assets/logos/", $n, ".a8")), $c)
    };
}

fn mark_for(name: &str) -> Option<Mark> {
    let n = name.to_lowercase();
    let has = |k: &str| n.contains(k);
    Some(if has("github") {
        mask!("github", 0x181717)
    } else if has("azuredevops") {
        mask!("azuredevops", 0x0078D7)
    } else if has("bitbucket") {
        mask!("bitbucket", 0x0052CC)
    } else if has("vercel") {
        mask!("vercel", 0x000000)
    } else if has("linear") {
        mask!("linear", 0x5E6AD2)
    } else if has("sentry") {
        mask!("sentry", 0x362D59)
    } else if has("supabase") {
        mask!("supabase", 0x3FCF8E)
    } else if has("convex") {
        mask!("convex", 0xEE342F)
    } else if has("discord") {
        mask!("discord", 0x5865F2)
    } else if has("blender") {
        mask!("blender", 0xE87D0D)
    } else if has("roblox") {
        mask!("robloxstudio", 0x00A2FF)
    } else if has("notion") {
        mask!("notion", 0x000000)
    } else if has("figma") {
        mask!("figma", 0xF24E1E)
    } else if has("stripe") {
        mask!("stripe", 0x635BFF)
    } else if has("gmail") {
        mask!("gmail", 0xEA4335)
    } else if has("playwright") {
        Mark::Glyph(ic::DRAMA, Some(0x2EAD33))
    } else if has("context7") {
        Mark::Glyph(ic::LIBRARY, None)
    } else if has("omarchy") {
        Mark::Glyph(ic::MONITOR, None)
    } else {
        return None;
    })
}

fn rgb(c: u32) -> Color32 {
    Color32::from_rgb((c >> 16) as u8, (c >> 8) as u8, c as u8)
}

/// Brand colour, or the text colour when the brand is too dark to read on our background.
fn tint(c: u32, t: &Tokens) -> Color32 {
    let col = rgb(c);
    let luma = 0.2126 * col.r() as f32 + 0.7152 * col.g() as f32 + 0.0722 * col.b() as f32;
    if t.dark && luma < 70.0 { t.fg() } else { col }
}

fn texture(ctx: &egui::Context, name: &'static str, mask: &[u8]) -> TextureHandle {
    let id = egui::Id::NULL.with(("logo", name));
    if let Some(t) = ctx.data(|d| d.get_temp::<TextureHandle>(id)) {
        return t;
    }
    // 48×48 alpha masks are tinted when drawn; full-colour logos are RGBA already.
    let rgba: Vec<u8> = if mask.len() == 48 * 48 * 4 { mask.to_vec() } else { mask.iter().flat_map(|a| [255, 255, 255, *a]).collect() };
    let tex = ctx.load_texture(format!("logo-{name}"), ColorImage::from_rgba_unmultiplied([48, 48], &rgba), TextureOptions::LINEAR);
    ctx.data_mut(|d| d.insert_temp(id, tex.clone()));
    tex
}

/// Provider marks (LobeHub icons): monochrome ones take the text colour, Gemini and
/// Meta keep their colours. Returns false when there is no logo for the provider.
pub fn provider(p: &Painter, rect: Rect, kind: crate::providers::Kind, t: &Tokens) -> bool {
    use crate::providers::Kind;
    let (name, data, mono): (&'static str, &'static [u8], bool) = match kind {
        Kind::Claude => ("p-claude-color", include_bytes!("../assets/logos/p-claude-color.rgba"), false),
        Kind::Codex => ("p-openai", include_bytes!("../assets/logos/p-openai.a8"), true),
        Kind::Cursor => ("p-cursor", include_bytes!("../assets/logos/p-cursor.a8"), true),
        Kind::Grok => ("p-grok", include_bytes!("../assets/logos/p-grok.a8"), true),
        Kind::Gemini => ("p-gemini-color", include_bytes!("../assets/logos/p-gemini-color.rgba"), false),
        Kind::Meta => ("p-meta-color", include_bytes!("../assets/logos/p-meta-color.rgba"), false),
        Kind::OpenCode => ("p-opencode", include_bytes!("../assets/logos/p-opencode.a8"), true),
    };
    let tex = texture(p.ctx(), name, data);
    let tint = if mono { t.fg() } else { Color32::WHITE };
    p.image(tex.id(), rect, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), tint);
    true
}

/// Paints the app's logo in `rect`; returns false when Harbor has none.
pub fn paint(ui: &Ui, painter: &Painter, rect: Rect, name: &str, t: &Tokens) -> bool {
    match mark_for(name) {
        Some(Mark::Mask(n, mask, c)) => {
            let tex = texture(ui.ctx(), n, mask);
            painter.image(tex.id(), rect, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), tint(c, t));
            true
        }
        Some(Mark::Glyph(g, c)) => {
            ic::glyph(painter, rect.center(), g, rect.height(), c.map(|c| tint(c, t)).unwrap_or(t.fg()));
            true
        }
        None => false,
    }
}

/// Logo, or the name's initial, on a rounded tile.
pub fn tile(ui: &mut Ui, name: &str, size: f32, t: &Tokens) {
    let (rect, _) = ui.allocate_exact_size(egui::Vec2::splat(size), egui::Sense::hover());
    let p = ui.painter().clone();
    p.rect(rect, egui::CornerRadius::same(crate::theme::RADIUS_LG), t.gray(100), egui::Stroke::new(1.0, t.border()), egui::StrokeKind::Inside);
    if !paint(ui, &p, rect.shrink(size * 0.22), name, t) {
        let initial: String = name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
        p.text(rect.center(), egui::Align2::CENTER_CENTER, initial, egui::FontId::new(size * 0.45, crate::theme::semibold()), t.subtle());
    }
}
