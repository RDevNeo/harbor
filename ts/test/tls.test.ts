import { afterAll, describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, verify, X509Certificate } from "node:crypto";
import { createServer as tcpServer, connect as tcpConnect, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server, TLSSocket } from "node:tls";
import { connect as raw, TLSSocket as TlsWrap } from "node:tls";
import { certFp, connect, generateIdentity, normalizeFp, parseIdentity, peerFp, server, serverTls, short, signWith, spki, WRONG_KEY } from "../proto/tls.ts";

const srv = generateIdentity();
const cli = generateIdentity();
const servers: (Server | TcpServer)[] = [];

afterAll(() => {
  for (const s of servers) s.close();
});

function listen(s: Server | TcpServer): Promise<number> {
  servers.push(s);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

interface Seen {
  peer: string | null;
  version: string | null;
}

function echo(seen: Seen[], known?: (fp: string) => boolean): Server {
  return server({
    id: srv,
    ...(known ? { known } : {}),
    onConnection: (sock, peer) => {
      seen.push({ peer, version: sock.getProtocol() });
      sock.on("data", (d) => sock.write(d));
      sock.on("error", () => {});
    },
  });
}

function roundTrip(sock: TLSSocket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sock.once("data", (d) => resolve(d.toString()));
    sock.once("error", reject);
    sock.write(text);
  });
}

describe("identity", () => {
  test("a new identity parses, and its fingerprint is the SPKI's", () => {
    const again = parseIdentity(srv.pem);
    expect(again.fp).toBe(srv.fp);
    expect(srv.fp).toMatch(/^[0-9a-f]{64}$/);
    const x = new X509Certificate(srv.cert);
    expect(x.subject).toBe("CN=Harbor");
    expect(x.checkPrivateKey(createPrivateKey(srv.key))).toBe(true);
    expect(x.verify(x.publicKey)).toBe(true);
  });

  test("spki() finds the same bytes the platform exports", () => {
    const x = new X509Certificate(srv.cert);
    const want = new Uint8Array(x.publicKey.export({ type: "spki", format: "der" }));
    expect(new Uint8Array(spki(x.raw) ?? [])).toEqual(want);
  });

  test("every new certificate's serial is a minimal positive DER integer (1 in 128 used to be refused)", () => {
    for (let i = 0; i < 300; i++) {
      const der = new X509Certificate(generateIdentity().cert).raw;
      // tbs > [0] version (5 bytes) > serial: tag 0x02, length 16, first byte 0x40..0x7f
      const at = der.indexOf(0x02, der.indexOf(0xa0) + 5);
      expect([der[at], der[at + 1]]).toEqual([0x02, 16]);
      expect(der[at + 2]! & 0xc0).toBe(0x40);
    }
  });

  test("garbage has no fingerprint (tls.rs: truncated certificates are refused)", () => {
    const x = new X509Certificate(srv.cert);
    expect(certFp(new Uint8Array())).toBeNull();
    expect(certFp(Uint8Array.of(0x30, 0x82))).toBeNull();
    expect(certFp(new Uint8Array(x.raw.subarray(0, 40)))).toBeNull();
  });

  test("short and normalizeFp (tls.rs)", () => {
    const fp = "ab12cd34ef567890".padEnd(64, "0");
    expect(short(fp)).toBe("ab12 cd34 ef56 7890");
    expect(normalizeFp(short(fp))).toBeNull();
    expect(normalizeFp(fp.toUpperCase().match(/.{1,2}/g)?.join(":") ?? "")).toBe(fp);
    expect(normalizeFp("zz")).toBeNull();
  });

  test("signatures verify against the certificate's key", () => {
    const msg = new TextEncoder().encode("sign in");
    const sig = signWith(srv, msg);
    expect(verify("sha256", msg, createPublicKey(srv.cert), sig)).toBe(true);
  });
});

