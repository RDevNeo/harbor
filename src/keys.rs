//! Keyboard shortcuts: the actions Harbor binds, their default keys and the user's
//! overrides (kv `keybindings`, JSON `{ action id: "Ctrl+Shift+F" }`). Matching is
//! exact: Ctrl+Shift+N doesn't fire Ctrl+N. Settings → Keybindings rebinds them.

use crate::store::Store;
use eframe::egui::{self, Event, InputState, Key, Modifiers};
use std::collections::BTreeMap;

pub struct Action {
    pub id: &'static str,
    pub label: &'static str,
    pub group: &'static str,
    /// Default combo, in `Combo::parse` form ("Ctrl+Backtick").
    pub default: &'static str,
    /// When it applies, as T3 Code writes it ("!terminalFocus"); "" = always.
    pub when: &'static str,
    /// Listed for reference only (clipboard, image viewer, ranges).
    pub fixed: bool,
}

const fn a(id: &'static str, label: &'static str, group: &'static str, default: &'static str, when: &'static str) -> Action {
    Action { id, label, group, default, when, fixed: false }
}

const fn fixed(id: &'static str, label: &'static str, group: &'static str, default: &'static str, when: &'static str) -> Action {
    Action { id, label, group, default, when, fixed: true }
}

pub const GROUPS: &[&str] = &["Navigation", "Composer", "Thread", "Panels", "Lists", "Editing", "Image viewer"];

pub const ACTIONS: &[Action] = &[
    a("new_thread", "New thread", "Navigation", "Ctrl+N", ""),
    a("palette", "Search everything (command palette)", "Navigation", "Ctrl+K", ""),
    a("settings", "Open settings", "Navigation", "Ctrl+Comma", ""),
    a("shortcuts", "Show the keyboard shortcuts", "Navigation", "Ctrl+Slash", ""),
    fixed("shortcuts_q", "Show the keyboard shortcuts (outside a text field)", "Navigation", "Shift+Questionmark", "!textFocus"),
    a("toggle_sidebar", "Show or hide the sidebar", "Navigation", "Ctrl+B", ""),
    fixed("pick_model", "Pick model 1–9", "Navigation", "Ctrl+1…9", "!terminalFocus && !dialog"),
    a("send", "Send", "Composer", "Enter", "composerFocus"),
    a("send_now", "Send the other way while the agent works (Steer or Queue)", "Composer", "Ctrl+Enter", "composerFocus"),
    a("steer_queued", "Steer with the oldest queued message", "Composer", "Ctrl+Shift+Enter", "composerFocus"),
    a("edit_queued", "Edit the latest queued message (caret at the start)", "Composer", "Alt+ArrowUp", "composerFocus"),
    a("newline", "New line", "Composer", "Shift+Enter", "composerFocus"),
    a("voice", "Dictate (start or stop the mic)", "Composer", "Ctrl+Shift+Space", ""),
    a("stop_turn", "Stop the turn (or take back the last send)", "Thread", "Escape", "chatOpen && !terminalFocus && !popup"),
    fixed("close_drawer", "Close the sidebar or team drawer", "Thread", "Escape", "drawerOpen"),
    a("toggle_terminal", "Open or close the terminal", "Panels", "Ctrl+Backtick", ""),
    a("toggle_team", "Show or hide the team panel (agents, wake-ups, webhooks)", "Panels", "Ctrl+D", "leadChatOpen && !terminalFocus"),
    a("toggle_browser", "Open or close the browser", "Panels", "Ctrl+Shift+B", "!browserFocus"),
    a("list_search", "Search the list", "Lists", "Ctrl+F", "listOpen"),
    a("list_toggle_panel", "Show or hide the side panel", "Lists", "Ctrl+Alt+B", "listOpen"),
    a("list_close_tab", "Close the panel's tab", "Lists", "Ctrl+W", "listPanelOpen"),
    a("pr_copy_link", "Copy the pull request's link", "Lists", "Ctrl+Shift+C", "pullRequestOpen && !terminalFocus"),
    a("pr_copy_number", "Copy the pull request's number", "Lists", "Ctrl+Shift+K", "pullRequestOpen"),
    fixed("list_back", "Leave the page", "Lists", "Escape", "listOpen && !menuOpen"),
    fixed("copy", "Copy (Ctrl+Shift+C in a terminal)", "Editing", "Ctrl+C", ""),
    fixed("cut", "Cut", "Editing", "Ctrl+X", ""),
    fixed("paste", "Paste text, images or files (also Shift+Insert)", "Editing", "Ctrl+V", ""),
    fixed("lightbox_close", "Close", "Image viewer", "Escape", "imageOpen"),
    fixed("lightbox_prev", "Previous image", "Image viewer", "Left", "imageOpen"),
    fixed("lightbox_next", "Next image", "Image viewer", "Right", "imageOpen"),
];

