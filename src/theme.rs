//! rengaf design tokens (the Spok design system, Geist-modelled), ported from
//! `rengaf.css`. Scales go 100–1000:
//!   100–300 component backgrounds (default, hover, active)
//!   400–600 borders (default, hover, active)
//!   700–800 high-contrast fills, 900–1000 text (secondary, primary)
//! Light or dark follows the Omarchy theme mode unless overridden in the app.

use eframe::egui::{
    self, Color32, CornerRadius, FontFamily, FontId, Margin, Shadow, Stroke, TextStyle, Vec2,
};
use std::path::PathBuf;
use std::time::SystemTime;

type Scale = [Color32; 10];

#[derive(Clone, Copy)]
pub struct Tokens {
    pub dark: bool,
    pub bg100: Color32,
    pub bg200: Color32,
    gray: Scale,
    blue: Scale,
    red: Scale,
    amber: Scale,
    green: Scale,
}

const fn c(hex: u32) -> Color32 {
    Color32::from_rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

const LIGHT: Tokens = Tokens {
    dark: false,
    bg100: c(0xffffff),
    bg200: c(0xf5f5f5),
    gray: [c(0xf2f2f2), c(0xebebeb), c(0xe6e6e6), c(0xeaeaea), c(0xc9c9c9), c(0xa8a8a8), c(0x8f8f8f), c(0x7d7d7d), c(0x4d4d4d), c(0x171717)],
    blue: [c(0xf0f7ff), c(0xeaf4ff), c(0xe0efff), c(0xcce7ff), c(0x97ccff), c(0x51aeff), c(0x0070f7), c(0x005edc), c(0x0064e2), c(0x002453)],
    red: [c(0xffeef0), c(0xffe9ea), c(0xffe4e5), c(0xffd8d7), c(0xffb5b6), c(0xff6a6e), c(0xfc0035), c(0xe70022), c(0xd60020), c(0x46000c)],
    amber: [c(0xfff6e1), c(0xfff4d4), c(0xfff1c8), c(0xffdd84), c(0xffc85e), c(0xffaa00), c(0xffb200), c(0xff9900), c(0xa64f00), c(0x541c00)],
    green: [c(0xecfdec), c(0xe5fce7), c(0xd3fad1), c(0xb9f5bc), c(0x82eb8d), c(0x4ce15e), c(0x28a948), c(0x279141), c(0x107d32), c(0x00370d)],
};

const DARK: Tokens = Tokens {
    dark: true,
    bg100: c(0x0a0a0a),
    bg200: c(0x111111),
    gray: [c(0x1a1a1a), c(0x1f1f1f), c(0x292929), c(0x2e2e2e), c(0x454545), c(0x878787), c(0x8f8f8f), c(0x7d7d7d), c(0xa0a0a0), c(0xededed)],
    blue: [c(0x06193a), c(0x022248), c(0x002f62), c(0x003771), c(0x004287), c(0x0091ff), c(0x0070f7), c(0x005edc), c(0x52a8ff), c(0xebf6ff)],
    red: [c(0x2a1314), c(0x3c1618), c(0x561a1e), c(0x671e22), c(0x832126), c(0xe5484d), c(0xe5484d), c(0xda3036), c(0xff6166), c(0xfeecee)],
    amber: [c(0x291800), c(0x331b00), c(0x4d2900), c(0x573200), c(0x6b4105), c(0xe79c13), c(0xffb224), c(0xff990a), c(0xf2a20d), c(0xfef3dd)],
    green: [c(0x0b2211), c(0x0f2e15), c(0x113619), c(0x0c451b), c(0x126428), c(0x1a9338), c(0x46a758), c(0x398e4a), c(0x5fc26a), c(0xe8fdea)],
};

fn step(s: &Scale, n: u16) -> Color32 {
    s[(n / 100).clamp(1, 10) as usize - 1]
}

impl Tokens {
    pub fn gray(&self, n: u16) -> Color32 { step(&self.gray, n) }
    pub fn blue(&self, n: u16) -> Color32 { step(&self.blue, n) }
    pub fn red(&self, n: u16) -> Color32 { step(&self.red, n) }
    pub fn amber(&self, n: u16) -> Color32 { step(&self.amber, n) }
    pub fn green(&self, n: u16) -> Color32 { step(&self.green, n) }

    // Semantic names, as rengaf maps them for shadcn.
    pub fn fg(&self) -> Color32 { self.gray(1000) }
    pub fn subtle(&self) -> Color32 { self.gray(900) }
    pub fn border(&self) -> Color32 { self.gray(400) }
    pub fn primary(&self) -> Color32 { self.gray(1000) }
    pub fn on_primary(&self) -> Color32 { self.bg100 }
    pub fn accent(&self) -> Color32 { self.gray(200) }
    pub fn destructive(&self) -> Color32 { self.red(800) }

    /// rengaf's menu shadow (`0 4 8 -4 #0000000a, 0 16 24 -8 #0000000f`): barely there, in dark too,
    /// where the border does the work. One egui shadow approximates the pair.
    pub fn shadow_menu(&self) -> Shadow {
        Shadow { offset: [0, 8], blur: 20, spread: 0, color: Color32::from_black_alpha(if self.dark { 40 } else { 16 }) }
    }
    /// The modal shadow (`0 8 16 -4 #0000000a, 0 24 32 -8 #0000000f`).
    pub fn shadow_modal(&self) -> Shadow {
        Shadow { offset: [0, 12], blur: 28, spread: 0, color: Color32::from_black_alpha(if self.dark { 56 } else { 20 }) }
    }
}

pub const RADIUS_MD: u8 = 6; // controls: buttons, inputs, menu items
pub const RADIUS_LG: u8 = 8; // cards, tables, popovers
pub const RADIUS_XL: u8 = 12; // dialogs, sheets

// ---- typography: Geist presets. One style sets size and weight. ----

const GEIST: &[u8] = include_bytes!("../assets/fonts/Geist-Regular.ttf");
const GEIST_MEDIUM: &[u8] = include_bytes!("../assets/fonts/Geist-Medium.ttf");
const GEIST_SEMIBOLD: &[u8] = include_bytes!("../assets/fonts/Geist-SemiBold.ttf");
const GEIST_MONO: &[u8] = include_bytes!("../assets/fonts/GeistMono-Regular.ttf");
/// Lucide icons (the set shadcn/rengaf use), subset to the glyphs Harbor draws.
const LUCIDE: &[u8] = include_bytes!("../assets/fonts/lucide.ttf");
/// Lucide "copy" and "check" remapped to U+1F5D0 and U+2714, the two characters
/// egui_commonmark's code-block copy button draws (no font here has them, so egui showed
/// a missing-glyph box). Made with fontTools: subset lucide.ttf to those two glyphs and
/// rewrite the cmap; the FontTweak in `install_fonts` centres them on the block's text.
const LUCIDE_MD: &[u8] = include_bytes!("../assets/fonts/lucide-md.ttf");
/// Glyph fallback (icons, symbols Geist lacks) if the system has it.
const NERD_FALLBACK: &str = "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf";

pub fn medium() -> FontFamily { FontFamily::Name("medium".into()) }
pub fn semibold() -> FontFamily { FontFamily::Name("semibold".into()) }

pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    let mut add = |name: &str, bytes: Vec<u8>| {
        fonts.font_data.insert(name.into(), egui::FontData::from_owned(bytes).into());
    };
    add("geist", GEIST.to_vec());
    add("geist-medium", GEIST_MEDIUM.to_vec());
    add("geist-semibold", GEIST_SEMIBOLD.to_vec());
    add("geist-mono", GEIST_MONO.to_vec());
    add("lucide", LUCIDE.to_vec());
    let nerd = std::fs::read(NERD_FALLBACK).ok();
    if let Some(b) = nerd.clone() {
        add("nerd", b);
    }
    fonts.font_data.insert(
        "lucide-md".into(),
        egui::FontData::from_static(LUCIDE_MD)
            .tweak(egui::FontTweak { scale: 0.8, y_offset: -5.5, ..Default::default() })
            .into(),
    );
    // egui's bundled fonts stay as the last fallback for emoji etc.
    let defaults: Vec<String> = fonts.families[&FontFamily::Proportional].clone();
    let chain = |first: &str| {
        let mut v = vec![first.to_string(), "lucide".to_string(), "lucide-md".to_string()];
        if nerd.is_some() {
            v.push("nerd".into());
        }
        v.extend(defaults.iter().cloned());
        v
    };
    fonts.families.insert(FontFamily::Proportional, chain("geist"));
    fonts.families.insert(FontFamily::Monospace, chain("geist-mono"));
    fonts.families.insert(medium(), chain("geist-medium"));
    fonts.families.insert(semibold(), chain("geist-semibold"));
    ctx.set_fonts(fonts);
}

