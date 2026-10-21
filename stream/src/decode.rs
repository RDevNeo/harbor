//! H.264/HEVC → RGBA with libavcodec + libswscale (the system's FFmpeg).
//! Shared by every backend: they hand over whole access units (Annex B) and get
//! decoded frames back; converting to RGBA is a separate step so frames nobody
//! will see cost no conversion.
//! Decoding uses VAAPI (the GPU) when the machine has it, else the CPU;
//! HARBOR_STREAM_HWDEC=0 forces the CPU. GPU frames are copied back only when
//! converted.

use ffmpeg_sys_next as ff;
use std::ptr;

pub struct Decoder {
    ctx: *mut ff::AVCodecContext,
    pkt: *mut ff::AVPacket,
    #[cfg_attr(not(feature = "gamestream"), allow(dead_code))]
    hw: bool,
}

/// A decoded picture (a reference; cheap to keep the newest one around).
pub struct Frame(*mut ff::AVFrame);

// Both only touch FFmpeg objects they own; FFmpeg contexts aren't thread-bound.
unsafe impl Send for Decoder {}
unsafe impl Send for Frame {}

impl Drop for Frame {
    fn drop(&mut self) {
        unsafe { ff::av_frame_free(&mut self.0) }
    }
}

impl Frame {
    pub fn size(&self) -> (u32, u32) {
        unsafe { ((*self.0).width as u32, (*self.0).height as u32) }
    }
}

#[derive(Clone, Copy)]
pub enum Codec {
    H264,
    H265,
}

/// Take VAAPI when FFmpeg offers it for this stream, else its software format.
unsafe extern "C" fn pick_vaapi(_ctx: *mut ff::AVCodecContext, fmts: *const ff::AVPixelFormat) -> ff::AVPixelFormat {
    unsafe {
        let mut p = fmts;
        while *p != ff::AVPixelFormat::AV_PIX_FMT_NONE {
            if *p == ff::AVPixelFormat::AV_PIX_FMT_VAAPI {
                return *p;
            }
            p = p.add(1);
        }
        // no VAAPI for this stream: the first non-hardware format
        let mut p = fmts;
        while *p != ff::AVPixelFormat::AV_PIX_FMT_NONE {
            let d = ff::av_pix_fmt_desc_get(*p);
            if !d.is_null() && (*d).flags & ff::AV_PIX_FMT_FLAG_HWACCEL as u64 == 0 {
                return *p;
            }
            p = p.add(1);
        }
        *fmts
    }
}

impl Decoder {
    #[cfg_attr(not(feature = "gamestream"), allow(dead_code))]
    pub fn new(codec: Codec) -> Result<Self, String> {
        let hw = std::env::var("HARBOR_STREAM_HWDEC").map(|v| v != "0").unwrap_or(true);
        match hw.then(|| Self::open(codec, true)) {
            Some(Ok(d)) => Ok(d),
            _ => Self::open(codec, false),
        }
    }

    /// CPU only. Phones: their small frames decode in a few ms, while copying a
    /// VAAPI surface back to memory took 25-30 ms per frame (measured on an Intel iGPU laptop).
    pub fn software(codec: Codec) -> Result<Self, String> {
        Self::open(codec, false)
    }

    /// Whether frames come from the GPU (VAAPI).
    #[cfg_attr(not(feature = "gamestream"), allow(dead_code))]
    pub fn hardware(&self) -> bool {
        self.hw
    }

    fn open(codec: Codec, hw: bool) -> Result<Self, String> {
        unsafe {
            let id = match codec {
                Codec::H264 => ff::AVCodecID::AV_CODEC_ID_H264,
                Codec::H265 => ff::AVCodecID::AV_CODEC_ID_HEVC,
            };
            let c = ff::avcodec_find_decoder(id);
            if c.is_null() {
                return Err("no H.264/HEVC decoder in this FFmpeg".into());
            }
            let ctx = ff::avcodec_alloc_context3(c);
            // Real time: output each frame as soon as it's decoded (no frame threads,
            // which hold frames back); slice threads still help on big frames.
            (*ctx).flags |= ff::AV_CODEC_FLAG_LOW_DELAY as i32;
            (*ctx).flags2 |= ff::AV_CODEC_FLAG2_FAST;
            (*ctx).thread_type = ff::FF_THREAD_SLICE;
            (*ctx).thread_count = 4;
            if hw {
                let mut dev: *mut ff::AVBufferRef = ptr::null_mut();
                if ff::av_hwdevice_ctx_create(&mut dev, ff::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI, ptr::null(), ptr::null_mut(), 0) < 0 {
                    let mut ctx = ctx;
                    ff::avcodec_free_context(&mut ctx);
                    return Err("no VAAPI device".into());
                }
                (*ctx).hw_device_ctx = ff::av_buffer_ref(dev);
                ff::av_buffer_unref(&mut dev);
                (*ctx).get_format = Some(pick_vaapi);
                (*ctx).thread_count = 1;
            }
            if ff::avcodec_open2(ctx, c, ptr::null_mut()) < 0 {
                let mut ctx = ctx;
                ff::avcodec_free_context(&mut ctx);
                return Err("couldn't open the video decoder".into());
            }
            Ok(Self { ctx, pkt: ff::av_packet_alloc(), hw })
        }
    }

