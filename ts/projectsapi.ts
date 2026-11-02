import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { statSync } from "node:fs";
import { type Call, err, type Json, ok, type Reply } from "./packages/net/src/index.ts";
import { repoDir, type Store } from "./packages/store/src/index.ts";
import { ICONS } from "./packages/ui/src/icons.ts";
import { type Act, AddProject, type Disk, type GhList, nameProblem, type Row, STEP_LABEL, type Step, untrustedKey } from "./packages/ui/src/logic/addproject.ts";
import { cloneProject, createProject, ghRepos, localClones, realDisk } from "./packages/ui/src/addproject.ts";

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

/** origin's URL of the repository in `dir` ("" without one). */
function gitOrigin(dir: string): string {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

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
    if (!["", "rows", "job"].includes(sub)) return null;
    const b = obj(call.body);
    const pc = str(b.pc);
    if (pc !== "" && pc !== this.h.me().id) return this.onPeer(pc, sub, b, call);
    if (sub === "rows") return ok(this.rows(b));
    if (sub === "job") return this.job(str(b.job), call.global);
    return this.act(b, call.global);
  }

  private disk(): Disk {
    return this.h.disk?.() ?? realDisk();
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
    const id = known ? known.id : this.h.store.addRepo(dir);
    const remote = (this.h.origin ?? gitOrigin)(dir);
    if (!known && remote !== "") this.h.store.setRepoRemote(id, remote);
    this.h.reload();
    this.h.touch();
    const r = this.h.store.repos().find((x) => x.id === id);
    const path = r?.path ?? dir;
    return { ok: true, id: global ? path : id, name: r?.name ?? "", path, remote: r?.remote ?? remote, existing: known !== undefined, git: isDir(join(dir, ".git")), pc: this.h.me().id, pc_name: this.pcName() };
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
    if (r.status === 404 && sub !== "job" && ["no such call", "unknown call", "not found"].includes(str(rb.error))) return err(409, `${peer.name} runs an older Harbor that can't add projects from a phone: update it there first`);
    if (r.status !== 200 || typeof rb.path !== "string" || rb.path === "" || sub === "rows") return r;
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
