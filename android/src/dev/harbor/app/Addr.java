package dev.harbor.app;

import java.net.InetAddress;

/** Tailnet's address rules, plain Java so android/test/AddrTest.java checks them on the JVM
 *  (build.sh runs it). */
final class Addr {
    /** How a request may reach the hub. */
    enum Way { VPN, DEFAULT, OFF }

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

    /** vpnBound: a socket is bound to Tailscale's VPN network. Without one (some phone doesn't
     *  show it as a VPN, or binding fails) the default network may carry the request, but only
     *  while Tailscale is up here (localUp), and only to a tailnet address (pick), so it still
     *  goes through the tunnel. Otherwise nothing is sent. */
    static Way way(boolean vpnBound, boolean localUp) {
        return vpnBound ? Way.VPN : localUp ? Way.DEFAULT : Way.OFF;
    }
}
