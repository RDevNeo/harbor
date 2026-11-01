import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as slint from "slint-ui";
import { type Account, git, type Kind, providers } from "@harbor/agents";
import { type Chat, dataDir, type Item, now, parseAccess } from "@harbor/store";
import { newOpened, type Opened, toggle as toggleCard, transcriptCards } from "./cards.ts";
import { byteAt, charAt, ComposerMenus, type MenuContext, pressOf } from "./composer.ts";
import { add as addMention, chipHead, chipSnippet, chipTip, isChat, type Mention, mentionAgent, mentionOf } from "./logic/mentions.ts";
import { personalDir } from "./logic/slash.ts";
import { forkable } from "./logic/fork.ts";
import { isImage } from "./logic/images.ts";
import { Keys } from "./logic/keys.ts";
import { headerClick, shortElapsed as stripElapsed, stripView } from "./logic/agentstrip.ts";
import { localHm, until } from "./logic/team.ts";
import { agentCard, agentSettled, earlierChats, loadMarks, mark, saveMarks, teamAgents, webhookCard } from "./logic/teamui.ts";
import { control } from "@harbor/mcp";
import { Data } from "./data.ts";
import { ICONS, type IconName } from "./icons.ts";
import { ago, tilde } from "./logic/app.ts";
import { chatIdle, parseSnooze, type Status, ownStatus, projectIdle, projectInitial, sidebarList, sidebarOrder, snoozedLabel, snoozePresets, snoozePreview, tree } from "./logic/sidebar.ts";
import { defuse, imageCount, writeImage } from "./logic/usertext.ts";
import { kindOfAccount, type Pixels, providerLogo } from "./logos.ts";
import { MediaRows } from "./mediarows.ts";
import { emptyText, Favorites, type PickerState, pickerRows, railTip, type Row } from "./picker.ts";
import { runLoop } from "./loop.ts";
import { scripted } from "./script.ts";
import { type Mode, omarchyStamp, parseMode, resolveDark, token } from "./theme.ts";
import { type AgentRow, type AppWindow, blankStatus, noPixels, type HookRow, type ProcItem, type ModelRow, type RailItem, type StripRow, type WakeRow, type CardData, type ComposerState, type KeyEvent, loadWindow, type PopItem, type SideRow, type StatusData } from "./window.ts";

/** The draft's key in per-chat maps (app.rs `DRAFT`). */
const DRAFT = 0;

interface Sel {
  account: string;
  model: string;
  effort: string;
  access: string;
}

/** Keeps a model's rows equal to `next`, touching only the rows that changed. */
function sync<T>(model: slint.ArrayModel<T>, next: readonly T[], same: (a: T, b: T) => boolean = (a, b) => a === b): void {
  const n = Math.min(model.length, next.length);
  for (let i = 0; i < n; i++) {
    const v = next[i];
    const old = model.rowData(i);
    if (v !== undefined && (old === undefined || !same(old, v))) model.setRowData(i, v);
  }
  if (model.length > next.length) model.remove(next.length, model.length - next.length);
  else if (next.length > n) model.push(...next.slice(n));
}

const sameJson = <T>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameJsonRow = (a: AgentRow, b: AgentRow): boolean => a.logo === b.logo && JSON.stringify({ ...a, logo: 0 }) === JSON.stringify({ ...b, logo: 0 });
const sameSideRow = (a: SideRow, b: SideRow): boolean => a.avatar === b.avatar && JSON.stringify({ ...a, avatar: 0 }) === JSON.stringify({ ...b, avatar: 0 });

function glyph(name: IconName | null): string {
  return name === null ? "" : ICONS[name];
}

export class Shell {
  readonly win: AppWindow;
  readonly data: Data;
  private dark = true;
  private mode: Mode = "system";
  private stamp = 0;
  private view: "draft" | "chat" = "draft";
  private chatId = 0;
  private draftRepo: number | null = null;
  /** The draft is the project's page: its first message starts the project's main chat. */
  private draftMain = false;
  private sel: Sel;
  private opened = new Map<number, Opened>();
  private drafts = new Map<number, string>();
  private query = "";
  private rows = new slint.ArrayModel<SideRow>([]);
  private settledRows = new slint.ArrayModel<SideRow>([]);
  private cards = new slint.ArrayModel<CardData>([]);
  private files = new slint.ArrayModel<{ name: string; image: boolean }>([]);
  private menu = new slint.ArrayModel<{ icon: string; label: string; desc: string; section: string }>([]);
  private popItems = new slint.ArrayModel<PopItem>([]);
  private teamAgentRows = new slint.ArrayModel<AgentRow>([]);
  private teamSettledRows = new slint.ArrayModel<AgentRow>([]);
  private wakeRows = new slint.ArrayModel<WakeRow>([]);
  private hookRows = new slint.ArrayModel<HookRow>([]);
  private procRows = new slint.ArrayModel<ProcItem>([]);
  private procsOpen = new Set<number>();
  private earlierRows = new slint.ArrayModel<{ id: number; title: string; ago: string }>([]);
  private logos = new Map<string, Pixels>();
  private railItems = new slint.ArrayModel<RailItem>([]);
  private modelRows = new slint.ArrayModel<ModelRow>([]);
  private picker: PickerState = { rail: null, search: "", more: false, hover: 0 };
  private pickerRowsNow: Row[] = [];
  private favorites: Favorites;
  private keys: Keys;
  private stripRows = new slint.ArrayModel<StripRow>([]);
  private avatars = new Map<number, Pixels | null>();
  private mediaRows: MediaRows | null = null;
  private gitStatus = new Map<number, git.Status | null>();
  private gitRunning = new Set<number>();

  /** Images in the transcript, once the media package is loaded. */
  useMedia(pkg: typeof import("@harbor/media")): void {
    this.mediaRows = new MediaRows(pkg, () => this.changed(this.chatId));
  }
  private stripFold = new Map<number, boolean>();
  private popActions: (() => void)[] = [];
  private dialogAction: ((ok: boolean, input: string) => void) | null = null;
  private cardsDirty = false;
  private menus = new ComposerMenus();
  private mentions = new Map<number, Mention[]>();
  private attached = new Map<number, string[]>();
  private mentionChips = new slint.ArrayModel<{ head: string; snippet: string; tip: string }>([]);

  constructor(win: AppWindow, data: Data) {
    this.win = win;
    this.data = data;
    const get = (k: string, d: string) => data.store.get(k) ?? d;
    const model = get("default_model", "claude-opus-5-5");
    this.sel = {
      account: get("default_account", "claude"),
      model: model === "opus" || model === "" ? "claude-opus-5-5" : model === "sonnet" ? "claude-sonnet-5-5" : model === "haiku" ? "claude-haiku-5-5" : model,
      effort: get("default_effort", providers.defaultEffort("Claude")),
      access: get("default_access", "full"),
    };
    this.mode = parseMode(get("theme", ""));
    this.stamp = omarchyStamp(homedir());
    this.dark = resolveDark(this.mode, homedir());
    win.dark = this.dark;
    win.compact = data.store.get("density") === "compact";
    win.side_rows = this.rows;
    win.side_settled = this.settledRows;
    win.cards = this.cards;
    win.files = this.files;
    win.menu = this.menu;
    win.pop_items = this.popItems;
    win.picker_rail = this.railItems;
    win.strip_rows = this.stripRows;
    win.mentions = this.mentionChips;
    win.picker_rows = this.modelRows;
    this.favorites = new Favorites(data.store);
    this.keys = Keys.load(data.store);
    win.team_agents = this.teamAgentRows;
    win.team_settled = this.teamSettledRows;
    win.team_wakeups = this.wakeRows;
    win.team_hooks = this.hookRows;
    win.team_procs = this.procRows;
    win.team_earlier = this.earlierRows;
    win.team_on = data.store.get("show_team") !== "0";
    win.team_settled_open = data.store.get("agents_settled_open") === "1";
    this.wire();
  }


