import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { http as meshHttp, type Body } from "./client.ts";
import { urlEncode, err, ok, type Reply } from "./http.ts";
import { APP_INBOX, safeName, type Hub, type Parcel } from "./hub.ts";
import { now } from "./kv.ts";
import { tildeOf } from "./movepc.ts";
import { outputWithin, type Spawner } from "./proc.ts";
import { pairedPcs, shQuote, sshOpts, type RemoteConfig, type RemoteCtx, type RemoteHost } from "./remote.ts";
import { dest as peerDest, type Dest, type Down, type Peer } from "./shared.ts";
import { agoShort, newestVersion, pcLine, type PcVersion } from "./versions.ts";
import { sip13, type Json } from "./wire.ts";

/** Images above this aren't fetched for a preview. */
export const DEVICE_PREVIEW_MAX = 25 << 20;
/** The most one send to a PC may carry (its listener's upload limit). */
export const DEVICE_SEND_MAX = 200 << 20;
/** A phone's Harbor app calls every 30 s while it's open: seen this recently, it's open. */
export const PHONE_OPEN_SECS = 75;
/** In the background the app pings every 15 minutes: pinged this recently, the phone is online (reachable), the app open or not. */
export const PHONE_ALIVE_SECS = 35 * 60;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** ssh's options and destination for a paired PC: one reused connection (Harbor's own socket), then what remote agents use (`harbor nc`, Settings > Devices' login and key). */
export function deviceSshArgs(ctx: RemoteCtx, cfg: RemoteConfig, h: RemoteHost): string[] {
  const v = ["-o", "ControlMaster=auto", "-o", `ControlPath=${ctx.home}/.ssh/harbor-%C`, "-o", "ControlPersist=120"];
  // ssh takes an option's first value: the agents' "no reuse" ones are dropped.
  const opts = sshOpts(ctx, cfg, h);
  for (let i = 0; i < opts.length; i++) {
    const next = opts[i + 1] ?? "";
    if (opts[i] === "-o" && (next.startsWith("ControlMaster=") || next.startsWith("ControlPath="))) {
      i++;
      continue;
    }
    v.push(opts[i] ?? "");
  }
  // `--`: the destination is never read as an option.
  v.push("--", h.host);
  return v;
}

/** `cmd` run by the PC's sh, whatever its login shell: ssh hands the command line to that shell, and fish reads `\'` inside single quotes, so it gets only base64 in quotes free of both. */
export function deviceShCmd(cmd: string): string {
  return `python3 -c 'import base64,os;os.execv("/bin/sh",["sh","-c",base64.b64decode("${Buffer.from(cmd).toString("base64")}")])'`;
}

/** A device's key as one folder name (a PC picks its own mesh id). */
export function deviceDirName(key: string): string {
  const s = [...key].map((c) => (/^[A-Za-z0-9\-_.]$/.test(c) ? c : "_")).join("");
  return /^\.*$/.test(s) ? `_${s}` : s;
}

// Rust formats ties to even ("{:.0}" of 2.5 is "2"); toFixed rounds them up.
function fixed(x: number, digits: number): string {
  const scaled = x * 10 ** digits;
  const twice = scaled * 2;
  if (Number.isInteger(twice) && twice % 2 !== 0) {
    const down = Math.floor(scaled);
    const r = down % 2 === 0 ? down : down + 1;
    return (r / 10 ** digits).toFixed(digits);
  }
  return x.toFixed(digits);
}

/** A size for the transfers list: "12 B", "3 KB", "1.5 MB", "2.0 GB". */
export function deviceHumanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${fixed(n / 1024, 0)} KB`;
  if (n < 1_073_741_824) return `${fixed(n / 1_048_576, 1)} MB`;
  return `${fixed(n / 1_073_741_824, 1)} GB`;
}

/** A free name in `dir` for `name` ("a.png", "a (2).png", ...). */
export function freeFileName(dir: string, name: string): string {
  const p = parse(name);
  let out = join(dir, name);
  for (let n = 2; existsSync(out); n++) out = join(dir, `${p.name} (${n})${p.ext}`);
  return out;
}

/** The user's Downloads folder: the desktop's own (`xdg-user-dir`), unless that is the home itself. */
export async function deviceDownloadsDir(home: string, run: Spawner = outputWithin): Promise<string> {
  try {
    const o = await run("xdg-user-dir", ["DOWNLOAD"], { timeoutMs: 5000 });
    const p = o.stdout.toString("utf8").trim();
    if (p !== "" && p !== home && statSync(p).isDirectory()) return p;
  } catch {
    // no xdg-user-dir
  }
  return join(home, "Downloads");
}


const kindOf = (k: string): PairedDevice["kind"] => (k === "pc" || k === "android" ? k : "");
const downOfText = (d: string): PairedDevice["down"] => (d === "harbor" || d === "pc" ? d : "");

export interface PairedDevice {
  /** A paired PC's mesh id ("pc:..."), or "phone:<pairing group>". */
  key: string;
  name: string;
  kind: "pc" | "android" | "";
  online: boolean;
  /** The address it was last seen at. */
  ip: string;
  /** When it last answered or called (unix seconds, 0: not known). */
  seen: number;
  /** Phones: the PC of the mesh it was last seen at, when that isn't this one. */
  via: string;
  /** Phones: its app's versionCode (0: unknown, an old app). */
  app: number;
  /** Phones: the account signed in on it. */
  owner: string;
  /** PCs that don't answer: why. */
  down: Down | "";
  /** Phones: Harbor is open on it right now (online is also true while it only pings). */
  open: boolean;
  /** PCs: its Harbor version and updates in a line ("" when unknown). */
  harbor: string;
}

export function newPairedDevice(d: Partial<PairedDevice> = {}): PairedDevice {
  return { key: "", name: "", kind: "", online: false, ip: "", seen: 0, via: "", app: 0, owner: "", down: "", open: false, harbor: "", ...d };
}

export function isPhoneDevice(d: Pick<PairedDevice, "kind">): boolean {
  return d.kind === "android";
}

/** A phone's pairing (the token's group). */
export function deviceGroup(d: Pick<PairedDevice, "key">): string {
  return d.key.startsWith("phone:") ? d.key.slice("phone:".length) : "";
}

/** Phones take sends any time (they wait for the app); PCs while they answer. */
export function deviceCanSend(d: Pick<PairedDevice, "kind" | "online">): boolean {
  return isPhoneDevice(d) || d.online;
}

/** For hot reload: what a device tab needs to come back. */
export function deviceJson(d: PairedDevice): Json {
  return { key: d.key, name: d.name, kind: d.kind, online: d.online, ip: d.ip, seen: d.seen, via: d.via, app: d.app, owner: d.owner, down: d.down, open: d.open, harbor: d.harbor };
}

export function deviceFrom(v: unknown): PairedDevice {
  const o: Record<string, unknown> = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const s = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
  const i = (k: string): number => (typeof o[k] === "number" && Number.isInteger(o[k]) ? (o[k] as number) : 0);
  return newPairedDevice({ key: s("key"), name: s("name"), kind: kindOf(s("kind")), online: o.online === true, ip: s("ip"), seen: i("seen"), via: s("via"), app: i("app"), owner: s("owner"), down: downOfText(s("down")), open: o.open === true, harbor: s("harbor") });
}

/** What a phone's app is, for Devices and Settings > Phones: "app 0.18.1", or how it's behind the app this PC serves (`served`: its versionCode, 0 when none). Null while the phone hasn't been seen. Second: it needs an update. */
export function phoneAppNote(app: number, seen: number, served: number): [string, boolean] | null {
  const name = (c: number) => `${Math.trunc(c / 1_000_000)}.${Math.trunc(c / 1000) % 1000}.${c % 1000}`;
  if (seen === 0) return null;
  if (app === 0) return ["app older than 0.17: update it", true];
  // An app that picks up sends but doesn't say its version: 0.17 or 0.18.0.
  if (app === APP_INBOX) return [served > app ? `app 0.17+, ${name(served)} available` : "app 0.17+", served > app];
  if (served > app) return [`app ${name(app)} → ${name(served)} available`, true];
  return [`app ${name(app)}`, false];
}

/** Everything paired: the mesh's PCs, then (with phone access on) the phones, one per pairing. `versions` is versions.ts's PCs. */
export function pairedDevices(hub: Hub, versions: readonly PcVersion[], at: number = now()): PairedDevice[] {
  const meshOn = hub.mesh.on;
  const newest = newestVersion(versions);
  const v: PairedDevice[] = pairedPcs(hub.mesh.allowed, hub.mesh.peers).map((p) => {
    const down = meshOn && !p.online ? (hub.mesh.down.get(p.id) ?? "") : "";
    const x = versions.find((y) => y.id === p.id);
    // Its Harbor: "0.66.0 (latest)", or the version it ran when last seen.
    const harbor = x && x.online ? `Harbor ${pcLine(x, newest, at)}` : x && x.version !== "" ? `Harbor ${x.version}` : "";
    return newPairedDevice({ seen: hub.mesh.peers.get(p.id)?.seen ?? 0, key: p.id, name: p.name, kind: "pc", online: meshOn && p.online, ip: p.ip, down, harbor });
  });
  if (hub.enabled) {
    for (const p of hub.pairedPhones()) {
      const open = p.seen > 0 && at - p.seen < PHONE_OPEN_SECS;
      const online = open || (p.alive > 0 && at - p.alive < PHONE_ALIVE_SECS);
      v.push(newPairedDevice({ key: `phone:${p.group}`, name: p.name === "" ? "Phone" : p.name, kind: "android", online, open, ip: p.ip, seen: Math.max(p.seen, p.alive), via: p.via, app: p.app, owner: p.owner }));
    }
  }
  return v;
}

/** A device row's details: kind, state, owner or Harbor version, address. */
export function deviceDetails(d: PairedDevice, served: number, at: number = now()): string {
  const bits = [isPhoneDevice(d) ? "Phone" : "PC"];
  const ago = (s: number): string => {
    const a = agoShort(s, at);
    return a === "now" ? "seen just now" : `seen ${a} ago`;
  };
  if (isPhoneDevice(d) && d.online && d.open && d.via !== "") bits.push(`Harbor open, via ${d.via}`);
  else if (isPhoneDevice(d) && d.online && d.open) bits.push("Harbor open");
  // Reachable, the app in the background or closed (its pings, PHONE_ALIVE_SECS).
  else if (isPhoneDevice(d) && d.online && d.via !== "") bits.push(`online, via ${d.via}`);
  else if (d.online) bits.push("online");
  else if (!isPhoneDevice(d) && d.down === "harbor" && d.seen > 0) bits.push(`Harbor isn't running, ${ago(d.seen)}`);
  else if (!isPhoneDevice(d) && d.down === "harbor") bits.push("Harbor isn't running");
  else if (d.seen > 0) bits.push(`offline, ${ago(d.seen)}`);
  else bits.push("offline");
  if (isPhoneDevice(d)) {
    if (d.owner !== "") bits.push(d.owner);
    const note = phoneAppNote(d.app, d.seen, served);
    if (note) bits.push(note[0]);
  } else {
    if (d.harbor !== "") bits.push(d.harbor);
    if (d.ip !== "" && d.online) bits.push(d.ip);
  }
  return bits.join(" · ");
}

