import { rmSync } from "node:fs";
import { join } from "node:path";
import { turnscope } from "./packages/agents/src/index.ts";
import { apps, control, setHarborVersion } from "./packages/mcp/src/index.ts";
import { directoryPcWorkspaces, preview as meshPreview, newNote, scopeHas } from "./packages/net/src/index.ts";
import { type Chat, dataDir, malloc, runDir, single, stallwatch, Store } from "./packages/store/src/index.ts";
import {
  FollowMain,
  FOLLOW_REMOTE as REMOTE,
  HANDOVER,
  handoverSay,
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
import { env as osEnv, proc } from "./packages/os/src/index.ts";

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
  // What every program Harbor starts expects (macOS: a locale, which apps from the Dock lack).
  Object.assign(process.env, osEnv.childDefaults());
  // A restart (reload.ts): the old process, its pid; with a window, the file this one tells it it's ready in.
  const reloadedFrom = Number(process.env.HARBOR_RELOADED_PID) || 0;
  const handover = o.window ? (process.env[HANDOVER] ?? null) : null;
  delete process.env[HANDOVER];
  // The window's place (single.ts placeEnv): Hyprland reads it from this process's starting environment
  // (/proc/PID/environ), which keeps it; what this process starts (terminals, agents' apps) mustn't open there too.
  if (handover !== null) delete process.env.HL_EXEC_RULE_TOKEN;
  if (handover !== null) {
    // The window is built (Slint compiles the UI) while the old Harbor still runs; then it steps aside.
    try {
      await (await import("./packages/ui/src/index.ts")).prewarm();
    } catch (e) {
      console.error(`harbor: the window couldn't be built ahead: ${e instanceof Error ? e.message : String(e)}`);
    }
    handoverSay(handover, "ready");
  }
  if (!(await single.acquire(process.env, handover !== null ? 60_000 : undefined))) {
    if (o.window) await single.focusRunning();
    return 0;
  }
  const stopTrims = malloc.trimEvery();
  // A line in the log for every time the main thread stops answering for a quarter second or more (stallwatch.ts).
  stallwatch.hookSqlite();
  const stopStallWatch = stallwatch.start();
  const stopMemTrace = stallwatch.memTrace();
  // Ahead of turns and other apps for CPU, and its memory kept from reclaim (turnscope.ts).
  void turnscope.protectApp();
  setHarborVersion(o.version);
  wire();

  let reloader: Reloader | null = null;
  let follow: FollowMain | null = null;
  const updater = new Updater(cfg, { swap: () => void reloader?.now(), advertise: advertised, keep: (v) => follow?.keeps(v) ?? false });
  updater.dropLeftovers();
  const store = Store.open(dataDir());
  const offline = isOffline();
  // Builds of Harbor's main, seconds after each push (followmain.ts): the public repository's main, or a
  // local checkout's when it's ahead. Offline (rigs): a checkout only, or HARBOR_FOLLOW_REMOTE's repository.
  const remote = process.env.HARBOR_FOLLOW_REMOTE || (offline ? null : REMOTE);
  // Its pushes to main reach the other PCs through the worker at once (followmain.ts `nudge`): the account's token, once the hub is up.
  let bearer: () => string | null = () => null;
  follow = new FollowMain({ cfg, kv: store, dataDir: dataDir(), repos: () => store.repos(), busy: () => updater.busy(), buildEnv: googleBuildEnv, remote, token: () => bearer() });
  const ui = o.window ? await import("./packages/ui/src/index.ts") : null;
  const made: { data: InstanceType<NonNullable<typeof ui>["Data"]> | null } = { data: null };
  let taking = Promise.resolve();
  const run = await startHub({
    version: advertised(o.version),
    build: o.version,
    updater,
    store,
    discordNotices: true,
    whatsappKeep: true,
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
  bearer = () => run.account.bearer();
  const engine = run.engine;
  const data = made.data;

  let snapshot: () => Snapshot = () => ({});
  let hidden = !o.window;
  /** Quits as the tray's Quit does; set below once the window (or the background wait) is up. */
  let quitApp = (): void => {};
  const reopen = (): void => {
    hidden = false;
    void reloader?.now();
  };
  const sock = control.startSocket<never, never, preview.Offer>({
    // The new Harbor of a restart asks the running one to show itself when it can't start: that isn't the user.
    raise: () => (reloader?.handingOver ? true : single.raise()),
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
      } else if (i.kind === "restart") {
        void reloader?.now();
      } else if (i.kind === "quit") {
        quitApp();
      } else if (i.kind === "previewBack") {
        void preview.back(cfg, i.off, () => void reloader?.now());
      }
    },
  });

  // Values Store.setLater holds (the last chat, the split panes) are written before a restart's new Harbor reads them.
  const flushKv = (): void => {
    try {
      run.store.flushLater();
    } catch {
      // closed already
    }
  };
  let stopped = false;
  const stopAll = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    stopTrims();
    stopStallWatch();
    stopMemTrace();
    flushKv();
    sock?.stop();
    follow?.stop();
    await run.stop();
  };
  let leave = (): void => {};
  reloader = new Reloader({
    cfg,
    kv: run.store,
    snapshot: () => {
      flushKv();
      return snapshot();
    },
    args: () => o.argv,
    hidden: () => hidden,
    beforeExit: stopAll,
    release: () => single.release(),
    handover: join(process.env.XDG_RUNTIME_DIR || runDir(), `harbor-handover-${process.pid}`),
    leaving: () => leave(),
    place: () => single.placeEnv(),
  });

  const bundle = runtimeInfo()?.bundle;
  // Files put in place by something else (install.sh, another Harbor's updater): VERSION is written
  // last, once the runtime and the bundle are both there. Watching the executable reloaded a PC into
  // a new runtime while its bundle was still downloading (0.110.0), and the failed start rolled it
  // back to do it all again.
  if (cfg.dir !== null && bundle !== undefined && !cfg.preview) watchFiles([join(cfg.dir, "VERSION")], () => void reloader?.now());
  if (!offline) updater.start();
  // Runs offline too (rigs): a checkout's main, or HARBOR_FOLLOW_REMOTE's.
  follow.start();
  autostartByDefault(store, updater.managed() && !cfg.preview && !offline);

  // Offline rigs restore only their own restarts (a copied database may hold the real window's snapshot).
  const restore = offline && reloadedFrom === 0 ? null : takeSnapshot(run.store);
  if (!o.window && restore) snapshot = () => restore;
  const { trayStart } = await import("./packages/ui/src/tray.ts");
  if (!o.window) {
    void confirmStart(cfg);
    let quit = (): void => {};
    const tray = offline && !process.env.HARBOR_TRAY ? null : trayStart({ onOpen: reopen, onQuit: () => quit(), hidden: () => true });
    await new Promise<void>((resolve) => {
      quit = resolve;
      quitApp = resolve;
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
    quitApp = quit;
    // Offline rigs have no tray (HARBOR_TRAY=1 shows it anyway: a test session of the tray itself).
    const tray = offline && !process.env.HARBOR_TRAY ? null : trayStart({ onOpen: () => single.raise(), onQuit: quit });
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
        account: () => run.account.account(),
        directory: () => run.account.directory(),
      },
      prs: run.prs,
      workspaces: () => ({ all: run.account.workspaces(), mine: run.account.workspace(), pcs: directoryPcWorkspaces(run.account.directory()) }),
      gh: run.services.gh,
      funnel: run.funnel,
      runOnRows: (chatId: number | null, current: string, kind: string) => run.runOn.rows(chatId, current, kind),
      sharedAccounts: () => run.sharedAccounts(),
      relocate: (chatId: number, to: string) => run.runOn.relocate(chatId, to),
      failover: {
        draft: (repo: number) => run.failover.draft(repo),
        startedNotice: (chat: number, off: string) => run.failover.startedNotice(chat, off),
      },
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
      homeImage: async (chat: number, path: string) => (await run.mesh.homeImage(chat, path, null))?.body ?? null,
    };
    let late = (): void => {};
    const shown = (w: slint.Window): void => {
      void confirmStart(cfg);
      o.shown?.(w, quit);
      if (handover !== null) void handedOver(handover, reloadedFrom, () => late(), ui.loopState);
    };
    await ui.runShell(data, hub, { restore, shown, snapshotWith: (f) => (snapshot = f), leaveWith: (f) => (leave = f), lateWith: (f) => (late = f), quit, closer: (f) => (closeWindow = f), toaster: (t) => { run.move.onToast = t; run.runOn.onToast = t; run.projectMove.onToast = t; run.setProviderPopup((text) => {
      const desk = data.notifier.desktop;
      if (desk?.focused) t(text);
      else desk?.show(newNote({ kind: "pc", key: "providers", title: text }));
    }); }, busyIn: (f) => run.setBusyIn(f), projects: (p) => run.setWindowProjects(p) });
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
 * The new window of a handover is up: once the display has woken its loop (its first frames are drawn) the old
 * process is told, and leaves; then the edits its window took after its snapshot come in (`late`).
 */
async function handedOver(file: string, oldPid: number, late: () => void, loop: { wakes: number }): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 50 && loop.wakes < 2; i++) await sleep(20);
  await sleep(50);
  handoverSay(file, "shown");
  for (let i = 0; i < 250 && oldPid > 0 && proc.exists(oldPid); i++) await sleep(20);
  rmSync(file, { force: true });
  try {
    late();
  } catch (e) {
    console.error(`harbor: the old window's last edits didn't come in: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The Google clients this build has (baked in, or from the environment), for a build of main to keep. */
function googleBuildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const desk = apps.googleBuiltinFromEnv();
  const web = apps.googleWebFromEnv();
  if (desk) Object.assign(out, { HARBOR_GOOGLE_CLIENT_ID: desk.id, HARBOR_GOOGLE_CLIENT_SECRET: desk.secret });
  if (web) Object.assign(out, { HARBOR_GOOGLE_WEB_CLIENT_ID: web.id, HARBOR_GOOGLE_WEB_CLIENT_SECRET: web.secret });
  return out;
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
