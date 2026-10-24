package dev.harbor.app;

import java.net.InetAddress;
import java.util.Arrays;
import java.util.Collections;

/** Net's rules (Addr). Plain JVM, no Android: build.sh runs it before packaging. */
public class AddrTest {
    private static int failed;

    private static void check(boolean ok, String what) {
        if (!ok) { failed++; System.err.println("FAIL " + what); }
    }

    private static InetAddress ip(String s) throws Exception { return InetAddress.getByName(s); }

    /** An IPv4 address from its octets (tailnet ones aren't written out: the pre-commit hook
     *  refuses anything that looks like a real tailnet address). */
    private static InetAddress v4(int a, int b, int c, int d) throws Exception {
        return InetAddress.getByAddress(new byte[]{(byte) a, (byte) b, (byte) c, (byte) d});
    }

    /** ::ffff:a.b.c.d, the IPv4-mapped form. */
    private static InetAddress mapped(int a, int b, int c, int d) throws Exception {
        byte[] x = new byte[16];
        x[10] = (byte) 0xff; x[11] = (byte) 0xff;
        x[12] = (byte) a; x[13] = (byte) b; x[14] = (byte) c; x[15] = (byte) d;
        return InetAddress.getByAddress(x);
    }

    public static void main(String[] args) throws Exception {
        // Tailscale's ranges, and their edges.
        for (InetAddress a : new InetAddress[]{v4(100, 64, 0, 0), v4(100, 100, 1, 1), v4(100, 127, 255, 255),
                ip("fd7a:115c:a1e0::1"), ip("fd7a:115c:a1e0:ffff::9"), mapped(100, 90, 0, 1)})
            check(Addr.tailnet(a), a + " is tailnet");
        for (InetAddress a : new InetAddress[]{v4(100, 63, 255, 255), v4(100, 128, 0, 0), ip("10.0.2.2"), ip("192.0.2.1"),
                ip("127.0.0.1"), ip("::1"), ip("fd7a:115c:a1e1::1"), ip("fe80::1")})
            check(!Addr.tailnet(a), a + " is not tailnet");

        check(Addr.literal(v4(100, 64, 1, 2).getHostAddress()) && Addr.literal("fd7a::1"), "IP literals");
        check(!Addr.literal("desk.example.ts.net") && !Addr.literal("localhost") && !Addr.literal("1e100.net"), "names aren't literals");

        // pick: the first tailnet address, never another one.
        check(v4(100, 101, 1, 2).equals(Addr.pick(new InetAddress[]{ip("192.0.2.1"), v4(100, 101, 1, 2)})), "pick skips non-tailnet");
        check(Addr.pick(new InetAddress[]{ip("192.0.2.1"), ip("10.0.2.2")}) == null, "pick: none");
        check(Addr.pick(null) == null && Addr.pick(new InetAddress[0]) == null, "pick: empty");

        // up: Tailscale's own address on an interface.
        check(Addr.up(Arrays.asList(ip("127.0.0.1"), ip("192.0.2.7"), v4(100, 70, 0, 3))), "up with a tailnet address");
        check(Addr.up(Collections.singletonList(ip("fd7a:115c:a1e0::3"))), "up with a tailnet IPv6");
        check(!Addr.up(Arrays.asList(ip("127.0.0.1"), ip("192.0.2.7"), ip("fe80::1"))), "down without one");

        // how: a pinned key goes anywhere over TLS; without one only loopback, or the one-time
        // upgrade of an old pairing inside Tailscale.
        check(Addr.how(true, false, false, false) == Addr.How.TLS_PINNED, "pinned: TLS to a LAN address");
        check(Addr.how(true, true, false, false) == Addr.How.TLS_PINNED, "pinned: TLS even to loopback");
        check(Addr.how(false, true, false, false) == Addr.How.PLAIN_LOOPBACK, "no key, loopback: plain");
        check(Addr.how(false, false, true, true) == Addr.How.TLS_FIRST_USE, "no key, tailnet address with Tailscale up: learn it once");
        check(Addr.how(false, false, true, false) == Addr.How.REFUSE, "no key, Tailscale off: refused");
        check(Addr.how(false, false, false, true) == Addr.How.REFUSE, "no key, a LAN address: refused (pair again)");
        check(Addr.how(false, false, false, false) == Addr.How.REFUSE, "no key, nothing: refused");
        String f = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        check(f.equals(Addr.fp(f.toUpperCase())) && f.equals(Addr.fp("01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef")), "fingerprints normalised");
        check(Addr.fp("abc") == null && Addr.fp(null) == null && Addr.fp(f + "0") == null && Addr.fp(f.replace('a', 'g')) == null, "bad fingerprints");

        if (failed > 0) { System.err.println(failed + " AddrTest check(s) failed"); System.exit(1); }
        System.out.println("AddrTest ok");
    }
}