/** The line under a device's Send menu, when there is one. */
export function sendMenuNote(d: PairedDevice): string | null {
  if (isPhoneDevice(d) && d.seen > 0 && d.app < APP_INBOX) return "The phone's app is too old to take these: update it (Settings › Update there)";
  if (isPhoneDevice(d) && !d.online) return "Arrives when Harbor is open on the phone";
  return null;
}

/** What the Image entry of a Send menu says about where it lands. */
export function imageSendNote(d: Pick<PairedDevice, "kind">): string {
  return isPhoneDevice(d) ? "Saved to its Pictures and opened in its photo app" : "Saved to its Downloads and opened there";
}


/** One file transfer, shown under the list (or the file browser) with its progress. */
export interface DeviceTransfer {
  label: string;
  sent: number;
  size: number;
  done: boolean;
  error: string | null;
  /** Where a download was saved. */
  saved: string | null;
  /** Waits on this PC for the phone's Harbor app to pick it up. */
  waiting: boolean;
}

export function newDeviceTransfer(t: Partial<DeviceTransfer> = {}): DeviceTransfer {
  return { label: "", sent: 0, size: 0, done: false, error: null, saved: null, waiting: false, ...t };
}

/** Transfers that finished or failed leave the list. */
export function clearDeviceTransfers(l: DeviceTransfer[]): DeviceTransfer[] {
  return l.filter((x) => !x.done && x.error === null);
}

