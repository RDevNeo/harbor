import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { phoneRoutes } from "./phoneroutes.ts";
import { RunOn } from "./runon.ts";
import { type ProjectPlace, ProjectClones } from "./projectclones.ts";
import { ProjectsApi } from "./projectsapi.ts";
import { WorkspaceMoves } from "./workspacemoves.ts";
import { resolveUpload } from "./packages/net/src/hub.ts";
import { Worktrees } from "./worktrees.ts";
import { WorktreeCleaner } from "./worktreeclean.ts";
import { statusBars, waitJson } from "./statusbars.ts";
import { type Account, agent, chatpr, commits, memory, openchat, Engine, type EngineHost, oauth, providers, recap, worktree } from "./packages/agents/src/index.ts";
import { clipboard, devicespeech, dictate, dictwords, favicon, media, parakeet, voice } from "./packages/media/src/index.ts";
import { discord, Funnel, hookcert, machines, mcp, whatsapp } from "./packages/mcp/src/index.ts";
import {
  AccountService,
  Vault,
  fakePeers,
  RamMeter,
  deviceSshArgs,
  type DeviceSendEnv,
  gatherVersions,
  isPhoneDevice,
  newHost,
  type PairedDevice,
  pairedDevices,
  aboutOwner,
  acceptMemory,
  receiveDelivery,
  Api,
  catalogOf,
  dest,
  discoverStart,
  err,
  hostPort,
  hostname,
  addFolder,
  directoryMates,
  foldProjects,
  takesMainFrom,
  directoryPcWorkspaces,
  scopeHas,
  scopeHasDevice,
  isFound,
  hostLabel,
  osLabel,
  remoteDir,
  shellFamily,
  deviceNote,
  deviceProfile,
  profileSetup,
  http,
  Hub,
  placeOf,
  relocateBlocker,
  relocateWhy,
  deviceWhy,
  githubOf,
  ownerConfirmed,
  ownerOf,
  type OwnerSources,
  profileCheck,
  ProfileScheduler,
  detectProfiles,
  GITHUB_KEY,
  meshPcs,
  OWNER_KEY,
  type Pc,
  type Peer,
  profileInputs,
  versionsInput,
  profileCheckJson,
  profileFullName,
  profileNodeEnv,
  type PeerDevice,
  type RemoteHost,
  Remotes,
  systemRunner,
  lanAddrs,
  lanPortmapNet,
  loadOrCreate,
  loadTokens,
  overlays,
  Mesh,
  MovePc,
  ProjectMove,
  ProjectReceiver,
  iconFile,
  manifestOf,
  movedProject,
  scanFolder,
  noteJson,
  Notes,
  Notifier,
  loadRemote,
  ok,
  parseIp,
  PhoneRoutes,
  Portmap,
  readMe,
  relayServe,
  saveTokens,
  setHello,
  socketAddr,
  StoreReplica,
  tailnetIp,
  type CatalogAccount,
  type Call,
  type Dest,
  type Json,
  type MeshApp,
  type MovePcAccount,
  accountsByPc,
  helloAccounts,
  photoBook,
  type PhotoBook,
  type LocalAccount,
  meshAccountJson,
  type Person,
  type SharedAccount,
  sharedAccounts,
  sharedWith,
  kindLabel,
  type Reply,
  preview,
  outgoingCtx,
  knowDevices,
  chatLink as chatLinkOf,
  fakeAccount,
  fakePeerDevices,
  newPeer,
} from "./packages/net/src/index.ts";
import { WindowMesh } from "./windowmesh.ts";
import { DeviceMemory, sshOutput } from "./devicemem.ts";
import { GUEST_NOTICE, MeshTurns } from "./meshturns.ts";
import { type Chat, dataDir, home, repoDir, secrets, settingsync, stateDir, Store, wssettings } from "./packages/store/src/index.ts";
import { apk as updateApk, notices, type Updater } from "./packages/update/src/index.ts";
import { type Services, startServices } from "./services.ts";
import { fileSource, secretSource, SingleHost } from "./accountvault.ts";

export type HubHost = Pick<EngineHost, "changed" | "isForeign" | "copyTurn" | "hostname" | "chatLink" | "offline" | "turnEnded" | "moving" | "hold" | "hookBase" | "missingFolder" | "holdForClone" | "remoteSpec" | "turnContext" | "adopt" | "accounts" | "rediscover">;

export interface HubOptions {
  version: string;
  env?: Record<string, string | undefined>;
  updater?: Updater;
  store?: Store;
  /** The window's Engine, made with the hub's host and notes (the phones' notifications). */
  engine?: (host: HubHost, notes: Notes, voice: dictate.Mesh) => Engine;
  /** The first port the webhook listener tries (false: none); a test hub keeps off the real one's. */
  hookPort?: number | false;
  /** Live previews between PCs (update's preview.ts, run by the process that can restart into one). */
  preview?: HubPreview;
  /** Posts what the Discord host wants the user to know (signed out, a captcha to solve): the real app only, a test hub would take the user's. */
  discordNotices?: boolean;
  /** Keeps a linked WhatsApp's host running and posts its notices: the real app only, like discordNotices. */
  whatsappKeep?: boolean;
}

export interface HubPreview {
  /** Why this PC won't take `offer` from a PC with or without full access here; null: it will. */
  refuses(fullAccess: boolean, offer: preview.PreviewOffer): string | null;
  /** Fetches the offer from `from`, then restarts into it. */
  take(from: Dest, name: string, offer: preview.PreviewOffer): void;
  /** A file of this PC's own offer. */
  file(kind: string, id: string): string | null;
}

/** HARBOR_OFFLINE=1 (ts/run.sh, on a copy of someone's data): no mesh, relay, account, discovery or listening, and
 *  the Engine acts only on what the person sends. */
export function isOffline(env: Record<string, string | undefined> = process.env): boolean {
  return env.HARBOR_OFFLINE === "1";
}

const asJson = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

export interface RunningHub {
  store: Store;
  hub: Hub;
  api: Api;
  mesh: Mesh;
  phone: PhoneRoutes;
  engine: Engine;
  move: MovePc;
  projectMove: ProjectMove;
  runOn: RunOn;
  /** This PC's and the mesh's agent accounts, each sign-in once (meshaccounts.ts); another PC's run there. */
  sharedAccounts: () => SharedAccount[];
  windowMesh: WindowMesh;
  funnel: Funnel;
  prs: chatpr.ChatPrs;
  account: AccountService;
  /** Move to workspace… for chats and projects. */
  moves: WorkspaceMoves;
  /** What else holds a worktree folder's rename back: the window's terminals open in it. */
  setBusyIn(f: (dir: string) => string | null): void;
  /** What the window does when a phone changes a project's icon or removes it. */
  setWindowProjects(p: { icon: (repo: number, refresh: boolean) => void; removed: (repo: number) => void; settled: (repo: number, on: boolean) => void }): void;
  /** Devices: what is paired, and the versionCode of the phone app this PC serves. */
  devices(): { list: PairedDevice[]; served: number };
  deviceEnv: DeviceSendEnv;
  /** A paired PC's terminal (ssh into it) and its ssh options for the file browser; null for phones. */
  deviceHost(d: PairedDevice): { shell: string[]; ssh: string[] } | null;
  services: Services;
  /** Where a project's folder is when it isn't on this PC (null: it's here). */
  projectPlace(repo: number): ProjectPlace | null;
  /** A call to this PC's own API routes, as a phone's would be answered (the window's worktree bar uses the phone's). */
  call(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<Reply>;
  /** A new chat's own worktree (as `POST /v1/chats` with `worktree`): made for project `repo`, then given to the chat. */
  newWorktree: { make(repo: number, base: string, about: string): Promise<unknown>; attach(chat: number, made: unknown): void; discard(repo: number, made: unknown): void };
  stop(): Promise<void>;
}

function catalogAccount(a: providers.Account): CatalogAccount {
  return { id: a.id, kind: a.kind, name: a.name, badge: a.badge, bin: a.bin, loggedIn: a.loggedIn, off: a.off === true, usage: a.usage.map((u) => ({ label: u.label, percent: u.percent })) };
}

/** Where phones should try this PC: the network's IPv4 first, the router's public address, then IPv6 and Tailscale's (api.rs `phone_addrs`). */
export function phoneAddrs(port: number, all: string[], pub: string | null): string[] {
  const v = all.filter((a) => !a.includes(":") && !tailnetIp(a));
  const p = pub === null ? null : socketAddr(pub);
  if (p) v.push(p.port === port ? p.ip : p.text);
  v.push(...all.filter((a) => a.includes(":") || tailnetIp(a)));
  return v;
}

/** The phone's and another PC's Update, Check and Automatically (api.rs `/v1/hub/*`); null: not an update route. */
async function updateRoute(u: Updater | null, call: Call, store: Store): Promise<Reply | null> {
  const [v, hubSeg, what] = call.path;
  if (call.method !== "POST" || v !== "v1" || hubSeg !== "hub" || call.path.length !== 3) return null;
  if (what === "auto") {
    const on = typeof call.body === "object" && call.body !== null ? (call.body as { on?: unknown }).on : undefined;
    if (typeof on !== "boolean") return err(400, 'send {"on": true} or false');
    return ok({ ok: true, auto: true });
  }
  if (what !== "update" && what !== "check") return null;
  if (u === null || !u.managed()) return err(409, "this Harbor was built from source, so it doesn't update itself");
  if (what === "check") {
    void u.check();
    return { status: 202, body: { ok: true, checking: true } };
  }
  const s = u.state();
  if (s.t === "available") void u.installNow();
  else void u.checkAndInstall();
  return s.t === "available" ? ok({ ok: true }) : { status: 202, body: { ok: true, checking: true } };
}

function downloadsDir(): string {
  const home = process.env.HOME ?? "";
  try {
    const d = Bun.spawnSync(["xdg-user-dir", "DOWNLOAD"], { stdin: "ignore", stderr: "ignore" }).stdout.toString().trim();
    if (d !== "" && d !== home && existsSync(d)) return d;
  } catch {
    // no xdg-user-dir
  }
  return join(home, "Downloads");
}

/** The one chat whose running turn waits on a Discord join (its call has no result yet): where a captcha from a server that didn't name its chat belongs. Two or none: unknown. */
export function discordCaller(e: Pick<Engine, "turns" | "transcript" | "chat">): Chat | undefined {
  const waiting: number[] = [];
  for (const id of e.turns.keys()) {
    const items = e.transcript(id).items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.kind !== "tool") continue;
      if (it.result === null && /discord_join$/.test(it.name)) waiting.push(id);
      break;
    }
  }
  return waiting.length === 1 ? e.chat(waiting[0] as number) : undefined;
}

