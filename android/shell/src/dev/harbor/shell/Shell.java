package dev.harbor.shell;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.GeneralSecurityException;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import dalvik.system.DexClassLoader;

/** The shell's side of the contract with the app's code (android/README.md, "Shell and code"):
 *  everything here stays callable, with the same meaning, for as long as phones run this shell.
 *  Change it only together with a shell version bump (android/shell/shell.lock).
 *
 *  Android 9+ (API 28) runs the newest good code it has: Factory asks {@link #boot} for a class
 *  loader at each process start. Android 8 has no AppComponentFactory and always runs the APK's
 *  own code ({@link #loads} false): its phones keep updating by APK. */
public final class Shell {
    private Shell() { }

    static final String TAG = "harbor-shell";

    /** This shell's version (shell.lock): what code's minShell is compared with. */
    public static final int VERSION = Built.SHELL;
    /** The APK's own code: its version (versionCode's numbering, 0.188.2 -> 188002) and name. */
    public static final long BUNDLED = Built.CODE;
    public static final String BUNDLED_NAME = Built.NAME;

    private static volatile File dir;
    private static volatile Boot.Pick running;
    private static volatile boolean proved;

    /** This Android can run downloaded code. */
    public static boolean loads() { return Build.VERSION.SDK_INT >= 28; }

    /** The code this process runs: its version number and name (the APK's own unless a downloaded
     *  one was loaded). */
    public static long code() {
        Boot.Pick p = running;
        return p != null && p.code != 0 ? p.code : BUNDLED;
    }

    public static String name() {
        Boot.Pick p = running;
        return p != null && p.code != 0 ? p.version : BUNDLED_NAME;
    }

    /** True when this process runs downloaded code (not the APK's). */
    public static boolean downloaded() {
        Boot.Pick p = running;
        return p != null && p.code != 0;
    }

    private static File dir(Context c) {
        File d = dir;
        return d != null ? d : new File(c.getApplicationInfo().dataDir, "harbor-code");
    }

    // ---- process start (Factory) ----

    /** The class loader of this process's code, or null for the APK's own (the default). */
    static ClassLoader boot(ClassLoader apk, ApplicationInfo ai) {
        dir = new File(ai.dataDir, "harbor-code");
        // Only the app's main process runs downloaded code (Restart's process is the shell's).
        String proc = Build.VERSION.SDK_INT >= 28 ? Application.getProcessName() : null;
        if (proc != null && ai.processName != null && !proc.equals(ai.processName)) return null;
        Boot.Pick p = Boot.start(dir, BUNDLED, VERSION);
        if (!p.note.isEmpty()) Log.i(TAG, p.note);
        if (p.code == 0) { running = p; return null; }
        ClassLoader code;
        try {
            code = new Code(p.zip.getPath(), ai.nativeLibraryDir, apk);
            // Opens the dex now: a file ART refuses fails here, not in the middle of a screen.
            code.loadClass("dev.harbor.app.Hubs");
        } catch (Throwable t) {
            Log.w(TAG, "code " + p.version + " doesn't load: " + t);
            Boot.refuse(dir, p.code); // a file that doesn't load won't load next time either
            running = null;
            return null;
        }
        running = p;
        Log.i(TAG, "running code " + p.version + (p.trial ? " (on trial)" : "") + " on shell " + VERSION + ", APK " + BUNDLED_NAME);
        if (p.trial) watch(p.code);
        return code;
    }

