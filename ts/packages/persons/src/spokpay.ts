// SpokPay admin API (site requests), ported from Person Hub's shell/spokpay.cjs. The admin key is
// pasted once and kept ONLY here: <dir>/spokpay.json (0600, never sent to the phone or the UI, never
// logged). It is only ever sent to SpokPay's API; callers get the calls below and their answers.
// <dir>/spokpay-links.json (0600) remembers which SpokPay store a person / a Persons store is, and the
// refs opened from here; <dir>/spokpay-proposals.json keeps proposals and reply drafts. The contract
// is in spokpay-core.ts.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "@harbor/store";
import * as core from "./spokpay-core.ts";
import type { Category, ImageBytes, OwnerStore, Permission, Proposal, ProposalFields, ReplyDraft, SpStore, SrHeader, SrMessage, SrRow, SrThread, StatusMove } from "./spokpay-core.ts";

const TIMEOUT = 20_000;

export interface SpokpayStatus {
  connected: boolean;
  /** "spk_admin_…1a2b" */
  keyHint: string;
  /** true held, false not, null unknown (couldn't ask). */
  permissions: Partial<Record<Permission, boolean | null>>;
  checkedAt: number | null;
  savedAt: number | null;
  error: string;
  base: string;
}

export interface SpLinks {
  version: 1;
  people: Record<string, string>;
  stores: Record<string, string>;
  refs: Record<string, string[]>;
}

export type SpokpayEvent = { type: "spokpay-status"; status: SpokpayStatus } | { type: "spokpay-links" } | { type: "spokpay-proposals" };

export interface SpokpayOptions {
  dir: string;
  emit?: (ev: SpokpayEvent) => void;
  log?: (...a: unknown[]) => void;
  fetch?: (url: URL, init: { method: string; headers: Record<string, string>; body?: string | FormData; signal?: AbortSignal }) => Promise<Response>;
  /** SpokPay's API base (`PH_SPOKPAY_API` overrides the default). */
  base?: string;
}

export interface ProposeInput {
  personId: string;
  store?: { slug: string; name: string } | null;
  fields?: Partial<ProposalFields> | Record<string, unknown>;
  why?: string;
  from?: { name: string; chat?: string | null };
  images?: { url: string; name?: string; type?: string; picked?: boolean }[];
  source?: { messageId: string; account: string };
}

export interface ProposalPatch {
  fields?: ProposalFields;
  agent?: boolean;
  store?: { slug: string; name: string } | null;
  picked?: string[];
  why?: string;
}

export interface Spokpay {
  status(): SpokpayStatus;
  setKey(raw: string): Promise<SpokpayStatus>;
  clearKey(): SpokpayStatus;
  refresh(): Promise<SpokpayStatus>;
  active(): Promise<SrRow[]>;
  waiting(): Promise<SrRow[]>;
  thread(ref: string, limit?: number): Promise<SrThread>;
  requests(slugs: string[]): Promise<SrRow[]>;
  stores(search: string): Promise<SpStore[]>;
  ownerStores(usernames: string[]): Promise<OwnerStore[]>;
  reply(ref: string, input: { text: string; images?: ImageBytes[] }, idempotencyKey?: string): Promise<{ siteRequest: SrHeader; message: SrMessage | null }>;
  setStatus(ref: string, to: StatusMove | string): Promise<{ siteRequest: SrHeader }>;
  proposals(): Proposal[];
  propose(input: ProposeInput): Proposal;
  saveProposal(id: string, patch: ProposalPatch): Proposal;
  discardProposal(id: string): void;
  openProposal(id: string, fields?: ProposalFields, images?: ImageBytes[]): Promise<Proposal | undefined>;
  drafts(ref?: string): ReplyDraft[];
  saveDraft(input: { id?: string; ref: string; text: string; why?: string; from?: { name: string; chat?: string | null } }): ReplyDraft;
  discardDraft(id: string): void;
  sendDraft(id: string, text?: string, images?: ImageBytes[]): Promise<{ siteRequest: SrHeader; message: SrMessage | null }>;
  links(): SpLinks;
  setLink(kind: "people" | "stores", id: string, slug: string | null): SpLinks;
  start(): void;
}

interface Account {
  version: 1;
  key: string;
  savedAt: number;
  checkedAt: number;
  permissions: Partial<Record<Permission, boolean | null>>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});

