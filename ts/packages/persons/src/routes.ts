// `v1/persons/…`: the Persons tab's API (API.md). The Slint window calls it in-process and Hub for Android over the
// phone API, so both see and change the same state. JSON only (pictures and files as base64).
import type { AgentDiscord } from "./agent/index.ts";
import { statSync } from "node:fs";
import { chatKey, KIND_LABEL, isSection, normWhatsApp, personSections, pickChat, SECTIONS, serves, validPeer, type ChatRef } from "./model/accounts.ts";
import { isContactKind } from "./model/personal.ts";
import { aiPartsJson } from "./aiparts.ts";
import { attachmentKind } from "./model/conversation.ts";
import { initials } from "./model/format.ts";
import { parsePlace } from "./model/move.ts";
import { cleanUsername, isDiscordId, isEmail, joinScope, normalizeData, personLabel, searchText } from "./model/data.ts";
import { headerStatus } from "./model/presence.ts";
import { seenOf } from "./model/readState.ts";
import type { AppData, ChannelKind, Message, OutgoingFile, Person, SectionId, Store } from "./model/types.ts";
import { Avatars, pictureUrls, storeImageFile, whatsappNumber } from "./avatars.ts";
import { normalizeSocials } from "./socials.ts";
import type { ConnView, PersonsService, RowInfo } from "./service.ts";
import { forwardableFiles, forwardedNote, splitForwarded } from "./forward.ts";
import type { SiteRequests } from "./siterequests.ts";
import type { SiteRequestBoard } from "./srboard.ts";
import { initialsOf, siteRequestPageUrl } from "./srlist.ts";
import { normalizeRef } from "./spokpay-core.ts";
import { spError } from "./spokpay-view.ts";
import { factRows, finishWords, type PaneView } from "./srpane.ts";
import { normFolds, readFolds, writeFolds } from "./folds.ts";
import type { Proposal, ProposalFields } from "./spokpay-core.ts";
import { audioKey, waveBars, type AudioService } from "./audio.ts";
import type { VoiceQueue } from "./voicequeue.ts";

export interface Call {
  method: string;
  path: string[];
  query: [string, string][];
  body: unknown;
}
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export interface Reply {
  status: number;
  body: Json;
}

const ok = (body: Json): Reply => ({ status: 200, body });
const err = (status: number, msg: string): Reply => ({ status, body: { error: msg } });
const q = (c: Call, k: string): string | null => c.query.find(([x]) => x === k)?.[1] ?? null;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;
/** The AI thread for a chat: each answer also split into its markdown (with the phone's blocks) and its ```reply drafts. */
const aiJson = (items: readonly { role: string; text: string }[]): Json =>
  json(items.map((a) => {
    if (a.role !== "user") return { ...a, parts: aiPartsJson(a.text) };
    // a forwarded message (Forward to AI) shows as its quote and the question
    const f = splitForwarded(a.text);
    return f.forwarded ? { ...a, text: f.question, forwarded: { from: f.forwarded.from, text: f.forwarded.text || f.forwarded.attachment || "" } } : a;
  }));
/** A proposal as the chat's card shows it (Headquarters' ProposalCard). */
const proposalJson = (p: Proposal): Json =>
  json({
    id: p.id,
    at: new Date(p.createdAt).toISOString(),
    messageId: p.source?.messageId ?? null,
    store: p.store,
    category: p.shown.category,
    subject: p.shown.subject,
    details: p.shown.details,
    brief: p.shown.brief,
    why: p.why,
    from: p.from.name,
    chat: p.from.chat,
    images: p.images.filter((i) => i.picked).length,
    state: p.state,
  });

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#8b5cf6", "#0ea5e9"];
export const colorOf = (id: string): string => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
};
const TONE: Record<string, string> = { online: "green", idle: "yellow", dnd: "red", muted: "muted" };
const sectionOf = (s: string | null | undefined): SectionId | null => (s && isSection(s) ? s : null);

export class PersonsRoutes {
  readonly avatars: Avatars;
  /** WhatsApp photos by number: file or null (asked once per run per number). */
  private waPhotos = new Map<string, string | null>();

  constructor(private readonly s: PersonsService, private readonly extra: { socials?: (urls: string[], fresh: boolean) => Promise<Json>; ai?: AiPort; qr?: (text: string) => Promise<string[] | null>; agent?: AgentDiscord; sites?: SiteRequests; board?: SiteRequestBoard; audio?: AudioService; voice?: VoiceQueue } = {}) {
    this.avatars = new Avatars(s.dir, () => s.touch());
  }

  async route(c: Call): Promise<Reply | null> {
    const p = c.path;
    if (p[0] !== "v1" || p[1] !== "persons") return null;
    const m = c.method;
    const rest = p.slice(2);
    try {
      if (m === "GET" && rest[0] === "state" && rest.length === 1) return await this.state(c);
      if (m === "GET" && rest[0] === "unread" && rest.length === 1) return ok({ rev: this.s.rev, unread: this.unreadTotal() });
      // the PC's sidebar folds (folds.ts): read once when the tab starts, saved on each fold
      if (rest[0] === "folds" && rest.length === 1) {
        if (m === "GET") return ok(json(readFolds(this.s.dir)));
        if (m === "POST") {
          const f = normFolds(c.body);
          await writeFolds(this.s.dir, f);
          return ok(json({ ok: true, ...f }));
        }
      }
      if (rest[0] === "chat" && rest[1]) {
        if (m === "GET" && rest.length === 2) return await this.chat(rest[1], c);
        if (m === "POST" && rest[2] === "send") return await this.send(rest[1], obj(c.body));
        if (m === "POST" && rest[2] === "read") return this.read(rest[1], obj(c.body));
        if (m === "POST" && rest[2] === "unread") return this.unread(rest[1], obj(c.body));
        if (m === "POST" && rest[2] === "typing") return this.typing(rest[1], obj(c.body));
        if (m === "POST" && rest[2] === "retry") return this.retry(rest[1], obj(c.body));
        if (m === "POST" && rest[2] === "ai") return await this.ai(rest[1], obj(c.body));
        if (m === "POST" && rest[2] === "site-request") return this.siteRequest(rest[1], obj(c.body));
      }
      if (m === "POST" && rest[0] === "site-requests" && rest.length === 2) return await this.siteRequestsRoute(rest[1]!, obj(c.body));
      if (rest[0] === "site-request" && rest[1]) return await this.srPane(m, decodeURIComponent(rest[1]), rest[2] ?? "", obj(c.body));
      if (rest[0] === "proposal" && rest[1]) return await this.proposal(m, decodeURIComponent(rest[1]), rest[2] ?? "", obj(c.body));
      if (rest[0] === "proposing" && rest[1]) return await this.proposing(m, decodeURIComponent(rest[1]), rest[2] ?? "", obj(c.body));
      if (rest[0] === "person" && rest[1]) {
        if (m === "POST" && rest[2] === "link") return this.link(rest[1], obj(c.body));
        if (m === "POST" && rest[2] === "unlink") return this.unlinkRoute(rest[1], obj(c.body));
        if (m === "POST" && rest[2] === "move") return this.moveRoute(rest[1], obj(c.body));
        if (m === "GET") return await this.panel(rest[1], q(c, "socials") !== "cached");
        if (m === "PATCH") return this.patchPerson(rest[1], obj(c.body));
        if (m === "DELETE") return this.deletePerson(rest[1]);
      }
      if (m === "POST" && rest[0] === "people") return this.createPerson(obj(c.body));
      if (m === "POST" && rest[0] === "contacts" && rest.length === 1) return await this.addContact(obj(c.body));
      if (m === "GET" && rest[0] === "lookup") return await this.lookup(c);
      if (rest[0] === "stores") {
        if (m === "POST" && rest.length === 1) return this.saveStore(null, obj(c.body));
        if (m === "PATCH" && rest[1]) return this.saveStore(rest[1], obj(c.body));
        if (m === "DELETE" && rest[1]) return this.deleteStore(rest[1]);
      }
      if (rest[0] === "connections") {
        if (m === "POST" && rest.length === 1) return await this.addConn(obj(c.body));
        if (m === "POST" && rest[1] && rest[2] === "connect") return this.connConnect(rest[1]);
        if (m === "POST" && rest[1] && rest[2] === "session") return await this.connSession(rest[1], obj(c.body));
        if (m === "POST" && rest[1] && rest[2] === "disconnect") {
          await this.s.disconnect(decodeURIComponent(rest[1]));
          return ok({ ok: true });
        }
        if (m === "POST" && rest[1] && rest[2] === "cancel") {
          await this.s.cancelSignIn(decodeURIComponent(rest[1]));
          return ok({ ok: true });
        }
        if (m === "DELETE" && rest[1]) return await this.connRemove(rest[1]);
      }
      if (rest[0] === "agent" && rest[1] === "discord" && rest.length === 2) return await this.agentDiscord(m, obj(c.body));
      if (rest[0] === "audio") return await this.audioRoute(m, rest[1] ?? "", obj(c.body));
      if (m === "GET" && rest[0] === "img") return await this.img(rest, c);
      if (m === "GET" && rest[0] === "file") return await this.file(c);
    } catch (e) {
      return err(500, e instanceof Error ? e.message : String(e));
    }
    return err(404, "no such call");
  }

