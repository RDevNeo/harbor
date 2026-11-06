import type { Item } from "@harbor/store";

/** A Discord captcha notice's detail: which captcha, and where it stands. */
export interface CaptchaNote {
  captcha: string;
  state: "pending" | "joined" | "closed" | "timeout" | "stopped" | "expired";
  guild: string | null;
}

const STATES = new Set(["pending", "joined", "closed", "timeout", "stopped", "expired"]);

/** The JSON a `captcha` notice carries in its detail; null: not one. */
export function captchaNote(detail: string): CaptchaNote | null {
  let v: unknown;
  try {
    v = JSON.parse(detail);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.captcha !== "string" || o.captcha === "" || typeof o.state !== "string" || !STATES.has(o.state)) return null;
  return { captcha: o.captcha, state: o.state as CaptchaNote["state"], guild: typeof o.guild === "string" && o.guild !== "" ? o.guild : null };
}

/** How a captcha notice draws: the live card, its outcome line, or nothing (a pending one that has ended since). */
export type CaptchaRole = { role: "card" | "outcome" | "none"; note: CaptchaNote };

/** The captcha notices of a transcript, by seq. A pending one with a later notice of the same captcha is
 * superseded (nothing); the later one is its outcome line; a pending one alone is the live card. */
export function captchaRoles(items: readonly Item[]): Map<number, CaptchaRole> {
  const out = new Map<number, CaptchaRole>();
  const last = new Map<string, number>();
  items.forEach((it, i) => {
    if (it.kind !== "notice" || it.icon !== "captcha") return;
    const note = captchaNote(it.detail);
    if (note === null) return;
    out.set(i, { role: note.state === "pending" ? "card" : "outcome", note });
    last.set(note.captcha, i);
  });
  for (const [i, r] of out) if (r.role === "card" && (last.get(r.note.captcha) ?? i) > i) r.role = "none";
  return out;
}
