package dev.harbor.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** The only way the app reaches a hub. The API is plain HTTP/1.1 (android/PROTOCOL.md), so it
 *  must only travel inside Tailscale's WireGuard tunnel: each request resolves the host on
 *  Tailscale's VPN network, needs a tailnet address (100.64/10, fd7a:115c:a1e0::/48) and
 *  connects a socket bound to that network. Should a phone not show Tailscale as a VPN (or the
 *  binding fail), the default network may carry it, still only to a tailnet address and only
 *  while a local interface has one (Addr.way), so updates keep working. With Tailscale off, or
 *  any other address, the token never leaves the phone. Loopback is allowed too (adb reverse,
 *  for testing). The platform HTTP stack gets no cleartext at all (res/xml/network.xml). */
final class Tailnet {
    /** Not sent: the hub isn't reachable through Tailscale right now. */
    static final class Refused extends IOException {
        Refused(String msg) { super(msg); }
    }

    /** Tailscale's VPN network: a VPN with an address of its own in the tailnet. Null when off. */
    static Network vpn(Context c) {
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        if (cm == null) return null;
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities nc = cm.getNetworkCapabilities(n);
            if (nc == null || !nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            LinkProperties lp = cm.getLinkProperties(n);
            if (lp != null) for (LinkAddress la : lp.getLinkAddresses()) if (Addr.tailnet(la.getAddress())) return n;
        }
        return null;
    }

    /** A socket bound to network n, or null when Android won't bind it. */
    private static Socket bound(Network n) {
        Socket s = new Socket();
        try {
            n.bindSocket(s);
            return s;
        } catch (IOException | RuntimeException e) {
            try { s.close(); } catch (IOException ignored) { }
            return null;
        }
    }

    /** True when an interface of this phone is up with a tailnet address (Tailscale's tun). */
    static boolean localUp() {
        List<InetAddress> own = new ArrayList<>();
        try {
            for (NetworkInterface i : Collections.list(NetworkInterface.getNetworkInterfaces()))
                if (i.isUp()) own.addAll(Collections.list(i.getInetAddresses()));
        } catch (Exception e) {
            return false;
        }
        return Addr.up(own);
    }

    /** A socket to host:port through Tailscale (or loopback), or Refused. */
    static Socket connect(String host, int port, int timeout) throws IOException {
        String h = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        if (Addr.literal(h)) {
            InetAddress a = InetAddress.getByName(h);
            if (a.isLoopbackAddress()) {
                Socket s = new Socket();
                s.connect(new InetSocketAddress(a, port), timeout);
                return s;
            }
        }
        Network n = Ui.app == null ? null : vpn(Ui.app);
        Socket s = n == null ? null : bound(n);
        Addr.Way way = Addr.way(s != null, s == null && localUp());
        if (way == Addr.Way.OFF) throw new Refused("Tailscale is off on this phone. Turn it on to reach the PC.");
        if (s == null) s = new Socket();
        try {
            // On the VPN network its own DNS (MagicDNS) answers; on the default one, the phone's.
            InetAddress to = Addr.pick(way == Addr.Way.VPN ? n.getAllByName(h) : InetAddress.getAllByName(h));
            if (to == null) throw new Refused(host + " isn't a Tailscale address. Pair with the PC's Tailscale name or IP.");
            s.connect(new InetSocketAddress(to, port), timeout);
            return s;
        } catch (IOException e) {
            s.close();
            throw e;
        }
    }

    /** One request: head, optional body, then the answer. The hub always answers with
     *  Content-Length and Connection: close. close() may be called from any thread. */
    static final class Http {
        private final Socket s;
        private final String method;
        private final StringBuilder head;
        private OutputStream out;
        private InputStream in;
        private int code = -1;
        private long length = -1;

        Http(String host, int port, String method, String path, int readTimeout) throws IOException {
            this.method = method;
            s = connect(host, port, 8_000);
            s.setSoTimeout(readTimeout);
            String hp = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
            head = new StringBuilder(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            header("Host", hp + ":" + port);
            header("Connection", "close");
        }

        void header(String k, String v) {
            head.append(k).append(": ").append(v.replace("\r", "").replace("\n", "")).append("\r\n");
        }

        /** Sends the head with this Content-Length; write the body to the stream returned. */
        OutputStream body(long len) throws IOException {
            header("Content-Length", String.valueOf(len));
            send();
            return out;
        }

        private void send() throws IOException {
            if (out != null) return;
            if (!method.equals("GET") && !method.equals("HEAD") && head.indexOf("\r\nContent-Length:") < 0)
                header("Content-Length", "0");
            OutputStream raw = new BufferedOutputStream(s.getOutputStream(), 1 << 16);
            raw.write(head.append("\r\n").toString().getBytes(StandardCharsets.UTF_8));
            // Closing the body only flushes: the socket stays open for the answer.
            out = new FilterOutputStream(raw) {
                @Override public void write(byte[] b, int off, int len) throws IOException { raw.write(b, off, len); }
                @Override public void close() throws IOException { raw.flush(); }
            };
        }

        /** The status code; reads the answer's head the first time. */
        int code() throws IOException {
            if (code >= 0) return code;
            send();
            out.flush();
            InputStream r = new BufferedInputStream(s.getInputStream(), 1 << 14);
            String status = line(r);
            String[] p = status.split(" ", 3);
            if (p.length < 2 || !p[0].startsWith("HTTP/")) throw new IOException("bad reply from the PC");
            try { code = Integer.parseInt(p[1]); } catch (NumberFormatException e) { throw new IOException("bad reply from the PC"); }
            for (String l; !(l = line(r)).isEmpty(); ) {
                int i = l.indexOf(':');
                if (i > 0 && l.substring(0, i).trim().toLowerCase(Locale.ROOT).equals("content-length")) {
                    try { length = Long.parseLong(l.substring(i + 1).trim()); } catch (NumberFormatException ignored) { }
                }
            }
            in = length < 0 ? r : new Limited(r, length);
            return code;
        }

        /** Content-Length of the answer, -1 if none. */
        long length() throws IOException { code(); return length; }

        /** The answer's body (for errors too). */
        InputStream in() throws IOException { code(); return in; }

        void close() {
            try { s.close(); } catch (IOException ignored) { }
        }

        private static String line(InputStream r) throws IOException {
            StringBuilder b = new StringBuilder();
            for (int c; (c = r.read()) != '\n'; ) {
                if (c < 0) throw new java.io.EOFException("unexpected end of stream");
                if (b.length() > 16_384) throw new IOException("bad reply from the PC");
                if (c != '\r') b.append((char) c);
            }
            return b.toString();
        }
    }

    /** At most n bytes of in. */
    private static final class Limited extends InputStream {
        private final InputStream in;
        private long left;

        Limited(InputStream in, long n) { this.in = in; left = n; }

        @Override public int read() throws IOException {
            if (left <= 0) return -1;
            int c = in.read();
            if (c >= 0) left--;
            return c;
        }

        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = in.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override public void close() throws IOException { in.close(); }
    }
}
