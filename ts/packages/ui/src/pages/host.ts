import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { git, providers, provupdate, type Account, type Work } from "@harbor/agents";
import { type voiceCtl } from "@harbor/media";
import { Desktop, hostname, spawnNotifySend, testNote } from "@harbor/net";
import { control, discord, hookcert, type ghapi, prs as ghprs } from "@harbor/mcp";
import { type Chat } from "@harbor/store";
import { type Data } from "../data.ts";
import { Funnel } from "../logic/funnel.ts";
import { fixOnPeer, localDevice } from "../logic/hubseam.ts";
import { type Keys, type KeyPress } from "../logic/keys.ts";
import { type Item } from "../logic/palette.ts";
import { type Tab } from "../logic/pages.ts";
import { addClaudeAccount } from "../logic/settings-providers.ts";
import { attachAddProject, type AddProjectView } from "../addproject.ts";
import { appMark } from "../logos.ts";
import { loadQr } from "../qr.ts";
import { token } from "../theme.ts";
import { type AppWindow } from "../window.ts";
import { busOf } from "./bus.ts";
import { mountIssues, type IssuesView } from "./issues.ts";
import { mountPalette, type PaletteHandle, type PaletteView } from "./palette.ts";
import { mountPrs, type PrsHandle, type PrsView } from "./prs.ts";
import { mountSettings, settingsSpeech, type SettingsHandle, type SettingsView } from "./settings.ts";

type IssuesPage = ReturnType<typeof mountIssues>;

export type Page = "settings" | "prs" | "issues";

/** What the window asks of the hub running in the same process. */
export interface PageHub {
  /** The GitHub API the phone and the other PCs of the mesh use: its Issues list is the merged one. */
  gh: ghapi.GhApi;
  /** Looks for a release now and gives the updater's status line once it has an answer. */
  checkUpdates: () => Promise<string>;
}

/** What the pages ask of the main window around them. */
export interface PageShell {
  win: AppWindow;
  data: Data;
  keys: Keys;
  /** Brings the page's slot to the front of the window. */
  show: (page: Page) => void;
  /** Back to the view the page was opened from. */
  leave: () => void;
  dark: () => boolean;
  theme: (dark: boolean, compact: boolean) => void;
  unported: (what: string) => void;
  toast: (message: string) => void;
  hub: () => PageHub;
  openExternal: (url: string) => void;
  openChat: (id: number) => void;
  /** A new draft in `project` holding `text`. */
  draftWith: (project: number, text: string) => void;
  /** The composer's account, model and effort, which a fix or merge thread starts with. */
  composer: () => { account: string; model: string; effort: string };
  /** A dialog with a text field, answered with the text. */
  ask: (title: string, text: string, ok: string, act: (text: string) => void) => void;
  /** The remote the project's git status found, if known. */
  remote: (repo: number) => string | null;
  work: () => Work;
  /** The window's dictation, null until @harbor/media has loaded. */
  dictation: () => voiceCtl.VoiceCtl | null;
  quit: () => void;
  /** Runs `argv` in a terminal tab of the bottom pane (app.rs `open_terminal`). */
  terminal: (title: string, cwd: string, argv: string[]) => void;
  /** A project's folder on this PC. */
  projectDir: (project: number) => string | null;
}

/** The Settings, Pull requests and Issues pages and the palette and add-project overlays, mounted on first use. */
export class PageHost {
  private settings: Promise<SettingsHandle> | null = null;
  private prs: PrsHandle | null = null;
  private issues: IssuesPage | null = null;
  private palette: PaletteHandle | null = null;
  private readonly funnel = new Funnel(() => providers.which("tailscale") !== null, control.HOOK_PORT);

  constructor(private readonly s: PageShell) {}

