import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sec from "../src/secrets.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hsec-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const key = (): [string, string][] => [["BOAT_API_KEY", "boat_s3cr3t/V4lue+x"]];
const b64 = (s: string): string => sec.base64(new TextEncoder().encode(s));

test("scrubs the value and its encodings", () => {
  const s = key();
  const v = s[0]?.[1] ?? "";
  const basic = b64(`user:${v}`);
  const hex = [...Buffer.from(v)].map((c) => c.toString(16).padStart(2, "0")).join("");
  const text = [
    `plain ${v}`,
    "url boat_s3cr3t%2FV4lue%2Bx",
    "lower boat_s3cr3t%2fV4lue%2bx",
    `b64 ${b64(v)}`,
    `basic ${basic}`,
    `urlsafe ${b64(v).replaceAll("+", "-").replaceAll("/", "_")}`,
    `hex ${hex}`,
    "",
  ].join("\n");
  const out = sec.scrub(text, s);
  expect(out).not.toContain("s3cr3t");
  expect(out).not.toContain(hex);
  for (const line of out.split("\n").filter(Boolean)) expect(line).toContain("[hidden: BOAT_API_KEY]");
  // Basic auth: "user:" stays readable around the hidden part, a few chars at most.
  const b = out.split("\n").find((l) => l.startsWith("basic")) ?? "";
  expect(b.length).toBeLessThan("basic ".length + "[hidden: BOAT_API_KEY]".length + 8);
});

test("base64 cores are found at any offset", () => {
  const v = new TextEncoder().encode("abcdefgh12345");
  for (const pre of ["", "x", "xy", "xyz:"]) {
    const data = new TextEncoder().encode(`${pre}abcdefgh12345!tail`);
    const enc = sec.base64(data);
    expect([0, 1, 2].some((k) => enc.includes(sec.b64Core(v, k)))).toBe(true);
  }
});

test("scrubs json escaped values", () => {
  const s: [string, string][] = [["PW", 'pa"ss\\word']];
  expect(sec.scrub(JSON.stringify({ pw: s[0]?.[1] }), s)).toBe('{"pw":"[hidden: PW]"}');
});

test("leaves other text alone", () => {
  expect(sec.scrub("nothing to see here\n", key())).toBe("nothing to see here\n");
  expect(sec.scrub("a", [])).toBe("a");
});

test("a cut value loses its start too", () => {
  expect(sec.dropPartial("token: boat_s3cr", key())).toBe("token: [hidden]");
  expect(sec.dropPartial("done", key())).toBe("done");
});

test("spots pasted keys", () => {
  expect(sec.pastedKey("use BOAT_API_KEY=boat_9f8e7d6c5b4a3f2e1d0c please")).toEqual(["boat_9f8e7d6c5b4a3f2e1d0c", "BOAT_API_KEY"]);
  expect(sec.pastedKey("token: `ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7`")?.[1]).toBe("GITHUB_TOKEN");
  expect(sec.pastedKey("sk-ant-api03-abcDEF123456789xyz")?.[1]).toBe("ANTHROPIC_API_KEY");
  expect(sec.pastedKey("rename boat_api_key_handler_function")).toBeNull();
  expect(sec.pastedKey("sk-short1")).toBeNull();
});

test("names are env variables", () => {
  expect(sec.envName("boat-api-key")).toBe("BOAT_API_KEY");
  expect(sec.envName(" OPENAI_API_KEY ")).toBe("OPENAI_API_KEY");
  expect(sec.envName("1KEY")).toBeNull();
  expect(sec.envName("A=B")).toBeNull();
  expect(sec.envName("")).toBeNull();
});

test("stores values owner only", () => {
  const p = join(tmp(), "secrets.json");
  expect(sec.save("boat_api_key", "  boat_123456  ", "Boat CLI", p)).toBe("BOAT_API_KEY");
  sec.save("BOAT_API_KEY", "boat_654321", "", p);
  expect(() => sec.save("X", "abc", "", p)).toThrow();
  const all = sec.load(p);
  expect(all.length).toBe(1);
  expect([all[0]?.value, all[0]?.description]).toEqual(["boat_654321", "Boat CLI"]);
  expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(sec.names(p)[0]?.value).toBe("");
  sec.remove("BOAT_API_KEY", p);
  expect(sec.load(p)).toEqual([]);
});

test("runs with the secret and hides it", async () => {
  const s = key();
  const cwd = tmpdir();
  const out = await sec.run('echo "$BOAT_API_KEY"; printf %s "$BOAT_API_KEY" | base64 >&2; exit 3', cwd, s, 20_000);
  expect(out.startsWith("exit code 3")).toBe(true);
  expect(out).not.toContain("s3cr3t");
  expect(out.split("[hidden: BOAT_API_KEY]").length - 1).toBe(2);
  const slow = await sec.run("printf 'boat_s3c'; sleep 30", cwd, s, 500).catch((e: Error) => e.message);
  expect(slow.startsWith("timed out")).toBe(true);
  expect(slow).not.toContain("boat_s3c");
});

