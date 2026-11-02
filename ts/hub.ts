import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { phoneRoutes } from "./phoneroutes.ts";
import { RunOn } from "./runon.ts";
import { ProjectClones } from "./projectclones.ts";
import { ProjectsApi } from "./projectsapi.ts";
import { Worktrees } from "./worktrees.ts";
import { statusBars } from "./statusbars.ts";
import { type Account, agent, chatpr, commits, openchat, Engine, type EngineHost, oauth, providers, recap, worktree } from "./packages/agents/src/index.ts";
import { clipboard, dictate, dictwords, media, parakeet, voice } from "./packages/media/src/index.ts";
import { Funnel, hookcert, machines, mcp } from "./packages/mcp/src/index.ts";
import {
  AccountService,
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
  type Reply,
  preview,
  outgoingCtx,
} from "./packages/net/src/index.ts";
import { WindowMesh } from "./windowmesh.ts";
import { GUEST_NOTICE, MeshTurns } from "./meshturns.ts";
import { type Chat, dataDir, home, repoDir, stateDir, Store } from "./packages/store/src/index.ts";
import { apk as updateApk, notices, type Updater } from "./packages/update/src/index.ts";
import { type Services, startServices } from "./services.ts";

export type HubHost = Pick<EngineHost, "changed" | "isForeign" | "hostname" | "chatLink" | "offline" | "turnEnded" | "moving" | "hold" | "hookBase" | "missingFolder" | "holdForClone" | "remoteSpec" | "turnContext" | "adopt">;

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
  runOn: RunOn;
  windowMesh: WindowMesh;
  funnel: Funnel;
  prs: chatpr.ChatPrs;
  account: AccountService;
  /** What else holds a worktree folder's rename back: the window's terminals open in it. */
  setBusyIn(f: (dir: string) => string | null): void;
  /** Devices: what is paired, and the versionCode of the phone app this PC serves. */
  devices(): { list: PairedDevice[]; served: number };
  deviceEnv: DeviceSendEnv;
  /** A paired PC's terminal (ssh into it) and its ssh options for the file browser; null for phones. */
  deviceHost(d: PairedDevice): { shell: string[]; ssh: string[] } | null;
  services: Services;
  stop(): Promise<void>;
}

