// "Open Site Request" on a message (Person Hub's views/spokpay/data.ts proposeFromMessage, Headquarters' model): SpokPay's
// agent (a Hub chat in the SpokPay project) proposes a site request from the message and the conversation; the proposal
// lands in the person's chat as a card that waits for the user's "Open site request", the only write that reaches
// SpokPay. Without a SpokPay project (or when the agent fails) the message itself becomes the proposal.
import { readFileSync } from "node:fs";
import { personLabel } from "./model/data.ts";
import type { AppData, Message, Person } from "./model/types.ts";
import type { ImageBytes, Proposal, ProposalFields } from "./spokpay-core.ts";
import { chatImages, discordUsernames, draftPrompt, knownStores, localDraft, offersSiteRequests, parseDraft, pickSpokpayProject, pickStore, resolveStore, spError, takeOver, turnReply } from "./spokpay-view.ts";
import type { Spokpay } from "./spokpay.ts";

type HubCall = (method: string, path: string, query?: Record<string, string>, body?: unknown) => Promise<{ status: number; body: unknown }>;

/** A proposal the agent is still drafting (shown in the chat as "drafting…" with Cancel, or its error with "Use the message"). */
export interface Proposing {
  personId: string;
  messageId: string;
  at: number;
  chat: string | null;
  error: string | null;
  /**
   * "Use the message" was pressed while the agent still drafted (an older phone app offers it then): the message's own
   * proposal, which the agent's draft replaces when it arrives if that one still waits unedited. The card is gone.
   */
  local?: { proposalId: string; store: { slug: string; name: string } | null };
}

interface Card {
  kind: string;
  text?: string;
  markdown?: string;
}

