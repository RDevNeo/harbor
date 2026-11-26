// SpokPay admin API client: the pure part (request building, answer checking, store matching), ported
// from Person Hub's shell/spokpay-core.cjs. The contract is SpokPay's own source (github
// fagnersales/spokpay):
//   convex/assistant/api/admin/route.ts      site requests (list, thread, open), stores list
//   convex/assistant/api/crm/route.ts        CRM contacts (a store owner's Discord handle and stores)
//   convex/assistant/api/http/auth.ts        `Authorization: Bearer spk_admin_<64 hex>`, one permission per route
//   convex/assistant/api/http/errors.ts      `{ error: { code, message } }`: 401 UNAUTHENTICATED,
//                                            403 NOT_AUTHORIZED / ADMIN_ONLY, 404 *_NOT_FOUND,
//                                            429 LIMIT_REACHED (+ Retry-After), else 400
//   convex/assistant/api/http/rateLimits.ts  240 calls a minute per key
//   convex/siteRequests/{validators,rules}.ts  categories, statuses, events, limits
// spokpay.ts does the I/O.

export const DEFAULT_BASE = "https://modest-chipmunk-857.convex.site/assistant/v1";
export const KEY_FORMAT = /^spk_admin_[0-9a-f]{64}$/;

export const CATEGORIES = ["website", "catalog", "delivery", "dashboard", "other"] as const;
export const STATUSES = ["open", "working", "review", "completed", "closed"] as const;
export const SIDES = ["store", "spokpay"] as const;
export const EVENTS = ["sent", "opened_by_spokpay", "edited", "started", "review", "completed", "closed", "approved", "rejected"] as const;
export const BRIEF_PARTS = ["change", "where", "references", "deadline", "outcome"] as const;
export const STORE_STATES = ["open", "closed", "frozen", "deleted"] as const;

export type Category = (typeof CATEGORIES)[number];
export type SrStatus = (typeof STATUSES)[number];
export type Side = (typeof SIDES)[number];
export type SrEvent = (typeof EVENTS)[number];
export type BriefPart = (typeof BRIEF_PARTS)[number];
export type Brief = Record<BriefPart, string>;
export type StoreState = (typeof STORE_STATES)[number];

// convex/siteRequests/rules.ts and the admin route
export const LIMITS = { subject: 120, summary: 600, briefPart: 600, message: 4000, why: 200, images: 5, imageBytes: 10 * 1024 * 1024, idempotencyKey: 200, threadMessages: 100, storesPage: 20, crmPage: 100 } as const;

