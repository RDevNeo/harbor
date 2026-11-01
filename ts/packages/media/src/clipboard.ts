import { limits } from "@harbor/store";
import { type Decoded, decodeBytes } from "./images.ts";
import { sharpLib } from "./sharplib.ts";

const TEXT = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING", "TEXT"];
const IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const READ_TIMEOUT_MS = 1500;
const SAME_NOTICE_MS = 1000;
const PREVIEW = 60;

export type Clip = { type: "text"; text: string } | { type: "image"; bytes: Uint8Array };

interface Backend {
  list(): Promise<string[] | null>;
  get(type: string): Promise<Uint8Array | null>;
  set(type: string | null, data: Uint8Array): Promise<boolean>;
}

async function exec(cmd: string[], opts: { input?: Uint8Array; timeoutMs?: number } = {}): Promise<{ ok: boolean; out: Uint8Array } | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { env: process.env, stdin: opts.input ? "pipe" : "ignore", stdout: opts.input ? "ignore" : "pipe", stderr: "ignore" });
  } catch {
    return null;
  }
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs) : null;
  if (opts.input && proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write(opts.input);
    await proc.stdin.end();
  }
  const out = opts.input ? new Uint8Array() : new Uint8Array(await new Response(proc.stdout as ReadableStream).arrayBuffer());
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  if (proc.signalCode) return null;
  return { ok: code === 0, out };
}

const lines = (b: Uint8Array): string[] => Buffer.from(b).toString("utf8").split("\n").map((l) => l.trim());

const wayland: Backend = {
  async list() {
    const r = await exec(["wl-paste", "--list-types"], { timeoutMs: READ_TIMEOUT_MS });
    return r?.ok ? lines(r.out) : null;
  },
  async get(type) {
    const text = TEXT.includes(type) || type === "text/uri-list";
    const r = await exec(["wl-paste", ...(text ? ["--no-newline"] : []), "--type", type], { timeoutMs: READ_TIMEOUT_MS });
    return r?.ok ? r.out : null;
  },
  async set(type, data) {
    const r = await exec(["wl-copy", ...(type ? ["--type", type] : [])], { input: data });
    return r?.ok ?? false;
  },
};

const x11: Backend = {
  async list() {
    const r = await exec(["xclip", "-selection", "clipboard", "-o", "-t", "TARGETS"], { timeoutMs: READ_TIMEOUT_MS });
    return r?.ok ? lines(r.out) : null;
  },
  async get(type) {
    const r = await exec(["xclip", "-selection", "clipboard", "-o", "-t", type], { timeoutMs: READ_TIMEOUT_MS });
    return r?.ok ? r.out : null;
  },
  async set(type, data) {
    const r = await exec(["xclip", "-selection", "clipboard", "-i", "-t", type ?? "UTF8_STRING"], { input: data });
    return r?.ok ?? false;
  },
};

let chosen: Backend | null | undefined;

async function backend(): Promise<Backend | null> {
  if (chosen !== undefined) return chosen;
  if (process.env.WAYLAND_DISPLAY && (await exec(["wl-paste", "--version"]))?.ok) chosen = wayland;
  else if (process.env.DISPLAY && (await exec(["xclip", "-version"]))?.ok !== undefined) chosen = x11;
  else chosen = null;
  return chosen;
}

export function resetBackend(): void {
  chosen = undefined;
}

export async function read(): Promise<Clip | null> {
  const b = await backend();
  if (!b) return null;
  const types = await b.list();
  if (!types) return null;
  const t = TEXT.find((m) => types.includes(m));
  if (t) {
    const r = await b.get(t);
    return r ? { type: "text", text: Buffer.from(r).toString("utf8") } : null;
  }
  const i = IMAGES.find((m) => types.includes(m));
  if (i) {
    const r = await b.get(i);
    return r && r.length > 0 ? { type: "image", bytes: r } : null;
  }
  if (types.includes("text/uri-list")) {
    const r = await b.get("text/uri-list");
    return r ? { type: "text", text: Buffer.from(r).toString("utf8") } : null;
  }
  return null;
}

export async function copyText(text: string): Promise<void> {
  await (await backend())?.set(null, Buffer.from(text, "utf8"));
}

const isPng = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

export async function copyImage(bytes: Uint8Array): Promise<boolean> {
  let png: Uint8Array = bytes;
  if (!isPng(bytes)) {
    try {
      png = await (await sharpLib())(bytes).png().toBuffer();
    } catch {
      return false;
    }
  }
  return (await (await backend())?.set("image/png", png)) ?? false;
}

export function preview(text: string): string | null {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  if (first === undefined) return null;
  const chars = [...first];
  const s = chars.slice(0, PREVIEW).join("");
  return chars.length > PREVIEW || text.trim() !== first ? `${s}…` : s;
}

export function fresh(last: { body: string; at: number } | null, body: string, now: number): { show: boolean; last: { body: string; at: number } } {
  if (last && last.body === body && now - last.at < SAME_NOTICE_MS) return { show: false, last };
  return { show: true, last: { body, at: now } };
}

let lastNotice: { body: string; at: number } | null = null;

export function notice(body: string): void {
  const r = fresh(lastNotice, body, Date.now());
  lastNotice = r.last;
  if (r.show) limits.notify("Copied to clipboard", body);
}

export async function copyImageNoticed(bytes: Uint8Array): Promise<void> {
  if (await copyImage(bytes)) notice("Image");
}

export async function copyTextNoticed(text: string): Promise<void> {
  const p = preview(text);
  if (p) notice(p);
  await copyText(text);
}

export interface ClipKey {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type ClipAction = "paste" | "copy" | "cut";

export function shortcut(k: ClipKey, inTerminal: boolean, keepCopyKeys: boolean): ClipAction | null {
  const ctrl = k.ctrl && !k.alt;
  if (k.key === "Paste" || (ctrl && k.key === "V") || (k.shift && !k.ctrl && k.key === "Insert")) return "paste";
  if (keepCopyKeys && ctrl && (k.key === "C" || k.key === "X")) return null;
  if (k.key === "Copy" || (ctrl && k.key === "C" && !(k.shift && inTerminal)) || (ctrl && !k.shift && k.key === "Insert")) return "copy";
  if (k.key === "Cut" || (ctrl && !k.shift && k.key === "X")) return "cut";
  return null;
}

export async function readForPaste(): Promise<{ type: "text"; text: string } | { type: "image"; image: Decoded } | null> {
  const clip = await read();
  if (!clip) return null;
  if (clip.type === "text") return clip.text === "" ? null : { type: "text", text: clip.text.replaceAll("\r\n", "\n") };
  try {
    return { type: "image", image: (await decodeBytes(clip.bytes, 16384)).image };
  } catch {
    return null;
  }
}
