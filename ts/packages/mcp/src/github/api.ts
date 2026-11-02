import type { Shared } from "@harbor/net";
import { type Forwarder, meshPort } from "../ghmesh.ts";
import { GhApi, type HostPort, type Json } from "../ghapi.ts";
import { detailsPort } from "./details.ts";
import { issuesPort } from "./issues.ts";
import { prsPort } from "./prs.ts";

export interface GhWiring {
  shared: Shared;
  mesh: Forwarder;
  host: HostPort;
  blocks(md: string): Json;
  deviceId(token: string): string;
  clock?: () => number;
}

export function createGhApi(w: GhWiring): GhApi {
  const mesh = meshPort(w.shared, w.mesh);
  const deps = { prs: prsPort, issues: issuesPort, details: detailsPort({ http: mesh.http }), mesh, host: w.host, blocks: w.blocks, deviceId: w.deviceId };
  return new GhApi(w.clock ? { ...deps, clock: w.clock } : deps);
}
