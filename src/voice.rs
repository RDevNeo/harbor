//! Voice input: the composer's mic (and its shortcut) records from the default input and
//! transcribes into the composer at the cursor, to edit before sending (never sent by itself).
//!
//! Recording is a `pw-record` (PipeWire) or `parecord` (PulseAudio) child writing raw 16 kHz
//! mono s16 to a pipe: no audio library. Transcription is private and free, on the user's own
//! PCs: Parakeet by default, Whisper (tiny, base or small) as the fallback, both through
//! sherpa-onnx built into Harbor (parakeet.rs); dictate.rs picks the engine, routes each
//! recording to the mesh PC with the most free memory and cleans the text up. Models download
//! into Harbor's data folder on first use. HARBOR_WHISPER names an external whisper.cpp
//! `whisper-cli` to use instead of the built-in Whisper (with a ggml model in `<data>/whisper`). Phones without a recogniser of their own send their recording to
//! their hub (`POST /v1/transcribe`, api.rs), and it goes the same way.

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
/// "auto" detects it per phrase, so languages can be mixed; a fixed one makes Whisper write
/// everything in it (translating the rest).
pub const LANGS: &[(&str, &str)] = &[("auto", "Detect automatically"), ("en", "English"), ("pt", "Portuguese")];

/// (name, what it's like, download size in bytes): Whisper's multilingual models (int8).
pub const MODELS: &[(&str, &str, u64)] = &[
    ("tiny", "Fastest, rougher", 103_609_903),
    ("base", "Fast, good for dictation", 160_609_290),
    ("small", "Slower, most accurate", 375_485_327),
];

/// Each Whisper model's files (sherpa-onnx's int8 export of OpenAI's Whisper): (file, size,
/// SHA-256 or "").
fn model_files(name: &str) -> Vec<(String, u64, &'static str)> {
    let (enc, dec) = match name {
        "tiny" => ((12_937_772, "d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434"), (89_855_401, "d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925")),
        "base" => ((29_120_534, "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11"), (130_672_026, "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d")),
        "small" => ((112_442_483, "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9"), (262_226_114, "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee")),
        _ => return vec![],
    };
    vec![(format!("{name}-encoder.int8.onnx"), enc.0, enc.1), (format!("{name}-decoder.int8.onnx"), dec.0, dec.1), (format!("{name}-tokens.txt"), 816_730, "")]
}

/// The model the first dictation downloads when there is none yet.
pub const DEFAULT_MODEL: &str = "base";

/// The language and model, kept for the API threads (phones' recordings) too.
static CONFIG: Mutex<(String, String)> = Mutex::new((String::new(), String::new()));

/// The built-in Whisper models' folder (one subfolder per model).
pub fn models_dir() -> PathBuf {
    crate::store::data_dir().join("whisper-onnx")
}

pub fn model_dir(name: &str) -> PathBuf {
    models_dir().join(name)
}

pub fn installed(name: &str) -> bool {
    let files = model_files(name);
    !files.is_empty() && files.iter().all(|(f, size, _)| std::fs::metadata(model_dir(name).join(f)).is_ok_and(|m| m.len() == *size))
}

