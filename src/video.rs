//! Videos in the image viewer (images.rs `lightbox`), played by libmpv.
//!
//! libmpv does the hard parts: hardware decoding, audio and its sync, seeking. Its render API
//! draws each frame into a texture here on the GPU, at the window's size, so a frame never comes
//! back to the CPU as RGBA. It isn't a build dependency: it's looked up by name when a video
//! opens, and without it the video opens in the system's player as it always did.
//!
//! One player at a time, on three threads:
//! - The UI thread only calls `mpv_render_*` (libmpv's rule: a render thread that waits on the
//!   core can deadlock). [`pump`] draws a frame when one is new; nothing else ever blocks it.
//! - `control`, one per video, is the only one to call the core: it starts it, loads the file,
//!   runs [`Cmd`]s and mirrors the player's state into [`State`]. It sleeps when mpv is quiet.
//! - mpv's own threads, which call `frame_ready` when a frame is due: that's the only repaint a
//!   playing video asks for, so painting follows the video's frame rate and a paused one is free.
//!
//! The file is whatever media.rs `check` allows and goes to mpv as one resolved absolute path in
//! a command's argument list: never through a shell, nor as an option or a URL.

use crate::icons as ic;
use crate::images::Fetch;
use crate::theme::RADIUS_MD;
use crate::widgets as w;
use crate::widgets::Tip as _;
use eframe::egui::{self, Color32, CornerRadius, CursorIcon, FontId, Id, Key, Rect, Response, Sense, Ui, Vec2, pos2, vec2};
use eframe::glow::{self, HasContext as _};
use raw_window_handle::{HasDisplayHandle as _, RawDisplayHandle};
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// A playing video with no frame drawn for this long is out of sight (see `control`).
const HIDDEN: Duration = Duration::from_millis(1500);
/// How long the controls stay after the pointer last moved, in seconds.
const CONTROLS_FOR: f64 = 2.5;
/// ← → in seconds, ↑ ↓ in percent.
const NUDGE: f64 = 5.0;
const VOLUME_STEP: u32 = 5;
/// The longest a closing video waits for mpv to let go of it, before its renderer ends anyway.
const STOP_WAIT: Duration = Duration::from_secs(1);

const WARN_NO_MPV: &str = "Install mpv to play videos inside Harbor";

// ---------------------------------------------------------------- libmpv

const RENDER_API_TYPE: c_int = 1;
const RENDER_OPENGL_INIT: c_int = 2;
const RENDER_OPENGL_FBO: c_int = 3;
const RENDER_FLIP_Y: c_int = 4;
const RENDER_X11_DISPLAY: c_int = 8;
const RENDER_WL_DISPLAY: c_int = 9;
const RENDER_BLOCK_FOR_TARGET_TIME: c_int = 12;
const RENDER_UPDATE_FRAME: u64 = 1;

const EVENT_NONE: c_int = 0;
const EVENT_END_FILE: c_int = 7;
const EVENT_FILE_LOADED: c_int = 8;
const EVENT_IDLE: c_int = 11;
const EVENT_PLAYBACK_RESTART: c_int = 21;
const EVENT_PROPERTY_CHANGE: c_int = 22;
const END_FILE_ERROR: c_int = 4;

const FORMAT_STRING: c_int = 1;
const FORMAT_FLAG: c_int = 3;
const FORMAT_INT64: c_int = 4;
const FORMAT_DOUBLE: c_int = 5;

#[repr(C)]
struct Param {
    kind: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct GlInit {
    get_proc_address: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
    ctx: *mut c_void,
    /// Gone from newer headers; libmpv.so.1 still reads it.
    extra_exts: *const c_char,
}

#[repr(C)]
struct Fbo {
    fbo: c_int,
    w: c_int,
    h: c_int,
    internal_format: c_int,
}

#[repr(C)]
struct Event {
    id: c_int,
    error: c_int,
    reply: u64,
    data: *mut c_void,
}

#[repr(C)]
struct EventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct EndFile {
    reason: c_int,
    error: c_int,
}

macro_rules! api {
    ($($name:ident: fn($($arg:ty),*) $(-> $ret:ty)?;)*) => {
        /// libmpv's functions, found at run time.
        struct Api { $($name: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)* }

        impl Api {
            unsafe fn load(lib: *mut c_void) -> Option<Self> {
                Some(Self { $($name: unsafe {
                    let sym = libc::dlsym(lib, concat!("mpv_", stringify!($name), "\0").as_ptr().cast());
                    if sym.is_null() {
                        return None;
                    }
                    std::mem::transmute::<*mut c_void, unsafe extern "C" fn($($arg),*) $(-> $ret)?>(sym)
                },)* })
            }
        }
    };
}

api! {
    create: fn() -> *mut c_void;
    initialize: fn(*mut c_void) -> c_int;
    terminate_destroy: fn(*mut c_void);
    set_option_string: fn(*mut c_void, *const c_char, *const c_char) -> c_int;
    set_property_string: fn(*mut c_void, *const c_char, *const c_char) -> c_int;
    command: fn(*mut c_void, *const *const c_char) -> c_int;
    observe_property: fn(*mut c_void, u64, *const c_char, c_int) -> c_int;
    wait_event: fn(*mut c_void, f64) -> *const Event;
    set_wakeup_callback: fn(*mut c_void, unsafe extern "C" fn(*mut c_void), *mut c_void);
    error_string: fn(c_int) -> *const c_char;
    render_context_create: fn(*mut *mut c_void, *mut c_void, *mut Param) -> c_int;
    render_context_set_update_callback: fn(*mut c_void, unsafe extern "C" fn(*mut c_void), *mut c_void);
    render_context_update: fn(*mut c_void) -> u64;
    render_context_render: fn(*mut c_void, *mut Param) -> c_int;
    render_context_free: fn(*mut c_void);
}

static API: OnceLock<Api> = OnceLock::new();

/// libmpv, loaded on the first call that finds it (one that doesn't looks again next time: it may
/// have been installed since). Loading it takes a moment: never on the UI thread.
fn load_api() -> Option<&'static Api> {
    if let Some(api) = API.get() {
        return Some(api);
    }
    for name in [c"libmpv.so.2", c"libmpv.so.1"] {
        // RTLD_LOCAL: its FFmpeg and friends stay out of everything else's way.
        let lib = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if !lib.is_null() {
            if let Some(api) = unsafe { Api::load(lib) } {
                return Some(API.get_or_init(|| api));
            }
        }
    }
    None
}

