// Collector ↔ Persons › Creators, in-process: who's already there (so a run never collects them again), the channels a
// creator can be written on (every connection of Persons › Creators: Gmail, WhatsApp, Discord, Instagram), the CRM's
// guards (30 new emails a day, no double sends, "already emailed"), and Send: the creator becomes (or joins) a person in
// Creators, with their picture, profiles, links and the address it went to, and the message goes out through Persons,
// so it's in that chat. Persons is the only sender: nothing here talks to Gmail, WhatsApp, Discord or Instagram itself.
import type { PersonsService } from "../../packages/persons/src/index.ts";
import { allPeers, isInstagramId, normWhatsApp, serves } from "../../packages/persons/src/model/accounts.ts";
import { joinScope, socialPhotoKey } from "../../packages/persons/src/model/data.ts";
import type { Message, Person } from "../../packages/persons/src/model/types.ts";
import { resolveContact } from "../../packages/persons/src/model/personal.ts";
import { normalizeSocials } from "../../packages/persons/src/socials.ts";
import { personKeys } from "./lib/identity.ts";
import { kindOf } from "./lib/links.ts";
import { instagramHandle } from "./lib/reach.ts";
import { DAILY_LIMIT, REPEAT_GUARD_MS } from "./lib/templates.ts";
import type { CreatorRecord } from "./lib/types.ts";

/** The channels Send message goes on: Persons' own kinds. */
export type SendKind = "gmail" | "whatsapp" | "discord" | "instagram";
export const SEND_KINDS: readonly SendKind[] = ["gmail", "whatsapp", "discord", "instagram"];
export const SEND_LABEL: Record<SendKind, string> = { gmail: "Email", whatsapp: "WhatsApp", discord: "Discord", instagram: "Instagram" };
/** The Persons connection's name ("the Creators Gmail"). */
export const SEND_APP: Record<SendKind, string> = { gmail: "Gmail", whatsapp: "WhatsApp", discord: "Discord", instagram: "Instagram" };

export interface Channel {
  /** The Persons connection id. */
  id: string;
  kind: SendKind;
  label: string;
  /** The signed-in address/number, when known. */
  account: string | null;
  connected: boolean;
}

export interface Guard {
  sentToday: number;
  limit: number;
  /** "You emailed them on 12 Nov: “Sua loja profissional.”", or null. */
  already: string | null;
  /** Sent to them moments ago (a double click). */
  justSent: boolean;
}

export interface SendInput {
  rec: CreatorRecord;
  channel: string;
  /** Email address, WhatsApp number, Discord user ID or Instagram handle. */
  to: string;
  subject: string;
  text: string;
}

export interface SendOutcome {
  ok: boolean;
  error?: string;
  /** The person in Persons › Creators. */
  person?: string;
  created?: boolean;
}

export interface PersonsBridge {
  up(): boolean;
  creatorKeys(): string[];
  channels(): Channel[];
  guard(channel: string, to: string, now?: number): Guard;
  send(i: SendInput): Promise<SendOutcome>;
  /** The review bar's Approve to Persons › Creators: the creator becomes (or joins) a person there, as Send makes them,
   *  with no message sent. */
  add(rec: CreatorRecord): SendOutcome;
}

const DAY_MS = 86_400_000;
const at = (m: Message): number => Date.parse(m.timestamp) || 0;
const isNewEmail = (m: Message): boolean => m.fromMe && !/^\s*re:/i.test(m.subject ?? "");

/** The creator's profiles Persons can show (YouTube, TikTok, Instagram): their own page first, then their links. */
export function socialsOf(rec: CreatorRecord): string[] {
  const urls = [rec.profile_url ?? "", ...rec.links.map((l) => l.url)].filter((u) => u && ["youtube", "tiktok", "instagram"].includes(kindOf(u)));
  return normalizeSocials(urls).slice(0, 12);
}

/** What the person's notes say about where they came from (links Persons has no field for, stats, the email's source). */
export function notesOf(rec: CreatorRecord): string {
  const stats = [
    rec.subscriber_count === null ? "" : `${rec.subscriber_count} ${rec.platform === "youtube" ? "subscribers" : "followers"}`,
    rec.video_count === null ? "" : `${rec.video_count} ${rec.platform === "instagram" ? "posts" : "videos"}`,
  ].filter(Boolean);
  const lines = [`Collector: ${rec.platform} ${rec.handle ?? rec.platform_id}${stats.length ? ` (${stats.join(", ")})` : ""}, found with "${rec.discovered_via}".`];
  if (rec.email) lines.push(`Email from ${rec.email_source ?? "Collector"}.`);
  const other = rec.links.filter((l) => !["youtube", "tiktok", "instagram"].includes(kindOf(l.url)));
  if (other.length) lines.push("Links:", ...other.slice(0, 20).map((l) => `${l.label ? `${l.label}: ` : ""}${l.url}`));
  return lines.join("\n");
}

