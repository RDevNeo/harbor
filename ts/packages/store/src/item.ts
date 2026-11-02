// itemJson must match the Rust app's serde_json byte for byte: peers compare transcripts by digest.

export interface Mention {
  item: number;
  from: string;
  at: number;
  text: string;
  len: number;
  excerpt: boolean;
  note: string;
  kind: string;
  chat: string;
  title: string;
}

/** The device a message came from (`Item` user's `via`). */
export type SentVia = "phone" | "pc";

export type Item =
  | {
      kind: "user";
      text: string;
      files: string[];
      at: number;
      mentions: Mention[];
      /** Where it was written when not on this PC: "Pixel 8 (Sam)", "work-pc (Sam)"; "" typed here. */
      sender: string;
      intent: string;
      /** The person who wrote it elsewhere ("" unknown; items from before 0.115 have only `sender`). */
      who?: string;
      /** What it was written on: the Harbor phone app or another PC (items from before 0.115: unset). */
      via?: SentVia;
    }
  | { kind: "text"; text: string; at: number }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; input: string; result: string | null; is_error: boolean }
  | {
      kind: "result";
      cost_usd: number;
      duration_ms: number;
      turns: number;
      input_tokens: number;
      output_tokens: number;
      cached: number;
      at: number;
      account: string;
      model: string;
    }
  | { kind: "error"; text: string }
  | { kind: "notice"; icon: string; text: string; detail: string }
  | { kind: "message"; from: string; to: string; text: string };

export type ItemKind = Item["kind"];

export function mention(m: Partial<Mention> = {}): Mention {
  return { item: 0, from: "", at: 0, text: "", len: 0, excerpt: false, note: "", kind: "", chat: "", title: "", ...m };
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Obj, k: string, req: boolean): string | null {
  const v = o[k];
  if (v === undefined) return req ? null : "";
  return typeof v === "string" ? v : null;
}

function int(o: Obj, k: string, req: boolean, signed = false): number | null {
  const v = o[k];
  if (v === undefined) return req ? null : 0;
  return typeof v === "number" && Number.isInteger(v) && (signed || v >= 0) ? v : null;
}

function parseMention(v: unknown): Mention | null {
  if (!isObj(v)) return null;
  const item = int(v, "item", false);
  const from = str(v, "from", false);
  const at = int(v, "at", false, true);
  const text = str(v, "text", false);
  const len = int(v, "len", false);
  const note = str(v, "note", false);
  const kind = str(v, "kind", false);
  const chat = str(v, "chat", false);
  const title = str(v, "title", false);
  const excerpt = v.excerpt === undefined ? false : v.excerpt;
  if (item === null || from === null || at === null || text === null || len === null || note === null || kind === null || chat === null || title === null) return null;
  if (typeof excerpt !== "boolean") return null;
  return { item, from, at, text, len, excerpt, note, kind, chat, title };
}

/** An item from its stored JSON; null for what Rust's serde would refuse too. */
export function parseItem(body: string): Item | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.kind) {
    case "user": {
      const text = str(v, "text", true);
      const at = int(v, "at", false, true);
      const sender = str(v, "sender", false);
      const intent = str(v, "intent", false);
      const files = v.files === undefined ? [] : v.files;
      const rawMentions = v.mentions === undefined ? [] : v.mentions;
      if (text === null || at === null || sender === null || intent === null) return null;
      if (!Array.isArray(files) || !files.every((f): f is string => typeof f === "string")) return null;
      if (!Array.isArray(rawMentions)) return null;
      const mentions: Mention[] = [];
      for (const m of rawMentions) {
        const p = parseMention(m);
        if (!p) return null;
        mentions.push(p);
      }
      const it: Item = { kind: "user", text, files, at, mentions, sender, intent };
      if (typeof v.who === "string" && v.who !== "") it.who = v.who;
      if (v.via === "phone" || v.via === "pc") it.via = v.via;
      return it;
    }
    case "text": {
      const text = str(v, "text", true);
      const at = int(v, "at", false, true);
      return text === null || at === null ? null : { kind: "text", text, at };
    }
    case "thinking": {
      const text = str(v, "text", true);
      return text === null ? null : { kind: "thinking", text };
    }
    case "tool": {
      const id = str(v, "id", true);
      const name = str(v, "name", true);
      const summary = str(v, "summary", false);
      const input = str(v, "input", true);
      const result = v.result === undefined || v.result === null ? null : v.result;
      if (id === null || name === null || summary === null || input === null) return null;
      if (result !== null && typeof result !== "string") return null;
      if (typeof v.is_error !== "boolean") return null;
      return { kind: "tool", id, name, summary, input, result, is_error: v.is_error };
    }
    case "result": {
      const cost = v.cost_usd;
      const dur = int(v, "duration_ms", true);
      const turns = int(v, "turns", true);
      const inT = int(v, "input_tokens", true);
      const outT = int(v, "output_tokens", true);
      const cached = int(v, "cached", false);
      const at = int(v, "at", false, true);
      const account = str(v, "account", false);
      const model = str(v, "model", false);
      if (typeof cost !== "number" || dur === null || turns === null || inT === null || outT === null) return null;
      if (cached === null || at === null || account === null || model === null) return null;
      return { kind: "result", cost_usd: cost, duration_ms: dur, turns, input_tokens: inT, output_tokens: outT, cached, at, account, model };
    }
    case "error": {
      const text = str(v, "text", true);
      return text === null ? null : { kind: "error", text };
    }
    case "notice": {
      const icon = str(v, "icon", true);
      const text = str(v, "text", true);
      const detail = str(v, "detail", false);
      return icon === null || text === null || detail === null ? null : { kind: "notice", icon, text, detail };
    }
    case "message": {
      const from = str(v, "from", true);
      const to = str(v, "to", true);
      const text = str(v, "text", true);
      return from === null || to === null || text === null ? null : { kind: "message", from, to, text };
    }
    default:
      return null;
  }
}