/// A whisper.cpp ggml model for HARBOR_WHISPER's `whisper-cli` (`<data>/whisper/ggml-*.bin`).
fn ggml_model(name: &str) -> Option<PathBuf> {
    let dir = crate::store::data_dir().join("whisper");
    std::iter::once(name).chain(MODELS.iter().map(|m| m.0)).map(|n| dir.join(format!("ggml-{n}.bin"))).find(|p| std::fs::metadata(p).is_ok_and(|m| m.len() > 1_000_000))
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

/// What transcribes with Whisper.
pub enum Engine {
    /// Built into Harbor (sherpa-onnx).
    Builtin,
    /// An external whisper.cpp command line program (HARBOR_WHISPER).
    Cli(PathBuf),
}

/// The Whisper transcriber: a `whisper-cli` named by HARBOR_WHISPER, else the built-in one.
pub fn engine() -> Engine {
    match std::env::var_os("HARBOR_WHISPER").map(PathBuf::from).filter(|p| p.is_file()) {
        Some(p) => Engine::Cli(p),
        None => Engine::Builtin,
    }
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

/// Why the mic can't record here, if it can't.
pub fn cant_record() -> Option<String> {
    recorder().is_none().then(|| "Can't record: neither pw-record (PipeWire) nor parecord (PulseAudio) is on this PC.".into())
}

/// Why a transcription didn't happen.
#[derive(Debug)]
pub enum Fail {
    /// A model is downloading: try again when it's done (the text says how far along).
    Wait(String),
    Err(String),
}

impl Fail {
    pub fn text(&self) -> &str {
        match self {
            Fail::Wait(s) | Fail::Err(s) => s,
        }
    }
}

/// `name` is needed and not there: starts its download (unless one runs) and says how far along
/// it is, or why the last try failed.
pub fn wait_for(name: &str) -> Fail {
    if let Some((n, e)) = take_download_error() {
        return Fail::Err(format!("Couldn't download the {} speech model: {e}", label(&n)));
    }
    if downloading().is_none() {
        start_download(name);
    }
    let (n, done, total) = downloading().unwrap_or((name.into(), 0, 0));
    Fail::Wait(format!("Getting the {} speech model ({} of {}); try again when it's done.", label(&n), megabytes(done), megabytes(total)))
}

/// A model's name for people ("parakeet" → "Parakeet").
pub fn label(name: &str) -> String {
    capital(name)
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

/// whisper.cpp's command line program on a WAV file (16 kHz mono).
fn transcribe_cli(bin: &Path, model: &Path, wav: &Path, lang: &str) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.arg("-m").arg(model).arg("-f").arg(wav).args(["-l", lang, "-t", &threads().to_string(), "-nt", "-np"]);
    // The dictionary's terms as the initial prompt: Whisper leans towards their spellings.
    let terms: Vec<String> = crate::dictate::dictionary().into_iter().map(|e| e.term).take(40).collect();
    if !terms.is_empty() {
        cmd.arg("--prompt").arg(format!("{}.", terms.join(", ")));
    }
    let out = crate::git::output_within(&mut cmd, TRANSCRIBE_TIMEOUT).map_err(|e| format!("{}: {e}", bin.display()))?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{} failed: {}", bin.display(), e.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no output").trim()));
    }
    Ok(clean(&String::from_utf8_lossy(&out.stdout)))
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
                    .map(|f| (f.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as i64).sum::<i64>() / channels as i64) as i16)
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

