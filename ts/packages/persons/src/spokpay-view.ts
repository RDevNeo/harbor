// What the Persons UI (Slint tab, phone) needs about SpokPay besides the calls: labels, which SpokPay
// store a person is, and the SpokPay agent's proposal / reply-draft prompts and parsers. Pure; ported
// from Person Hub's src/lib/spokpay.ts.
import type { AppData, Message, Person, Store } from "./model/types.ts";
import { BRIEF_PARTS, CATEGORIES, LIMITS, STATUS_MOVES } from "./spokpay-core.ts";
import type { Brief, BriefPart, Category, OwnerStore, ProposalFields, SpStore, SrEvent, SrStatus, StatusMove } from "./spokpay-core.ts";
import type { SpLinks } from "./spokpay.ts";

export { STATUS_MOVES };

// ---------- labels ----------

export const CATEGORY_LABEL: Record<Category, string> = { website: "Website", catalog: "Catalog", delivery: "Delivery", dashboard: "Dashboard", other: "Other" };
/** Headquarters' SITE_REQUEST_CATEGORY_FOR: one line each, for whoever picks. */
export const CATEGORY_HINT: Record<Category, string> = {
  website: "a change to the store’s website",
  catalog: "add, remove or update a catalog or its products",
  delivery: "a delivery that did not happen or went wrong",
  dashboard: "something in the dashboard SpokPay does for the store",
  other: "anything else",
};
export type Tone = "neutral" | "info" | "warning" | "muted";
/** Headquarters' STATUS (site-request-conversation/StatusMenu.tsx). */
export const STATUS: Record<SrStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "neutral" },
  working: { label: "Working", tone: "info" },
  review: { label: "Waiting review", tone: "warning" },
  completed: { label: "Completed", tone: "muted" },
  closed: { label: "Closed", tone: "muted" },
};
export const MOVE: Record<StatusMove, { label: string; hint: string }> = {
  working: { label: "Start working", hint: "The store sees SpokPay started on it." },
  review: { label: "Ask the store to review", hint: "The store approves or refuses what was done." },
  completed: { label: "Complete", hint: "The change is live. It can’t be reopened." },
  closed: { label: "Close", hint: "Dropped without the change. It can’t be reopened." },
};
export const BACK_TO_WORKING = { label: "Back to working", hint: "Takes it out of the store’s review." };
export const moveWords = (from: SrStatus, to: StatusMove): { label: string; hint: string } => (from === "review" && to === "working" ? BACK_TO_WORKING : MOVE[to]);
/** Headquarters' brief labels: only a site change has a place on the site. */
const PART_LABEL: Record<BriefPart, string> = { change: "What to change", where: "Where", references: "References", deadline: "Deadline", outcome: "Outcome" };
const OTHER_PART_LABEL: Record<BriefPart, string> = { ...PART_LABEL, change: "What is asked", where: "Where or which order" };
export const partLabel = (category: Category, part: BriefPart): string => (category === "website" ? PART_LABEL : OTHER_PART_LABEL)[part];
export const BRIEF_LABEL = PART_LABEL;
/** Headquarters' EVENT_WORDS (SiteRequestPane.tsx), plus the openings. */
export const EVENT_WORDS: Record<SrEvent, (store: string) => string> = {
  sent: (store) => `${store} opened the request`,
  opened_by_spokpay: () => "SpokPay opened the request",
  edited: () => "SpokPay edited the request",
  started: () => "SpokPay set it to Working",
  review: () => "SpokPay asked the store to review",
  completed: () => "SpokPay completed the request",
  closed: () => "SpokPay closed the request",
  approved: (store) => `${store} approved it`,
  rejected: (store) => `${store} asked for changes`,
};
export const isFinished = (s: SrStatus): boolean => s === "completed" || s === "closed";

/** An error as the user should read it: SpokPay's code apart (`[CODE] message`), no "Error: " prefix. */
export function spError(e: unknown): { code: string; message: string } {
  const code = typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "";
  const raw = (e instanceof Error ? e.message : String(e)).replace(/^Error: /, "");
  const m = /^\[([A-Z0-9_]+)\] ([\s\S]*)$/.exec(raw);
  return m ? { code: m[1] ?? "", message: m[2] ?? "" } : { code: /^[A-Z0-9_]+$/.test(code) ? code : "", message: raw };
}

// ---------- which SpokPay store a person is ----------

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const isSlug = (s: string): boolean => SLUG.test(s);

/** The person's Discord usernames, the SpokPay section's identity first (SpokPay's CRM keeps owners' handles). */
export function discordUsernames(p: Person): string[] {
  const out = [
    ...(p.identities ?? []).filter((i) => i.kind === "discord" && i.section === "spokpay").map((i) => i.username ?? ""),
    p.discordUsername ?? "",
    ...(p.identities ?? []).filter((i) => i.kind === "discord" && i.section !== "spokpay").map((i) => i.username ?? ""),
  ]
    .map((u) => u.trim().replace(/^@/, "").toLowerCase())
    .filter((u) => /^[\w.]{2,40}$/.test(u));
  return [...new Set(out)].slice(0, 4);
}

