// node:tls has no verifier hooks (tls.rs has them), so a pin is checked right after the handshake, before any data.
import { constants, createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server, type TLSSocket, connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";

export interface Identity {
  pem: string;
  key: string;
  cert: string;
  /** SHA-256 of the certificate's SubjectPublicKeyInfo, hex. */
  fp: string;
}

interface Tlv {
  tag: number;
  header: number;
  length: number;
}

function tlv(b: Uint8Array): Tlv | null {
  const tag = b[0];
  const l0 = b[1];
  if (tag === undefined || l0 === undefined) return null;
  if (l0 < 0x80) return { tag, header: 2, length: l0 };
  const n = l0 & 0x7f;
  if (n === 0 || n > 4) return null;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const x = b[2 + i];
    if (x === undefined) return null;
    length = length * 256 + x;
  }
  return { tag, header: 2 + n, length };
}

export function spki(cert: Uint8Array): Uint8Array | null {
  const outer = tlv(cert);
  if (!outer || outer.tag !== 0x30) return null;
  const body = cert.subarray(outer.header, outer.header + outer.length);
  const inner = tlv(body);
  if (!inner || inner.tag !== 0x30) return null;
  let tbs = body.subarray(inner.header, inner.header + inner.length);
  // [0] version (optional), serial, signature algorithm, issuer, validity, subject, then the key.
  let skip = tbs[0] === 0xa0 ? 6 : 5;
  while (skip-- > 0) {
    const t = tlv(tbs);
    if (!t || t.header + t.length > tbs.length) return null;
    tbs = tbs.subarray(t.header + t.length);
  }
  const key = tlv(tbs);
  if (!key || key.tag !== 0x30 || key.header + key.length > tbs.length) return null;
  return tbs.subarray(0, key.header + key.length);
}

export function certFp(cert: Uint8Array): string | null {
  const key = spki(cert);
  return key ? createHash("sha256").update(key).digest("hex") : null;
}

/** A fingerprint as typed or pasted: spaces, colons and dashes dropped, lowercase. */
export function normalizeFp(s: string): string | null {
  const f = s.replace(/[ :-]/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(f) ? f : null;
}

/** A fingerprint as people compare it: the first 64 bits in groups of four. */
export function short(fp: string): string {
  return (fp.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

function pemBlock(pem: string, label: string): string | null {
  const m = pem.match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----\\n?`));
  return m ? m[0] : null;
}

function pemDer(block: string): Uint8Array {
  return Buffer.from(block.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
}

export function parseIdentity(pem: string): Identity {
  const key = pemBlock(pem, "PRIVATE KEY");
  const cert = pemBlock(pem, "CERTIFICATE");
  if (!key) throw new Error("identity key: none in the file");
  if (!cert) throw new Error("identity certificate: none in the file");
  const fp = certFp(pemDer(cert));
  if (!fp) throw new Error("identity certificate: unreadable");
  return { pem, key, cert, fp };
}

function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts);
  if (body.length < 0x80) return Buffer.concat([Uint8Array.of(tag, body.length), body]);
  const len: number[] = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) len.unshift(n % 256);
  return Buffer.concat([Uint8Array.of(tag, 0x80 | len.length, ...len), body]);
}

const seq = (...p: Uint8Array[]) => der(0x30, ...p);
const oid = (...bytes: number[]) => der(0x06, Uint8Array.from(bytes));
const ascii = (s: string) => new TextEncoder().encode(s);

const ECDSA_SHA256 = seq(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
const COMMON_NAME = oid(0x55, 0x04, 0x03);
const SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11);

/** A new ECDSA P-256 key and a self-signed certificate like rcgen's in tls.rs: valid for a century. */
export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const name = seq(der(0x31, seq(COMMON_NAME, der(0x0c, ascii("Harbor")))));
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x40; // positive and minimal DER: a leading 0x00 with a low next byte is refused (INVALID_INTEGER)
  const tbs = seq(
    der(0xa0, der(0x02, Uint8Array.of(2))),
    der(0x02, serial),
    ECDSA_SHA256,
    name,
    seq(der(0x17, ascii("250101000000Z")), der(0x18, ascii("21250101000000Z"))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(seq(SUBJECT_ALT_NAME, der(0x04, seq(der(0x82, ascii("harbor"))))))),
  );
  const signature = sign("sha256", tbs, privateKey);
  const cert = seq(tbs, ECDSA_SHA256, der(0x03, Uint8Array.of(0), signature));
  const b64 = Buffer.from(cert).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return parseIdentity(keyPem + certPem);
}

/** The DER ECDSA P-256 / SHA-256 signature the account service checks (Identity::sign). */
export function signWith(id: Identity, msg: Uint8Array): Uint8Array {
  return sign("sha256", msg, createPrivateKey(id.key));
}

export const WRONG_KEY = "it answers with another key than the one paired here";

export function peerFp(sock: TLSSocket): string | null {
  const raw = sock.getPeerCertificate(true).raw;
  return raw && raw.length > 0 ? certFp(raw) : null;
}

export interface ServerOptions {
  id: Identity;
  /** Certificate-less clients are let in unless this is set (`KnownClient` in tls.rs). */
  known?: (fp: string) => boolean;
  onConnection: (sock: TLSSocket, peer: string | null) => void;
}

/** No tickets: every connection proves its key again, like tls.rs's server_config. */
export const serverTls = (id: Identity) =>
  ({
    key: id.key,
    cert: id.cert,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    secureOptions: constants.SSL_OP_NO_TICKET,
  }) as const;

/** TLS 1.3 and 1.2, any client certificate; what a client may do is decided by its fingerprint. */
export function server(o: ServerOptions): Server {
  return createServer(serverTls(o.id), (sock) => {
    const peer = peerFp(sock);
    if (o.known && !(peer && o.known(peer))) {
      sock.destroy();
      return;
    }
    o.onConnection(sock, peer);
  });
}

export interface ClientOptions {
  id: Identity;
  /** The server's fingerprint; null only for pairing, where the code proves who it is. */
  pin: string | null;
  host?: string;
  port?: number;
  stream?: Duplex;
  /** TLS 1.3 like tls.rs; "TLSv1.2" stands in for a phone with an older Android. */
  maxVersion?: "TLSv1.3" | "TLSv1.2";
}

export function connect(o: ClientOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const max = o.maxVersion ?? "TLSv1.3";
    const sock = tlsConnect({
      key: o.id.key,
      cert: o.id.cert,
      rejectUnauthorized: false,
      minVersion: max,
      maxVersion: max,
      ...(o.host === undefined ? {} : { host: o.host }),
      ...(o.port === undefined ? {} : { port: o.port }),
      ...(o.stream === undefined ? {} : { socket: o.stream }),
    });
    sock.once("error", reject);
    sock.once("secureConnect", () => {
      const fp = peerFp(sock);
      if (!fp) {
        sock.destroy();
        reject(new Error("TLS: no certificate"));
      } else if (o.pin !== null && fp !== o.pin) {
        sock.destroy();
        reject(new Error(WRONG_KEY));
      } else {
        sock.off("error", reject);
        resolve(sock);
      }
    });
  });
}
