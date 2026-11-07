// The account vault's cryptography (vault.ts runs the sync). One random 256-bit vault key per
// account encrypts every item with AES-256-GCM; the account service only stores what comes out.
// The key reaches a PC in one of two ways, both opened only on that PC:
// - wrapped for the PC's own X25519 key (ECIES: an ephemeral X25519 key, HKDF-SHA256, AES-256-GCM),
//   by another PC of the account that holds the key. The PC asks with its X25519 public key signed
//   by its TLS key (the one its fingerprint and the account service's device record are of);
// - wrapped with the account's recovery code (scrypt, AES-256-GCM): the way in when none of the
//   other PCs is on. The code is shown in Settings › Workspace on every PC that has the key.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const INFO = "harbor-vault-v1";
export const KEY_BYTES = 32;

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");
const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();
export const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** A new vault key. */
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

// ---- this PC's own vault key pair (X25519), kept beside identity.pem

export interface DeviceKey {
  /** SPKI DER, base64. */
  pub: string;
  /** PKCS#8 DER, base64. */
  key: string;
}

export function newDeviceKey(): DeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { pub: b64(publicKey.export({ type: "spki", format: "der" })), key: b64(privateKey.export({ type: "pkcs8", format: "der" })) };
}

const pubOf = (s: string): KeyObject => createPublicKey({ key: unb64(s), format: "der", type: "spki" });
const privOf = (s: string): KeyObject => createPrivateKey({ key: unb64(s), format: "der", type: "pkcs8" });

/** What a PC asks for the key with (`req:<fp>`): its X25519 key, signed with its TLS key. */
export interface KeyRequest {
  pub: string;
  /** The TLS key's SPKI (base64): its SHA-256 is the PC's fingerprint. */
  spki: string;
  sig: string;
  name: string;
}

export const requestText = (fp: string, pub: string): string => `harbor-vault-req-v1\n${fp}\n${pub}`;

/** The request is the PC's own: its TLS key hashes to `fp` and signed this X25519 key. */
export function requestValid(fp: string, r: KeyRequest): boolean {
  try {
    const spki = unb64(r.spki);
    if (sha256Hex(spki) !== fp) return false;
    const k = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (pubOf(r.pub).asymmetricKeyType !== "x25519") return false;
    return verify("sha256", Buffer.from(requestText(fp, r.pub)), k, unb64(r.sig));
  } catch {
    return false;
  }
}

/** The vault key for one PC (`key:<fp>`). */
export interface Wrapped {
  v: 1;
  epoch: string;
  /** The X25519 key it's for: a PC that made a new one asks again. */
  pub: string;
  eph: string;
  ct: string;
}

function wrapKey(shared: Buffer, eph: string, pub: string, fp: string, epoch: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([unb64(eph), unb64(pub)]), `${INFO} wrap ${fp} ${epoch}`, 32));
}

export function wrapFor(vk: Uint8Array, fp: string, pub: string, epoch: string): Wrapped {
  const e = generateKeyPairSync("x25519");
  const eph = b64(e.publicKey.export({ type: "spki", format: "der" }));
  const k = wrapKey(diffieHellman({ privateKey: e.privateKey, publicKey: pubOf(pub) }), eph, pub, fp, epoch);
  return { v: 1, epoch, pub, eph, ct: b64(gcmSeal(k, `wrap\n${fp}\n${epoch}`, vk)) };
}

export function unwrap(w: Wrapped, fp: string, mine: DeviceKey): Uint8Array | null {
  if (w.pub !== mine.pub) return null;
  try {
    const k = wrapKey(diffieHellman({ privateKey: privOf(mine.key), publicKey: pubOf(w.eph) }), w.eph, w.pub, fp, w.epoch);
    const vk = gcmOpen(k, `wrap\n${fp}\n${w.epoch}`, unb64(w.ct));
    return vk && vk.length === KEY_BYTES ? new Uint8Array(vk) : null;
  } catch {
    return null;
  }
}

// ---- the recovery code

/** Crockford's base32: no I, L, O or U to misread. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 25;

/** 125 random bits, as five groups of five ("7KQ2M-…"). */
export function newRecoveryCode(): string {
  const r = randomBytes(CODE_CHARS);
  const chars = [...r].map((b) => ALPHABET[b & 31]).join("");
  return (chars.match(/.{5}/g) ?? []).join("-");
}

/** As typed: case, spaces and dashes don't matter; O, I and L read as 0, 1 and 1. Null: not a code. */
export function normalizeCode(s: string): string | null {
  const c = s
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return c.length === CODE_CHARS && [...c].every((x) => ALPHABET.includes(x)) ? c : null;
}

export interface RecoveryWrap {
  v: 1;
  epoch: string;
  salt: string;
  n: number;
  ct: string;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 << 20 };

function codeKey(code: string, salt: Buffer, n: number): Buffer {
  return scryptSync(code, salt, 32, { ...SCRYPT, N: n });
}

export function wrapRecovery(vk: Uint8Array, code: string, epoch: string): RecoveryWrap {
  const c = normalizeCode(code);
  if (c === null) throw new Error("not a recovery code");
  const salt = randomBytes(16);
  return { v: 1, epoch, salt: b64(salt), n: SCRYPT.N, ct: b64(gcmSeal(codeKey(c, salt, SCRYPT.N), `recovery\n${epoch}`, vk)) };
}

export function unwrapRecovery(w: RecoveryWrap, code: string): Uint8Array | null {
  const c = normalizeCode(code);
  if (c === null || !Number.isInteger(w.n) || w.n < 1 << 14 || w.n > 1 << 20) return null;
  const vk = gcmOpen(codeKey(c, unb64(w.salt), w.n), `recovery\n${w.epoch}`, unb64(w.ct));
  return vk && vk.length === KEY_BYTES ? new Uint8Array(vk) : null;
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