    /// Decode one access unit; returns the frames it produced (normally one).
    pub fn decode(&mut self, data: &[u8]) -> Vec<Frame> {
        let mut out = Vec::new();
        unsafe {
            if ff::av_new_packet(self.pkt, data.len() as i32) < 0 {
                return out;
            }
            ptr::copy_nonoverlapping(data.as_ptr(), (*self.pkt).data, data.len());
            let r = ff::avcodec_send_packet(self.ctx, self.pkt);
            ff::av_packet_unref(self.pkt);
            if r < 0 && r != -(libc_eagain()) {
                return out;
            }
            loop {
                let f = ff::av_frame_alloc();
                if ff::avcodec_receive_frame(self.ctx, f) < 0 {
                    let mut f = f;
                    ff::av_frame_free(&mut f);
                    break;
                }
                out.push(Frame(f));
            }
        }
        out
    }
}

fn libc_eagain() -> i32 {
    11 // EAGAIN on Linux
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            ff::av_packet_free(&mut self.pkt);
            ff::avcodec_free_context(&mut self.ctx);
        }
    }
}

/// Frame → RGBA at a given size (scaled with a cached swscale context).
pub struct Converter {
    sws: *mut ff::SwsContext,
    /// a GPU frame copied to memory (reused)
    sw: *mut ff::AVFrame,
}

unsafe impl Send for Converter {}

impl Default for Converter {
    fn default() -> Self {
        Self { sws: ptr::null_mut(), sw: ptr::null_mut() }
    }
}

impl Converter {
    /// RGBA pixels of `f` at `w`×`h` (tightly packed) into `buf`.
    pub fn rgba(&mut self, f: &Frame, w: u32, h: u32, buf: &mut Vec<u8>) -> bool {
        unsafe {
            let mut src: *const ff::AVFrame = f.0;
            if (*src).format == ff::AVPixelFormat::AV_PIX_FMT_VAAPI as i32 {
                if self.sw.is_null() {
                    self.sw = ff::av_frame_alloc();
                }
                if !gpu_to_memory(f.0, self.sw) {
                    return false;
                }
                src = self.sw;
            }
            // sws_scale_frame: sliced over several threads, and it follows the
            // frame's own colour description (BT.709 limited from GameStream)
            if self.sws.is_null() {
                self.sws = ff::sws_alloc_context();
                if self.sws.is_null() {
                    return false;
                }
                (*self.sws).threads = 4;
            }
            let same = (w as i32, h as i32) == ((*src).width, (*src).height);
            (*self.sws).flags = if same { ff::SwsFlags::SWS_POINT } else { ff::SwsFlags::SWS_BILINEAR } as u32;
            let len = (w * h * 4) as usize;
            buf.resize(len, 0);
            unsafe extern "C" fn keep(_: *mut std::ffi::c_void, _: *mut u8) {}
            let mut dst = ff::av_frame_alloc();
            (*dst).width = w as i32;
            (*dst).height = h as i32;
            (*dst).format = ff::AVPixelFormat::AV_PIX_FMT_RGBA as i32;
            (*dst).data[0] = buf.as_mut_ptr();
            (*dst).linesize[0] = (w * 4) as i32;
            (*dst).buf[0] = ff::av_buffer_create(buf.as_mut_ptr(), len, Some(keep), ptr::null_mut(), 0);
            let ok = ff::sws_scale_frame(self.sws, dst, src) >= 0;
            ff::av_frame_free(&mut dst);
            ok
        }
    }
}

/// A frame's planes, tightly packed, for Harbor to convert on its GPU.
#[allow(dead_code)]
pub struct Planes {
    /// "nv12" (Y, then interleaved UV) or "i420" (Y, U, V)
    pub fmt: &'static str,
    pub w: u32,
    pub h: u32,
    /// "bt709" or "bt601"
    pub cs: &'static str,
    pub full_range: bool,
}

