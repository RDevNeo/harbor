import { APP_INBOX, type Hub, type PairedPhone, type Sighting } from "./hub.ts";
import { now } from "./kv.ts";
import type { Me, Peer } from "./shared.ts";
import type { Json } from "./wire.ts";

/** One PC: what its Harbor says about itself (`update::info` there; null before 0.51). */
export interface PcVersion {
  id: string;
  name: string;
  me: boolean;
  online: boolean;
  /** Unix time of its last answer (0: never this PC's own). */
  seen: number;
  /** "" when unknown. */
  version: string;
  update: unknown;
}

/** One phone's app, as the hub last saw it. */
export interface PhoneVersion {
  name: string;
  /** versionCode (0: unknown, an app before 0.19 that doesn't say it). */
  app: number;
  /** Last call or background ping, here or on another PC (0: never seen). */
  seen: number;
  /** The PC it was last seen at ("" for this one). */
  via: string;
  /** What the phone says it is (model, Android, ABIs, built-in browser; "" when unknown). */
  platform: string;
}

export function newPcVersion(p: Partial<PcVersion> = {}): PcVersion {
  return { id: "", name: "", me: false, online: false, seen: 0, version: "", update: null, ...p };
}

export function newPhoneVersion(p: Partial<PhoneVersion> = {}): PhoneVersion {
  return { name: "", app: 0, seen: 0, via: "", platform: "", ...p };
}

/** "0.66.0" from versionCode 66000 (Cargo.toml's version is the APK's versionName). */
export function codeName(code: number): string {
  return `${Math.trunc(code / 1_000_000)}.${Math.trunc(code / 1000) % 1000}.${code % 1000}`;
}

/** update.rs's version order: "0.2.0" > "0.2.0-rc.1" > "0.1.9". */
function parseVersion(v: string): [number, number, number, number] | null {
  const t = v.trim().replace(/^v+/, "");
  const dash = t.indexOf("-");
  const core = dash < 0 ? t : t.slice(0, dash);
  const parts = core.split(".");
  const num = (s: string | undefined): number | null => (s !== undefined && /^\+?\d+$/.test(s) ? Number(s) : null);
  const major = num(parts[0]);
  const minor = num(parts[1]);
  if (major === null || minor === null) return null;
  const patch = parts[2] === undefined ? 0 : (num(parts[2]) ?? 0);
  return [major, minor, patch, dash < 0 ? 1 : 0];
}

/** Whether `candidate` is a newer Harbor version than `current` (false when either doesn't parse). */
export function versionNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x > y;
  }
  return false;
}

function field(v: unknown, key: string): unknown {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[key] : undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The newest Harbor any PC runs or knows of. */
export function newestVersion(pcs: readonly PcVersion[]): string {
  let best = "";
  for (const p of pcs) {
    for (const v of [p.version, str(field(p.update, "latest"))]) {
      if (v !== "" && (best === "" || versionNewer(v, best))) best = v;
    }
  }
  return best;
}

/** app.rs's `ago`: "now", "5m", "2h", "3d". */
export function agoShort(ts: number, at: number = now()): string {
  const d = Math.max(at - ts, 0);
  if (d < 60) return "now";
  if (d < 3600) return `${Math.trunc(d / 60)}m`;
  if (d < 86400) return `${Math.trunc(d / 3600)}h`;
  return `${Math.trunc(d / 86400)}d`;
}

function agoText(ts: number, at: number): string {
  const a = agoShort(ts, at);
  return a === "now" ? "just now" : `${a} ago`;
}

/** A PC's Harbor in a line: "0.66.0 (latest, updates automatically)", "0.64.1, offline (last seen 2d ago)". */
/** The version a PC really runs (its update info's `build`, e.g. "0.167.1+abc1234"); else the one it advertises. */
export function runningVersion(p: Pick<PcVersion, "version" | "update">): string {
  const u = p.update;
  const b = typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>).build : undefined;
  return typeof b === "string" && b.trim() !== "" ? b.trim() : p.version;
}

