//! Voice input: the composer's mic (and its shortcut) records from the default input and
//! transcribes into the composer at the cursor, to edit before sending (never sent by itself).
//!
//! Recording is a `pw-record` (PipeWire) or `parecord` (PulseAudio) child writing raw 16 kHz
//! mono s16 to a pipe: no audio library. Transcription is local, private and free: whisper.cpp,
//! compiled into Harbor (whisper-rs), with a ggml model from Settings › Voice (tiny, base or
//! small, downloaded into Harbor's data folder; the first dictation downloads base by itself).
//! HARBOR_WHISPER names an external `whisper-cli` to use instead. Phones without a recogniser
//! of their own send their recording here (`POST /v1/transcribe`, api.rs), and it's
//! transcribed the same way.

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

/// The model the first dictation downloads when there is none yet.
pub const DEFAULT_MODEL: &str = "base";

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

/// What transcribes.
pub enum Engine {
    /// whisper.cpp compiled into Harbor.
    Builtin,
    /// An external whisper.cpp command line program.
    Cli(PathBuf),
}

/// The transcriber: a `whisper-cli` named by HARBOR_WHISPER, else the built-in whisper.cpp,
/// else (a CPU the built-in one can't run on) a `whisper-cli` on the PATH.
pub fn engine() -> Option<Engine> {
    if let Some(p) = std::env::var_os("HARBOR_WHISPER").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(Engine::Cli(p));
    }
    if builtin_runs() {
        return Some(Engine::Builtin);
    }
    on_path(&["whisper-cli", "whisper-cpp", "whisper.cpp"]).map(Engine::Cli)
}

/// Whether this CPU has what the built-in whisper.cpp was compiled for (.cargo/config.toml).
fn builtin_runs() -> bool {
    #[cfg(target_arch = "x86_64")]
    return is_x86_feature_detected!("avx") && is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") && is_x86_feature_detected!("f16c");
    #[cfg(not(target_arch = "x86_64"))]
    true
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

/// Why this PC can't transcribe, if it can't (a missing model isn't a reason: it downloads).
pub fn missing() -> Option<String> {
    engine().is_none().then(|| "This CPU lacks AVX2, which Harbor's speech recogniser needs. Set HARBOR_WHISPER to a whisper-cli built for it.".into())
}

/// Why the mic can't record here, if it can't.
pub fn cant_record() -> Option<String> {
    recorder().is_none().then(|| "Can't record: neither pw-record (PipeWire) nor parecord (PulseAudio) is on this PC.".into())
}

/// The model to transcribe with. When there's none yet, the default one starts downloading and
/// the error says how far along it is.
fn ready_model() -> Result<String, String> {
    if let Some(m) = current_model() {
        return Ok(m);
    }
    if let Some((name, e)) = take_download_error() {
        return Err(format!("Couldn't download the {name} speech model: {e}"));
    }
    if downloading().is_none() {
        start_download(DEFAULT_MODEL);
    }
    let (name, done, total) = downloading().unwrap_or((DEFAULT_MODEL.into(), 0, 0));
    Err(format!("Getting the {name} speech model ({} of {}); try again when it's done.", megabytes(done), megabytes(total)))
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

/// Transcribes a WAV file (16-bit PCM; a phone's recording): the text, or why not.
pub fn transcribe(wav: &Path, lang: &str) -> Result<String, String> {
    let bytes = std::fs::read(wav).map_err(|e| e.to_string())?;
    transcribe_samples(&wav_samples(&bytes)?, lang)
}

/// whisper.cpp's command line program on a WAV file (16 kHz mono).
fn transcribe_cli(bin: &Path, model: &Path, wav: &Path, lang: &str) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.arg("-m").arg(model).arg("-f").arg(wav).args(["-l", lang, "-t", &threads().to_string(), "-nt", "-np"]);
    let out = crate::git::output_within(&mut cmd, TRANSCRIBE_TIMEOUT).map_err(|e| format!("{}: {e}", bin.display()))?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{} failed: {}", bin.display(), e.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no output").trim()));
    }
    Ok(clean(&String::from_utf8_lossy(&out.stdout)))
}

