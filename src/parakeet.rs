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

// (Unit tests run the engine in-process: the worker plumbing goes unused there.)
#![cfg_attr(test, allow(dead_code))]

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

// ------------------------------------------------------------------ the worker process
//
// The engine (ONNX Runtime, C++) runs in a child process, this same binary started with
// `--speech-worker`: if it aborts or runs out of memory, only the worker dies and the next
// dictation starts a new one. It holds the Parakeet model while it lives; the hub ends it after
// "Keep speech model loaded" minutes idle, which gives all its memory back. One request at a
// time (the lock), so concurrent dictations can't load the model twice.
//
// Wire (pipes): a JSON line `{"op": "load"|"parakeet"|"whisper", "n": samples, …}` then n
// 16-bit little-endian samples; the answer is one JSON line, `{"text": …}` or `{"error": …}`.

pub const WORKER_FLAG: &str = "--speech-worker";
/// The longest one request may take (a 10-minute recording on a slow CPU).
const CALL_TIMEOUT: Duration = Duration::from_secs(600);
/// Parakeet isn't loaded with less free memory than this (MB): Whisper or another PC instead.
const MIN_FREE_MB: u64 = 1200;

struct Worker {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: std::sync::mpsc::Receiver<String>,
    last: Instant,
}

static WORKER: Mutex<Option<Worker>> = Mutex::new(None);
/// The worker has the Parakeet model loaded.
static LOADED: AtomicBool = AtomicBool::new(false);
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
    LOADED.load(Ordering::Relaxed)
}

fn threads() -> i32 {
    std::thread::available_parallelism().map(|n| n.get().clamp(1, 4)).unwrap_or(2) as i32
}

/// Loads the model in the background (a recording just started), if it's there and fits.
pub fn preload() {
    if installed() && !loaded() && crate::dictate::mem_available_mb() >= MIN_FREE_MB {
        std::thread::spawn(|| {
            let _ = call(serde_json::json!({ "op": "load" }), &[]);
        });
    }
}

/// 16 kHz mono samples → text, with Parakeet.
pub fn transcribe(samples: &[i16]) -> Result<String, String> {
    if !installed() {
        return Err("The Parakeet model isn't downloaded.".into());
    }
    let free = crate::dictate::mem_available_mb();
    if !loaded() && free < MIN_FREE_MB {
        return Err(format!("Not enough free memory for Parakeet ({free} MB free)."));
    }
    call(serde_json::json!({ "op": "parakeet" }), samples)
}

/// Whisper model `name` (files in `dir`) on 16 kHz mono samples: loaded for this one use and
/// freed after (it's only the fallback).
pub fn whisper(dir: &std::path::Path, name: &str, samples: &[i16], lang: &str) -> Result<String, String> {
    call(serde_json::json!({ "op": "whisper", "dir": dir, "name": name, "lang": lang }), samples)
}

/// Frees the model now (ends the worker), unless a request is running.
pub fn unload() {
    if let Ok(mut g) = WORKER.try_lock() {
        if let Some(w) = g.take() {
            stop(w);
        }
    }
    #[cfg(test)]
    {
        in_process::unload();
        LOADED.store(false, Ordering::Relaxed);
    }
}

fn stop(mut w: Worker) {
    LOADED.store(false, Ordering::Relaxed);
    let _ = w.child.kill();
    let _ = w.child.wait();
}

/// One request to the worker (started if needed). Unit tests run the engine in-process.
fn call(head: serde_json::Value, samples: &[i16]) -> Result<String, String> {
    #[cfg(test)]
    {
        let r = in_process::handle(&head, samples);
        LOADED.store(in_process::loaded(), Ordering::Relaxed);
        return r;
    }
    #[cfg(not(test))]
    {
        use std::io::Write;
        let op = head["op"].as_str().unwrap_or("").to_string();
        let mut g = WORKER.lock().unwrap_or_else(|e| e.into_inner());
        if g.as_mut().is_some_and(|w| !matches!(w.child.try_wait(), Ok(None))) {
            LOADED.store(false, Ordering::Relaxed);
            *g = None;
        }
        if g.is_none() {
            *g = Some(spawn()?);
            if !REAPER.swap(true, Ordering::SeqCst) {
                std::thread::spawn(reaper);
            }
        }
        let Some(w) = g.as_mut() else { return Err("The speech engine didn't start.".into()) };
        let mut head = head;
        head["n"] = serde_json::json!(samples.len());
        let mut msg = head.to_string().into_bytes();
        msg.push(b'\n');
        msg.extend(samples.iter().flat_map(|s| s.to_le_bytes()));
        let answer = match w.stdin.write_all(&msg).and_then(|_| w.stdin.flush()) {
            Ok(()) => w.lines.recv_timeout(CALL_TIMEOUT).map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        let line = match answer {
            Ok(l) => l,
            Err(e) => {
                // It died (an abort, out of memory) or hangs: gone, and the next try starts anew.
                eprintln!("harbor: speech worker stopped: {e}");
                if let Some(w) = g.take() {
                    stop(w);
                }
                return Err("The speech engine stopped (out of memory?); try again.".into());
            }
        };
        w.last = Instant::now();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
        if op == "parakeet" || op == "load" {
            LOADED.store(v["error"].is_null(), Ordering::Relaxed);
        }
        if keep_min() == 0 && op != "load" {
            if let Some(w) = g.take() {
                stop(w);
            }
        }
        match v["text"].as_str() {
            Some(t) => Ok(t.to_string()),
            None => Err(v["error"].as_str().unwrap_or("The speech engine gave no answer.").to_string()),
        }
    }
}

/// This binary as a worker. After an update replaced it on disk, /proc/self/exe reads
/// "… (deleted)": the new binary at the same path speaks the same wire.
#[cfg(not(test))]
fn spawn() -> Result<Worker, String> {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = PathBuf::from(exe.to_string_lossy().trim_end_matches(" (deleted)"));
    let mut child = Command::new(&exe)
        .arg(WORKER_FLAG)
        .env("HARBOR_SPEECH_THREADS", threads().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start the speech engine: {e}"))?;
    let stdin = child.stdin.take().ok_or("no worker stdin")?;
    let out = child.stdout.take().ok_or("no worker stdout")?;
    let (tx, lines) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for l in std::io::BufReader::new(out).lines() {
            let Ok(l) = l else { break };
            if tx.send(l).is_err() {
                break;
            }
        }
    });
    Ok(Worker { child, stdin, lines, last: Instant::now() })
}

