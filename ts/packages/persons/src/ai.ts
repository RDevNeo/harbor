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
};

/** The hidden context of a question (personAi.ts aiContext, unchanged wording). */
export function aiContext(o: { person: Person; section: SectionId; data: Pick<AppData, "stores" | "lists"> | null; channel: string; messages: readonly Message[]; me?: string }): string {
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
    const files = m.attachments?.length ? ` [${m.voice ? "voice message" : m.attachments.map((a) => a.name).join(", ")}]` : "";
    const subj = m.subject ? ` (subject: ${m.subject})` : "";
    return `[${m.timestamp.slice(0, 16).replace("T", " ")}] ${m.fromMe ? (o.me ? `Me (${o.me})` : "Me") : name}${subj}: ${m.content.replace(/\n+/g, " ⏎ ")}${files}`;
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
  }

  private key = (p: Person, s: SectionId): string => `${p.id}:${s}`;

  private remember(k: string, chat: string): void {
    if (this.chats[k] === chat) return;
    this.chats[k] = chat;
    writeAtomic(this.file, JSON.stringify(this.chats, null, 2));
  }

  /** The chat of a person+section (remembered, else found by title), and the project to create it in. */
  async locate(p: Person, s: SectionId): Promise<{ project: string | null; chat: string | null }> {
    const r = await this.call("GET", "v1/state");
    const body = (r.body ?? {}) as { projects?: StateProject[]; chats?: StateChat[] };
    const state = { projects: body.projects ?? [], chats: body.chats ?? [] };
    const k = this.key(p, s);
    const known = this.chats[k];
    if (known && state.chats.some((c) => String(c.id) === known)) return { project: findAiChat(state, aiTitle(p, s)).project, chat: known };
    const f = findAiChat(state, aiTitle(p, s));
    if (f.chat) this.remember(k, f.chat);
    return f;
  }

  async items(p: Person, s: SectionId): Promise<{ id: string; role: "user" | "assistant"; text: string; at: string }[]> {
    const chat = this.chats[this.key(p, s)] ?? (await this.locate(p, s)).chat;
    if (!chat) return [];
    const r = await this.call("GET", `v1/chats/${encodeURIComponent(chat)}/items`, { since: "0" });
    if (r.status !== 200) return [];
    const b = (r.body ?? {}) as { items?: Card[]; running?: boolean; queued?: number };
    return cardsToAi(b.items ?? [], !!b.running || (b.queued ?? 0) > 0);
  }

  async ask(p: Person, s: SectionId, text: string, conversation: Message[], kind: ChannelKind | null, data: AppData): Promise<string> {
    const channel = kind === "gmail" ? "Gmail" : kind === "whatsapp" ? "WhatsApp" : "Discord";
    const full = withAiContext(text, aiContext({ person: p, section: s, data, channel, messages: conversation }));
    const { project, chat } = await this.locate(p, s);
    if (chat) {
      const r = await this.call("POST", `v1/chats/${encodeURIComponent(chat)}/send`, {}, { text: full, mode: "queue", client_id: crypto.randomUUID() });
      if (r.status >= 400) throw new Error(String((r.body as { error?: string } | null)?.error ?? `Hub answered ${r.status}`));
      return chat;
    }
    if (!project) throw new Error("No project for Person AI: add the folder creators-hub/tabs/Persons as a project in Projects");
    const r = await this.call("POST", "v1/chats", {}, { text: full, project_id: project, title: aiTitle(p, s) });
    const id = (r.body as { id?: string | number | null } | null)?.id;
    if (r.status >= 400 || id == null) throw new Error(String((r.body as { error?: string } | null)?.error ?? "Hub didn't start the chat"));
    this.remember(this.key(p, s), String(id));
    return String(id);
  }
}
