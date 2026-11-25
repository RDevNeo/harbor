// Pure helpers for the Gmail connection (ported from Person Hub's shell/gmail-core.cjs, itself after
// Harbor's gmail.ts): MIME building with In-Reply-To/References threading, message walking, header
// and charset handling, the account file, attachment URLs and Gmail's quota table. No I/O here.
import { createHash } from "node:crypto";
import type { Attachment, Message } from "../model/types.ts";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const b64url = (buf: Uint8Array | string): string => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64url = (s: unknown): Buffer => Buffer.from(String(s ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function header(part: unknown, name: string): string | undefined {
  const hs = obj(part).headers;
  if (!Array.isArray(hs)) return undefined;
  const h = hs.map(obj).find((x) => String(x.name ?? "").toLowerCase() === name.toLowerCase());
  return h ? String(h.value ?? "") : undefined;
}

/** "Ana <ana@x.com>" → "ana@x.com". */
export function addrEmail(a: unknown): string {
  const t = String(a ?? "").trim();
  const i = t.lastIndexOf("<");
  const j = t.lastIndexOf(">");
  return (i >= 0 && i < j ? t.slice(i + 1, j) : t).trim().toLowerCase();
}

/** Every address in a To/Cc header. */
export function addrList(s: unknown): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const c of String(s ?? "")) {
    if (c === '"') quoted = !quoted;
    else if (c === "<" && !quoted) angle = true;
    else if (c === ">" && !quoted) angle = false;
    else if ((c === "," || c === ";") && !quoted && !angle) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map(addrEmail).filter(Boolean);
}

export const isEmail = (s: unknown): s is string => typeof s === "string" && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(s.trim());

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Readable text from an HTML body (good enough for chat bubbles). */
export function htmlText(h: string): string {
  return decodeEntities(
    String(h)
      .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, "")
      // quoted history and signatures: Gmail/Outlook/Apple quote blocks and Gmail's signature block
      .replace(/<div[^>]*class="[^"]*\b(gmail_quote|gmail_signature|gmail_extra)\b[^"]*"[\s\S]*$/i, "")
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
      .replace(/<div[^>]*id="(appendonsend|divRplyFwdMsg)"[\s\S]*$/i, "")
      // links kept: "text (url)" unless the text is the url
      .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => {
        const text = t.replace(/<[^>]+>/g, "").trim();
        const url = decodeEntities(href);
        return !text || text === url || url.startsWith("mailto:") ? text || url : `${text} (${url})`;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  );
}

/**
 * The new part of a reply: drops the quoted history ("On … wrote:" / "Em … escreveu:" and
 * everything after, "> " lines, Gmail's forwarded markers) and trims blank lines.
 */
export function stripQuoted(text: unknown): string {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    const joined = `${l} ${lines[i + 1] ?? ""}`.trim();
    if (/^(On|Em|El|Le|Am)\b.{3,200}\b(wrote|escreveu|escribió|a écrit|schrieb):$/i.test(l.trim()) || /^(On|Em)\b.{3,200}\b(wrote|escreveu):$/i.test(joined)) break;
    if (/^-{2,}\s*(Original Message|Mensagem original|Forwarded message|Mensagem encaminhada)\s*-{2,}/i.test(l.trim())) break;
    if (/^>/.test(l)) continue;
    // signatures: the "-- " delimiter and the usual mobile footers end the new text
    if (l === "-- " || l === "--" || /^(Sent from my|Enviado do meu|Enviado de meu|Get Outlook for|Obter o Outlook para)\b/i.test(l.trim())) break;
    out.push(l.replace(/\s+$/, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface WalkedFile {
  name: string;
  type: string;
  size: number;
  attachmentId: string;
  inline?: string;
}

/** Text body and attachments of a Gmail message payload (multipart walked like Harbor's `walk`). */
export function walk(payload: unknown): { body: string; files: WalkedFile[] } {
  const text: string[] = [];
  const html: string[] = [];
  const files: WalkedFile[] = [];
  const visit = (pv: unknown): void => {
    const p = obj(pv);
    const parts = arr(p.parts);
    if (parts.length) {
      for (const q of parts) visit(q);
      return;
    }
    const mime = String(p.mimeType ?? "").toLowerCase();
    const name = String(p.filename ?? "");
    const body = obj(p.body);
    const disp = (header(p, "Content-Disposition") ?? "").trim().toLowerCase();
    if (name || disp.startsWith("attachment") || !(mime === "text/plain" || mime === "text/html")) {
      if (body.attachmentId || Number(body.size) > 0) {
        const f: WalkedFile = { name: name || "(unnamed)", type: mime, size: Number(body.size) || 0, attachmentId: String(body.attachmentId ?? "") };
        if (!body.attachmentId) f.inline = String(body.data ?? "");
        files.push(f);
      }
      return;
    }
    const data = unb64url(body.data).toString("utf8");
    (mime === "text/html" ? html : text).push(data);
  };
  visit(payload);
  const raw = text.some((t) => t.trim()) ? text.join("\n\n") : htmlText(html.join("\n"));
  return { body: raw, files };
}

/** A Gmail message in the app's shape, plus what threading and peers need (kept in the cache too). */
export interface Email extends Message {
  threadId: string;
  subject: string;
  messageIdHeader: string;
  references: string;
  to: string[];
  cc: string[];
  from: string;
}

/** The chmail:// URL of an attachment: what fetchAttachment takes back. */
export const attachmentUrl = (messageId: string, attachmentId: string, name: string, type: string): string =>
  `chmail://att/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;

/**
 * A Gmail message (format=full) → the conversation shape the app uses (like Discord messages, plus
 * subject and thread). `me` is the signed-in address; attachment URLs go through chmail://.
 */
export function slimEmail(mv: unknown, me: string | null): Email {
  const m = obj(mv);
  const p = obj(m.payload);
  const from = addrEmail(header(p, "From"));
  const labels = arr(m.labelIds);
  const fromMe = labels.includes("SENT") || (!!me && from === me.toLowerCase());
  const { body, files } = walk(p);
  const id = String(m.id);
  const out: Email = {
    id,
    channelId: String(m.threadId ?? ""),
    threadId: String(m.threadId ?? ""),
    authorId: from,
    fromMe,
    content: stripQuoted(body),
    timestamp: new Date(Number(m.internalDate) || Date.parse(header(p, "Date") ?? "") || 0).toISOString(),
    subject: header(p, "Subject") ?? "",
    messageIdHeader: header(p, "Message-ID") ?? header(p, "Message-Id") ?? "",
    references: header(p, "References") ?? "",
    to: addrList(header(p, "To")),
    cc: addrList(header(p, "Cc")),
    from,
    unread: labels.includes("UNREAD"),
  };
  const atts = files.filter((f) => f.attachmentId);
  if (atts.length) out.attachments = atts.map((f): Attachment => ({ name: f.name, type: f.type, size: f.size, url: attachmentUrl(id, f.attachmentId, f.name, f.type) }));
  return out;
}

/** Who a message is with, from my side: the other address (sender, or first recipient of mine). */
export function peerOf(msg: Pick<Email, "fromMe" | "from" | "to" | "cc"> | null | undefined, me: string | null): string {
  if (!msg) return "";
  if (!msg.fromMe) return msg.from;
  const others = [...(msg.to ?? []), ...(msg.cc ?? [])].filter((a) => a !== (me ?? "").toLowerCase());
  return others[0] ?? "";
}

/** The message involves this address (as sender or recipient). */
export const involves = (m: Pick<Email, "from" | "to" | "cc">, email: string): boolean => m.from === email || !!m.to?.includes(email) || !!m.cc?.includes(email);

// ---------- MIME (as Harbor's build()) ----------
const oneLine = (s: unknown): string => String(s ?? "").replace(/[\r\n]/g, " ");
const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

export function encodeWords(input: unknown): string {
  const s = oneLine(input);
  if (isAscii(s)) return s;
  const words: string[] = [];
  let chunk = "";
  for (const c of s) {
    if (Buffer.byteLength(chunk) + Buffer.byteLength(c) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += c;
  }
  words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}
const b64Lines = (data: Uint8Array): string => (Buffer.from(data).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
const leaf = (ctype: string, extra: string, data: Uint8Array): string => `Content-Type: ${ctype}\r\n${extra}Content-Transfer-Encoding: base64\r\n\r\n${b64Lines(data)}\r\n`;

export const reSubject = (s: unknown): string => {
  const t = String(s ?? "").trim();
  return /^re:/i.test(t) ? t : `Re: ${t}`;
};

export interface MimeFile {
  name: string;
  type: string;
  data: Uint8Array;
}

export interface MimeInput {
  to: string;
  subject: string;
  text: string;
  files?: MimeFile[];
  inReplyTo?: string;
  references?: string;
}

/** RFC 822 message: To, Subject, threading headers, a UTF-8 text body and attachments. */
export function buildMime({ to, subject, text, files = [], inReplyTo = "", references = "" }: MimeInput, boundary: string): string {
  let h = `To: ${oneLine(to)}\r\nSubject: ${encodeWords(subject)}\r\n`;
  if (inReplyTo) h += `In-Reply-To: ${oneLine(inReplyTo)}\r\nReferences: ${oneLine(references || inReplyTo)}\r\n`;
  h += "MIME-Version: 1.0\r\n";
  const plain = leaf("text/plain; charset=UTF-8", "", Buffer.from(String(text ?? "")));
  if (!files.length) return h + plain;
  const parts = [plain];
  for (const f of files) {
    const name = oneLine(f.name).replace(/"/g, "'");
    const disp = isAscii(name) ? `Content-Disposition: attachment; filename="${name}"\r\n` : `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(name)}\r\n`;
    parts.push(leaf(`${f.type || "application/octet-stream"}; name="${encodeWords(name)}"`, disp, f.data));
  }
  return `${h}Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.map((p) => `--${boundary}\r\n${p}`).join("")}--${boundary}--\r\n`;
}

// ---------- files ----------

/** A file name safe to write in a folder and to show. */
export function safeFileName(name: unknown, fallback = "file"): string {
  const s = [...String(name ?? "")]
    .filter((c) => c.charCodeAt(0) >= 32)
    .join("")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return s || fallback;
}

export const isMime = (t: unknown): t is string => typeof t === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(t);

export interface AttRef {
  mid: string;
  aid: string;
  name: string;
  type: string;
}

/** A chmail://att/<message id>/<attachment id>?name=&type= URL, checked. */
export function parseAtt(url: string): AttRef {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Not a mail attachment");
  }
  if (u.protocol !== "chmail:" || u.host !== "att") throw new Error("Not a mail attachment");
  const [, mid = "", aid = ""] = u.pathname.split("/").map((x) => decodeURIComponent(x));
  if (!/^[\w-]{6,64}$/.test(mid) || !/^[\w-]{8,4096}$/.test(aid)) throw new Error("Not a mail attachment");
  return { mid, aid, name: u.searchParams.get("name") || "attachment", type: u.searchParams.get("type") || "application/octet-stream" };
}

/** Where an attachment is kept: <message id>-<hash of the attachment id>-<name>. */
export const attFileName = (a: AttRef, name?: string): string => `${a.mid}-${createHash("sha256").update(a.aid).digest("hex").slice(0, 12)}-${safeFileName(name || a.name, "attachment")}`;

// ---------- the account file (Person Hub's gmail-account*.json) ----------

/** The account file names: the original "gmail" connection keeps Person Hub's unsuffixed ones. */
export const fileSuffix = (id: string): string => (id === "gmail" ? "" : `-${id}`);

export type AccountRead =
  | { kind: "ok"; refresh: string; me: string; historyId: string | null; scopes: string }
  /** Sealed with Electron's safeStorage, which Hub can't open: the user signs in again. */
  | { kind: "sealed"; me: string }
  | { kind: "none" };

/** `{ version, account, refresh_token: { enc: 'none' | 'safeStorage', data }, history_id, scopes }`. */
export function readAccount(j: unknown): AccountRead {
  const a = obj(j);
  const t = obj(a.refresh_token);
  const me = typeof a.account === "string" ? a.account.toLowerCase() : "";
  if (!me) return { kind: "none" };
  if (t.enc === "safeStorage") return { kind: "sealed", me };
  const tok = t.enc === "none" || t.enc === undefined ? t.data : undefined;
  if (typeof tok !== "string" || tok === "") return { kind: "none" };
  return { kind: "ok", refresh: tok, me, historyId: typeof a.history_id === "string" && a.history_id ? a.history_id : null, scopes: String(a.scopes ?? "") };
}

export const accountJson = (me: string, refresh: string, historyId: string | null, scopes: string): string =>
  JSON.stringify({ version: 1, account: me, refresh_token: { enc: "none", data: refresh }, history_id: historyId, scopes });

// ---------- quota: Gmail allows 15,000 units/min per user ----------

const COST: [RegExp, number][] = [
  [/^\/messages\/send/, 100],
  [/^\/messages\/batchModify/, 50],
  [/^\/messages\/[^/]+\/modify/, 5],
  [/^\/threads\?/, 10],
  [/^\/threads\//, 10],
  [/^\/history/, 2],
  [/^\/profile/, 1],
  [/^\/messages\/[^/]+\/attachments/, 5],
  [/^\/messages/, 5],
];
export const costOf = (p: string): number => COST.find(([re]) => re.test(p))?.[1] ?? 5;

/** How long a 429 pauses calls: Retry-After, else 10 s doubling (step 1, 2, …) up to 5 min. */
export const coolMs = (retryAfter: string | null, step: number): number => {
  const ra = Number(retryAfter);
  return Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(10_000 * 2 ** (step - 1), 5 * 60_000);
};

/** "…=s96-c" → "…=s128-c": Google photo URLs take their size at the end. */
export const sizedPhoto = (url: string): string => String(url).replace(/=s\d+(-[a-z]+)*$/, "=s128-c");

/** Merges messages into a conversation by id (newer copies win), oldest first, at most `keep`. Null when nothing changed. */
export function mergeMessages<T extends { id: string; timestamp: string }>(list: readonly T[], msgs: readonly T[], keep: number): T[] | null {
  const map = new Map(list.map((m) => [m.id, m]));
  let changed = false;
  for (const m of msgs) {
    const prev = map.get(m.id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(m)) {
      map.set(m.id, m);
      changed = true;
    }
  }
  if (!changed) return null;
  return [...map.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-keep);
}
