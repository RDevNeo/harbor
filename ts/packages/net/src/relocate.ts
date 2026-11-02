import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { codeState, placeSessionFiles, safeRel, sessionDir, sessionFiles, validSid, type SessionEnv } from "./movepc.ts";
import { lastLine, outputWithin, type Spawner } from "./proc.ts";
import { hostLabel, shQuote, shellFamily, shellPath, type RemoteHost, type RemoteSetup } from "./remote.ts";
import { label, type Peer } from "./shared.ts";

const SSH_WAIT = 120_000;

/** Where a chat can run: this PC, one of its SSH devices, or another PC's Harbor. */
export type RelocatePlace = { kind: "here" } | { kind: "device"; host: RemoteHost } | { kind: "hub"; peer: Peer };

/** Where the agent's files are: this PC's (null), or a device's own. */
export function placeFiles(p: RelocatePlace): string | null {
  switch (p.kind) {
    case "here":
      return null;
    case "device":
      return p.host.device_files ? p.host.id : null;
    case "hub":
      return `hub:${p.peer.id}`;
  }
}

/** A device's side of a move, prepared where the app can read its settings. */
export interface RelocateDev {
  name: string;
  ssh: string[];
  host: string;
  /** The folder its turns start in. */
  dir: string;
  /** Shell lines that set `c` to the Claude profile its turns use. */
  config: string;
}

/** The shell lines that set `c` to the profile a turn's `setup` gives Claude on a device. */
export function configLines(setup: readonly RemoteSetup[]): string {
  let s = 'c="$HOME/.claude"';
  for (const l of setup) {
    if (l.kind === "guest") s = `c="$HOME"/${shQuote(l.rel)}; mkdir -p "$c"`;
    else if (l.kind === "profile") s += `; [ -d "$HOME"/${shQuote(l.rel)} ] && c="$HOME"/${shQuote(l.rel)}`;
  }
  return s;
}

/** The script that writes a session's tar stream (stdout) from a device: its newest copy in any profile there. Exit 96 when there's none. */
export function pullScript(sid: string): string {
  const f = shQuote(`${sid}.jsonl`);
  const d = shQuote(sid);
  return [
    `s=$(ls -t "$HOME"/.claude*/projects/*/${f} "$HOME"/.local/state/harbor/guests/*/projects/*/${f} 2>/dev/null | head -n1)`,
    `[ -n "$s" ] || { echo "harbor: the chat's session isn't on $(hostname)" >&2; exit 96; }`,
    `cd "$(dirname "$s")" || exit 96`,
    "export COPYFILE_DISABLE=1",
    `if [ -d ${d} ]; then tar -cf - ${f} ${d}; else tar -cf - ${f}; fi`,
  ].join("\n");
}

/** The script that unpacks a session's tar stream (stdin) where a device's turns will look. */
export function pushScript(dir: string, config: string): string {
  return `cd ${shellPath(dir)} 2>/dev/null || { echo "harbor: the folder ${dir.replace(/["$`\\]/g, "")} doesn't exist on $(hostname)" >&2; exit 97; }\n${config}\nd="$c/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"; mkdir -p "$d" && tar -xf - -C "$d"`;
}

/** The script that counts a device folder's uncommitted changes (0 outside git). */
export function dirtyScript(dir: string): string {
  return `cd ${shellPath(dir)} 2>/dev/null || { echo 0; exit 0; }\ngit rev-parse --git-dir >/dev/null 2>&1 || { echo 0; exit 0; }\ngit status --porcelain | wc -l`;
}

function sshArgs(dev: RelocateDev, script: string): string[] {
  return [...dev.ssh, dev.host, `sh -c ${shQuote(script)}`];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** [place relative to the unpacked folder, file here] for every plain file under `dir`. */
function collect(dir: string, rel: string, out: [string, string][]): void {
  let rd;
  try {
    rd = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of rd) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) collect(join(dir, e.name), r, out);
    else if (e.isFile()) out.push([r, join(dir, e.name)]);
  }
}

/** A session from a device into `into` (made here): its files there, as [place, file here]. */
async function pull(run: Spawner, dev: RelocateDev, sid: string, into: string): Promise<[string, string][]> {
  const out = await run("ssh", sshArgs(dev, pullScript(sid)), { timeoutMs: SSH_WAIT }).catch((e: unknown) => {
    throw new Error(`ssh to ${dev.name}: ${msg(e)}`);
  });
  if (out.code !== 0) throw new Error(`couldn't read the session on ${dev.name}: ${lastLine(out.stderr)}`);
  mkdirSync(into, { recursive: true });
  const x = await run("tar", ["-xf", "-", "-C", into], { timeoutMs: SSH_WAIT, input: out.stdout });
  if (x.code !== 0) throw new Error(`couldn't unpack the session from ${dev.name}: ${lastLine(x.stderr)}`);
  const all: [string, string][] = [];
  collect(into, "", all);
  // Only the session's own places (a Mac's tar may add `._…` files).
  const files = all.filter(([rel]) => safeRel(sid, rel));
  if (!files.some(([rel]) => rel === `${sid}.jsonl`)) throw new Error(`the session didn't come over from ${dev.name}`);
  return files;
}

