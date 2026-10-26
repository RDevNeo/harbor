//! rengaf components drawn natively: Button variants, sidebar menu rows, group
//! labels, Card, Badge, Input/Textarea with the focus ring. Each one follows the
//! class recipe of its shadcn counterpart in the registry.

use crate::theme::{self, RADIUS_LG, RADIUS_MD, Tokens};
use eframe::egui::{
    self, Align2, Color32, CornerRadius, CursorIcon, FontId, Frame, Margin, Rect, Response,
    Sense, Stroke, StrokeKind, TextEdit, Ui, Vec2, WidgetText,
};

pub fn tokens(ui: &Ui) -> Tokens {
    ui.ctx().data(|d| d.get_temp::<TokensCell>(egui::Id::NULL)).map(|c| c.0).unwrap_or_else(|| {
        // Never hit in practice: App stores tokens every frame.
        crate::theme::Theme::new(crate::theme::Mode::Dark).t
    })
}

#[derive(Clone, Copy)]
pub struct TokensCell(pub Tokens);

pub fn alpha(c: Color32, a: f32) -> Color32 {
    c.gamma_multiply(a)
}

pub fn mix(a: Color32, b: Color32, t: f32) -> Color32 {
    let l = |x: u8, y: u8| (x as f32 * (1.0 - t) + y as f32 * t).round() as u8;
    Color32::from_rgb(l(a.r(), b.r()), l(a.g(), b.g()), l(a.b(), b.b()))
}

// ---------------------------------------------------------------- Button

#[derive(Clone, Copy, PartialEq)]
pub enum Variant {
    Primary,
    Secondary,
    Outline,
    Ghost,
    GhostMuted,
    Destructive,
    GhostDestructive,
}

/// rengaf's button sizes (button-variants.ts): height, text and icon go together.
#[derive(Clone, Copy, PartialEq)]
pub enum Size {
    Default, // h-9 (36), button-14, px-4: page actions, forms, dialogs
    Sm,      // h-8 (32), button-14, px-3: toolbars, card headers, secondary actions
    Xs,      // h-7 (28), button-12, px-2.5: table rows, dense toolbars
    #[allow(dead_code)]
    Icon,    // size-9 (36)
    IconSm,  // size-8 (32)
    IconXs,  // size-7 (28)
}

impl Size {
    /// (height, text font, horizontal padding, icon glyph size)
    fn metrics(self) -> (f32, FontId, f32, f32) {
        match self {
            Size::Default => (36.0, FontId::new(14.0, theme::medium()), 16.0, 16.0),
            Size::Sm => (32.0, FontId::new(14.0, theme::medium()), 12.0, 16.0),
            Size::Xs => (28.0, FontId::new(12.0, theme::medium()), 10.0, 14.0),
            Size::Icon => (36.0, FontId::new(16.0, theme::medium()), 0.0, 16.0),
            Size::IconSm => (32.0, FontId::new(16.0, theme::medium()), 0.0, 16.0),
            Size::IconXs => (28.0, FontId::new(14.0, theme::medium()), 0.0, 14.0),
        }
    }

    fn square(self) -> bool {
        matches!(self, Size::Icon | Size::IconSm | Size::IconXs)
    }
}

pub struct Btn<'a> {
    text: &'a str,
    variant: Variant,
    size: Size,
    enabled: bool,
    pressed: bool,
    full_width: bool,
}

pub fn btn(text: &str) -> Btn<'_> {
    // rengaf: neutral actions are outline; primary is the one main action of a view.
    Btn { text, variant: Variant::Outline, size: Size::Default, enabled: true, pressed: false, full_width: false }
}

impl<'a> Btn<'a> {
    pub fn variant(mut self, v: Variant) -> Self { self.variant = v; self }
    pub fn primary(self) -> Self { self.variant(Variant::Primary) }
    pub fn outline(self) -> Self { self.variant(Variant::Outline) }
    pub fn ghost(self) -> Self { self.variant(Variant::Ghost) }
    pub fn muted(self) -> Self { self.variant(Variant::GhostMuted) }
    pub fn size(mut self, s: Size) -> Self { self.size = s; self }
    pub fn sm(self) -> Self { self.size(Size::Sm) }
    pub fn xs(self) -> Self { self.size(Size::Xs) }
    #[allow(dead_code)]
    pub fn icon(self) -> Self { self.size(Size::Icon) }
    pub fn icon_sm(self) -> Self { self.size(Size::IconSm) }
    pub fn icon_xs(self) -> Self { self.size(Size::IconXs) }
    pub fn secondary(self) -> Self { self.variant(Variant::Secondary) }
    pub fn enabled(mut self, e: bool) -> Self { self.enabled = e; self }
    /// aria-pressed: ghost buttons show the accent fill.
    pub fn pressed(mut self, p: bool) -> Self { self.pressed = p; self }

    /// Width `show` will take (for placing the button before drawing it).
    pub fn width(&self, ui: &Ui) -> f32 {
        let (h, font, pad, _) = self.size.metrics();
        if self.size.square() {
            h
        } else {
            ui.painter().layout_no_wrap(self.text.to_string(), font, Color32::PLACEHOLDER).size().x + pad * 2.0
        }
    }

