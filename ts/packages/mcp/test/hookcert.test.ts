import "./sandbox.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, verify, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, createSecureContext } from "node:tls";
import { generateIdentity, MemKv } from "@harbor/net";
import type { Hook } from "../src/control.ts";
import { Account, b64u, type Challenge, challengeCert, clientHello, Hooks, obtain, type Options, sslipName } from "../src/hookcert.ts";
import type { Json } from "../src/json.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-hookcert-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const newAccount = (): Account => new Account(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString());

test("base64url", () => {
  expect(b64u(new Uint8Array())).toBe("");
  expect(b64u(Buffer.from("f"))).toBe("Zg");
  expect(b64u(Buffer.from("fo"))).toBe("Zm8");
  expect(b64u(Buffer.from("foo"))).toBe("Zm9v");
  expect(b64u(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
});

test("names", () => {
  expect(sslipName("203.0.113.7")).toBe("203-0-113-7.sslip.io");
  expect(sslipName("2001:db8::7")).toBe("2001-db8--7.sslip.io");
});

test("jws_and_thumbprint: jws and thumbprint", () => {
  const a = newAccount();
  const jwk = JSON.parse(a.jwk()) as Record<string, string>;
  expect([jwk.kty, jwk.crv]).toEqual(["EC", "P-256"]);
  expect(a.thumbprint()).toHaveLength(43);
  expect(a.jwk()).toBe(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`);
  const j = JSON.parse(a.jws("https://acme.example/new-acct", "n0nce", { a: 1 })) as Record<string, string>;
  // The signature checks out against the JWK's key.
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "" }, format: "jwk" });
  expect(verify("sha256", Buffer.from(`${j.protected}.${j.payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(j.signature ?? "", "base64url"))).toBe(true);
  const prot = JSON.parse(Buffer.from(j.protected ?? "", "base64url").toString()) as Record<string, unknown>;
  expect(prot.alg).toBe("ES256");
  expect(prot.nonce).toBe("n0nce");
  expect(prot.url).toBe("https://acme.example/new-acct");
  expect(typeof prot.jwk === "object" && prot.kid === undefined).toBe(true);
  expect(JSON.parse(Buffer.from(j.payload ?? "", "base64url").toString())).toEqual({ a: 1 });
  // POST-as-GET: an empty payload.
  expect((JSON.parse(a.jws("https://acme.example/x", "n")) as Record<string, string>).payload).toBe("");
  // Registered: the account's URL instead of the key.
  a.kid = "https://acme.example/acct/1";
  const k = JSON.parse(Buffer.from((JSON.parse(a.jws("u", "n")) as Record<string, string>).protected ?? "", "base64url").toString()) as Record<string, unknown>;
  expect([k.kid, k.jwk]).toEqual(["https://acme.example/acct/1", undefined]);
});

test("the account key is made once, owner-only, and read back", () => {
  const a = Account.loadOrCreate(dir);
  expect(statSync(join(dir, "acme-account.pem")).mode & 0o777).toBe(0o600);
  expect(Account.loadOrCreate(dir).jwk()).toBe(a.jwk());
});

test("every challenge certificate loads (a serial is minimal DER)", () => {
  for (let i = 0; i < 600; i++) {
    const c = challengeCert("hooks.example.org", `token.${i}`);
    expect(() => createSecureContext({ key: c.key, cert: c.cert })).not.toThrow();
  }
});

test("the challenge certificate names the host and carries the digest", () => {
  const c = challengeCert("hooks.example.org", "token.thumb");
  const x = new X509Certificate(c.cert);
  expect(x.subjectAltName).toBe("DNS:hooks.example.org");
  expect(x.verify(x.publicKey)).toBe(true);
  const digest = createHash("sha256").update("token.thumb").digest();
  // The acmeIdentifier extension (OID 1.3.6.1.5.5.7.1.31) is critical and holds the digest as an OCTET STRING.
  const ext = Buffer.concat([Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x1f, 0x01, 0x01, 0xff, 0x04, 0x22, 0x04, 0x20]), digest]);
  expect(c.der.includes(ext)).toBe(true);
  expect(new Date(x.validTo).getTime()).toBeGreaterThan(Date.now());
  expect(new Date(x.validFrom).getTime()).toBeLessThan(Date.now());
});

