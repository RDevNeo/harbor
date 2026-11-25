// Hub's agents reach the other PCs (shell, files, gh over SSH on Tailscale) through hub-machines, a small stdio MCP
// server shipped beside Hub (packaging/hub-install.sh puts it in <install>/hub-machines/), in place of Harbor's mesh
// `machines` tools. Same server name ("machines"), so its tools are mcp__machines__list/bash/read/grep/glob/github.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { selfArgv } from "./paths.ts";

export const NAME = "machines";

type Env = Record<string, string | undefined>;

/** Where the server is: HUB_MACHINES_SERVER, else hub-machines/server.ts beside Hub's executable; null when it isn't there. */
export function serverPath(env: Env = process.env, exe: string = selfArgv()[0] ?? ""): string | null {
  const p = env.HUB_MACHINES_SERVER ?? (exe === "" ? "" : join(dirname(exe), "hub-machines", "server.ts"));
  return p !== "" && existsSync(p) ? p : null;
}

/** Its MCP entry for a turn (Node runs the .ts as it is), or null: then the turn has no machines tools. */
export function entry(env: Env = process.env, which: (cmd: string) => string | null = (c) => Bun.which(c), exe?: string): { type: "stdio"; command: string; args: string[]; env?: Record<string, string> } | null {
  const p = serverPath(env, exe);
  if (p === null) return null;
  const node = env.HUB_MACHINES_NODE ?? which("node");
  if (node === null || node === "") return null;
  return { type: "stdio", command: node, args: [p], ...(env.HUB_MACHINES_CONFIG ? { env: { HUB_MACHINES_CONFIG: env.HUB_MACHINES_CONFIG } } : {}) };
}
