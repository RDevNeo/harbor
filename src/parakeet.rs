//! The main speech engine: NVIDIA Parakeet TDT 0.6B v3 (int8; 25 European languages, detects
//! the language itself) through sherpa-onnx, linked into Harbor with its ONNX Runtime.
//!
//! The model (~670 MB, CC-BY-4.0) downloads into Harbor's data folder on first use (voice.rs
//! runs the download). It is loaded only when needed (a recording starting loads it while you
//! speak), kept for "Keep speech model loaded" minutes after the last use, then freed
//! completely: no memory and no threads while idle. Long recordings are cut at pauses with
//! Silero VAD, so memory stays bounded.
//!
//! The Whisper fallback runs on the same runtime (`whisper`): one C++ toolchain in the binary
//! (whisper.cpp next to the prebuilt ONNX Runtime broke it: both carry std::regex code).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig, OfflineWhisperModelConfig, SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};

const DIR: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const HF: &str = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main";

/// (file, URL, size, SHA-256 or "" where the repository gives none).
const FILES: &[(&str, &str, u64, &str)] = &[
    ("encoder.int8.onnx", "encoder.int8.onnx", 652_184_281, "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"),
    ("decoder.int8.onnx", "decoder.int8.onnx", 11_845_275, "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"),
    ("joiner.int8.onnx", "joiner.int8.onnx", 6_355_277, "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"),
    ("tokens.txt", "tokens.txt", 93_939, ""),
    ("silero_vad.onnx", "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx", 643_854, "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"),
];

/// The languages it knows (ISO 639-1), for choosing Whisper for the others.
pub const LANGS: &[&str] = &["bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk"];

/// Recordings longer than this are cut at pauses first.
const SPLIT_ABOVE_S: usize = 30;

pub fn dir() -> PathBuf {
    crate::store::data_dir().join("parakeet").join(DIR)
}

/// The model's files: what voice.rs downloads.
pub fn parts() -> Vec<crate::voice::Part> {
    FILES
        .iter()
        .map(|(name, url, size, sha)| crate::voice::Part {
            url: if url.starts_with("https://") { url.to_string() } else { format!("{HF}/{url}") },
            dst: dir().join(name),
            size: *size,
            sha256: sha,
        })
        .collect()
}

/// Download size in bytes.
pub fn size() -> u64 {
    FILES.iter().map(|f| f.2).sum()
}

/// Its size in MB, as the mesh counts it for a PC that has it loaded.
pub fn model_mb() -> u64 {
    size() / 1_000_000
}

pub fn installed() -> bool {
    FILES.iter().all(|(name, _, size, _)| std::fs::metadata(dir().join(name)).is_ok_and(|m| m.len() == *size))
}

pub fn remove() {
    unload();
    let _ = std::fs::remove_dir_all(dir());
}

// ------------------------------------------------------------------ loading on demand

struct Loaded {
    rec: Arc<OfflineRecognizer>,
    last: Instant,
}

static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);
/// One load at a time (a preload and a transcription may both ask).
static LOADING: Mutex<()> = Mutex::new(());
static REAPER: AtomicBool = AtomicBool::new(false);
/// Minutes the model stays loaded after its last use (0: freed right after each use).
static KEEP_MIN: AtomicU64 = AtomicU64::new(5);

pub fn set_keep_min(m: u64) {
    KEEP_MIN.store(m, Ordering::Relaxed);
}

pub fn keep_min() -> u64 {
    KEEP_MIN.load(Ordering::Relaxed)
}

pub fn loaded() -> bool {
    LOADED.lock().unwrap().is_some()
}

fn threads() -> i32 {
    std::thread::available_parallelism().map(|n| n.get().clamp(1, 4)).unwrap_or(2) as i32
}

/// Loads the model in the background (a recording just started), if it's there.
pub fn preload() {
    if installed() && !loaded() {
        std::thread::spawn(|| {
            let _ = recognizer();
        });
    }
}

/// The loaded recognizer, loading it if needed.
fn recognizer() -> Result<Arc<OfflineRecognizer>, String> {
    let _one = LOADING.lock().unwrap();
    if let Some(l) = LOADED.lock().unwrap().as_mut() {
        l.last = Instant::now();
        return Ok(l.rec.clone());
    }
    if !installed() {
        return Err("The Parakeet model isn't downloaded.".into());
    }
    let d = dir();
    let p = |n: &str| Some(d.join(n).to_string_lossy().into_owned());
    let mut cfg = OfflineRecognizerConfig::default();
    cfg.model_config.transducer = OfflineTransducerModelConfig { encoder: p("encoder.int8.onnx"), decoder: p("decoder.int8.onnx"), joiner: p("joiner.int8.onnx") };
    cfg.model_config.tokens = p("tokens.txt");
    cfg.model_config.model_type = Some("nemo_transducer".into());
    cfg.model_config.num_threads = threads();
    cfg.model_config.provider = Some("cpu".into());
    cfg.decoding_method = Some("greedy_search".into());
    let rec = Arc::new(OfflineRecognizer::create(&cfg).ok_or("Couldn't load the Parakeet model. Remove it in Settings › Voice and download it again.")?);
    *LOADED.lock().unwrap() = Some(Loaded { rec: rec.clone(), last: Instant::now() });
    if !REAPER.swap(true, Ordering::SeqCst) {
        std::thread::spawn(reaper);
    }
    Ok(rec)
}

