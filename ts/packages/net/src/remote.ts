import { paths as osPaths } from "@harbor/os";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseIp, type Ip } from "./ip.ts";
import type { Kv } from "./kv.ts";
import { label as peerLabel, socketAddr, type Allowed, type Peer } from "./shared.ts";
import { tailnetIp } from "./tls.ts";

const REFRESH_MS = 15_000;
const CONFIG_MS = 10_000;
const NEARBY_MS = 60_000;
const KEY = "remote_devices";

/** The line a remote turn ends with when the agent exits (detach.rs `REMOTE_EXIT`). */
export const REMOTE_EXIT = "harbor_exit";

/** The argument `remoteLaunch` turns into the path of the file `{ kind: "mcp" }` wrote. */
export const MCP_CONFIG_ARG = "@harbor-mcp-config";


export interface RunOutput {
  /** null: ended by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program with no stdin and returns what it printed; rejects when it can't start. */
export type Runner = (program: string, args: string[]) => Promise<RunOutput>;

export const systemRunner: Runner = (program, args) =>
  new Promise((resolve, reject) => {
    const c = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    c.stdout.on("data", (d: Buffer) => out.push(d));
    c.stderr.on("data", (d: Buffer) => err.push(d));
    c.once("error", reject);
    c.once("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });

export interface RemoteCommand {
  program: string;
  args: string[];
}


/** Rust's format!: `{name}` is a variable, `{{` and `}}` are braces. */
function fmt(t: string, v: Record<string, string> = {}): string {
  return t.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, k: string | undefined) => (m === "{{" ? "{" : m === "}}" ? "}" : k !== undefined ? (v[k] ?? m) : m));
}

const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const eqi = (a: string, b: string) => lower(a) === lower(b);
const cmpStr = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const base64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64");

/** An IP the way Rust's `IpAddr::from_str` takes it: no brackets, no zone. */
function strictIp(s: string): Ip | null {
  return /[[\]%]/.test(s) ? null : parseIp(s);
}

function splitOnce(s: string, sep: string): [string, string] | null {
  const i = s.indexOf(sep);
  return i < 0 ? null : [s.slice(0, i), s.slice(i + sep.length)];
}

/** A first label, lower case ("work-laptop" for "Work-Laptop.local"). */
function firstLabel(s: string): string {
  return lower(s.trim().split(".")[0] ?? "");
}

function get(v: unknown, k: string): unknown {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");


/** One device. Serialized fields and order match remote.rs's `Host` in kv `remote_devices`. */
export interface RemoteHost {
  /** A paired PC's peer id ("ts:<name>" before 0.13, "pc:<name>"), a Tailscale peer's "ts:<MagicDNS label>", or "ssh:<n>" for hosts added by hand. */
  id: string;
  /** Shown name; empty: the address. */
  name: string;
  /** What ssh connects to: an IP, a name or a ~/.ssh/config alias (found PCs: through `harbor nc`). */
  host: string;
  user: string;
  port: number;
  /** "" (by OS), a built-in icon name or "file" (a copied image). */
  icon: string;
  /** Folder agents start in. Empty: a project's path relative to home, mirrored on the device, or ~ without one. */
  dir: string;
  bridge: boolean;
  commands: boolean;
  device_files: boolean;
  hidden: boolean;
  /** "linux", "macOS", "windows", "freebsd"…; empty until known (a POSIX shell is assumed). */
  os: string;
  /** A found PC's other names (its IPs and machine name), for ~/.ssh/config. Not stored. */
  aka: string[];
}

export function newHost(p: Partial<RemoteHost> = {}): RemoteHost {
  return { id: "", name: "", host: "", user: "", port: 0, icon: "", dir: "", bridge: false, commands: false, device_files: false, hidden: false, os: "", aka: [], ...p };
}

/** Settings › Workspace, stored as JSON in the kv table. */
export interface RemoteConfig {
  /** Before 0.14: "connect through Tailscale"; kept so old settings read. */
  tailscale: boolean;
  user: string;
  key: string;
  port: number;
  devices: RemoteHost[];
}

export function newConfig(p: Partial<RemoteConfig> = {}): RemoteConfig {
  return { tailscale: true, user: "", key: "", port: 0, devices: [], ...p };
}

export function hostLabel(h: RemoteHost): string {
  if (h.name !== "") return h.name;
  if (isFound(h)) return splitOnce(h.id, ":")?.[1] ?? h.host;
  return h.host;
}

/** A PC Harbor found (paired, or on Tailscale), not one added by hand. */
export function isFound(h: RemoteHost): boolean {
  return h.id.startsWith("ts:") || h.id.startsWith("pc:");
}

/** Built-in icons a device can wear: name, glyph. */
export const ICONS: readonly (readonly [string, string])[] = [
  ["monitor", "\u{e11d}"],
  ["laptop", "\u{e1cd}"],
  ["terminal", "\u{e181}"],
  ["house", "\u{e0f5}"],
  ["globe", "\u{e0e8}"],
  ["bot", "\u{e1bb}"],
  ["hammer", "\u{e0ec}"],
  ["gauge", "\u{e1bf}"],
];

/** The glyph a device shows when it has no image. */
export function glyph(h: RemoteHost): string {
  const named = ICONS.find(([n]) => n === h.icon);
  if (named) return named[1];
  if (h.os === "macOS") return "\u{e1cd}";
  if (h.os === "" && !isFound(h)) return "\u{e181}";
  return "\u{e11d}";
}

/** The OS as shown: "Linux", "macOS", "Windows", "FreeBSD"… */
export function osLabel(os: string): string {
  switch (os) {
    case "linux":
      return "Linux";
    case "windows":
      return "Windows";
    case "freebsd":
      return "FreeBSD";
    case "openbsd":
      return "OpenBSD";
    default:
      return os;
  }
}

/** How a device's shell is spoken to. */
export type ShellFamily = "posix" | "windows";

export function shellFamily(os: string): ShellFamily {
  return eqi(os, "windows") ? "windows" : "posix";
}

/** The OS word for what a device says of itself: `uname -s` ("Darwin", "Linux"…) or the Windows probe's "Windows". */
export function osFrom(sys: string): string {
  const w = sys.trim().split(/\s+/)[0] ?? "";
  if (w === "") return "";
  if (w === "Darwin") return "macOS";
  if (eqi(w, "windows") || w.startsWith("MINGW") || w.startsWith("MSYS") || w.startsWith("CYGWIN")) return "windows";
  return lower(w);
}

/** Where a device's custom image is copied to. */
export function iconPath(dataDir: string, id: string): string {
  const safe = [...id].map((c) => (/^[A-Za-z0-9-]$/.test(c) ? c : "_")).join("");
  return join(dataDir, "devices", safe);
}

/** This PC's name, as other devices know it. */
export function hostname(read: (path: string) => string | null = readText): string {
  const t = (read("/etc/hostname") ?? "").trim();
  return t !== "" ? t : "this PC";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseHost(v: unknown): RemoteHost {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not a device");
  const o = v as Record<string, unknown>;
  const s = (k: string, required = false): string => {
    const x = o[k];
    if (x === undefined && !required) return "";
    if (typeof x !== "string") throw new Error(k);
    return x;
  };
  const b = (k: string, d: boolean): boolean => {
    const x = o[k];
    if (x === undefined) return d;
    if (typeof x !== "boolean") throw new Error(k);
    return x;
  };
  return newHost({
    id: s("id", true),
    name: s("name"),
    host: s("host"),
    user: s("user"),
    port: port(o.port),
    icon: s("icon"),
    dir: s("dir"),
    bridge: b("bridge", true),
    commands: b("commands", false),
    device_files: b("device_files", false),
    hidden: b("hidden", false),
    os: s("os"),
  });
}

function port(x: unknown): number {
  if (x === undefined) return 0;
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 65535) throw new Error("port");
  return x;
}

/** The settings in kv; defaults when missing or unreadable (serde's all-or-nothing). */
export function loadRemote(kv: Kv): RemoteConfig {
  const t = kv.get(KEY);
  if (t === null) return newConfig();
  try {
    const v: unknown = JSON.parse(t);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return newConfig();
    const o = v as Record<string, unknown>;
    const str = (k: string): string => {
      const x = o[k];
      if (x === undefined) return "";
      if (typeof x !== "string") throw new Error(k);
      return x;
    };
    const ts = o.tailscale;
    const devs = o.devices;
    if (ts !== undefined && typeof ts !== "boolean") return newConfig();
    if (devs !== undefined && !Array.isArray(devs)) return newConfig();
    return {
      tailscale: ts ?? true,
      user: str("user"),
      key: str("key"),
      port: port(o.port),
      devices: ((devs as unknown[] | undefined) ?? []).map(parseHost),
    };
  } catch {
    return newConfig();
  }
}

export function saveRemote(kv: Kv, c: RemoteConfig): void {
  const devices = c.devices.map((h) => ({ id: h.id, name: h.name, host: h.host, user: h.user, port: h.port, icon: h.icon, dir: h.dir, bridge: h.bridge, commands: h.commands, device_files: h.device_files, hidden: h.hidden, os: h.os }));
  kv.set(KEY, JSON.stringify({ tailscale: c.tailscale, user: c.user, key: c.key, port: c.port, devices }));
}


/** A PC of the tailnet or paired with this Harbor (remote.rs `Peer`). */
export interface TailPeer {
  id: string;
  name: string;
  dns: string;
  ip: string;
  ips: string[];
  host_name: string;
  os: string;
  online: boolean;
}

export function newTailPeer(p: Partial<TailPeer> = {}): TailPeer {
  return { id: "", name: "", dns: "", ip: "", ips: [], host_name: "", os: "", online: false, ...p };
}

export interface Tailnet {
  installed: boolean;
  /** BackendState: "Running", "Stopped", "NeedsLogin"…; empty if it didn't answer. */
  state: string;
  me: string;
  peers: TailPeer[];
}

export function newTailnet(p: Partial<Tailnet> = {}): Tailnet {
  return { installed: false, state: "", me: "", peers: [], ...p };
}

/** Tailscale's OS names for machines that can run agents (phones can't). */
function isPc(os: string): boolean {
  return ["linux", "macOS", "windows", "freebsd", "openbsd"].includes(os);
}

/** Parses `tailscale status --json`: the PCs among the peers. */
export function parseTailscaleStatus(v: unknown): Tailnet {
  const peerMap = get(v, "Peer");
  // serde_json keeps object keys sorted.
  const entries: unknown[] = typeof peerMap === "object" && peerMap !== null && !Array.isArray(peerMap) ? Object.keys(peerMap).sort(cmpStr).map((k) => (peerMap as Record<string, unknown>)[k]) : [];
  const found: TailPeer[] = entries
    .filter((p) => isPc(text(get(p, "OS"))))
    .map((p) => {
      const dns = text(get(p, "DNSName")).replace(/\.+$/, "");
      const lbl = dns.split(".")[0] ?? "";
      const rawIps = get(p, "TailscaleIPs");
      const ips = Array.isArray(rawIps) ? rawIps.filter((x): x is string => typeof x === "string") : [];
      const name = text(get(p, "HostName"));
      return {
        id: `ts:${lbl === "" ? name : lbl}`,
        name: lbl === "" ? name : lbl,
        dns,
        ip: ips[0] ?? "",
        ips,
        host_name: name,
        os: text(get(p, "OS")),
        online: get(p, "Online") === true,
      };
    });
  // Two peers with one id: the one in this PC's own tailnet keeps it, the others go by full DNS
  // name, one without isn't offered. Never the first that matches.
  const selfDns = text(get(get(v, "Self"), "DNSName"));
  const mine = splitOnce(selfDns.replace(/\.+$/, ""), ".")?.[1] ?? "";
  const own = (p: TailPeer) => mine !== "" && splitOnce(p.dns, ".")?.[1] === mine;
  const peers: TailPeer[] = [];
  for (const p of found) {
    const keep = found.filter((q) => q.id === p.id).length === 1 || (own(p) && found.filter((q) => q.id === p.id && own(q)).length === 1);
    if (keep) {
      peers.push(p);
      continue;
    }
    if (p.dns === "") continue;
    peers.push({ ...p, id: `ts:${p.dns}` });
  }
  peers.sort((a, b) => Number(b.online) - Number(a.online) || cmpStr(a.name, b.name));
  return { installed: true, state: text(get(v, "BackendState")), me: selfDns.split(".")[0] ?? "", peers };
}

/** The PCs paired with this Harbor (keys on the allowed list), with what the mesh knows of them. */
export function pairedPcs(allowed: Allowed[], peers: Map<string, Peer>): TailPeer[] {
  return allowed
    .filter((a) => a.fp !== "" && a.id !== "")
    .map((a) => {
      const p = peers.get(a.id);
      const ips: string[] = [];
      for (const x of [...a.addrs, ...(p?.addrs ?? [])]) {
        const ip = socketAddr(x)?.ip;
        if (ip !== undefined && ips[ips.length - 1] !== ip) ips.push(ip);
      }
      // The network's address first: ssh shows it, `harbor nc` tries them all.
      const sorted = ips.map((ip, i) => ({ ip, i, t: tailnetIp(ip) ? 1 : 0 })).sort((x, y) => x.t - y.t || x.i - y.i).map((x) => x.ip);
      return {
        id: a.id,
        name: a.name === "" ? peerLabel(a.id) : a.name,
        dns: "",
        ip: sorted[0] ?? "",
        ips: sorted,
        host_name: peerLabel(a.id),
        os: "linux",
        online: p?.online ?? false,
      };
    });
}

function aka(p: TailPeer): string[] {
  return [...p.ips, ...[p.dns, p.name, p.host_name].filter((s) => s !== "")];
}


/** POSIX shell quoting (ssh joins its arguments into one remote command line). */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** A remote path for the shell: a leading ~ stays expandable. */
export function shellPath(p: string): string {
  if (p === "~" || p === "") return '"$HOME"';
  if (p.startsWith("~/")) return `"$HOME"/${shQuote(p.slice(2))}`;
  return shQuote(p);
}

/** What the ssh helpers need from the PC they run on. */
export interface RemoteCtx {
  home: string;
  /** This Harbor's executable, for `harbor nc`. */
  selfExe(): string | null;
  sshConfig(): SshEntry[];
  probe(id: string): RemoteProbe | undefined;
}

function expand(ctx: RemoteCtx, p: string): string {
  return p.startsWith("~/") ? join(ctx.home, p.slice(2)) : p;
}

/** ssh's options for a device, up to (not including) the destination. */
export function sshOpts(ctx: RemoteCtx, cfg: RemoteConfig, h: RemoteHost): string[] {
  const v = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"];
  // Its own connection (no ControlMaster): its port forward lives and dies with it.
  v.push("-o", "ControlMaster=no", "-o", "ControlPath=none");
  // PCs Harbor found go through `harbor nc`: their network address, or another paired PC.
  if (isFound(h)) {
    const exe = ctx.selfExe();
    if (exe !== null) v.push("-o", `ProxyCommand=${shQuote(exe)} nc --device ${shQuote(h.id)} %h %p`);
  }
  const found = sshConfigEntry(ctx, h);
  const p = sshPort(ctx, cfg, h);
  if (p !== 0) v.push("-p", String(p));
  if (cfg.key.trim() !== "") v.push("-i", expand(ctx, cfg.key.trim()), "-o", "IdentitiesOnly=yes");
  else if (found !== null && found.key !== "") v.push("-i", expand(ctx, found.key));
  const user = sshLogin(ctx, cfg, h)?.[0] ?? "";
  if (user !== "") v.push("-l", user);
  return v;
}

/** The port ssh connects to (0: its default). */
export function sshPort(ctx: RemoteCtx, cfg: RemoteConfig, h: RemoteHost): number {
  return [h.port, cfg.port].find((p) => p !== 0) ?? sshConfigEntry(ctx, h)?.port ?? 0;
}

/** The user ssh logs in as and whether it comes from ~/.ssh/config (null: ssh's default). */
export function sshLogin(ctx: RemoteCtx, cfg: RemoteConfig, h: RemoteHost): [string, boolean] | null {
  const own = [h.user.trim(), cfg.user.trim()].find((u) => u !== "");
  if (own !== undefined) return [own, false];
  const u = sshConfigEntry(ctx, h)?.user ?? "";
  return u !== "" ? [u, true] : null;
}


/** A `Host` block of ~/.ssh/config: what Harbor borrows when it connects by another name. */
export interface SshEntry {
  aliases: string[];
  host_name: string;
  user: string;
  port: number;
  key: string;
}

/** Parses ssh_config text: `Host` blocks with plain aliases (wildcard patterns are skipped), following `Include` of plain files through `read` (path relative to ~/.ssh). */
export function parseRemoteSshConfig(src: string, read: (file: string) => string | null, depth = 0): SshEntry[] {
  const out: SshEntry[] = [];
  let cur: SshEntry | null = null;
  const push = () => {
    const e = cur;
    cur = null;
    if (e && e.aliases.length > 0) {
      if (e.host_name === "") e.host_name = e.aliases[0] ?? "";
      out.push(e);
    }
  };
  const trimQuotes = (s: string) => s.replace(/^"+|"+$/g, "");
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.search(/[\s=]/);
    const k = m < 0 ? line : line.slice(0, m);
    const rest = (m < 0 ? "" : line.slice(m)).replace(/^[\s=]+/, "").trim();
    const val = trimQuotes(rest.split(/\s+/)[0] ?? "");
    const words = rest.split(/\s+/).filter((w) => w !== "");
    switch (lower(k)) {
      case "host":
        push();
        cur = { aliases: words.map(trimQuotes).filter((a) => !/[*?!]/.test(a)), host_name: "", user: "", port: 0, key: "" };
        break;
      case "match":
        push();
        break;
      case "include":
        if (depth < 4) {
          push();
          for (const f of words.filter((w) => !/[*?]/.test(w))) {
            const t = read(f);
            if (t !== null) out.push(...parseRemoteSshConfig(t, read, depth + 1));
          }
        } else cur = optionOf(cur, lower(k), val);
        break;
      default:
        cur = optionOf(cur, lower(k), val);
    }
  }
  push();
  return out;
}

/** The first value of an option wins, as in ssh. */
function optionOf(e: SshEntry | null, key: string, val: string): SshEntry | null {
  if (!e) return e;
  if (key === "hostname" && e.host_name === "") e.host_name = val;
  else if (key === "user" && e.user === "") e.user = val;
  else if (key === "port" && e.port === 0) e.port = /^\+?\d+$/.test(val) && Number(val) <= 65535 ? Number(val) : 0;
  else if (key === "identityfile" && e.key === "") e.key = val;
  return e;
}

/** The first entry whose HostName (or alias) is one of `names`. */
export function matchSshEntry(entries: SshEntry[], names: string[]): SshEntry | null {
  const is = (s: string) => names.some((n) => n !== "" && eqi(n, s));
  return entries.find((e) => is(e.host_name)) ?? entries.find((e) => e.aliases.some(is)) ?? null;
}

/** The ~/.ssh/config entry for a device dialed by a name ssh wouldn't match it under. */
export function sshConfigEntry(ctx: RemoteCtx, h: RemoteHost): SshEntry | null {
  const names = [h.host.trim(), ...h.aka, h.host.split(".")[0] ?? ""];
  return matchSshEntry(ctx.sshConfig(), names);
}


/** Every device: the configured ones, then found PCs not configured yet (with defaults). Each with whether it's online (null: unknown, an SSH host never tested). */
export function remoteDevices(ctx: RemoteCtx, cfg: RemoteConfig, net: Tailnet): [RemoteHost, boolean | null][] {
  const v: [RemoteHost, boolean | null][] = cfg.devices.map((h) => {
    const peer = net.peers.find((p) => p.id === h.id);
    const online = peer ? peer.online : (ctx.probe(h.id)?.ok ?? null);
    // An OS just found by a test shows before the settings take it.
    const os = h.os === "" ? (ctx.probe(h.id)?.os ?? "") : h.os;
    return [{ ...h, aka: peer ? aka(peer) : [], os }, online];
  });
  // A Tailscale peer that is a device added by hand (the same machine) shows once, as that.
  const byHand = cfg.devices
    .filter((h) => !isFound(h))
    .flatMap((h) => [firstLabel(h.host), firstLabel(sshConfigEntry(ctx, h)?.host_name ?? "")])
    .filter((n) => n !== "");
  for (const p of net.peers) {
    const added = p.id.startsWith("ts:") && [p.name, p.host_name, p.dns].some((n) => n !== "" && byHand.includes(firstLabel(n)));
    if (!cfg.devices.some((h) => h.id === p.id) && !added) {
      const host = newHost({ id: p.id, host: p.dns === "" ? p.ip : p.dns, name: p.dns === "" ? p.name : "", os: p.os, bridge: true, aka: aka(p) });
      v.push([host, p.online]);
    }
  }
  return v;
}

/** A device by id, configured or discovered. */
export function findDevice(ctx: RemoteCtx, cfg: RemoteConfig, net: Tailnet, id: string): RemoteHost | null {
  return remoteDevices(ctx, cfg, net).map(([h]) => h).find((h) => h.id === id) ?? null;
}


/** An address that only answers while Tailscale runs: a MagicDNS name or a 100.64/10 IP. */
function tailnetOnly(host: string): boolean {
  const h = host.trim().replace(/\.+$/, "");
  return h.endsWith(".ts.net") || (strictIp(h) !== null && tailnetIp(h));
}

/** The allowed PC a device or host name stands for (relay.rs `find_pc`). */
function findPc(list: Allowed[], device: string, host: string): Allowed | null {
  const lbl = host.split(".")[0] ?? host;
  const ip = strictIp(host.replace(/^\[/, "").replace(/\]$/, ""));
  return (
    list
      .filter((a) => a.fp !== "")
      .find(
        (a) =>
          (device !== "" && a.id === device) ||
          (a.id !== "" && a.id === host) ||
          eqi(a.name, lbl) ||
          eqi(peerLabel(a.id), lbl) ||
          (ip !== null && a.addrs.some((x) => {
            const s = socketAddr(x);
            const p = s ? parseIp(s.ip) : null;
            return p !== null && p.v === ip.v && p.b.every((b, i) => b === ip.b[i]);
          })),
      ) ?? null
  );
}

/** Moves old Tailscale-only devices onto the ssh alias of the same machine (existing or new device); returns [old id, new id] for pinned chats. */
export function migrateDevices(cfg: RemoteConfig, allowed: Allowed[], entries: SshEntry[]): [string, string][] {
  const moved: [string, string][] = [];
  const old = cfg.devices.filter((h) => h.id.startsWith("ts:") && tailnetOnly(h.host) && findPc(allowed, h.id, "") === null);
  for (const h of old) {
    const names = [firstLabel(h.id.replace(/^(ts:)+/, "")), firstLabel(h.host)].filter((n) => n !== "");
    const is = (e: SshEntry) => !tailnetOnly(e.host_name) && (names.includes(firstLabel(e.host_name)) || e.aliases.some((a) => names.includes(lower(a))));
    const e = entries.find(is);
    if (!e) continue;
    // A device already added for it (by the alias, its HostName or the machine name).
    const same = (d: RemoteHost) => !isFound(d) && (e.aliases.some((a) => eqi(a, d.host.trim())) || firstLabel(d.host) === firstLabel(e.host_name) || names.includes(firstLabel(d.host)));
    const existing = cfg.devices.find(same);
    let to: string;
    if (existing) to = existing.id;
    else {
      let n = 1;
      while (cfg.devices.some((d) => d.id === `ssh:${n}`)) n++;
      to = `ssh:${n}`;
      const name = h.name === "" ? h.id.replace(/^(ts:)+/, "") : h.name;
      cfg.devices.push({ ...h, id: to, name, host: e.aliases[0] ?? "", aka: [] });
    }
    cfg.devices = cfg.devices.filter((d) => d.id !== h.id);
    moved.push([h.id, to]);
  }
  return moved;
}


/** A PC the Add form offers: an ~/.ssh/config alias, or one announcing ssh on the network. */
export interface NearbyPc {
  /** Shown name: the alias, or the name the PC announces. */
  name: string;
  /** What ssh dials: the alias, else the announced host name. */
  host: string;
  user: string;
  port: number;
  /** "ssh config", "network" or "ssh config · network". */
  source: string;
  /** Its other names and IPs, to tell it's already a device. */
  aka: string[];
}

/** One resolved ssh service on the network: [name, host name, address, port]. */
export type Announced = [string, string, string, number];

/** Hosts in ~/.ssh/config that are code forges, not PCs. */
function forge(e: SshEntry): boolean {
  const h = lower(e.host_name);
  return ["github.com", "gitlab.com", "bitbucket.org", "ssh.dev.azure.com", "codeberg.org"].some((f) => h === f || h.endsWith(`.${f}`)) || e.user === "git";
}

/** Decodes avahi's `\DDD` escapes (decimal bytes) in a service name. */
function avahiUnescape(s: string): string {
  const b = Buffer.from(s, "utf8");
  const out: number[] = [];
  const digit = (x: number | undefined) => x !== undefined && x >= 0x30 && x <= 0x39;
  for (let i = 0; i < b.length; ) {
    if (b[i] === 0x5c && i + 3 < b.length && digit(b[i + 1]) && digit(b[i + 2]) && digit(b[i + 3])) {
      out.push(Math.min(Number(b.subarray(i + 1, i + 4).toString()), 255));
      i += 4;
    } else if (b[i] === 0x5c && i + 1 < b.length) {
      out.push(b[i + 1] ?? 0);
      i += 2;
    } else {
      out.push(b[i] ?? 0);
      i += 1;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(out));
}

/** Parses `avahi-browse -ptr` of `_ssh._tcp` / `_sftp-ssh._tcp`: each resolved one, once per host. */
export function parseAvahi(src: string): Announced[] {
  const v: Announced[] = [];
  for (const l of src.split(/\r?\n/).filter((l) => l.startsWith("=;"))) {
    const f = l.split(";");
    if (f.length < 9) continue;
    const portText = f[8] ?? "";
    const name = avahiUnescape(f[3] ?? "");
    const host = (f[6] ?? "").replace(/\.+$/, "");
    const ip = f[7] ?? "";
    const port = /^\+?\d+$/.test(portText) && Number(portText) <= 65535 ? Number(portText) : 22;
    // IPv4 first: a link-local IPv6 needs its interface to be dialed.
    const x = v.find((y) => eqi(y[1], host));
    if (x) {
      if (x[2].includes(":") && !ip.includes(":")) x[2] = ip;
    } else v.push([name, host, ip, port]);
  }
  return v;
}

/** The Add form's offers from ~/.ssh/config `entries` and the network's `announced`: one per machine, the alias when there is one (it has the login). */
export function nearbyFrom(entries: SshEntry[], announced: Announced[], me: string[]): NearbyPc[] {
  // This PC itself (its name, addresses, localhost) isn't offered.
  const mine = (host: string) => {
    const ip = strictIp(host);
    return eqi(host, "localhost") || (ip !== null && ip.v === 4 ? ip.b[0] === 127 : ip !== null && ip.b.slice(0, 15).every((x) => x === 0) && ip.b[15] === 1) || me.some((m) => eqi(m, host) || (ip === null && firstLabel(m) === firstLabel(host)));
  };
  const v: NearbyPc[] = entries
    .filter((e) => !forge(e) && e.aliases.length > 0 && !mine(e.host_name))
    .map((e) => ({ name: e.aliases[0] ?? "", host: e.aliases[0] ?? "", user: "", port: 0, source: "ssh config", aka: [...e.aliases, e.host_name] }));
  for (const [name, host, ip, port] of announced) {
    if (mine(host) || mine(ip)) continue;
    const same = (n: NearbyPc) => n.aka.some((a) => eqi(a, host) || a === ip || firstLabel(a) === firstLabel(host));
    const n = v.find(same);
    if (n) {
      n.source = "ssh config · network";
      n.aka.push(host, ip);
    } else v.push({ name, host, user: "", port: port === 22 ? 0 : port, source: "network", aka: [host, ip] });
  }
  return v;
}

/** Whether an offer is a device already (by any of its names). */
export function isDevice(ctx: RemoteCtx, n: NearbyPc, devs: [RemoteHost, boolean | null][]): boolean {
  const isIp = (s: string) => strictIp(s) !== null;
  // The same name, or two host names of one machine ("mac" is not "mac.example": only names).
  const same = (a: string, b: string) => eqi(a, b) || (!isIp(a) && !isIp(b) && firstLabel(a) === firstLabel(b));
  const offer = [n.host, ...n.aka].filter((s) => s !== "");
  return devs.some(([h]) => {
    const names = [h.host, ...h.aka, sshConfigEntry(ctx, h)?.host_name ?? ""].filter((s) => s !== "");
    return names.some((m) => offer.some((a) => same(m, a)));
  });
}


/** The folder a chat's agent starts in on the device; home when it works on this PC's files (the project needn't be there). */
export function remoteDir(home: string, h: RemoteHost, project: string | null): string {
  const dir = h.dir.trim().replace(/\/+$/, "");
  if (!h.device_files) return "~";
  // The device is Linux or macOS: what's under this PC's home goes there with "/".
  const under = (p: string): string | null => osPaths.under(p.replace(/[\\/]+$/, ""), home.replace(/[\\/]+$/, ""))?.replaceAll("\\", "/") ?? null;
  if (project !== null && dir !== "") return `${dir}/${project.replace(/\/+$/, "").split("/").pop() ?? ""}`;
  if (project !== null) {
    const rel = under(project);
    if (rel === null) return project;
    return rel === "" ? "~" : `~/${rel}`;
  }
  return dir !== "" ? dir : "~";
}

/** What runs on the device before the agent, in its shell's own words. */
export type RemoteSetup =
  /** The account's Claude login (an OAuth access token, the next stdin line) into `CLAUDE_CODE_OAUTH_TOKEN`. Never an argument: ssh's command line shows in `ps` on both PCs. */
  | { kind: "token" }
  /** The next stdin line (the `--mcp-config` JSON, whose URLs hold the bridge's token) into an owner-only temp file, removed when the turn ends; `MCP_CONFIG_ARG` names it. */
  | { kind: "mcp" }
  /** A Claude profile (~/.claude2…, relative to home) used there too when the device has it. */
  | { kind: "profile"; rel: string }
  /** An empty profile (relative to home) instead of the device's own, with the device's auto-memory off. Only with `token`. */
  | { kind: "guest"; rel: string }
  /** Claude Code resumes only sessions of the folder it runs in: this session is copied to this one's. */
  | { kind: "session"; id: string }
  /** A line for a POSIX device's shell as it is (ignored on Windows). */
  | { kind: "sh"; line: string };

/** How a turn starts on a device: ssh's remote command, and what goes on stdin before the rest of the turn's input. */
export interface RemoteLaunch {
  command: string;
  input: string;
}

/** The command for a device of `family` that enters `dir`, runs the `setup` and starts `argv` on the connection's stdin. */
export function remoteLaunch(family: ShellFamily, dir: string, setup: RemoteSetup[], argv: string[]): RemoteLaunch {
  if (family === "posix") return { command: remoteCommand(dir, setup, argv), input: "" };
  // cmd caps a command line at 8191 characters and the agent's prompt alone can be longer: a short
  // fixed command reads the script from the first stdin line.
  return { command: psCommand(PS_BOOT), input: `${base64(psScript(dir, setup, argv))}\n` };
}

/** The command ssh runs on a POSIX device; a watchdog stops the agent when the connection goes, and the last line carries its exit code. */
export function remoteCommand(dir: string, setup: RemoteSetup[], argv: string[]): string {
  let s = `cd ${shellPath(dir)} 2>/dev/null || { echo "harbor: the folder ${dir.replace(/["$`\\]/g, "")} doesn't exist on $(hostname)" >&2; exit 97; }\n`;
  for (const l of setup) s += `${shSetup(l)}\n`;
  s += pathRequire(argv[0] ?? "claude");
  s += argv.map((a) => (a === MCP_CONFIG_ARG ? '"$HARBOR_MCP_CONFIG"' : shQuote(a))).join(" ");
  s +=
    " <&0 &\nc=$!\n( while kill -0 $PPID 2>/dev/null; do sleep 2; done; pkill -TERM -P $c; kill -TERM $c ) >/dev/null 2>&1 &\nw=$!\nwait $c; s=$?\nkill $w 2>/dev/null\nprintf '\\n{\"type\":\"harbor_exit\",\"code\":%d}\\n' \"$s\"\nexit $s\n";
  const q = shQuote(s);
  return `if command -v bash >/dev/null 2>&1; then exec bash -lc ${q}; else exec sh -lc ${q}; fi`;
}