/// The player's setup. Later lines win, and an option a version doesn't have is skipped.
const OPTIONS: &[(&CStr, &CStr)] = &[
    // Nothing of the user's mpv: no config, scripts, key bindings, resumed positions.
    (c"config", c"no"),
    (c"load-scripts", c"no"),
    (c"ytdl", c"no"),
    (c"osc", c"no"),
    (c"load-stats-overlay", c"no"),
    (c"load-console", c"no"),
    (c"load-auto-profiles", c"no"),
    (c"load-select", c"no"),
    (c"load-context-menu", c"no"),
    (c"load-positioning", c"no"),
    (c"load-commands", c"no"),
    (c"terminal", c"no"),
    (c"input-default-bindings", c"no"),
    (c"input-builtin-bindings", c"no"),
    (c"input-vo-keyboard", c"no"),
    (c"resume-playback", c"no"),
    // Only this one file: nothing it refers to (other files, the network), nothing beside it.
    (c"access-references", c"no"),
    (c"ordered-chapters", c"no"),
    (c"load-unsafe-playlists", c"no"),
    (c"autoload-files", c"no"),
    (c"sub-auto", c"no"),
    (c"audio-file-auto", c"no"),
    (c"cover-art-auto", c"no"),
    (c"sid", c"no"),
    // Frames come here, at their time (no waiting in the render call), scaled the cheap way.
    (c"vo", c"libmpv"),
    (c"video-timing-offset", c"0"),
    (c"profile", c"fast"),
    (c"osd-level", c"0"),
    (c"osd-bar", c"no"),
    // On the GPU when it can; a copy back from it beats decoding on the CPU where it can't (X11).
    (c"hwdec", c"auto-safe"),
    (c"hwdec", c"auto-safe,auto-copy-safe"),
    // The last frame stays at the end, paused.
    (c"idle", c"yes"),
    (c"keep-open", c"yes"),
    (c"hr-seek", c"yes"),
    (c"volume-max", c"100"),
    (c"audio-client-name", c"Harbor"),
];

/// What `control` mirrors, in the order of the ids it watches them with.
const WATCH: [(&CStr, c_int); 5] = [(c"time-pos", FORMAT_DOUBLE), (c"duration", FORMAT_DOUBLE), (c"pause", FORMAT_FLAG), (c"eof-reached", FORMAT_FLAG), (c"dwidth", FORMAT_INT64)];

/// With HARBOR_VIDEO_LOG set: also noted, at the end of the log (ids from 100).
const STATS: [&CStr; 7] = [c"hwdec-current", c"video-codec", c"frame-drop-count", c"decoder-frame-drop-count", c"vo-delayed-frame-count", c"avsync", c"estimated-vf-fps"];

/// A dev aid: where to log the player's work (its own log, then a line per video).
fn log_file() -> Option<CString> {
    std::env::var_os("HARBOR_VIDEO_LOG").and_then(|p| CString::new(p.as_bytes()).ok())
}

// ---------------------------------------------------------------- state

/// What `control` is asked to do.
#[derive(Debug, Clone, PartialEq)]
enum Cmd {
    Load,
    Pause(bool),
    /// To a time; `true` for the exact frame, `false` for the nearest keyframe (dragging).
    Seek(f64, bool),
    Nudge(f64),
    Volume(u32),
    Mute(bool),
    /// Lets go of the video; the core stays until `Quit`.
    Stop,
    Quit,
}

fn push(q: &mut Vec<Cmd>, c: Cmd) {
    // Of a dragged seek bar only its last place matters.
    if matches!(c, Cmd::Seek(..)) {
        q.retain(|c| !matches!(c, Cmd::Seek(..)));
    }
    q.push(c);
}

#[derive(Debug, Clone, PartialEq, Default)]
enum Stage {
    #[default]
    Starting,
    Playing,
    Failed(String),
    /// No libmpv here: the file to open in the system's player.
    NoMpv(PathBuf),
}

struct Handle(*mut c_void);
// A pointer libmpv gives out, used from the threads its API allows.
unsafe impl Send for Handle {}

#[derive(Default)]
struct State {
    cmds: Vec<Cmd>,
    /// mpv has events waiting.
    woken: bool,
    /// The core, once it runs.
    core: Option<Handle>,
    stage: Stage,
    pos: f64,
    dur: f64,
    paused: bool,
    ended: bool,
    /// A first frame is out (or the file has no picture).
    started: bool,
    /// mpv has no video open, so ending the renderer won't wait for it.
    stopped: bool,
    has_video: bool,
    stats: Vec<String>,
}

/// What both sides of a player see.
struct Shared {
    ctx: egui::Context,
    state: Mutex<State>,
    wake: Condvar,
    born: Instant,
    /// When the viewer last drew, in ms since `born`.
    seen: AtomicU64,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn send(&self, c: Cmd) {
        push(&mut self.lock().cmds, c);
        self.wake.notify_one();
    }

    fn fail(&self, stage: Stage) {
        self.lock().stage = stage;
        self.ctx.request_repaint();
    }