    pub fn show(self, ui: &mut Ui) -> Response {
        let t = tokens(ui);
        let (h, mut font, pad, icon) = self.size.metrics();
        // An icon-only button draws its glyph at the size's icon step.
        if self.size.square() {
            font = FontId::new(icon, font.family);
        }
        let galley = ui.painter().layout_no_wrap(self.text.to_string(), font, Color32::PLACEHOLDER);
        let w = match self.size {
            _ if self.size.square() => h,
            _ if self.full_width => ui.available_width(),
            _ => galley.size().x + pad * 2.0,
        };
        let sense = if self.enabled { Sense::click() } else { Sense::hover() };
        let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, h), sense);
        if !ui.is_rect_visible(rect) {
            return resp;
        }
        let hover = self.enabled && resp.hovered();
        let down = self.enabled && resp.is_pointer_button_down_on();
        let clear = Color32::TRANSPARENT;
        let (fill, fg, stroke) = match self.variant {
            Variant::Primary => {
                let f = if hover { mix(t.primary(), t.bg100, 0.10) } else { t.primary() };
                (f, t.on_primary(), clear)
            }
            Variant::Secondary => {
                let f = if down { t.gray(300) } else if hover { t.gray(200) } else { t.gray(100) };
                (f, t.fg(), clear)
            }
            Variant::Outline => {
                // Dark: bg-input/30 over the page, border in input (rengaf's outline).
                let rest = if t.dark { mix(t.bg100, t.border(), 0.3) } else { t.bg100 };
                let f = if hover || self.pressed { if t.dark { mix(t.bg100, t.border(), 0.5) } else { t.accent() } } else { rest };
                (f, t.fg(), t.border())
            }
            Variant::Ghost => {
                let f = if hover || self.pressed { t.accent() } else { clear };
                (f, t.fg(), clear)
            }
            Variant::GhostMuted => {
                let f = if hover || self.pressed { t.accent() } else { clear };
                (f, if hover { t.fg() } else { t.subtle() }, clear)
            }
            Variant::Destructive => {
                let base = if t.dark { alpha(t.destructive(), 0.6) } else { t.destructive() };
                (if hover { alpha(base, 0.9) } else { base }, Color32::WHITE, clear)
            }
            Variant::GhostDestructive => {
                let f = if hover { alpha(t.destructive(), if t.dark { 0.2 } else { 0.1 }) } else { clear };
                (f, t.red(900), clear)
            }
        };
        let opacity = if self.enabled { 1.0 } else { 0.5 };
        let p = ui.painter();
        p.rect(
            rect,
            CornerRadius::same(RADIUS_MD),
            alpha(fill, opacity),
            Stroke::new(1.0, alpha(stroke, opacity)),
            StrokeKind::Inside,
        );
        let pos = rect.center() - galley.size() / 2.0;
        p.galley(pos, galley, alpha(fg, opacity));
        if resp.has_focus() {
            focus_ring(ui, rect, RADIUS_MD);
        }
        if self.enabled {
            resp.clone().on_hover_cursor(CursorIcon::PointingHand)
        } else {
            resp
        }
    }
}

pub fn focus_ring(ui: &Ui, rect: Rect, radius: u8) {
    let t = tokens(ui);
    ui.painter().rect_stroke(
        rect.expand(1.5),
        CornerRadius::same(radius + 2),
        Stroke::new(3.0, alpha(t.gray(1000), 0.5)),
        StrokeKind::Outside,
    );
}

// ---------------------------------------------------------------- Sidebar

/// `SidebarMenuButton`: h-8 p-2 rounded-md text-sm, accent fill on hover / active.
pub fn menu_row(ui: &mut Ui, active: bool, icon: &str, label: &str, right: Option<(&str, Color32)>) -> Response {
    let font = FontId::new(12.0, egui::FontFamily::Monospace);
    let g = right.map(|(txt, col)| ui.painter().layout_no_wrap(txt.into(), font, col));
    let w = g.as_ref().map_or(0.0, |g| g.size().x);
    menu_row_with(ui, active, icon, label, w, |p, rect| {
        if let Some(g) = g {
            p.galley(egui::pos2(rect.right() - 8.0 - g.size().x, rect.center().y - g.size().y / 2.0), g, Color32::PLACEHOLDER);
        }
    })
}

/// Row body of `menu_row`: `right_w` is kept free on the
/// right and `right` paints into it.
fn menu_row_with(ui: &mut Ui, active: bool, icon: &str, label: &str, right_w: f32, right: impl FnOnce(&egui::Painter, Rect)) -> Response {
    let t = tokens(ui);
    let h = theme::row_h();
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), h), Sense::click());
    if !ui.is_rect_visible(rect) {
        return resp;
    }
    let p = ui.painter();
    if active || resp.hovered() {
        p.rect_filled(rect, CornerRadius::same(RADIUS_MD), t.accent());
    }
    let mut x = rect.left() + 8.0;
    if !icon.is_empty() {
        p.text(egui::pos2(x + 8.0, rect.center().y), Align2::CENTER_CENTER, icon, FontId::proportional(14.0), if active { t.fg() } else { t.subtle() });
        x += 24.0;
    }
    right(p, rect);
    let right_w = if right_w > 0.0 { right_w + 8.0 } else { 0.0 };
    let font = FontId::new(14.0, if active { theme::medium() } else { egui::FontFamily::Proportional });
    let max_w = (rect.right() - 8.0 - right_w - x).max(10.0);
    let g = truncated(ui, label, font, t.fg(), max_w);
    p.galley(egui::pos2(x, rect.center().y - g.size().y / 2.0), g, t.fg());
    resp.on_hover_cursor(CursorIcon::PointingHand)
}

// ---------------------------------------------------------------- Chat status

/// What a chat is doing, as shown next to it in the sidebar (T3 style).
pub enum Status {
    /// A turn is running; seconds since it started.
    Working(u64),
    /// Finished while you were elsewhere and not opened yet: the unread dot.
    Done,
    Failed,
    /// Idle: plain text such as the last activity ("5h"), in the given colour.
    Text(String, Color32),
}

fn status_parts(t: &Tokens, s: &Status) -> (String, Color32, Option<&'static str>) {
    match s {
        Status::Working(secs) => (format!("Working {}", short_elapsed(*secs)), t.blue(900), None),
        Status::Done => ("Done".into(), t.green(900), Some(crate::icons::CIRCLE_CHECK)),
        Status::Failed => ("Failed".into(), t.red(900), Some(crate::icons::CIRCLE_X)),
        Status::Text(s, c) => (s.clone(), *c, None),
    }
}

