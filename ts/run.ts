import { control, setHarborVersion } from "./packages/mcp/src/index.ts";
import { directoryPcWorkspaces } from "./packages/net/src/index.ts";
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
  const run = await startHub({
    version: o.version,
    updater,
    store,
    ...(ui ? { engine: (host, notes, voice) => (made.data = new ui.Data(store, host, notes, voice)).engine } : {}),
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
        if (i.here) void reloader?.now();
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
      checkUpdates: async () => (await updater.check(), updater.info().status),
    };
    await ui.runShell(data, hub, { restore, shown: () => void confirmStart(cfg), snapshotWith: (f) => (snapshot = f), quit, closer: (f) => (closeWindow = f) });
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