/// The built-in whisper.cpp on 16 kHz mono samples.
fn transcribe_builtin(model: &Path, samples: &[i16], lang: &str) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
    // whisper.cpp logs every step to stderr; with no log backend this silences it.
    whisper_rs::install_logging_hooks();
    let mut cp = WhisperContextParameters::default();
    cp.use_gpu = false;
    let ctx = WhisperContext::new_with_params(model, cp).map_err(|e| format!("Couldn't load the speech model ({e:?}). Remove it in Settings › Voice and download it again."))?;
    let mut state = ctx.create_state().map_err(|e| format!("Couldn't start the speech recogniser: {e:?}"))?;
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_n_threads(threads() as _);
    p.set_language(Some(lang));
    p.set_no_timestamps(true);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_special(false);
    p.set_print_timestamps(false);
    let pcm: Vec<f32> = samples.iter().map(|s| *s as f32 / 32768.0).collect();
    state.full(p, &pcm).map_err(|e| format!("Transcription failed: {e:?}"))?;
    let text: Vec<String> = state.as_iter().filter_map(|seg| seg.to_str_lossy().ok().map(|t| t.into_owned())).collect();
    Ok(clean(&text.join("\n")))
}

fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get().clamp(1, 4)).unwrap_or(2)
}

/// The samples of a 16-bit PCM WAV, as 16 kHz mono (other rates and stereo are converted).
pub fn wav_samples(b: &[u8]) -> Result<Vec<i16>, String> {
    let bad = || "The recording isn't a 16-bit PCM WAV file.".to_string();
    if b.len() < 12 || &b[..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err(bad());
    }
    let (mut channels, mut rate) = (0usize, 0u32);
    let mut i = 12;
    while i + 8 <= b.len() {
        let len = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        let body = &b[i + 8..(i + 8).saturating_add(len).min(b.len())];
        match &b[i..i + 4] {
            b"fmt " if body.len() >= 16 => {
                let format = u16::from_le_bytes([body[0], body[1]]);
                channels = u16::from_le_bytes([body[2], body[3]]) as usize;
                rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                let bits = u16::from_le_bytes([body[14], body[15]]);
                if !(format == 1 || format == 0xFFFE) || bits != 16 || channels == 0 || rate == 0 {
                    return Err(bad());
                }
            }
            b"data" if channels > 0 => {
                let frames: Vec<i16> = body
                    .chunks_exact(2 * channels)
                    .map(|f| (f.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as i32).sum::<i32>() / channels as i32) as i16)
                    .collect();
                return Ok(resample(&frames, rate, RATE));
            }
            _ => {}
        }
        i += 8 + len + (len & 1);
    }
    Err(bad())
}

