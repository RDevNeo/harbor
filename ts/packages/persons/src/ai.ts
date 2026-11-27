// Person AI (creators-hub/src/lib/personAi.ts): one Hub chat per person and section, in the project whose folder ends
// in creators-hub/tabs/Persons (the old "creators" project as fallback), titled "<Person> · <Section>", created on
// the first question. Each question carries the hidden <person-hub-context> (who the person is, the section, the
// recent conversation); the answers show in the person's chat as AI bubbles and are never sent to the person.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTION_LABEL } from "./model/accounts.ts";
import { personLabel } from "./model/data.ts";
import type { AppData, ChannelKind, Message, Person, SectionId } from "./model/types.ts";
import { writeAtomic } from "./store.ts";
import { formatDuration } from "./model/conversation.ts";
import { isAudio } from "./voicequeue.ts";
import type { AiPort } from "./routes.ts";

export const AI_PROJECT_PATH = "creators-hub/tabs/Persons";
const LEGACY_AI_PROJECT = "creators";
const CTX_OPEN = "\n\n<person-hub-context>\n";
const CTX_CLOSE = "\n</person-hub-context>";
export const CONTEXT_MESSAGES = 30;

export const aiTitle = (p: Person, section: SectionId): string => `${personLabel(p)} · ${SECTION_LABEL[section]}`;
export const withAiContext = (text: string, context: string): string => `${text}${CTX_OPEN}${context}${CTX_CLOSE}`;
export const stripAiContext = (text: string): string => text.replace(/\s*<person-hub-context>[\s\S]*?<\/person-hub-context>\s*/g, "").trim();

export const SECTION_MEANING: Record<SectionId, string> = {
  stores: "Stores: people who own a store on SpokPay (the user's platform that turns a seller into a Roblox store: storefront, PIX checkout, automatic Robux/gamepass delivery). The user supports them and talks to them on Discord (or WhatsApp). They are mostly Brazilian and the conversation is usually in Portuguese.",
  spokpay: "SpokPay: people the user is onboarding to SpokPay (bringing their Roblox store to the platform). The user talks to them on Discord (or WhatsApp). They are mostly Brazilian and the conversation is usually in Portuguese.",
  creators: "Creators: content creators / influencers the user reaches out to by email (Gmail), e.g. for partnerships and promotion.",
  neobux: "Neobux: content creators / influencers the user invites to promote Neobux, the user's own Robux and Gamepass store (it sells on SpokPay). A creator gets a 7% coupon for their audience and a commission on the sales it brings (10% to start, 15% at most, never more). The user writes to them by email, WhatsApp, Discord or Instagram. They are mostly Brazilian and the conversation is usually in Portuguese.",
  personal: "Personal: the user's own contacts (friends, family, acquaintances) on the user's own Discord, WhatsApp or Instagram. Not about SpokPay unless the conversation says so; answer in the conversation's language.",
};

/** The hidden context of a question (personAi.ts aiContext, unchanged wording). */
/** What a message's attachments say in the context: "[voice 0:20] <transcript>" for speech, else their names. */
export function attachmentsLine(m: Message, transcriptOf?: (m: Message, index: number) => string | null | undefined): string {
  const atts = m.attachments ?? [];
  if (!atts.length) return "";
  const parts: string[] = [];
  const others: string[] = [];
  atts.forEach((a, i) => {
    if (!isAudio(m, a)) return void others.push(a.name);
    const len = a.duration ? ` ${formatDuration(a.duration)}` : "";
    const t = transcriptOf?.(m, i)?.replace(/\s+/g, " ").trim();
    parts.push(`[${m.voice ? "voice" : "audio"}${len}]${t ? ` ${t}` : t === "" ? " (no speech)" : " (not transcribed)"}`);
  });
  if (others.length) parts.push(`[${others.join(", ")}]`);
  return parts.join(" ");
}

