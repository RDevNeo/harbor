package dev.harbor.app;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Choreographer;
import android.view.Surface;
import java.util.concurrent.atomic.AtomicBoolean;

/** Servo, the browser screen's engine (android/servo, libharborservo.so). It runs only in the
 *  `:browser` process (Browser), on one thread of its own: every native call below is made on
 *  that thread (`post`). Servo draws with its own GL into the screen's SurfaceView.
 *
 *  The library ships for arm64-v8a and armeabi-v7a (32-bit Android, like the Galaxy A13), and
 *  x86_64 in emulator builds; on any other ABI, or before
 *  Android 9, `supported` is false and links open in the phone's browser instead. */
final class Engine {
    /** What the screen hears back (on the main thread). */
    interface Client {
        void url(String url);
        void title(String title);
        void loading(boolean on);
        void history(boolean back, boolean forward);
        void ime(boolean show);
    }

    private static Boolean loaded;
    private static String why = "";
    private static HandlerThread thread;
    private static Handler handler;
    private static Client client;
    private static final AtomicBoolean spinQueued = new AtomicBoolean();

    /** Whether this phone can run an engine at all (Android 9+, an ABI the engine builds for);
     *  `available` also needs this APK to carry one for the ABI the app runs as. */
    static boolean supported() {
        if (Build.VERSION.SDK_INT < 28) return false;
        for (String abi : Build.SUPPORTED_ABIS) if ("arm64-v8a".equals(abi) || "x86_64".equals(abi) || "armeabi-v7a".equals(abi)) return true;
        return false;
    }

    /** Loads the library (once); false with `why()` when it can't. */
    static synchronized boolean load() {
        if (loaded != null) return loaded;
        if (!supported()) {
            why = "The built-in browser needs Android 9 or newer on an ARM or x86 phone.";
            return loaded = false;
        }
        try {
            System.loadLibrary("c++_shared");
            System.loadLibrary("harborservo");
            loaded = true;
        } catch (Throwable t) {
            why = "The browser engine couldn't start: " + t.getMessage();
            loaded = false;
        }
        return loaded;
    }

    static String why() { return why; }

    /** Why this phone has no built-in browser, in plain words; null when it has one. The
     *  Galaxy A13 and other budget phones run a 32-bit Android on a 64-bit processor: they
     *  report no 64-bit ABI at all, and the engine is built for 64-bit Android only. */
    static String unavailable(Context c) {
        if (Build.VERSION.SDK_INT < 28) return "It needs Android 9 or newer; this phone has Android " + Build.VERSION.RELEASE + ".";
        if (!supported()) return "The browser engine isn't built for this processor (" + String.join(", ", Build.SUPPORTED_ABIS) + ").";
        if (!new java.io.File(c.getApplicationInfo().nativeLibraryDir, "libharborservo.so").isFile()) {
            if (Build.SUPPORTED_64_BIT_ABIS.length == 0)
                return "This phone runs a 32-bit Android (" + String.join(", ", Build.SUPPORTED_ABIS) + "), and this app carries the browser engine for 64-bit Android only. Links open in your usual browser.";
            return "This copy of the app has no browser engine for " + Build.SUPPORTED_ABIS[0] + ".";
        }
        if (Browser.failedBefore(c)) return "It stopped while starting last time; it tries again after the next update.";
        return null;
    }

    /** What the phone is, for the PCs (X-Harbor-Platform): "Samsung SM-A135M, Android 12 (SDK 31),
     *  ABIs armeabi-v7a, armeabi, browser: no (32-bit Android)". */
    static String platform(Context c) {
        String why = c == null ? null : unavailable(c);
        String browser = why == null ? "yes" : "no (" + (Build.SUPPORTED_64_BIT_ABIS.length == 0 ? "32-bit Android" : Build.VERSION.SDK_INT < 28 ? "Android < 9" : "unavailable") + ")";
        String make = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.substring(0, 1).toUpperCase() + Build.MANUFACTURER.substring(1);
        return (make + " " + Build.MODEL).trim() + ", Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + "), ABIs "
                + String.join(", ", Build.SUPPORTED_ABIS) + ", browser: " + browser;
    }

    /** This phone can run it and this APK carries it (a build without the engine has none). */
    static boolean available(Context c) {
        return supported() && new java.io.File(c.getApplicationInfo().nativeLibraryDir, "libharborservo.so").isFile();
    }

    /** Starts the servo thread and Servo itself (once per process). */
    static void start(Context c, Client to) {
        client = to;
        if (thread != null) return;
        thread = new HandlerThread("servo");
        thread.start();
        handler = new Handler(thread.getLooper());
        float density = c.getResources().getDisplayMetrics().density;
        post(() -> init(new Callbacks(), density));
    }

    static void post(Runnable r) { if (handler != null) handler.post(r); }

    /** Called back by Rust: wakeup from any thread, the rest on the servo thread. */
    static final class Callbacks {
        void wakeup() {
            if (spinQueued.compareAndSet(false, true)) post(() -> { spinQueued.set(false); spin(); });
        }
        void requestFrame() {
            // On the servo thread (it has a Looper): its own Choreographer.
            Choreographer.getInstance().postFrameCallback(t -> frame());
        }
        void onUrl(String u) { Ui.main.post(() -> { if (client != null) client.url(u); }); }
        void onTitle(String t) { Ui.main.post(() -> { if (client != null) client.title(t); }); }
        void onLoading(boolean on) { Ui.main.post(() -> { if (client != null) client.loading(on); }); }
        void onHistory(boolean b, boolean f) { Ui.main.post(() -> { if (client != null) client.history(b, f); }); }
        void onIme(boolean show) { Ui.main.post(() -> { if (client != null) client.ime(show); }); }
    }

    static native boolean init(Callbacks callbacks, float density);
    /** A Surface to draw into; the first one creates the page and loads `url`. */
    static native boolean attach(Surface surface, int w, int h, String url);
    static native void detach();
    static native void resize(int w, int h);
    static native void load(String url);
    /** 0 back, 1 forward, 2 reload. */
    static native void nav(int what);
    /** action 0 down, 1 move, 2 up, 3 cancel; device pixels. */
    static native void touch(int action, int id, float x, float y);
    static native void key(int keycode, int unicode, boolean down);
    static native void imeText(String text);
    static native void imeDismissed();
    static native void spin();
    static native void frame();
}
