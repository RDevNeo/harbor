//! Phones: the companion app's screen sharing (ShareService, :47886), which speaks
//! scrcpy 4.1's tunnel_forward protocol. The video socket: a dummy byte, the device
//! name (64 bytes), the codec id, then 12-byte headers (a session header — top bit set —
//! carries the size; a packet header carries pts|flags and a length). With control
//! on, a second connection within 3 s carries scrcpy's control messages
//! (app/src/control_msg.c), played by the app's Control (accessibility).
//!
//! connect-json: {"host","port"=47886,"control":bool,"name"?}

use crate::decode::{Codec, Decoder};
use crate::{Input, Sink, emit};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};

const PACKET_CONFIG: u64 = 1 << 62;
const PTS_MASK: u64 = (1 << 61) - 1;

pub fn run(cfg: &Value, sink: Sink, input: Receiver<Input>) -> Result<(), String> {
    let host = cfg["host"].as_str().ok_or("no host")?;
    let port = cfg["port"].as_u64().unwrap_or(47886) as u16;
    let control = cfg["control"].as_bool().unwrap_or(false);
    emit(json!({ "t": "status", "text": format!("Connecting to {host}…") }));
    let addr = (host, port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("bad address")?;
    let mut video = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("can't reach the phone's screen sharing: {e}"))?;
    video.set_nodelay(true).ok();
    video.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut dummy = [0u8; 1];
    video.read_exact(&mut dummy).map_err(|_| "the phone isn't sharing its screen".to_string())?;
    // the control socket must follow the video one (same address, within 3 s)
    let ctl = if control {
        let s = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| format!("control: {e}"))?;
        s.set_nodelay(true).ok();
        Some(s)
    } else {
        None
    };
    let mut name = [0u8; 64];
    video.read_exact(&mut name).map_err(|e| e.to_string())?;
    let name = String::from_utf8_lossy(&name).trim_end_matches('\0').to_string();
    let mut codec = [0u8; 4];
    video.read_exact(&mut codec).map_err(|e| e.to_string())?;
    let codec = match &codec {
        b"h264" => Codec::H264,
        b"h265" => Codec::H265,
        c => return Err(format!("unsupported codec {:?}", String::from_utf8_lossy(c))),
    };
    let mut dec = Decoder::software(codec)?;

    // video size, for mapping input (updated by session headers)
    let size = Arc::new(AtomicU64::new(0));
    let quitting = Arc::new(AtomicBool::new(false));
    {
        let (size, quitting) = (size.clone(), quitting.clone());
        let v = video.try_clone().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            match ctl {
                Some(ctl) => controller(ctl, input, size),
                None => while !matches!(input.recv(), Ok(Input::Quit) | Err(_)) {},
            }
            // quit: end the video loop too
            quitting.store(true, Ordering::Relaxed);
            let _ = v.shutdown(std::net::Shutdown::Both);
        });
    }

    let mut hdr = [0u8; 12];
    let mut config: Vec<u8> = Vec::new();
    let mut data = Vec::new();
    let mut ready = false;
    video.set_read_timeout(Some(Duration::from_secs(15))).ok();
    loop {
        if let Err(e) = video.read_exact(&mut hdr) {
            if quitting.load(Ordering::Relaxed) {
                return Ok(());
            }
            return match e.kind() {
                std::io::ErrorKind::UnexpectedEof => Err("the phone stopped sharing".into()),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => Err("no video from the phone for 15 s".into()),
                _ => Err(format!("connection lost: {e}")),
            };
        }
        sink.received(12);
        if hdr[0] & 0x80 != 0 {
            let w = u32::from_be_bytes(hdr[4..8].try_into().unwrap());
            let h = u32::from_be_bytes(hdr[8..12].try_into().unwrap());
            size.store((w as u64) << 32 | h as u64, Ordering::Relaxed);
            if !ready {
                ready = true;
                emit(json!({ "t": "ready", "name": cfg["name"].as_str().unwrap_or(&name), "model": name, "w": w, "h": h, "control": control }));
            }
            continue;
        }
        let pts = u64::from_be_bytes(hdr[0..8].try_into().unwrap());
        let len = u32::from_be_bytes(hdr[8..12].try_into().unwrap()) as usize;
        if len > 64 << 20 {
            return Err("bad packet".into());
        }
        data.resize(len, 0);
        if let Err(e) = video.read_exact(&mut data) {
            return if quitting.load(Ordering::Relaxed) { Ok(()) } else { Err(format!("connection lost: {e}")) };
        }
        sink.received(len);
        if pts & PACKET_CONFIG != 0 {
            // SPS/PPS: decoded together with the next frame (like scrcpy)
            config = data.clone();
            continue;
        }
        let _ = pts & PTS_MASK;
        let t = Instant::now();
        let frames = if config.is_empty() {
            dec.decode(&data)
        } else {
            let mut merged = std::mem::take(&mut config);
            merged.extend_from_slice(&data);
            dec.decode(&merged)
        };
        let ms = t.elapsed().as_secs_f32() * 1000.0;
        for f in frames {
            sink.frame(f, ms);
        }
    }
}

