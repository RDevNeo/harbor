package dev.harbor.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509ExtendedKeyManager;
import javax.net.ssl.X509ExtendedTrustManager;
import javax.security.auth.x500.X500Principal;

/** The only way the app reaches a hub (android/PROTOCOL.md). Every connection is mutual TLS with
 *  pinned keys: the hub must show the key (fingerprint) this phone paired with, and the phone
 *  shows its own, an EC key made in the Android Keystore on first use that never leaves it.
 *  The hub binds that key to the pairing's token, so a copied token alone gets nothing.
 *  Exceptions, both decided in Addr.how:
 *  - loopback in plain HTTP while a pairing has no key (adb reverse, test rigs);
 *  - a pairing from before 0.13 has no key yet: it learns the hub's key once, but only over
 *    Tailscale's VPN to a tailnet address, where WireGuard already vouches for the hub (as
 *    before 0.13), and from then on it's pinned. Anything else without a key is refused: pair again.
 *  The platform HTTP stack gets no cleartext at all (res/xml/network.xml). */
final class Net {
    /** Not sent: no safe way to reach the hub right now. */
    static final class Refused extends IOException {
        Refused(String msg) { super(msg); }
    }

    /** The hub answered with another key than the pinned one. */
    static final class WrongKey extends IOException {
        WrongKey() { super("This PC answered with another key than the one it was paired with. Pair it again (Harbor › Settings › Phones)."); }
    }

    // ---- this phone's key ----

    private static final String ALIAS = "harbor-tls";
    private static KeyStore.PrivateKeyEntry entry;