export function aiContext(o: { person: Person; section: SectionId; data: Pick<AppData, "stores" | "lists"> | null; channel: string; messages: readonly Message[]; me?: string; transcriptOf?: (m: Message, index: number) => string | null | undefined }): string {
  const { person: p, section, data } = o;
  const name = personLabel(p);
  const ids: string[] = [];
  if (p.discordId || p.discordUsername) ids.push(`Discord ${[p.discordUsername && `@${p.discordUsername}`, p.discordId && `(id ${p.discordId})`].filter(Boolean).join(" ")}`);
  if (p.email) ids.push(`email ${p.email}`);
  if (p.whatsapp) ids.push(`WhatsApp +${p.whatsapp}`);
  for (const i of p.identities ?? []) ids.push(`${i.kind} ${i.username ? `@${i.username} ` : ""}${i.kind === "whatsapp" ? `+${i.value}` : i.value} (in ${SECTION_LABEL[i.section]})`);
  const stores = (data?.stores ?? []).filter((s) => p.storeIds.includes(s.id)).map((s) => `${s.name}${s.ownerId === p.id ? " (owner)" : ""}`);
  const owns = (data?.stores ?? []).filter((s) => s.ownerId === p.id && !p.storeIds.includes(s.id)).map((s) => `${s.name} (owner)`);
  const lists = (data?.lists ?? []).filter((l) => p.listIds.includes(l.id)).map((l) => l.name);
  const recent = o.messages.slice(-CONTEXT_MESSAGES);
  const line = (m: Message): string => {
    const files = attachmentsLine(m, o.transcriptOf);
    const subj = m.subject ? ` (subject: ${m.subject})` : "";
    const text = m.content.replace(/\n+/g, " ⏎ ");
    return `[${m.timestamp.slice(0, 16).replace("T", " ")}] ${m.fromMe ? (o.me ? `Me (${o.me})` : "Me") : name}${subj}: ${text}${text && files ? " " : ""}${files}`;
  };
  return [
    "You are the user's assistant inside Hub's Persons tab, for their conversation with one person. The user writes to you here; you never talk to the person.",
    "Never send anything to this person (or anyone) yourself: no Discord, Gmail or WhatsApp sends. When you suggest a message for the user to send, put exactly that text in a fenced block that starts with ```reply (one block per suggested message), written in the language of the conversation.",
    "",
    `Person: ${name}${p.displayName && p.displayName !== name ? ` (display name ${p.displayName})` : ""}`,
    ids.length ? `Identities: ${ids.join("; ")}` : "",
    stores.length || owns.length ? `Stores: ${[...stores, ...owns].join(", ")}` : "",
    lists.length ? `Lists: ${lists.join(", ")}` : "",
    p.notes?.trim() ? `Notes: ${p.notes.trim()}` : "",
    "",
    `Section: ${SECTION_MEANING[section]}`,
    `Channel of this chat: ${o.channel}`,
    "",
    recent.length ? `The last ${recent.length} messages with ${name} on ${o.channel} (oldest first):` : `No messages with ${name} on ${o.channel} yet.`,
    ...recent.map(line),
  ].filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i > 0)).join("\n");
}

interface StateChat { id: string | number; title: string; role?: string; retired?: boolean; project_id?: string | number | null; updated_ms?: number }
interface StateProject { id: string | number; name: string; path?: string }
interface Card { seq: number; kind: string; text?: string; markdown?: string; at?: number }

/** The project and the chat titled `title` in it (personAi.ts findAiChat). */
export function findAiChat(s: { projects: StateProject[]; chats: StateChat[] }, title: string): { project: string | null; chat: string | null } {
  const clean = (p: StateProject): string => (p.path ?? "").replace(/\/+$/, "");
  const persons = s.projects.filter((p) => clean(p).endsWith(`/${AI_PROJECT_PATH}`));
  const projects = persons.length ? persons : s.projects.filter((p) => p.name.trim().toLowerCase() === LEGACY_AI_PROJECT || clean(p).split("/").pop()?.toLowerCase() === LEGACY_AI_PROJECT);
  const ids = new Set(projects.map((p) => String(p.id)));
  const t = title.trim().toLowerCase();
  const chat = s.chats
    .filter((c) => c.title.trim().toLowerCase() === t && c.role !== "sub" && !c.retired && c.project_id != null && ids.has(String(c.project_id)))
    .sort((a, b) => (b.updated_ms ?? 0) - (a.updated_ms ?? 0))[0];
  return { project: projects[0] ? String(projects[0].id) : null, chat: chat ? String(chat.id) : null };
}