/** serde_json's (ryu) spelling of an f64: "0.0", "1.5", "1e21", "1.5e-7"; null for NaN and infinity. */
export function f64Json(x: number): string {
  if (!Number.isFinite(x)) return "null";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant = "", exp = "0"] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const kk = Number(exp) + 1;
  const k = kk - digits.length;
  let body: string;
  if (k >= 0 && kk <= 16) body = `${digits}${"0".repeat(k)}.0`;
  else if (kk > 0 && kk <= 16) body = `${digits.slice(0, kk)}.${digits.slice(kk)}`;
  else if (kk > -5 && kk <= 0) body = `0.${"0".repeat(-kk)}${digits}`;
  else body = `${digits.slice(0, 1)}${digits.length > 1 ? `.${digits.slice(1)}` : ""}e${kk - 1}`;
  return sign + body;
}

const s = (x: string): string => JSON.stringify(x);

function mentionJson(m: Mention): string {
  let o = `{"item":${m.item},"from":${s(m.from)},"at":${m.at},"text":${s(m.text)},"len":${m.len}`;
  if (m.excerpt) o += ',"excerpt":true';
  if (m.note) o += `,"note":${s(m.note)}`;
  if (m.kind) o += `,"kind":${s(m.kind)}`;
  if (m.chat) o += `,"chat":${s(m.chat)}`;
  if (m.title) o += `,"title":${s(m.title)}`;
  return `${o}}`;
}

/** The item as serde_json writes it. */
export function itemJson(it: Item): string {
  switch (it.kind) {
    case "user": {
      let o = `{"kind":"user","text":${s(it.text)},"files":[${it.files.map(s).join(",")}],"at":${it.at}`;
      if (it.mentions.length > 0) o += `,"mentions":[${it.mentions.map(mentionJson).join(",")}]`;
      if (it.sender) o += `,"sender":${s(it.sender)}`;
      if (it.intent) o += `,"intent":${s(it.intent)}`;
      if (it.who) o += `,"who":${s(it.who)}`;
      if (it.via) o += `,"via":${s(it.via)}`;
      return `${o}}`;
    }
    case "text":
      return `{"kind":"text","text":${s(it.text)},"at":${it.at}}`;
    case "thinking":
      return `{"kind":"thinking","text":${s(it.text)}}`;
    case "tool":
      return `{"kind":"tool","id":${s(it.id)},"name":${s(it.name)},"summary":${s(it.summary)},"input":${s(it.input)},"result":${it.result === null ? "null" : s(it.result)},"is_error":${it.is_error}}`;
    case "result":
      return `{"kind":"result","cost_usd":${f64Json(it.cost_usd)},"duration_ms":${it.duration_ms},"turns":${it.turns},"input_tokens":${it.input_tokens},"output_tokens":${it.output_tokens},"cached":${it.cached},"at":${it.at},"account":${s(it.account)},"model":${s(it.model)}}`;
    case "error":
      return `{"kind":"error","text":${s(it.text)}}`;
    case "notice":
      return `{"kind":"notice","icon":${s(it.icon)},"text":${s(it.text)},"detail":${s(it.detail)}}`;
    case "message":
      return `{"kind":"message","from":${s(it.from)},"to":${s(it.to)},"text":${s(it.text)}}`;
  }
}

// FNV-1a over 64 bits, kept as two 32-bit halves so it stays fast without BigInt per byte.
export class Fnv {
  private hi = 0xcbf29ce4;
  private lo = 0x84222325;

  update(bytes: Uint8Array): this {
    let { hi, lo } = this;
    // An indexed loop: `for…of` over a Uint8Array goes through the iterator protocol per byte,
    // which made hashing a PC's transcripts take seconds on the window's thread.
    for (let i = 0, n = bytes.length; i < n; i++) {
      lo = (lo ^ bytes[i]!) >>> 0;
      const p = lo * 0x1b3;
      const carry = Math.floor(p / 0x100000000);
      const nlo = p >>> 0;
      hi = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) >>> 0;
      lo = nlo;
    }
    this.hi = hi;
    this.lo = lo;
    return this;
  }

  value(): bigint {
    return (BigInt(this.hi) << 32n) | BigInt(this.lo);
  }
}

const enc = new TextEncoder();

export function fnvText(text: string): bigint {
  return new Fnv().update(enc.encode(text)).value();
}

export function itemHash(it: Item): bigint {
  return fnvText(itemJson(it));
}

/** A transcript's digest as copies compare it: FNV over each item's hash (8 bytes little-endian). */
export function digest(items: readonly Item[]): bigint {
  return digestOf(items.map(itemHash));
}

/** `digest` from the items' hashes (`itemHash`), in order. */
export function digestOf(hashes: readonly bigint[]): bigint {
  const h = new Fnv();
  const buf = new DataView(new ArrayBuffer(8));
  const bytes = new Uint8Array(buf.buffer);
  for (const x of hashes) {
    buf.setBigUint64(0, x, true);
    h.update(bytes);
  }
  return h.value();
}