/** The permissions this app uses, each with the route that needs it. */
export const PERMISSIONS = ["site-requests:read", "site-requests:open", "site-requests:write", "site-requests:status", "stores:read", "crm:read"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const isKey = (s: unknown): s is string => typeof s === "string" && KEY_FORMAT.test(s);
/** "spk_admin_…1a2b": enough to tell keys apart, never the key. */
export const keyHint = (s: unknown): string => (isKey(s) ? `spk_admin_…${s.slice(-4)}` : "");

/** "sr-116", " SR-116 " → "SR-116"; anything else null. */
export function normalizeRef(s: unknown): string | null {
  const m = /^\s*sr-(\d{1,9})\s*$/i.exec(String(s ?? ""));
  return m ? `SR-${Number(m[1])}` : null;
}

export class SpokpayError extends Error {
  override readonly name = "SpokpayError";
  readonly retryAfter?: string;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    retryAfter?: string,
  ) {
    super(message);
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** A refusal as SpokPay answers it (`{ error: { code, message } }`), or the HTTP status when the body isn't that. */
export function errorFrom(status: number, body: unknown, retryAfter?: string): SpokpayError {
  const e = isObj(body) && isObj(body.error) ? body.error : null;
  const code = typeof e?.code === "string" ? e.code : status === 401 ? "UNAUTHENTICATED" : status === 403 ? "NOT_AUTHORIZED" : status === 429 ? "LIMIT_REACHED" : `HTTP_${status}`;
  const m = typeof e?.message === "string" ? e.message : "";
  // SpokPay's message is English and for logs; ours says what to do
  const hint =
    code === "UNAUTHENTICATED"
      ? "The SpokPay API key is invalid, revoked or expired."
      : code === "NOT_AUTHORIZED"
        ? `This SpokPay API key lacks a permission: ${m.replace(/ The admin can add it here:.*$/, "")}`.trim()
        : code === "LIMIT_REACHED"
          ? `SpokPay's rate limit: try again${retryAfter ? ` in ${retryAfter} s` : " in a minute"}.`
          : m || `SpokPay answered ${status}`;
  return new SpokpayError(status, code, hint, retryAfter);
}

// ---------- answers, checked against the route validators ----------

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return (list as readonly unknown[]).includes(v) ? (v as T) : fallback;
}
const sideOrNull = (v: unknown): Side | null => ((SIDES as readonly unknown[]).includes(v) ? (v as Side) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const bad = (what: string): SpokpayError => new SpokpayError(502, "BAD_ANSWER", `SpokPay answered an unexpected ${what}`);

/** GET /admin/site-requests/active | /waiting (adminAssistantSiteRequestRowValidator) */
export interface SrRow {
  ref: string;
  category: Category;
  subject: string;
  status: SrStatus;
  storeName: string;
  storeSlug: string | null;
  ownerEmail: string;
  lastMessagePreview: string | null;
  lastMessageSide: Side | null;
  waitingOn: Side | null;
  unread: boolean;
  createdAt: number;
  lastActivityAt: number;
}
export interface SrAttachment {
  url: string | null;
  name: string;
  contentType: string | null;
}
/** adminAssistantSiteRequestHeaderValidator */
export interface SrHeader {
  ref: string;
  category: Category;
  subject: string;
  status: SrStatus;
  store: { name: string; slug: string | null };
  waitingOn: Side | null;
  /** SpokPay's `summary` (the paragraph its admin page shows first): "" while the admin API doesn't send it. */
  summary: string;
  brief: Brief;
  attachments: SrAttachment[];
  createdAt: number;
  lastActivityAt: number;
}
export interface SrMessage {
  messageId: string;
  side: Side;
  authorName: string;
  text: string;
  attachments: SrAttachment[];
  createdAt: number;
}
/** GET /admin/site-requests/<ref>/messages */
export interface SrThread {
  siteRequest: SrHeader;
  messages: SrMessage[];
  events: { event: SrEvent; createdAt: number }[];
  hasMore: boolean;
}
/** GET /admin/stores (adminAssistantStoreRowValidator, slug present) */
export interface SpStore {
  name: string;
  slug: string;
  ownerEmail: string;
  iconUrl: string | null;
  frozenAt: number | null;
}
export interface CrmStore {
  slug: string;
  name: string;
  state: StoreState;
  role: string;
}
export interface CrmContact {
  ref: string;
  kind: string;
  name: string;
  discord: string;
  stores: CrmStore[];
}
/** A store of a CRM store owner (crmApiStoreValidator) found by their Discord handle. */
export interface OwnerStore extends CrmStore {
  contact: string;
}

export function readRow(xv: unknown): SrRow {
  const x = obj(xv);
  const ref = normalizeRef(x.ref);
  if (!isObj(xv) || !ref) throw bad("site request row");
  return {
    ref,
    category: oneOf(x.category, CATEGORIES, "website"),
    subject: str(x.subject),
    status: oneOf(x.status, STATUSES, "open"),
    storeName: str(x.storeName),
    storeSlug: strOrNull(x.storeSlug),
    ownerEmail: str(x.ownerEmail),
    lastMessagePreview: strOrNull(x.lastMessagePreview),
    lastMessageSide: sideOrNull(x.lastMessageSide),
    waitingOn: sideOrNull(x.waitingOn),
    unread: x.unread === true,
    createdAt: num(x.createdAt),
    lastActivityAt: num(x.lastActivityAt),
  };
}
export function readRows(body: unknown): SrRow[] {
  const b = obj(body);
  if (!Array.isArray(b.siteRequests)) throw bad("site request list");
  return b.siteRequests.map(readRow);
}

/** adminAssistantAttachmentValidator */
const readAttachment = (av: unknown): SrAttachment => {
  const a = obj(av);
  return { url: strOrNull(a.url), name: str(a.name), contentType: strOrNull(a.contentType) };
};

export function readHeader(xv: unknown): SrHeader {
  const x = obj(xv);
  const ref = normalizeRef(x.ref);
  if (!isObj(xv) || !ref) throw bad("site request");
  const brief = obj(x.brief);
  const store = obj(x.store);
  return {
    ref,
    category: oneOf(x.category, CATEGORIES, "website"),
    subject: str(x.subject),
    status: oneOf(x.status, STATUSES, "open"),
    store: { name: str(store.name), slug: strOrNull(store.slug) },
    waitingOn: sideOrNull(x.waitingOn),
    summary: str(x.summary),
    brief: Object.fromEntries(BRIEF_PARTS.map((p) => [p, str(brief[p])])) as Brief,
    attachments: arr(x.attachments).map(readAttachment),
    createdAt: num(x.createdAt),
    lastActivityAt: num(x.lastActivityAt),
  };
}

export function readThread(body: unknown): SrThread {
  if (!isObj(body)) throw bad("thread");
  return {
    siteRequest: readHeader(body.siteRequest),
    messages: arr(body.messages).map((mv) => {
      const m = obj(mv);
      return { messageId: str(m.messageId), side: oneOf(m.side, SIDES, "store"), authorName: str(m.authorName), text: str(m.text), attachments: arr(m.attachments).map(readAttachment), createdAt: num(m.createdAt) };
    }),
    events: arr(body.events)
      .map(obj)
      .filter((e) => (EVENTS as readonly unknown[]).includes(e.event))
      .map((e) => ({ event: e.event as SrEvent, createdAt: num(e.createdAt) })),
    hasMore: body.hasMore === true,
  };
}

/** POST /admin/site-requests → 201 `{ siteRequest, opened: true }` (200 `opened: false` for a retried Idempotency-Key). */
export function readOpened(body: unknown): { siteRequest: SrHeader; opened: boolean } {
  if (!isObj(body)) throw bad("answer to the opening");
  return { siteRequest: readHeader(body.siteRequest), opened: body.opened === true };
}

/** GET /admin/stores: buildListPageValidator(adminAssistantStoreRowValidator) */
export function readStorePage(body: unknown): { page: SpStore[]; isDone: boolean; continueCursor: string } {
  const b = obj(body);
  if (!Array.isArray(b.page)) throw bad("store list");
  return {
    page: b.page
      .map(obj)
      .filter((s) => typeof s.slug === "string" && s.slug)
      .map((s) => ({ name: str(s.name), slug: String(s.slug), ownerEmail: str(s.ownerEmail), iconUrl: strOrNull(s.iconUrl), frozenAt: typeof s.frozenAt === "number" ? s.frozenAt : null })),
    isDone: b.isDone !== false,
    continueCursor: str(b.continueCursor),
  };
}

/** GET /admin/crm/contacts: buildListPageValidator(crmApiContactValidator); only what this app reads. */
export function readCrmPage(body: unknown): CrmContact[] {
  const b = obj(body);
  if (!Array.isArray(b.page)) throw bad("CRM list");
  return b.page.map(obj).map((c) => ({
    ref: str(c.ref),
    kind: str(c.kind),
    name: str(c.name),
    discord: str(obj(c.channels).discord),
    stores: arr(c.stores)
      .map(obj)
      .filter((s) => typeof s.slug === "string" && s.slug)
      .map((s) => ({ slug: String(s.slug), name: str(s.name), state: oneOf(s.state, STORE_STATES, "open"), role: str(s.role) || "owner" })),
  }));
}

// ---------- requests ----------

const clip = (s: unknown, n: number): string =>
  String(s ?? "")
    .trim()
    .slice(0, n);

/** Image bytes for an opening or a reply (sent as multipart `images`). */
export interface ImageBytes {
  name: string;
  type: string;
  data: Uint8Array;
}

export interface OpeningInput {
  store?: string;
  category?: string;
  subject?: string;
  summary?: string;
  brief?: Partial<Record<BriefPart, string>>;
  images?: ImageBytes[];
}

export interface OpeningFields {
  store: string;
  category: Category;
  subject: string;
  summary: string;
  brief: Partial<Brief>;
}

export type Built<J, F> = { json: J; form?: undefined; images?: undefined } | { json?: undefined; form: F; images: ImageBytes[] };

function checkImages(images: unknown[]): ImageBytes[] {
  if (images.length > LIMITS.images) throw new SpokpayError(400, "INVALID_INPUT", `At most ${LIMITS.images} images`);
  return images.map((iv, i) => {
    const im = obj(iv);
    const data = im.data;
    const size = data instanceof Uint8Array ? data.byteLength : 0;
    const label = typeof im.name === "string" && im.name ? im.name : "";
    if (!(data instanceof Uint8Array) || size === 0 || size > LIMITS.imageBytes) throw new SpokpayError(400, "INVALID_INPUT", `${label || "An image"} must be between 1 byte and 10 MB`);
    if (!String(im.type ?? "").startsWith("image/")) throw new SpokpayError(400, "INVALID_INPUT", `${label || "A file"} is not an image`);
    return { name: String(label || `image-${i + 1}`).slice(0, 120), type: String(im.type), data };
  });
}

/**
 * The body of POST /admin/site-requests (site-requests:open): JSON `{ store, category, subject,
 * summary, brief }`, or multipart/form-data with the same fields as text (`brief` as JSON text) and
 * up to 5 `images`. Checked here as the route checks it, so a refusal never needs a round trip.
 */
export function buildOpening(input: OpeningInput | undefined): Built<OpeningFields, Record<string, string>> {
  const store = clip(input?.store, 200);
  if (!store) throw new SpokpayError(400, "INVALID_INPUT", "Pick the store");
  const category = input?.category ?? "website";
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new SpokpayError(400, "INVALID_INPUT", `category must be one of ${CATEGORIES.join(", ")}`);
  const subject = clip(input?.subject, LIMITS.subject);
  if (!subject) throw new SpokpayError(400, "SITE_REQUEST_SUBJECT_REQUIRED", "Add a subject");
  const summary = clip(input?.summary, LIMITS.summary);
  if (!summary) throw new SpokpayError(400, "SITE_REQUEST_SUMMARY_REQUIRED", "Add a summary");
  const brief: Partial<Brief> = {};
  for (const p of BRIEF_PARTS) {
    const v = clip(input?.brief?.[p], LIMITS.briefPart);
    if (v) brief[p] = v;
  }
  const images = checkImages(arr(input?.images));
  const fields: OpeningFields = { store, category: category as Category, subject, summary, brief };
  if (!images.length) return { json: fields };
  return { form: { store, category, subject, summary, brief: JSON.stringify(brief) }, images };
}

/** An Idempotency-Key: given, or made by the caller; at most 200 characters. */
export const idempotencyKey = (s: unknown): string | undefined => clip(s, LIMITS.idempotencyKey) || undefined;

// ---------- a person's stores ----------

const folded = (s: unknown): string =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");

/**
 * The stores whose CRM contact has one of these Discord usernames (SpokPay's CRM keeps a store
 * owner's Discord handle as `channels.discord`). Deleted stores are left out; one entry per slug.
 */
export function storesOfDiscord(contacts: readonly Pick<CrmContact, "ref" | "discord" | "stores">[], usernames: readonly string[]): OwnerStore[] {
  const want = new Set(usernames.map(folded).filter(Boolean));
  const out = new Map<string, OwnerStore>();
  for (const c of contacts) {
    if (!want.has(folded(c.discord))) continue;
    for (const s of c.stores) if (s.state !== "deleted" && !out.has(s.slug)) out.set(s.slug, { slug: s.slug, name: s.name, state: s.state, role: s.role, contact: c.ref });
  }
  return [...out.values()];
}

/** Which permissions a probe answer shows: 2xx (or a 400/404 refusal made after the permission check) = held; 403 = not. */
export function heldFromProbe(status: number, code?: string): boolean | null {
  if (status === 401) return null; // the key itself is refused
  if (status === 403) return false;
  if (status >= 200 && status < 300) return true;
  // POST /admin/site-requests checks the permission before reading the body: {} is 400 INVALID_INPUT with it
  if (status === 400 || status === 404) return code !== "ADMIN_ONLY";
  return null;
}

// ---------- reply and status (key only) ----------

export type StatusMove = "working" | "review" | "completed" | "closed";
export const MOVES: readonly StatusMove[] = ["working", "review", "completed", "closed"];
/** SpokPay's own table (ADMIN_TRANSITIONS): where the admin moves a request; nothing moves one back to open. */
export const STATUS_MOVES: Record<SrStatus, readonly StatusMove[]> = {
  open: ["working", "review", "completed", "closed"],
  working: ["review", "completed", "closed"],
  review: ["working", "completed", "closed"],
  completed: [],
  closed: [],
};

/** POST /admin/site-requests/<ref>/messages (site-requests:write): JSON `{ text }`, or a form with `text` and up to 5 `images`. */
export function buildReply(input: { text?: string; images?: ImageBytes[] | undefined } | undefined): Built<{ text: string }, { text: string }> {
  const text = String(input?.text ?? "").trim();
  const raw = arr(input?.images);
  if (!text && !raw.length) throw new SpokpayError(400, "SITE_REQUEST_MESSAGE_EMPTY", "Write the reply");
  if (text.length > LIMITS.message) throw new SpokpayError(400, "INVALID_INPUT", `The reply has ${text.length} characters; SpokPay takes ${LIMITS.message}`);
  const images = checkImages(raw);
  if (!images.length) return { json: { text } };
  return { form: { text }, images };
}

/** `{ siteRequest, message }` */
export function readReplied(body: unknown): { siteRequest: SrHeader; message: SrMessage | null } {
  if (!isObj(body)) throw bad("answer to the reply");
  const t = readThread({ siteRequest: body.siteRequest, messages: body.message ? [body.message] : [], events: [], hasMore: false });
  return { siteRequest: t.siteRequest, message: t.messages[0] ?? null };
}

// Headquarters' wording of a refusal (siteRequestConversation/replies.ts and statusRules.ts).
export function replyRefusal(e: SpokpayError): string {
  if (e.status === 403 && /site-requests:write/.test(e.message)) return "The SpokPay key lacks site-requests:write. Add it in Connect Claude on spokpay.com/admin.";
  if (e.code === "SITE_REQUEST_ALREADY_COMPLETED") return "SpokPay finished this request, so it takes no reply.";
  if (e.status === 404) return "SpokPay no longer has this request.";
  return e.message;
}
export function statusRefusal(e: SpokpayError): string {
  if (e.status === 403 && /site-requests:status/.test(e.message)) return "The SpokPay key lacks site-requests:status. Add it in Connect Claude on spokpay.com/admin.";
  if (e.code === "SITE_REQUEST_TRANSITION_INVALID") return "SpokPay does not move this request there from where it is now. It may have changed since this page read it.";
  if (e.status === 404) return "SpokPay no longer has this request.";
  return e.message;
}

// ---------- proposals (Headquarters' siteRequestProposals): an agent or the user proposes, the user opens ----------

export const PROPOSAL_STATES = ["waiting", "opening", "opened", "failed", "discarded"] as const;

/** What the request will say. `details` is SpokPay's `summary`, the paragraph its admin page shows first. */
export interface ProposalFields {
  category: Category;
  subject: string;
  details: string;
  brief: Brief;
}
export type ProposalState =
  | { kind: "waiting" }
  | { kind: "opening"; startedAt: number }
  | { kind: "opened"; at: number; ref: string }
  | { kind: "failed"; at: number; reason: string; fix: "connections" | "none" }
  | { kind: "discarded"; at: number };
export interface ProposalImage {
  url: string;
  name: string;
  type: string;
  picked: boolean;
}
/** `agent`: the fields as the agent last wrote them; `shown` adds the user's edits, which Open sends. */
export interface Proposal {
  id: string;
  personId: string;
  store: { slug: string; name: string } | null;
  agent: ProposalFields;
  shown: ProposalFields;
  why: string;
  from: { name: string; chat: string | null };
  images: ProposalImage[];
  source: { messageId: string; account: string } | null;
  createdAt: number;
  state: ProposalState;
}
export interface ReplyDraft {
  id: string;
  ref: string;
  text: string;
  agentText: string;
  why: string;
  from: { name: string; chat: string | null };
  createdAt: number;
}

/** Headquarters' readFields: subject and details required, SpokPay's limits. */
export function readFields(input: unknown): ProposalFields {
  const i = obj(input);
  const brief = obj(i.brief);
  return {
    category: oneOf(i.category, CATEGORIES, "website"),
    subject: clip(i.subject, LIMITS.subject),
    details: clip(i.details, LIMITS.summary),
    brief: Object.fromEntries(BRIEF_PARTS.map((p) => [p, clip(brief[p], LIMITS.briefPart)])) as Brief,
  };
}
export function readProposal(xv: unknown): Proposal | null {
  if (!isObj(xv) || typeof xv.id !== "string") return null;
  const x = xv;
  const id = xv.id;
  const st = obj(x.state);
  const state = (PROPOSAL_STATES as readonly unknown[]).includes(st.kind) ? (st as unknown as ProposalState) : { kind: "waiting" as const };
  const store = obj(x.store);
  const from = obj(x.from);
  const source = obj(x.source);
  return {
    id,
    personId: str(x.personId),
    store: isObj(x.store) && typeof store.slug === "string" ? { slug: store.slug, name: str(store.name) } : null,
    agent: readFields(x.agent ?? x.shown),
    shown: readFields(x.shown),
    why: clip(x.why, LIMITS.why),
    from: { name: str(from.name) || "You", chat: strOrNull(from.chat) },
    images: arr(x.images)
      .map(obj)
      .filter((i) => typeof i.url === "string")
      .slice(0, 20)
      .map((i) => ({ url: String(i.url), name: str(i.name) || "image", type: str(i.type), picked: i.picked === true })),
    source: typeof source.messageId === "string" ? { messageId: source.messageId, account: str(source.account) } : null,
    createdAt: num(x.createdAt),
    state,
  };
}
/** A reply an agent drafted on a request: it only waits for the user's Send. */
export function readDraft(xv: unknown): ReplyDraft | null {
  const x = obj(xv);
  const ref = normalizeRef(x.ref);
  if (typeof x.id !== "string" || !ref) return null;
  const from = obj(x.from);
  return {
    id: x.id,
    ref,
    text: String(x.text ?? "").slice(0, LIMITS.message),
    agentText: String(x.agentText ?? x.text ?? "").slice(0, LIMITS.message),
    why: clip(x.why, LIMITS.why),
    from: { name: str(from.name) || "SpokPay agent", chat: strOrNull(from.chat) },
    createdAt: num(x.createdAt),
  };
}