/** A session's files to a device, where its turns will look. */
async function push(run: Spawner, dev: RelocateDev, sid: string, files: readonly [string, string][]): Promise<void> {
  const main = files.find(([r]) => r === `${sid}.jsonl`);
  if (!main) throw new Error("no session file");
  const [rel, path] = main;
  if (!path.endsWith(rel)) throw new Error("bad session path");
  const root = path.slice(0, path.length - rel.length);
  const args = ["-cf", "-", "-C", root, `${sid}.jsonl`];
  try {
    if (statSync(join(root, sid)).isDirectory()) args.push(sid);
  } catch {
    // no sidecar folder
  }
  const packed = await run("tar", args, { timeoutMs: SSH_WAIT, env: { COPYFILE_DISABLE: "1" } });
  if (packed.code !== 0) throw new Error(`couldn't pack the session: ${lastLine(packed.stderr)}`);
  const out = await run("ssh", sshArgs(dev, pushScript(dev.dir, dev.config)), { timeoutMs: SSH_WAIT, input: packed.stdout });
  if (out.code !== 0) throw new Error(`couldn't put the session on ${dev.name}: ${lastLine(out.stderr)}`);
}

/** One session of the move: its id, the account's profile here (null: ~/.claude), and its folder here. */
export interface RelocateSession {
  sid: string;
  config: string | null;
  here: string;
}

/** The files check before the agent's files change place. */
export type RelocateCheck = { kind: "none" } | { kind: "here"; dir: string } | { kind: "device"; dev: RelocateDev };

export interface RelocateJob {
  from: RelocateDev | null;
  to: RelocateDev | null;
  sessions: RelocateSession[];
  check: RelocateCheck;
}

export interface RelocateEnv extends SessionEnv {
  dataDir: string;
  /** ssh, tar and git all go through this. */
  run?: Spawner;
  newId?: () => string;
}

