import { defaultConfig, sleep, type UpdateConfig } from "./config.ts";
import { Updater } from "./delivery.ts";
import { install, NoBuild, rollback, current } from "./install.ts";
import { ask, cli as previewCli, label } from "./preview.ts";
import { GIT_SHA, newer, VERSION } from "./version.ts";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function updateCli(cfg: UpdateConfig, arg: string, io: CliIo): Promise<number | null> {
  try {
    if (arg === "--update") {
      if (cfg.dir === null) throw new Error("this copy wasn't installed by install.sh, so it doesn't update itself");
      const v = await new Updater(cfg).latest();
      if (!newer(v, current(cfg))) {
        io.out(`Harbor ${current(cfg)} is up to date.`);
        return 0;
      }
      io.out(`Installing Harbor ${v}…`);
      try {
        await install(cfg, v);
      } catch (e) {
        if (!(e instanceof NoBuild)) throw e;
        io.out(`Harbor ${v} has no build of this app yet: staying on ${current(cfg)}.`);
        return 0;
      }
      io.out(`Harbor ${v} is installed.`);
      return 0;
    }
    if (arg === "--restore-previous") {
      io.out(`Harbor ${rollback(cfg).restored} is back.`);
      return 0;
    }
    return null;
  } catch (e) {
    io.err(`harbor: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export function versionLabel(cfg: UpdateConfig = defaultConfig()): string {
  const base = GIT_SHA === null ? VERSION : `${VERSION} (${GIT_SHA})`;
  const p = label(cfg);
  return p === null ? base : `${base} ${p}`;
}

type Command = (args: string[]) => Promise<number> | number;

export const updateCommands: Record<string, Command> = {
  "--version": () => {
    console.log(`harbor ${versionLabel()}`);
    return 0;
  },
  preview: async (args) => {
    const { single } = await import("@harbor/store");
    const sock = single.socketPath();
    return previewCli(defaultConfig(), args, {
      out: (l) => console.log(l),
      err: (l) => console.error(l),
      ask: (v) => ask(v, sock),
      sleep: (ms) => sleep(ms),
    });
  },
};