/** The second line of a transfer: its error, what it saved, a wait, or its progress. */
export function transferStatus(x: DeviceTransfer): string {
  if (x.error !== null) return x.error;
  if (x.done) return x.saved !== null ? `${deviceHumanSize(x.size)} · saved to ${x.saved}` : x.size === 0 ? "Done" : deviceHumanSize(x.size);
  if (x.waiting) return "Waiting for Harbor on the phone (open the app)";
  return `${deviceHumanSize(x.sent)} of ${deviceHumanSize(x.size)}`;
}

/** What a send is: "text" (onto the clipboard), "clip-image" (an image onto the clipboard), "image" (opens there) or "file" (lands in Downloads there). */
export type DeviceSendKind = "text" | "clip-image" | "image" | "file";

const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");

export interface DeviceSendEnv {
  hub: Hub | null;
  /** The PC `key` names, when the mesh has it. */
  peer(key: string): Peer | null;
  http?: typeof meshHttp;
  /** The image as a PNG file (the clipboard takes PNGs): itself, or a converted temp copy. Absent: PNGs only. */
  toPng?: (path: string) => Promise<string>;
  /** The hub's clock (a parcel's age is measured with it). */
  clock?: () => number;
  /** Called after each change to a transfer. */
  wake?: () => void;
}

