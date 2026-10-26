//! Voice input: the composer's mic (and its shortcut) records from the default input and
//! transcribes into the composer at the cursor, to edit before sending (never sent by itself).
//!
//! Recording is a `pw-record` (PipeWire) or `parecord` (PulseAudio) child writing raw 16 kHz
//! mono s16 to a pipe: no audio library. Transcription is local, private and free:
//! whisper.cpp's `whisper-cli` with a ggml model from Settings › Voice (tiny, base or small,
//! downloaded into Harbor's data folder). Without whisper.cpp the mic says how to get it.
//! Phones without a recogniser of their own send their recording here (`POST
//! /v1/transcribe`, api.rs), and it's transcribed the same way.

use crate::widgets::Tip as _;
use crate::app::App;
use eframe::egui;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const RATE: u32 = 16_000;
/// Longest recording kept (then it stops by itself).
const MAX_SECS: u64 = 600;
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(300);

/// (code whisper takes, label).
pub const LANGS: &[(&str, &str)] = &[("auto", "Detect automatically"), ("en", "English"), ("pt", "Portuguese")];

/// (name, what it's like, download size in bytes): whisper.cpp's multilingual models.
pub const MODELS: &[(&str, &str, u64)] = &[
    ("tiny", "Fastest, rougher", 77_691_713),
    ("base", "Fast, good for dictation", 147_951_465),
    ("small", "Slower, most accurate", 487_601_967),
];

/// The language and model, kept for the API threads (phones' recordings) too.
static CONFIG: Mutex<(String, String)> = Mutex::new((String::new(), String::new()));

pub fn models_dir() -> PathBuf {
    crate::store::data_dir().join("whisper")
}

pub fn model_path(name: &str) -> PathBuf {
    models_dir().join(format!("ggml-{name}.bin"))
}

pub fn installed(name: &str) -> bool {
    std::fs::metadata(model_path(name)).is_ok_and(|m| m.len() > 1_000_000)
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

/// whisper.cpp's command line program (`whisper-cli`; older builds call it `main` or
/// `whisper-cpp`). HARBOR_WHISPER names another.
pub fn whisper_bin() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HARBOR_WHISPER").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    on_path(&["whisper-cli", "whisper-cpp", "whisper.cpp"])
}

/// The recorder: PipeWire's, else PulseAudio's.
pub fn recorder() -> Option<(PathBuf, Vec<String>)> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    if let Some(p) = on_path(&["pw-record"]) {
        return Some((p, s(&["--raw", "--rate", "16000", "--channels", "1", "--format", "s16", "--media-category", "Capture", "--media-role", "Communication", "-"])));
    }
    on_path(&["parecord"]).map(|p| (p, s(&["--raw", "--rate=16000", "--channels=1", "--format=s16le", "--latency-msec=100"])))
}

/// The language whisper is told ("auto", "en", "pt") and the model used.
pub fn config() -> (String, String) {
    let c = CONFIG.lock().unwrap().clone();
    (if c.0.is_empty() { "auto".into() } else { c.0 }, c.1)
}

/// The model to use: the one picked if it's there, else the smallest one there.
pub fn current_model() -> Option<String> {
    let (_, m) = config();
    if !m.is_empty() && installed(&m) {
        return Some(m);
    }
    MODELS.iter().map(|m| m.0).find(|m| installed(m)).map(String::from)
}

/// Why voice input can't work here, if it can't (the mic shows it).
pub fn missing() -> Option<String> {
    if recorder().is_none() {
        return Some("Voice input records with pw-record (PipeWire) or parecord (PulseAudio): neither is installed.".into());
    }
    if whisper_bin().is_none() {
        return Some("Voice input transcribes with whisper.cpp on this PC, and it isn't installed. Install it (Arch: the whisper.cpp package; others: build github.com/ggml-org/whisper.cpp) so `whisper-cli` is on the PATH, then pick a model in Settings › Voice.".into());
    }
    if current_model().is_none() {
        return Some("Download a speech model in Settings › Voice first (base is a good start, 142 MB).".into());
    }
    None
}

// ------------------------------------------------------------------ recording

pub struct Recording {
    child: Child,
    samples: Arc<Mutex<Vec<i16>>>,
    /// The last 100 ms's loudness, 0..1, as f32 bits.
    level: Arc<AtomicU32>,
    pub started: Instant,
}

