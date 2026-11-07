package dev.harbor.app;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;

/** Checks a release file's minisign signature with Harbor's release key, the one the desktop
 *  updater uses (ts/packages/update/src/minisign.ts, packaging/minisign.pub). Prehashed
 *  signatures only (BLAKE2b-512 of the file, then Ed25519), as minisign makes by default.
 *  Plain Java with nothing from Android: the phone supports Android 8, which has neither
 *  BLAKE2b nor Ed25519 (MinisignTest). */
final class Minisign {
    private Minisign() { }

    static final String PUBKEY = "RWSaeVHfD2GBvTEgaNXQQs8eQR5rCD50vuckgoo79X6wqhOKXIpUVHNh";

    private static final String TRUSTED = "trusted comment: ";

    /** A .minisig file: the key that made it, the signature over the file's BLAKE2b-512, the
     *  trusted comment ("harbor vX.Y.Z <file>") and the signature over both. */
    static final class Sig {
        byte[] keyId, sig, global;
        String trusted;
    }

    static Sig parse(String text) throws GeneralSecurityException {
        String[] l = text.split("\r?\n");
        if (l.length < 4 || !l[0].startsWith("untrusted comment:") || !l[2].startsWith(TRUSTED))
            throw new GeneralSecurityException("unreadable signature");
        byte[] raw, global;
        try {
            raw = Base64.getDecoder().decode(l[1].trim());
            global = Base64.getDecoder().decode(l[3].trim());
        } catch (IllegalArgumentException e) {
            throw new GeneralSecurityException("unreadable signature");
        }
        if (raw.length != 74 || global.length != 64) throw new GeneralSecurityException("unreadable signature");
        if (raw[0] != 'E' || raw[1] != 'D') throw new GeneralSecurityException("not a prehashed signature");
        Sig s = new Sig();
        s.keyId = Arrays.copyOfRange(raw, 2, 10);
        s.sig = Arrays.copyOfRange(raw, 10, 74);
        s.trusted = l[2].substring(TRUSTED.length());
        s.global = global;
        return s;
    }

    /** Throws unless `s` signs a file whose BLAKE2b-512 is `digest` with key `pubkey` (the bare
     *  base64 line), its trusted comment included. */
    static void verify(String pubkey, byte[] digest, Sig s) throws GeneralSecurityException {
        byte[] raw;
        try { raw = Base64.getDecoder().decode(pubkey.trim()); } catch (IllegalArgumentException e) { throw new GeneralSecurityException("unreadable public key"); }
        if (raw.length != 42 || raw[0] != 'E' || raw[1] != 'd') throw new GeneralSecurityException("unreadable public key");
        if (!Arrays.equals(Arrays.copyOfRange(raw, 2, 10), s.keyId)) throw new GeneralSecurityException("signed with another key");
        byte[] pk = Arrays.copyOfRange(raw, 10, 42);
        if (!Ed25519.verify(pk, digest, s.sig)) throw new GeneralSecurityException("bad signature");
        byte[] c = s.trusted.getBytes(StandardCharsets.UTF_8);
        byte[] covered = Arrays.copyOf(s.sig, 64 + c.length);
        System.arraycopy(c, 0, covered, 64, c.length);
        if (!Ed25519.verify(pk, covered, s.global)) throw new GeneralSecurityException("bad signature on the trusted comment");
    }

    /** Throws unless the trusted comment says release `version` (no "v") and file `name`, as the
     *  release workflow signs them: "harbor v0.156.0 harbor-android.apk". */
    static void signedFor(Sig s, String version, String name) throws GeneralSecurityException {
        if (!s.trusted.contains("v" + version + " ") || !s.trusted.endsWith(name))
            throw new GeneralSecurityException(name + ": signed for another release (" + s.trusted + ")");
    }