/** Hub's cards as AI bubbles: each user card one, the text cards after it one reply (personAi.ts cardsToAi). */
export function cardsToAi(cards: readonly Card[], running: boolean): { id: string; role: "user" | "assistant"; text: string; at: string; streaming?: boolean }[] {
  const out: { id: string; role: "user" | "assistant"; text: string; at: string; streaming?: boolean }[] = [];
  let reply: (typeof out)[number] | null = null;
  const at = (c: Card): string => new Date((c.at ?? Date.now() / 1000) * 1000).toISOString();
  for (const c of cards) {
    if (c.kind === "user") {
      reply = null;
      out.push({ id: `h${c.seq}`, role: "user", text: stripAiContext(c.markdown ?? c.text ?? ""), at: at(c) });
    } else if (c.kind === "text") {
      const text = c.markdown ?? c.text ?? "";
      if (!reply) {
        reply = { id: `h${c.seq}`, role: "assistant", text, at: at(c) };
        out.push(reply);
      } else reply.text = [reply.text, text].filter(Boolean).join("\n\n");
    }
  }
  const last = out.at(-1);
  if (running) {
    if (last?.role === "assistant") last.streaming = true;
    else if (last) out.push({ id: "h-wait", role: "assistant", text: "", at: last.at, streaming: true });
  }
  return out;
}

/**
 * The site request a note to the AI came from: srpane.ts srAiContext puts "Site request: SR-215 · <subject>" on a line
 * of its hidden context (the person's context comes first when the store's person is known). Null for anything else.
 */
export function srRefOf(raw: string): string | null {
  const ctx = /<person-hub-context>([\s\S]*?)<\/person-hub-context>/.exec(raw)?.[1];
  if (!ctx || !ctx.includes("SpokPay site request's pane")) return null;
  return /^Site request: (SR-[A-Za-z0-9-]+) ·/m.exec(ctx)?.[1] ?? null;
}

export type AiTurn = { id: string; role: "user" | "assistant"; text: string; at: string; streaming?: boolean; queued?: boolean };

/**
 * The turns of one site request in its Person AI chat (cardsToAi, but only the notes sent from that request's pane and
 * the answers after each, up to the next note). `running`: the chat's turn is going; it is this request's while the
 * chat's last note is one of them. Ids carry the chat's (a request's notes may sit in more than one chat).
 */
export function srTurns(cards: readonly Card[], ref: string, running: boolean, chat: string): AiTurn[] {
  const out: AiTurn[] = [];
  let reply: AiTurn | null = null;
  let ours = false;
  const at = (c: Card): string => new Date((c.at ?? Date.now() / 1000) * 1000).toISOString();
  for (const c of cards) {
    if (c.kind === "user") {
      const raw = c.markdown ?? c.text ?? "";
      ours = srRefOf(raw) === ref;
      reply = null;
      if (ours) out.push({ id: `${chat}:h${c.seq}`, role: "user", text: stripAiContext(raw), at: at(c) });
    } else if (c.kind === "text" && ours) {
      const text = c.markdown ?? c.text ?? "";
      if (!reply) {
        reply = { id: `${chat}:h${c.seq}`, role: "assistant", text, at: at(c) };
        out.push(reply);
      } else reply.text = [reply.text, text].filter(Boolean).join("\n\n");
    }
  }
  const last = out.at(-1);
  if (running && ours && last) {
    if (last.role === "assistant") last.streaming = true;
    else out.push({ id: `${chat}:h-wait`, role: "assistant", text: "", at: last.at, streaming: true });
  }
  return out;
}

/** A note sent from a request's pane that its chat hasn't shown yet (queued behind a running turn). */
export interface SrPending {
  at: number;
  chat: string;
  text: string;
}
/** sr-ai.json: each request's Person AI chats (its notes stay found when its person changes) and notes on their way. */
export type SrNotes = Record<string, { chats: string[]; pending: SrPending[] }>;

/** A pending note waits this long for its card, then it's dropped (the chat lost it, or the user cleared the queue). */
export const PENDING_MS = 30 * 60_000;

/**
 * The request's turns from its chats plus its notes still on their way: a pending note goes once a note card with its
 * words shows in its chat (sent at or after it), else after PENDING_MS. Returns the timeline (by time) and the pending
 * notes still waiting.
 */