impl Recording {
    /// Starts recording; `wake` is called as sound comes in (to redraw the meter).
    pub fn start(wake: impl Fn() + Send + 'static) -> Result<Self, String> {
        let (bin, args) = recorder().ok_or("no recorder (pw-record or parecord)")?;
        let mut child = Command::new(&bin).args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("{}: {e}", bin.display()))?;
        let mut out = child.stdout.take().ok_or("no recorder output")?;
        let samples = Arc::new(Mutex::new(Vec::<i16>::with_capacity(RATE as usize * 30)));
        let level = Arc::new(AtomicU32::new(0));
        let (s2, l2) = (samples.clone(), level.clone());
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 3200]; // 100 ms
            let mut odd: Option<u8> = None;
            loop {
                let n = match out.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut bytes: Vec<u8> = odd.take().into_iter().chain(buf[..n].iter().copied()).collect();
                if bytes.len() % 2 == 1 {
                    odd = bytes.pop();
                }
                let chunk: Vec<i16> = bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
                l2.store(rms(&chunk).to_bits(), Ordering::Relaxed);
                let mut s = s2.lock().unwrap();
                if s.len() < (RATE as u64 * MAX_SECS) as usize {
                    s.extend_from_slice(&chunk);
                }
                drop(s);
                wake();
            }
        });
        Ok(Self { child, samples, level, started: Instant::now() })
    }

    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    pub fn too_long(&self) -> bool {
        self.started.elapsed() >= Duration::from_secs(MAX_SECS)
    }

    /// Stops and returns what was recorded.
    pub fn stop(mut self) -> Vec<i16> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // The reader ends with the pipe; what it read so far is all there is.
        std::thread::sleep(Duration::from_millis(30));
        std::mem::take(&mut *self.samples.lock().unwrap())
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Loudness of a chunk, 0..1 (RMS, scaled so speech fills most of the meter).
pub fn rms(s: &[i16]) -> f32 {
    if s.is_empty() {
        return 0.0;
    }
    let sum: f64 = s.iter().map(|x| (*x as f64 / 32768.0).powi(2)).sum();
    ((sum / s.len() as f64).sqrt() as f32 * 6.0).min(1.0)
}

/// A WAV file (16-bit PCM, mono) of the samples.
pub fn wav(samples: &[i16], rate: u32) -> Vec<u8> {
    let data = samples.len() as u32 * 2;
    let mut v = Vec::with_capacity(44 + data as usize);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&rate.to_le_bytes());
    v.extend_from_slice(&(rate * 2).to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        v.extend_from_slice(&s.to_le_bytes());
    }
    v
}

/// whisper.cpp on a WAV file (16 kHz mono): the text, or why not.
pub fn transcribe(wav: &Path, lang: &str) -> Result<String, String> {
    if let Some(m) = missing() {
        return Err(m);
    }
    let bin = whisper_bin().ok_or("no whisper-cli")?;
    let model = model_path(&current_model().ok_or("no model")?);
    let lang = if LANGS.iter().any(|l| l.0 == lang) { lang } else { "auto" };
    let threads = std::thread::available_parallelism().map(|n| n.get().clamp(1, 4)).unwrap_or(2).to_string();
    let mut cmd = Command::new(&bin);
    cmd.arg("-m").arg(&model).arg("-f").arg(wav).args(["-l", lang, "-t", &threads, "-nt", "-np"]);
    let out = crate::git::output_within(&mut cmd, TRANSCRIBE_TIMEOUT).map_err(|e| format!("whisper.cpp: {e}"))?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr);
        return Err(format!("whisper.cpp failed: {}", e.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no output").trim()));
    }
    Ok(clean(&String::from_utf8_lossy(&out.stdout)))
}

