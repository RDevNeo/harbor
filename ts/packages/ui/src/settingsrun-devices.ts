import { loadRemote, loadTokens, newTailnet, readMe, remoteDevices, renamePc, saveRemote, setHelloName, type AccountService, type Hub, type Mesh } from "@harbor/net";
import { harborVersion } from "@harbor/mcp";
import { type Store } from "@harbor/store";
import { homedir } from "node:os";
import { type DevicesHost } from "./logic/settings-devices.ts";

/** The running app supplies its existing services; isolated screenshot runners use the store alone. */
export interface SettingsRuntime {
  account: AccountService;
  hub: Hub;
  mesh: Mesh;
  /** This Harbor's own version (the mesh advertises an older one to old peers). */
  version: string;
}

export function devicesHost(store: Store, refresh: () => void, myFp: () => string, copy: (text: string) => void, runtime?: SettingsRuntime): DevicesHost {
  return {
    now: () => Math.floor(Date.now() / 1000),
    me: () => runtime?.hub.mesh.me ?? readMe(store),
    myFp,
    versionLabel: () => runtime?.version ?? harborVersion(),
    // The PCs whose owner shares a workspace with this PC's owner (the directory's peers): the ones it trusts.
    peers: () => (runtime?.account.directory().peers ?? []).filter((p) => p.fp !== "" && p.fp !== myFp()),
    meshPeers: () => [...(runtime?.hub.mesh.peers.values() ?? [])],
    rename(name) {
      const me = renamePc(store, name);
      if (runtime) {
        // Peers read it in their next hello, phones in their next poll, the workspace's directory on the next register.
        runtime.hub.mesh.me = { ...runtime.hub.mesh.me, name: me.name };
        setHelloName(me.name);
        runtime.account.poke();
      }
      refresh();
    },
    copy,
    // Phones signed in with an account (the ones from before accounts can only update their app).
    phones: () => (runtime?.hub.tokens ?? loadTokens(store)).filter((t) => t.account !== "").map((t) => ({ fp: t.fp, name: t.name, account: t.account, accountName: t.account_name })),
    signOutPhone(fp) {
      if (!runtime) return;
      void runtime.account.removeDevice(fp).then(() => {
        runtime.hub.tokens = runtime.hub.tokens.filter((t) => t.fp !== fp);
        runtime.hub.tokensDirty = true;
        refresh();
      });
    },
    ssh: {
      devices: () => remoteDevices({ home: homedir(), selfExe: () => null, sshConfig: () => [], probe: () => undefined }, loadRemote(store), newTailnet()),
      remove(id) {
        const cfg = loadRemote(store);
        saveRemote(store, { ...cfg, devices: cfg.devices.filter((d) => d.id !== id) });
        refresh();
      },
    },
  };
}
