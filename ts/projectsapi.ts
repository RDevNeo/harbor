import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { statSync } from "node:fs";
import { addFolder, type Call, err, gitRemote, type Json, ok, type Reply } from "./packages/net/src/index.ts";
import { homedir } from "node:os";
import { type Repo, repoDir, type Store } from "./packages/store/src/index.ts";
import { ICONS } from "./packages/ui/src/icons.ts";
import { type Act, AddProject, type Disk, type GhList, nameProblem, type Row, STEP_LABEL, type Step, untrustedKey } from "./packages/ui/src/logic/addproject.ts";
import { cloneProject, createProject, ghRepos, localClones, realDisk } from "./packages/ui/src/addproject.ts";
import { type ProjectAct, projectMenu } from "./packages/ui/src/logic/projectmenu.ts";
import { parseSnooze } from "./packages/ui/src/logic/sidebar.ts";
import { projectsdir, sidebartree } from "./packages/store/src/index.ts";
import { webUrl } from "./packages/agents/src/git.ts";
import { githubRepo } from "./packages/agents/src/worktree.ts";
import { choiceJson, shareJson, type WorkspaceMoves } from "./workspacemoves.ts";

/**
 * "Add project" from a phone (`/v1/projects*`): the desktop's own palette (logic/addproject.ts)
 * served as rows, and its acts run on the PC. `pc` in a body picks another PC of the mesh: the
 * call goes on to it, and a project made there is listed here too (as a copy of one of its chats
 * would list it), so the new chat started from the phone finds it.
 */
export interface ProjectsHost {
  store: Store;
  /** The engine re-reads the projects. */
  reload(): void;
  /** Phones and the window hear of a change. */
  touch(): void;
  me(): { id: string; name: string };
  peer(id: string): { id: string; name: string; online: boolean } | null;
  /** A call on to another PC of the mesh (`/mesh/v1/call`). */
  forward(peer: string, path: string[], body: Record<string, unknown>, sender: string): Promise<Reply>;
  sender(call: Call): string;
  disk?: () => Disk;
  clones?: () => Map<string, string>;
  github?: () => Promise<GhList>;
  clone?: (url: string, dir: string, github: boolean, projectsDir: string) => Promise<string | null>;
  origin?: (dir: string) => string;
  /** Project `repo`'s main chat, by the id the caller asks (`global`: its gid). */
  mainChat?: (repo: number, global: boolean) => { id: Json; title: string } | null;
  /** An image of the user's own is the project's icon. */
  customIcon?: (repo: number) => boolean;
  /** The project's icon: looked up again, the website's again, or the image at `file`; an error to show, or null. */
  setIcon?: (repo: number, how: "refresh" | "website" | { file: string }) => Promise<string | null>;
  /** The project's icon for a phone (null: none, its letter shows). */
  icon?: (repo: number) => Promise<{ hash: string; png: string } | null>;
  /** Removes the project from Harbor, as the window's Remove from Harbor. */
  remove?: (repo: number) => void;
  /** The window hears project `repo` was settled or unsettled here. */
  settled?: (repo: number, on: boolean) => void;
  /** The file a phone uploaded (`POST /v1/upload`'s id), or null. */
  uploadPath?: (id: string) => string | null;
  /** Move to workspace… (workspacemoves.ts). */
  moves?: WorkspaceMoves;
  /** `POST /v1/projects/move`: Move to PC… of project `repo` (projectmoverun.ts `api`). */
  move?: (repo: number, body: Record<string, unknown>, sender: string) => Promise<Reply>;
  /** What project `repo`'s move to another PC does now (null: none runs). */
  moving?: (repo: number) => string | null;
  /** Clean up merged worktrees of project `repo` (worktreeclean.ts): what it did (null: this Harbor can't). */
  cleanWorktrees?: (repo: number) => Promise<{ removed: number; branches: number; kept: number; busy: number; open: number; said: string } | null>;
}

const STEPS: readonly Step[] = ["sources", "new", "local", "url", "github"];
const GH_FRESH_MS = 5 * 60_000;
const CLONES_FRESH_MS = 60_000;
const JOB_KEEP_MS = 30 * 60_000;