/// Compact, for the sidebar: "42s", "8m", "1h".
fn short_elapsed(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m", secs / 60),
        _ => format!("{}h", secs / 3600),
    }
}

/// Minutes only, for labels that shouldn't tick every second: "<1m", "9m", "1h 12m".
pub fn minutes(secs: u64) -> String {
    match secs {
        0..60 => "<1m".into(),
        60..3600 => format!("{}m", secs / 60),
        _ => format!("{}h {}m", secs / 3600, secs % 3600 / 60),
    }
}

/// How long something has run: "42s", "8m 54s", "1h 12m".
pub fn elapsed(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m {}s", secs / 60, secs % 60),
        _ => format!("{}h {}m", secs / 3600, secs % 3600 / 60),
    }
}

const STATUS_ICON: f32 = 13.0;

/// The unread dot (rengaf nav-sidebar's `size-1.5 rounded-full`, in info blue).
const UNREAD_DOT: f32 = 6.0;

pub fn status_width(ui: &Ui, s: &Status) -> f32 {
    if matches!(s, Status::Done) {
        return UNREAD_DOT + 4.0;
    }
    let t = tokens(ui);
    let (text, col, _) = status_parts(&t, s);
    let g = ui.painter().layout_no_wrap(text, FontId::proportional(12.5), col);
    let icon = if matches!(s, Status::Text(..)) { 0.0 } else { STATUS_ICON + 6.0 };
    g.size().x + icon
}

/// Paints a status right-aligned at `right` (vertically centred on it).
pub fn paint_status(p: &egui::Painter, right: egui::Pos2, s: &Status) {
    let t = p.ctx().data(|d| d.get_temp::<TokensCell>(egui::Id::NULL)).map(|c| c.0).unwrap_or_else(|| crate::theme::Theme::new(crate::theme::Mode::Dark).t);
    if matches!(s, Status::Done) {
        p.circle_filled(egui::pos2(right.x - UNREAD_DOT / 2.0 - 2.0, right.y), UNREAD_DOT / 2.0, t.blue(700));
        return;
    }
    let (text, col, icon) = status_parts(&t, s);
    let g = p.layout_no_wrap(text, FontId::proportional(12.5), col);
    let x = right.x - g.size().x;
    p.galley(egui::pos2(x, right.y - g.size().y / 2.0), g, col);
    let c = egui::pos2(x - 6.0 - STATUS_ICON / 2.0, right.y);
    match (s, icon) {
        // The spinner asks for its next step, which also keeps the seconds counting.
        (Status::Working(_), _) => spinner(p, c, STATUS_ICON / 2.0 - 0.5, col),
        (_, Some(glyph)) => crate::icons::glyph(p, c, glyph, STATUS_ICON, col),
        _ => {}
    }
}

/// How often spinners step: each step repaints the whole window, so a spinner (and the
/// seconds counter beside it) gets 2 fps.
pub const SPIN_STEP: std::time::Duration = std::time::Duration::from_millis(500);

/// Asks for a frame in `after`, for something animated or counting inside `rect`;
/// nothing when `rect` is clipped away (scrolled out, collapsed), at most one frame
/// per 2 s while the window is unfocused. Minimized or occluded windows paint no ui.
pub fn repaint_in(p: &egui::Painter, rect: Rect, after: std::time::Duration) {
    if !p.clip_rect().intersects(rect) {
        return;
    }
    let focused = p.ctx().input(|i| i.viewport().focused.unwrap_or(true));
    p.ctx().request_repaint_after(if focused { after } else { after.max(std::time::Duration::from_secs(2)) });
}

/// When a [`minutes`] label next changes.
pub fn minute_step(secs: u64) -> std::time::Duration {
    std::time::Duration::from_secs(60 - secs % 60)
}

/// A slowly turning dashed ring, stepping every [`SPIN_STEP`] while it's on screen.
pub fn spinner(p: &egui::Painter, c: egui::Pos2, r: f32, col: Color32) {
    use std::f32::consts::TAU;
    // A fixed step per tick (a third of the gap between dashes) reads as turning,
    // where a continuous angle sampled this slowly would jitter. The next frame
    // lands on the next step.
    let ticks = p.ctx().input(|i| i.time) / SPIN_STEP.as_secs_f64();
    let next = SPIN_STEP.mul_f64(1.0 - ticks.fract()) + std::time::Duration::from_millis(2);
    repaint_in(p, Rect::from_center_size(c, Vec2::splat(2.0 * r)), next);
    let turn = (ticks as u64 % 24) as f32 * TAU / 24.0;
    let dashes = 8;
    for k in 0..dashes {
        let a0 = turn + k as f32 / dashes as f32 * TAU;
        let a1 = a0 + TAU / dashes as f32 * 0.55;
        let pts: Vec<egui::Pos2> = (0..=4).map(|i| {
            let a = a0 + (a1 - a0) * i as f32 / 4.0;
            c + Vec2::new(a.cos(), a.sin()) * r
        }).collect();
        p.line(pts, Stroke::new(1.5, col));
    }
}

/// A loading spinner in the layout, like `ui.spinner()` but at [`spinner`]'s pace
/// (egui's asks for a frame every frame, at the monitor's refresh rate).
pub fn busy(ui: &mut Ui) -> egui::Response {
    let size = ui.spacing().interact_size.y;
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(size), egui::Sense::hover());
    spinner(ui.painter(), rect.center(), size / 2.0 - 2.0, tokens(ui).subtle());
    resp
}

pub fn truncated(ui: &Ui, text: &str, font: FontId, color: Color32, max_w: f32) -> std::sync::Arc<egui::Galley> {
    let mut job = egui::text::LayoutJob::simple_singleline(text.to_string(), font, color);
    job.wrap = egui::text::TextWrapping::truncate_at_width(max_w);
    ui.painter().layout_job(job)
}

// ---------------------------------------------------------------- Card / Badge

