import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ICONS,
  MCP_CONFIG_ARG,
  MemKv,
  PS_BOOT,
  Remotes,
  REMOTE_EXIT,
  findDevice,
  glyph,
  hostLabel,
  hostname,
  iconPath,
  isDevice,
  loadRemote,
  matchSshEntry,
  migrateDevices,
  nearbyFrom,
  newConfig,
  newHost,
  newTailPeer,
  newTailnet,
  osFrom,
  osLabel,
  pairedPcs,
  parseAvahi,
  parseRemoteSshConfig,
  parseTailscaleStatus,
  pathLookup,
  pathRequire,
  probeResult,
  profileSetup,
  psPath,
  psQuote,
  psScript,
  psSetup,
  remoteCommand,
  remoteDevices,
  remoteDir,
  remoteLaunch,
  runProbe,
  saveRemote,
  shQuote,
  shellArgv,
  shellFamily,
  shellPath,
  sshLogin,
  sshOpts,
  sshPort,
  testCommand,
  newPeer,
  type Allowed,
  type RemoteCtx,
  type RemoteHost,
  type RemoteSetup,
  type RunOutput,
  type Runner,
} from "../src/index.ts";

const HOME = "/home/user";

function ctx(over: Partial<RemoteCtx> = {}): RemoteCtx {
  return { home: HOME, selfExe: () => null, sshConfig: () => [], probe: () => undefined, ...over };
}

const allowed = (p: Partial<Allowed>): Allowed => ({ node: "", name: "", fp: "", id: "", addrs: [], ...p });

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** `sh -c script` with `input` on stdin, as ssh's remote shell would run it. */
function sh(script: string, input: string | null, env: Record<string, string | undefined> = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const e: Record<string, string | undefined> = { ...process.env, ...env };
    delete e.CLAUDE_CODE_OAUTH_TOKEN;
    const c = spawn("sh", ["-c", script], { env: e as NodeJS.ProcessEnv, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    c.stdout?.on("data", (d: Buffer) => out.push(d));
    c.stderr?.on("data", (d: Buffer) => err.push(d));
    c.once("error", reject);
    c.once("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    if (input !== null && c.stdin) {
      c.stdin.on("error", () => undefined);
      c.stdin.end(input);
    }
  });
}

/** The agent's own output: what the script printed before its last line (the agent's exit, for detach.rs). */
function agentOut(out: string, code: number): string {
  const end = `\n{"type":"${REMOTE_EXIT}","code":${code}}\n`;
  if (!out.endsWith(end)) throw new Error(`no exit line in ${JSON.stringify(out)}`);
  return out.slice(0, -end.length);
}


function status(peers: string): ReturnType<typeof parseTailscaleStatus> {
  return parseTailscaleStatus(JSON.parse(`{"Self":{"DNSName":"me.mytail.ts.net."},"Peer":{${peers}}}`));
}