/// Named presets, `TextStyle::Name("heading-24")` etc.
pub fn ts(name: &str) -> TextStyle {
    TextStyle::Name(name.into())
}

/// The rest of a rengaf preset that a font size doesn't carry: its line height (px) and
/// tracking (px, from em). `widgets::text`/`subtle` apply them.
pub fn preset_metrics(name: &str) -> (Option<f32>, f32) {
    let (lh, em) = match name {
        "heading-32" => (40.0, -0.04),
        "heading-24" => (32.0, -0.04),
        "heading-20" => (26.0, -0.02),
        "heading-16" => (24.0, -0.02),
        "heading-14" => (20.0, -0.02),
        "copy-16" => (24.0, 0.0),
        "copy-14" | "label-14" | "strong-14" | "button-14" => (20.0, 0.0),
        "copy-13" | "copy-13-mono" => (18.0, 0.0),
        "label-13" => (16.0, 0.0),
        "label-12" | "label-12-mono" | "button-12" => (16.0, 0.0),
        "label-16" => (20.0, 0.0),
        _ => return (None, 0.0),
    };
    let size = name.rsplit('-').find_map(|p| p.parse::<f32>().ok()).unwrap_or(14.0);
    (Some(lh), em * size)
}

fn text_styles() -> std::collections::BTreeMap<TextStyle, FontId> {
    use FontFamily::{Monospace, Proportional};
    let mut m = std::collections::BTreeMap::new();
    m.insert(TextStyle::Small, FontId::new(12.0, Proportional));
    m.insert(TextStyle::Body, FontId::new(14.0, Proportional));
    m.insert(TextStyle::Monospace, FontId::new(13.0, Monospace));
    m.insert(TextStyle::Button, FontId::new(14.0, medium()));
    m.insert(TextStyle::Heading, FontId::new(20.0, semibold()));
    for (name, size, fam) in [
        ("heading-32", 32.0, semibold()),
        ("heading-24", 24.0, semibold()),
        ("heading-20", 20.0, semibold()),
        ("heading-16", 16.0, semibold()),
        ("heading-14", 14.0, semibold()),
        ("button-14", 14.0, medium()),
        ("button-12", 12.0, medium()),
        ("label-14", 14.0, Proportional),
        ("label-13", 13.0, Proportional),
        ("label-12", 12.0, Proportional),
        ("label-13-mono", 13.0, Monospace),
        ("label-12-mono", 12.0, Monospace),
        ("copy-14", 14.0, Proportional),
        ("copy-13", 13.0, Proportional),
        ("copy-16", 16.0, Proportional),
        ("label-16", 16.0, Proportional),
        ("button-16", 16.0, medium()),
        ("copy-13-mono", 13.0, Monospace),
        ("strong-14", 14.0, medium()),
    ] {
        m.insert(ts(name), FontId::new(size, fam));
    }
    m
}