    /** All three for a whole file in memory. */
    static void check(String pubkey, byte[] data, String sigText, String version, String name) throws GeneralSecurityException {
        Sig s = parse(sigText);
        Blake2b h = new Blake2b();
        h.update(data, 0, data.length);
        verify(pubkey, h.digest(), s);
        signedFor(s, version, name);
    }

    // ---- BLAKE2b-512 (RFC 7693), unkeyed ----

    static final class Blake2b {
        private static final long[] IV = {
            0x6a09e667f3bcc908L, 0xbb67ae8584caa73bL, 0x3c6ef372fe94f82bL, 0xa54ff53a5f1d36f1L,
            0x510e527fade682d1L, 0x9b05688c2b3e6c1fL, 0x1f83d9abfb41bd6bL, 0x5be0cd19137e2179L };
        private static final byte[][] SIGMA = {
            { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 },
            { 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3 },
            { 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4 },
            { 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8 },
            { 9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13 },
            { 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9 },
            { 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11 },
            { 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10 },
            { 6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5 },
            { 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0 } };

        private final long[] h = IV.clone(), v = new long[16], m = new long[16];
        private final byte[] buf = new byte[128];
        private int n;
        private long t0, t1;

        Blake2b() { h[0] ^= 0x01010000L ^ 64; }

        void update(byte[] b, int off, int len) {
            while (len > 0) {
                if (n == 128) { // full, and more comes: not the last block
                    count(128);
                    compress(false);
                    n = 0;
                }
                int k = Math.min(128 - n, len);
                System.arraycopy(b, off, buf, n, k);
                n += k; off += k; len -= k;
            }
        }

        byte[] digest() {
            count(n);
            Arrays.fill(buf, n, 128, (byte) 0);
            compress(true);
            byte[] out = new byte[64];
            for (int i = 0; i < 64; i++) out[i] = (byte) (h[i >> 3] >>> (8 * (i & 7)));
            return out;
        }

        private void count(int k) {
            t0 += k;
            if (Long.compareUnsigned(t0, k) < 0) t1++;
        }

        private void compress(boolean last) {
            for (int i = 0; i < 16; i++) {
                long x = 0;
                for (int j = 7; j >= 0; j--) x = (x << 8) | (buf[i * 8 + j] & 0xff);
                m[i] = x;
            }
            System.arraycopy(h, 0, v, 0, 8);
            System.arraycopy(IV, 0, v, 8, 8);
            v[12] ^= t0;
            v[13] ^= t1;
            if (last) v[14] = ~v[14];
            for (int r = 0; r < 12; r++) {
                byte[] s = SIGMA[r % 10];
                g(0, 4, 8, 12, m[s[0]], m[s[1]]);
                g(1, 5, 9, 13, m[s[2]], m[s[3]]);
                g(2, 6, 10, 14, m[s[4]], m[s[5]]);
                g(3, 7, 11, 15, m[s[6]], m[s[7]]);
                g(0, 5, 10, 15, m[s[8]], m[s[9]]);
                g(1, 6, 11, 12, m[s[10]], m[s[11]]);
                g(2, 7, 8, 13, m[s[12]], m[s[13]]);
                g(3, 4, 9, 14, m[s[14]], m[s[15]]);
            }
            for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
        }

        private void g(int a, int b, int c, int d, long x, long y) {
            v[a] = v[a] + v[b] + x; v[d] = Long.rotateRight(v[d] ^ v[a], 32);
            v[c] = v[c] + v[d];     v[b] = Long.rotateRight(v[b] ^ v[c], 24);
            v[a] = v[a] + v[b] + y; v[d] = Long.rotateRight(v[d] ^ v[a], 16);
            v[c] = v[c] + v[d];     v[b] = Long.rotateRight(v[b] ^ v[c], 63);
        }
    }

    // ---- Ed25519 verification (RFC 8032 §5.1.7), the reference arithmetic ----

