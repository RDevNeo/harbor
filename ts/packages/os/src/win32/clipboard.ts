// Windows' clipboard, by MIME type (user32 through bun:ffi). Loaded only on Windows. Images go on it as
// PNG and as a bitmap (CF_DIB, for apps that only read that), files as CF_HDROP, HTML as "HTML Format".
import { ptr, toArrayBuffer } from "bun:ffi";
import { bytesAt, hiddenWindow, kernel32, pointer, user32, wide } from "./gui.ts";
import { decodeCfHtml, decodeDib, decodeHdrop, decodePng, encodeCfHtml, encodeDib, encodeHdrop, encodePng, pathsOfUriList, uriListOfPaths } from "./formats.ts";

const CF_UNICODETEXT = 13;
const CF_DIB = 8;
const CF_HDROP = 15;
const CF_DIBV5 = 17;
const GMEM_MOVEABLE = 0x2;

const TEXT = new Set(["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT"]);

let registered: { png: number; html: number } | undefined;
function formats(): { png: number; html: number } {
  return (registered ??= {
    png: user32().RegisterClipboardFormatW(ptr(wide("PNG"))),
    html: user32().RegisterClipboardFormatW(ptr(wide("HTML Format"))),
  });
}

/** A private clipboard by name (tests: never the user's), formats to bytes. */
const privates = new Map<string, { seq: number; data: Map<number, Uint8Array> }>();

/** Runs `f` with the clipboard open; null when another app holds it for long. */
function opened<T>(f: () => T): T | null {
  for (let i = 0; i < 5; i++) {
    if (user32().OpenClipboard(hiddenWindow()) !== 0) {
      try {
        return f();
      } finally {
        user32().CloseClipboard();
      }
    }
    Bun.sleepSync(5);
  }
  return null;
}

function present(name?: string): Set<number> {
  if (name !== undefined) return new Set(privates.get(name)?.data.keys() ?? []);
  return (
    opened(() => {
      const out = new Set<number>();
      for (let f = user32().EnumClipboardFormats(0); f !== 0; f = user32().EnumClipboardFormats(f)) out.add(f);
      return out;
    }) ?? new Set()
  );
}

/** One format's bytes; the clipboard must be open (or `name` a private one). */
function get(format: number, name?: string): Uint8Array | null {
  if (name !== undefined) return privates.get(name)?.data.get(format) ?? null;
  const h = pointer(user32().GetClipboardData(format));
  if (h === null) return null;
  const p = pointer(kernel32().GlobalLock(h));
  if (p === null) return null;
  try {
    return bytesAt(p, Number(kernel32().GlobalSize(h)));
  } finally {
    kernel32().GlobalUnlock(h);
  }
}

/** The MIME types on the clipboard now. */
export function types(name?: string): string[] {
  const f = present(name);
  const { png, html } = formats();
  const out: string[] = [];
  if (f.has(CF_UNICODETEXT)) out.push("text/plain;charset=utf-8");
  if (f.has(html)) out.push("text/html");
  if (f.has(png) || f.has(CF_DIB) || f.has(CF_DIBV5)) out.push("image/png");
  if (f.has(CF_HDROP)) out.push("text/uri-list");
  return out;
}

const read1 = (mime: string, name?: string): Uint8Array | null => {
  const { png, html } = formats();
  if (TEXT.has(mime)) {
    const b = get(CF_UNICODETEXT, name);
    return b === null ? null : new Uint8Array(Buffer.from(Buffer.from(b).toString("utf16le").replace(/\0[\s\S]*$/, ""), "utf8"));
  }
  if (mime === "text/html") {
    const b = get(html, name);
    return b === null ? null : new Uint8Array(Buffer.from(decodeCfHtml(b), "utf8"));
  }
  if (mime === "image/png") {
    const p = get(png, name);
    if (p !== null && p.length > 0) return p;
    const dib = get(CF_DIBV5, name) ?? get(CF_DIB, name);
    const px = dib === null ? null : decodeDib(dib);
    return px === null ? null : encodePng(px.rgba, px.w, px.h);
  }
  if (mime === "text/uri-list") {
    const b = get(CF_HDROP, name);
    return b === null ? null : new Uint8Array(Buffer.from(uriListOfPaths(decodeHdrop(b)), "utf8"));
  }
  return null;
};

/** The clipboard's data of one MIME type; null when it has none. */
export function read(mime: string, name?: string): Uint8Array | null {
  return name !== undefined ? read1(mime, name) : opened(() => read1(mime));
}

/** What `offers` put on the clipboard, format by format (the first offer of each format wins). */
export function plan(offers: readonly { mime: string; data: Uint8Array }[], f: { png: number; html: number }): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  const put = (format: number, data: Uint8Array): void => {
    if (!out.has(format)) out.set(format, data);
  };
  for (const o of offers) {
    if (TEXT.has(o.mime)) put(CF_UNICODETEXT, new Uint8Array(Buffer.from(`${Buffer.from(o.data).toString("utf8")}\0`, "utf16le")));
    else if (o.mime === "text/html") put(f.html, encodeCfHtml(Buffer.from(o.data).toString("utf8")));
    else if (o.mime === "image/png") {
      put(f.png, o.data);
      const px = out.has(CF_DIB) ? null : decodePng(o.data);
      if (px !== null) put(CF_DIB, encodeDib(px));
    } else if (o.mime === "text/uri-list") {
      const paths = pathsOfUriList(Buffer.from(o.data).toString("utf8"));
      if (paths.length > 0) put(CF_HDROP, encodeHdrop(paths));
    }
  }
  return out;
}

/** Puts every offer on the clipboard at once; a token that `changeCount` matches while it's still there, or null. */
export function write(offers: readonly { mime: string; data: Uint8Array }[], name?: string): number | null {
  const items = plan(offers, formats());
  if (items.size === 0) return null;
  if (name !== undefined) {
    const seq = (privates.get(name)?.seq ?? 0) + 1;
    privates.set(name, { seq, data: items });
    return seq;
  }
  const ok = opened(() => {
    if (user32().EmptyClipboard() === 0) return false;
    let any = false;
    for (const [format, data] of items) {
      const h = pointer(kernel32().GlobalAlloc(GMEM_MOVEABLE, Math.max(1, data.length)));
      if (h === null) continue;
      const p = pointer(kernel32().GlobalLock(h));
      if (p === null) {
        kernel32().GlobalFree(h);
        continue;
      }
      new Uint8Array(toArrayBuffer(p, 0, data.length)).set(data);
      kernel32().GlobalUnlock(h);
      // The clipboard owns the memory once it takes it; free it only when it didn't.
      if (user32().SetClipboardData(format, h) === null) kernel32().GlobalFree(h);
      else any = true;
    }
    return any;
  });
  return ok ? changeCount() : null;
}

/** Changes whenever any app puts something on the clipboard. */
export function changeCount(name?: string): number {
  return name !== undefined ? (privates.get(name)?.seq ?? 0) : user32().GetClipboardSequenceNumber();
}
