import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { type Account, type Engine, git, providers, Work } from "./packages/agents/src/index.ts";
import { bridge, connect, type ghapi, type ghmesh, ghwire, hookcert, machines, mcp, prs, version } from "./packages/mcp/src/index.ts";
import {
  blocks,
  type Call,
  deviceId,
  err,
  type Hub,
  hostname,
  issuedIds,
  type Json,
  type OwnerSources,
  outgoingCtx,
  type Reply,
  versionsInput,
  versionsText,
} from "./packages/net/src/index.ts";
import { type Chat, type Repo, repoDir, type Store } from "./packages/store/src/index.ts";
import { scan, withArgs } from "./packages/ui/src/logic/slash.ts";
import { wire } from "./wire.ts";

type Forwarder = ghmesh.Forwarder;

export interface ServicesOptions {
  store: Store;
  hub: Hub;
  mesh: Forwarder;
  engine: Engine;
  version: string;
  env?: Record<string, string | undefined>;
  account: { signedIn(): boolean; ownerName(): string | null };
  /** The new-chat composer's picks (account, model, effort), which Fix and Merge threads start from. */
  composer: () => { account: string; model: string; effort: string };
  accounts: () => readonly Account[];
  /** The first port the webhook listener tries; false: none, and no public webhook address either (ts/run.sh's offline mode). */
  hookPort?: number | false;
  /** This PC's Harbor update info and the phone app it serves, for the agents' version list. */
  versionsOwn?: () => { update: unknown; served: number };
}

export interface Services {
  gh: ghapi.GhApi;
  /** A phone's GitHub page call, or null when the call is not one. */
  routePhone(call: Call): Promise<Reply> | null;
  /** What another PC asks of this one beyond chats: its share, a tool call, its issues; null when the call is not one. */
  routeMesh(call: Call): Promise<Reply> | null;
  /** Hands the mesh listener this PC's share levels and projects again. */
  publish(): void;
  stop(): void;
}

const asReply = (p: Promise<ghapi.Reply>): Promise<Reply> => p.then((r) => ({ status: r.status, body: r.body as Json }));

function fullName(): string {
  try {
    const me = userInfo().username;
    for (const l of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = l.split(":");
      if (f[0] === me) return (f[4] ?? "").split(",")[0]?.trim() ?? "";
    }
  } catch {
    // no passwd file: the owner is named some other way
  }
  return "";
}

export function ownerSources(o: Pick<ServicesOptions, "account">): OwnerSources {
  return { accountOwnerName: () => o.account.ownerName(), signedIn: () => o.account.signedIn(), fullName, githubUser: () => mcp.githubUser() ?? null };
}

/** Each project's GitHub repository ("owner/name"), read from the project's remote once. */
class Slugs {
  private readonly cache = new Map<number, string | null>();

  constructor(private readonly e: Engine) {}

  async refresh(): Promise<[Repo, string][]> {
    const out: [Repo, string][] = [];
    for (const r of this.e.repos) {
      let slug = this.cache.get(r.id);
      if (slug === undefined) {
        const remote = r.remote !== "" ? r.remote : ((await git.origin(repoDir(r))) ?? "");
        slug = remote === "" ? null : (prs.githubRepo(remote) ?? null);
        this.cache.set(r.id, slug);
      }
      if (slug !== null) out.push([r, slug]);
    }
    return out;
  }

  known(): [Repo, string][] {
    return this.e.repos.flatMap((r): [Repo, string][] => {
      const s = this.cache.get(r.id);
      return s ? [[r, s]] : [];
    });
  }
}

function hostPort(o: ServicesOptions, work: Work, slugs: Slugs, src: OwnerSources): ghapi.HostPort {
  const env = o.env ?? process.env;
  return {
    repos: async () => [...new Set((await slugs.refresh()).map(([, s]) => s))].sort(),
    projects: async (global) => (await slugs.refresh()).map(([r, repo]) => ({ id: global ? r.path : r.id, name: r.name, repo })),
    projectOf: (repo) => slugs.known().find(([, s]) => s.toLowerCase() === repo.toLowerCase())?.[0].id,
    agentLabel: () => {
      const a = work.account(o.composer().account);
      if (!a) return "an agent";
      return o.accounts().filter((x) => x.kind === a.kind && x.bin !== null).length > 1 ? providers.short(a) : a.kind;
    },
    ctx: () => outgoingCtx(o.store, { home: env.HOME ?? homedir(), dataDir: env.XDG_DATA_HOME ?? "", hostname: hostname() }, src, null),
    agentThread: async (global, start) => {
      const composer = o.composer();
      const chat: Chat | null = start.kind === "merge" ? work.mergePr(start.project, start.pr, start.extra, composer) : work.fixIssue(start.project, start.issue, start.extra, composer);
      if (!chat) return err(409, "no account to run the agent with");
      return { status: 200, body: global ? { id: chat.gid } : { id: chat.id, gid: chat.gid } };
    },
  };
}

export async function startServices(o: ServicesOptions): Promise<Services> {
  const env = o.env ?? process.env;
  version.setHarborVersion(o.version);
  wire();
  bridge.setSlash({ scan, withArgs });
  const slugs = new Slugs(o.engine);
  const work = new Work(o.engine);
  const src = ownerSources(o);
  machines.setHub({
    me: () => o.hub.mesh.me,
    peers: () => [...o.hub.mesh.peers.values()],
    versions: () => versionsText(versionsInput(o.hub, { hostname: hostname(), version: o.version, update: null, served: 0, ...o.versionsOwn?.() })),
  });
  const publish = (): void => {
    machines.publish(o.store, machines.ownProjects(o.engine.repos.map((r) => ({ name: r.name, dir: repoDir(r) }))), issuedIds(o.store));
  };
  publish();
  void slugs.refresh();
  const timer = setInterval(publish, 10_000);
  const hostPortImpl = hostPort(o, work, slugs, src);
  const gh = ghwire.createGhApi({ shared: o.hub.mesh, mesh: o.mesh, host: hostPortImpl, blocks: (md) => blocks(md), deviceId });
  const link = connect.connect({ engine: o.engine, ...(env.HARBOR_SOCK ? { socket: env.HARBOR_SOCK } : {}), ...(o.hookPort === undefined ? {} : { hooks: o.hookPort }) });
  const hooks = o.hookPort === false ? null : hookcert.start({ kv: o.store, tokens: { has: (t) => o.engine.webhooks.some((w) => w.token === t) }, send: (h) => void connect.deliverHook(o.engine, h), wake: () => undefined });
  return {
    gh,
    routePhone: (call) => (call.path[0] === "v1" && (call.path[1] === "prs" || call.path[1] === "issues") ? asReply(gh.handle(call)) : null),
    routeMesh: (call) => {
      const [m, v, a] = call.path;
      if (m !== "mesh" || v !== "v1") return null;
      if (a === "share" && call.method === "GET") return Promise.resolve({ status: 200, body: machines.serveShare(call.device).body as Json });
      if (a === "tool" && call.method === "POST") return machines.serveTool(call.device, call.body).then((r) => ({ status: r.status, body: r.body as Json }));
      if (a === "issues") return asReply(gh.handle(call));
      return null;
    },
    publish,
    stop() {
      clearInterval(timer);
      link.stop();
      hooks?.stop();
    },
  };
}
