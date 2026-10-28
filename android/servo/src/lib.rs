//! Servo for Harbor for Android's browser screen (`dev.harbor.app.Browser`).
//!
//! The app loads this library in its own `:browser` process and calls the `Engine` natives
//! below from one thread (the "servo" HandlerThread): Servo and its rendering context live on
//! that thread. Servo draws with its own GL (surfman over EGL) straight into the screen's
//! SurfaceView, the way servoshell's Android port does; no WebView is involved.
//!
//! Java → Rust: init, attach/detach (the Surface), resize, load/back/forward/reload, touch,
//! key, imeText, spin (Servo woke up), frame (a vsync asked for by `requestFrame`).
//! Rust → Java (the callbacks object given to init): wakeup() from any thread; requestFrame(),
//! onUrl(String), onTitle(String), onLoading(boolean), onHistory(boolean, boolean),
//! onIme(boolean) on the servo thread.

#![cfg(target_os = "android")]
#![allow(non_snake_case)]

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::rc::Rc;

use dpi::PhysicalSize;
use euclid::Scale;
use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::sys::{jboolean, jfloat, jint, jobject};
use jni::{JNIEnv, JavaVM};
use keyboard_types::{CompositionEvent, CompositionState, Key, KeyState, NamedKey};
use raw_window_handle::{AndroidDisplayHandle, AndroidNdkWindowHandle, DisplayHandle, RawDisplayHandle, RawWindowHandle, WindowHandle};
use servo::{
    DevicePoint, EmbedderControl, EmbedderControlId, EventLoopWaker, ImeEvent, InputEvent, KeyboardEvent, LoadStatus, Preferences,
    RefreshDriver, RenderingContext, Servo, ServoBuilder, SimpleDialog, TouchEvent, TouchEventType, TouchId, TouchPointerType,
    WebView, WebViewBuilder, WebViewDelegate, WindowRenderingContext,
};
use url::Url;

unsafe extern "C" {
    fn ANativeWindow_fromSurface(env: *mut jni::sys::JNIEnv, surface: jobject) -> *mut c_void;
    fn ANativeWindow_release(window: *mut c_void);
}

/// The Java callbacks object and the VM, for calls from any thread.
struct Host {
    vm: JavaVM,
    obj: GlobalRef,
}

impl Host {
    fn call(&self, name: &str, sig: &str, args: &[JValue]) {
        if let Ok(mut env) = self.vm.attach_current_thread_permanently() {
            if env.call_method(self.obj.as_obj(), name, sig, args).is_err() {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
            }
        }
    }
    fn string(&self, name: &str, s: &str) {
        if let Ok(mut env) = self.vm.attach_current_thread_permanently() {
            if let Ok(js) = env.new_string(s) {
                let _ = env.call_method(self.obj.as_obj(), name, "(Ljava/lang/String;)V", &[JValue::Object(&js)]);
                let _ = env.exception_clear();
            }
        }
    }
}

// The waker crosses threads; Host only holds a JavaVM and a GlobalRef (both thread-safe).
struct SendWaker(std::sync::Arc<(JavaVM, GlobalRef)>);

impl EventLoopWaker for SendWaker {
    fn clone_box(&self) -> Box<dyn EventLoopWaker> {
        Box::new(SendWaker(self.0.clone()))
    }
    fn wake(&self) {
        if let Ok(mut env) = self.0.0.attach_current_thread_permanently() {
            let _ = env.call_method(self.0.1.as_obj(), "wakeup", "()V", &[]);
            let _ = env.exception_clear();
        }
    }
}

/// Frame starts come from Android's Choreographer: asked for only while Servo waits for one.
struct Vsync {
    host: Rc<Host>,
    callbacks: RefCell<Vec<Box<dyn Fn() + Send>>>,
}

impl RefreshDriver for Vsync {
    fn observe_next_frame(&self, cb: Box<dyn Fn() + Send + 'static>) {
        let was_empty = {
            let mut c = self.callbacks.borrow_mut();
            c.push(cb);
            c.len() == 1
        };
        if was_empty {
            self.host.call("requestFrame", "()V", &[]);
        }
    }
}

