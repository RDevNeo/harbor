// Collector ↔ Persons › Creators, in-process: who's already there (so a run never collects them again), the channels a
// creator can be written on (every connection of Persons › Creators: Gmail, WhatsApp, Discord, Instagram), the CRM's
// guards (30 new emails a day, no double sends, "already emailed"), and Send: the creator becomes (or joins) a person in
// Creators, with their picture, profiles, links and the address it went to, and the message goes out through Persons,
// so it's in that chat. Persons is the only sender: nothing here talks to Gmail, WhatsApp, Discord or Instagram itself.
import type { PersonsService } from "../../packages/persons/src/index.ts";
import { allPeers, isInstagramId, normWhatsApp, phoneVariants, SECTION_LABEL, serves } from "../../packages/persons/src/model/accounts.ts";
import { DEFAULT_LISTS, joinScope, socialPhotoKey } from "../../packages/persons/src/model/data.ts";
import { LIST_SECTIONS, parsePlace, type Place } from "../../packages/persons/src/model/move.ts";
import type { Message, Person, SectionId } from "../../packages/persons/src/model/types.ts";
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
  /** Persons' name for the connection: "Creators Gmail", "Stores WhatsApp". */
  conn?: string;
}

/** Where Send puts the person in Persons: a store, or the Creators / SpokPay / Neobux / Personal list ("store:<id>",
 *  "creators"…, Persons' parsePlace words), with its section (whose connections send). */
export interface PersonsPlace {
  value: string;
  label: string;
  section: SectionId;
}

/** "creators" when the place is unknown (Send's place before it could be picked). */
export const DEFAULT_PLACE = "creators";

/** A place's section ("store:x" → "stores"). */
export const placeSection = (place: string): PersonsPlace["section"] => parsePlace(place)?.section ?? "creators";

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
  /** Where in Persons they go ("creators" when absent). */
  place?: string;
  subject: string;
  text: string;
}

export interface SendOutcome {
  ok: boolean;
  error?: string;
  /** The person in Persons (the place sent to). */
  person?: string;
  created?: boolean;
}

export interface PersonsBridge {
  up(): boolean;
  /** Everyone in Persons › Creators and Neobux (creators too) and in the other places given (where Collector has sent
   *  leads): never collected. */
  creatorKeys(places?: string[]): string[];
  /** Persons' places, as its sidebar has them: each store, then Creators, SpokPay, Neobux, Personal. */
  places(): PersonsPlace[];
  /** The connections that send for a section (its own, and those shared with it); none given: every one. */
  channels(section?: string): Channel[];
  guard(channel: string, to: string, now?: number): Guard;
  send(i: SendInput): Promise<SendOutcome>;
  /** The review bar's Approve (Persons › Creators) or Neobux: the creator becomes (or joins) a person in that place
   *  ("creators" when none given; the list made when missing), as Send makes them, with no message sent. */
  add(rec: CreatorRecord, place?: string): SendOutcome;
  /** Every message Persons sent that went out (Collector's or typed in Persons; never a failed one), with who it went
   *  to: Collector moves the lead that is that person into Sent. Returns the unsubscribe. */
  onSent?(cb: (e: SentEvent) => void): () => void;
}