    /** The phone's key and certificate, made in the Keystore the first time. */
    static synchronized KeyStore.PrivateKeyEntry identity() throws IOException {
        if (entry != null) return entry;
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (!ks.containsAlias(ALIAS)) {
                KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
                g.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512)
                        .setCertificateSubject(new X500Principal("CN=Harbor phone"))
                        .setCertificateSerialNumber(BigInteger.ONE)
                        .setCertificateNotBefore(new Date(1735689600000L))   // 2025-01-01
                        .setCertificateNotAfter(new Date(4891363200000L))    // 2125-01-01
                        .build());
                g.generateKeyPair();
            }
            entry = (KeyStore.PrivateKeyEntry) ks.getEntry(ALIAS, null);
            if (entry == null) throw new IOException("no key");
            return entry;
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("This phone's key store isn't working: " + e.getMessage(), e);
        }
    }

    /** SHA-256 of a certificate's public key (its SubjectPublicKeyInfo), hex: what both sides pin. */
    static String fingerprint(X509Certificate c) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(c.getPublicKey().getEncoded());
            StringBuilder b = new StringBuilder();
            for (byte x : d) b.append(String.format(Locale.ROOT, "%02x", x & 0xff));
            return b.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** This phone's fingerprint ("" when the Keystore fails). */
    static String myFp() {
        try { return fingerprint((X509Certificate) identity().getCertificate()); } catch (IOException e) { return ""; }
    }

    /** Shows the Keystore key to the hub when it asks. */
    private static final class Keys extends X509ExtendedKeyManager {
        private final KeyStore.PrivateKeyEntry e;
        Keys(KeyStore.PrivateKeyEntry e) { this.e = e; }
        @Override public String chooseClientAlias(String[] t, Principal[] i, Socket s) { return ALIAS; }
        @Override public String chooseEngineClientAlias(String[] t, Principal[] i, SSLEngine en) { return ALIAS; }
        @Override public String[] getClientAliases(String t, Principal[] i) { return new String[] { ALIAS }; }
        @Override public X509Certificate[] getCertificateChain(String a) {
            java.security.cert.Certificate[] c = e.getCertificateChain();
            X509Certificate[] x = new X509Certificate[c.length];
            for (int k = 0; k < c.length; k++) x[k] = (X509Certificate) c[k];
            return x;
        }
        @Override public PrivateKey getPrivateKey(String a) { return e.getPrivateKey(); }
        @Override public String chooseServerAlias(String t, Principal[] i, Socket s) { return null; }
        @Override public String[] getServerAliases(String t, Principal[] i) { return null; }
    }

    /** The hub's key must be the pinned one (pin null: any, remembered in seen; Addr.how decides
     *  when that's allowed). No names or authorities: the key is the identity. */
    private static final class Pin extends X509ExtendedTrustManager {
        final String pin;
        volatile String seen;
        Pin(String pin) { this.pin = pin; }

        private void check(X509Certificate[] chain) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("no certificate");
            String fp = fingerprint(chain[0]);
            seen = fp;
            if (pin != null && !MessageDigest.isEqual(pin.getBytes(StandardCharsets.US_ASCII), fp.getBytes(StandardCharsets.US_ASCII)))
                throw new CertificateException("wrong key");
        }
        @Override public void checkServerTrusted(X509Certificate[] c, String a) throws CertificateException { check(c); }
        @Override public void checkServerTrusted(X509Certificate[] c, String a, Socket s) throws CertificateException { check(c); }
        @Override public void checkServerTrusted(X509Certificate[] c, String a, SSLEngine e) throws CertificateException { check(c); }
        @Override public void checkClientTrusted(X509Certificate[] c, String a) throws CertificateException { throw new CertificateException("client only"); }
        @Override public void checkClientTrusted(X509Certificate[] c, String a, Socket s) throws CertificateException { throw new CertificateException("client only"); }
        @Override public void checkClientTrusted(X509Certificate[] c, String a, SSLEngine e) throws CertificateException { throw new CertificateException("client only"); }
        @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    // ---- Tailscale, only to upgrade a pairing from before 0.13 ----

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

    // ---- connecting ----

    /** A connection to host:port, TLS pinned to pin (a fingerprint, or null for a pairing from
     *  before 0.13). Its seen() is the hub's fingerprint. */
    static Http open(String host, int port, String pin, String method, String path, int readTimeout, int connectTimeout) throws IOException {
        String h = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        boolean hasPin = pin != null && !pin.isEmpty();
        // One lookup decides where it goes (a name could resolve differently twice).
        InetAddress[] all = InetAddress.getAllByName(h);
        InetAddress first = all.length > 0 ? all[0] : null;
        boolean loop = first != null && first.isLoopbackAddress();
        Network n = null;
        InetAddress to = first;
        Addr.How how;
        if (hasPin || loop) {
            how = Addr.how(hasPin, loop, false, false);
        } else {
            n = Ui.app == null ? null : vpn(Ui.app);
            // On Tailscale's network its own DNS (MagicDNS) answers.
            InetAddress[] ts = n != null ? n.getAllByName(h) : (localUp() ? all : null);
            to = Addr.pick(ts);
            how = Addr.how(false, false, to != null, n != null || localUp());
        }
        if (how == Addr.How.REFUSE)
            throw new Refused("This pairing is from before Harbor 0.13 and has no key for the PC: pair the phone again (Harbor › Settings › Phones › Pair a phone).");
        Socket s = how == Addr.How.TLS_FIRST_USE && n != null ? bound(n) : null;
        if (s == null) s = new Socket();
        try {
            s.connect(new InetSocketAddress(to, port), connectTimeout);
            s.setSoTimeout(readTimeout);
            if (how == Addr.How.PLAIN_LOOPBACK) return new Http(s, host, port, method, path, null);
            Pin trust = new Pin(hasPin ? pin : null);
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(new X509ExtendedKeyManager[] { new Keys(identity()) }, new TrustManager[] { trust }, null);
            SSLSocket ss = (SSLSocket) ctx.getSocketFactory().createSocket(s, h, port, true);
            List<String> want = new ArrayList<>();
            for (String p : ss.getSupportedProtocols()) if (p.equals("TLSv1.3") || p.equals("TLSv1.2")) want.add(p);
            ss.setEnabledProtocols(want.toArray(new String[0]));
            ss.setUseClientMode(true);
            ss.setSoTimeout(Math.max(connectTimeout, 8_000)); // the handshake
            try {
                ss.startHandshake();
            } catch (SSLHandshakeException e) {
                if (hasPin && trust.seen != null && !trust.seen.equals(pin)) throw new WrongKey();
                throw e;
            }
            ss.setSoTimeout(readTimeout);
            Http c = new Http(ss, host, port, method, path, trust.seen);
            c.ssl = ss;
            return c;
        } catch (IOException | RuntimeException | java.security.GeneralSecurityException e) {
            try { s.close(); } catch (IOException ignored) { }
            if (e instanceof IOException) throw (IOException) e;
            throw new IOException(e.getMessage(), e);
        }
    }

    /** One request: head, optional body, then the answer. The hub always answers with
     *  Content-Length and Connection: close. close() may be called from any thread. */
    static final class Http {
        /** Adds the auth headers once the head goes out (the body's length is known then). */
        interface Signer { void sign(Http h, long len) throws IOException; }

        private final Socket s;
        final String method, path;
        SSLSocket ssl; // null: plain loopback
        Signer signer;
        /** The call carried a session's MAC; a 401 then ends that session (on401). */
        boolean signed;
        Runnable on401;
        private long bodyLen;
        private byte[] exporter;
        private boolean exported;
        private final StringBuilder head;
        /** The hub's fingerprint as its TLS handshake showed it (null: plain loopback). */
        final String seen;
        private OutputStream out;
        private InputStream in;
        private int code = -1;
        private long length = -1;

        Http(Socket s, String host, int port, String method, String path, String seen) {
            this.s = s;
            this.method = method;
            this.path = path;
            this.seen = seen;
            String hp = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
            head = new StringBuilder(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            header("Host", hp + ":" + port);
            header("Connection", "close");
        }

        void header(String k, String v) {
            head.append(k).append(": ").append(v.replace("\r", "").replace("\n", "")).append("\r\n");
        }

        /** 32 bytes only this TLS connection has (RFC 5705 exporter, label Sec.EXPORTER), the
         *  same the PC computes: calls are bound to their connection with it. Null without TLS
         *  or on Android before 12, which can't export them. */
        byte[] exporter() {
            if (exported) return exporter;
            exported = true;
            if (ssl != null && android.os.Build.VERSION.SDK_INT >= 31) {
                try {
                    if (android.net.ssl.SSLSockets.isSupportedSocket(ssl))
                        exporter = android.net.ssl.SSLSockets.exportKeyingMaterial(ssl, Sec.EXPORTER, null, 32);
                } catch (Exception | LinkageError e) {
                    exporter = null;
                }
            }
            return exporter;
        }

        /** Sends the head with this Content-Length; write the body to the stream returned. */
        OutputStream body(long len) throws IOException {
            bodyLen = len;
            header("Content-Length", String.valueOf(len));
            send();
            return out;
        }

        private void send() throws IOException {
            if (out != null) return;
            if (!method.equals("GET") && !method.equals("HEAD") && head.indexOf("\r\nContent-Length:") < 0)
                header("Content-Length", "0");
            if (signer != null) signer.sign(this, bodyLen);
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
            if (code == 401 && signed && on401 != null) on401.run();
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