// ---- mode ----

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    System,
    Light,
    Dark,
}

impl Mode {
    pub fn parse(s: &str) -> Self {
        match s {
            "light" => Self::Light,
            "dark" => Self::Dark,
            _ => Self::System,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

pub struct Theme {
    pub t: Tokens,
    pub mode: Mode,
    omarchy: PathBuf,
    stamp: Option<SystemTime>,
    last_check: std::time::Instant,
}

fn omarchy_is_dark(path: &PathBuf) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| {
            t.lines().find_map(|l| {
                let (k, v) = l.split_once('=')?;
                (k.trim() == "mode").then(|| !v.contains("light"))
            })
        })
        .unwrap_or(true)
}

impl Theme {
    pub fn new(mode: Mode) -> Self {
        let omarchy = crate::store::home().join(".local/state/omarchy/current/theme/colors.toml");
        let stamp = std::fs::metadata(&omarchy).and_then(|m| m.modified()).ok();
        let mut s = Self { t: DARK, mode, omarchy, stamp, last_check: std::time::Instant::now() };
        s.resolve();
        s
    }

    fn resolve(&mut self) {
        let dark = match self.mode {
            Mode::Light => false,
            Mode::Dark => true,
            Mode::System => omarchy_is_dark(&self.omarchy),
        };
        self.t = if dark { DARK } else { LIGHT };
    }

    pub fn set_mode(&mut self, mode: Mode, ctx: &egui::Context) {
        self.mode = mode;
        self.resolve();
        self.apply(ctx);
    }

