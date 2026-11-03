import { join } from "node:path";
import { control, setHarborVersion } from "./packages/mcp/src/index.ts";
import { directoryPcWorkspaces, preview as meshPreview, scopeHas } from "./packages/net/src/index.ts";
import { type Chat, dataDir, malloc, single, Store } from "./packages/store/src/index.ts";
import {
  Reloader,
  advertised,
  Updater,
  confirmStart,
  defaultConfig,
  preview,
  runtimeInfo,
  takeSnapshot,
  watchFiles,
  type Snapshot,
} from "./packages/update/src/index.ts";
import type * as slint from "slint-ui";
import { isOffline, startHub } from "./hub.ts";
import { autostartByDefault, keepsRunning } from "./packages/ui/src/background.ts";
import { wire } from "./wire.ts";

export interface RunOptions {
  window: boolean;
  argv: string[];
  version: string;
  shown?: (window: slint.Window, quit: () => void) => void;
}

export async function runApp(o: RunOptions): Promise<number> {
  const cfg = defaultConfig();
  // Before the native libraries start work on Bun's threads: each would get an arena of its own.
  malloc.capArenas();
  if (!(await single.acquire())) {
    if (o.window) await single.focusRunning();
    return 0;
  }
  const stopTrims = malloc.trimEvery();
  setHarborVersion(o.version);
  wire();

  let reloader: Reloader | null = null;
  const updater = new Updater(cfg, { swap: () => void reloader?.now(), advertise: advertised });
  const store = Store.open(dataDir());
  const offline = isOffline();
  const ui = o.window ? await import("./packages/ui/src/index.ts") : null;
  const made: { data: InstanceType<NonNullable<typeof ui>["Data"]> | null } = { data: null };
  let taking = Promise.resolve();
  const run = await startHub({
    version: advertised(o.version),
    updater,
    store,
    discordNotices: true,
    ...(ui ? { engine: (host, notes, voice) => (made.data = new ui.Data(store, host, notes, voice)).engine } : {}),
    preview: {
      refuses: (full, offer) => preview.refuses(cfg, full, offer),
      take: (from, name, offer) => {
        // One offer at a time: its file is fetched to a fixed name.
        taking = taking.then(async () => {
          try {
            await preview.fetchOffer(cfg, { id: offer.id, sha256: offer.sha256, note: offer.note, kind: "bundle" }, name, (kind, to) => meshPreview.fetchPreviewFile(from, offer.id, kind, to));
            await reloader?.now();
          } catch (e) {
            cfg.log(`preview ${offer.id} not taken: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
      },
      file: (kind, id) => preview.offeredFile(cfg, kind, id),
    },
  });
  const engine = run.engine;
  const data = made.data;

  let snapshot: () => Snapshot = () => ({});
  let hidden = !o.window;
  const reopen = (): void => {
    hidden = false;
    void reloader?.now();
  };
  const sock = control.startSocket<never, never, preview.Offer>({
    previewReceived: (v) => preview.received(cfg, v as Partial<preview.PushRequest>),
    send: (i) => {
      if (i.kind === "tool") {
        engine.tool(i.call.chatId, i.call.tool, i.call.args).then(
          (text) => i.call.reply(true, text),
          (e: unknown) => i.call.reply(false, e instanceof Error ? e.message : String(e)),
        );
      } else if (i.kind === "preview") {
        const { offer, here } = i;
        void (async () => {
          if (offer && !offline) await meshPreview.announcePreview(run.hub.mesh, offer);
          if (here) await reloader?.now();
        })();
      } else if (i.kind === "focus") {
        if (!o.window) reopen();
      } else if (i.kind === "previewBack") {
        void preview.back(cfg, i.off, () => void reloader?.now());
      }
    },
  });

  let stopped = false;
  const stopAll = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    stopTrims();
    sock?.stop();
    await run.stop();
  };
  reloader = new Reloader({
    cfg,
    kv: run.store,
    snapshot: () => snapshot(),
    args: () => o.argv,
    hidden: () => hidden,
    beforeExit: stopAll,
    release: () => single.release(),
  });

  const bundle = runtimeInfo()?.bundle;
  // Files put in place by something else (install.sh, another Harbor's updater): VERSION is written
  // last, once the runtime and the bundle are both there. Watching the executable reloaded a PC into
  // a new runtime while its bundle was still downloading (0.110.0), and the failed start rolled it
  // back to do it all again.
  if (cfg.dir !== null && bundle !== undefined && !cfg.preview) watchFiles([join(cfg.dir, "VERSION")], () => void reloader?.now());
  if (!offline) updater.start();
  autostartByDefault(store, updater.managed() && !cfg.preview && !offline);

  const restore = offline ? null : takeSnapshot(run.store);
  if (!o.window && restore) snapshot = () => restore;
  const { trayStart } = await import("./packages/ui/src/tray.ts");
  if (!o.window) {
    void confirmStart(cfg);
    let quit = (): void => {};
    const tray = offline ? null : trayStart({ onOpen: reopen, onQuit: () => quit(), hidden: () => true });
    await new Promise<void>((resolve) => {
      quit = resolve;
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    tray?.stop();
    await stopAll();
    return 0;
  }
  if (ui && data) {
    let closeWindow = (): void => {};
    let quitting = false;
    const quit = (): void => {
      quitting = true;
      closeWindow();
    };
    const tray = offline ? null : trayStart({ onOpen: () => single.raise(), onQuit: quit });
    // The window shows only this PC's chats and copies from the PCs this account uses (account.ts `pcScope`).
    data.scope = (home: string) => scopeHas(run.account.scope(), home);
    const hub = {
      settings: { account: run.account, hub: run.hub, mesh: run.mesh, version: o.version },
      call: (method: string, path: string, query?: Record<string, string>, body?: unknown) => run.call(method, path, query, body),
      newWorktree: run.newWorktree,
      account: {
        invites: () => run.account.invites(),
        busy: () => run.account.status().busy,
        answer: (id: string, accept: boolean) => (accept ? run.account.acceptInvite(id) : run.account.declineInvite(id)),
        error: () => run.account.status().error,
        subscribe: (f: () => void) => run.account.subscribe(f),
      },
      prs: run.prs,
      workspaces: () => ({ all: run.account.workspaces(), mine: run.account.workspace(), pcs: directoryPcWorkspaces(run.account.directory()) }),
      gh: run.services.gh,
      funnel: run.funnel,
      runOnRows: (chatId: number | null, current: string, kind: string) => run.runOn.rows(chatId, current, kind),
      relocate: (chatId: number, to: string) => run.runOn.relocate(chatId, to),
      auto: {
        pick: (kind: string) => run.runOn.autoPick(kind),
        resolve: (device: string, kind: string) => run.runOn.resolve(device, kind),
        mark: (gid: string, place: string) => run.runOn.markAuto(gid, place),
        label: (chat: Chat) => run.runOn.autoLabel(chat),
        relocate: (chatId: number, kind: string) => run.runOn.relocateAuto(chatId, kind),
        name: (id: string) => run.runOn.nameOf(id),
      },
      hookPort: () => run.engine.hookPort,
      devices: run.devices,
      deviceEnv: run.deviceEnv,
      deviceHost: run.deviceHost,
      moveTargets: (chatId: number) => run.move.targetsNow(chatId),
      movePc: (chatId: number, peerId: string) => run.move.movePc(chatId, peerId),
      moves: {
        chatMenu: (id: number) => {
          const c = run.store.chat(id);
          return c ? run.moves.chatMenu(c) : null;
        },
        projectMenu: (id: number) => {
          const r = run.store.repos().find((x) => x.id === id);
          return r ? run.moves.projectMenu(r) : null;
        },
        moveChat: async (id: number, ws: string) => {
          const c = run.store.chat(id);
          return c ? run.moves.moveChat(c, ws) : { status: 404, body: { error: "no such chat" } };
        },
        moveProject: async (id: number, ws: string) => {
          const r = run.store.repos().find((x) => x.id === id);
          return r ? run.moves.moveProject(r, ws) : { status: 404, body: { error: "no such project" } };
        },
        chatShares: (id: number) => {
          const c = run.store.chat(id);
          return c ? run.moves.chatShares(c) : null;
        },
        projectShares: (id: number) => {
          const r = run.store.repos().find((x) => x.id === id);
          return r ? run.moves.projectShares(r) : null;
        },
        shareChat: async (id: number, ws: string, on: boolean) => {
          const c = run.store.chat(id);
          return c ? run.moves.shareChat(c, ws, on) : { status: 404, body: { error: "no such chat" } };
        },
        shareProject: async (id: number, ws: string, on: boolean) => {
          const r = run.store.repos().find((x) => x.id === id);
          return r ? run.moves.shareProject(r, ws, on) : { status: 404, body: { error: "no such project" } };
        },
        projectIn: (id: number) => {
          const r = run.store.repos().find((x) => x.id === id);
          return r ? run.moves.projectIn(r) : "";
        },
      },
      projectMove: (repo: number, body: Record<string, unknown>) => run.projectMove.api(repo, body, run.hub.mesh.me.name),
      projectMoving: (repo: number) => {
        const st = run.projectMove.statusOf(repo);
        return st?.state === "running" ? `Moving to ${st.toName}: ${st.stage}` : null;
      },
      mesh: run.windowMesh,
      projectPlace: (repo: number) => run.projectPlace(repo),
      checkUpdates: async () => (await updater.check(), updater.info().status),
      player: { library: () => updater.videoLib(), coming: () => updater.videoInstalling(), ask: () => void updater.autoExtras("video", true) },
    };
    await ui.runShell(data, hub, { restore, shown: (w) => (void confirmStart(cfg), o.shown?.(w, quit)), snapshotWith: (f) => (snapshot = f), quit, closer: (f) => (closeWindow = f), toaster: (t) => { run.move.onToast = t; run.runOn.onToast = t; run.projectMove.onToast = t; }, busyIn: (f) => run.setBusyIn(f), projects: (p) => run.setWindowProjects(p) });
    tray?.stop();
    if (!quitting && keepsRunning()) {
      const note = ui.stillRunning(run.store, tray !== null);
      if (note) Bun.spawnSync(["notify-send", "-a", "Harbor", ...note], { stdio: ["ignore", "ignore", "ignore"] });
      hidden = true;
      if (await reloader.now()) return 0;
    }
  }
  await stopAll();
  return 0;
}

/**
 * `harbor --check-window [SECONDS]`, offline only: the real window must come up and stay up, then it closes.
 * Its own data folders, socket and runtime folder are the caller's to give (install-one.sh's preflight).
 */
export async function checkWindow(args: string[], version: string): Promise<number> {
  const secs = Number(args[0] ?? 5);
  if (!(secs > 0)) return (console.error("usage: harbor --check-window [SECONDS]"), 2);
  if (!isOffline()) return (console.error("harbor: --check-window runs only with HARBOR_OFFLINE=1 and its own data folders"), 2);
  let verdict = "no window: the app ended before showing one";
  const limit = setTimeout(() => {
    console.error(`harbor: no window within ${30 + secs} s`);
    process.exit(1);
  }, (30 + secs) * 1000);
  const code = await runApp({
    window: true,
    argv: [],
    version,
    shown: (w, quit) => {
      verdict = `the window closed within ${secs} s of showing`;
      const at = performance.now();
      setTimeout(async () => {
        const { loopState } = await import("./packages/ui/src/index.ts");
        const size = w.physicalSize;
        if (!w.visible) verdict = `the window was hidden ${secs} s after showing`;
        else if (size.width < 1 || size.height < 1) verdict = `the window has no size (${size.width}x${size.height})`;
        else if (loopState.kind === "woken" && loopState.wakes === 0) verdict = "the display never woke the window's loop (its poll Worker is not running)";
        else verdict = `ok: a ${size.width}x${size.height} window, up ${Math.round((performance.now() - at) / 1000)} s, loop ${loopState.kind} (${loopState.wakes} wakes)`;
        quit();
      }, secs * 1000);
    },
  });
  clearTimeout(limit);
  const ok = verdict.startsWith("ok: ");
  (ok ? console.log : console.error)(ok ? `window ${verdict}` : `harbor: ${verdict}`);
  return ok && code === 0 ? 0 : 1;
}