/// whisper's text as one paragraph, without its non-speech marks ("[BLANK_AUDIO]", "(music)").
pub fn clean(s: &str) -> String {
    let mut out = String::new();
    for l in s.lines() {
        let l = l.trim();
        // Timestamps, if a build prints them anyway.
        let l = if l.starts_with('[') && l.contains("-->") { l.split_once(']').map(|x| x.1.trim()).unwrap_or(l) } else { l };
        let whole_mark = (l.starts_with('[') && l.ends_with(']')) || (l.starts_with('(') && l.ends_with(')'));
        if l.is_empty() || whole_mark {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(l);
    }
    out
}

/// Transcribes samples on this thread (via a temporary WAV file).
pub fn transcribe_samples(samples: &[i16], lang: &str) -> Result<String, String> {
    if samples.len() < RATE as usize / 4 {
        return Err("Nothing was recorded (check the input device).".into());
    }
    let path = std::env::temp_dir().join(format!("harbor-voice-{}-{}.wav", std::process::id(), crate::store::new_uuid()));
    std::fs::write(&path, wav(samples, RATE)).map_err(|e| e.to_string())?;
    let r = transcribe(&path, lang);
    let _ = std::fs::remove_file(&path);
    r
}

// ------------------------------------------------------------------ model download

pub struct Download {
    pub name: String,
    pub total: u64,
    pub done: Arc<AtomicU64>,
    pub result: Arc<Mutex<Option<Result<(), String>>>>,
}

/// Downloads a model from whisper.cpp's own Hugging Face repo, into a temporary name first.
pub fn download(name: &str, wake: impl Fn() + Send + 'static) -> Download {
    let total = MODELS.iter().find(|m| m.0 == name).map(|m| m.2).unwrap_or(0);
    let d = Download { name: name.into(), total, done: Arc::new(AtomicU64::new(0)), result: Arc::new(Mutex::new(None)) };
    let (done, result, name) = (d.done.clone(), d.result.clone(), name.to_string());
    std::thread::spawn(move || {
        let dst = model_path(&name);
        let tmp = dst.with_extension("part");
        let r = (|| -> Result<(), String> {
            std::fs::create_dir_all(models_dir()).map_err(|e| e.to_string())?;
            let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin");
            let mut child = Command::new("curl")
                .args(["-fsSL", "--retry", "2", "--connect-timeout", "20", "-o"])
                .arg(&tmp)
                .arg(&url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("curl: {e}"))?;
            let status = loop {
                if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
                    break st;
                }
                done.store(std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0), Ordering::Relaxed);
                wake();
                std::thread::sleep(Duration::from_millis(400));
            };
            if !status.success() {
                let mut e = String::new();
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut e);
                }
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("download failed: {}", e.trim()));
            }
            let len = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
            if total > 0 && len != total {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("download incomplete ({len} of {total} bytes)"));
            }
            std::fs::rename(&tmp, &dst).map_err(|e| e.to_string())
        })();
        *result.lock().unwrap() = Some(r);
        wake();
    });
    d
}

pub fn megabytes(b: u64) -> String {
    format!("{} MB", b / 1_000_000)
}

// ------------------------------------------------------------------ the composer's mic

#[derive(Default)]
pub struct State {
    /// Recording for this composer (chat id or app::DRAFT).
    pub rec: Option<(i64, Recording)>,
    /// Transcribing for this composer, since.
    pub busy: Option<(i64, Instant)>,
    chan: Option<(Sender<(i64, Result<String, String>)>, Receiver<(i64, Result<String, String>)>)>,
    pub download: Option<Download>,
}

impl App {
    /// The voice settings from the store, mirrored for the API threads (called at start).
    pub fn voice_load(&self) {
        *CONFIG.lock().unwrap() = (self.store.get("voice_lang").unwrap_or_default(), self.store.get("voice_model").unwrap_or_default());
    }

    pub fn voice_set(&self, lang: Option<&str>, model: Option<&str>) {
        if let Some(l) = lang {
            self.store.set("voice_lang", l);
        }
        if let Some(m) = model {
            self.store.set("voice_model", m);
        }
        self.voice_load();
    }

    /// The mic button or its shortcut: starts recording into composer `key`, or stops and
    /// transcribes.
    pub fn voice_toggle(&mut self, key: i64, ctx: &egui::Context) {
        if let Some((k, rec)) = self.voice.rec.take() {
            let samples = rec.stop();
            let (tx, _) = self.voice_chan();
            self.voice.busy = Some((k, Instant::now()));
            let (lang, _) = config();
            let ctx = ctx.clone();
            std::thread::spawn(move || {
                let _ = tx.send((k, transcribe_samples(&samples, &lang)));
                ctx.request_repaint();
            });
            return;
        }
        if self.voice.busy.is_some() {
            return;
        }
        if let Some(why) = missing() {
            crate::picker::show_toast(ctx, why);
            return;
        }
        let c = ctx.clone();
        match Recording::start(move || c.request_repaint()) {
            Ok(r) => self.voice.rec = Some((key, r)),
            Err(e) => crate::picker::show_toast(ctx, format!("Couldn't record: {e}")),
        }
    }

