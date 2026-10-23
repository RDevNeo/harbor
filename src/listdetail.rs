//! A list with a tabbed detail panel beside it, after T3 Code's Pull Requests
//! page. Clicking a row opens it as a tab in the panel on the right (the list
//! stays usable on the left); more rows add more tabs. The panel can be
//! maximized over the list, hidden and shown again (Ctrl+Alt+B), and a tab
//! closes with its ×, a middle click or Ctrl+W. Esc leaves the page.
//!
//! Pages own a [`Split`] and call [`areas`] to place the list and the panel,
//! [`header`] for the panel's tab strip and controls, [`shortcuts`] for the
//! keys, and [`MenuKeys`] to drive their dropdown menus from the keyboard.

use crate::icons as ic;
use crate::theme::{self, RADIUS_MD};
use crate::widgets::{self as w, alpha};
use eframe::egui::{self, CornerRadius, CursorIcon, FontId, Id, Key, Modifiers, Rect, Sense, Stroke, Ui, Vec2, pos2};

/// Below this, list and panel can't share the page: the panel covers the list.
const MIN_SIDE: f32 = 340.0;

#[derive(Clone)]
pub struct Split {
    /// The open tabs' keys (a PR's URL, an issue's URL…), left to right.
    pub tabs: Vec<String>,
    pub active: usize,
    /// The panel is showing (it can be hidden with tabs still open).
    pub open: bool,
    /// The panel covers the list.
    pub max: bool,
    /// The panel's share of the page width.
    pub frac: f32,
}

impl Default for Split {
    fn default() -> Self {
        Split { tabs: vec![], active: 0, open: false, max: false, frac: 0.5 }
    }
}

impl Split {
    /// Opens `key` in the panel: switches to its tab, or adds one.
    pub fn select(&mut self, key: &str) {
        match self.tabs.iter().position(|k| k == key) {
            Some(i) => self.active = i,
            None => {
                self.tabs.push(key.to_string());
                self.active = self.tabs.len() - 1;
            }
        }
        self.open = true;
    }

    /// The tab on show, when the panel is open.
    pub fn current(&self) -> Option<&str> {
        self.open.then(|| self.tabs.get(self.active).map(String::as_str)).flatten()
    }

    pub fn showing(&self) -> bool {
        self.current().is_some()
    }

    /// Closes tab `i`; the one after it (or before, at the end) takes over.
    pub fn close(&mut self, i: usize) {
        if i >= self.tabs.len() {
            return;
        }
        self.tabs.remove(i);
        if i < self.active || self.active >= self.tabs.len() {
            self.active = self.active.saturating_sub(1);
        }
        if self.tabs.is_empty() {
            self.open = false;
            self.max = false;
        }
    }

    pub fn toggle(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        self.open = !self.open;
        if !self.open {
            self.max = false;
        }
    }

