// Discord logins without a browser: Person Hub's saved token read from LevelDB, the token store, QR sign-in.
import { afterEach, describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync, publicEncrypt, constants, createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordToken, localStorageKey, readLog, unsnappy } from "../src/import/leveldb.ts";
import { tokenStore } from "../src/tokens.ts";
import { decryptWith, parseUserPayload, remoteAuth } from "../src/conn/remoteauth.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "persons-login-"));
  dirs.push(d);
  return d;
};
const FAKE = "MTAwMDAwMDAwMDAwMDAwMDAw.GAbCdE.fake_fake_fake_fake_fake_fake_fake_xx";

/** A LevelDB write-ahead log with one batch (what Chromium writes before compacting). */
function logFile(entries: [Uint8Array, Uint8Array | null][], seq: number): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(seq), 0);
  head.writeUInt32LE(entries.length, 8);
  parts.push(head);
  const v = (n: number): Buffer => {
    const b: number[] = [];
    while (n >= 0x80) {
      b.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    b.push(n);
    return Buffer.from(b);
  };
  for (const [k, val] of entries) {
    parts.push(Buffer.from([val ? 1 : 0]), v(k.length), Buffer.from(k));
    if (val) parts.push(v(val.length), Buffer.from(val));
  }
  const batch = Buffer.concat(parts);
  const rec = Buffer.alloc(7);
  rec.writeUInt16LE(batch.length, 4);
  rec[6] = 1;
  return Buffer.concat([rec, batch]);
}

describe("Person Hub's saved Discord login", () => {
  it("snappy: literals and copies", () => {
    // "abcabcabc": literal "abc", then copy offset 3 length 6
    const src = Uint8Array.from([9, (3 - 1) << 2, 97, 98, 99, 1 | ((6 - 4) << 2), 3]);
    expect(Buffer.from(unsnappy(src)).toString()).toBe("abcabcabc");
  });

  it("reads the newest token from Local Storage's log, and a later deletion wins", () => {
    const part = tmp();
    const ldb = join(part, "Local Storage", "leveldb");
    mkdirSync(ldb, { recursive: true });
    const key = localStorageKey("https://discord.com", "token");
    const val = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(FAKE), "latin1")]);
    writeFileSync(join(ldb, "000003.log"), logFile([[key, val], [localStorageKey("https://discord.com", "other"), Buffer.from([1, 120])]], 5));
    expect(readLog(new Uint8Array(logFile([[key, val]], 1))).length).toBe(1);
    expect(discordToken(part)).toBe(FAKE);
    writeFileSync(join(ldb, "000004.log"), logFile([[key, null]], 9));
    expect(discordToken(part)).toBeNull();
  });

  it("no folder, no token", () => {
    expect(discordToken(join(tmp(), "missing"))).toBeNull();
  });
});

describe("token store (sealed file)", () => {
  it("keeps tokens encrypted on disk, per connection", () => {
    const d = tmp();
    const s = tokenStore(d, { HUB_PERSONS_TOKENS: "file" });
    expect(s.where).toBe("sealed file");
    expect(s.get("stores")).toBeNull();
    s.set("stores", FAKE);
    s.set("spokpay", `${FAKE}2`);
    expect(tokenStore(d, { HUB_PERSONS_TOKENS: "file" }).get("stores")).toBe(FAKE);
    const raw = require("node:fs").readFileSync(join(d, "discord", "tokens.sealed"), "utf8") as string;
    expect(raw.includes("fake_fake")).toBe(false);
    s.remove("stores");
    expect(s.get("stores")).toBeNull();
    expect(s.get("spokpay")).toBe(`${FAKE}2`);
  });
});

describe("QR sign-in (remote auth)", () => {
  it("parses who scanned", () => {
    expect(parseUserPayload("581633588764606504:0:a_abc:fagner:x")).toEqual({ id: "581633588764606504", username: "fagner:x", avatar: "a_abc" });
    expect(parseUserPayload("nope")).toBeNull();
  });

  it("runs the whole exchange against a fake gateway and API", async () => {
    let serverKey: ReturnType<typeof createPublicKey> | null = null;
    const nonce = Buffer.from("nonce-123");
    const enc = (b: Buffer): string => publicEncrypt({ key: serverKey!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, b).toString("base64");
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname.endsWith("/remote-auth/login")) return Response.json({ encrypted_token: enc(Buffer.from(FAKE)) });
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ op: "hello", heartbeat_interval: 40000, timeout_ms: 120000 }));
        },
        message(ws, m) {
          const v = JSON.parse(String(m)) as Record<string, string>;
          if (v.op === "init") {
            serverKey = createPublicKey({ key: Buffer.from(v.encoded_public_key!, "base64"), format: "der", type: "spki" });
            ws.send(JSON.stringify({ op: "nonce_proof", encrypted_nonce: enc(nonce) }));
          } else if (v.op === "nonce_proof") {
            const want = createHash("sha256").update(nonce).digest("base64url");
            if (v.proof !== want) return ws.close();
            ws.send(JSON.stringify({ op: "pending_remote_init", fingerprint: "FP" }));
            ws.send(JSON.stringify({ op: "pending_ticket", encrypted_user_payload: enc(Buffer.from("581633588764606504:0:0:igor")) }));
            ws.send(JSON.stringify({ op: "pending_login", ticket: "T" }));
          }
        },
      },
    });
    try {
      const seen: string[] = [];
      const r = await remoteAuth({ qr: (u) => seen.push(u), scanned: (u) => seen.push(u.username) }, { gateway: `ws://127.0.0.1:${server.port}/`, api: `http://127.0.0.1:${server.port}/api/v9`, timeout: 10_000 });
      expect(r).toEqual({ token: FAKE });
      expect(seen).toEqual(["https://discord.com/ra/FP", "igor"]);
    } finally {
      server.stop(true);
    }
  });

  it("decrypts with the key it made", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const c = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from("x")).toString("base64");
    expect(decryptWith(privateKey, c).toString()).toBe("x");
  });
});
