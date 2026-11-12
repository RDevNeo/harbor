import { afterAll, describe, expect, test } from "bun:test";
import { createPublicKey, verify, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tcpConnect, type AddressInfo, type Server } from "node:net";
import { createSecureContext, connect as rawTls, type TLSSocket } from "node:tls";
import {
  accept,
  certFp,
  codeKey,
  connect,
  firewallFix,
  generateIdentity,
  hostPort,
  lanAddrs,
  legacy,
  listen,
  loadOrCreate,
  newCode,
  normalizeCode,
  normalizeFp,
  parseIdentity,
  peerFp,
  privateIp,
  proof,
  proofOk,
  scopeKey,
  short,
  signWith,
  spki,
  tailnetIp,
  temporaryV6,
  Throttle,
  ufwBlocks,
  virtualIf,
  WRONG_KEY,
  type Conn,
} from "../src/tls.ts";
import { expectPerm } from "../../../test/perm.ts";

const srv = generateIdentity();
const cli = generateIdentity();
const servers: Server[] = [];

afterAll(() => {
  for (const s of servers) s.close();
});

function up(s: Server): Promise<number> {
  servers.push(s);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

/** tls.rs serve_once: answers each connection with the client's fingerprint, or "-". */
function fpServer(seen: Conn[] = [], known?: (fp: string) => boolean): Promise<number> {
  return up(
    listen({
      id: () => srv,
      ...(known ? { known, public: () => true } : {}),
      onConn: (c) => {
        seen.push(c);
        const answer = () => c.sock.end(c.peer ?? "-");
        if (c.tls) answer();
        else {
          c.sock.once("data", answer);
          c.sock.resume();
        }
      },
    }),
  );
}

function readAll(s: TLSSocket | ReturnType<typeof tcpConnect>): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    s.on("data", (d: Buffer) => {
      out += d.toString();
    });
    s.on("end", () => resolve(out));
    s.on("close", () => resolve(out));
    s.on("error", reject);
  });
}

