import { allowedJson, allowedKey, hostPort, lanAddrs, loadAllowed, loadCode, loadRemote, loadTokens, newTailnet, normalizeFp, readMe, remoteDevices, saveRemote, short as keyShort, showCode, type AccountService, type Hub, type Mesh } from "@harbor/net";
import { harborVersion } from "@harbor/mcp";
import { type Store } from "@harbor/store";
import { homedir } from "node:os";
import { ICONS } from "./icons.ts";
import { btn, row } from "./logic/settings-blocks.ts";
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
  const port = () => runtime?.hub.port ?? Number(store.get("api_port") ?? "47930");
  let busy = false;
  let result: { ok: boolean; text: string } | null = null;
  return {
    kv: store,
    now: () => Math.floor(Date.now() / 1000),
    mesh: {
      me: () => runtime?.hub.mesh.me ?? readMe(store), myFp,
      versionLabel: () => runtime?.version ?? harborVersion(),
      peers: () => [...(runtime?.hub.mesh.peers.values() ?? [])],
      allowed: () => loadAllowed(store),
      seen: () => runtime?.hub.mesh.seen ?? new Map(),
      addrs: () => lanAddrs().map((a) => hostPort(a, port())),
      copy,
      allow(key, name, allow) {
        const change = (all: ReturnType<typeof loadAllowed>) => {
          const keep = all.filter((a) => allowedKey(a) !== key && a.node !== key);
          if (allow) keep.push({ node: normalizeFp(key) ? "" : key, fp: normalizeFp(key) ?? "", name, id: "", addrs: [] });
          all.splice(0, all.length, ...keep);
        };
        if (runtime) runtime.mesh.updateAllowed(change);
        else { const all = loadAllowed(store); change(all); store.set("mesh_allowed", allowedJson(all)); }
        refresh();
      },
    },
    pair: {
      shown: () => loadCode(store),
      show: () => { showCode(store); return null; },
      cancel: () => store.set("mesh_pair", ""), busy: () => busy, result: () => result,
      join(addr, code) {
        if (!runtime || busy) return;
        busy = true; result = null;
        void runtime.mesh.pairJoin(addr, code).then(
          (pc) => { result = { ok: true, text: `Paired with ${pc.name || addr}.` }; },
          (e: unknown) => { result = { ok: false, text: e instanceof Error ? e.message : String(e) }; },
        ).finally(() => { busy = false; refresh(); });
      },
    },
    phones: () => {
      const acc = runtime?.account;
      const tokens = runtime?.hub.tokens ?? loadTokens(store);
      const me = acc?.account();
      const owner = me?.workspaces.some((w) => w.id === acc?.workspace() && w.role === "owner");
      return tokens.filter((t) => t.account !== "").map((t) => row(t.name || "Phone", {
        icon: ICONS.SMARTPHONE,
        desc: `${t.account_name ? `Signed in as ${t.account_name}` : "Signed in"} · key ${keyShort(t.fp)}`,
        buttons: owner || me?.id === t.account ? [btn(`signout:${t.fp}`, "Sign out", { variant: "destructive" })] : [],
      }));
    },
    signOut(fp) {
      if (!runtime) return;
      void runtime.account.removeDevice(fp).then(() => {
        runtime.hub.tokens = runtime.hub.tokens.filter((t) => t.fp !== fp);
        runtime.hub.tokensDirty = true;
        refresh();
      });
    },
    ssh: {
      devices: () => remoteDevices({ home: homedir(), selfExe: () => null, sshConfig: () => [], probe: () => undefined }, loadRemote(store), newTailnet()),
      remove(id) { const cfg = loadRemote(store); saveRemote(store, { ...cfg, devices: cfg.devices.filter((d) => d.id !== id) }); },
    },
  };
}