export function pcLine(p: PcVersion, newest: string, at: number = now()): string {
  if (!p.me && !p.online) {
    const v = p.version === "" ? "version unknown" : p.version;
    return p.seen > 0 ? `${v}, offline (last seen ${agoText(p.seen, at)})` : `${v}, offline`;
  }
  if (p.version === "") return "version unknown";
  const u = p.update;
  if (typeof u !== "object" || u === null || Array.isArray(u) || !("managed" in u)) {
    // A Harbor before 0.51 says its version but nothing about its updates.
    let s = `${p.version} (update status unknown, before 0.51)`;
    if (newest !== "" && versionNewer(newest, p.version)) s += `; ${newest} is out`;
    return s;
  }
  const managed = field(u, "managed") === true;
  const latest = str(field(u, "latest"));
  const error = str(field(u, "error"));
  const bits: string[] = [];
  let state: string;
  if (!managed) state = "built from source, doesn't update itself";
  else if (field(u, "installing") === true) state = `updating to ${latest === "" ? "a newer version" : latest}`;
  else if (field(u, "ready") === true) state = `${latest} installed, restarts into it`;
  else if (field(u, "checking") === true) state = "checking for updates";
  else if (latest !== "") state = `${latest} available`;
  else if (error !== "") state = `update failed: ${error}`;
  else if (newest !== "" && versionNewer(newest, p.version)) state = `${newest} is out`;
  else if (field(u, "status") === "up to date" || newest === p.version) state = "latest";
  else state = "";
  if (state !== "") bits.push(state);
  if (managed) {
    const auto = field(u, "auto");
    if (auto === true) bits.push("updates automatically");
    else if (auto === false) bits.push("auto-update off");
  }
  const preview = field(field(u, "preview"), "id");
  if (typeof preview === "string") bits.push(`running preview ${preview}`);
  if (bits.length === 0) return p.version;
  if (bits[0] === "latest" || (!managed && bits.length === 1)) return `${p.version} (${bits.join(", ")})`;
  return `${p.version}, ${bits.join(", ")}`;
}

/** A phone's app in a line: "app 0.66.0 (66000), seen 5m ago at laptop". `served`: the app versionCode this PC serves (0: none). */
export function phoneLine(p: PhoneVersion, served: number, at: number = now()): string {
  let s: string;
  if (p.app === 0) s = "app version unknown (older than 0.17)";
  else if (p.app === APP_INBOX) s = "app 0.17 or 0.18.0 (doesn't say which)";
  else s = `app ${codeName(p.app)} (${p.app})`;
  if (served > p.app && p.app > 0) s += `, ${codeName(served)} available`;
  if (p.seen > 0) {
    s += `, seen ${agoText(p.seen, at)}`;
    if (p.via !== "") s += ` at ${p.via}`;
  } else {
    s += ", not seen yet";
  }
  if (p.platform !== "") s += `; ${p.platform}`;
  return s;
}

/** The phone's own short form for who-is-who: "app 0.66.0" (null while unknown). */
export function phoneShort(app: number): string | null {
  return app > 0 && app !== APP_INBOX ? `app ${codeName(app)}` : null;
}