/// Whisper on 16 kHz mono samples, on this thread. Without a model, the default one starts
/// downloading (`Fail::Wait`).
pub fn whisper(samples: &[i16], lang: &str) -> Result<String, Fail> {
    let lang = if LANGS.iter().any(|l| l.0 == lang) { lang } else { "auto" };
    match engine() {
        Engine::Builtin => {
            let name = current_model().ok_or_else(|| wait_for(DEFAULT_MODEL))?;
            crate::parakeet::whisper(&model_dir(&name), &name, samples, lang).map_err(Fail::Err)
        }
        Engine::Cli(bin) => {
            let (_, picked) = config();
            let model = ggml_model(&picked).ok_or_else(|| Fail::Err(format!("HARBOR_WHISPER is set: put a whisper.cpp ggml model (ggml-base.bin) in {}.", crate::store::data_dir().join("whisper").display())))?;
            let path = std::env::temp_dir().join(format!("harbor-voice-{}-{}.wav", std::process::id(), crate::store::new_uuid()));
            std::fs::write(&path, wav(samples, RATE)).map_err(|e| Fail::Err(e.to_string()))?;
            let r = transcribe_cli(&bin, &model, &path, lang);
            let _ = std::fs::remove_file(&path);
            r.map_err(Fail::Err)
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

/// One file of a model: where from, where to, its size and SHA-256 ("" to check the size only).
pub struct Part {
    pub url: String,
    pub dst: PathBuf,
    pub size: u64,
    pub sha256: &'static str,
}

/// Starts downloading model `name` ("parakeet", or a Whisper model), unless a download is
/// already under way.
pub fn start_download(name: &str) {
    let mut d = DOWNLOAD.lock().unwrap();
    if d.as_ref().is_some_and(|d| d.result.lock().unwrap().is_none()) {
        return;
    }
    let parts = if name == "parakeet" {
        crate::parakeet::parts()
    } else {
        model_files(name)
            .into_iter()
            .map(|(f, size, sha256)| Part { url: format!("https://huggingface.co/csukuangfj/sherpa-onnx-whisper-{name}/resolve/main/{f}"), dst: model_dir(name).join(&f), size, sha256 })
            .collect()
    };
    *d = Some(download(name, parts));
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

/// Downloads a model's files, each into a temporary name first; files already there are kept.
fn download(name: &str, parts: Vec<Part>) -> Download {
    let total = parts.iter().map(|p| p.size).sum();
    let d = Download { name: name.into(), total, done: Arc::new(AtomicU64::new(0)), result: Arc::new(Mutex::new(None)) };
    let (done, result) = (d.done.clone(), d.result.clone());
    std::thread::spawn(move || {
        let r = (|| -> Result<(), String> {
            let mut base = 0;
            for part in &parts {
                if std::fs::metadata(&part.dst).is_ok_and(|m| m.len() == part.size) {
                    base += part.size;
                    continue;
                }
                fetch(part, |n| done.store(base + n, Ordering::Relaxed))?;
                base += part.size;
            }
            Ok(())
        })();
        *result.lock().unwrap() = Some(r);
    });
    d
}

/// One file with curl, its size and checksum checked; `progress` gets the bytes so far.
fn fetch(part: &Part, progress: impl Fn(u64)) -> Result<(), String> {
    let tmp = part.dst.with_extension("part");
    if let Some(dir) = part.dst.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut child = Command::new("curl")
        .args(["-fsSL", "--retry", "2", "--connect-timeout", "20", "-o"])
        .arg(&tmp)
        .arg(&part.url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl: {e}"))?;
    let status = loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            break st;
        }
        progress(std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0));
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
    if part.size > 0 && len != part.size {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("download incomplete ({len} of {} bytes)", part.size));
    }
    if !part.sha256.is_empty() && sha256_file(&tmp).as_deref() != Some(part.sha256) {
        let _ = std::fs::remove_file(&tmp);
        return Err("the download was damaged (checksum mismatch); try again".into());
    }
    std::fs::rename(&tmp, &part.dst).map_err(|e| e.to_string())
}

fn sha256_file(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Some(ctx.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

pub fn megabytes(b: u64) -> String {
    format!("{} MB", b / 1_000_000)
}

// ------------------------------------------------------------------ the composer's mic

/// A finished transcription for a composer, or a recording handed back to wait for a model.
enum Back {
    /// The text, and whether it ended with the send command.
    Done(i64, Result<(String, bool), String>),
    Wait(i64, Vec<i16>),
}

#[derive(Default)]
pub struct State {
    /// Recording for this composer (chat id or app::DRAFT).
    pub rec: Option<(i64, Recording)>,
    /// Transcribing for this composer, since.
    pub busy: Option<(i64, Instant)>,
    chan: Option<(Sender<Back>, Receiver<Back>)>,
    /// A recording waiting for the speech model to finish downloading.
    pending: Option<(i64, Vec<i16>)>,
    /// When the cleanup account was last mirrored for the API threads.
    account_at: Option<Instant>,
    /// A dictation that ended with "press enter": its composer sends (chat.rs).
    pub send: Option<i64>,
    /// Settings › Voice › Dictionary: the entry being added or edited (its index), its fields.
    dict_edit: Option<usize>,
    dict_term: String,
    dict_sounds: String,
}

impl App {
    /// The voice settings from the store, mirrored for the API threads (called at start).
    pub fn voice_load(&self) {
        // `voice_lang2` (0.74.2): a language picked before then forced Whisper into it (translating
        // the other one spoken), so every PC starts again from Detect.
        *CONFIG.lock().unwrap() = (self.store.get("voice_lang2").unwrap_or_default(), self.store.get("voice_model").unwrap_or_default());
        let keep = self.store.get("voice_keep_min").and_then(|v| v.parse().ok()).unwrap_or(5);
        let engine = self.store.get("voice_engine").unwrap_or_default();
        crate::dictate::set(Some(&engine), Some(self.store.get("voice_cleanup").as_deref() != Some("0")), Some(keep), false);
        let dict = self.store.get("voice_dict").and_then(|d| serde_json::from_str(&d).ok()).map(|v| crate::dictwords::parse(&v)).unwrap_or_default();
        crate::dictate::set_words(Some(self.store.get("voice_commands").as_deref() != Some("0")), Some(dict), false);
    }

    /// Settings › Voice's commands switch and dictionary.
    fn voice_set_words(&self, commands: Option<bool>, dict: Option<Vec<crate::dictwords::Entry>>) {
        if let Some(c) = commands {
            self.store.set("voice_commands", if c { "1" } else { "0" });
        }
        if let Some(d) = dict {
            self.store.set("voice_dict", &crate::dictwords::to_json(&d).to_string());
        }
        self.voice_load();
    }

    pub fn voice_set(&self, lang: Option<&str>, model: Option<&str>) {
        if let Some(l) = lang {
            self.store.set("voice_lang2", l);
        }
        if let Some(m) = model {
            self.store.set("voice_model", m);
        }
        self.voice_load();
    }

    /// Settings › Voice's engine, cleanup and keep-loaded choices.
    fn voice_set_more(&self, engine: Option<&str>, cleanup: Option<bool>, keep_min: Option<u64>) {
        if let Some(e) = engine {
            self.store.set("voice_engine", e);
        }
        if let Some(c) = cleanup {
            self.store.set("voice_cleanup", if c { "1" } else { "0" });
        }
        if let Some(m) = keep_min {
            self.store.set("voice_keep_min", &m.to_string());
        }
        self.voice_load();
    }

    /// The mic button or its shortcut: starts recording into composer `key`, or stops and
    /// transcribes.
    pub fn voice_toggle(&mut self, key: i64, ctx: &egui::Context) {
        if let Some((k, rec)) = self.voice.rec.take() {
            let samples = rec.stop();
            self.voice.busy = Some((k, Instant::now()));
            self.voice_transcribe(k, samples, ctx);
            return;
        }
        if self.voice.busy.is_some() {
            return;
        }
        if let Some(why) = cant_record() {
            crate::picker::show_toast(ctx, why);
            return;
        }
        // While you speak: the model loads, or (the first dictation) downloads.
        if crate::dictate::engine() == "parakeet" {
            if crate::parakeet::installed() {
                crate::parakeet::preload();
            } else {
                start_download("parakeet");
            }
        } else if current_model().is_none() {
            start_download(DEFAULT_MODEL);
        }
        let c = ctx.clone();
        match Recording::start(move || c.request_repaint()) {
            Ok(r) => self.voice.rec = Some((key, r)),
            Err(e) => crate::picker::show_toast(ctx, format!("Couldn't record: {e}")),
        }
    }

    /// Transcribes on a thread: the best PC of the mesh, then the cleanup.
    fn voice_transcribe(&mut self, key: i64, samples: Vec<i16>, ctx: &egui::Context) {
        let tx = self.voice.chan.get_or_insert_with(channel).0.clone();
        let (lang, _) = config();
        let (ctx, hub) = (ctx.clone(), self.api.hub.clone());
        std::thread::spawn(move || {
            let back = match crate::dictate::transcribe(&hub, &samples, &lang, crate::dictate::cleanup_on(), true, false) {
                Ok(d) => Back::Done(key, Ok((d.text, d.send))),
                Err(Fail::Wait(_)) => Back::Wait(key, samples),
                Err(Fail::Err(e)) => Back::Done(key, Err(e)),
            };
            let _ = tx.send(back);
            ctx.request_repaint();
        });
    }

    /// Transcripts that came back: into their composer at the cursor (from `App::tick`).
    pub fn voice_poll(&mut self, ctx: &egui::Context) {
        if self.voice.rec.as_ref().is_some_and(|(_, r)| r.too_long()) {
            let key = self.voice.rec.as_ref().map(|r| r.0).unwrap_or(crate::app::DRAFT);
            self.voice_toggle(key, ctx);
        }
        // The cleanup's account, for the API threads too (every 10 s).
        if self.voice.account_at.is_none_or(|t| t.elapsed() > Duration::from_secs(10)) {
            self.voice.account_at = Some(Instant::now());
            let a = self
                .accounts
                .iter()
                .find(|a| a.id == "claude" && a.installed() && a.logged_in == Some(true))
                .filter(|a| self.blocked(&a.id).is_none())
                .map(|a| (a.bin_str(), a.env()));
            crate::dictate::set_account(a);
        }
        // Settings a phone changed.
        if let Some((cleanup, keep, commands, dict)) = crate::dictate::take_dirty() {
            self.store.set("voice_cleanup", if cleanup { "1" } else { "0" });
            self.store.set("voice_keep_min", &keep.to_string());
            self.store.set("voice_commands", if commands { "1" } else { "0" });
            self.store.set("voice_dict", &crate::dictwords::to_json(&dict).to_string());
        }
        if let Some((name, e)) = take_download_error() {
            crate::picker::show_toast(ctx, format!("Couldn't download the {} speech model: {e}", label(&name)));
            if self.voice.pending.take().is_some() {
                self.voice.busy = None;
            }
        }
        if self.voice.pending.is_some() {
            if crate::dictate::ready_here() {
                let (k, samples) = self.voice.pending.take().unwrap();
                self.voice_transcribe(k, samples, ctx);
            } else {
                if downloading().is_none() {
                    start_download(if crate::dictate::engine() == "parakeet" { "parakeet" } else { DEFAULT_MODEL });
                }
                ctx.request_repaint_after(Duration::from_millis(400));
            }
        }
        let got: Vec<Back> = match &self.voice.chan {
            Some((_, rx)) => rx.try_iter().collect(),
            None => return,
        };
        for b in got {
            match b {
                Back::Wait(key, samples) => {
                    // The model is still on its way: transcribed once it's here (above).
                    self.voice.pending = Some((key, samples));
                }
                Back::Done(key, r) => {
                    self.voice.busy = None;
                    match r {
                        Ok((text, send)) => {
                            if !text.trim().is_empty() {
                                self.voice_insert(ctx, key, &text);
                            }
                            if send {
                                self.voice.send = Some(key);
                                ctx.request_repaint();
                            } else if text.trim().is_empty() {
                                crate::picker::show_toast(ctx, "Didn't catch any words.".into());
                            }
                        }
                        Err(e) => crate::picker::show_toast(ctx, e),
                    }
                }
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
            let what = match model_progress().filter(|_| self.voice.pending.is_some() || !crate::dictate::ready_here()) {
                Some(p) => format!("Getting the speech model… {p}"),
                None => "Transcribing…".into(),
            };
            ui.label(egui::RichText::new(what).color(t.subtle()).size(12.5));
            return;
        }
        let tip = match cant_record() {
            Some(why) => why,
            None => hint,
        };
        if crate::widgets::btn(crate::icons::MIC).muted().icon_sm().show(ui).tip(tip).clicked() {
            self.voice_toggle(key, ui.ctx());
        }
    }
}

impl App {
    /// Settings › Voice: what's installed, the engine and its models (download or remove), the
    /// language, cleanup and how long the model stays loaded.
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
            let parakeet = crate::dictate::engine() == "parakeet";
            w::setting_row(ui, "Engine", if parakeet { "Parakeet: fast and accurate in 25 European languages, detects the language itself. Whisper takes over for other languages." } else { "Whisper: many languages, slower and less accurate." }, |ui| {
                if let Some(i) = w::tabs(ui, &["Parakeet", "Whisper"], if parakeet { 0 } else { 1 }) {
                    self.voice_set_more(Some(if i == 0 { "parakeet" } else { "whisper" }), None, None);
                }
            });
            if let Engine::Cli(b) = engine() {
                w::separator(ui);
                w::setting_row(ui, "Whisper", &format!("Transcribes with {} (HARBOR_WHISPER).", b.display()), |ui| ui.label(egui::RichText::new("Ready").color(t.green(900))));
            }
        });
        let dl = downloading();
        if dl.is_some() {
            ctx.request_repaint_after(Duration::from_millis(400));
        }
        let progress_bar = |ui: &mut egui::Ui, done: u64, total: u64| {
            let frac = if total > 0 { done as f32 / total as f32 } else { 0.0 };
            ui.add(egui::ProgressBar::new(frac.min(1.0)).desired_width(140.0).text(format!("{} of {}", megabytes(done), megabytes(total))));
        };
        ui.add_space(12.0);
        section(ui, "Parakeet model");
        let mut pk: Option<&str> = None;
        rows(ui, |ui| {
            let here = crate::parakeet::installed();
            let state = if crate::parakeet::loaded() { "  ·  in memory" } else { "" };
            let desc = format!("Parakeet TDT 0.6B v3, int8 · {}{}", megabytes(crate::parakeet::size()), if here { "" } else { " · downloads by itself on the first dictation" });
            w::setting_row(ui, &format!("Parakeet{state}"), &desc, |ui| {
                if let Some((_, done, total)) = dl.as_ref().filter(|d| d.0 == "parakeet") {
                    progress_bar(ui, *done, *total);
                } else if here {
                    if w::btn("Remove").sm().outline().show(ui).clicked() {
                        pk = Some("remove");
                    }
                } else if w::btn("Download").sm().outline().enabled(dl.is_none()).show(ui).clicked() {
                    pk = Some("download");
                }
            });
        });
        match pk {
            Some("download") => start_download("parakeet"),
            Some("remove") => crate::parakeet::remove(),
            _ => {}
        }
        ui.add_space(12.0);
        section(ui, if crate::dictate::engine() == "parakeet" { "Whisper models (fallback)" } else { "Whisper models" });
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
                        progress_bar(ui, *done, *total);
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
                let _ = std::fs::remove_dir_all(model_dir(name));
                if model == name {
                    self.voice_set(None, Some(""));
                }
            }
            _ => {}
        }
        w::subtle(
            ui,
            "Parakeet TDT 0.6B v3 is NVIDIA's model (CC-BY-4.0), run with sherpa-onnx (Apache-2.0); Whisper is OpenAI's (MIT), in sherpa-onnx's export. Both download from Hugging Face and stay in Harbor's data folder.",
            "label-12",
        );
        ui.add_space(12.0);
        section(ui, "Dictation");
        rows(ui, |ui| {
            let mut on = crate::dictate::cleanup_on();
            let changed = w::setting_row(ui, "Clean up dictation", "Removes filler words and false starts, fixes punctuation and applies spoken corrections (\"no wait, I meant…\"), through this PC's Claude account. Never adds anything; the raw text when it can't.", |ui| w::toggle(ui, &mut on).changed());
            if changed {
                self.voice_set_more(None, Some(on), None);
            }
            w::separator(ui);
            let mut cmds = crate::dictate::commands_on();
            let changed = w::setting_row(ui, "Voice commands", "End with \"press enter\" or say \"send\" (\"aperta enter\", \"enviar\") as the last sentence to send the message. \"New line\" (\"nova linha\") alone makes a line break. Anywhere else these words are just text.", |ui| w::toggle(ui, &mut cmds).changed());
            if changed {
                self.voice_set_words(Some(cmds), None);
            }
            w::separator(ui);
            let keeps: [(u64, &str); 5] = [(0, "Off"), (1, "1 min"), (5, "5 min"), (15, "15 min"), (60, "1 h")];
            let cur = keeps.iter().position(|k| k.0 == crate::parakeet::keep_min()).unwrap_or(2);
            w::setting_row(ui, "Keep speech model loaded", "After the last dictation, then it's freed: no memory or CPU while idle.", |ui| {
                let labels: Vec<&str> = keeps.iter().map(|k| k.1).collect();
                if let Some(i) = w::tabs(ui, &labels, cur) {
                    self.voice_set_more(None, None, Some(keeps[i].0));
                }
            });
        });
        ui.add_space(12.0);
        self.voice_dictionary(ui);
        ui.add_space(12.0);
        section(ui, "Language");
        rows(ui, |ui| {
            w::setting_row(ui, "Spoken language", "Detect: each phrase in the language you spoke it, so you can mix languages. Picking one makes Whisper write everything in it, translating the rest.", |ui| {
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
                "The mic in the composer (or {}) starts and stops dictation; the text goes in at the cursor, to edit before you send. Each recording is transcribed on the PC of your mesh with the most free memory (this one on a near tie). Phones send their recordings here the same way.",
                crate::keys::label(&self.keys.get("voice"))
            ),
            "label-12",
        );
    }
}

impl App {
    /// Settings › Voice › Dictionary: names and terms spelled exactly, each with optional
    /// sound-alikes; add, edit and remove. Phones use this PC's list (GET /v1/voice).
    fn voice_dictionary(&mut self, ui: &mut egui::Ui) {
        use crate::pages::{rows, section};
        use crate::widgets as w;
        section(ui, "Dictionary");
        let mut dict = crate::dictate::dictionary();
        let mut changed = false;
        let (mut edit, mut remove): (Option<usize>, Option<usize>) = (None, None);
        rows(ui, |ui| {
            for (i, e) in dict.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                let desc = if e.sounds.is_empty() { String::new() } else { format!("Sounds like: {}", e.sounds.join(", ")) };
                w::setting_row(ui, &e.term, &desc, |ui| {
                    if w::btn("Remove").sm().outline().show(ui).clicked() {
                        remove = Some(i);
                    }
                    if w::btn("Edit").sm().outline().show(ui).clicked() {
                        edit = Some(i);
                    }
                });
            }
            if !dict.is_empty() {
                w::separator(ui);
            }
            let title = if self.voice.dict_edit.is_some() { "Edit the word" } else { "Add a word" };
            let mut save = false;
            w::setting_row(ui, title, "Spelled exactly like this when you say it (\"SpokPay\"). Sounds like, optional: how it comes out wrong, comma-separated (\"spoke pay\").", |ui| {
                let label = if self.voice.dict_edit.is_some() { "Save" } else { "Add" };
                save |= w::btn(label).sm().enabled(!self.voice.dict_term.trim().is_empty()).show(ui).clicked();
                ui.vertical(|ui| {
                    let a = w::input(ui, &mut self.voice.dict_term, "Word or name", false, 150.0);
                    ui.add_space(4.0);
                    let b = w::input(ui, &mut self.voice.dict_sounds, "Sounds like", false, 150.0);
                    save |= (a.lost_focus() || b.lost_focus()) && ui.input(|i| i.key_pressed(egui::Key::Enter)) && !self.voice.dict_term.trim().is_empty();
                });
            });
            if save {
                let entry = crate::dictwords::Entry { term: self.voice.dict_term.trim().to_string(), sounds: self.voice.dict_sounds.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect() };
                match self.voice.dict_edit.take().filter(|i| *i < dict.len()) {
                    Some(i) => dict[i] = entry,
                    None => dict.push(entry),
                }
                self.voice.dict_term.clear();
                self.voice.dict_sounds.clear();
                changed = true;
            }
        });
        if let Some(i) = edit {
            self.voice.dict_edit = Some(i);
            self.voice.dict_term = dict[i].term.clone();
            self.voice.dict_sounds = dict[i].sounds.join(", ");
        }
        if let Some(i) = remove {
            dict.remove(i);
            if self.voice.dict_edit == Some(i) {
                self.voice.dict_edit = None;
            }
            changed = true;
        }
        if changed {
            // Through parse: blanks and duplicates out.
            let clean = crate::dictwords::parse(&crate::dictwords::to_json(&dict));
            self.voice_set_words(None, Some(clean));
        }
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

    /// End to end with the built-in Whisper: no model at first (it downloads), then the
    /// WAV at HARBOR_VOICE_TEST_WAV is transcribed. Needs the network; run it with
    /// `XDG_DATA_HOME=<empty dir> cargo test voice::tests::builtin -- --ignored`.
    #[test]
    #[ignore]
    fn builtin_downloads_and_transcribes() {
        let wavf = PathBuf::from(std::env::var_os("HARBOR_VOICE_TEST_WAV").expect("HARBOR_VOICE_TEST_WAV"));
        assert!(matches!(engine(), Engine::Builtin));
        let samples = wav_samples(&std::fs::read(&wavf).unwrap()).unwrap();
        if current_model().is_none() {
            let e = whisper(&samples, "en").unwrap_err();
            assert!(e.text().starts_with("Getting the Base speech model"), "{e:?}");
            while downloading().is_some() {
                std::thread::sleep(Duration::from_secs(1));
            }
            assert!(take_download_error().is_none());
        }
        let t0 = Instant::now();
        let text = whisper(&samples, "en").unwrap();
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
