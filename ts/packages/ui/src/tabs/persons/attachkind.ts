// The composer's attachments as preview tiles (PAttach): each file's kind by its extension (a picture, video, audio,
// PDF or other file), the type's icon and colour for the tile without a picture, and the line under its name
// ("MP4 · 0:42 · 12.3 MB", "PDF · 3 pages · 812 KB").
import type { GlyphName } from "@harbor/net";

export type AttachKind = "image" | "video" | "audio" | "pdf" | "file";

export interface AttachType {
  kind: AttachKind;
  /** The extension, upper case ("PDF"); "" without one. */
  ext: string;
  icon: GlyphName;
  /** The type's colour (#rrggbb): the icon and its tile's tint. */
  tint: string;
  /** Pictures sharp decodes itself; the other pictures (BMP, HEIC…) go through ffmpeg for their still. */
  direct: boolean;
}

/** Pictures sharp (the image decoder) reads directly. */
const SHARP = ["png", "jpg", "jpeg", "jfif", "gif", "webp", "avif", "tif", "tiff", "svg"];
/** Pictures only ffmpeg reads (where it was built with them). */
const FFMPEG_PICS = ["bmp", "heic", "heif", "ico", "jxl", "tga"];
const VIDEO = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "3gp", "mpg", "mpeg", "mpv", "ogv", "wmv", "flv", "ts", "mts", "m2ts"];
const AUDIO = ["mp3", "ogg", "oga", "opus", "wav", "m4a", "aac", "flac", "wma", "amr", "weba", "aiff"];

const BLUE = "#3b82f6";
const GREEN = "#16a34a";
const ORANGE = "#ea580c";
const PURPLE = "#8b5cf6";
const RED = "#dc2626";
const PINK = "#db2777";
const AMBER = "#d97706";
const TEAL = "#0d9488";
const GRAY = "#6b7280";

/** Other files: their icon and colour by extension. */
const FILES: [string[], GlyphName, string][] = [
  [["doc", "docx", "odt", "rtf", "pages"], "FILE_TEXT", BLUE],
  [["xls", "xlsx", "ods", "csv", "tsv", "numbers"], "FILE_TEXT", GREEN],
  [["ppt", "pptx", "odp", "key"], "FILE_TEXT", ORANGE],
  [["txt", "md", "log"], "FILE_TEXT", GRAY],
  [["json", "xml", "yaml", "yml", "html", "htm", "css", "js", "ts", "py", "sql", "sh"], "FILE_CODE", TEAL],
  [["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"], "ARCHIVE", AMBER],
  [["apk", "aab", "ipa"], "SMARTPHONE", GREEN],
  [["psd", "ai", "fig", "sketch", "xcf"], "FILE_IMAGE", PINK],
];

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** A file's kind, icon and colour by its name. */
export function attachType(name: string): AttachType {
  const e = extOf(name);
  const ext = e.toUpperCase();
  if (SHARP.includes(e)) return { kind: "image", ext, icon: "FILE_IMAGE", tint: PINK, direct: true };
  if (FFMPEG_PICS.includes(e)) return { kind: "image", ext, icon: "FILE_IMAGE", tint: PINK, direct: false };
  if (VIDEO.includes(e)) return { kind: "video", ext, icon: "VIDEO", tint: PURPLE, direct: false };
  if (AUDIO.includes(e)) return { kind: "audio", ext, icon: "VOLUME", tint: ORANGE, direct: false };
  if (e === "pdf") return { kind: "pdf", ext, icon: "FILE_TEXT", tint: RED, direct: false };
  const hit = FILES.find(([exts]) => exts.includes(e));
  return { kind: "file", ext, icon: hit?.[1] ?? "FILE", tint: hit?.[2] ?? GRAY, direct: false };
}

/** Extensions by MIME type, for files whose name has none (a WhatsApp document, an email part). */
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/vnd.rar": "rar",
  "application/x-7z-compressed": "7z",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.android.package-archive": "apk",
  "text/csv": "csv",
  "text/plain": "txt",
  "application/json": "json",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
};

/** A received file's kind, icon and colour: by its name's extension, else by its MIME type. */
export function attachTypeOf(name: string, mime?: string | null): AttachType {
  if (extOf(name)) return attachType(name);
  const e = MIME_EXT[(mime ?? "").split(";")[0]!.trim().toLowerCase()];
  return attachType(e ? `file.${e}` : name);
}

/** A size as people read it: "980 B", "812 KB", "12.3 MB", "1.2 GB". */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** A length as a player shows it: "0:07", "4:32", "1:02:05". */
export function lengthText(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The line under a tile's name: its type, length or pages, and size, each when known. */
export function attachMeta(t: AttachType, o: { size?: number | null; duration?: number | null; pages?: number | null }): string {
  const parts: string[] = [];
  if (t.ext) parts.push(t.ext);
  if (o.duration) parts.push(lengthText(o.duration));
  if (o.pages) parts.push(o.pages === 1 ? "1 page" : `${o.pages} pages`);
  if (o.size != null) parts.push(sizeText(o.size));
  return parts.join(" · ");
}