struct Delegate {
    host: Rc<Host>,
    dirty: Cell<bool>,
    ime: Cell<Option<EmbedderControlId>>,
}

impl WebViewDelegate for Delegate {
    fn notify_new_frame_ready(&self, _: WebView) {
        self.dirty.set(true);
    }
    fn notify_url_changed(&self, _: WebView, url: Url) {
        self.host.string("onUrl", url.as_str());
    }
    fn notify_page_title_changed(&self, _: WebView, title: Option<String>) {
        self.host.string("onTitle", &title.unwrap_or_default());
    }
    fn notify_load_status_changed(&self, _: WebView, status: LoadStatus) {
        let on = !matches!(status, LoadStatus::Complete);
        self.host.call("onLoading", "(Z)V", &[JValue::Bool(on as u8)]);
    }
    fn notify_history_changed(&self, wv: WebView, _: Vec<Url>, _: usize) {
        self.host.call("onHistory", "(ZZ)V", &[JValue::Bool(wv.can_go_back() as u8), JValue::Bool(wv.can_go_forward() as u8)]);
    }
    fn show_embedder_control(&self, _: WebView, control: EmbedderControl) {
        match control {
            EmbedderControl::InputMethod(im) => {
                self.ime.set(Some(im.id()));
                self.host.call("onIme", "(Z)V", &[JValue::Bool(1)]);
            }
            // Page dialogs: alert() is acknowledged, confirm()/prompt() answered "cancel".
            EmbedderControl::SimpleDialog(SimpleDialog::Alert(a)) => a.confirm(),
            EmbedderControl::SimpleDialog(d) => d.dismiss(),
            _ => {}
        }
    }
    fn hide_embedder_control(&self, _: WebView, id: EmbedderControlId) {
        if self.ime.get() == Some(id) {
            self.ime.set(None);
            self.host.call("onIme", "(Z)V", &[JValue::Bool(0)]);
        }
    }
}

struct Page {
    ctx: Rc<WindowRenderingContext>,
    vsync: Rc<Vsync>,
    delegate: Rc<Delegate>,
    webview: WebView,
    /// The ANativeWindow the context draws into (released when replaced).
    window: *mut c_void,
}

struct State {
    servo: Servo,
    host: Rc<Host>,
    density: f32,
    page: Option<Page>,
    /// The URL to open once the first Surface is attached.
    pending: Option<Url>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> Option<R> {
    STATE.with(|s| s.borrow_mut().as_mut().map(f))
}

/// "localhost:3000" → http, "example.com" → https, anything else → a search (as on the desktop).
fn normalize(input: &str) -> Option<Url> {
    let s = input.trim();
    if let Ok(u) = Url::parse(s) {
        if matches!(u.scheme(), "http" | "https" | "about" | "data") {
            return Some(u);
        }
    }
    let local = s.starts_with("localhost") || s.starts_with("127.") || s.starts_with("0.0.0.0") || s.starts_with('[');
    if local {
        return Url::parse(&format!("http://{s}")).ok();
    }
    if s.contains('.') && !s.contains(' ') {
        return Url::parse(&format!("https://{s}")).ok();
    }
    Url::parse_with_params("https://duckduckgo.com/", &[("q", s)]).ok()
}

fn jstr(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(|s| s.into()).unwrap_or_default()
}

fn handles(env: &JNIEnv, surface: &JObject) -> Option<(RawDisplayHandle, RawWindowHandle, *mut c_void)> {
    let w = unsafe { ANativeWindow_fromSurface(env.get_raw(), surface.as_raw()) };
    let nn = NonNull::new(w)?;
    Some((RawDisplayHandle::Android(AndroidDisplayHandle::new()), RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(nn)), w))
}

/// Gives back our reference to an ANativeWindow (null: none held).
fn release(w: *mut c_void) {
    if !w.is_null() {
        unsafe { ANativeWindow_release(w) };
    }
}