/** What `gather` reads from the hub and the update module. */
export interface VersionsInput {
  me: Me;
  /** The name to use while the mesh has none for this PC. */
  hostname: string;
  meshOn: boolean;
  peers: readonly Peer[];
  /** This PC's own Harbor version and `update::info`. */
  version: string;
  update: unknown;
  paired: readonly PairedPhone[];
  /** The phones paired with this PC itself (not those learned from other PCs). */
  local: readonly PairedPhone[];
  /** Per PC: its name and the phones it saw. */
  elsewhere: readonly (readonly [string, readonly Sighting[]])[];
  /** versionCode of the app this PC serves (0: none). */
  served: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every PC (this one first) and phone the hub knows of. */
export function gatherVersions(input: VersionsInput, at: number = now()): [PcVersion[], PhoneVersion[]] {
  const { me } = input;
  const pcs: PcVersion[] = [
    { id: me.id, name: me.name === "" ? input.hostname : me.name, me: true, online: true, seen: at, version: input.version, update: input.update },
  ];
  if (input.meshOn) {
    const peers = [...input.peers].sort((a, b) => Number(b.online) - Number(a.online) || cmp(a.name, b.name));
    for (const p of peers) pcs.push({ id: p.id, name: p.name, me: false, online: p.online, seen: p.seen, version: p.version, update: p.update });
  }
  const phones: PhoneVersion[] = input.paired.map((p) => ({
    name: p.name === "" ? "Phone" : p.name,
    app: p.app,
    seen: Math.max(p.seen, p.alive),
    via: p.via,
    platform: p.platform,
  }));
  // Phones paired with another PC only.
  const known = new Set(input.local.map((p) => p.group));
  const extra = new Map<string, PhoneVersion>();
  for (const [pc, sightings] of input.elsewhere) {
    for (const s of sightings) {
      if (known.has(s.group)) continue;
      let e = extra.get(s.group);
      if (!e) {
        e = newPhoneVersion();
        extra.set(s.group, e);
      }
      e.app = Math.max(e.app, s.app);
      const seen = Math.max(s.seen, s.alive);
      if (s.platform !== "" && (e.platform === "" || seen >= e.seen)) e.platform = s.platform;
      if (seen >= e.seen) {
        e.seen = seen;
        e.via = pc;
        if (s.name !== "") e.name = s.name;
      }
    }
  }
  for (const p of extra.values()) phones.push({ ...p, name: p.name === "" ? "Phone" : p.name });
  phones.sort((a, b) => b.seen - a.seen);
  return [pcs, phones];
}

/** `GET /v1/versions`: the same lines the agent reads, for the phone's PCs sheet (from 0.68). */
export function versionsJson(input: VersionsInput, at: number = now()): Json {
  const [pcs, phones] = gatherVersions(input, at);
  const newest = newestVersion(pcs);
  return {
    newest,
    pcs: pcs.map((p) => ({ name: p.name, self: p.me, online: p.me || p.online, seen: p.seen, version: p.version, line: pcLine(p, newest, at) })),
    phones: phones.map((p) => ({
      name: p.name,
      app: p.app,
      app_version: p.app > 0 ? codeName(p.app) : "",
      seen: p.seen,
      via: p.via,
      platform: p.platform,
      line: phoneLine(p, input.served, at),
    })),
  };
}

/** For the agent (`machines` `list`): a "Harbor versions" section. */
export function versionsText(input: VersionsInput, at: number = now()): string {
  const [pcs, phones] = gatherVersions(input, at);
  const newest = newestVersion(pcs);
  let out = `Harbor versions (newest known: ${newest === "" ? "unknown" : newest}):`;
  for (const p of pcs) out += `\n- ${p.name}${p.me ? " (this PC)" : ""}: Harbor ${pcLine(p, newest, at)}`;
  if (phones.length === 0) {
    out += "\nPhones: none paired";
  } else {
    out += "\nPhones:";
    for (const p of phones) out += `\n- ${p.name}: ${phoneLine(p, input.served, at)}`;
  }
  return out;
}

/** The input from a Hub: `own` is what update.rs says about this PC. */
export function versionsInput(hub: Hub, own: { hostname: string; version: string; update: unknown; served: number }): VersionsInput {
  return {
    me: hub.mesh.me,
    hostname: own.hostname,
    meshOn: hub.mesh.on,
    peers: [...hub.mesh.peers.values()],
    version: own.version,
    update: own.update,
    paired: hub.pairedPhones(),
    local: hub.localPhones(),
    elsewhere: [...hub.elsewhere.values()],
    served: own.served,
  };
}