export function srMerge(turns: readonly AiTurn[], pending: readonly SrPending[], now: number): { items: AiTurn[]; pending: SrPending[] } {
  const used = new Set<string>();
  const left: SrPending[] = [];
  for (const p of pending) {
    const hit = turns.find((t) => t.role === "user" && !used.has(t.id) && t.id.startsWith(`${p.chat}:`) && Date.parse(t.at) >= p.at - 5_000 && t.text.trim() === p.text.trim());
    if (hit) used.add(hit.id);
    else if (now - p.at < PENDING_MS) left.push(p);
  }
  const items: AiTurn[] = [...turns];
  for (const p of left) {
    const at = new Date(p.at).toISOString();
    items.push({ id: `p${p.at}`, role: "user", text: p.text, at, queued: true });
    items.push({ id: `p${p.at}-wait`, role: "assistant", text: "", at, streaming: true });
  }
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { items, pending: left };
}

type HubCall = (method: string, path: string, query?: Record<string, string>, body?: unknown) => Promise<{ status: number; body: unknown }>;

export class PersonAi implements AiPort {
  private file: string;
  private chats: Record<string, string> = {};

  constructor(dir: string, private readonly call: HubCall) {
    this.file = join(dir, "ai-chats.json");
    try {
      if (existsSync(this.file)) this.chats = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      this.chats = {};
    }
    this.srFile = join(dir, "sr-ai.json");
    try {
      if (existsSync(this.srFile)) this.srNotes = JSON.parse(readFileSync(this.srFile, "utf8")) as SrNotes;
    } catch {
      this.srNotes = {};
    }
  }

  private saveSr(): void {
    writeAtomic(this.srFile, JSON.stringify(this.srNotes, null, 2));
  }

  /** A note went from request `ref`'s pane to `chat` (`text`: its words as the chat shows them, context left out). */
  noteSr(ref: string, chat: string, text: string, now = Date.now()): void {
    const e = this.srNotes[ref] ?? { chats: [], pending: [] };
    if (!e.chats.includes(chat)) e.chats.push(chat);
    e.pending.push({ at: now, chat, text });
    this.srNotes[ref] = e;
    this.saveSr();
  }

  /**
   * Request `ref`'s turns with the Person AI, in time order: its notes and the answers to them, from every chat its notes
   * went to (and `current`, the chat they go to now), plus its notes still queued.
   */
  async srItems(ref: string, current: string | null): Promise<AiTurn[]> {
    const e = this.srNotes[ref];
    const chats = [...new Set([...(e?.chats ?? []), ...(current ? [current] : [])])];
    const turns: AiTurn[] = [];
    for (const chat of chats) {
      const r = await this.call("GET", `v1/chats/${encodeURIComponent(chat)}/items`, { since: "0" }).catch(() => null);
      if (!r || r.status !== 200) continue;
      const b = (r.body ?? {}) as { items?: Card[]; running?: boolean; queued?: number };
      turns.push(...srTurns(b.items ?? [], ref, !!b.running, chat));
    }
    const m = srMerge(turns, e?.pending ?? [], Date.now());
    if (e && m.pending.length !== e.pending.length) {
      e.pending = m.pending;
      this.saveSr();
    }
    return m.items;
  }

  private key = (p: Person, s: SectionId): string => `${p.id}:${s}`;
  private srFile: string;
  private srNotes: SrNotes = {};

  private remember(k: string, chat: string): void {
    if (this.chats[k] === chat) return;
    this.chats[k] = chat;
    writeAtomic(this.file, JSON.stringify(this.chats, null, 2));
  }

  /** The chat of a person+section (remembered, else found by title), and the project to create it in. */
  locate(p: Person, s: SectionId): Promise<{ project: string | null; chat: string | null }> {
    return this.locateKey(this.key(p, s), aiTitle(p, s));
  }

  private async locateKey(k: string, title: string): Promise<{ project: string | null; chat: string | null }> {
    const r = await this.call("GET", "v1/state");
    const body = (r.body ?? {}) as { projects?: StateProject[]; chats?: StateChat[] };
    const state = { projects: body.projects ?? [], chats: body.chats ?? [] };
    const known = this.chats[k];
    if (known && state.chats.some((c) => String(c.id) === known)) return { project: findAiChat(state, title).project, chat: known };
    const f = findAiChat(state, title);
    if (f.chat) this.remember(k, f.chat);
    return f;
  }

  chatOf(p: Person, s: SectionId): string | null {
    return this.chats[this.key(p, s)] ?? null;
  }

  /** Every AI chat remembered for a person, by section (Link keeps a linked person's chats under their own id). */
  chatsOf(p: Person): { section: SectionId; chat: string }[] {
    const out: { section: SectionId; chat: string }[] = [];
    for (const [k, chat] of Object.entries(this.chats)) {
      const i = k.lastIndexOf(":");
      if (k.slice(0, i) === p.id) out.push({ section: k.slice(i + 1) as SectionId, chat });
    }
    return out;
  }

