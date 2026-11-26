// Collector ↔ Persons › Creators, in-process: who's already there (so a run never collects them again), the channels a
// creator can be written on (the Creators Gmail; the Creators WhatsApp when their bio gives a number), the CRM's guards
// (30 new emails a day, no double sends, "already emailed"), and Send: the creator becomes (or joins) a person in
// Creators, with their picture, profiles, links and email, and the message goes out through Persons, so it's in that chat.
// Persons is the only sender: nothing here talks to Gmail or WhatsApp itself.
import type { PersonsService } from "../../packages/persons/src/index.ts";
import { allPeers, normWhatsApp } from "../../packages/persons/src/model/accounts.ts";
import { joinScope, socialPhotoKey } from "../../packages/persons/src/model/data.ts";
import type { Message, Person } from "../../packages/persons/src/model/types.ts";
import { normalizeSocials } from "../../packages/persons/src/socials.ts";
import { personKeys } from "./lib/identity.ts";
import { kindOf } from "./lib/links.ts";
import { DAILY_LIMIT, REPEAT_GUARD_MS } from "./lib/templates.ts";
import type { CreatorRecord } from "./lib/types.ts";

export interface Channel {
  /** The Persons connection id. */
  id: string;
  kind: "gmail" | "whatsapp";
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
  /** Email address or WhatsApp number. */
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

export function livePersons(svc: () => PersonsService | null): PersonsBridge {
  const people = (): Person[] => svc()?.data?.people ?? [];
  const creators = (): Person[] => people().filter((p) => p.listIds.includes("creators"));
  const find = (rec: CreatorRecord, kind: "gmail" | "whatsapp", to: string): Person | undefined => {
    const socials = new Set(socialsOf(rec));
    return (
      people().find((p) => allPeers(p, kind).includes(to)) ??
      people().find((p) => (p.socials ?? []).some((u) => socials.has(u)))
    );
  };
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
        .filter((v) => v.section === "creators" && (v.kind === "gmail" || v.kind === "whatsapp"))
        .map((v) => ({ id: v.id, kind: v.kind as "gmail" | "whatsapp", label: v.kind === "gmail" ? "Email" : "WhatsApp", account: v.state.me?.username || v.state.me?.globalName || null, connected: v.connected }))
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "gmail" ? -1 : 1));
    },
    guard: (channel, to, now = Date.now()) => {
      const v = svc()?.view(channel);
      if (!v) return { sentToday: 0, limit: DAILY_LIMIT, already: null, justSent: false };
      let sentToday = 0;
      if (v.kind === "gmail") for (const c of Object.values(v.convos)) for (const m of c.messages) if (isNewEmail(m) && now - at(m) < DAY_MS) sentToday++;
      const theirs = v.convos[v.kind === "gmail" ? to.toLowerCase() : to]?.messages ?? [];
      let last: Message | undefined;
      for (const m of theirs) if ((v.kind === "gmail" ? isNewEmail(m) : m.fromMe) && (!last || at(m) > at(last))) last = m;
      const already = last ? `You ${v.kind === "gmail" ? "emailed" : "wrote to"} them on ${new Date(at(last)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}${last.subject ? `: “${last.subject}”` : ""}.` : null;
      const justSent = theirs.some((m) => m.fromMe && now - at(m) < REPEAT_GUARD_MS && now >= at(m));
      return { sentToday, limit: v.kind === "gmail" ? DAILY_LIMIT : 0, already, justSent };
    },
    send: async (i) => {
      const s = svc();
      if (!s) return { ok: false, error: "Persons isn't up." };
      const v = s.view(i.channel);
      if (!v || v.section !== "creators") return { ok: false, error: "That channel isn't one of Persons › Creators'." };
      if (!v.connected) return { ok: false, error: `The Creators ${v.kind === "gmail" ? "Gmail" : "WhatsApp"} isn't signed in (Persons › Creators › Connections).` };
      const kind = v.kind as "gmail" | "whatsapp";
      const to = kind === "gmail" ? i.to.trim().toLowerCase() : normWhatsApp(i.to);
      if (!to) return { ok: false, error: kind === "gmail" ? "No email address." : "No WhatsApp number." };
      const now = new Date().toISOString();
      const socials = socialsOf(i.rec);
      let p = find(i.rec, kind, to);
      let created = false;
      if (!p) {
        const fresh: Person = {
          id: s.newId("p"),
          name: i.rec.name,
          discordId: "",
          ...(kind === "gmail" ? { email: to } : { whatsapp: to }),
          storeIds: [],
          listIds: ["creators"],
          socials,
          notes: notesOf(i.rec),
          createdAt: now,
          updatedAt: now,
        };
        if (i.rec.avatar_url?.startsWith("https://")) Object.assign(fresh, { socialPhoto: i.rec.avatar_url, socialPhotoAt: now, socialPhotoOf: socialPhotoKey(fresh) });
        if (kind === "gmail" && i.rec.whatsapp) fresh.whatsapp = i.rec.whatsapp;
        s.update((d) => ({ ...d, people: [...d.people, fresh] }));
        p = fresh;
        created = true;
      } else {
        const id = p.id;
        s.updatePerson(id, (x) => {
          let n = joinScope(x, { kind: "list", id: "creators" }, now);
          if (kind === "gmail" && !n.email) n = { ...n, email: to, updatedAt: now };
          if (kind === "whatsapp" && !n.whatsapp) n = { ...n, whatsapp: to, updatedAt: now };
          const merged = normalizeSocials([...(n.socials ?? []), ...socials]).slice(0, 12);
          if (merged.length !== (n.socials ?? []).length) n = { ...n, socials: merged, updatedAt: now };
          if (!n.notes) n = { ...n, notes: notesOf(i.rec), updatedAt: now };
          return n;
        });
      }
      const r = await s.send(p.id, v.id, i.text, { ...(kind === "gmail" && i.subject ? { subject: i.subject } : {}), peer: to });
      if (!r.ok) {
        // Persons Hub's rule: a person is only made by a send that went out.
        if (created) s.deletePerson(p.id);
        return { ok: false, error: r.error ?? "Not sent." };
      }
      return { ok: true, person: p.id, created };
    },
  };
}

/** For tests and the screenshot rig: records what would have been sent, sends nothing. */
export function fakePersons(o: { channels?: Channel[]; keys?: string[]; sent?: SendInput[] } = {}): PersonsBridge {
  const sent = o.sent ?? [];
  return {
    up: () => true,
    creatorKeys: () => o.keys ?? [],
    channels: () => o.channels ?? [{ id: "creators-gmail", kind: "gmail", label: "Email", account: "igor@spokpay.com", connected: true }],
    guard: () => ({ sentToday: sent.length, limit: DAILY_LIMIT, already: null, justSent: false }),
    send: async (i) => {
      sent.push(i);
      return { ok: true, person: `p_fake${sent.length}`, created: true };
    },
  };
}
