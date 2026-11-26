// What a Persons chat offers on a right-click (long-press on the phone, PersonsChat.java keeps the same rules): Person
// Hub's message menu (src/views/Chat.tsx MessageMenu), in its order and with its icons, drawn with Hub's MenuPanel /
// MenuItem / MenuSeparator. Pure, so it is unit tested.
import type { GlyphName } from "@harbor/net";

export type MsgAction = "reply" | "forward" | "site-request" | "copy" | "open-file" | "unread";

export interface MenuEntry {
  action?: MsgAction;
  label: string;
  /** A Lucide glyph (net's glyphs.ts); none on a separator. */
  icon?: GlyphName;
  /** A shortcut on the right ("Alt+Click"). */
  hint?: string;
  sep?: boolean;
  /** Destructive (red): none of a message's entries are. */
  danger?: boolean;
}

export interface MsgMenuIn {
  fromMe: boolean;
  hasText: boolean;
  hasFiles: boolean;
  /** The chat's account is connected and the person has an id on it (Reply). */
  canSend: boolean;
  /** The person's AI is there (Forward to AI). */
  aiOn: boolean;
  /** The person panel has SpokPay site requests here (spokpay-view.ts offersSiteRequests). */
  siteRequests: boolean;
  /** A site request is already being drafted from this message. */
  proposing?: boolean;
}

/**
 * Reply · Forward to AI · Open Site Request | Copy text · Open attachment | Mark as unread (their messages; Alt+Click).
 * Each group only when it has entries, a separator between groups.
 */
export function messageMenu(m: MsgMenuIn): MenuEntry[] {
  const groups: MenuEntry[][] = [
    [
      ...(m.canSend ? [{ action: "reply" as const, label: "Reply", icon: "REPLY" as const }] : []),
      ...(m.aiOn ? [{ action: "forward" as const, label: "Forward to AI", icon: "SPARKLES" as const }] : []),
      ...(m.siteRequests && !m.proposing ? [{ action: "site-request" as const, label: "Open Site Request", icon: "FILE_PLUS" as const }] : []),
    ],
    [
      ...(m.hasText ? [{ action: "copy" as const, label: "Copy text", icon: "COPY" as const }] : []),
      ...(m.hasFiles ? [{ action: "open-file" as const, label: "Open attachment", icon: "EXTERNAL" as const }] : []),
    ],
    [...(!m.fromMe ? [{ action: "unread" as const, label: "Mark as unread", icon: "MAIL_WARNING" as const, hint: "Alt+Click" }] : [])],
  ];
  const out: MenuEntry[] = [];
  for (const g of groups) {
    if (!g.length) continue;
    if (out.length) out.push({ label: "", sep: true });
    out.push(...g);
  }
  return out;
}

/** The menu of an AI answer: its ```reply drafts (or the whole answer) into the composer, and Copy. */
export function aiMenu(o: { drafts: string[]; text: string; canSend: boolean }): (MenuEntry & { use?: string })[] {
  const uses = o.drafts.length ? o.drafts.map((d, i) => ({ label: o.drafts.length > 1 ? `Use reply ${i + 1}` : "Use as reply", icon: "CORNER_UP_RIGHT" as const, use: d })) : [{ label: "Use as reply", icon: "CORNER_UP_RIGHT" as const, use: o.text }];
  return [...(o.canSend ? uses : []), ...(o.canSend && o.text ? [{ label: "", sep: true }] : []), ...(o.text ? [{ action: "copy" as const, label: "Copy text", icon: "COPY" as const }] : [])];
}

/** A message that didn't go: Retry, Dismiss. */
export function failedMenu(): MenuEntry[] {
  return [
    { label: "Retry", icon: "ROTATE_CW" },
    { label: "Dismiss", icon: "X" },
  ];
}

/** What the composer's text field says (Person Hub's placeholders). */
export function composerHint(o: { toAi: boolean; forwarded: boolean; name: string; kind: string; me: string }): string {
  if (o.toAi) return o.forwarded ? "Ask about this message (empty: “What should I reply to this?”)" : `Tell the AI what to do about ${o.name}`;
  if (o.kind === "gmail") return `Email ${o.name}${o.me ? ` as ${o.me}` : ""}…`;
  return `Message ${o.name}${o.kind ? ` on ${o.kind === "whatsapp" ? "WhatsApp" : o.kind === "spokpay" ? "SpokPay" : "Discord"}` : ""}`;
}

/** Why the composer can't write to the person (null: it can), Person Hub's notes. */
export function blockedNote(o: { hasAccount: boolean; hasPeer: boolean; connected: boolean; kind: string }): string | null {
  const what = o.kind === "gmail" ? "email address" : o.kind === "whatsapp" ? "WhatsApp number" : "Discord account";
  const app = o.kind === "gmail" ? "Gmail" : o.kind === "whatsapp" ? "WhatsApp" : "Discord";
  if (!o.hasAccount) return "No channel to talk to them here: connect Discord, Gmail or WhatsApp in the section’s +, and give them that identifier (Edit).";
  if (!o.hasPeer) return `Add their ${what} (Edit) to message them here.`;
  if (!o.connected) return `Sign in to ${app} (the section’s + menu › Connections) to message.`;
  return null;
}

/** Move to…'s entries in a person's menu (the phone's PersonsUi.moveMenu keeps the same rules). */
export interface MoveEntry {
  /** "spokpay", "creators", "stores" (opens the stores), "store:<id>", "new-store". */
  to: string;
  label: string;
  /** Where they are now: a check, and it can't be picked. */
  here?: boolean;
  /** The stores (Stores' submenu): each store, a separator, New store…. */
  sub?: MoveEntry[];
  sep?: boolean;
}

/**
 * SpokPay · Creators · Stores › (every store, then New store…). `places` = where the person is ("spokpay", "creators",
 * "store:<id>"); `from` = the place the menu was opened in ("" = All people: every place they're in counts as here).
 */
export function moveEntries(o: { places: string[]; from: string; stores: { id: string; name: string }[] }): MoveEntry[] {
  const here = (to: string): boolean => (o.from ? o.from === to : o.places.includes(to));
  const stores: MoveEntry[] = [...o.stores].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ to: `store:${s.id}`, label: s.name, ...(here(`store:${s.id}`) ? { here: true } : {}) }));
  return [
    { to: "spokpay", label: "SpokPay", ...(here("spokpay") ? { here: true } : {}) },
    { to: "creators", label: "Creators", ...(here("creators") ? { here: true } : {}) },
    { to: "stores", label: "Stores", sub: [...stores, ...(stores.length ? [{ to: "", label: "", sep: true }] : []), { to: "new-store", label: "New store…" }] },
  ];
}

/** The place a sidebar row stands for: "store:<id>" in a store, its section's list, "" in All people. */
export const placeOfRow = (section: string, store: string): string => (store ? `store:${store}` : section === "creators" || section === "spokpay" ? section : "");
