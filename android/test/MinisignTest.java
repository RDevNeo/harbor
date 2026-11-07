package dev.harbor.app;

import java.nio.charset.StandardCharsets;

/** The release signature check the phone's updater runs on what it downloads from GitHub
 *  (Minisign). Plain JVM, no Android: build.sh runs it before packaging. */
public class MinisignTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    private static byte[] unhex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    private static String blake(byte[] data, int chunk) {
        Minisign.Blake2b h = new Minisign.Blake2b();
        for (int off = 0; off < data.length; off += chunk) h.update(data, off, Math.min(chunk, data.length - off));
        return hex(h.digest());
    }

    private static boolean throwsOn(Runnable r) {
        try { r.run(); return false; } catch (RuntimeException e) { return true; }
    }

    // A signature by the release key, of a file holding "harbor test\n" (the desktop's test too).
    static final String REAL_SIG = "untrusted comment: signature from minisign secret key\n"
            + "RUSaeVHfD2GBvargpdewoKaCPteir0zUTL31H4bcjFF5op1zwKHVaz4aU3MCYoB8DmZ+BbqDLBmvxEokE+YvUTkIXmvkhoxkFg8=\n"
            + "trusted comment: harbor v0.0.1 harbor-x86_64-linux.tar.gz\n"
            + "N5LtPI0Gsk3pOwxTI4SLqgkXbXPZe3xgdluvQMXHbmDLg/UIFKQnNC3sdYQke6ZBlrU6os7Moa5CZJTZufUQDQ==\n";

    private static boolean ok(byte[] data, String sig, String version, String name) {
        try { Minisign.check(Minisign.PUBKEY, data, sig, version, name); return true; } catch (Exception e) { return false; }
    }

    public static void main(String[] args) {
        // BLAKE2b-512 against Python's hashlib, in one go and fed in odd pieces across blocks.
        check(blake(new byte[0], 1).equals("786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce"), "blake2b empty");
        check(blake("abc".getBytes(StandardCharsets.US_ASCII), 3).equals("ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"), "blake2b abc");
        byte[] k1 = new byte[1000];
        for (int i = 0; i < k1.length; i++) k1[i] = (byte) (i % 251);
        String want1000 = "c11e1c0340bd7e5a1b275f1230c962fad215ecb1391486e74e31b960a2f2996381a5fad092da06841d5f26e38f6ecfeaf441acbcd1c2de61aef121e7927175f5";
        for (int chunk : new int[] { 1, 7, 128, 129, 1000 }) check(blake(k1, chunk).equals(want1000), "blake2b 1000 bytes in pieces of " + chunk);
        byte[] k256 = java.util.Arrays.copyOf(k1, 256); // exactly two blocks: the last one must be flagged last
        check(blake(k256, 128).equals("93463ac058b6163eb43be3f5bb32b28541498f4e3366f1effe253ad44e1e076e41c3616046027c82a7124f8f4746668ad10b12e8e25a95ac8f3151df01cd5a93"), "blake2b two whole blocks");

        // Ed25519: RFC 8032 test 1 (empty message), and a flipped bit.
        byte[] pub = unhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        byte[] sig = unhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
        check(Minisign.Ed25519.verify(pub, new byte[0], sig), "rfc 8032 test 1");
        sig[5] ^= 1;
        check(!Minisign.Ed25519.verify(pub, new byte[0], sig), "rfc 8032 test 1, bit flipped");
        check(!Minisign.Ed25519.verify(pub, new byte[] { 1 }, unhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")), "another message");

        // A real minisign signature by Harbor's release key: for its file, release and name only.
        byte[] file = "harbor test\n".getBytes(StandardCharsets.US_ASCII);
        long t = System.nanoTime();
        check(ok(file, REAL_SIG, "0.0.1", "harbor-x86_64-linux.tar.gz"), "the release key's signature checks out");
        System.out.println("minisign check: " + (System.nanoTime() - t) / 1_000_000 + " ms");
        check(!ok(file, REAL_SIG, "0.0.2", "harbor-x86_64-linux.tar.gz"), "another release");
        check(!ok(file, REAL_SIG, "0.0.1", "harbor-android.apk"), "another file");
        check(!ok("harbor test!\n".getBytes(StandardCharsets.US_ASCII), REAL_SIG, "0.0.1", "harbor-x86_64-linux.tar.gz"), "changed file");
        check(!ok(file, REAL_SIG.replace("v0.0.1 harbor-x86_64", "v0.0.2 harbor-x86_64"), "0.0.2", "harbor-x86_64-linux.tar.gz"), "edited trusted comment");
        check(!ok(file, "garbage", "0.0.1", "harbor-x86_64-linux.tar.gz"), "unreadable signature");
        try {
            Minisign.verify("RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new byte[64], Minisign.parse(REAL_SIG));
            check(false, "another key");
        } catch (Exception e) {
            check(true, "another key");
        }

        if (failed > 0) { System.err.println(failed + " failed"); System.exit(1); }
        System.out.println("MinisignTest ok");
    }
}
