// "Open Site Request" on a message (Person Hub's views/spokpay/data.ts proposeFromMessage, Headquarters' model): SpokPay's
// agent (a Hub chat in the SpokPay project) proposes a site request from the message and the conversation; the proposal
// lands in the person's chat as a card that waits for the user's "Open site request", the only write that reaches
// SpokPay. Without a SpokPay project (or when the agent fails) the message itself becomes the proposal.
import { readFileSync } from "node:fs";
import { personLabel } from "./model/data.ts";
import type { AppData, Message, Person } from "./model/types.ts";
import type { ImageBytes, Proposal, ProposalFields } from "./spokpay-core.ts";
import { chatImages, discordUsernames, draftPrompt, knownStores, localDraft, offersSiteRequests, parseDraft, pickSpokpayProject, pickStore, resolveStore, spError } from "./spokpay-view.ts";
import type { Spokpay } from "./spokpay.ts";

type HubCall = (method: string, path: string, query?: Record<string, string>, body?: unknown) => Promise<{ status: number; body: unknown }>;

/** A proposal the agent is still drafting (shown in the chat as "drafting…", or its error with "Use the message"). */
export interface Proposing {
  personId: string;
  messageId: string;
  at: number;
  chat: string | null;
  error: string | null;
}

interface Card {
  kind: string;
  text?: string;
  markdown?: string;
}

