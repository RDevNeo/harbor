// `harbor <command>`: the command-line entry points agents and helper processes call. Each
// package adds its own command here.
import { runTurn } from "./packages/agents/src/index.ts";
import { mcpshim, serve } from "./packages/mcp/src/index.ts";
import { AccountService, discoverAsk, hostPort, lanAddrs, lanPortmapNet, loadOrCreate, meshCli, ncCli, Portmap, readMe } from "./packages/net/src/index.ts";
import { dataDir, stateDir, Store } from "./packages/store/src/index.ts";
import pkg from "./package.json";
import { startHub } from "./hub.ts";

type Command = (args: string[]) => Promise<number> | number;

const io = { out: (l: string) => console.log(l), err: (l: string) => console.error(l) };

function store(): Store {
  return Store.open(dataDir());
}

function apiPort(s: Store): number {
  const p = s.get("api_port") ?? "";
  return /^\d+$/.test(p) ? Number(p) : 47930;
}

const commands: Record<string, Command> = {
  "--version": () => {
    console.log(`harbor ${pkg.version} (ts)`);
    return 0;
  },
  "--speech-worker": async () => (await import("./packages/media/src/speech-worker.ts")).runSpeechWorker(),
  "--background": async () => {
    const h = await startHub({ version: pkg.version });
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    await h.stop();
    return 0;
  },
  turn: async (args) => {
    // Harbor's own app sign-ins, added by the runner so they never land in the turn's folder.
    (await import("./wire.ts")).wire();
    await runTurn(args);
    return 0;
  },
  mcp: async (args) => {
    await mcpshim.run(args, { version: pkg.version });
    return 0;
  },
  app: (args) => serve.serve(args),
  net: (args) => {
    const s = store();
    return new Portmap({ kv: s, net: lanPortmapNet() }).cli(args, { log: io.out, err: io.err });
  },
  nc: (args) => ncCli(args, { kv: store(), id: loadOrCreate(stateDir()), io, stdin: process.stdin, stdout: process.stdout }),
  mesh: (args) => meshCli(args, { kv: store(), id: loadOrCreate(stateDir()), io, ask: () => discoverAsk({ waitMs: 1500, myFp: loadOrCreate(stateDir()).fp }) }),
  account: (args) => {
    const s = store();
    const port = apiPort(s);
    const svc = new AccountService({
      kv: s,
      stateDir: stateDir(),
      identity: () => loadOrCreate(stateDir()),
      me: () => readMe(s),
      addrs: () => lanAddrs().map((a) => hostPort(a, port)),
      version: pkg.version,
    });
    return svc.cli(args, io);
  },
};
commands["-V"] = commands["--version"] as Command;

const [name, ...rest] = process.argv.slice(2);
if (name === undefined) {
  (await import("./wire.ts")).wire();
  const { openWindow } = await import("./packages/ui/src/index.ts");
  process.exit(await openWindow());
}
const cmd = commands[name];
if (cmd === undefined) {
  console.error(`harbor: unknown command ${name} (this build has: ${Object.keys(commands).join(", ")})`);
  process.exit(2);
}
process.exit(await cmd(rest));