  /**
   * The agents' Discord (agent/index.ts): POST {tool, args, chat} runs a tool (`hub app discord` calls it over the
   * control socket), GET says which connection they use and how it is, PUT {connection} picks another (null: default).
   */
  private async agentDiscord(m: string, b: Record<string, unknown>): Promise<Reply> {
    const a = this.extra.agent;
    if (!a) return err(503, "Hub's agents have no Discord here");
    if (m === "GET") return ok(a.info() as unknown as Json);
    if (m === "PUT") {
      a.pick(typeof b.connection === "string" && b.connection !== "" ? b.connection : null);
      return ok(a.info() as unknown as Json);
    }
    if (m !== "POST") return err(405, "GET, PUT or POST");
    const chat = typeof b.chat === "number" && Number.isInteger(b.chat) ? b.chat : null;
    return ok((await a.run(String(b.tool ?? ""), b.args ?? null, chat)) as unknown as Json);
  }

  /** A QR code as rows of "0"/"1" for the phone to draw (computed once per code by the engine's encoder). */
  private qrCache = new Map<string, string[] | null>();
  private qrRowsOf(text: string): Json {
    if (this.qrCache.has(text)) return this.qrCache.get(text) ?? null;
    const enc = this.extra.qr;
    if (!enc) return null;
    this.qrCache.set(text, null);
    void enc(text).then((rows) => {
      if (this.qrCache.size > 20) this.qrCache.clear();
      this.qrCache.set(text, rows);
      if (rows) this.s.touch();
    }, () => {});
    return null;
  }

  // ---------- pictures ----------

  /** The person's picture on disk: the best URL that's cached (the best one is fetched meanwhile), else WhatsApp. */
  picture(p: Person, size = 128): string | null {
    for (const u of pictureUrls(p, size)) {
      const f = this.avatars.file(u);
      if (f) return f;
    }
    const n = whatsappNumber(p);
    if (n) {
      if (this.waPhotos.has(n)) return this.waPhotos.get(n) ?? null;
      const wa = this.s.views().find((v) => v.kind === "whatsapp" && v.connected);
      const conn = wa ? this.s.conn(wa.id) : undefined;
      if (conn?.photo) {
        this.waPhotos.set(n, null);
        void conn.photo(n).then((f) => {
          this.waPhotos.set(n, f);
          if (f) this.s.touch();
        }, () => {});
      }
    }
    return null;
  }

  private pictureRef(p: Person): string | null {
    const f = this.picture(p);
    if (!f) return null;
    let v = 0;
    try {
      v = Math.floor(statSync(f).mtimeMs);
    } catch {
      // gone meanwhile
    }
    return `/v1/persons/img/person/${encodeURIComponent(p.id)}?v=${v}`;
  }