/** The palette's glyphs by the names the phone draws them with. */
const ICON_NAMES = new Map<string, string>([
  [ICONS.FOLDER, "folder"],
  [ICONS.FOLDER_GIT, "folder-git"],
  [ICONS.FOLDER_PLUS, "folder-plus"],
  [ICONS.LINK, "link"],
  [ICONS.ARROW_UP, "up"],
]);

type Job = { state: "cloning"; text: string; at: number } | { state: "done"; project: Record<string, Json>; at: number } | { state: "failed"; error: string; at: number };

/** The desktop's glyphs by the names the phone draws them with (projectMenu's). */
const MENU_ICONS = new Map<string, string>([
  [ICONS.TERMINAL, "terminal"],
  [ICONS.PULL, "pr"],
  [ICONS.CIRCLE_DOT, "circle-dot"],
  [ICONS.EXTERNAL, "external"],
  [ICONS.ARCHIVE, "archive"],
  [ICONS.UNARCHIVE, "unarchive"],
  [ICONS.USERS, "users"],
  [ICONS.LINK, "link"],
  [ICONS.MONITOR, "monitor"],
  [ICONS.GIT_MERGE, "merge"],
]);

const PROJECT_ACTS: readonly ProjectAct[] = ["terminal", "prs", "issues", "remote", "rename_main", "settle_main", "refresh_icon", "choose_icon", "website_icon", "clean_worktrees", "settle_project", "unsettle_project", "move_workspace", "share_workspace", "move_pc", "remove"];
const now = (): number => Math.floor(Date.now() / 1000);
const zone = (at: number): number => -new Date(at * 1000).getTimezoneOffset() * 60;

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const gitOrigin = gitRemote;

/** An act as the phone sends it back: null when it isn't one. */
export function parseAct(v: unknown): Act | null {
  const a = obj(v);
  switch (a.kind) {
    case "step":
      return STEPS.includes(a.step as Step) ? { kind: "step", step: a.step as Step } : null;
    case "enter":
    case "add":
      return typeof a.dir === "string" && a.dir !== "" ? { kind: a.kind, dir: a.dir } : null;
    case "create":
      return typeof a.name === "string" ? { kind: "create", name: a.name, git: a.git !== false } : null;
    case "clone":
      return typeof a.url === "string" && a.url.trim() !== "" && typeof a.name === "string" ? { kind: "clone", url: a.url.trim(), name: a.name } : null;
    default:
      return null;
  }
}

