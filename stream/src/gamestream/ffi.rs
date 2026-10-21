//! Hand-written bindings for the parts of moonlight-common-c's Limelight.h we use
//! (and libopus' multistream decoder).
#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::os::raw::{c_char, c_int, c_short, c_uchar, c_uint, c_void};

#[repr(C)]
pub struct STREAM_CONFIGURATION {
    pub width: c_int,
    pub height: c_int,
    pub fps: c_int,
    pub bitrate: c_int,
    pub packetSize: c_int,
    pub streamingRemotely: c_int,
    pub audioConfiguration: c_int,
    pub supportedVideoFormats: c_int,
    pub clientRefreshRateX100: c_int,
    pub colorSpace: c_int,
    pub colorRange: c_int,
    pub encryptionFlags: c_int,
    pub remoteInputAesKey: [c_char; 16],
    pub remoteInputAesIv: [c_char; 16],
}

#[repr(C)]
pub struct LENTRY {
    pub next: *mut LENTRY,
    pub data: *mut c_char,
    pub length: c_int,
    pub bufferType: c_int,
}

#[repr(C)]
pub struct DECODE_UNIT {
    pub frameNumber: c_int,
    pub frameType: c_int,
    pub frameHostProcessingLatency: u16,
    pub receiveTimeUs: u64,
    pub enqueueTimeUs: u64,
    pub presentationTimeUs: u64,
    pub rtpTimestamp: u32,
    pub fullLength: c_int,
    pub bufferList: *mut LENTRY,
    pub hdrActive: bool,
    pub colorspace: u8,
}

#[repr(C)]
pub struct DECODER_RENDERER_CALLBACKS {
    pub setup: Option<unsafe extern "C" fn(c_int, c_int, c_int, c_int, *mut c_void, c_int) -> c_int>,
    pub start: Option<unsafe extern "C" fn()>,
    pub stop: Option<unsafe extern "C" fn()>,
    pub cleanup: Option<unsafe extern "C" fn()>,
    pub submitDecodeUnit: Option<unsafe extern "C" fn(*mut DECODE_UNIT) -> c_int>,
    pub capabilities: c_int,
}

#[repr(C)]
pub struct OPUS_MULTISTREAM_CONFIGURATION {
    pub sampleRate: c_int,
    pub channelCount: c_int,
    pub streams: c_int,
    pub coupledStreams: c_int,
    pub samplesPerFrame: c_int,
    pub mapping: [c_uchar; 8],
}

#[repr(C)]
pub struct AUDIO_RENDERER_CALLBACKS {
    pub init: Option<unsafe extern "C" fn(c_int, *const OPUS_MULTISTREAM_CONFIGURATION, *mut c_void, c_int) -> c_int>,
    pub start: Option<unsafe extern "C" fn()>,
    pub stop: Option<unsafe extern "C" fn()>,
    pub cleanup: Option<unsafe extern "C" fn()>,
    pub decodeAndPlaySample: Option<unsafe extern "C" fn(*mut c_char, c_int)>,
    pub capabilities: c_int,
}

/// The C side is variadic (printf-style); we take only the format string.
pub type LogFn = unsafe extern "C" fn(*const c_char, ...);

#[repr(C)]
pub struct CONNECTION_LISTENER_CALLBACKS {
    pub stageStarting: Option<unsafe extern "C" fn(c_int)>,
    pub stageComplete: Option<unsafe extern "C" fn(c_int)>,
    pub stageFailed: Option<unsafe extern "C" fn(c_int, c_int)>,
    pub connectionStarted: Option<unsafe extern "C" fn()>,
    pub connectionTerminated: Option<unsafe extern "C" fn(c_int)>,
    pub logMessage: Option<LogFn>,
    pub rumble: Option<unsafe extern "C" fn(u16, u16, u16)>,
    pub connectionStatusUpdate: Option<unsafe extern "C" fn(c_int)>,
    pub setHdrMode: Option<unsafe extern "C" fn(bool)>,
    pub rumbleTriggers: Option<unsafe extern "C" fn(u16, u16, u16)>,
    pub setMotionEventState: Option<unsafe extern "C" fn(u16, u8, u16)>,
    pub setControllerLED: Option<unsafe extern "C" fn(u16, u8, u8, u8)>,
    pub setAdaptiveTriggers: Option<unsafe extern "C" fn(u16, u8, u8, u8, *mut u8, *mut u8)>,
}

#[repr(C)]
pub struct SERVER_INFORMATION {
    pub address: *const c_char,
    pub serverInfoAppVersion: *const c_char,
    pub serverInfoGfeVersion: *const c_char,
    pub rtspSessionUrl: *const c_char,
    pub serverCodecModeSupport: c_int,
}