/// Lets Servo work, then paints a frame if one is ready.
fn pump(s: &mut State) {
    s.servo.spin_event_loop();
    if let Some(p) = &s.page {
        if p.delegate.dirty.take() {
            if p.ctx.make_current().is_ok() {
                p.webview.paint();
                p.ctx.present();
            }
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_init(env: JNIEnv, _: JClass, callbacks: JObject, density: jfloat) -> jboolean {
    if STATE.with(|s| s.borrow().is_some()) {
        return 1;
    }
    android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Warn).with_tag("harbor-servo"));
    std::panic::set_hook(Box::new(|info| log::error!("panic: {info}")));
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (Ok(vm), Ok(obj)) = (env.get_java_vm(), env.new_global_ref(&callbacks)) else { return 0 };
    let (Ok(vm2), obj2) = (env.get_java_vm(), obj.clone()) else { return 0 };
    let host = Rc::new(Host { vm, obj });
    let mut prefs = Preferences::default();
    // Phone layouts: honour <meta name=viewport>.
    prefs.viewport_meta_enabled = true;
    let servo = ServoBuilder::default()
        .preferences(prefs)
        .event_loop_waker(Box::new(SendWaker(std::sync::Arc::new((vm2, obj2)))))
        .build();
    STATE.with(|s| *s.borrow_mut() = Some(State { servo, host, density: density.max(0.5), page: None, pending: None }));
    1
}

/// A Surface to draw into: the first one creates the page (loading `url`), later ones (after
/// the screen came back) are rebound.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_attach(mut env: JNIEnv, _: JClass, surface: JObject, w: jint, h: jint, url: JString) -> jboolean {
    let url = jstr(&mut env, &url);
    let Some((display, window, raw)) = handles(&env, &surface) else { return 0 };
    let size = PhysicalSize::new(w.max(1) as u32, h.max(1) as u32);
    let ok = with(|s| {
        let window_handle = unsafe { WindowHandle::borrow_raw(window) };
        if let Some(p) = &mut s.page {
            let ok = p.ctx.set_window(window_handle, size).is_ok();
            release(p.window);
            p.window = raw;
            p.webview.resize(size);
            p.delegate.dirty.set(true);
            pump(s);
            return ok;
        }
        let display_handle = unsafe { DisplayHandle::borrow_raw(display) };
        let vsync = Rc::new(Vsync { host: s.host.clone(), callbacks: RefCell::new(Vec::new()) });
        let Ok(ctx) = WindowRenderingContext::new_with_refresh_driver(display_handle, window_handle, size, vsync.clone()) else {
            unsafe { ANativeWindow_release(raw) };
            return false;
        };
        let ctx = Rc::new(ctx);
        let delegate = Rc::new(Delegate { host: s.host.clone(), dirty: Cell::new(true), ime: Cell::new(None) });
        let start = normalize(&url).or_else(|| s.pending.take()).unwrap_or_else(|| Url::parse("about:blank").unwrap());
        let webview = WebViewBuilder::new(&s.servo, ctx.clone())
            .url(start)
            .hidpi_scale_factor(Scale::new(s.density))
            .delegate(delegate.clone())
            .build();
        webview.show();
        webview.set_focused(true);
        s.page = Some(Page { ctx, vsync, delegate, webview, window: raw });
        pump(s);
        true
    });
    ok.unwrap_or(false) as jboolean
}