/// `Card`: bg-card, border gray-400, rounded-lg. Cards never float.
pub fn card(ui: &Ui) -> Frame {
    let t = tokens(ui);
    Frame::new()
        .fill(t.bg100)
        .stroke(Stroke::new(1.0, t.border()))
        .corner_radius(CornerRadius::same(RADIUS_LG))
        .inner_margin(Margin::same(16))
}

/// The well: panel and table bodies, code (background-200).
pub fn well(ui: &Ui) -> Frame {
    let t = tokens(ui);
    Frame::new()
        .fill(t.bg200)
        .stroke(Stroke::new(1.0, t.border()))
        .corner_radius(CornerRadius::same(RADIUS_LG))
        .inner_margin(Margin::symmetric(12, 10))
}

/// Badge tones (badge-variants.ts): the "-subtle" recipe (bg 200, border 400, text 900; gray:
/// text 1000), Muted (gray-100, no border), and the solid 800 fills.
#[derive(Clone, Copy)]
#[allow(dead_code)]
pub enum Tone {
    Gray,
    Blue,
    Green,
    Amber,
    Red,
    Muted,
    BlueSolid,
    GreenSolid,
    AmberSolid,
    RedSolid,
}

impl Tone {
    /// (fill, border, text)
    pub fn colors(self, t: &Tokens) -> (Color32, Color32, Color32) {
        let clear = Color32::TRANSPARENT;
        match self {
            Tone::Gray => (t.gray(200), t.gray(400), t.gray(1000)),
            Tone::Blue => (t.blue(200), t.blue(400), t.blue(900)),
            Tone::Green => (t.green(200), t.green(400), t.green(900)),
            Tone::Amber => (t.amber(200), t.amber(400), t.amber(900)),
            Tone::Red => (t.red(200), t.red(400), t.red(900)),
            Tone::Muted => (t.gray(100), clear, t.gray(900)),
            Tone::BlueSolid => (t.blue(800), clear, Color32::WHITE),
            Tone::GreenSolid => (t.green(800), clear, Color32::WHITE),
            Tone::AmberSolid => (t.amber(800), clear, if t.dark { t.bg100 } else { t.gray(1000) }),
            Tone::RedSolid => (t.red(800), clear, Color32::WHITE),
        }
    }
}

/// `Badge`: rounded-full, px-2 py-0.5, label-12 medium, a 1px border.
pub fn badge(ui: &mut Ui, text: &str, tone: Tone) -> Response {
    let t = tokens(ui);
    let (bg, border, fg) = tone.colors(&t);
    let g = ui.painter().layout_no_wrap(text.into(), FontId::new(12.0, theme::medium()), fg);
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(g.size().x + 18.0, 22.0), Sense::hover());
    ui.painter().rect(rect, CornerRadius::same(11), bg, Stroke::new(1.0, border), StrokeKind::Inside);
    ui.painter().galley(rect.center() - g.size() / 2.0, g, fg);
    resp
}

pub fn dot(ui: &mut Ui, color: Color32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(10.0), Sense::hover());
    ui.painter().circle_filled(rect.center(), 3.5, color);
}

// ---------------------------------------------------------------- Inputs

fn field_frame(ui: &Ui, focused: bool, margin: Margin) -> Frame {
    let t = tokens(ui);
    Frame::new()
        .fill(t.bg100)
        .stroke(Stroke::new(1.0, if focused { t.gray(1000) } else { t.border() }))
        .corner_radius(CornerRadius::same(RADIUS_MD))
        .inner_margin(margin)
}

/// `Input`: h-9 rounded-md border px-3, focus ring. `mono` is the code/ID variant.
pub fn input(ui: &mut Ui, text: &mut String, hint: &str, mono: bool, width: f32) -> Response {
    let id = ui.next_auto_id();
    let focused = ui.memory(|m| m.has_focus(id));
    let font = if mono { theme::ts("label-13-mono") } else { theme::ts("label-14") };
    let r = TextEdit::singleline(text)
        .id(id)
        .hint_text(WidgetText::from(hint).color(tokens(ui).gray(900)))
        .font(font)
        .desired_width(width)
        .frame(field_frame(ui, focused, Margin::symmetric(12, 8)))
        .show(ui)
        .response
        .response;
    if focused {
        focus_ring(ui, r.rect, RADIUS_MD);
    }
    r
}

/// The chat composer: a `Textarea` whose own frame is drawn by the caller.
/// It grows with its text up to 14 lines or 45% of the window, whichever is
/// smaller, then scrolls inside (the cursor stays in view while typing).
pub fn composer(ui: &mut Ui, id: egui::Id, text: &mut String, hint: &str, rows: usize) -> Response {
    let line = ui.text_style_height(&theme::ts("copy-14"));
    let min = line * rows as f32;
    let max = (line * 14.0).min(ui.ctx().content_rect().height() * 0.45).max(min);
    let out = egui::ScrollArea::vertical()
        .id_salt(id.with("scroll"))
        .max_height(max)
        // The caller's layout may offer little height (a horizontal row); the
        // scrolled height must come from the cap, not from what is left.
        .min_scrolled_height(max)
        .auto_shrink([false, true])
        .show(ui, |ui| {
            // `@file` and `#123` tags show highlighted (tags.rs).
            let font = egui::FontSelection::from(theme::ts("copy-14")).resolve(ui.style());
            let mut layouter = |ui: &Ui, buf: &dyn egui::TextBuffer, wrap: f32| crate::tags::layout(ui, buf.as_str(), wrap, font.clone());
            let out = TextEdit::multiline(text)
                .id(id)
                .layouter(&mut layouter)
                // A caller may tint the hint for this frame (recap.rs: the suggestion is grayer).
                .hint_text(WidgetText::from(hint).color(ui.data_mut(|d| d.remove_temp::<egui::Color32>(id.with("hint-color"))).unwrap_or(tokens(ui).gray(900))))
                .font(theme::ts("copy-14"))
                .desired_rows(rows)
                .desired_width(f32::INFINITY)
                .frame(Frame::NONE)
                .show(ui);
            // In the frame the text changes, egui scrolls to the cursor in the old
            // layout, so a long paste stays at the top: scroll to it again next frame.
            let follow = id.with("follow");
            let response = out.response.response;
            if ui.data_mut(|d| d.remove_temp::<bool>(follow)).is_some() {
                if let Some(c) = out.cursor_range {
                    let r = out.galley.pos_from_cursor(c.primary).translate(out.galley_pos.to_vec2());
                    ui.scroll_to_rect(r.expand2(Vec2::new(0.0, 4.0)), None);
                }
            }
            if response.changed() {
                ui.data_mut(|d| d.insert_temp(follow, true));
                ui.ctx().request_repaint();
            }
            response
        });
    let grown = (out.inner_rect.height() - min).max(0.0);
    ui.data_mut(|d| d.insert_temp(id.with("grown"), grown));
    out.inner
}