describe("remote", () => {
  test("parses_tailscale_status", () => {
    const v: unknown = JSON.parse(`{"BackendState":"Running","Self":{"DNSName":"me.tail.ts.net."},"Peer":{
      "a":{"HostName":"Box","DNSName":"box.tail.ts.net.","OS":"linux","Online":true,"TailscaleIPs":["100.1.2.3"]},
      "b":{"HostName":"Phone","DNSName":"phone.tail.ts.net.","OS":"android","Online":true,"TailscaleIPs":["100.1.2.4"]},
      "c":{"HostName":"Mac Air","DNSName":"mac-air.tail.ts.net.","OS":"macOS","Online":false,"TailscaleIPs":["100.1.2.5"]}}}`);
    const t = parseTailscaleStatus(v);
    expect(t.state).toBe("Running");
    expect(t.me).toBe("me");
    expect(t.peers.length).toBe(2);
    expect([t.peers[0]?.id, t.peers[0]?.dns, t.peers[0]?.online]).toEqual(["ts:box", "box.tail.ts.net", true]);
    expect([t.peers[1]?.id, t.peers[1]?.os]).toEqual(["ts:mac-air", "macOS"]);
  });

  test("tailscale_ids_are_never_ambiguous", () => {
    // A look-alike shared in from another tailnet, online while the own one is off.
    let net = status(`"a":{"HostName":"desk","DNSName":"desk.mytail.ts.net.","OS":"linux","Online":false},
      "b":{"HostName":"desk","DNSName":"desk.other.ts.net.","OS":"linux","Online":true}`);
    const cfg = newConfig();
    const c = ctx();
    expect(findDevice(c, cfg, net, "ts:desk")?.host).toBe("desk.mytail.ts.net");
    expect(findDevice(c, cfg, net, "ts:desk.other.ts.net")?.host).toBe("desk.other.ts.net");
    // No DNS name: its HostName is the peer's own choice, so it can't take an id.
    net = status(`"a":{"HostName":"desk","DNSName":"desk.mytail.ts.net.","OS":"linux","Online":false},
      "b":{"HostName":"desk","DNSName":"","OS":"linux","Online":true}`);
    expect(net.peers.length).toBe(1);
    expect(findDevice(c, cfg, net, "ts:desk")?.host).toBe("desk.mytail.ts.net");
    // Neither in this tailnet: neither is "desk".
    net = status(`"a":{"HostName":"desk","DNSName":"desk.one.ts.net.","OS":"linux"},
      "b":{"HostName":"desk","DNSName":"desk.two.ts.net.","OS":"linux"}`);
    expect(findDevice(c, cfg, net, "ts:desk")).toBeNull();
  });

  test("ssh_config_entries", () => {
    const src =
      "Host *\n  User nobody\nHost desk pc-*\n    HostName 10.0.0.11\n    User desk\n    User other\n    IdentityFile ~/.ssh/id_ed25519\n" +
      "Include extra\nHost laptop sam\n  HostName=10.0.0.95\n  User sam-work\nMatch all\n  User ignored\nHost a13\n  Port 8022\n";
    const read = (f: string) => (f === "extra" ? "Host box\n  HostName box.tail.ts.net\n  User boxer\n" : null);
    const e = parseRemoteSshConfig(src, read, 0);
    expect(e.map((x) => x.aliases.join(","))).toEqual(["desk", "box", "laptop,sam", "a13"]);
    expect([e[0]?.user, e[0]?.key]).toEqual(["desk", "~/.ssh/id_ed25519"]);
    expect([e[3]?.host_name, e[3]?.port]).toEqual(["a13", 8022]);
    const m = (names: string[]) => matchSshEntry(e, names)?.user ?? null;
    expect(m(["home-desk.tail.ts.net", "10.0.0.11"])).toBe("desk");
    expect(m(["fd7a::1", "10.0.0.95"])).toBe("sam-work");
    expect(m(["BOX.tail.ts.net"])).toBe("boxer");
    expect(m(["sam"])).toBe("sam-work");
    expect(m(["elsewhere", ""])).toBeNull();
  });

  // The Rust test is #[ignore]: it connects to real devices named in HARBOR_TEST_DEVICES. Here the
  // same Test-button path (login, probe, OS) runs against a fake ssh that answers like a device.
  test("devices_connect", async () => {
    const calls: RemoteCommandLike[] = [];
    const run: Runner = async (program, args) => {
      calls.push({ program, args });
      return { code: 0, stdout: "HARBOR_OK\nLinux x86_64\nclaude 2.1.0 (Claude Code)\n", stderr: "" };
    };
    const c = ctx({ sshConfig: () => parseRemoteSshConfig("Host desk\n  HostName 10.0.0.11\n  User deskuser\n", () => null) });
    const h = newHost({ id: "ssh:desk", host: "desk" });
    const p = await runProbe(run, c, newConfig(), h);
    expect([p.ok, p.os, p.text]).toEqual([true, "linux", "Connected · Linux x86_64 · claude 2.1.0 (Claude Code)"]);
    expect(sshLogin(c, newConfig(), h)).toEqual(["deskuser", true]);
    expect(calls.length).toBe(1);
    expect(calls[0]?.program).toBe("ssh");
    expect(calls[0]?.args).toContain("deskuser");
    expect(calls[0]?.args.at(-2)).toBe("desk");
  });

  test("remote_dirs", () => {
    expect(remoteDir(HOME, newHost(), `${HOME}/Documents/app`)).toBe("~");
    let h = newHost({ device_files: true });
    expect(remoteDir(HOME, h, `${HOME}/Documents/app`)).toBe("~/Documents/app");
    expect(remoteDir(HOME, h, null)).toBe("~");
    h = newHost({ dir: "~/work/", device_files: true });
    expect(remoteDir(HOME, h, `${HOME}/Documents/app`)).toBe("~/work/app");
    expect(remoteDir(HOME, h, null)).toBe("~/work");
    expect(shellPath("~/a b")).toBe(`"$HOME"/'a b'`);
    expect(shellPath("/srv/x")).toBe("'/srv/x'");
    expect(remoteDir(HOME, newHost({ device_files: true }), "/srv/elsewhere")).toBe("/srv/elsewhere");
    expect(remoteDir(HOME, newHost({ device_files: true }), HOME)).toBe("~");
  });

  test("remote_command_runs_in_a_login_shell", async () => {
    const c = remoteCommand("~/p", [], ["claude", "-p", "it's"]);
    expect(c.startsWith("if command -v bash")).toBe(true);
    expect(c).toContain("exec bash -lc '");
    // The script round-trips through sh: run it with `sh` as the agent.
    const script = remoteCommand("/", [{ kind: "sh", line: "export X=1" }], ["sh", "-c", 'echo "$X $(cat)"']);
    const out = await sh(script, "in");
    expect(agentOut(out.stdout, 0).trim()).toBe("1 in");
    // The last line says the agent exited, and how.
    const failing = await sh(remoteCommand("/", [], ["sh", "-c", "exit 5"]), null);
    expect([failing.code, agentOut(failing.stdout, 5)]).toEqual([5, ""]);
  });

  test("token_setup_takes_the_first_stdin_line", async () => {
    const setup: RemoteSetup[] = [{ kind: "token" }, { kind: "sh", line: "export X=1" }];
    const agent = ["sh", "-c", `printf '%s|%s|' "$CLAUDE_CODE_OAUTH_TOKEN" "$X"; cat`];
    const script = remoteCommand("/", setup, agent);
    expect(script).not.toContain("sk-ant-oat01");
    const out = await sh(script, 'sk-ant-oat01-abc\n{"type":"user"}\n{"n":2}\n');
    expect(agentOut(out.stdout, 0)).toBe('sk-ant-oat01-abc|1|{"type":"user"}\n{"n":2}\n');
    // Without a login line (the account isn't signed in here) nothing is read.
    const plain = remoteCommand("/", [{ kind: "sh", line: "export X=1" }], agent);
    const out2 = await sh(plain, '{"n":1}\n');
    expect(agentOut(out2.stdout, 0)).toBe('|1|{"n":1}\n');
  });

  test("mcp_config_travels_on_stdin", async () => {
    const setup: RemoteSetup[] = [{ kind: "token" }, { kind: "mcp" }];
    const argv = ["sh", "-c", `printf '%s|%s|%s|%s|' "$CLAUDE_CODE_OAUTH_TOKEN" "$1" "$(cat "$1")" "$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1")"; cat`, "sh", MCP_CONFIG_ARG];
    const script = remoteCommand("/", setup, argv);
    expect(script).not.toContain("secret-grant");
    const out = await sh(script, 'sk-ant-oat01-abc\n{"url":"http://127.0.0.1:1/secret-grant/origin"}\n{"type":"user"}\n');
    const parts = agentOut(out.stdout, 0).split("|");
    expect(parts[0]).toBe("sk-ant-oat01-abc");
    expect(parts[2]).toBe('{"url":"http://127.0.0.1:1/secret-grant/origin"}');
    expect(parts[3]).toBe("600");
    expect(parts[4]).toBe('{"type":"user"}\n');
    const file = parts[1] ?? "";
    expect(file !== "" && !existsSync(file)).toBe(true);
  });

  test("remote_command_finds_the_cli_off_the_login_path", async () => {
    const home = tempDir("harbor-home-");
    try {
      mkdirSync(join(home, ".local/bin"), { recursive: true });
      const cli = join(home, ".local/bin/harbor-fake-cli");
      writeFileSync(cli, '#!/bin/sh\necho "fake $1 $(cat)"\n');
      chmodSync(cli, 0o755);
      const run = async (argv: string[]) => {
        const out = await sh(remoteCommand("/", [], argv), "in", { HOME: home, PATH: "/usr/bin:/bin" });
        // (Without the script's last line, there once the agent ran.)
        const stdout = out.stdout
          .split("\n")
          .filter((l) => !l.includes(REMOTE_EXIT))
          .join("\n")
          .trim();
        return [out.code, stdout, out.stderr.trim()] as const;
      };
      expect(await run(["harbor-fake-cli", "--version"])).toEqual([0, "fake --version in", ""]);
      const [code, out, err] = await run(["harbor-missing-cli"]);
      expect([code, out]).toEqual([98, ""]);
      expect(err.endsWith("install it or add it to ~/.bash_profile")).toBe(true);
      expect(err.startsWith("harbor: harbor-missing-cli isn't on the PATH of a login shell on ")).toBe(true);
      // Claude by its product name, and the Test button's script with the same lookup.
      expect(pathRequire("claude")).toContain("harbor: Claude Code isn't on the PATH");
      const probe = testCommand(ctx(), newConfig(), newHost(), "posix");
      const arg = probe.args.at(-1) ?? "";
      expect(arg.includes("HARBOR_OK") && arg.includes("/opt/homebrew/bin") && arg.includes("zsh -lic")).toBe(true);
      // A zsh login shell is asked last, with no stdin to swallow.
      expect(pathLookup("claude")).toContain("</dev/null");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The Rust test is #[ignore] (it needs ssh to 127.0.0.1). The part it checks, that the agent goes
  // when the connection's process goes, is run here with a parent shell standing in for sshd's.
  test(
    "agent_there_stops_with_ssh",
    async () => {
      const dir = tempDir("harbor-stop-");
      const pidFile = join(dir, "pid");
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      let agent = 0;
      const parent = spawn("sh", ["-c", 'sh -c "$1" & wait', "x", remoteCommand("/tmp", [], ["sh", "-c", `echo $$ > ${shQuote(pidFile)}; exec sleep 34717`])], { stdio: "ignore" });
      try {
        const until = async (cond: () => boolean, ms: number) => {
          const end = Date.now() + ms;
          while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
        };
        await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 8000);
        agent = Number(readFileSync(pidFile, "utf8").trim());
        expect(alive(agent)).toBe(true);
        parent.kill("SIGKILL");
        await until(() => !alive(agent), 12000);
        expect(alive(agent)).toBe(false);
      } finally {
        parent.kill("SIGKILL");
        if (agent > 0 && alive(agent)) process.kill(agent, "SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test("os_words", () => {
    expect(osFrom("Darwin arm64")).toBe("macOS");
    expect(osFrom("Linux x86_64")).toBe("linux");
    expect(osFrom("FreeBSD amd64")).toBe("freebsd");
    expect(osFrom("Windows AMD64")).toBe("windows");
    expect(osFrom("MINGW64_NT-10.0-22631 x86_64")).toBe("windows");
    expect(osFrom("")).toBe("");
    expect([shellFamily("windows"), shellFamily("macOS"), shellFamily("")]).toEqual(["windows", "posix", "posix"]);
    expect(osLabel("windows")).toBe("Windows");
  });

  test("probe_reads_the_os", () => {
    const out = (stdout: string, code: number): RunOutput => ({ code, stdout, stderr: "boom\n" });
    let p = probeResult(out("motd\nHARBOR_OK\r\nWindows AMD64\r\nclaude 2.1.0 (Claude Code)\r\n", 0));
    expect([p.ok, p.os, p.text]).toEqual([true, "windows", "Connected · Windows AMD64 · claude 2.1.0 (Claude Code)"]);
    p = probeResult(out("HARBOR_OK\nDarwin arm64\nno claude\n", 0));
    expect([p.ok, p.os]).toEqual([true, "macOS"]);
    expect(p.text.endsWith("Claude Code isn't installed there")).toBe(true);
    // A Windows box with no CLI prints an empty version.
    expect(probeResult(out("HARBOR_OK\nWindows ARM64\nclaude \n", 0)).text).not.toContain("· claude");
    p = probeResult(out("", 1));
    expect([p.ok, p.os, p.text]).toEqual([false, "", "boom"]);
  });

  test("powershell_quoting", () => {
    expect(psQuote("it's")).toBe("'it''s'");
    expect(psQuote("a\u2019b")).toBe("'a\u2019\u2019b'");
    expect(psQuote('$env:X `n "q"')).toBe(`'$env:X \`n "q"'`);
    expect(psPath("~")).toBe("$HOME");
    expect(psPath("~/Documents/my app")).toBe("(Join-Path $HOME 'Documents/my app')");
    expect(psPath("D:\\work")).toBe("'D:\\work'");
    expect(winArg("plain")).toBe("plain");
    expect(winArg("")).toBe('""');
    expect(winArg("a b")).toBe('"a b"');
    expect(winArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(winArg("C:\\dir\\")).toBe("C:\\dir\\");
    expect(winArg("C:\\my dir\\")).toBe('"C:\\my dir\\\\"');
    expect(winArg('\\\\"x')).toBe('"\\\\\\\\\\"x"');
  });

  test("windows_turn_command_is_short_and_fixed", () => {
    const long = "x".repeat(20_000);
    const argv = ["claude", "-p", "--append-system-prompt", long, "--mcp-config", MCP_CONFIG_ARG];
    const a = remoteLaunch("windows", "~/Documents/app", [{ kind: "token" }, { kind: "mcp" }], argv);
    const b = remoteLaunch("windows", "~", [], ["claude"]);
    expect(a.command).toBe(b.command);
    expect(a.command.length).toBeLessThan(2000);
    expect(a.command.startsWith("powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ")).toBe(true);
    // The encoded command is UTF-16LE base64 of the boot script.
    const b64 = a.command.split(" ").at(-1) ?? "";
    expect(Buffer.from(b64, "base64").toString("utf16le")).toBe(PS_BOOT);
    // The script is the first stdin line, and only one line.
    expect(a.input.endsWith("\n") && a.input.split("\n").length === 2).toBe(true);
    const script = Buffer.from(a.input.trim(), "base64").toString("utf8");
    expect(script).toBe(psScript("~/Documents/app", [{ kind: "token" }, { kind: "mcp" }], argv));
    const at = (n: string) => {
      const i = script.indexOf(n);
      if (i < 0) throw new Error(`${n} not in ${script}`);
      return i;
    };
    expect(at("Set-Location -LiteralPath (Join-Path $HOME 'Documents/app')")).toBeLessThan(at("$env:CLAUDE_CODE_OAUTH_TOKEN=(HarborLine)"));
    expect(at("$env:CLAUDE_CODE_OAUTH_TOKEN=")).toBeLessThan(at("$env:HARBOR_MCP_CONFIG=$HarborMcp"));
    expect(at("$env:HARBOR_MCP_CONFIG=$HarborMcp")).toBeLessThan(at("Get-Command 'claude'"));
    expect(script).toContain("'--mcp-config',$env:HARBOR_MCP_CONFIG)");
    // Where Windows installers put the CLI, npm's shim run through node.
    for (const d of ["$env:USERPROFILE\\.local\\bin", "$env:APPDATA\\npm", "'claude.exe','claude.cmd'", "node_modules\\@anthropic-ai\\claude-code\\cli.js"]) expect(script).toContain(d);
    // POSIX setup lines don't leak into PowerShell.
    expect(psScript("~", [{ kind: "sh", line: "export X=1" }], ["claude"])).not.toContain("export X");
  });

  test("windows_terminal_and_probe_go_through_powershell", () => {
    const h = newHost({ id: "ssh:1", host: "winbox", os: "windows" });
    const argv = shellArgv(ctx(), newConfig(), h, "claude /login");
    expect(argv.at(-2)).toBe("winbox");
    expect(argv.at(-1)?.startsWith("powershell -NoLogo")).toBe(true);
    expect(argv.at(-1)).not.toContain("bash");
    // No command: ssh's own shell there.
    expect(shellArgv(ctx(), newConfig(), h, null).at(-1)).toBe("winbox");
    const t = testCommand(ctx(), newConfig(), h, "windows");
    expect(t.args.at(-1)?.startsWith("powershell ")).toBe(true);
  });

  // The Rust test skips itself without PowerShell; so does this one.
  test("windows_turn_runs_under_powershell", async () => {
    const pwsh = findPwsh();
    if (pwsh === null) {
      console.error("skipped: no pwsh (set HARBOR_TEST_PWSH)");
      return;
    }
    const root = tempDir("harbor-ps-");
    try {
      const bin = join(root, "bin");
      const work = join(root, "my work");
      mkdirSync(bin, { recursive: true });
      mkdirSync(work, { recursive: true });
      // `powershell` is what ssh runs there.
      symlinkSync(pwsh, join(bin, "powershell"));
      const cli = join(bin, "harbor-fake-cli");
      writeFileSync(
        cli,
        "#!/usr/bin/env python3\nimport json,os,sys\nm=sys.argv[-1]\nprint(json.dumps({'argv':sys.argv[1:],'token':os.environ.get('CLAUDE_CODE_OAUTH_TOKEN'),'mcp':open(m).read(),'mode':oct(os.stat(m).st_mode&0o777),'cwd':os.getcwd(),'stdin':sys.stdin.read()}))\nsys.exit(7)\n",
      );
      chmodSync(cli, 0o755);
      const tricky = ["-p", 'it\'s "quoted"', "back\\slash\\", "C:\\my dir\\", "", "line one\nline two", "naïve ✓ ‘curly’", "$env:PATH %OS% `tick`", 'a\\\\"b'];
      const argv = ["harbor-fake-cli", ...tricky, MCP_CONFIG_ARG];
      const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root };
      const l = remoteLaunch("windows", work, [{ kind: "token" }, { kind: "mcp" }], argv);
      const input = `${l.input}sk-ant-oat01-abc\n{"mcpServers":{}}\n{"type":"user"}\n{"n":2}\n`;
      const r = await sh(l.command, input, env);
      expect(r.code).toBe(7);
      const [agent, exit] = r.stdout.trim().split("\n\n");
      expect(exit?.trim()).toBe(`{"type":"${REMOTE_EXIT}","code":7}`);
      const v = JSON.parse(agent ?? "") as { argv: string[]; token: string; mcp: string; mode: string; cwd: string; stdin: string };
      expect(v.argv.slice(0, tricky.length)).toEqual(tricky);
      expect(v.token).toBe("sk-ant-oat01-abc");
      expect(v.mcp).toBe('{"mcpServers":{}}\n');
      expect(v.mode).toBe("0o600");
      expect(v.stdin).toBe('{"type":"user"}\n{"n":2}\n');
      expect(realpathSync(v.cwd)).toBe(realpathSync(work));
      expect(existsSync(v.argv.at(-1) ?? "")).toBe(false);
      // No folder, no CLI: the same words and codes as on POSIX.
      const l2 = remoteLaunch("windows", "/nowhere/at-all", [], argv);
      const r2 = await sh(l2.command, l2.input, env);
      expect(r2.code).toBe(97);
      expect(r2.stderr).toContain("harbor: the folder /nowhere/at-all doesn't exist on");
      const l3 = remoteLaunch("windows", "~", [], ["harbor-missing-cli"]);
      const r3 = await sh(l3.command, l3.input, env);
      expect(r3.code).toBe(98);
      expect(r3.stderr).toContain("harbor: harbor-missing-cli isn't on the PATH on");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The Rust test skips itself without PowerShell; so does this one.
  test("windows_session_and_profile_setup", async () => {
    const pwsh = findPwsh();
    if (pwsh === null) return;
    const root = tempDir("harbor-pss-");
    try {
      const work = join(root, "my work");
      mkdirSync(join(root, ".claude2/projects/-elsewhere"), { recursive: true });
      mkdirSync(work, { recursive: true });
      writeFileSync(join(root, ".claude2/projects/-elsewhere/abc.jsonl"), "{}");
      const script = `Set-Location -LiteralPath ${psQuote(work)}\n${psSetup({ kind: "profile", rel: ".claude2" })}\n${psSetup({ kind: "session", id: "abc" })}\n[Console]::Out.WriteLine($env:CLAUDE_CONFIG_DIR)`;
      const r = await sh(`${shQuote(pwsh)} -NoProfile -NonInteractive -Command ${shQuote(script)}`, null, { HOME: root, CLAUDE_CONFIG_DIR: undefined });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(join(root, ".claude2"));
      const slug = realpathSync(work).replace(/[^A-Za-z0-9]/g, "-");
      expect(statSync(join(root, ".claude2/projects", slug, "abc.jsonl")).isFile()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tailscale_devices_move_to_ssh", () => {
    const text = "Host mac\n  HostName Mac-Air.local\n  User me\nHost box\n  HostName 192.0.2.3\nHost gh\n  HostName github.com\n  User git\n";
    const entries = parseRemoteSshConfig(text, () => null, 0);
    const ts = (id: string, host: string) => newHost({ id, name: "My Mac", host, os: "macOS", bridge: true, icon: "laptop" });
    const paired = [allowed({ fp: "f", id: "ts:home-desk", name: "home-desk" })];
    // A peer with an alias for its machine: a new SSH device with its settings.
    let cfg = newConfig({ devices: [ts("ts:mac-air", "mac-air.example.ts.net"), ts("ts:home-desk", "home-desk.example.ts.net"), ts("ts:nobox", "nobox.example.ts.net")] });
    const moved = migrateDevices(cfg, paired, entries);
    expect(moved).toEqual([["ts:mac-air", "ssh:1"]]);
    const m = cfg.devices.find((d) => d.id === "ssh:1");
    expect([m?.host, m?.name, m?.os, m?.icon]).toEqual(["mac", "My Mac", "macOS", "laptop"]);
    // A paired PC and a peer without an alias stay.
    expect(cfg.devices.some((d) => d.id === "ts:home-desk") && cfg.devices.some((d) => d.id === "ts:nobox")).toBe(true);
    expect(migrateDevices(cfg, paired, entries)).toEqual([]);
    // Already added by hand (the alias): its chats go there, nothing is added.
    cfg = newConfig({ devices: [ts("ts:mac-air", "mac-air.example.ts.net"), newHost({ id: "ssh:4", host: "mac" })] });
    expect(migrateDevices(cfg, paired, entries)).toEqual([["ts:mac-air", "ssh:4"]]);
    expect(cfg.devices.length).toBe(1);
  });

  test("tailscale_peer_of_a_device_shows_once", () => {
    const net = newTailnet({
      peers: [newTailPeer({ id: "ts:work-laptop", name: "work-laptop", dns: "work-laptop.example.ts.net", online: true }), newTailPeer({ id: "ts:other", name: "other" })],
    });
    const cfg = newConfig({ devices: [newHost({ id: "ssh:1", host: "Work-Laptop.local" })] });
    expect(remoteDevices(ctx(), cfg, net).map(([h]) => h.id)).toEqual(["ssh:1", "ts:other"]);
  });

  test("nearby_pcs", () => {
    const avahi =
      "+;wlo1;IPv6;Mac\\226\\128\\153s\\032Air;SSH Remote Terminal;local\n" +
      "=;wlo1;IPv6;Mac\\226\\128\\153s\\032Air;SSH Remote Terminal;local;Mac-Air.local;fe80::1;22;\n" +
      "=;wlo1;IPv4;Mac\\226\\128\\153s\\032Air;SSH Remote Terminal;local;Mac-Air.local;192.0.2.6;22;\n" +
      "=;wlo1;IPv4;Mac\\226\\128\\153s\\032Air;SFTP File Transfer;local;Mac-Air.local;192.0.2.6;22;\n" +
      "=;wlo1;IPv4;nas;SSH Remote Terminal;local;nas.local;192.0.2.9;2222;\n" +
      "=;wlo1;IPv4;me;SSH Remote Terminal;local;thispc.local;192.0.2.2;22;\n";
    const a = parseAvahi(avahi);
    expect(a.length).toBe(3);
    expect(a[0]).toEqual(["Mac\u2019s Air", "Mac-Air.local", "192.0.2.6", 22]);
    const entries = parseRemoteSshConfig("Host mac\n  HostName Mac-Air.local\nHost gh\n  HostName github.com\n  User git\nHost box\n  HostName 192.0.2.4\nHost self\n  HostName 192.0.2.2\nHost lo\n  HostName localhost\n", () => null, 0);
    const n = nearbyFrom(entries, a, ["thispc", "192.0.2.2"]);
    expect(n.map((x) => [x.host, x.source, x.port])).toEqual([
      ["mac", "ssh config · network", 0],
      ["box", "ssh config", 0],
      ["nas.local", "network", 2222],
    ]);
    // Offers that are devices already don't show.
    const devs: [RemoteHost, boolean | null][] = [
      [newHost({ id: "ssh:1", host: "box" }), null],
      [newHost({ id: "pc:nas", host: "192.0.2.50", aka: ["nas"] }), null],
    ];
    const [n0, n1, n2] = n;
    if (!n0 || !n1 || !n2) throw new Error("three offers expected");
    expect(isDevice(ctx(), n1, devs) && isDevice(ctx(), n2, devs) && !isDevice(ctx(), n0, devs)).toBe(true);
  });
});

describe("remote beyond the Rust tests", () => {
  test("settings round trip in the Rust field order, and bad JSON reads as defaults", () => {
    const kv = new MemKv();
    expect(loadRemote(kv)).toEqual(newConfig());
    const cfg = newConfig({ user: "me", port: 2200, devices: [newHost({ id: "ssh:1", name: "Box", host: "box", bridge: true, aka: ["not stored"] })] });
    saveRemote(kv, cfg);
    const text = kv.get("remote_devices") ?? "";
    expect(text.startsWith('{"tailscale":true,"user":"me","key":"","port":2200,"devices":[{"id":"ssh:1","name":"Box","host":"box","user":"","port":0,"icon":"","dir":"","bridge":true,"commands":false,"device_files":false,"hidden":false,"os":""}]}')).toBe(true);
    expect(loadRemote(kv).devices[0]?.aka).toEqual([]);
    // An old setting with a missing field reads with the defaults; a bridge defaults on.
    kv.set("remote_devices", '{"devices":[{"id":"ssh:2","host":"x"}]}');
    const old = loadRemote(kv);
    expect([old.tailscale, old.devices[0]?.bridge, old.devices[0]?.port]).toEqual([true, true, 0]);
    kv.set("remote_devices", '{"devices":[{"host":"x"}]}');
    expect(loadRemote(kv)).toEqual(newConfig());
    kv.set("remote_devices", "not json");
    expect(loadRemote(kv)).toEqual(newConfig());
  });

  test("labels, glyphs, icon paths and the hostname", () => {
    expect(hostLabel(newHost({ id: "pc:desk", host: "10.0.0.2" }))).toBe("desk");
    expect(hostLabel(newHost({ id: "ssh:1", host: "box" }))).toBe("box");
    expect(hostLabel(newHost({ id: "ssh:1", name: "Mine", host: "box" }))).toBe("Mine");
    expect(glyph(newHost({ icon: "bot" }))).toBe(icon("bot"));
    expect(glyph(newHost({ os: "macOS" }))).toBe(icon("laptop"));
    expect(glyph(newHost({ id: "ssh:1" }))).toBe(icon("terminal"));
    expect(iconPath("/data", "ts:my pc")).toBe("/data/devices/ts_my_pc");
    expect(hostname(() => "desk\n")).toBe("desk");
    expect(hostname(() => null)).toBe("this PC");
  });

  test("ssh options: found PCs go through harbor nc, logins and ports fall back to ~/.ssh/config", () => {
    const entries = parseRemoteSshConfig("Host box\n  HostName box.example\n  User boxer\n  Port 2022\n  IdentityFile ~/.ssh/box\n", () => null);
    const c = ctx({ sshConfig: () => entries, selfExe: () => "/opt/h arbor/harbor" });
    const plain = sshOpts(c, newConfig(), newHost({ id: "ssh:1", host: "box" }));
    expect(plain.slice(0, 4)).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]);
    expect(plain.slice(-6)).toEqual(["-p", "2022", "-i", `${HOME}/.ssh/box`, "-l", "boxer"]);
    expect(plain.join(" ")).toContain("-p 2022 -i /home/user/.ssh/box -l boxer");
    expect(plain.join(" ")).not.toContain("ProxyCommand");
    const found = sshOpts(c, newConfig({ user: "root", key: "~/k", port: 22 }), newHost({ id: "pc:desk", host: "box" }));
    expect(found).toContain("ProxyCommand='/opt/h arbor/harbor' nc --device 'pc:desk' %h %p");
    expect(found.join(" ")).toContain("-p 22 -i /home/user/k -o IdentitiesOnly=yes -l root");
    expect(sshPort(c, newConfig(), newHost({ host: "box" }))).toBe(2022);
    expect(sshPort(c, newConfig({ port: 2201 }), newHost({ host: "box", port: 2300 }))).toBe(2300);
    expect(sshLogin(c, newConfig({ user: " me " }), newHost({ host: "box" }))).toEqual(["me", false]);
    expect(sshLogin(c, newConfig(), newHost({ host: "unknown" }))).toBeNull();
  });

  test("paired PCs list the network's address first and carry the mesh's online state", () => {
    const tailnet = [100, 64, 0, 5].join(".");
    const list = [allowed({ fp: "f1", id: "pc:desk", name: "", addrs: [`${tailnet}:47930`, "192.0.2.5:47930"] }), allowed({ id: "pc:nokey" })];
    const peers = new Map([["pc:desk", newPeer({ id: "pc:desk", online: true, addrs: ["192.0.2.5:47931"] })]]);
    const [p, ...rest] = pairedPcs(list, peers);
    expect(rest).toEqual([]);
    expect([p?.id, p?.name, p?.ip, p?.ips, p?.online, p?.os]).toEqual(["pc:desk", "desk", "192.0.2.5", ["192.0.2.5", tailnet], true, "linux"]);
  });

  test("Remotes reads the tailnet, tests devices and adopts the OS through the runner", async () => {
    const asked: string[] = [];
    const runner: Runner = async (program, args) => {
      asked.push(`${program} ${args.join(" ")}`);
      if (program === "tailscale") return { code: 0, stdout: '{"BackendState":"Running","Self":{"DNSName":"me.t.ts.net."},"Peer":{"a":{"HostName":"box","DNSName":"box.t.ts.net.","OS":"linux","Online":true}}}', stderr: "" };
      return { code: 0, stdout: "HARBOR_OK\nDarwin arm64\nclaude 2.0.0\n", stderr: "" };
    };
    let changes = 0;
    const r = new Remotes({
      home: HOME,
      dataDir: "/data",
      runner,
      which: (b) => (b === "tailscale" ? "/bin/tailscale" : null),
      mesh: () => ({ allowed: [allowed({ fp: "f", id: "pc:desk", name: "desk" })], peers: new Map() }),
      readFile: (p) => (p === `${HOME}/.ssh/config` ? "Host mac\n  HostName mac.local\n  User me\n" : null),
      onChange: () => void changes++,
    });
    expect(r.tailnet().peers).toEqual([]);
    for (let i = 0; i < 200 && changes === 0; i++) await new Promise((res) => setTimeout(res, 10));
    const net = r.tailnetCached();
    expect([net.installed, net.state, net.me, net.peers.map((p) => p.id)]).toEqual([true, "Running", "me", ["pc:desk", "ts:box"]]);
    expect(changes).toBe(1);
    const cfg = newConfig({ devices: [newHost({ id: "ssh:1", host: "mac" })] });
    expect(r.devices(cfg, net).map(([h, on]) => [h.id, on])).toEqual([["ssh:1", null], ["pc:desk", false], ["ts:box", true]]);
    const p = await r.test(cfg, cfg.devices[0] ?? newHost());
    expect([p.ok, p.os]).toEqual([true, "macOS"]);
    expect(asked.at(-1)).toContain("-l me");
    expect(r.devices(cfg, net)[0]?.[1]).toBe(true);
    expect(r.adoptOs(cfg)).toBe(true);
    expect(cfg.devices[0]?.os).toBe("macOS");
    expect(r.adoptOs(cfg)).toBe(false);
    const n = asked.length;
    await r.testOnce(cfg, cfg.devices[0] ?? newHost());
    expect(asked.length).toBe(n);
  });

  test("a device that does not answer as POSIX is asked as Windows, and a refused ssh is not", async () => {
    const calls: string[] = [];
    const winRunner: Runner = async (_p, args) => {
      const last = args.at(-1) ?? "";
      calls.push(last.startsWith("powershell") ? "windows" : "posix");
      return last.startsWith("powershell") ? { code: 0, stdout: "HARBOR_OK\r\nWindows AMD64\r\nclaude 2.1.0\r\n", stderr: "" } : { code: 1, stdout: "", stderr: "x\n" };
    };
    const p = await runProbe(winRunner, ctx(), newConfig(), newHost({ id: "ssh:1", host: "w" }));
    expect([p.ok, p.os, calls]).toEqual([true, "windows", ["posix", "windows"]]);
    calls.length = 0;
    const refused: Runner = async () => {
      calls.push("ssh");
      return { code: 255, stdout: "", stderr: "ssh: connect to host w port 22: Connection refused\n" };
    };
    const q = await runProbe(refused, ctx(), newConfig(), newHost({ id: "ssh:1", host: "w" }));
    expect([q.ok, q.text, calls]).toEqual([false, "ssh: connect to host w port 22: Connection refused", ["ssh"]]);
    const missing: Runner = async () => {
      throw new Error("No such file or directory");
    };
    expect((await runProbe(missing, ctx(), newConfig(), newHost({ host: "w" }))).text).toBe("ssh: No such file or directory");
  });

  test("profile setup is the folder under home", () => {
    expect(profileSetup(HOME, `${HOME}/.claude2`)).toEqual([{ kind: "profile", rel: ".claude2" }]);
    expect(profileSetup(HOME, `${HOME}/.claude/`)).toEqual([{ kind: "profile", rel: ".claude" }]);
    expect(profileSetup(HOME, "/elsewhere/.claude")).toEqual([]);
    expect(profileSetup(HOME, HOME)).toEqual([]);
    expect(profileSetup(HOME, null)).toEqual([]);
  });

  test("remote_command hands every argument and the folder to the shell intact", async () => {
    const dir = tempDir("harbor-dir-");
    try {
      const folder = join(dir, "my work");
      mkdirSync(folder);
      const script = remoteCommand(folder, [], ["sh", "-c", 'printf "%s|%s" "$1" "$(pwd)"', "sh", "a'b \"c\" $HOME"]);
      const out = await sh(script, null);
      const [arg, pwd] = agentOut(out.stdout, 0).split("|");
      expect(arg).toBe(`a'b "c" $HOME`);
      // Real paths: macOS's temp folder is /var/..., a link to /private/var/....
      expect(realpathSync(pwd ?? "")).toBe(realpathSync(folder));
      const missing = await sh(remoteCommand(join(dir, "nope"), [], ["true"]), null);
      expect(missing.code).toBe(97);
      expect(missing.stderr).toContain("doesn't exist on");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(shQuote("a'b")).toBe("'a'\\''b'");
  });
});

interface RemoteCommandLike {
  program: string;
  args: string[];
}

/** Windows' rule for one argument on a command line (what `HarborQ` in the script does): quotes when it's empty or has blanks or quotes; backslashes doubled only before a quote. */
function winArg(a: string): string {
  if (a !== "" && !/[\s"]/.test(a)) return a;
  let out = '"';
  let slashes = 0;
  for (const c of a) {
    if (c === "\\") slashes++;
    else if (c === '"') {
      out += `${"\\".repeat(slashes * 2 + 1)}"`;
      slashes = 0;
    } else {
      out += "\\".repeat(slashes) + c;
      slashes = 0;
    }
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

function findPwsh(): string | null {
  const given = process.env.HARBOR_TEST_PWSH;
  if (given && existsSync(given)) return given;
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = join(d, "pwsh");
    if (d !== "" && existsSync(p)) return p;
  }
  return null;
}

function icon(name: string): string {
  const g = ICONS.find(([n]) => n === name)?.[1];
  if (g === undefined) throw new Error(`no icon ${name}`);
  return g;
}
