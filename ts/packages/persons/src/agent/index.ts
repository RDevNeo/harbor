// Hub's agents on Discord: which Persons connection their tools use (the Stores one, Discord account #1, unless
// <persons>/agents.json says {"discord": "<connection id>"}), the tools on it, and what the Settings card and the
// phone's Discord sheet show about it. Routes: POST v1/persons/agent/discord {tool, args, chat} runs a tool (what
// `hub app discord` calls); GET answers the card's info; PUT {connection} picks another connection.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDiscordConnection, type DiscordLink } from "../conn/discord.ts";
import type { ConnView, PersonsService } from "../service.ts";
import { DiscordTools, SIGN_IN_HOW, type ToolAnswer } from "./discord.ts";

export { DiscordTools, SIGN_IN_HOW, type ToolAnswer } from "./discord.ts";

export interface AgentDiscordInfo {
  /** The connection the tools use; null: none in Persons yet. */
  connection: string | null;
  label: string | null;
  status: string;
  /** Who's signed in. */
  account: { id: string; name: string; username: string } | null;
  error: string | null;
  /** The QR sign-in's code while one is under way (Discord's remote-auth URL to draw). */
  qr: string | null;
}

export class AgentDiscord {
  readonly tools: DiscordTools;
  private readonly settingsFile: string;

  constructor(private readonly s: PersonsService) {
    this.settingsFile = join(s.dir, "agents.json");
    const paceDir = join(s.dir, "discord");
    try {
      mkdirSync(paceDir, { recursive: true, mode: 0o700 });
    } catch {
      // read-only data (a rig): pacing then forgets on restart
    }
    this.tools = new DiscordTools({
      link: () => this.link(),
      about: () => {
        const v = this.view();
        return v ? { label: v.label, status: v.state.status, error: v.state.error ?? null } : null;
      },
      paceFile: join(paceDir, "agent-pace.json"),
    });
  }

  /** The raw side of the connection agents use (Collector's read-only calls go through it too); null: none. */
  link(): DiscordLink | null {
    const v = this.view();
    const c = v ? this.s.conn(v.id) : undefined;
    return isDiscordConnection(c) ? c.link : null;
  }

  /** The connection picked in agents.json, if it's still there. */
  private picked(): string | null {
    try {
      const v = JSON.parse(readFileSync(this.settingsFile, "utf8")) as { discord?: unknown };
      return typeof v.discord === "string" && v.discord !== "" ? v.discord : null;
    } catch {
      return null;
    }
  }

  /** The Discord connection agents use: the one picked, else the Stores one, else the first. */
  view(): ConnView | undefined {
    const d = this.s.views().filter((c) => c.kind === "discord");
    const p = this.picked();
    return (p ? d.find((c) => c.id === p) : undefined) ?? d.find((c) => c.section === "stores") ?? d[0];
  }

  /** Picks the connection (null: back to the default). */
  pick(id: string | null): void {
    if (id !== null && !this.s.views().some((c) => c.kind === "discord" && c.id === id)) throw new Error("No Discord connection has that id");
    const tmp = `${this.settingsFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(id === null ? {} : { discord: id }), { mode: 0o600 });
    renameSync(tmp, this.settingsFile);
  }

  info(): AgentDiscordInfo {
    const v = this.view();
    if (!v) return { connection: null, label: null, status: "signed-out", account: null, error: null, qr: null };
    const me = v.state.me;
    return {
      connection: v.id,
      label: v.label,
      status: v.state.status,
      account: me && v.state.status === "connected" ? { id: me.id, name: me.globalName ?? me.username, username: me.username } : null,
      error: v.state.error ?? null,
      qr: v.state.status === "signing-in" ? (v.state.qr ?? null) : null,
    };
  }

  /** Starts the connection's QR sign-in (making the Stores Discord connection when there's none). */
  async signIn(): Promise<void> {
    const v = this.view();
    if (!v) await this.s.addConnection("stores", "discord");
    else this.s.connect(v.id);
  }

  async cancel(): Promise<void> {
    const v = this.view();
    if (v) await this.s.cancelSignIn(v.id);
  }

  /** Signs the connection out (Persons' chats on it too); it stays in Persons, to sign in again. */
  async signOut(): Promise<void> {
    const v = this.view();
    const c = v ? this.s.conn(v.id) : undefined;
    if (c) await c.disconnect();
  }

  /** One tool call, as the route answers it: `json` an object to print, or `text`; errors as `error`. */
  async run(tool: string, args: unknown, chat: number | null): Promise<ToolAnswer | { error: string }> {
    try {
      return await this.tools.call(tool, args, chat);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** The line for the Settings card and the phone: who's signed in, or how to sign in. Tone 1: under way, 2: trouble. */
export function cardLine(i: AgentDiscordInfo, about: string): { text: string; tone: 0 | 1 | 2 } {
  if (i.connection === null) return { text: about, tone: 0 };
  const where = i.label ? ` (Persons › ${i.label})` : "";
  switch (i.status) {
    case "connected":
      return { text: `Signed in as ${i.account?.name ?? "someone"}${where}`, tone: 0 };
    case "signing-in":
      return { text: "Scan the QR code with the Discord app: You › Scan QR code", tone: 1 };
    case "connecting":
    case "starting":
      return { text: `Connecting${where}…`, tone: 1 };
    default:
      return { text: i.error ? `Signed out: ${i.error}` : `Signed out${where}: sign in from Persons or here`, tone: 2 };
  }
}

export const SIGN_IN_TEXT = SIGN_IN_HOW;
