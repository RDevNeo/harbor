// What the agents package gets from mcp: kept out of both packages, so neither imports the other.
import { agent, setAgentEnv } from "./packages/agents/src/index.ts";
import { bridge, machines, mcp, workspace } from "./packages/mcp/src/index.ts";

/** Both mirror bridge.rs's Grant field for field; agents only passes it through. */
const asGrant = (g: agent.Grant): bridge.Grant => g as unknown as bridge.Grant;
type Extra = Parameters<typeof mcp.claudeConfig>[1];

export function wire(): void {
  setAgentEnv(mcp.agentEnvAs);
  agent.integrate({
    servers: {
      claudeConfig: (chat, extra, apps) => mcp.claudeConfig(chat, extra as Extra, apps),
      claudeServers: (extra) => mcp.claudeServers(extra === null ? undefined : (extra as Extra[number])),
      codexArgs: () => mcp.codexArgs(),
      machinesName: machines.NAME,
    },
    bridge: {
      grant: (g) => bridge.grant(asGrant(g)),
      revoke: (t) => bridge.revoke(t),
      resume: (dir) => bridge.resume(dir),
      remoteConfig: (g, port) => bridge.remoteConfig(asGrant(g), port),
      origin: bridge.ORIGIN,
    },
    workspace: { forAccess: workspace.forAccess, replaced: workspace.REPLACED, note: workspace.note },
  });
}