    fn drawn(&self) {
        self.seen.store(self.born.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    fn unseen(&self) -> Duration {
        self.born.elapsed().saturating_sub(Duration::from_millis(self.seen.load(Ordering::Relaxed)))
    }

    /// The next commands, once there are some or mpv has events.
    fn next(&self) -> Vec<Cmd> {
        let mut st = self.lock();
        while st.cmds.is_empty() && !st.woken {
            st = self.wake.wait(st).unwrap_or_else(|e| e.into_inner());
        }
        st.woken = false;
        std::mem::take(&mut st.cmds)
    }
}

/// mpv has something new (it says so from its own threads).
unsafe extern "C" fn woken(data: *mut c_void) {
    let s = unsafe { &*(data as *const Shared) };
    s.lock().woken = true;
    s.wake.notify_one();
}

/// A frame is due. A delay above zero, as "repaint now" paints twice in a row.
unsafe extern "C" fn frame_ready(data: *mut c_void) {
    let s = unsafe { &*(data as *const Shared) };
    s.ctx.request_repaint_after(Duration::from_millis(1));
}

// ---------------------------------------------------------------- the control thread

/// The file to play for `key`: its real absolute path, when media.rs allows it.
fn playable(path: &Path) -> Result<PathBuf, String> {
    if !crate::media::check(path)? {
        return Err("not a video".into());
    }
    let file = crate::media::located(path).canonicalize().map_err(|e| e.to_string())?;
    if file.is_absolute() { Ok(file) } else { Err("not a file Harbor shows".into()) }
}

/// Where `key` is here: fetched first when it's a file of another PC's chat.
fn file_of(key: &str, fetch: Option<Fetch>) -> Result<PathBuf, String> {
    let path = Path::new(key);
    match fetch.filter(|_| !crate::media::located(path).exists()) {
        Some(fetch) => playable(&fetch(key).and_then(|b| crate::media::save_remote(key, &b)).ok_or("the PC this chat runs on is off or doesn't have it")?),
        None => playable(path),
    }
}

unsafe fn start(api: &Api, paused: bool, volume: u32) -> Option<*mut c_void> {
    unsafe {
        let core = (api.create)();
        if core.is_null() {
            return None;
        }
        for (name, value) in OPTIONS {
            (api.set_option_string)(core, name.as_ptr(), value.as_ptr());
        }
        let volume = CString::new(volume.to_string()).ok()?;
        (api.set_option_string)(core, c"volume".as_ptr(), volume.as_ptr());
        (api.set_option_string)(core, c"pause".as_ptr(), if paused { c"yes" } else { c"no" }.as_ptr());
        if let Some(log) = log_file() {
            (api.set_option_string)(core, c"log-file".as_ptr(), [log.as_bytes(), b".mpv\0"].concat().as_ptr().cast());
        }
        if (api.initialize)(core) < 0 {
            (api.terminate_destroy)(core);
            return None;
        }
        Some(core)
    }
}

/// Runs one video from start to end (the viewer's `Quit`, sent after its render context is gone).
fn control(s: Arc<Shared>, key: String, fetch: Option<Fetch>, paused: bool) {
    let file = match file_of(&key, fetch) {
        Ok(f) => f,
        Err(e) => return s.fail(Stage::Failed(e)),
    };
    let Some(api) = load_api() else { return s.fail(Stage::NoMpv(file)) };
    let Ok(path) = CString::new(file.as_os_str().as_bytes()) else { return s.fail(Stage::Failed("not a file Harbor shows".into())) };
    let Some(core) = (unsafe { start(api, paused, VOLUME.load(Ordering::Relaxed)) }) else { return s.fail(Stage::Failed("mpv didn't start".into())) };
    let logging = log_file().is_some();
    unsafe {
        (api.set_wakeup_callback)(core, woken, Arc::as_ptr(&s) as *mut c_void);
        for (id, (name, format)) in WATCH.iter().enumerate() {
            (api.observe_property)(core, id as u64, name.as_ptr(), *format);
        }
        if logging {
            for (id, name) in STATS.iter().enumerate() {
                (api.observe_property)(core, 100 + id as u64, name.as_ptr(), FORMAT_STRING);
            }
        }
    }
    {
        let mut st = s.lock();
        st.core = Some(Handle(core));
        st.paused = paused;
        st.stats = vec![String::new(); STATS.len()];
    }
    s.ctx.request_repaint();
    let set = |name: &CStr, value: &CStr| unsafe {
        (api.set_property_string)(core, name.as_ptr(), value.as_ptr());
    };
    let flag = |on: bool| if on { c"yes" } else { c"no" };
    let number = |n: f64| CString::new(format!("{n:.3}")).unwrap_or_default();
    let command = |args: &[&CStr]| unsafe {
        let mut argv: Vec<*const c_char> = args.iter().map(|a| a.as_ptr()).collect();
        argv.push(std::ptr::null());
        (api.command)(core, argv.as_ptr());
    };
    loop {
        for c in s.next() {
            match c {
                Cmd::Load => {
                    s.lock().stopped = false;
                    command(&[c"loadfile", &path]);
                }
                Cmd::Pause(on) => set(c"pause", flag(on)),
                Cmd::Seek(to, exact) => command(&[c"seek", &number(to), if exact { c"absolute+exact" } else { c"absolute+keyframes" }]),
                Cmd::Nudge(by) => command(&[c"seek", &number(by), c"relative+exact"]),
                Cmd::Volume(v) => set(c"volume", &number(v as f64)),
                Cmd::Mute(on) => set(c"mute", flag(on)),
                Cmd::Stop => command(&[c"stop"]),
                Cmd::Quit => {
                    if logging {
                        note(&format!("{key}: {:?}", STATS.iter().zip(&s.lock().stats).map(|(n, v)| format!("{}={v}", n.to_string_lossy())).collect::<Vec<_>>()));
                    }
                    unsafe { (api.terminate_destroy)(core) };
                    return;
                }
            }
        }
        let mut repaint = false;
        loop {
            let e = unsafe { &*(api.wait_event)(core, 0.0) };
            match e.id {
                EVENT_NONE => break,
                EVENT_FILE_LOADED => {
                    s.lock().stage = Stage::Playing;
                    repaint = true;
                }
                EVENT_PLAYBACK_RESTART => {
                    s.lock().started = true;
                    repaint = true;
                }
                EVENT_IDLE => {
                    s.lock().stopped = true;
                    repaint = true;
                }
                EVENT_END_FILE => {
                    let end = unsafe { &*(e.data as *const EndFile) };
                    if end.reason == END_FILE_ERROR {
                        let why = unsafe { CStr::from_ptr((api.error_string)(end.error)) };
                        s.lock().stage = Stage::Failed(why.to_string_lossy().into_owned());
                        repaint = true;
                    }
                }
                EVENT_PROPERTY_CHANGE => repaint |= changed(&mut s.lock(), e.reply, unsafe { &*(e.data as *const EventProperty) }),
                _ => {}
            }
        }
        let playing = !s.lock().paused;
        if out_of_sight(playing, s.unseen()) {
            set(c"pause", c"yes");
        }
        if repaint {
            s.ctx.request_repaint();
        }
    }
}

/// A window out of sight gets no frames (a hidden Hyprland workspace, a minimized window), so
/// nothing that runs in a frame can notice: `control`, woken by the playing video itself, does.
fn out_of_sight(playing: bool, unseen: Duration) -> bool {
    playing && unseen > HIDDEN
}

/// Takes in a watched property. True when the viewer must draw for it: the position alone isn't
/// (frames come with their own repaint).
fn changed(st: &mut State, id: u64, p: &EventProperty) -> bool {
    if p.format == 0 || p.data.is_null() {
        return id == 4 && {
            st.has_video = false;
            true
        };
    }
    unsafe {
        match id {
            0 => st.pos = *(p.data as *const f64),
            1 => st.dur = *(p.data as *const f64),
            2 => st.paused = *(p.data as *const c_int) != 0,
            3 => st.ended = *(p.data as *const c_int) != 0,
            4 => st.has_video = *(p.data as *const i64) > 0,
            n if p.format == FORMAT_STRING => {
                if let Some(v) = st.stats.get_mut(n.saturating_sub(100) as usize) {
                    *v = CStr::from_ptr(*(p.data as *const *const c_char)).to_string_lossy().into_owned();
                }
            }
            _ => {}
        }
    }
    id > 0 && id < 100
}

fn note(line: &str) {
    use std::io::Write as _;
    let Some(path) = std::env::var_os("HARBOR_VIDEO_LOG") else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

// ---------------------------------------------------------------- the player, on the UI thread

/// The texture frames are drawn into, kept for the window's life (egui can't let go of a texture
/// it was given): back to one pixel between videos.
struct Target {
    fbo: glow::Framebuffer,
    tex: glow::Texture,
    id: egui::TextureId,
    size: [i32; 2],
}

impl Target {
    unsafe fn new(gl: &glow::Context, frame: &mut eframe::Frame) -> Option<Self> {
        unsafe {
            let tex = gl.create_texture().ok()?;
            let fbo = gl.create_framebuffer().ok()?;
            gl.bind_texture(glow::TEXTURE_2D, Some(tex));
            for (name, value) in [(glow::TEXTURE_MIN_FILTER, glow::LINEAR), (glow::TEXTURE_MAG_FILTER, glow::LINEAR), (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE), (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE)] {
                gl.tex_parameter_i32(glow::TEXTURE_2D, name, value as i32);
            }
            let mut t = Self { fbo, tex, id: frame.register_native_glow_texture(tex), size: [0, 0] };
            t.resize(gl, [1, 1]);
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
            gl.framebuffer_texture_2d(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(tex), 0);
            gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            Some(t)
        }
    }

    /// True when the size changed (what's in the texture is gone).
    unsafe fn resize(&mut self, gl: &glow::Context, size: [i32; 2]) -> bool {
        if self.size == size {
            return false;
        }
        self.size = size;
        unsafe {
            gl.bind_texture(glow::TEXTURE_2D, Some(self.tex));
            gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, size[0], size[1], 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(None));
            gl.bind_texture(glow::TEXTURE_2D, None);
        }
        true
    }

    /// mpv draws its current frame here. It expects OpenGL's default state where egui left its own.
    unsafe fn render(&self, gl: &glow::Context, api: &Api, render: *mut c_void) {
        unsafe {
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo));
            gl.disable(glow::SCISSOR_TEST);
            gl.disable(glow::BLEND);
            gl.use_program(None);
            gl.bind_buffer(glow::ARRAY_BUFFER, None);
            gl.active_texture(glow::TEXTURE0);
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 4);
            let mut fbo = Fbo { fbo: self.fbo.0.get() as c_int, w: self.size[0], h: self.size[1], internal_format: glow::RGBA8 as c_int };
            let (mut flip, mut block): (c_int, c_int) = (0, 0);
            let mut params = [
                Param { kind: RENDER_OPENGL_FBO, data: (&raw mut fbo).cast() },
                Param { kind: RENDER_FLIP_Y, data: (&raw mut flip).cast() },
                Param { kind: RENDER_BLOCK_FOR_TARGET_TIME, data: (&raw mut block).cast() },
                Param { kind: 0, data: std::ptr::null_mut() },
            ];
            (api.render_context_render)(render, params.as_mut_ptr());
            gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        }
    }

    unsafe fn delete(self, gl: &glow::Context) {
        // (The texture is egui's now: it goes with the window.)
        unsafe { gl.delete_framebuffer(self.fbo) };
    }
}

