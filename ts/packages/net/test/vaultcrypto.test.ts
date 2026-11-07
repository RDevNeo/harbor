import { describe, expect, test } from "bun:test";
import { generateIdentity, signWith, spkiOf } from "../src/tls.ts";
import {
  checks,
  decodeItem,
  encodeItem,
  keyCheck,
  leaseRow,
  newDeviceKey,
  newRecoveryCode,
  newVaultKey,
  normalizeCode,
  open,
  packFiles,
  requestText,
  requestValid,
  rowId,
  seal,
  unpackFiles,
  unwrap,
  unwrapRecovery,
  wrapFor,
  wrapRecovery,
} from "../src/vaultcrypto.ts";

const bytes = (s: string) => new Uint8Array(Buffer.from(s));

describe("vault crypto", () => {
  test("an item opens only with its key, under its own row and epoch", () => {
    const vk = newVaultKey();
    const row = rowId(vk, "f:gmail.accounts/sam@example.com.json");
    const box = seal(vk, row, "e1", bytes("refresh token"));
    expect(box.startsWith("v1.")).toBe(true);
    expect(box.includes("refresh")).toBe(false);
    expect(open(vk, row, "e1", box)?.toString()).toBe("refresh token");
    expect(open(newVaultKey(), row, "e1", box)).toBeNull();
    expect(open(vk, rowId(vk, "f:other"), "e1", box)).toBeNull(); // moved to another row
    expect(open(vk, row, "e2", box)).toBeNull(); // from an old vault
    const flipped = `v1.${Buffer.from(Buffer.from(box.slice(3), "base64").map((b, i) => (i === 20 ? b ^ 1 : b))).toString("base64")}`;
    expect(open(vk, row, "e1", flipped)).toBeNull();
    // Two seals of the same thing differ (a fresh nonce each time).
    expect(seal(vk, row, "e1", bytes("x"))).not.toBe(seal(vk, row, "e1", bytes("x")));
  });

  test("row ids are keyed hashes: the same name gives the same row, another vault another", () => {
    const vk = newVaultKey();
    expect(rowId(vk, "s:KEY")).toBe(rowId(vk, "s:KEY"));
    expect(rowId(vk, "s:KEY")).not.toBe(rowId(newVaultKey(), "s:KEY"));
    expect(rowId(vk, "s:KEY")).toMatch(/^i:[0-9a-f]{40}$/);
    expect(leaseRow(vk, "whatsapp")).toMatch(/^lease:[0-9a-f]{40}$/);
    expect(leaseRow(vk, "whatsapp")).not.toBe(leaseRow(vk, "discord"));
  });

  test("items carry their name and gzipped bytes, or a deletion", () => {
    const big = bytes("a".repeat(100_000));
    const enc = encodeItem({ id: "b:whatsapp", data: big });
    expect(enc.length).toBeLessThan(2000);
    expect(decodeItem(enc)).toEqual({ id: "b:whatsapp", data: big });
    expect(decodeItem(encodeItem({ id: "s:GONE", data: null }))).toEqual({ id: "s:GONE", data: null });
    expect(decodeItem(new Uint8Array([0, 0]))).toBeNull();
  });

  test("the key wrapped for a PC opens only with that PC's key pair", () => {
    const vk = newVaultKey();
    const mine = newDeviceKey();
    const w = wrapFor(vk, "fp1", mine.pub, "e1");
    expect(Buffer.from(unwrap(w, "fp1", mine) ?? []).equals(Buffer.from(vk))).toBe(true);
    expect(unwrap(w, "fp1", newDeviceKey())).toBeNull();
    expect(unwrap(w, "fp2", mine)).toBeNull(); // bound to the fingerprint
    expect(unwrap({ ...w, epoch: "e2" }, "fp1", mine)).toBeNull();
    expect(checks(vk, "e1", keyCheck(vk, "e1"))).toBe(true);
    expect(checks(newVaultKey(), "e1", keyCheck(vk, "e1"))).toBe(false);
  });

  test("a key request is valid only signed by the TLS key its fingerprint is of", () => {
    const id = generateIdentity();
    const dk = newDeviceKey();
    const req = { pub: dk.pub, spki: Buffer.from(spkiOf(id)).toString("base64"), sig: Buffer.from(signWith(id, requestText(id.fp, dk.pub))).toString("base64"), name: "laptop" };
    expect(requestValid(id.fp, req)).toBe(true);
    expect(requestValid(generateIdentity().fp, req)).toBe(false);
    expect(requestValid(id.fp, { ...req, pub: newDeviceKey().pub })).toBe(false); // someone else's X25519 key
    const other = generateIdentity();
    expect(requestValid(other.fp, { ...req, spki: Buffer.from(spkiOf(other)).toString("base64") })).toBe(false);
  });

  test("the recovery code: 125 bits in five groups, forgiving to type, opens only its vault", () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(newRecoveryCode()).not.toBe(code);
    expect(normalizeCode(code.toLowerCase().replace(/-/g, " "))).toBe(code.replace(/-/g, ""));
    expect(normalizeCode("ABCDE")).toBeNull();
    const vk = newVaultKey();
    const w = wrapRecovery(vk, code, "e1");
    expect(JSON.stringify(w).includes(code)).toBe(false);
    expect(Buffer.from(unwrapRecovery(w, code) ?? []).equals(Buffer.from(vk))).toBe(true);
    expect(unwrapRecovery(w, newRecoveryCode())).toBeNull();
    expect(unwrapRecovery({ ...w, n: 2 }, code)).toBeNull(); // no weakened cost from the service
  });

  test("a session's files pack the same way every time, and unsafe names don't unpack", () => {
    const a = packFiles([
      ["auth/creds.json", bytes("{}")],
      ["linked.json", bytes("1")],
    ]);
    const b = packFiles([
      ["linked.json", bytes("1")],
      ["auth/creds.json", bytes("{}")],
    ]);
    expect(a.equals(b)).toBe(true);
    expect(unpackFiles(a)?.map(([n, d]) => [n, d.toString()])).toEqual([
      ["auth/creds.json", "{}"],
      ["linked.json", "1"],
    ]);
    for (const bad of ["../x", "/etc/passwd", "a/../../b", "a//b"]) expect(unpackFiles(packFiles([[bad, bytes("x")]]))).toBeNull();
    expect(unpackFiles(a.subarray(0, a.length - 1))).toBeNull();
  });
});
