import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { cost, randomHex } from "@harbor/store";
import { enc, freshTokenFor, googleAccounts } from "./mcp.ts";

export const NAME = "gmail";
export const VERSION = "0.108.0";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const RAW_MAX = 4 << 20;
const PARALLEL = 8;
const SYSTEM = ["INBOX", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT"];
const SIGN_IN = "Gmail isn't signed in. The user can sign in under Settings › Integrations › Apps in Harbor (desktop) or Settings › Apps (phone).";

type Obj = Record<string, unknown>;
export type Label = [id: string, name: string];

export class GmailError extends Error {}

const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const at = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((x, k) => obj(x)[k], v);
const uint = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const fail = (msg: string): never => {
  throw new GmailError(msg);
};

const s = (d: string): Obj => ({ type: "string", description: d });
const int = (d: string): Obj => ({ type: "integer", description: d });
const flag = (d: string): Obj => ({ type: "boolean", description: d });
const list = (d: string): Obj => ({ type: "array", items: { type: "string" }, description: d });

function tool(name: string, description: string, properties: Obj, required: string[]): Obj {
  return { name, description, inputSchema: { type: "object", properties, required } };
}

function mailProps(extra: Obj): Obj {
  return {
    to: s('Recipients, comma-separated ("Ana <ana@example.com>, bo@example.com")'),
    cc: s("Cc recipients, comma-separated"),
    bcc: s("Bcc recipients, comma-separated"),
    subject: s('Subject (a reply defaults to "Re: " + the original\'s)'),
    body: s("Plain-text body"),
    html: s("HTML body (optional; the plain text goes along as the alternative)"),
    attachments: list("Paths of files to attach, on the PC that runs Harbor"),
    reply_to: s("Id of the message this answers: threads it into that conversation and fills recipients and subject when not given"),
    reply_all: flag("With reply_to: also copy the original's other recipients"),
    ...extra,
  };
}

function labelProps(extra: Obj): Obj {
  return {
    move_to: s('Label to move to, like moving to a folder: adds it and takes the mail out of the inbox ("INBOX" moves it back)'),
    add_labels: list("Labels to add, by name or id"),
    remove_labels: list("Labels to remove, by name or id"),
    archive: flag("true: take out of the inbox"),
    read: flag("true: mark read; false: mark unread"),
    starred: flag("true: star; false: unstar"),
    ...extra,
  };
}

export function tools(): Obj[] {
  const v = [
    tool(
      "search",
      "Search the user's Gmail with Gmail's search syntax: from:, to:, subject:, is:unread, is:starred, has:attachment, label:, in:inbox, in:sent, newer_than:7d, after:2026/01/31, \"exact phrase\", OR, -word. Newest first: ids, date, sender, subject, labels and a snippet. threads: true lists whole conversations instead of single messages.",
      {
        query: s("Gmail search query (empty: everything but spam and trash)"),
        max_results: int("How many (default 20, at most 100)"),
        page_token: s("The page_token a previous search returned, for the next page"),
        threads: flag("List conversations instead of messages"),
        include_spam_trash: flag("Also search spam and trash"),
      },
      [],
    ),
    tool(
      "get_message",
      "Read one message: headers, labels, its text (the plain-text part, or the HTML as text) and its attachments with the ids get_attachment needs.",
      { id: s("Message id"), max_chars: int("Longest body returned (default 20000)") },
      ["id"],
    ),
    tool(
      "get_thread",
      "Read a whole conversation, oldest message first, each shown as get_message shows it.",
      { id: s("Thread id"), max_chars: int("Longest body returned per message (default 8000)") },
      ["id"],
    ),
    tool(
      "get_attachment",
      "Save an attachment to a file on the PC that runs Harbor and return its path. Pass the filename get_message listed with it.",
      {
        message_id: s("Message id"),
        attachment_id: s("The attachment_id get_message listed"),
        filename: s("The attachment's filename"),
        path: s("File or folder to save to (default: a harbor-gmail folder in the temp dir)"),
      },
      ["message_id", "attachment_id"],
    ),
    tool(
      "send",
      "Send an email from the user's Gmail. To answer in the same conversation pass reply_to (the message id you answer): recipients, subject and threading come from it unless given. Only send what the user asked for; when unsure, save_draft instead.",
      mailProps({}),
      [],
    ),
    tool("save_draft", "Save a draft the user can review in Gmail, or replace draft_id's content. Same fields as send.", mailProps({ draft_id: s("Draft to replace (from list_drafts or an earlier save_draft)") }), []),
    tool("list_drafts", "The user's drafts: draft id, recipients, subject, snippet.", { query: s("Gmail search query to filter them"), max_results: int("How many (default 20, at most 100)") }, []),
    tool("send_draft", "Send a saved draft as it is.", { draft_id: s("Draft id") }, ["draft_id"]),
    tool("delete_draft", "Delete a draft for good.", { draft_id: s("Draft id") }, ["draft_id"]),
    tool(
      "modify",
      "Change labels on messages, or on whole conversations with threads: true: move_to a label (like moving to a folder), archive, mark read or unread, star or unstar, add or remove labels by name or id. Up to 1000 ids at once.",
      labelProps({ ids: list("Message ids (thread ids with threads: true)"), threads: flag("The ids are conversations") }),
      ["ids"],
    ),
    tool(
      "trash",
      "Move messages, or whole conversations with threads: true, to the trash; undo: true takes them back out. Gmail empties the trash after 30 days.",
      { ids: list("Message ids (thread ids with threads: true)"), threads: flag("The ids are conversations"), undo: flag("Take them out of the trash") },
      ["ids"],
    ),
    tool(
      "list_labels",
      "The user's labels and Gmail's system labels with their ids, and the signed-in address. counts: true adds how many messages each has and how many are unread.",
      { counts: flag("Also count messages per label (slower)") },
      [],
    ),
    tool(
      "edit_label",
      'Create, rename or delete one of the user\'s labels. Nested labels use a slash: "Clients/Acme". Deleting a label keeps its messages.',
      {
        action: { type: "string", enum: ["create", "rename", "delete"], description: "What to do" },
        label: s("The label's name (or id, to rename or delete)"),
        new_name: s("For rename: the new name"),
      },
      ["action", "label"],
    ),
    tool(
      "filters",
      "Gmail filters, which sort incoming mail: list them, create one (criteria from, to, subject, query, has_attachment; actions move_to, add_labels, remove_labels, archive, read, starred, forward) or delete one by id.",
      labelProps({
        action: { type: "string", enum: ["list", "create", "delete"], description: "What to do" },
        id: s("For delete: the filter's id"),
        from: s("Criteria: sender"),
        to: s("Criteria: recipient"),
        subject: s("Criteria: words in the subject"),
        query: s("Criteria: a Gmail search query"),
        has_attachment: flag("Criteria: only mail with attachments"),
        forward: s("Action: forward to this address (it must be a verified forwarding address in Gmail)"),
      }),
      ["action"],
    ),
  ];
  for (const t of v) {
    const all = t.name === "search" ? '; "all" searches every account' : "";
    obj(at(t, "inputSchema", "properties")).account = s(`Gmail account to use, by address (default: the default account; see accounts)${all}`);
  }
  v.push(tool("accounts", "The Gmail accounts connected in Harbor, the default (what tools use without account) first.", {}, []));
  return v;
}

export function need(a: Obj, k: string): string {
  const v = str(a[k])?.trim();
  return v ? v : fail(`Pass ${k}.`);
}

export function opt(a: Obj, k: string): string {
  return str(a[k])?.trim() ?? "";
}

export function strs(a: Obj, k: string): string[] {
  const v = a[k];
  const items = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? v.split(",") : [];
  return items.map((x) => x.trim()).filter((x) => x !== "");
}

export function addrs(a: Obj, k: string): string {
  const v = a[k];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x !== "").join(", ");
  return typeof v === "string" ? v.trim() : "";
}