/// How much taller than its base rows the composer `id` drew last frame, so a
/// vertically centred screen can move up to keep it in the window.
pub fn composer_growth(ctx: &egui::Context, id: egui::Id) -> f32 {
    ctx.data(|d| d.get_temp(id.with("grown")).unwrap_or(0.0))
}


/// Text that reads as "Subtle" (gray-900) in the given preset.
pub fn subtle(ui: &mut Ui, text: impl Into<String>, preset: &str) -> Response {
    let t = tokens(ui);
    ui.label(rich(text, preset).color(t.subtle()))
}

pub fn text(ui: &mut Ui, text: impl Into<String>, preset: &str) -> Response {
    ui.label(rich(text, preset))
}

/// Text in a rengaf preset: its size and weight, line height and tracking.
pub fn rich(text: impl Into<String>, preset: &str) -> egui::RichText {
    let (line, track) = theme::preset_metrics(preset);
    let mut r = egui::RichText::new(text.into()).text_style(theme::ts(preset)).line_height(line);
    if track != 0.0 {
        r = r.extra_letter_spacing(track);
    }
    r
}

pub fn separator(ui: &mut Ui) {
    let t = tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), Sense::hover());
    ui.painter().hline(rect.x_range(), rect.center().y, Stroke::new(1.0, t.border()));
}

// ---------------------------------------------------------------- Popover / menus

/// Popover surface: bg-popover, border, rounded-lg (rengaf's rules), p-1, the menu shadow.
pub fn popover_frame(t: &Tokens) -> Frame {
    Frame::new()
        .fill(t.bg100)
        .stroke(Stroke::new(1.0, t.border()))
        .corner_radius(CornerRadius::same(RADIUS_LG))
        .inner_margin(Margin::same(4))
        .shadow(t.shadow_menu())
}

/// A menu's section label (DropdownMenuLabel): px-2 py-1.5, 12 subtle.
pub fn menu_label(ui: &mut Ui, text: &str) {
    let t = tokens(ui);
    let g = ui.painter().layout_no_wrap(text.trim().to_string(), FontId::proportional(12.0), t.subtle());
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 28.0), Sense::hover());
    ui.painter().galley(egui::pos2(rect.left() + 8.0, rect.center().y - g.size().y / 2.0), g, t.subtle());
}

/// A menu's separator: full bleed across the popover's padding, my-1.
pub fn menu_separator(ui: &mut Ui) {
    let t = tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 9.0), Sense::hover());
    ui.painter().hline((rect.left() - 4.0)..=(rect.right() + 4.0), rect.center().y, Stroke::new(1.0, t.border()));
}

/// Shows a floating popover anchored to `anchor`, above it when `above`.
/// Returns the popover rect and whether it should close (outside click or Esc).
pub fn popover<R>(
    ctx: &egui::Context,
    id: &str,
    anchor: Rect,
    width: f32,
    above: bool,
    t: &Tokens,
    add: impl FnOnce(&mut Ui) -> R,
) -> (R, bool) {
    let (pivot, pos) = if above {
        (Align2::LEFT_BOTTOM, anchor.left_top() - Vec2::new(0.0, 6.0))
    } else {
        (Align2::LEFT_TOP, anchor.left_bottom() + Vec2::new(0.0, 6.0))
    };
    let area = egui::Area::new(egui::Id::NULL.with(id))
        .order(egui::Order::Foreground)
        .pivot(pivot)
        .fixed_pos(pos)
        .constrain(true)
        .show(ctx, |ui| {
            popover_frame(t).show(ui, |ui| {
                ui.set_width(width);
                add(ui)
            })
            .inner
        });
    let rect = area.response.rect;
    let close = ctx.input(|i| {
        i.key_pressed(egui::Key::Escape)
            || (i.pointer.any_pressed()
                && i.pointer.interact_pos().is_some_and(|p| !rect.contains(p) && !anchor.contains(p)))
    });
    (area.inner, close)
}

/// A row in a menu: optional icon, label, optional description, check mark.
pub fn menu_item(ui: &mut Ui, icon: &str, label: &str, desc: Option<&str>, checked: bool) -> Response {
    let t = tokens(ui);
    // rengaf DropdownMenuItem: rounded-sm, px-2 py-1.5, text 14 regular, gap 8, icon 16 muted,
    // focus/hover bg-accent (gray-200).
    let h = if desc.is_some() { 44.0 } else { 32.0 } - if theme::compact() { 4.0 } else { 0.0 };
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), h), Sense::click());
    let top = rect.top() - if theme::compact() { 2.0 } else { 0.0 };
    let p = ui.painter();
    if resp.hovered() && ui.is_enabled() {
        p.rect_filled(rect, CornerRadius::same(4), t.accent());
    }
    let mut x = rect.left() + 8.0;
    if !icon.is_empty() {
        crate::icons::glyph(p, egui::pos2(x + 8.0, top + 16.0), icon, 16.0, t.subtle());
        x += 24.0;
    }
    p.text(egui::pos2(x, top + 7.0), Align2::LEFT_TOP, label, FontId::proportional(14.0), t.fg());
    if let Some(d) = desc {
        p.text(egui::pos2(x, top + 25.0), Align2::LEFT_TOP, d, FontId::proportional(12.0), t.subtle());
    }
    if checked {
        crate::icons::glyph(p, egui::pos2(rect.right() - 16.0, top + 16.0), crate::icons::CHECK, 16.0, t.fg());
    }
    resp.on_hover_cursor(CursorIcon::PointingHand)
}