/** Persons stores the person owns, then those they're in. */
export function personStores(p: Person, data: Pick<AppData, "stores">): Store[] {
  const owned = data.stores.filter((s) => s.ownerId === p.id);
  return [...owned, ...data.stores.filter((s) => p.storeIds.includes(s.id) && !owned.includes(s))];
}

export interface StoreChoice {
  slug: string;
  name: string;
  why: string;
}
export interface Resolved {
  /** The store to use (null: the user picks from `choices` or searches). */
  slug: string | null;
  name: string;
  source: "person" | "store" | "crm" | "name" | null;
  choices: StoreChoice[];
}

/**
 * Which SpokPay store a person is: a store remembered for them, else for their Persons store, else
 * the stores SpokPay's CRM ties to their Discord handle (one → that one; several → pick), else a
 * SpokPay store named exactly like their Persons store.
 */
export function resolveStore(p: Person, data: Pick<AppData, "stores">, links: Pick<SpLinks, "people" | "stores"> | null, crm: OwnerStore[] = [], byName: SpStore[] = []): Resolved {
  const choices: StoreChoice[] = [];
  const add = (slug: string, name: string, why: string): void => {
    if (isSlug(slug) && !choices.some((c) => c.slug === slug)) choices.push({ slug, name, why });
  };
  const mine = personStores(p, data);
  const person = links?.people?.[p.id];
  const fromStore = mine.map((s) => ({ s, slug: links?.stores?.[s.id] })).find((x) => x.slug);
  const live = crm.filter((s) => s.state !== "deleted");
  for (const s of live) add(s.slug, s.name, s.role === "owner" ? "owner (CRM)" : `${s.role.replace("_", "-")} (CRM)`);
  const named = mine.length ? byName.filter((s) => mine.some((m) => m.name.trim().toLowerCase() === s.name.trim().toLowerCase())) : [];
  for (const s of named) add(s.slug, s.name, "same name");
  const nameOf = (slug: string): string => choices.find((c) => c.slug === slug)?.name ?? slug;
  if (person && isSlug(person)) {
    add(person, nameOf(person), "remembered");
    return { slug: person, name: nameOf(person), source: "person", choices };
  }
  if (fromStore?.slug && isSlug(fromStore.slug)) {
    add(fromStore.slug, fromStore.s.name, `remembered for ${fromStore.s.name}`);
    return { slug: fromStore.slug, name: nameOf(fromStore.slug), source: "store", choices };
  }
  const owners = live.filter((s) => s.role === "owner");
  const one = live.length === 1 ? live[0] : owners.length === 1 ? owners[0] : undefined;
  if (one) return { slug: one.slug, name: one.name, source: "crm", choices };
  const onlyNamed = named[0];
  if (!live.length && named.length === 1 && onlyNamed) return { slug: onlyNamed.slug, name: onlyNamed.name, source: "name", choices };
  return { slug: null, name: "", source: null, choices };
}

// ---------- what the SpokPay agent proposes (Headquarters' open-site-request skill) ----------

export interface Draft {
  fields: ProposalFields;
  why: string;
  store: string;
}
export const emptyBrief = (): Brief => ({ change: "", where: "", references: "", deadline: "", outcome: "" });

const clip = (s: unknown, n: number): string => (typeof s === "string" ? s.trim().slice(0, n) : "");
const jsonBlocks = (reply: string): string[] => {
  const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "").reverse();
  const bare = /\{[\s\S]*\}/.exec(reply)?.[0];
  return [...blocks, ...(bare ? [bare] : [])];
};

/** The proposal in an agent's reply: the last ```json block (or bare object) with a subject and details. */
export function parseDraft(reply: string): Draft | null {
  for (const text of jsonBlocks(reply)) {
    try {
      const j: unknown = JSON.parse(text);
      if (!j || typeof j !== "object") continue;
      const o = j as Record<string, unknown>;
      const subject = clip(o.subject, LIMITS.subject);
      const details = clip(o.details ?? o.summary, LIMITS.summary);
      if (!subject || !details) continue;
      const b = o.brief && typeof o.brief === "object" ? (o.brief as Record<string, unknown>) : {};
      const brief = emptyBrief();
      for (const k of BRIEF_PARTS) brief[k] = clip(b[k], LIMITS.briefPart);
      const category = (CATEGORIES as readonly unknown[]).includes(o.category) ? (o.category as Category) : "website";
      return { fields: { category, subject, details, brief }, why: clip(o.why, 200), store: clip(o.store, 100).toLowerCase() };
    } catch {
      // next
    }
  }
  return null;
}

/** When the agent can't be asked (or fails): the message itself, for the user to edit. */
export function localDraft(m: Pick<Message, "content">): ProposalFields {
  const text = (m.content ?? "").trim();
  const first =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  return { category: "website", subject: first.slice(0, LIMITS.subject), details: text.slice(0, LIMITS.summary), brief: { ...emptyBrief(), change: text.slice(0, LIMITS.briefPart) } };
}