    fn voice_chan(&mut self) -> (Sender<(i64, Result<String, String>)>, ()) {
        let c = self.voice.chan.get_or_insert_with(channel);
        (c.0.clone(), ())
    }

    /// Transcripts that came back: into their composer at the cursor (from `App::tick`).
    pub fn voice_poll(&mut self, ctx: &egui::Context) {
        if self.voice.rec.as_ref().is_some_and(|(_, r)| r.too_long()) {
            let key = self.voice.rec.as_ref().map(|r| r.0).unwrap_or(crate::app::DRAFT);
            self.voice_toggle(key, ctx);
        }
        let got: Vec<(i64, Result<String, String>)> = match &self.voice.chan {
            Some((_, rx)) => rx.try_iter().collect(),
            None => return,
        };
        for (key, r) in got {
            self.voice.busy = None;
            match r {
                Ok(text) if text.trim().is_empty() => crate::picker::show_toast(ctx, "Didn't catch any words.".into()),
                Ok(text) => self.voice_insert(ctx, key, &text),
                Err(e) => crate::picker::show_toast(ctx, e),
            }
        }
    }

    /// Puts text into composer `key` at its cursor, spaced from the words around it.
    pub fn voice_insert(&mut self, ctx: &egui::Context, key: i64, text: &str) {
        let cid = egui::Id::NULL.with(("composer", key));
        let draft = self.drafts.entry(key).or_default();
        let mut state = egui::text_edit::TextEditState::load(ctx, cid).unwrap_or_default();
        let len = draft.chars().count();
        let at = state.cursor.char_range().map(|r| r.primary.index.0).unwrap_or(len).min(len);
        let (new, cursor) = insert_spaced(draft, at, text);
        *draft = new;
        state.cursor.set_char_range(Some(egui::text::CCursorRange::one(egui::text::CCursor::new(cursor))));
        state.store(ctx, cid);
        self.focus_composer = true;
    }

    // -------------------------------------------------------------- composer UI

    /// The mic in the composer's footer: idle, recording (level meter and time), or
    /// transcribing. Clicks toggle.
    pub fn voice_button(&mut self, ui: &mut egui::Ui, key: i64) {
        let t = self.theme.t;
        let recording = self.voice.rec.as_ref().filter(|(k, _)| *k == key).map(|(_, r)| (r.level(), r.started.elapsed()));
        let busy = self.voice.busy.is_some_and(|(k, _)| k == key);
        let hint = self.key_hint("Dictate", "voice");
        if let Some((level, secs)) = recording {
            // Stop, then the meter and the time, right to left.
            let r = crate::widgets::round_button(ui, ic_stop(), true).tip(self.key_hint("Stop and transcribe", "voice"));
            if r.clicked() {
                self.voice_toggle(key, ui.ctx());
            }
            let (rect, _) = ui.allocate_exact_size(egui::vec2(40.0, 20.0), egui::Sense::hover());
            meter(ui.painter(), rect, level, t.red(900), t.gray(500));
            let s = secs.as_secs();
            ui.label(egui::RichText::new(format!("{}:{:02}", s / 60, s % 60)).color(t.subtle()).size(12.5).monospace());
            ui.ctx().request_repaint_after(Duration::from_millis(100));
            return;
        }
        if busy {
            let (rect, _) = ui.allocate_exact_size(egui::vec2(18.0, 20.0), egui::Sense::hover());
            crate::widgets::spinner(ui.painter(), rect.center(), 6.0, t.subtle());
            ui.label(egui::RichText::new("Transcribing…").color(t.subtle()).size(12.5));
            return;
        }
        let tip = match missing() {
            Some(why) => why,
            None => hint,
        };
        if crate::widgets::btn(crate::icons::MIC).muted().icon_sm().show(ui).tip(tip).clicked() {
            self.voice_toggle(key, ui.ctx());
        }
    }
}