async function pngOf(env: DeviceSendEnv, path: string): Promise<string> {
  if (env.toPng) return env.toPng(path);
  if (readFileSync(path).subarray(0, 8).equals(PNG_MAGIC)) return path;
  throw new Error("only PNG and JPEG images can go on the clipboard");
}

/** One item to a paired PC (`POST /mesh/v1/deliver`). */
export async function deviceSendToPc(env: DeviceSendEnv, key: string, kind: DeviceSendKind, name: string, text: string, path: string | null): Promise<void> {
  if (!env.hub) throw new Error("Harbor isn't ready");
  const peer = env.peer(key);
  if (!peer) throw new Error("this PC isn't connected right now");
  let body: Buffer;
  if (path !== null) {
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > DEVICE_SEND_MAX) throw new Error("files up to 200 MB");
    body = readFileSync(path);
  } else body = Buffer.from(text);
  const http = env.http ?? meshHttp;
  const b: Body = { ctype: "application/octet-stream", data: body };
  let r: [number, unknown];
  try {
    r = await http(peerDest(peer), "POST", `/mesh/v1/deliver?kind=${kind}&name=${urlEncode(name)}`, b, 600_000);
  } catch (e) {
    throw new Error(`${peer.name} didn't answer: ${msg(e)}`);
  }
  const [status, v] = r;
  if (status === 200) return;
  if (status === 404) throw new Error(`${peer.name}'s Harbor is too old to take this: update it`);
  const e = typeof v === "object" && v !== null && "error" in v && typeof v.error === "string" ? v.error : null;
  throw new Error(e ?? `${peer.name} answered ${status}`);
}

/** Sends to a device, each item tracked like a transfer: to a phone through this PC's hub, to a PC over the mesh. Resolves when the sends to PCs are over (a phone's waits for its app). */
export async function deviceSend(dev: PairedDevice, kind: DeviceSendKind, text: string | null, files: string[], transfers: DeviceTransfer[], env: DeviceSendEnv): Promise<void> {
  const name = dev.name;
  const to = kind === "text" || kind === "clip-image" ? `${name}'s clipboard` : name;
  const items: { label: string; text: string; path: string | null; temp: boolean; size: number }[] = [];
  if (text !== null) items.push({ label: "Text", text, path: null, temp: false, size: 0 });
  for (const f of files) {
    const n = basename(f);
    let path = f;
    let temp = false;
    if (kind === "clip-image") {
      try {
        path = await pngOf(env, f);
        temp = path !== f;
      } catch (e) {
        transfers.push(newDeviceTransfer({ label: `${n} → ${to}`, error: msg(e) }));
        continue;
      }
    }
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    const label = temp ? `${parse(n).name}.png` : n;
    items.push({ label, text: "", path, temp, size });
  }
  const running: Promise<void>[] = [];
  for (const it of items) {
    const t = newDeviceTransfer({ label: `${it.label} → ${to}`, size: it.size, waiting: isPhoneDevice(dev) });
    transfers.push(t);
    const report = (sent: number, done: boolean, error: string | null): void => {
      t.waiting = false;
      t.sent = sent;
      t.done = done;
      t.error = error;
      env.wake?.();
    };
    if (isPhoneDevice(dev)) {
      if (!env.hub) continue;
      const parcel: Parcel = { id: randomBytes(8).toString("hex"), group: deviceGroup(dev), kind, name: it.label, text: it.text, path: it.path, temp: it.temp, size: it.size, at: (env.clock ?? (() => performance.now()))(), report };
      env.hub.post(parcel);
    } else {
      running.push(
        deviceSendToPc(env, dev.key, kind, it.label, it.text, it.path).then(
          () => report(it.size, true, null),
          (e: unknown) => report(0, false, msg(e)),
        ).finally(() => {
          if (it.temp && it.path !== null) rmSync(it.path, { force: true });
        }),
      );
    }
  }
  env.wake?.();
  await Promise.all(running);
}


