import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUBKEY, blake2b, blake2bFile, parsePublicKey, parseSignature, verifyAsset, verifyBytes } from "../src/minisign.ts";
import { cleanup, makeKey, tmp, windowsTime } from "./support.ts";

windowsTime();

afterEach(cleanup);

const REAL_SIG = `untrusted comment: signature from minisign secret key
RUSaeVHfD2GBvargpdewoKaCPteir0zUTL31H4bcjFF5op1zwKHVaz4aU3MCYoB8DmZ+BbqDLBmvxEokE+YvUTkIXmvkhoxkFg8=
trusted comment: harbor v0.0.1 harbor-x86_64-linux.tar.gz
N5LtPI0Gsk3pOwxTI4SLqgkXbXPZe3xgdluvQMXHbmDLg/UIFKQnNC3sdYQke6ZBlrU6os7Moa5CZJTZufUQDQ==
`;

test("a signature made by the release key checks out, for its release and file only", async () => {
  const pk = await parsePublicKey(PUBKEY);
  const f = join(tmp(), "a.tar.gz");
  const name = "harbor-x86_64-linux.tar.gz";
  writeFileSync(f, "harbor test\n");
  await verifyAsset(pk, f, REAL_SIG, "0.0.1", name);
  await expect(verifyAsset(pk, f, REAL_SIG, "0.0.2", name)).rejects.toThrow("signed for another release");
  await expect(verifyAsset(pk, f, REAL_SIG, "0.0.1", "harbor-browser-x86_64-linux.tar.gz")).rejects.toThrow("signed for another release");
  writeFileSync(f, "harbor test!\n");
  await expect(verifyAsset(pk, f, REAL_SIG, "0.0.1", name)).rejects.toThrow("bad signature");
});

test("the public key is read from the bare line or from a whole minisign.pub", async () => {
  const a = await parsePublicKey(PUBKEY);
  const b = await parsePublicKey(`untrusted comment: minisign public key BD81610FDF51799A\n${PUBKEY}\n`);
  expect(Buffer.from(a.id).toString("hex")).toBe(Buffer.from(b.id).toString("hex"));
  expect(Buffer.from(a.id).toString("hex")).toBe("9a7951df0f6181bd");
  await expect(parsePublicKey("not a key")).rejects.toThrow();
  await expect(parsePublicKey("RWSa")).rejects.toThrow("unreadable");
});

test("a throwaway key signs and verifies prehashed (BLAKE2b-512) like minisign", async () => {
  const key = await makeKey();
  const pk = await parsePublicKey(key.publicKey);
  const data = new TextEncoder().encode("a bundle");
  const sig = await key.sign(data, "harbor v1.2.3 harbor-app.js");
  const parsed = await verifyBytes(pk, data, sig);
  expect(parsed.prehashed).toBe(true);
  expect(parsed.trustedComment).toBe("harbor v1.2.3 harbor-app.js");
  await expect(verifyBytes(pk, new TextEncoder().encode("another bundle"), sig)).rejects.toThrow("bad signature");
});

test("the real release key refuses a signature made by another key", async () => {
  const other = await makeKey();
  const data = new TextEncoder().encode("x");
  const sig = await other.sign(data, "harbor v0.0.1 x");
  await expect(verifyBytes(await parsePublicKey(PUBKEY), data, sig)).rejects.toThrow("another key");
});

test("a changed trusted comment is caught by the global signature", async () => {
  const key = await makeKey();
  const pk = await parsePublicKey(key.publicKey);
  const data = new TextEncoder().encode("x");
  const sig = await key.sign(data, "harbor v1.0.0 harbor-app.js");
  const forged = sig.replace("v1.0.0", "v9.9.9");
  await expect(verifyBytes(pk, data, forged)).rejects.toThrow("trusted comment");
});

test("legacy (not prehashed) signatures are refused", async () => {
  const key = await makeKey();
  const data = new TextEncoder().encode("x");
  const legacy = await key.sign(data, "harbor v1.0.0 x", { legacy: true });
  expect(() => parseSignature(legacy)).toThrow("legacy");
  await expect(verifyBytes(await parsePublicKey(key.publicKey), data, legacy)).rejects.toThrow("legacy");
});

test("garbage in place of a signature is unreadable", () => {
  for (const bad of ["", "hello", "untrusted comment: x\n!!!\ntrusted comment: y\n!!!\n", "untrusted comment: x\nRUSa\ntrusted comment: y\nAAAA\n"]) {
    expect(() => parseSignature(bad)).toThrow("unreadable");
  }
});

test("windows line endings in a signature file are accepted", async () => {
  const key = await makeKey();
  const data = new TextEncoder().encode("x");
  const sig = (await key.sign(data, "harbor v1.0.0 x")).replace(/\n/g, "\r\n");
  await verifyBytes(await parsePublicKey(key.publicKey), data, sig);
});

test("a large file hashes by streaming to the same value as in memory", async () => {
  const f = join(tmp(), "big");
  const data = new Uint8Array(5 * 1024 * 1024 + 17).map((_, i) => i % 251);
  writeFileSync(f, data);
  expect(Buffer.from(await blake2bFile(f)).toString("hex")).toBe(Buffer.from(blake2b(data)).toString("hex"));
  const key = await makeKey();
  const sig = await key.sign(data, "harbor v2.0.0 big");
  await verifyAsset(await parsePublicKey(key.publicKey), f, sig, "2.0.0", "big");
});
