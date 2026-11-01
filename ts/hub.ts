import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { statusBars } from "./statusbars.ts";
import { chatpr, commits, Engine, type EngineHost, providers, provupdate, recap } from "./packages/agents/src/index.ts";
import { dictate, media, parakeet, voice } from "./packages/media/src/index.ts";
import { mcp } from "./packages/mcp/src/index.ts";
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
  Api,
  catalogOf,
  CloneState,
  dest,
  discoverStart,
  err,
  hostPort,
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
  Mesh,
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
  type Reply,
} from "./packages/net/src/index.ts";
import { type Chat, dataDir, home, repoDir, stateDir, Store } from "./packages/store/src/index.ts";
import { apk as updateApk, notices, type Updater } from "./packages/update/src/index.ts";
import { type Services, startServices } from "./services.ts";

export type HubHost = Pick<EngineHost, "changed" | "isForeign" | "hostname" | "chatLink" | "offline" | "turnEnded">;

export interface HubOptions {
  version: string;
  env?: Record<string, string | undefined>;
  updater?: Updater;
  store?: Store;
  /** The window's Engine, made with the hub's host and notes (the phones' notifications). */
  engine?: (host: HubHost, notes: Notes, voice: dictate.Mesh) => Engine;
  /** The first port the webhook listener tries (false: none); a test hub keeps off the real one's. */
  hookPort?: number | false;
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
  prs: chatpr.ChatPrs;
  account: AccountService;
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

/** The phones' banner for provider CLIs that are behind (api.rs `updates_json`); null when there's nothing to say. */
export function providerUpdates(st: provupdate.Status = provupdate.status()): Json {
  if (st.items.length === 0 && !st.updating && st.error === null) return null;
  return {
    items: st.items.map((p) => ({ kind: p.kind.toLowerCase(), label: p.kind, logo: provupdate.logoFile(p.kind), current: p.current, latest: p.latest })),
    names: provupdate.names(st.items),
    key: provupdate.key(st.items),
    updating: st.updating,
    error: st.error,
  };
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
async function updateRoute(u: Updater, call: Call): Promise<Reply | null> {
  const [v, hubSeg, what] = call.path;
  if (call.method !== "POST" || v !== "v1" || hubSeg !== "hub" || call.path.length !== 3) return null;
  if (what === "auto") return ok({ ok: true, auto: true });
  if (what !== "update" && what !== "check") return null;
  if (!u.managed()) return err(409, "this Harbor was built from source, so it doesn't update itself");
  if (what === "check") {
    void u.check();
    return { status: 202, body: { ok: true, checking: true } };
  }
  const s = u.state();
  if (s.t === "available") void u.installNow();
  else void u.checkAndInstall();
  return s.t === "available" ? ok({ ok: true }) : { status: 202, body: { ok: true, checking: true } };
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
    chat: (chatId) => store.chats().find((x) => x.id === chatId),
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
  const clones = new CloneState();
  const profileEnv = profileNodeEnv(() => mcp.githubUser() ?? null);
  const owners: OwnerSources = { accountOwnerName: () => account.ownerName(), signedIn: () => account.signedIn(), fullName: () => profileFullName(profileEnv), githubUser: () => mcp.githubUser() ?? null };
  const apkInfo = () => o.updater?.apk() ?? updateApk(dataDir(env));
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
    items: (chat) => (engine ? engine.transcript(chat).items : store.items(chat)),
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
  });
  const uploadsDir = join(dataDir(env), "uploads");
  let api: Api | null = null;
  const meshApp: MeshApp = {
    helloExtra: () => replica.helloExtra(),
    chats: (since, full) => replica.chats(since, full),
    items: (chat, since) => replica.items(chat, since),
    applyChats: (peer, epoch, body) => replica.applyChats(peer, epoch, body),
    applyItems: (peer, epoch, hid, body) => replica.applyItems(peer, epoch, hid, body),
    route: async (call) => (await services?.routeMesh(call)) ?? replica.route(call),
  };
  const mesh = new Mesh({
    hub,
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
  const blockerOf = (c: Chat): string | null => {
    const subs = store.chats().filter((x) => x.parent === c.id);
    const chats = [c, ...subs].map((x) => ({ id: x.id, name: x.name, device: x.device, claude: accounts.find((y) => y.id === x.account)?.kind === "Claude", running: engine?.running(x.id) ?? false }));
    const lead = deviceList().find(([h]) => h.id === c.device)?.[0];
    return relocateBlocker({ foreignHome: c.home !== "" ? hub.mesh.nameOf(c.home) : null, isSub: c.role === "sub", movingTo: null, chats, leadDevice: lead ? { os: lead.os } : null });
  };
  catalog.relocateBlocker = blockerOf;
  catalog.deviceWhy = (c) => {
    const devs = deviceList();
    const hosts = [...hub.mesh.peers.values()];
    const ids = ["", ...devs.filter(([h]) => !h.hidden).map(([h]) => h.id), ...hosts.map((p) => p.id)];
    return deviceWhy(c.started, c.home !== "", ids, (id) => relocateWhy({ started: c.started, device: c.device, to: id, blocker: () => blockerOf(c), place: placeOf(id, hosts, devs), meshOn: hub.mesh.on }));
  };
  const phone = new PhoneRoutes({
    store,
    hub,
    replica,
    mesh,
    version: o.version,
    myFp: () => id.fp,
    devices: () => remotes.devices(loadRemote(store), remotes.tailnet()),
    pr: prOf,
    app: () => ({ version_code: apkInfo()?.code ?? 0, url: "/app.apk" }),
    profileCheck: () => {
      const confirmed = ownerConfirmed(store, owners);
      return profileCheckJson(profileCheck(store, { confirmed, owner: ownerOf(store, owners), github: githubOf(store, owners) }));
    },
    bars: (chat, nowMs) => statusBars({ engine: eng(), clones, homeName }, chat, nowMs),
    engine: null,
    uploadsDir,
    updates: () => ({ hub_update: o.updater ? asJson(notices.hubUpdate(o.updater.info(), o.updater.state(), o.updater.asked())) : null, provider_updates: providerUpdates() }),
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
      const r = c.repoId === null ? null : store.repos().find((x) => x.id === c.repoId);
      const dir = r ? repoDir(r) : null;
      if (dir === null || !existsSync(dir)) return null;
      return { ofText: (md) => commits.ofText(dir, md, () => hub.touch(c.id, false)), tokens: (t) => commits.tokens(t) };
    },
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
    offline,
    turnEnded: (id) => prs.want(id, null),
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
      const c = store.chats().find((x) => x.id === id);
      return c ? live.worktreeOf(c) : null;
    },
    queuePromote: (id, q) => live.queuePromote(id, q),
    queueMove: (id, q, to) => live.queueMove(id, q, to),
    queueUpdate: (id, q, text, mentions, editing) => live.queueUpdate(id, q, text, mentions, editing),
    queueRemove: (id, q) => live.queueRemove(id, q),
    queueResume: (id) => live.queueResume(id),
    recap: (id) => live.recaps.shownFor(id),
    recapSeen: (id) => live.recaps.seen(id),
    unread: (id) => live.unread.has(id),
    failed: (id) => live.failed.has(id),
    opened: (id) => live.opened(id),
    subsQueued: (lead) => live.subsQueued(lead),
    queuedCount: (id) => live.queuedCount(id),
  };
  live.reattachTurns();
  live.limits.load();
  let engineTimer: ReturnType<typeof setTimeout> | null = null;
  const engineTick = () => {
    const next = live.tick();
    if (!offline) prs.sweep((c) => live.worktreeOf(c) !== null);
    engineTimer = setTimeout(engineTick, Math.min(Math.max(next ?? 1000, 50), 1000));
  };
  engineTick();
  const route = async (call: Call): Promise<Reply> => {
    const updated = o.updater ? await updateRoute(o.updater, call) : null;
    if (updated !== null) return updated;
    if (call.method === "GET" && call.path.join("/") === "v1/voice") return ok(JSON.parse(JSON.stringify(dictate.status(hub.mesh.me.name))));
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
  services = await startServices({ store, hub, mesh, engine: live, version: o.version, env, account, composer: () => catalog.defaults(), accounts: () => accounts, ...(offline ? { hookPort: false as const } : o.hookPort === undefined ? {} : { hookPort: o.hookPort }) });
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
  const stopProviderNews = provupdate.onChange(() => hub.touch(null, true));
  const refresh = setInterval(() => {
    accounts = providers.discover();
    mirrorDictation();
    if (!offline) provupdate.tick(accounts);
  }, 60_000);
  return {
    store,
    hub,
    api,
    mesh,
    phone,
    engine: live,
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
      stopProviderNews();
      services?.stop();
      mesh.stop();
      disc?.stop();
      stopMap();
      if (signIn) await account.stop();
      api?.close();
    },
  };
}
