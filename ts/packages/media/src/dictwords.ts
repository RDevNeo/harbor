export interface Entry {
  term: string;
  sounds: string[];
}

export const MAX_ENTRIES = 500;
export const MAX_TERM = 60;
const MAX_SOUNDS = 8;

const ALNUM = /^[\p{Alphabetic}\p{N}]$/u;

function isAlnum(c: string): boolean {
  return ALNUM.test(c);
}

function isSpace(c: string): boolean {
  return /^\s$/u.test(c);
}

function eqAscii(a: string, b: string): boolean {
  const low = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return low(a) === low(b);
}

function lower(s: string): string {
  return Array.from(s, (c) => c.toLowerCase()).join("");
}

function clip(s: string): string {
  return Array.from(s.split(/\s+/u).filter((w) => w !== "").join(" ")).slice(0, MAX_TERM).join("");
}

function field(v: unknown, k: string): unknown {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
}

/** The dictionary from its JSON (`[{"term": "…", "sounds": ["…"]}]`), cleaned: blank and duplicate terms out, lengths capped. */
export function parse(v: unknown): Entry[] {
  const out: Entry[] = [];
  if (!Array.isArray(v)) return out;
  for (const e of v) {
    const t = field(e, "term");
    const term = clip(typeof t === "string" ? t : "");
    if (term === "" || out.some((x) => eqAscii(x.term, term))) continue;
    const sounds: string[] = [];
    const raw = field(e, "sounds");
    for (const s of Array.isArray(raw) ? raw : []) {
      if (typeof s !== "string") continue;
      const c = clip(s);
      if (c !== "" && !eqAscii(c, term) && !sounds.includes(c) && sounds.length < MAX_SOUNDS) sounds.push(c);
    }
    out.push({ term, sounds });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

export function toJson(d: readonly Entry[]): { term: string; sounds: string[] }[] {
  return d.map((e) => ({ term: e.term, sounds: [...e.sounds] }));
}

type Span = [number, number];

function wordSpans(text: string): Span[] {
  const out: Span[] = [];
  let start: number | null = null;
  let i = 0;
  for (const c of text) {
    if (isAlnum(c)) {
      start ??= i;
    } else if (start !== null) {
      out.push([start, i]);
      start = null;
    }
    i += c.length;
  }
  if (start !== null) out.push([start, text.length]);
  return out;
}

const FOLD: Record<string, string> = {
  á: "a", à: "a", â: "a", ã: "a", ä: "a",
  é: "e", è: "e", ê: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i",
  ó: "o", ò: "o", ô: "o", õ: "o", ö: "o",
  ú: "u", ù: "u", û: "u", ü: "u",
  ç: "s",
  ñ: "n",
};

function foldChar(c: string): string {
  return FOLD[c] ?? c;
}

/** Words reduced to a rough sound for Portuguese and English: accents off, ph/f, c/k/q, z/s, y/i made one, doubles single. */
export function key(s: string): string {
  const b = Array.from(lower(s), foldChar).filter(isAlnum);
  let out = "";
  let i = 0;
  while (i < b.length) {
    const cur = b[i] as string;
    const next = b[i + 1];
    let c: string;
    let skip = 1;
    if (cur === "p" && next === "h") {
      c = "f";
      skip = 2;
    } else if (cur === "c" && next === "k") {
      c = "k";
      skip = 2;
    } else if (cur === "c" || cur === "q" || cur === "k") {
      c = "k";
    } else if (cur === "x") {
      out += "k";
      c = "s";
    } else if (cur === "z") {
      c = "s";
    } else if (cur === "y") {
      c = "i";
    } else {
      c = cur;
    }
    if (!out.endsWith(c)) out += c;
    i += skip;
  }
  return out;
}

function distance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 0; i < x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(i + 1);
    for (let j = 0; j < y.length; j++) {
      cur[j + 1] = Math.min((prev[j] as number) + (x[i] === y[j] ? 0 : 1), (prev[j + 1] as number) + 1, (cur[j] as number) + 1);
    }
    prev = cur;
  }
  return prev[y.length] as number;
}

function first(s: string): string | undefined {
  for (const c of s) return c;
  return undefined;
}

/** How far `heard` (in `words` words) is from `form`, if close enough to be it. */
function closeness(heard: string, words: number, form: string): number | null {
  if (heard === "" || form === "") return null;
  if (heard === form) return 0;
  const n = Array.from(form).length;
  const fuzzy = n >= 7 || (n >= 6 && words >= 2);
  if (!fuzzy || first(heard) !== first(form)) return null;
  const d = distance(heard, form);
  return d <= (n >= 10 ? 2 : 1) ? d : null;
}