describe("a ClientHello", () => {
  test("is read for its name and protocols", async () => {
    let resolve: (b: Buffer) => void = () => {};
    const got = new Promise<Buffer>((r) => {
      resolve = r;
    });
    const s = Bun.listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { data: (_sock, d) => resolve(Buffer.from(d)), open() {}, close() {}, error() {} } });
    const c = tlsConnect({ host: "127.0.0.1", port: s.port, servername: "Hooks.Example.org", ALPNProtocols: ["acme-tls/1", "h2"], rejectUnauthorized: false });
    c.on("error", () => {});
    const hello = clientHello(await got);
    c.destroy();
    s.stop(true);
    expect(hello).toEqual({ sni: "hooks.example.org", alpn: ["acme-tls/1", "h2"] });
  });

  test("that is cut short or is not one gives nothing", () => {
    expect(clientHello(Buffer.from("GET / HTTP/1.1\r\n\r\n"))).toEqual({ sni: "", alpn: [] });
    expect(clientHello(Buffer.alloc(0))).toEqual({ sni: "", alpn: [] });
    expect(clientHello(Buffer.from([0x16, 3, 1, 0, 4, 1, 0, 0, 0]))).toEqual({ sni: "", alpn: [] });
  });
});


function listener(over: Partial<Options> = {}): { hooks: Hooks; sent: Hook[]; tokens: Set<string>; kv: MemKv } {
  const sent: Hook[] = [];
  const tokens = new Set(["tok123"]);
  const kv = new MemKv({ hooks_public: "1" });
  const hooks = new Hooks({
    kv,
    tokens,
    send: (h) => sent.push(h),
    wake: () => {},
    identity: () => generateIdentity(),
    mapTo: () => Promise.reject(new Error("no router")),
    dir,
    hosts: ["127.0.0.1"],
    port: 0,
    ...over,
  });
  return { hooks, sent, tokens, kv };
}

async function up(l: ReturnType<typeof listener>): Promise<number> {
  l.hooks.start();
  await l.hooks.settled();
  return l.hooks.boundPort() as number;
}

/** The certificate the listener shows a client offering these protocols for this name; null when the handshake fails. */
function shown(port: number, name: string, alpn: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const c = tlsConnect({ host: "127.0.0.1", port, servername: name, ALPNProtocols: alpn, rejectUnauthorized: false, maxVersion: "TLSv1.3" });
    c.once("secureConnect", () => {
      const raw = c.getPeerCertificate(true).raw;
      resolve(Buffer.from(raw));
      c.destroy();
    });
    c.once("error", () => resolve(null));
    c.once("close", () => resolve(null));
  });
}

test("tls_alpn_challenge: the TLS-ALPN-01 handshake shows the challenge certificate for its name only", async () => {
  const l = listener();
  const port = await up(l);
  try {
    const cert = challengeCert("hooks.example.org", "token.thumb");
    l.hooks.setChallenge({ name: "hooks.example.org", cert: cert.cert, key: cert.key });
    const got = await shown(port, "hooks.example.org", ["acme-tls/1"]);
    expect(got?.equals(cert.der)).toBe(true);
    expect(await shown(port, "other.example.org", ["acme-tls/1"])).toBeNull();
    // An ordinary client for that name still sees Harbor's own key, not the challenge.
    const plain = await shown(port, "hooks.example.org", ["http/1.1"]);
    expect(plain).not.toBeNull();
    expect(plain?.equals(cert.der)).toBe(false);
    l.hooks.setChallenge(null);
    expect(await shown(port, "hooks.example.org", ["acme-tls/1"])).toBeNull();
  } finally {
    l.hooks.stop();
  }
});