  private async img(rest: string[], c: Call): Promise<Reply> {
    const d = this.s.data;
    if (!d) return err(503, "not loaded");
    let f: string | null = null;
    if (rest[1] === "person" && rest[2]) {
      const p = this.s.person(decodeURIComponent(rest[2]));
      if (p) {
        const size = Number(q(c, "size") ?? "128") >= 200 ? 256 : 128;
        f = this.picture(p, size);
        if (!f) for (const u of pictureUrls(p, size)) if ((f = await this.avatars.fetch(u))) break;
      }
    } else if (rest[1] === "url") {
      const u = q(c, "u") ?? "";
      if (/^https:\/\//.test(u)) f = this.avatars.file(u) ?? (await this.avatars.fetch(u));
    } else if (rest[1] === "store" && rest[2]) {
      const st = d.stores.find((x) => x.id === decodeURIComponent(rest[2]!));
      if (st) f = storeImageFile(this.s.dir, st);
    }
    const out = f ? Avatars.read(f) : null;
    if (!out) return err(404, "no picture");
    return ok(q(c, "path") === "1" ? { type: out.type, path: f } : out);
  }

  private async file(c: Call): Promise<Reply> {
    const url = q(c, "url") ?? "";
    const name = q(c, "name") ?? "file";
    const f = await this.s.fetchAttachment(url, name, q(c, "account") ?? undefined);
    if (!f) return err(404, "can't fetch that file");
    const size = statSync(f).size;
    if (q(c, "path") === "1") return ok({ path: f, name, size });
    if (size > 20 << 20) return err(413, "too large for the phone");
    const out = Avatars.read(f);
    return out ? ok({ ...out, name, size }) : err(404, "gone");
  }

  // ---------- state ----------

  private unreadAt = { rev: -1, n: 0 };
  /** Everyone's unread messages (stateJson's `unread`): the window's Persons tab badge reads it every few seconds, so
   *  it's counted once per change of the data. */
  private unreadTotal(): number {
    if (this.unreadAt.rev !== this.s.rev) this.unreadAt = { rev: this.s.rev, n: this.s.totalUnread() };
    return this.unreadAt.n;
  }

  private rowJson(i: RowInfo): Json {
    return {
      lastAt: i.lastAt ?? null,
      unread: i.unread,
      presence: i.presence ?? null,
      status: i.status ? { text: i.status.text, tone: TONE[i.status.tone] ?? "muted" } : null,
      channel: i.channel ?? null,
      typing: i.typing ?? null,
    };
  }

  private connJson(v: ConnView): Json {
    const who = v.state.me?.globalName || v.state.me?.username || "";
    return {
      id: v.id,
      kind: v.kind,
      section: v.section,
      // the sections it serves besides its own (Personal shares the Stores Discord and WhatsApp)
      also: v.also ?? [],
      status: v.state.status,
      gateway: v.state.gateway,
      label: who ? `${KIND_LABEL[v.kind]} · ${who}` : KIND_LABEL[v.kind],
      who,
      error: v.state.error ?? null,
      qr: v.state.qr ?? null,
      qrRows: v.state.qr ? this.qrRowsOf(v.state.qr) : null,
      contacts: v.state.contacts ?? null,
    };
  }

  stateJson(): Json {
    const d = this.s.data;
    if (!d) return { rev: this.s.rev, loading: true };
    const sections: SectionId[] = SECTIONS;
    const counts = new Map<string, number>();
    for (const p of d.people) for (const sid of p.storeIds) counts.set(sid, (counts.get(sid) ?? 0) + 1);
    let unread = 0;
    const people = d.people.map((p) => {
      const rows: Record<string, Json> = {};
      const all = this.s.rowInfo(p, null);
      unread += all.unread;
      rows[""] = this.rowJson(all);
      for (const sec of sections) {
        const inSec = sec === "stores" ? p.storeIds.length > 0 || d.stores.some((s) => s.ownerId === p.id) : p.listIds.includes(sec);
        if (inSec) rows[sec] = this.rowJson(this.s.rowInfo(p, sec));
      }
      const settled: Record<string, Json> = {};
      for (const sec of sections) if (p.settled?.[sec] && this.isSettledNow(p, sec)) settled[sec] = true;
      const avatarPath = this.picture(p);
      return {
        id: p.id,
        name: personLabel(p),
        initials: initials(personLabel(p)),
        color: colorOf(p.id),
        avatar: avatarPath ? this.pictureRef(p) : null,
        avatarPath,
        storeIds: p.storeIds,
        listIds: p.listIds,
        settled,
        rows,
        search: searchText(p).replace(/\n/g, " "),
        linked: (p.links ?? []).map((l) => ({ id: l.person.id, name: personLabel(l.person) })),
      };
    });
    return {
      rev: this.s.rev,
      unread,
      audio: this.audioState(),
      connections: this.s.views().map((v) => this.connJson(v)),
      stores: d.stores.map((st) => {
        const f = storeImageFile(this.s.dir, st);
        return { id: st.id, name: st.name, color: st.color ?? "#64748b", image: f ? `/v1/persons/img/store/${encodeURIComponent(st.id)}` : null, imagePath: f, ownerId: st.ownerId ?? null, count: counts.get(st.id) ?? 0 };
      }),
      lists: d.lists.map((l) => ({ id: l.id, name: l.name, accountId: l.accountId })),
      people,
      siteRequests: this.siteRequestsJson(),
    };
  }

  /**
   * The SpokPay section's Site requests (Headquarters' Home list, srboard.ts): SpokPay's active requests, newest
   * activity first, each with its store's side ("Store replied" / "Store waiting"), its store icon (a file here, a
   * picture URL for the phone) and its admin page; the notices that keep it from being current; `waits` lights the
   * heading's amber dot. Null without SpokPay in this engine.
   */
  private siteRequestsJson(): Json {
    const b = this.extra.board;
    if (!b) return null;
    const v = b.view();
    return json({
      waits: v.waits,
      notices: v.notices,
      rows: v.rows.map((r) => {
        const icon = r.storeSlug ? v.icons[r.storeSlug] ?? null : null;
        return {
          ref: r.ref,
          subject: r.subject,
          store: r.store,
          storeSlug: r.storeSlug,
          initials: initialsOf(r.store),
          line: r.line,
          waiting: r.waiting,
          unread: r.unread,
          at: r.lastActivityAt,
          side: r.side,
          iconPath: icon ? this.avatars.file(icon) : null,
          icon: icon ? `/v1/persons/img/url?u=${encodeURIComponent(icon)}` : null,
          url: siteRequestPageUrl(r.ref),
        };
      }),
    });
  }

  /** POST site-requests/seen {ref, at} (a row opened: the store's words read, here only); POST site-requests/reload. */
  private async siteRequestsRoute(act: string, b: Record<string, unknown>): Promise<Reply> {
    const board = this.extra.board;
    if (!board) return err(404, "SpokPay isn't in this engine");
    if (act === "seen") {
      const ref = str(b.ref) ?? "";
      const at = Number(b.at);
      if (!ref || !Number.isFinite(at)) return err(400, "ref and at are needed");
      board.markSeen(ref, at);
      return ok({ ok: true });
    }
    if (act === "reload") {
      await board.reload();
      return ok({ ok: true });
    }
    return err(404, "no such call");
  }

  /**
   * A site request's pane (SpokPay's admin request page): `GET site-request/{ref}` reads it now (and marks what the
   * store wrote seen); `POST site-request/{ref}/reply { text, images?: [{ name, type, data: base64 }], key? }` answers
   * the store as SpokPay; `POST site-request/{ref}/status { to }` moves it. Each answers `{ ok, pane }` (srpane.ts
   * PaneView plus the store's icon and the admin page's link); a refusal is `{ error, code }`.
   */
  private async srPane(m: string, ref: string, act: string, b: Record<string, unknown>): Promise<Reply> {
    const board = this.extra.board;
    if (!board) return err(404, "SpokPay isn't in this engine");
    try {
      if (m === "POST" && act === "reply") {
        const images = (Array.isArray(b.images) ? b.images : []).map((x) => {
          const im = obj(x);
          return { name: str(im.name) ?? "image.png", type: str(im.type) ?? "image/png", data: new Uint8Array(Buffer.from(str(im.data) ?? "", "base64")) };
        });
        await board.reply(ref, str(b.text) ?? "", images, str(b.key));
      } else if (m === "POST" && act === "status") {
        await board.move(ref, str(b.to) ?? "");
      } else if (m === "POST" && act === "ai") {
        return await this.srAi(ref, b);
      } else if (m === "GET" && act === "ai") {
        // the request's AI turns alone (no SpokPay read): the pane asks again while the AI works
        const r = normalizeRef(ref);
        if (!r) return err(400, "Not a site request ref (SR-…)");
        const v = { ref: r, storeSlug: board.slugOf(r) };
        const chat = this.srAiChat(v);
        return ok({ ok: true, ai: aiJson(await this.srAiItems(r, chat)), aiChat: chat });
      } else if (!(m === "GET" && act === "")) return err(404, "no such call");
      return ok({ ok: true, pane: await this.paneJson(await board.pane(ref, (u) => `/v1/persons/img/url?u=${encodeURIComponent(u)}`)) });
    } catch (e) {
      const x = spError(e);
      const status = typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 502;
      return { status: status >= 400 ? status : 502, body: { error: x.message, code: x.code } };
    }
  }

  /**
   * The person a site request's composer writes "To" and whose Person AI hears its notes: the one Hub opened it for,
   * else the one remembered as that SpokPay store (spokpay-links.json, the person's or their Persons store's).
   */
  private srPerson(ref: string, slug: string | null): { p: Person; section: SectionId } | null {
    const board = this.extra.board;
    const d = this.s.data;
    if (!board || !d) return null;
    const links = board.links();
    const byId = (id: string | null | undefined): Person | undefined => (id ? this.s.person(id) ?? undefined : undefined);
    const p =
      byId(board.openedBy(ref)) ??
      (slug
        ? d.people.find((x) => links.people[x.id] === slug) ?? d.people.find((x) => d.stores.some((st) => links.stores[st.id] === slug && (st.ownerId === x.id || x.storeIds.includes(st.id))))
        : undefined);
    if (!p) return null;
    const secs = personSections(p);
    return { p, section: secs.includes("spokpay") ? "spokpay" : secs[0] ?? "spokpay" };
  }

  /** The Person AI chat of a request: its person's (that section's), else the store's own ("<Store> · SpokPay"). */
  private srAiChat(v: { ref: string; storeSlug: string | null }): string | null {
    const ai = this.extra.ai;
    if (!ai) return null;
    const who = this.srPerson(v.ref, v.storeSlug);
    return who ? ai.chatOf?.(who.p, who.section) ?? null : ai.chatOfKey?.(srAiKey(v)) ?? null;
  }

  /** A request's turns with the Person AI (none when it isn't there or its chat can't be read now). */
  private async srAiItems(ref: string, chat: string | null): Promise<{ id: string; role: string; text: string; at: string }[]> {
    return (await this.extra.ai?.srItems?.(ref, chat).catch(() => [])) ?? [];
  }

  /**
   * `POST site-request/{ref}/ai { text, paths?, forward? }`: the composer's "To: AI" note, to the Person AI as person chats send
   * theirs, with the request (ref, subject, status, brief, the newest messages) as hidden context: the chat of the
   * person linked to its store, else the store's own. Remembered as the request's (ai.ts sr-ai.json), so the note and
   * the answer to it show in the pane, at the point it was sent. Answers `{ ok, chat, ai }` (`ai`: the request's turns).
   */
  private async srAi(ref: string, b: Record<string, unknown>): Promise<Reply> {
    const board = this.extra.board;
    const ai = this.extra.ai;
    if (!board) return err(404, "SpokPay isn't in this engine");
    if (!ai) return err(503, "Person AI isn't available");
    const attached = (Array.isArray(b.paths) ? b.paths : []).filter((x): x is string => typeof x === "string" && x.startsWith("/")).slice(0, 10);
    let text = str(b.text) ?? "";
    if (attached.length) text = `${text.trim()}\n\nFiles attached to this note (on this PC): ${attached.join(", ")}`.trim();
    if (!text.trim() && !str(b.forward)) return err(400, "empty");
    const r = normalizeRef(ref);
    if (!r) return err(400, "Not a site request ref (SR-…)");
    const c = await board.aiContext(r, siteRequestPageUrl(r));
    // Forward to AI (a message's menu): the message quoted as person chats quote theirs, the question after it
    const fwdId = str(b.forward);
    if (fwdId) {
      const m = board.message(r, fwdId);
      if (!m) return err(404, "That message isn't in this request any more");
      const from = m.side === "spokpay" ? `SpokPay (${m.authorName || "SpokPay"})` : `${m.authorName || c.store} (${c.store})`;
      text = forwardedNote({ message: { content: m.text, timestamp: new Date(m.createdAt).toISOString(), attachments: m.attachments.filter((a) => a.url).map((a) => ({ name: a.name || "file", url: a.url!, ...(a.contentType ? { type: a.contentType } : {}) })) }, from, question: text });
    }
    const who = this.srPerson(c.ref, c.storeSlug);
    if (who && this.s.data) {
      const { chat, choices } = this.chatConn(who.p, who.section);
      const msgs = this.timeline(choices).map((x) => x.m);
      const chatId = String(await ai.ask(who.p, who.section, text, msgs, chat?.conn.kind ?? null, this.s.data, undefined, c.context));
      ai.noteSr?.(c.ref, chatId, text);
      return ok({ ok: true, chat: chatId, ai: aiJson(await this.srAiItems(c.ref, chatId)) });
    }
    if (!ai.askAbout) return err(503, "Person AI can't take notes about a store here");
    const chatId = String(await ai.askAbout(srAiKey(c), `${c.store} · SpokPay`, text, c.context));
    ai.noteSr?.(c.ref, chatId, text);
    return ok({ ok: true, chat: chatId, ai: aiJson(await this.srAiItems(c.ref, chatId)) });
  }

  private async paneJson(v: PaneView): Promise<Json> {
    const icon = v.storeSlug ? this.extra.board?.view().icons[v.storeSlug] ?? null : null;
    const who = this.srPerson(v.ref, v.storeSlug);
    const pic = who ? this.picture(who.p) : null;
    const aiChat = this.srAiChat(v);
    // the request's notes to the AI and its answers, drawn in the timeline at the point each was sent
    const ai = aiJson(await this.srAiItems(v.ref, aiChat));
    return json({
      ...v,
      // "To <avatar> <name>": the linked person as their chat shows them, else the owner with the store's icon
      person: who ? { id: who.p.id, section: who.section, name: personLabel(who.p), initials: initials(personLabel(who.p)), color: colorOf(who.p.id), avatarPath: pic, avatar: pic ? this.pictureRef(who.p) : null } : null,
      aiChat,
      ai,
      factRows: factRows(v.brief.facts),
      confirms: { completed: finishWords("completed", v.store), closed: finishWords("closed", v.store) },
      initials: initialsOf(v.store),
      iconPath: icon ? this.avatars.file(icon) : null,
      icon: icon ? `/v1/persons/img/url?u=${encodeURIComponent(icon)}` : null,
      url: siteRequestPageUrl(v.ref),
    });
  }

  private isSettledNow(p: Person, sec: SectionId): boolean {
    const mark = p.settled?.[sec];
    if (!mark) return false;
    const last = this.s.rowInfo(p, sec).lastAt;
    return !(last && Date.parse(last) > Date.parse(mark));
  }

  private async state(c: Call): Promise<Reply> {
    const rev = Number(q(c, "rev") ?? "0");
    if (rev && rev === this.s.rev) await this.s.waitChange(rev, Math.min(25_000, Number(q(c, "wait") ?? "25000") || 25_000));
    return ok(this.stateJson());
  }

  // ---------- chat ----------

  /** The chat the composer uses: `account` (a chat key, or a connection id) if it's one of the person's, else the default. */
  private chatConn(p: Person, section: SectionId | null, account?: string | null): { chat: ChatRef<ConnView> | undefined; choices: ChatRef<ConnView>[] } {
    const { choices, current } = this.s.chatChoices(p, section);
    return { chat: pickChat(choices, account) ?? current, choices };
  }

  /** Every message of a person's chats (oldest first), each with the chat it is in: their page's one timeline. */
  private timeline(choices: ChatRef<ConnView>[]): { m: Message; chat: ChatRef<ConnView> }[] {
    const out: { m: Message; chat: ChatRef<ConnView> }[] = [];
    for (const ch of choices) {
      const cur = this.s.view(ch.conn.id) ?? ch.conn;
      for (const m of cur.convos[ch.peer]?.messages ?? []) out.push({ m, chat: { conn: cur, peer: ch.peer } });
    }
    return out.sort((a, b) => Date.parse(a.m.timestamp) - Date.parse(b.m.timestamp) || (a.m.timestamp < b.m.timestamp ? -1 : a.m.timestamp > b.m.timestamp ? 1 : 0));
  }

  /** A message of the person's chats by id, with its chat (menus, Forward to AI, site requests). */
  private findMessage(choices: ChatRef<ConnView>[], id: string | undefined): { m: Message; chat: ChatRef<ConnView> } | undefined {
    return id ? this.timeline(choices).find((x) => x.m.id === id) : undefined;
  }

  /** The chats' channel as the timeline marks it: kind, and a label when the person has more than one chat. */
  private channelJson(ch: ChatRef<ConnView>, choices: ChatRef<ConnView>[]): Json {
    return { key: chatKey(ch), kind: ch.conn.kind, label: this.chatLabel(ch, choices) };
  }

  /** "WhatsApp", or "WhatsApp · +55 11 9…" when they have two chats of that kind (a linked person's other number). */
  private chatLabel(ch: ChatRef<ConnView>, choices: ChatRef<ConnView>[]): string {
    const same = choices.filter((c) => c.conn.kind === ch.conn.kind);
    if (same.length < 2) return KIND_LABEL[ch.conn.kind];
    const twoConns = new Set(same.map((c) => c.conn.id)).size > 1;
    const who = ch.conn.kind === "whatsapp" ? `+${ch.peer}` : ch.conn.kind === "discord" ? ch.peer.slice(-4).padStart(5, "…") : ch.peer;
    return `${KIND_LABEL[ch.conn.kind]} · ${twoConns && new Set(same.map((c) => c.peer)).size < 2 ? (ch.conn.state.me?.globalName || ch.conn.state.me?.username || ch.conn.section) : who}`;
  }

  private msgJson(m: Message, ch: ChatRef<ConnView>, mine: Map<string, Message>, choices: ChatRef<ConnView>[]): Json {
    const conn = ch.conn;
    const files = (m.attachments ?? []).map((a, i) => {
      const kind = attachmentKind(a, m.voice);
      const key = audioKey(conn.id, m.id, i);
      const meta = kind === "audio" ? this.extra.audio?.meta(key) : undefined;
      return {
        name: a.name,
        url: `/v1/persons/file?account=${encodeURIComponent(conn.id)}&url=${encodeURIComponent(a.url)}&name=${encodeURIComponent(a.name)}`,
        raw: a.url,
        type: a.type ?? null,
        size: a.size ?? null,
        width: a.width ?? null,
        height: a.height ?? null,
        kind,
        image: kind === "image",
        duration: a.duration ?? meta?.duration ?? null,
        // audio: the bubble's bars (the platform's waveform, else measured once played), played, its transcript
        ...(kind === "audio" ? { audio: key, bars: waveBars(a.waveform) ?? meta?.bars ?? null, played: !!meta?.played || m.fromMe, transcript: meta?.transcript ?? null, transcribing: !!this.extra.audio?.isTranscribing(key) || this.extra.voice?.current === key, transcriptFailed: meta?.transcript === undefined && !!meta?.failed } : {}),
      };
    });
    const r = m.reply;
    const quoted = r ? mine.get(r.id) : undefined;
    return {
      id: m.id,
      fromMe: m.fromMe,
      text: m.content,
      at: m.timestamp,
      edited: !!m.edited,
      subject: m.subject ?? null,
      threadId: m.threadId ?? null,
      status: m.status ?? null,
      voice: !!m.voice,
      embed: !!m.embed,
      forwarded: !!m.forwarded,
      reply: r ? { id: r.id, text: quoted?.content ?? r.content ?? (r.attachments ? "📎 Attachment" : r.deleted ? "Deleted message" : ""), fromMe: quoted?.fromMe ?? !!r.fromMe } : null,
      files,
      channel: this.channelJson(ch, choices),
      ai: false,
    };
  }

  /** Chats whose oldest page was reached (`before` stops asking them). */
  private exhausted = new Set<string>();
  /** Chats whose newest page was read this run (on first open). */
  private historyRead = new Set<string>();

  private async chat(personId: string, c: Call): Promise<Reply> {
    const p = this.s.person(decodeURIComponent(personId));
    if (!p) return err(404, "no such person");
    const section = sectionOf(q(c, "section"));
    const { chat: picked, choices } = this.chatConn(p, section, q(c, "account"));
    const conn = picked?.conn;
    const pic = this.pictureRef(p);
    const row = this.s.rowInfo(p, section);
    const personJson = { id: p.id, name: personLabel(p), initials: initials(personLabel(p)), color: colorOf(p.id), avatar: pic, avatarPath: this.picture(p), presence: row.presence ?? null };
    const ai = this.extra.ai ? await this.extra.ai.items(p, section ?? conn?.section ?? "stores").catch(() => []) : [];
    // the composer's AI switch and Forward to AI; the message menu's Open Site Request, the proposals' cards
    const sites = this.extra.sites;
    const extras = {
      aiOn: !!this.extra.ai,
      aiChat: this.extra.ai?.chatOf?.(p, section ?? conn?.section ?? "stores") ?? null,
      siteRequests: !!sites && !!this.s.data && sites.offered(p, this.s.data),
      proposals: sites ? sites.proposals(p.id).map(proposalJson) : [],
      proposing: sites ? json(sites.proposing(p.id).map((x) => ({ ...x, at: new Date(x.at).toISOString() }))) : [],
      linked: (p.links ?? []).map((l) => ({ id: l.person.id, name: personLabel(l.person) })),
    };
    if (!picked || !conn) return ok({ person: { ...personJson, status: null }, account: null, accounts: [], peer: null, typing: null, more: false, unreadFrom: null, messages: [], outgoing: [], ai: aiJson(ai), ...extras });
    const before = q(c, "before");
    if (before) {
      // an older page of the timeline: each chat that may still have messages before that one loads its page
      const at = this.timeline(choices).find((x) => x.m.id === before)?.m.timestamp ?? "";
      await Promise.all(choices.map(async (ch) => {
        const cur = this.s.view(ch.conn.id) ?? ch.conn;
        const first = cur.convos[ch.peer]?.messages[0];
        const k = chatKey(ch);
        if (!first || this.exhausted.has(k) || (at && Date.parse(first.timestamp) < Date.parse(at))) return;
        const n = await this.s.loadHistory(ch.conn.id, ch.peer, first.id).catch(() => 0);
        if (!n) this.exhausted.add(k);
      }));
      const older = this.timeline(choices).filter((x) => at && Date.parse(x.m.timestamp) < Date.parse(at));
      const byId = new Map(older.map((x) => [x.m.id, x.m]));
      return ok({ messages: older.map((x) => this.msgJson(x.m, x.chat, byId, choices)), more: older.length > 0 });
    }
    // each chat's newest page, read once per run when it first opens (connected): its past shows even when a few live
    // messages came in first; never again on the reloads every change brings (that looped while a chat stayed empty)
    await Promise.all(choices.map(async (ch) => {
      const cur = this.s.view(ch.conn.id) ?? ch.conn;
      const k = chatKey(ch);
      if (!cur.connected || this.historyRead.has(k)) return;
      this.historyRead.add(k);
      await this.s.loadHistory(ch.conn.id, ch.peer).catch(() => {
        this.historyRead.delete(k);
        return 0;
      });
    }));
    this.s.watch(conn.id, picked.peer);
    const cur = this.s.view(conn.id) ?? conn;
    const all = this.timeline(choices);
    const byId = new Map(all.map((x) => [x.m.id, x.m]));
    // the first unread message over every chat
    const firstUnread = all.find((x) => {
      if (x.m.fromMe) return false;
      const seen = seenOf(p, x.chat.conn.id, x.chat.peer);
      return seen ? Date.parse(x.m.timestamp) > Date.parse(seen) : x.m.unread === true;
    });
    const typingOf = (ch: ChatRef<ConnView>) => {
      const t = (this.s.view(ch.conn.id) ?? ch.conn).typing[ch.peer];
      return t && t.until > Date.now() ? t.kind : undefined;
    };
    const typing = typingOf(picked) ?? choices.map(typingOf).find(Boolean);
    const status = headerStatus(conn.kind, this.s.presenceOf(picked.peer), cur.lastSeen[picked.peer], typing);
    const outgoing = choices.flatMap((ch) => ((this.s.view(ch.conn.id) ?? ch.conn).outgoing[ch.peer] ?? []).map((o) => ({ key: o.key, text: o.text, status: o.status, error: o.error ?? null, at: o.at, subject: o.subject ?? null, files: (o.files ?? []).map((f) => ({ name: f.name, type: f.type, size: f.data.length })), channel: this.channelJson(ch, choices) })));
    return ok({
      person: { ...personJson, status: status ? { text: status.text, tone: TONE[status.tone] ?? "muted" } : null },
      // `id` is the chat's key ("<connection>:<who>"): what `account` takes back; `conn` the connection
      account: { id: chatKey(picked), conn: conn.id, kind: conn.kind, section: conn.section, label: this.connLabel(cur), to: this.chatLabel(picked, choices), connected: cur.connected },
      accounts: choices.map((x) => ({ id: chatKey(x), conn: x.conn.id, kind: x.conn.kind, label: this.connLabel(x.conn), to: this.chatLabel(x, choices), connected: x.conn.connected })),
      peer: picked.peer,
      typing: typing ?? null,
      more: all.length > 0,
      unreadFrom: firstUnread?.m.id ?? null,
      messages: all.map((x) => this.msgJson(x.m, x.chat, byId, choices)),
      outgoing: json(outgoing),
      ai: aiJson(ai),
      ...extras,
    });
  }

  private connLabel(v: ConnView): string {
    const who = v.state.me?.globalName || v.state.me?.username || "";
    return who ? `${KIND_LABEL[v.kind]} · ${who}` : KIND_LABEL[v.kind];
  }

  private resolve(personId: string, b: Record<string, unknown>): { p: Person; conn: ConnView; peer: string; choices: ChatRef<ConnView>[] } | null {
    const p = this.s.person(decodeURIComponent(personId));
    if (!p) return null;
    const { chat, choices } = this.chatConn(p, sectionOf(str(b.section)), str(b.account));
    return chat ? { p, conn: chat.conn, peer: chat.peer, choices } : null;
  }

  private async send(personId: string, b: Record<string, unknown>): Promise<Reply> {
    const r = this.resolve(personId, b);
    if (!r) return err(404, "no channel to send through");
    const text = str(b.text) ?? "";
    const files: OutgoingFile[] = (Array.isArray(b.files) ? b.files : []).map((x) => {
      const f = obj(x);
      return { name: str(f.name) ?? "file", type: str(f.type) ?? "application/octet-stream", data: new Uint8Array(Buffer.from(str(f.data) ?? "", "base64")) };
    }).filter((f) => f.data.length > 0);
    if (!text.trim() && !files.length) return err(400, "nothing to send");
    const opts: { files?: OutgoingFile[]; replyTo?: string; subject?: string; peer?: string } = { peer: r.peer };
    if (files.length) opts.files = files;
    const replyTo = str(b.replyTo);
    if (replyTo) opts.replyTo = replyTo;
    const subject = str(b.subject);
    if (subject) opts.subject = subject;
    const res = await this.s.send(r.p.id, r.conn.id, text, opts);
    return ok(json(res));
  }

  /** Seen: every chat on the page (one timeline shows them all). */
  private read(personId: string, b: Record<string, unknown>): Reply {
    const r = this.resolve(personId, b);
    if (r) for (const ch of r.choices) this.s.markSeen(r.p.id, ch.conn.id, str(b.upTo), ch.peer);
    return ok({ ok: !!r });
  }

  private unread(personId: string, b: Record<string, unknown>): Reply {
    const r = this.resolve(personId, b);
    const hit = r ? this.findMessage(r.choices, str(b.messageId)) : undefined;
    if (r && hit) this.s.markUnread(r.p.id, hit.chat.conn.id, hit.m, hit.chat.peer);
    return ok({ ok: !!hit });
  }

  private typing(personId: string, b: Record<string, unknown>): Reply {
    const r = this.resolve(personId, b);
    if (r) this.s.sendTyping(r.conn.id, r.peer, b.on !== false);
    return ok({ ok: !!r });
  }

  /** A failed message: retried or dismissed in the chat it was sent on (`key` is the outgoing item's). */
  private retry(personId: string, b: Record<string, unknown>): Reply {
    const r = this.resolve(personId, b);
    const key = str(b.key);
    if (r && key) {
      const ch = r.choices.find((c) => ((this.s.view(c.conn.id) ?? c.conn).outgoing[c.peer] ?? []).some((o) => o.key === key)) ?? { conn: r.conn, peer: r.peer };
      if (b.dismiss === true) this.s.dismiss(ch.conn.id, ch.peer, key);
      else this.s.retry(r.p.id, ch.conn.id, key, ch.peer);
    }
    return ok({ ok: !!r });
  }

  private async ai(personId: string, b: Record<string, unknown>): Promise<Reply> {
    const p = this.s.person(decodeURIComponent(personId));
    if (!p) return err(404, "no such person");
    if (!this.extra.ai) return err(503, "Person AI isn't available");
    const section = sectionOf(str(b.section)) ?? "stores";
    let text = str(b.text) ?? "";
    const { chat, choices } = this.chatConn(p, section, str(b.account));
    const conn = chat?.conn;
    // the conversation over every chat of theirs (one timeline)
    const msgs = this.timeline(choices).map((x) => x.m);
    // Forward to AI: the message quoted in the note (its images and PDFs fetched to this PC for the agent to read)
    const fwdId = str(b.forward);
    const fwdHit = this.findMessage(choices, fwdId);
    const fwd = fwdHit?.m;
    if (fwdId && !fwd) return err(404, "That message isn't in this chat any more");
    // files attached to the note: paths on this PC (the window's attach button)
    const attached = (Array.isArray(b.paths) ? b.paths : []).filter((x): x is string => typeof x === "string" && x.startsWith("/")).slice(0, 10);
    if (fwd && fwdHit) {
      const files: string[] = [];
      for (const f of forwardableFiles(fwd)) {
        const path = await this.s.fetchAttachment(f.url, f.name, fwdHit.chat.conn.id).catch(() => null);
        if (path) files.push(path);
      }
      const me = fwdHit.chat.conn.state.me?.globalName || fwdHit.chat.conn.state.me?.username;
      const said = (fwd.attachments ?? []).map((_, i) => this.extra.audio?.meta(audioKey(fwdHit.chat.conn.id, fwd.id, i))?.transcript).filter((t): t is string => !!t);
      text = forwardedNote({ message: fwd, from: fwd.fromMe ? `Me${me ? ` (${me})` : ""}` : personLabel(p), question: text, files, transcripts: said });
    }
    if (attached.length) text = `${text.trim()}\n\nFiles attached to this note (on this PC): ${attached.join(", ")}`.trim();
    if (!text.trim()) return err(400, "empty");
    // what was said in their voice messages (transcribed in the background, voicequeue.ts): "[voice 0:20] …"
    const connOf = new Map(this.timeline(choices).map((x) => [x.m.id, x.chat.conn.id]));
    const transcriptOf = (m: Message, i: number): string | undefined => {
      const c = connOf.get(m.id);
      return c ? this.extra.audio?.meta(audioKey(c, m.id, i))?.transcript : undefined;
    };
    const aiChat = await this.extra.ai.ask(p, section, text, msgs, conn?.kind ?? null, this.s.data!, transcriptOf);
    return ok({ ok: true, chat: aiChat });
  }

  // ---------- SpokPay site requests ----------

  /** Open Site Request on a message: SpokPay's agent drafts the proposal (siterequests.ts); the card shows in the chat. */
  private siteRequest(personId: string, b: Record<string, unknown>): Reply {
    const sites = this.extra.sites;
    const r = this.resolve(personId, b);
    if (!sites || !r || !this.s.data) return err(404, "no chat");
    if (!sites.offered(r.p, this.s.data)) return err(409, "Site requests aren't offered for this person");
    const hit = this.findMessage(r.choices, str(b.messageId));
    if (!hit) return err(404, "That message isn't in this chat any more");
    const m = hit.m;
    const msgs = this.timeline(r.choices).map((x) => x.m);
    const k = hit.chat.conn.kind;
    const handle = k === "discord" ? (r.p.discordUsername ? `@${r.p.discordUsername}` : "") : k === "gmail" ? (hit.chat.peer || r.p.email || "") : `+${hit.chat.peer}`;
    sites.fromMessage({ person: r.p, message: m, recent: msgs.filter((x) => x.timestamp <= m.timestamp).slice(-30), account: hit.chat.conn.id, handle, data: this.s.data });
    return ok({ ok: true });
  }

  /** A proposal's card: POST …/open {fields?}, PATCH {fields?, store?}, DELETE (discard). */
  private async proposal(m: string, id: string, act: string, b: Record<string, unknown>): Promise<Reply> {
    const sites = this.extra.sites;
    if (!sites) return err(503, "SpokPay isn't set up here");
    const fields = b.fields && typeof b.fields === "object" ? (b.fields as ProposalFields) : undefined;
    if (m === "POST" && act === "open") {
      const p = await sites.open(id, fields);
      return ok(p ? proposalJson(p) : null);
    }
    if (m === "PATCH") {
      const patch: { fields?: ProposalFields; store?: { slug: string; name: string } | null } = {};
      if (fields) patch.fields = fields;
      if ("store" in b) {
        const st = obj(b.store);
        const slug = (str(st.slug) ?? "").trim().toLowerCase();
        patch.store = slug ? { slug, name: str(st.name) || slug } : null;
      }
      const p = sites.sp.saveProposal(id, patch);
      this.s.touch();
      return ok(proposalJson(p));
    }
    if (m === "DELETE") {
      sites.sp.discardProposal(id);
      this.s.touch();
      return ok({ ok: true });
    }
    return err(405, "POST open, PATCH or DELETE");
  }

  /** A proposal still drafting: POST …/local {personId, section, account} (the message itself), DELETE (dismiss). */
  private async proposing(m: string, messageId: string, act: string, b: Record<string, unknown>): Promise<Reply> {
    const sites = this.extra.sites;
    if (!sites || !this.s.data) return err(503, "SpokPay isn't set up here");
    if (m === "DELETE") {
      sites.dismiss(messageId);
      return ok({ ok: true });
    }
    if (m !== "POST" || act !== "local") return err(405, "POST local or DELETE");
    const r = this.resolve(str(b.personId) ?? "", b);
    if (!r) return err(404, "no chat");
    const msgs = this.timeline(r.choices).map((x) => x.m);
    await sites.local(messageId, { person: r.p, message: msgs.find((x) => x.id === messageId), recent: msgs.slice(-30), data: this.s.data });
    return ok({ ok: true });
  }

  // ---------- voice messages and audio files ----------

  private audioState(): Json {
    const a = this.extra.audio;
    return a ? (a.state() as unknown as Json) : null;
  }

  /**
   * `POST audio/play {key, account, url, name, at?, speed?, duration?}` (the attachment downloaded and decrypted
   * once, then played here), `pause`, `stop`, `seek {key, pos, duration?}`, `speed {speed}`, `played {key}` (the
   * phone plays it itself), `transcribe {key, account, url, name}` → `{ text }`; `GET audio` → the player's state.
   */
  private async audioRoute(m: string, act: string, b: Record<string, unknown>): Promise<Reply> {
    const a = this.extra.audio;
    if (!a) return err(503, "Audio isn't available here");
    if (m === "GET" && !act) return ok(this.audioState());
    if (m !== "POST") return err(405, "GET or POST");
    const key = str(b.key) ?? "";
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const speedOf = (v: unknown): number | null => { const n = num(v); return n === null ? null : Math.min(2, Math.max(0.5, n)); };
    const fileOf = async (): Promise<string> => {
      const url = str(b.url) ?? "";
      if (!url) throw new Error("no file");
      const f = await this.s.fetchAttachment(url, str(b.name) ?? "audio", str(b.account));
      if (!f) throw new Error("Couldn't download that audio");
      return f;
    };
    if (act === "play") {
      if (!/^[\w-]{1,60}:.{1,200}:\d{1,3}$/.test(key)) return err(400, "bad key");
      if (!a.canPlay()) return err(501, "No audio player on this PC (install ffmpeg, or mpv)");
      const f = await fileOf();
      return ok((await a.play(key, f, num(b.at), speedOf(b.speed), num(b.duration))) as unknown as Json);
    }
    if (act === "pause") return ok(a.pause() as unknown as Json);
    if (act === "stop") return ok(a.stop() as unknown as Json);
    if (act === "seek") return ok(a.seek(key, num(b.pos) ?? 0, num(b.duration)) as unknown as Json);
    if (act === "speed") {
      const sp = speedOf(b.speed) ?? 1;
      const st = a.state();
      // playing: it goes on from where it is at the new speed
      if (st.playing && st.key && str(b.url)) return ok((await a.play(st.key, await fileOf(), null, sp, st.duration)) as unknown as Json);
      return ok(a.setSpeed(sp) as unknown as Json);
    }
    if (act === "played") {
      if (key) a.markPlayed(key);
      return ok({ ok: !!key });
    }
    if (act === "transcribe") {
      if (!a.canTranscribe()) return err(501, "Speech to text isn't set up on this PC");
      const text = await a.transcribe(key, await fileOf());
      return ok({ ok: true, text });
    }
    return err(404, "no such call");
  }

  // ---------- Link with… / Unlink ----------

  /** `POST person/{id}/link {ids}`: they become part of this person (data.json backed up before the first link). */
  private link(personId: string, b: Record<string, unknown>): Reply {
    const id = decodeURIComponent(personId);
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter((x): x is string => typeof x === "string");
    if (!this.s.person(id)) return err(404, "no such person");
    if (!ids.length) return err(400, "pick who to link");
    const linked = this.s.link(id, ids);
    if (!linked.length) return err(400, "nobody to link");
    return ok({ ok: true, linked, person: json(this.s.person(id)) });
  }

  /** `POST person/{id}/unlink {id}`: someone linked into this person back on their own. */
  private unlinkRoute(personId: string, b: Record<string, unknown>): Reply {
    const id = decodeURIComponent(personId);
    const other = str(b.id) ?? "";
    if (!this.s.unlink(id, other)) return err(400, "they aren't linked here");
    return ok({ ok: true, person: json(this.s.person(other)) });
  }

  /** `POST person/{id}/move {to, from?}`: Move to… ("creators", "spokpay" or "store:<id>"; `from` the place the menu
   *  was opened in, none = everywhere). Their chats, identities, notes, pictures and AI chat come along; nothing is sent. */
  private moveRoute(personId: string, b: Record<string, unknown>): Reply {
    const id = decodeURIComponent(personId);
    const p = this.s.person(id);
    if (!p) return err(404, "no such person");
    const to = parsePlace(str(b.to) ?? "");
    if (!to) return err(400, "to: creators, spokpay or store:<id>");
    const from = str(b.from) ? parsePlace(str(b.from)!) : null;
    const left = this.s.move(id, from, to);
    if (!left) return err(400, "nothing to move");
    for (const sec of left) this.extra.ai?.move?.(p, sec, to.section);
    return ok({ ok: true, person: json(this.s.person(id)) });
  }

  // ---------- people ----------

  /** `fresh` false: socials as cached (instant); true: read now where stale (may take a few seconds). */
  private async panel(personId: string, fresh = true): Promise<Reply> {
    const d = this.s.data;
    const p = this.s.person(decodeURIComponent(personId));
    if (!d || !p) return err(404, "no such person");
    const socials = this.extra.socials && p.socials?.length ? await this.extra.socials(p.socials, fresh).catch(() => null) : null;
    const identities = [
      ...(p.discordId ? [{ kind: "discord", value: p.discordId, section: null, label: p.discordUsername ? `@${p.discordUsername}` : p.discordId }] : []),
      ...(p.email ? [{ kind: "gmail", value: p.email, section: null, label: p.email }] : []),
      ...(p.whatsapp ? [{ kind: "whatsapp", value: p.whatsapp, section: null, label: `+${p.whatsapp}` }] : []),
      ...(p.instagram ? [{ kind: "instagram", value: p.instagram, section: null, label: p.instagramUsername ? `@${p.instagramUsername}` : p.instagram }] : []),
      ...(p.identities ?? []).map((i) => ({ kind: i.kind, value: i.value, section: i.section, label: i.kind === "discord" && i.username ? `@${i.username}` : i.kind === "whatsapp" ? `+${i.value}` : i.value })),
    ];
    return ok({
      person: json(p),
      name: personLabel(p),
      initials: initials(personLabel(p)),
      color: colorOf(p.id),
      avatar: this.pictureRef(p),
      avatarPath: this.picture(p, 256) ?? this.picture(p),
      stores: d.stores.filter((s) => p.storeIds.includes(s.id) || s.ownerId === p.id).map((s) => ({ id: s.id, name: s.name, owner: s.ownerId === p.id, color: s.color ?? "#64748b" })),
      lists: d.lists.filter((l) => p.listIds.includes(l.id)).map((l) => ({ id: l.id, name: l.name })),
      identities: json(identities),
      linked: json((p.links ?? []).map((l) => ({ id: l.person.id, name: personLabel(l.person), at: l.at, ids: [l.person.discordUsername ? `@${l.person.discordUsername}` : l.person.discordId, l.person.email ? l.person.email : "", l.person.whatsapp ? `+${l.person.whatsapp}` : "", l.person.instagramUsername ? `@${l.person.instagramUsername}` : "", ...(l.person.identities ?? []).map((i) => (i.kind === "whatsapp" ? `+${i.value}` : i.value))].filter(Boolean), aiChats: this.extra.ai?.chatsOf?.(l.person) ?? [] }))),
      socials: socials ?? (p.socials ?? []).map((url) => ({ url, platform: null, handle: null, uploads: [] })),
    });
  }

  private patchPerson(personId: string, b: Record<string, unknown>): Reply {
    const id = decodeURIComponent(personId);
    if (!this.s.person(id)) return err(404, "no such person");
    const settle = obj(b.settle);
    const sec = sectionOf(str(settle.section));
    if (sec) this.s.setSettled(id, sec, settle.on !== false);
    if (typeof b.name === "string") this.s.rename(id, b.name);
    this.s.updatePerson(id, (p) => {
      const n: Person = { ...p };
      const at = new Date().toISOString();
      let changed = false;
      const set = <K extends "notes" | "email" | "whatsapp">(k: K, v: string | undefined): void => {
        if (v === undefined) return;
        changed = true;
        if (v) n[k] = v;
        else delete n[k];
      };
      if (typeof b.notes === "string") set("notes", b.notes.trim() ? b.notes : "");
      if (typeof b.email === "string") set("email", isEmail(b.email) ? b.email.trim().toLowerCase() : "");
      if (typeof b.whatsapp === "string") set("whatsapp", normWhatsApp(b.whatsapp));
      if (typeof b.discordId === "string" && (b.discordId === "" || isDiscordId(b.discordId))) {
        n.discordId = b.discordId.trim();
        changed = true;
      }
      if (typeof b.discordUsername === "string") {
        const u = cleanUsername(b.discordUsername);
        if (u) n.discordUsername = u;
        else delete n.discordUsername;
        changed = true;
      }
      if (Array.isArray(b.storeIds)) {
        n.storeIds = b.storeIds.filter((x): x is string => typeof x === "string" && !!this.s.data?.stores.some((s) => s.id === x));
        changed = true;
      }
      if (Array.isArray(b.listIds)) {
        n.listIds = b.listIds.filter((x): x is string => typeof x === "string" && !!this.s.data?.lists.some((l) => l.id === x));
        changed = true;
      }
      if (Array.isArray(b.socials)) {
        // TikTok / Instagram / YouTube profile links, canonical (tiktok.com/@x without https too)
        const urls = normalizeSocials(b.socials);
        if (urls.length) n.socials = urls;
        else delete n.socials;
        changed = true;
      }
      if (!changed) return p;
      n.updatedAt = at;
      return n;
    });
    return ok({ ok: true, person: json(this.s.person(id) ?? null) });
  }

  private deletePerson(personId: string): Reply {
    const id = decodeURIComponent(personId);
    const p = this.s.person(id);
    if (!p) return err(404, "no such person");
    this.s.deletePerson(id);
    return ok({ ok: true, person: json(p) });
  }

  private createPerson(b: Record<string, unknown>): Reply {
    const d = this.s.data;
    if (!d) return err(503, "not loaded");
    // Undo of a delete: the person as they were (same id), if nobody took the id meanwhile
    if (b.restore === true && typeof b.id === "string" && !d.people.some((p) => p.id === b.id)) {
      const { restore: _r, ...raw } = b;
      const back = normalizeData({ ...d, people: [raw] }).people[0];
      if (!back) return err(400, "can't restore that");
      this.s.update((x) => ({ ...x, people: [...x.people, back] }));
      return ok({ ok: true, person: json(back) });
    }
    const at = new Date().toISOString();
    const discordId = str(b.discordId)?.trim() ?? "";
    const email = str(b.email)?.trim().toLowerCase() ?? "";
    const wa = normWhatsApp(str(b.whatsapp) ?? "");
    const dup = d.people.find((p) => (discordId && p.discordId === discordId) || (email && p.email === email) || (wa && p.whatsapp === wa));
    if (dup) return ok({ ok: false, existing: dup.id, error: `${personLabel(dup)} already has that` });
    let p: Person = { id: this.s.newId(), name: (str(b.name) ?? "").trim(), discordId: isDiscordId(discordId) ? discordId : "", storeIds: [], listIds: [], createdAt: at, updatedAt: at };
    const uname = cleanUsername(str(b.discordUsername) ?? "");
    if (uname) p.discordUsername = uname;
    if (isEmail(email)) p.email = email;
    if (wa) p.whatsapp = wa;
    if (typeof b.avatar === "string" || b.avatar === null) p.avatar = b.avatar as string | null;
    if (str(b.displayName)) p.displayName = str(b.displayName)!;
    for (const sid of Array.isArray(b.storeIds) ? b.storeIds : []) if (typeof sid === "string" && d.stores.some((s) => s.id === sid)) p = joinScope(p, { kind: "store", id: sid }, at);
    for (const lid of Array.isArray(b.listIds) ? b.listIds : []) if (typeof lid === "string" && d.lists.some((l) => l.id === lid)) p = joinScope(p, { kind: "list", id: lid }, at);
    if (!p.name && !p.discordId && !p.discordUsername && !p.email && !p.whatsapp) return err(400, "give a name, a Discord id or username, an email or a WhatsApp number");
    const person = p;
    this.s.update((x) => ({ ...x, people: [...x.people, person] }));
    return ok({ ok: true, person: json(person) });
  }

  private saveStore(id: string | null, b: Record<string, unknown>): Reply {
    const name = (str(b.name) ?? "").trim();
    if (id === null) {
      if (!name) return err(400, "a store needs a name");
      const st: Store = { id: this.s.newId("s"), name, color: str(b.color) ?? COLORS[(this.s.data?.stores.length ?? 0) % COLORS.length]! };
      const owner = str(b.ownerId);
      if (owner && this.s.person(owner)) st.ownerId = owner;
      this.s.update((d) => ({ ...d, stores: [...d.stores, st] }));
      return ok({ ok: true, store: json(st) });
    }
    this.s.update((d) => ({
      ...d,
      stores: d.stores.map((s) => {
        if (s.id !== decodeURIComponent(id)) return s;
        const n: Store = { ...s };
        if (name) n.name = name;
        if (str(b.color)) n.color = str(b.color)!;
        if (typeof b.ownerId === "string") {
          if (b.ownerId && this.s.person(b.ownerId)) n.ownerId = b.ownerId;
          else delete n.ownerId;
        }
        return n;
      }),
    }));
    return ok({ ok: true });
  }

  private deleteStore(id: string): Reply {
    const sid = decodeURIComponent(id);
    this.s.update((d: AppData) => ({ ...d, stores: d.stores.filter((s) => s.id !== sid), people: d.people.map((p) => (p.storeIds.includes(sid) ? { ...p, storeIds: p.storeIds.filter((x) => x !== sid) } : p)) }));
    return ok({ ok: true });
  }

  private async lookup(c: Call): Promise<Reply> {
    const section = sectionOf(q(c, "section"));
    const kind = (q(c, "kind") ?? "discord") as ChannelKind;
    const text = (q(c, "q") ?? "").trim();
    if (!text) return ok({ matches: [] });
    const views = this.s.views();
    const conn = kind === "discord" ? this.s.discordFor(section) : views.find((v) => v.kind === kind && !!section && serves(v, section) && v.connected) ?? views.find((v) => v.kind === kind && v.connected);
    if (!conn) return ok({ matches: [], error: `No ${KIND_LABEL[kind]} connected` });
    const r = await this.s.lookup(conn.id, kind === "whatsapp" ? normWhatsApp(text) || text : text);
    const known = (id: string): string | null => this.s.data?.people.find((p) => (kind === "discord" ? p.discordId === id : kind === "gmail" ? p.email === id : kind === "instagram" ? p.instagram === id : p.whatsapp === id))?.id ?? null;
    return ok({
      matches: r.matches.map((u) => ({ id: u.id, username: u.username, name: u.globalName ?? u.username, avatar: u.avatar, avatarUrl: u.avatarUrl, known: known(u.id) })),
      notFound: !!r.notFound,
      notes: json(r.notes ?? []),
    });
  }

  // ---------- connections ----------

  private async addConn(b: Record<string, unknown>): Promise<Reply> {
    const section = sectionOf(str(b.section));
    const kind = str(b.kind) as ChannelKind | undefined;
    if (!section || !kind || !["discord", "gmail", "whatsapp", "instagram"].includes(kind)) return err(400, "section and kind");
    const m = await this.s.addConnection(section, kind);
    return ok({ ok: true, id: m.id });
  }

  /**
   * `POST contacts {kind, handle, name?}`: Personal › Add contact. `handle` is a WhatsApp number, a Discord username or
   * an Instagram username, resolved on that platform before anything is saved. `{ ok: true, person, existed }`, or
   * `{ ok: false, error }` with the reason it couldn't be resolved (nothing saved).
   */
  private async addContact(b: Record<string, unknown>): Promise<Reply> {
    const kind = str(b.kind);
    if (!isContactKind(kind)) return err(400, "kind: discord, whatsapp or instagram");
    try {
      const r = await this.s.addContact(kind, str(b.handle) ?? "", str(b.name) ?? "");
      return ok({ ok: true, person: json(r.person), existed: r.existed });
    } catch (e) {
      return ok({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** `POST connections/{id}/session {cookie}`: Instagram's session pasted from a browser; checked before it's kept. */
  private async connSession(id: string, b: Record<string, unknown>): Promise<Reply> {
    try {
      const st = await this.s.setSession(decodeURIComponent(id), str(b.cookie) ?? "");
      return ok({ ok: true, status: st.status });
    } catch (e) {
      return ok({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private connConnect(id: string): Reply {
    this.s.connect(decodeURIComponent(id));
    return ok({ ok: true });
  }

  private async connRemove(id: string): Promise<Reply> {
    await this.s.removeConnection(decodeURIComponent(id));
    return ok({ ok: true });
  }
}

/** The Person AI side (ai.ts): its items for a person+section, and asking it. */
export interface AiPort {
  items(p: Person, section: SectionId): Promise<{ id: string; role: "user" | "assistant"; text: string; at: string }[]>;
  /** `transcriptOf`: a message's voice transcript (attachment index), for the context's "[voice 0:20] …". */
  ask(p: Person, section: SectionId, text: string, conversation: Message[], kind: ChannelKind | null, data: AppData, transcriptOf?: (m: Message, index: number) => string | null | undefined, extra?: string): Promise<string | number>;
  /** A note about something that isn't a person here (a site request of a store nobody is linked to): its own chat. */
  askAbout?(key: string, title: string, text: string, context: string): Promise<string | number>;
  chatOfKey?(key: string): string | null;
  /** The person's AI chat once it exists (known after items or ask). */
  chatOf?(p: Person, section: SectionId): string | null;
  /** Every AI chat known for a person (a linked person's stay reachable from the panel). */
  chatsOf?(p: Person): { section: SectionId; chat: string }[];
  /** Move to…: the person's AI chat of `from` becomes their chat of `to` (when `to` has none yet). */
  move?(p: Person, from: SectionId, to: SectionId): void;
  /** A note went to `chat` from site request `ref`'s pane (its turns show in that pane; ai.ts sr-ai.json). */
  noteSr?(ref: string, chat: string, text: string): void;
  /** A site request's own turns with the Person AI (its notes and their answers; queued ones too), in time order. */
  srItems?(ref: string, current: string | null): Promise<{ id: string; role: "user" | "assistant"; text: string; at: string; streaming?: boolean; queued?: boolean }[]>;
}

export { validPeer };

/** The Person AI chat of a store nobody here is linked to (ai.ts askAbout): one per SpokPay store. */
const srAiKey = (v: { ref: string; storeSlug: string | null }): string => `sr:${v.storeSlug ?? v.ref}`;