const POLL_MS = 4000;
export interface SiteRequestsOptions {
  log?: (...a: unknown[]) => void;
  /** How often the agent's chat is read (tests make it short). */
  pollMs?: number;
}
const GIVE_UP_MS = 15 * 60_000;
const stamp = (iso: string): string => String(iso ?? "").slice(0, 16).replace("T", " ");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SiteRequests {
  private busy = new Map<string, Proposing>();
  private readonly log: (...a: unknown[]) => void;
  private readonly pollMs: number;

  constructor(
    readonly sp: Spokpay,
    private readonly call: HubCall,
    private readonly touch: () => void,
    /** A chat attachment as a file on this PC (the service's fetchAttachment). */
    private readonly fetchFile: (url: string, name: string, account?: string) => Promise<string | null>,
    o: SiteRequestsOptions = {},
  ) {
    this.log = o.log ?? (() => {});
    this.pollMs = o.pollMs ?? POLL_MS;
  }

  /** Live proposals of a person (discarded ones gone). */
  proposals(personId: string): Proposal[] {
    return this.sp.proposals().filter((p) => p.personId === personId && p.state.kind !== "discarded");
  }

  /** The drafting cards of a person (a run whose card became the message's proposal has none). */
  proposing(personId: string): Proposing[] {
    return [...this.busy.values()].filter((p) => p.personId === personId && !p.local).map(({ local: _, ...p }) => p);
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
      const why = e instanceof Error ? e.message : String(e);
      if (this.busy.get(m.id) !== item) return this.log("spokpay: site request draft dropped (card closed):", why);
      if (item.local) {
        // its card is the message's proposal already: nothing left to show
        this.busy.delete(m.id);
        this.log("spokpay: site request draft failed after Use the message:", why);
        return this.touch();
      }
      item.error = why;
      this.log("spokpay: site request draft failed:", why);
      this.touch();
    };
    void (async () => {
      const { fallback, stores: crm } = await this.storeOf(p, o.data);
      const stores = knownStores(crm, fallback);
      const propose = (fields: ProposalFields, why: string, from: { name: string; chat?: string | null }, store: { slug: string; name: string } | null): void => {
        if (this.busy.get(m.id) !== item) return; // cancelled meanwhile
        if (!item.local) this.sp.propose({ personId: p.id, store, fields, why, from, images, source }); // else the message's is there
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
      const reply = await this.answer(item.chat, () => this.busy.get(m.id) === item);
      if (this.busy.get(m.id) !== item) return this.log("spokpay: site request draft dropped: its card was cancelled", `(chat ${item.chat})`);
      const d = parseDraft(reply);
      if (!d) throw new Error("The agent answered without a proposal.");
      const store = pickStore(d.store, stores, fallback);
      if (item.local) return this.adopt(m.id, item, d.fields, d.why, { name: "SpokPay agent", chat: item.chat }, store);
      propose(d.fields, d.why, { name: "SpokPay agent", chat: item.chat }, store);
    })().catch((e) => fail(new Error(spError(e).message || String(e))));
  }

  /** The agent's whole answer once its turn is over (its error when the turn ended in one). */
  private async answer(chat: string, wanted: () => boolean): Promise<string> {
    const until = Date.now() + GIVE_UP_MS;
    while (Date.now() < until) {
      await sleep(this.pollMs);
      if (!wanted()) return ""; // its card was cancelled: the caller drops it
      const r = await this.call("GET", `v1/chats/${encodeURIComponent(chat)}/items`, { since: "0" }).catch(() => null);
      if (!r || r.status !== 200) continue;
      const t = turnReply((r.body ?? {}) as { items?: Card[]; running?: boolean; queued?: number });
      if (!t.done) continue;
      if ("error" in t) throw new Error(`The agent stopped: ${t.error}`);
      return t.text;
    }
    throw new Error("The agent took too long.");
  }

  /** The agent's draft for a message whose card became the message's own proposal meanwhile: it takes that one's place. */
  private adopt(messageId: string, item: Proposing, fields: ProposalFields, why: string, from: { name: string; chat: string | null }, store: { slug: string; name: string } | null): void {
    this.busy.delete(messageId);
    const local = item.local!;
    const p = this.sp.proposals().find((x) => x.id === local.proposalId);
    const how = takeOver(p);
    if (how === "replace") {
      // the store too, unless the user picked another; their picked images stay
      const keepStore = (p?.store?.slug ?? null) !== (local.store?.slug ?? null);
      this.sp.saveProposal(local.proposalId, { fields, agent: true, why, from, ...(keepStore ? {} : { store }) });
      this.log("spokpay: the agent's site request draft replaced the message's proposal", `(chat ${from.chat})`);
    } else this.log(`spokpay: the agent's site request draft kept aside: the message's proposal was ${how}`, `(chat ${from.chat})`);
    this.touch();
  }

  /** The agent failed (or was skipped): the message itself becomes the proposal. */
  async local(messageId: string, o: { person: Person; message: Message | undefined; recent: Message[]; data: AppData }): Promise<void> {
    const before = this.busy.get(messageId);
    const m = o.message;
    if (!m) {
      // nothing to propose from: keep the card (the agent's draft still comes, or its error with Dismiss)
      this.log("spokpay: Use the message: the message isn't in the chat any more");
      throw new Error("That message isn't in the chat any more");
    }
    const { fallback } = await this.storeOf(o.person, o.data).catch(() => ({ fallback: null }));
    const item = this.busy.get(messageId);
    if (before && (!item || item.local)) {
      // the agent's draft landed (or the card was cancelled, or pressed twice) while this looked for the store
      this.log("spokpay: Use the message: the card was already gone");
      return this.touch();
    }
    // still drafting (an older phone app offers this then): the agent keeps going and its draft replaces this one
    const drafting = !!item && !item.error;
    if (!drafting) this.busy.delete(messageId);
    const p = this.sp.propose({ personId: o.person.id, store: fallback, fields: localDraft(m), why: drafting ? "From the message (the SpokPay agent is still drafting: its draft replaces this one if you don't edit it)." : `From the message (${item?.error ?? "agent skipped"}).`, from: { name: "You" }, images: chatImages(m, o.recent), source: { messageId: m.id, account: "" } });
    if (drafting) item!.local = { proposalId: p.id, store: fallback };
    this.touch();
  }

  dismiss(messageId: string): void {
    if (this.busy.delete(messageId)) this.log("spokpay: site request draft cancelled");
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
