//! Opus (multistream, as GameStream sends it) → PCM → ALSA's "default" device,
//! which on this desktop is PipeWire's ALSA plugin: no extra software. Decoding
//! happens on moonlight-common-c's audio thread; a player thread writes to ALSA
//! and drops audio when it falls behind, so sound never lags the picture by more
//! than ~100 ms.

use super::ffi::*;
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};

pub static MUTED: AtomicBool = AtomicBool::new(false);

pub struct Audio {
    dec: *mut OpusMSDecoder,
    channels: usize,
    frame: usize,
    tx: Option<SyncSender<Vec<i16>>>,
    pcm: Vec<i16>,
}

unsafe impl Send for Audio {}

impl Audio {
    pub fn new(cfg: &OPUS_MULTISTREAM_CONFIGURATION) -> Result<Self, String> {
        let mut err = 0;
        let dec = unsafe {
            opus_multistream_decoder_create(cfg.sampleRate, cfg.channelCount, cfg.streams, cfg.coupledStreams, cfg.mapping.as_ptr(), &mut err)
        };
        if dec.is_null() {
            return Err(format!("opus decoder: error {err}"));
        }
        let channels = cfg.channelCount as usize;
        let rate = cfg.sampleRate as u32;
        // ~8 packets of 5 ms queued at most; beyond that, packets are dropped
        let (tx, rx) = sync_channel::<Vec<i16>>(8);
        std::thread::Builder::new()
            .name("audio".into())
            .spawn(move || play(rx, channels as u32, rate))
            .map_err(|e| e.to_string())?;
        Ok(Self { dec, channels, frame: cfg.samplesPerFrame as usize, tx: Some(tx), pcm: Vec::new() })
    }

    pub fn decode(&mut self, data: &[u8]) {
        // up to 120 ms per packet, whatever the host chose
        self.pcm.resize(5760 * self.channels.max(1), 0);
        let n = unsafe {
            opus_multistream_decode(self.dec, if data.is_empty() { std::ptr::null() } else { data.as_ptr() }, data.len() as i32, self.pcm.as_mut_ptr(), 5760, 0)
        };
        let _ = self.frame;
        if n <= 0 {
            return;
        }
        let mut out = self.pcm[..n as usize * self.channels].to_vec();
        if MUTED.load(Ordering::Relaxed) {
            out.iter_mut().for_each(|s| *s = 0);
        }
        if let Some(tx) = &self.tx {
            if let Err(TrySendError::Disconnected(_)) = tx.try_send(out) {
                self.tx = None;
            }
        }
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        self.tx = None;
        unsafe { opus_multistream_decoder_destroy(self.dec) }
    }
}

fn play(rx: Receiver<Vec<i16>>, channels: u32, rate: u32) {
    let mut pcm: *mut snd_pcm_t = std::ptr::null_mut();
    let name = CString::new(std::env::var("HARBOR_STREAM_ALSA").unwrap_or_else(|_| "default".into())).unwrap();
    unsafe {
        if snd_pcm_open(&mut pcm, name.as_ptr(), SND_PCM_STREAM_PLAYBACK, 0) < 0 {
            eprintln!("audio: can't open ALSA device");
            for _ in rx {}
            return;
        }
        // 40 ms device buffer: low latency without underruns on a busy desktop
        if snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, channels, rate, 1, 40_000) < 0 {
            eprintln!("audio: ALSA refused stereo 48 kHz");
            snd_pcm_close(pcm);
            for _ in rx {}
            return;
        }
    }
    let max_delay = rate as i64 / 10; // 100 ms
    for buf in rx {
        unsafe {
            let mut delay: std::os::raw::c_long = 0;
            if snd_pcm_delay(pcm, &mut delay) == 0 && delay as i64 > max_delay {
                continue; // behind: drop this packet to catch up
            }
            let frames = (buf.len() / channels as usize) as std::os::raw::c_ulong;
            let r = snd_pcm_writei(pcm, buf.as_ptr() as *const _, frames);
            if r < 0 {
                snd_pcm_recover(pcm, r as i32, 1);
            }
        }
    }
    unsafe {
        snd_pcm_drop(pcm);
        snd_pcm_close(pcm);
    }
}