    /** Code on trial: an uncaught exception counts as a crash against it, and a process that ran
     *  10 minutes without one proves it. */
    private static void watch(long code) {
        File d = dir;
        Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            if (!proved) Boot.crash(d, code);
            if (prev != null) prev.uncaughtException(t, e);
        });
        Thread w = new Thread(() -> {
            SystemClock.sleep(10 * 60_000L);
            ok();
        }, "harbor-shell-trial");
        w.setDaemon(true);
        w.start();
    }

    /** The app's code calls this once a screen has stayed up a few seconds: the code works. */
    public static void ok() {
        Boot.Pick p = running;
        if (p == null || !p.trial || proved) return;
        proved = true;
        Boot.ok(dir, p.code);
        Log.i(TAG, "code " + p.version + " proved itself");
    }

    // ---- new code (the app's Update) ----

    /** Checks a downloaded harbor-phone-code.zip with Harbor's release key and keeps it for the
     *  next start (Boot.stage). Throws GeneralSecurityException when it isn't Harbor's,
     *  Boot.Unusable when it can't run on this shell. */
    public static Boot.Info stage(Context c, File file, String sigText, String release) throws IOException, GeneralSecurityException {
        if (!loads()) throw new Boot.Unusable("Android " + Build.VERSION.RELEASE + " can't load app code: it updates by APK");
        Boot.Info i = Boot.stage(dir(c), file, sigText, release, Minisign.PUBKEY, BUNDLED, code(), VERSION, System.currentTimeMillis());
        Log.i(TAG, "staged code " + i.version + " for the next start");
        return i;
    }

    /** The code waiting for the next start (0 none). */
    public static long staged(Context c) { return Boot.staged(dir(c))[0]; }

    /** Since when it waits (wall clock ms, 0 none). */
    public static long stagedAt(Context c) { return Boot.staged(dir(c))[1]; }

    /** Code `code` failed here before (it was rolled back). */
    public static boolean bad(Context c, long code) { return Boot.bad(dir(c), code); }

    /** Ends this process so the next start runs the staged code: quietly (nothing on screen; the
     *  app decides when, Update), or, from a screen, through Restart, which opens Harbor again. */
    public static void restart(Context c, boolean reopen) {
        Log.i(TAG, "restarting for code " + staged(c) + (reopen ? ", reopening" : ""));
        if (reopen) {
            Intent i = new Intent(c, Restart.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(Restart.PID, Process.myPid());
            c.startActivity(i);
            if (c instanceof Activity) ((Activity) c).finishAffinity();
            Runtime.getRuntime().exit(0);
        }
        Process.killProcess(Process.myPid());
        Runtime.getRuntime().exit(0);
    }

    // ---- the code's files ----

    /** A file the running code carries (its "assets/" + path: fonts, logos), or null when the
     *  APK's own code runs or the code lacks it (then the APK's assets have it). */
    public static InputStream asset(String path) {
        Boot.Pick p = running;
        if (p == null || p.code == 0) return null;
        try {
            ZipFile z = new ZipFile(p.zip);
            ZipEntry e = z.getEntry("assets/" + path);
            if (e == null) { z.close(); return null; }
            InputStream in = z.getInputStream(e);
            return new java.io.FilterInputStream(in) {
                @Override public void close() throws IOException { try { super.close(); } finally { z.close(); } }
            };
        } catch (IOException e) {
            return null;
        }
    }

    /** The same as a file (Typeface needs one), unpacked once per code version into the code cache;
     *  null as asset(). */
    public static File assetFile(Context c, String path) {
        Boot.Pick p = running;
        if (p == null || p.code == 0) return null;
        File f = new File(c.getCodeCacheDir(), "harbor-code-" + p.code + "/" + path);
        if (f.isFile()) return f;
        try (InputStream in = asset(path)) {
            if (in == null) return null;
            File part = new File(f.getPath() + ".part");
            if (!f.getParentFile().isDirectory() && !f.getParentFile().mkdirs()) return null;
            try (FileOutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return part.renameTo(f) ? f : null;
        } catch (IOException e) {
            return null;
        }
    }

    /** Downloaded code's class loader: its own classes first (the APK holds older copies of the
     *  same names), the shell's from the APK, Android's from the platform. */
    static final class Code extends DexClassLoader {
        private final ClassLoader shell;

        Code(String zip, String libs, ClassLoader apk) {
            super(zip, null, libs, apk.getParent());
            shell = apk;
        }

        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            if (name.startsWith("dev.harbor.shell.")) return shell.loadClass(name);
            return super.loadClass(name, resolve);
        }
    }
}