function catalogAccount(a: providers.Account): CatalogAccount {
  return { id: a.id, kind: a.kind, name: a.name, badge: a.badge, bin: a.bin, loggedIn: a.loggedIn, usage: a.usage.map((u) => ({ label: u.label, percent: u.percent })) };
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
    store.set("auto_update", on ? "1" : "0");
    return ok({ ok: true, auto: on });
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

/** Harbor without its window (Rust's `--background`): the phone API, the mesh, discovery, port mapping and the account loop. */
export async function startHub(o: HubOptions): Promise<RunningHub> {
  const env = o.env ?? process.env;
  const offline = isOffline(env);
  const store = o.store ?? Store.open(dataDir(env));
  const state = stateDir(env);
  const id = loadOrCreate(state);
  const me = readMe(store, env);
  const portText = store.get("api_port") ?? "";
  const port = /^\d+$/.test(portText) ? Number(portText) : 47930;
  const hub = new Hub(loadTokens(store), port);
  hub.mesh.me = me;
  hub.enabled = store.get("api_enabled") === "1";
  hub.loadRemembered(store);
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
  let engine: Engine | null = null;
  const mirrorDictation = (): void => {
    // As voice.rs: not while the account is blocked by a usage limit.
    const a = accounts.find((x) => x.id === "claude" && x.bin !== null && x.loggedIn === true && engine?.limits.blocked(x.id) === undefined);
    dictate.setAccount(a ? (system, prompt, ms) => recap.askWithin(providers.binStr(a), providers.accountEnv(a), system, prompt, ms) : null);
  };
  mirrorDictation();
  const catalog = catalogOf(providers, () => accounts.map(catalogAccount), store);
  const portmap = new Portmap({ kv: store, net: lanPortmapNet() });
  const addrs = () => phoneAddrs(port, lanAddrs(env), portmap.publicAddr());
  const meshAddrs = () => addrs().map((a) => (parseIp(a) ? hostPort(a, port) : a));
  const account = new AccountService({ kv: store, stateDir: state, identity: () => id, me: () => hub.mesh.me, addrs: meshAddrs, version: o.version, env });
  account.load();
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
  });
  const prOf = (c: Chat): Json => {
    const p = c.home !== "" ? chatpr.prFrom(replica.remote.get(c.id)?.pr) : prs.of(c);
    return p ? asJson(chatpr.prJson(p)) : null;
  };
  const projectClones = new ProjectClones({ store, engine: () => eng(), hub, mesh: () => mesh, phone: () => phone, touch: () => hub.touch(null, true) });
  const clones = projectClones.state;
  const projects = new ProjectsApi({
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
  });
  let busyIn: (dir: string) => string | null = () => null;
  const worktrees = new Worktrees({ store, engine: () => eng(), touch: () => hub.touch(null, true), wantPr: (chat) => prs.want(chat, chatpr.SHOWN_TTL_MS), busyIn: (dir) => busyIn(dir) });
  const profileEnv = profileNodeEnv(() => mcp.githubUser() ?? null);
  const owners: OwnerSources = { accountOwnerName: () => account.ownerName(), signedIn: () => account.signedIn(), fullName: () => profileFullName(profileEnv), githubUser: () => mcp.githubUser() ?? null };
  const apkInfo = () => o.updater?.apk() ?? updateApk(dataDir(env));
  const profile = new ProfileScheduler();
  const profileCheckNow = (): Json => profileCheckJson(profileCheck(store, { confirmed: ownerConfirmed(store, owners), owner: ownerOf(store, owners), github: githubOf(store, owners) }));
  const peersNow = (): Peer[] => [...hub.mesh.peers.values()].sort((a, b) => Number(b.online) - Number(a.online) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
      accounts: accounts.filter((a) => a.bin !== null).map((a) => providers.short(a)),
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
    const main = accounts.find((a) => a.id === "claude" && a.bin !== null && a.loggedIn === true);
    const askable = main !== undefined && live.limits.blocked(main.id) === undefined && !(live.limits.quota.get(main.id) ?? []).some(([, used]) => used >= 0.9) && env.HARBOR_PROFILE_RULES === undefined;
    const inputs = () =>
      profileInputs({
        pcs,
        typedOwner: store.get(OWNER_KEY) ?? "",
        typedGithub: store.get(GITHUB_KEY) ?? "",
        accounts: accounts.map((a) => ({ id: a.id, installed: a.bin !== null, loggedIn: a.loggedIn, short: providers.short(a), name: a.name, email: a.email })),
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
    accounts: () => accounts.filter((a) => a.bin !== null).map((a) => ({ id: a.id, short: providers.short(a), kind: a.kind.toLowerCase() })),
    copied: (chat) => engine?.storeChanged(chat),
    cwd: (c) => engine?.chatCwd(c) ?? null,
  });
  const uploadsDir = join(dataDir(env), "uploads");
  let api: Api | null = null;
  let move: MovePc | null = null;
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
  const meshMore = async (call: Call): Promise<Reply | null> => {
    if (call.path[0] !== "mesh" || call.path[1] !== "v1" || call.path.length !== 3) return null;
    const b = typeof call.body === "object" && call.body !== null && !Array.isArray(call.body) ? call.body : {};
    switch (`${call.method} ${call.path[2]}`) {
      case "GET voice":
        return ok(JSON.parse(JSON.stringify(dictate.status(hub.mesh.me.name))));
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
  const mesh = new Mesh({
    hub,
    transcribe: async (wav, lang) => {
      const [status, body] = await dictate.servePeer(voicePeers, wav, lang);
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
    myAddrs: meshAddrs,
    uploadsDir,
    apkCode: () => apkInfo()?.code ?? 0,
    upload: async (r, q) => (api ? api.upload(r, q) : err(503, "Harbor is starting")),
    notes: { last: () => notes.last(), ownSince: (s) => { const [n, l] = notes.ownSince(s); return [n.map(noteJson), l]; } },
    env,
  });
  mesh.reread();
  hub.mesh.about = () => aboutOwner(store, owners);
  const remotes = new Remotes({
    home: home(),
    dataDir: dataDir(env),
    runner: systemRunner,
    selfExe: () => process.execPath,
    which: (bin) => providers.which(bin),
    mesh: () => ({ allowed: hub.mesh.allowed, peers: hub.mesh.peers }),
    lanAddrs: () => lanAddrs(env),
  });
  await remotes.refresh();
  const deviceList = (): [RemoteHost, boolean | null][] => remotes.devices(loadRemote(store), remotes.tailnetCached());
  // remoteui.rs `remote_spec`: how a chat's turn reaches its device; null for this PC.
  const remoteSpec = (chat: Chat, account: Account): agent.RemoteSpec | null => {
    if (chat.device === "") return null;
    const cfg = loadRemote(store);
    const h = remotes.find(cfg, remotes.tailnetCached(), chat.device);
    if (h === null) throw new Error("This chat's device isn't in Settings › Devices anymore. Add it again, or start a new chat on this PC.");
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
  const phone = new PhoneRoutes({
    ctx: ctxFor,
    store,
    hub,
    replica,
    mesh,
    version: o.version,
    myFp: () => id.fp,
    devices: () => remotes.devices(loadRemote(store), remotes.tailnet()),
    pr: prOf,
    dropChat: (c) => worktrees.drop(c),
    worktrees: {
      make: async (repo, base, about) => {
        const info = worktrees.info({ t: "draft", repo });
        return info ? worktrees.make(info.repo, base, about) : null;
      },
      attach: (chat, made) => worktrees.attach(chat, made as worktree.Made),
      discard: (repo, made) => {
        const info = worktrees.info({ t: "draft", repo });
        if (info) void worktrees.discard(info.repo, (made as worktree.Made).dir);
      },
    },
    openedFrom: (chat, gid, title) => eng().notice(chat, "chat", openchat.openedBy(title), `${openchat.LINK}${gid}`),
    more: phoneRoutes({ store, hub, engine: () => eng(), phone: () => phone, uploadId: (path) => phone.uploadId(path), versionsOwn, owners, profile, profileCheck: profileCheckNow, republish: () => services?.publish(), worktrees, projectClones, projects, wantPr: (chat) => prs.want(chat, chatpr.SHOWN_TTL_MS) }),
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
      // The devices of Settings › Devices; Tailscale's PCs and paired ones aren't offered from the phone yet.
      devices: () => loadRemote(store).devices.map((h) => h.id),
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
  const windowMesh = new WindowMesh({
    hub,
    mesh,
    replica,
    phone,
    env,
    chat: (id) => (engine ? engine.chat(id) : store.chat(id)),
    ownerName: () => account.ownerName(),
    ctx: ctxFor,
  });
  // The hooks below run once the engine exists.
  const eng = (): Engine => {
    if (!engine) throw new Error("the engine isn't started");
    return engine;
  };
  const host: HubHost = {
    changed: (chat) => {
      hub.touch(chat, true);
    },
    isForeign: (chat) => hub.mesh.foreign.has(chat),
    hostname: () => hub.mesh.me.name,
    chatLink: (c) => `harbor://chat/${c.gid}?pc=${encodeURIComponent(hub.mesh.me.name)}`,
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
    missingFolder: (c) => projectClones.missingFolder(c),
    holdForClone: (c, prompt, files) => projectClones.holdForClone(c, prompt, files),
  };
  // A window's Engine adds its own notifications; one the hub makes notifies through the hub.
  const own: Partial<EngineHost> = {
    keepMedia: (text, cwd) => media.keep(text, cwd),
    noteTurn: (id, sub, failed, said) => {
      const c = eng().chat(id);
      if (!c) return;
      const project = c.repoId === null ? null : (eng().repo(c.repoId)?.name ?? null);
      notifier.noteTurn({ gid: c.gid, title: c.title, name: c.name, home: c.home, project }, sub, failed, said);
    },
    noteLimit: (id, account, waits, note) => notifier.noteLimit(eng().chat(id) ?? null, account, eng().accountLabel(account), waits, note),
    noteResumed: (id, account, text) => notifier.noteResumed(eng().chat(id) ?? null, account, eng().accountLabel(account), text, eng().limits.limitSettings().notify),
    notify: (kind, key, title, body) => notifier.post(kind, key, title, body, "", false),
  };
  const voicePeers: dictate.Mesh<dictate.MeshPeer & { dest: Dest }> = {
    on: () => hub.mesh.on,
    me: () => ({ name: hub.mesh.me.name }),
    peers: () => [...hub.mesh.peers.values()].filter((p) => p.online && p.fp !== "").map((p) => ({ id: p.id, name: p.name, online: p.online, dest: dest(p) })),
    http: (p, method, path, body, waitMs) => http(p.dest, method, path, body, waitMs),
  };
  engine = o.engine ? o.engine(host, notes, voicePeers) : new Engine({ store, accounts: () => accounts, ...host, ...own });
  const live = engine;
  const funnel = new Funnel(() => providers.which("tailscale") !== null, () => live.hookPort);
  const moveAccounts = (): MovePcAccount[] =>
    accounts.map((a) => ({
      id: a.id,
      claude: a.kind === "Claude",
      email: a.email,
      short: providers.short(a),
      configDir: a.configDir,
      usable: a.kind === "Claude" && a.bin !== null && a.loggedIn !== false && live.limits.blocked(a.id) === undefined && live.limits.ctl.overCap(a.id) === undefined,
      usage: live.limits.usageOf(a.id),
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
  });
  mover.load();
  move = mover;
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
  });
  mover.relocate = (chat, pc) => runOn.relocate(chat, pc);
  phone.d.relocate = { why: (chat, to) => runOn.why(chat, to), relocate: (chat, to) => runOn.relocate(chat, to) };
  phone.d.move = { targetsJson: (chat) => mover.targetsJson(chat), movePc: (chat, pc) => mover.movePc(chat, pc) };
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
  };
  live.reattachTurns();
  live.limits.load();
  let engineTimer: ReturnType<typeof setTimeout> | null = null;
  let profileAt = 0;
  const engineTick = () => {
    const next = live.tick();
    if (!offline) {
      prs.sweep((c) => live.worktreeOf(c) !== null);
      worktrees.tickMoves();
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
        const d = await dictate.transcribe(voicePeers, voice.wavSamples(wav), lang, { cleanup: get("cleanup") === "1" || (get("cleanup") !== "0" && dictate.cleanupOn()), commands: get("commands") === "1", localOnly: get("local") === "1" });
        const v: Record<string, string | boolean> = { text: d.text, host: d.host };
        if (d.send) v.send = true;
        if (d.raw !== null) v.raw = d.raw;
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
  const stopMap = env.HARBOR_LISTEN === undefined && !offline ? portmap.start(port, () => store.get("net_map") !== "0") : () => {};
  const signIn = env.HARBOR_TEST_NO_SIGNIN === undefined && !offline && existsSync(join(state, "account.json"));
  if (signIn) account.start();
  const tick = setInterval(() => {
    hub.enabled = store.get("api_enabled") === "1";
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
    replica.reload();
    if (o.updater) for (const p of hub.mesh.peers.values()) o.updater.peerNews(p.update);
  }, 10_000);
  const refresh = setInterval(() => {
    accounts = providers.discover();
    mirrorDictation();
  }, 60_000);
  return {
    store,
    hub,
    api,
    mesh,
    phone,
    engine: live,
    move: mover,
    runOn,
    windowMesh,
    setBusyIn: (f) => {
      busyIn = f;
    },
    funnel,
    prs,
    account,
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
      // surface.rs device_host: as Settings › Devices knows it, else the PC with the defaults.
      const cfg = loadRemote(store);
      const h = remotes.find(cfg, remotes.tailnetCached(), d.key) ?? newHost({ id: d.key, name: d.name, host: d.ip, bridge: true });
      return { shell: remotes.shellArgv(cfg, h, null), ssh: deviceSshArgs(remotes, cfg, h) };
    },
    services,
    stop: async () => {
      clearInterval(tick);
      if (engineTimer) clearTimeout(engineTimer);
      for (const [id, r] of live.turns) {
        live.persist(id);
        r.turn?.release();
      }
      clearInterval(refresh);
      services?.stop();
      mesh.stop();
      disc?.stop();
      stopMap();
      if (signIn) await account.stop();
      api?.close();
    },
  };
}