type GetProc = unsafe extern "C" fn(*const c_char) -> *mut c_void;

/// The GL loader of the context eframe made: EGL's, else (X11) GLX's. Both are loaded already.
fn get_proc() -> Option<GetProc> {
    static PROC: OnceLock<Option<GetProc>> = OnceLock::new();
    *PROC.get_or_init(|| unsafe {
        let flags = libc::RTLD_NOW | libc::RTLD_LOCAL;
        let found = |lib: *mut c_void, name: &CStr| if lib.is_null() { std::ptr::null_mut() } else { libc::dlsym(lib, name.as_ptr()) };
        let egl = libc::dlopen(c"libEGL.so.1".as_ptr(), flags);
        let current = found(egl, c"eglGetCurrentContext");
        let on_egl = !current.is_null() && !std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> *mut c_void>(current)().is_null();
        let proc = if on_egl { found(egl, c"eglGetProcAddress") } else { found(libc::dlopen(c"libGL.so.1".as_ptr(), flags), c"glXGetProcAddressARB") };
        (!proc.is_null()).then(|| std::mem::transmute::<*mut c_void, GetProc>(proc))
    })
}

unsafe extern "C" fn gl_proc(_: *mut c_void, name: *const c_char) -> *mut c_void {
    get_proc().map_or(std::ptr::null_mut(), |f| unsafe { f(name) })
}