export class ProjectsApi {
  private gh: { list: GhList | null; at: number; loading: boolean } = { list: null, at: 0, loading: false };
  private clones: { map: Map<string, string>; at: number } | null = null;
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly h: ProjectsHost) {}

  /** `/v1/projects*`, or null for any other call. */
  async route(call: Call): Promise<Reply | null> {
    const p = call.path;
    if (p[0] !== "v1" || p[1] !== "projects" || call.method !== "POST" || p.length > 3) return null;
    const sub = p[2] ?? "";
    if (!["", "rows", "job", "menu", "do", "move", "icon"].includes(sub)) return null;
    const b = obj(call.body);
    const pc = str(b.pc);
    if (pc !== "" && pc !== this.h.me().id) return this.onPeer(pc, sub, b, call);
    if (sub === "rows") return ok(this.rows(b));
    if (sub === "move") {
      // A project by its id or folder, or (asked on from another PC) by one of its chats.
      const r = b.chat !== undefined ? this.repoOfChat(b.chat) : this.repoOf(b.project);
      if (r === null) return err(404, "that project isn't on this PC any more");
      if (!this.h.move) return err(409, "projects can't move from here");
      return this.h.move(r.id, b, this.h.sender(call));
    }
    if (sub === "icon") {
      // Its picture as the sidebar shows it, the PNG in base64: `/v1/state` names it by `hash`.
      const r = this.repoOf(b.project);
      if (r === null) return err(404, "that project isn't on this PC any more");
      const icon = (await this.h.icon?.(r.id)) ?? null;
      return icon === null ? err(404, "that project has no icon") : ok({ hash: icon.hash, png: icon.png });
    }
    if (sub === "menu" || sub === "do") {
      const r = this.repoOf(b.project);
      if (r === null) return err(404, "that project isn't on this PC any more");
      return sub === "menu" ? ok(this.menu(r, call.global)) : this.run(r, b, call.from !== undefined && call.from !== null);
    }
    if (sub === "job") return this.job(str(b.job), call.global);
    return this.act(b, call.global);
  }

  private disk(): Disk {
    const d = this.h.disk?.() ?? realDisk();
    return { projects: projectsdir.projectsDir(this.h.store, d.home), ...d };
  }

  private pcName(): string {
    return this.h.me().name;
  }

  /** The palette at `step` (`dir` browsed, `query` typed), as the desktop shows it. */
  rows(b: Record<string, unknown>): Json {
    const step: Step = STEPS.includes(b.step as Step) ? (b.step as Step) : "sources";
    const ap = new AddProject(this.disk(), step === "github" ? this.localClones() : new Map());
    ap.go(step);
    const dir = str(b.dir);
    if (step === "local" && dir !== "") {
      const d = ap.expand(dir);
      if (ap.disk.isDir(d)) ap.enter(d);
      else ap.error = `Not a folder: ${ap.tilde(d)}`;
    }
    ap.query = str(b.query);
    if (step === "github") {
      this.loadGithub();
      ap.gh = this.gh.list;
      ap.ghLoading = this.gh.loading;
    }
    const rows = ap.rows(this.known());
    return {
      pc: this.h.me().id,
      pc_name: this.pcName(),
      step,
      label: STEP_LABEL[step],
      hint: ap.hint(),
      dir: ap.dir,
      dir_label: ap.tilde(ap.dir),
      projects_dir: ap.tilde(ap.projectsDir()),
      loading: step === "github" && this.gh.loading,
      rows: rows.map((r) => this.rowJson(r, step)),
      statuses: ap.status(rows.length).map(([text, tone]) => ({ text, tone })),
    };
  }

  private rowJson(r: Row, step: Step): Json {
    const icon = r.icon.kind === "logo" ? r.icon.name : (ICON_NAMES.get(r.icon.glyph) ?? "folder");
    const act: Record<string, Json> = { ...(r.act as unknown as Record<string, Json>) };
    if (r.act.kind === "clone" && step === "github") act.github = true;
    return { icon, title: r.title, detail: r.detail, act };
  }

  private known(): Set<string> {
    return new Set(this.h.store.repos().flatMap((r) => [r.path, repoDir(r)]));
  }

  private localClones(): Map<string, string> {
    if (this.clones && Date.now() - this.clones.at < CLONES_FRESH_MS) return this.clones.map;
    const map = (this.h.clones ?? localClones)();
    this.clones = { map, at: Date.now() };
    return map;
  }

  private loadGithub(): void {
    if (this.gh.loading || (this.gh.list !== null && Date.now() - this.gh.at < GH_FRESH_MS)) return;
    this.gh.loading = true;
    void (this.h.github ?? ghRepos)()
      .catch((e: unknown): GhList => ({ err: say(e) }))
      .then((list) => {
        this.gh = { list, at: Date.now(), loading: false };
      });
  }

  /** What an act from the phone does here: a project added, made or (in the background) cloned. */
  private async act(b: Record<string, unknown>, global: boolean): Promise<Reply> {
    const act = parseAct(b.act);
    if (act === null) return err(400, "act: add, create or clone");
    const disk = this.disk();
    const ap = new AddProject(disk, new Map());
    const pdir = ap.projectsDir();
    switch (act.kind) {
      case "step":
      case "enter":
        return err(400, "that act only moves the list: ask /v1/projects/rows");
      case "add": {
        const dir = ap.expand(act.dir);
        if (!disk.isDir(dir)) return err(409, `Not a folder: ${ap.tilde(dir)}`);
        return ok(this.added(dir, global));
      }
      case "create": {
        const bad = nameProblem(act.name);
        if (bad !== null) return err(400, bad);
        try {
          return ok(this.added(createProject(pdir, act.name, act.git, (p) => ap.tilde(p)), global));
        } catch (e) {
          return err(409, say(e));
        }
      }
      case "clone": {
        const bad = nameProblem(act.name);
        if (bad !== null) return err(400, bad);
        const dir = join(pdir, act.name.trim());
        if (disk.exists(dir)) return err(409, `${ap.tilde(dir)} already exists`);
        const github = obj(b.act).github === true;
        const id = randomBytes(8).toString("hex");
        const text = `Cloning ${act.url}…`;
        this.prune();
        this.jobs.set(id, { state: "cloning", text, at: Date.now() });
        void (this.h.clone ?? cloneProject)(act.url, dir, github, pdir)
          .catch((e: unknown) => say(e))
          .then((e) => {
            if (e !== null) {
              this.jobs.set(id, { state: "failed", error: e, at: Date.now() });
              return;
            }
            this.h.store.set(untrustedKey(dir), "1");
            // Its id as asked when the phone polls (the phone asks global ids).
            this.jobs.set(id, { state: "done", project: this.added(dir, false), at: Date.now() });
          });
        return { status: 202, body: { ok: true, job: id, text, into: ap.tilde(dir) } };
      }
    }
  }

  /** A clone started by `act`: still going (202), the project (200), or why it failed (409). */
  private job(id: string, global: boolean): Reply {
    const j = this.jobs.get(id);
    if (!j) return err(404, "that clone isn't known here any more: look for the project in the list");
    if (j.state === "cloning") return { status: 202, body: { ok: true, job: id, text: j.text } };
    if (j.state === "failed") return err(409, j.error);
    const p = j.project;
    return ok({ ...p, id: global ? (p.path ?? null) : (p.id ?? null) });
  }

  private prune(): void {
    const old = Date.now() - JOB_KEEP_MS;
    for (const [k, j] of this.jobs) if (j.at < old) this.jobs.delete(k);
  }

  /** `dir` as a project here (the one it already is, or a new one). */
  private added(dir: string, global: boolean): Record<string, Json> {
    const known = this.h.store.repos().find((r) => r.path === dir || repoDir(r) === dir);
    const remote = (this.h.origin ?? gitOrigin)(dir);
    // Another PC's project that this folder is a folder of takes it, instead of a second row (projectfold.ts).
    const id = known ? known.id : addFolder(this.h.store, dir, remote, homedir());
    this.h.reload();
    this.h.touch();
    const r = this.h.store.repos().find((x) => x.id === id);
    const path = r?.path ?? dir;
    return { ok: true, id: global ? path : id, name: r?.name ?? "", path, remote: r?.remote ?? remote, existing: known !== undefined, git: isDir(join(dir, ".git")), pc: this.h.me().id, pc_name: this.pcName() };
  }

  /** The sidebar's snoozes (kv `snoozed`, "r<project>" and "c<chat>" to seconds), as phoneroutes.ts reads them. */
  private snoozes(): Map<string, number> {
    try {
      const v: unknown = JSON.parse(this.h.store.get("snoozed") ?? "{}");
      return new Map(Object.entries(typeof v === "object" && v !== null ? v : {}).filter((e): e is [string, number] => typeof e[1] === "number"));
    } catch {
      return new Map();
    }
  }

  private snoozeOf(key: string): number | null {
    const t = this.snoozes().get(key);
    return t !== undefined && t > now() ? t : null;
  }

  private setSnooze(key: string, until: number | null): void {
    const all = this.snoozes();
    if (until === null) all.delete(key);
    else all.set(key, until);
    this.h.store.set("snoozed", JSON.stringify(Object.fromEntries(all)));
    this.h.touch();
  }

  /** A project by the id the phone has for it: its number, or its folder (global ids). */
  private repoOf(v: unknown): Repo | null {
    const repos = this.h.store.repos();
    if (typeof v === "number") return repos.find((r) => r.id === v) ?? null;
    if (typeof v !== "string" || v === "") return null;
    if (/^\d+$/.test(v)) return repos.find((r) => r.id === Number(v)) ?? null;
    return repos.find((r) => r.path === v) ?? repos.find((r) => repoDir(r) === v) ?? null;
  }

  /** The project of a chat, by its id here or its gid. */
  private repoOfChat(v: unknown): Repo | null {
    const chats = this.h.store.chats();
    const c = typeof v === "number" ? chats.find((x) => x.id === v) : typeof v === "string" ? (/^\d+$/.test(v) ? chats.find((x) => x.id === Number(v)) : chats.find((x) => x.gid === v)) : undefined;
    if (!c || c.repoId === null || c.home !== "") return null;
    return this.h.store.repos().find((r) => r.id === c.repoId) ?? null;
  }

  /** A project's page on the web, from its stored origin (null without one). */
  private remoteOf(r: Repo): string | null {
    const o = r.remote !== "" ? r.remote : (this.h.origin ?? gitOrigin)(repoDir(r));
    return o === "" ? null : webUrl(o);
  }

  /**
   * What the desktop's project row offers (logic/projectmenu.ts), for the phone's project sheet:
   * its own buttons (`row`: New chat, Snooze) then its menu in the same order and words. Open
   * terminal is the window's own: greyed here, with why.
   */
  menu(r: Repo, global: boolean): Json {
    const remote = this.remoteOf(r);
    const main = this.h.mainChat?.(r.id, global) ?? null;
    const until = this.snoozeOf(`r${r.id}`);
    const settled = this.h.store.settledProjects().has(r.id);
    const moves = this.h.moves?.projectMenu(r) ?? null;
    const shares = this.h.moves?.projectShares(r) ?? null;
    const items = projectMenu({
      remote,
      main: main !== null,
      customIcon: this.h.customIcon?.(r.id) ?? false,
      settled,
      git: this.h.cleanWorktrees !== undefined && isDir(join(repoDir(r), ".git")),
      ...(moves ? { moveWhy: moves.why } : {}),
      ...(shares ? { shareWhy: shares.why, shareLine: shares.line } : {}),
      moving: this.h.moving?.(r.id) ?? null,
    }).map((it): Json => {
      const off = it.act === "terminal" || it.off === true;
      return {
        act: it.act,
        label: it.label,
        icon: MENU_ICONS.get(it.icon) ?? "",
        desc: it.act === "terminal" ? `It opens in Harbor's window on ${this.pcName()}` : it.desc,
        sep: it.sep,
        enabled: !off,
      };
    });
    return {
      id: global ? r.path : r.id,
      name: r.name,
      path: r.path,
      pc: this.h.me().id,
      pc_name: this.pcName(),
      remote,
      github: remote === null ? null : githubRepo(remote),
      main,
      snoozed: until === null ? null : `until ${sidebartree.snoozeLabel(until, now(), zone(now()))}`,
      settled,
      // Move to workspace…'s list (null: a Harbor without it).
      workspaces: moves ? choiceJson(moves) : null,
      // Share with workspace…'s checklist (null: a Harbor without it).
      shares: shares ? shareJson(shares) : null,
      row: settled ? [] : [
        { act: "new_chat", label: "New chat in this project", icon: "plus" },
        { act: "snooze", label: "Snooze", icon: "clock" },
      ],
      items,
    };
  }

  /** One of the project sheet's acts that runs on the PC: icons, Snooze, Remove from Harbor. */
  private async run(r: Repo, b: Record<string, unknown>, forwarded = false): Promise<Reply> {
    const act = str(b.act);
    switch (act) {
      case "workspace":
        if (!this.h.moves) return err(409, "this Harbor can't move projects to a workspace");
        return this.h.moves.moveProject(r, b.workspace, forwarded);
      case "share":
        if (!this.h.moves) return err(409, "this Harbor can't share projects with a workspace");
        return this.h.moves.shareProject(r, b.workspace, b.on, forwarded);
      case "refresh_icon":
      case "website_icon":
      case "choose_icon": {
        if (!this.h.setIcon) return err(409, "project icons are the window's: this PC runs without one");
        let how: "refresh" | "website" | { file: string } = act === "refresh_icon" ? "refresh" : "website";
        if (act === "choose_icon") {
          const file = this.h.uploadPath?.(str(b.upload)) ?? null;
          if (file === null) return err(400, "send the image first (POST /v1/upload), then its id as upload");
          how = { file };
        }
        const bad = await this.h.setIcon(r.id, how);
        return bad === null ? ok({ ok: true }) : err(409, bad);
      }
      case "settle_project":
      case "unsettle_project": {
        const on = act === "settle_project";
        this.h.store.settleProject(r.id, on);
        this.h.reload();
        this.h.settled?.(r.id, on);
        this.h.touch();
        return ok({ ok: true, settled: on });
      }
      case "clean_worktrees": {
        const done = (await this.h.cleanWorktrees?.(r.id)) ?? null;
        if (done === null) return err(409, "this Harbor can't clean up worktrees");
        if (done.removed > 0) this.h.touch();
        return ok({ ok: true, ...done });
      }
      case "remove":
        if (!this.h.remove) return err(409, "can't remove projects here");
        this.h.remove(r.id);
        this.h.touch();
        return ok({ ok: true });
      case "snooze": {
        const key = `r${r.id}`;
        if (b.wake === true) {
          this.setSnooze(key, null);
          return ok({ ok: true, snoozed_until_ms: null, snoozed_label: null });
        }
        const at = now();
        const off = typeof b.off === "number" && Number.isInteger(b.off) ? b.off : zone(at);
        let until: number;
        if (typeof b.until_ms === "number" && Number.isInteger(b.until_ms)) {
          until = Math.trunc(b.until_ms / 1000);
          if (!(until > at && until <= at + 366 * 86400)) return err(400, "pick a time within the next year");
        } else if (typeof b.text === "string") {
          const u = parseSnooze(b.text, at, off);
          if (u === null) return err(400, "Try 5h, 1h30m, 2d or 18:00");
          until = u;
        } else return err(400, "until_ms, text or wake");
        this.setSnooze(key, until);
        return ok({ ok: true, snoozed_until_ms: until * 1000, snoozed_label: sidebartree.snoozeLabel(until, at, off) });
      }
      default:
        return err(400, PROJECT_ACTS.includes(act as ProjectAct) ? `${act} runs on the phone itself` : "act: refresh_icon, website_icon, choose_icon, clean_worktrees, snooze, settle_project, unsettle_project, workspace, share or remove");
    }
  }

  /** The same call on PC `pc`; a project made there is listed here too. */
  private async onPeer(pc: string, sub: string, b: Record<string, unknown>, call: Call): Promise<Reply> {
    const peer = this.h.peer(pc);
    if (peer === null) return err(404, "that PC isn't one of this mesh's");
    if (!peer.online) return err(409, `${peer.name} is off: pick a PC that's on`);
    const { pc: _pc, ...rest } = b;
    const path = ["v1", "projects", ...(sub === "" ? [] : [sub])];
    const r = await this.h.forward(peer.id, path, rest, this.h.sender(call));
    const rb = obj(r.body);
    if (r.status === 503) return err(503, `${peer.name} is off or unreachable`);
    if (r.status === 404 && sub !== "job" && ["no such call", "unknown call", "not found"].includes(str(rb.error)))
      return err(409, `${peer.name} runs an older Harbor that can't ${sub === "menu" || sub === "do" || sub === "move" ? "change its projects" : "add projects"} from a phone: update it there first`);
    if (r.status !== 200 || typeof rb.path !== "string" || rb.path === "" || sub === "rows" || sub === "menu" || sub === "do" || sub === "move") return r;
    // A project there: listed here as well, by the folder it has there.
    const repos = this.h.store.repos();
    const remote = str(rb.remote);
    let id = repos.find((x) => x.path === rb.path)?.id ?? null;
    if (id === null) {
      id = this.h.store.addRepo(rb.path);
      if (remote !== "") this.h.store.setRepoRemote(id, remote);
      this.h.reload();
      this.h.touch();
    }
    return ok({ ...(rb as Record<string, Json>), id: call.global ? rb.path : id, pc: peer.id, pc_name: peer.name });
  }
}