pub fn action(id: &str) -> Option<&'static Action> {
    ACTIONS.iter().find(|a| a.id == id)
}

/// A key with exact modifiers (Ctrl is Cmd on macOS).
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Combo {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub key: Key,
}

impl Combo {
    pub fn parse(s: &str) -> Option<Self> {
        let mut c = Combo { ctrl: false, shift: false, alt: false, key: Key::Escape };
        let (mods, key) = s.rsplit_once('+').unwrap_or(("", s));
        for m in mods.split('+').filter(|m| !m.is_empty()) {
            match m {
                "Ctrl" | "Cmd" => c.ctrl = true,
                "Shift" => c.shift = true,
                "Alt" => c.alt = true,
                _ => return None,
            }
        }
        c.key = Key::from_name(key)?;
        Some(c)
    }

    pub fn from_event(key: Key, m: Modifiers) -> Self {
        Combo { ctrl: m.command || m.ctrl, shift: m.shift, alt: m.alt, key }
    }

    fn mods(&self) -> String {
        [(self.ctrl, "Ctrl+"), (self.shift, "Shift+"), (self.alt, "Alt+")].iter().filter(|(on, _)| *on).map(|(_, s)| *s).collect()
    }

    /// Stored form: modifiers and egui's key name ("Ctrl+Backtick").
    pub fn name(&self) -> String {
        format!("{}{}", self.mods(), self.key.name())
    }

    /// Shown form, key caps split on '+' ("Ctrl+`").
    pub fn label(&self) -> String {
        // "?" is Shift plus a key on most layouts: shown as the one character it types.
        if self.key == Key::Questionmark && self.shift && !self.ctrl && !self.alt {
            return "?".into();
        }
        format!("{}{}", self.mods(), key_label(self.key))
    }

    fn matches(&self, key: Key, m: Modifiers) -> bool {
        *self == Combo::from_event(key, m)
    }
}

fn key_label(k: Key) -> &'static str {
    match k {
        Key::Escape => "Esc",
        Key::Backtick => "`",
        Key::Backslash => "\\",
        Key::Comma => ",",
        Key::Period => ".",
        Key::Slash => "/",
        Key::Questionmark => "?",
        Key::Semicolon => ";",
        Key::Quote => "'",
        Key::Minus => "-",
        Key::Equals => "=",
        Key::OpenBracket => "[",
        Key::CloseBracket => "]",
        Key::Plus => "Plus",
        k => k.name(),
    }
}

/// Shown form of a stored combo string; ranges like "Ctrl+1…9" pass through.
pub fn label(s: &str) -> String {
    Combo::parse(s).map(|c| c.label()).unwrap_or_else(|| s.to_string())
}

#[derive(Default)]
pub struct Keys {
    over: BTreeMap<String, String>,
    /// The action waiting for its new keys (Settings → Keybindings).
    pub capture: Option<&'static str>,
    /// The last keys refused while capturing (a plain character), to explain why.
    pub refused: Option<String>,
    pub search: String,
}

impl Keys {
    pub fn load(store: &Store) -> Self {
        let over = store.get("keybindings").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
        Keys { over, ..Default::default() }
    }

    fn save(&self, store: &Store) {
        store.set("keybindings", &serde_json::to_string(&self.over).unwrap_or_default());
    }

    /// The action's combo as stored: the user's, else the default.
    pub fn get(&self, id: &str) -> String {
        self.over.get(id).cloned().or_else(|| action(id).map(|a| a.default.to_string())).unwrap_or_default()
    }

    pub fn combo(&self, id: &str) -> Option<Combo> {
        Combo::parse(&self.get(id))
    }

    pub fn is_custom(&self, id: &str) -> bool {
        self.over.contains_key(id)
    }

    pub fn has_custom(&self) -> bool {
        !self.over.is_empty()
    }

    pub fn set(&mut self, store: &Store, id: &str, c: Combo) {
        match action(id) {
            Some(a) if Combo::parse(a.default) == Some(c) => self.over.remove(id),
            _ => self.over.insert(id.to_string(), c.name()),
        };
        self.save(store);
    }

    pub fn reset(&mut self, store: &Store, id: &str) {
        self.over.remove(id);
        self.save(store);
    }

    pub fn reset_all(&mut self, store: &Store) {
        self.over.clear();
        self.save(store);
    }

