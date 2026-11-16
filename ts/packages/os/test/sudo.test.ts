import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleString, fileName, interpret, osascriptArgs, ROOT_SCRIPT, rootCommand, ruleLine, SAFE_USER, scriptArgs, sudoersDir } from "../src/sudo.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the rule: the user's own file in sudoers.d, a name sudo doesn't skip, a user name sudoers takes as is", () => {
  expect(sudoersDir("linux")).toBe("/etc/sudoers.d");
  expect(sudoersDir("darwin")).toBe("/private/etc/sudoers.d");
  expect(fileName("igor")).toBe("harbor-igor");
  // sudo skips files whose names hold a dot.
  expect(fileName("john.doe")).toBe("harbor-john_doe");
  expect(ruleLine("igor")).toBe("igor ALL=(ALL) NOPASSWD: ALL");
  for (const ok of ["igor", "john.doe", "a-b_c", "_svc"]) expect(SAFE_USER.test(ok)).toBe(true);
  for (const bad of ["", "a b", "a,b", "a:b", "a=b", "a#b", "%group", "a\\b", "-x"]) expect(SAFE_USER.test(bad)).toBe(false);
  expect(scriptArgs("on", "a b", "linux")).toBeNull();
  expect(scriptArgs("on", "igor", "linux")).toEqual(["on", "/etc/sudoers.d", "harbor-igor", "igor"]);
});

test("how the root script runs: polkit, macOS's dialog, sudo in a terminal, or sudo with no password to take it out", () => {
  const args = ["on", "/etc/sudoers.d", "harbor-igor", "igor"];
  expect(rootCommand("desktop", args, "linux", "/usr/bin/pkexec")).toEqual(["/usr/bin/pkexec", "/bin/sh", "-c", ROOT_SCRIPT, "sh", ...args]);
  expect(rootCommand("desktop", args, "linux", null)).toBeNull();
  expect(rootCommand("terminal", args, "linux", null)).toEqual(["sudo", "/bin/sh", "-c", ROOT_SCRIPT, "sh", ...args]);
  expect(rootCommand("sudo-n", ["off", "/etc/sudoers.d", "harbor-igor", "igor"], "linux", null)?.slice(0, 2)).toEqual(["sudo", "-n"]);
  const mac = rootCommand("desktop", ["on", "/private/etc/sudoers.d", "harbor-igor", "igor"], "darwin", null) ?? [];
  expect(mac[0]).toBe("/usr/bin/osascript");
  expect(mac[2]).toContain("with administrator privileges");
  expect(mac[2]).toContain(`quoted form of "/bin/sh"`);
  expect(osascriptArgs(["on"])[1]).toContain(`quoted form of "on"`);
  expect(appleString('a"b\\c')).toBe('"a\\"b\\\\c"');
});

test("what the outcome means: a dismissed prompt is a no, a missing polkit agent is no way to ask", () => {
  expect(interpret("desktop", "linux", 126, "")).toMatchObject({ declined: true, noPrompt: false });
  expect(interpret("desktop", "linux", 127, "Error executing command as another user: No authentication agent found.")).toMatchObject({ declined: false, noPrompt: true });
  expect(interpret("desktop", "darwin", 1, "execution error: User canceled. (-128)")).toMatchObject({ declined: true });
  expect(interpret("desktop", "linux", 3, "/etc/sudoers doesn't read /etc/sudoers.d\n")).toMatchObject({ code: 3, declined: false, noPrompt: false, out: "/etc/sudoers doesn't read /etc/sudoers.d" });
  expect(interpret("terminal", "linux", 1, "")).toMatchObject({ declined: false, noPrompt: false });
});

// The root script itself, with stand-ins for chown, chgrp and visudo (no root here): Linux and macOS only.
const posix = process.platform !== "win32" && existsSync("/bin/sh");
function rig(visudoOk: (file: string) => boolean, sudoers = "root ALL=(ALL) ALL\n@includedir /etc/sudoers.d\n") {
  const root = mkdtempSync(join(tmpdir(), "harbor-sudo-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const d = join(root, "sudoers.d");
  mkdirSync(bin);
  writeFileSync(join(root, "sudoers"), sudoers);
  for (const n of ["chown", "chgrp"]) {
    writeFileSync(join(bin, n), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, n), 0o755);
  }
  // visudo -cf FILE: the test decides; visudo -c (the whole configuration): fine.
  writeFileSync(join(bin, "visudo"), `#!/bin/sh\nif [ "$1" = -cf ]; then grep -q "${visudoOk("") ? "NOPASSWD" : "NEVER-THERE"}" "$2"; exit $?; fi\nexit 0\n`);
  chmodSync(join(bin, "visudo"), 0o755);
  const run = (verb: string) => Bun.spawnSync(["/bin/sh", "-c", ROOT_SCRIPT, "sh", verb, d, "harbor-igor", "igor", join(root, "sudoers")], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  return { d, run };
}

test.skipIf(!posix)("the root script writes the rule checked by visudo, mode 0440, and takes it out again", () => {
  const { d, run } = rig(() => true);
  const on = run("on");
  expect(on.exitCode).toBe(0);
  const f = join(d, "harbor-igor");
  expect(readFileSync(f, "utf8")).toBe("# Harbor: passwordless sudo for igor (harbor admin off removes it)\nigor ALL=(ALL) NOPASSWD: ALL\n");
  expect(statSync(f).mode & 0o777).toBe(0o440);
  // No temporary file left behind.
  expect(readdirSync(d)).toEqual(["harbor-igor"]);
  expect(run("off").exitCode).toBe(0);
  expect(existsSync(f)).toBe(false);
});

test.skipIf(!posix)("a rule visudo refuses never goes in, and a sudoers that doesn't read sudoers.d isn't touched", () => {
  const refused = rig(() => false);
  const r = refused.run("on");
  expect(r.exitCode).toBe(4);
  expect(readdirSync(refused.d)).toEqual([]);
  const noInclude = rig(() => true, "root ALL=(ALL) ALL\n");
  const n = noInclude.run("on");
  expect(n.exitCode).toBe(3);
  expect(n.stdout.toString()).toContain("doesn't read");
  expect(existsSync(noInclude.d)).toBe(false);
  // macOS's line, and the older #includedir, both count.
  expect(rig(() => true, "#includedir /private/etc/sudoers.d\n").run("on").exitCode).toBe(0);
});