/** What a PC does with what another PC delivers. */
export interface DeliverSink {
  /** The Downloads folder files land in. */
  downloads(): Promise<string> | string;
  home: string;
  copyText(text: string): void;
  copyImage(bytes: Buffer): void;
  /** Opens an image file (xdg-open). */
  open(path: string): void;
  /** A desktop notification. */
  notify(title: string, body: string): void;
  /** Reads the request's body: exactly `len` bytes, at most `max`; throws when short or too large. */
  read(len: number, max: number): Promise<Buffer>;
}

/** Whether bytes start like an image the clipboard can take (image::guess_format's common formats). */
export function deviceGuessImage(b: Uint8Array): boolean {
  const s = (o: number, t: string) => Buffer.from(b.subarray(o, o + t.length)).toString("latin1") === t;
  return (
    s(0, "\x89PNG\r\n\x1a\n") ||
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
    s(0, "GIF87a") ||
    s(0, "GIF89a") ||
    (s(0, "RIFF") && s(8, "WEBP")) ||
    s(0, "BM") ||
    s(0, "II*\0") ||
    s(0, "MM\0*") ||
    s(0, "\0\0\x01\0")
  );
}

/** What a paired PC sent this one (`POST /mesh/v1/deliver` from `from`): text or an image onto the clipboard, an image saved to Downloads and opened, a file saved to Downloads; each with a desktop notification. */
export async function receiveDelivery(from: string, kind: string, name: string, len: number, sink: DeliverSink): Promise<Reply> {
  if (len > DEVICE_SEND_MAX) return err(413, "files up to 200 MB");
  if (kind === "text" || kind === "clip-image") {
    let bytes: Buffer;
    try {
      bytes = await sink.read(len, kind === "text" ? 4 << 20 : 64 << 20);
    } catch {
      return err(400, "short or too large");
    }
    if (kind === "text") {
      sink.copyText(bytes.toString("utf8"));
      sink.notify("Copied to clipboard", `Text from ${from}`);
    } else {
      if (!deviceGuessImage(bytes)) return err(400, "not an image");
      sink.copyImage(bytes);
      sink.notify("Copied to clipboard", `Image from ${from}`);
    }
  } else if (kind === "image" || kind === "file") {
    const dir = await sink.downloads();
    mkdirSync(dir, { recursive: true });
    const to = freeFileName(dir, safeName(name));
    const part = join(dirname(to), `.${basename(to)}.part`);
    try {
      const bytes = await sink.read(len, DEVICE_SEND_MAX);
      if (bytes.length !== len) throw new Error("short body");
      writeFileSync(part, bytes);
      renameSync(part, to);
    } catch (e) {
      rmSync(part, { force: true });
      return err(500, `couldn't save it: ${msg(e)}`);
    }
    if (kind === "image") sink.open(to);
    sink.notify(`From ${from}`, `${basename(to)}, in ${tildeOf(sink.home, dir)}`);
  } else return err(400, "unknown kind");
  return ok({ ok: true });
}


export interface FileBrowseEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