// ---- control ----------------------------------------------------------------------

const TYPE_KEY: u8 = 0;
const TYPE_TEXT: u8 = 1;
const TYPE_TOUCH: u8 = 2;
const TYPE_SCROLL: u8 = 3;
const TYPE_BACK_OR_SCREEN_ON: u8 = 4;
const TYPE_EXPAND_NOTIFICATIONS: u8 = 5;
const TYPE_SET_CLIPBOARD: u8 = 9;
/// scrcpy's CONTROL_MSG_CLIPBOARD_TEXT_MAX_LENGTH (256 KiB minus the header)
const CLIPBOARD_MAX: usize = (1 << 18) - 14;
const POINTER_MOUSE: u64 = u64::MAX; // scrcpy's POINTER_ID_MOUSE (-1)
const META_CTRL: i32 = 0x1000 | 0x2000; // CTRL_ON | CTRL_LEFT_ON
const META_SHIFT: i32 = 0x1 | 0x40;
const META_ALT: i32 = 0x2 | 0x10;

fn controller(mut s: TcpStream, input: Receiver<Input>, size: Arc<AtomicU64>) {
    // drain what the phone sends back (clipboard acks), so its buffer never fills
    if let Ok(mut r) = s.try_clone() {
        std::thread::spawn(move || {
            let mut b = [0u8; 256];
            while matches!(r.read(&mut b), Ok(n) if n > 0) {}
        });
    }
    let mut touching = false;
    while let Ok(i) = input.recv() {
        let packed = size.load(Ordering::Relaxed);
        let (w, h) = ((packed >> 32) as u16, packed as u16);
        let pos = |x: f32, y: f32| -> [u8; 12] {
            let mut p = [0u8; 12];
            p[0..4].copy_from_slice(&((x.clamp(0.0, 1.0) * w as f32) as i32).min(w as i32 - 1).to_be_bytes());
            p[4..8].copy_from_slice(&((y.clamp(0.0, 1.0) * h as f32) as i32).min(h as i32 - 1).to_be_bytes());
            p[8..10].copy_from_slice(&w.to_be_bytes());
            p[10..12].copy_from_slice(&h.to_be_bytes());
            p
        };
        let mut msg: Vec<u8> = Vec::new();
        match i {
            Input::Quit => break,
            Input::Control(_) => continue,
            Input::Pointer { x, y, down, button } => match (button, down) {
                (0, d) => {
                    // AMOTION_EVENT_ACTION_DOWN 0 / UP 1 / MOVE 2; moves only while pressed
                    let action = match d {
                        Some(true) => 0,
                        Some(false) if touching => 1,
                        None if touching => 2,
                        _ => continue,
                    };
                    touching = action != 1;
                    msg.extend([TYPE_TOUCH, action]);
                    msg.extend(POINTER_MOUSE.to_be_bytes());
                    msg.extend(pos(x, y));
                    msg.extend(if action == 1 { 0u16 } else { 0xffff }.to_be_bytes()); // pressure
                    msg.extend(1i32.to_be_bytes()); // action button: primary
                    msg.extend(if action == 1 { 0i32 } else { 1 }.to_be_bytes()); // buttons
                }
                // right click = back (or wake a dark screen), like scrcpy
                (1, Some(d)) => msg.extend([TYPE_BACK_OR_SCREEN_ON, if d { 0 } else { 1 }]),
                _ => continue,
            },
            Input::Wheel { x, y, dx, dy } => {
                let fp = |v: f32| ((v / 16.0).clamp(-1.0, 1.0) * 32768.0).clamp(-32768.0, 32767.0) as i16;
                msg.push(TYPE_SCROLL);
                msg.extend(pos(x, y));
                msg.extend(fp(-dx).to_be_bytes());
                msg.extend(fp(dy).to_be_bytes());
                msg.extend(0i32.to_be_bytes());
            }
            Input::Text(t) => {
                // scrcpy caps a text message at 300 bytes: split on char boundaries
                let mut chunk = String::new();
                for c in t.chars() {
                    if chunk.len() + c.len_utf8() > 300 {
                        text_msg(&mut msg, &chunk);
                        chunk.clear();
                    }
                    chunk.push(c);
                }
                if !chunk.is_empty() {
                    text_msg(&mut msg, &chunk);
                }
            }
            Input::Paste(t) => {
                // the phone's clipboard gets it and the app's Control pastes it into the
                // focused field (one step, any length/script), like scrcpy's Ctrl+V
                let mut end = t.len().min(CLIPBOARD_MAX);
                while !t.is_char_boundary(end) {
                    end -= 1;
                }
                msg.push(TYPE_SET_CLIPBOARD);
                msg.extend(0u64.to_be_bytes()); // sequence 0: no ack wanted
                msg.push(1); // paste
                msg.extend((end as u32).to_be_bytes());
                msg.extend(&t.as_bytes()[..end]);
            }
            Input::Key { key, down, ctrl, shift, alt, .. } => {
                let Some(code) = keycode(&key) else { continue };
                let meta = if ctrl { META_CTRL } else { 0 } | if shift { META_SHIFT } else { 0 } | if alt { META_ALT } else { 0 };
                key_msg(&mut msg, code, down, meta);
            }
            Input::Button(name) => {
                let code = match name.as_str() {
                    "back" => 4,
                    "home" => 3,
                    "recents" => 187,
                    "power" => 26,
                    "volume_up" => 24,
                    "volume_down" => 25,
                    "notifications" => {
                        msg.push(TYPE_EXPAND_NOTIFICATIONS);
                        0
                    }
                    _ => continue,
                };
                if code != 0 {
                    key_msg(&mut msg, code, true, 0);
                    key_msg(&mut msg, code, false, 0);
                }
            }
        }
        if s.write_all(&msg).is_err() {
            break;
        }
    }
    let _ = s.shutdown(std::net::Shutdown::Both);
}

