import { describe, expect, test } from "bun:test";
import {
  checks,
  decodeItem,
  encodeItem,
  keyCheck,
  leaseRow,
  newVaultKey,
  open,
  packFiles,
  rowId,
  seal,
  unpackFiles,
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

  test("the key check: only the vault's key passes, and it's the one the account service computes (worker/src/vault.js)", () => {
    const vk = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
    expect(keyCheck(vk, "0123456789abcdef")).toBe("9015c7632b1a7ffa5ae683539317b0a8");
    expect(checks(vk, "0123456789abcdef", keyCheck(vk, "0123456789abcdef"))).toBe(true);
    expect(checks(newVaultKey(), "0123456789abcdef", keyCheck(vk, "0123456789abcdef"))).toBe(false);
    expect(checks(vk, "another epoch", keyCheck(vk, "0123456789abcdef"))).toBe(false);
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
