package dev.harbor.app;

import java.security.KeyPair;
import java.util.Arrays;

/** Sec against the hub's own numbers (src/phoneauth.rs, vectors_for_the_phone): the phone and
 *  the PC must derive the same codes and keys bit for bit. Plain JVM: build.sh runs it. */
public class SecTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static byte[] fill(int v) { byte[] b = new byte[32]; Arrays.fill(b, (byte) v); return b; }

    public static void main(String[] a) throws Exception {
        // RFC 5869 A.1
        byte[] ikm = new byte[22];
        Arrays.fill(ikm, (byte) 0x0b);
        check(Sec.hex(Sec.hkdf(Sec.unhex("000102030405060708090a0b0c"), ikm, Sec.unhex("f0f1f2f3f4f5f6f7f8f9"), 42))
                .equals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"), "hkdf rfc5869");

        check(Sec.hex(Sec.th("harbor-test", Sec.utf8("one"), new byte[0], Sec.utf8("three")))
                .equals("af7369f5bac5c613b958471530d69b638f0be097c6b131b91fd55b3576e787a3"), "transcript hash");
        Object[] pk = Sec.pairKeys(fill(1), fill(2));
        check(Sec.hex((byte[]) pk[0]).equals("cd966abbfc7ca130ce3c947df356376ba6852ee20f3724c8afcd635441bff309"), "pairing secret");
        check("547386".equals(pk[1]), "pairing code " + pk[1]);

        Sec.Ratchet r = new Sec.Ratchet(Sec.hkdf(fill(3), fill(4), "harbor-session-v3 root"));
        check(Sec.hex(r.key(0)).equals("e6b49459350050f2c0c6ea10a589ec82e565579adc99f05a00ba18fad774146e"), "epoch 0 key");
        byte[] k3 = r.key(3);
        check(Sec.hex(k3).equals("7c342e37a39cace52b8281c6ea32c3125608190ff09969cfbb5750608ed66f3f"), "epoch 3 key");
        check(r.key(2) == null, "the ratchet doesn't go back");
        String msg = Sec.requestMsg("sid", 3, 7, "GET", "/v1/state?x=1", 0, "aa", "bb", fill(5));
        check(Sec.hex(Sec.hmac(k3, Sec.utf8(msg))).equals("78d83b9c1472be6f7cfabe8d2c59f7a155de2b26ed7c880cd877dc81fe863ad2"), "request MAC");
        check(Sec.hex(Sec.hubSecret(fill(6), "cc")).equals("849c6eb3ca9b030f2bb199862c4e88aaa29cf7460dfeb1b09daaca05f9e60571"), "hub secret");

        byte[] four7 = new byte[4], four9 = new byte[4], x8 = new byte[32];
        Arrays.fill(four7, (byte) 7); Arrays.fill(four9, (byte) 9); Arrays.fill(x8, (byte) 8);
        check(Sec.hex(Sec.rekeyMsg("hh", "pp", "tok", four7, new byte[0], true, x8)).equals("76ff425e763a66725ee859afa39a3acf83e72379ec78c23a220775f0a8752aa1"), "rekey proof message");
        check(Sec.hex(Sec.addPresenceMsg("hh", "pp", "tok", "sid", four9)).equals("9b66f1a091d649ccdbd56509decd14e9a881a93ebddb7f0648cae184944d85dd"), "add-presence message");

        check(Sec.hex(Sec.hmac(Sec.aliveKey(fill(6)), Sec.aliveMsg("hh", "pp", "tok", 1700000000123L, x8))).equals("edce0e0a5d43c76eef6683bc40daa39f9382ec6366a8054d3718df151a687599"), "alive ping MAC");

        // ECDH: both ends agree, keys travel as 91-byte named-curve SPKI (what the hub parses).
        KeyPair x = Sec.ephemeral(), y = Sec.ephemeral();
        byte[] sx = Sec.spki(x.getPublic()), sy = Sec.spki(y.getPublic());
        check(sx.length == 91 && Sec.hex(sx).startsWith("3059301306072a8648ce3d020106082a8648ce3d030107034200"), "spki form");
        check(Arrays.equals(Sec.agree(x.getPrivate(), sy), Sec.agree(y.getPrivate(), sx)), "ecdh agrees");
        check(Sec.agree(x.getPrivate(), sy).length == 32, "32-byte secret");

        if (failed > 0) { System.err.println(failed + " failed"); System.exit(1); }
        System.out.println("SecTest ok");
    }
}
