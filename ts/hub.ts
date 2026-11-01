import { existsSync } from "node:fs";
import { join } from "node:path";
import { commits, Engine, providers } from "./packages/agents/src/index.ts";
import { dictate, voice } from "./packages/media/src/index.ts";
import {
  AccountService,
  Api,
  catalogOf,
  dest,
  discoverStart,
  err,
  hostPort,
  http,
  Hub,
  lanAddrs,
  lanPortmapNet,
  loadOrCreate,
  loadTokens,
  Mesh,
  noteJson,
  Notes,
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
  type MeshApp,
  type Reply,
} from "./packages/net/src/index.ts";
import { dataDir, repoDir, stateDir, Store } from "./packages/store/src/index.ts";
import { type Services, startServices } from "./services.ts";

export interface HubOptions {
  version: string;
  env?: Record<string, string | undefined>;
}

export interface RunningHub {
  store: Store;
  hub: Hub;
  api: Api;
  mesh: Mesh;
  phone: PhoneRoutes;
  engine: Engine;
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

/** Harbor without its window (Rust's `--background`): the phone API, the mesh, discovery, port mapping and the account loop. */
export async function startHub(o: HubOptions): Promise<RunningHub> {
  const env = o.env ?? process.env;
  const store = Store.open(dataDir(env));
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
  hub.notes = {
    last: () => notes.last(),
    wait: async (since, ms) => {
      const [n, l] = await notes.wait(since, ms);
      return [n.map(noteJson), l];
    },
  };
  let accounts = providers.discover();
  const catalog = catalogOf(providers, () => accounts.map(catalogAccount), store);
  const portmap = new Portmap({ kv: store, net: lanPortmapNet() });
  const addrs = () => phoneAddrs(port, lanAddrs(env), portmap.publicAddr());
  const meshAddrs = () => addrs().map((a) => (parseIp(a) ? hostPort(a, port) : a));
  const account = new AccountService({ kv: store, stateDir: state, identity: () => id, me: () => hub.mesh.me, addrs: meshAddrs, version: o.version, env });
  account.load();
  let engine: Engine | null = null;
  let services: Services | null = null;
  let phoneRoute: (call: Call) => Promise<Reply> = async () => err(503, "Harbor is starting");
  const replica = new StoreReplica({
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
    upload: async (r, q) => (api ? api.upload(r, q) : err(503, "Harbor is starting")),
    notes: { last: () => notes.last(), ownSince: (s) => { const [n, l] = notes.ownSince(s); return [n.map(noteJson), l]; } },
    env,
  });
  mesh.reread();
  const phone = new PhoneRoutes({
    store,
    hub,
    replica,
    mesh,
    version: o.version,
    myFp: () => id.fp,
    engine: null,
    uploadsDir,
    catalog,
    voice: () => ({ transcribe: true, why: null, lang: voice.config()[0] }),
    commits: (c) => {
      const r = c.repoId === null ? null : store.repos().find((x) => x.id === c.repoId);
      const dir = r ? repoDir(r) : null;
      if (dir === null || !existsSync(dir)) return null;
      return { ofText: (md) => commits.ofText(dir, md, () => hub.touch(c.id, false)), tokens: (t) => commits.tokens(t) };
    },
  });
  engine = new Engine({
    store,
    accounts: () => accounts,
    changed: (chat) => {
      hub.touch(chat, true);
    },
    isForeign: (chat) => hub.mesh.foreign.has(chat),
    hostname: () => hub.mesh.me.name,
    chatLink: (c) => `harbor://chat/${c.gid}?pc=${encodeURIComponent(hub.mesh.me.name)}`,
  });
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
    queuePromote: (id, q) => live.queuePromote(id, q),
    queueMove: (id, q, to) => live.queueMove(id, q, to),
    queueUpdate: (id, q, text, mentions, editing) => live.queueUpdate(id, q, text, mentions, editing),
    queueRemove: (id, q) => live.queueRemove(id, q),
    queueResume: (id) => live.queueResume(id),
    recap: (id) => live.recaps.shownFor(id),
    recapSeen: (id) => live.recaps.seen(id),
  };
  live.reattachTurns();
  let engineTimer: ReturnType<typeof setTimeout> | null = null;
  const engineTick = () => {
    const next = live.tick();
    engineTimer = setTimeout(engineTick, Math.min(Math.max(next ?? 1000, 50), 1000));
  };
  engineTick();
  const voicePeers: dictate.Mesh<dictate.MeshPeer & { dest: Dest }> = {
    on: () => hub.mesh.on,
    me: () => ({ name: hub.mesh.me.name }),
    peers: () => [...hub.mesh.peers.values()].filter((p) => p.online && p.fp !== "").map((p) => ({ id: p.id, name: p.name, online: p.online, dest: dest(p) })),
    http: (p, method, path, body, waitMs) => http(p.dest, method, path, body, waitMs),
  };
  const route = async (call: Call): Promise<Reply> => {
    if (call.method === "GET" && call.path.join("/") === "v1/voice") return ok(JSON.parse(JSON.stringify(dictate.status(hub.mesh.me.name))));
    return (await services?.routePhone(call)) ?? phone.route(call);
  };
  phoneRoute = route;
  const apk = () => {
    const p = join(dataDir(env), "harbor-android.apk");
    return existsSync(p) ? p : null;
  };
  api = new Api({
    hub,
    id: () => id,
    uploadsDir,
    route,
    account: account.phoneAuth(),
    appInfo: () => ({ version_code: 0, url: "/app.apk", hub: null }),
    apk,
    mesh: (p, q, r) => mesh.serve(p, q, r),
    meshAdmitted: (p, q) => mesh.admitted(p, q),
    relay: (p, q, r, w) => relayServe({ hub, myFp: () => id.fp, isPhone: (pp, rq) => { try { return api?.caller(pp, rq).level === null; } catch { return false; } } }, p, q, r, w),
    hubs: () => mesh.hubs(),
    forwardLease: (...a) => mesh.forwardLease(...a),
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
  services = await startServices({ store, hub, mesh, engine: live, version: o.version, env, account, composer: () => catalog.defaults(), accounts: () => accounts });
  const bound = await api.listen();
  hub.net = { addrs: addrs(), bound, error: hub.net.error };
  mesh.start();
  const disc = await discoverStart({ shared: hub.mesh, me: () => ({ id: hub.mesh.me.id, name: hub.mesh.me.name, fp: id.fp, port, version: o.version, on: hub.mesh.on }) });
  const stopMap = env.HARBOR_LISTEN === undefined ? portmap.start(port, () => store.get("net_map") !== "0") : () => {};
  const signIn = env.HARBOR_TEST_NO_SIGNIN === undefined && existsSync(join(state, "account.json"));
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
  }, 10_000);
  const refresh = setInterval(() => {
    accounts = providers.discover();
  }, 60_000);
  return {
    store,
    hub,
    api,
    mesh,
    phone,
    engine: live,
    services,
    stop: async () => {
      clearInterval(tick);
      if (engineTimer) clearTimeout(engineTimer);
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
