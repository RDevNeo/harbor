package dev.harbor.shell;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Properties;
import java.util.TreeSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Which app code a process of Harbor for Android runs, and how new code gets there: the shell's
 *  state machine, in plain Java (BootTest runs it on the JVM; Shell and Factory are its Android
 *  side). See android/README.md, "Shell and code".
 *
 *  The app's code ("the code": every class but the shell's, the fonts and the logos) comes as
 *  harbor-phone-code.zip with each release. A downloaded one is checked against Harbor's release
 *  key ({@link #stage}) and kept read-only in the folder this class owns as {@code <code>.zip}
 *  with {@code <code>.properties} beside it; {@code state.properties} says which runs:
 *  <ul>
 *  <li>{@code staged}: checked, waiting for the next process start ({@link #start} takes it).
 *  <li>{@code current}: the one this and the next processes run, 0 for the code built into the APK
 *      ("bundled").
 *  <li>{@code good}: the last one that proved itself ({@link #ok}: a screen stayed up, or a
 *      process ran a while without a crash), 0 for the bundled code. A current one that isn't good
 *      yet counts its starts and crashes; at {@link #MAX_CRASHES} crashes or {@link #MAX_STARTS}
 *      starts it is marked bad (never run again) and the process starts on the good one instead.
 *  <li>{@code bad}: codes that failed so.
 *  </ul>
 *  Downloaded code only runs while it's newer than the bundled code (installing a newer APK
 *  drops it) and its {@code minShell} is at most this shell's version. */
public final class Boot {
    private Boot() { }

    /** The release file, and the file inside it that describes it. */
    public static final String ASSET = "harbor-phone-code.zip", INFO = "harbor-code.properties";
    static final String STATE = "state.properties";
    /** Crashes, or starts, of code that hasn't proved itself before it's rolled back. Starts
     *  count crashes Java never sees (a native crash, a kill while hung). */
    public static final int MAX_CRASHES = 2, MAX_STARTS = 6;

    /** What a release's code says about itself (its INFO entry). */
    public static final class Info {
        public long code;
        public String version;
        public int minShell;
        public long size;
    }

    /** The state file, read. */
    static final class State {
        long current, good, staged, stagedAt;
        int starts, crashes;
        final TreeSet<Long> bad = new TreeSet<>();

        /** The file's text: same state, same text (start() writes only a change). */
        String text() {
            StringBuilder b = new StringBuilder();
            for (long x : bad) b.append(b.length() == 0 ? "" : ",").append(x);
            return "bad=" + b + "\ncrashes=" + crashes + "\ncurrent=" + current + "\ngood=" + good
                    + "\nstaged=" + staged + "\nstagedAt=" + stagedAt + "\nstarts=" + starts + "\n";
        }
    }

    /** What a process runs: code 0 is the bundled code. */
    public static final class Pick {
        public long code;
        public String version;
        public File zip;
        /** Not proved yet: crashes count against it (Shell). */
        public boolean trial;
        /** What happened, for the log ("" nothing new). */
        public String note = "";
    }

    // ---- at process start ----

    /** Decides what this process runs (Factory, once per main process) and writes down the start.
     *  bundled: the APK's own code; shell: this shell's version. Never throws: a state it can't
     *  read is the bundled code. */
    public static synchronized Pick start(File dir, long bundled, int shell) {
        Pick p = new Pick();
        try {
            State s = read(dir);
            String was = s.text();
            StringBuilder note = new StringBuilder();
            s.bad.headSet(bundled, true).clear(); // older than the APK: never offered again anyway
            if (s.staged != 0) {
                if (s.staged > s.current && usable(dir, s.staged, bundled, shell, s)) {
                    s.current = s.staged;
                    s.starts = s.crashes = 0;
                    note.append("took staged ").append(s.staged).append("; ");
                }
                s.staged = 0;
                s.stagedAt = 0;
            }
            if (s.current != 0 && s.current != s.good && (s.crashes >= MAX_CRASHES || s.starts >= MAX_STARTS)) {
                note.append("rolled back ").append(s.current).append(" (").append(s.crashes).append(" crashes, ")
                        .append(s.starts).append(" starts); ");
                s.bad.add(s.current);
                s.current = s.good;
                s.starts = s.crashes = 0;
            }
            if (s.good != 0 && !usable(dir, s.good, bundled, shell, s)) s.good = 0;
            if (s.current != 0 && !usable(dir, s.current, bundled, shell, s)) {
                note.append("dropped ").append(s.current).append(" (the APK's code is as new, or the file is gone); ");
                s.current = s.good;
                s.starts = s.crashes = 0;
            }
            if (s.current != 0 && s.current != s.good) {
                s.starts++;
                p.trial = true;
            }
            // Nothing written on a start that changes nothing (most starts: no fsync on the way up).
            if (!s.text().equals(was)) write(dir, s);
            if (dir.isDirectory()) clean(dir, s);
            p.code = s.current;
            if (p.code != 0) {
                p.zip = zip(dir, p.code);
                p.version = info(dir, p.code).version;
            }
            p.note = note.toString();
        } catch (Exception e) {
            p = new Pick();
            p.note = "state unreadable, the APK's code: " + e;
        }
        return p;
    }

    /** Code `code` proved itself (a screen stayed up, or the process ran a while). */
    public static synchronized void ok(File dir, long code) {
        try {
            State s = read(dir);
            if (code == 0 || s.current != code || s.good == code) return;
            s.good = code;
            s.starts = s.crashes = 0;
            write(dir, s);
            clean(dir, s);
        } catch (IOException ignored) { }
    }

    /** The process running `code` crashed (an uncaught exception) before it proved itself. */
    public static synchronized void crash(File dir, long code) {
        try {
            State s = read(dir);
            if (code == 0 || s.current != code || s.good == code) return;
            s.crashes++;
            write(dir, s);
        } catch (IOException ignored) { }
    }

    /** Code `code` doesn't even load (ART refused its file): bad at once, the next start runs
     *  the good one (or the APK's). */
    public static synchronized void refuse(File dir, long code) {
        try {
            State s = read(dir);
            if (code == 0) return;
            s.bad.add(code);
            if (s.good == code) s.good = 0;
            if (s.current == code) { s.current = s.good; s.starts = s.crashes = 0; }
            write(dir, s);
            clean(dir, s);
        } catch (IOException ignored) { }
    }

    /** The code waiting for the next start (0 none), and since when (wall clock ms). */
    public static synchronized long[] staged(File dir) {
        try {
            State s = read(dir);
            return new long[] { s.staged, s.stagedAt };
        } catch (IOException e) {
            return new long[] { 0, 0 };
        }
    }

    /** Codes that failed here (rolled back): never staged again. */
    public static synchronized boolean bad(File dir, long code) {
        try { return read(dir).bad.contains(code); } catch (IOException e) { return false; }
    }

    // ---- a new release's code ----

    /** Thrown when the code is fine but can't run here (needs a newer shell, or isn't newer). */
    public static final class Unusable extends IOException {
        Unusable(String m) { super(m); }
    }

    /** Takes a downloaded harbor-phone-code.zip (`file`, moved away on success) for the next
     *  start, only when `sigText` (its .minisig) checks out with `pubkey` for release `release`,
     *  and its INFO says it runs on this shell and is newer than both the bundled code and
     *  `running`. Throws GeneralSecurityException when it isn't Harbor's, Unusable when it can't run
     *  here; returns what it staged. */
    public static Info stage(File dir, File file, String sigText, String release, String pubkey, long bundled, long running,
                             int shell, long now) throws IOException, GeneralSecurityException {
        Minisign.Sig sig = Minisign.parse(sigText);
        Minisign.signedFor(sig, release, ASSET);
        Minisign.Blake2b h = new Minisign.Blake2b();
        long size = 0;
        try (InputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) { h.update(buf, 0, n); size += n; }
        }
        Minisign.verify(pubkey, h.digest(), sig);
        Info info = describe(file);
        info.size = size;
        if (info.minShell > shell) throw new Unusable("code " + info.version + " needs shell " + info.minShell + ", this app is shell " + shell);
        if (info.code <= bundled || info.code <= running) throw new Unusable("code " + info.version + " isn't newer than what runs");
        synchronized (Boot.class) {
            State s = read(dir);
            if (s.bad.contains(info.code)) throw new Unusable("code " + info.version + " failed here before");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("can't make " + dir);
            File to = zip(dir, info.code);
            if (to.exists()) { to.setWritable(true); to.delete(); }
            if (!file.renameTo(to)) copy(file, to);
            file.delete();
            // Android 14 loads dex only from read-only files; nothing should change it anyway.
            if (!to.setReadOnly()) throw new IOException("can't make " + to + " read-only");
            Properties p = new Properties();
            p.setProperty("code", Long.toString(info.code));
            p.setProperty("version", info.version);
            p.setProperty("minShell", Integer.toString(info.minShell));
            p.setProperty("size", Long.toString(size));
            store(p, new File(dir, info.code + ".properties"));
            s.staged = info.code;
            s.stagedAt = now;
            write(dir, s);
            clean(dir, s);
        }
        return info;
    }

    /** A code zip's INFO, checked for sense (classes.dex in it too). */
    static Info describe(File file) throws IOException {
        try (ZipFile z = new ZipFile(file)) {
            ZipEntry e = z.getEntry(INFO);
            if (e == null || z.getEntry("classes.dex") == null) throw new IOException("not Hub's app code");
            Properties p = new Properties();
            try (InputStream in = z.getInputStream(e)) { p.load(new java.io.InputStreamReader(in, StandardCharsets.UTF_8)); }
            Info i = new Info();
            try {
                i.code = Long.parseLong(p.getProperty("code", ""));
                i.minShell = Integer.parseInt(p.getProperty("minShell", ""));
            } catch (NumberFormatException x) {
                throw new IOException("unreadable " + INFO);
            }
            i.version = p.getProperty("version", "");
            if (i.code <= 0 || !i.version.matches("\\d+\\.\\d+\\.\\d+")) throw new IOException("unreadable " + INFO);
            return i;
        }
    }

    // ---- the folder ----

    static File zip(File dir, long code) { return new File(dir, code + ".zip"); }

    /** What staging wrote down about `code`. */
    static Info info(File dir, long code) throws IOException {
        Properties p = load(new File(dir, code + ".properties"));
        Info i = new Info();
        try {
            i.code = Long.parseLong(p.getProperty("code", "0"));
            i.minShell = Integer.parseInt(p.getProperty("minShell", "0"));
            i.size = Long.parseLong(p.getProperty("size", "-1"));
        } catch (NumberFormatException e) {
            throw new IOException("unreadable " + code + ".properties");
        }
        i.version = p.getProperty("version", "");
        return i;
    }

    /** `code` may run: newer than the APK's, not bad, its file whole, and this shell new enough
     *  for it. */
    static boolean usable(File dir, long code, long bundled, int shell, State s) {
        if (code <= bundled || s.bad.contains(code)) return false;
        try {
            Info i = info(dir, code);
            File z = zip(dir, code);
            // Read-only too (Android 14 loads no other dex): set again here, as root can't tell.
            return i.code == code && i.minShell <= shell && z.isFile() && z.length() == i.size && z.setReadOnly();
        } catch (IOException e) {
            return false;
        }
    }

    /** Deletes the codes nothing names any more (and half-written files). */
    static void clean(File dir, State s) {
        File[] fs = dir.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            String n = f.getName();
            if (n.equals(STATE)) continue;
            int dot = n.indexOf('.');
            long code;
            try { code = Long.parseLong(dot < 0 ? n : n.substring(0, dot)); } catch (NumberFormatException e) { code = -1; }
            boolean keep = code > 0 && (code == s.current || code == s.good || code == s.staged)
                    && (n.endsWith(".zip") || n.endsWith(".properties"));
            if (keep) continue;
            if (f.isDirectory()) continue; // ART's oat/ beside the zips: Android cleans it
            f.setWritable(true);
            f.delete();
        }
    }

    static State read(File dir) throws IOException {
        State s = new State();
        File f = new File(dir, STATE);
        if (!f.isFile()) return s;
        Properties p = load(f);
        try {
            s.current = Long.parseLong(p.getProperty("current", "0"));
            s.good = Long.parseLong(p.getProperty("good", "0"));
            s.staged = Long.parseLong(p.getProperty("staged", "0"));
            s.stagedAt = Long.parseLong(p.getProperty("stagedAt", "0"));
            s.starts = Integer.parseInt(p.getProperty("starts", "0"));
            s.crashes = Integer.parseInt(p.getProperty("crashes", "0"));
            for (String b : p.getProperty("bad", "").split(",")) if (!b.trim().isEmpty()) s.bad.add(Long.parseLong(b.trim()));
        } catch (NumberFormatException e) {
            throw new IOException("unreadable " + STATE);
        }
        return s;
    }

    static void write(File dir, State s) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("can't make " + dir);
        replace(s.text().getBytes(StandardCharsets.UTF_8), new File(dir, STATE));
    }

    private static Properties load(File f) throws IOException {
        Properties p = new Properties();
        try (InputStream in = new FileInputStream(f)) { p.load(new java.io.InputStreamReader(in, StandardCharsets.UTF_8)); }
        return p;
    }

    private static void store(Properties p, File f) throws IOException {
        StringBuilder b = new StringBuilder();
        for (String k : new TreeSet<>(p.stringPropertyNames())) b.append(k).append('=').append(p.getProperty(k)).append('\n');
        replace(b.toString().getBytes(StandardCharsets.UTF_8), f);
    }

    /** Written beside, synced, then renamed over: a crash mid-write leaves the old one. */
    private static void replace(byte[] data, File f) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
            out.getFD().sync();
        }
        if (!tmp.renameTo(f)) { tmp.delete(); throw new IOException("can't write " + f); }
    }

    private static void copy(File from, File to) throws IOException {
        try (InputStream in = new FileInputStream(from); FileOutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.getFD().sync();
        }
    }
}
