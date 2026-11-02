// The store's Item and Mention shapes, so its objects fit here.
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

export type Item =
  | { kind: "user"; text: string; files: string[]; at: number; mentions: Mention[]; sender: string; intent: string }
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

/** Rust's `str::parse::<i64>()`: an optional sign and digits, nothing else. */
export function parseInt64(s: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
