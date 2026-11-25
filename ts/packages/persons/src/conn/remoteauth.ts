// Discord sign-in by QR code, with no browser: the remote-auth gateway the official clients use for "Log in with
// QR code" (wss://remote-auth-gateway.discord.gg, version 2). Hub shows the code; the user scans it in the Discord
// app on their phone (You › Scan QR code) and confirms; the token comes back encrypted to a key made here.
//
//   hello → init {our RSA-OAEP public key} → nonce_proof (decrypt, send sha256) → pending_remote_init {fingerprint}
//   (the QR is https://discord.com/ra/<fingerprint>) → pending_ticket (who scanned) → pending_login {ticket}
//   → POST /users/@me/remote-auth/login {ticket} → {encrypted_token} → token.
// The token is returned to the caller only, never logged.
import { constants, createHash, generateKeyPairSync, privateDecrypt, type KeyObject } from "node:crypto";

export interface RemoteAuthEvents {
  /** A new code to show (each lasts about two minutes; a fresh one follows by itself). */
  qr(url: string): void;
  /** Someone scanned it: their name, waiting for them to confirm on the phone. */
  scanned?(user: { id: string; username: string; avatar: string | null }): void;
  log?(...a: unknown[]): void;
}

export interface RemoteAuthOptions {
  gateway?: string;
  api?: string;
  /** Gives up after this long (ms). */
  timeout?: number;
  signal?: AbortSignal;
  /** Headers for the login call (X-Super-Properties, User-Agent). */
  headers?: Record<string, string>;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
}

export type RemoteAuthResult = { token: string } | { cancelled: true } | { error: string };

const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function decryptWith(key: KeyObject, b64: string): Buffer {
  return privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(b64, "base64"));
}

/** "id:discriminator:avatar:username" (Discord's decrypted user payload). */
export function parseUserPayload(s: string): { id: string; username: string; avatar: string | null } | null {
  const [id = "", , avatar = "", ...rest] = s.split(":");
  if (!/^\d{15,21}$/.test(id)) return null;
  return { id, username: rest.join(":"), avatar: avatar && avatar !== "0" ? avatar : null };
}

/** One sign-in: keeps showing fresh codes until someone confirms, the user cancels, or it times out. */
export async function remoteAuth(ev: RemoteAuthEvents, o: RemoteAuthOptions = {}): Promise<RemoteAuthResult> {
  const deadline = Date.now() + (o.timeout ?? 15 * 60_000);
  while (Date.now() < deadline && !o.signal?.aborted) {
    const t0 = Date.now();
    const r = await oneSession(ev, o, deadline);
    if (r !== "again") return r;
    // closed at once (no network, refused): don't hammer the gateway
    if (Date.now() - t0 < 3000) await new Promise((res) => setTimeout(res, 5000));
  }
  return o.signal?.aborted ? { cancelled: true } : { error: "Nobody scanned the code in time" };
}

function oneSession(ev: RemoteAuthEvents, o: RemoteAuthOptions, deadline: number): Promise<RemoteAuthResult | "again"> {
  const WS = o.WebSocketImpl ?? WebSocket;
  const http = o.fetchImpl ?? fetch;
  const gateway = o.gateway ?? "wss://remote-auth-gateway.discord.gg/?v=2";
  const api = (o.api ?? "https://discord.com/api/v9").replace(/\/$/, "");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  return new Promise((resolve) => {
    let done = false;
    let beat: ReturnType<typeof setInterval> | null = null;
    // Bun's WebSocket takes headers: the gateway wants Discord's origin
    const ws = new (WS as unknown as new (url: string, opts?: unknown) => WebSocket)(gateway, { headers: { Origin: "https://discord.com" } });
    const finish = (r: RemoteAuthResult | "again"): void => {
      if (done) return;
      done = true;
      if (beat) clearInterval(beat);
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {
        // closed
      }
      resolve(r);
    };
    const onAbort = (): void => finish({ cancelled: true });
    o.signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => finish("again"), Math.max(1000, deadline - Date.now()));
    const send = (v: unknown): void => ws.send(JSON.stringify(v));
    ws.onmessage = (m: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(m.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      try {
        switch (msg.op) {
          case "hello":
            beat = setInterval(() => send({ op: "heartbeat" }), Number(msg.heartbeat_interval) || 41_250);
            send({ op: "init", encoded_public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64") });
            break;
          case "nonce_proof": {
            const nonce = decryptWith(privateKey, String(msg.encrypted_nonce));
            send({ op: "nonce_proof", proof: b64url(createHash("sha256").update(nonce).digest()) });
            break;
          }
          case "pending_remote_init":
            ev.qr(`https://discord.com/ra/${String(msg.fingerprint)}`);
            break;
          case "pending_ticket": {
            const u = parseUserPayload(decryptWith(privateKey, String(msg.encrypted_user_payload)).toString("utf8"));
            if (u) ev.scanned?.(u);
            break;
          }
          case "pending_login":
            void (async () => {
              try {
                const r = await http(`${api}/users/@me/remote-auth/login`, { method: "POST", headers: { "Content-Type": "application/json", ...o.headers }, body: JSON.stringify({ ticket: msg.ticket }) });
                const body = (await r.json().catch(() => ({}))) as { encrypted_token?: string; message?: string };
                if (!r.ok || !body.encrypted_token) return finish({ error: body.message ? `Discord: ${body.message}` : `Discord answered ${r.status}` });
                finish({ token: decryptWith(privateKey, body.encrypted_token).toString("utf8") });
              } catch (e) {
                finish({ error: e instanceof Error ? e.message : String(e) });
              }
            })();
            break;
          case "cancel":
            ev.log?.("the phone cancelled the QR sign-in");
            finish({ cancelled: true });
            break;
        }
      } catch (e) {
        ev.log?.("remote auth:", e instanceof Error ? e.message : String(e));
        finish("again");
      }
    };
    // the gateway closes a code after its timeout: a fresh one (unless we're done)
    ws.onclose = () => finish("again");
    ws.onerror = () => finish("again");
  });
}