function maxChars(a: Obj, fallback: number): number {
  return Math.max(uint(a.max_chars) ?? fallback, 200);
}

function count(a: Obj): number {
  return Math.min(Math.max(uint(a.max_results) ?? 20, 1), 100);
}

export function resolve(asked: string, accounts: string[]): string {
  const first = accounts[0];
  if (first === undefined) return fail(SIGN_IN);
  const want = asked.trim();
  if (want === "") return first;
  const found = accounts.find((e) => e.toLowerCase() === want.toLowerCase());
  return found ?? fail(`No Gmail account ${want} is connected. Connected: ${accounts.join(", ")}. Leave account out for the default (${first}).`);
}

export function listAccounts(accounts: string[]): string {
  const first = accounts[0];
  if (first === undefined) return fail(SIGN_IN);
  let out = `${accounts.length} Gmail account${accounts.length === 1 ? "" : "s"} connected; tools use ${first} unless you pass account:\n`;
  accounts.forEach((e, i) => {
    out += `- ${e}${i === 0 ? " (default)" : ""}\n`;
  });
  return out;
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function header(part: unknown, name: string): string | undefined {
  const want = name.toLowerCase();
  const h = arr(obj(part).headers).find((h) => str(obj(h).name)?.toLowerCase() === want);
  return str(obj(h).value);
}

function labelNames(ids: unknown, labels: Label[]): string {
  return arr(ids)
    .filter((i): i is string => typeof i === "string")
    .map((i) => labels.find(([id]) => id === i)?.[1] ?? i)
    .join(", ");
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", zwnj: "", zwj: "", shy: "",
};

function reference(name: string): string | undefined {
  const named = NAMED[name];
  if (named !== undefined) return named;
  if (!name.startsWith("#")) return undefined;
  const n = name.slice(1);
  const hex = /^[xX]/.test(n);
  const digits = hex ? n.slice(1) : n;
  if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return undefined;
  const code = Number.parseInt(digits, hex ? 16 : 10);
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  return String.fromCodePoint(code);
}

export function entities(s: string): string {
  let out = "";
  let rest = s;
  for (;;) {
    const i = rest.indexOf("&");
    if (i < 0) break;
    out += rest.slice(0, i);
    rest = rest.slice(i);
    const end = rest.slice(0, 12).indexOf(";");
    const decoded = end > 0 ? reference(rest.slice(1, end)) : undefined;
    if (decoded === undefined) {
      out += "&";
      rest = rest.slice(1);
    } else {
      out += decoded;
      rest = rest.slice(end + 1);
    }
  }
  return out + rest;
}

function attr(tag: string, name: string): string | undefined {
  const lower = asciiLower(tag);
  let from = 0;
  for (;;) {
    const i = lower.indexOf(name, from);
    if (i < 0) return undefined;
    from = i + name.length;
    const beforeOk = i === 0 || /\s/.test(lower.charAt(i - 1));
    const rest = tag.slice(from).trimStart();
    if (!beforeOk || !rest.startsWith("=")) continue;
    const value = rest.slice(1).trimStart();
    const q = value.charAt(0);
    const v = q === '"' || q === "'" ? (value.slice(1).split(q)[0] ?? "") : (value.split(/[\s>]/)[0] ?? "");
    return entities(v);
  }
}

const BLOCKS = new Set(["p", "div", "tr", "table", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section", "article", "header", "footer", "hr"]);

export function htmlText(h: string): string {
  let out = "";
  let rest = h;
  let link: [string, number] | undefined;
  const push = (t: string): void => {
    out += t.replace(/[\r\n\t]/g, " ");
  };
  for (;;) {
    const lt = rest.indexOf("<");
    if (lt < 0) break;
    push(rest.slice(0, lt));
    const after = rest.slice(lt + 1);
    if (after.startsWith("!--")) {
      const c = after.slice(3);
      const e = c.indexOf("-->");
      rest = e < 0 ? "" : c.slice(e + 3);
      continue;
    }
    const gt = after.indexOf(">");
    if (gt < 0) {
      rest = "";
      break;
    }
    const tag = after.slice(0, gt);
    rest = after.slice(gt + 1);
    const lower = asciiLower(tag);
    const closing = lower.startsWith("/");
    const name = lower.replace(/^\/+/, "").split(/[\s/]/)[0] ?? "";
    if (!closing && ["script", "style", "head", "title"].includes(name)) {
      const e = asciiLower(rest).indexOf(`</${name}`);
      rest = e < 0 ? "" : rest.slice(e);
    } else if (name === "br" || BLOCKS.has(name)) {
      out += "\n";
    } else if (name === "li" && !closing) {
      out += "\n- ";
    } else if ((name === "td" || name === "th") && closing) {
      out += " ";
    } else if (name === "a" && !closing) {
      const u = attr(tag, "href");
      link = u === undefined ? undefined : [u, out.length];
    } else if (name === "a" && link) {
      const [u, from] = link;
      link = undefined;
      const shown = out.slice(from).trim();
      if (u !== "" && !u.startsWith("#") && !u.startsWith("mailto:") && shown !== u) out += ` (${u})`;
    }
  }
  push(rest);
  return entities(out);
}

export function tidy(t: string): string {
  const out: string[] = [];
  for (const raw of t.split("\n")) {
    const line = raw
      .replace(/\r$/, "")
      .replace(/[​‌‍͏﻿­]/g, "")
      .split(/[  ]/)
      .filter((w) => w !== "")
      .join(" ");
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

export function clip(t: string, max: number): string {
  const chars = [...t];
  if (chars.length <= max) return t;
  return `${chars.slice(0, max).join("")}\n[… ${chars.length - max} more characters: pass a larger max_chars to read them]`;
}

export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${Math.floor(n / 1024)} KB`;
  return `${cost.fixed(n / 1_048_576, 1)} MB`;
}

export function charset(ctype: string): string {
  for (const p of ctype.split(";")) {
    const eq = p.trim().indexOf("=");
    if (eq < 0) continue;
    const t = p.trim();
    if (t.slice(0, eq).trim().toLowerCase() === "charset") return t.slice(eq + 1).trim().replace(/^"+|"+$/g, "").toLowerCase();
  }
  return "utf-8";
}

const LATIN1 = ["iso-8859-1", "latin1", "latin-1", "windows-1252", "cp1252", "iso-8859-15"];

function decodeCharset(data: Uint8Array, cs: string): string {
  if (LATIN1.includes(cs)) return Array.from(data, (b) => String.fromCharCode(b)).join("");
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(data);
}

export function safeName(n: string): string {
  const clean = n.replace(/[/\\\p{Cc}]/gu, "_").trim().replace(/^\.+/, "");
  return clean === "" ? "attachment" : clean;
}

export function b64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

export function b64url(data: Uint8Array): string {
  return b64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of s) {
    const v = /[A-Za-z0-9+\-/_]/.test(c) ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(c === "-" ? "+" : c === "_" ? "/" : c) : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

export interface Attachment {
  name: string;
  mime: string;
  size: number;
  id: string;
}

export class Parts {
  text: string[] = [];
  html: string[] = [];
  files: Attachment[] = [];

  body(): string {
    const t = this.text.some((x) => x.trim() !== "") ? this.text.join("\n\n") : htmlText(this.html.join("\n"));
    return tidy(t);
  }
}

export function walk(p: unknown, out: Parts): void {
  const parts = obj(p).parts;
  if (Array.isArray(parts)) {
    for (const q of parts) walk(q, out);
    return;
  }
  const mime = asciiLower(str(obj(p).mimeType) ?? "");
  const name = str(obj(p).filename) ?? "";
  const body = obj(obj(p).body);
  const disposition = asciiLower((header(p, "Content-Disposition") ?? "").trimStart());
  if (name !== "" || disposition.startsWith("attachment") || !(mime === "text/plain" || mime === "text/html")) {
    const id = str(body.attachmentId) ?? "";
    const bytes = uint(body.size) ?? 0;
    if (id !== "" || bytes > 0) out.files.push({ name: name === "" ? "(unnamed)" : name, mime, size: bytes, id });
    return;
  }
  const text = decodeCharset(unb64(str(body.data) ?? ""), charset(header(p, "Content-Type") ?? ""));
  (mime === "text/html" ? out.html : out.text).push(text);
}

export function showMessage(v: unknown, labels: Label[], max: number): string {
  const p = obj(v).payload;
  let s = `Message ${str(obj(v).id) ?? "?"} (thread ${str(obj(v).threadId) ?? "?"}) [${labelNames(obj(v).labelIds, labels)}]\n`;
  for (const h of ["From", "Reply-To", "To", "Cc", "Date", "Subject"]) {
    const x = header(p, h);
    if (x !== undefined) s += `${h}: ${x}\n`;
  }
  const parts = new Parts();
  walk(p, parts);
  if (parts.files.length > 0) {
    s += "Attachments:\n";
    for (const f of parts.files) s += `- ${f.name} (${f.mime}, ${size(f.size)}) attachment_id: ${f.id === "" ? "(inline, none)" : f.id}\n`;
  }
  return `${s}\n${clip(parts.body(), max)}\n`;
}

function messageLine(v: unknown, labels: Label[]): string {
  const p = obj(v).payload;
  return `- ${str(obj(v).id) ?? "?"} (thread ${str(obj(v).threadId) ?? "?"}) ${header(p, "Date") ?? ""}\n  ${header(p, "From") ?? "?"}: ${header(p, "Subject") ?? "(no subject)"} [${labelNames(obj(v).labelIds, labels)}]\n  ${entities(str(obj(v).snippet) ?? "")}\n`;
}

function threadLine(v: unknown, labels: Label[]): string {
  const msgs = arr(obj(v).messages);
  const first = msgs[0];
  const last = msgs[msgs.length - 1];
  if (first === undefined || last === undefined) return `- thread ${str(obj(v).id) ?? "?"}: empty\n`;
  const ids = new Set<unknown>();
  for (const m of msgs) for (const l of arr(obj(m).labelIds)) ids.add(l);
  const lp = obj(last).payload;
  return `- thread ${str(obj(v).id) ?? "?"}, ${msgs.length} message${msgs.length === 1 ? "" : "s"}, last ${header(lp, "Date") ?? ""}\n  ${header(lp, "From") ?? "?"}: ${header(obj(first).payload, "Subject") ?? "(no subject)"} [${labelNames([...ids], labels)}]\n  ${entities(str(obj(last).snippet) ?? "")}\n`;
}

export interface Mail {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html: string;
  files: { name: string; mime: string; data: Uint8Array }[];
  inReplyTo: string;
  references: string;
  thread: string;
}

export function blankMail(over: Partial<Mail> = {}): Mail {
  return { to: "", cc: "", bcc: "", subject: "", text: "", html: "", files: [], inReplyTo: "", references: "", thread: "", ...over };
}

export function reSubject(s: string): string {
  const t = s.trim();
  return t.toLowerCase().startsWith("re:") ? t : `Re: ${t}`;
}

export function splitAddrs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const c of s) {
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
  return out.map((a) => a.trim()).filter((a) => a !== "");
}

export function addrEmail(a: string): string {
  const t = a.trim();
  const i = t.lastIndexOf("<");
  const j = t.lastIndexOf(">");
  return (i >= 0 && i < j ? t.slice(i + 1, j) : t).trim().toLowerCase();
}

export function replyAllCc(me: string, to: string, others: string, cc: string): string {
  const seen = splitAddrs(to).map(addrEmail);
  seen.push(me.toLowerCase());
  const out: string[] = [];
  for (const a of [...splitAddrs(cc), ...splitAddrs(others)]) {
    const e = addrEmail(a);
    if (e === "" || seen.includes(e)) continue;
    seen.push(e);
    out.push(a);
  }
  return out.join(", ");
}

const MIME: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", txt: "text/plain", log: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html",
  htm: "text/html", json: "application/json", xml: "application/xml", zip: "application/zip", ics: "text/calendar",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg", mp4: "video/mp4", mov: "video/quicktime",
};

export function mimeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 ? MIME[name.slice(dot + 1).toLowerCase()] : undefined) ?? "application/octet-stream";
}

const oneLine = (s: string): string => s.replace(/[\r\n]/g, " ");
const isAscii = (s: string): boolean => /^[\x00-\x7f]*$/.test(s);

export function encodeWords(input: string): string {
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
  return words.map((w) => `=?UTF-8?B?${b64(Buffer.from(w))}?=`).join("\r\n ");
}

function encodeAddrs(s: string): string {
  return splitAddrs(oneLine(s))
    .map((a) => {
      const i = a.lastIndexOf("<");
      if (i < 0 || isAscii(a)) return a;
      return `${encodeWords(a.slice(0, i).trim().replace(/^"+|"+$/g, ""))} ${a.slice(i)}`;
    })
    .join(", ");
}

function b64Lines(data: Uint8Array): string {
  return (b64(data).match(/.{1,76}/g) ?? []).join("\r\n");
}

function leaf(ctype: string, extra: string, data: Uint8Array): string {
  return `Content-Type: ${ctype}\r\n${extra}Content-Transfer-Encoding: base64\r\n\r\n${b64Lines(data)}\r\n`;
}

function multipart(kind: string, boundary: string, parts: string[]): string {
  const body = parts.map((p) => `--${boundary}\r\n${p}`).join("");
  return `Content-Type: multipart/${kind}; boundary="${boundary}"\r\n\r\n${body}--${boundary}--\r\n`;
}

export function build(m: Mail, boundary: string): string {
  let h = "";
  for (const [k, v] of [["To", m.to], ["Cc", m.cc], ["Bcc", m.bcc]] as const) {
    if (v.trim() !== "") h += `${k}: ${encodeAddrs(v)}\r\n`;
  }
  h += `Subject: ${encodeWords(m.subject)}\r\n`;
  if (m.inReplyTo !== "") h += `In-Reply-To: ${oneLine(m.inReplyTo)}\r\nReferences: ${oneLine(m.references)}\r\n`;
  h += "MIME-Version: 1.0\r\n";
  const text = m.text === "" && m.html !== "" ? tidy(htmlText(m.html)) : m.text;
  const plain = leaf("text/plain; charset=UTF-8", "", Buffer.from(text));
  const body = m.html === "" ? plain : multipart("alternative", `${boundary}-alt`, [plain, leaf("text/html; charset=UTF-8", "", Buffer.from(m.html))]);
  if (m.files.length === 0) return h + body;
  const parts = [body];
  for (const f of m.files) {
    const name = oneLine(f.name).replace(/"/g, "'");
    const disp = isAscii(name) ? `Content-Disposition: attachment; filename="${name}"\r\n` : `Content-Disposition: attachment; filename*=UTF-8''${enc(name)}\r\n`;
    parts.push(leaf(`${f.mime}; name="${encodeWords(name)}"`, disp, f.data));
  }
  return h + multipart("mixed", `${boundary}-mix`, parts);
}

const boundary = (): string => `harbor-${randomHex(12)}`;

export function labelId(n: string, labels: Label[]): string {
  const name = n.trim();
  const exact = labels.find(([id]) => id === name);
  if (exact) return exact[0];
  const low = name.toLowerCase();
  const loose = labels.find(([id, label]) => label.toLowerCase() === low || id.toLowerCase() === low);
  if (loose) return loose[0];
  const up = name.toUpperCase();
  if (SYSTEM.includes(up) || up.startsWith("CATEGORY_")) return up;
  return fail(`No label ${JSON.stringify(name)}. See list_labels, or create it with edit_label.`);
}

const dedup = (v: string[]): string[] => v.filter((x, i) => v.indexOf(x) === i);

export function plan(a: Obj, labels: Label[]): [add: string[], remove: string[]] {
  const add: string[] = [];
  const rm: string[] = [];
  for (const n of strs(a, "add_labels")) add.push(labelId(n, labels));
  for (const n of strs(a, "remove_labels")) rm.push(labelId(n, labels));
  const to = opt(a, "move_to");
  if (to !== "") {
    const id = labelId(to, labels);
    if (id === "TRASH") fail("To move mail to the trash, use trash.");
    if (id !== "INBOX") rm.push("INBOX");
    add.push(id);
  }
  if (a.archive === true) rm.push("INBOX");
  if (a.read === true) rm.push("UNREAD");
  else if (a.read === false) add.push("UNREAD");
  if (a.starred === true) add.push("STARRED");
  else if (a.starred === false) rm.push("STARRED");
  const adds = dedup(add);
  const rms = dedup(rm);
  const both = adds.find((x) => rms.includes(x));
  if (both !== undefined) fail(`${labelNames([both], labels)} would be both added and removed.`);
  return [adds, rms];
}

export function describe(add: string[], rm: string[], labels: Label[]): string {
  return [...add.map((i) => `+${labelNames([i], labels)}`), ...rm.map((i) => `-${labelNames([i], labels)}`)].join(", ");
}

export interface Auth {
  accounts(): string[] | Promise<string[]>;
  token(email: string, force: boolean): string | null | undefined | Promise<string | null | undefined>;
}

export interface Options {
  auth: Auth;
  api?: string;
  upload?: string;
  version?: string;
  attachmentDir?: string;
}

type Body = { type: string; data: Uint8Array | string };
type Settled<T> = { ok: true; v: T } | { ok: false; e: string };

async function each<T, R>(items: T[], f: (x: T) => Promise<R>): Promise<Settled<R>[]> {
  const out: Settled<R>[] = items.map(() => ({ ok: false, e: "not fetched" }));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        out[i] = { ok: true, v: await f(items[i] as T) };
      } catch (e) {
        out[i] = { ok: false, e: e instanceof Error ? e.message : String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return out;
}

async function send(token: string, method: string, url: string, body?: Body): Promise<[number, unknown]> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body) headers["Content-Type"] = body.type;
  else if (method !== "GET" && method !== "DELETE") headers["Content-Length"] = "0";
  let res: Response;
  try {
    res = await fetch(url, { method, headers, ...(body ? { body: body.data } : {}), signal: AbortSignal.timeout(300_000) });
  } catch (e) {
    return fail(`Gmail didn't answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  try {
    return [res.status, JSON.parse(text)];
  } catch {
    return [res.status, null];
  }
}

function apiMessage(v: unknown): string {
  return str(at(v, "error", "message")) ?? str(obj(v).error_description) ?? str(obj(v).error) ?? "";
}

export async function profileEmail(token: string, api: string = API): Promise<string> {
  const [code, v] = await send(token, "GET", `${api}/profile`);
  if (code < 200 || code >= 300) return fail(`Gmail: ${str(at(v, "error", "message")) ?? ""} (${code})`);
  return str(obj(v).emailAddress) ?? fail("Gmail sent no address.");
}

export class Gmail {
  readonly api: string;
  readonly upload: string;
  private readonly cache = new Map<string, { at: number; labels: Label[] }>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(readonly opts: Options) {
    this.api = opts.api ?? API;
    this.upload = opts.upload ?? UPLOAD;
  }

  async callTool(name: string, args: unknown): Promise<{ ok: boolean; text: string }> {
    try {
      return { ok: true, text: await this.dispatch(name, obj(args)) };
    } catch (e) {
      return { ok: false, text: e instanceof GmailError ? e.message : `Gmail: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async dispatch(name: string, a: Obj): Promise<string> {
    const accounts = await this.opts.auth.accounts();
    if (name === "accounts") return listAccounts(accounts);
    if (name === "search" && opt(a, "account").toLowerCase() === "all") {
      if (accounts.length === 0) return fail(SIGN_IN);
      let out = "";
      for (const e of accounts) {
        const text = await new Mailbox(this, e).search(a).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
        out += `## ${e}\n${text}\n`;
      }
      return out;
    }
    const box = new Mailbox(this, resolve(opt(a, "account"), accounts));
    switch (name) {
      case "search": return box.search(a);
      case "get_message": return box.getMessage(a);
      case "get_thread": return box.getThread(a);
      case "get_attachment": return box.getAttachment(a);
      case "send": return box.sendMail(a);
      case "save_draft": return box.saveDraft(a);
      case "list_drafts": return box.listDrafts(a);
      case "send_draft": {
        const v = await box.call("POST", "/drafts/send", { id: need(a, "draft_id") });
        return `Sent the draft (message ${str(obj(v).id) ?? "?"}, thread ${str(obj(v).threadId) ?? "?"}).`;
      }
      case "delete_draft": {
        const id = need(a, "draft_id");
        await box.call("DELETE", `/drafts/${enc(id)}`);
        return `Deleted draft ${id}.`;
      }
      case "modify": return box.modify(a);
      case "trash": return box.trash(a);
      case "list_labels": return box.listLabels(a);
      case "edit_label": return box.editLabel(a);
      case "filters": return box.filters(a);
      default: return fail(`No tool ${name}.`);
    }
  }

  async token(account: string, failed: string | null): Promise<string> {
    const run = async (): Promise<string> => {
      const gone = (): never => fail(`The sign-in of ${account} has expired or was revoked. Sign in to it again in Harbor (Settings › Integrations › Apps).`);
      let tok = (await this.opts.auth.token(account, false)) ?? gone();
      if (failed === tok) tok = (await this.opts.auth.token(account, true)) ?? gone();
      return tok;
    };
    const turn = this.lock.then(run, run);
    this.lock = turn.catch(() => undefined);
    return turn;
  }

  cachedLabels(account: string): Label[] | undefined {
    const c = this.cache.get(account);
    return c && Date.now() - c.at < 60_000 ? c.labels : undefined;
  }

  keepLabels(account: string, labels: Label[]): void {
    this.cache.set(account, { at: Date.now(), labels });
  }

  forgetLabels(account: string): void {
    this.cache.delete(account);
  }
}

class Mailbox {
  constructor(
    private readonly g: Gmail,
    readonly account: string,
  ) {}

  private me(): string {
    return this.account.toLowerCase();
  }

  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.request(method, `${this.g.api}${path}`, body === undefined ? undefined : { type: "application/json", data: JSON.stringify(body) });
  }

  private async request(method: string, url: string, body?: Body): Promise<unknown> {
    let failed: string | null = null;
    for (;;) {
      const tok = await this.g.token(this.account, failed);
      const [code, v] = await send(tok, method, url, body);
      if (code === 401 && failed === null) {
        failed = tok;
        continue;
      }
      if (code >= 200 && code < 300) return v;
      if (code === 401) {
        return fail(`Gmail refused the sign-in of ${this.account} (${apiMessage(v)}). Sign in to it again in Harbor (Settings › Integrations › Apps).`);
      }
      return fail(`Gmail: ${apiMessage(v)} (${code})`);
    }
  }

  async labels(): Promise<Label[]> {
    const hit = this.g.cachedLabels(this.account);
    if (hit) return hit;
    try {
      const v = await this.call("GET", "/labels");
      const l = arr(obj(v).labels).flatMap((x): Label[] => {
        const id = str(obj(x).id);
        const name = str(obj(x).name);
        return id !== undefined && name !== undefined ? [[id, name]] : [];
      });
      this.g.keepLabels(this.account, l);
      return l;
    } catch {
      return [];
    }
  }

  async search(a: Obj): Promise<string> {
    const q = opt(a, "query");
    const threads = a.threads === true;
    const kind = threads ? "threads" : "messages";
    let path = `/${kind}?maxResults=${count(a)}&q=${enc(q)}`;
    if (opt(a, "page_token") !== "") path += `&pageToken=${enc(opt(a, "page_token"))}`;
    if (a.include_spam_trash === true) path += "&includeSpamTrash=true";
    const found = await this.call("GET", path);
    const ids = arr(obj(found)[kind]).flatMap((x) => str(obj(x).id) ?? []);
    if (ids.length === 0) return `No ${kind} match ${JSON.stringify(q)}.`;
    const meta = "format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date";
    const items = await each(ids, (id) => this.call("GET", `/${kind}/${id}?${meta}`));
    const labels = await this.labels();
    let out = `${ids.length} ${kind}${q === "" ? "" : ` for ${JSON.stringify(q)}`}:\n`;
    ids.forEach((id, i) => {
      const r = items[i] as Settled<unknown>;
      out += r.ok ? (threads ? threadLine(r.v, labels) : messageLine(r.v, labels)) : `- ${id}: ${r.e}\n`;
    });
    const next = str(obj(found).nextPageToken);
    if (next !== undefined) out += `More: page_token ${next}\n`;
    return out;
  }

  async getMessage(a: Obj): Promise<string> {
    const v = await this.call("GET", `/messages/${enc(need(a, "id"))}?format=full`);
    return showMessage(v, await this.labels(), maxChars(a, 20_000));
  }

  async getThread(a: Obj): Promise<string> {
    const v = await this.call("GET", `/threads/${enc(need(a, "id"))}?format=full`);
    const labels = await this.labels();
    const msgs = arr(obj(v).messages);
    const max = maxChars(a, 8_000);
    return `Thread ${str(obj(v).id) ?? "?"}: ${msgs.length} message${msgs.length === 1 ? "" : "s"}\n\n${msgs.map((m) => showMessage(m, labels, max)).join("\n---\n\n")}`;
  }

  async getAttachment(a: Obj): Promise<string> {
    const [mid, aid] = [need(a, "message_id"), need(a, "attachment_id")];
    const v = await this.call("GET", `/messages/${enc(mid)}/attachments/${enc(aid)}`);
    const data = unb64(str(obj(v).data) ?? "");
    const name = safeName(opt(a, "filename"));
    let path: string;
    const given = opt(a, "path");
    if (given === "") {
      const d = join(this.g.opts.attachmentDir ?? tmpdir(), "harbor-gmail");
      mkdirSync(d, { recursive: true });
      path = join(d, name);
    } else {
      path = isDir(given) ? join(given, name) : given;
    }
    try {
      writeFileSync(path, data);
    } catch (e) {
      return fail(`Can't write ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return `Saved ${name} (${size(data.length)}) to ${path}`;
  }

  private async compose(a: Obj): Promise<Mail> {
    const m = blankMail({ to: addrs(a, "to"), cc: addrs(a, "cc"), bcc: addrs(a, "bcc"), subject: opt(a, "subject"), text: str(a.body) ?? "", html: str(a.html) ?? "" });
    const reply = opt(a, "reply_to");
    if (reply !== "") {
      const hs = ["From", "Reply-To", "To", "Cc", "Subject", "Message-ID", "References"].map((h) => `metadataHeaders=${h}`).join("&");
      const o = await this.call("GET", `/messages/${enc(reply)}?format=metadata&${hs}`);
      const p = obj(o).payload;
      const h = (k: string): string => header(p, k) ?? "";
      m.thread = str(obj(o).threadId) ?? "";
      m.inReplyTo = h("Message-ID");
      m.references = [h("References"), h("Message-ID")].filter((x) => x !== "").join(" ");
      if (m.subject === "") m.subject = reSubject(h("Subject"));
      if (m.to === "") {
        const me = this.me();
        const from = h("Reply-To") === "" ? h("From") : h("Reply-To");
        const mine = me !== "" && addrEmail(h("From")) === me;
        m.to = mine ? h("To") : from;
        if (a.reply_all === true) {
          const others = mine ? h("Cc") : `${h("To")}, ${h("Cc")}`;
          m.cc = replyAllCc(me, m.to, others, m.cc);
        }
      }
    }
    for (const path of strs(a, "attachments")) {
      let data: Uint8Array;
      try {
        data = readFileSync(path);
      } catch (e) {
        return fail(`Can't attach ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const name = basename(path) || "attachment";
      m.files.push({ name, mime: mimeFor(name), data });
    }
    return m;
  }

  private async putRaw(method: string, path: string, raw: string, thread: string, draft?: string): Promise<unknown> {
    const msg: Obj = thread === "" ? {} : { threadId: thread };
    const wrap = (m: Obj): Obj => (draft === undefined ? m : draft === "" ? { message: m } : { id: draft, message: m });
    if (Buffer.byteLength(raw) <= RAW_MAX) {
      msg.raw = b64url(Buffer.from(raw));
      return this.call(method, path, wrap(msg));
    }
    const b = boundary();
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(wrap(msg))}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`),
      Buffer.from(raw),
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    return this.request(method, `${this.g.upload}${path}?uploadType=multipart`, { type: `multipart/related; boundary=${b}`, data: body });
  }

  async sendMail(a: Obj): Promise<string> {
    const m = await this.compose(a);
    if (m.to === "" && m.cc === "" && m.bcc === "") return fail("Who to? Pass to, or reply_to.");
    const v = await this.putRaw("POST", "/messages/send", build(m, boundary()), m.thread);
    return `Sent to ${[m.to, m.cc, m.bcc].filter((x) => x !== "").join(", ")} (message ${str(obj(v).id) ?? "?"}, thread ${str(obj(v).threadId) ?? "?"}).`;
  }

  async saveDraft(a: Obj): Promise<string> {
    const m = await this.compose(a);
    const raw = build(m, boundary());
    const id = opt(a, "draft_id");
    const v = id === "" ? await this.putRaw("POST", "/drafts", raw, m.thread, "") : await this.putRaw("PUT", `/drafts/${enc(id)}`, raw, m.thread, id);
    return `Draft ${str(obj(v).id) ?? "?"} saved (message ${str(at(v, "message", "id")) ?? "?"}, thread ${str(at(v, "message", "threadId")) ?? "?"}). It is in Gmail's Drafts.`;
  }

  async listDrafts(a: Obj): Promise<string> {
    let path = `/drafts?maxResults=${count(a)}`;
    if (opt(a, "query") !== "") path += `&q=${enc(opt(a, "query"))}`;
    const found = await this.call("GET", path);
    const ids = arr(obj(found).drafts).flatMap((d) => str(obj(d).id) ?? []);
    if (ids.length === 0) return "No drafts.";
    const items = await each(ids, (id) => this.call("GET", `/drafts/${enc(id)}?format=metadata`));
    let out = `${ids.length} drafts:\n`;
    ids.forEach((id, i) => {
      const r = items[i] as Settled<unknown>;
      if (!r.ok) {
        out += `- ${id}: ${r.e}\n`;
        return;
      }
      const msg = obj(obj(r.v).message);
      out += `- ${id} (message ${str(msg.id) ?? "?"}, thread ${str(msg.threadId) ?? "?"})\n  To: ${header(msg.payload, "To") ?? "(nobody yet)"} · ${header(msg.payload, "Subject") ?? "(no subject)"}\n  ${entities(str(msg.snippet) ?? "")}\n`;
    });
    return out;
  }

  async modify(a: Obj): Promise<string> {
    const ids = strs(a, "ids");
    if (ids.length === 0) return fail("Pass ids.");
    const labels = await this.labels();
    const [add, rm] = plan(a, labels);
    if (add.length === 0 && rm.length === 0) return fail("Nothing to change: pass move_to, archive, read, starred, add_labels or remove_labels.");
    const change = { addLabelIds: add, removeLabelIds: rm };
    if (a.threads === true) {
      const r = await each(ids, (id) => this.call("POST", `/threads/${enc(id)}/modify`, change));
      const failed = failures(ids, r);
      const done = ids.length - failed.length;
      return `${done} conversation${done === 1 ? "" : "s"} updated: ${describe(add, rm, labels)}.${failedNote(failed)}`;
    }
    for (let i = 0; i < ids.length; i += 1000) await this.call("POST", "/messages/batchModify", { ...change, ids: ids.slice(i, i + 1000) });
    return `${ids.length} message${ids.length === 1 ? "" : "s"} updated: ${describe(add, rm, labels)}.`;
  }

  async trash(a: Obj): Promise<string> {
    const ids = strs(a, "ids");
    if (ids.length === 0) return fail("Pass ids.");
    const kind = a.threads === true ? "threads" : "messages";
    const verb = a.undo === true ? "untrash" : "trash";
    const r = await each(ids, (id) => this.call("POST", `/${kind}/${enc(id)}/${verb}`));
    const failed = failures(ids, r);
    return `${ids.length - failed.length} ${kind} ${verb === "trash" ? "moved to the trash" : "taken out of the trash"}.${failedNote(failed)}`;
  }

  async listLabels(a: Obj): Promise<string> {
    const v = await this.call("GET", "/labels");
    const all = arr(obj(v).labels)
      .map((l, i) => ({ l: obj(l), i }))
      .sort((x, y) => {
        const kx = x.l.type !== "user";
        const ky = y.l.type !== "user";
        if (kx !== ky) return kx ? 1 : -1;
        const nx = (str(x.l.name) ?? "").toLowerCase();
        const ny = (str(y.l.name) ?? "").toLowerCase();
        return nx < ny ? -1 : nx > ny ? 1 : x.i - y.i;
      })
      .map((x) => x.l);
    const counts: (Obj | undefined)[] =
      a.counts === true ? (await each(all.flatMap((l) => str(l.id) ?? []), (id) => this.call("GET", `/labels/${enc(id)}`))).map((r) => (r.ok ? obj(r.v) : undefined)) : all.map(() => undefined);
    let out = `Signed in as ${this.me()}.\nYour labels:\n`;
    let system = false;
    all.forEach((l, i) => {
      if (l.type !== "user" && !system) {
        system = true;
        out += "System labels:\n";
      }
      const c = counts[i];
      const n = c ? `: ${uint(c.messagesTotal) ?? 0} messages, ${uint(c.messagesUnread) ?? 0} unread` : "";
      out += `- ${str(l.name) ?? "?"} (id ${str(l.id) ?? "?"})${n}\n`;
    });
    return out;
  }

  async editLabel(a: Obj): Promise<string> {
    const label = need(a, "label");
    const action = need(a, "action");
    let r: string;
    if (action === "create") {
      const v = await this.call("POST", "/labels", { name: label, labelListVisibility: "labelShow", messageListVisibility: "show" });
      r = `Created label ${label} (id ${str(obj(v).id) ?? "?"}).`;
    } else if (action === "rename") {
      const to = need(a, "new_name");
      const id = labelId(label, await this.labels());
      await this.call("PATCH", `/labels/${enc(id)}`, { name: to });
      r = `Renamed ${label} to ${to}.`;
    } else if (action === "delete") {
      const id = labelId(label, await this.labels());
      await this.call("DELETE", `/labels/${enc(id)}`);
      r = `Deleted label ${label}; its messages stay.`;
    } else {
      return fail(`No action ${JSON.stringify(action)}: create, rename or delete.`);
    }
    this.g.forgetLabels(this.account);
    return r;
  }

  async filters(a: Obj): Promise<string> {
    const action = need(a, "action");
    if (action === "list") return this.listFilters();
    if (action === "create") return this.createFilter(a);
    if (action === "delete") {
      const id = need(a, "id");
      await this.call("DELETE", `/settings/filters/${enc(id)}`);
      return `Deleted filter ${id}.`;
    }
    return fail(`No action ${JSON.stringify(action)}: list, create or delete.`);
  }

  private async listFilters(): Promise<string> {
    const v = await this.call("GET", "/settings/filters");
    const labels = await this.labels();
    const fs = arr(obj(v).filter);
    if (fs.length === 0) return "No filters.";
    let out = `${fs.length} filters:\n`;
    for (const f of fs) {
      const c = obj(obj(f).criteria);
      const crit: string[] = [];
      for (const [k, label] of [["from", "from:"], ["to", "to:"], ["subject", "subject:"], ["query", ""], ["negatedQuery", "not "]] as const) {
        const x = str(c[k]);
        if (x !== undefined) crit.push(`${label}${x}`);
      }
      if (c.hasAttachment === true) crit.push("has:attachment");
      const act = obj(obj(f).action);
      const ids = (k: string): string[] => arr(act[k]).flatMap((x) => str(x) ?? []);
      let does = describe(ids("addLabelIds"), ids("removeLabelIds"), labels);
      const fw = str(act.forward);
      if (fw !== undefined) does = [does, `forward to ${fw}`].filter((x) => x !== "").join(", ");
      out += `- ${str(obj(f).id) ?? "?"}: ${crit.join(" ")} → ${does}\n`;
    }
    return out;
  }

  private async createFilter(a: Obj): Promise<string> {
    const criteria: Obj = {};
    for (const k of ["from", "to", "subject", "query"]) if (opt(a, k) !== "") criteria[k] = opt(a, k);
    if (a.has_attachment === true) criteria.hasAttachment = true;
    if (Object.keys(criteria).length === 0) return fail("Pass at least one criterion: from, to, subject, query or has_attachment.");
    const [add, rm] = plan(a, await this.labels());
    const action: Obj = {};
    if (add.length > 0) action.addLabelIds = add;
    if (rm.length > 0) action.removeLabelIds = rm;
    if (opt(a, "forward") !== "") action.forward = opt(a, "forward");
    if (Object.keys(action).length === 0) return fail("Pass what it does: move_to, add_labels, remove_labels, archive, read, starred or forward.");
    const v = await this.call("POST", "/settings/filters", { criteria, action });
    return `Created filter ${str(obj(v).id) ?? "?"}.`;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function failures(ids: string[], r: Settled<unknown>[]): string[] {
  return ids.flatMap((id, i) => {
    const x = r[i];
    return x && !x.ok ? [`${id}: ${x.e}`] : [];
  });
}

const failedNote = (failed: string[]): string => (failed.length > 0 ? `\nFailed:\n${failed.join("\n")}` : "");

export async function serve(gmail: Gmail, input: AsyncIterable<string>, write: (line: string) => boolean): Promise<void> {
  for await (const line of input) {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    const id = obj(req).id;
    if (id === undefined) continue;
    const params = obj(obj(req).params);
    let result: unknown;
    switch (str(obj(req).method) ?? "") {
      case "initialize":
        result = {
          protocolVersion: str(params.protocolVersion) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: gmail.opts.version ?? VERSION },
        };
        break;
      case "tools/list":
        result = { tools: tools() };
        break;
      case "tools/call": {
        const r = await gmail.callTool(str(params.name) ?? "", params.arguments);
        result = { content: [{ type: "text", text: r.text }], isError: !r.ok };
        break;
      }
      case "ping":
        result = {};
        break;
      default:
        if (!write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }))) return;
        continue;
    }
    if (!write(JSON.stringify({ jsonrpc: "2.0", id, result }))) return;
  }
}

export function harborAuth(): Auth {
  return { accounts: () => googleAccounts(NAME), token: (email, force) => freshTokenFor(NAME, email, force) };
}

export async function run(opts: Options = { auth: harborAuth() }): Promise<void> {
  let open = true;
  process.stdout.on("error", () => {
    open = false;
  });
  const write = (line: string): boolean => {
    if (open) process.stdout.write(`${line}\n`);
    return open;
  };
  await serve(new Gmail(opts), createInterface({ input: process.stdin }), write);
}