/// Ends the worker once it's been idle long enough (at least two minutes: a model loaded while
/// you speak waits for the recording to end); stops when there's no worker.
#[cfg(not(test))]
fn reaper() {
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let Ok(mut g) = WORKER.try_lock() else { continue };
        match g.as_ref() {
            None => {
                REAPER.store(false, Ordering::SeqCst);
                return;
            }
            Some(w) if w.last.elapsed() >= Duration::from_secs((keep_min() * 60).max(120)) => {
                if let Some(w) = g.take() {
                    stop(w);
                }
            }
            Some(_) => {}
        }
    }
}

/// The worker's side: answers requests on stdin until it closes (the hub ended or quit).
pub fn worker_main() -> i32 {
    use std::io::{BufRead, Read, Write};
    let mut input = std::io::BufReader::new(std::io::stdin().lock());
    let mut out = std::io::stdout().lock();
    loop {
        let mut line = String::new();
        if input.read_line(&mut line).unwrap_or(0) == 0 {
            return 0;
        }
        let head: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or_default();
        let n = head["n"].as_u64().unwrap_or(0).min(crate::voice::RATE as u64 * 1200) as usize;
        let mut raw = vec![0u8; n * 2];
        if input.read_exact(&mut raw).is_err() {
            return 1;
        }
        let samples: Vec<i16> = raw.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        let answer = match in_process::handle(&head, &samples) {
            Ok(t) => serde_json::json!({ "text": t }),
            Err(e) => serde_json::json!({ "error": e }),
        };
        if writeln!(out, "{answer}").and_then(|_| out.flush()).is_err() {
            return 1;
        }
    }
}

/// The engine itself, in whichever process runs it.
mod in_process {
    use super::*;

    static REC: Mutex<Option<Arc<OfflineRecognizer>>> = Mutex::new(None);

    fn threads() -> i32 {
        std::env::var("HARBOR_SPEECH_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or_else(super::threads)
    }

    #[cfg(test)]
    pub fn loaded() -> bool {
        REC.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    #[cfg(test)]
    pub fn unload() {
        *REC.lock().unwrap_or_else(|e| e.into_inner()) = None;
        trim();
    }

    pub fn handle(head: &serde_json::Value, samples: &[i16]) -> Result<String, String> {
        match head["op"].as_str() {
            Some("load") => recognizer().map(|_| String::new()),
            Some("parakeet") => parakeet(samples),
            Some("whisper") => {
                let dir = PathBuf::from(head["dir"].as_str().unwrap_or(""));
                let name = head["name"].as_str().unwrap_or("");
                // (Only codes Harbor offers: a stray byte can't reach the C side.)
                let lang = head["lang"].as_str().filter(|l| l.len() <= 8 && l.chars().all(|c| c.is_ascii_alphabetic())).unwrap_or("auto");
                whisper(&dir, name, samples, lang)
            }
            _ => Err("unknown request".into()),
        }
    }

    fn recognizer() -> Result<Arc<OfflineRecognizer>, String> {
        let mut g = REC.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = g.as_ref() {
            return Ok(r.clone());
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
        *g = Some(rec.clone());
        Ok(rec)
    }

    fn parakeet(samples: &[i16]) -> Result<String, String> {
        let rec = recognizer()?;
        let pcm: Vec<f32> = samples.iter().map(|s| *s as f32 / 32768.0).collect();
        let pieces = if pcm.len() > SPLIT_ABOVE_S * crate::voice::RATE as usize { split(&pcm) } else { vec![pcm] };
        let mut out: Vec<String> = vec![];
        for piece in pieces.iter().filter(|p| !p.is_empty()) {
            let stream = rec.create_stream();
            stream.accept_waveform(crate::voice::RATE as i32, piece);
            rec.decode(&stream);
            let t = stream.get_result().map(|r| r.text).unwrap_or_default();
            if !t.trim().is_empty() {
                out.push(t.trim().to_string());
            }
        }
        Ok(out.join(" "))
    }

    fn whisper(dir: &std::path::Path, name: &str, samples: &[i16], lang: &str) -> Result<String, String> {
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
        // Whisper reads 30 s at most: longer ones in pieces.
        let pieces = if pcm.len() > 25 * crate::voice::RATE as usize { split(&pcm) } else { vec![pcm] };
        let mut out: Vec<String> = vec![];
        for piece in pieces.iter().filter(|p| !p.is_empty()) {
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

    /// Gives freed memory back to the system right away.
    #[allow(unsafe_code)] // malloc_trim: glibc keeps freed memory otherwise; no safe wrapper
    pub fn trim() {
        #[cfg(all(target_os = "linux", target_env = "gnu"))]
        unsafe {
            libc::malloc_trim(0);
        }
    }
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
