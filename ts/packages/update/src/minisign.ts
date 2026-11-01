import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const PUBKEY = "RWSaeVHfD2GBvTEgaNXQQs8eQR5rCD50vuckgoo79X6wqhOKXIpUVHNh";

const ED = [0x45, 0x64] as const;
const ED_PREHASHED = [0x45, 0x44] as const;
const TRUSTED = "trusted comment: ";

type Bytes = Uint8Array<ArrayBuffer>;

export interface PublicKey {
  id: Bytes;
  key: CryptoKey;
}

export interface Signature {
  prehashed: boolean;
  keyId: Bytes;
  signature: Bytes;
  trustedComment: string;
  global: Bytes;
}

function unbase64(s: string): Bytes {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error("unreadable");
  return new Uint8Array(Buffer.from(s, "base64"));
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

export async function parsePublicKey(text: string): Promise<PublicKey> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("untrusted comment:"));
  let raw: Bytes;
  try {
    raw = unbase64(lines[0] ?? "");
  } catch {
    throw new Error("public key: unreadable");
  }
  if (raw.length !== 42 || !same(raw.subarray(0, 2), ED)) throw new Error("public key: unreadable");
  const key = await crypto.subtle.importKey("raw", raw.subarray(10), "Ed25519", false, ["verify"]);
  return { id: raw.slice(2, 10), key };
}

// minisign-verify refuses legacy (not prehashed) signatures by default; so does this.
export function parseSignature(text: string): Signature {
  const lines = text.split(/\r?\n/);
  const sigLine = lines[1]?.trim();
  const comment = lines[2];
  const globalLine = lines[3]?.trim();
  if (!lines[0]?.startsWith("untrusted comment:") || sigLine === undefined || comment === undefined || globalLine === undefined || !comment.startsWith(TRUSTED)) {
    throw new Error("unreadable signature");
  }
  let raw: Bytes;
  let global: Bytes;
  try {
    raw = unbase64(sigLine);
    global = unbase64(globalLine);
  } catch {
    throw new Error("unreadable signature");
  }
  if (raw.length !== 74 || global.length !== 64) throw new Error("unreadable signature");
  const algorithm = raw.subarray(0, 2);
  if (same(algorithm, ED)) throw new Error("legacy signature: sign with a prehashed minisign signature");
  if (!same(algorithm, ED_PREHASHED)) throw new Error("unreadable signature");
  return { prehashed: true, keyId: raw.slice(2, 10), signature: raw.slice(10), trustedComment: comment.slice(TRUSTED.length), global };
}

export async function blake2bFile(path: string): Promise<Bytes> {
  const h = createHash("blake2b512");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return new Uint8Array(h.digest());
}

export function blake2b(data: Uint8Array): Bytes {
  return new Uint8Array(createHash("blake2b512").update(data).digest());
}

const verifyRaw = (pk: PublicKey, sig: Bytes, message: Bytes): Promise<boolean> => crypto.subtle.verify("Ed25519", pk.key, sig, message);

async function check(pk: PublicKey, sigText: string, digest: () => Promise<Bytes>): Promise<Signature> {
  const sig = parseSignature(sigText);
  if (!same(sig.keyId, pk.id)) throw new Error("signed with another key");
  if (!(await verifyRaw(pk, sig.signature, await digest()))) throw new Error("bad signature");
  const comment = new TextEncoder().encode(sig.trustedComment);
  const covered: Bytes = new Uint8Array(sig.signature.length + comment.length);
  covered.set(sig.signature);
  covered.set(comment, sig.signature.length);
  if (!(await verifyRaw(pk, sig.global, covered))) throw new Error("bad signature on the trusted comment");
  return sig;
}

export const verifyBytes = (pk: PublicKey, data: Uint8Array, sigText: string): Promise<Signature> => check(pk, sigText, async () => blake2b(data));

export const verifyFileSignature = (pk: PublicKey, file: string, sigText: string): Promise<Signature> => check(pk, sigText, () => blake2bFile(file));

export async function verifyAsset(pk: PublicKey, file: string, sigText: string, version: string, name: string): Promise<void> {
  let sig: Signature;
  try {
    sig = await verifyFileSignature(pk, file, sigText);
  } catch (e) {
    throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const tc = sig.trustedComment;
  if (!tc.includes(`v${version} `) || !tc.endsWith(name)) throw new Error(`${name}: signed for another release (${tc})`);
}
