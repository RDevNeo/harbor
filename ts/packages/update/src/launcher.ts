import { dirname, join } from "node:path";
import { defaultConfig, type RuntimeInfo, type UpdateConfig } from "./config.ts";
import { updateCli } from "./commands.ts";
import { alive, BUNDLE_FILE, isFile, read } from "./files.ts";
import { enabled, superseded } from "./preview.ts";
import { forget, readMeta, SLOT } from "./previewmeta.ts";
import { RELOADED_PID } from "./reload.ts";
import { captureStart } from "./startlog.ts";
import { beginAttempt, readAttempt, recoverUnconfirmed, watch } from "./startup.ts";
import { newer, RUNTIME_VERSION } from "./version.ts";

// Loading a bundle must start nothing: main does.
export interface AppBundle {
  meta: { version: string; minRuntime: string };
  main: (argv: string[]) => number | Promise<number>;
}

export interface Chosen {
  kind: "release" | "preview";
  path: string;
  id: string;
  version: string;
}

export interface LaunchOptions {
  cfg?: UpdateConfig;
  load?: (path: string) => Promise<unknown>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  spawn?: (cmd: string[]) => void;
  armWatchdog?: boolean;
  env?: Record<string, string | undefined>;
  embedded?: AppBundle;
}

const WINDOW_ARG = "--background";

export const isWindowLaunch = (argv: readonly string[]): boolean => argv.length === 0 || (argv.length === 1 && argv[0] === WINDOW_ARG);

const needsNewer = (m: AppBundle, runtime: string): boolean => newer(m.meta.minRuntime, runtime);

function isBundle(m: unknown): m is AppBundle {
  if (typeof m !== "object" || m === null) return false;
  const x = m as Partial<AppBundle>;
  return typeof x.main === "function" && typeof x.meta?.version === "string" && typeof x.meta.minRuntime === "string";
}

export function choose(cfg: UpdateConfig): Chosen {
  const dir = cfg.dir ?? dirname(cfg.exe);
  const release: Chosen = { kind: "release", path: join(dir, BUNDLE_FILE), id: "", version: read(join(dir, "VERSION")) };
  if (cfg.dir === null || !enabled(cfg)) return release;
  const m = readMeta(cfg.dir);
  if (m === null) return release;
  if (!isFile(join(cfg.dir, SLOT)) || superseded(m.version, release.version === "" ? null : release.version)) {
    forget(cfg.dir);
    return release;
  }
  if (m.stage === "failed") return release;
  return { kind: "preview", path: join(cfg.dir, SLOT), id: m.id, version: m.version };
}

// Another Harbor already running or starting owns the attempt; only the restart that replaces it takes over.
function secondary(cfg: UpdateConfig, env: Record<string, string | undefined>): boolean {
  const prior = cfg.dir === null ? null : readAttempt(cfg.dir);
  return prior !== null && prior.pid !== process.pid && alive(prior.pid) && prior.pid !== Number(env[RELOADED_PID]);
}

// A single executable runs the bundle it carries unless an update put a newer one beside it.
export function useEmbedded(chosen: Chosen, embedded: AppBundle | undefined): embedded is AppBundle {
  if (embedded === undefined || chosen.kind !== "release") return false;
  return !isFile(chosen.path) || !newer(chosen.version, embedded.meta.version);
}

/**
 * The launcher is the runtime, which knows only its own version: the installed one is VERSION on disk.
 * Without it `harbor --update` took this copy for 0.0.0-dev, always installed, and kept 0.0.0-dev as the
 * previous version, so a rollback after it named that.
 */
export function installedConfig(base: UpdateConfig): UpdateConfig {
  const v = base.dir === null ? "" : read(join(base.dir, "VERSION"));
  return v === "" ? base : { ...base, version: v };
}

const watchdogSpawn = (cmd: string[]): void => {
  Bun.spawn(cmd, { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
};

export async function launch(argv: string[], opts: LaunchOptions = {}): Promise<number> {
  const base = opts.cfg ?? { ...defaultConfig(), runtime: RUNTIME_VERSION };
  const out = opts.out ?? ((l: string) => console.log(l));
  const err = opts.err ?? ((l: string) => console.error(l));
  const load = opts.load ?? ((p: string) => import(p) as Promise<unknown>);
  const [cmd, ...rest] = argv;

  if (cmd === "runtime-version") {
    out(base.runtime);
    return 0;
  }
  if (cmd === "smoke-bundle") {
    const path = rest[0];
    if (path === undefined) return 2;
    const m = await load(path);
    if (!isBundle(m)) {
      err("harbor: that file is not a Harbor bundle");
      return 1;
    }
    if (needsNewer(m, base.runtime)) {
      err(`harbor: that bundle needs runtime ${m.meta.minRuntime} or newer; this is ${base.runtime}`);
      return 1;
    }
    out(`harbor ${m.meta.version}`);
    return 0;
  }
  if (cmd === "start-watch") {
    const pid = Number(rest[0]);
    if (!Number.isInteger(pid)) return 2;
    return watch(base, pid, {
      relaunch: (args) => (opts.spawn ?? watchdogSpawn)([base.exe, ...args]),
      kill: (p) => process.kill(p, "SIGKILL"),
    });
  }
  if (cmd === "--update" || cmd === "--restore-previous") return (await updateCli(installedConfig(base), cmd, { out, err })) ?? 2;

  const window = isWindowLaunch(argv);
  let chosen: Chosen;
  if (base.dir === null) {
    chosen = { kind: "release", path: join(dirname(base.exe), BUNDLE_FILE), id: "", version: "" };
  } else {
    if (window) recoverUnconfirmed(base);
    chosen = choose(base);
    if (window && !secondary(base, opts.env ?? process.env)) {
      beginAttempt(base, { version: chosen.version, pid: process.pid, kind: chosen.kind, args: argv, id: chosen.id });
      if (opts.armWatchdog !== false) {
        const dir = base.dir;
        captureStart(dir, () => {
          const a = readAttempt(dir);
          return a === null || a.pid !== process.pid || a.stage === "ok";
        });
        (opts.spawn ?? watchdogSpawn)([base.exe, "start-watch", String(process.pid)]);
      }
    }
  }
  const own = useEmbedded(chosen, opts.embedded);
  const info: RuntimeInfo = { version: base.runtime, bundle: own ? base.exe : chosen.path, preview: chosen.kind === "preview", exe: base.exe };
  globalThis.__harbor = Object.assign(globalThis.__harbor ?? {}, { runtime: info });
  const m = own ? opts.embedded : await load(chosen.path);
  if (!isBundle(m)) {
    err(`harbor: ${chosen.path} is not a Harbor bundle`);
    return 1;
  }
  if (needsNewer(m, base.runtime)) {
    err(`harbor: ${m.meta.version} needs runtime ${m.meta.minRuntime} or newer; this is ${base.runtime}`);
    return 1;
  }
  return await m.main(argv);
}