/// Lead content of a composer trigger.
pub enum Lead<'a> {
    Icon(&'a str),
    Provider(crate::providers::Kind, &'a str),
    /// Painted by the caller in the icon's rect, with the trigger's text colour.
    Paint(&'a dyn Fn(&egui::Painter, Rect, Color32)),
}

/// Composer control (model / effort / access): ghost-muted with icon, label, chevron.
pub fn trigger(ui: &mut Ui, lead: Lead, label: &str, open: bool) -> Response {
    let t = tokens(ui);
    let font = FontId::new(14.0, egui::FontFamily::Proportional);
    let g = ui.painter().layout_no_wrap(label.to_string(), font, Color32::PLACEHOLDER);
    let w = 8.0 + 18.0 + 6.0 + g.size().x + 4.0 + 14.0 + 6.0;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, 30.0), Sense::click());
    let hover = resp.hovered() || open;
    let p = ui.painter();
    if hover {
        p.rect_filled(rect, CornerRadius::same(RADIUS_MD), t.accent());
    }
    let fg = if hover { t.fg() } else { t.subtle() };
    let icon_rect = Rect::from_center_size(egui::pos2(rect.left() + 8.0 + 9.0, rect.center().y), Vec2::splat(16.0));
    match lead {
        Lead::Icon(i) => crate::icons::glyph(p, icon_rect.center(), i, 15.0, fg),
        Lead::Provider(k, badge) => crate::icons::account_mark(p, icon_rect.expand(2.0), k, badge, &t),
        Lead::Paint(f) => f(p, icon_rect, fg),
    }
    let tx = icon_rect.right() + 6.0;
    p.galley(egui::pos2(tx, rect.center().y - g.size().y / 2.0), g.clone(), fg);
    crate::icons::glyph(p, egui::pos2(tx + g.size().x + 11.0, rect.center().y + 1.0), crate::icons::DOWN, 13.0, fg);
    resp.on_hover_cursor(CursorIcon::PointingHand)
}

pub fn vsep(ui: &mut Ui, h: f32) {
    let t = tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(9.0, h), Sense::hover());
    ui.painter().vline(rect.center().x, rect.y_range(), Stroke::new(1.0, t.gray(500)));
}

/// Round primary action (send / stop) as in the composer.
pub fn round_button(ui: &mut Ui, icon: &str, enabled: bool) -> Response {
    let t = tokens(ui);
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(34.0), if enabled { Sense::click() } else { Sense::hover() });
    let a = if enabled { 1.0 } else { 0.4 };
    let fill = if enabled && resp.hovered() { mix(t.primary(), t.bg100, 0.12) } else { t.primary() };
    ui.painter().circle_filled(rect.center(), 17.0, alpha(fill, a));
    crate::icons::glyph(ui.painter(), rect.center(), icon, 16.0, alpha(t.on_primary(), a.max(0.8)));
    if enabled { resp.on_hover_cursor(CursorIcon::PointingHand) } else { resp }
}

/// Keyboard shortcut chip ("Ctrl+1"), outlined when `strong`.
pub fn kbd(ui: &Ui, pos: egui::Pos2, text: &str, strong: bool) {
    let t = tokens(ui);
    let g = ui.painter().layout_no_wrap(text.into(), FontId::new(12.0, egui::FontFamily::Monospace), t.subtle());
    let r = Rect::from_min_size(pos - Vec2::new(g.size().x + 12.0, g.size().y / 2.0 + 3.0), g.size() + Vec2::new(12.0, 6.0));
    if strong {
        key_cap(ui.painter(), r, &t);
    }
    ui.painter().galley(r.min + Vec2::new(6.0, 3.0), g, t.subtle());
}

/// Attachment chip with a remove button; returns true when removed.
pub fn file_chip(ui: &mut Ui, name: &str, image: bool) -> bool {
    let t = tokens(ui);
    let g = ui.painter().layout_no_wrap(name.into(), FontId::proportional(12.5), t.fg());
    let (rect, _) = ui.allocate_exact_size(Vec2::new(g.size().x + 52.0, 26.0), Sense::hover());
    let p = ui.painter();
    p.rect(rect, CornerRadius::same(RADIUS_MD), t.gray(100), Stroke::new(1.0, t.border()), StrokeKind::Inside);
    crate::icons::glyph(p, egui::pos2(rect.left() + 13.0, rect.center().y), if image { crate::icons::IMAGE } else { crate::icons::CLIP }, 13.0, t.subtle());
    p.galley(egui::pos2(rect.left() + 24.0, rect.center().y - g.size().y / 2.0), g, t.fg());
    let xr = Rect::from_center_size(egui::pos2(rect.right() - 13.0, rect.center().y), Vec2::splat(18.0));
    let x = ui.interact(xr, ui.scope_id().with(("chip", name)), Sense::click());
    if x.hovered() {
        ui.painter().rect_filled(xr, CornerRadius::same(4), t.gray(300));
    }
    crate::icons::glyph(ui.painter(), xr.center(), crate::icons::X, 12.0, t.subtle());
    x.clicked()
}