interface ReqOpts {
  key?: string | undefined;
  json?: unknown;
  form?: Record<string, string> | undefined;
  images?: ImageBytes[] | undefined;
  query?: Record<string, string | number | undefined>;
  idem?: string | undefined;
}

export function createSpokpay(o: SpokpayOptions): Spokpay {
  const emit = o.emit ?? (() => {});
  const log = o.log ?? (() => {});
  const http = o.fetch ?? ((url: URL, init: RequestInit) => fetch(url, init));
  const base = o.base ?? (process.env.PH_SPOKPAY_API || core.DEFAULT_BASE);
  const FILE = join(o.dir, "spokpay.json");
  const LINKS = join(o.dir, "spokpay-links.json");
  const PROPOSALS = join(o.dir, "spokpay-proposals.json");
  const readJson = (f: string): unknown => {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  };
  const writeJson = (f: string, v: unknown): void => writePrivate(f, JSON.stringify(v, null, 2));
  let acct: Account | null = (() => {
    const j = obj(readJson(FILE));
    return j.version === 1 && core.isKey(j.key) ? (j as unknown as Account) : null;
  })();
  let error = "";

  const status = (): SpokpayStatus => ({
    connected: !!acct,
    keyHint: acct ? core.keyHint(acct.key) : "",
    permissions: acct?.permissions ?? {},
    checkedAt: acct?.checkedAt ?? null,
    savedAt: acct?.savedAt ?? null,
    error,
    base,
  });
  const changed = (): void => emit({ type: "spokpay-status", status: status() });

  /** One call: `Authorization: Bearer <key>`, JSON or form body, `{ error: { code, message } }` on refusal. */
  async function request(method: string, route: string, { key = acct?.key, json, form, images, query, idem }: ReqOpts = {}): Promise<{ status: number; body: unknown }> {
    if (!key) throw new core.SpokpayError(401, "NOT_CONNECTED", "Connect the SpokPay API first (SpokPay section › + › SpokPay API)");
    const url = new URL(`${base}${route}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    if (idem) headers["Idempotency-Key"] = idem;
    let body: string | FormData | undefined;
    if (form) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(form)) fd.append(k, String(v));
      for (const im of images ?? []) fd.append("images", new Blob([im.data], { type: im.type }), im.name);
      body = fd;
    } else if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    }
    let res: Response;
    try {
      res = await http(url, body === undefined ? { method, headers, signal: AbortSignal.timeout(TIMEOUT) } : { method, headers, body, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (e) {
      throw new core.SpokpayError(0, "NETWORK", `Can't reach SpokPay (${e instanceof Error && e.name === "TimeoutError" ? "timed out" : e instanceof Error ? e.message : String(e)})`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    log("spokpay", method, route.replace(/SR-\d+/i, "SR-…"), res.status); // never the key, never the text
    if (!res.ok) throw core.errorFrom(res.status, parsed, res.headers.get("retry-after") ?? undefined);
    return { status: res.status, body: parsed };
  }

  const isSpError = (e: unknown): e is core.SpokpayError => e instanceof core.SpokpayError;

  /**
   * What the key may do, by asking without writing: GETs, and for the write permissions their
   * routes with an empty body (each checks the permission before the body: 403 without it, 400
   * INVALID_INPUT with it; nothing is written either way).
   */
  async function probe(key: string): Promise<Partial<Record<Permission, boolean | null>>> {
    const one = async (perm: Permission, fn: () => Promise<{ status: number }>): Promise<[Permission, boolean | null]> => {
      try {
        const r = await fn();
        return [perm, core.heldFromProbe(r.status)];
      } catch (e) {
        if (isSpError(e) && e.status === 401) throw e;
        if (!isSpError(e)) return [perm, null];
        return [perm, e.status === 0 || e.status === 429 ? null : core.heldFromProbe(e.status, e.code)];
      }
    };
    const results = await Promise.all([
      one("site-requests:read", () => request("GET", "/admin/site-requests/active", { key })),
      one("site-requests:open", () => request("POST", "/admin/site-requests", { key, json: {} })),
      // the reply and status routes check the permission before the ref and the body: {} on SR-0 is
      // 403 without it, 400 INVALID_INPUT with it, and writes nothing either way
      one("site-requests:write", () => request("POST", "/admin/site-requests/SR-0/messages", { key, json: {} })),
      one("site-requests:status", () => request("POST", "/admin/site-requests/SR-0/status", { key, json: {} })),
      one("stores:read", () => request("GET", "/admin/stores", { key, query: { numItems: 1 } })),
      one("crm:read", () => request("GET", "/admin/crm/contacts", { key, query: { kind: "store_owner", numItems: 1 } })),
    ]);
    return Object.fromEntries(results);
  }

  async function setKey(raw: string): Promise<SpokpayStatus> {
    const key = String(raw ?? "").trim();
    if (!core.isKey(key)) throw new core.SpokpayError(400, "INVALID_INPUT", "That is not a SpokPay admin key (spk_admin_ and 64 characters)");
    const permissions = await probe(key); // 401 (invalid, revoked, expired) throws
    if (permissions["site-requests:read"] === false) throw new core.SpokpayError(403, "NOT_AUTHORIZED", "This key lacks site-requests:read (tick “Read site requests” in Connect Claude on spokpay.com/admin)");
    acct = { version: 1, key, savedAt: Date.now(), checkedAt: Date.now(), permissions };
    writeJson(FILE, acct);
    error = "";
    log("spokpay: key saved", core.keyHint(key));
    changed();
    return status();
  }

  async function refresh(): Promise<SpokpayStatus> {
    if (!acct) return status();
    try {
      acct = { ...acct, permissions: await probe(acct.key), checkedAt: Date.now() };
      writeJson(FILE, acct);
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    changed();
    return status();
  }

  function clearKey(): SpokpayStatus {
    acct = null;
    error = "";
    try {
      rmSync(FILE, { force: true });
    } catch {
      // gone
    }
    log("spokpay: key removed");
    changed();
    return status();
  }

  const need = (perm: Permission): void => {
    if (acct && acct.permissions?.[perm] === false) throw new core.SpokpayError(403, "NOT_AUTHORIZED", `This SpokPay API key lacks ${perm}`);
  };
  /** A call that, refused with 401, means the key went bad: say so in the status too. */
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (isSpError(e) && e.status === 401 && acct) {
        error = e.message;
        changed();
      }
      throw e;
    }
  };

  // ---------- links: person / Persons store → SpokPay store slug, and refs opened here ----------
  const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
  const ID = /^[\w-]{1,80}$/;
  const loadLinks = (): SpLinks => {
    const j = obj(readJson(LINKS));
    return { version: 1, people: obj(j.people) as Record<string, string>, stores: obj(j.stores) as Record<string, string>, refs: obj(j.refs) as Record<string, string[]> };
  };
  function setLink(kind: "people" | "stores", id: string, slug: string | null): SpLinks {
    if (!["people", "stores"].includes(kind) || !ID.test(String(id))) throw new Error("Invalid link");
    if (slug !== null && slug !== undefined && !SLUG.test(String(slug))) throw new Error("Invalid store slug");
    const l = loadLinks();
    if (slug === null || slug === undefined) delete l[kind][id];
    else l[kind][id] = String(slug);
    writeJson(LINKS, l);
    emit({ type: "spokpay-links" });
    return l;
  }
  function rememberRef(slug: string | null | undefined, ref: string): void {
    if (!slug || !SLUG.test(slug) || !core.normalizeRef(ref)) return;
    const l = loadLinks();
    const prev = l.refs[slug];
    const refs = Array.isArray(prev) ? prev.filter((r) => r !== ref) : [];
    l.refs[slug] = [ref, ...refs].slice(0, 50);
    writeJson(LINKS, l);
    emit({ type: "spokpay-links" });
  }

  // ---------- reads ----------
  const active = (): Promise<SrRow[]> =>
    guarded(async () => {
      need("site-requests:read");
      return core.readRows((await request("GET", "/admin/site-requests/active")).body);
    });
  const waiting = (): Promise<SrRow[]> =>
    guarded(async () => {
      need("site-requests:read");
      return core.readRows((await request("GET", "/admin/site-requests/waiting")).body);
    });
  const thread = (ref: string, limit: number = core.LIMITS.threadMessages): Promise<SrThread> =>
    guarded(async () => {
      need("site-requests:read");
      const r = core.normalizeRef(ref);
      if (!r) throw new core.SpokpayError(400, "INVALID_INPUT", "Not a site request ref (SR-…)");
      const n = Math.max(1, Math.min(core.LIMITS.threadMessages, Number(limit) || core.LIMITS.threadMessages));
      return core.readThread((await request("GET", `/admin/site-requests/${encodeURIComponent(r)}/messages`, { query: { limit: n } })).body);
    });

  /**
   * A store's requests, newest activity first: the active ones (the API lists only those) plus the
   * refs opened from here, read one by one so finished ones still show.
   */
  async function requests(slugs: string[]): Promise<SrRow[]> {
    const want = new Set(
      (Array.isArray(slugs) ? slugs : [])
        .map(String)
        .filter((s) => SLUG.test(s))
        .slice(0, 20),
    );
    if (!want.size) return [];
    const rows = (await active()).filter((r) => r.storeSlug && want.has(r.storeSlug));
    const have = new Set(rows.map((r) => r.ref));
    const links = loadLinks();
    const extra = [...want]
      .flatMap((s) => {
        const l = links.refs[s];
        return Array.isArray(l) ? l : [];
      })
      .filter((r) => !have.has(r))
      .slice(0, 15);
    const more = await Promise.all(
      extra.map(async (ref): Promise<SrRow | null> => {
        try {
          const t = await thread(ref, 1);
          const h = t.siteRequest;
          const last = t.messages.at(-1);
          return {
            ref: h.ref,
            category: h.category,
            subject: h.subject,
            status: h.status,
            storeName: h.store.name,
            storeSlug: h.store.slug,
            ownerEmail: "",
            lastMessagePreview: last ? last.text.slice(0, 140) : null,
            lastMessageSide: last?.side ?? null,
            waitingOn: h.waitingOn,
            unread: false,
            createdAt: h.createdAt,
            lastActivityAt: h.lastActivityAt,
          };
        } catch {
          return null;
        }
      }),
    );
    return [...rows, ...more.filter((r): r is SrRow => r !== null)].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** GET /admin/stores?search= (stores:read): name or slug, up to 20. */
  const stores = (search: string): Promise<SpStore[]> =>
    guarded(async () => {
      need("stores:read");
      const q = String(search ?? "")
        .trim()
        .slice(0, 100);
      return core.readStorePage((await request("GET", "/admin/stores", { query: { search: q || undefined, numItems: core.LIMITS.storesPage } })).body).page;
    });

  /** The stores of the store owners whose Discord handle is one of `usernames` (crm:read). */
  const ownerStores = (usernames: string[]): Promise<OwnerStore[]> =>
    guarded(async () => {
      need("crm:read");
      const names = [
        ...new Set(
          (Array.isArray(usernames) ? usernames : [])
            .map((u) =>
              String(u)
                .trim()
                .replace(/^@/, ""),
            )
            .filter((u) => /^[\w.]{2,40}$/.test(u)),
        ),
      ].slice(0, 4);
      const pages = await Promise.all(names.map(async (u) => core.readCrmPage((await request("GET", "/admin/crm/contacts", { query: { kind: "store_owner", search: u, numItems: 20 } })).body)));
      return core.storesOfDiscord(pages.flat(), names);
    });

  /** POST /admin/site-requests (site-requests:open): the one write, only on the user's Open. */
  const open = (input: core.OpeningInput, idem?: string): Promise<{ siteRequest: SrHeader; opened: boolean }> =>
    guarded(async () => {
      need("site-requests:open");
      const built = core.buildOpening(input);
      const key = core.idempotencyKey(idem) ?? randomUUID();
      const r = await request("POST", "/admin/site-requests", built.json ? { json: built.json, idem: key } : { form: built.form, images: built.images, idem: key });
      const out = core.readOpened(r.body);
      rememberRef(out.siteRequest.store.slug ?? built.json?.store ?? built.form?.store, out.siteRequest.ref);
      log("spokpay: site request opened", out.siteRequest.ref, out.opened ? "new" : "retry");
      return out;
    });

  // ---------- reply and status (the user's Send / status menu only) ----------
  const reply = (ref: string, input: { text: string; images?: ImageBytes[] }, idem?: string): Promise<{ siteRequest: SrHeader; message: SrMessage | null }> =>
    guarded(async () => {
      need("site-requests:write");
      const r = core.normalizeRef(ref);
      if (!r) throw new core.SpokpayError(400, "INVALID_INPUT", "Not a site request ref (SR-…)");
      const built = core.buildReply(input);
      const key = core.idempotencyKey(idem) ?? randomUUID();
      try {
        const res = await request("POST", `/admin/site-requests/${encodeURIComponent(r)}/messages`, built.json ? { json: built.json, idem: key } : { form: built.form, images: built.images, idem: key });
        log("spokpay: replied on", "SR-…");
        return core.readReplied(res.body);
      } catch (e) {
        if (isSpError(e) && e.status) throw new core.SpokpayError(e.status, e.code, core.replyRefusal(e));
        throw e;
      }
    });
  const setStatus = (ref: string, to: string): Promise<{ siteRequest: SrHeader }> =>
    guarded(async () => {
      need("site-requests:status");
      const r = core.normalizeRef(ref);
      if (!r) throw new core.SpokpayError(400, "INVALID_INPUT", "Not a site request ref (SR-…)");
      if (!(core.MOVES as readonly string[]).includes(to)) throw new core.SpokpayError(400, "INVALID_INPUT", "status must be working, review, completed or closed");
      try {
        const res = await request("POST", `/admin/site-requests/${encodeURIComponent(r)}/status`, { json: { status: to } });
        log("spokpay: status moved", to);
        return { siteRequest: core.readHeader(obj(res.body).siteRequest) };
      } catch (e) {
        if (isSpError(e) && e.status) throw new core.SpokpayError(e.status, e.code, core.statusRefusal(e));
        throw e;
      }
    });

  // ---------- proposals and reply drafts (Headquarters' model: proposed, then the user's Open / Send) ----------
  interface Box {
    version: 1;
    proposals: Proposal[];
    drafts: ReplyDraft[];
  }
  const loadBox = (): Box => {
    const j = obj(readJson(PROPOSALS));
    return {
      version: 1,
      proposals: (Array.isArray(j.proposals) ? j.proposals : []).map(core.readProposal).filter((p): p is Proposal => p !== null),
      drafts: (Array.isArray(j.drafts) ? j.drafts : []).map(core.readDraft).filter((d): d is ReplyDraft => d !== null),
    };
  };
  const saveBox = (b: Box): void => {
    // keep what waits, and the newest 300 others
    const live = b.proposals.filter((p) => ["waiting", "opening", "failed"].includes(p.state.kind));
    const rest = b.proposals
      .filter((p) => !live.includes(p))
      .sort((x, y) => y.createdAt - x.createdAt)
      .slice(0, 300);
    writeJson(PROPOSALS, { version: 1, proposals: [...live, ...rest], drafts: b.drafts.slice(-200) });
    emit({ type: "spokpay-proposals" });
  };
  const newId = (): string => `sp_${randomBytes(8).toString("hex")}`;
  const proposals = (): Proposal[] => loadBox().proposals.filter((p) => p.state.kind !== "discarded");
  function propose(input: ProposeInput): Proposal {
    if (!ID.test(String(input?.personId ?? ""))) throw new Error("Invalid person");
    const b = loadBox();
    const fields = core.readFields(input.fields);
    const p = core.readProposal({
      id: newId(),
      personId: input.personId,
      store: input.store ?? null,
      agent: fields,
      shown: fields,
      why: input.why,
      from: input.from,
      images: input.images,
      source: input.source,
      createdAt: Date.now(),
      state: { kind: "waiting" },
    });
    if (!p) throw new Error("Invalid proposal");
    b.proposals.push(p);
    saveBox(b);
    return p;
  }
  /** The user's edits (fields, store, picked images) while it waits; an agent's revision with `agent: true`. */
  function saveProposal(id: string, patch: ProposalPatch): Proposal {
    const b = loadBox();
    const p = b.proposals.find((x) => x.id === id);
    if (!p) throw new Error("This proposal is gone");
    if (p.state.kind !== "waiting" && p.state.kind !== "failed") throw new Error("It is no longer waiting");
    if (patch?.fields) {
      p.shown = core.readFields(patch.fields);
      if (patch.agent) p.agent = p.shown;
    }
    if (patch && "store" in patch) p.store = patch.store && typeof patch.store.slug === "string" && SLUG.test(patch.store.slug) ? { slug: patch.store.slug, name: String(patch.store.name ?? "").slice(0, 120) } : null;
    if (Array.isArray(patch?.picked)) {
      const on = new Set(patch.picked.map(String));
      p.images = p.images.map((i) => ({ ...i, picked: on.has(i.url) }));
    }
    if (typeof patch?.why === "string") p.why = patch.why.slice(0, core.LIMITS.why);
    saveBox(b);
    return p;
  }
  function discardProposal(id: string): void {
    const b = loadBox();
    const p = b.proposals.find((x) => x.id === id);
    if (p && p.state.kind !== "opened" && p.state.kind !== "opening") {
      p.state = { kind: "discarded", at: Date.now() };
      saveBox(b);
    }
  }
  /** Open: the one write that reaches SpokPay and the store. `images`: the picked images' bytes. */
  async function openProposal(id: string, fields?: ProposalFields, images?: ImageBytes[]): Promise<Proposal | undefined> {
    let b = loadBox();
    let p = b.proposals.find((x) => x.id === id);
    if (!p) throw new Error("This proposal is gone");
    if (p.state.kind !== "waiting" && p.state.kind !== "failed") throw new Error(p.state.kind === "opened" ? `Already opened as ${p.state.ref}` : "It is already opening");
    if (fields) p.shown = core.readFields(fields);
    const store = p.store;
    if (!store) throw new core.SpokpayError(400, "INVALID_INPUT", "Pick the store");
    p.state = { kind: "opening", startedAt: Date.now() };
    saveBox(b);
    // the same proposal, store and subject retried answers the request the first Open made
    const idem = `${p.id}-${createHash("sha1").update(`${store.slug}\n${p.shown.subject}`).digest("hex").slice(0, 12)}`;
    let next: Proposal["state"];
    try {
      const out = await open({ store: store.slug, category: p.shown.category as Category, subject: p.shown.subject, summary: p.shown.details, brief: p.shown.brief, images: Array.isArray(images) ? images : [] }, idem);
      next = { kind: "opened", at: Date.now(), ref: out.siteRequest.ref };
    } catch (e) {
      const code = isSpError(e) ? e.code : "";
      next = { kind: "failed", at: Date.now(), reason: (e instanceof Error ? e.message : String(e)).slice(0, 300), fix: code === "NOT_AUTHORIZED" || code === "UNAUTHENTICATED" || code === "NOT_CONNECTED" ? "connections" : "none" };
    }
    b = loadBox();
    p = b.proposals.find((x) => x.id === id);
    if (p) {
      p.state = next;
      saveBox(b);
    }
    return p;
  }

  const drafts = (ref?: string): ReplyDraft[] => {
    const r = core.normalizeRef(ref);
    return loadBox().drafts.filter((d) => !r || d.ref === r);
  };
  function saveDraft(input: { id?: string; ref: string; text: string; why?: string; from?: { name: string; chat?: string | null } }): ReplyDraft {
    const b = loadBox();
    const ref = core.normalizeRef(input?.ref);
    if (!ref) throw new Error("Not a site request ref");
    const old = typeof input?.id === "string" ? b.drafts.find((d) => d.id === input.id) : undefined;
    if (old) {
      old.text = String(input.text ?? "").slice(0, core.LIMITS.message);
      saveBox(b);
      return old;
    }
    const d = core.readDraft({ id: newId(), ref, text: input?.text, agentText: input?.text, why: input?.why, from: input?.from, createdAt: Date.now() });
    if (!d) throw new Error("Invalid draft");
    b.drafts.push(d);
    saveBox(b);
    return d;
  }
  function discardDraft(id: string): void {
    const b = loadBox();
    b.drafts = b.drafts.filter((d) => d.id !== id);
    saveBox(b);
  }
  /** Send: the draft (as edited) goes to the store as SpokPay's reply; the draft goes once SpokPay took it. */
  async function sendDraft(id: string, text?: string, images?: ImageBytes[]): Promise<{ siteRequest: SrHeader; message: SrMessage | null }> {
    const d = loadBox().drafts.find((x) => x.id === id);
    if (!d) throw new Error("This draft is gone");
    const out = await reply(d.ref, images ? { text: text ?? d.text, images } : { text: text ?? d.text }, d.id);
    discardDraft(id);
    return out;
  }

  return {
    status,
    setKey,
    clearKey,
    refresh,
    active,
    waiting,
    thread,
    requests,
    stores,
    ownerStores,
    reply,
    setStatus,
    proposals,
    propose,
    saveProposal,
    discardProposal,
    openProposal,
    drafts,
    saveDraft,
    discardDraft,
    sendDraft,
    links: loadLinks,
    setLink,
    start() {
      if (acct) void refresh();
    },
  };
}
