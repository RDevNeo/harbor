
import { urlDecode, urlEncode } from "./http.ts";

export const CHAT_SCHEME = "harbor://chat/";

/** The link of chat `gid`; `pc` (its PC's name) when known. */
export function chatLink(gid: string, pc: string): string {
  return pc === "" ? `${CHAT_SCHEME}${gid}` : `${CHAT_SCHEME}${gid}?pc=${urlEncode(pc)}`;
}

export interface ParsedChatLink {
  /** Length of the link at the start of the text. */
  len: number;
  gid: string;
  pc: string;
}

const GID_CHAR = /[A-Za-z0-9_-]/;
const PC_CHAR = /[A-Za-z0-9_.%-]/;

function run(s: string, ok: RegExp): number {
  let n = 0;
  while (n < s.length && ok.test(s.charAt(n))) n += 1;
  return n;
}

/** A chat link at the start of `s`. */
export function parseChatLink(s: string): ParsedChatLink | null {
  if (!s.startsWith(CHAT_SCHEME)) return null;
  const rest = s.slice(CHAT_SCHEME.length);
  const n = run(rest, GID_CHAR);
  if (n === 0 || n > 64) return null;
  const gid = rest.slice(0, n);
  let len = CHAT_SCHEME.length + n;
  let pc = "";
  const after = rest.slice(n);
  if (after.startsWith("?pc=")) {
    const q = after.slice(4);
    // A sentence's full stop after the link isn't part of it.
    pc = q.slice(0, run(q, PC_CHAR)).replace(/\.+$/, "");
    len += 4 + pc.length;
  }
  return { len, gid, pc };
}

interface Site {
  at: number;
  len: number;
  /** Not already a markdown link's destination or an autolink. */
  bare: boolean;
}

/** Where chat links start in `md` outside code spans and blocks. */
function sites(md: string): Site[] {
  const out: Site[] = [];
  if (!md.includes(CHAT_SCHEME)) return out;
  let inCode = false;
  let i = 0;
  while (i < md.length) {
    if (md.charAt(i) === "`") {
      let n = 0;
      while (md.charAt(i + n) === "`") n += 1;
      inCode = !inCode;
      i += n;
      continue;
    }
    if (!inCode) {
      const p = parseChatLink(md.slice(i));
      if (p) {
        const prev = i > 0 ? md.charAt(i - 1) : "";
        out.push({ at: i, len: p.len, bare: prev !== "(" && prev !== "<" });
        i += p.len;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/** Every chat link `md` names outside code, in order (bare, `<…>` or `[label](…)`): the whole link as written and its gid. */
export function chatLinks(md: string): [string, string][] {
  const out: [string, string][] = [];
  for (const s of sites(md)) {
    const text = md.slice(s.at, s.at + s.len);
    const p = parseChatLink(text);
    if (p && !out.some(([l]) => l === text)) out.push([text, p.gid]);
  }
  return out;
}

const MD_SPECIAL = new Set(["[", "]", "\\", "*", "_", "`"]);

/** `md` with each bare chat link as a markdown link labelled `title(link)`; links already in `[label](…)` keep their label, `<…>` autolinks get the title too. */
export function labelChatLinks(md: string, title: (url: string) => string): string {
  const all = sites(md);
  if (all.length === 0) return md;
  let out = "";
  let at = 0;
  for (const s of all) {
    const url = md.slice(s.at, s.at + s.len);
    const auto = md.slice(0, s.at).endsWith("<") && md.slice(s.at + s.len).startsWith(">");
    if (!s.bare && !auto) continue;
    const start = auto ? s.at - 1 : s.at;
    const end = auto ? s.at + s.len + 1 : s.at + s.len;
    out += md.slice(at, start);
    const label = [...title(url)].map((c) => (MD_SPECIAL.has(c) ? `\\${c}` : c)).join("");
    out += `[${label}](${url})`;
    at = end;
  }
  return out + md.slice(at);
}

/** What a chat link leads to, as this PC sees it. */
export interface ChatLinkTarget {
  /** The chat here (a copy when it lives on another PC); null: not here. */
  id: number | null;
  /** Its title, or why it can't open. */
  title: string;
  /** Why it can't be opened ("Chat not found", "laptop is offline"); empty when it can. */
  missing: string;
}

/** The chat fields the links need. */
export interface LinkChat {
  id: number;
  gid: string;
  title: string;
  name: string;
  /** "sub" for a sub-agent. */
  role: string;
  parent: number | null;
}

/** What a link is resolved against: this PC's chats and the mesh's PCs. */
export interface ChatLinkWorld {
  chats: readonly LinkChat[];
  peers: readonly { name: string; online: boolean }[];
}

/** A chat's title as links show it: a sub-agent's under its lead's. */
export function chatLinkTitle(world: ChatLinkWorld, c: LinkChat): string {
  const title = c.title.trim() === "" ? "Untitled chat" : c.title.trim();
  const lead = c.parent === null ? undefined : world.chats.find((x) => x.id === c.parent);
  if (c.role === "sub" && lead) return `${lead.title.trim()} › ${c.name === "" ? title : c.name}`;
  return title;
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Where link `url` (a chat link, as written) leads. */
export function chatLinkTarget(world: ChatLinkWorld, url: string): ChatLinkTarget {
  const p = parseChatLink(url);
  if (!p) return { id: null, title: url, missing: "Not a chat link" };
  const c = world.chats.find((x) => x.gid === p.gid);
  if (c) return { id: c.id, title: chatLinkTitle(world, c), missing: "" };
  const pc = urlDecode(p.pc);
  const lower = asciiLower(pc);
  const off = pc !== "" && world.peers.some((x) => asciiLower(x.name) === lower && !x.online);
  const missing = off ? `${pc} is offline` : "Chat not found";
  return { id: null, title: missing, missing };
}

/** The chat links `md` names, resolved for the phone (`chat_links` in /v1): link as written → `{title, chat, missing}`. */
export function chatLinkTargets(world: ChatLinkWorld, md: string): Record<string, { title: string; chat: number | null; missing: string }> {
  const out: Record<string, { title: string; chat: number | null; missing: string }> = {};
  for (const [url] of chatLinks(md)) {
    const t = chatLinkTarget(world, url);
    out[url] = { title: t.title, chat: t.id, missing: t.missing };
  }
  return out;
}

/** Opens the chat link `url` through `open`; the reason when it can't. */
export function openChatLink(world: ChatLinkWorld, url: string, open: (id: number) => void): { id: number } | { error: string } {
  const t = chatLinkTarget(world, url);
  if (t.id === null) return { error: t.missing };
  open(t.id);
  return { id: t.id };
}