/// libmpv's renderer for `core`, on the window's GL context. No advanced control: with it the core
/// waits for this thread, and a window out of sight gets no frames to answer in.
unsafe fn renderer(api: &Api, core: *mut c_void, frame: &eframe::Frame, s: &Arc<Shared>) -> Option<*mut c_void> {
    get_proc()?;
    let (display, handle) = match frame.display_handle().map(|h| h.as_raw()) {
        Ok(RawDisplayHandle::Wayland(h)) => (RENDER_WL_DISPLAY, h.display.as_ptr()),
        Ok(RawDisplayHandle::Xlib(h)) => h.display.map_or((0, std::ptr::null_mut()), |d| (RENDER_X11_DISPLAY, d.as_ptr())),
        _ => (0, std::ptr::null_mut()),
    };
    let mut init = GlInit { get_proc_address: gl_proc, ctx: std::ptr::null_mut(), extra_exts: std::ptr::null() };
    let mut params = [
        Param { kind: RENDER_API_TYPE, data: c"opengl".as_ptr() as *mut c_void },
        Param { kind: RENDER_OPENGL_INIT, data: (&raw mut init).cast() },
        Param { kind: display, data: handle },
        Param { kind: 0, data: std::ptr::null_mut() },
    ];
    let mut render = std::ptr::null_mut();
    unsafe {
        if (api.render_context_create)(&raw mut render, core, params.as_mut_ptr()) < 0 {
            return None;
        }
        (api.render_context_set_update_callback)(render, frame_ready, Arc::as_ptr(s) as *mut c_void);
    }
    Some(render)
}

struct Player {
    key: String,
    s: Arc<Shared>,
    render: Option<Handle>,
    /// mpv couldn't draw in this window (it says so in the viewer).
    broken: bool,
    closing: bool,
    /// When it was asked to close.
    closed: Instant,
    /// The texture holds a picture of this video.
    drawn: bool,
    /// When the pointer last moved or a key was pressed (egui's clock).
    moved: f64,
    /// Where the seek bar is held, in seconds.
    drag: Option<f64>,
    muted: bool,
    // What the UI thread spends on it (microseconds), for the log.
    frames: u64,
    render_us: u64,
    render_max: u64,
    create_us: u64,
}

impl Player {
    /// Silent at once; what's left goes in a later [`pump`].
    fn close(&mut self) {
        if !self.closing {
            self.closing = true;
            self.closed = Instant::now();
            self.s.send(Cmd::Stop);
        }
    }

    /// Lets go of everything; the core goes on its thread. Ending the renderer waits for mpv to
    /// drop the video, so this comes after it did ([`pump`]).
    fn finish(mut self) {
        let t = Instant::now();
        if let (Some(render), Some(api)) = (self.render.take(), API.get()) {
            unsafe { (api.render_context_free)(render.0) };
        }
        if log_file().is_some() {
            let avg = self.render_us / self.frames.max(1);
            note(&format!("{}: {} frames drawn, {avg} µs avg, {} µs max; renderer made in {} µs, freed in {} µs", self.key, self.frames, self.render_max, self.create_us, t.elapsed().as_micros()));
        }
        self.s.send(Cmd::Quit);
    }
}

/// A video to open once the last one is gone (that takes a frame, for its GL context).
struct Next {
    ctx: egui::Context,
    key: String,
    fetch: Option<Fetch>,
    play: bool,
}

#[derive(Default)]
struct Viewer {
    player: Option<Player>,
    next: Option<Next>,
    target: Option<Target>,
    /// Whether the window was full screen before a video changed that.
    was_full: Option<bool>,
}

static VIEWER: Mutex<Viewer> = Mutex::new(Viewer { player: None, next: None, target: None, was_full: None });
/// Percent, for every video; App keeps it in the store.
static VOLUME: AtomicU32 = AtomicU32::new(100);
static VOLUME_CHANGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn viewer() -> MutexGuard<'static, Viewer> {
    VIEWER.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn set_volume(percent: u32) {
    VOLUME.store(percent.min(100), Ordering::Relaxed);
}

/// The volume when it changed since the last call.
pub fn take_volume() -> Option<u32> {
    VOLUME_CHANGED.swap(false, Ordering::Relaxed).then(|| VOLUME.load(Ordering::Relaxed))
}

fn spawn(ctx: egui::Context, key: String, fetch: Option<Fetch>, play: bool) -> Player {
    let s = Arc::new(Shared { ctx, state: Mutex::default(), wake: Condvar::new(), born: Instant::now(), seen: AtomicU64::new(0) });
    let (for_thread, file) = (s.clone(), key.clone());
    std::thread::spawn(move || control(for_thread, file, fetch, !play));
    let moved = s.ctx.input(|i| i.time);
    Player { key, s, render: None, broken: false, closing: false, closed: Instant::now(), drawn: false, moved, drag: None, muted: false, frames: 0, render_us: 0, render_max: 0, create_us: 0 }
}

/// A video is showing in the viewer (or about to).
pub fn is_open() -> bool {
    let v = viewer();
    v.next.is_some() || v.player.as_ref().is_some_and(|p| !p.closing)
}

/// Shows `key`, playing or waiting at its first frame. `fetch`: it's a file of another PC's chat.
pub fn open(ctx: &egui::Context, key: &str, fetch: Option<Fetch>, play: bool) {
    let mut v = viewer();
    match &mut v.player {
        Some(p) if p.key == key && !p.closing => {}
        Some(p) => {
            p.close();
            v.next = Some(Next { ctx: ctx.clone(), key: key.to_string(), fetch, play });
            ctx.request_repaint();
        }
        None => v.player = Some(spawn(ctx.clone(), key.to_string(), fetch, play)),
    }
}