/** Lists a folder on the PC (python3: Harbor's PCs run Linux). */
export const DEVICE_LS_PY = `import os,sys,json
p=os.path.abspath(os.path.expanduser(sys.argv[1] if len(sys.argv)>1 else "~"))
out=[]
for e in os.scandir(p):
    try:
        st=e.stat(); d=e.is_dir()
    except OSError:
        st=None; d=False
    out.append([e.name,d,st.st_size if st else 0,int(st.st_mtime) if st else 0])
print(json.dumps({"path":p,"entries":out}))`;

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** The listing the PC printed: its path and entries, folders first, then by name. */
export function deviceParseListing(stdout: Uint8Array): { path: string; entries: FileBrowseEntry[] } {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(stdout).toString("utf8"));
  } catch {
    throw new Error("unexpected answer");
  }
  const o: Record<string, unknown> = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const list = Array.isArray(o.entries) ? (o.entries as unknown[]) : [];
  const entries = list.map((e): FileBrowseEntry => {
    const a = Array.isArray(e) ? (e as unknown[]) : [];
    const u = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : 0);
    return { name: typeof a[0] === "string" ? a[0] : "", dir: a[1] === true, size: u(a[2]), mtime: typeof a[3] === "number" && Number.isInteger(a[3]) ? a[3] : 0 };
  });
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || byteCmp(a.name.toLowerCase(), b.name.toLowerCase()));
  return { path: typeof o.path === "string" ? o.path : "/", entries };
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

/** images.rs `is_image`. */
export function deviceIsImage(name: string): boolean {
  const e = parse(name).ext.slice(1).toLowerCase();
  return IMAGE_EXTS.includes(e);
}

/** The part of an error after its last ": " (ssh prefixes the host and the program). */
function afterLastColon(s: string): string {
  const i = s.lastIndexOf(": ");
  return i < 0 ? s : s.slice(i + 2);
}

function lines(b: string): string[] {
  const l = b.split(/\r?\n/);
  if (l[l.length - 1] === "") l.pop();
  return l;
}

/** How the browser starts ssh: the options and destination come first. */
export type SshSpawn = (args: string[], stdin: "ignore" | "pipe", stdout: "ignore" | "pipe") => ChildProcess;

export const spawnSsh: SshSpawn = (args, stdin, stdout) => spawn("ssh", args, { stdio: [stdin, stdout, "pipe"] });

export interface FileBrowserEnv {
  home: string;
  spawn?: SshSpawn;
  downloads(): Promise<string> | string;
  /** XDG_CACHE_HOME, else ~/.cache. */
  cacheHome?: string;
  wake?: () => void;
}

/** Where a remote file's preview is kept: one folder per device, one file per (path, mtime). */
export function previewCachePath(cacheHome: string, deviceKey: string, remote: string, mtime: number): string {
  const t = Buffer.alloc(8);
  t.writeBigInt64LE(BigInt(mtime));
  const h = sip13(Buffer.concat([Buffer.from(remote), Uint8Array.of(0xff), t]));
  const ext = parse(remote).ext.slice(1).toLowerCase();
  return join(cacheHome, "harbor/devices", deviceDirName(deviceKey), `${h.toString(16).padStart(16, "0")}.${ext}`);
}

function partPath(to: string): string {
  return `${to}.part`;
}

