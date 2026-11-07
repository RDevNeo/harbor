// The WhatsApp app (a linked device of the user's personal account): `harbor app whatsapp`, the
// MCP server an agent's turn runs, relays tool calls to the host (whatsapphost.ts), which starts
// when needed. Also what the Settings card, the hub's phone routes and the app's keeper use.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import type { Pending } from "./apps.ts";
import { selfCommand } from "./discordsetup.ts";
import * as setup from "./whatsappsetup.ts";
import { phoneOf } from "./whatsappstore.ts";
import { INSTRUCTIONS, tools } from "./whatsapptools.ts";

export const NAME = setup.NAME;
export const HOST = setup.HOST;
export { INSTRUCTIONS };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One request to the host, if it's running. */
export function ask(req: Obj, waitMs: number, sock = setup.socket()): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const s = createConnection({ path: sock });
    let buf = "";
    let done = false;
    const finish = (f: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      f();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("WhatsApp didn't answer in time."))), waitMs);
    const answer = (): void => {
      let v: Obj;
      try {
        v = obj(JSON.parse(buf));
      } catch {
        return finish(() => reject(new Error("WhatsApp's host stopped.")));
      }
      if (v.ok === true) finish(() => resolve(v.result ?? null));
      else finish(() => reject(new Error(str(v.error) ?? "WhatsApp failed.")));
    };
    s.setEncoding("utf8");
    s.once("connect", () => s.write(`${JSON.stringify(req)}\n`));
    s.on("data", (d: string) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        buf = buf.slice(0, i);
        answer();
      }
    });
    s.once("end", answer);
    s.once("error", (e) => finish(() => reject(e)));
  });
}

const canConnect = (sock = setup.socket()): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createConnection({ path: sock });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });

/** Starts the host, detached, with only what it needs of this process's environment. */
function spawnHost(): void {
  const cmd = selfCommand();
  const exe = cmd?.[0];
  if (cmd === undefined || exe === undefined) throw new Error("Can't find Harbor's binary.");
  const log = openSync(setup.logPath(), "a", 0o600);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (["HOME", "PATH", "LANG", "TZ", "HARBOR_DATA_DIR", "HARBOR_HOME", "SSL_CERT_FILE"].includes(k) || k.startsWith("XDG_") || k.startsWith("HARBOR_WHATSAPP_"))) env[k] = v;
  }
  try {
    const child = spawn(exe, [...cmd.slice(1), "app", HOST], { env, detached: true, stdio: ["ignore", "ignore", log] });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** One request to the host, started if it wasn't. */
export async function request(req: Obj, waitMs: number): Promise<unknown> {
  if (!(await canConnect())) {
    spawnHost();
    const until = Date.now() + 15_000;
    while (!(await canConnect())) {
      if (Date.now() > until) throw new Error("WhatsApp's host didn't start.");
      await sleep(50);
    }
  }
  return ask(req, waitMs);
}

/**
 * A link with no WhatsApp, for screenshots (scripts/shot --env HARBOR_FAKE_WHATSAPP=…): "qr" and
 * "code" show a link waiting for the phone (a made-up code), "linked" a linked account; "rig"
 * starts unlinked and follows Link, Get a code and Cancel (the phone rig, ts/rig/phonehub.ts).
 */
const fakeMode = (): string | undefined => {
  const m = process.env.HARBOR_FAKE_WHATSAPP || undefined;
  return m === "rig" ? rigMode : m;
};
let fakeCode: string | undefined;
let rigMode = "idle";

function fakeStatus(mode: string): Obj {
  if (mode === "idle") return { phase: "idle", linked: false, account: null, pairing: null, error: null, sync: "", busy: 0 };
  const linkedNow = mode === "linked";
  const code = mode === "code" ? "K7QX-2M9P" : fakeCode;
  return {
    phase: linkedNow ? "open" : "pairing",
    linked: linkedNow,
    account: linkedNow ? { jid: "15550100000@s.whatsapp.net", name: "Sam" } : null,
    pairing: linkedNow
      ? null
      : {
          qr: "https://wa.me/settings/linked_devices#2@not-a-real-link-code-made-up-for-a-screenshot",
          code: code ?? null,
          note: code !== undefined ? "Enter the code on your phone \u{b7} 5:42 left" : "Scan with WhatsApp",
          // A made-up Brazilian number (no mobile there starts with 1): the hint and its other form.
          left: code !== undefined ? "5:42" : null,
          hint: code !== undefined ? "Didn't link? Some Brazilian numbers are on WhatsApp without the 9 after the area code: try +55 11 1234 5678." : null,
          retry: code !== undefined ? { phone: "+551112345678", label: "Try without the 9" } : null,
        },
    error: null,
    sync: "",
    busy: 0,
  };
}

export const signedIn = (): boolean => (fakeMode() !== undefined ? fakeMode() === "linked" : setup.linked() !== undefined);

export function accountName(): string | undefined {
  if (fakeMode() === "linked") return "Sam (+15550100000)";
  const l = setup.linked();
  if (l === undefined) return undefined;
  const phone = phoneOf(l.jid);
  return l.name !== "" ? (phone !== undefined ? `${l.name} (${phone})` : l.name) : (phone ?? l.jid);
}

/** The host's status, or what's known without it. Doesn't start anything. */
export async function status(): Promise<Obj> {
  const f = fakeMode();
  if (f !== undefined) return fakeStatus(f);
  try {
    return obj(await ask({ op: "status" }, 3000));
  } catch {
    const l = setup.linked();
    return { phase: "stopped", linked: l !== undefined, account: l === undefined ? null : { jid: l.jid, name: l.name }, pairing: null, error: null, sync: "", busy: 0 };
  }
}

export type CardLine = { text: string; tone: 0 | 1 | 2 };

/** The card's line, the same on the desktop and the phone (the hub sends it). Tone 1: in progress, 2: trouble. */
export function cardLine(s: Obj, about: string): CardLine {
  const p = obj(s.pairing);
  if (s.pairing !== null && s.pairing !== undefined) return { text: str(p.note) ?? "Linking…", tone: 1 };
  const err = str(s.error);
  const acct = obj(s.account);
  if (s.linked !== true) return err !== undefined ? { text: err, tone: 2 } : { text: about, tone: 0 };
  const jid = str(acct.jid) ?? "";
  const who = `Linked as ${str(acct.name) ?? phoneOf(jid) ?? "you"}`;
  switch (str(s.phase)) {
    case "open":
      return { text: str(s.sync) !== undefined ? `${who} · Syncing chats (${String(s.sync)})` : `${who} · Connected`, tone: 0 };
    case "connecting":
    case "installing":
      return { text: `${who} · Connecting…`, tone: 1 };
    case "closed":
      return { text: `${who} · Offline, retrying`, tone: 2 };
    default:
      return { text: `${who} · Starts with Harbor`, tone: 0 };
  }
}

let lastCard: { at: number; s: Obj | undefined } | undefined;

/** The card's line, read off the UI thread every few seconds: answers from the last look. */
export function card(about: string, changed: () => void = () => {}): CardLine {
  if (lastCard === undefined || Date.now() - lastCard.at > 4000) {
    lastCard = { at: Date.now(), s: lastCard?.s };
    void status().then((s) => {
      lastCard = { at: lastCard?.at ?? Date.now(), s };
      changed();
    });
  }
  return lastCard.s === undefined ? { text: signedIn() ? `Linked as ${accountName() ?? "you"}` : about, tone: 0 } : cardLine(lastCard.s, about);
}

const SHORT = 60_000;
/** A code: the first link may install the engine, and the code gets a new link of its own (and a second number for Brazil). */
const CODE_WAIT = 180_000;

/** Starts a link on this PC; with `phone`, also asks for a code to type on that phone. */
export async function link(phone?: string): Promise<Obj> {
  if (process.env.HARBOR_FAKE_WHATSAPP === "rig") rigMode = "qr";
  const f = fakeMode();
  if (f !== undefined) return fakeStatus(f);
  return obj(await request(phone === undefined ? { op: "link" } : { op: "link", phone }, SHORT));
}

/** A code to type on the phone instead of scanning (WhatsApp › Linked devices › Link with phone number). */
export async function code(phone: string): Promise<Obj> {
  const f = fakeMode();
  if (f !== undefined) {
    fakeCode = "K7QX-2M9P";
    return fakeStatus(f);
  }
  return obj(await request({ op: "code", phone }, CODE_WAIT));
}

/** Back from a code to the QR and the number field: a different number, or the QR after all. */
export async function uncode(): Promise<Obj> {
  if (process.env.HARBOR_FAKE_WHATSAPP === "rig") fakeCode = undefined;
  const f = fakeMode();
  if (f !== undefined) return fakeStatus(f);
  return obj(await ask({ op: "uncode" }, 5000));
}

export async function cancel(): Promise<void> {
  if (process.env.HARBOR_FAKE_WHATSAPP === "rig") {
    rigMode = "idle";
    fakeCode = undefined;
    return;
  }
  await ask({ op: "cancel" }, 15_000).catch(() => {});
}

/** Unlinks: WhatsApp drops this device and what Harbor stored of the account goes. */
export async function unlink(): Promise<void> {
  if (await canConnect()) await ask({ op: "signout" }, 30_000);
  else {
    await request({ op: "signout" }, 30_000);
  }
}

export function signOut(): void {
  void unlink().catch(() => {});
}

/** The Settings card's link: follows the host until linked, putting the QR and code in `Pending`. */
export async function login(signal: AbortSignal, update: (p: Pending) => void): Promise<void> {
  await link();
  for (;;) {
    await sleep(400);
    if (signal.aborted) {
      await cancel();
      throw new Error("Linking was cancelled.");
    }
    if (signedIn()) return;
    const s = await status();
    const p = obj(s.pairing);
    if (s.pairing === null || s.pairing === undefined) {
      if (signedIn()) return;
      throw new Error(str(s.error) ?? "Linking stopped.");
    }
    const out: Pending = {};
    const qr = str(p.qr);
    const c = str(p.code);
    const note = str(p.note);
    const hint = str(p.hint);
    const retry = obj(p.retry);
    if (qr !== undefined) out.qr = qr;
    if (c !== undefined) out.code = c;
    if (note !== undefined) out.note = note;
    if (hint !== undefined) out.hint = hint;
    const left = str(p.left);
    if (left !== undefined) out.left = left;
    if (str(retry.phone) !== undefined) out.retry = { phone: str(retry.phone) ?? "", label: str(retry.label) ?? "Try again" };
    update(out);
  }
}

/**
 * The app's keeper: a linked PC keeps its host (and so its link) running, so messages are stored
 * as they come and WhatsApp doesn't drop an idle device; the host's notices become Harbor
 * notifications. Returns what stops it.
 */
export function keep(notify: (n: { key: string; title: string; body: string }) => void, everyMs = 60_000): () => void {
  const look = (): void => {
    readNotices(notify);
    if (!signedIn()) return;
    void canConnect().then((up) => {
      if (!up && signedIn()) {
        try {
          spawnHost();
        } catch {
          // the next look tries again
        }
      }
    });
  };
  const first = setTimeout(look, 5000);
  const timer = setInterval(look, everyMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

function readNotices(notify: (n: { key: string; title: string; body: string }) => void): void {
  const p = setup.noticesPath();
  if (!existsSync(p)) return;
  let text = "";
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return;
  }
  rmSync(p, { force: true });
  for (const l of text.split("\n")) {
    try {
      const n = obj(JSON.parse(l));
      notify({ key: str(n.key) ?? "whatsapp", title: str(n.title) ?? "WhatsApp", body: str(n.body) ?? "" });
    } catch {
      // a partial line
    }
  }
}

const NOT_LINKED = "WhatsApp isn't linked on this PC. The user links it in Harbor: Settings › Integrations › WhatsApp (desktop) or Settings › Apps › WhatsApp (phone).";
const WAIT = 700_000;
const MAX_TEXT = 80_000;

export async function call(name: string, args: unknown): Promise<Obj> {
  if (!signedIn()) {
    if (!(await canConnect())) return { content: [{ type: "text", text: NOT_LINKED }], isError: name !== "status" };
  }
  try {
    const r = obj(await request({ op: "call", name, args: args ?? {} }, WAIT));
    const content = Array.isArray(r.content) ? r.content.map(obj) : [];
    for (const c of content) if (typeof c.text === "string" && c.text.length > MAX_TEXT) c.text = `${c.text.slice(0, MAX_TEXT)}\n…[cut: narrow the request]`;
    return { content, isError: r.isError === true };
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

/** Serves the tools on `input`/`output` until the agent's turn ends; calls run side by side (a wait mustn't hold the rest). */
export function serve(input: Readable, output: Writable, version = "0"): Promise<void> {
  const reply = (body: Obj): void => {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
  };
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    let req: Obj;
    try {
      req = obj(JSON.parse(line));
    } catch {
      return;
    }
    if (!("id" in req)) return;
    const id = req.id ?? null;
    const params = obj(req.params);
    switch (str(req.method) ?? "") {
      case "initialize":
        reply({ id, result: { protocolVersion: str(params.protocolVersion) ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: NAME, version }, instructions: INSTRUCTIONS } });
        break;
      case "tools/list":
        reply({ id, result: { tools: tools() } });
        break;
      case "tools/call":
        void call(str(params.name) ?? "", params.arguments).then((r) => reply({ id, result: r }));
        break;
      case "ping":
        reply({ id, result: {} });
        break;
      default:
        reply({ id, error: { code: -32601, message: "unknown method" } });
    }
  });
  return new Promise((resolve) => lines.once("close", () => resolve()));
}

/** `harbor app whatsapp`. */
export const run = (version?: string): Promise<void> => serve(process.stdin, process.stdout, version);
