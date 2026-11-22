package dev.harbor.shell;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** The shell's choice of app code (Boot): staging a release's harbor-phone-code.zip (signature,
 *  shell version, newer), which code a process start runs, proving and rolling back. Signs its
 *  own made-up releases with a throwaway Ed25519 key in minisign's format. Plain JVM (JDK 15+ for
 *  Ed25519), no Android: build.sh runs it before packaging. */
public class BootTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static void same(Object got, Object want, String what) {
        check(String.valueOf(got).equals(String.valueOf(want)), what + ": got " + got + ", want " + want);
    }

    // ---- a throwaway minisign key ----

    static KeyPair keys;
    static final byte[] KEY_ID = { 1, 2, 3, 4, 5, 6, 7, 8 };

    static String pubkey() {
        byte[] x509 = keys.getPublic().getEncoded();
        byte[] raw = new byte[42];
        raw[0] = 'E'; raw[1] = 'd';
        System.arraycopy(KEY_ID, 0, raw, 2, 8);
        System.arraycopy(x509, x509.length - 32, raw, 10, 32);
        return Base64.getEncoder().encodeToString(raw);
    }

    static byte[] ed(byte[] msg) throws Exception {
        Signature s = Signature.getInstance("Ed25519");
        s.initSign(keys.getPrivate());
        s.update(msg);
        return s.sign();
    }

    /** A .minisig of `file`, as the release workflow signs: "harbor v<release> <name>". */
    static String sign(File file, String release, String name) throws Exception {
        byte[] data = Files.readAllBytes(file.toPath());
        Minisign.Blake2b h = new Minisign.Blake2b();
        h.update(data, 0, data.length);
        byte[] sig = ed(h.digest());
        byte[] raw = new byte[74];
        raw[0] = 'E'; raw[1] = 'D';
        System.arraycopy(KEY_ID, 0, raw, 2, 8);
        System.arraycopy(sig, 0, raw, 10, 64);
        String trusted = "harbor v" + release + " " + name;
        byte[] t = trusted.getBytes(StandardCharsets.UTF_8);
        byte[] covered = Arrays.copyOf(sig, 64 + t.length);
        System.arraycopy(t, 0, covered, 64, t.length);
        return "untrusted comment: signature from minisign secret key\n" + Base64.getEncoder().encodeToString(raw)
                + "\ntrusted comment: " + trusted + "\n" + Base64.getEncoder().encodeToString(ed(covered)) + "\n";
    }

    /** A release's code zip: its INFO and a stand-in classes.dex. */
    static File codeZip(File dir, long code, String version, int minShell, boolean withDex) throws Exception {
        File f = new File(dir, "dl-" + code + "-" + System.nanoTime() + ".zip");
        try (ZipOutputStream z = new ZipOutputStream(new FileOutputStream(f))) {
            z.putNextEntry(new ZipEntry(Boot.INFO));
            z.write(("code=" + code + "\nversion=" + version + "\nminShell=" + minShell + "\n").getBytes(StandardCharsets.UTF_8));
            if (withDex) {
                z.putNextEntry(new ZipEntry("classes.dex"));
                z.write(("dex " + code).getBytes(StandardCharsets.UTF_8));
            }
            z.putNextEntry(new ZipEntry("assets/fonts/lucide.ttf"));
            z.write(new byte[] { 0, 1, 0, 0 });
        }
        return f;
    }

    static final long APK = 188002; // the code built into the APK (0.188.2)
    static final int SHELL = 3;

    static String stageErr(File state, File zip, String sig, String release, String key, long running) {
        try {
            Boot.stage(state, zip, sig, release, key, APK, running, SHELL, 1000);
            return "";
        } catch (Boot.Unusable e) {
            return "unusable: " + e.getMessage();
        } catch (java.security.GeneralSecurityException e) {
            return "security: " + e.getMessage();
        } catch (Exception e) {
            return "io: " + e.getMessage();
        }
    }

    /** Downloads, signs and stages code `code` (minShell, on `release`): "" when it went in. */
    static String stage(File state, File dl, long code, int minShell) throws Exception {
        String v = (code / 1000000) + "." + (code / 1000 % 1000) + "." + (code % 1000);
        File z = codeZip(dl, code, v, minShell, true);
        return stageErr(state, z, sign(z, v, Boot.ASSET), v, pubkey(), 0);
    }

    static File fresh(String name) throws Exception {
        File d = Files.createTempDirectory("boottest-" + name).toFile();
        d.deleteOnExit();
        return d;
    }

    public static void main(String[] args) throws Exception {
        keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        String key = pubkey();

        // ---- staging: only Harbor's own, for this release and this shell, and newer ----
        File dl = fresh("dl"), st = fresh("st");
        File z = codeZip(dl, 189000, "0.189.0", SHELL, true);
        String sig = sign(z, "0.189.0", Boot.ASSET);
        same(stageErr(st, z, sig, "0.189.0", key, 0), "", "a signed code zip stages");
        same(Boot.staged(st)[0], 189000, "staged, waiting for the next start");
        same(Boot.staged(st)[1], 1000, "and since when");
        check(!z.exists(), "the download moved into the shell's folder");
        File kept = new File(st, "189000.zip");
        check(kept.isFile() && !Files.isWritable(kept.toPath()) || kept.isFile() && isRoot(), "kept read-only");

        File z2 = codeZip(dl, 189001, "0.189.1", SHELL, true);
        String sig2 = sign(z2, "0.189.1", Boot.ASSET);
        File other = fresh("st2");
        KeyPair mine = keys;
        keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        String strangerSig = sign(z2, "0.189.1", Boot.ASSET);
        keys = mine;
        check(stageErr(other, z2, strangerSig, "0.189.1", key, 0).startsWith("security"), "another key's signature (same key id) is refused");
        check(stageErr(other, z2, sig2, "0.189.0", key, 0).startsWith("security"), "signed for another release");
        check(stageErr(other, z2, sign(z2, "0.189.1", "harbor-android.apk"), "0.189.1", key, 0).startsWith("security"), "signed as another file");
        try (FileOutputStream out = new FileOutputStream(z2, true)) { out.write(0); }
        check(stageErr(other, z2, sig2, "0.189.1", key, 0).startsWith("security"), "a byte added after signing");
        same(Boot.staged(other)[0], 0, "nothing staged from refused files");

        File z3 = codeZip(dl, 189002, "0.189.2", SHELL + 1, true);
        check(stageErr(other, z3, sign(z3, "0.189.2", Boot.ASSET), "0.189.2", key, 0).startsWith("unusable: code 0.189.2 needs shell 4"), "needs a newer shell");
        File z4 = codeZip(dl, APK, "0.188.2", SHELL, true);
        check(stageErr(other, z4, sign(z4, "0.188.2", Boot.ASSET), "0.188.2", key, 0).startsWith("unusable"), "not newer than the APK's code");
        File z5 = codeZip(dl, 189003, "0.189.3", SHELL, true);
        check(stageErr(other, z5, sign(z5, "0.189.3", Boot.ASSET), "0.189.3", key, 189004).startsWith("unusable"), "not newer than the code running");
        File z6 = codeZip(dl, 189005, "0.189.5", SHELL, false);
        check(stageErr(other, z6, sign(z6, "0.189.5", Boot.ASSET), "0.189.5", key, 0).startsWith("io: not Harbor's app code"), "no classes.dex in it");

        // ---- process starts ----
        File d = fresh("start");
        Boot.Pick p = Boot.start(d, APK, SHELL);
        same(p.code, 0, "nothing downloaded: the APK's code");
        check(!p.trial, "the APK's code is never on trial");

        same(stage(d, dl, 189000, SHELL), "", "0.189.0 staged");
        p = Boot.start(d, APK, SHELL);
        same(p.code, 189000, "the next start runs the staged code");
        same(p.version, "0.189.0", "with its version");
        check(p.trial, "on trial until it proves itself");
        check(p.zip != null && p.zip.getName().equals("189000.zip"), "from its read-only zip");
        same(Boot.staged(d)[0], 0, "no longer staged");
        Boot.ok(d, 189000);
        p = Boot.start(d, APK, SHELL);
        same(p.code, 189000, "proved: still runs");
        check(!p.trial, "and is no longer on trial");

        // A new one that crashes twice before proving itself: back to the good one, never again.
        same(stage(d, dl, 189001, SHELL), "", "0.189.1 staged");
        p = Boot.start(d, APK, SHELL);
        same(p.code, 189001, "0.189.1 on trial");
        Boot.crash(d, 189001);
        p = Boot.start(d, APK, SHELL);
        same(p.code, 189001, "one crash: tried again");
        Boot.crash(d, 189001);
        p = Boot.start(d, APK, SHELL);
        same(p.code, 189000, "two crashes: rolled back to the good code");
        check(!p.trial, "the good code isn't on trial");
        check(p.note.contains("rolled back 189001"), "said so: " + p.note);
        check(Boot.bad(d, 189001), "0.189.1 is bad here");
        check(!new File(d, "189001.zip").exists(), "and its file is gone");
        check(stage(d, dl, 189001, SHELL).startsWith("unusable"), "and isn't staged again");
        Boot.crash(d, 189000);
        Boot.crash(d, 189000);
        same(Boot.start(d, APK, SHELL).code, 189000, "crashes don't count against proved code");

        // Starts that never prove themselves (a native crash Java doesn't see) roll back too.
        same(stage(d, dl, 189002, SHELL), "", "0.189.2 staged");
        for (int i = 1; i <= Boot.MAX_STARTS; i++) same(Boot.start(d, APK, SHELL).code, 189002, "start " + i + " runs it");
        same(Boot.start(d, APK, SHELL).code, 189000, "after " + Boot.MAX_STARTS + " unproved starts: rolled back");

        // A newer APK installed: its own code wins, the downloaded ones go.
        p = Boot.start(d, 189500, SHELL);
        same(p.code, 0, "the APK's code is newer: it runs");
        check(!new File(d, "189000.zip").exists(), "the older download is deleted");
        check(!Boot.bad(d, 189001), "bad marks older than the APK are forgotten");

        // A rollback with no good one: the APK's code.
        File e = fresh("nogood");
        same(stage(e, dl, 189000, SHELL), "", "staged on a fresh phone");
        same(Boot.start(e, APK, SHELL).code, 189000, "runs");
        Boot.crash(e, 189000);
        Boot.crash(e, 189000);
        same(Boot.start(e, APK, SHELL).code, 0, "rolled back to the APK's code");

        // A file that's gone or changed size isn't loaded.
        File g = fresh("gone");
        same(stage(g, dl, 189000, SHELL), "", "staged");
        Boot.start(g, APK, SHELL);
        Boot.ok(g, 189000);
        File zf = new File(g, "189000.zip");
        zf.setWritable(true);
        try (FileOutputStream out = new FileOutputStream(zf, true)) { out.write(1); }
        same(Boot.start(g, APK, SHELL).code, 0, "a changed file isn't run");

        // ART refused the file (Shell.boot): bad at once.
        File r = fresh("refuse");
        same(stage(r, dl, 189000, SHELL), "", "staged");
        Boot.start(r, APK, SHELL);
        Boot.refuse(r, 189000);
        same(Boot.start(r, APK, SHELL).code, 0, "refused code: the APK's");
        check(Boot.bad(r, 189000), "and it's bad");

        // A staged code older than what runs isn't taken; a state file that isn't one is the APK's code.
        File o = fresh("older");
        same(stage(o, dl, 189003, SHELL), "", "0.189.3 staged");
        same(Boot.start(o, APK, SHELL).code, 189003, "runs");
        same(stage(o, dl, 189004, SHELL), "", "0.189.4 staged");
        same(Boot.start(o, APK, 2).code, 0, "a shell older than the code needs (downgraded APK): the APK's code");
        File bad = fresh("garbage");
        Files.write(new File(bad, Boot.STATE).toPath(), "current=x\n".getBytes(StandardCharsets.UTF_8));
        Boot.Pick gp = Boot.start(bad, APK, SHELL);
        same(gp.code, 0, "an unreadable state: the APK's code");
        check(gp.note.startsWith("state unreadable"), "said so: " + gp.note);

        if (failed > 0) throw new AssertionError(failed + " check(s) failed");
        System.out.println("BootTest ok");
    }

    static boolean isRoot() { return "root".equals(System.getProperty("user.name")); }
}