function collect(c: ChildProcess): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    c.stdout?.on("data", (d: Buffer) => out.push(d));
    c.stderr?.on("data", (d: Buffer) => err.push(d));
    c.once("error", reject);
    c.once("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

/** A PC's files over ssh: listing, previews of images, downloads and uploads, each tracked as a transfer. */
export class FileBrowser {
  entries: FileBrowseEntry[] = [];
  loading = false;
  error: string | null = null;
  showHidden = false;
  history: string[] = [];
  path: string;
  transfers: DeviceTransfer[] = [];
  /** Remote path to the local copy of an image, or why there is none. */
  previews = new Map<string, { path: string } | { error: string }>();
  queued: [string, number, number][] = [];
  fetching = new Set<string>();
  private pending = new Set<Promise<void>>();

  constructor(
    readonly dev: PairedDevice,
    /** ssh's options and destination for it (deviceSshArgs). */
    readonly ssh: string[],
    path: string | null,
    readonly env: FileBrowserEnv,
  ) {
    this.path = path ?? "~";
    this.list(this.path);
  }

  title(): string {
    return `${this.dev.name} files`;
  }

  /** Resolves when everything started so far has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private child(cmd: string, stdin: "ignore" | "pipe", stdout: "ignore" | "pipe"): ChildProcess {
    return (this.env.spawn ?? spawnSsh)([...this.ssh, deviceShCmd(cmd)], stdin, stdout);
  }

  list(path: string): void {
    this.loading = true;
    this.track(this.listing(path));
  }

  private async listing(path: string): Promise<void> {
    try {
      const o = await collect(this.child(`python3 -c ${shQuote(DEVICE_LS_PY)} ${shQuote(path)}`, "ignore", "pipe"));
      if (o.code !== 0) {
        const last = lines(o.stderr).reverse().find((l) => l.trim() !== "")?.trim() ?? "can't list it";
        throw new Error(afterLastColon(last));
      }
      const r = deviceParseListing(o.stdout);
      this.loading = false;
      this.error = null;
      this.path = r.path;
      this.entries = r.entries;
      this.queued = [];
    } catch (e) {
      this.loading = false;
      this.error = msg(e);
      // Stay where we were.
      const p = this.history.pop();
      if (p !== undefined) this.path = p;
    }
    this.env.wake?.();
  }

  go(path: string): void {
    if (this.path !== "") this.history.push(this.path);
    this.list(path);
  }

  back(): void {
    const p = this.history.pop();
    if (p !== undefined) this.list(p);
  }

  join(name: string): string {
    return this.path.endsWith("/") ? `${this.path}${name}` : `${this.path}/${name}`;
  }

  /** The folder above (null at the root). */
  parent(): string | null {
    const p = this.path.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
    if (p === "/") return null;
    const i = p.lastIndexOf("/");
    if (i < 0) return "";
    return i === 0 ? "/" : p.slice(0, i);
  }

  /** The entries shown: hidden ones only when asked. */
  shown(): FileBrowseEntry[] {
    return this.entries.filter((e) => this.showHidden || !e.name.startsWith("."));
  }

  /** A remote file to `to` (Downloads, or the preview cache), with progress when `track`. */
  download(remote: string, size: number, to: string, track: boolean): void {
    let t: DeviceTransfer | null = null;
    if (track) {
      t = newDeviceTransfer({ label: `${basename(remote)} ← ${this.dev.name}`, size });
      this.transfers.push(t);
    }
    this.track(this.fetch(remote, to, t));
  }

  private async fetch(remote: string, to: string, t: DeviceTransfer | null): Promise<void> {
    const part = partPath(to);
    let result: { path: string } | { error: string };
    try {
      mkdirSync(dirname(to), { recursive: true });
      const c = this.child(`cat -- ${shQuote(remote)}`, "ignore", "pipe");
      const errs: Buffer[] = [];
      c.stderr?.on("data", (d: Buffer) => errs.push(d));
      const file = createWriteStream(part);
      const fileDone = new Promise<void>((resolve, reject) => {
        file.once("close", resolve);
        file.once("error", reject);
      });
      fileDone.catch(() => undefined);
      const closed = new Promise<number | null>((resolve, reject) => {
        c.once("error", reject);
        c.once("close", resolve);
      });
      let sent = 0;
      let tick = Date.now();
      let tooBig = false;
      c.stdout?.on("data", (d: Buffer) => {
        if (tooBig) return;
        sent += d.length;
        // A preview stops at its cap, whatever size the listing claimed.
        if (t === null && sent > DEVICE_PREVIEW_MAX) {
          tooBig = true;
          c.kill();
          return;
        }
        file.write(d);
        if (t !== null && Date.now() - tick > 100) {
          tick = Date.now();
          t.sent = sent;
          this.env.wake?.();
        }
      });
      const code = await closed;
      file.end();
      await fileDone;
      if (tooBig) {
        rmSync(part, { force: true });
        result = { error: "too big to preview" };
      } else if (code !== 0) {
        rmSync(part, { force: true });
        const last = lines(Buffer.concat(errs).toString("utf8")).pop() ?? "download failed";
        result = { error: afterLastColon(last) };
      } else {
        renameSync(part, to);
        result = { path: to };
      }
    } catch (e) {
      rmSync(part, { force: true });
      result = { error: msg(e) };
    }
    if (t !== null) {
      if ("path" in result) {
        t.done = true;
        t.sent = t.size;
        t.saved = result.path;
      } else t.error = result.error;
    } else {
      this.fetching.delete(remote);
      this.previews.set(remote, result);
    }
    this.env.wake?.();
  }

  /** Local files into the folder being shown (not opened there: a plain copy). */
  upload(files: string[]): void {
    const taken = new Set(this.entries.map((e) => e.name));
    for (const f of files) {
      if (!statSync(f, { throwIfNoEntry: false })?.isFile()) continue;
      const name = basename(f);
      const dot = name.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      let there = name;
      for (let n = 2; taken.has(there); n++) there = `${stem} (${n})${ext}`;
      const dest = this.join(there);
      const size = statSync(f).size;
      const t = newDeviceTransfer({ label: `${name} → ${this.dev.name}`, size });
      this.transfers.push(t);
      this.track(this.send(f, dest, t));
    }
  }

  private async send(file: string, dest: string, t: DeviceTransfer): Promise<void> {
    try {
      const c = this.child(`cat > ${shQuote(`${dest}.part`)} && mv -f ${shQuote(`${dest}.part`)} ${shQuote(dest)}`, "pipe", "ignore");
      const errs: Buffer[] = [];
      c.stderr?.on("data", (d: Buffer) => errs.push(d));
      const closed = new Promise<number | null>((resolve, reject) => {
        c.once("error", reject);
        c.once("close", resolve);
      });
      c.stdin?.on("error", () => undefined);
      const src = readFileSync(file);
      let sent = 0;
      let tick = Date.now();
      const chunk = 1 << 16;
      for (let i = 0; i < src.length; i += chunk) {
        const part = src.subarray(i, i + chunk);
        if (!c.stdin || c.stdin.destroyed || !c.stdin.write(part)) await new Promise<void>((r) => (c.stdin && !c.stdin.destroyed ? c.stdin.once("drain", r) : r()));
        sent += part.length;
        if (Date.now() - tick > 100) {
          tick = Date.now();
          t.sent = sent;
          this.env.wake?.();
        }
      }
      c.stdin?.end();
      const code = await closed;
      if (code !== 0) throw new Error(lines(Buffer.concat(errs).toString("utf8")).pop() ?? "upload failed");
      t.done = true;
      t.sent = t.size;
    } catch (e) {
      t.error = msg(e);
    }
    this.list(this.path);
    this.env.wake?.();
  }

  private cacheFile(remote: string, mtime: number): string {
    return previewCachePath(this.env.cacheHome ?? join(this.env.home, ".cache"), this.dev.key, remote, mtime);
  }

  /** The local copy of a remote image, queueing its fetch when needed (null until it is there). */
  preview(remote: string, size: number, mtime: number): string | null {
    const known = this.previews.get(remote);
    if (known) return "path" in known ? known.path : null;
    const local = this.cacheFile(remote, mtime);
    if (statSync(local, { throwIfNoEntry: false })?.isFile()) {
      this.previews.set(remote, { path: local });
      return local;
    }
    if (size <= DEVICE_PREVIEW_MAX && !this.fetching.has(remote) && !this.queued.some((q) => q[0] === remote)) this.queued.push([remote, size, mtime]);
    return null;
  }

  /** Starts queued preview fetches, two at a time. */
  pumpPreviews(): void {
    while (this.fetching.size < 2) {
      const q = this.queued.shift();
      if (!q) break;
      this.fetching.add(q[0]);
      this.download(q[0], q[1], this.cacheFile(q[0], q[2]), false);
    }
  }

  /** A click on an entry: a folder opens, an image with a local copy returns that path (to show), anything else downloads to Downloads. */
  async click(e: FileBrowseEntry): Promise<string | null> {
    const remote = this.join(e.name);
    const image = !e.dir && deviceIsImage(e.name);
    if (e.dir) {
      this.go(remote);
      return null;
    }
    const local = image ? this.preview(remote, e.size, e.mtime) : null;
    if (local !== null) return local;
    if (!image) await this.downloadToDownloads(remote, e.size);
    return null;
  }

  /** The download button: the file lands in Downloads under a free name. */
  async downloadToDownloads(remote: string, size: number): Promise<void> {
    const name = basename(remote);
    const to = freeFileName(await this.env.downloads(), name === "" ? "file" : name);
    this.download(remote, size, to, true);
  }
}