describe("webhooks over HTTPS", () => {
  const post = (port: number, path: string, body = "{}", headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`https://127.0.0.1:${port}${path}`, { method: "POST", body, headers, tls: { rejectUnauthorized: false } });

  test("a live webhook is accepted and nothing else is answered", async () => {
    const l = listener();
    const port = await up(l);
    try {
      const ok = await post(port, "/hooks/tok123", '{"a":1}', { "x-github-event": "push", authorization: "secret" });
      expect(ok.status).toBe(202);
      expect(await ok.text()).toBe('{"ok":true}');
      expect(l.sent).toHaveLength(1);
      expect(l.sent[0]).toMatchObject({ token: "tok123", method: "POST", body: '{"a":1}' });
      expect(l.sent[0]?.headers).toContainEqual(["x-github-event", "push"]);
      expect(l.sent[0]?.headers.some(([k]) => k === "authorization")).toBe(false);
      expect((await post(port, "/hooks/nope")).status).toBe(404);
      expect((await post(port, "/other")).status).toBe(404);
      expect((await fetch(`https://127.0.0.1:${port}/hooks/tok123`, { tls: { rejectUnauthorized: false } })).status).toBe(202);
      expect(l.sent).toHaveLength(2);
      expect(l.sent[1]?.method).toBe("GET");
    } finally {
      l.hooks.stop();
    }
  });

  test("a GitHub signature is checked and a body can come chunked", async () => {
    const l = listener();
    const port = await up(l);
    try {
      expect((await post(port, "/hooks/tok123", "{}", { "x-hub-signature-256": "sha256=00" })).status).toBe(401);
      const body = '{"z":2}';
      const sig = new Bun.CryptoHasher("sha256", "tok123").update(body).digest("hex");
      expect((await post(port, "/hooks/tok123", body, { "x-hub-signature-256": `sha256=${sig}` })).status).toBe(202);
      const chunked = new Response(new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode("chunk")); c.enqueue(new TextEncoder().encode("ed")); c.close(); } }));
      const r = await fetch(`https://127.0.0.1:${port}/hooks/tok123`, { method: "POST", body: chunked.body, tls: { rejectUnauthorized: false } });
      expect(r.status).toBe(202);
      expect(l.sent.at(-1)?.body).toBe("chunked");
    } finally {
      l.hooks.stop();
    }
  });

  test("a plain HTTP request gets a 400, and a certificate in place is the one shown", async () => {
    const l = listener();
    const port = await up(l);
    try {
      const out = await new Promise<string>((resolve) => {
        const s = tcpConnect(port, "127.0.0.1");
        let got = "";
        s.on("data", (d) => (got += d));
        s.on("close", () => resolve(got));
        s.write("GET /hooks/tok123 HTTP/1.1\r\nHost: x\r\n\r\n");
      });
      expect(out).toStartWith("HTTP/1.1 400 Bad Request");
      expect(l.sent).toHaveLength(0);
      const made = challengeCert("hooks.example.org", "x");
      rmSync(join(dir, "none"), { force: true });
      await Bun.write(join(dir, "hooks-cert.pem"), made.cert);
      await Bun.write(join(dir, "hooks-key.pem"), made.key);
      await Bun.write(join(dir, "hooks-cert.json"), JSON.stringify({ name: "hooks.example.org", expires: 1 }));
      expect(l.hooks.loadSaved()).toEqual({ name: "hooks.example.org", expires: 1 });
      expect((await shown(port, "hooks.example.org", ["http/1.1"]))?.equals(made.der)).toBe(true);
    } finally {
      l.hooks.stop();
    }
  });

  test("an address that keeps missing is cut off after 20 misses a minute", async () => {
    const l = listener();
    const port = await up(l);
    try {
      for (let i = 0; i < 20; i++) expect((await post(port, `/hooks/miss${i}`)).status).toBe(404);
      const refused = await post(port, "/hooks/tok123").then(
        (r) => r.status,
        () => "closed",
      );
      expect(refused).toBe("closed");
      expect(l.sent).toHaveLength(0);
    } finally {
      l.hooks.stop();
    }
  });

  test("off, the port is closed without a word", async () => {
    const l = listener();
    const port = await up(l);
    try {
      l.kv.set("hooks_public", "0");
      l.hooks.kick();
      await l.hooks.settled();
      await Bun.sleep(20);
      const r = await post(port, "/hooks/tok123").then(
        (x) => x.status,
        () => "closed",
      );
      expect(r).toBe("closed");
      expect(l.hooks.status()).toEqual({ name: "", base: null, route: "", error: "", expires: 0, busy: false });
    } finally {
      l.hooks.stop();
    }
  });
});


