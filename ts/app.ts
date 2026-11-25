import pkg from "./package.json";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { env as osEnv } from "./packages/os/src/index.ts";
import { DEV_VERSION, RUNTIME_VERSION, VERSION, VIDEO_LIB, defaultConfig, repoRef, runtimeInfo, updateCommands, versionLabel } from "./packages/update/src/index.ts";

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
    // Slint's addon loads (with what it links) without starting a window.
    const slint = (await import("slint-ui/rust-module.cjs")).default as { processEvents?: unknown };
    console.log(`slint: ${typeof slint.processEvents === "function" ? "ok" : "no event loop"}`);
    return typeof sherpa.OfflineRecognizer === "function" && typeof slint.processEvents === "function" ? 0 : 1;
  },
  // Records the microphone to stdout for dictation, where Harbor records itself (macOS).
  "record-mic": async () => {
    const { audio } = await import("./packages/os/src/index.ts");
    return audio.recordToStdout();
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
    console.log(st === null || !on ? (on ? "On: the running Hub starts following main within 10 s." : followMain.statusLine(off, false)) : followMain.statusLine(st, on));
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
        console.error(`harbor hot: ${d} isn't a Hub checkout (no ts/packages/ui/src/cards.ts)`);
        return 1;
      }
      writePrivate(file, `${JSON.stringify({ dir: d })}\n`);
      console.log(`Hot reload on: the running Hub follows ${d} within 3 s. Saves to the transcript's cards, the team tools and the agents' instructions swap in without a restart.`);
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
  // Restarts the running Harbor the way an update does: the window comes back where it was, with what was typed.
  restart: async () => {
    const { single } = await import("./packages/store/src/index.ts");
    if (await single.restartRunning()) return (console.log("Hub is restarting."), 0);
    console.error("harbor: no running Hub answered");
    return 1;
  },
  // A call to the running Harbor's own API, as a phone makes them, with this PC's rights (the control socket is
  // its owner's only): `harbor api PATCH v1/chats/12 '{"device":"pc:Mac"}'`, `harbor api transcribe clip.wav`.
  api: async (args) => {
    const { single } = await import("./packages/store/src/index.ts");
    const [first, second, third] = args;
    if (first === undefined || second === undefined) {
      console.error("usage: harbor api METHOD PATH [JSON] | harbor api transcribe FILE.wav");
      return 2;
    }
    let req: { method: string; path: string; body?: unknown; wav?: string };
    if (first === "transcribe") req = { method: "POST", path: "v1/transcribe", wav: Buffer.from(await Bun.file(second).arrayBuffer()).toString("base64") };
    else {
      let body: unknown = null;
      if (third !== undefined) {
        try {
          body = JSON.parse(third);
        } catch (e) {
          console.error(`harbor api: the body isn't JSON: ${e instanceof Error ? e.message : String(e)}`);
          return 2;
        }
      }
      req = { method: first, path: second, body };
    }
    const r = await single.apiCall(req);
    if (r === null) return (console.error("harbor: no running Hub answered"), 1);
    console.log(JSON.stringify(r.body, null, 2));
    return r.ok ? 0 : 1;
  },
  // Quits the running Harbor as its tray's Quit does, and waits until it's gone (installers, before replacing it).
  // Hub's phones pair here (packages/net/src/hubpair.ts): a one-time code and its link/QR, the paired phones, removing one.
  pair: async (args) => {
    const { single } = await import("./packages/store/src/index.ts");
    const [sub, arg] = args;
    if (sub === "list") {
      const r = await single.apiCall({ method: "GET", path: "v1/pair/devices" });
      if (r === null) return (console.error("hub: Hub isn't running"), 1);
      const list = ((r.body as { devices?: { fp: string; name: string; created: number }[] }).devices ?? []);
      if (list.length === 0) console.log("No phone is paired with this PC yet: run `hub pair`.");
      for (const d of list) console.log(`${d.name}  ${d.fp.slice(0, 16)}…  paired ${new Date(d.created * 1000).toLocaleString()}`);
      return 0;
    }
    if (sub === "remove") {
      if (!arg) return (console.error("usage: hub pair remove FINGERPRINT (from hub pair list)"), 2);
      const all = await single.apiCall({ method: "GET", path: "v1/pair/devices" });
      const fp = ((all?.body as { devices?: { fp: string }[] } | undefined)?.devices ?? []).find((d) => d.fp.startsWith(arg.toLowerCase()))?.fp ?? arg;
      const r = await single.apiCall({ method: "POST", path: "v1/pair/revoke", body: { fp } });
      if (r === null) return (console.error("hub: Hub isn't running"), 1);
      console.log((r.body as { removed?: boolean }).removed ? "Removed: that phone has to pair again." : "No paired phone has that key.");
      return 0;
    }
    if (sub !== undefined) return (console.error("usage: hub pair [list | remove FINGERPRINT]"), 2);
    const r = await single.apiCall({ method: "POST", path: "v1/pair/start" });
    if (r === null || !r.ok) return (console.error(`hub: ${r === null ? "Hub isn't running" : JSON.stringify(r.body)}`), 1);
    const b = r.body as { code: string; link: string; name: string; port: number; addrs: string[]; expires_ms: number };
    const qr = Bun.which("qrencode") === null ? null : Bun.spawnSync(["qrencode", "-t", "ansiutf8", "-m", "2", b.link]);
    if (qr?.exitCode === 0) process.stdout.write(qr.stdout.toString());
    console.log(`Pair a phone with Hub on ${b.name}: scan the code above in Hub for Android, or open this link on the phone:`);
    console.log(b.link);
    console.log(`Code ${b.code.slice(0, 5)}-${b.code.slice(5)} (port ${b.port}; ${b.addrs.join(", ")}), good for one phone until ${new Date(b.expires_ms).toLocaleTimeString()}.`);
    return 0;
  },
  quit: async () => {
    const { single } = await import("./packages/store/src/index.ts");
    if (!(await single.quitRunning())) {
      if (single.lockHeld() === true) return (console.error("harbor: the running Hub didn't answer"), 1);
      return (console.log("Hub isn't running."), 0);
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      // Gone: its lock is free (or, with no lock to test, its control socket no longer answers).
      const held = single.lockHeld();
      if (held === false || (held === null && !(await single.socketListening()))) return (console.log("Hub quit."), 0);
      await new Promise((r) => setTimeout(r, 200));
    }
    console.error("harbor: Hub is still quitting after 30 s");
    return 1;
  },
  // Harbor has administrator rights by default (packages/os/src/admin.ts: Windows runs it as administrator, Linux
  // and macOS give its agents passwordless sudo). `harbor admin off` turns that off
  // for good (updates don't turn it back on), `harbor admin on` back on; `harbor admin` says how it runs. The running
  // Harbor does it (and restarts into or out of the administrator token); with none running, this command does.
  admin: async (args) => {
    const what = args[0] ?? "status";
    if (!["status", "on", "off"].includes(what)) return (console.error("usage: harbor admin [status|on|off]"), 2);
    const { admin, autostart } = await import("./packages/os/src/index.ts");
    if (!admin.state().supported) return (console.log("Hub's administrator rights are for Windows, Linux and macOS."), what === "status" ? 0 : 2);
    const { single } = await import("./packages/store/src/index.ts");
    // Linux and macOS: this command does it, and sudo asks for the password right here when it must.
    const r = admin.cliLocal() ? null : await single.adminRunning(what);
    if (r !== null) {
      (r.ok ? console.log : console.error)(r.text);
      return r.ok ? 0 : 1;
    }
    if (what === "status") {
      for (const l of await admin.status("command")) console.log(l);
      if (!admin.cliLocal()) console.log("Hub isn't running.");
      return 0;
    }
    const exe = autostart.installedLauncher();
    if (!existsSync(exe)) return (console.error(`harbor: no installed Hub at ${exe}`), 1);
    const done = await admin.set(what === "on", { exe, login: autostart.enabled("--background", exe), arg: "--background" }, "terminal");
    const said = admin.cliLocal() ? done.message : what === "on" ? "On: Hub starts as administrator from now on." : "Off: Hub starts with your normal rights from now on, updates included (harbor admin on turns it back on).";
    (done.ok ? console.log : console.error)(done.ok ? said : done.message);
    return done.ok ? 0 : 1;
  },
  // The one prompt's program, run elevated: registers or removes the scheduled task.
  "admin-task": async (args) => (await import("./packages/os/src/index.ts")).admin.taskCommand(args),
  // The scheduled task's action: starts the Harbor that was asked for (or the logon start), then leaves.
  "admin-start": async () => (await import("./packages/os/src/index.ts")).admin.taskStart(),
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
    // Embedded (Person Hub's engine, an unmanaged copy): its bundle is the one beside the runtime, replaced by Person Hub's installs.
    const own = process.env.HARBOR_EMBEDDED === "1" ? runtimeInfo()?.bundle : undefined;
    const bundle = dir !== null && existsSync(join(dir, "harbor-app.js")) ? join(dir, "harbor-app.js") : own !== undefined && existsSync(own) ? own : undefined;
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
    const portText = s.get("hub_api_port") ?? "";
    const port = /^\d+$/.test(portText) ? Number(portText) : 47940;
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
  // Windows: PATH by its usual name, Git Bash and the agents' folders on it (nothing elsewhere).
  osEnv.normalize();
  const [name, ...rest] = argv;
  if (name === undefined) return (await import("./run.ts")).runApp({ window: true, argv: [], version });
  const cmd = commands[name];
  if (cmd === undefined) {
    console.error(`harbor: unknown command ${name} (this build has: ${Object.keys(commands).join(", ")})`);
    return 2;
  }
  return await cmd(rest);
}
