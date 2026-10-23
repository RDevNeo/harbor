//! Lucide glyphs (embedded subset of lucide.ttf) and painted provider marks.

use crate::providers::Kind;
use crate::theme::Tokens;
use eframe::egui::{Align2, Color32, FontId, Painter, Pos2, Rect, Vec2, pos2};

pub const SEARCH: &str = "\u{e151}";
pub const FILTER: &str = "\u{e460}";
pub const FOLDER_PLUS: &str = "\u{e0d9}";
pub const COMPOSE: &str = "\u{e172}";
pub const SETTINGS: &str = "\u{e154}";
pub const PULL: &str = "\u{e0e5}";
pub const REFRESH: &str = "\u{e145}";
pub const CLIP: &str = "\u{e12d}";
pub const BRAIN: &str = "\u{e3c6}";
pub const LOCK_OPEN: &str = "\u{e10c}";
pub const LOCK: &str = "\u{e10b}";
pub const EYE: &str = "\u{e0ba}";
pub const EYE_OFF: &str = "\u{e0bb}";
pub const DOWN: &str = "\u{e06d}";
pub const RIGHT: &str = "\u{e06f}";
pub const UP: &str = "\u{e070}";
pub const LEFT: &str = "\u{e06e}";
pub const STAR: &str = "\u{e176}";
pub const ARROW_UP: &str = "\u{e04a}";
pub const STOP: &str = "\u{e167}";
pub const TERMINAL: &str = "\u{e181}";
pub const FOLDER: &str = "\u{e0d7}";
pub const X: &str = "\u{e1b2}";
pub const CHECK: &str = "\u{e06c}";
pub const SUN: &str = "\u{e178}";
pub const MOON: &str = "\u{e11e}";
pub const SUN_MOON: &str = "\u{e2b2}";
pub const EXTERNAL: &str = "\u{e0b9}";
pub const BRANCH: &str = "\u{e0e2}";
pub const PLUS: &str = "\u{e13d}";
pub const TRASH: &str = "\u{e18e}";
pub const ARCHIVE: &str = "\u{e041}";
pub const UNARCHIVE: &str = "\u{e2cd}";
pub const LOADER: &str = "\u{e10a}";
pub const IMAGE: &str = "\u{e0f6}";
pub const SPARKLES: &str = "\u{e412}";
pub const CIRCLE_CHECK: &str = "\u{e226}";
pub const CIRCLE_X: &str = "\u{e084}";
pub const BOT: &str = "\u{e1bb}";
pub const WEBHOOK: &str = "\u{e374}";
pub const ALARM: &str = "\u{e03a}";
pub const CLOCK: &str = "\u{e087}";
pub const USERS: &str = "\u{e1a4}";
pub const GRIP: &str = "\u{e0eb}";
pub const MESSAGE: &str = "\u{e117}";
pub const ARROW_LEFT: &str = "\u{e048}";
pub const COPY: &str = "\u{e09e}";
pub const FORK: &str = "\u{e28d}";
pub const GLOBE: &str = "\u{e0e8}";
pub const MAXIMIZE: &str = "\u{e113}";
pub const MINIMIZE: &str = "\u{e11b}";
pub const PANEL_RIGHT: &str = "\u{e431}";
pub const PANEL_BOTTOM: &str = "\u{e42c}";
pub const SMARTPHONE: &str = "\u{e163}";
pub const SQUARE_MENU: &str = "\u{e453}";
pub const PANEL_LEFT: &str = "\u{e12a}";
pub const PANEL_LEFT_CLOSE: &str = "\u{e21c}";
pub const SQUARE_DASHED: &str = "\u{e1cb}";
pub const ROTATE_CW: &str = "\u{e149}";
pub const ARROW_RIGHT: &str = "\u{e049}";
pub const HAMMER: &str = "\u{e0ec}";
pub const LINK: &str = "\u{e102}";
pub const DRAMA: &str = "\u{e521}";
pub const LIBRARY: &str = "\u{e54e}";
pub const MONITOR: &str = "\u{e11d}";
pub const ALERT: &str = "\u{e077}";
pub const PLAY: &str = "\u{e13c}";
pub const ACTIVITY: &str = "\u{e038}";
pub const UPLOAD: &str = "\u{e19e}";
pub const DOWNLOAD: &str = "\u{e0b2}";
pub const FILE: &str = "\u{e0c0}";
pub const FILE_IMAGE: &str = "\u{e31c}";
pub const SEND: &str = "\u{e152}";
pub const LAPTOP: &str = "\u{e1cd}";
pub const CORNER_LEFT_UP: &str = "\u{e0a4}";
pub const HOUSE: &str = "\u{e0f5}";
pub const MOUSE_POINTER: &str = "\u{e1c3}";
pub const KEYBOARD: &str = "\u{e284}";
pub const PALETTE: &str = "\u{e1dd}";
pub const GAUGE: &str = "\u{e1bf}";
pub const PLUG: &str = "\u{e37f}";
pub const SLIDERS: &str = "\u{e29a}";
pub const PR_OPEN: &str = "\u{e555}";
pub const PR_DRAFT: &str = "\u{e35b}";
pub const PR_CLOSED: &str = "\u{e35a}";
pub const GIT_MERGE: &str = "\u{e0e4}";
pub const PEN_LINE: &str = "\u{e130}";
pub const LAYERS: &str = "\u{e529}";
pub const USER_ROUND: &str = "\u{e468}";
pub const TAG: &str = "\u{e17f}";
pub const CIRCLE_DASHED: &str = "\u{e4b0}";
pub const CIRCLE_SLASH: &str = "\u{e402}";
pub const ARROW_DOWN_UP: &str = "\u{e046}";
pub const LIST_CHECKS: &str = "\u{e1d0}";
pub const USER_LOCK: &str = "\u{e660}";
pub const CALENDAR_DOWN: &str = "\u{e5fe}";
pub const CALENDAR_UP: &str = "\u{e5ff}";
pub const FOLDER_GIT: &str = "\u{e40a}";
pub const CIRCLE_DOT: &str = "\u{e345}";
pub const MILESTONE: &str = "\u{e298}";
pub const AT_SIGN: &str = "\u{e04e}";
pub const USER_CHECK: &str = "\u{e1a0}";

pub fn glyph(p: &Painter, center: Pos2, icon: &str, size: f32, color: Color32) {
    p.text(center, Align2::CENTER_CENTER, icon, FontId::proportional(size), color);
}

/// The mark used for a provider in menus and the model picker rail.
pub fn provider(p: &Painter, rect: Rect, kind: Kind, t: &Tokens) {
    crate::logos::provider(p, rect, kind, t);
}

/// Provider mark with the account badge (IG, FS) in its lower right corner.
pub fn account_mark(p: &Painter, rect: Rect, kind: Kind, badge: &str, t: &Tokens) {
    provider(p, rect.shrink(rect.width() * 0.12).translate(Vec2::new(-1.5, -1.5)), kind, t);
    if !badge.is_empty() {
        let font = FontId::new(8.5, crate::theme::semibold());
        let g = p.layout_no_wrap(badge.into(), font, t.fg());
        let size = g.size() + Vec2::new(5.0, 1.0);
        let br = Rect::from_min_size(pos2(rect.right() - size.x + 4.0, rect.bottom() - size.y + 3.0), size);
        p.rect_filled(br, 3.0, t.gray(300));
        p.galley(br.center() - g.size() / 2.0, g, t.fg());
    }
}