/// Frees the model once it's been idle long enough; ends when nothing is loaded.
fn reaper() {
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let mut g = LOADED.lock().unwrap();
        let idle = match g.as_ref() {
            None => {
                REAPER.store(false, Ordering::SeqCst);
                return;
            }
            // At least two minutes: a model loaded while you speak waits for the recording to end
            // (with "keep loaded" off, transcribe() frees it right after use).
            Some(l) => l.last.elapsed() >= Duration::from_secs((keep_min() * 60).max(120)) && Arc::strong_count(&l.rec) == 1,
        };
        if idle {
            *g = None;
            drop(g);
            trim();
        }
    }
}

/// Frees the model now (unless a transcription is using it; then after it).
pub fn unload() {
    let mut g = LOADED.lock().unwrap();
    if g.as_ref().is_some_and(|l| Arc::strong_count(&l.rec) == 1) {
        *g = None;
        drop(g);
        trim();
    }
}

/// Gives freed memory back to the system right away.
#[allow(unsafe_code)] // malloc_trim: glibc keeps freed memory otherwise; no safe wrapper
fn trim() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
}

// ------------------------------------------------------------------ transcribing

/// 16 kHz mono samples → text.
pub fn transcribe(samples: &[i16]) -> Result<String, String> {
    let rec = recognizer()?;
    let pcm: Vec<f32> = samples.iter().map(|s| *s as f32 / 32768.0).collect();
    let pieces = if pcm.len() > SPLIT_ABOVE_S * crate::voice::RATE as usize { split(&pcm) } else { vec![pcm] };
    let mut out: Vec<String> = vec![];
    for piece in &pieces {
        let stream = rec.create_stream();
        stream.accept_waveform(crate::voice::RATE as i32, piece);
        rec.decode(&stream);
        let t = stream.get_result().map(|r| r.text).unwrap_or_default();
        if !t.trim().is_empty() {
            out.push(t.trim().to_string());
        }
    }
    drop(rec);
    if let Some(l) = LOADED.lock().unwrap().as_mut() {
        l.last = Instant::now();
    }
    if keep_min() == 0 {
        unload();
    }
    Ok(out.join(" "))
}

/// Whisper model `name` (files in `dir`) on 16 kHz mono samples: loaded for this one use and
/// freed after (it's only the fallback). Pieces of at most ~20 s (Whisper reads 30 s at most).
pub fn whisper(dir: &std::path::Path, name: &str, samples: &[i16], lang: &str) -> Result<String, String> {
    let p = |f: String| Some(dir.join(f).to_string_lossy().into_owned());
    let mut cfg = OfflineRecognizerConfig::default();
    cfg.model_config.whisper = OfflineWhisperModelConfig {
        encoder: p(format!("{name}-encoder.int8.onnx")),
        decoder: p(format!("{name}-decoder.int8.onnx")),
        language: Some(if lang == "auto" { String::new() } else { lang.to_string() }),
        task: Some("transcribe".into()),
        tail_paddings: -1,
        ..Default::default()
    };
    cfg.model_config.tokens = p(format!("{name}-tokens.txt"));
    cfg.model_config.num_threads = threads();
    cfg.model_config.provider = Some("cpu".into());
    cfg.decoding_method = Some("greedy_search".into());
    let rec = OfflineRecognizer::create(&cfg).ok_or("Couldn't load the Whisper model. Remove it in Settings › Voice and download it again.")?;
    let pcm: Vec<f32> = samples.iter().map(|s| *s as f32 / 32768.0).collect();
    let pieces = if pcm.len() > 25 * crate::voice::RATE as usize { split(&pcm) } else { vec![pcm] };
    let mut out: Vec<String> = vec![];
    for piece in &pieces {
        let stream = rec.create_stream();
        stream.accept_waveform(crate::voice::RATE as i32, piece);
        rec.decode(&stream);
        let t = crate::voice::clean(&stream.get_result().map(|r| r.text).unwrap_or_default());
        if !t.is_empty() {
            out.push(t);
        }
    }
    drop(rec);
    trim();
    Ok(out.join(" "))
}

/// A long recording cut at its pauses (Silero VAD), pieces of at most ~20 s; fixed 20 s
/// pieces if the VAD can't start.
fn split(pcm: &[f32]) -> Vec<Vec<f32>> {
    let rate = crate::voice::RATE as usize;
    let fixed = || pcm.chunks(20 * rate).map(|c| c.to_vec()).collect::<Vec<_>>();
    let cfg = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(dir().join("silero_vad.onnx").to_string_lossy().into_owned()),
            threshold: 0.5,
            min_silence_duration: 0.8,
            min_speech_duration: 0.25,
            window_size: 512,
            max_speech_duration: 20.0,
        },
        sample_rate: rate as i32,
        num_threads: 1,
        provider: Some("cpu".into()),
        ..Default::default()
    };
    let Some(vad) = VoiceActivityDetector::create(&cfg, (pcm.len() / rate + 2) as f32) else { return fixed() };
    let mut out = vec![];
    let mut take = |vad: &VoiceActivityDetector| {
        while let Some(seg) = vad.front() {
            out.push(seg.samples().to_vec());
            vad.pop();
        }
    };
    for w in pcm.chunks(512) {
        vad.accept_waveform(w);
        take(&vad);
    }
    vad.flush();
    take(&vad);
    if out.is_empty() { fixed() } else { out }
}
