import pkg from "./package.json";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEV_VERSION, RUNTIME_VERSION, VERSION, VIDEO_LIB, defaultConfig, repoRef, updateCommands, versionLabel } from "./packages/update/src/index.ts";

declare const HARBOR_MIN_RUNTIME: string | undefined;

const version = VERSION === DEV_VERSION ? pkg.version : VERSION;

export const meta = { version, minRuntime: typeof HARBOR_MIN_RUNTIME === "string" ? HARBOR_MIN_RUNTIME : RUNTIME_VERSION };

type Command = (args: string[]) => Promise<number> | number;

const io = { out: (l: string) => console.log(l), err: (l: string) => console.error(l) };

async function store() {
  const { dataDir, Store } = await import("./packages/store/src/index.ts");
  return Store.open(dataDir());
}

// Each command loads only what it needs: `--version` or `harbor mcp` must not start the window's or the mesh's code.
const commands: Record<string, Command> = {
  ...updateCommands,
  "--check-native": async () => {
    const { sharpLib } = await import("./packages/media/src/sharplib.ts");
    const sharp = await sharpLib();
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#f00" } }).png().toBuffer();
    const svg = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#00f"/></svg>')).png().toBuffer();
    console.log(`sharp: ok, libvips ${sharp.versions.vips}, a ${png.length} byte png, a ${svg.length} byte png from an svg`);
    const sherpa = (await import("sherpa-onnx-node")).default;
    console.log(`sherpa: ${typeof sherpa.OfflineRecognizer === "function" ? "ok" : "no recognizer"}`);
    return typeof sherpa.OfflineRecognizer === "function" ? 0 : 1;
  },
  "--version": () => {
    console.log(`harbor ${VERSION === DEV_VERSION ? `${pkg.version} (ts)` : versionLabel()}`);
    return 0;
  },
  "--check-video": async (args) => {
    const { video } = await import("./packages/media/src/index.ts");
    // Harbor's own player, where install.sh and the updater put it (the window asks the updater the same).
    const dir = defaultConfig().dir;
    const own = dir !== null && existsSync(join(dir, VIDEO_LIB)) ? join(dir, VIDEO_LIB) : null;
    const r = video.checkVideo(args, own);
    for (const line of r.lines) console.log(line);
    return r.code;
  },
  "follow-main": async (args) => {
    const { followMain } = await import("./packages/update/src/index.ts");
    const { dataDir } = await import("./packages/store/src/index.ts");
    const verb = args[0] ?? "status";
    const at = args.indexOf("--checkout");
    if (!["status", "on", "off"].includes(verb) || (at >= 0 && !args[at + 1])) {
      console.error("usage: harbor follow-main [status|on|off] [--checkout DIR]");
      return 2;
    }
    const kv = await store();
    if (at >= 0) kv.set(followMain.CHECKOUT_KEY, (await import("node:path")).resolve(args[at + 1] as string));
    if (verb !== "status") followMain.setEnabled(kv, verb === "on");
    const checkout = followMain.findCheckout(kv, () => kv.repos());
    const on = followMain.enabled(kv);
    const { readJson } = await import("./packages/update/src/files.ts");
    const st = readJson<import("./packages/update/src/followmain.ts").FollowStatus>(join(dataDir(), followMain.DIR, "status.json"));
    console.log(`main: ${process.env.HARBOR_FOLLOW_REMOTE || followMain.REMOTE}${checkout === null ? "" : `, or ${checkout} when it's ahead`}`);
    const off = { state: "off" as const, checkout: "", commit: "", subject: "", version: "", reason: "", at: 0 };
    console.log(st === null || !on ? (on ? "On: the running Harbor starts following main within 10 s." : followMain.statusLine(off, false)) : followMain.statusLine(st, on));
    if (st?.last) console.log(followMain.timelineText(st.last));
    return 0;
  },
  "--check-window": async (args) => (await import("./run.ts")).checkWindow(args, version),
  "--speech-worker": async () => (await import("./packages/media/src/speech-worker.ts")).runSpeechWorker(),
  // Dev hot reload (packages/ui/src/hotdev.ts): this PC's running Harbor follows a checkout's TypeScript.
  hot: async (args) => {
    const { stateDir, writePrivate } = await import("./packages/store/src/index.ts");
    const { rmSync, readFileSync } = await import("node:fs");
    const file = join(stateDir(), "hot.json");
    const [verb = "status", dir] = args;
    if (verb === "on") {
      const d = resolve(dir ?? process.cwd());
      if (!["ts/packages/ui/src/cards.ts", "packages/ui/src/cards.ts"].some((f) => existsSync(join(d, f)))) {
        console.error(`harbor hot: ${d} isn't a Harbor checkout (no ts/packages/ui/src/cards.ts)`);
        return 1;
      }
      writePrivate(file, `${JSON.stringify({ dir: d })}\n`);
      console.log(`Hot reload on: the running Harbor follows ${d} within 3 s. Saves to the transcript's cards, the team tools and the agents' instructions swap in without a restart.`);
      return 0;
    }
    if (verb === "off") {
      rmSync(file, { force: true });
      console.log("Hot reload off: what's loaded stays until the next start.");
      return 0;
    }
    if (verb !== "status") {
      console.error("usage: harbor hot on [DIR] | off | status");
      return 2;
    }
    let on = "";
    try {
      on = String((JSON.parse(readFileSync(file, "utf8")) as { dir?: unknown }).dir ?? "");
    } catch {
      // off
    }
    console.log(process.env.HARBOR_HOT ? `on (HARBOR_HOT): ${process.env.HARBOR_HOT}` : on !== "" ? `on: ${on}` : "off");
    return 0;
  },
  "--background": async (args) => (await import("./run.ts")).runApp({ window: false, argv: ["--background", ...args], version }),
  turn: async (args) => {
    const { runTurn } = await import("./packages/agents/src/index.ts");
    // Harbor's own app sign-ins, added by the runner so they never land in the turn's folder.
    (await import("./wire.ts")).wire();
    await runTurn(args);
    return 0;
  },
  mcp: async (args) => {
    const { mcpshim } = await import("./packages/mcp/src/index.ts");
    await mcpshim.run(args, { version });
    return 0;
  },
  // The app bundle's own version and commit: the runtime may be older than the bundle.
  app: async (args) => {
    // An update replaces the installed bundle: the Discord host watches it, to make way for the new one.
    const dir = defaultConfig().dir;
    const bundle = dir !== null && existsSync(join(dir, "harbor-app.js")) ? join(dir, "harbor-app.js") : undefined;
    return (await import("./packages/mcp/src/index.ts")).serve.serve(args, { version, shellRef: repoRef(), bundle });
  },
  net: async (args) => {
    const { lanPortmapNet, Portmap } = await import("./packages/net/src/index.ts");
    return new Portmap({ kv: await store(), net: lanPortmapNet() }).cli(args, { log: io.out, err: io.err });
  },
  nc: async (args) => {
    const { loadOrCreate, ncCli } = await import("./packages/net/src/index.ts");
    const { stateDir } = await import("./packages/store/src/index.ts");
    const tailnetNc = (host: string, port: number): Promise<number> | null =>
      Bun.which("tailscale") === null ? null : Bun.spawn(["tailscale", "nc", host, String(port)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
    return ncCli(args, { kv: await store(), id: loadOrCreate(stateDir()), io, stdin: process.stdin, stdout: process.stdout, tailnetNc });
  },
  mesh: async (args) => {
    const { discoverAsk, loadOrCreate, meshCli } = await import("./packages/net/src/index.ts");
    const { stateDir } = await import("./packages/store/src/index.ts");
    return meshCli(args, { kv: await store(), id: loadOrCreate(stateDir()), io, ask: () => discoverAsk({ waitMs: 1500, myFp: loadOrCreate(stateDir()).fp }) });
  },
  account: async (args) => {
    const { AccountService, hostPort, lanAddrs, loadOrCreate, readMe } = await import("./packages/net/src/index.ts");
    const { stateDir } = await import("./packages/store/src/index.ts");
    const s = await store();
    const portText = s.get("api_port") ?? "";
    const port = /^\d+$/.test(portText) ? Number(portText) : 47930;
    const svc = new AccountService({
      kv: s,
      stateDir: stateDir(),
      identity: () => loadOrCreate(stateDir()),
      me: () => readMe(s),
      addrs: () => lanAddrs().map((a) => hostPort(a, port)),
      version,
    });
    return svc.cli(args, io);
  },
};
commands["-V"] = commands["--version"] as Command;

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined) return (await import("./run.ts")).runApp({ window: true, argv: [], version });
  const cmd = commands[name];
  if (cmd === undefined) {
    console.error(`harbor: unknown command ${name} (this build has: ${Object.keys(commands).join(", ")})`);
    return 2;
  }
  return await cmd(rest);
}
