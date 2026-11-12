import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { limits } from "@harbor/store";
import type { Offer, OwnerIn, OwnerOut } from "./clipowner.ts";
// Its source, not its path: a compiled executable or a bundle has no clipowner.ts beside it.
import * as ownerText from "./clipowner.ts" with { type: "text" };
import { type Decoded, decodeBytes } from "./images.ts";
import { sharpLib } from "./sharplib.ts";
import { clipboard as osClipboard } from "@harbor/os";

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

/** The system's own clipboard through @harbor/os (macOS's pasteboard), by MIME type. */
const system: Backend = {
  list: async () => osClipboard.types(),
  get: async (type) => osClipboard.read(type),
  set: async (type, data) => osClipboard.write([{ mime: type ?? "text/plain;charset=utf-8", data }]) !== null,
};

let chosen: Backend | null | undefined;

async function backend(): Promise<Backend | null> {
  if (chosen !== undefined) return chosen;
  if (osClipboard.available()) chosen = system;
  else if (process.env.WAYLAND_DISPLAY && (await exec(["wl-paste", "--version"]))?.ok) chosen = wayland;
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

/** A message as it's copied: its text and its images (files on this PC), and which image each `[Image #k]` of
 * the text names (a user message's), so a paste into a composer gives them back. */
export interface RichCopy {
  text: string;
  images: string[];
  named: [number, string][];
}

const sniff = (b: Uint8Array): string | null => {
  const at = (s: string, off = 0) => [...s].every((ch, i) => b[off + i] === ch.charCodeAt(0));
  if (isPng(b)) return "image/png";
  if (at("\xFF\xD8\xFF")) return "image/jpeg";
  if (at("GIF87a") || at("GIF89a")) return "image/gif";
  if (b.length >= 12 && at("RIFF") && at("WEBP", 8)) return "image/webp";
  return null;
};

const escapeHtml = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Past this many bytes of images, the HTML names their files instead of holding them. */
const HTML_INLINE_MAX = 16 << 20;

/** What a copy offers, best first: the text (every name X11 and Wayland apps ask by), HTML with the text and its
 * images (rich editors, mail), the one image itself when there is just one (image editors, chat apps), and the
 * image files (file managers, browsers' file paste). `bytes` reads a file (null: unreadable, left out). */
export async function richOffers(copy: RichCopy, bytes: (path: string) => Uint8Array | null = readOr): Promise<Offer[]> {
  const out: Offer[] = [];
  const enc = new TextEncoder();
  if (copy.text !== "") {
    const t = enc.encode(copy.text);
    for (const m of TEXT) out.push({ mime: m, data: t });
  }
  const imgs: { path: string; data: Uint8Array; mime: string }[] = [];
  for (const path of copy.images) {
    const data = bytes(path);
    if (!data || data.length === 0) continue;
    let mime = sniff(data);
    let d = data;
    if (mime === null) {
      // An SVG or another kind sharp reads: as PNG.
      try {
        d = new Uint8Array(await (await sharpLib())(data).png().toBuffer());
        mime = "image/png";
      } catch {
        continue;
      }
    }
    imgs.push({ path, data: d, mime });
  }
  if (imgs.length === 0) return out;
  const inline = imgs.reduce((n, i) => n + i.data.length, 0) <= HTML_INLINE_MAX;
  const img = (i: (typeof imgs)[number]) => `<img src="${inline ? `data:${i.mime};base64,${Buffer.from(i.data).toString("base64")}` : escapeHtml(pathToFileURL(i.path).href)}">`;
  const para = copy.text === "" ? "" : `<p>${escapeHtml(copy.text).replaceAll("\n", "<br>")}</p>`;
  out.push({ mime: "text/html", data: enc.encode(`<meta charset="utf-8">${para}${imgs.map(img).join("")}`) });
  const one = imgs.length === 1 ? imgs[0] : undefined;
  if (one) {
    let png: Uint8Array | null = one.mime === "image/png" ? one.data : null;
    if (png === null) {
      try {
        png = new Uint8Array(await (await sharpLib())(one.data).png().toBuffer());
      } catch {
        png = null;
      }
    }
    if (png) out.push({ mime: "image/png", data: png });
    if (one.mime !== "image/png") out.push({ mime: one.mime, data: one.data });
  }
  out.push({ mime: "text/uri-list", data: enc.encode(imgs.map((i) => `${pathToFileURL(i.path).href}\r\n`).join("")) });
  return out;
}

function readOr(path: string): Uint8Array | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

let ownerUrl: string | null = null;
/** What holds this process's copy on the clipboard (Wayland: a Worker; macOS: the pasteboard's change count), and
 * that copy; null once another copy took it. */
let holder: { worker: Worker | null; token: number | null; copy: RichCopy } | null = null;
/** How long a Worker may take to own the clipboard. */
const OWN_MS = 3000;

/** The copy this process holds on the clipboard now, until another copy (any app's) replaces it. */
export function owned(): RichCopy | null {
  if (holder !== null && holder.token !== null && !osClipboard.stillOurs(holder.token)) holder = null;
  return holder?.copy ?? null;
}

/** Puts `offers` on the Wayland clipboard all at once (clipowner.ts); false when it can't (X11, a compositor without data-control). */
export function own(offers: Offer[], copy: RichCopy): Promise<boolean> {
  // macOS: the pasteboard takes every type at once, and keeps it after Harbor quits.
  if (osClipboard.available()) {
    const token = offers.length === 0 ? null : osClipboard.write(offers);
    if (token !== null) holder = { worker: null, token, copy };
    return Promise.resolve(token !== null);
  }
  const display = process.env.WAYLAND_DISPLAY ?? "";
  const runtime = process.env.XDG_RUNTIME_DIR ?? "";
  if (display === "" || (!display.startsWith("/") && runtime === "") || offers.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      ownerUrl ??= URL.createObjectURL(new Blob([(ownerText as unknown as { default: string }).default], { type: "application/typescript" }));
      worker = new Worker(ownerUrl);
    } catch {
      resolve(false);
      return;
    }
    worker.unref();
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const end = () => {
      if (holder?.worker === worker) holder = null;
      worker.terminate();
    };
    const timer = setTimeout(() => {
      settle(false);
      end();
    }, OWN_MS);
    worker.onerror = () => {
      settle(false);
      end();
    };
    worker.onmessage = (e: MessageEvent<OwnerOut>) => {
      if (e.data.t === "owned") {
        holder = { worker, token: null, copy };
        settle(true);
      } else {
        settle(false);
        end();
      }
    };
    worker.postMessage({ offers, display, runtime } satisfies OwnerIn);
  });
}

/** Copies a message with its images: every type at once on Wayland; false when that can't be done here
 * (the caller copies the text as before). */
export async function copyRich(copy: RichCopy): Promise<boolean> {
  return own(await richOffers(copy), copy);
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