/// Thin progress bar (usage windows).
pub fn meter(ui: &mut Ui, frac: f32, width: f32) {
    let t = tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, 6.0), Sense::hover());
    ui.painter().rect_filled(rect, CornerRadius::same(3), t.gray(200));
    let f = frac.clamp(0.0, 1.0);
    let col = if f > 0.85 { t.red(800) } else if f > 0.6 { t.amber(800) } else { t.gray(1000) };
    let mut r = rect;
    r.set_width(rect.width() * f);
    if f > 0.0 {
        ui.painter().rect_filled(r, CornerRadius::same(3), col);
    }
}

/// Frameless search field with the search icon inside its left padding, so icon and
/// text share one vertical centre.
pub fn search_field(ui: &mut Ui, text: &mut String, hint: &str, id: Option<egui::Id>, width: f32) -> Response {
    let t = tokens(ui);
    let mut te = TextEdit::singleline(text)
        .hint_text(WidgetText::from(hint).color(t.subtle()))
        .font(theme::ts("label-14"))
        // In egui 0.37 a TextEdit's padding is its frame's inner margin.
        .frame(Frame::NONE.inner_margin(Margin { left: 26, right: 4, top: 7, bottom: 7 }))
        .desired_width(width);
    if let Some(id) = id {
        te = te.id(id);
    }
    let r = te.show(ui).response.response;
    crate::icons::glyph(ui.painter(), egui::pos2(r.rect.left() + 11.0, r.rect.center().y), crate::icons::SEARCH, 16.0, t.subtle());
    r
}

/// Draws `add` inside `rect` without taking layout space, unlike `ui.put`, which
/// advances the cursor (hover-only buttons would push the rows below and flicker).
pub fn overlay<R>(ui: &mut Ui, rect: Rect, add: impl FnOnce(&mut Ui) -> R) -> R {
    let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rect).layout(egui::Layout::centered_and_justified(egui::Direction::TopDown)));
    add(&mut child)
}

// ---------------------------------------------------------------- Tabs

/// rengaf's Tabs as a segmented control: a muted list (gray-100, rounded-lg, 3px padding,
/// h-9) of triggers (rounded-md, 14 medium); the active one is raised (light: background;
/// dark: input/30 with a border). Returns the index clicked.
pub fn tabs(ui: &mut Ui, labels: &[&str], selected: usize) -> Option<usize> {
    let t = tokens(ui);
    let font = FontId::new(14.0, theme::medium());
    let gs: Vec<_> = labels.iter().map(|l| ui.painter().layout_no_wrap(l.to_string(), font.clone(), t.fg())).collect();
    let widths: Vec<f32> = gs.iter().map(|g| g.size().x + 20.0).collect();
    let total: f32 = widths.iter().sum::<f32>() + 6.0;
    let (rect, _) = ui.allocate_exact_size(Vec2::new(total, 36.0), Sense::hover());
    ui.painter().rect_filled(rect, CornerRadius::same(RADIUS_LG), t.gray(100));
    let mut x = rect.left() + 3.0;
    let mut out = None;
    for (i, (g, w)) in gs.into_iter().zip(widths).enumerate() {
        let r = Rect::from_min_size(egui::pos2(x, rect.top() + 3.0), Vec2::new(w, rect.height() - 6.0));
        let resp = ui.interact(r, ui.scope_id().with(("tabs", i, labels[i])), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
        let active = i == selected;
        if active {
            let (fill, stroke) = if t.dark { (mix(t.bg100, t.border(), 0.3), Stroke::new(1.0, t.border())) } else { (t.bg100, Stroke::NONE) };
            ui.painter().rect(r, CornerRadius::same(RADIUS_MD), fill, stroke, StrokeKind::Inside);
        }
        let fg = if active || resp.hovered() { t.fg() } else { t.subtle() };
        ui.painter().galley(r.center() - g.size() / 2.0, g, fg);
        if resp.clicked() && !active {
            out = Some(i);
        }
        x += w;
    }
    out
}

// ---------------------------------------------------------------- Empty state

/// rengaf's Empty: a 40px muted tile with the icon, a heading-16 title, a copy-14 subtle line,
/// and an optional primary action (true when clicked). Centred in the width it has.
pub fn empty(ui: &mut Ui, icon: &str, title: &str, desc: &str, action: Option<&str>) -> bool {
    let t = tokens(ui);
    let mut clicked = false;
    ui.vertical_centered(|ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        let (tile, _) = ui.allocate_exact_size(Vec2::splat(40.0), Sense::hover());
        ui.painter().rect_filled(tile, CornerRadius::same(RADIUS_LG), t.gray(100));
        crate::icons::glyph(ui.painter(), tile.center(), icon, 24.0, t.fg());
        ui.add_space(16.0);
        ui.label(rich(title, "heading-16"));
        if !desc.is_empty() {
            ui.add_space(4.0);
            let w = ui.available_width().min(360.0);
            ui.allocate_ui(Vec2::new(w, 0.0), |ui| {
                ui.vertical_centered(|ui| ui.add(egui::Label::new(rich(desc, "copy-14").color(t.subtle())).wrap()));
            });
        }
        if let Some(a) = action {
            ui.add_space(16.0);
            clicked = btn(a).primary().show(ui).clicked();
        }
    });
    clicked
}

// ---------------------------------------------------------------- Tooltip

/// rengaf's Tooltip (inverted: bg-foreground text-background, rounded-md, px-3 py-1.5,
/// text-xs) in place of egui's default, which looks like a popover.
pub trait Tip {
    fn tip(self, text: impl Into<String>) -> Self;
}

impl Tip for Response {
    fn tip(self, text: impl Into<String>) -> Self {
        let text = text.into();
        if text.is_empty() {
            return self;
        }
        self.on_hover_ui(move |ui| tip_body(ui, &text))
    }
}