/** A setup as a POSIX shell line. The shell reads a pipe byte by byte, so the agent's `<&0` gets the rest of the input intact. */
export function shSetup(s: RemoteSetup): string {
  switch (s.kind) {
    case "token":
      return "IFS= read -r CLAUDE_CODE_OAUTH_TOKEN && export CLAUDE_CODE_OAUTH_TOKEN";
    case "mcp":
      return String.raw`IFS= read -r HARBOR_MCP; HARBOR_MCP_CONFIG=$(umask 077; mktemp) && printf '%s\n' "$HARBOR_MCP" > "$HARBOR_MCP_CONFIG" && trap 'rm -f "$HARBOR_MCP_CONFIG"' EXIT; unset HARBOR_MCP`;
    case "profile": {
      const p = `"$HOME"/${shQuote(s.rel)}`;
      return `[ -d ${p} ] && export CLAUDE_CONFIG_DIR=${p}`;
    }
    case "guest": {
      const p = `"$HOME"/${shQuote(s.rel)}`;
      return `mkdir -p ${p} && chmod 700 ${p} && export CLAUDE_CONFIG_DIR=${p} CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`;
    }
    case "session":
      return fmt(
        "c=\"${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects\"; d=\"$c/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')\"; [ -e \"$d\"/{f} ] || {{ s=$(ls \"$c\"/*/{f} 2>/dev/null | head -n1); [ -n \"$s\" ] || s=$(ls \"$HOME\"/.claude*/projects/*/{f} \"$HOME\"/.local/state/harbor/guests/*/projects/*/{f} 2>/dev/null | head -n1); [ -n \"$s\" ] && mkdir -p \"$d\" && cp \"$s\" \"$d\"/; }}",
        { f: shQuote(`${s.id}.jsonl`) },
      );
    case "sh":
      return s.line;
  }
}