/** A small ACME server (RFC 8555): it checks every request's signature and that the challenge was answered before it calls the authorization valid. */
function fakeAcme(validate: (name: string, digest: Buffer) => Promise<boolean>, opts: { fail?: boolean } = {}) {
  const log: string[] = [];
  const keys = new Map<string, Json>();
  let nonce = 0;
  let valid = false;
  let name = "";
  let finalized = false;
  let csr = Buffer.alloc(0);
  const cert = challengeCert("issued.example.org", "x");
  const origin = { port: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const base = `http://127.0.0.1:${origin.port}`;
      const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ "Replay-Nonce": `n${++nonce}`, ...extra });
      const json = (v: unknown, status = 200, extra: Record<string, string> = {}): Response => new Response(JSON.stringify(v), { status, headers: headers({ "Content-Type": "application/json", ...extra }) });
      log.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/dir") return json({ newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order` });
      if (u.pathname === "/nonce") return new Response(null, { status: 200, headers: headers() });
      const body = JSON.parse(await req.text()) as { protected: string; payload: string; signature: string };
      const prot = JSON.parse(Buffer.from(body.protected, "base64url").toString()) as { nonce: string; url: string; jwk?: Json; kid?: string };
      if (prot.url !== `${base}${u.pathname}`) return json({ type: "urn:ietf:params:acme:error:malformed", detail: "wrong url" }, 400);
      if (!/^n\d+$/.test(prot.nonce)) return json({ type: "urn:ietf:params:acme:error:badNonce", detail: "bad nonce" }, 400);
      const jwk = prot.jwk ?? keys.get(prot.kid ?? "");
      if (!jwk) return json({ type: "x", detail: "unknown account" }, 400);
      const key = createPublicKey({ key: jwk as never, format: "jwk" });
      if (!verify("sha256", Buffer.from(`${body.protected}.${body.payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(body.signature, "base64url"))) return json({ type: "x", detail: "bad signature" }, 400);
      const payload = body.payload === "" ? null : (JSON.parse(Buffer.from(body.payload, "base64url").toString()) as Record<string, unknown>);
      const challenge = { type: "tls-alpn-01", token: "tok-abc", url: `${base}/chal` };
      switch (u.pathname) {
        case "/acct":
          keys.set(`${base}/acct/1`, jwk);
          return json({ status: "valid" }, 201, { Location: `${base}/acct/1` });
        case "/order":
          if (opts.fail) return json({ type: "urn:ietf:params:acme:error:rejectedIdentifier", detail: "that name is not allowed" }, 400);
          name = String(((payload?.identifiers as { value: string }[] | undefined) ?? [])[0]?.value);
          return json({ status: "pending", authorizations: [`${base}/authz`], finalize: `${base}/fin`, identifiers: payload?.identifiers }, 201, { Location: `${base}/order/1` });
        case "/authz":
          return json({ status: valid ? "valid" : "pending", challenges: [{ type: "http-01", token: "x", url: `${base}/nope` }, challenge] });
        case "/chal":
          valid = await validate(name, createHash("sha256").update(`tok-abc.${b64u(createHash("sha256").update(`{"crv":"P-256","kty":"EC","x":"${(jwk as { x: string }).x}","y":"${(jwk as { y: string }).y}"}`).digest())}`).digest());
          return json({ ...challenge, status: "processing" });
        case "/fin":
          finalized = true;
          csr = Buffer.from(String((payload as { csr: string }).csr), "base64url");
          return json({ status: "valid", certificate: `${base}/cert/1`, finalize: `${base}/fin` });
        case "/order/1":
          return json({ status: finalized ? "valid" : "pending", certificate: `${base}/cert/1`, finalize: `${base}/fin` });
        case "/cert/1":
          return new Response(cert.cert + cert.cert, { headers: headers({ "Content-Type": "application/pem-certificate-chain" }) });
        default:
          return json({}, 404);
      }
    },
  });
  origin.port = server.port ?? 0;
  return { server, log, directory: `http://127.0.0.1:${server.port}/dir`, csr: () => csr, cert };
}

describe("ACME", () => {
  test("a certificate is ordered, validated by the challenge and downloaded", async () => {
    const seen: { challenge: Challenge | null } = { challenge: null };
    const acme = fakeAcme(async (name, digest) => seen.challenge?.name === name && new X509Certificate(seen.challenge.cert).raw.includes(digest));
    const shownDuring: (Challenge | null)[] = [];
    try {
      const got = await obtain(acme.directory, "hooks.example.org", {
        challenge: (c) => {
          seen.challenge = c;
          shownDuring.push(c);
        },
        account: newAccount(),
        pollMs: 5,
      });
      expect(got.chain).toBe(acme.cert.cert + acme.cert.cert);
      expect(got.key).toContain("BEGIN PRIVATE KEY");
      // The challenge was shown while the server validated, and taken away after.
      expect(shownDuring[0]?.name).toBe("hooks.example.org");
      expect(new X509Certificate(shownDuring[0]?.cert ?? "").subjectAltName).toBe("DNS:hooks.example.org");
      expect(shownDuring.at(-1)).toBeNull();
      expect(acme.log.filter((l) => l.startsWith("POST /acct"))).toHaveLength(1);
      expect(acme.log).toContain("POST /fin");
      // The request the server got is signed by the certificate's own key, for the name.
      const req = Bun.spawnSync(["openssl", "req", "-inform", "DER", "-noout", "-verify", "-text"], { stdin: acme.csr(), stdout: "pipe", stderr: "pipe" });
      expect(req.stderr.toString() + req.stdout.toString()).toContain("verify OK");
      expect(req.stdout.toString()).toContain("DNS:hooks.example.org");
    } finally {
      await acme.server.stop(true);
    }
  });

  test("an order the server rejects says why", async () => {
    const acme = fakeAcme(async () => true, { fail: true });
    try {
      const outcome = await obtain(acme.directory, "bad.example.org", { challenge: () => {}, account: newAccount(), pollMs: 5 }).then(
        () => "obtained",
        (e: Error) => e.message,
      );
      expect(outcome).toBe("that name is not allowed");
    } finally {
      await acme.server.stop(true);
    }
  });

  test("a directory that is not there is an error", async () => {
    const outcome = await obtain("http://127.0.0.1:1/dir", "x.example.org", { challenge: () => {}, account: newAccount() }).then(
      () => "obtained",
      (e: Error) => e.message,
    );
    expect(outcome).toContain("http://127.0.0.1:1/dir");
  });

  test("a round maps the port, names the host and gets a certificate the listener then serves", async () => {
    const live: { l: ReturnType<typeof listener> | null } = { l: null };
    const acme = fakeAcme(async (name, digest) => {
      const der = await shown(live.l?.hooks.boundPort() ?? 0, name, ["acme-tls/1"]);
      return der !== null && der.includes(digest) && new X509Certificate(der).subjectAltName === `DNS:${name}`;
    });
    const l = listener({ directory: acme.directory, pollMs: 5, mapTo: () => Promise.resolve(["UPnP", { ip: "203.0.113.7", port: 443 }]), isPublic: () => true, now: () => 1_000_000 });
    live.l = l;
    try {
      const port = await up(l);
      expect(l.hooks.status()).toMatchObject({ name: "203-0-113-7.sslip.io", route: "UPnP: 203.0.113.7:443 → this PC", error: "", busy: false, base: "https://203-0-113-7.sslip.io/hooks" });
      expect(acme.log.filter((x) => x === "POST /order")).toHaveLength(1);
      expect(readFileSync(join(dir, "hooks-cert.pem"), "utf8")).toBe(acme.cert.cert + acme.cert.cert);
      expect(port).toBeGreaterThan(0);
    } finally {
      l.hooks.stop();
      await acme.server.stop(true);
    }
  });
});

describe("rounds", () => {
  const withAcme = async (
    run: (a: ReturnType<typeof fakeAcme>, make: (over?: Partial<Options>) => ReturnType<typeof listener>) => Promise<void>,
    opts: { fail?: boolean } = {},
  ): Promise<void> => {
    const live: { l: ReturnType<typeof listener> | null } = { l: null };
    const acme = fakeAcme(async (name, digest) => {
      const der = await shown(live.l?.hooks.boundPort() ?? 0, name, ["acme-tls/1"]);
      return der !== null && der.includes(digest);
    }, opts);
    const make = (over: Partial<Options> = {}): ReturnType<typeof listener> => {
      live.l = listener({ directory: acme.directory, pollMs: 5, now: () => 1_000_000, ...over });
      return live.l;
    };
    try {
      await run(acme, make);
    } finally {
      await acme.server.stop(true);
    }
  };

  test("a typed name gets a certificate, saved owner-only with its expiry", async () => {
    await withAcme(async (acme, make) => {
      const l = make();
      l.kv.set("hooks_name", "  Hooks.Example.Org ");
      await up(l);
      const st = l.hooks.status();
      expect(st.error).toBe("");
      expect(st).toMatchObject({ name: "hooks.example.org", base: "https://hooks.example.org/hooks", expires: 1_000_000 + 90 * 86400, route: expect.stringContaining("Your router didn't open port 443 (no router)") });
      for (const f of ["hooks-cert.pem", "hooks-key.pem", "hooks-cert.json", "acme-account.pem"]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(dir, "hooks-cert.json"), "utf8"))).toEqual({ name: "hooks.example.org", expires: 1_000_000 + 90 * 86400 });
      // Fresh: the next look orders nothing.
      const orders = acme.log.filter((x) => x === "POST /order").length;
      await l.hooks.round();
      expect(acme.log.filter((x) => x === "POST /order")).toHaveLength(orders);
      l.hooks.stop();
    });
  });

  test("a failed order is not retried for hours unless the user presses Check", async () => {
    await withAcme(
      async (acme, make) => {
        const l = make();
        l.kv.set("hooks_name", "hooks.example.org");
        await up(l);
        expect(l.hooks.status().error).toBe("that name is not allowed");
        expect(l.hooks.status().base).toBeNull();
        const orders = () => acme.log.filter((x) => x === "POST /order").length;
        expect(orders()).toBe(1);
        await l.hooks.round();
        expect(l.hooks.status().error).toBe("that name is not allowed (tried again later, or press Check)");
        expect(orders()).toBe(1);
        l.hooks.kick();
        await l.hooks.settled();
        expect(orders()).toBe(2);
        l.hooks.stop();
      },
      { fail: true },
    );
  });

  test("with no name and no route there is nothing to name", async () => {
    const l = listener({ directory: "http://127.0.0.1:1/dir" });
    await up(l);
    expect(l.hooks.status().error).toBe("no public address to name: the router doesn't map port 443, and no name is set");
    expect(existsSync(join(dir, "hooks-cert.pem"))).toBe(false);
    l.hooks.stop();
  });

  test("a route that maps another port is explained", async () => {
    const l = listener({ directory: "http://127.0.0.1:1/dir", mapTo: () => Promise.resolve(["NAT-PMP", { ip: "203.0.113.7", port: 50443 }]) });
    await up(l);
    expect(l.hooks.status().route).toBe("NAT-PMP mapped 203.0.113.7:50443, but Let's Encrypt needs port 443 on a public address");
    l.hooks.stop();
  });
});
