// npm's command shims on Windows (codex.cmd, claude.cmd…): a batch file that runs node on the package's script.
// Bun won't pass an argument with a cmd.exe special character (" & % | < > ^ or a line break) to a .cmd, and
// cmd.exe would mangle it anyway: a prompt or a JSON config can't go through one. So Harbor reads the shim and
// runs what it runs, node and the script, with the arguments as they are.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What an npm shim's text runs, relative to its folder: the script (or program) and whether node runs it. */
export function shimTarget(text: string): { target: string; node: boolean } | null {
  // cmd-shim's last line: `"%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*`, or for a program of its own
  // `"%dp0%\..\pkg\bin\tool.exe"   %*`.
  const m = /"%(?:~)?dp0%?\\([^"]+)"\s+%\*/i.exec(text);
  if (!m?.[1]) return null;
  const node = /"%_prog%"/i.test(text) || /\bnode(\.exe)?"?\s+"%(?:~)?dp0/i.test(text);
  return { target: m[1], node };
}

/**
 * The command line that runs `program` without cmd.exe in between: [node, script] for an npm shim, [program] for
 * anything else (or a shim this can't read, which then runs as before). `which` finds node on PATH.
 */
export function argvOf(program: string, which: (name: string) => string | null): string[] {
  if (!/\.(cmd|bat)$/i.test(program)) return [program];
  let text: string;
  try {
    text = readFileSync(program, "utf8");
  } catch {
    return [program];
  }
  const t = shimTarget(text);
  if (t === null) return [program];
  const dir = dirname(program);
  const target = join(dir, t.target);
  if (!existsSync(target)) return [program];
  if (!t.node) return [target];
  const beside = join(dir, "node.exe");
  const node = existsSync(beside) ? beside : which("node");
  return node === null ? [program] : [node, target];
}