    pub fn apply(&mut self, a: TabAct) {
        match a {
            TabAct::Activate(i) => self.active = i.min(self.tabs.len().saturating_sub(1)),
            TabAct::Close(i) => self.close(i),
            TabAct::CloseOthers(i) => {
                if let Some(k) = self.tabs.get(i).cloned() {
                    self.tabs = vec![k];
                    self.active = 0;
                }
            }
            TabAct::CloseRight(i) => {
                self.tabs.truncate(i + 1);
                self.active = self.active.min(i);
            }
            TabAct::CloseAll => {
                self.tabs.clear();
                self.active = 0;
                self.open = false;
                self.max = false;
            }
            TabAct::Toggle => self.toggle(),
            TabAct::Maximize => self.max = !self.max,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TabAct {
    Activate(usize),
    Close(usize),
    CloseOthers(usize),
    CloseRight(usize),
    CloseAll,
    Toggle,
    Maximize,
}

/// Splits `rect` into the list (left) and the panel (right), with a draggable
/// divider between them; `None` for a side that isn't shown.
pub fn areas(ui: &mut Ui, id: Id, s: &mut Split, rect: Rect) -> (Option<Rect>, Option<Rect>) {
    if !s.showing() {
        return (Some(rect), None);
    }
    if s.max || rect.width() < MIN_SIDE * 2.0 {
        return (None, Some(rect));
    }
    let pw = (rect.width() * s.frac).clamp(MIN_SIDE, rect.width() - MIN_SIDE);
    let x = rect.right() - pw;
    let handle = Rect::from_min_max(pos2(x - 3.0, rect.top()), pos2(x + 3.0, rect.bottom()));
    let r = ui.interact(handle, id.with("divider"), Sense::drag()).on_hover_cursor(CursorIcon::ResizeHorizontal);
    if r.dragged() {
        if let Some(p) = r.interact_pointer_pos() {
            s.frac = ((rect.right() - p.x) / rect.width()).clamp(0.2, 0.8);
        }
    }
    let t = w::tokens(ui);
    let col = if r.hovered() || r.dragged() { t.gray(700) } else { t.border() };
    ui.painter().vline(x, rect.y_range(), Stroke::new(1.0, col));
    (Some(Rect::from_min_max(rect.min, pos2(x, rect.bottom()))), Some(Rect::from_min_max(pos2(x + 1.0, rect.top()), rect.max)))
}

/// Runs `add` in `rect` (top-down).
pub fn region<R>(ui: &mut Ui, rect: Rect, add: impl FnOnce(&mut Ui) -> R) -> R {
    let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rect).layout(egui::Layout::top_down(egui::Align::Min)));
    child.set_clip_rect(rect.intersect(ui.clip_rect()));
    add(&mut child)
}

/// The panel's top bar: a tab per open item (`label` gives its icon and text)
/// on the left; maximize, the panel toggle and, with `close_hint`, the page's
/// close button on the right. Returns the tab action and whether the page's
/// close was clicked.
pub fn header(ui: &mut Ui, s: &Split, label: impl Fn(&str) -> (&'static str, String), close_hint: Option<&str>) -> (Option<TabAct>, bool) {
    let t = w::tokens(ui);
    let mut act = None;
    let mut close_page = false;
    ui.horizontal(|ui| {
        ui.set_height(32.0);
        ui.spacing_mut().item_spacing.x = 4.0;
        ui.add_space(10.0);
        let controls = 3.0 * 30.0 + 16.0;
        let room = (ui.available_width() - controls).max(60.0);
        egui::ScrollArea::horizontal().id_salt("ld-tabs").max_width(room).scroll_bar_visibility(egui::scroll_area::ScrollBarVisibility::AlwaysHidden).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                for (i, key) in s.tabs.iter().enumerate() {
                    let (icon, text) = label(key);
                    if let Some(a) = tab(ui, i, icon, &text, i == s.active, s.tabs.len()) {
                        act = Some(a);
                    }
                }
            });
        });
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(12.0);
            ui.spacing_mut().item_spacing.x = 6.0;
            if let Some(h) = close_hint {
                if w::btn(ic::X).muted().icon_sm().show(ui).on_hover_text(h).clicked() {
                    close_page = true;
                }
            }
            if w::btn(ic::PANEL_RIGHT).muted().icon_sm().pressed(true).show(ui).on_hover_text("Hide the panel (Ctrl+Alt+B)").clicked() {
                act = Some(TabAct::Toggle);
            }
            let (icon, tip) = if s.max { (ic::MINIMIZE, "Show the list again") } else { (ic::MAXIMIZE, "Maximize the panel") };
            if w::btn(icon).muted().icon_sm().pressed(s.max).show(ui).on_hover_text(tip).clicked() {
                act = Some(TabAct::Maximize);
            }
        });
    });
    let r = ui.max_rect();
    ui.painter().hline(r.x_range(), ui.min_rect().bottom() + 6.0, Stroke::new(1.0, t.border()));
    ui.add_space(7.0);
    (act, close_page)
}

/// The list-side toggle for a hidden panel (disabled until something was opened).
pub fn toggle_btn(ui: &mut Ui, s: &Split) -> Option<TabAct> {
    let has = !s.tabs.is_empty();
    let tip = if has { "Show the panel (Ctrl+Alt+B)" } else { "Open an item first" };
    w::btn(ic::PANEL_RIGHT).muted().icon_sm().enabled(has).show(ui).on_hover_text(tip).clicked().then_some(TabAct::Toggle)
}