/** Harbor without its window (Rust's `--background`): the phone API, the mesh, discovery, port mapping and the account loop. */
export async function startHub(o: HubOptions): Promise<RunningHub> {
  const env = o.env ?? process.env;
  const offline = isOffline(env);
  const store = o.store ?? Store.open(dataDir(env));
  // A project listed twice (another PC's, and this PC's folder of it): one row, before anything reads them.
  for (const [theirs, mine] of foldProjects(store, env.HOME ?? homedir())) console.error(`harbor: project ${theirs} (another PC's) is project ${mine} here: folded into it`);
  const state = stateDir(env);
  const id = loadOrCreate(state);
  const me = readMe(store, env);
  const portText = store.get("api_port") ?? "";
  const port = /^\d+$/.test(portText) ? Number(portText) : 47930;
  // Screenshots only: a signed-in look (account.ts fakeAccount), written before the phones' tokens are read.
  const fakeOnline = env.HARBOR_FAKE_ACCOUNT ? fakeAccount(store, env.HARBOR_FAKE_ACCOUNT, id.fp) : [];
  const hub = new Hub(loadTokens(store), port);
  hub.mesh.me = me;
  hub.enabled = true;
  hub.loadRemembered(store);
  // Whoever settles or unsettles a chat or a project (the window, a phone, the project menu's
  // API, new activity waking a settled project), other PCs and phones hear of each chat at once.
  const stopSettled = store.onSettled((chat) => hub.touch(chat, true));
  hub.loadDrafts(store);
  setHello(me.id, me.name, id);
  const notes = new Notes();
  const notifier = new Notifier({ notes });
  hub.notes = {
    last: () => notes.last(),
    wait: async (since, ms) => {
      const [n, l] = await notes.wait(since, ms);
      return [n.map(noteJson), l];
    },
  };
  let accounts = providers.discover();
  parakeet.useOwnBinaryForWorker();
  // Cleanup and where to transcribe, for phones' dictations even before (or without) a window.
  dictate.loadFrom(store);
  let engine: Engine | null = null;
  const mirrorDictation = (): void => {
    // As voice.rs: not while the account is blocked by a usage limit.
    const a = accounts.find((x) => x.id === "claude" && providers.signedIn(x) && engine?.limits.blocked(x.id) === undefined);
    dictate.setAccount(a ? (system, prompt, ms) => recap.askWithin(providers.binStr(a), providers.accountEnv(a), system, prompt, ms) : null);
  };
  mirrorDictation();
  const rediscover = (): void => {
    accounts = providers.discover();
    mirrorDictation();
  };
  const catalog = catalogOf(providers, () => accounts.map(catalogAccount), store);
  const portmap = new Portmap({ kv: store, net: lanPortmapNet() });
  const addrs = () => phoneAddrs(port, lanAddrs(env), portmap.publicAddr());
  const meshAddrs = () => addrs().map((a) => (parseIp(a) ? hostPort(a, port) : a));
  // The account vault: the integrations' sign-ins, the saved keys and the single-host sessions follow the account (accountvault.ts).
  let single: SingleHost | null = null;
  const vaultLog = env.HARBOR_ACCOUNT_LOG === "1" ? (line: string) => process.stderr.write(`vault: ${line}\n`) : undefined;
  const vault = new Vault({
    stateDir: state,
    identity: () => id,
    name: () => (hub.mesh.me.name === "" ? hostname() : hub.mesh.me.name),
    sources: () => [fileSource(), secretSource(), ...(single?.sources() ?? [])],
    log: vaultLog,
    notice: (title, body) => notifier.post("pc", `vault:${title}`, title, body, "", false),
    onChange: () => account.notifyChanged(),
  });
  single = new SingleHost({
    vault,
    me: () => ({ id: hub.mesh.me.id, name: hub.mesh.me.name === "" ? hostname() : hub.mesh.me.name }),
    dest: (pid, fp) => {
      const p = hub.mesh.peers.get(pid);
      return p && p.fp === fp ? dest(p) : null;
    },
    log: vaultLog,
  });
  single.attach();
  const account = new AccountService({
    kv: store,
    stateDir: state,
    identity: () => id,
    me: () => hub.mesh.me,
    addrs: meshAddrs,
    version: o.version,
    env,
    vault,
    // The account's settings (settingsync KEYS of class account): pulled each minute, sent shortly after a change here.
    settings: {
      load: () => settingsync.load(store),
      signedIn: () => settingsync.signedIn(store),
      sync: async (token, pull) => {
        await settingsync.sync(store, token, pull, async (t, body) => (await account.settingsCall(t, body as never)) as settingsync.SettingsReply);
        // Values another PC of the account set: the window takes them now (the theme, the team view).
        if (settingsync.sync_state.reload) {
          settingsync.sync_state.reload = false;
          account.notifyChanged();
        }
      },
    },
  });
  settingsync.onChanged(() => account.pokeSync());
  account.load();
  // Copies of this owner's other PCs' chats follow their project's move and shares; other people's don't.
  let matesAt: [unknown, string, string, ReadonlySet<string>] | null = null;
  store.mates = () => {
    const d = account.directory();
    const me = account.account()?.id ?? "";
    const self = hub.mesh.me.id;
    if (matesAt === null || matesAt[0] !== d || matesAt[1] !== me || matesAt[2] !== self) matesAt = [d, me, self, directoryMates(d, me, self)];
    return matesAt[3];
  };
  // Messages saved before 0.115 have only their sender's label: the bubbles match it with these.
  knowDevices({
    pcs: () => [[hub.mesh.me.name, account.ownerName() ?? ""], ...[...hub.mesh.peers.values()].map((p) => [p.name, p.owner] as const)],
    phones: () => hub.localPhones().map((p) => [p.name, p.owner] as const),
  });
  let services: Services | null = null;
  let phoneRoute: (call: Call) => Promise<Reply> = async () => err(503, "Harbor is starting");
  const prs = new chatpr.ChatPrs({
    store,
    chats: () => store.chats(),
    chat: (chatId) => store.chat(chatId),
    folders: (c) => {
      const r = engine?.repo(c.repoId);
      return engine && r ? { repo: repoDir(r), dir: engine.worktreeOf(c) ?? repoDir(r) } : null;
    },
    changed: (chatId) => (engine ? engine.changed(chatId) : hub.touch(chatId, true)),
    merged: (lead, pr) => cleaner?.merged(lead, pr),
  });
  let cleaner: WorktreeCleaner | null = null;
  const prOf = (c: Chat): Json => {
    const p = c.home !== "" ? chatpr.prFrom(replica.remote.get(c.id)?.pr) : prs.of(c);
    return p ? asJson(chatpr.prJson(p)) : null;
  };
  const projectClones = new ProjectClones({ store, engine: () => eng(), hub, mesh: () => mesh, phone: () => phone, touch: () => hub.touch(null, true) });
  const clones = projectClones.state;
  const moves = new WorkspaceMoves({
    store,
    workspaces: () => ({ all: account.workspaces(), mine: account.workspace(), pcs: directoryPcWorkspaces(account.directory()) }),
    pcName: (id) => hub.mesh.nameOf(id),
    forward: (id, method, path, body) => {
      const p = hub.mesh.on ? hub.mesh.peer(id) : null;
      if (!p) return Promise.resolve(err(404, "that PC isn't one of this mesh's"));
      if (!p.online) return Promise.resolve(err(409, `${p.name} is off: try again when it's back`));
      return mesh.forward(dest(p), p.name, method, path, body, [], [hub.mesh.me.name, ""], null);
    },
    touch: (chat) => {
      if (chat === null) {
        hub.touch(null, true);
        engine?.storeChanged(null);
      } else {
        // The mesh list re-reads where chats are (StoreReplica.chats reloads): a bump is enough.
        hub.touch(chat, true);
        engine?.changed(chat);
      }
    },
  });
  const projects = new ProjectsApi({
    moves,
    store,
    reload: () => engine?.reload(),
    touch: () => hub.touch(null, true),
    me: () => ({ id: hub.mesh.me.id, name: hub.mesh.me.name === "" ? hostname() : hub.mesh.me.name }),
    peer: (id) => (hub.mesh.on ? hub.mesh.peer(id) : null),
    forward: (id, path, body, sender) => {
      const p = hub.mesh.peer(id);
      return p ? mesh.forward(dest(p), p.name, "POST", path, body, [], [sender, ""], null) : Promise.resolve(err(404, "that PC isn't one of this mesh's"));
    },
    sender: (call) => (call.from ? call.from.sender || call.from.name : hub.callerLabel(call.token, call.device)),
    mainChat: (repo, global) => {
      const id = engine?.mainChat(repo) ?? null;
      const c = id === null ? undefined : store.chat(id);
      return c ? { id: global ? c.gid : c.id, title: c.title } : null;
    },
    customIcon: (repo) => existsSync(favicon.customPath(repo)),
    setIcon: async (repo, how) => {
      if (how === "website") favicon.clearCustom(repo);
      else if (how !== "refresh") {
        if ((await favicon.decode(how.file).catch(() => null)) === null) return "Harbor can't read that image: pick a PNG, JPEG, WebP or GIF";
        if (!favicon.setCustom(repo, how.file)) return "Couldn't save the icon on this PC";
      }
      if (windowProjects) windowProjects.icon(repo, how === "refresh");
      else if (how === "refresh") {
        const r = store.repos().find((x) => x.id === repo);
        if (r) await favicon.resolve(repo, repoDir(r), r.name, true).catch(() => null);
      }
      return null;
    },
    remove: (repo) => {
      store.removeRepo(repo);
      engine?.reload();
      windowProjects?.removed(repo);
    },
    uploadPath: (id) => resolveUpload(uploadsDir, id),
    settled: (repo, on) => windowProjects?.settled(repo, on),
    move: (repo, body, sender) => (projectMove ? projectMove.api(repo, body, sender) : Promise.resolve(err(409, "projects can't move from here"))),
    cleanWorktrees: (repo) => (cleaner ? cleaner.project(repo) : Promise.resolve(null)),
    moving: (repo) => {
      const st = projectMove?.statusOf(repo);
      return st?.state === "running" ? `Moving to ${st.toName}: ${st.stage}` : null;
    },
  });
  let windowProjects: { icon: (repo: number, refresh: boolean) => void; removed: (repo: number) => void; settled: (repo: number, on: boolean) => void } | null = null;
  let busyIn: (dir: string) => string | null = () => null;
  const worktrees = new Worktrees({ store, engine: () => eng(), touch: () => hub.touch(null, true), wantPr: (chat) => prs.want(chat, chatpr.SHOWN_TTL_MS), busyIn: (dir) => busyIn(dir) });
  // Delete merged worktrees: on this PC's own chats only, never on a copy of someone's data.
  if (!offline) cleaner = new WorktreeCleaner({ store, engine: () => eng(), prs, worktrees, busyIn: (dir) => busyIn(dir), touch: () => hub.touch(null, true) });
  const profileEnv = profileNodeEnv(() => mcp.githubUser() ?? null);
  const owners: OwnerSources = { accountOwnerName: () => account.ownerName(), signedIn: () => account.signedIn(), fullName: () => profileFullName(profileEnv), githubUser: () => mcp.githubUser() ?? null };
  const apkInfo = () => o.updater?.apk() ?? updateApk(dataDir(env));
  const profile = new ProfileScheduler();
  const profileCheckNow = (): Json => profileCheckJson(profileCheck(store, { confirmed: ownerConfirmed(store, owners), owner: ownerOf(store, owners), github: githubOf(store, owners) }));
  const peersNow = (): Peer[] => [...hub.mesh.peers.values()].sort((a, b) => Number(b.online) - Number(a.online) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // meshaccounts.ts: this PC's accounts and every other PC's, each sign-in once; another PC's run there.
  const localAccounts = (): LocalAccount[] =>
    accounts
      .filter((a) => a.off !== true && a.bin !== null)
      .map((a) => ({ id: a.id, kind: a.kind, email: a.email, badge: a.badge, short: providers.short(a), usable: providers.usable(a), models: a.kind === "Claude" ? [] : providers.staticModels(a.kind).map((m): [string, string] => [m.id, m.label]) }));
  const meshPeople = (): Person[] => {
    const me = aboutOwner(store, owners);
    return [{ name: me.owner, github: me.github }, ...[...hub.mesh.peers.values()].map((p) => ({ name: p.owner, github: p.github }))];
  };
  // People's photos (Settings › Workspace's): who is signed in here, then every member of this account's workspaces,
  // found by the email an account signs in with first (meshaccounts.ts `photoBook`).
  const meshPhotos = (): PhotoBook => {
    const me = account.account();
    return photoBook([...(me ? [{ name: me.name, email: me.email, image: me.image }] : []), ...account.directory().workspaces.flatMap((w) => w.members)]);
  };
  // Read for every chat of `/v1/state` (its allowed accounts): worked out at most every 2 s.
  let sharedCache: [number, SharedAccount[]] = [0, []];
  const sharedNow = (): SharedAccount[] => {
    const t = Date.now();
    if (t - sharedCache[0] < 2000) return sharedCache[1];
    sharedCache = [t, sharedFresh()];
    return sharedCache[1];
  };
  const sharedFresh = (): SharedAccount[] => {
    const me = aboutOwner(store, owners);
    // Only the PCs this account uses (account.ts `pcScope`), as the window's chats.
    const peers = hub.mesh.on ? peersNow().filter((p) => scopeHas(account.scope(), p.id)) : [];
    return sharedAccounts({
      me: { id: hub.mesh.me.id, name: hub.mesh.me.name === "" ? hostname() : hub.mesh.me.name, owner: me.owner, github: me.github },
      local: localAccounts(),
      peers,
      provs: new Map(peers.filter((p) => p.provs.length > 0).map((p) => [p.id, p.provs])),
      photos: meshPhotos(),
    });
  };
  /** hello's `accounts` to `peer`: those this PC doesn't let its chats use (Settings › Workspace, as its files) say `shared: false`. */
  const helloAccountsFor = (peer?: string): Json[] => {
    const level = peer === undefined ? "full" : machines.levelFor(store, peer);
    const kindOk = (k: string) => {
      const kind = providers.kindOf(kindLabel(k));
      return kind !== undefined && sharedWith(level, providers.access(kind).map((c) => c[0]));
    };
    // Every account, as before (Runs on and Move to PC read them); one this PC doesn't let `peer`'s chats use says so.
    return helloAccounts(localAccounts(), meshPeople(), { owner: aboutOwner(store, owners).owner, book: meshPhotos() }).map((a) => meshAccountJson(kindOk(a.kind) ? a : { ...a, shared: false }));
  };
  const pcsNow = (): Pc[] => {
    const [versions] = gatherVersions(versionsInput(hub, versionsOwn()));
    return meshPcs({
      kv: store,
      owners,
      me: hub.mesh.me,
      hostname: hostname(),
      meshOn: hub.mesh.on,
      localPhones: hub.localPhones().map((p) => ({ name: p.name, app: p.app })),
      versions,
      accounts: accounts.filter(providers.usable).map((a) => providers.short(a)),
      byPc: accountsByPc(sharedNow()),
      hosts: peersNow(),
      elsewhere: hub.elsewhere,
    });
  };
  const meshTurns = new MeshTurns({
    store,
    env: { dataDir: dataDir(env) },
    pcs: pcsNow,
    hostGithub: () => githubOf(store, owners),
    chat: (id) => engine?.chat(id),
    projectName: (c) => (c.repoId === null ? "" : (store.repos().find((r) => r.id === c.repoId)?.name ?? "")),
    cwd: (c) => engine?.chatCwd(c) ?? null,
    peer: (id) => {
      const p = hub.mesh.peer(id);
      return p ? { online: p.online, dest: dest(p) } : null;
    },
    notice: (id, text) => engine?.notice(id, "users", text, GUEST_NOTICE),
  });
  const detectNow = (): void => {
    if (!engine || profile.running || !(profileFull || profile.want)) return;
    const live = engine;
    const pcs = pcsNow();
    const main = accounts.find((a) => a.id === "claude" && providers.signedIn(a));
    const askable = main !== undefined && live.limits.blocked(main.id) === undefined && !(live.limits.quota.get(main.id) ?? []).some(([, used]) => used >= 0.9) && env.HARBOR_PROFILE_RULES === undefined;
    const inputs = () =>
      profileInputs({
        pcs,
        typedOwner: store.get(OWNER_KEY) ?? "",
        typedGithub: store.get(GITHUB_KEY) ?? "",
        accounts: accounts.filter((a) => a.off !== true).map((a) => ({ id: a.id, installed: a.bin !== null, loggedIn: a.loggedIn, short: providers.short(a), name: a.name, email: a.email })),
        ask: askable ? { model: recap.MODEL, run: (system, prompt) => recap.askWithin(providers.binStr(main), providers.accountEnv(main), system, prompt, 120_000) } : null,
      });
    const job = profile.tick({ nowMs: Date.now(), full: profileFull, kv: store, confirmed: ownerConfirmed(store, owners), inputs });
    if (!job) return;
    void detectProfiles(job.inputs, job.sig, profileEnv).then(
      (d) => {
        profile.finish(d, store);
        services?.publish();
        hub.touch(null, true);
      },
      () => {
        profile.running = false;
      },
    );
  };
  let profileFull = false;
  const versionsOwn = () => ({ hostname: hostname(), version: o.version, update: o.updater ? asJson(o.updater.info()) : null, served: apkInfo()?.code ?? 0 });
  const homeName = (c: Chat): string => (c.home !== "" ? hub.mesh.nameOf(c.home) : hub.mesh.me.name);
  const replica = new StoreReplica({
    about: () => aboutOwner(store, owners),
    forks: (chat) => engine?.forksOf(chat) ?? [],
    queued: (chat) => engine?.queuedCount(chat) ?? 0,
    pr: prOf,
    status: (chat) => phone.status(chat),
    worktree: (c) => {
      const w = engine?.worktreeOf(c) ?? null;
      return w === null ? null : basename(w);
    },
    items: (chat) => (engine ? engine.itemsOf(chat) : store.items(chat)),
    liveItems: (chat) => engine?.liveItems(chat) ?? null,
    live: (chat) => {
      if (!engine) return null;
      const since = engine.runningSince(chat);
      return since === null ? null : { running: true, sinceMs: since, queued: engine.queued(chat).length, status: phone.status(chat) };
    },
    store,
    hub,
    route: (call) => phoneRoute(call),
    version: o.version,
    update: () => (o.updater ? asJson(o.updater.info()) : null),
    accounts: (peer) => helloAccountsFor(peer),
    copied: (chat) => engine?.storeChanged(chat),
    cwd: (c) => engine?.chatCwd(c) ?? null,
    // A project's main chat is its owner's: another PC's project, or one shared or moved here by that PC (projectfold.ts).
    mainFrom: (repo, peer) => {
      const place = store.placement();
      return takesMainFrom({
        away: projectClones.place(repo)?.pc ?? null,
        peer,
        mine: account.workspace(),
        peerWs: directoryPcWorkspaces(account.directory()).get(peer) ?? "",
        moved: place.repos.get(repo) ?? "",
        shares: place.shared?.repos.get(repo) ?? [],
      });
    },
  });
  const uploadsDir = join(dataDir(env), "uploads");
  let api: Api | null = null;
  let move: MovePc | null = null;
  let projectMove: ProjectMove | null = null;
  const meshApp: MeshApp = {
    helloExtra: () => replica.helloExtra(),
    chats: (since, full) => replica.chats(since, full),
    items: (chat, since) => replica.items(chat, since),
    applyChats: (peer, epoch, body) => {
      // A chat handed to this peer whose answer was lost: its list settles it first.
      move?.reconcile(peer, body);
      return replica.applyChats(peer, epoch, body);
    },
    applyItems: (peer, epoch, hid, body) => replica.applyItems(peer, epoch, hid, body),
    route: async (call) => (await move?.route(call)) ?? (await services?.routeMesh(call)) ?? (await meshMore(call)) ?? replica.route(call),
  };
  // Dictation on this PC's SSH devices (made once the devices are read, below).
  let speech: devicespeech.DeviceSpeech | null = null;
  const meshMore = async (call: Call): Promise<Reply | null> => {
    if (call.path[0] !== "mesh" || call.path[1] !== "v1" || call.path.length !== 3) return null;
    const b = typeof call.body === "object" && call.body !== null && !Array.isArray(call.body) ? call.body : {};
    switch (`${call.method} ${call.path[2]}`) {
      case "GET voice": {
        // `warm=1`: a peer's person started dictating to this PC (or to its SSH device `device`), so the model loads while they speak.
        const device = call.query.find(([k]) => k === "device")?.[1] ?? "";
        if (call.query.some(([k, v]) => k === "warm" && v === "1")) {
          if (device !== "") speech?.warm(device);
          else if (parakeet.preload()) console.error(`harbor: loading the speech model for ${hub.mesh.peers.get(call.device)?.name ?? "a peer"}'s dictation`);
        }
        return ok(JSON.parse(JSON.stringify(dictate.status(hub.mesh.me.name, speech ?? undefined))));
      }
      case "POST app": {
        // A tool call of WhatsApp or Discord from another of this account's PCs: this PC runs it for the account (accountvault.ts).
        const r = single ? await single.serveMesh(hub.mesh.peers.get(call.device)?.fp, b) : { status: 404, body: { error: "no such app" } };
        return { status: r.status, body: r.body as Json };
      }
      case "POST memory": {
        const r = acceptMemory(store, b);
        return r.ok ? ok({ ok: true, changed: r.value }) : err(404, r.error);
      }
      case "POST preview": {
        const offer = preview.previewOffer(b);
        if (offer === null) return err(400, "no offer");
        const why = o.preview ? o.preview.refuses(machines.fullAccess(call.device), offer) : "previews are off on this PC";
        if (why !== null) return err(403, why);
        const p = hub.mesh.peers.get(call.device);
        if (!p) return err(404, "unknown PC");
        o.preview?.take(dest(p), p.name, offer);
        return ok({ taking: true });
      }
      case "POST phones":
        store.set("api_enabled", "1");
        hub.enabled = true;
        return ok({ ok: true });
      default:
        return null;
    }
  };
  // Free memory, sampled here and told to peers (the composer's Auto pick of where a chat runs).
  const ramMeter = new RamMeter();
  ramMeter.start();
  const mesh = new Mesh({
    hub,
    ram: () => ramMeter.mb(),
    // The machines this PC added by hand over SSH: peers and phones list them under it (Settings › Workspace, the phone's PCs).
    devices: () =>
      loadRemote(store)
        .devices.filter((h) => !isFound(h) && !h.hidden && h.host.trim() !== "" && scopeHasDevice(account.scope(), h.id))
        .map((h) => ({ id: h.id, name: hostLabel(h), os: h.os })),
    transcribe: async (wav, lang, from, device) => {
      const [status, body] = await dictate.servePeer(voicePeers, wav, lang, from, device === "" ? null : device);
      return { status, body: body as Json };
    },
    deliver: (from, kind, name, len, read) =>
      receiveDelivery(from, kind, name, len, {
        downloads: () => downloadsDir(),
        home: home(),
        copyText: (text) => void clipboard.copyText(text),
        copyImage: (bytes) => void clipboard.copyImage(bytes),
        open: (path) => void Bun.spawn(["xdg-open", path], { stdio: ["ignore", "ignore", "ignore"] }).exited.catch(() => undefined),
        notify: (title, body) => notifier.post("pc", `deliver:${title}`, title, body, "", false),
        read,
      }),
    kv: store,
    id: () => id,
    app: meshApp,
    workspacePeers: () => account.meshPeers(),
    // A PC that isn't trusted yet knocked: it may have just joined this PC's workspace (an accepted invitation).
    stranger: () => account.refreshSoon(),
    myAddrs: meshAddrs,
    uploadsDir,
    apkCode: () => apkInfo()?.code ?? 0,
    upload: async (r, q) => (api ? api.upload(r, q) : err(503, "Harbor is starting")),
    notes: { last: () => notes.last(), ownSince: (s) => { const [n, l] = notes.ownSince(s); return [n.map(noteJson), l]; } },
    memory: (chat) => memory.snapshot(engine ? memory.engineSource(engine) : { chats: [], runner: () => null, procs: [] }, chat) as Json,
    // Settings that are one value for the whole workspace ("Clean up dictation"): the newest change on any PC wins.
    shared: {
      snapshot: () => wssettings.snapshot(store),
      adopt: (peer, v) => {
        const took = wssettings.adopt(store, v);
        if (took.length === 0) return;
        if (took.includes(dictate.CLEANUP_KEY)) dictate.set({ cleanup: store.get(dictate.CLEANUP_KEY) === "1" });
        console.error(`harbor: workspace settings from ${hub.mesh.peers.get(peer)?.name ?? peer}: ${took.join(", ")}`);
      },
    },
    env,
  });
  wssettings.onChanged(store, () => void mesh.pushShared().catch(() => {}));
  mesh.reread();
  // Screenshots only (ram.ts fakePeers, a rig's own data): PCs that are on, with their free memory, in every PC list.
  const fakeDevices = env.HARBOR_FAKE_ACCOUNT ? fakePeerDevices(env.HARBOR_FAKE_ACCOUNT, id.fp) : new Map<string, PeerDevice[]>();
  for (const fp of new Set([...fakeOnline, ...fakeDevices.keys()])) {
    const pc = account.directory().peers.find((p) => p.fp === fp);
    if (pc) hub.mesh.peers.set(pc.id || fp, newPeer({ id: pc.id || fp, name: pc.name, fp, online: fakeOnline.includes(fp), version: pc.version, devices: fakeDevices.get(fp) ?? [] }));
  }
  const shotPeers = fakePeers(env.HARBOR_FAKE_PEERS);
  if (shotPeers.length > 0) {
    store.set("mesh_enabled", "1");
    mesh.reread();
    // As the mesh would: a PC this account doesn't use isn't followed, so it isn't a peer.
    // One standing in for a PC the data knows keeps what that one said (its devices).
    for (const p of shotPeers) if (scopeHas(account.scope(), p.id)) hub.mesh.peers.set(p.id, { ...p, devices: hub.mesh.peers.get(p.id)?.devices ?? p.devices });
  }
  hub.mesh.about = () => aboutOwner(store, owners);
  const remotes = new Remotes({
    home: home(),
    dataDir: dataDir(env),
    runner: systemRunner,
    selfExe: () => process.execPath,
    which: (bin) => providers.which(bin),
    mesh: () => ({ allowed: hub.mesh.workspacePeers(), peers: hub.mesh.peers }),
    lanAddrs: () => lanAddrs(env),
  });
  await remotes.refresh();
  const deviceList = (): [RemoteHost, boolean | null][] => remotes.devices(loadRemote(store), remotes.tailnetCached());
  // Settings › Devices' hand-added POSIX machines can transcribe dictation (PCs Harbor found run their own Harbor).
  speech = new devicespeech.DeviceSpeech({
    devices: () => {
      const cfg = loadRemote(store);
      return cfg.devices
        .filter((h) => !isFound(h) && !h.hidden && h.host.trim() !== "" && shellFamily(h.os) === "posix" && scopeHasDevice(account.scope(), h.id))
        .map((h) => ({ id: h.id, name: hostLabel(h), ssh: deviceSshArgs(remotes, cfg, h) }));
    },
    keepSecs: () => dictate.KEEP_MIN * 60,
  });
  // remoteui.rs `remote_spec`: how a chat's turn reaches its device; null for this PC.
  const remoteSpec = (chat: Chat, account: Account): agent.RemoteSpec | null => {
    if (chat.device === "") return null;
    const cfg = loadRemote(store);
    const h = remotes.find(cfg, remotes.tailnetCached(), chat.device);
    if (h === null) throw new Error("This chat's device isn't in Settings › Workspace anymore. Add it again, or start a new chat on this PC.");
    if (account.kind !== "Claude") throw new Error(`Only Claude Code runs on other devices so far; this chat uses ${account.kind}.`);
    const repo = chat.repoId === null ? undefined : store.repos().find((r) => r.id === chat.repoId);
    const project = repo ? repoDir(repo) : null;
    const dir = remoteDir(home(), h, project);
    if (h.os === "") void remotes.testOnce(cfg, h);
    const os = h.os === "" ? "" : `It runs ${osLabel(h.os)}. `;
    const commands = h.commands && chat.access !== "plan";
    const bridgeText = !h.bridge ? "" : commands && h.device_files ? "Your MCP servers are the Harbor PC's, through a bridge; the `origin` server's run_command runs shell commands on the Harbor PC." : "Your MCP servers are the Harbor PC's, through a bridge.";
    const base = `You run on the device '${hostLabel(h)}', started over SSH by Harbor on '${hostname()}', in ${dir}. ${os}The user talks to you through Harbor, usually at that PC; a message written on a phone or another PC says where it came from. ${h.device_files ? "Files, shell, git and builds are that device's. " : ""}Harbor's own tools (processes, agents, webhooks) act on the Harbor PC. ${bridgeText}`;
    const token = oauth.token(account.configDir);
    // With this PC's login the device's own profile is swapped for an empty one, and this PC's person's go in the note (meshctx.rs).
    const guest = token !== null;
    const note = guest ? `${base.trimEnd()}\n\n${deviceNote({ home: home(), hostname: hostname() }, project, !h.device_files)}` : base;
    return {
      ssh: remotes.sshOpts(cfg, h),
      host: h.host,
      name: hostLabel(h),
      family: shellFamily(h.os),
      dir,
      setup: guest ? [{ kind: "guest", rel: deviceProfile(hub.mesh.me.id) }] : profileSetup(home(), account.configDir),
      bridge: h.bridge,
      commands,
      workspace: !h.device_files,
      token,
      note: note.trim(),
    };
  };
  const blockerOf = (c: Chat): string | null => {
    const subs = store.subs(c.id);
    const chats = [c, ...subs].map((x) => ({ id: x.id, name: x.name, device: x.device, claude: accounts.find((y) => y.id === x.account)?.kind === "Claude", running: engine?.running(x.id) ?? false }));
    const lead = deviceList().find(([h]) => h.id === c.device)?.[0];
    return relocateBlocker({ foreignHome: c.home !== "" ? hub.mesh.nameOf(c.home) : null, isSub: c.role === "sub", movingTo: move?.movingTo(c.id) ?? null, chats, leadDevice: lead ? { os: lead.os } : null });
  };
  catalog.relocateBlocker = blockerOf;
  catalog.shared = sharedNow;
  catalog.movingTo = (c) => move?.movingTo(c.id) ?? null;
  catalog.deviceWhy = (c) => {
    const devs = deviceList();
    const hosts = [...hub.mesh.peers.values()];
    const ids = ["", ...devs.filter(([h]) => !h.hidden).map(([h]) => h.id), ...hosts.map((p) => p.id)];
    // The blocker is the same for every place: worked out once, and only when a place asks for it.
    let blocker: string | null | undefined;
    const once = () => (blocker === undefined ? (blocker = blockerOf(c)) : blocker);
    return deviceWhy(c.started, c.home !== "", ids, (id) => relocateWhy({ started: c.started, device: c.device, to: id, blocker: once, place: placeOf(id, hosts, devs), meshOn: hub.mesh.on }));
  };
  const ctxFor = (repo: number | null): Json => {
    const r = repo === null ? undefined : store.repos().find((x) => x.id === repo);
    const ctx = outgoingCtx(store, { home: home(), dataDir: dataDir(env), hostname: hostname() }, owners, r ? repoDir(r) : null);
    // Its memory id may be new: the share listener knows it at once.
    services?.publish();
    return ctx;
  };
  const newWorktree = {
    make: async (repo: number | null, base: string, about: string) => {
      const info = worktrees.info({ t: "draft", repo });
      return info ? worktrees.make(info.repo, base, about) : null;
    },
    attach: (chat: number, made: unknown) => worktrees.attach(chat, made as worktree.Made),
    discard: (repo: number | null, made: unknown) => {
      const info = worktrees.info({ t: "draft", repo });
      if (info) void worktrees.discard(info.repo, (made as worktree.Made).dir);
    },
  };
  const phone = new PhoneRoutes({
    ctx: ctxFor,
    shareLevel: (peer) => machines.levelFor(store, peer),
    projectPlace: (repo) => projectClones.place(repo),
    store,
    hub,
    replica,
    mesh,
    version: o.version,
    myFp: () => id.fp,
    devices: () => remotes.devices(loadRemote(store), remotes.tailnet()).filter(([h]) => scopeHasDevice(account.scope(), h.id)),
    scope: (home) => scopeHas(account.scope(), home),
    pr: prOf,
    dropChat: (c) => worktrees.drop(c),
    worktrees: newWorktree,
    openedFrom: (chat, gid, title) => eng().notice(chat, "chat", openchat.openedBy(title), `${openchat.LINK}${gid}`),
    more: phoneRoutes({ store, hub, engine: () => eng(), phone: () => phone, uploadId: (path) => phone.uploadId(path), versionsOwn, owners, profile, profileCheck: profileCheckNow, republish: () => services?.publish(), worktrees, projectClones, projects, moves, wantPr: (chat) => prs.want(chat, chatpr.SHOWN_TTL_MS) }),
    app: () => ({ version_code: apkInfo()?.code ?? 0, url: "/app.apk" }),
    profileCheck: profileCheckNow,
    bars: (chat, nowMs) => statusBars({ engine: eng(), clones, homeName }, chat, nowMs),
    engine: null,
    uploadsDir,
    updates: () => ({ hub_update: o.updater ? asJson(notices.hubUpdate(o.updater.info(), o.updater.state(), o.updater.asked())) : null }),
    catalog,
    voice: () => ({ transcribe: true, why: null, lang: voice.config()[0] }),
    // Relative paths start where the chat works; another PC's chat has its files there.
    find: (text, c) => media.find(text, c.home === "" && engine ? engine.chatCwd(c) : null),
    refs: { strip: (md) => media.stripRefs(md), parts: (md) => media.parts(md) },
    runSettings: {
      accounts: () => accounts,
      modelsFor: (k) => providers.staticModels(k),
      // The devices of Settings › Workspace; Tailscale's PCs and paired ones aren't offered from the phone yet.
      devices: () => loadRemote(store).devices.map((h) => h.id).filter((d) => scopeHasDevice(account.scope(), d)),
      setFast: (on) => {
        if (engine) engine.fast = on;
      },
    },
    commits: (c) => {
      const r = c.device !== "" || c.repoId === null ? null : store.repos().find((x) => x.id === c.repoId);
      const wt = r && c.home === "" ? (engine?.worktreeOf(c) ?? null) : null;
      const dir = wt !== null && existsSync(wt) ? wt : r ? repoDir(r) : null;
      if (dir === null || !existsSync(dir)) return null;
      return { ofText: (md) => commits.ofText(dir, md, () => hub.touch(c.id, false)), tokens: (t) => commits.tokens(t) };
    },
  });
  const deviceMemory = new DeviceMemory({
    devices: () => {
      const ids = new Set(loadRemote(store).devices.map((h) => h.id));
      return deviceList().filter(([h]) => ids.has(h.id));
    },
    harbors: () => ({ ids: [hub.mesh.me.id, ...hub.mesh.peers.keys()], names: [hub.mesh.me.name, hostname(), ...[...hub.mesh.peers.values()].map((p) => p.name)] }),
    read: (h) => sshOutput([...remotes.sshOpts(loadRemote(store), h), h.host, memory.DEVICE_RAM_SH]),
    running: (device) => (engine ? [...engine.turns.keys()].filter((id) => engine?.chat(id)?.device === device).length : 0),
  });
  const windowMesh = new WindowMesh({
    hub,
    mesh,
    devices: deviceMemory,
    replica,
    phone,
    env,
    chat: (id) => (engine ? engine.chat(id) : store.chat(id)),
    ownerName: () => account.ownerName(),
    ctx: ctxFor,
    uploadsDir,
  });
  // The hooks below run once the engine exists.
  const eng = (): Engine => {
    if (!engine) throw new Error("the engine isn't started");
    return engine;
  };
  const host: HubHost = {
    // A window's Engine shares the hub's accounts: one list, read again every minute and when usage is asked for.
    accounts: () => accounts,
    rediscover,
    changed: (chat) => {
      hub.touch(chat, true);
    },
    isForeign: (chat) => hub.mesh.foreign.has(chat),
    copyTurn: (chat) => replica.remote.get(chat) ?? null,
    hostname: () => hub.mesh.me.name,
    // Names the chat's own PC (a copy's home), as chatlink.rs `App::chat_link` did.
    chatLink: (c) => chatLinkOf(c.gid, homeName(c)),
    remoteSpec,
    hookBase: () => hookcert.publicBase() ?? funnel.base,
    offline,
    turnEnded: (id) => {
      prs.want(id, null);
      void meshTurns.afterTurn(id).catch(() => undefined);
    },
    turnContext: (chat, remote) => meshTurns.context(chat, remote),
    adopt: (id, from) => meshTurns.adopt(id, from),
    moving: (chat) => (move?.movingTo(chat) ?? null) !== null,
    hold: (chat, text, files, mentions) => move?.hold(chat, text, files, mentions) ?? false,
    // A chat of a project that moved to another PC doesn't run in the folder it left here.
    missingFolder: (c) => projectMove?.movedLine(c) ?? projectClones.missingFolder(c),
    holdForClone: (c, prompt, files) => (projectMove?.movedLine(c) ?? null) === null && projectClones.holdForClone(c, prompt, files),
  };
  // A window's Engine adds its own notifications; one the hub makes notifies through the hub.
  const own: Partial<EngineHost> = {
    keepMedia: (text, cwd) => media.keep(text, cwd),
    adoptMedia: (text, cwd, chat) => media.adopt(text, cwd, chat),
    noteTurn: (id, sub, failed, said) => {
      const c = eng().chat(id);
      if (!c) return;
      const project = c.repoId === null ? null : (eng().repo(c.repoId)?.name ?? null);
      notifier.noteTurn({ gid: c.gid, title: c.title, name: c.name, home: c.home, project }, sub, failed, said);
    },
    noteLimit: (id, account, waits, note) => notifier.noteLimit(eng().chat(id) ?? null, account, eng().accountLabel(account), waits, note),
    noteResumed: (id, account, text) => notifier.noteResumed(eng().chat(id) ?? null, account, eng().accountLabel(account), text, eng().limits.limitSettings().notify),
    notify: (kind, key, title, body, chat) => notifier.post(kind, key, title, body, chat ?? "", false),
  };
  const voicePeers: dictate.Mesh<dictate.MeshPeer & { dest: Dest }> = {
    on: () => hub.mesh.on,
    me: () => ({ name: hub.mesh.me.name, id: hub.mesh.me.id }),
    peers: () => [...hub.mesh.peers.values()].filter((p) => p.online && p.fp !== "").map((p) => ({ id: p.id, name: p.name, online: p.online, dest: dest(p) })),
    known: () => [...hub.mesh.peers.values()].map((p) => ({ id: p.id, name: p.name, online: p.online })),
    http: (p, method, path, body, waitMs) => http(p.dest, method, path, body, waitMs),
    ...(speech ? { speech } : {}),
  };
  engine = o.engine ? o.engine(host, notes, voicePeers) : new Engine({ store, ...host, ...own });
  const live = engine;
  // The secret cards waiting for the user, read at most once a second (a chat list asks for each chat's `wait`).
  let asks: { at: number; list: secrets.Ask[] } = { at: 0, list: [] };
  const asksNow = (): secrets.Ask[] => {
    if (Date.now() - asks.at > 1000) asks = { at: Date.now(), list: secrets.loadAsks(store) };
    return asks.list;
  };
  // A captcha the chat's agent hit goes into that chat's transcript (its card, then its outcome), and the notification opens that chat.
  const stopDiscord =
    o.discordNotices === true && !offline
      ? (() => {
          // Captcha cards this PC's chats show as waiting: one whose captcha no host holds any more ends as expired.
          const captchas = new discord.PendingCaptchas();
          captchas.seed(store.noticeDetails("captcha").filter(([id]) => live.chat(id)?.home === ""));
          const post = (n: discord.NoticeOf): void => {
            const at = discord.postNotice(n, {
              chat: (id) => live.chat(id),
              caller: () => discordCaller(live),
              adopt: (captcha, chat) => void discord.adoptCaptcha(captcha, chat),
              notice: (id, icon, text, detail) => live.notice(id, icon, text, detail),
              changed: (id) => live.host.changed?.(id),
              notify: (kind, key, title, body, chat) => live.host.notify?.(kind, key, title, body, chat),
            });
            if (at !== undefined && n.captcha !== undefined) captchas.note(at, n.captcha);
          };
          return discord.watch(post, 5000, () => void captchas.check(post));
        })()
      : () => {};
  const stopWhatsapp = o.whatsappKeep === true && !offline ? whatsapp.keep((n) => live.host.notify?.("whatsapp", n.key, n.title, n.body)) : () => {};
  const funnel = new Funnel(() => providers.which("tailscale") !== null, () => live.hookPort);
  const moveAccounts = (): MovePcAccount[] =>
    accounts.map((a) => ({
      id: a.id,
      claude: a.kind === "Claude",
      email: a.email,
      short: providers.short(a),
      configDir: a.configDir,
      usable: a.kind === "Claude" && providers.usable(a) && live.limits.blocked(a.id) === undefined && live.limits.ctl.overCap(a.id) === undefined,
      usage: live.limits.usageOf(a.id),
      kind: a.kind.toLowerCase(),
      // A switch to it by name (meshaccounts.ts): any provider that can run turns now.
      ready: providers.usable(a) && live.limits.blocked(a.id) === undefined && live.limits.ctl.overCap(a.id) === undefined,
    }));
  const mover = new MovePc({
    store,
    engine: live,
    mesh: hub.mesh,
    forward: (...a) => mesh.forward(...a),
    accounts: moveAccounts,
    home: home(),
    uploadsDir,
    worktreeRoot: worktree.root(),
    overlays: () => overlays({ dataDir: dataDir(env) }),
    removeWorktree: (repo, dir) => worktree.remove(repo, dir),
    reindex: () => replica.reload(),
    forget: (chat) => live.host.forgetWorkspace?.(chat),
    shareLevel: (peer) => machines.levelFor(store, peer),
    accessOf: (kind) => {
      const k = providers.kindOf(kindLabel(kind));
      return k === undefined ? [] : providers.access(k).map((c) => c[0]);
    },
  });
  mover.load();
  move = mover;
  const moveScratch = join(dataDir(env), "move-scratch");
  const projectsChanged = () => {
    live.reload();
    hub.touch(null, true);
  };
  const pm = new ProjectMove({
    store,
    movepc: mover,
    mesh: hub.mesh,
    forward: (...a) => mesh.forward(...a),
    home: home(),
    scratch: moveScratch,
    running: (id) => live.running(id),
    icon: (repo) => (existsSync(favicon.customPath(repo)) ? ProjectMove.iconBytes(favicon.customPath(repo)) : null),
    touch: projectsChanged,
  });
  pm.load();
  projectMove = pm;
  const receiver = new ProjectReceiver({
    meName: () => hub.mesh.me.name,
    home: home(),
    kv: store,
    scratch: moveScratch,
    repos: () => store.repos().map((r) => ({ id: r.id, name: r.name, dir: repoDir(r), remote: r.remote, left: movedProject(store, r.id, repoDir(r)) !== null })),
    manifest: (dir) => manifestOf(scanFolder(dir)),
    // What stood for the project here before: its copies' entry, or (it came back) the one it left.
    dropStale: (path, keep, peer) => {
      const chats = store.chats();
      for (const r of store.repos()) {
        if (repoDir(r) === keep || chats.some((c) => c.repoId === r.id)) continue;
        const left = movedProject(store, r.id, repoDir(r));
        const back = left !== null && left.pc === peer && left.dir === path;
        if (!back && (r.path !== path || existsSync(repoDir(r)))) continue;
        store.removeRepo(r.id);
        store.set(`project_moved:${r.id}`, "");
        windowProjects?.removed(r.id);
      }
      projectsChanged();
    },
    addProject: (dir, name, remote) => {
      const known = store.repos().find((r) => repoDir(r) === dir);
      const id = known ? known.id : addFolder(store, dir, remote, env.HOME ?? homedir());
      if (remote !== "" && (known || store.repos().find((r) => r.id === id)?.remote === "")) store.setRepoRemote(id, remote);
      if (name !== "") store.setRepoName(id, name);
      store.set(`project_moved:${id}`, "");
      projectsChanged();
      windowProjects?.icon(id, true);
      return id;
    },
    settle: (repo, st) => {
      if (st.name !== "") store.setRepoName(repo, st.name);
      const byGid = (g: string) => store.chats().find((c) => c.gid === g && c.home === "");
      const main = st.main === "" ? undefined : byGid(st.main);
      if (main && main.repoId === repo) store.setMainChat(repo, main.id);
      if (st.settled > 0) {
        store.settleProject(repo, true, st.settled);
        store.set(`project_settled:${repo}`, JSON.stringify(st.settledChats.flatMap((g) => byGid(g)?.id ?? [])));
        windowProjects?.settled(repo, true);
      }
      if (st.snooze * 1000 > Date.now()) {
        let all: Record<string, unknown> = {};
        try {
          all = JSON.parse(store.get("snoozed") ?? "{}") as Record<string, unknown>;
        } catch {
          // none
        }
        all[`r${repo}`] = st.snooze;
        store.set("snoozed", JSON.stringify(all));
      }
      const icon = iconFile(moveScratch, st.icon);
      if (icon !== null) {
        if (favicon.setCustom(repo, icon)) windowProjects?.icon(repo, false);
        rmSync(icon, { force: true });
      }
      projectsChanged();
      return null;
    },
  });
  receiver.load();
  mesh.d.project = { route: (peer, sub, body) => receiver.route(peer, sub, body), piece: (peer, m, st, seq, data) => receiver.piece(peer, m, st, seq, data) };
  const runOn = new RunOn({
    store,
    engine: live,
    mover,
    remotes,
    meshOn: () => hub.mesh.on,
    hosts: () => [...hub.mesh.peers.values()],
    me: () => ({ name: hub.mesh.me.name, hostname: hostname() }),
    accounts: () => accounts,
    remoteSpec,
    dataDir: dataDir(env),
    home: home(),
    overlays: () => overlays({ dataDir: dataDir(env) }),
    ram: () => ramMeter.mb(),
    scope: () => account.scope(),
  });
  mover.relocate = (chat, pc, auto) => runOn.relocate(chat, pc, auto);
  phone.d.relocate = { why: (chat, to) => runOn.why(chat, to), relocate: (chat, to) => runOn.relocate(chat, to) };
  phone.d.auto = { pick: (kind) => runOn.autoPick(kind), resolve: (device, kind) => runOn.resolve(device, kind), mark: (gid, place) => runOn.markAuto(gid, place), label: (c, here) => runOn.autoLabel(c, here), relocate: (chatId, kind) => runOn.relocateAuto(chatId, kind), why: (chatId, kind) => runOn.autoWhy(chatId, kind) };
  phone.d.move = { targetsJson: (chat) => mover.targetsJson(chat), movePc: (chat, pc, want) => mover.movePc(chat, pc, false, want ?? null) };
  phone.d.engine = {
    running: (id) => live.running(id),
    runningSince: (id) => live.runningSince(id),
    transcript: (id) => live.transcript(id),
    send: (id, text, opts) => live.send(id, text, opts),
    stop: (id) => live.stop(id),
    queued: (id) => live.queued(id),
    takeQueue: (id) => live.takeQueue(id),
    queueJson: (id) => live.queueJson(id),
    steering: (id) => live.steering(id),
    followDefault: () => live.followDefault(),
    held: (id) => live.queue.held.has(id),
    newThread: (repo, first, sel) => live.newThread(repo, first, sel),
    reload: () => live.reload(),
    worktreeOf: (id) => {
      const c = store.chat(id);
      return c ? live.worktreeOf(c) : null;
    },
    queuePromote: (id, q) => live.queuePromote(id, q),
    queueMove: (id, q, to) => live.queueMove(id, q, to),
    queueUpdate: (id, q, text, mentions, editing) => live.queueUpdate(id, q, text, mentions, editing),
    queueRemove: (id, q) => live.queueRemove(id, q),
    queueResume: (id) => live.queueResume(id),
    recap: (id) => live.recaps.shownFor(id),
    unread: (id) => live.unread.has(id),
    failed: (id) => live.failed.has(id),
    opened: (id) => live.opened(id),
    subsQueued: (lead) => live.subsQueued(lead),
    queuedCount: (id) => live.queuedCount(id),
    mainChat: (repo) => live.mainChat(repo),
    forksOf: (id) => live.forksOf(id),
    wait: (id) => waitJson(live, id, Date.now(), asksNow()),
  };
  live.reattachTurns();
  // Processes the agents started before a restart: their exits still wake them (and they wait on them
  // meanwhile). A copy of someone's data (offline) leaves them to that data's own Harbor.
  if (!offline) live.adoptProcs();
  live.limits.load();
  let engineTimer: ReturnType<typeof setTimeout> | null = null;
  let profileAt = 0;
  const engineTick = () => {
    const next = live.tick();
    if (!offline) {
      prs.sweep((c) => live.worktreeOf(c) !== null);
      worktrees.tickMoves();
      cleaner?.tick();
      profileFull = Date.now() - profileAt >= 10_000;
      if (profileFull) profileAt = Date.now();
      detectNow();
    }
    engineTimer = setTimeout(engineTick, Math.min(Math.max(next ?? 1000, 50), 1000));
  };
  engineTick();
  const route = async (call: Call): Promise<Reply> => {
    const updated = await updateRoute(o.updater ?? null, call, store);
    if (updated !== null) return updated;
    const at = `${call.method} ${call.path.join("/")}`;
    if (at === "GET v1/voice") return ok(JSON.parse(JSON.stringify(dictate.status(hub.mesh.me.name))));
    if (at === "PUT v1/voice/settings") {
      const b = typeof call.body === "object" && call.body !== null && !Array.isArray(call.body) ? (call.body as Record<string, unknown>) : {};
      // Stored here too: the kv is read again every 15 s, with or without a window to save it.
      if (typeof b.cleanup === "boolean") store.set(dictate.CLEANUP_KEY, b.cleanup ? "1" : "0");
      dictate.set({ ...(typeof b.cleanup === "boolean" ? { cleanup: b.cleanup } : {}), ...(typeof b.keep_loaded_min === "number" && Number.isInteger(b.keep_loaded_min) && b.keep_loaded_min >= 0 ? { keepMin: b.keep_loaded_min } : {}) }, true);
      dictate.setWords({ ...(typeof b.commands === "boolean" ? { commands: b.commands } : {}), ...(Array.isArray(b.dictionary) ? { dict: dictwords.parse(b.dictionary) } : {}) }, true);
      return ok(JSON.parse(JSON.stringify(dictate.status(hub.mesh.me.name))));
    }
    if (at === "POST v1/voice/cleanup") {
      const b = typeof call.body === "object" && call.body !== null && !Array.isArray(call.body) ? (call.body as Record<string, unknown>) : {};
      return ok({ text: await dictate.cleanupText(typeof b.text === "string" ? b.text : "") });
    }
    return (await services?.routePhone(call)) ?? phone.route(call);
  };
  phoneRoute = route;
  const apk = () => apkInfo()?.path ?? null;
  api = new Api({
    hub,
    id: () => id,
    uploadsDir,
    route,
    account: account.phoneAuth(),
    appInfo: () => ({ version_code: apkInfo()?.code ?? 0, url: "/app.apk", hub: o.updater ? asJson(o.updater.info()) : null }),
    apk,
    ...(o.preview ? { previewFile: (kind: string, id: string) => o.preview?.file(kind, id) ?? null } : {}),
    mesh: (p, q, r) => mesh.serve(p, q, r),
    meshAdmitted: (p, q) => mesh.admitted(p, q),
    relay: (p, q, r, w) => relayServe({ hub, myFp: () => id.fp, isPhone: (pp, rq) => { try { return api?.caller(pp, rq).level === null; } catch { return false; } } }, p, q, r, w),
    hubs: () => mesh.hubs(),
    forwardLease: (...a) => mesh.forwardLease(...a),
    // Another PC's chat: its images and videos are that PC's files, fetched from it.
    homeImage: (chat, path, max) => mesh.homeImage(chat, path, max),
    homeMedia: (chat, path, range) => mesh.homeMedia(chat, path, range),
    image: (path, max) => media.imageAnswer(path, max),
    mediaCheck: (path) => {
      const c = media.check(path);
      return c.ok ? null : c.error;
    },
    mime: (path) => media.mime(path),
    located: (path) => media.located(path),
    mediaWait: (path) => media.waitFor(path, 20_000),
    transcribe: async (wav, q) => {
      const get = (k: string) => q.find(([x]) => x === k)?.[1] ?? null;
      const langQ = get("lang");
      const lang = langQ === null || langQ === "" || langQ === "default" ? voice.config()[0] : langQ;
      try {
        const d = await dictate.transcribe(voicePeers, voice.wavSamples(wav), lang, { cleanup: get("cleanup") === "1" || (get("cleanup") !== "0" && dictate.cleanupOn()), commands: get("commands") === "1", localOnly: get("local") === "1", from: "a phone" });
        const v: Record<string, string | boolean> = { text: d.text, host: d.host };
        if (d.send) v.send = true;
        if (d.raw !== null) v.raw = d.raw;
        if (d.warn !== undefined) v.warn = d.warn;
        return ok(v);
      } catch (e) {
        return err(409, e instanceof Error ? e.message : String(e));
      }
    },
    reached: (ip) => portmap.reached(ip),
    env,
  });
  services = await startServices({ store, hub, mesh, engine: live, version: o.version, env, versionsOwn: () => ({ update: versionsOwn().update, served: versionsOwn().served }), account, composer: () => catalog.defaults(), accounts: () => accounts, ...(offline ? { hookPort: false as const } : o.hookPort === undefined ? {} : { hookPort: o.hookPort }) });
  if (!offline) void funnel.check();
  if (!offline) {
    const bound = await api.listen();
    hub.net = { addrs: addrs(), bound, error: hub.net.error };
    mesh.start();
  }
  // HARBOR_NO_DISCOVERY: a test hub neither hears nor answers the PCs on the network.
  const disc = offline || env.HARBOR_NO_DISCOVERY !== undefined ? null : await discoverStart({ shared: hub.mesh, me: () => ({ id: hub.mesh.me.id, name: hub.mesh.me.name, fp: id.fp, port, version: o.version, on: hub.mesh.on }) });
  const stopMap = env.HARBOR_LISTEN === undefined && !offline ? portmap.start(port, () => true) : () => {};
  // The speech model comes by itself, so the first dictation (here, or from a phone or PC that picks this one) needn't wait.
  const stopSpeech = env.HARBOR_LISTEN === undefined && !offline ? voice.keepParakeet() : () => {};
  // The voice keys this PC's own (cleanup, Transcribe on) are read again now and then: a change written
  // to the database from outside (another tool, a fix by hand) applies without a restart.
  const voiceKv = setInterval(() => dictate.loadFrom(store), 15_000);
  voiceKv.unref();
  const signIn = env.HARBOR_TEST_NO_SIGNIN === undefined && !offline && existsSync(join(state, "account.json"));
  if (signIn) account.start();
  const tick = setInterval(() => {
    hub.enabled = true;
    const a = addrs();
    if (JSON.stringify(a) !== JSON.stringify(hub.net.addrs)) {
      hub.net = { ...hub.net, addrs: a };
      hub.touch(null, true);
      disc?.announceNow();
    }
    if (hub.tokensDirty) {
      hub.tokensDirty = false;
      saveTokens(store, hub.tokens);
    }
    hub.rememberPhones(store);
    hub.saveDrafts(store);
    replica.reload();
    if (o.updater) for (const p of hub.mesh.peers.values()) o.updater.peerNews(p.update);
  }, 10_000);
  const refresh = setInterval(rediscover, 60_000);
  return {
    store,
    hub,
    api,
    mesh,
    phone,
    engine: live,
    move: mover,
    projectMove: pm,
    runOn,
    sharedAccounts: sharedNow,
    windowMesh,
    setBusyIn: (f) => {
      busyIn = f;
    },
    setWindowProjects: (p) => {
      windowProjects = p;
    },
    funnel,
    prs,
    account,
    moves,
    devices: () => {
      const me = hub.mesh.me;
      const peers = [...hub.mesh.peers.values()];
      const served = apkInfo()?.code ?? 0;
      const [pcs] = gatherVersions({ me, hostname: me.name, meshOn: hub.mesh.on, peers, version: o.version, update: null, paired: [], local: [], elsewhere: [], served });
      return { list: pairedDevices(hub, pcs), served };
    },
    deviceEnv: { hub, peer: (key) => hub.mesh.peers.get(key) ?? null },
    deviceHost: (d) => {
      if (isPhoneDevice(d)) return null;
      // surface.rs device_host: as Settings › Workspace knows it, else the PC with the defaults.
      const cfg = loadRemote(store);
      const h = remotes.find(cfg, remotes.tailnetCached(), d.key) ?? newHost({ id: d.key, name: d.name, host: d.ip, bridge: true });
      return { shell: remotes.shellArgv(cfg, h, null), ssh: deviceSshArgs(remotes, cfg, h) };
    },
    services,
    projectPlace: (repo) => projectClones.place(repo),
    call: (method, path, query = {}, body = null) => route({ method, path: path.split("/").filter((x) => x !== ""), query: Object.entries(query), body, token: "", device: "", global: false }),
    newWorktree: {
      make: (repo, base, about) => newWorktree.make(repo, base, about),
      attach: (chat, made) => newWorktree.attach(chat, made),
      discard: (repo, made) => newWorktree.discard(repo, made),
    },
    stop: async () => {
      clearInterval(tick);
      hub.saveDrafts(store);
      if (engineTimer) clearTimeout(engineTimer);
      for (const [id, r] of live.turns) {
        live.persist(id);
        r.turn?.release();
      }
      clearInterval(refresh);
      services?.stop();
      stopDiscord();
      stopWhatsapp();
      stopSettled();
      mesh.stop();
      disc?.stop();
      stopMap();
      stopSpeech();
      clearInterval(voiceKv);
      speech?.stop();
      if (signIn) await account.stop();
      api?.close();
    },
  };
}
