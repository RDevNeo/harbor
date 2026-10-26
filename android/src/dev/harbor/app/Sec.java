package dev.harbor.app;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Locale;

import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** The phone's half of src/phoneauth.rs (android/PROTOCOL.md, "Three factors"): transcript
 *  hashes, HKDF, the pairing code, session keys that move on every 10 minutes and request MACs.
 *  Plain Java (no Android classes), so test/SecTest.java checks it against the hub's own test
 *  vectors on the build machine's JVM. */
final class Sec {
    static final long EPOCH_MS = 600_000;
    static final String EXPORTER = "EXPORTER-harbor-v3";

    private Sec() { }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x & 0xff));
        return s.toString();
    }

    static byte[] unhex(String s) {
        if (s == null || (s.length() & 1) != 0) return null;
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) {
            int hi = Character.digit(s.charAt(2 * i), 16), lo = Character.digit(s.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) return null;
            b[i] = (byte) (hi << 4 | lo);
        }
        return b;
    }

    static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }

    static void wipe(byte[] b) { if (b != null) Arrays.fill(b, (byte) 0); }

    /** SHA-256 of the label, a zero byte, then each part with its length (4 bytes, big-endian). */
    static byte[] th(String label, byte[]... parts) {
        try {
            MessageDigest d = MessageDigest.getInstance("SHA-256");
            d.update(utf8(label));
            d.update((byte) 0);
            for (byte[] p : parts) {
                int n = p.length;
                d.update(new byte[] { (byte) (n >>> 24), (byte) (n >>> 16), (byte) (n >>> 8), (byte) n });
                d.update(p);
            }
            return d.digest();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] hmac(byte[] key, byte[] msg) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            // An empty HMAC key is legal (HKDF without salt); SecretKeySpec refuses one.
            m.init(new SecretKeySpec(key.length == 0 ? new byte[32] : key, "HmacSHA256"));
            return m.doFinal(msg);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** HKDF-SHA256 (RFC 5869), len bytes. */
    static byte[] hkdf(byte[] salt, byte[] ikm, byte[] info, int len) {
        byte[] prk = hmac(salt, ikm);
        byte[] out = expand(prk, info, len);
        wipe(prk);
        return out;
    }

    static byte[] hkdf(byte[] salt, byte[] ikm, String info) { return hkdf(salt, ikm, utf8(info), 32); }

    static byte[] expand(byte[] prk, byte[] info, int len) {
        byte[] out = new byte[len], t = new byte[0];
        int at = 0;
        for (int i = 1; at < len; i++) {
            byte[] m = new byte[t.length + info.length + 1];
            System.arraycopy(t, 0, m, 0, t.length);
            System.arraycopy(info, 0, m, t.length, info.length);
            m[m.length - 1] = (byte) i;
            t = hmac(prk, m);
            int n = Math.min(t.length, len - at);
            System.arraycopy(t, 0, out, at, n);
            at += n;
        }
        return out;
    }

    static byte[] expand(byte[] prk, String info) { return expand(prk, utf8(info), 32); }

    static byte[] cat(byte[] a, byte[] b) {
        byte[] r = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, r, a.length, b.length);
        return r;
    }

    static byte[] labelled(byte[] key, String label, byte[] t) { return hmac(key, cat(utf8(label), t)); }

    static boolean same(byte[] a, byte[] b) { return a != null && b != null && a.length > 0 && MessageDigest.isEqual(a, b); }

    private static byte[] flag(boolean b) { return utf8(b ? "1" : "0"); }

    // ---- pairing ----

    static byte[] pairPresenceMsg(String hubFp, String phoneFp, String token, byte[] epk, byte[] presence, boolean binding, byte[] x) {
        return th("harbor-pair-v3 presence", utf8(hubFp), utf8(phoneFp), utf8(token), epk, presence, flag(binding), x);
    }

    static byte[] pairTranscript(String hubFp, String phoneFp, String token, byte[] epkP, byte[] epkH, byte[] presence, boolean binding, byte[] x) {
        return th("harbor-pair-v3", utf8(hubFp), utf8(phoneFp), utf8(token), epkP, epkH, presence, flag(binding), x);
    }

    /** What the pairing secret proves when a pairing re-confirms its factors (rekey). */
    static byte[] rekeyMsg(String hubFp, String phoneFp, String token, byte[] epk, byte[] presence, boolean binding, byte[] x) {
        return th("harbor-rekey-v3", utf8(hubFp), utf8(phoneFp), utf8(token), epk, presence, flag(binding), x);
    }

    /** What a new presence key signs to add the third factor to a two-factor pairing. */
    static byte[] addPresenceMsg(String hubFp, String phoneFp, String token, String sid, byte[] presence) {
        return th("harbor-presence-v3", utf8(hubFp), utf8(phoneFp), utf8(token), utf8(sid), presence);
    }

    /** The key of the background pings (POST /v1/alive): from the pairing secret, no presence key. */
    static byte[] aliveKey(byte[] secret) { return hkdf(utf8("harbor-alive-v1"), secret, "harbor-alive-v1 key"); }

    /** What a background ping's MAC covers: both keys, the token, its time (unix ms), the connection. */
    static byte[] aliveMsg(String hubFp, String phoneFp, String token, long ts, byte[] x) {
        return th("harbor-alive-v1", utf8(hubFp), utf8(phoneFp), utf8(token), utf8(Long.toString(ts)), x);
    }

    /** The pairing secret and the 6-digit code both screens show. */
    static Object[] pairKeys(byte[] t, byte[] z) {
        byte[] s = hkdf(t, z, "harbor-pair-v3 secret");
        byte[] c = hkdf(t, z, "harbor-pair-v3 sas");
        long n = ((c[0] & 0xffL) << 24) | ((c[1] & 0xffL) << 16) | ((c[2] & 0xffL) << 8) | (c[3] & 0xffL);
        return new Object[] { s, String.format(Locale.ROOT, "%06d", n % 1_000_000) };
    }

    /** The secret this pairing has on another PC of the mesh (fingerprint hubFp). */
    static byte[] hubSecret(byte[] root, String hubFp) { return hkdf(utf8(hubFp), root, "harbor-hub-v3"); }

    // ---- sessions ----

    static byte[] sessionTranscript(String hubFp, String phoneFp, String token, byte[] epkP, byte[] epkH, byte[] nonce, byte[] challenge, byte[] x) {
        return th("harbor-session-v3", utf8(hubFp), utf8(phoneFp), utf8(token), epkP, epkH, nonce, challenge, x);
    }

    static byte[] sessionPresenceMsg(byte[] t2) { return cat(utf8("harbor-session-v3 presence"), t2); }

    static byte[] sessionRoot(byte[] t2, byte[] z, byte[] secret) {
        byte[] ikm = cat(z, secret);
        byte[] r = hkdf(t2, ikm, "harbor-session-v3 root");
        wipe(ikm);
        return r;
    }

    static String requestMsg(String sid, long epoch, long ctr, String method, String target, long len, String phoneFp, String hubFp, byte[] x) {
        return "harbor-req-v3\n" + sid + "\n" + epoch + "\n" + ctr + "\n" + method + "\n" + target + "\n" + len + "\n" + phoneFp + "\n" + hubFp + "\n" + (x == null ? "-" : hex(x));
    }

    /** A session's keys on the phone: the chain link of the current epoch; each step erases the
     *  one before, so nothing older can be recomputed. */
    static final class Ratchet {
        private long epoch;
        private byte[] chain;

        Ratchet(byte[] root) { chain = root.clone(); }

        long epoch() { return epoch; }

        /** The request key for epoch e (never back: null for an epoch already left). */
        synchronized byte[] key(long e) {
            if (e < epoch) return null;
            while (epoch < e) {
                byte[] next = expand(chain, "harbor-v3 chain");
                wipe(chain);
                chain = next;
                epoch++;
            }
            return expand(chain, "harbor-v3 mac");
        }

        synchronized void wipeAll() { wipe(chain); }
    }

    // ---- ECDH on P-256, keys as SubjectPublicKeyInfo DER (what the hub sends and expects) ----

    static KeyPair ephemeral() {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
            g.initialize(new ECGenParameterSpec("secp256r1"));
            return g.generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** Our SPKI (always the named-curve form the hub reads). */
    static byte[] spki(PublicKey k) { return k.getEncoded(); }

    static byte[] agree(PrivateKey mine, byte[] peerSpki) throws java.security.GeneralSecurityException {
        PublicKey peer = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(peerSpki));
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(mine);
        ka.doPhase(peer, true);
        byte[] z = ka.generateSecret();
        // A shared secret is the x coordinate, 32 bytes on P-256 (some providers drop a leading 0).
        return z.length < 32 ? leftPad(z) : z;
    }

    private static byte[] leftPad(byte[] z) {
        byte[] r = new byte[32];
        System.arraycopy(z, 0, r, 32 - z.length, z.length);
        return r;
    }
}