  openSettings(tab: Tab = "general"): void {
    this.s.show("settings");
    const store = this.s.data.store;
    if (this.settings === null) {
      const s = this.s;
      void this.funnel.check().then(() => this.settings).then((h) => h?.show()).catch(() => {});
      this.settings = loadQr().then((qr) => mountSettings(
        busOf<SettingsView>(s.win, "SettingsBus"),
        {
          store,
          quit: () => s.quit(),
          keys: s.keys,
          speech: s.dictation() ?? settingsSpeech(store),
          theme: { dark: () => s.dark(), set: (dark, compact) => s.theme(dark, compact) },
          back: () => s.leave(),
          providers: { login: (id) => this.login(id), addClaudeAccount: () => this.addClaudeAccount(), updateAll: (accounts) => void provupdate.updateAll(accounts) },
          integrations: { discordWindow: () => void discord.window().catch(() => {}) },
          webhooks: { terminal: (title, script) => s.terminal(title, homedir(), ["bash", "-lc", script]), checkFunnel: () => this.funnel.check(), disableFunnel: () => this.funnel.forget(), kick: () => hookcert.kick() },
          funnel: () => this.funnel,
          qr,
          notify: { sendTest: () => void new Desktop({ send: spawnNotifySend }).testPopup(testNote()) },
          copy: (text) => s.win.copy_text(text),
        },
        tab,
      ));
    }
    this.settings.then(
      (h) => h.show(tab),
      () => {
        this.settings = null;
        this.s.leave();
        this.s.unported("Settings");
      },
    );
  }

  /** app.rs `login`: installs a missing CLI, else signs the account in with its own environment. */
  private login(id: string): void {
    const a = providers.discover().find((x) => x.id === id);
    if (a === undefined) return;
    if (!providers.installed(a)) {
      this.s.terminal(`Install ${a.kind}`, homedir(), ["bash", "-lc", providers.installScript(a.kind)]);
      return;
    }
    const env = providers.accountEnv(a).flatMap(([k, v]) => (v === null ? ["-u", k] : [`${k}=${v}`]));
    this.s.terminal(`Sign in · ${a.name}`, homedir(), ["env", ...env, a.bin ?? a.kind.toLowerCase(), ...providers.loginCmd(a.kind)]);
  }

  private addClaudeAccount(): void {
    const add = addClaudeAccount(homedir(), existsSync, providers.which("claude-profile") !== null);
    this.s.terminal(add.title, homedir(), ["bash", "-lc", add.script]);
  }

  private projects(): { id: number; name: string; repo: string }[] {
    return this.s.data.repos.flatMap((r) => {
      const remote = this.s.remote(r.id) ?? (r.remote === "" ? null : r.remote);
      const repo = remote === null ? undefined : ghprs.githubRepo(remote);
      return repo === undefined ? [] : [{ id: r.id, name: r.name, repo }];
    });
  }

  private agent(): Account | undefined {
    return this.s.work().account(this.s.composer().account);
  }

  private agents(): { id: string; label: string; current: boolean }[] {
    const cur = this.agent()?.id;
    return this.s.data.accounts.filter((a) => a.bin !== null).map((a) => ({ id: a.id, label: providers.short(a), current: a.id === cur }));
  }

  private agentLabel(): string {
    const a = this.agent();
    if (a === undefined) return "an agent";
    return this.s.data.accounts.filter((x) => x.kind === a.kind && x.bin !== null).length > 1 ? providers.short(a) : a.kind;
  }

  /** Starts a thread with the agent, after asking for instructions when `ask`, and opens it. */
  private job(title: string, what: string, ask: boolean, start: (extra: string) => Chat | null): void {
    const go = (extra: string): void => {
      const chat = start(extra);
      if (chat === null) this.s.unported(`${title}: no account to run the agent with`);
      else this.s.openChat(chat.id);
    };
    if (ask) this.s.ask(`${title} with ${this.agentLabel()}`, what, "Start", (t) => {
      if (t.trim() !== "") go(t.trim());
    });
    else go("");
  }

  private fixAway(issue: ghapi.Issue, ask: boolean): void {
    const gh = this.s.hub().gh;
    const go = (extra: string): void => {
      void fixOnPeer(gh, issue.url, extra, this.issues?.filters.account, localDevice(process.env, hostname()), {
        toast: (m) => this.s.toast(m),
        open: (chat) => {
          this.s.data.reload();
          this.s.openChat(chat);
        },
      });
    };
    if (ask) this.s.ask(`Fix with ${this.agentLabel()}`, `#${issue.number} ${issue.title}`, "Start", (t) => {
      if (t.trim() !== "") go(t.trim());
    });
    else go("");
  }

