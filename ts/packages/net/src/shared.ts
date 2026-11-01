import { canonical, ipString, parseIp } from "./ip.ts";
import { kvJson, type Kv } from "./kv.ts";
import { tailnetIp } from "./tls.ts";

export interface Me {
  id: string;
  name: string;
}

/** Where a request goes: an address and the key that must answer there ("" = plain HTTP, loopback only); `via`: through that PC (relay). */
export interface Dest {
  addr: string;
  fp: string;
  via?: Dest | undefined;
  /** The key this PC shows there, when not the process's own (several PCs in one test). */
  as?: import("./tls.ts").Identity | undefined;
}

/** Another PC's Harbor. Serialized fields match mesh.rs's `Peer` in kv `mesh_peers`. */
export interface Peer {
  id: string;
  name: string;
  addr: string;
  dns: string;
  online: boolean;
  seen: number;
  version: string;
  accounts: [string, string, string][];
  node: string;
  phones: boolean;
  fp: string;
  addrs: string[];
  via?: Dest | undefined;
  owner: string;
  github: string;
  owner_suggested: boolean;
  update: unknown;
  moves: boolean;
}

export function newPeer(p: Partial<Peer> & { id: string }): Peer {
  return {
    name: "",
    addr: "",
    dns: "",
    online: false,
    seen: 0,
    version: "",
    accounts: [],
    node: "",
    phones: false,
    fp: "",
    addrs: [],
    owner: "",
    github: "",
    owner_suggested: false,
    update: null,
    moves: false,
    ...p,
  };
}

export function dest(p: Peer): Dest {
  return { addr: p.addr, fp: p.fp, via: p.via };
}

/** A Tailscale node (PCs allowed before 0.13 by node id). */
export interface Node {
  id: string;
  label: string;
  user: number | null;
  tagged: boolean;
}

/** A PC the user allowed: by key fingerprint, or (before 0.13) by Tailscale node id. kv `mesh_allowed`. */
export interface Allowed {
  node: string;
  name: string;
  fp: string;
  id: string;
  addrs: string[];
}

export function allowedKey(a: Allowed): string {
  return a.fp !== "" ? a.fp : a.node;
}

/** The id a peer allowed by key goes by here: its own when known. */
export function peerId(a: Allowed): string {
  return a.id !== "" ? a.id : `fp:${a.fp.slice(0, 16)}`;
}

/** A Harbor met that isn't linked. */
export interface Seen {
  node: string;
  fp: string;
  name: string;
  asked: number;
  refuses: boolean;
}

export type Down = "harbor" | "pc";

/** From the errors of trying each address: one refused means the PC is up without Harbor. */
export function downOf(errors: string[]): Down {
  return errors.some((e) => e.includes("refused") || e.includes("os error 111") || e.includes("ECONNREFUSED")) ? "harbor" : "pc";
}

/** Whether node `n` may share chats: allowed by the user, or an untagged node of the same Tailscale user. */
export function admit(me: Node | null, n: Node, allowed: Allowed[]): boolean {
  if (n.id === "") return false;
  return allowed.some((a) => a.node === n.id) || (me !== null && !me.tagged && !n.tagged && me.user !== null && me.user === n.user);
}

function asAllowed(v: unknown): Allowed | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const addrs = Array.isArray(o.addrs) ? o.addrs.filter((a): a is string => typeof a === "string") : [];
  return { node: s("node"), name: s("name"), fp: s("fp"), id: s("id"), addrs };
}

export function loadAllowed(kv: Kv): Allowed[] {
  const v = kvJson<unknown>(kv, "mesh_allowed", []);
  return Array.isArray(v) ? v.map(asAllowed).filter((a): a is Allowed => a !== null) : [];
}

/** Serialized in mesh.rs's field order (serde writes struct fields in declaration order). */
export function allowedJson(list: Allowed[]): string {
  return JSON.stringify(list.map((a) => ({ node: a.node, name: a.name, fp: a.fp, id: a.id, addrs: a.addrs })));
}