fn key_msg(msg: &mut Vec<u8>, code: i32, down: bool, meta: i32) {
    msg.extend([TYPE_KEY, if down { 0 } else { 1 }]);
    msg.extend(code.to_be_bytes());
    msg.extend(0i32.to_be_bytes()); // repeat
    msg.extend(meta.to_be_bytes());
}

fn text_msg(msg: &mut Vec<u8>, t: &str) {
    msg.push(TYPE_TEXT);
    msg.extend((t.len() as u32).to_be_bytes());
    msg.extend(t.as_bytes());
}

/// Android keycodes for the keys the app's Control understands (editing keys and
/// Ctrl+A/C/X/V); text goes as text.
fn keycode(key: &str) -> Option<i32> {
    Some(match key {
        "Enter" => 66,
        "Backspace" => 67,
        "Delete" => 112,
        "Tab" => 61,
        "Escape" => 111,
        "ArrowLeft" => 21,
        "ArrowRight" => 22,
        "ArrowUp" => 19,
        "ArrowDown" => 20,
        "Home" => 122,
        "End" => 123,
        "PageUp" => 92,
        "PageDown" => 93,
        k if k.len() == 1 && k.as_bytes()[0].is_ascii_alphabetic() => 29 + (k.as_bytes()[0].to_ascii_lowercase() - b'a') as i32,
        _ => return None,
    })
}