/** The move off the UI thread: the files check, then each session from where it is to where the next turn will look. */
export async function relocateRun(job: RelocateJob, env: RelocateEnv): Promise<void> {
  const run = env.run ?? outputWithin;
  const c = job.check;
  if (c.kind === "here") {
    await codeState({ home: env.home, run }, c.dir, false);
  } else if (c.kind === "device") {
    const dev = c.dev;
    const out = await run("ssh", sshArgs(dev, dirtyScript(dev.dir)), { timeoutMs: SSH_WAIT }).catch((e: unknown) => {
      throw new Error(`ssh to ${dev.name}: ${msg(e)}`);
    });
    if (out.code !== 0) throw new Error(`couldn't reach ${dev.name}: ${lastLine(out.stderr)}`);
    const last = lastLine(out.stdout);
    const n = /^\d+$/.test(last) ? Number(last) : 0;
    if (n > 0) throw new Error(`${dev.dir} on ${dev.name} has ${n} uncommitted change${n === 1 ? "" : "s"}: commit or stash them first`);
  }
  const tmp = join(env.dataDir, "relocate", (env.newId ?? randomUUID)());
  try {
    for (const s of job.sessions) {
      let files: [string, string][];
      if (job.from) files = await pull(run, job.from, s.sid, join(tmp, s.sid));
      else {
        const found = sessionFiles(env, s.config, s.sid);
        if (found === null) throw new Error("its Claude session isn't on this PC");
        files = found;
      }
      if (job.to) await push(run, job.to, s.sid, files);
      else placeSessionFiles(sessionDir(env.home, s.config, s.here), s.sid, files);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A place by the id the pickers use: "" this PC, a mesh PC's id (its Harbor), a device's. */
export function placeOf(id: string, hosts: readonly Peer[], devs: readonly [RemoteHost, boolean | null][]): { place: RelocatePlace; online: boolean | null } | null {
  if (id === "") return { place: { kind: "here" }, online: true };
  const p = hosts.find((x) => x.id === id);
  if (p) return { place: { kind: "hub", peer: p }, online: p.online };
  const d = devs.find(([h]) => h.id === id);
  return d ? { place: { kind: "device", host: d[0] }, online: d[1] } : null;
}

/** A place's name, for notices and toasts. */
export function placeName(p: RelocatePlace, me: { name: string; hostname: string }): string {
  switch (p.kind) {
    case "here":
      return me.name === "" ? me.hostname : me.name;
    case "device":
      return hostLabel(p.host);
    case "hub":
      return p.peer.name === "" ? label(p.peer.id) : p.peer.name;
  }
}

export interface RelocateChat {
  id: number;
  name: string;
  device: string;
  claude: boolean;
  running: boolean;
}

export interface RelocateBlockerInput {
  /** A copy of another PC's chat: that PC's name. */
  foreignHome: string | null;
  isSub: boolean;
  movingTo: string | null;
  /** The lead first, then its sub-agents. */
  chats: RelocateChat[];
  /** The lead's device in Settings > Devices, when the lead runs on one (null: not found). */
  leadDevice: { os: string } | null;
}

/** Why a started chat can't move anywhere now (null: it may; the places say the rest). */
export function relocateBlocker(i: RelocateBlockerInput): string | null {
  if (i.foreignHome !== null) return `it runs in ${i.foreignHome}'s Harbor: change it there, or move it with Move to PC…`;
  if (i.isSub) return "a sub-agent runs where its lead does: change the lead";
  if (i.movingTo !== null) return `it's moving to ${i.movingTo}`;
  const lead = i.chats[0];
  for (const x of i.chats) {
    const it = x === lead ? "it" : `its sub-agent ${x.name}`;
    if (!x.claude) return `${it} isn't a Claude chat: only Claude chats move between devices for now`;
    if (x.running) return `${it} is running: move it once its turn ends`;
    if (lead && x.device !== lead.device) return `its sub-agent ${x.name} runs on another device`;
  }
  if (lead && lead.device !== "") {
    if (i.leadDevice === null) return "its device isn't in Settings › Devices anymore, so its session can't be fetched";
    if (shellFamily(i.leadDevice.os) === "windows") return "Windows devices can't hand a started chat over yet";
  }
  return null;
}

export interface RelocateWhyInput {
  started: boolean;
  /** The chat's device now ("" this PC). */
  device: string;
  to: string;
  blocker: () => string | null;
  place: { place: RelocatePlace; online: boolean | null } | null;
  meshOn: boolean;
}

/** Why a started chat can't move to `to` now (null: it can, or it's already there). A chat not started yet is free to pick. */
export function relocateWhy(i: RelocateWhyInput): string | null {
  if (!i.started || i.to === i.device) return null;
  const b = i.blocker();
  if (b !== null) return b;
  if (i.place === null) return "no such device";
  const p = i.place.place;
  switch (p.kind) {
    case "here":
      return null;
    case "device":
      if (shellFamily(p.host.os) === "windows") return "Windows devices can't take a started chat yet";
      return i.place.online === false ? "it's offline" : null;
    case "hub":
      if (!i.meshOn) return "this PC doesn't share chats with other PCs (Settings › Devices)";
      if (!p.peer.online) return "it's off or out of reach";
      if (!p.peer.moves) return "it runs an older Harbor: update it first";
      if (!p.peer.accounts.some((a) => a[2] === "claude")) return "it has no Claude account";
      return null;
  }
}

/** For the phone: per place id, why a started chat can't move there (only those that can't); null for a chat not started or a copy. */
export function deviceWhy(started: boolean, foreign: boolean, ids: readonly string[], why: (id: string) => string | null): { [id: string]: string } | null {
  if (!started || foreign) return null;
  const m: { [id: string]: string } = {};
  for (const id of ids) {
    const w = why(id);
    if (w !== null) m[id] = w;
  }
  return m;
}

/** The notice and toast of a finished move to a device or this PC. */
export function relocatedText(target: RelocatePlace, from: string, name: string): { notice: string; detail: string; toast: string } {
  return {
    notice: `Moved from ${from} to ${name}`,
    detail: target.kind === "here" ? "Its Claude session came along; its next turn runs on this PC." : `Its Claude session came along; its next turn runs on ${name}.`,
    toast: `Moved to ${name}`,
  };
}

/** The notice and toast when a move couldn't be made. */
export function relocateFailedText(name: string, why: string): string {
  return `Couldn't move to ${name}: ${why}`;
}

/** The sessions of the chats that are started, with the check of their ids. */
export function relocateSessions(chats: readonly { name: string; started: boolean; session_id: string; configDir: string | null }[], here: string): RelocateSession[] {
  const out: RelocateSession[] = [];
  for (const c of chats) {
    if (!c.started || c.session_id === "") continue;
    if (!validSid(c.session_id)) throw new Error(`${c.name}'s session id looks wrong`);
    out.push({ sid: c.session_id, config: c.configDir, here });
  }
  return out;
}

/** Which files check a move needs: none when the files stay where they are or there's no project; the device's own files are checked there, a hub target checks this PC's folder itself. */
export function relocateCheck(a: { source: RelocatePlace; target: RelocatePlace; hasRepo: boolean; sourceDev: RelocateDev | null; cwd: string }): RelocateCheck {
  if (placeFiles(a.source) === placeFiles(a.target) || !a.hasRepo) return { kind: "none" };
  if (a.source.kind === "device" && a.source.host.device_files && a.sourceDev) return { kind: "device", dev: a.sourceDev };
  if (a.target.kind === "hub") return { kind: "none" };
  return { kind: "here", dir: a.cwd };
}

