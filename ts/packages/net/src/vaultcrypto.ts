// The account vault's cryptography (vault.ts runs the sync). One random 256-bit vault key per
// account encrypts every item with AES-256-GCM, and keys the hashes that name its rows. The account
// service makes the key (worker/src/vault.js mirrors newVaultKey and keyCheck), keeps it sealed with
// a secret of its own, and hands it to the account's signed-in PCs.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const INFO = "harbor-vault-v1";
export const KEY_BYTES = 32;

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");
const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();
export const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** A new vault key (as the service makes one; tests). */
export function newVaultKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

function subkey(vk: Uint8Array, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", vk, Buffer.alloc(0), `${INFO} ${label}`, 32));
}

function gcmSeal(key: Uint8Array, aad: string, plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

function gcmOpen(key: Uint8Array, aad: string, box: Uint8Array): Buffer | null {
  if (box.length < 28) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, box.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(box.subarray(box.length - 16));
    return Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

/** The service's id of an item: a keyed hash, so not even the item's name (a mail address, a key's name) is seen. */
export function rowId(vk: Uint8Array, item: string): string {
  return `i:${createHmac("sha256", subkey(vk, "ids")).update(item).digest("hex").slice(0, 40)}`;
}

/** The row of a single-host integration's lease. */
export function leaseRow(vk: Uint8Array, app: string): string {
  return `lease:${createHmac("sha256", subkey(vk, "ids")).update(`lease ${app}`).digest("hex").slice(0, 40)}`;
}

/** Proof, kept in `meta`, that a key is this vault's (a wrong or swapped key is refused). */
export function keyCheck(vk: Uint8Array, epoch: string): string {
  return createHmac("sha256", subkey(vk, "check")).update(epoch).digest("hex").slice(0, 32);
}

export function checks(vk: Uint8Array, epoch: string, check: string): boolean {
  const a = Buffer.from(keyCheck(vk, epoch));
  const b = Buffer.from(check);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** An item as the service holds it: "v1." and base64 of nonce, ciphertext and tag; bound to its row and the vault's epoch. */
export function seal(vk: Uint8Array, row: string, epoch: string, plain: Uint8Array): string {
  return `v1.${b64(gcmSeal(subkey(vk, "items"), `${epoch}\n${row}`, plain))}`;
}

export function open(vk: Uint8Array, row: string, epoch: string, text: string): Buffer | null {
  if (!text.startsWith("v1.")) return null;
  return gcmOpen(subkey(vk, "items"), `${epoch}\n${row}`, unb64(text.slice(3)));
}

/** What an item's plaintext holds: its name, and its bytes (gzipped) or none when it was deleted. */
export interface Plain {
  id: string;
  data: Uint8Array | null;
}

export function encodeItem(p: Plain): Buffer {
  const id = Buffer.from(p.id, "utf8");
  if (id.length > 0xffff) throw new Error("item name too long");
  const head = Buffer.alloc(3);
  head[0] = p.data === null ? 1 : 0;
  head.writeUInt16BE(id.length, 1);
  return Buffer.concat([head, id, p.data === null ? Buffer.alloc(0) : gzipSync(p.data)]);
}

export function decodeItem(b: Uint8Array): Plain | null {
  if (b.length < 3) return null;
  const buf = Buffer.from(b);
  const n = buf.readUInt16BE(1);
  if (3 + n > buf.length) return null;
  const id = buf.subarray(3, 3 + n).toString("utf8");
  if (buf[0] === 1) return { id, data: null };
  try {
    return { id, data: new Uint8Array(gunzipSync(buf.subarray(3 + n), { maxOutputLength: 64 << 20 })) };
  } catch {
    return null;
  }
}

// ---- a folder as one item (WhatsApp's linked-device keys, Discord's session)

/** Files under a folder as one deterministic archive (sorted, no times): the same files, the same bytes. */
export function packFiles(files: readonly [string, Uint8Array][]): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const n = Buffer.from(name, "utf8");
    const h = Buffer.alloc(6);
    h.writeUInt16BE(n.length, 0);
    h.writeUInt32BE(data.length, 2);
    parts.push(h, n, Buffer.from(data));
  }
  return Buffer.concat(parts);
}

/** A safe relative path: no absolute path, no `..`, no empty part. */
export function safeName(name: string): boolean {
  if (name === "" || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  return name.split("/").every((p) => p !== "" && p !== "." && p !== "..");
}

export function unpackFiles(b: Uint8Array): [string, Buffer][] | null {
  const buf = Buffer.from(b);
  const out: [string, Buffer][] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 6 > buf.length) return null;
    const n = buf.readUInt16BE(i);
    const len = buf.readUInt32BE(i + 2);
    i += 6;
    if (i + n + len > buf.length) return null;
    const name = buf.subarray(i, i + n).toString("utf8");
    if (!safeName(name)) return null;
    out.push([name, buf.subarray(i + n, i + n + len)]);
    i += n + len;
  }
  return out;
}

export const hashOf = (b: Uint8Array): string => sha256(b).toString("hex");