  private wire(): void {
    const w = this.win;
    w.open_chat = (id) => this.openChat(id);
    w.open_project = (id) => this.openProject(id);
    w.new_chat = (repo) => this.newDraft(repo);
    w.new_thread = () => this.newDraft(null);
    w.add_project = () => this.addProjectDialog();
    w.settle = (id, on) => this.setSettled(id, on);
    w.snooze = (key, x, y) => this.snoozeMenu(key, x, y);
    w.chat_menu = (id, x, y) => this.chatMenu(id, x, y);
    w.project_menu = (id, x, y) => this.projectMenu(id, x, y);
    w.searched = (q) => {
      this.query = q;
      this.refreshSidebar();
    };
    w.palette = () => this.unported("Search everything");
    w.filter = (x, y) => this.filterMenu(x, y);
    w.settings = () => this.unported("Settings");
    w.prs = () => this.unported("Pull requests");
    w.issues = () => this.unported("Issues");
    w.refresh = () => {
      this.data.reload();
      for (const r of this.data.repos) this.gitOf(r.id, true);
      this.refreshAll();
    };
    w.team = () => {
      w.team_on = !w.team_on;
      this.data.store.set("show_team", w.team_on ? "1" : "0");
    };
    w.open_agent = (id) => this.openChat(id);
    w.settle_agent = (id, on) => {
      const marks = mark(loadMarks(this.data.store.get("agent_settle")), id, on, now(), (x) => this.data.chat(x) !== undefined);
      this.data.store.set("agent_settle", saveMarks(marks));
      this.refreshTeam();
    };
    w.stop_agent = (id) => {
      this.engine.pending.delete(id);
      this.engine.stop(id);
    };
    w.cancel_wakeup = (id) => {
      this.data.store.deleteTimer(id);
      this.engine.timers = this.engine.timers.filter((t) => t.id !== id);
      this.refreshTeam();
    };
    w.wake_now = (id) => {
      const t = this.engine.timers.find((x) => x.id === id);
      if (t) t.at = now();
      this.engine.fireTimers();
      this.refreshTeam();
    };
    w.copy_hook = (url) => w.copy_text(url);
    w.proc_stop = (id) => {
      this.engine.procs.find((p) => p.id === id)?.stop();
      this.refreshTeam();
    };
    w.proc_toggle = (id) => {
      if (this.procsOpen.has(id)) this.procsOpen.delete(id);
      else this.procsOpen.add(id);
      this.refreshTeam();
    };
    w.proc_open = (url) => this.openExternal(url);
    w.delete_hook = (id) => {
      this.data.store.deleteWebhook(id);
      this.engine.webhooks = this.data.store.webhooks();
      this.refreshTeam();
    };
    w.team_settled_toggled = (on) => this.data.store.set("agents_settled_open", on ? "1" : "0");
    w.project_clicked = (x, y) => {
      if (this.view === "draft") this.projectPicker(x, y);
    };
    w.parent_clicked = () => {
      const c = this.data.chat(this.chatId);
      if (c?.parent) this.openChat(c.parent);
    };
    w.close_window = () => w.hide();
    w.read_only_act = () => {
      const c = this.data.chat(this.chatId);
      this.newDraft(c?.repoId ?? null);
    };
    w.toggle = (seq) => {
      toggleCard(this.openedOf(this.chatId), seq);
      this.refreshCards();
    };
    w.link = (url) => this.openLink(url);
    w.open_url = (url) => this.openExternal(url);
    w.card_act = (seq, a) => this.cardAction(seq, a);
    w.open_media = (path) => {
      Bun.spawn(["xdg-open", path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    };
    w.edited = (t) => {
      this.drafts.set(this.key(), t);
      setTimeout(() => this.refreshMenu(), 0);
    };
    w.key = (e) => this.composerKey(e);
    w.send = () => this.send();
    w.stop = () => this.stop(this.chatId);
    w.attach = () => void this.attach();
    w.mic = () => this.unported("Dictation");
    w.remove_file = (i) => {
      const list = this.attached.get(this.key()) ?? [];
      list.splice(i, 1);
      this.refreshFiles();
    };
    w.menu_pick = (i) => this.pickMenu(i);
    w.menu_hover = (i) => {
      this.menus.hover(i);
      w.menu_selected = i;
    };
    w.popup = (id, x, y) => this.composerPopup(id, x, y);
    w.pop_pick = (_id, i) => {
      const act = this.popActions[i];
      this.closePopup();
      act?.();
    };
    w.pop_close = () => this.closePopup();
    w.dialog_done = (_id, ok) => {
      const act = this.dialogAction;
      const input = w.dialog_input;
      w.dialog_id = "";
      this.dialogAction = null;
      act?.(ok, input);
    };
    w.global_key = (e) => this.globalKey(e);
    w.picker_rail_pick = (id) => {
      this.picker = { ...this.picker, rail: id === "" ? null : id, more: false, hover: 0 };
      this.refreshPicker();
    };
    w.picker_pick = (i) => this.pickModel(i);
    w.picker_star = (i) => {
      const r = this.pickerRowsNow[i];
      if (r) this.favorites.toggle(r.account, r.model);
      this.refreshPicker();
    };
    w.picker_more = () => {
      this.picker = { ...this.picker, more: true, hover: 0 };
      this.refreshPicker();
    };
    w.picker_back = () => {
      this.picker = { ...this.picker, more: false, hover: 0 };
      this.refreshPicker();
    };
    w.picker_searched = (t) => {
      this.picker = { ...this.picker, search: t, hover: 0 };
      this.refreshPicker();
    };
    w.picker_key = (e) => this.pickerKey(e);
    w.strip_open_agent = (id) => this.openChat(id);
    w.remove_mention = (i) => {
      const shown = this.messageMentions();
      const m = shown[i];
      const list = this.mentions.get(this.key()) ?? [];
      if (m) list.splice(list.indexOf(m), 1);
      this.refreshMentions();
    };
    w.trust = () => {
      const r = this.currentRepo();
      if (r) this.data.store.set(`untrusted:${r.local ?? r.path}`, "");
      this.refreshComposer();
    };
    w.strip_ask_stop = (id) => {
      w.strip_asking = id;
    };
    w.strip_cancel = () => {
      w.strip_asking = 0;
    };
    w.strip_stop = (id) => {
      w.strip_asking = 0;
      this.engine.pending.delete(id);
      this.engine.stop(id);
    };
    w.strip_head = () => {
      const v = stripView(this.stripRows.length, 0, this.stripFold.get(this.chatId) ?? null);
      if (headerClick(v.folded) === "toggle") this.stripFold.set(this.chatId, !v.open);
      else {
        w.team_on = true;
        this.data.store.set("show_team", "1");
      }
      this.refreshStrip();
    };
    w.strip_stop_all = () => this.dialog("Stop all agents?", "Every running sub-agent stops and their queues are cleared.", "Stop all", true, null, (ok) => {
      if (ok) this.engine.stopAll(this.chatId);
    });
  }


  showing(id: number): boolean {
    return this.view === "chat" && this.chatId === id && this.win.window.visible;
  }

  /** The key of the composer shown: the open chat, or the draft. */
  private key(): number {
    return this.view === "chat" ? this.chatId : DRAFT;
  }

  private openedOf(id: number): Opened {
    let o = this.opened.get(id);
    if (!o) {
      o = newOpened();
      this.opened.set(id, o);
    }
    return o;
  }

  private items(id: number): Item[] {
    return this.data.items(id);
  }

  private get engine() {
    return this.data.engine;
  }

  snapshot(): Record<string, unknown> {
    this.drafts.set(this.key(), this.win.draft);
    const drafts: Record<string, string> = {};
    for (const [k, t] of this.drafts) if (t.trim() !== "") drafts[String(k)] = t;
    return { view: this.view === "chat" ? { t: "chat", id: this.chatId } : { t: "draft" }, draft_repo: this.draftRepo, draft_main: this.draftMain, drafts };
  }

  restore(s: Record<string, unknown>): void {
    const drafts = s.drafts;
    if (typeof drafts === "object" && drafts !== null) {
      for (const [k, t] of Object.entries(drafts)) if (Number.isInteger(Number(k)) && typeof t === "string") this.drafts.set(Number(k), t);
    }
    const view = s.view as { t?: unknown; id?: unknown } | null | undefined;
    if (view?.t === "chat" && typeof view.id === "number" && this.data.chat(view.id)) this.openChat(view.id);
    else {
      const repo = typeof s.draft_repo === "number" && this.data.repo(s.draft_repo) ? s.draft_repo : null;
      this.newDraft(repo, s.draft_main === true);
    }
  }

  openChat(id: number): void {
    if (!this.data.chat(id)) return;
    this.drafts.set(this.key(), this.win.draft);
    this.view = "chat";
    this.chatId = id;
    this.engine.unread.delete(id);
    this.engine.failed.delete(id);
    this.data.store.set("last_chat", String(id));
    this.win.draft = this.drafts.get(id) ?? "";
    this.closePopup();
    this.refreshAll();
    // A long chat's first layout takes a few frames: its end is sought until then.
    for (const ms of [30, 120, 400, 900]) setTimeout(() => this.win.scroll_to_end(), ms);
  }

  private openProject(repo: number): void {
    const main = this.data.mainChat(repo);
    if (main !== null) this.openChat(main);
    else this.newDraft(repo, true);
  }

  newDraft(repo: number | null, main = false): void {
    this.drafts.set(this.key(), this.win.draft);
    this.view = "draft";
    this.draftRepo = repo;
    this.draftMain = main && repo !== null;
    this.win.draft = this.drafts.get(DRAFT) ?? "";
    this.closePopup();
    this.refreshAll();
    this.win.focus_composer();
  }

  refreshAll(): void {
    this.refreshSidebar();
    this.refreshView();
    sync(this.files, this.fileItems(), sameJson);
  }

  private fileItems(): { name: string; image: boolean }[] {
    return (this.attached.get(this.key()) ?? []).map((p) => ({ name: p.slice(p.lastIndexOf("/") + 1), image: isImage(p) }));
  }

  private refreshView(): void {
    const w = this.win;
    const chat = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    w.view = this.view;
    const repo = chat ? (chat.repoId === null ? undefined : this.data.repo(chat.repoId)) : this.draftRepo === null ? undefined : this.data.repo(this.draftRepo);
    const parent = chat?.role === "sub" && chat.parent !== null ? this.data.chat(chat.parent) : undefined;
    const st = repo ? this.gitOf(repo.id) : null;
    w.crumbs = {
      icon: repo ? ICONS.FOLDER : ICONS.SQUARE_DASHED,
      project: repo?.name ?? "No project",
      parent: chat?.role === "sub" ? (parent?.title ?? "Lead") : "",
      title: chat ? (chat.role === "sub" ? chat.name : chat.title) : this.draftMain ? "Main chat" : "New thread",
      branch: st?.branch ?? "",
      changed: st?.changed ?? 0,
    };
    w.team_enabled = chat?.role === "lead";
    this.refreshTeam();
    this.refreshStrip();
    const empty = chat ? this.items(chat.id).length === 0 : true;
    w.hero = this.view === "draft" || (chat?.role === "lead" && empty);
    w.hero_subtitle = chat ? `The lead plans and delegates to subagents in ${repo?.name ?? ""}.` : (repo?.name ?? "No project");
    w.hero_link = !chat;
    w.hero_note = !chat && this.draftMain ? "Starts the project's main chat: its row opens it from now on" : "";
    w.read_only = chat?.role === "chat";
    w.read_only_text = "This is an earlier chat, kept read-only. Start a new chat in the project to continue.";
    w.read_only_action = chat?.repoId !== null && chat?.repoId !== undefined ? "New chat" : "";
    w.chat_running = chat ? this.engine.running(chat.id) : false;
    this.refreshComposer();
    this.refreshCards();
  }

  /** The running subagents over a lead's composer (agentstrip.rs `agent_strip`). */
  private refreshStrip(): void {
    const lead = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    const subs = lead?.role === "lead" ? this.engine.runningSubs(lead.id) : [];
    const queued = lead ? this.engine.subsOf(lead.id).reduce((n, c) => n + (this.engine.pending.get(c.id)?.length ?? 0), 0) : 0;
    const v = stripView(subs.length, queued, lead ? (this.stripFold.get(lead.id) ?? null) : null);
    sync(
      this.stripRows,
      subs.map(([c, secs]) => {
        const acc = this.account(c.account);
        const kind = acc?.kind ?? kindOfAccount(c.account);
        return { id: c.id, name: c.name, logo: this.logoOf(kind), badge: acc?.badge ?? "", tip: `${c.name}\n${this.modelLabel(kind, c.model)}\n${c.title}\nWorking for ${stripElapsed(secs)}\n\nClick to open the agent` };
      }),
      (a, b) => a.logo === b.logo && JSON.stringify({ ...a, logo: 0 }) === JSON.stringify({ ...b, logo: 0 }),
    );
    const w = this.win;
    w.strip_title = v.title;
    w.strip_names = subs.map(([c]) => c.name).join(", ");
    w.strip_header = v.header;
    w.strip_folded = v.folded;
    w.strip_open = v.open;
  }

  /** The team panel beside a lead chat (teamui.rs `team_panel`). */
  private refreshTeam(): void {
    const lead = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    if (!lead || lead.role !== "lead") {
      for (const m of [this.teamAgentRows, this.teamSettledRows]) sync(m, []);
      sync(this.wakeRows, []);
      sync(this.hookRows, []);
      sync(this.procRows, []);
      sync(this.earlierRows, []);
      return;
    }
    sync(
      this.earlierRows,
      lead.repoId === null ? [] : earlierChats(this.data.chats, lead.repoId).map((c) => ({ id: c.id, title: c.title, ago: ago(c.updated, now()) })),
      sameJson,
    );
    sync(
      this.procRows,
      this.engine.procs
        .filter((p) => p.lead === lead.id)
        .map((p) => {
          const open = this.procsOpen.has(p.id);
          const tail = open ? p.tail(30) : "";
          return { id: p.id, name: p.name, url: p.url ?? "", cmd: p.cmd, open, output: open && tail === "" ? "(no output yet)" : tail };
        }),
      sameJson,
    );
    const t = now();
    const off = utcOffset();
    const marks = loadMarks(this.data.store.get("agent_settle"));
    const busy = (id: number) => ({ running: this.engine.running(id), pending: this.engine.pending.get(id)?.length ?? 0, queued: this.engine.queued(id).length, paused: this.engine.paused.has(id) });
    const subs = this.engine.subsOf(lead.id);
    const { active, settled } = teamAgents(subs, (id) => this.engine.running(id), (c) => agentSettled(busy(c.id), marks, c, t));
    const row = (c: (typeof subs)[number], isSettled: boolean): AgentRow => {
      const since = this.engine.runningSince(c.id);
      const card = agentCard({ running: since === null ? null : Math.floor((Date.now() - since) / 1000), queued: this.engine.pending.get(c.id)?.length ?? 0, paused: this.engine.paused.has(c.id) ? { at: null } : null, updated: c.updated }, isSettled, false, t, off);
      const acc = this.account(c.account);
      const kind = acc?.kind ?? kindOfAccount(c.account);
      return {
        id: c.id,
        name: c.name,
        model: this.modelLabel(kind, c.model),
        task: c.title,
        status: card.status.text,
        status_icon: card.status.icon === null ? "" : ICONS[card.status.icon],
        status_color: token(card.status.color, this.dark),
        running: since !== null,
        settled: isSettled,
        logo: this.logos.get(`${kind}:${this.dark}`) ?? { width: 1, height: 1, data: new Uint8Array(4) },
        badge: acc?.badge ?? "",
      };
    };
    sync(this.teamAgentRows, active.map((c) => row(c, false)), sameJsonRow);
    sync(this.teamSettledRows, settled.map((c) => row(c, true)), sameJsonRow);
    sync(
      this.wakeRows,
      this.engine.timers.filter((x) => x.chatId === lead.id).map((x) => ({ id: x.id, time: localHm(x.at, off), tip: `in ${until(x.at, t)}`, reason: x.reason })),
      sameJson,
    );
    this.win.team_has_project = lead.repoId !== null;
    sync(
      this.hookRows,
      this.engine.webhooks
        .filter((h) => h.repoId === lead.repoId)
        .map((h) => {
          const card = webhookCard(h, `http://127.0.0.1:${control.HOOK_PORT}/hooks/${h.token}`, null, t);
          return { id: h.id, name: h.name, public: card.badge === "Public", calls: card.calls, description: card.description ?? "", url: card.url };
        }),
      sameJson,
    );
    for (const c of subs) {
      const kind = this.account(c.account)?.kind ?? kindOfAccount(c.account);
      const key = `${kind}:${this.dark}`;
      if (!this.logos.has(key)) {
        void providerLogo(kind, token("fg", this.dark)).then((p) => {
          this.logos.set(key, p);
          this.refreshTeam();
        });
      }
    }
  }

  private refreshCards(): void {
    if (this.view !== "chat") {
      sync(this.cards, []);
      return;
    }
    const chat = this.data.chat(this.chatId);
    if (!chat) return;
    const follow = this.win.at_end;
    const since = this.engine.runningSince(chat.id);
    const status = since !== null ? `Working ${elapsed(Math.floor((Date.now() - since) / 1000))}` : "";
    const cwd = this.data.cwd(chat);
    const rows = this.mediaRows;
    const next = transcriptCards(this.items(chat.id), chat.role === "lead", [], this.openedOf(chat.id), status, utcOffset(), rows ? (c) => rows.rows(c, cwd, 760) : undefined);
    sync(this.cards, next, sameCard);
    if (follow) setTimeout(() => this.win.scroll_to_end(), 16);
  }


  private statusData(s: Status): StatusData {
    switch (s.kind) {
      case "working":
        return { kind: "working", text: shortElapsed(s.secs), icon: "", color: token("blue-900", this.dark) };
      case "done":
        return { kind: "done", text: "", icon: "", color: token("green-900", this.dark) };
      case "failed":
        return { kind: "failed", text: "", icon: "", color: token("red-900", this.dark) };
      case "text":
        return { kind: "text", text: s.text, icon: glyph(s.icon), color: token(s.color, this.dark) };
    }
  }

  private chatStatus(c: Chat, idle: Status): Status {
    const since = this.engine.teamStarted(c.id) ?? this.engine.runningSince(c.id);
    const t = now();
    return ownStatus(
      { working: since !== null ? Math.floor((Date.now() - since) / 1000) : null, paused: this.engine.paused.has(c.id) ? { at: null } : null, typing: false, viewed: false, failed: this.engine.failed.has(c.id), unread: this.engine.unread.has(c.id) },
      idle,
      t,
      utcOffset(),
    );
  }

  refreshSidebar(): void {
    const d = this.data;
    const t = now();
    const snoozed = d.snoozed();
    const ids = sidebarOrder(d.repos, d.store.get("order_by_activity") === "1", d.chats);
    const tr = tree(ids, d.chats, d.mainChats(), (k) => snoozed.has(k) && (snoozed.get(k) ?? 0) > t);
    const list = sidebarList(tr, d.chats, d.repos, this.query);
    const rows: SideRow[] = [];
    const chatRow = (c: Chat, kind: "thread" | "loose"): SideRow => {
      const until = snoozed.get(`c${c.id}`) ?? null;
      const idle = chatIdle(snoozedLabel(until !== null && until > t ? until : null, t, utcOffset()), c.updated, t);
      return {
        kind,
        id: c.id,
        title: c.title,
        active: this.view === "chat" && this.chatId === c.id,
        status: this.statusData(this.chatStatus(c, idle)),
        letter: "",
        avatar: noPixels,
        has_avatar: false,
        settled: c.settled,
        snoozed: until !== null && until > t,
        worktree: 0,
        tip: "",
      };
    };
    for (const p of list.projects) {
      const main = d.mainChat(p.repo.id);
      const mainChat = main === null ? undefined : d.chat(main);
      const wakeUps = d.timers.some((x) => p.chats.some((c) => c.id === x.chatId) || x.chatId === main);
      const idle = projectIdle(wakeUps);
      const repo = d.repo(p.repo.id);
      const selected = (main !== null && this.view === "chat" && this.chatId === main) || (this.view === "draft" && this.draftMain && this.draftRepo === p.repo.id);
      rows.push({
        kind: "project",
        id: p.repo.id,
        title: p.repo.name,
        active: selected,
        status: this.statusData(mainChat ? this.chatStatus(mainChat, idle) : idle),
        letter: projectInitial(p.repo.name),
        avatar: this.avatar(p.repo.id) ?? noPixels,
        has_avatar: this.avatar(p.repo.id) !== null,
        settled: false,
        snoozed: snoozed.has(`r${p.repo.id}`),
        worktree: 0,
        tip: repo ? tilde(repo.local ?? repo.path, homedir()) : "",
      });
      for (const c of p.chats) rows.push(chatRow(c, "thread"));
    }
    if (list.loose.length > 0) {
      rows.push({ kind: "label", id: 0, title: "Threads", active: false, status: blankStatus(), letter: "", avatar: noPixels, has_avatar: false, settled: false, snoozed: false, worktree: 0, tip: "" });
      for (const c of list.loose) rows.push(chatRow(c, "loose"));
    }
    sync(this.rows, rows, sameSideRow);
    sync(
      this.settledRows,
      list.settled.map((c) => chatRow(c, "loose")),
      sameSideRow,
    );
    const w = this.win;
    w.settled_count = list.settled.length;
    w.running = this.engine.turns.size;
    w.side_empty = list.projects.length > 0 ? "" : this.query.trim() !== "" ? "search" : d.repos.length === 0 ? "projects" : "";
  }

  /** A project's git status (app.rs `refresh_git`): the last one known, read again in the background. */
  private gitOf(repo: number, again = false): git.Status | null {
    const known = this.gitStatus.get(repo);
    if ((known === undefined || again) && !this.gitRunning.has(repo)) {
      const r = this.data.repo(repo);
      if (r) {
        this.gitRunning.add(repo);
        void git
          .status(r.local ?? r.path)
          .catch(() => null)
          .then((st) => {
            this.gitRunning.delete(repo);
            this.gitStatus.set(repo, st);
            if (st?.origin && st.origin !== r.remote) this.data.store.setRepoRemote(repo, st.origin);
            this.refreshView();
          });
      }
    }
    return known ?? null;
  }

  /** A project's icon (sidebar.rs `avatar`): its own or its website's, looked up once; null: the initial. */
  private avatar(repo: number): Pixels | null {
    if (this.avatars.has(repo)) return this.avatars.get(repo) ?? null;
    this.avatars.set(repo, null);
    const r = this.data.repo(repo);
    if (!r) return null;
    void import("@harbor/media")
      .then(({ favicon }) => favicon.resolve(repo, r.local ?? r.path, r.name, false))
      .then((img) => {
        if (!img) return;
        this.avatars.set(repo, img);
        this.refreshSidebar();
      })
      .catch(() => {});
    return null;
  }

  private setSettled(id: number, on: boolean): void {
    const c = this.data.chat(id);
    if (!c) return;
    c.settled = on;
    this.data.saveChat(c);
    if (on && this.view === "chat" && this.chatId === id) {
      const repo = c.repoId;
      if (repo !== null && this.data.mainChat(repo) !== null && this.data.mainChat(repo) !== id) this.openChat(this.data.mainChat(repo) ?? 0);
      else this.newDraft(repo);
      return;
    }
    this.refreshSidebar();
  }


  private account(id: string): Account | undefined {
    return this.data.accounts.find((a) => a.id === id);
  }

  private chatSel(): Sel {
    const c = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    return c ? { account: c.account, model: c.model, effort: c.effort, access: c.access } : this.sel;
  }

  private kind(sel: Sel): Kind {
    return this.account(sel.account)?.kind ?? kindOfAccount(sel.account);
  }

  private modelLabel(kind: Kind, id: string): string {
    return providers.staticModels(kind).find((m) => m.id === id)?.label ?? (id === "" ? "Default" : id);
  }

  private currentRepo() {
    const id = this.view === "chat" ? (this.data.chat(this.chatId)?.repoId ?? null) : this.draftRepo;
    return id === null ? undefined : this.data.repo(id);
  }

  /** The composer's mentioned messages (a mentioned chat is its title in the text instead). */
  private messageMentions(): Mention[] {
    return (this.mentions.get(this.key()) ?? []).filter((m) => !isChat(m));
  }

  private refreshMentions(): void {
    sync(
      this.mentionChips,
      this.messageMentions().map((m) => ({ head: chipHead(m), snippet: chipSnippet(m), tip: chipTip(m, true) })),
      sameJson,
    );
  }

  private refreshComposer(): void {
    this.refreshMentions();
    const repo = this.currentRepo();
    this.win.untrusted = repo !== undefined && !this.engine.trusted(repo.id);
    const sel = this.chatSel();
    const kind = this.kind(sel);
    const acc = this.account(sel.account);
    const running = this.view === "chat" && this.engine.running(this.chatId);
    const steer = running && this.engine.steering(this.chatId) !== "no" && this.engine.followDefault() === "steer";
    const draftEmpty = this.win.draft.trim() === "";
    const state: ComposerState = {
      model: this.modelLabel(kind, sel.model),
      model_tip: acc ? providers.short(acc) : kind,
      badge: acc?.badge ?? "",
      has_effort: providers.efforts(kind).length > 0,
      effort: providers.effortLabel(kind, sel.effort) + (providers.hasFast(kind) && this.data.store.get("fast_mode") === "1" ? " · Fast" : ""),
      access: providers.accessLabel(kind, sel.access),
      access_icon: sel.access === "full" ? ICONS.LOCK_OPEN : sel.access === "plan" ? ICONS.EYE : ICONS.LOCK,
      device: "This PC",
      action: running && draftEmpty ? "stop" : steer ? "steer" : running ? "queue" : "send",
      action_tip: running && draftEmpty ? "Stop (Esc)" : steer ? "Click to steer, Ctrl-click or Ctrl+Enter to queue" : running ? "Queue: it runs after the current turn" : "Send (Enter)",
      hint: "Ask for changes, send follow-ups, or attach images",
      typing: "",
      notice: "",
    };
    this.win.composer = state;
    void providerLogo(kindOfAccount(sel.account), token("fg", this.dark)).then((p) => {
      this.win.model_logo = p;
    });
  }

  private menuContext(): MenuContext {
    const chat = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    const repoId = chat ? chat.repoId : this.draftRepo;
    const repo = repoId === null ? undefined : this.data.repo(repoId);
    const sel = this.chatSel();
    const kind = this.kind(sel);
    const acc = this.account(sel.account);
    const items = chat ? this.items(chat.id) : null;
    return {
      key: this.key(),
      cwd: repo ? (repo.local ?? repo.path) : homedir(),
      repo: repoId,
      home: homedir(),
      modes: { efforts: providers.efforts(kind).map((c) => c[0]), access: providers.access(kind).map((c) => c[0]) },
      access: sel.access,
      personal: personalDir(acc ? { kind: acc.kind.toLowerCase(), configDir: acc.configDir } : null, homedir()),
      chat: chat && items ? { forkable: forkable(items).some((x) => x !== null), settled: chat.settled, queued: this.engine.queued(chat.id).length > 0 } : null,
      chats: this.data.chats.map((c) => ({
        id: c.id,
        gid: c.gid,
        title: c.title,
        repoId: c.repoId,
        sub: c.role === "sub",
        settled: c.settled,
        updated: c.updated,
        running: this.engine.running(c.id),
        project: c.repoId === null ? "" : (this.data.repo(c.repoId)?.name ?? ""),
        pc: c.home === "" ? "This PC" : c.home,
      })),
    };
  }

  private refreshMenu(): void {
    const rows = this.menus.update(this.win.draft, this.win.cursor, this.menuContext());
    sync(this.menu, rows, sameJson);
    this.win.menu_selected = this.menus.selected;
  }

  private pickMenu(i: number): void {
    const r = this.menus.pick(this.win.draft, i);
    sync(this.menu, []);
    if (!r) return;
    this.win.draft = r.text;
    this.drafts.set(this.key(), r.text);
    this.win.set_cursor(r.cursor);
    this.win.focus_composer();
    const p = r.picked;
    if (p.kind === "mention") {
      const list = this.mentions.get(this.key()) ?? [];
      list.push(p.mention);
      this.mentions.set(this.key(), list);
    } else if (p.kind === "command") {
      this.harborCommand(p.command);
    }
  }

  private harborCommand(c: string): void {
    const chat = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    switch (c) {
      case "model":
      case "effort":
        this.composerPopup(c, 470, 640);
        return;
      case "plan":
        this.setSel({ access: "plan" });
        return;
      case "default":
        this.setSel({ access: "full" });
        return;
      case "new":
        this.newDraft(chat?.repoId ?? this.draftRepo);
        return;
      case "settle":
        if (chat) this.setSettled(chat.id, true);
        return;
      case "clear-queue":
        if (chat) for (const q of [...this.engine.queued(chat.id)]) this.engine.queueRemove(chat.id, q.id);
        this.refreshAll();
        return;
      case "fork": {
        if (!chat) return;
        const at = forkable(this.items(chat.id)).findLastIndex((x) => x !== null);
        if (at >= 0) this.fork(chat.id, at);
        return;
      }
      default:
        this.unported(`/${c}`);
    }
  }

  private composerKey(e: KeyEvent): boolean {
    const m = e.modifiers;
    const p = pressOf(e.text, m);
    if (this.menu.length > 0) {
      const r = this.menus.key(this.key(), p);
      if (r.taken) {
        if (r.pick !== null) this.pickMenu(r.pick);
        else {
          this.win.menu_selected = this.menus.selected;
          if (p.key === "Escape") sync(this.menu, []);
        }
        return true;
      }
    }
    const chat = this.view === "chat" ? this.chatId : null;
    if ((p.ctrl && !p.alt && !p.shift && p.key.toLowerCase() === "v") || (p.shift && p.key === "Insert")) void this.pasteImage();
    if (this.keys.matches("send", p)) {
      this.send(this.engine.followDefault());
      return true;
    }
    if (this.keys.matches("send_now", p)) {
      this.send(this.engine.followDefault() === "steer" ? "queue" : "steer");
      return true;
    }
    if (chat !== null && this.keys.matches("steer_queued", p)) {
      const first = this.engine.queued(chat)[0];
      if (first) this.engine.queuePromote(chat, first.id);
      return true;
    }
    if (this.keys.matches("stop_turn", p)) {
      if (this.win.pop_id !== "") {
        this.closePopup();
        return true;
      }
      if (chat !== null && this.engine.running(chat)) {
        this.engine.esc(chat);
        return true;
      }
    }
    setTimeout(() => {
      this.refreshComposer();
      this.refreshMenu();
    }, 0);
    return false;
  }

  private globalKey(e: KeyEvent): boolean {
    const p = pressOf(e.text, e.modifiers);
    const w = this.win;
    if (this.keys.matches("toggle_sidebar", p)) {
      w.sidebar_open = !w.sidebar_open;
      return true;
    }
    if (this.keys.matches("new_thread", p)) {
      this.newDraft(this.view === "chat" ? (this.data.chat(this.chatId)?.repoId ?? null) : this.draftRepo);
      return true;
    }
    if (this.keys.matches("toggle_team", p) && w.team_enabled) {
      w.team();
      return true;
    }
    if (this.keys.matches("palette", p)) {
      w.palette();
      return true;
    }
    if (this.keys.matches("settings", p)) {
      w.settings();
      return true;
    }
    if (p.key === "Escape" && w.pop_id !== "") {
      this.closePopup();
      return true;
    }
    if (this.keys.matches("stop_turn", p) && this.view === "chat" && this.engine.running(this.chatId)) {
      this.engine.esc(this.chatId);
      return true;
    }
    return false;
  }

  /** An image on the clipboard joins the message (app.rs `save_pasted_image`); text pastes as usual. */
  private async pasteImage(): Promise<void> {
    const key = this.key();
    const { clipboard } = await import("@harbor/media");
    const clip = await clipboard.read();
    if (clip?.type !== "image") return;
    const dir = join(dataDir(), "pastes");
    mkdirSync(dir, { recursive: true });
    const png = clip.bytes[0] === 0x89 && clip.bytes[1] === 0x50;
    const path = join(dir, `pasted-${Date.now()}.${png ? "png" : "jpg"}`);
    writeFileSync(path, clip.bytes);
    const list = this.attached.get(key) ?? [];
    list.push(path);
    this.attached.set(key, list);
    const [text, cursor] = writeImage(this.win.draft, charAt(this.win.draft, this.win.cursor), imageCount(list));
    this.win.draft = text;
    this.drafts.set(key, text);
    this.win.set_cursor(byteAt(text, cursor));
    this.refreshFiles();
  }

  private async attach(): Promise<void> {
    const key = this.key();
    const { picker } = await import("@harbor/media");
    const picked = await picker.pick({ title: "Attach files", multiple: true });
    if (picked.length === 0) return;
    const list = this.attached.get(key) ?? [];
    for (const p of picked) if (!list.includes(p)) list.push(p);
    this.attached.set(key, list);
    this.refreshFiles();
  }

  private refreshFiles(): void {
    sync(this.files, this.fileItems(), sameJson);
    this.refreshComposer();
  }

  private send(mode: "steer" | "queue" = this.engine.followDefault()): void {
    const text = this.win.draft.trim();
    const from = this.key();
    const files = this.attached.get(from) ?? [];
    if (text === "" && files.length === 0 && this.messageMentions().length === 0) return;
    const mentions = (this.mentions.get(from) ?? []).filter((m) => !isChat(m) || text.includes(m.title));
    let id = this.view === "chat" ? this.chatId : DRAFT;
    if (id === DRAFT) {
      const joins = this.draftMain && this.draftRepo !== null ? this.data.mainChat(this.draftRepo) : null;
      id = joins ?? this.engine.newThread(this.draftRepo, text, { ...this.sel, device: "" }).id;
      if (this.draftMain && this.draftRepo !== null && joins === null) this.data.store.setMainChat(this.draftRepo, id);
      this.view = "chat";
      this.chatId = id;
      this.data.store.set("last_chat", String(id));
    }
    this.mentions.delete(from);
    this.drafts.delete(from);
    this.attached.delete(from);
    this.win.draft = "";
    this.refreshFiles();
    this.engine.send(id, text, { files, mentions, mode });
    this.refreshAll();
    setTimeout(() => this.win.scroll_to_end(), 30);
  }

  private stop(id: number): void {
    this.engine.stop(id);
    this.refreshAll();
  }

  /** The Engine changed chat `id` (null: several): redrawn at most every 50 ms while it streams. */
  changed(id: number | null): void {
    if (id === null || (this.view === "chat" && id === this.chatId)) this.cardsDirty = true;
    this.sidebarDirty = true;
    if (this.flush !== null) return;
    this.flush = setTimeout(() => {
      this.flush = null;
      if (this.cardsDirty) {
        this.cardsDirty = false;
        this.refreshView();
      }
      if (this.sidebarDirty) {
        this.sidebarDirty = false;
        this.refreshSidebar();
      }
    }, 50);
  }

  private sidebarDirty = false;
  private flush: ReturnType<typeof setTimeout> | null = null;

  /** Light or dark follows Omarchy's theme while the mode is System (theme.rs `refresh`). */
  private followTheme(): void {
    if (this.mode !== "system") return;
    const stamp = omarchyStamp(homedir());
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    const dark = resolveDark(this.mode, homedir());
    if (dark === this.dark) return;
    this.dark = dark;
    this.win.dark = dark;
    this.refreshAll();
  }

  /** Once a second: queued messages and wake-ups due, and the Working timers. */
  private wasRunning = new Set<number>();

  tick(): void {
    this.followTheme();
    for (const id of this.wasRunning) {
      const repo = this.data.chat(id)?.repoId;
      if (!this.engine.running(id) && repo !== null && repo !== undefined) this.gitOf(repo, true);
    }
    this.wasRunning = new Set(this.engine.turns.keys());
    this.engine.queueDrain();
    this.engine.fireTimers();
    if (this.engine.turns.size > 0) {
      if (this.view === "chat" && this.engine.running(this.chatId)) this.refreshCards();
      this.refreshSidebar();
      this.refreshTeam();
      this.refreshStrip();
    }
  }

  /** Saves what runs, so the next Harbor finds it, and stops following the turns (they go on). */
  shutdown(): void {
    for (const [id, run] of this.engine.turns) {
      this.engine.persist(id);
      run.turn?.release();
    }
  }


  private popup(id: string, x: number, y: number, items: (PopItem & { act?: () => void })[], width = 240, above = false): void {
    const w = this.win;
    this.popActions = items.map((i) => i.act ?? (() => {}));
    sync(
      this.popItems,
      items.map(({ act: _a, ...rest }) => rest),
    );
    w.pop_x = x;
    w.pop_y = y;
    w.pop_w = width;
    w.pop_above = above;
    w.pop_id = id;
  }

  private closePopup(): void {
    this.win.pop_id = "";
  }

  private item(label: string, act: () => void, extra: Partial<PopItem> = {}): PopItem & { act: () => void } {
    return { kind: "item", icon: "", label, desc: "", checked: false, enabled: true, badge: "", ...extra, act };
  }

  private label(text: string): PopItem {
    return { kind: "label", icon: "", label: text, desc: "", checked: false, enabled: false, badge: "" };
  }

  private separator(): PopItem {
    return { kind: "separator", icon: "", label: "", desc: "", checked: false, enabled: false, badge: "" };
  }

  private composerPopup(id: string, x: number, y: number): void {
    if (this.win.pop_id === id) {
      this.closePopup();
      return;
    }
    const sel = this.chatSel();
    const kind = this.kind(sel);
    const set = (patch: Partial<Sel>) => this.setSel(patch);
    if (id === "model") {
      this.picker = { rail: sel.account, search: "", more: false, hover: 0 };
      this.win.picker_search = "";
      this.refreshPicker();
      this.win.pop_x = x;
      this.win.pop_y = y;
      this.win.pop_id = "model";
    } else if (id === "effort") {
      const def = providers.defaultEffort(kind);
      const cur = sel.effort === "" ? def : sel.effort;
      const rows: (PopItem & { act?: () => void })[] = [{ ...this.label("Reasoning"), kind: "header" }];
      for (const [k, label, detail] of providers.efforts(kind)) rows.push({ ...this.item(label, () => set({ effort: k }), { desc: detail, checked: k === cur, badge: k === def ? "Default" : "" }), kind: "choice" });
      if (providers.hasFast(kind)) {
        const fast = this.data.store.get("fast_mode") === "1";
        rows.push({ ...this.separator(), kind: "gap" }, this.separator(), { ...this.separator(), kind: "gap" }, { ...this.label("Fast Mode"), kind: "header" });
        for (const [on, label] of [[true, "On"], [false, "Off"]] as const) {
          rows.push({ ...this.item(label, () => this.data.store.set("fast_mode", on ? "1" : "0"), { checked: fast === on }), kind: "choice" });
        }
      }
      this.popup(id, x, y, rows, 300, true);
    } else if (id === "access") {
      this.popup(
        id,
        x,
        y,
        [this.label("Access"), ...providers.access(kind).map(([k, label, detail]) => this.item(label, () => set({ access: k }), { desc: detail, checked: k === sel.access, icon: k === "full" ? ICONS.LOCK_OPEN : k === "plan" ? ICONS.EYE : ICONS.LOCK }))],
        320,
        true,
      );
    } else if (id === "device") {
      this.popup(id, x, y, [this.item("This PC", () => {}, { icon: ICONS.HOUSE, checked: true, desc: "Devices aren't in the TypeScript app yet" })], 280, true);
    }
  }

  /** Lead chats run on Claude; a started chat stays on its provider (app.rs `locked_kind_of`). */
  private lockedKind(): Kind | null {
    const c = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    if (!c) return null;
    if (c.role === "lead") return "Claude";
    if (!c.started) return null;
    return this.account(c.account)?.kind ?? kindOfAccount(c.account);
  }

  private logoOf(kind: Kind): Pixels {
    const key = `${kind}:${this.dark}`;
    const hit = this.logos.get(key);
    if (hit) return hit;
    void providerLogo(kind, token("fg", this.dark)).then((p) => {
      this.logos.set(key, p);
      if (this.win.pop_id === "model") this.refreshPicker();
    });
    return { width: 1, height: 1, data: new Uint8Array(4) };
  }

  private refreshPicker(): void {
    const sel = this.chatSel();
    const locked = this.lockedKind();
    const accounts = this.data.accounts.filter(providers.installed);
    sync(
      this.railItems,
      accounts.map((a) => ({ id: a.id, logo: this.logoOf(a.kind), badge: a.badge, active: this.picker.rail === a.id, dim: a.loggedIn === false || (locked !== null && locked !== a.kind), tip: railTip(a) })),
      (a, b) => a.logo === b.logo && JSON.stringify({ ...a, logo: 0 }) === JSON.stringify({ ...b, logo: 0 }),
    );
    const { rows, more } = pickerRows(this.picker, this.data.accounts, this.favorites.list, locked);
    this.pickerRowsNow = rows;
    sync(
      this.modelRows,
      rows.map((r) => ({ label: r.label, sub: r.sub, logo: this.logoOf(r.kind), enabled: r.enabled, current: r.account === sel.account && r.model === sel.model, favorite: this.favorites.has(r.account, r.model) })),
      (a, b) => a.logo === b.logo && JSON.stringify({ ...a, logo: 0 }) === JSON.stringify({ ...b, logo: 0 }),
    );
    const w = this.win;
    w.picker_favorites = this.picker.rail === null;
    w.picker_hover = this.picker.hover;
    w.picker_more_label = more?.[0] ?? "";
    w.picker_more_count = more?.[1] ?? 0;
    w.picker_in_more = this.picker.more;
    w.picker_empty = emptyText(this.picker);
  }

  private pickModel(i: number): void {
    const r = this.pickerRowsNow[i];
    if (!r?.enabled) return;
    const sel = this.chatSel();
    const kind = this.account(r.account)?.kind ?? kindOfAccount(r.account);
    this.setSel({ account: r.account, model: r.model, effort: kind === this.kind(sel) ? sel.effort : providers.defaultEffort(kind) });
    this.closePopup();
    this.win.focus_composer();
  }

  private pickerKey(e: KeyEvent): boolean {
    const n = Math.max(this.pickerRowsNow.length, 1);
    const k = pressOf(e.text, e.modifiers);
    if (k.ctrl && /^[1-9]$/.test(k.key)) {
      this.pickModel(Number(k.key) - 1);
      return true;
    }
    if (k.key === "ArrowDown" || k.key === "ArrowUp") {
      this.picker.hover = (this.picker.hover + (k.key === "ArrowDown" ? 1 : n - 1)) % n;
      this.win.picker_hover = this.picker.hover;
      return true;
    }
    if (k.key === "Enter") {
      this.picker.hover = this.win.picker_hover;
      if (this.pickerRowsNow[this.picker.hover]?.enabled) this.pickModel(this.picker.hover);
      else if (this.picker.search.trim() !== "") {
        this.setSel({ account: this.picker.rail ?? this.chatSel().account, model: this.picker.search.trim() });
        this.closePopup();
      }
      return true;
    }
    if (k.key === "Escape") {
      this.closePopup();
      this.win.focus_composer();
      return true;
    }
    return false;
  }

  private setSel(patch: Partial<Sel>): void {
    if (this.view === "chat") {
      const c = this.data.chat(this.chatId);
      if (!c) return;
      if (patch.account !== undefined) c.account = patch.account;
      if (patch.model !== undefined) c.model = patch.model;
      if (patch.effort !== undefined) c.effort = patch.effort;
      if (patch.access !== undefined) c.access = parseAccess(patch.access);
      this.data.saveChat(c);
    } else {
      this.sel = { ...this.sel, ...patch };
      const s = this.sel;
      for (const [k, v] of [
        ["default_account", s.account],
        ["default_model", s.model],
        ["default_effort", s.effort],
        ["default_access", s.access],
      ] as const)
        this.data.store.set(k, v);
    }
    this.refreshComposer();
  }

  private projectPicker(x: number, y: number): void {
    const items: (PopItem & { act?: () => void })[] = [this.item("No project", () => this.newDraft(null), { icon: ICONS.MESSAGE, desc: "Home folder", checked: this.draftRepo === null })];
    if (this.data.repos.length > 0) items.push(this.separator());
    for (const r of this.data.repos) items.push(this.item(r.name, () => this.newDraft(r.id), { icon: ICONS.FOLDER, desc: tilde(r.local ?? r.path, homedir()), checked: this.draftRepo === r.id }));
    this.popup("project", x - 110, y, items, 280);
  }

  private chatMenu(id: number, x: number, y: number): void {
    const c = this.data.chat(id);
    if (!c) return;
    const items: (PopItem & { act?: () => void })[] = [this.item("Rename", () => this.renameDialog(id)), this.item(c.settled ? "Unsettle" : "Settle", () => this.setSettled(id, !c.settled))];
    if (c.role === "lead" && c.repoId !== null && this.data.repo(c.repoId)) {
      items.push(this.item("Make main chat", () => this.makeMain(id), { desc: "The project's row opens this chat" }));
    }
    if (c.role !== "sub") {
      let why = "";
      try {
        this.engine.movable(id);
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
      items.push(why === "" ? this.item("Move to project…", () => this.moveMenu(id, x, y)) : this.item("Move to project…", () => {}, { enabled: false, desc: why }));
    }
    items.push(this.separator(), this.item("Delete", () => this.deleteDialog(id), { icon: ICONS.TRASH }));
    this.popup("chat", x, y, items, 240);
  }

  /** team.rs `make_main`: the chat becomes its project's main chat (back from Settled or snooze). */
  private makeMain(id: number): void {
    const c = this.data.chat(id);
    if (!c || c.repoId === null) return;
    if (c.settled) {
      c.settled = false;
      this.data.saveChat(c);
    }
    this.data.setSnooze(`c${id}`, null, () => {});
    this.data.store.setMainChat(c.repoId, id);
    this.refreshAll();
  }

  /** sidebar.rs `move_menu`: the chat and its sub-agents to another project, or none. */
  private moveMenu(id: number, x: number, y: number): void {
    const c = this.data.chat(id);
    if (!c) return;
    const move = (repo: number | null) => () => {
      try {
        this.engine.moveChat(id, repo);
      } catch (e) {
        this.dialog("Couldn't move this chat", e instanceof Error ? e.message : String(e), "OK", false, null, () => {});
      }
      this.data.reload();
      this.refreshAll();
    };
    const items: (PopItem & { act?: () => void })[] = [this.item("No project", move(null), { icon: ICONS.MESSAGE, desc: "Home folder", checked: c.repoId === null })];
    if (this.data.repos.length > 0) items.push(this.separator());
    for (const r of this.data.repos) items.push(this.item(r.name, move(r.id), { icon: ICONS.FOLDER, desc: tilde(r.local ?? r.path, homedir()), checked: c.repoId === r.id }));
    setTimeout(() => this.popup("move", x, y, items, 280), 0);
  }

  private projectMenu(id: number, x: number, y: number): void {
    const items: (PopItem & { act?: () => void })[] = [];
    const stored = this.data.repo(id)?.remote ?? "";
    const remote = this.gitStatus.get(id)?.remote ?? (stored === "" ? null : git.webUrl(stored));
    if (remote) items.push(this.item("Open remote", () => this.openExternal(remote), { icon: ICONS.EXTERNAL }));
    const main = this.data.mainChat(id);
    if (main !== null) {
      if (items.length > 0) items.push(this.separator());
      items.push(this.item("Rename main chat", () => this.renameDialog(main)), this.item("Settle main chat", () => this.setSettled(main, true), { desc: "The project's next message starts a new main chat" }));
    }
    if (items.length > 0) items.push(this.separator());
    items.push(this.item("Remove from Harbor", () => this.removeRepoDialog(id), { icon: ICONS.TRASH }));
    this.popup("project-row", x, y, items, 260);
  }

  /** sidebar.rs `snooze_menu`: presets, a time typed by hand with its preview, Unsnooze. */
  private snoozeMenu(key: string, x: number, y: number): void {
    const t = now();
    const off = utcOffset();
    const apply = (until: number | null) => this.data.setSnooze(key, until, this.refreshAllBound);
    const items: (PopItem & { act?: () => void })[] = [this.label("Snooze until")];
    for (const [label, until] of snoozePresets(t, off)) items.push(this.item(label, () => apply(until), { icon: ICONS.CLOCK }));
    items.push(this.separator(), { ...this.item("Custom: 5h, 2d, 18:00", () => {}, { desc: "Snooze until then" }), kind: "input" });
    if (this.data.snoozed().has(key)) items.push(this.separator(), this.item("Unsnooze", () => apply(null), { icon: ICONS.X }));
    const w = this.win;
    w.pop_input = "";
    w.pop_input_note = "";
    w.pop_input_ok = false;
    w.pop_input_edited = (text) => {
      const [until, line] = snoozePreview(text, now(), off);
      w.pop_input_ok = until !== null;
      w.pop_input_note = line;
    };
    w.pop_input_accept = () => {
      const until = parseSnooze(w.pop_input, now(), off);
      if (until === null) return;
      this.closePopup();
      apply(until);
    };
    this.popup("snooze", x, y, items, 240);
  }

  private refreshAllBound = (): void => this.refreshAll();

  private filterMenu(x: number, y: number): void {
    const byActivity = this.data.store.get("order_by_activity") === "1";
    const order = (on: boolean) => () => {
      this.data.store.set("order_by_activity", on ? "1" : "0");
      this.refreshSidebar();
    };
    this.popup("filter", x, y, [this.label("Order projects"), this.item("Manual", order(false), { icon: ICONS.GRIP, desc: "Drag projects to reorder", checked: !byActivity }), this.item("Last activity", order(true), { icon: ICONS.ACTIVITY, desc: "Most recent first", checked: byActivity })], 260);
  }


  private dialog(title: string, text: string, ok: string, danger: boolean, input: string | null, act: (ok: boolean, input: string) => void): void {
    const w = this.win;
    w.dialog_title = title;
    w.dialog_text = text;
    w.dialog_ok = ok;
    w.dialog_danger = danger;
    w.dialog_has_input = input !== null;
    w.dialog_input = input ?? "";
    this.dialogAction = act;
    w.dialog_id = "dialog";
  }

  private renameDialog(id: number): void {
    const c = this.data.chat(id);
    if (!c) return;
    this.dialog("Rename chat", "", "Rename", false, c.title, (ok, title) => {
      if (!ok || title.trim() === "") return;
      c.title = title.trim();
      this.data.saveChat(c);
      this.refreshAll();
    });
  }

  private deleteDialog(id: number): void {
    const c = this.data.chat(id);
    if (!c) return;
    this.dialog("Delete chat?", `"${c.title}" and its transcript are deleted from this PC.`, "Delete", true, null, (ok) => {
      if (!ok) return;
      this.data.deleteChat(id);
      if (this.view === "chat" && this.chatId === id) this.newDraft(c.repoId);
      else this.refreshAll();
    });
  }

  private removeRepoDialog(id: number): void {
    const r = this.data.repo(id);
    if (!r) return;
    this.dialog("Remove project?", `${r.name} leaves Harbor with its chats. Its folder stays on disk.`, "Remove", true, null, (ok) => {
      if (!ok) return;
      this.data.removeRepo(id);
      if (this.draftRepo === id) this.draftRepo = null;
      const c = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
      if (this.view === "chat" && !c) this.newDraft(null);
      else this.refreshAll();
    });
  }

  private addProjectDialog(): void {
    this.dialog("Add project", "The folder of a project on this PC.", "Add", false, "", (ok, path) => {
      if (!ok || path.trim() === "") return;
      const p = path.trim().replace(/^~(?=\/|$)/, homedir());
      const id = this.data.addRepo(p);
      if (id === null) {
        this.dialog("Add project", `${p} isn't a folder on this PC.`, "OK", false, null, () => {});
        return;
      }
      this.newDraft(id);
    });
  }

  private unported(what: string): void {
    this.dialog(what, `${what} isn't in the TypeScript app yet: it's listed as not started in ts/packages/ui/PROGRESS.md.`, "OK", false, null, () => {});
  }

  /** fork.rs `fork_from`: a new chat with the conversation up to that reply. */
  private fork(id: number, reply: number): void {
    const c = this.engine.forkFrom(id, reply);
    if (!c) return;
    this.data.reload();
    this.openChat(c.id);
  }

  /** A hover-bar button of message `seq` (chat.rs `msg_action`). */
  private cardAction(seq: number, a: string): void {
    const chat = this.data.chat(this.chatId);
    const item = chat ? this.items(chat.id)[seq] : undefined;
    if (!chat || !item) return;
    const text = item.kind === "user" || item.kind === "text" ? item.text : "";
    if (a === "copy") {
      this.win.copy_text(text);
    } else if (a === "quote") {
      const quote = defuse(text)
        .split("\n")
        .map((l) => `> ${l}\n`)
        .join("");
      this.win.draft = `${quote}\n${this.win.draft}`;
      this.drafts.set(this.key(), this.win.draft);
      this.win.focus_composer();
    } else if (a === "mention") {
      const m = mentionOf(item, seq, mentionAgent({ sub: chat.role === "sub", name: chat.name }, this.kind(this.chatSel())));
      if (!m) return;
      const list = this.mentions.get(this.key()) ?? [];
      addMention(list, m);
      this.mentions.set(this.key(), list);
      this.refreshMentions();
      this.win.focus_composer();
    } else {
      this.fork(chat.id, seq);
    }
  }


  private openLink(url: string): void {
    const chat = /^harbor:chat\/(.+)$/.exec(url);
    if (chat?.[1]) {
      const c = this.data.chats.find((x) => x.gid === chat[1]);
      if (c) this.openChat(c.id);
      return;
    }
    const byId = /^harbor:chat-id\/(\d+)/.exec(url);
    if (byId?.[1]) {
      this.openChat(Number(byId[1]));
      return;
    }
    if (url.startsWith("harbor:")) return;
    this.openExternal(url);
  }

  private openExternal(url: string): void {
    if (!/^(https?|mailto):/.test(url)) return;
    Bun.spawn(["xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  }
}

function sameCard(a: CardData, b: CardData): boolean {
  const plain = a.kind === "group" || a.kind === "space" || a.kind === "status" || a.kind === "divider" || a.kind === "earlier";
  return a === b || (plain && a.kind === b.kind && a.seq === b.seq && a.label === b.label && a.open === b.open && a.pending === b.pending && a.text === b.text && a.url === b.url);
}

function shortElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
}

function elapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/** This PC's offset from UTC now, in seconds (team.rs `utc_offset`). */
export function utcOffset(): number {
  return -new Date().getTimezoneOffset() * 60;
}


export interface ShellHooks {
  /** The screen to come back to after a restart (a snapshot the previous process left), or null. */
  restore?: Record<string, unknown> | null;
  /** Gets a function that reads the screen's state, for the next restart. */
  snapshotWith?: (read: () => Record<string, unknown>) => void;
  /** The first frame is on screen. */
  shown?: () => void;
}

export async function run(data: Data, hooks: ShellHooks = {}): Promise<void> {
  const win = await loadWindow();
  const shell = new Shell(win, data);
  data.onChange = (id) => shell.changed(id);
  data.visible = (id) => shell.showing(id);
  data.onNotificationOpen = (gids) => {
    const c = data.chats.find((x) => gids.includes(x.gid));
    if (c) shell.openChat(c.id);
  };
  data.engine.reattachTurns();
  void import("@harbor/media").then((pkg) => {
    shell.useMedia(pkg);
    shell.changed(null);
  });
  const last = Number(data.store.get("last_chat") ?? 0);
  shell.newDraft(null);
  if (process.env.HARBOR_VIEW === "chat" && data.chat(last)) shell.openChat(last);
  if (hooks.restore) shell.restore(hooks.restore);
  hooks.snapshotWith?.(() => shell.snapshot());
  win.show();
  scripted(win.window, process.env.HARBOR_POINTER);
  hooks.shown?.();
  const tick = setInterval(() => shell.tick(), 1000);
  await runLoop();
  clearInterval(tick);
  shell.shutdown();
}

export type { Item };
