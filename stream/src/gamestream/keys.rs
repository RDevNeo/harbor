//! Key names (egui's `Key::name()` and W3C-style names) → Windows virtual-key
//! codes, which is what GameStream carries. They name PHYSICAL keys in US
//! positions: the host's own layout (synced to ours by the agent) turns them
//! into characters, like with Moonlight.

pub fn vk(name: &str) -> Option<u16> {
    let n = name.trim();
    if n.len() == 1 {
        let c = n.chars().next()?.to_ascii_uppercase();
        if c.is_ascii_alphanumeric() {
            return Some(c as u16); // 'A'..'Z', '0'..'9' are their own codes
        }
        return Some(match c {
            ' ' => 0x20,
            ';' | ':' => 0xBA,
            '=' | '+' => 0xBB,
            ',' | '<' => 0xBC,
            '-' | '_' => 0xBD,
            '.' | '>' => 0xBE,
            '/' | '?' => 0xBF,
            '`' | '~' => 0xC0,
            '[' | '{' => 0xDB,
            '\\' | '|' => 0xDC,
            ']' | '}' => 0xDD,
            '\'' | '"' => 0xDE,
            _ => return None,
        });
    }
    if let Some(d) = n.strip_prefix("Num").or_else(|| n.strip_prefix("Digit")) {
        if let Ok(d) = d.parse::<u16>() {
            if d <= 9 {
                return Some(0x30 + d);
            }
        }
    }
    if let Some(l) = n.strip_prefix("Key") {
        if l.len() == 1 {
            return vk(l);
        }
    }
    if let Some(f) = n.strip_prefix('F') {
        if let Ok(f) = f.parse::<u16>() {
            if (1..=24).contains(&f) {
                return Some(0x70 + f - 1);
            }
        }
    }
    if let Some(d) = n.strip_prefix("Numpad") {
        if let Ok(d) = d.parse::<u16>() {
            if d <= 9 {
                return Some(0x60 + d);
            }
        }
    }
    Some(match n {
        "Backspace" => 0x08,
        "Tab" => 0x09,
        "Enter" | "NumpadEnter" => 0x0D,
        "Shift" | "ShiftLeft" => 0xA0,
        "ShiftRight" => 0xA1,
        "Control" | "Ctrl" | "ControlLeft" => 0xA2,
        "ControlRight" => 0xA3,
        "Alt" | "AltLeft" => 0xA4,
        "AltRight" | "AltGr" | "AltGraph" => 0xA5,
        "Meta" | "Super" | "SuperLeft" | "MetaLeft" | "OS" | "OSLeft" => 0x5B,
        "SuperRight" | "MetaRight" | "OSRight" => 0x5C,
        "ContextMenu" => 0x5D,
        "Pause" => 0x13,
        "CapsLock" => 0x14,
        "Escape" | "Esc" => 0x1B,
        "Space" => 0x20,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "End" => 0x23,
        "Home" => 0x24,
        "Left" | "ArrowLeft" => 0x25,
        "Up" | "ArrowUp" => 0x26,
        "Right" | "ArrowRight" => 0x27,
        "Down" | "ArrowDown" => 0x28,
        "PrintScreen" => 0x2C,
        "Insert" => 0x2D,
        "Delete" => 0x2E,
        "NumpadMultiply" => 0x6A,
        "NumpadAdd" => 0x6B,
        "NumpadSubtract" => 0x6D,
        "NumpadDecimal" => 0x6E,
        "NumpadDivide" => 0x6F,
        "NumLock" => 0x90,
        "ScrollLock" => 0x91,
        "Semicolon" | "Colon" => 0xBA,
        "Equals" | "Equal" | "Plus" => 0xBB,
        "Comma" => 0xBC,
        "Minus" => 0xBD,
        "Period" => 0xBE,
        "Slash" | "Questionmark" => 0xBF,
        "Backtick" | "Backquote" => 0xC0,
        "OpenBracket" | "BracketLeft" | "OpenCurlyBracket" => 0xDB,
        "Backslash" | "Pipe" => 0xDC,
        "CloseBracket" | "BracketRight" | "CloseCurlyBracket" => 0xDD,
        "Quote" => 0xDE,
        "IntlBackslash" => 0xE2,
        "AudioVolumeMute" => 0xAD,
        "AudioVolumeDown" => 0xAE,
        "AudioVolumeUp" => 0xAF,
        "MediaTrackNext" => 0xB0,
        "MediaTrackPrevious" => 0xB1,
        "MediaStop" => 0xB2,
        "MediaPlayPause" => 0xB3,
        "BrowserBack" => 0xA6,
        "BrowserForward" => 0xA7,
        "BrowserRefresh" => 0xA8,
        _ => return None,
    })
}

/// Modifier keys, by VK: (shift, ctrl, alt, meta) bit for Limelight's modifier byte.
pub fn modifier_bit(vk: u16) -> u8 {
    match vk {
        0xA0 | 0xA1 | 0x10 => 0x01,
        0xA2 | 0xA3 | 0x11 => 0x02,
        0xA4 | 0xA5 | 0x12 => 0x04,
        0x5B | 0x5C => 0x08,
        _ => 0,
    }
}