test("grants expire and cover only their chat", () => {
  const g: sec.Grant[] = [];
  const names = ["A", "B"];
  sec.grant(g, 1, names, sec.minutesSpan(15), 1000);
  expect(sec.ungranted(g, 1, names, 1000)).toEqual([]);
  expect(sec.ungranted(g, 2, names, 1000)).toEqual(names);
  expect(sec.ungranted(g, 1, ["C"], 1000)).toEqual(["C"]);
  expect(sec.expire(g, 1000 + 15 * 60 - 1)).toEqual([]);
  expect(sec.ungranted(g, 1, names, 1000 + 15 * 60)).toEqual(names);
  expect(sec.expire(g, 1000 + 15 * 60).length).toBe(2);
  expect(g).toEqual([]);
  sec.grant(g, 1, names, { kind: "not" }, 1000);
  expect(g).toEqual([]);
});

test("durations only get shorter", () => {
  expect(sec.spans(15)).toEqual([sec.minutesSpan(15), sec.minutesSpan(5)]);
  expect(sec.spans(120)).toEqual([sec.minutesSpan(120), sec.minutesSpan(5), sec.minutesSpan(60)]);
  expect(sec.spans(3)).toEqual([sec.minutesSpan(3)]);
  expect(sec.askedMinutes(100000)).toBe(sec.MAX_MINUTES);
  expect(sec.askedMinutes(null)).toBe(sec.DEFAULT_MINUTES);
  expect(sec.minutesLabel(90)).toBe("1 h 30 min");
  expect(sec.spanLabel(sec.minutesSpan(15), 15)).toBe("15 min (as asked)");
  expect(sec.spanLabel({ kind: "not" }, 0)).toBe("Save only, no access");
});

test("env lines quote what needs it", () => {
  expect(sec.envLine("K", "sk_live_123-abc")).toBe("K=sk_live_123-abc");
  expect(sec.envLine("K", 'a b#c$d"e')).toBe(`K='a b#c$d"e'`);
  expect(sec.envLine("K", "it's\nx\\")).toBe('K="it\'s\\nx\\\\"');
});

test("env files get the line replaced", () => {
  const old = "# keys\nexport STRIPE_KEY=old\nOTHER=1\nSTRIPE_KEY = older\n";
  expect(sec.setEnvVar(old, "STRIPE_KEY", "sk_new")).toBe("# keys\nexport STRIPE_KEY=sk_new\nOTHER=1\n");
  expect(sec.setEnvVar("A=1", "B", "2")).toBe("A=1\nB=2\n");
  expect(sec.setEnvVar("", "B", "2")).toBe("B=2\n");
  expect(sec.setEnvVar("STRIPE_KEY_2=x\n", "STRIPE_KEY", "y")).toBe("STRIPE_KEY_2=x\nSTRIPE_KEY=y\n");
});

test("env files stay in the project", () => {
  const base = tmp();
  const root = join(base, "proj");
  mkdirSync(join(root, "apps/web"), { recursive: true });
  mkdirSync(join(base, "outside"));
  symlinkSync(join(base, "outside"), join(root, "out"));
  symlinkSync(join(base, "outside/.env"), join(root, ".env.prod"));
  expect(() => sec.envPath(root, ".env.local")).not.toThrow();
  expect(() => sec.envPath(root, "apps/web/.env.development")).not.toThrow();
  expect(() => sec.envPath(root, join(root, ".env"))).not.toThrow();
  for (const bad of ["../.env", "out/.env", ".env.prod", "config.env", ".envrc", "src/.env.x/../.env", "/etc/.env", "nope/.env"]) {
    expect(() => sec.envPath(root, bad), bad).toThrow();
  }
  const p = sec.envPath(root, ".env.local");
  sec.writeEnv(p, "STRIPE_KEY", "sk_test_1");
  sec.writeEnv(p, "STRIPE_KEY", "sk test 2");
  expect(readFileSync(p, "utf8")).toBe("STRIPE_KEY='sk test 2'\n");
  expect(statSync(p).mode & 0o777).toBe(0o600);
});

test("checks and fixes gitignore", () => {
  const root = realpathSync(tmp());
  const file = join(root, ".env.local");
  expect(sec.gitIgnored(root, file)).toBeNull();
  expect(spawnSync("git", ["-C", root, "init", "-q"]).status).toBe(0);
  expect(sec.gitIgnored(root, file)).toBe(false);
  sec.addToGitignore(root, file);
  expect(sec.gitIgnored(root, file)).toBe(true);
  expect(sec.gitIgnored(root, join(root, ".env"))).toBe(false);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("/.env.local\n");
  expect(existsSync(root)).toBe(true);
});