/** The person in Persons for this creator (by their email or number, else their profiles), joined to Creators with
 *  what Collector knows filled in; or a new one in Creators. Send's way, used by Approve too. */
function ensure(s: PersonsService, rec: CreatorRecord, kind: SendKind | null, to: string, username = ""): { person: Person; created: boolean } {
  const people = s.data?.people ?? [];
  const socials = socialsOf(rec);
  const set = new Set(socials);
  const found = (kind && to ? people.find((p) => allPeers(p, kind).includes(to)) : undefined) ?? people.find((p) => (p.socials ?? []).some((u) => set.has(u)));
  const now = new Date().toISOString();
  // A send to WhatsApp made them with the number alone, as before; Approve (no channel) with both when known.
  const email = kind === "gmail" ? to : kind === null ? (rec.email ?? "").trim().toLowerCase() : "";
  const wa = kind === "whatsapp" ? to : rec.whatsapp ? normWhatsApp(rec.whatsapp) : "";
  if (!found) {
    const fresh: Person = {
      id: s.newId("p"),
      name: rec.name,
      discordId: kind === "discord" ? to : "",
      ...(email ? { email } : {}),
      ...(wa ? { whatsapp: wa } : {}),
      ...(kind === "instagram" && to ? { instagram: to, ...(username ? { instagramUsername: username } : {}) } : {}),
      storeIds: [],
      listIds: ["creators"],
      socials,
      notes: notesOf(rec),
      createdAt: now,
      updatedAt: now,
    };
    if (rec.avatar_url?.startsWith("https://")) Object.assign(fresh, { socialPhoto: rec.avatar_url, socialPhotoAt: now, socialPhotoOf: socialPhotoKey(fresh) });
    s.update((d) => ({ ...d, people: [...d.people, fresh] }));
    return { person: fresh, created: true };
  }
  s.updatePerson(found.id, (x) => {
    let n = joinScope(x, { kind: "list", id: "creators" }, now);
    if (kind === "gmail" && to && !n.email) n = { ...n, email: to, updatedAt: now };
    if (kind === "whatsapp" && to && !n.whatsapp) n = { ...n, whatsapp: to, updatedAt: now };
    if (kind === "discord" && to && !n.discordId) n = { ...n, discordId: to, updatedAt: now };
    if (kind === "instagram" && to && !n.instagram) n = { ...n, instagram: to, ...(username ? { instagramUsername: username } : {}), updatedAt: now };
    const merged = normalizeSocials([...(n.socials ?? []), ...socials]).slice(0, 12);
    if (merged.length !== (n.socials ?? []).length) n = { ...n, socials: merged, updatedAt: now };
    if (!n.notes) n = { ...n, notes: notesOf(rec), updatedAt: now };
    return n;
  });
  return { person: found, created: false };
}

/** The chat's key in a connection's convos for what was typed (an Instagram handle: the id of whoever has it in Persons). */
function peerKey(kind: string, to: string, people: Person[]): string {
  if (kind === "gmail") return to.trim().toLowerCase();
  if (kind === "whatsapp") return normWhatsApp(to);
  if (kind === "discord") return to.trim().replace(/^@/, "");
  const h = instagramHandle(to).toLowerCase();
  return people.find((p) => (p.instagramUsername ?? "").toLowerCase() === h)?.instagram ?? "";
}

