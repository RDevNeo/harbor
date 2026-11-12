import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { type Engine } from "./packages/agents/src/index.ts";
import { type Chat, repoDir, type Store } from "./packages/store/src/index.ts";
import { type CloneRepo, cloneFetch, cloneFetchInto, cloneProjectOwner, CloneState, dest, err, type Hub, type Mesh, type PhoneRoutes, type Reply } from "./packages/net/src/index.ts";
import { untrustedKey } from "./packages/ui/src/logic/addproject.ts";

export interface ProjectClonesHost {
  store: Store;
  engine: () => Engine;
  hub: Hub;
  mesh: () => Mesh;
  phone: () => PhoneRoutes;
  touch: () => void;
}

/** Where a project's folder is when it isn't on this PC (`pc` "": not known). */
export interface ProjectPlace {
  pc: string;
  name: string;
  online: boolean;
}

/** How long a folder found here is trusted; a missing one (another PC's path) is looked at less often: on macOS
 * a path under /home is the automounter's, and each look takes it milliseconds. A clone that finishes forgets. */
const HERE_MS = 3000;
const MISSING_MS = 30_000;

const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class ProjectClones {
  readonly state = new CloneState();

  constructor(private readonly h: ProjectClonesHost) {}

  private get e(): Engine {
    return this.h.engine();
  }

  homeName(c: Chat): string {
    return c.home !== "" ? this.h.hub.mesh.nameOf(c.home) : this.h.hub.mesh.me.name;
  }

  repoOf(id: number | null): CloneRepo | null {
    const r = this.e.repo(id);
    return r ? { id: r.id, name: r.name, path: r.path, dir: repoDir(r), remote: r.remote } : null;
  }

  repos(): CloneRepo[] {
    return this.e.repos.map((r) => ({ id: r.id, name: r.name, path: r.path, dir: repoDir(r), remote: r.remote }));
  }

  /** The PC that holds project `repo`: the home of a copy of its chats, else the one its copies came from (MeshStore). */
  owner(repo: number): [string, string] | null {
    const found = cloneProjectOwner(repo, this.e.chats.map((c) => ({ repoId: c.repoId, foreign: c.home !== "", home: c.home, homeName: this.homeName(c) })));
    if (found !== null) return found;
    const pc = this.h.store.projectPc(repo);
    return pc === "" || pc === this.h.hub.mesh.me.id ? null : [pc, this.h.hub.mesh.nameOf(pc)];
  }

  /**
   * Where project `repo`'s folder is when it isn't on this PC (null: it's here, or no such
   * project): the PC that holds it (`pc` "" when none is known), by name, and whether it's on.
   */
  place(repo: number): ProjectPlace | null {
    const r = this.e.repo(repo);
    if (!r || this.here(repoDir(r))) return null;
    const o = this.owner(r.id);
    if (o === null) return { pc: "", name: "", online: false };
    return { pc: o[0], name: o[1], online: this.h.hub.mesh.peer(o[0])?.online === true };
  }

  /** Whether a folder is on this PC, looked at most every few seconds, a missing one every 30 s (the sidebar asks on each repaint). */
  private here(dir: string): boolean {
    const t = Date.now();
    const k = this.seen.get(dir);
    if (k && t - k.at < (k.here ? HERE_MS : MISSING_MS)) return k.here;
    const here = isDir(dir);
    this.seen.set(dir, { at: t, here });
    return here;
  }

  private seen = new Map<string, { at: number; here: boolean }>();

  missingFolder(chat: Chat): string | null {
    const w = this.e.worktreeOf(chat);
    if (w !== null && !isDir(w)) return `This thread's worktree (${w}) is gone. Start a new chat in the project to go on.`;
    const r = this.e.repo(chat.repoId);
    if (!r || isDir(repoDir(r))) return null;
    const o = this.owner(r.id)?.[1] ?? null;
    if (o !== null && r.remote === "") return `${r.name}'s folder (${r.path}) isn't on this PC: it's on ${o}, and it has no Git remote to clone. Start the chat with ${o} as its device, or pick the folder that holds it here.`;
    if (o !== null) return `${r.name}'s folder (${r.path}) isn't on this PC: it's on ${o}. Start the chat with ${o} as its device, or clone the project here.`;
    return `${r.name}'s folder (${r.path}) isn't on this PC. Clone or move the project back, or pick another project.`;
  }

  holdForClone(chat: Chat, prompt: string, files: readonly string[]): boolean {
    const w = this.e.worktreeOf(chat);
    const plan = this.state.forTurn({ worktreeLost: w !== null && !isDir(w), repo: this.repoOf(chat.repoId), chat: chat.id, prompt, files: [...files], repos: this.repos(), home: homedir() });
    switch (plan.kind) {
      case "skip":
        return false;
      case "use":
        this.setLocal(plan.repo, plan.dir);
        return false;
      case "wait":
        return true;
      case "start": {
        const r = this.repoOf(chat.repoId);
        if (r) this.start(r, chat.id, plan.want, (remote) => cloneFetch(remote, plan.want));
        return true;
      }
    }
  }

  private setLocal(repo: number, dir: string): void {
    const r = this.e.repo(repo);
    if (!r) return;
    this.h.store.setRepoLocal(repo, r.path === dir ? null : dir);
    this.e.reload();
    this.h.touch();
  }

  private start(repo: CloneRepo, chat: number, at: string, work: (remote: string) => Promise<string>): void {
    const { text, detail } = this.state.begin(repo, at, homedir());
    this.e.notice(chat, "folder", text, detail);
    this.h.touch();
    void work(repo.remote).then(
      (dir) => this.finished(repo.id, { ok: true, dir }),
      (x) => this.finished(repo.id, { ok: false, error: say(x) }),
    );
  }

  private finished(repoId: number, result: { ok: true; dir: string } | { ok: false; error: string }): void {
    this.seen.clear();
    const e = this.e;
    const out = this.state.finished({
      repo: this.repoOf(repoId),
      repoId,
      result,
      repos: this.repos(),
      home: homedir(),
      turnRunning: (c) => e.running(c),
      missingFolder: (c) => {
        const chat = e.chat(c);
        return chat ? this.missingFolder(chat) : null;
      },
    });
    if (out.kind === "ok") {
      if (out.untrusted) this.h.store.set(untrustedKey(out.dir), "1");
      this.setLocal(repoId, out.dir);
      for (const s of out.steps) {
        if (s.do === "notice") e.notice(s.chat, "folder", s.text);
        else if (s.do === "queue") e.pushPending(s.chat, s.prompt);
        else e.startTurn(s.chat, s.prompt, s.files);
      }
    } else {
      for (const x of out.errors) {
        e.transcript(x.chat).items.push({ kind: "error", text: x.text });
        e.persist(x.chat);
      }
    }
    this.h.touch();
  }

  cloneHere(chat: Chat, path: string): string | null {
    const r = this.repoOf(chat.repoId);
    const picked = path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
    const checked = this.state.cloneHere({ chat: { foreign: chat.home !== "", repo: r }, picked });
    if (!checked.ok) return checked.error;
    this.start(checked.repo, chat.id, picked, (remote) => cloneFetchInto(remote, picked, checked.repo.name, homedir()));
    return null;
  }

  async runOnOwner(chat: Chat, sender: string, global: boolean): Promise<Reply> {
    const e = this.e;
    const r = this.repoOf(chat.repoId);
    const owner = r === null ? null : this.owner(r.id);
    const peer = owner === null ? null : this.h.hub.mesh.peer(owner[0]);
    const t = this.state.takeRunOnOwner({
      chat: { foreign: chat.home !== "", id: chat.id, account: chat.account, model: chat.model, effort: chat.effort, access: chat.access, repo: r },
      owner,
      ownerOnline: peer?.online === true,
      items: e.transcript(chat.id).items,
    });
    if (!t.ok) return err(409, t.error);
    if (peer === null) return err(409, "no other PC shares this project");
    const files = t.files.map((f) => ({ name: basename(f), data: readFileSync(f) }));
    const reply = await this.h.mesh().forward(dest(peer), peer.name, "POST", ["v1", "chats"], t.body, files, [sender, ""], null);
    const done = await this.h.phone().mapNew(peer.id, reply, global);
    if (reply.status < 300 && chat.home === "" && !chat.started && !e.running(chat.id)) {
      this.state.dropChat(chat.id);
      this.h.store.deleteChat(chat.id);
      e.reload();
      this.h.hub.touch(null, true);
    }
    return done;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