export function apply(text: string, dict: readonly Entry[]): string {
  if (dict.length === 0) return text;
  const forms: [number, string][] = [];
  dict.forEach((e, i) => {
    for (const f of [e.term, ...e.sounds]) forms.push([i, key(f)]);
  });
  const spans = wordSpans(text);
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < spans.length) {
    // Closest first, then most words ("spoke pay CRM").
    let best: { d: number; k: number; entry: number } | null = null;
    let joined = "";
    const max = Math.min(6, spans.length - i);
    for (let k = 1; k <= max; k++) {
      if (k > 1) {
        const gap = text.slice((spans[i + k - 2] as Span)[1], (spans[i + k - 1] as Span)[0]);
        if (!(Array.from(gap).every(isSpace) || gap === "-")) break;
      }
      const [s, e] = spans[i + k - 1] as Span;
      joined += text.slice(s, e);
      const heard = key(joined);
      for (const [entry, form] of forms) {
        const d = closeness(heard, k, form);
        if (d !== null && (best === null || d <= best.d)) best = { d, k, entry };
      }
    }
    if (best) {
      const s = (spans[i] as Span)[0];
      const e = (spans[i + best.k - 1] as Span)[1];
      out += text.slice(copied, s) + (dict[best.entry] as Entry).term;
      copied = e;
      i += best.k;
    } else {
      i += 1;
    }
  }
  return out + text.slice(copied);
}

const SEND_ALONE = [
  "send", "send it", "send message", "send the message", "enter", "press enter", "hit enter", "enviar", "envia", "envie", "enviar mensagem", "manda", "mandar", "pode enviar", "pode mandar",
  "aperta enter", "aperte enter", "apertar enter", "pressiona enter", "pressione enter", "da enter", "dar enter",
];
const SEND_TAIL = ["press enter", "hit enter", "aperta enter", "aperte enter", "apertar enter", "pressiona enter", "pressione enter", "da enter", "dar enter"];
const NEW_LINE = ["new line", "newline", "next line", "nova linha", "proxima linha", "quebra de linha", "pula linha", "pular linha"];
const NEW_PARAGRAPH = ["new paragraph", "next paragraph", "novo paragrafo", "proximo paragrafo"];

function norm(s: string): string {
  const t = Array.from(lower(s), (c) => foldChar(c)).map((c) => (isAlnum(c) ? c : " "));
  return t.join("").split(/\s+/u).filter((w) => w !== "").join(" ");
}

const SENTENCE_END = new Set([".", "!", "?", "…"]);

function sentences(text: string): Span[] {
  const out: Span[] = [];
  const chars: [number, string][] = [];
  let p = 0;
  for (const c of text) {
    chars.push([p, c]);
    p += c.length;
  }
  let start = 0;
  let n = 0;
  while (n < chars.length) {
    const [i, c] = chars[n] as [number, string];
    n += 1;
    let end: number | null = null;
    if (c === "\n") {
      end = i;
    } else if (SENTENCE_END.has(c)) {
      while (n < chars.length && SENTENCE_END.has((chars[n] as [number, string])[1])) n += 1;
      const next = chars[n];
      const after = next ? next[0] : text.length;
      if (!next || isSpace(next[1])) end = after;
    }
    if (end !== null) {
      out.push([start, end]);
      start = c === "\n" ? i + 1 : end;
    }
  }
  out.push([start, text.length]);
  return out.filter(([s, e]) => text.slice(s, e).trim() !== "");
}

function trimEndWhere(s: string, pred: (c: string) => boolean): string {
  let end = s.length;
  while (end > 0 && pred(s.charAt(end - 1))) end -= 1;
  return s.slice(0, end);
}

const blankOrComma = (c: string) => isSpace(c) || c === ",";
const blankOrTab = (c: string) => c === " " || c === "\t";

/** What the spoken commands do to a transcript: the text without them, and whether to send it. */
export function commands(text: string): [string, boolean] {
  let t = "";
  let copied = 0;
  for (const [s, e] of sentences(text)) {
    const n = norm(text.slice(s, e));
    let brk: string;
    if (NEW_LINE.includes(n)) brk = "\n";
    else if (NEW_PARAGRAPH.includes(n)) brk = "\n\n";
    else continue;
    t += trimEndWhere(text.slice(copied, s), blankOrTab) + brk;
    copied = e;
    while (copied < text.length && blankOrTab(text.charAt(copied))) copied += 1;
  }
  t += text.slice(copied);
  const trimmed = t.trimEnd();
  const last = sentences(trimmed).at(-1);
  if (last && SEND_ALONE.includes(norm(trimmed.slice(last[0], last[1])))) {
    return [trimEndWhere(trimmed.slice(0, last[0]), blankOrComma), true];
  }
  const n = norm(trimmed);
  const tail = SEND_TAIL.find((c) => n === c || n.endsWith(` ${c}`));
  if (tail) {
    const spans = wordSpans(trimmed);
    const words = tail.split(" ").length;
    if (spans.length >= words) {
      const cut = (spans[spans.length - words] as Span)[0];
      return [trimEndWhere(trimmed.slice(0, cut), blankOrComma), true];
    }
  }
  return [t, false];
}