  openPrs(project?: number): void {
    const s = this.s;
    s.show("prs");
    const bus = busOf<PrsView>(s.win, "PrsBus");
    void appMark("github", token("fg", s.dark()), s.dark()).then((p) => {
      bus.github = p;
    });
    if (this.prs === null) {
      this.prs = mountPrs(bus, {
        projects: () => this.projects(),
        repos: () => Promise.resolve([...new Set(this.projects().map((p) => p.repo))].sort()),
        agentLabel: () => this.agentLabel(),
        accounts: () => this.agents(),
        pickAccount: (id) => s.data.store.set("gh_agent_account", id),
        openUrl: git.openUrl,
        openBrowser: (url) => s.openExternal(url),
        copy: (text) => s.win.copy_text(text),
        checkout: (id, n) => {
          const dir = s.projectDir(id);
          if (dir !== null) s.terminal(`checkout #${n}`, dir, ["gh", "pr", "checkout", String(n)]);
        },
        review: (id, prompt) => s.draftWith(id, prompt),
        merge: (id, pr, ask) => this.job("Merge", `#${pr.number} ${pr.title}`, ask, (extra) => s.work().mergePr(id, pr, extra, s.composer())),
        close: () => s.leave(),
        now: () => Math.floor(Date.now() / 1000),
        notProject: "Add this repo as a project to do that here",
      });
    } else void this.prs.load();
    if (project !== undefined) this.prs.select(project);
  }

  openIssues(project?: number): void {
    const s = this.s;
    s.show("issues");
    if (this.issues !== null) {
      this.issues.load();
      if (project !== undefined) this.pick(this.issues, project);
      return;
    }
    void appMark("github", token("fg", s.dark()), s.dark()).then((github) => {
      const page = mountIssues(busOf<IssuesView>(s.win, "IssuesBus"), {
        projects: () => this.projects(),
        agentLabel: () => this.agentLabel(),
        agents: () => this.agents(),
        pickAgent: (id) => s.data.store.set("gh_agent_account", id),
        fix: (id, issue, ask) => {
          if (id === 0) this.fixAway(issue, ask);
          else this.job("Fix", `#${issue.number} ${issue.title}`, ask, (extra) => s.work().fixIssue(id, issue, extra, s.composer()));
        },
        openUrl: git.openUrl,
        browse: (url) => s.openExternal(url),
        copy: (text) => s.win.copy_text(text),
        close: () => s.leave(),
        keys: s.keys,
        github,
        gh: s.hub().gh,
      });
      this.issues = page;
      if (project !== undefined) this.pick(page, project);
    });
  }

  private pick(page: IssuesPage, project: number): void {
    page.project = project;
    page.elsewhere = null;
    page.changed();
  }

  /** Esc on the open page; the Issues page takes its own. */
  esc(page: Page): boolean {
    if (page === "settings") this.s.leave();
    else if (page === "prs" && this.prs !== null) this.prs.esc(false);
    else return false;
    return true;
  }

  /** The Pull requests page's list shortcuts. */
  shortcut(p: KeyPress): boolean {
    if (this.prs === null) return false;
    for (const id of ["list_close_tab", "list_toggle_panel", "pr_copy_link", "pr_copy_number"]) {
      if (this.s.keys.matches(id, p)) {
        this.prs.shortcut(id);
        return true;
      }
    }
    return false;
  }

  openPalette(items: () => Item[], run: (it: Item) => void): void {
    const win = this.s.win;
    this.palette ??= mountPalette(busOf<PaletteView>(win, "PaletteBus"), {
      items,
      kv: this.s.data.store,
      run,
      close: () => this.closePalette(),
    });
    this.palette.open();
    win.palette_open = true;
  }

  closePalette(): void {
    this.s.win.palette_open = false;
  }

  openAddProject(added: (id: number) => void): void {
    const win = this.s.win;
    const bus = busOf<AddProjectView>(win, "AddProjectBus");
    void appMark("github", token("fg", this.s.dark()), this.s.dark()).then((github) => {
      attachAddProject(bus, this.s.data.store, github, {
        added,
        done: () => {
          win.add_project_open = false;
        },
        openUrl: git.openUrl,
      });
      win.add_project_open = true;
    });
  }
}
