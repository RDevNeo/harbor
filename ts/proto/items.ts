// A chat's transcript: the JSON in harbor.db's items table (store.rs `Item`) and the cards the
// window draws from it.

export type Item =
  | { kind: "user"; text: string; at?: number }
  | { kind: "text"; text: string; at?: number }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; summary?: string; input: string; result: string | null; is_error: boolean }
  | { kind: "result"; cost_usd: number; duration_ms: number; turns: number; input_tokens: number; output_tokens: number }
  | { kind: "error"; text: string }
  | { kind: "notice"; icon: string; text: string; detail?: string }
  | { kind: "message"; from: string; to: string; text: string };

export interface Card {
  kind: "user" | "text" | "error" | "line";
  text: string;
  meta: string;
}

const KINDS = new Set(["user", "text", "thinking", "tool", "result", "error", "notice", "message"]);

/** One row of the items table; null for what Rust's serde would refuse too. */
export function parseItem(body: string): Item | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const kind = (v as { kind?: unknown }).kind;
  return typeof kind === "string" && KINDS.has(kind) ? (v as Item) : null;
}

function oneLine(s: string, max = 160): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** What the transcript shows: a reply's thinking is often empty (redacted), so it has no row. */
export function shown(it: Item): boolean {
  return it.kind !== "thinking" || it.text.trim() !== "";
}

export function toCard(it: Item): Card {
  switch (it.kind) {
    case "user":
      return { kind: "user", text: it.text, meta: "" };
    case "text":
      return { kind: "text", text: it.text, meta: "" };
    case "thinking":
      return { kind: "line", text: `Thinking: ${oneLine(it.text)}`, meta: "" };
    case "tool":
      return { kind: it.is_error ? "error" : "line", text: oneLine(`${it.name} ${it.summary ?? ""}`), meta: "" };
    case "result":
      return { kind: "line", text: `${(it.duration_ms / 1000).toFixed(1)} s · ${it.input_tokens} in · ${it.output_tokens} out`, meta: "" };
    case "error":
      return { kind: "error", text: it.text, meta: "" };
    case "notice":
      return { kind: "line", text: oneLine(it.text), meta: "" };
    case "message":
      return { kind: "line", text: oneLine(`${it.from} → ${it.to}: ${it.text}`), meta: "" };
  }
}