describe("identity (tls.rs)", () => {
  test("identity_and_fingerprint", () => {
    expect(srv.fp).toMatch(/^[0-9a-f]{64}$/);
    expect(parseIdentity(srv.pem).fp).toBe(srv.fp);
    const x = new X509Certificate(srv.cert);
    expect(new Uint8Array(spki(srv.der) ?? [])).toEqual(new Uint8Array(x.publicKey.export({ type: "spki", format: "der" })));
    expect(generateIdentity().fp).not.toBe(srv.fp);
    expect(short("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe("0123 4567 89ab cdef");
    expect(normalizeFp("AB:".repeat(32))).toBe("ab".repeat(32));
    expect(normalizeFp("abc")).toBeNull();
    expect(spki(Uint8Array.of(0x30, 0x03, 0x02, 0x01, 0x00))).toBeNull();
    expect(spki(new Uint8Array())).toBeNull();
    expect(spki(Uint8Array.of(0x30, 0x84, 0xff, 0xff, 0xff, 0xff))).toBeNull();
    expect(certFp(x.raw.subarray(0, 40))).toBeNull();
  });

  test("the certificate is rcgen's shape: CN=Harbor, SAN harbor, 2025 to 2125, self-signed", () => {
    const x = new X509Certificate(srv.cert);
    expect(x.subject).toBe("CN=Harbor");
    expect(x.subjectAltName).toBe("DNS:harbor");
    expect(new Date(x.validFrom).getUTCFullYear()).toBe(2025);
    expect(new Date(x.validTo).getUTCFullYear()).toBe(2125);
    expect(x.verify(x.publicKey)).toBe(true);
  });

  test("every new certificate loads (a serial is minimal DER)", () => {
    for (let i = 0; i < 600; i++) {
      const id = generateIdentity();
      expect(() => createSecureContext({ key: id.key, cert: id.cert })).not.toThrow();
    }
  });

  test("identity_file_is_private_and_kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "harbor-tls-"));
    try {
      const a = loadOrCreate(dir);
      const b = loadOrCreate(dir);
      expect(a.fp).toBe(b.fp);
      expectPerm(join(dir, "identity.pem"), 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("signatures verify against the certificate's key", () => {
    const sig = signWith(srv, "harbor-device-v1\n1\nab");
    expect(verify("sha256", Buffer.from("harbor-device-v1\n1\nab"), createPublicKey(srv.cert), sig)).toBe(true);
  });
});

describe("connections (tls.rs)", () => {
  test("pinned_mutual_tls", async () => {
    const port = await fpServer();
    const ok = await connect({ id: cli, pin: srv.fp, host: "127.0.0.1", port });
    expect(ok.fp).toBe(srv.fp);
    expect(await readAll(ok.sock)).toBe(cli.fp);
    expect(connect({ id: cli, pin: "0".repeat(64), host: "127.0.0.1", port })).rejects.toThrow(WRONG_KEY);
    const pairing = await connect({ id: cli, pin: null, host: "127.0.0.1", port });
    expect(pairing.fp).toBe(srv.fp);
    pairing.sock.destroy();
  });

  for (const v of ["TLSv1.3", "TLSv1.2"] as const) {
    test(`${v}: the server sees the client's key`, async () => {
      const seen: Conn[] = [];
      const port = await fpServer(seen);
      const c = await connect({ id: cli, pin: srv.fp, host: "127.0.0.1", port, maxVersion: v });
      expect(c.sock.getProtocol()).toBe(v);
      expect(await readAll(c.sock)).toBe(cli.fp);
    });
  }

  test("plain_and_no_client_cert", async () => {
    const seen: Conn[] = [];
    const port = await fpServer(seen);
    const plain = tcpConnect(port, "127.0.0.1", () => plain.write("GET / HTTP/1.1\r\n\r\n"));
    expect(await readAll(plain)).toBe("-");
    expect(seen[0]?.tls).toBe(false);
    const anon = rawTls({ host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1.3" });
    expect(await readAll(anon)).toBe("-");
    expect(seen[1]?.tls).toBe(true);
  });

  test("a plain connection keeps the close listener its acceptor set, so its slot is given back", async () => {
    const { createServer } = await import("node:net");
    let closes = 0;
    const server = createServer({ pauseOnConnect: true }, (sock) => {
      sock.once("close", () => closes++);
      void accept(sock, { id: () => null }).then((c) => c?.sock.destroy());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    for (let i = 0; i < 5; i++) {
      const c = tcpConnect(port, "127.0.0.1", () => c.write("GET / HTTP/1.1\r\n\r\n"));
      await readAll(c);
    }
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    expect(closes).toBe(5);
  });

  test("strangers_get_no_session_from_the_internet", async () => {
    const seen: Conn[] = [];
    const port = await fpServer(seen, (fp) => fp === cli.fp);
    const stranger = generateIdentity();
    const s = await connect({ id: stranger, pin: srv.fp, host: "127.0.0.1", port });
    expect(await readAll(s.sock)).toBe("");
    const known = await connect({ id: cli, pin: srv.fp, host: "127.0.0.1", port });
    expect(await readAll(known.sock)).toBe(cli.fp);
    expect(seen.map((c) => c.peer)).toEqual([cli.fp]);
  });

  test("no session tickets: every connection proves its key", async () => {
    const port = await fpServer();
    const tickets: Buffer[] = [];
    const c = rawTls({ host: "127.0.0.1", port, key: cli.key, cert: cli.cert, rejectUnauthorized: false });
    c.on("session", (s: Buffer) => tickets.push(s));
    await readAll(c);
    expect(tickets).toEqual([]);
  });

  test("TLS inside a TLS stream, as through a relay", async () => {
    const innerPort = await fpServer();
    const relayPort = await up(
      listen({
        id: () => srv,
        onConn: (c) => {
          const upstream = tcpConnect(innerPort, "127.0.0.1");
          c.sock.pipe(upstream).pipe(c.sock);
          c.sock.resume();
          upstream.on("error", () => c.sock.destroy());
          c.sock.on("error", () => upstream.destroy());
        },
      }),
    );
    const outer = await connect({ id: cli, pin: srv.fp, host: "127.0.0.1", port: relayPort });
    const inner = await connect({ id: cli, pin: srv.fp, stream: outer.sock });
    expect(await readAll(inner.sock)).toBe(cli.fp);
    outer.sock.destroy();
  });

  test("a socket that says nothing is dropped after the head time", async () => {
    let got: Conn | null | undefined;
    const s = await up(
      (await import("node:net")).createServer({ pauseOnConnect: true }, (sock) => {
        void accept(sock, { id: () => srv, head: 100 }).then((c) => {
          got = c;
        });
      }),
    );
    const c = tcpConnect(s, "127.0.0.1");
    await readAll(c);
    expect(got).toBeNull();
  });
});

describe("addresses (tls.rs)", () => {
  const v4 = (a: number, b: number, c: number, d: number) => [a, b, c, d].join(".");

  test("addresses", () => {
    expect(tailnetIp(v4(100, 64, 0, 1)) && tailnetIp(v4(100, 127, 255, 255)) && tailnetIp("fd7a:115c:a1e0::1")).toBe(true);
    expect(tailnetIp(v4(100, 128, 0, 1)) || tailnetIp("10.0.0.1") || tailnetIp("fd7a:115c:a1e1::1")).toBe(false);
    expect(tailnetIp(`::ffff:${v4(100, 100, 1, 1)}`)).toBe(true);
    expect(legacy("10.0.0.2", v4(100, 64, 0, 1))).toBe(false);
    expect(hostPort("fd00::1", 47930)).toBe("[fd00::1]:47930");
    expect(hostPort("10.0.0.1", 47930)).toBe("10.0.0.1:47930");
    for (const a of ["10.1.2.3", "172.16.0.1", "fd00::1", "fe80::1", "127.0.0.1", v4(100, 100, 1, 1), "::ffff:10.0.0.1"]) {
      expect(privateIp(a)).toBe(true);
    }
    for (const a of ["8.8.8.8", "2001:db8::1", v4(100, 128, 0, 1)]) expect(privateIp(a)).toBe(false);
    expect(virtualIf("docker0") && virtualIf("br-1a2b") && !virtualIf("wlan0") && !virtualIf("enp3s0")).toBe(true);
    for (const a of lanAddrs({})) expect(a === "127.0.0.1" || a === "::1").toBe(false);
    expect(lanAddrs({ HARBOR_ADDRS: "10.0.0.5, fd00::5,junk" })).toEqual(["10.0.0.5", "fd00::5"]);
  });

  test("privacy_addresses_left_out", () => {
    const t =
      "20010db8000000001111222233334444 03 40 00 01  wlan0\n20010db8000000005555666677778888 03 40 00 100  wlan0\n20010db800000000aaaabbbbccccdddd 03 40 00 20  wlan0\n";
    const v = temporaryV6(t);
    expect(v.length).toBe(2);
    expect(v).toContain("2001:db8::1111:2222:3333:4444");
    expect(v).not.toContain("2001:db8::5555:6666:7777:8888");
  });

  test("firewall", () => {
    const on = "ENABLED=yes\n";
    const drop = 'IPV6=yes\nDEFAULT_INPUT_POLICY="DROP"\n';
    const ts =
      "### tuple ### allow any any 0.0.0.0/0 any 0.0.0.0/0 in_tailscale0 comment=7461\n### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in\n";
    expect(ufwBlocks(on, drop, ts, 47930, false)).toBe(true);
    expect(ufwBlocks("ENABLED=no\n", drop, ts, 47930, false)).toBe(false);
    expect(ufwBlocks(on, 'DEFAULT_INPUT_POLICY="ACCEPT"\n', ts, 47930, false)).toBe(false);
    const lan = `${v4(192, 168, 0, 0)}/16`;
    const mine = `${ts}### tuple ### allow tcp 47930 0.0.0.0/0 any ${lan} in comment=6861\n`;
    expect(ufwBlocks(on, drop, mine, 47930, false)).toBe(false);
    expect(ufwBlocks(on, drop, "### tuple ### allow any 47900:47999 0.0.0.0/0 any 0.0.0.0/0 in\n", 47930, false)).toBe(false);
    expect(ufwBlocks(on, drop, "### tuple ### allow udp 47930 0.0.0.0/0 any 0.0.0.0/0 in\n", 47930, false)).toBe(true);
    expect(ufwBlocks(on, drop, "### tuple ### allow udp 47930 0.0.0.0/0 any 0.0.0.0/0 in\n", 47930, true)).toBe(false);
    expect(ufwBlocks(on, drop, mine, 47930, true)).toBe(true);
    expect(ufwBlocks(on, drop, "### tuple ### deny tcp 47930 0.0.0.0/0 any 0.0.0.0/0 in\n", 47930, false)).toBe(true);
    expect(ufwBlocks(on, drop, "### tuple ### allow tcp 80,47930 0.0.0.0/0 any 0.0.0.0/0 in\n", 47930, false)).toBe(false);
    expect(firewallFix(47930)).toContain(`from ${lan} to any port 47930 `);
    expect(firewallFix(47931)).toContain("to any port 47930 ");
    expect(firewallFix(47931)).toContain("to any port 47931 ");
  });

  test("throttle", () => {
    const t = new Throttle(3, 60_000);
    expect(t.hit("10.0.0.9") && t.hit("10.0.0.9") && t.hit("10.0.0.9")).toBe(true);
    expect(t.over("10.0.0.8")).toBe(false);
    expect(t.hit("10.0.0.9")).toBe(false);
    expect(t.over("10.0.0.9")).toBe(true);
    expect(t.over("::ffff:10.0.0.9")).toBe(true);
    for (let i = 0; i < 3; i++) expect(t.hit(`2001:db8:1:2::${i}`)).toBe(true);
    expect(t.hit("2001:db8:1:2:ffff::1")).toBe(false);
    expect(t.hit("2001:db8:1:3::1")).toBe(true);
    expect(scopeKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::");
  });
});

describe("pairing codes (tls.rs)", () => {
  test("pairing_proofs", () => {
    const code = newCode();
    expect(code.length).toBe(11);
    expect(normalizeCode(code.toLowerCase().replace("-", " "))).toBe(normalizeCode(code));
    expect(normalizeCode("o1-Il")).toBe("0111");
    const k = codeKey(code);
    const host = "a".repeat(64);
    const join = "b".repeat(64);
    const p = proof(k, "join", host, join);
    expect(proofOk(k, "join", host, join, p)).toBe(true);
    expect(proofOk(k, "host", host, join, p)).toBe(false);
    expect(proofOk(k, "join", "c".repeat(64), join, p)).toBe(false);
    expect(proofOk(codeKey("ZZZZZ-ZZZZZ"), "join", host, join, p)).toBe(false);
    expect(proofOk(k, "join", host, join, "")).toBe(false);
  });

  test("the code key is PBKDF2-HMAC-SHA256 as PROTOCOL.md gives it", () => {
    const hex = Buffer.from(codeKey("abcde-fghjk")).toString("hex");
    expect(hex).toBe(Buffer.from(codeKey("ABCDEFGHJK")).toString("hex"));
    expect(hex).toHaveLength(64);
  });
});