/// The tooltip's text, painted over egui's own popup frame (whose margin is `menu_margin`, 4).
pub fn tip_body(ui: &mut Ui, text: &str) {
    let t = tokens(ui);
    let (fill, fg) = (t.gray(1000), t.bg100);
    let galley = ui.painter().layout(text.to_string(), FontId::proportional(12.0), fg, 280.0);
    let (rect, _) = ui.allocate_exact_size(galley.size() + Vec2::new(16.0, 4.0), Sense::hover());
    let frame = rect.expand(5.0);
    ui.painter().with_clip_rect(frame.expand(1.0)).rect_filled(frame, CornerRadius::same(RADIUS_MD), fill);
    ui.painter().galley(rect.min + Vec2::new(8.0, 2.0), galley, fg);
}

// ---------------------------------------------------------------- Settings

/// `Switch`: a pill, gray-1000 when on, whose knob slides across.
pub fn toggle(ui: &mut Ui, on: &mut bool) -> Response {
    let t = tokens(ui);
    let (rect, mut resp) = ui.allocate_exact_size(Vec2::new(32.0, 20.0), Sense::click());
    if resp.clicked() {
        *on = !*on;
        resp.mark_changed();
    }
    resp.widget_info(|| egui::WidgetInfo::selected(egui::Role::Switch, ui.is_enabled(), *on, ""));
    // rengaf Switch: h-[1.15rem] w-8; on bg-primary (gray-1000), off bg-input (gray-400); a
    // size-4 thumb in background, which in dark is the foreground while off.
    let rect = Rect::from_center_size(rect.center(), Vec2::new(32.0, 18.0));
    let k = ui.ctx().animate_bool_with_time(resp.id, *on, 0.12);
    let a = if ui.is_enabled() { 1.0 } else { 0.5 };
    let off = if resp.hovered() { t.gray(500) } else { t.gray(400) };
    let p = ui.painter();
    p.rect_filled(rect, CornerRadius::same(9), alpha(mix(off, t.primary(), k), a));
    let x = egui::lerp((rect.left() + 9.0)..=(rect.right() - 9.0), k);
    let thumb_off = if t.dark { t.fg() } else { t.bg100 };
    p.circle_filled(egui::pos2(x, rect.center().y), 8.0, alpha(mix(thumb_off, t.on_primary(), k), a));
    if resp.has_focus() {
        focus_ring(ui, rect, 9);
    }
    if ui.is_enabled() { resp.on_hover_cursor(CursorIcon::PointingHand) } else { resp }
}

/// One row of a settings card: the title and a muted, wrapping description on the
/// left (about 60% of the row), `control` right-aligned and centred beside them.
/// Rows in one card are split by `separator`.
pub fn setting_row<R>(ui: &mut Ui, title: &str, desc: &str, control: impl FnOnce(&mut Ui) -> R) -> R {
    let t = tokens(ui);
    Frame::new()
        .inner_margin(Margin::symmetric(16, if theme::compact() { 8 } else { 12 }))
        .show(ui, |ui| {
            let full = ui.available_width();
            let top = ui.cursor().min;
            let lw = (full * 0.6).max(full - 260.0).min(full - 60.0);
            let left = ui
                .allocate_ui_with_layout(Vec2::new(lw, 0.0), egui::Layout::top_down(egui::Align::Min), |ui| {
                    ui.set_width(lw);
                    ui.spacing_mut().item_spacing.y = 2.0;
                    ui.label(rich(title, "strong-14").color(t.fg()));
                    if !desc.is_empty() {
                        ui.add(egui::Label::new(rich(desc, "copy-13").color(t.subtle())).wrap());
                    }
                })
                .response
                .rect;
            let slot = Rect::from_min_max(egui::pos2(top.x + lw + 12.0, top.y), egui::pos2(top.x + full, left.bottom().max(top.y + 24.0)));
            // rengaf: a control beside a title sits flush with its top (items-start).
            let mut child = ui.new_child(egui::UiBuilder::new().max_rect(slot).layout(egui::Layout::right_to_left(egui::Align::Min)));
            let r = control(&mut child);
            let extra = child.min_rect().bottom() - left.bottom();
            if extra > 0.0 {
                ui.add_space(extra);
            }
            ui.set_width(full);
            r
        })
        .inner
}

/// A key cap (rengaf's kbd): rounded-sm, a border with a 2px bottom edge.
fn key_cap(p: &egui::Painter, r: Rect, t: &Tokens) {
    p.rect(r, CornerRadius::same(4), t.border(), Stroke::NONE, StrokeKind::Inside);
    p.rect(Rect::from_min_max(r.min + Vec2::splat(1.0), r.max - Vec2::new(1.0, 2.0)), CornerRadius::same(3), t.gray(100), Stroke::NONE, StrokeKind::Inside);
}

/// A shortcut as key caps ("Ctrl+Shift+F" → Ctrl, Shift, F), styled as `kbd`.
pub fn kbd_combo(ui: &mut Ui, combo: &str) -> Response {
    let t = tokens(ui);
    let font = FontId::new(12.0, egui::FontFamily::Monospace);
    let mut caps: Vec<&str> = combo.split('+').filter(|s| !s.is_empty()).collect();
    if combo.ends_with("++") || combo == "+" {
        caps.push("+");
    }
    let gs: Vec<_> = caps.iter().map(|c| ui.painter().layout_no_wrap((*c).into(), font.clone(), t.subtle())).collect();
    let h = 22.0;
    let wdt: f32 = gs.iter().map(|g| g.size().x.max(8.0) + 12.0).sum::<f32>() + 4.0 * gs.len().saturating_sub(1) as f32;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(wdt, h), Sense::click());
    let mut x = rect.left();
    for g in gs {
        let cw = g.size().x.max(8.0) + 12.0;
        let r = Rect::from_min_size(egui::pos2(x, rect.top()), Vec2::new(cw, h));
        key_cap(ui.painter(), r, &t);
        ui.painter().galley(r.center() - g.size() / 2.0 - Vec2::new(0.0, 1.0), g, t.subtle());
        x += cw + 4.0;
    }
    resp
}
