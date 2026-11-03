import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import * as slint from "slint-ui";
import { type Account, chatpr, git, type Kind, providers, recap, Work } from "@harbor/agents";
import { type Chat, dataDir, type Item, now, parseAccess, runDir } from "@harbor/store";
import { CHAT_SCHEME, type ChatLinkWorld, chatLinkTarget, clearDeviceTransfers, openChatLink, deviceCanSend, deviceDetails, deviceDownloadsDir, deviceHumanSize, deviceIsImage, type DeviceSendEnv, type DeviceSendKind, deviceSend, type DeviceTransfer, FileBrowser, isPhoneDevice, type PairedDevice, sendMenuNote, transferStatus } from "@harbor/net";
import { EARLIER, earlier, forget, newOpened, type Opened, PAGE, queueCards, sameBlock, subsRunning, toggle as toggleCard, transcriptCards, trim, withQueue } from "./cards.ts";
import { byteAt, charAt, ComposerMenus, type MenuContext, pressOf, transcriptKey } from "./composer.ts";
import { add as addMention, chipHead, chipSnippet, chipTip, excerptOf, isChat, type Mention, mentionAgent, mentionOf, noteHint, SelectionButton } from "./logic/mentions.ts";
import { type HarborCommand, personalDir } from "./logic/slash.ts";
import { forkable } from "./logic/fork.ts";
import { MeshChat, type ShellMesh } from "./logic/meshchat.ts";
import { updateToast } from "./logic/hubseam.ts";
import { type Item as PaletteItem, paletteItems } from "./logic/palette.ts";
import { busOf } from "./pages/bus.ts";
import { type Page, type PageHub, PageHost } from "./pages/host.ts";
import { tabFromSlug } from "./logic/pages.ts";
import { type SettingsView } from "./pages/settings.ts";
import { isImage } from "./logic/images.ts";
import { Keys, label as keyLabel } from "./logic/keys.ts";
import { Zoom } from "./logic/zoom.ts";
import { headerClick, shortElapsed as stripElapsed, stripView } from "./logic/agentstrip.ts";
import { localHm, until } from "./logic/team.ts";
import { agentCard, agentSettled, earlierChats, loadMarks, mark, saveMarks, teamAgents, webhookCard } from "./logic/teamui.ts";
import { control } from "@harbor/mcp";
import { Data, mentionOf as fromStore } from "./data.ts";
import { web } from "./logic/browser.ts";
import { BrowserEngine, clearCrashes, crashing, helperPath, hostOf, keyMessages, sourceDir } from "./browser.ts";
import { gridSize } from "./logic/terminal.ts";
import { linkAt, selectionAt } from "./markdown.ts";
import { type Dock, listeningPorts, Surfaces, tabTitle } from "./surface.ts";
import { Terminal } from "./terminal.ts";
import { ICONS, type IconName } from "./icons.ts";
import { ago, tilde } from "./logic/app.ts";
import { EscHold, usageRows } from "./logic/usagepop.ts";
import { projectMenu, projectMoveTitle, type ProjectAct, REMOVE_PROJECT } from "./logic/projectmenu.ts";
import { chatIdle, inWorkspaces, type MoveItem, parseSnooze, picked, type Status, ownStatus, projectIdle, projectInitial, sidebarList, sidebarOrder, snoozedLabel, snoozePresets, snoozePreview, reordered, stepRow, toggled, tree, type Workspace } from "./logic/sidebar.ts";
import { clashingNames, draftPlaceLine, type Place, placeHint, placeLine } from "./logic/projectplace.ts";
import { chatTitles, defuse, dropFile, erase, eraseSpans, imageCount, imagesFollow, shiftImages, withPicked, writeImage } from "./logic/usertext.ts";
import { kindOfAccount, type Pixels, providerLogo } from "./logos.ts";
import { MediaRows } from "./mediarows.ts";
import { VideoPane } from "./videopane.ts";
import { CaptchaPane } from "./captchapane.ts";
import { ChatCaptcha, FRAME_W, hereCaptcha, noChatCaptcha } from "./chatcaptcha.ts";
import { fakeCaptcha } from "./fakecaptcha.ts";
import { emptyText, Favorites, type PickerState, pickerRows, railTip, type Row } from "./picker.ts";
import { runLoop } from "./loop.ts";
import { scripted } from "./script.ts";
import { type Mode, omarchyStamp, parseMode, resolveDark, token } from "./theme.ts";
import { type AgentRow, type AppWindow, blankStatus, noPixels, type HookRow, type ProcItem, type ModelRow, type RailItem, type StripRow, type WakeRow, type CardData, type MdBlockData, type ComposerState, type KeyEvent, loadWindow, type MenuEntry, type SurfaceTab, type PopItem, type SideRow, type StatusData, type DeviceRow, type TransferRow, type FileRow, type BrowserData } from "./window.ts";

/** How long the reader stays at a chat's end before the earlier pages they scrolled up to are let go. */
const TRIM_MS = 30_000;

/** After cards and images were let go: the engine's collector runs rarely when little else allocates, so their
 * memory would stay until then. */
function collectSoon(): void {
  setTimeout(() => Bun.gc(true), 200);
}

/** What the composer's Resume button sends. */
export const RESUME_TEXT = "Resume from where you left off: continue what you were saying or doing.";

/** The draft's key in per-chat maps (app.rs `DRAFT`). */
const DRAFT = 0;

const solo: ShellMesh = {
  me: () => "",
  home: (c) => (c.home === "" ? null : { name: c.home, online: false }),
  peer: () => null,
  remote: () => null,
  typers: () => [],
  viewers: () => [],
  forward: async () => ({ status: 503, body: { error: "this window has no hub" } }),
  create: async () => ({ status: 503, body: { error: "this window has no hub" } }),
  lease: () => {},
};

interface Sel {
  account: string;
  model: string;
  effort: string;
  access: string;
  device: string;
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

type Marks = Pick<SideRow, "worktree" | "worktree_tip" | "pr" | "pr_tip">;

/** sidebar.rs: a chat in its own worktree gets its folder mark, then its branch's PR state. */
export function marksOf(dir: string | null, gone: boolean, pr: chatpr.ChatPr | null): Marks {
  if (dir === null) return { worktree: "", worktree_tip: "", pr: "", pr_tip: "" };
  const name = basename(dir);
  return {
    worktree: gone ? "gone" : "live",
    worktree_tip: gone ? `Its worktree, ${name}, is gone` : `Runs in its own worktree, ${name}`,
    pr: pr?.state ?? "",
    pr_tip: pr ? `${chatpr.label(pr)}: ${pr.title}` : "",
  };
}

export class Shell {
  readonly win: AppWindow;
  readonly data: Data;
  private dark = true;
  private mode: Mode = "system";
  private stamp = 0;
  private view: "draft" | "chat" = "draft";
  /** The page over the draft or chat: it leaves back to the chat it was opened from, or the draft. */
  private page: Page | null = null;
  private pageBack: number | null = null;
  private workOf: Work | null = null;
  private readonly pages: PageHost;
  /** Quit Harbor completely; without a background controller, closing the window is quitting. */
  onQuit: (() => void) | null = null;
  private chatId = 0;
  private draftRepo: number | null = null;
  /** The draft is the project's page: its first message starts the project's main chat. */
  private draftMain = false;
  /** Projects whose folder is on another PC for which This PC was picked in the draft's Runs on. */
  private draftHere = new Set<number>();
  private sel: Sel;
  private opened = new Map<number, Opened>();
  private drafts = new Map<number, string>();
  private query = "";
  private rows = new slint.ArrayModel<SideRow>([]);
  private settledRows = new slint.ArrayModel<SideRow>([]);
  private cards = new slint.ArrayModel<CardData>([]);
  private liveBlocks = new slint.ArrayModel<MdBlockData>([]);
  private bare = new WeakMap<CardData, CardData>();
  /** Per draft: tokens picked from the composer's menus, which Backspace and Delete erase whole (usertext `whole`). */
  private pickedTokens = new Map<number, string[]>();
  private files = new slint.ArrayModel<{ name: string; image: boolean }>([]);
  private menu = new slint.ArrayModel<MenuEntry>([]);
  private popItems = new slint.ArrayModel<PopItem>([]);
  private readonly popEsc = new EscHold();
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
  private videoPane: VideoPane | null = null;
  private gitStatus = new Map<number, git.Status | null>();
  private gitRunning = new Set<number>();