/// Stops the video.
pub fn close(ctx: &egui::Context) {
    let mut v = viewer();
    v.next = None;
    if v.was_full.take() == Some(false) {
        ctx.send_viewport_cmd(egui::ViewportCommand::Fullscreen(false));
    }
    let Some(p) = v.player.as_mut() else { return };
    p.close();
    ctx.request_repaint();
}

/// The window is going: everything of the player, while its GL context is still there.
pub fn shutdown(gl: Option<&glow::Context>) {
    let mut v = viewer();
    v.next = None;
    if let Some(p) = v.player.take() {
        p.finish();
    }
    if let (Some(t), Some(gl)) = (v.target.take(), gl) {
        unsafe { t.delete(gl) };
    }
}

/// The player's GL work for this frame: starts its renderer, draws a new frame, ends a closed
/// one. Call once per frame, whether a video shows or not, before drawing the viewer.
pub fn pump(ctx: &egui::Context, frame: &mut eframe::Frame) {
    let mut v = viewer();
    if v.player.is_none() {
        return;
    }
    let Some(gl) = frame.gl().cloned() else { return };
    if let Some(p) = v.player.as_ref().filter(|p| p.closing) {
        if p.render.is_some() && !p.s.lock().stopped && p.closed.elapsed() < STOP_WAIT {
            ctx.request_repaint_after(STOP_WAIT);
            return;
        }
        if let Some(p) = v.player.take() {
            p.finish();
        }
        if let Some(t) = v.target.as_mut() {
            unsafe { t.resize(&gl, [1, 1]) };
        }
        if let Some(n) = v.next.take() {
            v.player = Some(spawn(n.ctx, n.key, n.fetch, n.play));
        }
        return;
    }
    let Some(api) = API.get() else { return };
    let v = &mut *v;
    let Some(p) = v.player.as_mut() else { return };
    if p.render.is_none() {
        let core = p.s.lock().core.as_ref().map(|c| c.0).filter(|_| !p.broken);
        let Some(core) = core else { return };
        let t = Instant::now();
        match unsafe { renderer(api, core, frame, &p.s) } {
            Some(r) => {
                p.render = Some(Handle(r));
                p.create_us = t.elapsed().as_micros() as u64;
                p.s.send(Cmd::Load);
            }
            None => {
                p.broken = true;
                p.s.fail(Stage::Failed("mpv can't draw in this window".into()));
                return;
            }
        }
    }
    if v.target.is_none() {
        v.target = unsafe { Target::new(&gl, frame) };
    }
    let (Some(render), Some(target)) = (p.render.as_ref().map(|r| r.0), v.target.as_mut()) else { return };
    let size = ctx.content_rect().size() * ctx.pixels_per_point();
    let resized = unsafe { target.resize(&gl, [(size.x.round() as i32).max(1), (size.y.round() as i32).max(1)]) };
    let flags = unsafe { (api.render_context_update)(render) };
    if flags & RENDER_UPDATE_FRAME != 0 || resized {
        let t = Instant::now();
        unsafe { target.render(&gl, api, render) };
        let took = t.elapsed().as_micros() as u64;
        p.frames += 1;
        p.render_us += took;
        p.render_max = p.render_max.max(took);
        p.drawn |= p.s.lock().started;
    }
}

/// Draws the video's picture over `screen`; false while it has none (the viewer shows its poster).
pub fn picture(ui: &mut Ui, screen: Rect) -> bool {
    let v = viewer();
    let (Some(p), Some(t)) = (&v.player, &v.target) else { return false };
    if !p.drawn || !p.s.lock().has_video {
        return false;
    }
    ui.painter().image(t.id, screen, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), Color32::WHITE);
    true
}

fn toggle(p: &Player, paused: bool, ended: bool) {
    // (Nothing was drawn while paused: this mustn't read as a window out of sight.)
    p.s.drawn();
    if ended {
        p.s.send(Cmd::Seek(0.0, true));
        p.s.send(Cmd::Pause(false));
    } else {
        p.s.send(Cmd::Pause(!paused));
    }
}

fn fullscreen(ctx: &egui::Context, was_full: &mut Option<bool>) {
    let full = ctx.input(|i| i.viewport().fullscreen.unwrap_or(false));
    was_full.get_or_insert(full);
    ctx.send_viewport_cmd(egui::ViewportCommand::Fullscreen(!full));
}

fn change_volume(p: &mut Player, percent: u32) {
    let percent = percent.min(100);
    VOLUME.store(percent, Ordering::Relaxed);
    VOLUME_CHANGED.store(true, Ordering::Relaxed);
    p.s.send(Cmd::Volume(percent));
    if p.muted {
        p.muted = false;
        p.s.send(Cmd::Mute(false));
    }
}

/// While a video shows: its keys, taken before anything else sees them. Returns what's left for
/// the viewer: previous, next, close.
pub fn take_keys(ctx: &egui::Context) -> [bool; 3] {
    let none = egui::Modifiers::NONE;
    let [space, left, right, up, down, m, f, esc, prev, next] = ctx.input_mut(|i| [Key::Space, Key::ArrowLeft, Key::ArrowRight, Key::ArrowUp, Key::ArrowDown, Key::M, Key::F, Key::Escape, Key::PageUp, Key::PageDown].map(|k| i.consume_key(none, k)));
    if !(space || left || right || up || down || m || f || esc) {
        return [prev, next, false];
    }
    let mut v = viewer();
    let v = &mut *v;
    let Some(p) = v.player.as_mut() else { return [prev, next, esc] };
    p.moved = ctx.input(|i| i.time);
    let (paused, ended) = {
        let st = p.s.lock();
        (st.paused, st.ended)
    };
    if space {
        toggle(p, paused, ended);
    }
    if left {
        p.s.send(Cmd::Nudge(-NUDGE));
    }
    if right {
        p.s.send(Cmd::Nudge(NUDGE));
    }
    if up || down {
        let now = VOLUME.load(Ordering::Relaxed);
        change_volume(p, if up { now + VOLUME_STEP } else { now.saturating_sub(VOLUME_STEP) });
    }
    if m {
        p.muted = !p.muted;
        p.s.send(Cmd::Mute(p.muted));
    }
    if f {
        fullscreen(ctx, &mut v.was_full);
    }
    // Esc leaves full screen first, then the viewer.
    let leave = esc && ctx.input(|i| i.viewport().fullscreen.unwrap_or(false));
    if leave {
        fullscreen(ctx, &mut v.was_full);
    }
    [prev, next, esc && !leave]
}

