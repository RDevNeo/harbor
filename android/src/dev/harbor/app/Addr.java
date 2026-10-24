package dev.harbor.app;

import java.net.InetAddress;

/** Net's rules for where a request may go, plain Java so android/test/AddrTest.java checks them
 *  on the JVM (build.sh runs it). */
final class Addr {
    /** How a connection to a hub is made. */
    enum How {
        /** TLS, and the hub must show the pinned key: the normal case, to any address. */
        TLS_PINNED,
        /** TLS, learning the hub's key: a pairing from before 0.13, over Tailscale only. */
        TLS_FIRST_USE,
        /** Plain HTTP to 127.0.0.1 (adb reverse, test rigs) for a pairing without a key. */
        PLAIN_LOOPBACK,
        /** Nothing is sent. */
        REFUSE
    }

    /** hasPin: the pairing has the hub's key. loopback: the address is this phone. tailnetDest: a
     *  Tailscale address (a pairing from before 0.13 names one), vpnUp: Tailscale is up here. A
     *  pinned key goes anywhere; without one only loopback (plain), or the one-time upgrade of an
     *  old pairing inside Tailscale's tunnel, where WireGuard vouches for the hub. */
    static How how(boolean hasPin, boolean loopback, boolean tailnetDest, boolean vpnUp) {
        if (hasPin) return How.TLS_PINNED;
        if (loopback) return How.PLAIN_LOOPBACK;
        if (tailnetDest && vpnUp) return How.TLS_FIRST_USE;
        return How.REFUSE;
    }

    /** A fingerprint as the pairing link or a person gives it: 64 hex characters (spaces, colons
     *  and dashes dropped), lowercase; null otherwise. */
    static String fp(String s) {
        if (s == null) return null;
        String f = s.replaceAll("[\\s:-]", "").toLowerCase(java.util.Locale.ROOT);
        return f.matches("[0-9a-f]{64}") ? f : null;
    }

    /** Tailscale's ranges: 100.64/10 and fd7a:115c:a1e0::/48. */
    static boolean tailnet(InetAddress a) {
        byte[] b = a.getAddress();
        if (b.length == 4) return (b[0] & 0xff) == 100 && (b[1] & 0xc0) == 64;
        return b.length == 16 && (b[0] & 0xff) == 0xfd && (b[1] & 0xff) == 0x7a && (b[2] & 0xff) == 0x11
                && (b[3] & 0xff) == 0x5c && (b[4] & 0xff) == 0xa1 && (b[5] & 0xff) == 0xe0;
    }

    /** An IP literal (no DNS lookup needed to parse it). */
    static boolean literal(String host) {
        return host.contains(":") || host.matches("[0-9.]+");
    }

    /** The first tailnet address among a host's addresses, or null. */
    static InetAddress pick(InetAddress[] all) {
        if (all != null) for (InetAddress a : all) if (a != null && tailnet(a)) return a;
        return null;
    }

    /** True when one of this phone's own addresses is in the tailnet: Tailscale is up. */
    static boolean up(Iterable<InetAddress> local) {
        for (InetAddress a : local) if (tailnet(a)) return true;
        return false;
    }
}