  /** Images in the transcript, once the media package is loaded. */
  useMedia(pkg: typeof import("@harbor/media")): void {
    this.media = pkg;
    this.images = new pkg.images.Images();
    this.images.onChange(() => this.refreshLightbox());
    this.videoPane = new VideoPane({
      win: this.win,
      pkg,
      images: this.images,
      store: this.data.store,
      toast: (m) => this.toast(m),
      open: (file) => void Bun.spawn(["xdg-open", file], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
      ...(this.hub.player ? { source: this.hub.player } : {}),
    });
    this.voice = new pkg.voiceCtl.VoiceCtl({
      store: this.data.store,
      mesh: this.data.voiceMesh,
      insert: (key, text) => this.insertDictation(key, text),
      toast: (m) => this.toast(m),
      wake: () => this.refreshVoice(),
      account: () => {
        // As voice.rs: not while the account is blocked by a usage limit.
        const a = this.data.accounts.find((x) => x.id === "claude" && x.bin !== null && x.loggedIn === true && this.engine.limits.blocked(x.id) === undefined);
        return a ? (system, prompt, ms) => recap.askWithin(providers.binStr(a), providers.accountEnv(a), system, prompt, ms) : null;
      },
    });
    this.voice.load();
    this.refreshVoice();
    this.mediaRows = new MediaRows(pkg, () => this.changed(this.chatId), (p) => this.nativeImage(p));
    // A Discord join that waits on a captcha comes up over the window for the person to solve.
    this.captcha = new CaptchaPane(this.win, async (b) => (await pkg.images.decodeBytes(b, 1280)).image);
    this.captcha.start();
  }
  private captcha: CaptchaPane | null = null;
  /** HARBOR_FAKE_CAPTCHA (screenshots): a captcha card with no Discord. */
  private readonly fakeCap = fakeCaptcha();
  private readonly chatCap: ChatCaptcha;
  private media: typeof import("@harbor/media") | null = null;
  private voice: import("@harbor/media").voiceCtl.VoiceCtl | null = null;
  private images: import("@harbor/media").images.Images | null = null;
  private voiceTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private zoomer!: Zoom;
  private zoomCards: ReturnType<typeof setTimeout> | null = null;
  private readonly surfaces = new Surfaces<Terminal>({
    spawn: (title, cwd, argv) => {
      try {
        return new Terminal(title, cwd, argv, { PATH: providers.childPath() }, () => this.termWake());
      } catch (e) {
        this.dialog("Couldn't open a terminal", e instanceof Error ? e.message : String(e), "OK", false, null, () => {});
        return null;
      }
    },
    changed: () => this.refreshPanes(),
    focus: (d, terminal) => setTimeout(() => this.win.focus_pane(d, terminal), 30),
  });
  private readonly prs: chatpr.ChatPrs;
  private readonly workspaces: () => Workspaces;
  private readonly hub: ShellHub;
  private readonly meshChat: MeshChat;
  private viewing: { id: number; focused: boolean } | null = null;
  private shownProjects: number[] = [];
  private selection: { seq: number; text: string } | null = null;
  private selButton: SelectionButton | null = null;
  private selTimer: ReturnType<typeof setTimeout> | null = null;
  private selHover = false;
  private noteFocus: Mention | null = null;
  private readonly deviceRows = new slint.ArrayModel<DeviceRow>([]);
  private readonly transferRows = new slint.ArrayModel<TransferRow>([]);
  private transfers: DeviceTransfer[] = [];
  private paired: PairedDevice[] = [];
  private readonly fileRows: Record<Dock, slint.ArrayModel<FileRow>> = { right: new slint.ArrayModel<FileRow>([]), bottom: new slint.ArrayModel<FileRow>([]) };
  private readonly fileTransfers: Record<Dock, slint.ArrayModel<TransferRow>> = { right: new slint.ArrayModel<TransferRow>([]), bottom: new slint.ArrayModel<TransferRow>([]) };
  private readonly thumbs = new Map<string, Pixels | null>();
  private readonly servers = new slint.ArrayModel<string>([]);
  private engines = 0;
  private browserQueued = false;
  private readonly paneTabs: Record<Dock, slint.ArrayModel<SurfaceTab>> = { right: new slint.ArrayModel<SurfaceTab>([]), bottom: new slint.ArrayModel<SurfaceTab>([]) };
  /** Each pane's terminal grid, rows and columns, as its view last measured it. */
  private readonly gridOf: Record<Dock, [number, number] | null> = { right: null, bottom: null };
  private termQueued = false;
  private stripFold = new Map<number, boolean>();
  private popActions: (() => void)[] = [];
  private dialogAction: ((ok: boolean, input: string) => void) | null = null;
  private cardsDirty = false;
  private menus = new ComposerMenus();
  private mentions = new Map<number, Mention[]>();
  private attached = new Map<number, string[]>();
  /** queue.rs `Edit`: the queued message in the composer, and the draft set aside meanwhile. */
  private queueEdit: { chat: number; id: number; original: string; aside: Draft } | null = null;
  private unfolded = new Set<number>();
  private mentionChips = new slint.ArrayModel<{ head: string; snippet: string; tip: string; note: string; hint: string; focus: boolean }>([]);

  constructor(win: AppWindow, data: Data, hub: ShellHub) {
    this.win = win;
    this.data = data;
    this.prs = hub.prs;
    this.workspaces = hub.workspaces;
    this.hub = hub;
    this.meshChat = new MeshChat(hub.mesh ?? solo, {
      restore: (chat, text, mentions, append) => this.restoreSend(chat, text, mentions, append),
      changed: () => this.refreshAll(),
      opened: (id) => {
        this.data.reload();
        this.openChat(id);
      },
    });
    // The open chat's Discord captcha card: frames while it's on screen, from this PC's Discord or the chat's home PC.
    const mesh = hub.mesh ?? solo;
    win.chat_cap = noChatCaptcha;
    this.chatCap = new ChatCaptcha({
      call: this.fakeCap?.call ?? ((c, body) => (c.home === "" ? hereCaptcha(c.id, body) : mesh.forward(c, "POST", ["captcha"], body))),
      chat: () => (this.view === "chat" && this.page === null ? this.data.chat(this.chatId) : undefined),
      looking: () => win.window.visible && !win.window.minimized,
      decode: async (b) => (this.media ? (await this.media.images.decodeBytes(b, Math.round(FRAME_W * 2 * win.scale_factor))).image : null),
      me: () => {
        const host = hostname().split(".")[0] ?? "";
        return { who: mesh.me() || `pc:${host}`, label: mesh.myName?.() || host };
      },
      show: (d) => (win.chat_cap = d),
      image: (p) => (win.chat_cap_frame = p),
      changed: () => this.refreshCards(),
      scale: () => win.scale_factor,
    });
    win.chat_cap_seen = (id, on, w) => this.chatCap.seen(id, on, w);
    win.chat_cap_pointer = (id, kind, fx, fy) => this.chatCap.pointer(id, kind, fx, fy);
    win.chat_cap_cancel = (id) => this.chatCap.cancel(id);
    // A default saved on a provider Harbor dropped reads as Claude's defaults.
    const dropped = !providers.knownAccount(data.store.get("default_account") ?? "claude");
    const get = (k: string, d: string) => (dropped ? d : (data.store.get(k) ?? d));
    const model = get("default_model", "claude-opus-5-5");
    this.sel = {
      account: get("default_account", "claude"),
      model: model === "opus" || model === "" ? "claude-opus-5-5" : model === "sonnet" ? "claude-sonnet-5-5" : model === "haiku" ? "claude-haiku-5-5" : model,
      effort: get("default_effort", providers.defaultEffort("Claude")),
      access: get("default_access", "full"),
      device: get("default_device", ""),
    };
    this.mode = parseMode(get("theme", ""));
    this.stamp = omarchyStamp(homedir());
    this.dark = resolveDark(this.mode, homedir());
    win.dark = this.dark;
    win.compact = data.store.get("density") === "compact";
    win.side_rows = this.rows;
    win.side_settled = this.settledRows;
    win.cards = this.cards;
    win.live_blocks = this.liveBlocks;
    win.files = this.files;
    win.menu = this.menu;
    win.pop_items = this.popItems;
    win.picker_rail = this.railItems;
    win.strip_rows = this.stripRows;
    win.mentions = this.mentionChips;
    win.picker_rows = this.modelRows;
    this.favorites = new Favorites(data.store);
    this.keys = Keys.load(data.store);
    this.zoomer = new Zoom(
      {
        scale: () => win.scale_factor,
        setScale: (scale) => {
          // Slint takes the new scale as if the display had changed it, then the same pixels as a new logical size.
          const w = win.window;
          w.dispatchEvent({ type: "scale-factor-changed", scaleFactor: scale });
          const p = w.physicalSize;
          if (p.width > 0 && p.height > 0) w.dispatchEvent({ type: "resized", size: { width: p.width / scale, height: p.height / scale } });
          w.requestRedraw();
        },
        level: (l) => (win.zoom_level = l),
        changed: () => {
          // Images were decoded for the old scale: decode them again once the keys stop.
          if (this.zoomCards !== null) clearTimeout(this.zoomCards);
          this.zoomCards = setTimeout(() => {
            this.zoomCards = null;
            this.refreshCards();
          }, 300);
        },
      },
      data.store,
    );
    this.pages = new PageHost({
      win,
      data,
      keys: this.keys,
      show: (p) => this.openPage(p),
      leave: () => this.leavePage(),
      dark: () => this.dark,
      theme: (dark, compact) => this.applyTheme(dark, compact),
      toast: (m) => this.toast(m),
      hub: () => this.hub,
      openExternal: (url) => this.openExternal(url),
      openChat: (id) => this.openChat(id),
      draftWith: (project, text) => {
        this.newDraft(project);
        this.win.draft = text;
        this.drafts.set(DRAFT, text);
      },
      composer: () => ({ account: this.sel.account, model: this.sel.model, effort: this.sel.effort }),
      ask: (title, text, ok, act) => this.dialog(title, text, ok, false, "", (yes, input) => yes && act(input)),
      remote: (repo) => this.gitStatus.get(repo)?.remote ?? null,
      work: () => (this.workOf ??= new Work(this.engine)),
      dictation: () => this.dictation,
      quit: () => (this.onQuit ? this.onQuit() : this.win.hide()),
      terminal: (title, cwd, argv) => this.surfaces.openTerminal(title, cwd, argv),
      projectDir: (id) => {
        const r = this.data.repos.find((x) => x.id === id);
        return r ? (r.local ?? r.path) : null;
      },
    });
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
    w.add_project = () => this.addProject();
    w.settle = (id, on) => this.setSettled(id, on);
    w.settle_project = (id, on) => this.settleProject(id, on);
    w.snooze = (key, x, y) => this.snoozeMenu(key, x, y);
    w.chat_menu = (id, x, y) => this.chatMenu(id, x, y);
    w.project_menu = (id, x, y) => this.projectMenu(id, x, y);
    w.searched = (q) => {
      this.query = q;
      this.refreshSidebar();
    };
    w.palette = () => this.openPalette();
    w.filter = (x, y) => this.filterMenu(x, y);
    w.usage = (x, y) => (w.pop_id === "usage" ? this.closePopup() : this.usageMenu(x, y));
    w.ws_filter = (x, y) => (w.pop_id === "workspace" ? this.closePopup() : this.wsMenu(x, y));
    w.ws_all = () => this.setWsFilter("");
    w.reorder = (id, target, above) => this.reorder(id, target, above);
    w.sel_mention = () => {
      const s = this.selection;
      this.selection = null;
      w.sel_shown = false;
      if (s) this.cardAction(s.seq, "excerpt", s.text);
    };
    w.sel_hover = (on) => {
      this.selHover = on;
      this.stepSelButton();
    };
    w.devices = this.deviceRows;
    w.transfers = this.transferRows;
    w.device_send = (key, x, y) => this.deviceMenu(key, x, y);
    w.device_terminal = (d, key) => this.deviceTerminal(d === "right" ? "right" : "bottom", key);
    w.device_files = (d, key) => this.deviceFiles(d === "right" ? "right" : "bottom", key);
    w.right_file_rows = this.fileRows.right;
    w.bottom_file_rows = this.fileRows.bottom;
    w.right_file_transfers = this.fileTransfers.right;
    w.bottom_file_transfers = this.fileTransfers.bottom;
    w.browser_servers = this.servers;
    w.browser_nav = (d, a) => this.browserNav(dock(d), a);
    w.browser_go = (d, u) => this.browserGo(dock(d), u);
    w.browser_missing = (d) => this.browserMissing(dock(d));
    w.browser_resized = (d, pw, ph) => this.engineOf(dock(d))?.resize(Math.round(pw), Math.round(ph));
    w.browser_pointer = (d, kind, x, y, button) => {
      const e = this.engineOf(dock(d));
      if (kind === "move") e?.send({ t: "move", x, y });
      else e?.send({ t: "button", x, y, button, down: kind === "down" });
      if (kind === "down") e?.send({ t: "focus", on: true });
    };
    w.browser_wheel = (d, x, y, dx, dy) => this.engineOf(dock(d))?.send({ t: "wheel", x, y, dx, dy });
    w.browser_key = (d, text, down, ctrl, shift, alt, meta) => {
      const e = this.engineOf(dock(d));
      for (const m of keyMessages(text, down, { ctrl, shift, alt, meta })) e?.send(m);
    };
    w.files_act = (d, a, i) => this.filesAct(d === "right" ? "right" : "bottom", a, i);
    w.files_go = (d, p) => {
      const fb = this.filesOf(d === "right" ? "right" : "bottom");
      if (fb && p.trim() !== "") fb.go(p.trim());
    };
    w.device_settings = () => void this.pages.openSettings("devices");
    w.transfers_clear = () => {
      this.transfers = clearDeviceTransfers(this.transfers);
      this.refreshDevices();
    };
    w.settings = () => void this.pages.openSettings();
    w.prs = () => this.pages.openPrs();
    w.issues = () => this.pages.openIssues();
    w.leave_page = () => this.leavePage();
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
      if (this.meshChat.stop(this.data.chat(id))) return;
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
      if (seq === EARLIER) return this.loadEarlier();
      toggleCard(this.openedOf(this.chatId), seq);
      this.refreshCards();
    };
    w.transcript_near_top = () => this.loadEarlier();
    w.link = (url) => this.openLink(url);
    w.open_url = (url) => this.openExternal(url);
    w.card_act = (seq, a) => this.cardAction(seq, a);
    w.queue_menu = (qid, x, y) => this.queueMenu(qid, x, y);
    w.right_tabs = this.paneTabs.right;
    w.bottom_tabs = this.paneTabs.bottom;
    const dock = (d: string): Dock => (d === "right" ? "right" : "bottom");
    w.pane_toggle = (d) => this.surfaces.toggleDock(dock(d));
    w.pane_add = (d) => this.surfaces.add(dock(d));
    w.pane_open = (d, i) => this.surfaces.open(dock(d), i);
    w.pane_close = (d, i) => this.surfaces.close(dock(d), i);
    w.pane_max_toggle = (d) => this.surfaces.toggleMax(dock(d));
    w.pane_hide = (d) => this.surfaces.hide(dock(d));
    w.pane_pick = (d, k) => this.pickSurface(dock(d), k);
    w.pane_recent = (d, x, y) => this.browserMenu(dock(d), x, y);
    w.term_key = (d, k, text, ctrl, alt, shift) => this.termOf(dock(d))?.key(k === "none" ? { text } : k, { ctrl, alt, shift });
    w.term_paste = (d) => {
      const p = Bun.spawnSync(["wl-paste", "-n"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      if (p.exitCode === 0) this.termOf(dock(d))?.paste(p.stdout.toString());
    };
    w.term_wheel = (d, n) => {
      this.termOf(dock(d))?.wheel(n);
      this.termWake();
    };
    w.term_resized = (d, width, height, cw, rh) => {
      if (cw <= 0 || rh <= 0) return;
      this.gridOf[dock(d)] = gridSize(width, height, cw, rh);
      this.fitTerm(dock(d));
    };
    w.open_media = (path) => this.openImage(path);
    w.cap_pointer = (kind, x, y) => this.captcha?.pointer(kind, x, y);
    w.cap_wheel = (x, y, dy) => this.captcha?.wheel(x, y, dy);
    w.cap_show = (shown) => this.captcha?.show(shown);
    w.cap_cancel = () => this.captcha?.cancel();
    w.lb_close = () => this.images?.close();
    w.lb_go = (i) => this.images?.goTo(i);
    w.lb_copy_image = () => void this.copyShownImage();
    w.lb_copy_path = () => {
      const key = this.images?.openKey();
      if (key) void this.media?.clipboard.copyTextNoticed(key);
    };
    w.edited = (t) => {
      const before = this.drafts.get(this.key()) ?? "";
      this.drafts.set(this.key(), t);
      if (this.followImages(before, t)) return;
      if (this.view === "chat") this.meshChat.typed(this.chatId, t.trim() !== "" || (this.mentions.get(this.chatId) ?? []).length > 0, { text: t, mentions: this.mentions.get(this.chatId) ?? [] });
      setTimeout(() => this.refreshMenu(), 0);
    };
    w.key = (e) => this.composerKey(e);
    w.send = () => this.send();
    w.resume_reply = () => this.resumeReply();
    w.stop = () => this.stop(this.chatId);
    w.attach = () => void this.attach();
    w.mic = () => this.mic();
    w.remove_file = (i) => {
      const key = this.key();
      const r = dropFile(this.win.draft, this.attached.get(key) ?? [], i, utf16At(this.win.draft, this.win.cursor));
      this.attached.set(key, r.files);
      if (r.text !== this.win.draft) this.composerText(r.text, r.cursor);
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
    w.nav_key = (e) => this.navKey(e, true);
    w.zoom = (step) => this.zoomer.key(step);
    w.scale_changed = (scale) => this.zoomer.scaleChanged(scale);
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
    w.note_edited = (i, t) => {
      const m = this.messageMentions()[i];
      if (m) m.note = t;
    };
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
      if (this.meshChat.stop(this.data.chat(id))) return;
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
    w.strip_stop_all = () => {
      const lead = this.chatId;
      const n = this.engine.liveSubs(lead).length;
      const subs = n === 1 ? "1 running sub-agent" : `${n} running sub-agents`;
      const title = this.engine.live(lead) ? `Stop the main agent and ${subs}?` : `Stop ${subs}?`;
      this.dialog(title, "Sub-agent queues are cleared; your queued messages wait until you resume. Finished work and transcripts stay.", "Stop all", true, null, (ok) => {
        if (!ok) return;
        // A copy's team runs at its home PC: each of its turns is stopped there.
        const copy = this.data.chat(lead);
        if (this.meshChat.foreign(copy)) {
          for (const [c] of this.engine.liveSubs(lead)) this.meshChat.stop(c);
          if (this.engine.live(lead)) this.meshChat.stop(copy);
        } else this.engine.stopAll(lead);
      });
      this.win.dialog_stop = true;
    };
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
    const items = this.data.items(id);
    return this.fakeCap ? this.fakeCap.items(items) : items;
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

  /** HARBOR_VIEW, for screenshots: `chat[:id]` (the last chat), `settings[:tab]` or a tab's slug, `prs`, `issues`.
   * "harbor-view shown" on stderr once the page is up: scripts/shot waits for it. */
  devView(v: string, last: number): void {
    const [name = "", arg = ""] = v.split(":");
    const tab = tabFromSlug(name === "settings" ? arg || "general" : name);
    const id = Number(arg || last);
    let shown: Promise<void> = Promise.resolve();
    if (name === "chat" && this.data.chat(id)) this.openChat(id);
    else if (tab !== null) shown = this.pages.openSettings(tab);
    else if (name === "prs") this.pages.openPrs();
    else if (name === "issues") this.pages.openIssues();
    else if (name !== "draft") console.error(`HARBOR_VIEW: no view ${v}`);
    void shown.then(() => console.error("harbor-view shown"));
  }

  openChat(id: number): void {
    if (!this.data.chat(id)) return;
    this.drafts.set(this.key(), this.win.draft);
    this.page = null;
    this.view = "chat";
    this.chatId = id;
    this.selection = null;
    this.win.sel_shown = false;
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
    this.page = null;
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
    w.view = this.page ?? this.view;
    const repo = chat ? (chat.repoId === null ? undefined : this.data.repo(chat.repoId)) : this.draftRepo === null ? undefined : this.data.repo(this.draftRepo);
    const parent = chat?.role === "sub" && chat.parent !== null ? this.data.chat(chat.parent) : undefined;
    const st = repo ? this.gitOf(repo.id) : null;
    w.crumbs = {
      icon: repo ? ICONS.FOLDER : ICONS.SQUARE_DASHED,
      project: repo?.name ?? "No project",
      parent: chat?.role === "sub" ? (parent?.title ?? "Lead") : "",
      title: chat ? (chat.role === "sub" ? chat.name : chat.title) : this.draftMain ? "Main chat" : "New thread",
      branch: st?.branch ?? "",
    };
    w.team_enabled = chat?.role === "lead";
    this.refreshTeam();
    this.refreshStrip();
    const empty = chat ? this.items(chat.id).length === 0 : true;
    w.hero = this.view === "draft" || (chat?.role === "lead" && empty);
    w.hero_subtitle = chat ? `The lead plans and delegates to subagents in ${repo?.name ?? ""}.` : (repo?.name ?? "No project");
    w.hero_link = !chat;
    w.hero_note = !chat && this.draftMain ? "Starts the project's main chat: its row opens it from now on" : "";
    const away = chat ? this.meshChat.readOnly(chat) : null;
    w.read_only = chat?.role === "chat" || away !== null;
    w.read_only_text = away ?? "This is an earlier chat, kept read-only. Start a new chat in the project to continue.";
    w.read_only_action = away === null && chat?.repoId !== null && chat?.repoId !== undefined ? "New chat" : "";
    w.chat_running = chat ? this.running(chat.id) : false;
    this.refreshComposer();
    this.refreshCards();
  }

  /** The running subagents over a lead's composer (agentstrip.rs `agent_strip`). */
  private refreshStrip(): void {
    const lead = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    const subs = lead?.role === "lead" ? this.engine.liveSubs(lead.id) : [];
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
    const busy = (id: number) => ({ running: this.engine.live(id), pending: this.engine.pending.get(id)?.length ?? 0, queued: this.engine.queued(id).length, paused: this.engine.paused.has(id) });
    const subs = this.engine.subsOf(lead.id);
    const { active, settled } = teamAgents(subs, (id) => this.engine.live(id), (c) => agentSettled(busy(c.id), marks, c, t));
    const row = (c: (typeof subs)[number], isSettled: boolean): AgentRow => {
      const since = this.engine.liveSince(c.id);
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
          const [local, pub] = this.engine.hookUrl(h.token);
          const card = webhookCard(h, local, pub, t);
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

  /** While a reply streams, its blocks go to `liveBlocks` and its card row carries none. */
  private live(cards: CardData[], running: boolean): CardData[] {
    let at = -1;
    if (running) {
      for (let i = cards.length - 1; i >= 0; i--) {
        const k = cards[i]?.kind;
        if (k === "text") at = i;
        if (k !== "status" && k !== "space") break;
      }
    }
    const card = cards[at];
    if (!card) {
      if (this.win.live_seq !== -1) this.win.live_seq = -1;
      if (this.liveBlocks.length > 0) sync(this.liveBlocks, []);
      return cards;
    }
    sync(this.liveBlocks, card.blocks, sameBlock);
    if (this.win.live_seq !== card.seq) this.win.live_seq = card.seq;
    let bare = this.bare.get(card);
    if (!bare) this.bare.set(card, (bare = { ...card, blocks: [] }));
    const out = cards.slice();
    out[at] = bare;
    return out;
  }

  /** Scrolled near the top of what's built: one more page of earlier cards above, the view kept where it was. */
  private loadEarlier(): void {
    if (this.view !== "chat" || this.cards.rowCount() < 2 || this.cards.rowData(1)?.kind !== "earlier") return;
    const o = this.openedOf(this.chatId);
    if (Date.now() - o.grew < 250) return;
    const above = this.win.transcript_height;
    earlier(o);
    this.atEndSince = null;
    this.refreshCards();
    this.win.transcript_grew_above(above);
    // The page's images come in over the next moments; then the view goes back to its usual anchoring.
    if (this.anchorOff !== null) clearTimeout(this.anchorOff);
    this.anchorOff = setTimeout(() => {
      this.anchorOff = null;
      this.win.transcript_anchor_off();
    }, 3000);
  }

  /** Once the reader has been at the end of a chat for TRIM_MS, earlier pages they loaded are let go. */
  private trimEarlier(): void {
    if (this.view !== "chat" || !this.win.at_end) {
      this.atEndSince = null;
      return;
    }
    const t = Date.now();
    this.atEndSince ??= t;
    if (t - this.atEndSince < TRIM_MS) return;
    const o = this.opened.get(this.chatId);
    if (o && trim(o)) {
      this.refreshCards();
      collectSoon();
    }
  }

  private atEndSince: number | null = null;
  private anchorOff: ReturnType<typeof setTimeout> | null = null;

  private refreshCards(): void {
    const shown = this.view === "chat" ? this.chatId : null;
    if (this.cardsOf !== null && this.cardsOf !== shown) {
      this.engine.release(this.cardsOf);
      const o = this.opened.get(this.cardsOf);
      if (o && o.memo.size > PAGE) collectSoon();
      if (o) forget(o);
    }
    this.cardsOf = shown;
    if (this.view !== "chat") {
      sync(this.cards, []);
      sync(this.liveBlocks, []);
      this.win.live_seq = -1;
      this.chatCap.cards(null, []);
      this.mediaRows?.sweep();
      return;
    }
    const chat = this.data.chat(this.chatId);
    if (!chat) return;
    const follow = this.win.at_end;
    const since = this.engine.liveSince(chat.id);
    const subs = chat.role === "lead" ? this.engine.liveSubs(chat.id).length : 0;
    const status = since !== null ? `Working… ${elapsed(Math.floor((Date.now() - since) / 1000))}  ·  Esc to stop${subsRunning(subs)}` : "";
    const cwd = this.data.cwd(chat);
    const rows = this.mediaRows;
    const next = transcriptCards(this.items(chat.id), chat.role === "lead", [], this.openedOf(chat.id), status, utcOffset(), rows ? (c) => rows.rows(c, cwd, 760, this.win.scale_factor) : undefined, (id) => this.chatCap.gone(id), this.meshChat.viewer(chat), this.linkTitle());
    if (this.queueEdit?.chat === chat.id && !this.engine.queued(chat.id).some((q) => q.id === this.queueEdit?.id && !q.written)) this.queueEditEnd(false);
    const running = this.engine.running(chat.id);
    const held = this.engine.queue.held.has(chat.id);
    const queue = queueCards(
      this.engine.queued(chat.id).map((m) => ({ id: m.id, text: m.text, files: m.files.length, written: m.written, steering: m.intent !== "", note: m.note, editing: m.editing })),
      { running, steerable: running && this.engine.steering(chat.id) !== "no" && !held, held, editing: this.queueEdit?.chat === chat.id ? this.queueEdit.id : null, unfolded: this.unfolded.has(chat.id) },
    );
    rows?.sweep();
    sync(this.cards, withQueue(this.live(next, running), queue), sameCard);
    this.chatCap.cards(chat.id, next.filter((c) => c.kind === "captcha").map((c) => c.detail));
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
    const since = this.engine.teamStarted(c.id) ?? this.engine.liveSince(c.id);
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
    const ws = this.workspaces();
    const shown = picked(d.store.get("sidebar_workspace") ?? "", ws.all);
    const settledRepos = d.store.settledProjects();
    const whole = tree(ids, d.chats, d.mainChats(), (k) => snoozed.has(k) && (snoozed.get(k) ?? 0) > t, new Set(settledRepos.keys()));
    const tr = shown.length === 0 ? whole : inWorkspaces(whole, shown, ws.mine, ws.pcs, d.chats, d.store.placement());
    const list = sidebarList(tr, d.chats, d.repos, this.query);
    const clash = clashingNames(d.repos);
    // A project whose folder isn't here names its PC; one of two with a name, its folder.
    const where = (id: number, name: string): { place: string; place_pc: boolean; tip: string } => {
      const repo = d.repo(id);
      if (!repo) return { place: "", place_pc: false, tip: "" };
      const dir = tilde(repo.local ?? repo.path, homedir());
      const at = this.placeOf(id);
      return { place: placeHint(at, dir, clash.has(name)), place_pc: at !== null, tip: placeLine(at, dir) };
    };
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
        ...this.marks(c),
        tip: "",
        place: "",
        place_pc: false,
      };
    };
    for (const p of list.projects) {
      const main = d.mainChat(p.repo.id);
      const mainChat = main === null ? undefined : d.chat(main);
      const wakeUps = d.timers.some((x) => p.chats.some((c) => c.id === x.chatId) || x.chatId === main);
      const idle = projectIdle(wakeUps);
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
        worktree: "",
        worktree_tip: "",
        pr: "",
        pr_tip: "",
        ...where(p.repo.id, p.repo.name),
      });
      for (const c of p.chats) rows.push(chatRow(c, "thread"));
    }
    if (list.loose.length > 0) {
      rows.push({ kind: "label", id: 0, title: "Threads", active: false, status: blankStatus(), letter: "", avatar: noPixels, has_avatar: false, settled: false, snoozed: false, worktree: "", worktree_tip: "", pr: "", pr_tip: "", tip: "", place: "", place_pc: false });
      for (const c of list.loose) rows.push(chatRow(c, "loose"));
    }
    sync(this.rows, rows, sameSideRow);
    const projectRow = (r: { id: number; name: string }): SideRow => {
      return {
        kind: "settled-project",
        id: r.id,
        title: r.name,
        active: false,
        status: this.statusData(projectIdle(false)),
        letter: projectInitial(r.name),
        avatar: noPixels,
        has_avatar: false,
        settled: true,
        snoozed: false,
        worktree: "",
        worktree_tip: "",
        pr: "",
        pr_tip: "",
        ...where(r.id, r.name),
      };
    };
    const settledRows = [...list.settledProjects.map(projectRow), ...list.settled.map((c) => chatRow(c, "loose"))];
    sync(this.settledRows, settledRows, sameSideRow);
    const w = this.win;
    w.settled_count = settledRows.length;
    w.running = this.engine.liveCount();
    const names = ws.all.filter((x) => shown.includes(x.id)).map((x) => x.name);
    const q = this.query.trim();
    w.side_ws = ws.all.length > 0;
    w.side_ws_on = shown.length > 0;
    w.side_drag = d.store.get("order_by_activity") !== "1" && q === "" && shown.length === 0;
    this.shownProjects = list.projects.map((p) => p.repo.id);
    w.side_ws_tip = names.length === 0 ? "Workspace" : `Workspace: ${names.join(", ")}`;
    w.side_empty = list.projects.length > 0 ? "" : q !== "" ? "search" : shown.length > 0 ? (list.loose.length === 0 && list.settled.length === 0 ? "ws" : "") : d.repos.length === 0 ? "projects" : "";
    w.side_empty_desc = w.side_empty === "ws" ? `No chats of ${names.length === 1 ? names[0] : "these workspaces"} reach this PC.` : w.side_empty === "projects" ? "Add a folder or clone a repository to start." : "";
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
    this.loadIcon(repo, false);
    return null;
  }

  /** sidebar.rs `load_icon`: `refresh` looks the website's icon up again. */
  private loadIcon(repo: number, refresh: boolean): void {
    this.avatars.set(repo, null);
    const r = this.data.repo(repo);
    if (!r) return;
    void import("@harbor/media")
      .then(({ favicon }) => favicon.resolve(repo, r.local ?? r.path, r.name, refresh, !this.data.offline))
      .then((img) => {
        this.avatars.set(repo, img);
        this.refreshSidebar();
      })
      .catch(() => {});
  }

  /** sidebar.rs `pick_icon`: an image of the user's own as the project's icon. */
  private async pickIcon(repo: number): Promise<void> {
    const r = this.data.repo(repo);
    if (!r) return;
    const { favicon, picker } = await import("@harbor/media");
    const [file] = await picker.pick({ title: "Project icon", filter: ["Images", picker.IMAGES], dir: r.local ?? r.path });
    if (file !== undefined && favicon.setCustom(repo, file)) this.loadIcon(repo, false);
  }

  private setSettled(id: number, on: boolean): void {
    const c = this.data.chat(id);
    if (!c) return;
    if (this.meshChat.patch(c, { settled: on })) {
      this.engine.unread.delete(id);
      return;
    }
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
    return c ? { account: c.account, model: c.model, effort: c.effort, access: c.access, device: c.device } : this.sel;
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
      this.messageMentions().map((m) => ({ head: chipHead(m), snippet: chipSnippet(m), tip: chipTip(m, true), note: m.note, hint: noteHint(m), focus: m === this.noteFocus })),
      sameJson,
    );
  }

  /** The draft's line about its project's folder being on another PC ("" when it's here). */
  private draftLine(): string {
    const repo = this.draftRepo === null ? undefined : this.data.repo(this.draftRepo);
    const p = this.draftPlace();
    if (!repo || p === null) return "";
    return draftPlaceLine(repo.name, p, this.draftTarget() ?? (this.sel.device === "" ? null : this.sel.device)) ?? "";
  }

  private refreshComposer(): void {
    this.refreshMentions();
    const repo = this.currentRepo();
    this.win.untrusted = repo !== undefined && !this.engine.trusted(repo.id);
    const sel = this.chatSel();
    const kind = this.kind(sel);
    const acc = this.account(sel.account);
    const open = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    const copy = this.meshChat.foreign(open);
    const running = this.view === "chat" && this.running(this.chatId);
    const steer = running && (copy || this.engine.steering(this.chatId) !== "no") && this.engine.followDefault() === "steer";
    const draftEmpty = this.win.draft.trim() === "";
    const editing = this.queueEdit !== null && this.queueEdit.chat === this.key();
    const resume = this.view === "chat" && draftEmpty && this.resumable(this.chatId);
    const state: ComposerState = {
      model: this.modelLabel(kind, sel.model),
      model_tip: acc ? providers.short(acc) : kind,
      badge: acc?.badge ?? "",
      has_effort: providers.efforts(kind).length > 0,
      effort: providers.effortLabel(kind, sel.effort) + (providers.hasFast(kind) && this.data.store.get("fast_mode") === "1" ? " · Fast" : ""),
      access: providers.accessLabel(kind, sel.access),
      access_icon: sel.access === "full" ? ICONS.LOCK_OPEN : sel.access === "plan" ? ICONS.EYE : ICONS.LOCK,
      device: this.deviceLabel(kind),
      action: editing ? "update" : running && draftEmpty ? "stop" : steer ? "steer" : running ? "queue" : resume ? "resume" : "send",
      action_tip: editing
        ? "Update queued message (Enter)"
        : running && draftEmpty
          ? "Stop (Esc)"
          : steer
            ? "Click to steer, Ctrl-click or Ctrl+Enter to queue"
            : running
              ? "Queue: it runs after the current turn"
              : resume
                ? "Resume queue: the next queued message starts"
                : this.view === "chat"
                  ? this.meshChat.sendTip(this.chatId)
                  : "Send (Enter)",
      hint: "Ask for changes, send follow-ups, or attach images",
      typing: this.view === "chat" ? this.meshChat.typing(this.chatId) : "",
      notice: "",
      remote: this.view === "chat" ? this.meshChat.runsOn(open) : this.draftLine(),
      error: this.meshChat.error(this.key()),
      can_resume_reply: this.view === "chat" && !running && !resume && !editing && draftEmpty && open !== undefined && this.items(open.id).length > 0,
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
        running: this.engine.live(c.id),
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
    if (r.token !== "") this.pickedTokens.set(this.key(), withPicked(this.pickedTokens.get(this.key()) ?? [], r.token));
    const p = r.picked;
    if (p.kind === "mention") {
      const list = this.mentions.get(this.key()) ?? [];
      list.push(p.mention);
      this.mentions.set(this.key(), list);
    } else if (p.kind === "command") {
      this.harborCommand(p.command);
    }
  }

  private harborCommand(c: HarborCommand): void {
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
    }
  }

  private composerKey(e: KeyEvent): boolean {
    if (this.win.lb_open || this.win.vid_open || this.escOfViewer(e)) return this.globalKey(e);
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
    const scroll = transcriptKey(e.text, m);
    if (scroll === "up" || scroll === "down") return true;
    if ((p.key === "Backspace" || p.key === "Delete") && !p.ctrl && !p.alt && !p.shift && this.win.cursor === this.win.cursor_anchor) {
      // Picked tokens (@file, #ref, /command), mentioned chats' titles and image tokens go whole; an image's goes with its image.
      const d = this.win.draft;
      const spans = eraseSpans(d, this.pickedTokens.get(this.key()) ?? [], chatTitles(this.mentions.get(this.key()) ?? []));
      const gone = erase(d, utf16At(d, this.win.cursor), p.key === "Backspace", spans);
      if (gone) {
        this.drafts.set(this.key(), gone[0]);
        if (!this.followImages(d, gone[0], gone[1])) this.composerText(gone[0], gone[1]);
        return true;
      }
    }
    if ((p.ctrl && !p.alt && !p.shift && p.key.toLowerCase() === "v") || (p.shift && p.key === "Insert")) void this.pasteImage();
    if (this.keys.matches("voice", p) && this.win.pop_id === "") {
      this.mic();
      return true;
    }
    if (this.keys.matches("send", p)) {
      this.send(this.engine.followDefault());
      return true;
    }
    if (this.keys.matches("send_now", p)) {
      this.send(this.engine.followDefault() === "steer" ? "queue" : "steer");
      return true;
    }
    if (chat !== null && this.keys.matches("steer_queued", p)) {
      const first = this.engine.queued(chat).find((q) => !q.written && q.intent === "");
      if (first) this.engine.queuePromote(chat, first.id);
      return true;
    }
    if (chat !== null && this.win.cursor === 0 && this.keys.matches("edit_queued", p)) {
      const last = this.engine.queued(chat).findLast((q) => !q.written && q.intent === "");
      if (last) {
        this.queueEditStart(chat, last.id);
        this.refreshCards();
        return true;
      }
    }
    if (this.keys.matches("stop_turn", p)) {
      if (this.win.pop_id !== "") {
        this.closePopup();
        if (p.key === "Escape") this.popEsc.closed();
        return true;
      }
      if (this.queueEdit !== null) {
        this.queueEditEnd(false);
        this.refreshCards();
        return true;
      }
      if (chat !== null && this.running(chat)) {
        if (!this.meshChat.stop(this.data.chat(chat))) this.engine.esc(chat);
        return true;
      }
    }
    setTimeout(() => {
      this.refreshComposer();
      this.refreshMenu();
    }, 0);
    return false;
  }

  private escOfViewer(e: KeyEvent): boolean {
    return e.text === "\u{1b}" && ((this.images?.heldEsc(e.repeat) ?? false) || this.popEsc.swallow(e.repeat));
  }

  /**
   * Alt+Up / Alt+Down: the previous / next chat in the sidebar, as a click on its row opens it. Called before any
   * widget sees the key (`yield` then leaves Alt+Up to the composer while it would edit a queued message), and again
   * by the window's own keys for what nothing else took.
   */
  private navKey(e: KeyEvent, yieldQueued: boolean): boolean {
    if (this.keys.capture !== null || this.win.lb_open || this.win.vid_open || this.menu.length > 0) return false;
    const p = pressOf(e.text, e.modifiers);
    const dir = this.keys.matches("chat_prev", p) ? -1 : this.keys.matches("chat_next", p) ? 1 : 0;
    if (dir === 0) return false;
    if (yieldQueued && this.keys.matches("edit_queued", p) && this.view === "chat" && this.win.cursor === 0 && this.engine.queued(this.chatId).some((q) => !q.written && q.intent === "")) return false;
    const rows = [...this.rows, ...(this.win.settled_open ? this.settledRows : [])];
    const to = stepRow(rows, dir);
    if (to === null) return true;
    if (to.kind === "project" || to.kind === "settled-project") this.openProject(to.id);
    else this.openChat(to.id);
    this.win.side_reveal = `${to.kind}:${to.id}`;
    return true;
  }

  private globalKey(e: KeyEvent): boolean {
    if (this.escOfViewer(e)) return true;
    if (this.navKey(e, false)) return true;
    const p = pressOf(e.text, e.modifiers);
    const w = this.win;
    if (w.vid_open && this.videoPane && this.images && !p.ctrl && !p.alt) {
      const r = this.videoPane.key(p.key);
      if (r.taken) {
        if (r.previous) this.images.pressKey("prev");
        if (r.next) this.images.pressKey("next");
        if (r.close) this.images.pressKey("close");
        this.images.applyKeys();
        return true;
      }
    }
    if (w.lb_open && this.images) {
      const k = p.key === "ArrowLeft" ? "prev" : p.key === "ArrowRight" ? "next" : p.key === "Escape" ? "close" : null;
      if (k) {
        this.images.pressKey(k);
        this.images.applyKeys();
        return true;
      }
      if (p.ctrl && p.key.toLowerCase() === "c") {
        void this.copyShownImage();
        return true;
      }
    }
    if (this.keys.matches("toggle_sidebar", p)) {
      if (this.page === "settings") {
        const nav = busOf<SettingsView>(w, "SettingsBus");
        nav.nav_open = !nav.nav_open;
      } else w.sidebar_open = !w.sidebar_open;
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
    if (this.keys.matches("toggle_terminal", p)) {
      this.surfaces.toggleTerminal(this.cwdHere());
      return true;
    }
    if (this.keys.matches("toggle_browser", p)) {
      this.surfaces.toggleBrowser(this.browserUrl());
      return true;
    }
    if (p.key === "Escape" && w.pop_id !== "") {
      this.closePopup();
      this.popEsc.closed();
      return true;
    }
    const scroll = transcriptKey(e.text, e.modifiers);
    if (scroll !== null && this.page === null && this.view === "chat" && !w.lb_open && !w.vid_open && w.pop_id === "") {
      w.transcript_key(scroll);
      return true;
    }
    if (this.page !== null && w.dialog_id === "" && (p.key === "Escape" ? this.pages.esc(this.page) : this.page === "prs" && this.pages.shortcut(p))) return true;
    if (this.keys.matches("stop_turn", p) && this.view === "chat" && this.running(this.chatId)) {
      if (!this.meshChat.stop(this.data.chat(this.chatId))) this.engine.esc(this.chatId);
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

  /** The composer's text went from `before` to `text` (the cursor at `cursor`, UTF-16, or where it is): images whose tokens
   * were erased leave the message and the later numbers move down. False when nothing changed. */
  private followImages(before: string, text: string, cursor?: number): boolean {
    const key = this.key();
    const r = imagesFollow(before, text, this.attached.get(key) ?? [], cursor ?? utf16At(text, this.win.cursor));
    if (!r) return false;
    this.attached.set(key, r.files);
    this.composerText(r.text, r.cursor);
    this.refreshFiles();
    return true;
  }

  /** The composer shows `text` with the cursor at UTF-16 index `cursor`, and the draft (shared with the chat's other devices) follows. */
  private composerText(text: string, cursor: number): void {
    const key = this.key();
    this.win.draft = text;
    this.drafts.set(key, text);
    this.win.set_cursor(Buffer.byteLength(text.slice(0, cursor)));
    if (this.view === "chat") this.meshChat.typed(this.chatId, text.trim() !== "" || (this.mentions.get(this.chatId) ?? []).length > 0, { text, mentions: this.mentions.get(this.chatId) ?? [] });
    this.refreshComposer();
    setTimeout(() => this.refreshMenu(), 0);
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
    if (this.queueEdit?.chat === from) {
      this.queueEditEnd(true);
      this.refreshAll();
      return;
    }
    if (from !== DRAFT && text === "" && files.length === 0 && this.resumable(from)) {
      this.engine.queueResume(from);
      this.refreshAll();
      return;
    }
    if (text === "" && files.length === 0 && this.messageMentions().length === 0) return;
    const mentions = (this.mentions.get(from) ?? []).filter((m) => !isChat(m) || text.includes(m.title));
    const clear = (): void => {
      this.mentions.delete(from);
      this.pickedTokens.delete(from);
      this.drafts.delete(from);
      this.attached.delete(from);
      this.win.draft = "";
      this.refreshFiles();
    };
    const open = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    if (this.meshChat.foreign(open)) {
      clear();
      this.meshChat.typed(open.id, false, null);
      this.meshChat.send(open, text, files, mentions, mode);
      this.refreshAll();
      return;
    }
    const joinsMain = this.view !== "chat" && this.draftMain && this.draftRepo !== null ? this.data.mainChat(this.draftRepo) : null;
    // A project whose folder is on another PC starts its chat there (draftTarget).
    const startOn = this.view !== "chat" && joinsMain === null ? (this.draftTarget() ?? this.sel.device) : "";
    if (startOn !== "") {
      const repo = this.draftRepo === null ? undefined : this.data.repo(this.draftRepo);
      const body = { project: repo ? { name: repo.name, path: repo.path, remote: repo.remote } : null, account: this.sel.account, model: this.sel.model, effort: this.sel.effort, access: this.sel.access, text };
      if (this.meshChat.create(startOn, body, files, this.draftRepo, DRAFT, { text, mentions })) {
        clear();
        this.refreshAll();
        return;
      }
    }
    let id = this.view === "chat" ? this.chatId : DRAFT;
    if (id === DRAFT) {
      const joins = joinsMain;
      id = joins ?? this.engine.newThread(this.draftRepo, text, this.sel).id;
      if (this.draftMain && this.draftRepo !== null && joins === null) this.data.store.setMainChat(this.draftRepo, id);
      this.view = "chat";
      this.chatId = id;
      this.data.store.set("last_chat", String(id));
    }
    this.mentions.delete(from);
    this.pickedTokens.delete(from);
    this.drafts.delete(from);
    this.attached.delete(from);
    this.win.draft = "";
    this.refreshFiles();
    this.engine.send(id, text, { files, mentions, mode });
    this.refreshAll();
    setTimeout(() => this.win.scroll_to_end(), 30);
  }

  /** `p` converted once into the window's own image: read back, it's a handle the models share (a plain object of
   * pixels is copied again each time a model row is read). Falls back to `p`. */
  private nativeImage(p: Pixels): Pixels {
    try {
      this.win.image_scratch = p;
      const n = this.win.image_scratch;
      this.win.image_scratch = noPixels;
      return n.width === p.width && n.height === p.height ? n : p;
    } catch {
      return p;
    }
  }

  /** The composer's Resume: an ordinary message asking the agent to go on, sent the way Enter would. */
  private resumeReply(): void {
    if (this.view !== "chat" || this.running(this.chatId) || this.win.draft.trim() !== "" || (this.attached.get(this.chatId)?.length ?? 0) > 0) return;
    this.win.draft = RESUME_TEXT;
    this.send();
  }

  /** Stopped with messages still queued: they wait for Resume (or the next message). */
  private resumable(id: number): boolean {
    return !this.engine.running(id) && this.engine.queue.held.has(id) && this.engine.queued(id).length > 0;
  }

  private takeDraft(chat: number): Draft {
    const d = { text: this.drafts.get(chat) ?? "", files: this.attached.get(chat) ?? [], mentions: this.mentions.get(chat) ?? [] };
    this.drafts.delete(chat);
    this.attached.delete(chat);
    this.mentions.delete(chat);
    return d;
  }

  /** undo.rs `restore_draft`: `d` goes in ahead of what the composer holds; the images there move up a number. */
  restoreDraft(chat: number, d: Draft): void {
    const rest = shiftImages(this.drafts.get(chat) ?? "", imageCount(d.files));
    const text = rest.trim() === "" ? d.text : `${d.text}\n${rest}`;
    const files = [...d.files, ...(this.attached.get(chat) ?? [])];
    const mentions = [...d.mentions];
    for (const m of this.mentions.get(chat) ?? []) addMention(mentions, m);
    this.drafts.set(chat, text);
    if (files.length > 0) this.attached.set(chat, files);
    else this.attached.delete(chat);
    if (mentions.length > 0) this.mentions.set(chat, mentions);
    else this.mentions.delete(chat);
    if (this.key() !== chat) return;
    this.win.draft = text;
    this.win.set_cursor(byteAt(text, [...text].length));
    this.refreshFiles();
    this.refreshComposer();
    this.win.focus_composer();
  }

  /** The pencil (or Alt+↑): the message goes into the composer and keeps its place in the queue. */
  private queueEditStart(chat: number, id: number): void {
    if (this.queueEdit !== null) this.queueEditEnd(false);
    const m = this.engine.queued(chat).find((q) => q.id === id && !q.written);
    if (!m) return;
    this.queueEdit = { chat, id, original: m.text, aside: this.takeDraft(chat) };
    this.engine.queueUpdate(chat, id, null, null, "pc");
    this.restoreDraft(chat, { text: m.text, files: m.files, mentions: m.mentions.map(fromStore) });
  }

  /** `save` writes the composer into the message (emptied: it's removed); either way the draft set aside comes back. */
  private queueEditEnd(save: boolean): void {
    const e = this.queueEdit;
    if (e === null) return;
    this.queueEdit = null;
    if (this.key() === e.chat) this.drafts.set(e.chat, this.win.draft);
    const d = this.takeDraft(e.chat);
    const text = d.text.trim();
    const here = this.engine.queued(e.chat).some((q) => q.id === e.id && !q.written);
    if (here && save && text === "" && d.files.length === 0 && d.mentions.length === 0) {
      this.engine.queueRemove(e.chat, e.id);
    } else if (here) {
      const q = this.engine.queue.find(e.chat, e.id);
      if (save && q) q.files = d.files;
      this.engine.queueUpdate(e.chat, e.id, save ? text : null, save ? d.mentions : null, "");
    }
    this.restoreDraft(e.chat, e.aside);
    // It started or was removed meanwhile: what was changed stays in the composer.
    if (!here && text !== "" && text !== e.original.trim()) this.restoreDraft(e.chat, { ...d, text });
  }

  private queueAction(qid: number, a: string): void {
    const id = this.chatId;
    if (a === "q-remove") this.engine.queueRemove(id, qid);
    else if (a === "q-steer") this.engine.queuePromote(id, qid);
    else if (a === "q-edit") this.queueEditStart(id, qid);
    else if (a === "q-cancel") this.queueEditEnd(false);
    else if (a === "q-unfold") this.unfolded.add(id);
    this.refreshAll();
  }

  private queueMenu(qid: number, x: number, y: number): void {
    const id = this.chatId;
    const waiting = this.engine.queued(id).filter((q) => !q.written && q.intent === "");
    const n = waiting.findIndex((q) => q.id === qid);
    const move = (to: number) => () => {
      this.engine.queueMove(id, qid, to);
      this.refreshCards();
    };
    const items: (PopItem & { act: () => void })[] = [];
    if (n > 0) items.push(this.item("Move up", move(n - 1)));
    if (n >= 0 && n + 1 < waiting.length) items.push(this.item("Move down", move(n + 1)));
    if (items.length > 0) this.popup("queue", x, y, items, 160);
  }

  private stop(id: number): void {
    if (!this.meshChat.stop(this.data.chat(id))) this.engine.stop(id);
    this.refreshAll();
  }

  private tickMesh(): void {
    const open = this.view === "chat" ? this.chatId : null;
    if (this.viewing !== null && this.viewing.id !== open) {
      this.meshChat.viewed(this.viewing.id, false, false);
      this.viewing = null;
    }
    if (open === null) return;
    const focused = this.data.visible(open);
    this.meshChat.viewed(open, focused, true);
    this.viewing = { id: open, focused };
    if (this.meshChat.foreign(this.data.chat(open))) {
      this.win.chat_running = this.running(open);
      this.refreshComposer();
    }
  }

  /** Here or, for another PC's chat, on its home PC. */
  private running(id: number): boolean {
    return this.engine.running(id) || this.meshChat.running(this.data.chat(id));
  }

  /** mesh.rs `Msg::Done`: a message that didn't go comes back into its composer. */
  private restoreSend(chat: number, text: string, mentions: Mention[], append: boolean): void {
    const cur = this.key() === chat ? this.win.draft : (this.drafts.get(chat) ?? "");
    const next = append ? cur + text : cur.trim() === "" && text !== "" ? text : cur;
    this.drafts.set(chat, next);
    if ((this.mentions.get(chat) ?? []).length === 0 && mentions.length > 0) this.mentions.set(chat, mentions);
    if (this.key() === chat) this.win.draft = next;
    this.refreshComposer();
  }

  /**
   * The Engine changed chat `id` (null: several). While a reply streams, the open transcript is redrawn at most
   * every 80 ms, the rest of the window and the sidebar at most every 250 ms.
   */
  changed(id: number | null): void {
    if (id === null || (this.view === "chat" && id === this.chatId)) this.cardsDirty = true;
    this.sidebarDirty = true;
    this.schedule(80);
  }

  private schedule(ms: number): void {
    const due = performance.now() + ms;
    if (this.flush !== null) {
      if (this.flushDue <= due) return;
      clearTimeout(this.flush);
    }
    this.flushDue = due;
    this.flush = setTimeout(() => {
      this.flush = null;
      const t = performance.now();
      const slow = t - this.restAt >= 250;
      if (this.cardsDirty) {
        this.cardsDirty = false;
        if (slow) this.refreshView();
        else {
          this.refreshCards();
          this.viewDirty = true;
        }
      } else if (this.viewDirty && slow) this.refreshView();
      if (this.sidebarDirty && slow) this.refreshSidebar();
      if (slow) {
        this.restAt = t;
        this.viewDirty = false;
        this.sidebarDirty = false;
      }
      if (this.viewDirty || this.sidebarDirty) this.schedule(Math.max(80, this.restAt + 250 - t));
    }, ms);
  }

  private sidebarDirty = false;
  private flushDue = 0;
  private viewDirty = false;
  private restAt = 0;
  private flush: ReturnType<typeof setTimeout> | null = null;
  private cardsOf: number | null = null;

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

  /** Once a second: the theme, git after a turn, the Working timers (the hub ticks the Engine). */
  private wasRunning = new Set<number>();

  tick(): void {
    this.tickMesh();
    // A captcha card on screen takes frames again once the window is back.
    this.chatCap.wake();
    // devices.rs: phones' "last seen" and PCs' online state change by themselves.
    if (this.devicesShown()) this.refreshDevices();
    this.voice?.poll();
    this.followTheme();
    for (const id of this.wasRunning) {
      const repo = this.data.chat(id)?.repoId;
      if (!this.engine.running(id) && repo !== null && repo !== undefined) this.gitOf(repo, true);
    }
    this.wasRunning = new Set(this.engine.turns.keys());
    this.spin();
    this.trimEarlier();
  }

  private spin(): void {
    const g = busOf<{ driven: boolean; tick: number }>(this.win, "Spin");
    if (this.engine.liveCount() > 0) {
      if (this.spinTimer !== null) return;
      g.driven = true;
      let n = 0;
      this.spinTimer = setInterval(() => {
        g.tick = (g.tick + 1) % 24;
        if (++n % 2 === 0) this.refreshRunning();
      }, 500);
    } else if (this.spinTimer !== null) {
      clearInterval(this.spinTimer);
      this.spinTimer = null;
      g.driven = false;
    }
  }

  private spinTimer: ReturnType<typeof setInterval> | null = null;

  private refreshRunning(): void {
    if (this.engine.liveCount() === 0) return;
    if (this.view === "chat" && this.engine.live(this.chatId)) this.refreshCards();
    this.refreshSidebar();
    this.refreshTeam();
    this.refreshStrip();
  }

  // A shown row is what keeps its PR looked up: one scrolled away goes stale after SHOWN_TTL_MS.
  private marks(c: Chat): Marks {
    const dir = this.engine.worktreeOf(c);
    if (dir !== null && !this.data.offline) this.prs.want(c.id, chatpr.SHOWN_TTL_MS);
    return marksOf(dir, dir !== null && !existsSync(dir), dir === null ? null : this.prs.of(c));
  }

  /** images.rs: the clicked image in the lightbox, browsing the images of its message. */
  private openImage(path: string): void {
    const img = this.images;
    const media = this.media;
    if (!img || !media) return;
    const shows = (p: string): boolean => media.images.isImage(p) || media.media.isVideo(p);
    if (!shows(path)) {
      Bun.spawn(["xdg-open", path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return;
    }
    let group: string[] = [path];
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards.rowData(i);
      if (c?.media.some((m) => m.path === path)) group = c.media.map((m) => m.path).filter(shows);
    }
    img.openClicked(path, group);
  }

  private refreshLightbox(): void {
    const w = this.win;
    const v = this.images?.view();
    this.videoPane?.show(v?.video === true);
    if (!v || v.video) {
      w.lb_open = false;
      return;
    }
    const full = v.full?.state === "ready" ? v.full : null;
    const small = v.small?.state === "ready" ? v.small : null;
    const shown = full ?? small;
    const failed = v.full?.state === "failed" ? v.full.error : v.small?.state === "failed" ? v.small.error : "";
    const name = v.key.split("/").at(-1) ?? v.key;
    w.lb_data = {
      image: shown ? shown.image : noPixels,
      width: shown ? shown.dims[0] : 0,
      height: shown ? shown.dims[1] : 0,
      caption: shown ? `${name}  ·  ${shown.dims[0]} × ${shown.dims[1]}` : name,
      loading: shown !== null && full === null,
      error: shown ? "" : failed,
      index: v.index,
      count: v.gallery.length,
      path: v.key.startsWith("/"),
    };
    w.lb_open = true;
  }

  /** Copy image (or Ctrl+C in the lightbox): the file's bytes go to the clipboard. */
  private async copyShownImage(): Promise<void> {
    const key = this.images?.openKey();
    if (!key || !this.media) return;
    const bytes = this.images?.bytesOf(key) ?? (await Bun.file(key).bytes().catch(() => null));
    if (bytes) await this.media.clipboard.copyImageNoticed(bytes);
  }

  /** picker.rs `show_toast`: 8 seconds over the bottom edge. */
  /** worktree.rs `ws_folder_busy`: a live terminal of a pane runs in `dir` or under it. */
  terminalIn(dir: string): boolean {
    return this.surfaces.terminalIn(dir);
  }

  toast(message: string): void {
    this.win.toast = message;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.win.toast = "";
      this.toastTimer = null;
    }, 8000);
  }

  /** The window's dictation, for the Voice settings tab; null until the media package has loaded. */
  get dictation(): import("@harbor/media").voiceCtl.VoiceCtl | null {
    return this.voice;
  }

  private mic(): void {
    if (!this.voice) return this.toast("Dictation is still starting");
    void this.voice.toggle(this.key()).then(() => this.refreshVoice());
    this.refreshVoice();
  }

  private insertDictation(key: number, text: string): void {
    const spaced = this.media?.voice.insertSpaced;
    if (!spaced) return;
    if (key === this.key()) {
      const [t, c] = spaced(this.win.draft, charAt(this.win.draft, this.win.cursor), text);
      this.win.draft = t;
      this.drafts.set(key, t);
      this.win.set_cursor(byteAt(t, c));
      this.refreshComposer();
    } else {
      const d = this.drafts.get(key) ?? "";
      this.drafts.set(key, spaced(d, [...d].length, text)[0]);
    }
  }

  /** voice.rs `voice_button`'s states for this composer, redrawn every 100ms while it records or transcribes. */
  private refreshVoice(): void {
    const v = this.voice;
    const w = this.win;
    if (!v || !this.media) return;
    const key = this.key();
    const rec = v.recordingFor(key);
    const busy = v.busyFor(key);
    const shortcut = keyLabel(this.keys.get("voice"));
    const progress = this.media.voice.modelProgress();
    w.voice = rec ? "rec" : busy ? "busy" : "";
    if (rec) {
      const s = Math.floor(rec.elapsedMs / 1000);
      w.voice_level = rec.level;
      w.voice_time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      w.voice_note = progress ? `Speech model ${progress}` : "";
      w.mic_tip = `Stop and transcribe (${shortcut})`;
    } else if (busy) {
      w.voice_note = progress && v.waitingForModel() ? `Getting the speech model… ${progress}` : "Transcribing…";
    } else {
      w.mic_tip = this.media.voice.cantRecord() ?? `Dictate (${shortcut})`;
    }
    const live = v.recording !== null || v.busy !== null;
    if (live && this.voiceTimer === null) this.voiceTimer = setInterval(() => this.refreshVoice(), 100);
    if (!live && this.voiceTimer !== null) {
      clearInterval(this.voiceTimer);
      this.voiceTimer = null;
    }
    // A dictation that ended with "press enter" / "enviar": as if Enter was pressed.
    if (v.send === key && w.pop_id === "") {
      v.takeSend();
      this.send();
    }
  }

  private termOf(d: Dock): Terminal | null {
    const s = this.surfaces.showing(d);
    return s?.kind === "terminal" ? s.term : null;
  }

  private fitTerm(d: Dock): void {
    const g = this.gridOf[d];
    if (g) this.termOf(d)?.resize(g[0], g[1]);
    this.termWake();
  }

  /** A terminal's output redraws at most every 16ms. */
  private termWake(): void {
    if (this.termQueued) return;
    this.termQueued = true;
    setTimeout(() => {
      this.termQueued = false;
      for (const d of ["right", "bottom"] as const) {
        const t = this.termOf(d);
        if (!t) continue;
        const f = t.frame(this.dark);
        this.win[d === "right" ? "right_screen" : "bottom_screen"] = { lines: f.rows, cursor_row: f.cursor_row, cursor_col: f.cursor_col, cursor_text: f.cursor_text, scrolled: f.scrolled };
      }
    }, 16);
  }

  private refreshPanes(): void {
    const w = this.win;
    if (this.devicesShown()) this.refreshDevices();
    for (const d of ["right", "bottom"] as const) {
      const fb = this.filesOf(d);
      if (fb) this.refreshBrowsed(d, fb);
      this.refreshBrowser(d);
    }
    for (const d of ["right", "bottom"] as const) {
      const p = this.surfaces.panes[d];
      sync(
        this.paneTabs[d],
        p.surfaces.map((s) => ({ kind: s.kind, title: tabTitle(s) })),
        sameJson,
      );
      if (d === "right") {
        w.right_open = p.open;
        w.right_active = p.active;
      } else {
        w.bottom_open = p.open;
        w.bottom_active = p.active;
      }
      this.fitTerm(d);
    }
    w.pane_max = this.surfaces.max ?? "";
  }

  /** app.rs `cwd_here`: the open chat's folder, else the draft's project, else home. */
  private cwdHere(): string {
    const chat = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    if (chat) return this.data.cwd(chat);
    const r = this.draftRepo === null ? undefined : this.data.repo(this.draftRepo);
    return r ? (r.local ?? r.path) : homedir();
  }

  private browserUrl(): string {
    return this.data.store.get("browser_last") ?? "localhost:3000";
  }

  private pickSurface(d: Dock, key: string): void {
    if (key === "B") this.surfaces.openBrowser(this.browserUrl(), d);
    else if (key === "T") {
      const cwd = this.cwdHere();
      this.surfaces.openTerminal(basename(cwd) || "~", cwd, [], d);
    } else if (key === "M") this.surfaces.openDevices(d);
  }

  /** surface.rs: the chooser's menu of dev servers and recent pages. */
  private browserMenu(d: Dock, x: number, y: number): void {
    const read = (f: string) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return "";
      }
    };
    const ports = listeningPorts([read("/proc/net/tcp"), read("/proc/net/tcp6")], this.engine.hookPort);
    let recent: string[] = [];
    try {
      const v: unknown = JSON.parse(this.data.store.get("browser_recent") ?? "[]");
      if (Array.isArray(v)) recent = v.filter((u): u is string => typeof u === "string");
    } catch {
      // nothing recent yet
    }
    const open = (u: string) => () => this.surfaces.openBrowser(u, d);
    const items: (PopItem & { act?: () => void })[] = [{ ...this.label("Dev servers"), kind: "caption" }];
    if (ports.length === 0) items.push({ ...this.label("Nothing listening on localhost"), kind: "caption" });
    for (const p of ports) items.push(this.item(`localhost:${p}`, open(`localhost:${p}`), { icon: ICONS.GLOBE }));
    if (recent.length > 0) {
      items.push(this.separator(), { ...this.label("Recent"), kind: "caption" });
      for (const u of recent) items.push(this.item([...u.replace(/^https?:\/\//, "")].slice(0, 40).join(""), open(u), { icon: ICONS.GLOBE }));
    }
    this.popup("browser-menu", x, y, items, 260);
  }

  /** Saves what runs, so the next Harbor finds it, and stops following the turns (they go on). */
  /** The window is on the screen: this PC's zoom applies. */
  shown(): void {
    this.zoomer.shown();
  }

  shutdown(): void {
    if (this.spinTimer !== null) clearInterval(this.spinTimer);
    if (this.zoomCards !== null) clearTimeout(this.zoomCards);
    this.surfaces.dispose();
    this.videoPane?.shutdown();
    this.captcha?.stop();
    this.chatCap.stop();
    for (const [id, run] of this.engine.turns) {
      this.engine.persist(id);
      run.turn?.release();
    }
  }


  private popup(id: string, x: number, y: number, items: (PopItem & { act?: () => void })[], width = 240, above = false, native = false): void {
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
    w.pop_native = native;
    w.pop_spacing = id === "effort" || id === "usage" ? 0 : 8;
    w.pop_id = id;
  }

  private closePopup(): void {
    this.win.pop_id = "";
  }

  private item(label: string, act: () => void, extra: Partial<PopItem> = {}): PopItem & { act: () => void } {
    return { kind: "item", icon: "", label, desc: "", checked: false, enabled: true, badge: "", value: 0, ...extra, act };
  }

  private label(text: string): PopItem {
    return { kind: "label", icon: "", label: text, desc: "", checked: false, enabled: false, badge: "", value: 0 };
  }

  private separator(): PopItem {
    return { kind: "separator", icon: "", label: "", desc: "", checked: false, enabled: false, badge: "", value: 0 };
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
        rows.push({ ...this.separator(), kind: "gap" }, { ...this.separator(), kind: "rule" }, { ...this.separator(), kind: "gap" }, { ...this.label("Fast Mode"), kind: "header" });
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
        [{ ...this.label("Access"), kind: "caption" }, ...providers.access(kind).map(([k, label, detail]) => this.item(label, () => set({ access: k }), { desc: detail, checked: k === sel.access, icon: k === "full" ? ICONS.LOCK_OPEN : k === "plan" ? ICONS.EYE : ICONS.LOCK }))],
        320,
        true,
      );
    } else if (id === "device") {
      this.runOnMenu(kind, x, y);
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

  /** The chat (null: the draft) the composer's device menu is for, and the device it's on. */
  private deviceOf(): [number | null, string] {
    const c = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    return c ? [c.id, c.device] : [null, this.draftTarget() ?? this.sel.device];
  }

  /** Where project `repo`'s folder is when it isn't on this PC (null: it's here). */
  private placeOf(repo: number): Place | null {
    return this.hub.projectPlace?.(repo) ?? null;
  }

  /** The draft's project's place, when the draft starts a chat of its own in it (not its main chat). */
  private draftPlace(): Place | null {
    if (this.view !== "draft" || this.draftRepo === null) return null;
    if (this.draftMain && this.data.mainChat(this.draftRepo) !== null) return null;
    return this.placeOf(this.draftRepo);
  }

  /**
   * The PC a new chat starts on when the draft's project folder isn't here: the PC that holds it,
   * while it's on, unless a device is picked or This PC was picked for the project.
   */
  private draftTarget(): string | null {
    const p = this.draftPlace();
    if (p === null || p.pc === "" || !p.online || this.sel.device !== "" || this.draftHere.has(this.draftRepo ?? -1)) return null;
    return p.pc;
  }

  private deviceLabel(kind: string): string {
    const [chat, current] = this.deviceOf();
    // Another PC's chat: its device is that PC's ("" is that PC itself, not this one).
    const open = chat === null ? undefined : this.data.chat(chat);
    if (this.meshChat.foreign(open)) return this.meshChat.homeName(open);
    if (current === "") return "This PC";
    return this.hub.runOnRows(chat, current, kind).find((r) => r.id === current)?.name ?? "Missing device";
  }

  /** remoteui.rs `device_menu`: where the chat runs; a started chat moves where it's picked, its sessions with it. */
  private runOnMenu(kind: string, x: number, y: number): void {
    const [chat, current] = this.deviceOf();
    const open = chat === null ? undefined : this.data.chat(chat);
    if (this.meshChat.foreign(open)) {
      // Another PC's chat runs there: that PC is the place, not this one's list.
      const home = this.meshChat.homeName(open);
      this.popup("device", x, y, [{ ...this.label("Runs on"), kind: "caption" }, this.item(home, () => {}, { icon: ICONS.HOUSE, desc: "This chat's PC: it runs there", checked: true })], 300, true);
      return;
    }
    const started = chat !== null && this.data.chat(chat)?.started === true;
    const pick = (id: string) => () => {
      if (id === current) return;
      const place = chat === null ? this.draftPlace() : null;
      if (started && chat !== null) {
        void this.hub.relocate(chat, id).then(
          (name) => this.toast(`Moving to ${name}…`),
          (e: unknown) => this.toast(`Couldn't move this chat: ${e instanceof Error ? e.message : String(e)}`),
        );
      } else if (place !== null && this.draftRepo !== null && (id === "" || id === place.pc)) {
        // The project's own PC, or This PC instead of it: for this project's drafts, not the default device.
        if (id === "") this.draftHere.add(this.draftRepo);
        else this.draftHere.delete(this.draftRepo);
        if (this.sel.device !== "") this.setSel({ device: "" });
        this.refreshComposer();
      } else this.setSel({ device: id });
    };
    const rows = this.hub.runOnRows(chat, current, kind).map((r) => this.item(r.name, pick(r.id), { icon: r.id === "" ? ICONS.HOUSE : r.glyph, desc: r.desc, checked: r.current, enabled: r.enabled }));
    const items: (PopItem & { act?: () => void })[] = [{ ...this.label("Runs on"), kind: "caption" }, ...rows];
    if (rows.length === 1) items.push(this.label("No other PCs yet: pair one in Settings › Devices, or add one by SSH."));
    items.push(this.separator(), this.item("Manage devices…", () => void this.pages.openSettings("devices"), { icon: ICONS.SETTINGS }));
    this.popup("device", x, y, items, 300, true);
  }

  private setSel(patch: Partial<Sel>): void {
    if (this.view === "chat") {
      const c = this.data.chat(this.chatId);
      if (!c) return;
      if (this.meshChat.foreign(c) && patch.device === undefined) {
        const n = { account: c.account, model: c.model, effort: c.effort, access: c.access, ...patch };
        this.meshChat.patch(c, { account: n.account, model: n.model, effort: n.effort, access: n.access });
        return;
      }
      if (patch.account !== undefined) c.account = patch.account;
      if (patch.model !== undefined) c.model = patch.model;
      if (patch.effort !== undefined) c.effort = patch.effort;
      if (patch.access !== undefined) c.access = parseAccess(patch.access);
      if (patch.device !== undefined) c.device = patch.device;
      this.data.saveChat(c);
    } else {
      this.sel = { ...this.sel, ...patch };
      const s = this.sel;
      for (const [k, v] of [
        ["default_account", s.account],
        ["default_model", s.model],
        ["default_effort", s.effort],
        ["default_access", s.access],
        ["default_device", s.device],
      ] as const)
        this.data.store.set(k, v);
    }
    this.refreshComposer();
  }

  private projectPicker(x: number, y: number): void {
    const items: (PopItem & { act?: () => void })[] = [
      { ...this.label("Project"), kind: "caption" },
      this.item("No project", () => this.newDraft(null), { icon: ICONS.FOLDER, desc: "Runs in your home folder", checked: this.draftRepo === null }),
    ];
    for (const r of this.data.repos) items.push(this.item(r.name, () => this.newDraft(r.id), { icon: ICONS.FOLDER, desc: tilde(r.local ?? r.path, homedir()), checked: this.draftRepo === r.id }));
    items.push(this.separator(), this.item("Add project…", () => this.addProject(), { icon: ICONS.FOLDER_PLUS }));
    this.popup("project", x, y, items, 300);
  }

  private chatMenu(id: number, x: number, y: number): void {
    const c = this.data.chat(id);
    if (!c) return;
    const native = (label: string, act: () => void, extra: Partial<PopItem> = {}) => ({ ...this.item(label, act, extra), kind: "native" as const });
    const items: (PopItem & { act?: () => void })[] = [native("Rename", () => this.renameDialog(id)), native(c.settled ? "Unsettle" : "Settle", () => this.setSettled(id, !c.settled))];
    if (c.role === "lead" && c.repoId !== null && this.data.repo(c.repoId)) {
      items.push(native("Make main chat", () => this.makeMain(id), { desc: "The project's row opens this chat, and what you write on the project's page goes here" }));
    }
    if (c.role !== "sub") {
      let why = "";
      try {
        this.engine.movable(id);
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
      items.push(why === "" ? native("Move to project…", () => this.moveMenu(id, x, y), { badge: "submenu" }) : native("Move to project…", () => {}, { enabled: false, desc: why }));
      // movepc.rs `move_pc_menu`: greyed out with why when the chat can't go to any PC.
      const mv = this.hub.moveTargets(id);
      const off = mv.targets.length === 0 ? (mv.why ?? "No other PCs: pair one in Settings › Devices") : mv.why;
      items.push(off === null ? native("Move to PC…", () => this.movePcMenu(id, x, y), { badge: "submenu" }) : native("Move to PC…", () => {}, { enabled: false, desc: off }));
      const ws = this.hub.moves?.chatMenu(id) ?? null;
      if (ws !== null) items.push(ws.why === null ? native("Move to workspace…", () => this.wsMoveMenu("chat", id, x, y), { badge: "submenu" }) : native("Move to workspace…", () => {}, { enabled: false, desc: ws.why }));
    }
    items.push(native("Delete", () => this.deleteDialog(id)));
    this.popup("chat", x, y, items, 240, false, true);
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

  /** The PCs of the mesh the chat can move to; one that can't take it says why. */
  private movePcMenu(id: number, x: number, y: number): void {
    const go = (pc: string) => () =>
      void this.hub.movePc(id, pc).then(
        (n) => this.toast(`Moving to ${n}…`),
        (e: unknown) => this.toast(`Couldn't move this chat: ${e instanceof Error ? e.message : String(e)}`),
      );
    const items = this.hub.moveTargets(id).targets.map((t) => this.item(t.name, go(t.id), { icon: ICONS.MONITOR, desc: t.why ?? "Goes on there", enabled: t.why === null }));
    setTimeout(() => this.popup("move-pc", x, y, items, 240), 0);
  }

  /** Move to workspace…: the account's workspaces, the one it's in ticked, then back to its PC's. */
  private wsMoveMenu(kind: "chat" | "project", id: number, x: number, y: number): void {
    const m = this.hub.moves;
    const menu = m ? (kind === "chat" ? m.chatMenu(id) : m.projectMenu(id)) : null;
    if (!m || menu === null || menu.why !== null) return;
    const go = (ws: string) => () =>
      void (kind === "chat" ? m.moveChat(id, ws) : m.moveProject(id, ws)).then(
        (r) => {
          const b = (r.body ?? {}) as { notice?: unknown; error?: unknown };
          this.toast(r.status < 300 ? String(b.notice ?? "Moved") : `Couldn't move it: ${String(b.error ?? r.status)}`);
          this.data.reload();
          this.refreshAll();
        },
        (e: unknown) => this.toast(`Couldn't move it: ${e instanceof Error ? e.message : String(e)}`),
      );
    const items: (PopItem & { act?: () => void })[] = [{ ...this.label("Move to workspace"), kind: "caption" }];
    for (const it of menu.items) {
      if (it.back) items.push(this.separator());
      items.push(this.item(it.label, it.on ? () => {} : go(it.id), { icon: it.back ? ICONS.HOUSE : ICONS.USERS, desc: it.hint, checked: it.on }));
    }
    setTimeout(() => this.popup("move-ws", x, y, items, 260), 0);
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

  private projectTerminal(id: number): void {
    const r = this.data.repo(id);
    if (!r) return;
    const dir = r.local ?? r.path;
    this.surfaces.openTerminal(basename(dir), dir);
  }

  /** sidebar.rs's project row menu, egui's own context menu (logic/projectmenu.ts: the phone's sheet lists the same). */
  private projectMenu(id: number, x: number, y: number): void {
    const native = (label: string, act: () => void, extra: Partial<PopItem> = {}) => ({ ...this.item(label, act, extra), kind: "native" as const });
    const stored = this.data.repo(id)?.remote ?? "";
    const remote = this.gitStatus.get(id)?.remote ?? (stored === "" ? null : git.webUrl(stored));
    const main = this.data.mainChat(id);
    const custom = this.media !== null && existsSync(this.media.favicon.customPath(id));
    const settled = this.data.store.settledProjects().has(id);
    const acts: Record<ProjectAct, () => void> = {
      terminal: () => this.projectTerminal(id),
      prs: () => this.pages.openPrs(id),
      issues: () => this.pages.openIssues(id),
      remote: () => remote !== null && this.openExternal(remote),
      rename_main: () => main !== null && this.renameDialog(main),
      settle_main: () => main !== null && this.setSettled(main, true),
      refresh_icon: () => this.loadIcon(id, true),
      choose_icon: () => void this.pickIcon(id),
      website_icon: () => {
        void import("@harbor/media").then(({ favicon }) => {
          favicon.clearCustom(id);
          this.loadIcon(id, false);
        });
      },
      settle_project: () => this.settleProject(id, true),
      unsettle_project: () => this.settleProject(id, false),
      move_workspace: () => this.wsMoveMenu("project", id, x, y),
      move_pc: () => void this.projectMovePc(id, x, y),
      remove: () => this.removeRepoDialog(id),
    };
    const ws = this.hub.moves?.projectMenu(id) ?? null;
    const items: (PopItem & { act?: () => void })[] = [];
    // A project whose folder is on another PC says which, over its options.
    const place = this.placeOf(id);
    const r = this.data.repo(id);
    if (place !== null && r) items.push({ ...this.label(placeLine(place, tilde(r.local ?? r.path, homedir()))), kind: "caption" });
    for (const it of projectMenu({ remote, main: main !== null, customIcon: custom, settled, ...(ws ? { moveWhy: ws.why } : {}), moving: this.hub.projectMoving?.(id) ?? null })) {
      if (it.sep) items.push(this.separator());
      const extra: Partial<PopItem> = {};
      if (it.icon !== "") extra.icon = it.icon;
      if (it.desc !== "") extra.desc = it.desc;
      if (it.off === true) extra.enabled = false;
      if (it.act === "move_workspace") extra.badge = it.off === true ? "" : "submenu";
      items.push(native(it.label, acts[it.act], extra));
    }
    this.popup("project-row", x, y, items, 260, false, true);
  }

  /** A project's Move to PC… (projectmoverun.ts through `hub.projectMove`): its state if one runs, else the PCs, the confirmation, then the move with its progress in the toast. */
  private async projectMovePc(id: number, x: number, y: number): Promise<void> {
    const call = this.hub.projectMove;
    if (!call) return;
    const name = this.data.repo(id)?.name ?? "Project";
    const ask = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const r = await call(id, body);
      const b = typeof r.body === "object" && r.body !== null && !Array.isArray(r.body) ? (r.body as Record<string, unknown>) : {};
      if (r.status >= 300) throw new Error(typeof b.error === "string" ? b.error : "it didn't work");
      return b;
    };
    const fail = (e: unknown) => this.dialog(`Couldn't move ${name}`, e instanceof Error ? e.message : String(e), "OK", false, null, () => {});
    try {
      const st = await ask({ step: "status" });
      if (st.state === "running") {
        this.dialog(`Moving ${name} to ${String(st.to_name)}`, `${String(st.stage)}\n\nIt goes on by itself; this menu says how far it is.`, "OK", false, null, () => {});
        return;
      }
      const t = await ask({ step: "targets" });
      const targets = (Array.isArray(t.targets) ? t.targets : []) as { id: string; name: string; why: string | null }[];
      if (targets.length === 0 || (typeof t.why === "string" && t.why !== "")) {
        fail(new Error(typeof t.why === "string" && t.why !== "" ? t.why : "No other PCs: pair one in Settings › Devices"));
        return;
      }
      const go = (pc: string) => () =>
        void (async () => {
          try {
            this.toast(`Reading ${name}…`);
            const plan = await ask({ step: "plan", to: pc });
            this.dialog(String(plan.title), String(plan.text), String(plan.ok ?? "Move"), false, null, (yes) => {
              if (!yes) return;
              void ask({ step: "start", to: pc }).then(
                (r) => {
                  this.toast(`Moving ${name} to ${String(r.to)}…`);
                  // Asked of the PC the move runs on: the project may leave this PC's list meanwhile.
                  const where = typeof r.ask === "object" && r.ask !== null ? (r.ask as Record<string, unknown>) : {};
                  this.followProjectMove(id, name, (b) => ask({ ...b, ...where }));
                },
                fail,
              );
            });
          } catch (e) {
            fail(e);
          }
        })();
      const items = targets.map((pc) => this.item(pc.name, go(pc.id), { icon: ICONS.MONITOR, desc: pc.why ?? "Goes there with its chats", enabled: pc.why === null }));
      setTimeout(() => this.popup("move-pc", x, y, items, 260), 0);
    } catch (e) {
      fail(e);
    }
  }

  /** The move's progress in the toast while it runs, then its result. */
  private followProjectMove(id: number, name: string, ask: (b: Record<string, unknown>) => Promise<Record<string, unknown>>): void {
    let misses = 0;
    const tick = () =>
      void ask({ step: "status" }).then(
        (st) => {
          misses = 0;
          const to = String(st.to_name ?? "");
          if (st.state === "running") {
            this.toast(`${name} → ${to}: ${String(st.stage)}`);
            setTimeout(tick, 1500);
            return;
          }
          if (st.state === "none") return;
          this.data.reload();
          this.refreshAll();
          this.dialog(projectMoveTitle(String(st.state), name, to), String(st.result ?? ""), "OK", false, null, () => {});
        },
        () => {
          if (++misses < 20) setTimeout(tick, 3000);
        },
      );
    setTimeout(tick, 1000);
  }

  /** The window's icon of project `repo` again (a phone changed it). */
  reloadIcon(repo: number, refresh: boolean): void {
    this.loadIcon(repo, refresh);
  }

  /** sidebar.rs `snooze_menu`: presets, a time typed by hand with its preview, Unsnooze. */
  private snoozeMenu(key: string, x: number, y: number): void {
    const t = now();
    const off = utcOffset();
    const apply = (until: number | null) => this.data.setSnooze(key, until, this.refreshAllBound);
    const items: (PopItem & { act?: () => void })[] = [{ ...this.label("Snooze until"), kind: "caption" }];
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
    this.popup("snooze", x, y, items, 220);
  }

  private refreshAllBound = (): void => this.refreshAll();

  /** The sidebar gauge's read-out, on numbers read now. */
  private usageMenu(x: number, y: number): void {
    const rows = usageRows(this.engine.usageReadings(), now());
    this.popup("usage", x, y, rows.map((r) => ({ icon: "", checked: false, enabled: false, ...r })), 300, true);
  }

  private filterMenu(x: number, y: number): void {
    const byActivity = this.data.store.get("order_by_activity") === "1";
    const order = (on: boolean) => () => {
      this.data.store.set("order_by_activity", on ? "1" : "0");
      this.refreshSidebar();
    };
    this.popup("filter", x, y, [{ ...this.label("Order projects"), kind: "caption" }, this.item("Manual", order(false), { icon: ICONS.GRIP, desc: "Drag projects to reorder", checked: !byActivity }), this.item("Last activity", order(true), { icon: ICONS.ACTIVITY, desc: "Most recent first", checked: byActivity })], 260);
  }


  /** sidebar.rs `ws_filter_menu`: a checklist that stays open, All then the account's workspaces. */
  private wsMenu(x: number, y: number): void {
    const ws = this.workspaces();
    const stored = this.data.store.get("sidebar_workspace") ?? "";
    const shown = picked(stored, ws.all);
    const pick = (ids: string) => () => {
      this.setWsFilter(ids);
      this.wsMenu(x, y);
    };
    const items = [
      { ...this.label("Workspace"), kind: "caption" as const },
      this.item("All", pick(""), { icon: ICONS.LAYERS, desc: "Every chat on this PC", checked: shown.length === 0 }),
      ...ws.all.map((x) => this.item(x.name, pick(toggled(stored, x.id, ws.all)), { icon: ICONS.USERS, desc: x.id === ws.mine ? "This PC's workspace" : "", checked: shown.includes(x.id) })),
    ];
    this.popup("workspace", x, y, items, 260);
  }

  private reorder(dragged: number, target: number, above: boolean): void {
    reordered(this.shownProjects, dragged, target, above).forEach((id, sort) => this.data.store.saveRepoMeta({ id, sort }));
    this.engine.reload();
    this.refreshSidebar();
  }

  private devicesShown(): boolean {
    return (["right", "bottom"] as const).some((d) => this.surfaces.panes[d].open && this.surfaces.showing(d)?.kind === "devices");
  }

  private refreshDevices(): void {
    const { list, served } = this.hub.devices();
    this.paired = list;
    const online = list.filter((d) => d.online).length;
    const w = this.win;
    w.devices_summary = `${online} of ${list.length} online`;
    sync(
      this.deviceRows,
      list.map((d) => ({ key: d.key, name: d.name, phone: isPhoneDevice(d), online: d.online, details: deviceDetails(d, served), can_send: deviceCanSend(d) })),
      sameJson,
    );
    sync(
      this.transferRows,
      [...this.transfers].reverse().map(transferRow),
      sameJson,
    );
    w.transfers_clearable = this.transfers.some((x) => x.done || x.error !== null);
  }

  /** devices.rs `send_menu_ui`: what goes to a device, and the text box for its clipboard. */
  private deviceMenu(key: string, x: number, y: number): void {
    const d = this.paired.find((p) => p.key === key);
    if (!d) return;
    const pick = (kind: DeviceSendKind, title: string, images: boolean, multiple: boolean) => () =>
      void import("@harbor/media").then(async ({ picker }) => {
        const files = await picker.pick({ title, multiple, ...(images ? { filter: ["Images", picker.IMAGES] as const } : {}) });
        if (files.length > 0) this.sendToDevice(d, kind, null, files);
      });
    const note = sendMenuNote(d);
    const items = [
      { ...this.label(`Send to ${d.name}`), kind: "caption" as const },
      this.item("Text to clipboard", () => this.deviceText(d, x, y), { icon: ICONS.CLIP }),
      this.item("File", pick("file", "Send files", false, true), { icon: ICONS.FILE }),
      this.item("Image", pick("image", "Send images", true, true), { icon: ICONS.IMAGE }),
      this.item("Image to clipboard", pick("clip-image", "Image to clipboard", true, false), { icon: ICONS.FILE_IMAGE }),
      ...(note === null ? [] : [{ ...this.label(note), kind: "caption" as const }]),
    ];
    this.popup("device-send", x, y, items, 240);
  }

  private deviceText(d: PairedDevice, x: number, y: number): void {
    const w = this.win;
    w.pop_input = "";
    w.pop_input_accept = () => {
      const text = w.pop_input;
      if (text === "") return;
      this.closePopup();
      this.sendToDevice(d, "text", text, []);
    };
    this.popup("device-text", x, y, [{ ...this.label(`Text for ${d.name}'s clipboard`), kind: "caption" }, { kind: "textbox", icon: "", label: "Send", desc: "Type or paste text", checked: false, enabled: true, badge: "", value: 0 }], 300);
  }

  private sendToDevice(d: PairedDevice, kind: DeviceSendKind, text: string | null, files: string[]): void {
    void deviceSend(d, kind, text, files, this.transfers, { ...this.hub.deviceEnv, wake: () => this.refreshDevices() });
    this.refreshDevices();
  }

  /** devices.rs `Action::Files`: a PC's files over ssh, in a new tab. */
  private deviceFiles(d: Dock, key: string): void {
    const dev = this.paired.find((p) => p.key === key);
    const host = dev ? this.hub.deviceHost(dev) : null;
    if (!dev || !host) return;
    const home = homedir();
    this.surfaces.openFiles(d, new FileBrowser(dev, host.ssh, null, { home, downloads: () => deviceDownloadsDir(home), wake: () => this.refreshPanes() }));
  }

  private filesOf(d: Dock): FileBrowser | null {
    const s = this.surfaces.showing(d);
    return s?.kind === "files" && s.files instanceof FileBrowser ? s.files : null;
  }

  private thumbOf(local: string): Pixels | null {
    const got = this.thumbs.get(local);
    if (got !== undefined) return got;
    const media = this.media;
    if (!media) return null;
    this.thumbs.set(local, null);
    media.images
      .decode(local, null, media.images.THUMB_PX)
      .then(({ image }) => {
        this.thumbs.set(local, image);
        this.refreshPanes();
      })
      .catch(() => {});
    return null;
  }

  private refreshBrowsed(d: Dock, fb: FileBrowser): void {
    const rows = fb.shown().map((e) => {
      const image = !e.dir && deviceIsImage(e.name);
      const local = image ? fb.preview(fb.join(e.name), e.size, e.mtime) : null;
      const thumb = local === null ? null : this.thumbOf(local);
      return { name: e.name, dir: e.dir, image, meta: e.dir ? "" : deviceHumanSize(e.size), thumb: thumb ?? noPixels, has_thumb: thumb !== null };
    });
    fb.pumpPreviews();
    const transfers = [...fb.transfers].reverse().map(transferRow);
    const data = { path: fb.path, loading: fb.loading, error: fb.error ?? "", can_back: fb.history.length > 0, can_up: fb.path !== "/", hidden: fb.showHidden };
    const w = this.win;
    sync(this.fileRows[d], rows, (a, b) => a.name === b.name && a.dir === b.dir && a.meta === b.meta && a.has_thumb === b.has_thumb);
    sync(this.fileTransfers[d], transfers, sameJson);
    if (d === "right") {
      w.right_files = data;
      w.right_file_clearable = fb.transfers.some((x) => x.done || x.error !== null);
    } else {
      w.bottom_files = data;
      w.bottom_file_clearable = fb.transfers.some((x) => x.done || x.error !== null);
    }
  }

  private filesAct(d: Dock, action: string, i: number): void {
    const fb = this.filesOf(d);
    if (!fb) return;
    const e = fb.shown()[i];
    switch (action) {
      case "back":
        fb.back();
        break;
      case "up": {
        const p = fb.parent();
        if (p !== null) fb.go(p);
        break;
      }
      case "home":
        fb.go("~");
        break;
      case "hidden":
        fb.showHidden = !fb.showHidden;
        break;
      case "refresh":
        fb.list(fb.path);
        break;
      case "upload":
        void import("@harbor/media").then(async ({ picker }) => {
          const files = await picker.pick({ title: "Upload files", multiple: true });
          if (files.length > 0) fb.upload(files);
        });
        break;
      case "open":
        if (e) void fb.click(e).then((local) => local !== null && this.openImage(local));
        break;
      case "download":
        if (e) void fb.downloadToDownloads(fb.join(e.name), e.size);
        break;
      case "clear":
        fb.transfers = clearDeviceTransfers(fb.transfers);
        break;
    }
    this.refreshPanes();
  }

  private engineOf(d: Dock): BrowserEngine | null {
    const s = this.surfaces.showing(d);
    return s?.kind === "browser" && s.engine instanceof BrowserEngine ? s.engine : null;
  }

  /** Local servers worth offering when a page can't be reached: Harbor's own processes, then anything listening. */
  private devServers(): string[] {
    const read = (f: string) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return "";
      }
    };
    const ports = listeningPorts([read("/proc/net/tcp"), read("/proc/net/tcp6")], this.engine.hookPort);
    return ports.map((p) => `localhost:${p}`);
  }

  /** surface.rs `pane_ui`'s browser: its engine starts when the tab shows, and its state is drawn. */
  private refreshBrowser(d: Dock): void {
    const s = this.surfaces.showing(d);
    if (s?.kind !== "browser") return;
    if (s.engine instanceof BrowserEngine && !s.engine.alive) this.surfaces.stopEngine(s);
    const helper = helperPath();
    if (!s.engine && helper !== null && crashing() === null) {
      s.engine = new BrowserEngine(helper, join(runDir(), `browser-${process.pid}-${++this.engines}`), s.url, () => this.browserWake());
    }
    const e = s.engine instanceof BrowserEngine ? s.engine : null;
    let data: BrowserData;
    if (e) {
      const st = e.state;
      if (st.url !== "" && st.url !== s.url) {
        s.url = st.url;
        this.rememberUrl(st.url);
      }
      e.took();
      const failed = st.title === "Error loading page";
      const host = hostOf(st.url);
      data = { state: "page", url: st.url, loading: st.loading, back: st.back, forward: st.forward, external: e.external !== null, has_frame: st.frame !== null, frame: st.frame ?? noPixels, cursor: st.cursor, error_host: failed ? host : "", error_local: host.startsWith("localhost") || host.startsWith("127."), why: "" };
    } else {
      const why = crashing();
      const state = why !== null ? "stopped" : helper !== null ? "starting" : sourceDir() !== null ? "build" : "absent";
      data = { state, url: s.url, loading: false, back: false, forward: false, external: false, has_frame: false, frame: noPixels, cursor: "default", error_host: "", error_local: false, why: why ?? "" };
    }
    if (d === "right") this.win.right_browser = data;
    else this.win.bottom_browser = data;
    if (data.error_host !== "") sync(this.servers, this.devServers(), (a, b) => a === b);
  }

  /** A frame or a change from an engine redraws at most every 16ms. */
  private browserWake(): void {
    if (this.browserQueued) return;
    this.browserQueued = true;
    setTimeout(() => {
      this.browserQueued = false;
      this.refreshPanes();
    }, 16);
  }

  private rememberUrl(url: string): void {
    if (url === "" || url === "about:blank") return;
    const st = this.data.store;
    st.set("browser_last", url);
    let recent: string[] = [];
    try {
      const v: unknown = JSON.parse(st.get("browser_recent") ?? "[]");
      if (Array.isArray(v)) recent = v.filter((u): u is string => typeof u === "string");
    } catch {
      // nothing recent yet
    }
    st.set("browser_recent", JSON.stringify([url, ...recent.filter((u) => u !== url)].slice(0, 8)));
  }

  private browserNav(d: Dock, a: string): void {
    const e = this.engineOf(d);
    if (!e) return;
    if (a === "external") {
      if (e.external !== null) this.openExternal(e.external);
    } else e.send({ t: a });
  }

  private browserGo(d: Dock, url: string): void {
    const u = url.trim();
    const s = this.surfaces.showing(d);
    if (u === "" || s?.kind !== "browser") return;
    s.url = u;
    this.engineOf(d)?.load(u);
    this.refreshPanes();
  }

  /** The "engine missing" screen's button: Try again after crashes, or build it from this checkout. */
  private browserMissing(d: Dock): void {
    if (crashing() !== null) clearCrashes();
    else {
      const dir = sourceDir();
      if (dir !== null) this.surfaces.openTerminal("Build browser", dir, ["bash", "-lc", "mise exec rust -- cargo build --release 2>/dev/null || cargo build --release; echo; echo 'Done: switch back to the Browser tab.'"], d);
    }
    this.refreshPanes();
  }

  /** surface.rs: a terminal on a paired PC, ssh into it. */
  private deviceTerminal(d: Dock, key: string): void {
    const dev = this.paired.find((p) => p.key === key);
    const host = dev ? this.hub.deviceHost(dev) : null;
    if (dev && host) this.surfaces.openTerminal(dev.name, homedir(), host.shell, d);
  }

  /** Shows the workspaces `ids` in the sidebar ("": all of them), on this device from now on. */
  private setWsFilter(ids: string): void {
    this.data.store.set("sidebar_workspace", ids);
    this.refreshSidebar();
  }

  private dialog(title: string, text: string, ok: string, danger: boolean, input: string | null, act: (ok: boolean, input: string) => void): void {
    const w = this.win;
    w.dialog_title = title;
    w.dialog_text = text;
    w.dialog_ok = ok;
    w.dialog_danger = danger;
    w.dialog_has_input = input !== null;
    w.dialog_stop = false;
    w.dialog_input = input ?? "";
    this.dialogAction = act;
    w.dialog_id = "dialog";
  }

  private renameDialog(id: number): void {
    const c = this.data.chat(id);
    if (!c) return;
    this.dialog("Rename chat", "", "Save changes", false, c.title, (ok, title) => {
      if (!ok || title.trim() === "") return;
      c.title = title.trim();
      this.data.saveChat(c);
      this.refreshAll();
    });
  }

  private deleteDialog(id: number): void {
    const c = this.data.chat(id);
    if (!c) return;
    this.dialog("Delete chat?", "The transcript is removed from Harbor. The provider's session stays on disk.", "Delete", true, null, (ok) => {
      if (!ok) return;
      this.data.deleteChat(id);
      if (this.view === "chat" && this.chatId === id) this.newDraft(c.repoId);
      else this.refreshAll();
    });
  }

  private removeRepoDialog(id: number): void {
    const r = this.data.repo(id);
    if (!r) return;
    this.dialog(REMOVE_PROJECT.title, REMOVE_PROJECT.text, REMOVE_PROJECT.ok, true, null, (ok) => {
      if (!ok) return;
      this.data.removeRepo(id);
      this.projectRemoved(id);
    });
  }

  /** After project `id` left Harbor (here, or from a phone): off the draft, out of a chat of it. */
  /** Settle project (logic/projectmenu.ts): it and its chats go to Settled; Unsettle brings them back. */
  private settleProject(id: number, on: boolean): void {
    this.data.store.settleProject(id, on);
    this.data.reload();
    this.projectSettled(id, on);
  }

  /** After project `id` was settled or unsettled (here, or from a phone): out of a chat of it. */
  projectSettled(id: number, on: boolean): void {
    const c = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    if (on && ((c !== undefined && c.repoId === id) || (this.view === "draft" && this.draftRepo === id))) this.newDraft(null);
    else this.refreshAll();
  }

  projectRemoved(id: number): void {
    this.avatars.delete(id);
    if (this.draftRepo === id) this.draftRepo = null;
    const c = this.view === "chat" ? this.data.chat(this.chatId) : undefined;
    if (this.view === "chat" && !c) this.newDraft(null);
    else this.refreshAll();
  }

  private addProject(): void {
    this.pages.openAddProject((id) => {
      this.data.reload();
      this.newDraft(id);
    });
  }

  private openPage(p: Page): void {
    if (this.page === null) this.pageBack = this.view === "chat" ? this.chatId : null;
    this.page = p;
    this.win.palette_open = false;
    this.closePopup();
    this.win.view = p;
  }

  /** Esc or a page's own close: the chat it was opened from, else the draft (app.rs `leave_settings`, `close_prs`). */
  private leavePage(): void {
    const back = this.pageBack;
    this.pageBack = null;
    if (back !== null && this.data.chat(back)) this.openChat(back);
    else this.newDraft(this.draftRepo);
  }

  private applyTheme(dark: boolean, compact: boolean): void {
    this.mode = parseMode(this.data.store.get("theme") ?? "");
    this.win.compact = compact;
    if (dark === this.dark) return;
    this.dark = dark;
    this.win.dark = dark;
    this.refreshAll();
  }

  private openPalette(): void {
    if (this.win.palette_open) {
      this.pages.closePalette();
      return;
    }
    this.closePopup();
    const chat = this.view === "chat" && this.page === null ? this.data.chat(this.chatId) : undefined;
    this.pages.openPalette(
      () =>
        paletteItems({
          repos: this.data.repos.map((r) => ({ id: r.id, name: r.name, dir: placeLine(this.placeOf(r.id), tilde(r.local ?? r.path, homedir())) })),
          chats: this.data.chats.map((c) => ({ id: c.id, title: c.title, role: c.role, parent: c.parent, name: c.name, repoId: c.repoId, settled: c.settled, updated: c.updated })),
          devices: [],
          current: chat?.id ?? null,
          draftRepo: this.draftRepo,
          fast: this.data.store.get("fast_mode") === "1",
          forkable: chat ? forkable(this.items(chat.id)).some((x) => x !== null) : false,
        }),
      (it) => this.paletteRun(it),
    );
  }

  /** palette.rs `palette_run`. */
  private paletteRun(it: PaletteItem): void {
    const a = it.act;
    switch (a.kind) {
      case "project":
        this.openProject(a.id);
        break;
      case "chat":
        this.openChat(a.id);
        break;
      case "new_chat":
        this.newDraft(a.repo);
        break;
      case "prs":
        this.pages.openPrs();
        break;
      case "issues":
        this.pages.openIssues();
        break;
      case "settings":
        void this.pages.openSettings(a.tab);
        break;
      case "settle":
        this.setSettled(a.id, a.on);
        break;
      case "fork": {
        const at = forkable(this.items(a.id)).findLastIndex((x) => x !== null);
        if (at >= 0) this.fork(a.id, at);
        break;
      }
      case "fast":
        this.data.store.set("fast_mode", a.on ? "1" : "0");
        break;
      case "toggle_sidebar":
        this.win.sidebar_open = !this.win.sidebar_open;
        break;
      case "check_updates":
        this.checkUpdates();
        break;
      case "toggle_terminal":
        this.surfaces.toggleTerminal(this.cwdHere());
        break;
      case "toggle_browser":
        this.surfaces.toggleBrowser(this.browserUrl());
        break;
    }
  }

  private checkUpdates(): void {
    this.toast("Checking for updates\u{2026}");
    this.hub.checkUpdates().then(
      (status) => this.toast(updateToast(status)),
      (e: unknown) => this.toast(`Update check failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  /** fork.rs `fork_from`: a new chat with the conversation up to that reply. */
  private fork(id: number, reply: number): void {
    if (this.meshChat.fork(this.data.chat(id), reply)) return;
    const c = this.engine.forkFrom(id, reply);
    if (!c) return;
    this.data.reload();
    this.openChat(c.id);
  }

  /** A hover-bar button of message `seq` (chat.rs `msg_action`); "excerpt" mentions the `excerpt` selected in it. */
  private cardAction(seq: number, a: string, excerpt = ""): void {
    if (a.startsWith("q-")) {
      this.queueAction(seq, a);
      return;
    }
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
    } else if (a === "mention" || a === "excerpt") {
      const whole = mentionOf(item, seq, mentionAgent({ sub: chat.role === "sub", name: chat.name }, this.kind(this.chatSel())));
      const m = whole && a === "excerpt" ? excerptOf(whole, excerpt) : whole;
      if (!m) return;
      const list = this.mentions.get(this.key()) ?? [];
      addMention(list, m);
      this.mentions.set(this.key(), list);
      // mentions.rs: a selection just mentioned gets its note box focused; a message, the composer.
      this.noteFocus = a === "excerpt" ? (list.find((x) => x.item === m.item && x.excerpt === m.excerpt && x.text === m.text) ?? null) : null;
      this.refreshMentions();
      this.noteFocus = null;
      if (a !== "excerpt") this.win.focus_composer();
    } else {
      this.fork(chat.id, seq);
    }
  }


  private openLink(url: string): void {
    if (url.startsWith("sel:")) {
      const sel = selectionAt(url);
      const w = this.win;
      if (sel === null) {
        // The press on the button is what ends the selection: the button stays for that press.
        const was = this.selection;
        setTimeout(() => {
          if (this.selection !== was) return;
          this.selection = null;
          w.sel_shown = false;
        }, 150);
        return;
      }
      this.selection = sel;
      this.selButton = sel.text.trim() !== "" ? new SelectionButton(performance.now() / 1000) : null;
      this.selHover = false;
      w.sel_x = sel.x;
      w.sel_y = sel.y;
      this.stepSelButton();
      return;
    }
    const scroll = /^scroll:(up|down|home|end)$/.exec(url)?.[1];
    if (scroll === "up" || scroll === "down" || scroll === "home" || scroll === "end") {
      if (!this.win.lb_open && !this.win.vid_open) this.win.transcript_key(scroll);
      return;
    }
    if (url.startsWith("at:")) {
      const hit = linkAt(url);
      if (hit !== null) this.openLink(hit);
      return;
    }
    // A chat link in a reply (chatlink.ts): opens that chat here, a copy of another PC's or a
    // sub-agent's too, never the system's harbor:// handler; a short notice says why it can't.
    if (url.startsWith(CHAT_SCHEME)) {
      const r = openChatLink(this.linkWorld(), url, (id) => this.openChat(id));
      if ("error" in r) this.toast(r.error);
      return;
    }
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

  /** What chat links resolve against: this PC's chats (copies of other PCs' included) and the mesh's PCs. */
  private linkWorld(): ChatLinkWorld {
    return { chats: this.data.chats, peers: this.hub.mesh?.peers?.() ?? [], me: this.hub.mesh?.myName?.() ?? hostname() };
  }

  /** The title each chat link in a reply reads as, against the chats as they are now. */
  private linkTitle(): (url: string) => string {
    let world: ChatLinkWorld | null = null;
    return (url) => chatLinkTarget((world ??= this.linkWorld()), url).title;
  }

  private stepSelButton(): void {
    if (this.selTimer !== null) clearTimeout(this.selTimer);
    this.selTimer = null;
    const b = this.selButton;
    if (b === null || this.selection === null) {
      this.win.sel_shown = false;
      return;
    }
    const s = b.step(performance.now() / 1000, false, this.selHover);
    this.win.sel_shown = s.show;
    if (s.wake !== null) this.selTimer = setTimeout(() => this.stepSelButton(), s.wake * 1000 + 5);
  }

  private openExternal(url: string): void {
    if (!web(url) && !/^mailto:/i.test(url)) return;
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


interface Draft {
  text: string;
  files: string[];
  mentions: Mention[];
}

/** devices.rs `transfers_ui`: one transfer, newest first in the list. */
function transferRow(x: DeviceTransfer): TransferRow {
  return { label: x.label, state: x.error !== null ? "error" : x.done ? "done" : x.waiting ? "wait" : "run", line: transferStatus(x), frac: x.size > 0 ? x.sent / x.size : 0 };
}

/** What the window takes from the running hub. */
export interface ShellHub extends PageHub {
  /** The composer's "Runs on" menu for a chat (null: the draft) whose device is `current`. */
  runOnRows: (chatId: number | null, current: string, kind: string) => { id: string; name: string; glyph: string; desc: string; online: boolean | null; current: boolean; enabled: boolean }[];
  relocate: (chatId: number, to: string) => Promise<string>;
  prs: chatpr.ChatPrs;
  workspaces: () => Workspaces;
  devices: () => { list: PairedDevice[]; served: number };
  deviceEnv: DeviceSendEnv;
  deviceHost: (d: PairedDevice) => { shell: string[]; ssh: string[] } | null;
  moveTargets: (chatId: number) => { why: string | null; targets: { id: string; name: string; why: string | null }[] };
  movePc: (chatId: number, peerId: string) => Promise<string>;
  /** A project's Move to PC… (`POST /v1/projects/move`'s body and reply); absent without a hub. */
  projectMove?: (repo: number, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  /** What a project's move does now (null: none runs). */
  projectMoving?: (repo: number) => string | null;
  /** Harbor's own video player (update.rs `video_lib`, `video_auto`); without it the system's libmpv. */
  player?: import("@harbor/media").video.PlayerSource;
  /** Chats homed on other PCs and the leases (mesh.rs); none without a hub. */
  mesh?: ShellMesh;
  /** Move to workspace… (workspacemoves.ts); none without a hub. */
  moves?: ShellMoves;
  /** Where a project's folder is when it isn't on this PC (null: it's here; projectclones.ts `place`). */
  projectPlace?: (repo: number) => Place | null;
}

/** Move to workspace… as the window asks it: a menu (null: no such chat or project) and the move, answered as the phone API answers it. */
export interface ShellMoves {
  chatMenu(id: number): { why: string | null; items: MoveItem[] } | null;
  projectMenu(id: number): { why: string | null; items: MoveItem[] } | null;
  moveChat(id: number, ws: string): Promise<{ status: number; body: unknown }>;
  moveProject(id: number, ws: string): Promise<{ status: number; body: unknown }>;
}

/** The account's workspaces, this PC's ("" for none) and each PC the directory lists, by mesh id. */
export interface Workspaces {
  all: Workspace[];
  mine: string;
  pcs: ReadonlyMap<string, string>;
}

export interface ShellHooks {
  /** The screen to come back to after a restart (a snapshot the previous process left), or null. */
  restore?: Record<string, unknown> | null;
  /** Gets a function that reads the screen's state, for the next restart. */
  snapshotWith?: (read: () => Record<string, unknown>) => void;
  /** The first frame is on screen. */
  shown?: (window: slint.Window) => void;
  quit?: () => void;
  /** Gets a function that closes this window (the tray's Quit while it is open). */
  closer?: (close: () => void) => void;
  /** Gets the window's toast, for what finishes behind it (a move to another PC). */
  toaster?: (toast: (text: string) => void) => void;
  /** Gets why a folder can't be renamed now as far as the window knows (a terminal open in it). */
  busyIn?: (busy: (dir: string) => string | null) => void;
  /** Gets what the window does when a phone changes a project's icon or removes it. */
  projects?: (p: { icon: (repo: number, refresh: boolean) => void; removed: (repo: number) => void; settled: (repo: number, on: boolean) => void }) => void;
}

export async function run(data: Data, hub: ShellHub, hooks: ShellHooks = {}): Promise<void> {
  const win = await loadWindow();
  const shell = new Shell(win, data, hub);
  data.onChange = (id) => shell.changed(id);
  data.onRestoreDraft = (id, text, files, mentions) => shell.restoreDraft(id, { text, files, mentions });
  data.visible = (id) => shell.showing(id);
  data.onNotificationOpen = (gids) => {
    const c = data.chats.find((x) => gids.includes(x.gid));
    if (c) shell.openChat(c.id);
  };
  void import("@harbor/media").then((pkg) => {
    shell.useMedia(pkg);
    shell.changed(null);
  });
  const last = Number(data.store.get("last_chat") ?? 0);
  shell.newDraft(null);
  if (process.env.HARBOR_VIEW) shell.devView(process.env.HARBOR_VIEW, last);
  if (hooks.restore) shell.restore(hooks.restore);
  hooks.snapshotWith?.(() => shell.snapshot());
  shell.onQuit = hooks.quit ?? null;
  hooks.closer?.(() => win.hide());
  hooks.toaster?.((t) => shell.toast(t));
  hooks.busyIn?.((dir) => (shell.terminalIn(dir) ? "a terminal is open in it" : null));
  hooks.projects?.({ icon: (repo, refresh) => shell.reloadIcon(repo, refresh), removed: (repo) => shell.projectRemoved(repo), settled: (repo, on) => shell.projectSettled(repo, on) });
  win.show();
  shell.shown();
  win.focus_composer();
  scripted(win.window, process.env.HARBOR_POINTER);
  hooks.shown?.(win.window);
  const tick = setInterval(() => shell.tick(), 1000);
  await runLoop();
  clearInterval(tick);
  shell.shutdown();
}

export type { Item };

/** The UTF-16 index of UTF-8 byte offset `byte` of `text` (the composer's cursor). */
function utf16At(text: string, byte: number): number {
  return Buffer.from(text).subarray(0, byte).toString().length;
}