describe("mutual TLS in Bun", () => {
  for (const [name, maxVersion] of [["1.3", "TLSv1.3"], ["1.2", "TLSv1.2"]] as const) {
    test(`TLS ${name}: both sides see the other's fingerprint`, async () => {
      const seen: Seen[] = [];
      const port = await listen(echo(seen));
      const c = await connect({ id: cli, pin: srv.fp, host: "127.0.0.1", port, maxVersion });
      expect(await roundTrip(c, "ping")).toBe("ping");
      expect(c.getProtocol()).toBe(maxVersion);
      expect(peerFp(c)).toBe(srv.fp);
      expect(seen).toEqual([{ peer: cli.fp, version: maxVersion }]);
      c.destroy();
    });
  }

  test("the wrong pin refuses the server", async () => {
    const port = await listen(echo([]));
    await expect(connect({ id: cli, pin: cli.fp, host: "127.0.0.1", port })).rejects.toThrow(WRONG_KEY);
  });

  test("no pin is for pairing: any server, and its key is reported", async () => {
    const port = await listen(echo([]));
    const c = await connect({ id: cli, pin: null, host: "127.0.0.1", port });
    expect(peerFp(c)).toBe(srv.fp);
    c.destroy();
  });

  test("a client without a certificate gets in; its fingerprint is null (AnyClient)", async () => {
    const seen: Seen[] = [];
    const port = await listen(echo(seen));
    const c = raw({ host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1.3" });
    await new Promise((resolve) => c.once("secureConnect", resolve));
    expect(await roundTrip(c, "ping")).toBe("ping");
    expect(seen[0]?.peer).toBeNull();
    c.destroy();
  });

  test("a known-keys server drops a stranger, keeps a known client (KnownClient)", async () => {
    const seen: Seen[] = [];
    const port = await listen(echo(seen, (fp) => fp === cli.fp));
    const stranger = await connect({ id: srv, pin: srv.fp, host: "127.0.0.1", port });
    const closed = new Promise((resolve) => stranger.once("close", resolve));
    stranger.write("x");
    stranger.on("error", () => {});
    await closed;
    expect(seen).toEqual([]);
    const known = await connect({ id: cli, pin: srv.fp, host: "127.0.0.1", port });
    expect(await roundTrip(known, "ok")).toBe("ok");
    known.destroy();
  });

  for (const [name, v] of [["1.3", "TLSv1.3"], ["1.2", "TLSv1.2"]] as const) {
    test(`TLS ${name}: no session is resumed, every connection proves its key`, async () => {
      const port = await listen(echo([]));
      const sessions: Buffer[] = [];
      const open = (session?: Buffer) => raw({ host: "127.0.0.1", port, key: cli.key, cert: cli.cert, rejectUnauthorized: false, minVersion: v, maxVersion: v, ...(session ? { session } : {}) });
      const c = open();
      c.on("session", (s) => sessions.push(s));
      await new Promise((resolve) => c.once("secureConnect", resolve));
      await roundTrip(c, "ping");
      await Bun.sleep(50);
      c.destroy();
      const again = open(sessions.at(-1));
      await new Promise((resolve) => again.once("secureConnect", resolve));
      expect(again.isSessionReused()).toBe(false);
      again.destroy();
    });
  }

  test("one port takes plain and TLS: the first byte decides (tls.rs accept)", async () => {
    const seen: string[] = [];
    const port = await listen(
      tcpServer((tcp) => {
        tcp.once("data", (first: Buffer) => {
          tcp.pause();
          if (first[0] !== 0x16) {
            seen.push("plain");
            tcp.end(first);
            return;
          }
          tcp.unshift(first);
          const sock = new TlsWrap(tcp, { ...serverTls(srv), isServer: true });
          sock.once("secure", () => {
            seen.push(peerFp(sock) ?? "none");
            sock.on("data", (d) => sock.write(d));
          });
          sock.on("error", () => {});
        });
        tcp.on("error", () => {});
      }),
    );
    const c = await connect({ id: cli, pin: srv.fp, host: "127.0.0.1", port });
    expect(await roundTrip(c, "ping")).toBe("ping");
    c.destroy();
    const plain = tcpConnect(port, "127.0.0.1");
    plain.write("GET /");
    const back = await new Promise((resolve) => plain.once("data", (d) => resolve(d.toString())));
    expect(back).toBe("GET /");
    expect(seen).toEqual([cli.fp, "plain"]);
    plain.destroy();
  });

  test("TLS runs over another stream, as a relay does (tls.rs handshake)", async () => {
    const seen: Seen[] = [];
    const inner = echo(seen);
    const innerPort = await listen(inner);
    const relayPort = await listen(
      server({
        id: srv,
        onConnection: (sock) => {
          const up = tcpConnect(innerPort, "127.0.0.1");
          sock.pipe(up).pipe(sock);
          sock.on("error", () => up.destroy());
          up.on("error", () => sock.destroy());
        },
      }),
    );
    const outer = await connect({ id: cli, pin: srv.fp, host: "127.0.0.1", port: relayPort });
    const c = await connect({ id: cli, pin: srv.fp, stream: outer });
    expect(await roundTrip(c, "through")).toBe("through");
    expect(seen).toEqual([{ peer: cli.fp, version: "TLSv1.3" }]);
    c.destroy();
    outer.destroy();
  });
});