fn tab(ui: &mut Ui, i: usize, icon: &str, text: &str, active: bool, n: usize) -> Option<TabAct> {
    let t = w::tokens(ui);
    let font = FontId::new(13.0, theme::medium());
    let g = w::truncated(ui, text, font, if active { t.fg() } else { t.subtle() }, 160.0);
    let size = Vec2::new(10.0 + 16.0 + 6.0 + g.size().x + 6.0 + 18.0 + 6.0, 28.0);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    let p = ui.painter();
    let hovered = ui.rect_contains_pointer(rect);
    if active {
        p.rect_filled(rect, CornerRadius::same(RADIUS_MD), t.accent());
    } else if hovered {
        p.rect_filled(rect, CornerRadius::same(RADIUS_MD), alpha(t.accent(), 0.5));
    }
    ic::glyph(p, pos2(rect.left() + 10.0 + 8.0, rect.center().y), icon, 14.0, t.subtle());
    p.galley(pos2(rect.left() + 32.0, rect.center().y - g.size().y / 2.0), g, t.fg());
    let xr = Rect::from_center_size(pos2(rect.right() - 6.0 - 9.0, rect.center().y), Vec2::splat(18.0));
    let x = ui.interact(xr, Id::NULL.with(("ld-tab-x", i)), Sense::click());
    if active || hovered {
        if x.hovered() {
            p.rect_filled(xr, CornerRadius::same(4), t.gray(300));
        }
        ic::glyph(p, xr.center(), ic::X, 12.0, t.subtle());
    }
    let mut act = None;
    if x.clicked() {
        act = Some(TabAct::Close(i));
    } else if resp.middle_clicked() {
        act = Some(TabAct::Close(i));
    } else if resp.clicked() {
        act = Some(TabAct::Activate(i));
    }
    resp.on_hover_cursor(CursorIcon::PointingHand).context_menu(|ui| {
        if ui.button("Close").clicked() {
            act = Some(TabAct::Close(i));
            ui.close();
        }
        if ui.add_enabled(n > 1, egui::Button::new("Close others")).clicked() {
            act = Some(TabAct::CloseOthers(i));
            ui.close();
        }
        if ui.add_enabled(i + 1 < n, egui::Button::new("Close to the right")).clicked() {
            act = Some(TabAct::CloseRight(i));
            ui.close();
        }
        if ui.button("Close all").clicked() {
            act = Some(TabAct::CloseAll);
            ui.close();
        }
    });
    act
}

/// The page keys (bindable in Settings → Keybindings): close the tab, show or
/// hide the panel, focus the search. Skipped while a text field other than
/// `search` has focus, so typing is never taken.
pub fn shortcuts(ctx: &egui::Context, keys: &crate::keys::Keys, s: &Split, search: Id) -> Option<Shortcut> {
    ctx.input_mut(|i| {
        if keys.take(i, "list_close_tab") && s.showing() {
            Some(Shortcut::Tab(TabAct::Close(s.active)))
        } else if keys.take(i, "list_toggle_panel") {
            Some(Shortcut::Tab(TabAct::Toggle))
        } else if keys.take(i, "list_search") {
            Some(Shortcut::Search)
        } else {
            None
        }
    })
    .inspect(|k| {
        if *k == Shortcut::Search {
            ctx.memory_mut(|m| m.request_focus(search));
        }
    })
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Shortcut {
    Tab(TabAct),
    Search,
}

/// Esc on the page: true when it should leave (nothing else took the key).
/// `typing` (a text field had focus when the frame began) only blurs it.
pub fn esc_leaves(ctx: &egui::Context, typing: bool) -> bool {
    if !ctx.input(|i| i.key_pressed(Key::Escape)) {
        return false;
    }
    if typing {
        ctx.memory_mut(|m| m.stop_text_input());
        ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape));
        return false;
    }
    ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape))
}

/// Keyboard for a dropdown menu of `n` rows: ↑/↓ (and Home/End) move the
/// highlight, Enter or Space picks it, → opens its submenu, ← leaves a
/// submenu, Esc closes. Keys are consumed so the page doesn't see them.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct MenuKeys {
    pub hl: Option<usize>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum MenuKey {
    Pick(usize),
    /// → on a row: open its submenu.
    Enter(usize),
    /// ←: back to the parent menu.
    Leave,
    Close,
}