impl App {
    /// Settings › Voice: what's installed, the model (download or remove), the language.
    pub fn voice_tab(&mut self, ui: &mut egui::Ui) {
        use crate::pages::{rows, section};
        use crate::widgets as w;
        let ctx = ui.ctx().clone();
        let t = self.theme.t;
        let (lang, model) = config();
        let current = current_model();
        section(ui, "On this PC");
        rows(ui, |ui| {
            let rec = recorder().map(|(p, _)| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            w::setting_row(
                ui,
                "Microphone",
                &match &rec {
                    Some(r) if r == "pw-record" => "Records the default input with pw-record (PipeWire).".to_string(),
                    Some(r) => format!("Records the default input with {r} (PulseAudio)."),
                    None => "Needs pw-record (PipeWire) or parecord (PulseAudio): neither is installed.".to_string(),
                },
                |ui| ui.label(egui::RichText::new(if rec.is_some() { "Ready" } else { "Missing" }).color(if rec.is_some() { t.green(900) } else { t.red(900) })),
            );
            w::separator(ui);
            let bin = whisper_bin();
            w::setting_row(
                ui,
                "whisper.cpp",
                &match &bin {
                    Some(b) => format!("Transcribes with {}.", b.display()),
                    None => "Not installed. Install whisper.cpp (Arch: the whisper.cpp package; others: build github.com/ggml-org/whisper.cpp) so whisper-cli is on the PATH, then reopen this page.".to_string(),
                },
                |ui| ui.label(egui::RichText::new(if bin.is_some() { "Ready" } else { "Missing" }).color(if bin.is_some() { t.green(900) } else { t.red(900) })),
            );
        });
        ui.add_space(12.0);
        section(ui, "Speech model");
        // A finished download: kept as the model, or its error.
        let finished = self.voice.download.as_ref().and_then(|d| d.result.lock().unwrap().take().map(|r| (d.name.clone(), r)));
        if let Some((name, r)) = finished {
            self.voice.download = None;
            match r {
                Ok(()) => self.voice_set(None, Some(&name)),
                Err(e) => crate::picker::show_toast(&ctx, format!("Couldn't download the {name} model: {e}")),
            }
        }
        let mut action: Option<(&str, &str)> = None;
        rows(ui, |ui| {
            for (i, (name, what, size)) in MODELS.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                let here = installed(name);
                let used = current.as_deref() == Some(*name);
                let title = format!("{}{}", capital(name), if used { "  ·  in use" } else { "" });
                let desc = format!("{what} · {}", megabytes(*size));
                w::setting_row(ui, &title, &desc, |ui| {
                    if let Some(d) = self.voice.download.as_ref().filter(|d| d.name == *name) {
                        let done = d.done.load(Ordering::Relaxed);
                        let frac = if d.total > 0 { done as f32 / d.total as f32 } else { 0.0 };
                        ui.add(egui::ProgressBar::new(frac.min(1.0)).desired_width(140.0).text(format!("{} of {}", megabytes(done), megabytes(d.total))));
                        ui.ctx().request_repaint_after(Duration::from_millis(400));
                    } else if here {
                        if w::btn("Remove").sm().outline().show(ui).clicked() {
                            action = Some(("remove", name));
                        }
                        if !used && w::btn("Use").sm().outline().show(ui).clicked() {
                            action = Some(("use", name));
                        }
                    } else if w::btn("Download").sm().outline().enabled(self.voice.download.is_none()).show(ui).clicked() {
                        action = Some(("download", name));
                    }
                });
            }
        });
        match action {
            Some(("download", name)) => {
                let c = ctx.clone();
                self.voice.download = Some(download(name, move || c.request_repaint()));
            }
            Some(("use", name)) => self.voice_set(None, Some(name)),
            Some(("remove", name)) => {
                let _ = std::fs::remove_file(model_path(name));
                if model == name {
                    self.voice_set(None, Some(""));
                }
            }
            _ => {}
        }
        w::subtle(ui, "Models come from whisper.cpp's own repository on Hugging Face and stay in Harbor's data folder.", "label-12");
        ui.add_space(12.0);
        section(ui, "Language");
        rows(ui, |ui| {
            w::setting_row(ui, "Spoken language", "Detect works for either; picking yours is a little faster and surer.", |ui| {
                for (code, label) in LANGS.iter().rev() {
                    let short = if *code == "auto" { "Detect" } else { label };
                    if w::btn(short).sm().outline().pressed(lang == *code).show(ui).clicked() {
                        self.voice_set(Some(code), None);
                    }
                }
            });
        });
        ui.add_space(12.0);
        w::subtle(
            ui,
            format!(
                "The mic in the composer (or {}) starts and stops dictation; the text goes in at the cursor, to edit before you send. Phones dictate with their own recogniser, and send their recording here only when they have none.",
                crate::keys::label(&self.keys.get("voice"))
            ),
            "label-12",
        );
    }
}