    /// Other actions on the same keys as `id`.
    pub fn conflicts(&self, id: &str) -> Vec<&'static Action> {
        let Some(c) = self.combo(id) else { return vec![] };
        let digit = c.ctrl && !c.shift && !c.alt && matches!(c.key, Key::Num1 | Key::Num2 | Key::Num3 | Key::Num4 | Key::Num5 | Key::Num6 | Key::Num7 | Key::Num8 | Key::Num9);
        ACTIONS
            .iter()
            .filter(|a| a.id != id && (self.combo(a.id) == Some(c) || (digit && a.id == "pick_model")))
            .filter(|a| !same_on_purpose(id, a.id))
            .collect()
    }

    /// Consumes a press of the action's keys.
    pub fn take(&self, i: &mut InputState, id: &str) -> bool {
        let Some(c) = self.combo(id) else { return false };
        let mut hit = false;
        i.events.retain(|e| {
            let m = matches!(e, Event::Key { key, pressed: true, modifiers, .. } if c.matches(*key, *modifiers));
            hit |= m;
            !m
        });
        hit
    }

    /// Whether the action's keys went down this frame, leaving the event for others.
    pub fn pressed(&self, i: &InputState, id: &str) -> bool {
        let Some(c) = self.combo(id) else { return false };
        i.events.iter().any(|e| matches!(e, Event::Key { key, pressed: true, repeat: false, modifiers, .. } if c.matches(*key, *modifiers)))
    }

    /// While capturing, from `raw_input_hook`, so it runs before the clipboard keys and
    /// every shortcut: all key, text and clipboard events are taken, and the first key
    /// press with its modifiers (Ctrl+Shift+K) becomes the binding. Esc alone cancels,
    /// Backspace alone goes back to the default, and a plain character is refused (it
    /// would type instead; it's also what Super+K arrives as, see [`Keys::refused`]).
    pub fn capture_raw(&mut self, raw: &mut egui::RawInput, store: &Store) {
        let Some(id) = self.capture else { return };
        let mut got = None;
        raw.events.retain(|e| match e {
            Event::Key { key, pressed: true, modifiers, .. } if got.is_none() => {
                got = Some(Combo::from_event(*key, *modifiers));
                false
            }
            Event::Key { .. } | Event::Text(_) | Event::Copy | Event::Cut | Event::Paste(_) | Event::PasteImage(_) | Event::Ime(_) => false,
            _ => true,
        });
        let Some(c) = got else { return };
        let bare = !c.ctrl && !c.shift && !c.alt;
        let typed = !c.ctrl && !c.alt && is_char(c.key);
        self.refused = None;
        match c.key {
            Key::Escape if bare => {}
            Key::Backspace if bare => self.reset(store, id),
            _ if typed => {
                self.refused = Some(c.label());
                return;
            }
            _ => self.set(store, id, c),
        }
        self.capture = None;
    }
}

/// Keys that type a character: bound without Ctrl or Alt they'd steal typing.
fn is_char(k: Key) -> bool {
    let n = k.name();
    n.len() == 1
        || n.starts_with("Num")
        || matches!(
            k,
            Key::Space | Key::Backtick | Key::Backslash | Key::Comma | Key::Period | Key::Slash | Key::Semicolon | Key::Quote | Key::Minus | Key::Equals | Key::OpenBracket | Key::CloseBracket | Key::Plus | Key::Colon | Key::Pipe | Key::Questionmark | Key::Exclamationmark | Key::OpenCurlyBracket | Key::CloseCurlyBracket
        )
}

/// Esc stops a turn, closes a drawer or the image viewer, or leaves a list page:
/// Harbor picks by context.
fn same_on_purpose(a: &str, b: &str) -> bool {
    let esc = ["stop_turn", "close_drawer", "lightbox_close", "list_back"];
    a != b && esc.contains(&a) && esc.contains(&b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combos_round_trip_and_defaults_parse() {
        for s in ["Ctrl+N", "Ctrl+Shift+Backtick", "Shift+Enter", "Alt+F4", "Escape"] {
            assert_eq!(Combo::parse(s).map(|c| c.name()).as_deref(), Some(s));
        }
        assert_eq!(label("Ctrl+Backslash"), "Ctrl+\\");
        assert!(ACTIONS.iter().filter(|a| !a.fixed).all(|a| Combo::parse(a.default).is_some()), "rebindable defaults parse");
        assert!(ACTIONS.iter().all(|a| GROUPS.contains(&a.group)));
        let keys = Keys::default();
        assert!(keys.conflicts("new_thread").is_empty());
        assert!(keys.conflicts("stop_turn").is_empty());
        assert!(is_char(Key::K) && is_char(Key::Num5) && is_char(Key::Space) && !is_char(Key::F5) && !is_char(Key::Enter) && !is_char(Key::Escape));
    }
}