/// "1:05", or "1:02:05" past an hour.
fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

fn icon_button(ui: &Ui, r: Rect, id: &str, glyph: &str, tip: &str) -> bool {
    let resp = ui.interact(r, Id::NULL.with(("video", id)), Sense::click()).on_hover_cursor(CursorIcon::PointingHand).tip(tip);
    if resp.hovered() {
        ui.painter().rect_filled(r, CornerRadius::same(6), Color32::from_white_alpha(28));
    }
    ic::glyph(ui.painter(), r.center(), glyph, 16.0, Color32::WHITE);
    resp.clicked()
}

/// A thin bar filled to `at` (0 to 1): it and where the pointer holds it, from 0 to 1.
fn slider(ui: &Ui, r: Rect, id: &str, at: f32) -> (Response, Option<f32>) {
    let resp = ui.interact(r, Id::NULL.with(("video", id)), Sense::click_and_drag()).on_hover_cursor(CursorIcon::PointingHand);
    let thick = if resp.hovered() || resp.dragged() { 5.0 } else { 3.0 };
    let line = Rect::from_center_size(r.center(), vec2(r.width(), thick));
    let radius = CornerRadius::same(2);
    let p = ui.painter();
    p.rect_filled(line, radius, Color32::from_white_alpha(70));
    p.rect_filled(Rect::from_min_size(line.min, vec2(line.width() * at.clamp(0.0, 1.0), thick)), radius, Color32::WHITE);
    let held = resp.is_pointer_button_down_on().then(|| resp.interact_pointer_pos()).flatten().map(|p| ((p.x - r.left()) / r.width()).clamp(0.0, 1.0));
    (resp, held)
}

/// What [`controls`] asks of the viewer.
#[derive(Default)]
pub struct Drawn {
    /// How visible its own buttons should be, like the controls.
    pub alpha: f32,
    pub shut: bool,
}