export function livePersons(svc: () => PersonsService | null): PersonsBridge {
  const people = (): Person[] => svc()?.data?.people ?? [];
  const creators = (): Person[] => people().filter((p) => p.listIds.includes("creators"));
  return {
    up: () => !!svc(),
    creatorKeys: () =>
      creators().flatMap((p) =>
        personKeys({
          emails: [...allPeers(p, "gmail")],
          links: p.socials ?? [],
        }),
      ),
    channels: () => {
      const s = svc();
      if (!s) return [];
      return s
        .views()
        .filter((v) => serves(v, "creators") && (SEND_KINDS as readonly string[]).includes(v.kind))
        .map((v) => ({ id: v.id, kind: v.kind as SendKind, label: SEND_LABEL[v.kind as SendKind], account: v.state.me?.username || v.state.me?.globalName || null, connected: v.connected }))
        .sort((a, b) => SEND_KINDS.indexOf(a.kind) - SEND_KINDS.indexOf(b.kind) || (a.id === b.id ? 0 : a.id.startsWith("creators") ? -1 : 1));
    },
    guard: (channel, to, now = Date.now()) => {
      const v = svc()?.view(channel);
      if (!v) return { sentToday: 0, limit: DAILY_LIMIT, already: null, justSent: false };
      let sentToday = 0;
      if (v.kind === "gmail") for (const c of Object.values(v.convos)) for (const m of c.messages) if (isNewEmail(m) && now - at(m) < DAY_MS) sentToday++;
      const theirs = v.convos[peerKey(v.kind, to, people())]?.messages ?? [];
      let last: Message | undefined;
      for (const m of theirs) if ((v.kind === "gmail" ? isNewEmail(m) : m.fromMe) && (!last || at(m) > at(last))) last = m;
      const already = last ? `You ${v.kind === "gmail" ? "emailed them" : `wrote to them on ${SEND_APP[v.kind as SendKind] ?? v.kind}`} on ${new Date(at(last)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}${last.subject ? `: “${last.subject}”` : ""}.` : null;
      const justSent = theirs.some((m) => m.fromMe && now - at(m) < REPEAT_GUARD_MS && now >= at(m));
      return { sentToday, limit: v.kind === "gmail" ? DAILY_LIMIT : 0, already, justSent };
    },
    send: async (i) => {
      const s = svc();
      if (!s) return { ok: false, error: "Persons isn't up." };
      const v = s.view(i.channel);
      if (!v || !serves(v, "creators") || !(SEND_KINDS as readonly string[]).includes(v.kind)) return { ok: false, error: "That channel isn't one of Persons › Creators'." };
      const kind = v.kind as SendKind;
      if (!v.connected) return { ok: false, error: `The Creators ${SEND_APP[kind]} isn't signed in (Persons › Creators › Connections).` };
      // who they are on that channel: the address or number as typed; an Instagram handle is looked up for its id
      let to = "";
      let username = "";
      if (kind === "gmail") to = i.to.trim().toLowerCase();
      else if (kind === "whatsapp") to = normWhatsApp(i.to);
      else if (kind === "discord") to = /^\d{15,21}$/.test(i.to.trim().replace(/^@/, "")) ? i.to.trim().replace(/^@/, "") : "";
      else {
        username = instagramHandle(i.to);
        const own = i.rec.platform === "instagram" && (i.rec.handle ?? "").replace(/^@/, "").toLowerCase() === username.toLowerCase() && isInstagramId(i.rec.platform_id) ? i.rec.platform_id : "";
        try {
          to = own || (await resolveContact("instagram", username, (q) => s.lookup(v.id, q))).id;
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (!to) return { ok: false, error: kind === "gmail" ? "No email address." : kind === "whatsapp" ? "No WhatsApp number." : kind === "discord" ? "A Discord user ID has 17-20 digits." : "No Instagram account." };
      const { person: p, created } = ensure(s, i.rec, kind, to, username);
      const r = await s.send(p.id, v.id, i.text, { ...(kind === "gmail" && i.subject ? { subject: i.subject } : {}), peer: to });
      if (!r.ok) {
        // Persons Hub's rule: a person is only made by a send that went out.
        if (created) s.deletePerson(p.id);
        return { ok: false, error: r.error ?? "Not sent." };
      }
      return { ok: true, person: p.id, created };
    },
    add: (rec) => {
      const s = svc();
      if (!s) return { ok: false, error: "Persons isn't up." };
      const email = (rec.email ?? "").trim().toLowerCase();
      const wa = rec.whatsapp ? normWhatsApp(rec.whatsapp) : "";
      const kind = email ? "gmail" : wa ? "whatsapp" : null;
      const { person, created } = ensure(s, rec, kind, kind === "gmail" ? email : wa);
      return { ok: true, person: person.id, created };
    },
  };
}

/** For tests and the screenshot rig: records what would have been sent, sends nothing. */
export function fakePersons(o: { channels?: Channel[]; keys?: string[]; sent?: SendInput[]; added?: CreatorRecord[] } = {}): PersonsBridge {
  const sent = o.sent ?? [];
  const added = o.added ?? [];
  return {
    up: () => true,
    creatorKeys: () => o.keys ?? [],
    channels: () =>
      o.channels ?? [
        { id: "creators-gmail", kind: "gmail", label: "Email", account: "igor@spokpay.com", connected: true },
        { id: "creators-whatsapp", kind: "whatsapp", label: "WhatsApp", account: null, connected: true },
        { id: "creators-discord", kind: "discord", label: "Discord", account: "spokpay", connected: true },
        { id: "creators-instagram", kind: "instagram", label: "Instagram", account: "spokpay", connected: false },
      ],
    guard: () => ({ sentToday: sent.length, limit: DAILY_LIMIT, already: null, justSent: false }),
    send: async (i) => {
      sent.push(i);
      return { ok: true, person: `p_fake${sent.length}`, created: true };
    },
    add: (rec) => {
      added.push(rec);
      return { ok: true, person: `p_added${added.length}`, created: true };
    },
  };
}
