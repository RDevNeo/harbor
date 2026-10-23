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
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** The only way the app reaches a hub. The API is plain HTTP/1.1 (android/PROTOCOL.md), so it
 *  must only travel inside Tailscale's WireGuard tunnel: each request resolves the host on
 *  Tailscale's VPN network, needs a tailnet address (100.64/10, fd7a:115c:a1e0::/48) and
 *  connects a socket bound to that network. With Tailscale off, or any other address, the
 *  token never leaves the phone. Loopback is allowed too (adb reverse, for testing). The
 *  platform HTTP stack gets no cleartext at all (res/xml/network.xml). */
final class Tailnet {
    /** Not sent: the hub isn't reachable through Tailscale right now. */
    static final class Refused extends IOException {
        Refused(String msg) { super(msg); }
    }

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

    /** Tailscale's VPN network: a VPN with an address of its own in the tailnet. Null when off. */
    static Network vpn(Context c) {
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        if (cm == null) return null;
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities nc = cm.getNetworkCapabilities(n);
            if (nc == null || !nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            LinkProperties lp = cm.getLinkProperties(n);
            if (lp != null) for (LinkAddress la : lp.getLinkAddresses()) if (tailnet(la.getAddress())) return n;
        }
        return null;
    }

    /** A socket to host:port through Tailscale (or loopback), or Refused. */
    static Socket connect(String host, int port, int timeout) throws IOException {
        String h = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        if (literal(h)) {
            InetAddress a = InetAddress.getByName(h);
            if (a.isLoopbackAddress()) {
                Socket s = new Socket();
                s.connect(new InetSocketAddress(a, port), timeout);
                return s;
            }
        }
        Network n = Ui.app == null ? null : vpn(Ui.app);
        if (n == null) throw new Refused("Tailscale is off on this phone. Turn it on to reach the PC.");
        InetAddress to = null;
        for (InetAddress a : n.getAllByName(h)) if (tailnet(a)) { to = a; break; }
        if (to == null) throw new Refused(host + " isn't a Tailscale address. Pair with the PC's Tailscale name or IP.");
        Socket s = new Socket();
        try {
            n.bindSocket(s);
            s.connect(new InetSocketAddress(to, port), timeout);
        } catch (IOException e) {
            s.close();
            throw e;
        }
        return s;
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