    /// Cheap mtime check, at most every 2 s and only when a frame is drawn anyway.
    pub fn refresh(&mut self, ctx: &egui::Context) {
        if self.mode != Mode::System || self.last_check.elapsed().as_secs() < 2 {
            return;
        }
        self.last_check = std::time::Instant::now();
        let stamp = std::fs::metadata(&self.omarchy).and_then(|m| m.modified()).ok();
        if stamp != self.stamp {
            self.stamp = stamp;
            self.resolve();
            self.apply(ctx);
        }
    }

    pub fn apply(&self, ctx: &egui::Context) {
        let t = self.t;
        let mut v = if t.dark { egui::Visuals::dark() } else { egui::Visuals::light() };
        v.override_text_color = Some(t.fg());
        v.weak_text_color = Some(t.subtle());
        v.panel_fill = t.bg100;
        v.window_fill = t.bg100;
        v.extreme_bg_color = t.bg100; // inputs sit on bg-card
        v.faint_bg_color = t.bg200;
        v.code_bg_color = t.bg200;
        v.hyperlink_color = t.blue(900);
        v.warn_fg_color = t.amber(900);
        v.error_fg_color = t.red(900);
        v.selection.bg_fill = if t.dark { t.blue(500) } else { t.blue(400) };
        v.selection.stroke = Stroke::new(1.0, t.gray(1000));
        v.window_stroke = Stroke::new(1.0, t.border());
        v.window_corner_radius = CornerRadius::same(RADIUS_XL);
        v.window_shadow = t.shadow_modal();
        v.popup_shadow = t.shadow_menu();
        v.menu_corner_radius = CornerRadius::same(RADIUS_LG);
        v.text_cursor.stroke = Stroke::new(1.5, t.gray(1000));
        v.striped = false;

        // Secondary button / ghost row recipe: gray-100 → hover gray-200 → active gray-300.
        let w = &mut v.widgets;
        w.noninteractive.bg_fill = t.bg100;
        w.noninteractive.weak_bg_fill = t.bg100;
        w.noninteractive.bg_stroke = Stroke::new(1.0, t.border());
        w.noninteractive.fg_stroke = Stroke::new(1.0, t.fg());
        for (st, fill, stroke) in [
            (&mut w.inactive, t.gray(100), Stroke::new(1.0, t.border())),
            (&mut w.hovered, t.gray(200), Stroke::new(1.0, t.gray(500))),
            (&mut w.active, t.gray(300), Stroke::new(1.0, t.gray(600))),
            (&mut w.open, t.gray(200), Stroke::new(1.0, t.gray(500))),
        ] {
            st.bg_fill = fill;
            st.weak_bg_fill = fill;
            st.bg_stroke = stroke;
            st.fg_stroke = Stroke::new(1.5, t.fg());
            st.corner_radius = CornerRadius::same(RADIUS_MD);
            st.expansion = 0.0;
        }
        w.noninteractive.corner_radius = CornerRadius::same(RADIUS_MD);

        ctx.all_styles_mut(|s| {
            s.visuals = v.clone();
            s.text_styles = text_styles();
            s.spacing.item_spacing = Vec2::new(8.0, 8.0);
            s.spacing.button_padding = Vec2::new(12.0, 6.0);
            s.spacing.interact_size = Vec2::new(32.0, 32.0);
            s.spacing.window_margin = Margin::same(24);
            s.spacing.menu_margin = Margin::same(4);
            s.spacing.combo_width = 140.0;
            // rengaf ScrollArea: a 10px track whose thumb is the border colour, rounded-full.
            s.spacing.scroll.bar_width = 8.0;
            s.spacing.scroll.floating = true;
            // The thumb is the text colour, faded to about the border's (gray-400) while the
            // pointer is over the area, and to gray-600 while it's on the bar.
            s.spacing.scroll.foreground_color = true;
            s.spacing.scroll.dormant_handle_opacity = 0.0;
            s.spacing.scroll.active_handle_opacity = 0.22;
            s.spacing.scroll.interact_handle_opacity = 0.45;
            s.spacing.scroll.dormant_background_opacity = 0.0;
            s.spacing.scroll.active_background_opacity = 0.0;
            s.spacing.scroll.interact_background_opacity = 0.0;
            s.spacing.tooltip_width = 280.0;
            s.interaction.selectable_labels = true;
        });
    }
}
