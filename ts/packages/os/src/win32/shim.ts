// npm's command shims on Windows (codex.cmd, claude.cmd…): a batch file that runs node on the package's script.
// Bun won't pass an argument with a cmd.exe special character (" & % | < > ^ or a line break) to a .cmd, and
// cmd.exe would mangle it anyway: a prompt or a JSON config can't go through one. So Harbor reads the shim and
// runs what it runs, node and the script, with the arguments as they are.
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** What an npm shim's text runs, relative to its folder: the script (or program) and whether node runs it. */
export function shimTarget(text: string): { target: string; node: boolean } | null {
  // cmd-shim's last line: `"%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*`, or for a program of its own
  // `"%dp0%\..\pkg\bin\tool.exe"   %*`.
  const m = /"%(?:~)?dp0%?\\([^"]+)"\s+%\*/i.exec(text);
  if (!m?.[1]) return null;
  const node = /"%_prog%"/i.test(text) || /\bnode(\.exe)?"?\s+"%(?:~)?dp0/i.test(text);
  return { target: m[1], node };
}

/** A script's `#!` line: its interpreter and the one argument it may give. Null: none. */
export function shebang(head: string): { interpreter: string; arg: string | null } | null {
  if (!head.startsWith("#!")) return null;
  const line = head.slice(2).split(/\r?\n/, 1)[0]?.trim() ?? "";
  const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
  if (!m?.[1]) return null;
  return { interpreter: m[1], arg: m[2]?.trim() || null };
}

/**
 * How a `#!` script runs here, as Git Bash would run it: `/usr/bin/env NAME` and a bare `sh`/`bash` find NAME
 * (Git's own bash for the shells), a Windows path that exists is used as it is. Null: its interpreter isn't here.
 */
export function interpreterOf(s: { interpreter: string; arg: string | null }, which: (name: string) => string | null, gitBash: string | null): string[] | null {
  let name = basename(s.interpreter.replaceAll("\\", "/")).replace(/\.exe$/i, "");
  let arg = s.arg;
  if (name === "env" && arg !== null) {
    const [first, ...rest] = arg.split(/\s+/).filter((w) => w !== "-S");
    if (first === undefined) return null;
    name = first;
    arg = rest.length > 0 ? rest.join(" ") : null;
  } else if (/^[A-Za-z]:[\\/]/.test(s.interpreter) && existsSync(s.interpreter)) {
    return arg === null ? [s.interpreter] : [s.interpreter, arg];
  }
  const shell = name === "sh" || name === "bash";
  const found = shell && gitBash !== null && existsSync(join(gitBash, `${name}.exe`)) ? join(gitBash, `${name}.exe`) : which(name);
  if (found === null) return null;
  return arg === null ? [found] : [found, arg];
}

const SCRIPT_EXT = new Set(["", ".sh", ".bash", ".js", ".mjs", ".cjs", ".ts", ".py"]);

/** The first bytes of a file (its `#!` line), "" when it can't be read. */
function head(path: string): string {
  try {
    const fd = openSync(path, "r");
    try {
      const b = Buffer.alloc(256);
      return b.toString("utf8", 0, readSync(fd, b, 0, 256, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * The command line that runs `program` without cmd.exe in between: [node, script] for an npm shim, the
 * interpreter and the script for a `#!` script (which Windows can't start itself), [program] for anything else
 * (or one this can't read, which then runs as before). `which` finds programs on PATH; `gitBash` is Git for
 * Windows' bin folder.
 */
export function argvOf(program: string, which: (name: string) => string | null, gitBash: string | null = null): string[] {
  if (SCRIPT_EXT.has(extname(program).toLowerCase())) {
    const s = shebang(head(program));
    const run = s === null ? null : interpreterOf(s, which, gitBash);
    return run === null ? [program] : [...run, program];
  }
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
