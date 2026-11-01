import { control, setHarborVersion } from "./packages/mcp/src/index.ts";
import { directoryPcWorkspaces, preview as meshPreview } from "./packages/net/src/index.ts";
import { dataDir, single, Store } from "./packages/store/src/index.ts";
import {
  Reloader,
  Updater,
  confirmStart,
  defaultConfig,
  preview,
  runtimeInfo,
  takeSnapshot,
  watchFiles,
  type Snapshot,
} from "./packages/update/src/index.ts";
import { isOffline, startHub } from "./hub.ts";
import { wire } from "./wire.ts";

export interface RunOptions {
  window: boolean;
  argv: string[];
  version: string;
}

export async function runApp(o: RunOptions): Promise<number> {
  const cfg = defaultConfig();
  if (!(await single.acquire())) {
    if (o.window) await single.focusRunning();
    return 0;
  }
  setHarborVersion(o.version);
  wire();

  let reloader: Reloader | null = null;
  const updater = new Updater(cfg, { swap: () => void reloader?.now() });
  const store = Store.open(dataDir());
  const offline = isOffline();
  const ui = o.window ? await import("./packages/ui/src/index.ts") : null;
  const made: { data: InstanceType<NonNullable<typeof ui>["Data"]> | null } = { data: null };
  let taking = Promise.resolve();
  const run = await startHub({
    version: o.version,
    updater,
    store,
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
  if (cfg.dir !== null && bundle !== undefined && !cfg.preview) watchFiles([cfg.exe, bundle], () => void reloader?.now());
  if (!offline) updater.start();

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
    const hub = {
      prs: run.prs,
      workspaces: () => ({ all: run.account.workspaces(), mine: run.account.workspace(), pcs: directoryPcWorkspaces(run.account.directory()) }),
      gh: run.services.gh,
      funnel: run.funnel,
      runOnRows: (chatId: number | null, current: string, kind: string) => run.runOn.rows(chatId, current, kind),
      relocate: (chatId: number, to: string) => run.runOn.relocate(chatId, to),
      hookPort: () => run.engine.hookPort,
      devices: run.devices,
      deviceEnv: run.deviceEnv,
      deviceHost: run.deviceHost,
      moveTargets: (chatId: number) => run.move.targetsNow(chatId),
      movePc: (chatId: number, peerId: string) => run.move.movePc(chatId, peerId),
      checkUpdates: async () => (await updater.check(), updater.info().status),
    };
    await ui.runShell(data, hub, { restore, shown: () => void confirmStart(cfg), snapshotWith: (f) => (snapshot = f), quit, closer: (f) => (closeWindow = f), toaster: (t) => { run.move.onToast = t; run.runOn.onToast = t; }, busyIn: (f) => run.setBusyIn(f) });
    tray?.stop();
    if (!quitting && run.store.get("bg_keep") !== "0") {
      const note = ui.stillRunning(run.store, tray !== null);
      if (note) Bun.spawnSync(["notify-send", "-a", "Harbor", ...note], { stdio: ["ignore", "ignore", "ignore"] });
      hidden = true;
      if (await reloader.now()) return 0;
    }
  }
  await stopAll();
  return 0;
}
