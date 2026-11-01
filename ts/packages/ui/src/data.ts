// The pages read through here, never the database: the Engine of @harbor/agents keeps chats and turns.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { type Account, Engine, providers } from "@harbor/agents";
import type { Chat, Item, Repo, Store, Timer } from "@harbor/store";
import { prompt as mentionsPrompt } from "./logic/mentions.ts";
import { expands, personalDir, slashPrompt } from "./logic/slash.ts";
import { tagsPrompt } from "./logic/tags.ts";
import { imagesPrompt } from "./logic/usertext.ts";

export class Data {
  readonly store: Store;
  readonly engine: Engine;
  accounts: Account[];
  /** Something about a chat changed (null: several): the window redraws. */
  onChange: (chatId: number | null) => void = () => {};
  /** The chat is on screen with the window focused. */
  visible: (chatId: number) => boolean = () => false;

  constructor(store: Store) {
    this.store = store;
    this.accounts = providers.discover();
    this.engine = new Engine({
      store,
      accounts: () => this.accounts,
      changed: (id) => this.onChange(id),
      visible: (id) => this.visible(id),
      slashPrompt: (id, text, files) => this.slashPrompt(id, text, files),
      mentionsPrompt: (ms) => mentionsPrompt(ms.map((m) => ({ ...m, kind: m.kind === "chat" ? "chat" : "" }))),
    });
  }

  get chats(): Chat[] {
    return this.engine.chats;
  }

  get repos(): Repo[] {
    return this.engine.repos;
  }

  get timers(): Timer[] {
    return this.engine.timers;
  }

  reload(): void {
    this.accounts = providers.discover();
    this.engine.reload();
  }

  chat(id: number): Chat | undefined {
    return this.engine.chat(id);
  }

  repo(id: number): Repo | undefined {
    return this.engine.repo(id);
  }

  items(id: number): Item[] {
    return this.engine.transcript(id).items;
  }

  mainChats(): Map<number, number> {
    return this.store.mainChats();
  }

  /** A project's main chat while it still is one: an unsettled lead of it. */
  mainChat(repo: number): number | null {
    return this.engine.mainChat(repo);
  }

  cwd(c: Chat): string {
    return this.engine.chatCwd(c);
  }

  /** Slash commands expanded for agents that don't expand them, plus the `@file` and `#issue` tags and images (slash.rs `slash_prompt`). */
  private slashPrompt(id: number, text: string, files: readonly string[]): string {
    const chat = this.chat(id);
    if (!chat) return text;
    const cwd = this.cwd(chat);
    const tags = tagsPrompt(text, cwd, null, null) + imagesPrompt(text, [...files]);
    const acc = this.accounts.find((a) => a.id === chat.account);
    const kind = acc ? acc.kind.toLowerCase() : null;
    const personal = personalDir(acc ? { kind: acc.kind.toLowerCase(), configDir: acc.configDir } : null, homedir());
    return slashPrompt(text, tags, expands(kind, chat.device), cwd, personal);
  }

  /** Snoozed chats ("c<id>") and projects ("r<id>") with when they wake (kv `snoozed`). */
  snoozed(): Map<string, number> {
    const raw = this.store.get("snoozed");
    const out = new Map<string, number>();
    if (raw === null) return out;
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === "object" && v !== null) {
        for (const [k, t] of Object.entries(v)) if (typeof t === "number") out.set(k, t);
      }
    } catch {
      // An unreadable value snoozes nothing, as in the Rust app.
    }
    return out;
  }

  setSnooze(key: string, until: number | null, after: () => void): void {
    const all = this.snoozed();
    if (until === null) all.delete(key);
    else all.set(key, until);
    this.store.set("snoozed", JSON.stringify(Object.fromEntries(all)));
    after();
  }

  saveChat(c: Chat): void {
    this.store.saveChat(c);
    this.onChange(c.id);
  }

  deleteChat(id: number): void {
    this.engine.stop(id);
    this.store.deleteChat(id);
    this.engine.transcripts.delete(id);
    this.engine.reload();
  }

  removeRepo(id: number): void {
    this.store.removeRepo(id);
    this.engine.reload();
  }

  addRepo(path: string): number | null {
    if (!existsSync(path) || !statSync(path).isDirectory()) return null;
    const known = this.repos.find((r) => r.path === path);
    if (known) return known.id;
    const id = this.store.addRepo(path);
    this.engine.reload();
    return this.repo(id) ? id : null;
  }
}
