import { createHmac, timingSafeEqual } from "node:crypto";
import type { UnixSocketListener } from "bun";
import { chmodSync, rmSync } from "node:fs";
import { single } from "@harbor/store";
import { type Json, isObject, parseJson } from "./json.ts";

export const HOOK_PORT = 47920;
const HOOK_PER_MINUTE = 30;
const BODY_MAX = 1 << 20;
const TOOL_WAIT_MS = 120_000;
const READ_WAIT_MS = 30_000;

export interface ToolCall {
  chatId: number;
  tool: string;
  args: Json;
  reply(ok: boolean, text: string): void;
}

export interface Hook {
  token: string;
  method: string;
  headers: [string, string][];
  body: string;
}

/** What the app thread is told: `Api`, `MeshMsg` and `Offer` are the net and update packages' types. */
export type Incoming<Api = never, MeshMsg = never, Offer = never> =
  | { kind: "tool"; call: ToolCall }
  | { kind: "hook"; hook: Hook }
  | { kind: "api"; call: Api }
  | { kind: "focus"; raised: boolean }
  | { kind: "mesh"; msg: MeshMsg }
  | { kind: "preview"; offer: Offer | undefined; here: boolean }
  | { kind: "previewBack"; off: boolean }
  | { kind: "restart" };

export const socketPath = single.socketPath;

export interface SocketOptions<A, M, O> {
  send(i: Incoming<A, M, O>): void;
  /** Checks a `harbor preview push` message; an error text refuses it. */
  previewReceived?(v: Json): { here: boolean; offer: O } | string | Promise<{ here: boolean; offer: O } | string>;
  raise?(): boolean;
  path?: string;
}

export interface Listener {
  stop(): void;
}

function reply(socket: { write(d: string): number; end(): void }, v: Json): void {
  socket.write(`${JSON.stringify(v)}\n`);
  socket.end();
}

export function startSocket<A = never, M = never, O = never>(opts: SocketOptions<A, M, O>): Listener | undefined {
  const path = opts.path ?? socketPath();
  rmSync(path, { force: true });
  const buffers = new WeakMap<object, { text: string; timer: ReturnType<typeof setTimeout>; done: boolean }>();
  const raise = opts.raise ?? ((): boolean => single.raise());
  const dispatch = (socket: { write(d: string): number; end(): void }, v: Json): void => {
    if (!isObject(v)) return socket.end();
    if (v.focus === true) {
      const raised = raise();
      opts.send({ kind: "focus", raised });
      return reply(socket, { ok: true });
    }
    if (v.preview !== undefined) {
      const answer = (got: { here: boolean; offer: O } | string): void => {
        if (typeof got === "string") return reply(socket, { ok: false, text: got });
        opts.send({ kind: "preview", offer: got.offer, here: got.here });
        const text = got.here ? "" : "Previews are off on this PC (harbor preview on): only offered to the other PCs.";
        reply(socket, { ok: true, restarting: got.here, text });
      };
      const got = opts.previewReceived ? opts.previewReceived(v.preview) : "Previews are not available here.";
      if (typeof got === "string" || !("then" in got)) return answer(got);
      return void got.then(answer, (e: unknown) => reply(socket, { ok: false, text: e instanceof Error ? e.message : String(e) }));
    }
    if (v.restart === true) {
      opts.send({ kind: "restart" });
      return reply(socket, { ok: true });
    }
    if (v.preview_back !== undefined) {
      opts.send({ kind: "previewBack", off: v.off === true });
      return reply(socket, { ok: true });
    }
    let answered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (ok: boolean, text: string): void => {
      if (answered) return;
      answered = true;
      if (timer) clearTimeout(timer);
      reply(socket, { ok, text });
    };
    timer = setTimeout(() => done(false, "Harbor did not answer"), TOOL_WAIT_MS);
    const call: ToolCall = {
      chatId: typeof v.chat === "number" && Number.isInteger(v.chat) ? v.chat : 0,
      tool: typeof v.tool === "string" ? v.tool : "",
      args: v.args ?? null,
      reply: done,
    };
    try {
      opts.send({ kind: "tool", call });
    } catch {
      done(false, "Harbor did not answer");
    }
  };
  let server: UnixSocketListener<undefined>;
  try {
    server = Bun.listen<undefined>({
      unix: path,
      socket: {
        open(socket) {
          const timer = setTimeout(() => socket.end(), READ_WAIT_MS);
          buffers.set(socket, { text: "", timer, done: false });
        },
        data(socket, data) {
          const b = buffers.get(socket);
          if (!b || b.done) return;
          b.text += data.toString("utf8");
          const i = b.text.indexOf("\n");
          if (i < 0) return;
          b.done = true;
          clearTimeout(b.timer);
          const v = parseJson(b.text.slice(0, i));
          if (v === undefined) {
            socket.end();
            return;
          }
          dispatch(socket, v);
        },
        close(socket) {
          const b = buffers.get(socket);
          if (b) clearTimeout(b.timer);
        },
        error() {},
      },
    });
  } catch {
    console.error(`harbor: cannot bind ${path}`);
    return undefined;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // the socket is gone already
  }
  return {
    stop() {
      server.stop(true);
      rmSync(path, { force: true });
    },
  };
}

export class Rate {
  private readonly seen = new Map<string, number[]>();