const POLL_MS = 4000;
const GIVE_UP_MS = 15 * 60_000;
const stamp = (iso: string): string => String(iso ?? "").slice(0, 16).replace("T", " ");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SiteRequests {
  private busy = new Map<string, Proposing>();

  constructor(
    readonly sp: Spokpay,
    private readonly call: HubCall,
    private readonly touch: () => void,
    /** A chat attachment as a file on this PC (the service's fetchAttachment). */
    private readonly fetchFile: (url: string, name: string, account?: string) => Promise<string | null>,
  ) {}

  /** Live proposals of a person (discarded ones gone). */
  proposals(personId: string): Proposal[] {
    return this.sp.proposals().filter((p) => p.personId === personId && p.state.kind !== "discarded");
  }

  proposing(personId: string): Proposing[] {
    return [...this.busy.values()].filter((p) => p.personId === personId);
  }

  offered(p: Person, data: Pick<AppData, "stores">): boolean {
    return offersSiteRequests({ connected: this.sp.status().connected, person: p, data, proposals: this.proposals(p.id).length });
  }

  /** The SpokPay store the person is (remembered, their Persons store's, SpokPay's CRM by their Discord handle). */
  private async storeOf(p: Person, data: AppData): Promise<{ fallback: { slug: string; name: string } | null; stores: { slug: string; name: string }[] }> {
    const crm = this.sp.status().permissions["crm:read"] === false ? [] : await this.sp.ownerStores(discordUsernames(p)).catch(() => []);
    const r = resolveStore(p, data, this.sp.links(), crm);
    const stores = crm.filter((s) => s.state !== "deleted").map((s) => ({ slug: s.slug, name: s.name }));
    const fallback = r.slug ? { slug: r.slug, name: r.name || r.slug } : stores.length === 1 ? stores[0]! : null;
    return { fallback, stores };
  }

  /** Starts a proposal from a message; it shows as "drafting…" until the agent answers. */
  fromMessage(o: { person: Person; message: Message; recent: Message[]; account: string; handle: string; data: AppData }): void {
    const { person: p, message: m } = o;
    if (this.busy.has(m.id)) return;
    const item: Proposing = { personId: p.id, messageId: m.id, at: Date.now(), chat: null, error: null };
    this.busy.set(m.id, item);
    this.touch();
    const label = personLabel(p);
    const images = chatImages(m, o.recent);
    const source = { messageId: m.id, account: o.account };
    const fail = (e: unknown): void => {
      item.error = e instanceof Error ? e.message : String(e);
      this.touch();
    };
    void (async () => {
      const { fallback, stores: crm } = await this.storeOf(p, o.data);
      const stores = knownStores(crm, fallback);
      const propose = (fields: ProposalFields, why: string, from: { name: string; chat?: string | null }, store: { slug: string; name: string } | null): void => {
        this.sp.propose({ personId: p.id, store, fields, why, from, images, source });
        this.busy.delete(m.id);
        this.touch();
      };
      const s = await this.call("GET", "v1/state");
      const body = (s.body ?? {}) as { projects?: { id: string | number; name: string; path?: string; here?: boolean }[] };
      const project = pickSpokpayProject((body.projects ?? []).map((x) => ({ ...x, id: String(x.id) })));
      if (!project) return propose(localDraft(m), "From the message: no Hub project for the SpokPay repo.", { name: "You" }, fallback);
      const fromOf = (x: Message): string => (x.fromMe ? "SpokPay (Fagner)" : label);
      const text = draftPrompt({
        person: label,
        handle: o.handle,
        stores,
        message: { from: fromOf(m), text: m.content || "(no text)", at: stamp(m.timestamp), images: images.filter((i) => i.picked).map((i) => i.name) },
        recent: o.recent
          .filter((x) => x.id !== m.id)
          .slice(-20)
          .map((x) => ({ from: fromOf(x), text: x.content || (x.attachments?.length ? `(${x.attachments.length} attachment(s))` : ""), at: stamp(x.timestamp) })),
      });
      // the project's id as the state gave it: a number here (a string is read as the project's folder: "no such project")
      const r = await this.call("POST", "v1/chats", {}, { text, project_id: /^\d+$/.test(project.id) ? Number(project.id) : project.id, title: `Site request · ${label}` });
      const chat = (r.body as { id?: string | number | null } | null)?.id;
      if (r.status >= 400 || chat == null) throw new Error(String((r.body as { error?: string } | null)?.error ?? "Hub didn't start the SpokPay agent"));
      item.chat = String(chat);
      this.touch();
      const reply = await this.answer(item.chat);
      if (!this.busy.has(m.id)) return; // dismissed meanwhile
      const d = parseDraft(reply);
      if (!d) throw new Error("The agent answered without a proposal.");
      const store = pickStore(d.store, stores, fallback);
      propose(d.fields, d.why, { name: "SpokPay agent", chat: item.chat }, store);
    })().catch((e) => fail(new Error(spError(e).message || String(e))));
  }

  /** The agent's whole answer once its turn is over. */
  private async answer(chat: string): Promise<string> {
    const until = Date.now() + GIVE_UP_MS;
    while (Date.now() < until) {
      await sleep(POLL_MS);
      const r = await this.call("GET", `v1/chats/${encodeURIComponent(chat)}/items`, { since: "0" }).catch(() => null);
      if (!r || r.status !== 200) continue;
      const b = (r.body ?? {}) as { items?: Card[]; running?: boolean; queued?: number };
      if (b.running || (b.queued ?? 0) > 0) continue;
      const items = b.items ?? [];
      const first = items.findIndex((c) => c.kind === "user");
      const texts = items.slice(first + 1).filter((c) => c.kind === "text").map((c) => c.markdown ?? c.text ?? "");
      if (texts.length) return texts.join("\n\n");
    }
    throw new Error("The agent took too long.");
  }

  /** The agent failed (or was skipped): the message itself becomes the proposal. */
  async local(messageId: string, o: { person: Person; message: Message | undefined; recent: Message[]; data: AppData }): Promise<void> {
    const item = this.busy.get(messageId);
    this.busy.delete(messageId);
    const m = o.message;
    if (m) {
      const { fallback } = await this.storeOf(o.person, o.data).catch(() => ({ fallback: null }));
      this.sp.propose({ personId: o.person.id, store: fallback, fields: localDraft(m), why: `From the message (${item?.error ?? "agent skipped"}).`, from: { name: "You" }, images: chatImages(m, o.recent), source: { messageId: m.id, account: "" } });
    }
    this.touch();
  }

  dismiss(messageId: string): void {
    this.busy.delete(messageId);
    this.touch();
  }

  /** Open: the picked images fetched from the chat, then SpokPay's API. */
  async open(id: string, fields?: ProposalFields): Promise<Proposal | undefined> {
    const p = this.sp.proposals().find((x) => x.id === id);
    if (!p) throw new Error("This proposal is gone");
    const images: ImageBytes[] = [];
    for (const im of p.images.filter((i) => i.picked).slice(0, 5)) {
      const f = await this.fetchFile(im.url, im.name, p.source?.account || undefined);
      if (!f) throw new Error(`Couldn't get ${im.name} from the chat: unpick it and try again`);
      const data = new Uint8Array(readFileSync(f));
      if (data.byteLength > 10 << 20) throw new Error(`${im.name} is over 10 MB`);
      images.push({ name: im.name, type: im.type.startsWith("image/") ? im.type : "image/png", data });
    }
    const out = await this.sp.openProposal(id, fields, images);
    this.touch();
    return out;
  }
}