/** A socket address as Rust's SocketAddr prints it, or null. */
export function socketAddr(s: string): { ip: string; port: number; text: string } | null {
  const m = s.match(/^\[([^\]]+)\]:(\d+)$/) ?? s.match(/^([^:]+):(\d+)$/);
  if (!m?.[1] || !m[2]) return null;
  const ip = parseIp(m[1]);
  const port = Number(m[2]);
  if (!ip || port > 65535 || m[1].includes("%")) return null;
  const c = ipString(canonical(ip));
  const v6 = canonical(ip).v === 6;
  return { ip: c, port, text: v6 ? `[${c}]:${port}` : `${c}:${port}` };
}

function multicast(ip: string): boolean {
  const p = parseIp(ip);
  if (!p) return false;
  return p.v === 4 ? ((p.b[0] ?? 0) & 0xf0) === 0xe0 : p.b[0] === 0xff;
}

/** Addresses as given by a peer: valid "host:port"s only, canonical, at most 12. */
export function cleanAddrs(v: unknown[]): string[] {
  const out: string[] = [];
  for (const a of v) {
    if (typeof a !== "string") continue;
    const sa = socketAddr(a);
    if (sa && !/^(0\.0\.0\.0|::)$/.test(sa.ip) && !multicast(sa.ip) && !out.includes(sa.text)) out.push(sa.text);
    if (out.length >= 12) break;
  }
  return out;
}

/** "ts:desk" → "desk". */
export function label(id: string): string {
  const i = id.indexOf(":");
  return i < 0 ? id : id.slice(i + 1);
}

/** What the listener, the peer workers and the app share (mesh.rs `Shared`). */
export class Shared {
  on = false;
  me: Me = { id: "", name: "" };
  peers = new Map<string, Peer>();
  /** This PC's own chats deleted this run: [revision, id]. */
  gone: [number, number][] = [];
  foreign = new Set<number>();
  /** "peer\0id there" → the copy's id here. */
  ids = new Map<string, number>();
  gids = new Map<number, string>();
  homes = new Map<number, [string, number]>();
  node: Node | null = null;
  allowed: Allowed[] = [];
  seen = new Map<string, Seen>();
  hints = new Map<string, string[]>();
  down = new Map<string, Down>();
  about: { owner?: string; github?: string; owner_suggested?: boolean } = {};
  /** The workspace's PCs from the account directory (account.rs `mesh_peers`). */
  workspacePeers: () => Allowed[] = () => [];

  admits(n: Node): boolean {
    return admit(this.node, n, this.allowed);
  }

  /** The allowed entry of a key: paired by hand, or a PC of this PC's workspace. */
  allowedFp(fp: string): Allowed | null {
    if (fp === "") return null;
    return this.allowed.find((a) => a.fp === fp) ?? this.workspacePeers().find((a) => a.fp === fp) ?? null;
  }

  hint(fp: string, addr: string): void {
    const v = this.hints.get(fp) ?? [];
    if (!v.includes(addr)) {
      v.unshift(addr);
      v.length = Math.min(v.length, 8);
    }
    this.hints.set(fp, v);
  }

  /** Where a key may answer: where it last did, what it said, what was learned; the shared network's first. */
  addrsOfFp(fp: string): string[] {
    const v: string[] = [];
    const p = [...this.peers.values()].find((x) => x.fp === fp);
    if (p) v.push(p.addr, ...p.addrs);
    const a = this.allowedFp(fp);
    if (a) v.push(...a.addrs);
    v.push(...(this.hints.get(fp) ?? []));
    const out: string[] = [];
    for (const x of v) if (x !== "" && !out.includes(x)) out.push(x);
    const ts = (x: string) => {
      const sa = socketAddr(x);
      return sa !== null && tailnetIp(sa.ip) ? 1 : 0;
    };
    return out.map((x, i) => ({ x, i })).sort((a, b) => ts(a.x) - ts(b.x) || a.i - b.i).map((e) => e.x);
  }

  peer(id: string): Peer | null {
    return this.peers.get(id) ?? null;
  }

  online(id: string): boolean {
    return this.peers.get(id)?.online ?? false;
  }

  nameOf(id: string): string {
    const n = this.peer(id)?.name ?? "";
    return n !== "" ? n : label(id);
  }

  byGid(gid: string): number | null {
    for (const [id, g] of this.gids) if (g === gid) return id;
    return null;
  }

  localId(peer: string, id: number): number | null {
    return this.ids.get(`${peer}\0${id}`) ?? null;
  }
}
