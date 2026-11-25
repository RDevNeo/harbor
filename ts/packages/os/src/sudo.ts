// Harbor's "run as administrator" on Linux and macOS: passwordless sudo for the user, so Harbor's agents can run
// `sudo …` with no password prompt. Harbor itself (its window) never runs as root. A file in sudoers.d,
// `harbor-<user>` holding `<user> ALL=(ALL) NOPASSWD: ALL` (root, 0440), is written by a small root script that checks
// that /etc/sudoers reads sudoers.d and validates the file with `visudo -cf` before moving it in (so a bad file can't
// lock sudo), then checks the whole configuration again and takes it back out if that fails. The one prompt is the
// desktop's own: polkit (pkexec) on Linux, the system's authentication dialog (osascript) on macOS; from a terminal
// (`harbor admin on`), sudo asks there. Harbor never sees the password. While it's on, `harbor admin off` removes the
// file with sudo, which needs no password then.
import { userInfo } from "node:os";
import { platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

/** Where sudo reads extra rules: macOS's /etc is /private/etc, and its sudoers names that path. */
export const sudoersDir = (p: string = platform()): string => (p === "darwin" ? "/private/etc/sudoers.d" : "/etc/sudoers.d");

/** A user name sudoers takes as it is (no character it would need escaped). */
export const SAFE_USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The file's name: sudo skips names with a dot (and ending in ~), so a user name's dots become _. */
export const fileName = (user: string): string => `harbor-${user.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export const ruleLine = (user: string): string => `${user} ALL=(ALL) NOPASSWD: ALL`;

export function currentUser(env: Env = process.env): string {
  try {
    return userInfo().username;
  } catch {
    return env.USER ?? env.LOGNAME ?? "";
  }
}

/**
 * The root script: `sh -c SCRIPT sh on|off DIR FILE USER`. Its exit codes: 0 done, 3 /etc/sudoers doesn't read DIR,
 * 4 the file wasn't written or visudo refused it, 5 sudo's whole configuration didn't check out with it (removed).
 */
export const ROOT_SCRIPT = [
  "set -u",
  // A fifth argument names another sudoers (the tests'); the real runs give four.
  'verb=$1 dir=$2 f=$3 u=$4 sudoers=${5:-/etc/sudoers}',
  'if [ "$verb" = off ]; then rm -f "$dir/$f"; exit 0; fi',
  "grep -Eq '^[[:space:]]*[@#]includedir[[:space:]]+(/private)?/etc/sudoers\\.d/?[[:space:]]*$' \"$sudoers\" || { echo \"$sudoers doesn't read $dir (no @includedir line): nothing was changed\"; exit 3; }",
  'mkdir -p "$dir" || exit 4',
  'tmp=$(mktemp "$dir/.harbor.XXXXXX") || exit 4',
  "printf '# Hub: passwordless sudo for %s (harbor admin off removes it)\\n%s ALL=(ALL) NOPASSWD: ALL\\n' \"$u\" \"$u\" > \"$tmp\" || { rm -f \"$tmp\"; exit 4; }",
  'chown root "$tmp" && chgrp 0 "$tmp" && chmod 0440 "$tmp" || { rm -f "$tmp"; exit 4; }',
  'if ! visudo -cf "$tmp" >/dev/null 2>&1; then rm -f "$tmp"; echo "visudo refused the rule: nothing was changed"; exit 4; fi',
  'mv -f "$tmp" "$dir/$f" || { rm -f "$tmp"; exit 4; }',
  'if ! visudo -c >/dev/null 2>&1; then rm -f "$dir/$f"; echo "sudo\'s configuration did not check out with the rule: it was taken out again"; exit 5; fi',
  "exit 0",
].join("\n");

/** The script's arguments for `verb`. Null: the user name isn't one sudoers takes as is. */
export function scriptArgs(verb: "on" | "off", user: string = currentUser(), p: string = platform()): string[] | null {
  if (!SAFE_USER.test(user)) return null;
  return [verb, sudoersDir(p), fileName(user), user];
}

/** An AppleScript string literal of `s`. */
export const appleString = (s: string): string => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** macOS: `osascript` arguments that run the script as root behind the system's own authentication dialog. */
export function osascriptArgs(args: readonly string[]): string[] {
  const cmd = ["/bin/sh", "-c", ROOT_SCRIPT, "sh", ...args].map((a) => `quoted form of ${appleString(a)}`).join(' & " " & ');
  return ["-e", `do shell script (${cmd}) with prompt "Hub wants to let its agents use sudo without asking for your password." with administrator privileges`];
}

export type Via = "desktop" | "terminal" | "sudo-n";

/** The command that runs the root script: the desktop's prompt, sudo in the terminal, or sudo with no password. */
export function rootCommand(via: Via, args: readonly string[], p: string = platform(), pkexec: string | null = Bun.which("pkexec")): string[] | null {
  const sh = ["/bin/sh", "-c", ROOT_SCRIPT, "sh", ...args];
  if (via === "sudo-n") return ["sudo", "-n", ...sh];
  if (via === "terminal") return ["sudo", ...sh];
  if (p === "darwin") return ["/usr/bin/osascript", ...osascriptArgs(args)];
  return pkexec === null ? null : [pkexec, ...sh];
}

export interface RootResult {
  code: number;
  /** The person said no (polkit's dismissed dialog, macOS's Cancel). */
  declined: boolean;
  /** No way to ask here (no pkexec, or polkit has no agent to ask with). */
  noPrompt: boolean;
  out: string;
}

/** What a run of the root script's exit code and output mean. */
export function interpret(via: Via, p: string, code: number, out: string): RootResult {
  const declined = (via === "desktop" && p !== "darwin" && code === 126) || (p === "darwin" && via === "desktop" && /-128\b|User canceled/i.test(out));
  // pkexec: 127 when no authorization could be had (no agent to ask with, or not allowed).
  const noPrompt = via === "desktop" && p !== "darwin" && code === 127;
  return { code, declined, noPrompt, out: out.trim() };
}

export async function runRoot(via: Via, verb: "on" | "off", p: string = platform()): Promise<RootResult> {
  const args = scriptArgs(verb, currentUser(), p);
  if (args === null) return { code: 2, declined: false, noPrompt: false, out: `the user name "${currentUser()}" has characters sudoers would need escaped` };
  const cmd = rootCommand(via, args, p);
  if (cmd === null) return { code: 127, declined: false, noPrompt: true, out: "no pkexec" };
  try {
    const tty = via === "terminal";
    // sudo by its full path, from "/": a working folder this user can't enter made the spawn fail (EACCES).
    const full = cmd[0] === "sudo" ? [Bun.which("sudo") ?? "/usr/bin/sudo", ...cmd.slice(1)] : cmd;
    const proc = Bun.spawn(full, { cwd: "/", stdin: tty ? "inherit" : "ignore", stdout: "pipe", stderr: tty ? "inherit" : "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : Promise.resolve(""), proc.exited]);
    return interpret(via, p, code, `${out}${err}`);
  } catch (e) {
    return { code: -1, declined: false, noPrompt: via === "desktop", out: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether sudo needs no password now (`sudo -n true`). */
export async function passwordless(): Promise<boolean> {
  const sudo = Bun.which("sudo");
  if (sudo === null) return false;
  try {
    const p = Bun.spawn([sudo, "-n", "true"], { cwd: "/", stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

/** Whether sudo is there at all. */
export const hasSudo = (): boolean => Bun.which("sudo") !== null && Bun.which("visudo") !== null;
