import { type Dest as NetDest, type Peer as NetPeer, type Reply as NetReply, type Shared, dest as peerDest, http, jsonBody } from "@harbor/net";
import type { Dest, MeshPort, Peer, Reply } from "./ghapi.ts";

export interface Forwarder {
  forward(d: NetDest, name: string, method: string, path: string[], body: Record<string, unknown>, files: { name: string; data: Uint8Array }[], sender: [string, string], ctx: unknown): Promise<NetReply>;
}

const MAP_WAIT_MS = 8000;

function netDest(d: Dest): NetDest {
  if (typeof d.addr !== "string" || typeof d.fp !== "string") throw new Error("not a PC address");
  return { addr: d.addr, fp: d.fp, via: isPeerDest(d.via) ? d.via : undefined };
}

function isPeerDest(v: unknown): v is NetDest {
  return typeof v === "object" && v !== null && "addr" in v && "fp" in v;
}

function ghPeer(p: NetPeer): Peer {
  return { id: p.id, name: p.name, online: p.online, dest: { ...peerDest(p) } };
}

export function meshPort(shared: Shared, mesh: Forwarder, wait: number = MAP_WAIT_MS): MeshPort {
  return {
    enabled: () => shared.on,
    me: () => shared.me,
    peers: () => [...shared.peers.values()].map(ghPeer),
    peer: (id) => {
      const p = [...shared.peers.values()].find((x) => x.id === id);
      return p ? ghPeer(p) : undefined;
    },
    async http(d, method, path, body, waitMs) {
      return http(netDest(d), method, path, body === undefined || body === null ? null : jsonBody(body as never), waitMs);
    },
    async forward(peer, req) {
      const r = await mesh.forward(netDest(peer.dest), peer.name, req.method, req.path, (req.body ?? {}) as Record<string, unknown>, [], req.sender, req.ctx);
      return { status: r.status, body: r.body };
    },
    async mapNew(home, reply, global): Promise<Reply> {
      const body = reply.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) return reply;
      const o = body as Record<string, unknown>;
      const hid = o.id;
      if (reply.status >= 300 || typeof hid !== "number" || !Number.isInteger(hid)) return reply;
      if (global) return { status: reply.status, body: { ...o, id: o.gid } };
      const until = Date.now() + wait;
      while (Date.now() < until) {
        const local = shared.localId(home, hid);
        if (local !== null) return { status: reply.status, body: { ...o, id: local } };
        await new Promise((r) => setTimeout(r, 50));
      }
      return { status: reply.status, body: { ...o, id: null } };
    },
  };
}