/// Linear resampling (only for phones that record at another rate).
fn resample(s: &[i16], from: u32, to: u32) -> Vec<i16> {
    if from == to || s.is_empty() {
        return s.to_vec();
    }
    let n = (s.len() as u64 * to as u64 / from as u64) as usize;
    (0..n)
        .map(|i| {
            let x = i as f64 * from as f64 / to as f64;
            let (j, f) = (x as usize, x.fract());
            let a = s[j.min(s.len() - 1)] as f64;
            let b = s[(j + 1).min(s.len() - 1)] as f64;
            (a + (b - a) * f) as i16
        })
        .collect()
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

/// Transcribes 16 kHz mono samples on this thread.
pub fn transcribe_samples(samples: &[i16], lang: &str) -> Result<String, String> {
    if samples.len() < RATE as usize / 4 {
        return Err("Nothing was recorded (check the input device).".into());
    }
    let engine = engine().ok_or_else(|| missing().unwrap_or_default())?;
    let model = model_path(&ready_model()?);
    let lang = if LANGS.iter().any(|l| l.0 == lang) { lang } else { "auto" };
    match engine {
        Engine::Builtin => transcribe_builtin(&model, samples, lang),
        Engine::Cli(bin) => {
            let path = std::env::temp_dir().join(format!("harbor-voice-{}-{}.wav", std::process::id(), crate::store::new_uuid()));
            std::fs::write(&path, wav(samples, RATE)).map_err(|e| e.to_string())?;
            let r = transcribe_cli(&bin, &model, &path, lang);
            let _ = std::fs::remove_file(&path);
            r
        }
    }
}

// ------------------------------------------------------------------ model download

struct Download {
    name: String,
    total: u64,
    done: Arc<AtomicU64>,
    result: Arc<Mutex<Option<Result<(), String>>>>,
}

/// The one model download (Settings, a first dictation, or a phone's recording started it).
static DOWNLOAD: Mutex<Option<Download>> = Mutex::new(None);

/// Starts downloading model `name`, unless a download is already under way.
pub fn start_download(name: &str) {
    let mut d = DOWNLOAD.lock().unwrap();
    if d.as_ref().is_some_and(|d| d.result.lock().unwrap().is_none()) {
        return;
    }
    *d = Some(download(name));
}

/// The download under way: (model, bytes so far, total bytes).
pub fn downloading() -> Option<(String, u64, u64)> {
    let mut g = DOWNLOAD.lock().unwrap();
    let d = g.as_ref()?;
    let finished = match &*d.result.lock().unwrap() {
        None => return Some((d.name.clone(), d.done.load(Ordering::Relaxed), d.total)),
        Some(r) => r.is_ok(),
    };
    if finished {
        *g = None;
    }
    None
}

/// A download that failed: (model, why), once.
pub fn take_download_error() -> Option<(String, String)> {
    let mut g = DOWNLOAD.lock().unwrap();
    let e = match g.as_ref().map(|d| d.result.lock().unwrap().clone()) {
        Some(Some(Err(e))) => (g.as_ref().unwrap().name.clone(), e),
        _ => return None,
    };
    *g = None;
    Some(e)
}

/// Downloads a model from whisper.cpp's own Hugging Face repo, into a temporary name first.
fn download(name: &str) -> Download {
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
                std::thread::sleep(Duration::from_millis(400));
            };
            if !status.success() {
                let mut e = String::new();
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut e);
                }
                let _ = std::fs::remove_file(&tmp);
                let e = e.trim().trim_start_matches("curl: ");
                return Err(if e.is_empty() { "the download stopped".into() } else { e.into() });
            }
            let len = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
            if total > 0 && len != total {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("download incomplete ({len} of {total} bytes)"));
            }
            std::fs::rename(&tmp, &dst).map_err(|e| e.to_string())
        })();
        *result.lock().unwrap() = Some(r);
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
    /// A recording waiting for the speech model to finish downloading.
    pending: Option<(i64, Vec<i16>)>,
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
            self.voice.busy = Some((k, Instant::now()));
            if current_model().is_none() && engine().is_some() && samples.len() >= RATE as usize / 4 {
                // The model is still on its way: transcribed once it's here (voice_poll).
                start_download(DEFAULT_MODEL);
                self.voice.pending = Some((k, samples));
                return;
            }
            self.voice_transcribe(k, samples, ctx);
            return;
        }
        if self.voice.busy.is_some() {
            return;
        }
        if let Some(why) = cant_record().or_else(missing) {
            crate::picker::show_toast(ctx, why);
            return;
        }
        if current_model().is_none() {
            // The first dictation: the default model downloads while you speak.
            start_download(DEFAULT_MODEL);
        }
        let c = ctx.clone();
        match Recording::start(move || c.request_repaint()) {
            Ok(r) => self.voice.rec = Some((key, r)),
            Err(e) => crate::picker::show_toast(ctx, format!("Couldn't record: {e}")),
        }
    }

    fn voice_transcribe(&mut self, key: i64, samples: Vec<i16>, ctx: &egui::Context) {
        let (tx, _) = self.voice_chan();
        let (lang, _) = config();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let _ = tx.send((key, transcribe_samples(&samples, &lang)));
            ctx.request_repaint();
        });
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
        if let Some((name, e)) = take_download_error() {
            crate::picker::show_toast(ctx, format!("Couldn't download the {name} speech model: {e}"));
            if self.voice.pending.take().is_some() {
                self.voice.busy = None;
            }
        }
        if self.voice.pending.is_some() {
            if current_model().is_some() {
                let (k, samples) = self.voice.pending.take().unwrap();
                self.voice_transcribe(k, samples, ctx);
            } else {
                if downloading().is_none() {
                    start_download(DEFAULT_MODEL);
                }
                ctx.request_repaint_after(Duration::from_millis(400));
            }
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
            if let Some(p) = model_progress() {
                ui.label(egui::RichText::new(format!("Speech model {p}")).color(t.subtle()).size(12.5));
            }
            ui.ctx().request_repaint_after(Duration::from_millis(100));
            return;
        }
        if busy {
            let (rect, _) = ui.allocate_exact_size(egui::vec2(18.0, 20.0), egui::Sense::hover());
            crate::widgets::spinner(ui.painter(), rect.center(), 6.0, t.subtle());
            let what = match model_progress().filter(|_| self.voice.pending.is_some()) {
                Some(p) => format!("Getting the speech model… {p}"),
                None => "Transcribing…".into(),
            };
            ui.label(egui::RichText::new(what).color(t.subtle()).size(12.5));
            return;
        }
        let tip = match cant_record().or_else(missing) {
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
            let engine = engine();
            w::setting_row(
                ui,
                "Speech recognition",
                &match &engine {
                    Some(Engine::Builtin) => "whisper.cpp, built into Harbor. Runs on this PC; nothing leaves it.".to_string(),
                    Some(Engine::Cli(b)) => format!("Transcribes with {}.", b.display()),
                    None => missing().unwrap_or_default(),
                },
                |ui| ui.label(egui::RichText::new(if engine.is_some() { "Ready" } else { "Missing" }).color(if engine.is_some() { t.green(900) } else { t.red(900) })),
            );
        });
        ui.add_space(12.0);
        section(ui, "Speech model");
        let dl = downloading();
        if dl.is_some() {
            ctx.request_repaint_after(Duration::from_millis(400));
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
                    if let Some((_, done, total)) = dl.as_ref().filter(|d| d.0 == *name) {
                        let frac = if *total > 0 { *done as f32 / *total as f32 } else { 0.0 };
                        ui.add(egui::ProgressBar::new(frac.min(1.0)).desired_width(140.0).text(format!("{} of {}", megabytes(*done), megabytes(*total))));
                    } else if here {
                        if w::btn("Remove").sm().outline().show(ui).clicked() {
                            action = Some(("remove", name));
                        }
                        if !used && w::btn("Use").sm().outline().show(ui).clicked() {
                            action = Some(("use", name));
                        }
                    } else if w::btn("Download").sm().outline().enabled(dl.is_none()).show(ui).clicked() {
                        action = Some(("download", name));
                    }
                });
            }
        });
        match action {
            Some(("download", name)) => {
                // Used once it's here (until then, whichever model is there).
                start_download(name);
                self.voice_set(None, Some(name));
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
        w::subtle(ui, "Models come from whisper.cpp's own repository on Hugging Face and stay in Harbor's data folder. Without one, the first dictation downloads Base.", "label-12");
        ui.add_space(12.0);
        section(ui, "Language");
        rows(ui, |ui| {
            w::setting_row(ui, "Spoken language", "Detect works for either; picking yours is a little faster and surer.", |ui| {
                let labels: Vec<&str> = LANGS.iter().map(|(code, label)| if *code == "auto" { "Detect" } else { *label }).collect();
                let cur = LANGS.iter().position(|l| l.0 == lang).unwrap_or(0);
                if let Some(i) = w::tabs(ui, &labels, cur) {
                    self.voice_set(Some(LANGS[i].0), None);
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

/// How far the model download is, as "34%".
fn model_progress() -> Option<String> {
    downloading().map(|(_, done, total)| format!("{}%", if total > 0 { done * 100 / total } else { 0 }))
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

    #[test]
    fn reads_wav() {
        let s: Vec<i16> = (0..1600).map(|i| (i * 7) as i16).collect();
        assert_eq!(wav_samples(&wav(&s, RATE)).unwrap(), s);
        // 32 kHz is halved.
        assert_eq!(wav_samples(&wav(&s, 32_000)).unwrap().len(), 800);
        assert!(wav_samples(b"RIFF....WAVEjunk").is_err());
    }

    /// End to end with the built-in whisper.cpp: no model at first (it downloads), then the
    /// WAV at HARBOR_VOICE_TEST_WAV is transcribed. Needs the network; run it with
    /// `XDG_DATA_HOME=<empty dir> cargo test voice::tests::builtin -- --ignored`.
    #[test]
    #[ignore]
    fn builtin_downloads_and_transcribes() {
        let wavf = PathBuf::from(std::env::var_os("HARBOR_VOICE_TEST_WAV").expect("HARBOR_VOICE_TEST_WAV"));
        assert!(matches!(engine(), Some(Engine::Builtin)));
        if current_model().is_none() {
            let e = transcribe(&wavf, "en").unwrap_err();
            assert!(e.starts_with("Getting the base speech model"), "{e}");
            while downloading().is_some() {
                std::thread::sleep(Duration::from_secs(1));
            }
            assert!(take_download_error().is_none());
        }
        let t0 = Instant::now();
        let text = transcribe(&wavf, "en").unwrap();
        eprintln!("transcribed in {:?}: {text}", t0.elapsed());
        assert!(!text.trim().is_empty());
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
