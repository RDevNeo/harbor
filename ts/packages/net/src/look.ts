import type { CaptchaRole } from "./captchanote.ts";
import { GLYPHS, type GlyphName } from "./glyphs.ts";
import { type Card, type Group, groupLabel, type Shown } from "./view.ts";
import type { Json } from "./wire.ts";

/**
 * How a chat's cards look: the decisions the desktop's cards.ts and the phone app both draw from,
 * made once here (glyphs, tones, labels, what expands, what a captcha notice is). The desktop calls
 * these functions; the hub sends their result to the phone as each card's `look` (PROTOCOL.md), so
 * the app draws it as given instead of deciding again in Java.
 */

/** A status color: "" the muted default, "red" failed, "green" done. */
export type Tone = "" | "red" | "green";

/** A notice's `icon` (what wrote it) → its glyph; anything else is a check. */
const NOTICE_GLYPHS: Record<string, GlyphName> = {
  bot: "BOT",
  report: "BOT",
  wake: "ALARM",
  webhook: "WEBHOOK",
  alert: "ALERT",
  fork: "FORK",
  process: "ACTIVITY",
  clock: "CLOCK",
  restart: "ROTATE_CW",
  folder: "FOLDER",
  worktree: "FOLDER_GIT",
  users: "USERS",
  monitor: "MONITOR",
  lock: "LOCK",
  captcha: "USER_CHECK",
  // A lead's hand-offs (hubs 0.84 to 0.107 wrote them; old transcripts still have them).
  started: "PLAY",
  sent: "SEND",
};

export function noticeGlyph(icon: string): string {
  return GLYPHS[NOTICE_GLYPHS[icon] ?? "CIRCLE_CHECK"];
}

/** A tool call's row: a spinner while it runs, then a green check or a red cross. */
export function toolLook(c: { result: string | null; is_error: boolean }): { glyph: string; tone: Tone } {
  if (c.result === null) return { glyph: GLYPHS.LOADER, tone: "" };
  return c.is_error ? { glyph: GLYPHS.CIRCLE_X, tone: "red" } : { glyph: GLYPHS.CIRCLE_CHECK, tone: "green" };
}

/** A notice's pill. `captcha` (a Discord captcha's notices, captchanote.ts): "card" the live captcha
 * card, "outcome" its plain line, "none" nothing (a pending one that has ended since). */
export interface NoticeLook {
  glyph: string;
  text: string;
  /** Tapping opens its detail (markdown when `markdown`); false with nothing to show or with a `url`. */
  expandable: boolean;
  markdown: boolean;
  /** A process's address: tapping opens it. */
  url: string | null;
  captcha: CaptchaRole["role"] | null;
}

export function noticeLook(c: Extract<Card, { kind: "notice" }>, role: CaptchaRole | null = null): NoticeLook {
  if (role !== null) {
    const glyph = role.role === "outcome" ? GLYPHS[role.note.state === "joined" ? "USER_CHECK" : "CIRCLE_SLASH"] : GLYPHS.USER_CHECK;
    return { glyph, text: c.text, expandable: false, markdown: false, url: null, captcha: role.role };
  }
  const detail = c.detail !== "" && !c.detail.startsWith("http");
  return { glyph: noticeGlyph(c.icon), text: c.text, expandable: c.url === null && detail, markdown: c.markdown, url: c.url, captcha: null };
}

/** A thin line across with a label and a link: the top of a fork, a chat an agent opened, a fork after a card. */
export interface DividerLook {
  glyph: string;
  text: string;
  link: string;
}

export const FORK_DIVIDER: DividerLook = { glyph: GLYPHS.FORK, text: "Conversation fork", link: "Open fork" };

export function dividerLook(c: Extract<Card, { kind: "forked_from" | "chat_link" }>): DividerLook {
  return c.kind === "forked_from" ? { glyph: GLYPHS.FORK, text: "Forked from conversation", link: "Open source conversation" } : { glyph: GLYPHS.BOT, text: c.text, link: "Open chat" };
}

/** The row over a user bubble: who wrote it elsewhere (a phone or PC glyph and the person), and
 * whether it steered a running turn ("↻ Steer"). `name` "" draws no person; a bubble joined to the
 * one above draws no person either (the run's first one has it). */
export interface SenderLook {
  glyph: string;
  name: string;
  steer: boolean;
  /** "↻" of the steer part. */
  steer_glyph: string;
}

export function senderLook(c: Extract<Card, { kind: "user" }>): SenderLook {
  const steer = c.intent !== "";
  if (c.who === "") return { glyph: "", name: "", steer, steer_glyph: GLYPHS.REDO_2 };
  return { glyph: GLYPHS[c.via === "phone" ? "SMARTPHONE" : "MONITOR"], name: c.who, steer, steer_glyph: GLYPHS.REDO_2 };
}

/** A run of tool calls' chevron row: "5 tool calls", with a spinner while one runs. */
export interface RunLook {
  label: string;
  pending: boolean;
}

export function runLook(g: Group): RunLook {
  return { label: groupLabel(g.calls), pending: g.pending };
}

/**
 * A card's `look` for the phone: what the desktop decides about it (above), as JSON. `role` is its
 * captcha role (captchaRoles), `runs` every run of the transcript (view.ts `groups`): the run's first
 * card carries the run's row as `run`. Null when the card has nothing to look up (a reply, thinking,
 * a message or an error that starts no run).
 */
export function cardLook(s: Shown, role: CaptchaRole | null, runs: ReadonlyMap<number, Group>): Record<string, Json> | null {
  const c = s.card;
  let v: Record<string, Json> = {};
  switch (c.kind) {
    case "user":
      // Always, so an app tells "no row" (a hub with looks) from an older hub's card.
      v = { ...senderLook(c) };
      break;
    case "tool":
      v = { ...toolLook(c) };
      break;
    case "notice": {
      const l = noticeLook(c, role);
      v = { glyph: l.glyph, text: l.text, expandable: l.expandable };
      if (l.captcha !== null) v.captcha = l.captcha;
      break;
    }
    case "forked_from":
    case "chat_link":
      v = { ...dividerLook(c) };
      break;
    default:
      break;
  }
  if (s.forksAfter.length > 0) v.fork = { ...FORK_DIVIDER };
  const run = s.group !== null && s.group === s.seq ? runs.get(s.group) : undefined;
  if (run) v.run = { ...runLook(run) };
  return Object.keys(v).length === 0 ? null : v;
}
