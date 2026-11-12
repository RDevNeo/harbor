// macOS's general pasteboard (NSPasteboard), by MIME type. Loaded only on macOS.
import { call, call1, callBool2, callI64, cls, items, jsBytes, jsString, nsData, nsString, pool, type Id } from "./darwin-objc.ts";

/** MIME types as the pasteboard names them. Text has one type there, whatever name X11 gave it. */
const UTI: Record<string, string> = {
  "text/plain;charset=utf-8": "public.utf8-plain-text",
  UTF8_STRING: "public.utf8-plain-text",
  "text/plain": "public.utf8-plain-text",
  STRING: "public.utf8-plain-text",
  TEXT: "public.utf8-plain-text",
  "text/html": "public.html",
  "image/png": "public.png",
  "image/jpeg": "public.jpeg",
  "image/gif": "com.compuserve.gif",
  "image/webp": "org.webmproject.webp",
  "text/uri-list": "public.file-url",
};
const MIME: Record<string, string> = {
  "public.utf8-plain-text": "text/plain;charset=utf-8",
  "public.html": "text/html",
  "public.png": "image/png",
  "public.jpeg": "image/jpeg",
  "com.compuserve.gif": "image/gif",
  "org.webmproject.webp": "image/webp",
  "public.file-url": "text/uri-list",
};

/** The general pasteboard, or one of the given name (tests: a private one, never the user's). */
function board(name?: string): Id {
  const c = cls("NSPasteboard");
  return name === undefined ? call(c, "generalPasteboard") : call1(c, "pasteboardWithName:", nsString(name));
}

/** The MIME types on the pasteboard now. */
export function types(name?: string): string[] {
  return pool(() => {
    const out: string[] = [];
    for (const t of items(call(board(name), "types"))) {
      const m = MIME[jsString(t)];
      if (m !== undefined && !out.includes(m)) out.push(m);
    }
    return out;
  });
}

/** The pasteboard's data of one MIME type; null when it has none. */
export function read(mime: string, name?: string): Uint8Array | null {
  const uti = UTI[mime];
  if (uti === undefined) return null;
  return pool(() => {
    const d = call1(board(name), "dataForType:", nsString(uti));
    if (d === null) return null;
    const b = jsBytes(d);
    // A file URL comes back as one URL; Harbor's callers read a uri-list.
    return mime === "text/uri-list" ? Buffer.from(`${Buffer.from(b).toString("utf8")}\r\n`) : b;
  });
}

/**
 * Replaces the pasteboard's content with every one of `offers` at once (the first of each pasteboard
 * type wins; a uri-list gives its first file). The pasteboard's change count after it, or null when it failed.
 */
export function write(offers: readonly { mime: string; data: Uint8Array }[], name?: string): number | null {
  return pool(() => {
    const pb = board(name);
    callI64(pb, "clearContents");
    const done = new Set<string>();
    let ok = true;
    for (const o of offers) {
      const uti = UTI[o.mime];
      if (uti === undefined || done.has(uti)) continue;
      done.add(uti);
      let data = o.data;
      if (o.mime === "text/uri-list") data = Buffer.from(Buffer.from(o.data).toString("utf8").split(/\r?\n/).find((l) => l !== "" && !l.startsWith("#")) ?? "");
      if (!callBool2(pb, "setData:forType:", nsData(data), nsString(uti))) ok = false;
    }
    return ok ? callI64(pb, "changeCount") : null;
  });
}

/** The pasteboard's change count: it moves whenever any app copies. */
export function changeCount(name?: string): number {
  return pool(() => callI64(board(name), "changeCount"));
}