  /** Move to…: the AI chat of `from` carries on as the chat of `to` (its title keeps the old section's name). Kept as
   *  is when `to` already has one. */
  move(p: Person, from: SectionId, to: SectionId): void {
    const chat = this.chats[this.key(p, from)];
    if (!chat || from === to || this.chats[this.key(p, to)]) return;
    this.chats[this.key(p, to)] = chat;
    delete this.chats[this.key(p, from)];
    writeAtomic(this.file, JSON.stringify(this.chats, null, 2));
  }

  async items(p: Person, s: SectionId): Promise<{ id: string; role: "user" | "assistant"; text: string; at: string }[]> {
    const chat = this.chats[this.key(p, s)] ?? (await this.locate(p, s)).chat;
    if (!chat) return [];
    const r = await this.call("GET", `v1/chats/${encodeURIComponent(chat)}/items`, { since: "0" });
    if (r.status !== 200) return [];
    const b = (r.body ?? {}) as { items?: Card[]; running?: boolean; queued?: number };
    return cardsToAi(b.items ?? [], !!b.running || (b.queued ?? 0) > 0);
  }

  /** `extra`: more hidden context after the person's (a site request's, srpane.ts srAiContext). */
  ask(p: Person, s: SectionId, text: string, conversation: Message[], kind: ChannelKind | null, data: AppData, transcriptOf?: (m: Message, index: number) => string | null | undefined, extra?: string): Promise<string> {
    const channel = kind === "gmail" ? "Gmail" : kind === "whatsapp" ? "WhatsApp" : "Discord";
    const context = aiContext({ person: p, section: s, data, channel, messages: conversation, ...(transcriptOf ? { transcriptOf } : {}) });
    return this.send(this.key(p, s), aiTitle(p, s), withAiContext(text, extra ? `${context}\n\n${extra}` : context));
  }

  /**
   * A note about something that isn't a person of Persons (a site request whose store nobody here is linked to): its
   * own chat, remembered under `key`, titled `title` ("<Store> · SpokPay"), in the same project.
   */
  askAbout(key: string, title: string, text: string, context: string): Promise<string> {
    return this.send(key, title, withAiContext(text, context));
  }

  chatOfKey(key: string): string | null {
    return this.chats[key] ?? null;
  }

  /** Hub's `/v1/state` body (its projects and chats): Forward to Projects' picker. */
  async hubState(): Promise<unknown> {
    const r = await this.call("GET", "v1/state");
    if (r.status >= 400) throw new Error(String((r.body as { error?: string } | null)?.error ?? `Hub answered ${r.status}`));
    return r.body;
  }

  /** Forward to Projects: a new chat in `project`, titled `title`, whose first message is `text`. Answers its id. */
  async startIn(project: string, title: string, text: string): Promise<string> {
    const r = await this.call("POST", "v1/chats", {}, { text, project_id: /^\d+$/.test(project) ? Number(project) : project, title });
    const id = (r.body as { id?: string | number | null } | null)?.id;
    if (r.status >= 400 || id == null) throw new Error(String((r.body as { error?: string } | null)?.error ?? "Hub didn't start the chat"));
    return String(id);
  }

  private async send(k: string, title: string, full: string): Promise<string> {
    const { project, chat } = await this.locateKey(k, title);
    if (chat) {
      const r = await this.call("POST", `v1/chats/${encodeURIComponent(chat)}/send`, {}, { text: full, mode: "queue", client_id: crypto.randomUUID() });
      if (r.status >= 400) throw new Error(String((r.body as { error?: string } | null)?.error ?? `Hub answered ${r.status}`));
      return chat;
    }
    if (!project) throw new Error("No project for Person AI: add the folder creators-hub/tabs/Persons as a project in Projects");
    const r = await this.call("POST", "v1/chats", {}, { text: full, project_id: /^\d+$/.test(project) ? Number(project) : project, title });
    const id = (r.body as { id?: string | number | null } | null)?.id;
    if (r.status >= 400 || id == null) throw new Error(String((r.body as { error?: string } | null)?.error ?? "Hub didn't start the chat"));
    this.remember(k, String(id));
    return String(id);
  }
}
