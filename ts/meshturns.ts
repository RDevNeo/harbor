import type { agent, SentBy } from "./packages/agents/src/index.ts";
import { workspace } from "./packages/mcp/src/index.ts";
import { adoptCtx, ctxAfterTurn, type CtxEnv, type Dest, type Guest, guestOf, guestTurn, loadGuests, type Pc, peopleNote } from "./packages/net/src/index.ts";
import type { Chat, Store } from "./packages/store/src/index.ts";

export interface MeshTurnsHost {
  store: Store;
  env: Pick<CtxEnv, "dataDir">;
  /** meshctx's `meshPcs`: this PC first. */
  pcs(): Pc[];
  hostGithub(): string;
  chat(id: number): Chat | undefined;
  projectName(c: Chat): string;
  cwd(c: Chat): string | null;
  peer(id: string): { online: boolean; dest: Dest } | null;
  notice(id: number, text: string): void;
}

export const GUEST_NOTICE =
  "A chat driven from another PC uses that PC's person's CLAUDE.md, memory and language here; memory it saves goes back there. A message written on this PC or its phones makes it this PC's again.";

/** meshctx.rs on the app: whose context each turn runs with, and the `machines` grant while the mesh has other PCs. */
export class MeshTurns {
  readonly guests: Map<number, Guest>;

  constructor(private readonly h: MeshTurnsHost) {
    this.guests = loadGuests(h.store);
  }

  context(chat: Chat, remote: boolean): agent.Context {
    const pcs = this.h.pcs();
    const c: agent.Context = { overlay: null, signedIn: false, note: peopleNote(pcs), machines: null };
    const guest = guestOf(this.guests, chat);
    if (pcs.length > 1) {
      c.machines = {
        chat: chat.gid,
        project: this.h.projectName(chat),
        tools: workspace.forAccess(chat.access, chat.role === "lead"),
        commander: guest?.peer ?? "",
        memory_id: guest?.memory_id ?? "",
      };
    }
    if (guest) Object.assign(c, guestTurn({ env: this.h.env, guest, me: pcs[0]?.name ?? "", hostGithub: this.h.hostGithub(), remote, note: c.note }));
    return c;
  }

  adopt(chatId: number, from: SentBy | null): void {
    const chat = this.h.chat(chatId);
    if (!chat) return;
    const said = adoptCtx({ kv: this.h.store, env: this.h.env, guests: this.guests, chatId, cwd: this.h.cwd(chat), call: from, me: this.h.pcs()[0]?.name ?? "" });
    if (said !== null) this.h.notice(chatId, said);
  }

  async afterTurn(chatId: number): Promise<void> {
    const chat = this.h.chat(chatId);
    const cwd = chat ? this.h.cwd(chat) : null;
    if (!chat || cwd === null) return;
    await ctxAfterTurn({ env: this.h.env, guest: guestOf(this.guests, chat), device: chat.device, peer: (id) => this.h.peer(id), cwd });
  }
}
