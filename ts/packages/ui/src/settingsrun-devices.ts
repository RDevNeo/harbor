import { loadRemote, loadTokens, scopeHasDevice, usablePcs, newTailnet, readMe, remoteDevices, renamePc, saveRemote, setHelloName, type AccountService, type Hub, type Mesh } from "@harbor/net";
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
  /** Builds of Harbor's main on this PC (update/followmain.ts); absent where it can't run. */
  followMain?: FollowMainView | null;
}

export interface FollowMainView {
  possible(): boolean;
  on(): boolean;
  checkout(): string | null;
  line(): string;
  setOn(on: boolean): void;
}

export function devicesHost(store: Store, refresh: () => void, myFp: () => string, copy: (text: string) => void, runtime?: SettingsRuntime): DevicesHost {
  return {
    now: () => Math.floor(Date.now() / 1000),
    me: () => runtime?.hub.mesh.me ?? readMe(store),
    myFp,
    versionLabel: () => runtime?.version ?? harborVersion(),
    // The PCs of the workspaces this account is a member of: the ones it uses (account.ts `pcScope`).
    peers: () => (runtime ? usablePcs(runtime.account.directory(), myFp()) : []),
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
      // An SSH device that is a Harbor PC this account doesn't use (not a member of its workspace) isn't listed.
      devices: () =>
        remoteDevices({ home: homedir(), selfExe: () => null, sshConfig: () => [], probe: () => undefined }, loadRemote(store), newTailnet()).filter(
          ([d]) => !runtime || scopeHasDevice(runtime.account.scope(), d.id, runtime.hub.mesh.peers.has(d.id)),
        ),
      remove(id) {
        const cfg = loadRemote(store);
        saveRemote(store, { ...cfg, devices: cfg.devices.filter((d) => d.id !== id) });
        refresh();
      },
    },
  };
}