impl Converter {
    /// The frame's YUV planes into `buf` (no colour conversion, no scaling).
    /// None for formats other than NV12/I420: use `rgba` then.
    #[allow(dead_code)]
    pub fn planes(&mut self, f: &Frame, buf: &mut Vec<u8>) -> Option<Planes> {
        unsafe {
            let mut src: *const ff::AVFrame = f.0;
            if (*src).format == ff::AVPixelFormat::AV_PIX_FMT_VAAPI as i32 {
                if self.sw.is_null() {
                    self.sw = ff::av_frame_alloc();
                }
                if !gpu_to_memory(f.0, self.sw) {
                    return None;
                }
                src = self.sw;
            }
            let fr = &*src;
            let (w, h) = (fr.width as usize, fr.height as usize);
            let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
            let fmt = fr.format;
            let nv12 = fmt == ff::AVPixelFormat::AV_PIX_FMT_NV12 as i32;
            let jpeg = fmt == ff::AVPixelFormat::AV_PIX_FMT_YUVJ420P as i32;
            if !nv12 && !jpeg && fmt != ff::AVPixelFormat::AV_PIX_FMT_YUV420P as i32 {
                return None;
            }
            buf.clear();
            buf.reserve(w * h + cw * ch * 2);
            let mut rows = |plane: usize, width: usize, height: usize| {
                let ls = fr.linesize[plane] as usize;
                for y in 0..height {
                    buf.extend_from_slice(std::slice::from_raw_parts(fr.data[plane].add(y * ls), width));
                }
            };
            rows(0, w, h);
            if nv12 {
                rows(1, cw * 2, ch);
            } else {
                rows(1, cw, ch);
                rows(2, cw, ch);
            }
            Some(Planes {
                fmt: if nv12 { "nv12" } else { "i420" },
                w: w as u32,
                h: h as u32,
                cs: if fr.colorspace == ff::AVColorSpace::AVCOL_SPC_BT709 { "bt709" } else { "bt601" },
                full_range: jpeg || fr.color_range == ff::AVColorRange::AVCOL_RANGE_JPEG,
            })
        }
    }
}

/// Copy a GPU frame into `dst` (NV12). The mapped surface is uncached memory,
/// where plain reads crawl (50-100 ms per 1080p frame); FFmpeg's "uc" copy uses
/// streaming loads, as video players do. Falls back to FFmpeg's own transfer.
unsafe fn gpu_to_memory(src: *const ff::AVFrame, dst: *mut ff::AVFrame) -> bool {
    unsafe {
        let mut m = ff::av_frame_alloc();
        (*m).format = ff::AVPixelFormat::AV_PIX_FMT_NONE as i32;
        let ok = if ff::av_hwframe_map(m, src, ff::AV_HWFRAME_MAP_READ as i32) >= 0 {
            let (w, h, fmt) = ((*m).width, (*m).height, (*m).format);
            if ((*dst).width, (*dst).height, (*dst).format) != (w, h, fmt) || (*dst).data[0].is_null() {
                ff::av_frame_unref(dst);
                (*dst).width = w;
                (*dst).height = h;
                (*dst).format = fmt;
                if ff::av_frame_get_buffer(dst, 64) < 0 {
                    ff::av_frame_free(&mut m);
                    return false;
                }
            }
            let dl: [isize; 4] = std::array::from_fn(|i| (*dst).linesize[i] as isize);
            let sl: [isize; 4] = std::array::from_fn(|i| (*m).linesize[i] as isize);
            let dd: [*mut u8; 4] = std::array::from_fn(|i| (*dst).data[i]);
            let sd: [*const u8; 4] = std::array::from_fn(|i| (*m).data[i] as *const u8);
            ff::av_image_copy_uc_from(dd.as_ptr(), dl.as_ptr(), sd.as_ptr(), sl.as_ptr(), std::mem::transmute::<i32, ff::AVPixelFormat>(fmt), w, h);
            true
        } else {
            ff::av_frame_unref(dst);
            ff::av_hwframe_transfer_data(dst, src, 0) >= 0
        };
        ff::av_frame_free(&mut m);
        ok
    }
}

impl Drop for Converter {
    fn drop(&mut self) {
        unsafe {
            ff::sws_free_context(&mut self.sws);
            ff::av_frame_free(&mut self.sw);
        }
    }
}