/** Where the CLI's installers put it, for a device whose login shell isn't bash (a Mac's zsh files hold its PATH). */
const CLI_DIRS = ["$HOME/.local/bin", "$HOME/.claude/local", "/opt/homebrew/bin", "/usr/local/bin", "$HOME/.bun/bin", "$HOME/.npm-global/bin", "$HOME/.local/share/mise/shims", "$HOME/.volta/bin"];

/** Puts the first usual install folder holding `bin` on PATH, else where zsh finds it (stdin /dev/null, so it can't eat the input). */
export function pathLookup(bin: string): string {
  const b = shQuote(bin);
  const dirs = CLI_DIRS.map((d) => `"${d}"`).join(" ");
  return (
    fmt("command -v {b} >/dev/null 2>&1 || for d in {dirs}; do [ -x \"$d\"/{b} ] && {{ PATH=\"$d:$PATH\"; break; }}; done\n", { b, dirs }) +
    fmt("command -v {b} >/dev/null 2>&1 || ! command -v zsh >/dev/null 2>&1 || {{ p=$(zsh -lic 'command -v '{b} </dev/null 2>/dev/null | tail -n1); [ -n \"$p\" ] && [ -x \"$p\" ] && PATH=\"$(dirname \"$p\"):$PATH\"; }}\n", { b }) +
    "export PATH\n"
  );
}