/// The Surface is going away (screen hidden): stop drawing into it.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_detach(_: JNIEnv, _: JClass) {
    with(|s| {
        if let Some(p) = &mut s.page {
            let _ = p.ctx.take_window();
            release(p.window);
            p.window = std::ptr::null_mut();
        }
        s.servo.spin_event_loop();
    });
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_resize(_: JNIEnv, _: JClass, w: jint, h: jint) {
    with(|s| {
        if let Some(p) = &s.page {
            p.webview.resize(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
            p.delegate.dirty.set(true);
        }
        pump(s);
    });
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_load(mut env: JNIEnv, _: JClass, url: JString) {
    let url = jstr(&mut env, &url);
    let Some(u) = normalize(&url) else { return };
    with(|s| {
        match &s.page {
            Some(p) => p.webview.load(u),
            None => s.pending = Some(u),
        }
        pump(s);
    });
}

/// 0 back, 1 forward, 2 reload.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_nav(_: JNIEnv, _: JClass, what: jint) {
    with(|s| {
        if let Some(p) = &s.page {
            match what {
                0 => {
                    p.webview.go_back(1);
                }
                1 => {
                    p.webview.go_forward(1);
                }
                _ => p.webview.reload(),
            }
        }
        pump(s);
    });
}

/// action: 0 down, 1 move, 2 up, 3 cancel; x, y in device pixels.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_touch(_: JNIEnv, _: JClass, action: jint, id: jint, x: jfloat, y: jfloat) {
    let kind = match action {
        0 => TouchEventType::Down,
        1 => TouchEventType::Move,
        2 => TouchEventType::Up,
        _ => TouchEventType::Cancel,
    };
    with(|s| {
        if let Some(p) = &s.page {
            let ev = TouchEvent::new(kind, TouchId(id), DevicePoint::new(x, y).into(), TouchPointerType::Touch);
            p.webview.notify_input_event(InputEvent::Touch(ev));
        }
        pump(s);
    });
}

/// A key: `unicode` its character (0: none), else Android's `keycode` for the named ones.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_key(_: JNIEnv, _: JClass, keycode: jint, unicode: jint, down: jboolean) {
    let key = char::from_u32(unicode as u32).filter(|c| *c != '\0' && !c.is_control()).map(|c| Key::Character(c.to_string())).or_else(|| {
        Some(Key::Named(match keycode {
            66 | 160 => NamedKey::Enter,
            67 => NamedKey::Backspace,
            112 => NamedKey::Delete,
            61 => NamedKey::Tab,
            111 => NamedKey::Escape,
            21 => NamedKey::ArrowLeft,
            22 => NamedKey::ArrowRight,
            19 => NamedKey::ArrowUp,
            20 => NamedKey::ArrowDown,
            122 => NamedKey::Home,
            123 => NamedKey::End,
            _ => return None,
        }))
    });
    let Some(key) = key else { return };
    let state = if down != 0 { KeyState::Down } else { KeyState::Up };
    with(|s| {
        if let Some(p) = &s.page {
            p.webview.notify_input_event(InputEvent::Keyboard(KeyboardEvent::from_state_and_key(state, key)));
        }
        pump(s);
    });
}

/// Text from the soft keyboard (a committed word, a pasted string…).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_imeText(mut env: JNIEnv, _: JClass, text: JString) {
    let text = jstr(&mut env, &text);
    if text.is_empty() {
        return;
    }
    with(|s| {
        if let Some(p) = &s.page {
            let wv = &p.webview;
            wv.notify_input_event(InputEvent::Keyboard(KeyboardEvent::from_state_and_key(KeyState::Down, Key::Named(NamedKey::Process))));
            wv.notify_input_event(InputEvent::Ime(ImeEvent::Composition(CompositionEvent { state: CompositionState::End, data: text })));
            wv.notify_input_event(InputEvent::Keyboard(KeyboardEvent::from_state_and_key(KeyState::Up, Key::Named(NamedKey::Process))));
        }
        pump(s);
    });
}

/// The soft keyboard was closed by the user.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_imeDismissed(_: JNIEnv, _: JClass) {
    with(|s| {
        if let Some(p) = &s.page {
            p.webview.notify_input_event(InputEvent::Ime(ImeEvent::Dismissed));
        }
        pump(s);
    });
}

/// Servo woke up (`wakeup`, posted to the servo thread).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_spin(_: JNIEnv, _: JClass) {
    with(pump);
}

/// A vsync asked for with `requestFrame`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_harbor_app_Engine_frame(_: JNIEnv, _: JClass) {
    with(|s| {
        if let Some(p) = &s.page {
            let cbs: Vec<_> = p.vsync.callbacks.borrow_mut().drain(..).collect();
            for cb in cbs {
                cb();
            }
        }
        pump(s);
    });
}