/** A message Persons sent (onSent), and who in Persons it went to. */
export interface SentEvent {
  kind: SendKind;
  /** The email, WhatsApp digits, Discord or Instagram id it went to. */
  peer: string;
  at: string;
  /** The person in Persons (null: nobody there has that address), their profiles and emails. */
  person: string | null;
  socials: string[];
  emails: string[];
  /** Where they are in Persons ("creators", "store:<id>"…) and its name. */
  place: string;
  placeLabel: string;
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
function ensure(s: PersonsService, rec: CreatorRecord, kind: SendKind | null, to: string, username = "", placeWord = DEFAULT_PLACE): { person: Person; created: boolean } {
  const place: Place = parsePlace(placeWord) ?? { section: "creators" };
  const scope = place.section === "stores" ? ({ kind: "store", id: place.store } as const) : ({ kind: "list", id: place.section } as const);
  // the list joined is there (as Persons' Move to / Add contact make it)
  if (place.section !== "stores" && !(s.data?.lists ?? []).some((l) => l.id === place.section)) {
    const def = DEFAULT_LISTS.find((l) => l.id === place.section);
    if (def && s.data) s.update((d) => ({ ...d, lists: [...(d.lists ?? []), { ...def }] }));
  }
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
      ...(kind === "discord" && to && username ? { discordUsername: username } : {}),
      ...(email ? { email } : {}),
      ...(wa ? { whatsapp: wa } : {}),
      ...(kind === "instagram" && to ? { instagram: to, ...(username ? { instagramUsername: username } : {}) } : {}),
      storeIds: place.section === "stores" ? [place.store] : [],
      listIds: place.section === "stores" ? [] : [place.section],
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
    let n = joinScope(x, scope, now);
    if (kind === "gmail" && to && !n.email) n = { ...n, email: to, updatedAt: now };
    if (kind === "whatsapp" && to && !n.whatsapp) n = { ...n, whatsapp: to, updatedAt: now };
    if (kind === "discord" && to && !n.discordId) n = { ...n, discordId: to, ...(username && !n.discordUsername ? { discordUsername: username } : {}), updatedAt: now };
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

/** The lists whose people a run never collects, whether or not Collector sent there: creators already being talked to. */
export const ALWAYS_KNOWN: readonly string[] = ["creators", "neobux"];

export function livePersons(svc: () => PersonsService | null): PersonsBridge {
  const people = (): Person[] => svc()?.data?.people ?? [];
  return {
    up: () => !!svc(),
    places: () => {
      const d = svc()?.data;
      if (!d) return [{ value: "creators", label: "Creators", section: "creators" }];
      const stores = d.stores.map((x): PersonsPlace => ({ value: `store:${x.id}`, label: x.name, section: "stores" }));
      const lists = LIST_SECTIONS.map((id): PersonsPlace => ({ value: id, label: d.lists.find((l) => l.id === id)?.name || SECTION_LABEL[id], section: id }));
      return [...stores, ...lists];
    },
    onSent: (cb) => {
      // Persons may come up after Collector: subscribe once it's there
      let off: (() => void) | null = null;
      let stopped = false;
      const on = (): void => {
        const s = svc();
        if (!s || off || stopped || typeof s.onSent !== "function") return;
        off = s.onSent((e) => {
          if (!(SEND_KINDS as readonly string[]).includes(e.kind)) return;
          const same = (v: string): boolean => v === e.peer || (e.kind === "whatsapp" && (phoneVariants(v).includes(e.peer) || phoneVariants(e.peer).includes(v)));
          const p = (s.data?.people ?? []).find((x) => allPeers(x, e.kind).some(same)) ?? null;
          // the section it went from: the connection's own, or one it is shared with (Neobux writes through Creators'
          // logins, Personal through the Stores ones) when that's where the person is
          const served: SectionId[] = [e.section, ...(s.view(e.connId)?.also ?? [])];
          const sec = (p && served.find((x) => (x === "stores" ? p.storeIds.length > 0 : p.listIds.includes(x)))) || e.section;
          const place = sec === "stores" ? (p?.storeIds[0] ? `store:${p.storeIds[0]}` : DEFAULT_PLACE) : sec;
          const label = sec === "stores" ? (s.data?.stores.find((x) => `store:${x.id}` === place)?.name ?? SECTION_LABEL.stores) : (s.data?.lists.find((l) => l.id === sec)?.name ?? SECTION_LABEL[sec]);
          cb({ kind: e.kind as SendKind, peer: e.peer, at: e.at, person: p?.id ?? null, socials: p?.socials ?? [], emails: p ? allPeers(p, "gmail") : [], place, placeLabel: label });
        });
      };
      on();
      const t = off ? null : setInterval(() => {
        on();
        if (off && t) clearInterval(t);
      }, 5000);
      (t as { unref?: () => void } | null)?.unref?.();
      return () => {
        stopped = true;
        off?.();
        if (t) clearInterval(t);
      };
    },
    creatorKeys: (places = []) =>
      people()
        .filter((p) => ALWAYS_KNOWN.some((l) => p.listIds.includes(l)) || places.some((w) => { const x = parsePlace(w); return !!x && (x.section === "stores" ? p.storeIds.includes(x.store) : p.listIds.includes(x.section)); }))
        .flatMap((p) =>
        personKeys({
          emails: [...allPeers(p, "gmail")],
          links: p.socials ?? [],
        }),
      ),
    channels: (section) => {
      const s = svc();
      if (!s) return [];
      return s
        .views()
        .filter((v) => (!section || serves(v, section as PersonsPlace["section"])) && (SEND_KINDS as readonly string[]).includes(v.kind))
        .map((v) => ({ id: v.id, kind: v.kind as SendKind, label: SEND_LABEL[v.kind as SendKind], account: v.state.me?.username || v.state.me?.globalName || null, connected: v.connected, conn: v.label, own: v.section === section }))
        .sort((a, b) => SEND_KINDS.indexOf(a.kind) - SEND_KINDS.indexOf(b.kind) || Number(b.own) - Number(a.own))
        .map(({ own: _, ...c }) => c);
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
      const placeWord = i.place && parsePlace(i.place) ? i.place : DEFAULT_PLACE;
      const section = placeSection(placeWord);
      if (!v || !serves(v, section) || !(SEND_KINDS as readonly string[]).includes(v.kind)) return { ok: false, error: `That channel doesn't send for Persons › ${SECTION_LABEL[section]}.` };
      const kind = v.kind as SendKind;
      if (!v.connected) return { ok: false, error: `The ${v.label} isn't signed in (Persons › ${SECTION_LABEL[v.section]} › Connections).` };
      if (placeWord.startsWith("store:") && !(s.data?.stores ?? []).some((x) => `store:${x.id}` === placeWord)) return { ok: false, error: "That store isn't in Persons any more." };
      // who they are on that channel: the address or number as typed; an Instagram handle is looked up for its id
      let to = "";
      let username = "";
      if (kind === "gmail") to = i.to.trim().toLowerCase();
      else if (kind === "whatsapp") to = normWhatsApp(i.to);
      else if (kind === "discord") {
        // a user ID as typed; a username is looked up on that Discord for its user ID (only people it shares a server
        // or a DM with can be found)
        const t = i.to.trim().replace(/^@/, "");
        if (/^\d{15,21}$/.test(t)) to = t;
        else
          try {
            const r = await resolveContact("discord", t, (q) => s.lookup(v.id, q));
            to = r.id;
            username = r.username;
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
      }
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
      const { person: p, created } = ensure(s, i.rec, kind, to, username, placeWord);
      const r = await s.send(p.id, v.id, i.text, { ...(kind === "gmail" && i.subject ? { subject: i.subject } : {}), peer: to });
      if (!r.ok) {
        // Persons Hub's rule: a person is only made by a send that went out.
        if (created) s.deletePerson(p.id);
        return { ok: false, error: r.error ?? "Not sent." };
      }
      return { ok: true, person: p.id, created };
    },
    add: (rec, place = DEFAULT_PLACE) => {
      const s = svc();
      if (!s) return { ok: false, error: "Persons isn't up." };
      const email = (rec.email ?? "").trim().toLowerCase();
      const wa = rec.whatsapp ? normWhatsApp(rec.whatsapp) : "";
      const kind = email ? "gmail" : wa ? "whatsapp" : null;
      const { person, created } = ensure(s, rec, kind, kind === "gmail" ? email : wa, "", place);
      return { ok: true, person: person.id, created };
    },
  };
}

/** For tests and the screenshot rig: records what would have been sent, sends nothing. */
export function fakePersons(o: { channels?: Channel[]; keys?: string[]; sent?: SendInput[]; added?: CreatorRecord[]; addedTo?: string[]; places?: PersonsPlace[] } = {}): PersonsBridge {
  const sent = o.sent ?? [];
  const added = o.added ?? [];
  const addedTo = o.addedTo ?? [];
  return {
    up: () => true,
    creatorKeys: () => o.keys ?? [],
    places: () => o.places ?? [{ value: "store:robux", label: "Robux Paradise", section: "stores" }, { value: "creators", label: "Creators", section: "creators" }, { value: "spokpay", label: "SpokPay", section: "spokpay" }, { value: "neobux", label: "Neobux", section: "neobux" }, { value: "personal", label: "Personal", section: "personal" }],
    channels: (section) =>
      o.channels ??
      (section === "stores" || section === "personal"
        ? [
            { id: "stores-gmail", kind: "gmail", label: "Email", account: "lojas@spokpay.com", connected: true, conn: "Stores Gmail" },
            { id: "stores-whatsapp", kind: "whatsapp", label: "WhatsApp", account: null, connected: true, conn: "Stores WhatsApp" },
            { id: "stores-discord", kind: "discord", label: "Discord", account: "spokpay", connected: true, conn: "Stores Discord" },
          ]
        : [
            { id: "creators-gmail", kind: "gmail", label: "Email", account: "igor@spokpay.com", connected: true, conn: "Creators Gmail" },
            { id: "creators-whatsapp", kind: "whatsapp", label: "WhatsApp", account: null, connected: true, conn: "Creators WhatsApp" },
            { id: "creators-discord", kind: "discord", label: "Discord", account: "spokpay", connected: true, conn: "Creators Discord" },
            { id: "creators-instagram", kind: "instagram", label: "Instagram", account: "spokpay", connected: false, conn: "Creators Instagram" },
          ]),
    guard: () => ({ sentToday: sent.length, limit: DAILY_LIMIT, already: null, justSent: false }),
    send: async (i) => {
      sent.push(i);
      return { ok: true, person: `p_fake${sent.length}`, created: true };
    },
    add: (rec, place = DEFAULT_PLACE) => {
      added.push(rec);
      addedTo.push(place);
      return { ok: true, person: `p_added${added.length}`, created: true };
    },
  };
}