fn capital(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn ic_stop() -> &'static str {
    crate::icons::STOP
}

/// Five bars rising with the level.
fn meter(p: &egui::Painter, rect: egui::Rect, level: f32, on: egui::Color32, off: egui::Color32) {
    let n = 5;
    let w = rect.width() / (n as f32 * 1.8);
    for i in 0..n {
        let x = rect.left() + i as f32 * w * 1.8 + w / 2.0;
        // The middle bars reach highest, as voice meters do.
        let shape = [0.55, 0.8, 1.0, 0.8, 0.55][i];
        let h = (rect.height() * (0.18 + 0.82 * (level * shape).min(1.0))).max(3.0);
        let lit = level * shape > 0.06;
        p.line_segment([egui::pos2(x, rect.center().y - h / 2.0), egui::pos2(x, rect.center().y + h / 2.0)], egui::Stroke::new(w, if lit { on } else { off }));
    }
}

/// `text` inserted into `s` at char `at`, with a space before (after a word) and after (before a
/// word): the new string and the cursor after the insert.
pub fn insert_spaced(s: &str, at: usize, text: &str) -> (String, usize) {
    let chars: Vec<char> = s.chars().collect();
    let at = at.min(chars.len());
    let text = text.trim();
    let before = at > 0 && !chars[at - 1].is_whitespace();
    let after = at < chars.len() && !chars[at].is_whitespace();
    let mut ins = String::new();
    if before {
        ins.push(' ');
    }
    ins.push_str(text);
    if after {
        ins.push(' ');
    }
    let head: String = chars[..at].iter().collect();
    let tail: String = chars[at..].iter().collect();
    let cursor = at + ins.chars().count() - usize::from(after);
    (format!("{head}{ins}{tail}"), cursor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inserts_with_spaces() {
        assert_eq!(insert_spaced("", 0, " hello "), ("hello".to_string(), 5));
        assert_eq!(insert_spaced("fix it", 6, "now"), ("fix it now".to_string(), 10));
        assert_eq!(insert_spaced("fix it", 3, "all"), ("fix all it".to_string(), 7));
        assert_eq!(insert_spaced("ação é", 4, "olá"), ("ação olá é".to_string(), 8));
    }

    #[test]
    fn cleans_whisper_output() {
        assert_eq!(clean(" Hello there.\n And then.\n"), "Hello there. And then.");
        assert_eq!(clean("[BLANK_AUDIO]\n"), "");
        assert_eq!(clean("[00:00:00.000 --> 00:00:02.000]   Olá mundo\n(music)\n"), "Olá mundo");
    }

    #[test]
    fn wav_header() {
        let w = wav(&[0, 1000, -1000], RATE);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(w.len(), 44 + 6);
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 16_000);
        assert!(rms(&[0; 100]) == 0.0 && rms(&[16000; 100]) > 0.9);
    }

    /// With a stand-in whisper (HARBOR_WHISPER), the program is run the documented way.
    #[test]
    fn runs_whisper_cli() {
        let dir = std::env::temp_dir().join(format!("harbor-voice-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("whisper-cli");
        std::fs::write(&bin, "#!/bin/sh\necho \"$@\" > \"$(dirname \"$0\")/args\"\necho ' Hello from whisper.'\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let wavf = dir.join("a.wav");
        std::fs::write(&wavf, wav(&[0; 16000], RATE)).unwrap();
        let mut cmd = Command::new(&bin);
        cmd.args(["-m", "model.bin", "-f"]).arg(&wavf).args(["-l", "pt", "-nt", "-np"]);
        let out = crate::git::output_within(&mut cmd, Duration::from_secs(5)).unwrap();
        assert_eq!(clean(&String::from_utf8_lossy(&out.stdout)), "Hello from whisper.");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