pub const STREAM_CFG_LOCAL: c_int = 0;
pub const STREAM_CFG_REMOTE: c_int = 1;
pub const STREAM_CFG_AUTO: c_int = 2;
pub const COLORSPACE_REC_709: c_int = 1;
pub const COLOR_RANGE_LIMITED: c_int = 0;
pub const ENCFLG_ALL: c_int = -1;
pub const AUDIO_CONFIGURATION_STEREO: c_int = (0x3 << 16) | (2 << 8) | 0xCA;
pub const VIDEO_FORMAT_H264: c_int = 0x0001;
pub const VIDEO_FORMAT_H265: c_int = 0x0100;
pub const VIDEO_FORMAT_MASK_H264: c_int = 0x000F;
pub const VIDEO_FORMAT_MASK_H265: c_int = 0x0F00;
pub const SCM_H264: c_int = 0x1;
pub const SCM_HEVC: c_int = 0x100;
pub const CAPABILITY_DIRECT_SUBMIT: c_int = 0x1;
pub const CAPABILITY_REFERENCE_FRAME_INVALIDATION_AVC: c_int = 0x2;
pub const CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC: c_int = 0x4;
pub const DR_OK: c_int = 0;
pub const DR_NEED_IDR: c_int = -1;
pub const FRAME_TYPE_IDR: c_int = 1;
pub const BUTTON_ACTION_PRESS: c_char = 0x07;
pub const BUTTON_ACTION_RELEASE: c_char = 0x08;
pub const KEY_ACTION_DOWN: c_char = 0x03;
pub const KEY_ACTION_UP: c_char = 0x04;
pub const MODIFIER_SHIFT: c_char = 0x01;
pub const MODIFIER_CTRL: c_char = 0x02;
pub const MODIFIER_ALT: c_char = 0x04;
pub const MODIFIER_META: c_char = 0x08;
pub const ML_ERROR_GRACEFUL_TERMINATION: c_int = 0;

unsafe extern "C" {
    pub fn LiInitializeStreamConfiguration(c: *mut STREAM_CONFIGURATION);
    pub fn LiInitializeVideoCallbacks(c: *mut DECODER_RENDERER_CALLBACKS);
    pub fn LiInitializeAudioCallbacks(c: *mut AUDIO_RENDERER_CALLBACKS);
    pub fn LiInitializeConnectionCallbacks(c: *mut CONNECTION_LISTENER_CALLBACKS);
    pub fn LiInitializeServerInformation(c: *mut SERVER_INFORMATION);
    pub fn LiGetLaunchUrlQueryParameters() -> *const c_char;
    pub fn LiStartConnection(
        server: *mut SERVER_INFORMATION,
        stream: *mut STREAM_CONFIGURATION,
        cl: *mut CONNECTION_LISTENER_CALLBACKS,
        dr: *mut DECODER_RENDERER_CALLBACKS,
        ar: *mut AUDIO_RENDERER_CALLBACKS,
        render_ctx: *mut c_void,
        dr_flags: c_int,
        audio_ctx: *mut c_void,
        ar_flags: c_int,
    ) -> c_int;
    pub fn LiStopConnection();
    pub fn LiInterruptConnection();
    pub fn LiGetStageName(stage: c_int) -> *const c_char;
    pub fn LiGetEstimatedRttInfo(rtt: *mut u32, var: *mut u32) -> bool;
    pub fn LiSendMousePositionEvent(x: c_short, y: c_short, w: c_short, h: c_short) -> c_int;
    pub fn LiSendMouseButtonEvent(action: c_char, button: c_int) -> c_int;
    pub fn LiSendKeyboardEvent(key: c_short, action: c_char, modifiers: c_char) -> c_int;
    pub fn LiSendKeyboardEvent2(key: c_short, action: c_char, modifiers: c_char, flags: c_char) -> c_int;
    pub fn LiSendUtf8TextEvent(text: *const c_char, len: c_uint) -> c_int;
    pub fn LiSendHighResScrollEvent(amount: c_short) -> c_int;
    pub fn LiSendHighResHScrollEvent(amount: c_short) -> c_int;
    pub fn LiGetMicroseconds() -> u64;
    pub fn LiRequestIdrFrame();
    pub fn LiGetPendingVideoFrames() -> c_int;
}

// libopus
pub enum OpusMSDecoder {}
unsafe extern "C" {
    pub fn opus_multistream_decoder_create(
        fs: i32,
        channels: c_int,
        streams: c_int,
        coupled: c_int,
        mapping: *const c_uchar,
        error: *mut c_int,
    ) -> *mut OpusMSDecoder;
    pub fn opus_multistream_decode(
        st: *mut OpusMSDecoder,
        data: *const c_uchar,
        len: i32,
        pcm: *mut i16,
        frame_size: c_int,
        decode_fec: c_int,
    ) -> c_int;
    pub fn opus_multistream_decoder_destroy(st: *mut OpusMSDecoder);
}

// ALSA (through PipeWire's ALSA plugin on this desktop)
pub enum snd_pcm_t {}
pub const SND_PCM_STREAM_PLAYBACK: c_int = 0;
pub const SND_PCM_FORMAT_S16_LE: c_int = 2;
pub const SND_PCM_ACCESS_RW_INTERLEAVED: c_int = 3;
unsafe extern "C" {
    pub fn snd_pcm_open(pcm: *mut *mut snd_pcm_t, name: *const c_char, stream: c_int, mode: c_int) -> c_int;
    pub fn snd_pcm_set_params(
        pcm: *mut snd_pcm_t,
        format: c_int,
        access: c_int,
        channels: c_uint,
        rate: c_uint,
        soft_resample: c_int,
        latency_us: c_uint,
    ) -> c_int;
    pub fn snd_pcm_writei(pcm: *mut snd_pcm_t, buf: *const c_void, frames: std::os::raw::c_ulong) -> std::os::raw::c_long;
    pub fn snd_pcm_recover(pcm: *mut snd_pcm_t, err: c_int, silent: c_int) -> c_int;
    pub fn snd_pcm_delay(pcm: *mut snd_pcm_t, delay: *mut std::os::raw::c_long) -> c_int;
    pub fn snd_pcm_drop(pcm: *mut snd_pcm_t) -> c_int;
    pub fn snd_pcm_close(pcm: *mut snd_pcm_t) -> c_int;
}
