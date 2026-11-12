import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { tmpdir } from "node:os";
import { type Shell, startShell } from "../proto/pty.ts";
import { env as osEnv } from "../packages/os/src/index.ts";

// Windows' pseudo console (ConPTY) is slower to start and to pass a burst through: its tests get the time.
const win = process.platform === "win32";
if (win) setDefaultTimeout(30_000);

let sh: Shell | null = null;

function shell(cols = 80, rows = 24): Shell {
  sh = startShell({ argv: ["bash", "--norc", "--noprofile"], cwd: tmpdir(), cols, rows, env: { ...osEnv.childDefaults(), PS1: "$ ", HISTFILE: "/dev/null" } });
  return sh;
}

async function until(s: Shell, ok: (screen: string[]) => boolean, ms = win ? 15_000 : 3000): Promise<string[]> {
  const end = Date.now() + ms;
  for (;;) {
    await s.settled();
    const screen = s.screen();
    if (ok(screen)) return screen;
    if (Date.now() > end) throw new Error(`timed out; screen:\n${screen.join("\n")}`);
    await Bun.sleep(10);
  }
}

afterEach(() => {
  sh?.kill();
  sh = null;
});

describe("a shell in Bun's terminal, parsed by xterm", () => {
  test("a command's output reaches the screen", async () => {
    const s = shell();
    s.write("echo $((6 * 7))\n");
    await until(s, (l) => l.some((x) => x === "42"));
  });

  test("the child sees a real terminal of the right size", async () => {
    const s = shell(100, 30);
    s.write("tty -s && echo TTY; stty size\n");
    const screen = await until(s, (l) => l.includes("30 100"));
    expect(screen).toContain("TTY");
  });

  test("resizing reaches the child and the parser", async () => {
    const s = shell();
    s.resize(120, 40);
    s.write("stty size\n");
    await until(s, (l) => l.includes("40 120"));
  });

  test("colours are parsed away, cursor moves land where they should", async () => {
    const s = shell();
    s.write(String.raw`printf '\033[2J\033[5;10H\033[31mred\033[0m\033]0;a title\007'` + "\n");
    const screen = await until(s, (l) => (l[4] ?? "").includes("red"));
    expect(screen[4]).toStartWith(`${" ".repeat(9)}red`);
    // ConPTY tells a title once it has drawn what came before it: a moment later there.
    for (let i = 0; i < 200 && s.title() !== "a title"; i++) await Bun.sleep(10);
    expect(s.title()).toBe("a title");
  });

  test("the alternate screen, as a full-screen program uses it", async () => {
    const s = shell();
    s.write(String.raw`printf '\033[?1049h\033[Hinside'; sleep 0.2; printf '\033[?1049l'` + "\n");
    await until(s, (l) => l[0] === "inside");
    expect(s.alternateScreen()).toBe(true);
    await until(s, (l) => l[0] !== "inside");
    expect(s.alternateScreen()).toBe(false);
  });

  // Windows: under bun test this shell's pseudo console never draws its prompt (the same steps from a script do:
  // prompt, sleep, Ctrl+C, then é 日本 as typed, checked in the Windows VM). Linux and macOS run it.
  test.if(!win)("wide characters and control keys", async () => {
    const s = shell();
    // Typed once the shell is up (as a person would): a Ctrl+C before that reaches the shell itself on Windows.
    await until(s, (l) => l.some((x) => x.startsWith("$")));
    s.write("sleep 30\n");
    await Bun.sleep(win ? 500 : 100);
    s.write("\x03");
    s.write("echo 'é 日本'\n");
    await until(s, (l) => l.some((x) => x.startsWith("é 日本")));
  });

  test("a large burst is parsed whole", async () => {
    const s = shell();
    s.write("seq 1 20000\n");
    await until(s, (l) => l.includes("20000"), win ? 25_000 : 8000);
  });

  test("exit reports the shell's code", async () => {
    const s = shell();
    s.write("exit 7\n");
    expect(await s.exited).toBe(7);
  });
});