impl MenuKeys {
    pub fn input(&mut self, ctx: &egui::Context, n: usize) -> Option<MenuKey> {
        if n == 0 {
            return ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape)).then_some(MenuKey::Close);
        }
        let (up, down, home, end, enter, right, left, esc) = ctx.input_mut(|i| {
            let mut k = |key| i.consume_key(Modifiers::NONE, key);
            (k(Key::ArrowUp), k(Key::ArrowDown), k(Key::Home), k(Key::End), k(Key::Enter) | k(Key::Space), k(Key::ArrowRight), k(Key::ArrowLeft), k(Key::Escape))
        });
        let cur = self.hl.map(|h| h.min(n - 1));
        if down {
            self.hl = Some(cur.map_or(0, |h| (h + 1) % n));
        }
        if up {
            self.hl = Some(cur.map_or(n - 1, |h| (h + n - 1) % n));
        }
        if home {
            self.hl = Some(0);
        }
        if end {
            self.hl = Some(n - 1);
        }
        if esc {
            return Some(MenuKey::Close);
        }
        if left {
            return Some(MenuKey::Leave);
        }
        let h = self.hl?;
        if enter {
            return Some(MenuKey::Pick(h.min(n - 1)));
        }
        if right {
            return Some(MenuKey::Enter(h.min(n - 1)));
        }
        None
    }
}

/// The rows of the menu being drawn, for [`row_key`].
#[derive(Clone, Copy, Default)]
struct Rows {
    hl: Option<usize>,
    pick: Option<usize>,
    scroll: bool,
    i: usize,
}

fn rows_id() -> Id {
    Id::NULL.with("ld-menu-rows")
}

/// How many rows the menu `menu` drew last frame (what its keys move over).
pub fn rows_count(ctx: &egui::Context, menu: &str) -> usize {
    ctx.data(|d| d.get_temp::<usize>(Id::NULL.with(("ld-menu-n", menu)))).unwrap_or(0)
}

/// Before drawing a menu's rows: which one the keyboard highlights, which one
/// it picked this frame (that row reports a click), and whether the highlight
/// moved (the row scrolls into view).
pub fn rows_begin(ctx: &egui::Context, hl: Option<usize>, pick: Option<usize>, scroll: bool) {
    ctx.data_mut(|d| d.insert_temp(rows_id(), Rows { hl, pick, scroll, i: 0 }));
}

/// After drawing them: keeps the count for next frame's keys.
pub fn rows_end(ctx: &egui::Context, menu: &str) {
    let n = ctx.data_mut(|d| d.remove_temp::<Rows>(rows_id())).map_or(0, |r| r.i);
    ctx.data_mut(|d| d.insert_temp(Id::NULL.with(("ld-menu-n", menu)), n));
}

/// Called by each menu row (in order): true when the keyboard highlights it;
/// a keyboard pick makes `resp.clicked()` true, as Enter on a focused widget does.
pub fn row_key(ui: &Ui, resp: &mut egui::Response) -> bool {
    let Some(mut r) = ui.data(|d| d.get_temp::<Rows>(rows_id())) else { return false };
    let me = r.i;
    r.i += 1;
    ui.data_mut(|d| d.insert_temp(rows_id(), r));
    if r.pick == Some(me) {
        resp.flags.insert(egui::response::Flags::FAKE_PRIMARY_CLICKED);
    }
    let hl = r.hl == Some(me);
    if hl && r.scroll {
        resp.scroll_to_me(None);
    }
    hl
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tabs_open_switch_and_close() {
        let mut s = Split::default();
        assert!(!s.showing());
        s.select("a");
        s.select("b");
        s.select("c");
        assert_eq!(s.current(), Some("c"));
        s.select("a");
        assert_eq!((s.tabs.len(), s.current()), (3, Some("a")));
        s.close(0);
        assert_eq!(s.current(), Some("b"), "the next tab takes over");
        s.apply(TabAct::Activate(1));
        s.close(1);
        assert_eq!(s.current(), Some("b"), "closing the last tab falls back to the one before");
        s.toggle();
        assert!(!s.showing() && s.tabs.len() == 1);
        s.toggle();
        assert_eq!(s.current(), Some("b"));
        s.apply(TabAct::Maximize);
        s.close(0);
        assert!(!s.open && !s.max && s.tabs.is_empty());
        s.toggle();
        assert!(!s.open, "nothing to show");
    }

    #[test]
    fn close_others_and_right() {
        let mut s = Split::default();
        for k in ["a", "b", "c", "d"] {
            s.select(k);
        }
        s.apply(TabAct::CloseRight(1));
        assert_eq!(s.tabs, ["a", "b"]);
        assert_eq!(s.active, 1);
        s.apply(TabAct::CloseOthers(0));
        assert_eq!((s.tabs.clone(), s.active), (vec!["a".to_string()], 0));
    }
}