interface Line {
  from: string;
  text: string;
  at: string;
}
const line = (m: Line): string => `[${m.at}] ${m.from}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}`;

/**
 * What SpokPay's agent (a chat in the SpokPay project) is asked: Headquarters' open-site-request
 * skill, answered as one JSON block instead of `hq site-request propose`.
 */
export function draftPrompt(o: { person: string; handle: string; stores: { slug: string; name: string }[]; message: Line & { images: string[] }; recent: Line[] }): string {
  return [
    'Propose a SpokPay site request for this store owner. Only propose it: Fagner reads your proposal in Hub\'s Persons tab, edits it and presses "Open site request", the only way one reaches SpokPay.',
    "Never open one yourself: no SpokPay admin API call, no `convex run`, no admin screen, no script. Never message the store owner.",
    "Read .claude/skills/site-requests/SKILL.md first (categories, the brief). The store reads the subject, details and brief: write them in Brazilian Portuguese (the dashboard-copy skill).",
    "",
    `Store owner: ${o.person}${o.handle ? ` (${o.handle})` : ""}, talking to SpokPay (Fagner) on Discord.`,
    `Their stores (SpokPay slugs): ${o.stores.length ? o.stores.map((s) => `${s.name} (${s.slug})`).join(", ") : 'not known; say which in "why"'}.`,
    "",
    "The message the request is about:",
    line(o.message) + (o.message.images.length ? `\n(images in it: ${o.message.images.join(", ")})` : ""),
    "",
    "Recent conversation (oldest first):",
    ...o.recent.map(line),
    "",
    "Category, by what SpokPay has to do: website (a change to its website), catalog (a catalog or its products added, removed or updated), delivery (a delivery that did not happen or went wrong), dashboard (something in its dashboard SpokPay does for it), other.",
    'subject: what is asked, in a few words (≤120). details: the paragraph SpokPay\'s page shows first, what the store gets (≤600). brief: for website every part you know; otherwise "change" is what is asked and "where" a good place for an order number. Leave a part "" instead of inventing it. why: one line for Fagner, in English: where the ask came from and why it needs a request.',
    "Answer with ONLY one ```json block shaped exactly:",
    '{"store":"<slug>","category":"website|catalog|delivery|dashboard|other","subject":"","details":"","brief":{"change":"","where":"","references":"","deadline":"","outcome":""},"why":""}',
  ].join("\n");
}

/** A reply SpokPay's agent drafts on a request (Headquarters' `hq site-request reply`): only waits for Fagner's Send. */
export function replyPrompt(o: { ref: string; store: string; subject: string; status: string; brief: Brief; messages: Line[]; ask: string }): string {
  return [
    `Draft SpokPay's next reply on site request ${o.ref} (${o.store}: ${o.subject}, status ${o.status}). Only draft it: Fagner reads it in Hub's Persons tab and presses Send. Never send it yourself, never call SpokPay's API, never move the request.`,
    "Read .claude/skills/site-requests/SKILL.md if you need how requests work. Write in Brazilian Portuguese, as SpokPay writes to a store (the dashboard-copy skill), short and concrete.",
    "",
    "What the store asked for:",
    ...BRIEF_PARTS.filter((p) => o.brief[p]).map((p) => `- ${PART_LABEL[p]}: ${o.brief[p]}`),
    "",
    "The conversation (oldest first):",
    ...o.messages.map(line),
    "",
    o.ask ? `Fagner's note: ${o.ask}` : "",
    'Answer with ONLY one ```json block: {"text":"<the reply>","why":"<one line for Fagner, in English>"}',
  ]
    .filter((x) => x !== "")
    .join("\n");
}

export function parseReplyDraft(reply: string): { text: string; why: string } | null {
  for (const text of jsonBlocks(reply)) {
    try {
      const j = JSON.parse(text) as Record<string, unknown> | null;
      const t = clip(j?.text, 4000);
      if (t) return { text: t, why: clip(j?.why, 200) };
    } catch {
      // next
    }
  }
  return null;
}

/** This PC's SpokPay checkout: preferred when several projects are SpokPay checkouts. */
export const SPOKPAY_CHECKOUT = "/home/igor/Documents/harbor-projects/spokpay";

/**
 * The project to draft in: one whose folder is a SpokPay checkout (".../spokpay"; not spokpay-crm or
 * spokpay-agents), this PC's own checkout first, then one on this PC, then any.
 */
export function pickSpokpayProject<P extends { id: string; name: string; path?: string | undefined; here?: boolean | undefined }>(projects: readonly P[]): P | null {
  const folder = (p: P): string => (p.path ?? "").replace(/\/+$/, "");
  const isCheckout = (p: P): boolean => /(^|\/)spokpay$/i.test(folder(p)) || (!p.path && p.name.trim().toLowerCase() === "spokpay");
  const all = projects.filter(isCheckout);
  return all.find((p) => folder(p) === SPOKPAY_CHECKOUT) ?? all.find((p) => p.here !== false && !!p.path) ?? all[0] ?? null;
}
