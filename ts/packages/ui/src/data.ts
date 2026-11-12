// The pages read through here, never the database: the Engine of @harbor/agents keeps chats and turns.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { type Account, Engine, type EngineHost, providers } from "@harbor/agents";
import { media } from "@harbor/media";
import { Desktop, loadPrefs, Notes, Notifier, spawnNotifySend } from "@harbor/net";
import type { dictate } from "@harbor/media";
import { repoDir, sidebartree, type Chat, type Item, type Mention as StoreMention, type Repo, type Store, type Timer } from "@harbor/store";
import { type Mention, prompt as mentionsPrompt } from "./logic/mentions.ts";
import { expands, personalDir, slashPrompt } from "./logic/slash.ts";
import { tagsPrompt } from "./logic/tags.ts";
import { imagesPrompt } from "./logic/usertext.ts";

/** How long the chat list trusts what it saw of a project's folder (`Data.folderHere`). */
const FOLDER_MS = 30_000;

export class Data {
  readonly store: Store;
  readonly engine: Engine;
  /** The window's own accounts, when no hub shares its list. */
  private own: readonly Account[] = [];
  private readonly shared: (() => readonly Account[]) | undefined;
  private readonly rediscover: () => void;
  /** Something about a chat changed (null: several): the window redraws. */
  onChange: (chatId: number | null) => void = () => {};
  /** The chat is on screen with the window focused. */
  visible: (chatId: number) => boolean = () => false;
  /** A notification was clicked: open these chats (global ids). */
  onNotificationOpen: (gids: string[]) => void = () => {};
  /** An undone send (or a queued message being edited) goes back into the chat's composer. */
  onRestoreDraft: (chatId: number, text: string, files: string[], mentions: Mention[]) => void = () => {};
  readonly notifier: Notifier;

  /** `hub`: the hooks of the hub this window belongs to, and its notes (what phones are told). */
  /** Other PCs that transcribe dictation (none without the hub). */
  readonly voiceMesh: dictate.Mesh;

  constructor(store: Store, hub: Partial<EngineHost> = {}, notes = new Notes(), voiceMesh: dictate.Mesh = alone) {
    this.store = store;
    this.voiceMesh = voiceMesh;
    this.shared = hub.accounts;
    this.rediscover = hub.rediscover ?? (() => (this.own = providers.discover()));
    if (!this.shared) this.own = providers.discover();
    const desktop = new Desktop({ send: spawnNotifySend, prefs: loadPrefs(store), onOpen: () => this.onNotificationOpen(desktop.takeOpen()) });
    this.notifier = new Notifier({ notes, desktop });
    this.engine = new Engine({
      ...hub,
      store,
      accounts: () => this.accounts,
      rediscover: () => this.rediscover(),
      changed: (id) => {
        this.onChange(id);
        hub.changed?.(id);
      },
      visible: (id) => this.visible(id),
      slashPrompt: (id, text, files) => this.slashPrompt(id, text, files),
      noteTurn: (id, sub, failed, said) => {
        const c = this.chat(id);
        if (!c || this.visible(id)) return;
        const project = c.repoId === null ? null : (this.repo(c.repoId)?.name ?? null);
        this.notifier.noteTurn({ gid: c.gid, title: c.title, name: c.name, home: c.home, project }, sub, failed, said);
      },
      mentionsPrompt: (ms) => mentionsPrompt(ms.map(mentionOf)),
      restoreDraft: (id, text, files, ms) => this.onRestoreDraft(id, text, files, ms.map(mentionOf)),
      noteLimit: (id, account, waits, note) => this.notifier.noteLimit(this.chat(id) ?? null, account, this.engine.accountLabel(account), waits, note),
      noteResumed: (id, account, text) => this.notifier.noteResumed(this.chat(id) ?? null, account, this.engine.accountLabel(account), text, this.engine.limits.limitSettings().notify),
      notify: (kind, key, title, body, chat) => this.notifier.post(kind, key, title, body, chat ?? "", false),
      keepMedia: (text, cwd) => media.keep(text, cwd),
      adoptMedia: (text, cwd, chat) => media.adopt(text, cwd, chat),
    });
  }

  get offline(): boolean {
    return this.engine.host.offline === true;
  }

  /** Whether chats homed on another PC show (account.ts `pcScope`: one of the PCs this account uses); null: all do. */
  scope: ((home: string) => boolean) | null = null;

  private scoped(): { chats: Chat[]; repos: Repo[] } {
    const has = this.scope;
    if (has === null) return { chats: this.engine.chats, repos: this.engine.repos };
    return sidebartree.inScope(this.engine.chats, this.engine.repos, has, (r) => this.folderHere(repoDir(r)));
  }

  /**
   * Whether a project's folder is on this PC, known for 30 s: the chat list asks on every read, and another PC's
   * project has that PC's path (/home/… on macOS is the automounter: each look took 6 ms, a busy loop of them).
   */
  private folders = new Map<string, { here: boolean; at: number }>();
  private folderHere(path: string): boolean {
    const t = Date.now();
    const known = this.folders.get(path);
    if (known !== undefined && t - known.at < FOLDER_MS) return known.here;
    const here = existsSync(path);
    this.folders.set(path, { here, at: t });
    return here;
  }

  /** The chats the pages show: this PC's own and copies from the PCs this account uses. */
  get chats(): Chat[] {
    return this.scope === null ? this.engine.chats : this.scoped().chats;
  }

  get repos(): Repo[] {
    return this.scope === null ? this.engine.repos : this.scoped().repos;
  }

  get timers(): Timer[] {
    return this.engine.timers;
  }

  /** This PC's accounts: the hub's list when there is a hub, so the window never keeps a profile that was removed. */
  get accounts(): readonly Account[] {
    return this.shared ? this.shared() : this.own;
  }

  /** Reads this PC's accounts again (one was turned off or removed in Settings › Providers). */
  rediscoverAccounts(): void {
    this.rediscover();
  }

  reload(): void {
    this.rediscover();
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
}

export function mentionOf(m: StoreMention): Mention {
  return { ...m, kind: m.kind === "chat" ? "chat" : "" };
}

const alone: dictate.Mesh = { on: () => false, me: () => ({ name: "" }), peers: () => [], http: async () => [0, null] };