/// The controls over a video on `screen`: they fade while it plays. A click on the video pauses
/// it, a double click takes it full screen.
pub fn controls(ui: &mut Ui, screen: Rect) -> Drawn {
    let ctx = ui.ctx().clone();
    let mut v = viewer();
    let v = &mut *v;
    let Some(p) = v.player.as_mut() else { return Drawn { alpha: 1.0, shut: false } };
    p.s.drawn();
    let (stage, pos, dur, paused, ended, started, has_video) = {
        let st = p.s.lock();
        (st.stage.clone(), st.pos, st.dur, st.paused, st.ended, st.started, st.has_video)
    };
    match stage {
        Stage::NoMpv(file) => {
            // Once, however many passes a frame takes.
            p.closing = true;
            crate::git::open_url(&file.to_string_lossy());
            crate::picker::show_toast(&ctx, WARN_NO_MPV.to_string());
            return Drawn { alpha: 1.0, shut: true };
        }
        Stage::Failed(why) => {
            ui.painter().text(screen.center(), egui::Align2::CENTER_CENTER, format!("Can't play this video: {why}"), FontId::proportional(14.0), Color32::from_gray(220));
            let file = crate::media::located(Path::new(&p.key)).into_owned();
            if file.is_file() {
                let r = Rect::from_center_size(screen.center() + vec2(0.0, 36.0), vec2(240.0, 28.0));
                let mut child = ui.new_child(egui::UiBuilder::new().max_rect(r).layout(egui::Layout::top_down(egui::Align::Center)));
                if w::btn(&format!("{}  Open in your video player", ic::EXTERNAL)).secondary().xs().show(&mut child).clicked() {
                    crate::git::open_url(&file.to_string_lossy());
                }
            }
            return Drawn { alpha: 1.0, shut: false };
        }
        Stage::Starting | Stage::Playing => {}
    }
    if !started {
        w::spinner(ui.painter(), screen.center(), 12.0, Color32::WHITE);
    }
    let area = ui.interact(screen, Id::NULL.with(("video", "area")), Sense::click());
    let now = ctx.input(|i| i.time);
    if ctx.input(|i| i.pointer.delta() != Vec2::ZERO || i.pointer.any_down()) {
        p.moved = now;
    }
    let bar = Rect::from_min_max(pos2(screen.left() + 12.0, screen.bottom() - 52.0), pos2(screen.right() - 12.0, screen.bottom() - 12.0));
    let over = ctx.pointer_latest_pos().is_some_and(|at| bar.contains(at));
    let show = paused || over || p.drag.is_some() || now - p.moved < CONTROLS_FOR;
    let alpha = ctx.animate_bool_with_time(Id::NULL.with(("video", "controls")), show, 0.18);
    if !paused {
        // Frames repaint by themselves; this is for the clock and the fade of a still one.
        ctx.request_repaint_after(Duration::from_millis(if has_video { 500 } else { 250 }));
    }
    if alpha <= 0.0 {
        ctx.set_cursor_icon(CursorIcon::None);
    } else {
        let mut ui = ui.new_child(egui::UiBuilder::new().max_rect(screen));
        ui.multiply_opacity(alpha);
        let y = bar.center().y;
        ui.painter().rect_filled(bar, CornerRadius::same(RADIUS_MD), Color32::from_black_alpha(170));
        // An unused click on the bar isn't one on the video.
        ui.interact(bar, Id::NULL.with(("video", "bar")), Sense::click());
        let cell = |x: f32, width: f32| Rect::from_min_size(pos2(x, y - 14.0), vec2(width, 28.0));
        let mut left = bar.left() + 6.0;
        let (glyph, tip) = if ended { (ic::PLAY, "Play again (Space)") } else if paused { (ic::PLAY, "Play (Space)") } else { (ic::PAUSE, "Pause (Space)") };
        if icon_button(&ui, cell(left, 28.0), "play", glyph, tip) {
            toggle(p, paused, ended);
        }
        left += 28.0 + 8.0;
        let shown = p.drag.unwrap_or(pos);
        let time = ui.painter().layout_no_wrap(format!("{} / {}", clock(shown), clock(dur)), FontId::monospace(12.0), Color32::from_gray(230));
        ui.painter().galley(pos2(left, y - time.size().y / 2.0), time.clone(), Color32::from_gray(230));
        left += time.size().x + 12.0;
        let mut right = bar.right() - 6.0 - 28.0;
        let full = ctx.input(|i| i.viewport().fullscreen.unwrap_or(false));
        if icon_button(&ui, cell(right, 28.0), "full", if full { ic::MINIMIZE } else { ic::MAXIMIZE }, "Full screen (F)") {
            fullscreen(&ctx, &mut v.was_full);
        }
        right -= 8.0 + 64.0;
        let volume = VOLUME.load(Ordering::Relaxed);
        let (_, held) = slider(&ui, cell(right, 64.0), "volume", if p.muted { 0.0 } else { volume as f32 / 100.0 });
        if let Some(at) = held {
            let to = (at * 100.0).round() as u32;
            if to != volume || p.muted {
                change_volume(p, to);
            }
        }
        right -= 4.0 + 28.0;
        if icon_button(&ui, cell(right, 28.0), "mute", if p.muted || volume == 0 { ic::VOLUME_X } else { ic::VOLUME }, "Mute (M)") {
            p.muted = !p.muted;
            p.s.send(Cmd::Mute(p.muted));
        }
        let seek = Rect::from_min_max(pos2(left, bar.top()), pos2(right - 12.0, bar.bottom()));
        if seek.width() > 16.0 && dur > 0.0 {
            let (resp, held) = slider(&ui, seek, "seek", (shown / dur) as f32);
            if let Some(at) = held {
                let to = at as f64 * dur;
                if p.drag != Some(to) {
                    p.drag = Some(to);
                    p.s.send(Cmd::Seek(to, false));
                }
            } else if resp.drag_stopped() || resp.clicked() {
                if let Some(to) = p.drag.take() {
                    p.s.send(Cmd::Seek(to, true));
                }
            }
        }
    }
    if area.double_clicked() {
        fullscreen(&ctx, &mut v.was_full);
    } else if area.clicked() {
        toggle(p, paused, ended);
    }
    Drawn { alpha, shut: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_reads_like_a_player() {
        assert_eq!((clock(0.0), clock(9.9), clock(65.0), clock(3725.0), clock(-1.0)), ("0:00".to_string(), "0:09".to_string(), "1:05".to_string(), "1:02:05".to_string(), "0:00".to_string()));
    }

    #[test]
    fn only_the_last_seek_of_a_drag_is_kept() {
        let mut q = vec![];
        push(&mut q, Cmd::Seek(1.0, false));
        push(&mut q, Cmd::Pause(true));
        push(&mut q, Cmd::Seek(2.0, false));
        push(&mut q, Cmd::Seek(3.0, true));
        assert_eq!(q, [Cmd::Pause(true), Cmd::Seek(3.0, true)]);
    }

    #[test]
    fn a_window_out_of_sight_pauses_a_playing_video_only() {
        assert!(out_of_sight(true, HIDDEN + Duration::from_millis(1)));
        assert!(!out_of_sight(true, HIDDEN / 2));
        assert!(!out_of_sight(false, HIDDEN * 10));
    }

    #[test]
    fn the_player_reads_nothing_but_the_file() {
        let on = |name: &CStr, value: &CStr| OPTIONS.iter().rev().find(|(n, _)| *n == name).is_some_and(|(_, v)| *v == value);
        for name in [c"config", c"load-scripts", c"ytdl", c"access-references", c"ordered-chapters", c"sub-auto", c"audio-file-auto", c"autoload-files", c"resume-playback", c"input-default-bindings"] {
            assert!(on(name, c"no"), "{name:?}");
        }
        assert!(on(c"vo", c"libmpv"));
    }

    #[test]
    fn plays_only_what_media_allows_as_an_absolute_path() {
        let d = std::env::temp_dir().join(format!("harbor-video-test-{}", std::process::id()));
        std::fs::create_dir_all(d.join(".ssh")).unwrap();
        let mp4 = b"\0\0\0\x18ftypmp42\0\0\0\0";
        std::fs::write(d.join("clip.mp4"), mp4).unwrap();
        std::fs::write(d.join("--script=x.mp4"), mp4).unwrap();
        std::fs::write(d.join(".ssh/key.mp4"), mp4).unwrap();
        std::fs::write(d.join("fake.mp4"), b"not a video at all").unwrap();
        std::fs::write(d.join("pic.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        assert_eq!(playable(&d.join("clip.mp4")).unwrap(), d.join("clip.mp4").canonicalize().unwrap());
        // A name that reads like an option is still a path from the root.
        assert!(playable(&d.join("--script=x.mp4")).unwrap().starts_with("/"));
        for bad in [d.join(".ssh/key.mp4"), d.join("fake.mp4"), d.join("pic.png"), d.join("missing.mp4"), PathBuf::from("clip.mp4"), PathBuf::from("https://example.com/a.mp4")] {
            assert!(playable(&bad).is_err(), "{bad:?}");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_video_of_another_pc_is_saved_here_before_it_plays() {
        let key = format!("/home-pc/{}-run.mp4", std::process::id());
        let asked = Arc::new(Mutex::new(0));
        let log = asked.clone();
        let fetch: Fetch = Arc::new(move |_: &str| {
            *log.lock().unwrap() += 1;
            Some(b"\0\0\0\x18ftypmp42\0\0\0\0".to_vec())
        });
        let file = file_of(&key, Some(fetch)).unwrap();
        assert!(file.is_absolute() && file.to_string_lossy().ends_with(".mp4"));
        assert_eq!(*asked.lock().unwrap(), 1);
        let _ = std::fs::remove_file(&file);
        let off: Fetch = Arc::new(|_: &str| None);
        assert!(file_of(&key, Some(off)).unwrap_err().contains("off"));
    }
}