    static final class Ed25519 {
        private static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
        private static final BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
        private static final BigInteger D = BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);
        private static final BigInteger D2 = D.shiftLeft(1).mod(P);
        private static final BigInteger SQRT_M1 = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
        private static final BigInteger[] B;
        static {
            BigInteger y = BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P);
            BigInteger x = recoverX(y, 0);
            B = new BigInteger[] { x, y, BigInteger.ONE, x.multiply(y).mod(P) };
        }

        static boolean verify(byte[] pub, byte[] msg, byte[] sig) {
            if (pub.length != 32 || sig.length != 64) return false;
            BigInteger[] a = decompress(pub), r = decompress(Arrays.copyOfRange(sig, 0, 32));
            if (a == null || r == null) return false;
            BigInteger s = le(Arrays.copyOfRange(sig, 32, 64));
            if (s.compareTo(L) >= 0) return false;
            byte[] hash;
            try {
                MessageDigest md = MessageDigest.getInstance("SHA-512");
                md.update(sig, 0, 32);
                md.update(pub);
                md.update(msg);
                hash = md.digest();
            } catch (GeneralSecurityException e) {
                return false;
            }
            BigInteger k = le(hash).mod(L);
            return equal(mul(s, B), add(r, mul(k, a)));
        }

        private static BigInteger le(byte[] b) {
            byte[] be = new byte[b.length + 1];
            for (int i = 0; i < b.length; i++) be[b.length - i] = b[i];
            return new BigInteger(be);
        }

        private static BigInteger recoverX(BigInteger y, int sign) {
            if (y.compareTo(P) >= 0) return null;
            BigInteger y2 = y.multiply(y);
            BigInteger x2 = y2.subtract(BigInteger.ONE).multiply(D.multiply(y2).add(BigInteger.ONE).modInverse(P)).mod(P);
            if (x2.signum() == 0) return sign == 1 ? null : BigInteger.ZERO;
            BigInteger x = x2.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
            if (x.multiply(x).subtract(x2).mod(P).signum() != 0) x = x.multiply(SQRT_M1).mod(P);
            if (x.multiply(x).subtract(x2).mod(P).signum() != 0) return null;
            if (x.testBit(0) != (sign == 1)) x = P.subtract(x);
            return x;
        }

        private static BigInteger[] decompress(byte[] s) {
            int sign = (s[31] >> 7) & 1;
            byte[] c = s.clone();
            c[31] &= 0x7f;
            BigInteger y = le(c);
            BigInteger x = recoverX(y, sign);
            if (x == null) return null;
            return new BigInteger[] { x, y, BigInteger.ONE, x.multiply(y).mod(P) };
        }

        private static BigInteger[] add(BigInteger[] p, BigInteger[] q) {
            BigInteger a = p[1].subtract(p[0]).multiply(q[1].subtract(q[0])).mod(P);
            BigInteger b = p[1].add(p[0]).multiply(q[1].add(q[0])).mod(P);
            BigInteger c = p[3].multiply(D2).multiply(q[3]).mod(P);
            BigInteger d = p[2].shiftLeft(1).multiply(q[2]).mod(P);
            BigInteger e = b.subtract(a), f = d.subtract(c), g = d.add(c), h = b.add(a);
            return new BigInteger[] { e.multiply(f).mod(P), g.multiply(h).mod(P), f.multiply(g).mod(P), e.multiply(h).mod(P) };
        }

        private static BigInteger[] mul(BigInteger s, BigInteger[] p) {
            BigInteger[] q = { BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO };
            for (int i = s.bitLength() - 1; i >= 0; i--) {
                q = add(q, q);
                if (s.testBit(i)) q = add(q, p);
            }
            return q;
        }

        private static boolean equal(BigInteger[] p, BigInteger[] q) {
            return p[0].multiply(q[2]).subtract(q[0].multiply(p[2])).mod(P).signum() == 0
                    && p[1].multiply(q[2]).subtract(q[1].multiply(p[2])).mod(P).signum() == 0;
        }
    }
}