/** `pathLookup`, then a clear word and exit 98 when `bin` still isn't there. */
export function pathRequire(bin: string): string {
  const shown = bin.replace(/["$`\\]/g, "");
  const name = bin === "claude" ? "Claude Code" : shown;
  return `${pathLookup(bin)}command -v ${shQuote(bin)} >/dev/null 2>&1 || { echo "harbor: ${name} isn't on the PATH of a login shell on $(hostname); install it or add it to ~/.bash_profile" >&2; exit 98; }\n`;
}

/** The profile setup for an account whose Claude config lives in a profile folder under home (~/.claude2…); none for the default one. */
export function profileSetup(home: string, configDir: string | null): RemoteSetup[] {
  if (configDir === null) return [];
  const rel = osPaths.under(configDir.replace(/[\\/]+$/, ""), home.replace(/[\\/]+$/, ""));
  if (rel === null || rel === "") return [];
  return [{ kind: "profile", rel: rel.replaceAll("\\", "/") }];
}


/** PowerShell quoting: a single-quoted string (PowerShell takes the typographic single quotes for quotes too, so they're doubled as well). */
export function psQuote(s: string): string {
  let out = "'";
  for (const c of s) {
    if (c === "'" || c === "\u2018" || c === "\u2019" || c === "\u201A" || c === "\u201B") out += c;
    out += c;
  }
  return `${out}'`;
}

/** A command line that runs a PowerShell script whatever OpenSSH's shell is there: `powershell` with the script UTF-16 and base64, so no shell on the way reads a character of it. */
export function psCommand(script: string): string {
  return `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${base64(Buffer.from(script, "utf16le"))}`;
}

/** The fixed command of a Windows turn: reads stdin's first line byte by byte, decodes it (base64 UTF-8) and runs it. `HarborLine` reads the next lines the same way. */
export const PS_BOOT =
  "$ProgressPreference='SilentlyContinue';$HarborIn=[Console]::OpenStandardInput();function HarborLine{$b=New-Object System.Collections.Generic.List[byte];while(($c=$HarborIn.ReadByte()) -ge 0 -and $c -ne 10){if($c -ne 13){$b.Add([byte]$c)}};[Text.Encoding]::UTF8.GetString($b.ToArray())};. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((HarborLine)))))";

/** A path for PowerShell: ~ is the user's profile folder; `/` works as a separator there. */
export function psPath(p: string): string {
  if (p === "~" || p === "") return "$HOME";
  if (p.startsWith("~/")) return `(Join-Path $HOME ${psQuote(p.slice(2))})`;
  return psQuote(p);
}

/** Where the CLI's Windows installers put it. */
const WIN_CLI_DIRS = [
  "$env:USERPROFILE\\.local\\bin",
  "$env:APPDATA\\npm",
  "$env:USERPROFILE\\.bun\\bin",
  "$env:USERPROFILE\\scoop\\shims",
  "$env:LOCALAPPDATA\\Microsoft\\WinGet\\Links",
  "$env:LOCALAPPDATA\\mise\\shims",
  "$env:LOCALAPPDATA\\Volta\\bin",
];

/** PowerShell lines that set `$HarborExe` (and `$HarborPre`, arguments before the agent's) to `bin`: from the PATH, else the first of the usual folders with `bin`.exe or .cmd. An npm .cmd shim is skipped for `node cli.js`. */
export function psLookup(bin: string): string {
  const b = psQuote(bin);
  const dirs = WIN_CLI_DIRS.map((d) => `"${d}"`).join(",");
  const names = `${psQuote(`${bin}.exe`)},${psQuote(`${bin}.cmd`)}`;
  return (
    "$HarborExe=$null;$HarborPre=@()\n" +
    fmt("$c=Get-Command {b} -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n", { b }) +
    fmt("if($c){{$HarborExe=$c.Path}}else{{foreach($d in @({dirs})){{foreach($n in @({names})){{$f=Join-Path $d $n;if(Test-Path -LiteralPath $f){{$HarborExe=$f;break}}}};if($HarborExe){{break}}}}}}\n", { dirs, names }) +
    "if($HarborExe -and $HarborExe -match '\\.(cmd|bat)$'){$js=Join-Path (Split-Path $HarborExe) 'node_modules\\@anthropic-ai\\claude-code\\cli.js';$node=Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1;if($node -and (Test-Path -LiteralPath $js)){$HarborPre=@($js);$HarborExe=$node.Path}}\n" +
    "if($HarborExe){$env:PATH=(Split-Path $HarborExe)+';'+$env:PATH}\n"
  );
}

/** A setup as PowerShell (stdin lines through the boot's `HarborLine`). */
export function psSetup(s: RemoteSetup): string {
  switch (s.kind) {
    case "token":
      return "$env:CLAUDE_CODE_OAUTH_TOKEN=(HarborLine)";
    case "mcp":
      return '$HarborMcp=[IO.Path]::GetTempFileName();$HarborClean+=$HarborMcp;[IO.File]::WriteAllText($HarborMcp,(HarborLine)+"`n");$env:HARBOR_MCP_CONFIG=$HarborMcp';
    case "profile":
      return fmt("$p=Join-Path $HOME {q};if(Test-Path -LiteralPath $p -PathType Container){{$env:CLAUDE_CONFIG_DIR=$p}}", { q: psQuote(s.rel) });
    case "guest":
      return fmt("$p=Join-Path $HOME {q};New-Item -ItemType Directory -Force -Path $p|Out-Null;$env:CLAUDE_CONFIG_DIR=$p;$env:CLAUDE_CODE_DISABLE_AUTO_MEMORY='1'", { q: psQuote(s.rel) });
    case "session": {
      const v = { f: psQuote(`${s.id}.jsonl`) };
      return (
        "$c=Join-Path $(if($env:CLAUDE_CONFIG_DIR){$env:CLAUDE_CONFIG_DIR}else{Join-Path $HOME '.claude'}) 'projects';$d=Join-Path $c ((Get-Location).ProviderPath -replace '[^A-Za-z0-9]','-')\n" +
        fmt("if(-not (Test-Path -LiteralPath (Join-Path $d {f}))){{$s=Get-ChildItem -Path $c -Directory -ErrorAction SilentlyContinue | ForEach-Object {{Join-Path $_.FullName {f}}} | Where-Object {{Test-Path -LiteralPath $_}} | Select-Object -First 1\n", v) +
        fmt("if(-not $s){{$s=Get-ChildItem -Path $HOME -Directory -Filter '.claude*' -Force -ErrorAction SilentlyContinue | ForEach-Object {{Get-ChildItem -Path (Join-Path $_.FullName 'projects') -Directory -ErrorAction SilentlyContinue}} | ForEach-Object {{Join-Path $_.FullName {f}}} | Where-Object {{Test-Path -LiteralPath $_}} | Select-Object -First 1}}\n", v) +
        "if($s){New-Item -ItemType Directory -Force -Path $d | Out-Null;Copy-Item -LiteralPath $s -Destination $d}}"
      );
    }
    case "sh":
      return "";
  }
}

/** The PowerShell script of a Windows turn (run by `PS_BOOT`): enters `dir`, runs the setup, finds the CLI and starts it with `argv`'s arguments quoted as Windows programs read them, on the connection's stdin and stdout. Exit 97 / 98 as on POSIX. */
export function psScript(dir: string, setup: RemoteSetup[], argv: string[]): string {
  const bin = argv[0] ?? "claude";
  const shown = dir.replace(/["$`]/g, "");
  const name = bin === "claude" ? "Claude Code" : bin.replace(/["$`]/g, "");
  let s =
    "$ErrorActionPreference='Stop';$HarborClean=@();$HarborCode=1\n" +
    fmt("try{{Set-Location -LiteralPath {p}}}catch{{[Console]::Error.WriteLine(\"harbor: the folder {shown} doesn't exist on $env:COMPUTERNAME\");exit 97}}\n", { p: psPath(dir), shown }) +
    "try{\n";
  for (const l of setup) {
    const t = psSetup(l);
    if (t !== "") s += `${t}\n`;
  }
  s += psLookup(bin);
  s += fmt("if(-not $HarborExe){{[Console]::Error.WriteLine(\"harbor: {name} isn't on the PATH on $env:COMPUTERNAME; install it (irm https://claude.ai/install.ps1 | iex) or add its folder to your user PATH\");exit 98}}\n", { name });
  const args = argv.slice(1).map((a) => (a === MCP_CONFIG_ARG ? "$env:HARBOR_MCP_CONFIG" : psQuote(a))).join(",");
  s +=
    `$HarborArgs=@($HarborPre)+@(${args})\n` +
    "function HarborQ($a){if($a -ne '' -and $a -notmatch '[\\s\"]'){return $a};'\"'+(($a -replace '(\\\\*)\"','$1$1\\\"') -replace '(\\\\+)$','$1$1')+'\"'}\n" +
    "$p=New-Object System.Diagnostics.Process\n" +
    "$p.StartInfo.FileName=$HarborExe\n" +
    "$p.StartInfo.Arguments=(($HarborArgs | ForEach-Object {HarborQ ([string]$_)}) -join ' ')\n" +
    "$p.StartInfo.UseShellExecute=$false\n" +
    "$p.StartInfo.WorkingDirectory=(Get-Location).ProviderPath\n" +
    "[void]$p.Start();$p.WaitForExit();$HarborCode=$p.ExitCode\n" +
    "}finally{$HarborClean | ForEach-Object {Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue}}\n" +
    "[Console]::Out.WriteLine();[Console]::Out.WriteLine('{\"type\":\"harbor_exit\",\"code\":'+$HarborCode+'}');[Console]::Out.Flush()\n" +
    "exit $HarborCode\n";
  return s;
}


export interface RemoteProbe {
  running: boolean;
  /** null while running. */
  ok: boolean | null;
  text: string;
  /** The OS the device said it runs (`osFrom`); empty when it didn't answer. */
  os: string;
}

/** The command that tests a device: ssh with the same lookup as a turn's, so the test tells the same truth. */
export function testCommand(ctx: RemoteCtx, cfg: RemoteConfig, h: RemoteHost, f: ShellFamily): RemoteCommand {
  const args = [...sshOpts(ctx, cfg, h), h.host];
  if (f === "posix") {
    const script = `echo HARBOR_OK; uname -sm\n${pathLookup("claude")}v=$(claude --version 2>/dev/null) && echo "claude $v" || echo "no claude"`;
    args.push(`if command -v bash >/dev/null 2>&1; then exec bash -lc ${shQuote(script)}; else echo HARBOR_OK; uname -sm; echo "no bash"; fi`);
  } else {
    const script =
      "[Console]::Out.WriteLine('HARBOR_OK');[Console]::Out.WriteLine(\"Windows $env:PROCESSOR_ARCHITECTURE\")\n" +
      psLookup("claude") +
      "if($HarborExe){$v=& $HarborExe @($HarborPre+'--version') 2>$null | Select-Object -First 1;[Console]::Out.WriteLine(\"claude $v\")}else{[Console]::Out.WriteLine('no claude')}";
    args.push(psCommand(script));
  }
  return { program: "ssh", args };
}

/** What a test's ssh printed, as the Test button shows it. */
export function probeResult(out: RunOutput | Error): RemoteProbe {
  if (out instanceof Error) return { running: false, ok: false, text: `ssh: ${out.message}`, os: "" };
  if (out.stdout.includes("HARBOR_OK")) {
    const lines = out.stdout.split(/\r?\n/).map((l) => l.trim());
    if (lines.at(-1) === "") lines.pop();
    const after = lines.slice(Math.max(0, lines.findIndex((l) => l.includes("HARBOR_OK"))) + 1);
    const sys = after[0] ?? "";
    const cli = after[1] ?? "";
    const ok = cli.startsWith("claude ") && cli.length > "claude ".length;
    // Reachable but without the CLI still counts as online; the text says why.
    return { running: false, ok: true, text: ok ? `Connected · ${sys} · ${cli}` : `Connected · ${sys} · Claude Code isn't installed there`, os: osFrom(sys) };
  }
  const last = out.stderr.split(/\r?\n/).reverse().find((l) => l.trim() !== "") ?? "no answer";
  return { running: false, ok: false, text: last.trim(), os: "" };
}

async function attempt(run: Runner, c: RemoteCommand): Promise<RunOutput | Error> {
  try {
    return await run(c.program, c.args);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** Connects to the device and checks for Claude Code there. A device of unknown OS is asked as a POSIX one first, then as Windows. */
export async function runProbe(run: Runner, ctx: RemoteCtx, cfg: RemoteConfig, h: RemoteHost): Promise<RemoteProbe> {
  const first = shellFamily(h.os);
  const out = await attempt(run, testCommand(ctx, cfg, h, first));
  // ssh's own failures exit 255; anything else that didn't answer is a shell that didn't read the
  // script: the other family's.
  const other: ShellFamily | null = !(out instanceof Error) && !out.stdout.includes("HARBOR_OK") && out.code !== 255 ? (first === "posix" ? "windows" : "posix") : null;
  const p = probeResult(out);
  if (other === null) return p;
  const q = probeResult(await attempt(run, testCommand(ctx, cfg, h, other)));
  return q.ok === true ? q : p;
}

/** Opens a terminal on the device (for `claude /login` there, or a look around). */
export function shellArgv(ctx: RemoteCtx, cfg: RemoteConfig, h: RemoteHost, cmd: string | null): string[] {
  // Interactive: ssh may ask for a password or a host key here.
  const opts = sshOpts(ctx, cfg, h);
  const out = ["ssh", "-t", ...opts.slice(2), h.host];
  if (cmd !== null) {
    if (shellFamily(h.os) === "posix") out.push(`bash -lc ${shQuote(cmd)}`);
    else {
      // `cmd` is the CLI and its arguments ("claude /login").
      const words = cmd.split(/\s+/).filter((w) => w !== "");
      const bin = words.shift() ?? "claude";
      const args = words.map(psQuote).join(" ");
      out.push(psCommand(`${psLookup(bin)}if($HarborExe){& $HarborExe @HarborPre ${args}}else{Write-Host "${bin} isn't installed here"}`));
    }
  }
  return out;
}


/** What a `Remotes` needs from the PC and the app it runs in. */
export interface RemoteDeps {
  home: string;
  dataDir: string;
  runner: Runner;
  /** This Harbor's executable, for `harbor nc`. Default: none. */
  selfExe?: () => string | null;
  /** The program's path when it is installed. Default: none installed. */
  which?: (bin: string) => string | null;
  /** The paired PCs and what the mesh knows of them (api::Hub); null before the hub is up. */
  /** The trusted PCs (this PC's workspace's, from the directory) and the mesh's peers. */
  mesh?: () => { allowed: Allowed[]; peers: Map<string, Peer> } | null;
  /** A text file's content (~/.ssh/config, /etc/hostname); null when unreadable. Default: the real file system. */
  readFile?: (path: string) => string | null;
  /** This PC's addresses, for telling itself among nearby PCs. */
  lanAddrs?: () => string[];
  /** Called when a background read finished (the repaint of the egui version). */
  onChange?: () => void;
  /** Milliseconds, for the caches. */
  clock?: () => number;
}

/** The state remote.rs keeps in statics: the tailnet, ~/.ssh/config, nearby PCs and test results, with their refresh times. */
export class Remotes implements RemoteCtx {
  readonly home: string;
  private tail: [number, Tailnet] | null = null;
  private reading = false;
  private sshCache: [number, SshEntry[]] | null = null;
  private near: [number, NearbyPc[]] | null = null;
  private browsing = false;
  private readonly probes = new Map<string, RemoteProbe>();

  constructor(private readonly d: RemoteDeps) {
    this.home = d.home;
  }

  private now(): number {
    return (this.d.clock ?? Date.now)();
  }

  private read(path: string): string | null {
    return (this.d.readFile ?? readText)(path);
  }

  selfExe(): string | null {
    return this.d.selfExe?.() ?? null;
  }

  probe(id: string): RemoteProbe | undefined {
    return this.probes.get(id);
  }

  sshConfig(): SshEntry[] {
    if (this.sshCache && this.now() - this.sshCache[0] < CONFIG_MS) return this.sshCache[1];
    const dir = join(this.d.home, ".ssh");
    const reader = (f: string) => this.read(isAbsolute(f) ? f : f.startsWith("~/") ? join(this.d.home, f.slice(2)) : join(dir, f));
    const t = reader("config");
    const v = t === null ? [] : parseRemoteSshConfig(t, reader, 0);
    this.sshCache = [this.now(), v];
    return v;
  }

  /** Every PC Harbor knows of: the paired ones, then (while it's installed) Tailscale's others. */
  async readTailnet(): Promise<Tailnet> {
    const hub = this.d.mesh?.() ?? null;
    const net = newTailnet(hub ? { peers: pairedPcs(hub.allowed, hub.peers) } : {});
    if (this.d.which?.("tailscale")) {
      let ts = newTailnet({ installed: true });
      const out = await attempt(this.d.runner, { program: "tailscale", args: ["status", "--json"] });
      if (!(out instanceof Error)) {
        try {
          ts = parseTailscaleStatus(JSON.parse(out.stdout));
        } catch {
          // not JSON: Tailscale didn't answer
        }
      }
      net.installed = true;
      net.state = ts.state;
      net.me = ts.me;
      for (const p of ts.peers) if (!net.peers.some((q) => q.id === p.id)) net.peers.push(p);
    }
    return net;
  }

  /** The tailnet as last read; a stale one is read again in the background. Never waits. */
  tailnet(): Tailnet {
    const cur = this.tail;
    if (cur === null || this.now() - cur[0] > REFRESH_MS) void this.refresh();
    return cur?.[1] ?? newTailnet();
  }

  /** The tailnet as last read, without reading it again (for answers that have no window). */
  tailnetCached(): Tailnet {
    return this.tail?.[1] ?? newTailnet();
  }

  async refresh(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      this.tail = [this.now(), await this.readTailnet()];
    } finally {
      this.reading = false;
    }
    this.d.onChange?.();
  }

  devices(cfg: RemoteConfig, net: Tailnet): [RemoteHost, boolean | null][] {
    return remoteDevices(this, cfg, net);
  }

  find(cfg: RemoteConfig, net: Tailnet, id: string): RemoteHost | null {
    return findDevice(this, cfg, net, id);
  }

  sshOpts(cfg: RemoteConfig, h: RemoteHost): string[] {
    return sshOpts(this, cfg, h);
  }

  /** `migrateDevices` with this PC's ~/.ssh/config. */
  migrateHere(cfg: RemoteConfig, allowed: Allowed[]): [string, string][] {
    return migrateDevices(cfg, allowed, this.sshConfig());
  }

  isDevice(n: NearbyPc, devs: [RemoteHost, boolean | null][]): boolean {
    return isDevice(this, n, devs);
  }

  shellArgv(cfg: RemoteConfig, h: RemoteHost, cmd: string | null): string[] {
    return shellArgv(this, cfg, h, cmd);
  }

  /** The Add form's offers, read again in the background when a minute old (`avahi-browse`, when installed). */
  nearby(): NearbyPc[] {
    const cur = this.near;
    if ((cur === null || this.now() - cur[0] > NEARBY_MS) && !this.browsing) {
      this.browsing = true;
      void this.browse().finally(() => {
        this.browsing = false;
        this.d.onChange?.();
      });
    }
    return cur?.[1] ?? [];
  }

  private async browse(): Promise<void> {
    let src = "";
    if (this.d.which?.("avahi-browse")) {
      for (const svc of ["_ssh._tcp", "_sftp-ssh._tcp"]) {
        const o = await attempt(this.d.runner, { program: "avahi-browse", args: ["-ptr", svc] });
        if (!(o instanceof Error)) src += o.stdout;
      }
    }
    const me = [hostname((p) => this.read(p)), ...(this.d.lanAddrs?.() ?? [])];
    this.near = [this.now(), nearbyFrom(this.sshConfig(), parseAvahi(src), me)];
  }

  /** Tests the device in the background; the result is `probe(h.id)` when it resolves. */
  async test(cfg: RemoteConfig, h: RemoteHost): Promise<RemoteProbe> {
    this.probes.set(h.id, { running: true, ok: null, text: "Connecting…", os: "" });
    const p = await runProbe(this.d.runner, this, cfg, h);
    this.probes.set(h.id, p);
    this.d.onChange?.();
    return p;
  }

  /** `test` for a device not tested yet this session (an SSH host added by hand: its online dot and OS come from it). */
  async testOnce(cfg: RemoteConfig, h: RemoteHost): Promise<void> {
    if (!isFound(h) && h.host.trim() !== "" && !this.probes.has(h.id)) await this.test(cfg, h);
  }

  /** Takes the OS the devices said into the settings (for a device whose OS isn't known, or changed); whether anything changed. */
  adoptOs(cfg: RemoteConfig): boolean {
    let changed = false;
    for (const h of cfg.devices) {
      const p = this.probes.get(h.id);
      if (p && p.os !== "" && p.os !== h.os && (!isFound(h) || h.os === "")) {
        h.os = p.os;
        changed = true;
      }
    }
    return changed;
  }
}