  allow(token: string, at: number): boolean {
    for (const [k, q] of this.seen) {
      const last = q[q.length - 1];
      if (last === undefined || at - last >= 60_000) this.seen.delete(k);
    }
    let q = this.seen.get(token);
    if (!q) {
      q = [];
      this.seen.set(token, q);
    }
    while (q.length > 0 && at - (q[0] as number) >= 60_000) q.shift();
    if (q.length >= HOOK_PER_MINUTE) return false;
    q.push(at);
    return true;
  }
}

export const HOOK_RATE_LIMIT = HOOK_PER_MINUTE;
const hookRate = new Rate();

const KEEP = ["content-type", "user-agent", "x-github-event", "x-github-delivery", "x-gitlab-event", "x-vercel-event", "stripe-signature", "x-event-key", "x-request-id"];

function empty(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "Content-Length": "0", Connection: "close", ...extra } });
}

async function readCapped(req: Request): Promise<Uint8Array | undefined> {
  const len = req.headers.get("content-length");
  const cut = len !== null && Number(len) > BODY_MAX;
  if (!req.body) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_MAX) {
      await reader.cancel();
      if (!cut) return undefined;
      parts.push(value.subarray(0, value.byteLength - (total - BODY_MAX)));
      break;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

export interface Tokens {
  has(token: string): boolean;
}

export interface HookContext {
  tokens: Tokens;
  send(h: Hook): void;
  rate?: Rate;
  now?: () => number;
}

/**
 * Answers one webhook request. Only `/hooks/<token>` of a live webhook is answered; a GitHub-style
 * `X-Hub-Signature-256` must match an HMAC of the body keyed with the token.
 */
export async function serveHook(req: Request, ctx: HookContext): Promise<Response> {
  const prefix = "/hooks/";
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url).pathname);
  } catch {
    return empty(400);
  }
  const token = pathname.startsWith(prefix) ? pathname.slice(prefix.length).replace(/\/+$/, "") : "";
  if (token === "" || !ctx.tokens.has(token)) return empty(404);
  if (!(ctx.rate ?? hookRate).allow(token, (ctx.now ?? Date.now)())) return empty(429, { "Retry-After": "60" });
  const body = await readCapped(req);
  if (!body) return empty(413);
  const sig = req.headers.get("x-hub-signature-256");
  if (sig !== null && !signatureOk(token, body, sig)) return empty(401);
  const headers: [string, string][] = [];
  req.headers.forEach((v, k) => {
    if (KEEP.includes(k)) headers.push([k, v]);
  });
  ctx.send({ token, method: req.method, headers, body: new TextDecoder().decode(body) });
  return new Response('{"ok":true}', { status: 202, headers: { "Content-Type": "application/json", Connection: "close" } });
}

export function signatureOk(token: string, body: Uint8Array | string, sig: string): boolean {
  const s = sig.trim();
  if (!s.startsWith("sha256=")) return false;
  const hex = s.slice("sha256=".length);
  const want: number[] = [];
  for (let i = 0; i < Math.floor(hex.length / 2); i++) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) return false;
    want.push(Number.parseInt(pair, 16));
  }
  const got = createHmac("sha256", token).update(body).digest();
  return want.length === got.length && timingSafeEqual(got, Uint8Array.from(want));
}

export interface HookServer {
  port: number;
  stop(): void;
}

export function startHooks(tokens: Tokens, send: (h: Hook) => void, first = HOOK_PORT): HookServer | undefined {
  for (let p = first; p < first + 10; p++) {
    try {
      const server = Bun.serve({ hostname: "127.0.0.1", port: p, idleTimeout: 10, fetch: (req) => serveHook(req, { tokens, send }) });
      return { port: server.port ?? p, stop: () => void server.stop(true) };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function tailscale(args: string[]): Promise<string | undefined> {
  try {
    const p = Bun.spawn(["tailscale", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  } catch {
    return undefined;
  }
}

export async function funnel(port: number): Promise<[string | undefined, number | undefined]> {
  const text = await tailscale(["funnel", "status"]);
  if (text === undefined || !text.includes("Funnel on")) return [undefined, undefined];
  const p = funnelHooksPort(text);
  if (p === port) return [await funnelBase(), undefined];
  return [undefined, p];
}

export function funnelHooksPort(status: string): number | undefined {
  const line = status.split("\n").find((l) => l.includes("/hooks") && l.includes("proxy"));
  if (!line) return undefined;
  const i = line.indexOf("127.0.0.1:");
  if (i < 0) return undefined;
  const m = /^\d+/.exec(line.slice(i + "127.0.0.1:".length));
  if (!m) return undefined;
  const n = Number(m[0]);
  return n <= 65535 ? n : undefined;
}

async function funnelBase(): Promise<string | undefined> {
  const text = await tailscale(["status", "--json"]);
  const v = text === undefined ? undefined : parseJson(text);
  const self = isObject(v) ? v.Self : undefined;
  const dns = isObject(self) ? self.DNSName : undefined;
  return typeof dns === "string" && dns !== "" ? `https://${dns.replace(/\.+$/, "")}/hooks` : undefined;
}

export function funnelEnableCmd(port: number): string {
  return `tailscale funnel --bg --set-path /hooks http://127.0.0.1:${port}/hooks`;
}

export function funnelDisableCmd(): string {
  return "tailscale funnel --set-path /hooks off";
}
