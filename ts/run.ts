import { control, setHarborVersion } from "./packages/mcp/src/index.ts";
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
    hidden: () => !o.window,
    beforeExit: stopAll,
    release: () => single.release(),
  });

  const bundle = runtimeInfo()?.bundle;
  if (cfg.dir !== null && bundle !== undefined && !cfg.preview) watchFiles([cfg.exe, bundle], () => void reloader?.now());
  if (!offline) updater.start();

  const restore = offline ? null : takeSnapshot(run.store);
  if (!o.window) {
    void confirmStart(cfg);
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    await stopAll();
    return 0;
  }
  if (ui && data) {
    let closeWindow = (): void => {};
    const tray = ui.trayStart({ onOpen: () => single.raise(), onQuit: () => closeWindow() });
    await ui.runShell(data, { restore, shown: () => void confirmStart(cfg), snapshotWith: (f) => (snapshot = f), closer: (f) => (closeWindow = f) });
    tray?.stop();
  }
  await stopAll();
  return 0;
}
