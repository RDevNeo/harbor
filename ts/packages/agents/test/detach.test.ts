import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as detach from "../src/detach.ts";
import { compact } from "../src/json.ts";
import { procStart } from "../src/procfs.ts";
import { reap } from "./reap.ts";

const base = mkdtempSync(join(tmpdir(), "hts-detach-"));
const saved = { ...detach.timing };
beforeAll(() => Object.assign(detach.timing, { retryForMs: 2000, retryFirstMs: 100, lingerMs: 1000 }));
afterAll(() => {
  reap(base);
  Object.assign(detach.timing, saved);
  rmSync(base, { recursive: true, force: true });
});

let n = 0;
const fresh = (name: string): string => {
  const d = join(base, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/** Runs `f` with these env vars set (undefined: unset), then puts them back. */
function withEnv(vars: Record<string, string | undefined>, f: () => void): void {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (v: Record<string, string | undefined>): void => {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
    }
  };
  set(vars);
  try {
    f();
  } finally {
    set(before);
  }
}

const ROOT = "/home/u/.local/state/harbor/turns";

test("finds_the_chat_of_a_runner", () => {
  expect(detach.runnerChat(["/x/harbor", "turn", `${ROOT}/23-1792605157067846264`], ROOT)).toBe(23);
  // Its folder may be gone: the command line still names it.
  expect(detach.runnerChat(["/x/harbor (deleted)", "turn", `${ROOT}/7-1`], ROOT)).toBe(7);
  // A runner started from source.
  expect(detach.runnerChat(["/x/bun", "/src/ts/harbor.ts", "turn", `${ROOT}/9-1`], ROOT)).toBe(9);
});

test("ignores_other_processes_and_other_harbors", () => {
  expect(detach.runnerChat(["/x/harbor", "mcp", "--chat", "23"], ROOT)).toBeUndefined();
  expect(detach.runnerChat(["/x/harbor"], ROOT)).toBeUndefined();
  // A test instance's turns live in another folder.
  expect(detach.runnerChat(["/x/harbor", "turn", "/home/u/.local/state/harbor/turns-0a1b2c3d4e5f/23-1"], ROOT)).toBeUndefined();
  expect(detach.runnerChat(["/x/harbor", "turn", "/elsewhere/23-1"], ROOT)).toBeUndefined();
  expect(detach.runnerChat(["/x/bun", "/x/other.ts", "turn", `${ROOT}/9-1`], ROOT)).toBeUndefined();
});

/** ssh once the agent there exited (code `code`), with a forwarded connection still open. */
function lingeringSsh(dir: string, code: number) {
  const out = openSync(join(dir, "out"), "a");
  const script = `printf '%s\\n' '{"type":"result","subtype":"success"}' '' '{"type":"${detach.REMOTE_EXIT}","code":${code}}'; exec sleep 300`;
  return Bun.spawn(["sh", "-c", script], { stdout: out, stderr: "ignore", stdin: "ignore" });
}

test("a_remote_turn_ends_when_ssh_lingers_after_its_agent", async () => {
  const dir = fresh("linger");
  writeFileSync(join(dir, "err"), "");
  const child = lingeringSsh(dir, 0);
  const t = Date.now();
  expect(await detach.waitRemote(child, dir)).toBe(0);
  const took = Date.now() - t;
  expect(took).toBeGreaterThanOrEqual(detach.timing.lingerMs);
  expect(took).toBeLessThan(detach.timing.lingerMs + 3000);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(readFileSync(join(dir, "err"), "utf8")).toContain("ssh still held");
  // The agent's own code, not the signal's.
  rmSync(join(dir, "out"));
  expect(await detach.waitRemote(lingeringSsh(dir, 2), dir)).toBe(2);
  // An ssh that ends by itself keeps its code, the agent's end said or not.
  const quick = Bun.spawn(["sh", "-c", "exit 3"], { stdout: "ignore" });
  expect(await detach.waitRemote(quick, dir)).toBe(3);
});

test("a_lingering_ssh_turn_ends_as_a_success", async () => {
  const root = fresh("linger-run");
  const dir = join(root, "7-1");
  mkdirSync(dir);
  const ssh = join(root, "ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh\nprintf '%s\\n' '{"type":"result","subtype":"success","duration_ms":5,"num_turns":1}' '' '{"type":"${detach.REMOTE_EXIT}","code":0}'\nexec sleep 300\n`,
  );
  chmodSync(ssh, 0o755);
  writeFileSync(join(dir, "cmd.json"), compact({ program: ssh, args: ["-R", "127.0.0.1:1:127.0.0.1:1", "device", "cmd"], input: false }));
  const t = Date.now();
  await detach.run([dir]);
  const took = Date.now() - t;
  expect(took).toBeGreaterThanOrEqual(detach.timing.lingerMs);
  expect(took).toBeLessThan(detach.timing.lingerMs + 3000);
  expect(readFileSync(join(dir, "exit"), "utf8")).toBe("0");
  // Harbor reads it as a turn that ended well: its result, no stop.
  const meta: detach.Meta = { chat_id: 7, kind: "Claude", started: 1, base: 0, pid: 0xffffffff, pid_start: 0 };
  const lines: string[] = [];
  expect(await detach.follow(dir, meta, (l) => lines.push(l), () => {})).toBe(true);
  expect(existsSync(join(dir, "stopped"))).toBe(false);
  expect(lines.some((l) => l.includes('"result"'))).toBe(true);
});

test("ssh_lines_that_mean_the_device_is_out_of_reach", () => {
  const r = (l: string): string | undefined => {
    const x = detach.unreachable(l);
    return x ? `${x[0]}|${x[1]}` : undefined;
  };
  expect(r("ssh: connect to host mac.local port 22: No route to host")).toBe("mac.local|No route to host");
  expect(r("ssh: connect to host 10.0.0.5 port 2222: Connection timed out\r")).toBe("10.0.0.5|Connection timed out");
  expect(r("ssh: connect to host box port 22: Connection refused")).toBe("box|Connection refused");
  expect(r("ssh: connect to host box port 22: Network is unreachable")).toBe("box|Network is unreachable");
  expect(r("ssh: Could not resolve hostname mac.local: Name or service not known")).toBe("mac.local|Name or service not known");
  expect(r("ssh: Could not resolve hostname mac.local: Temporary failure in name resolution")).toBe("mac.local|Temporary failure in name resolution");
  // Got there: a login or anything later is no reason to try again.
  for (const l of ["user@box: Permission denied (publickey).", "Host key verification failed.", "ssh: connect to host box port 22: Permission denied", "Connection to box closed by remote host.", "error: something"])
    expect(r(l)).toBeUndefined();
  expect(detach.unreachableText("Studio-Mac", "studio-mac.local", "No route to host", 4, 31_000)).toBe(
    "Couldn't reach Studio-Mac (studio-mac.local): no route to host (tried 4 times over 31 s). Is it on and on the same network?",
  );
  expect(detach.unreachableText("box", "box", "Connection refused", 1, 0)).toBe("Couldn't reach box: it refused the connection. Is its SSH server (Remote Login on a Mac) on?");
});

/** A fake ssh (named so) that answers on try `ok` (0: never), saying `fail` until then; it records its tries and its first line of input. */
function flakySsh(root: string, ok: number, fail: string): [string, string] {
  const dir = join(root, "7-1");
  mkdirSync(dir, { recursive: true });
  const ssh = join(root, "ssh");
  const t = join(root, "tries");
  writeFileSync(
    ssh,
    `#!/bin/sh\necho x >> '${t}'\nn=$(wc -l < '${t}' | tr -d ' ')\nif [ "$n" != ${ok} ]; then echo '${fail}' >&2; exit 255; fi\nread -r first\necho "$first" > '${t}.in'\necho 'Warning: Permanently added box' >&2\nprintf '%s\\n' '{"type":"result","subtype":"success","duration_ms":5,"num_turns":1}'\nexit 0\n`,
  );
  chmodSync(ssh, 0o755);
  writeFileSync(join(dir, "cmd.json"), compact({ program: ssh, args: ["box", "cmd"], input: true, env: [[detach.DEVICE, "Studio-Mac"]] }));
  writeFileSync(join(dir, "in"), "token\nhi\n");
  writeFileSync(join(dir, "in.closed"), "");
  return [dir, t];
}

const tries = (t: string): number => {
  try {
    return readFileSync(t, "utf8").split("\n").filter((l) => l !== "").length;
  } catch {
    return 0;
  }
};

test("a_device_out_of_reach_is_tried_again", async () => {
  // Fails twice (its address changed), then answers: the turn runs, with its whole input, and
  // the chat never sees ssh's failures.
  let [dir, t] = flakySsh(fresh("reach"), 3, "ssh: connect to host mac.local port 22: No route to host");
  await detach.run([dir]);
  expect(readFileSync(join(dir, "exit"), "utf8")).toBe("0");
  expect(tries(t)).toBe(3);
  expect(readFileSync(`${t}.in`, "utf8")).toBe("token\n");
  expect(readFileSync(join(dir, "err"), "utf8")).toBe("Warning: Permanently added box\n");
  expect(readFileSync(join(dir, "out"), "utf8")).toContain('"result"');
  // Never answers: one plain error, after the retry time.
  [dir, t] = flakySsh(fresh("reach"), 0, "ssh: connect to host mac.local port 22: Connection timed out");
  const at = Date.now();
  await detach.run([dir]);
  expect(Date.now() - at).toBeLessThan(detach.timing.retryForMs + 1000);
  expect(readFileSync(join(dir, "exit"), "utf8")).toBe("255");
  const err = readFileSync(join(dir, "err"), "utf8");
  expect(err.startsWith("Couldn't reach Studio-Mac (mac.local): it didn't answer (tried ")).toBe(true);
  expect(err.trimEnd().split("\n").length).toBe(1);
  expect(tries(t)).toBeGreaterThanOrEqual(3);
  // A refused login isn't tried again, and its line is the error.
  [dir, t] = flakySsh(fresh("reach"), 0, "user@box: Permission denied (publickey).");
  await detach.run([dir]);
  expect(tries(t)).toBe(1);
  expect(readFileSync(join(dir, "err"), "utf8")).toBe("user@box: Permission denied (publickey).\n");
}, 15_000);

test("a_guest_turns_commands_run_as_its_account", async () => {
  const root = fresh("guest-run");
  const acct = join(root, "acct");
  const overlay = join(root, "guests/pc-b");
  for (const d of [join(root, "9-1"), acct, overlay]) mkdirSync(d, { recursive: true });
  const expires = Date.now() + 3_600_000;
  const login = compact({ claudeAiOauth: { accessToken: "sk-ant-oat01-guest", refreshToken: "sk-ant-ort01-guest", expiresAt: expires, scopes: ["user:inference"] } });
  writeFileSync(join(acct, ".credentials.json"), login);
  // The agent, and a command it runs: Claude Code keeps the token from that one, which has only the overlay to sign in from.
  const agent =
    'printf \'token=%s login=%s\\n\' "$CLAUDE_CODE_OAUTH_TOKEN" "${HARBOR_GUEST_LOGIN-none}"; env -u CLAUDE_CODE_OAUTH_TOKEN sh -c \'cat "$CLAUDE_CONFIG_DIR/.credentials.json"; { stat -c " mode=%a" "$CLAUDE_CONFIG_DIR/.credentials.json" 2>/dev/null || stat -f " mode=%Lp" "$CLAUDE_CONFIG_DIR/.credentials.json"; }\'';
  const turn = async (dir: string): Promise<string> => {
    const env = [["CLAUDE_CONFIG_DIR", overlay], [detach.GUEST_LOGIN, acct], ["CLAUDE_CODE_OAUTH_TOKEN", null]];
    writeFileSync(join(dir, "cmd.json"), compact({ program: "sh", args: ["-c", agent], env, input: false }));
    await detach.run([dir]);
    try {
      return readFileSync(join(dir, "out"), "utf8");
    } catch {
      return "";
    }
  };
  let out = await turn(join(root, "9-1"));
  expect(out.startsWith("token=sk-ant-oat01-guest login=none\n")).toBe(true);
  const flat = out.replace(/\s/g, "");
  expect(flat).toContain('"accessToken":"sk-ant-oat01-guest"');
  expect(out).toContain(" mode=600");
  // The refresh token stays with the account.
  expect(out).not.toContain("sk-ant-ort01");
  expect(readFileSync(join(root, "9-1/cmd.json"), "utf8")).not.toContain("sk-ant-oat01");
  // Taken out when the turn ends.
  expect(existsSync(join(overlay, ".credentials.json"))).toBe(false);
  // An account not signed in here: a login left in the overlay doesn't stand in for it.
  rmSync(join(acct, ".credentials.json"));
  writeFileSync(join(overlay, ".credentials.json"), login);
  mkdirSync(join(root, "9-2"));
  out = await turn(join(root, "9-2"));
  expect(out.startsWith("token= login=none\n")).toBe(true);
  expect(out).not.toContain("sk-ant-");
});

test("a_stopped_guest_turn_gives_its_login_back", () => {
  const root = fresh("guest-stop");
  const creds = join(root, ".credentials.json");
  const turn = (env: unknown): void => writeFileSync(join(root, "cmd.json"), compact({ program: "sh", env }));
  writeFileSync(creds, "{}");
  // Any other turn: the config dir is its account's own profile, with its own login.
  turn([["CLAUDE_CONFIG_DIR", root]]);
  detach.takeBack(root, 0xffffffff);
  expect(existsSync(creds)).toBe(true);
  turn([["CLAUDE_CONFIG_DIR", root], [detach.GUEST_LOGIN, ""]]);
  detach.takeBack(root, 0xffffffff);
  expect(existsSync(creds)).toBe(false);
});

test("picks_up_a_chats_live_turn_before_an_older_stopped_one", async () => {
  const sleeper = Bun.spawn(["sleep", "30"]);
  const pid = sleeper.pid;
  const meta = (p: number): detach.Meta => ({ chat_id: 5, kind: "Claude", started: 1, base: 0, pid: p, pid_start: procStart(p) ?? 0 });
  // The stopped turn's runner is gone; the next turn's runs.
  const left: [string, detach.Meta][] = [
    ["/x/5-100", meta(0xffffffff)],
    ["/x/5-200", meta(pid)],
    ["/x/6-50", meta(0xffffffff)],
  ];
  detach.followOrder(left);
  expect(left[0]?.[0]).toBe("/x/5-200");
  sleeper.kill();
  await sleeper.exited;
  // None live: the newest first.
  detach.followOrder(left);
  expect(left.map((l) => l[0])).toEqual(["/x/5-200", "/x/5-100", "/x/6-50"]);
});

test("sees_a_live_runner_by_its_process", async () => {
  // `python3 turn <dir>` (a script named "turn") has a runner's command line.
  const tmp = fresh("runner");
  writeFileSync(join(tmp, "turn"), "import time\ntime.sleep(10)\n");
  const root = fresh("runner-root");
  const dir = join(root, "424242-1");
  const p = Bun.spawn(["python3", "turn", dir], { cwd: tmp });
  await Bun.sleep(200);
  const found = detach.runners(root).find((r) => r[0] === 424242);
  p.kill();
  await p.exited;
  expect(found ? [found[1], found[2]] : undefined).toEqual([dir, p.pid]);
  expect(detach.runners(root).some((r) => r[0] === 424242)).toBe(false);
});

describe("the turn folder is the Rust app's", () => {
  test("cmd.json has serde's sorted keys and env as Rust's Command keeps it", () => {
    const c = detach.command("claude");
    c.args.push("-p", "x");
    c.cwd = "/w";
    c.env.set("PATH", "/bin");
    c.env.set("CLAUDE_CONFIG_DIR", null);
    c.env.set("PATH", "/usr/bin");
    expect(detach.cmdJson(c, true, true)).toBe(
      '{"agent_env":true,"args":["-p","x"],"cwd":"/w","env":[["CLAUDE_CONFIG_DIR",null],["PATH","/usr/bin"]],"input":true,"program":"claude"}',
    );
    expect(detach.cmdJson(detach.command("sh"), false, false)).toBe('{"agent_env":false,"args":[],"cwd":null,"env":[],"input":false,"program":"sh"}');
  });

  test("meta.json in the struct's field order, read back only whole", () => {
    const m: detach.Meta = { chat_id: 12, kind: "Codex", started: 1792605157, base: 4, pid: 4242, pid_start: 987654 };
    const text = detach.metaJson(m);
    expect(text).toBe('{"chat_id":12,"kind":"Codex","started":1792605157,"base":4,"pid":4242,"pid_start":987654}');
    expect(detach.readMeta(text)).toEqual(m);
    // serde rejects a missing field or a wrong type: such a folder is no turn.
    expect(detach.readMeta('{"chat_id":12,"kind":"Codex","started":1,"base":4,"pid":1}')).toBeUndefined();
    expect(detach.readMeta('{"chat_id":12,"kind":"Codex","started":1,"base":-1,"pid":1,"pid_start":0}')).toBeUndefined();
    // Unknown fields are ignored, like serde's default.
    expect(detach.readMeta('{"chat_id":1,"kind":"Claude","started":1,"base":0,"pid":1,"pid_start":0,"extra":true}')?.chat_id).toBe(1);
  });

  test("a test instance's turns folder is named by FNV-1a of its data folder", () => {
    expect(detach.fnv1a("a")).toBe(0xaf63dc4c8601ec8cn);
    expect(detach.fnv1a("")).toBe(0xcbf29ce484222325n);
    withEnv({ HOME: "/home/u", XDG_STATE_HOME: join(base, "st"), XDG_DATA_HOME: undefined }, () => expect(detach.root()).toBe(join(base, "st/harbor/turns")));
    const h = (detach.fnv1a("/tmp/x/harbor") & 0xffffffffffffn).toString(16).padStart(12, "0");
    withEnv({ HOME: "/home/u", XDG_STATE_HOME: join(base, "st"), XDG_DATA_HOME: "/tmp/x" }, () => expect(detach.root()).toBe(join(base, `st/harbor/turns-${h}`)));
  });
});

describe("harbor turn", () => {
  test("spawns detached and is followed to its end, input written mid-turn", async () => {
    const root = fresh("spawn");
    const c = detach.command("sh");
    c.args.push("-c", 'read a; echo "1:$a"; read b; echo "2:$b"; echo warn >&2; exit 0');
    const [dir, meta] = await detach.spawn(c, "first\n", true, false, { chat_id: 3, kind: "Claude", started: 1, base: 0, pid: 0, pid_start: 0 }, root);
    expect(meta.pid).toBeGreaterThan(0);
    expect(meta.pid_start).toBe(procStart(meta.pid) ?? -1);
    expect(detach.readMeta(readFileSync(join(dir, "meta.json"), "utf8"))).toEqual(meta);
    expect(statSync(join(dir, "cmd.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "in")).mode & 0o777).toBe(0o600);
    expect(detach.inputOpen(dir)).toBe(true);
    expect(detach.runners(root).map((r) => r[0])).toEqual([3]);
    const out: string[] = [];
    const err: string[] = [];
    const done = detach.follow(dir, meta, (l) => out.push(l), (l) => err.push(l));
    expect(detach.writeInput(dir, "second\n")).toBe(true);
    detach.closeInput(dir);
    expect(detach.writeInput(dir, "late\n")).toBe(false);
    expect(await done).toBe(true);
    expect(out).toEqual(["1:first", "2:second"]);
    expect(err).toEqual(["warn"]);
    expect(statSync(join(dir, "out")).mode & 0o777).toBe(0o600);
    expect(detach.leftovers(root).map((l) => l[0])).toEqual([dir]);
  });

  test("a program that can't start ends the turn with 127 and says why", async () => {
    const dir = fresh("nostart");
    writeFileSync(join(dir, "cmd.json"), compact({ program: "/nonexistent/agent", args: [], input: false }));
    await detach.run([dir]);
    expect(readFileSync(join(dir, "exit"), "utf8")).toBe("127");
    expect(readFileSync(join(dir, "err"), "utf8")).toBe("/nonexistent/agent: No such file or directory (os error 2)\n");
  });

  // Linux only: a process's open files are readable through /proc after they're deleted; elsewhere the output is gone.
  test.if(process.platform === "linux")("a deleted folder's output is still read through the runner's open files", async () => {
    const root = fresh("gone");
    const c = detach.command("sh");
    c.args.push("-c", "echo before; sleep 0.6; echo after");
    const [dir, meta] = await detach.spawn(c, null, false, false, { chat_id: 4, kind: "Claude", started: 1, base: 0, pid: 0, pid_start: 0 }, root);
    await Bun.sleep(150);
    rmSync(dir, { recursive: true, force: true });
    const out: string[] = [];
    await detach.follow(dir, meta, (l) => out.push(l), () => {});
    expect(out).toEqual(["before", "after"]);
  });

  test("leftovers sweep old folders without a turn and keep the rest", () => {
    const root = fresh("sweep");
    mkdirSync(join(root, "1-1"));
    mkdirSync(join(root, "2-2"));
    writeFileSync(join(root, "2-2/meta.json"), detach.metaJson({ chat_id: 2, kind: "Claude", started: 9, base: 0, pid: 1, pid_start: 0 }));
    mkdirSync(join(root, "3-3"));
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    utimesSync(join(root, "1-1"), old, old);
    expect(detach.leftovers(root).map((l) => l[0])).toEqual([join(root, "2-2")]);
    expect(existsSync(join(root, "1-1"))).toBe(false);
    expect(existsSync(join(root, "3-3"))).toBe(true);
  });

  test("recover rebuilds a lost folder from the live runner", async () => {
    const root = fresh("recover");
    const p = Bun.spawn(["sh", "-c", "sleep 5"]);
    await Bun.sleep(50);
    const dir = join(root, "8-1");
    const started = Math.floor(Date.now() / 1000);
    const m = detach.recover(dir, p.pid, 8, [started - 100, null, started - 10, null, started + 1000]);
    p.kill();
    expect(m.kind).toBe("Claude");
    expect(m.base).toBe(3);
    expect(Math.abs(m.started - started)).toBeLessThanOrEqual(2);
    expect(existsSync(join(dir, "in.closed"))).toBe(true);
    expect(detach.readMeta(readFileSync(join(dir, "meta.json"), "utf8"))).toEqual(m);
  });
});

test("the signed-out agent env hides every sign-in", () => {
  withEnv({ XDG_DATA_HOME: join(base, "data") }, () => {
    const v = new Map(detach.signedOutEnv());
    expect(v.get("GH_TOKEN")).toBeNull();
    expect(v.get("GIT_TERMINAL_PROMPT")).toBe("0");
    expect(v.get("GIT_CONFIG_COUNT")).toBe("6");
    expect(v.get("GIT_CONFIG_VALUE_3")).toContain("GitHub is not signed in");
    expect(v.get("CONVEX_OVERRIDE_ACCESS_TOKEN")).toBe("sign-in-to-convex-in-harbor");
    const gh = v.get("GH_CONFIG_DIR") ?? "";
    expect(gh).toBe(join(base, "data/harbor/apps/github-signed-out"));
    expect(readFileSync(join(gh, "hosts.yml"), "utf8")).toContain("sign-in-to-github-in-harbor");
  });
});
