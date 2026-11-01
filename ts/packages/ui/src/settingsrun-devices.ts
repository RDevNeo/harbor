import { homedir } from "node:os";
import { basename } from "node:path";
import {
  agoShort,
  allowedJson,
  allowedKey,
  confirmOwner,
  githubOf,
  hostPort,
  lanAddrs,
  lanPortmapNet,
  loadAllowed,
  loadCode,
  loadProfileDetected,
  loadRemote,
  newHost,
  newTailnet,
  normalizeFp,
  Portmap,
  ownerConfirmed,
  ownerOf,
  profileFullName,
  profileNodeEnv,
  readMe,
  remoteDevices,
  saveRemote,
  showCode,
  type Kv,
  type OwnerSources,
  type RemoteCtx,
  type RemoteProbe,
} from "@harbor/net";
import { machines } from "@harbor/mcp";
import { type Store } from "@harbor/store";
import { type DevicesHost } from "./logic/settings-devices.ts";

/** The Devices tab over this PC's store alone: no mesh is running, so there are no peers, nothing is paired and the buttons that reach out do nothing. */
export function devicesHost(store: Store, refresh: () => void, myFp: () => string): DevicesHost {
  const kv: Kv = store;
  const env = profileNodeEnv();
  const owners: OwnerSources = { accountOwnerName: () => null, signedIn: () => (store.get("account") ?? "") !== "", fullName: () => profileFullName(env), githubUser: () => null };
  const ctx: RemoteCtx = { home: homedir(), selfExe: () => null, sshConfig: () => [], probe: (): RemoteProbe | undefined => undefined };
  const port = () => {
    const t = store.get("api_port") ?? "";
    return /^\d+$/.test(t) ? Number(t) : 47930;
  };
  const now = () => Math.floor(Date.now() / 1000);
  const portmap = new Portmap({ kv, net: lanPortmapNet() });
  return {
    kv,
    now,
    mesh: {
      on: () => store.get("mesh_enabled") === "1",
      setOn: (on) => store.set("mesh_enabled", on ? "1" : "0"),
      me: () => readMe(store),
      myFp,
      versionLabel: () => "0.108.0 (ts)",
      ownVersion: () => "0.108.0",
      ownLatest: () => "",
      peers: () => [],
      allowed: () => loadAllowed(store),
      seen: () => new Map(),
      lan: () => [],
      chatsCopied: () => 0,
      phonesOn: () => store.get("api_enabled") === "1",
      setPhonesOn: (on) => store.set("api_enabled", on ? "1" : "0"),
      port,
      firewallBlocks: () => false,
      openFirewall: () => {},
      addrs: () => lanAddrs().map((a) => hostPort(a, port())),
      allow(key, name, allow) {
        const list = loadAllowed(store).filter((a) => allowedKey(a) !== key && a.node !== key);
        if (allow) {
          const fp = normalizeFp(key);
          list.push(fp !== null ? { node: "", name, fp, id: "", addrs: [] } : { node: key, name, fp: "", id: "", addrs: [] });
        }
        store.set("mesh_allowed", allowedJson(list));
        refresh();
      },
      shareLevel: (id) => machines.levelFor(store, id),
      setShareLevel: (id, l) => machines.setLevel(store, id, l),
      updatePeers: () => {},
      autoUpdatePeers: () => {},
      enablePhonesOn: () => {},
      copy: () => {},
    },
    pair: {
      shown: () => loadCode(store),
      show: () => {
        showCode(store);
        return null;
      },
      cancel: () => store.set("mesh_pair", ""),
      busy: () => false,
      join: () => {},
      result: () => null,
    },
    outside: { kv, port, summary: (p) => portmap.summary(p), firewallBlocksInternet: () => false, openInternetFix: () => {} },
    people: {
      shownOwner: () => ownerOf(kv, owners),
      shownGithub: () => githubOf(kv, owners),
      check: () => {
        const d = loadProfileDetected(kv);
        return ownerConfirmed(kv, owners) || d === null || ownerOf(kv, owners) === "" ? null : { why: d.me.why };
      },
      detectedStatus: () => {
        const d = loadProfileDetected(kv);
        return d === null ? "Not run yet." : `Last run ${agoShort(d.at, now())} (${d.by === "rules" ? "rules only: no Claude account to ask" : d.by}).`;
      },
      detecting: () => false,
      pcs: () => [],
      confirm: () => confirmOwner(kv, owners),
      detect: () => {},
      changed: () => {},
    },
    ssh: {
      config: () => loadRemote(kv),
      save: (c) => saveRemote(kv, c),
      devices: () => remoteDevices(ctx, loadRemote(kv), newTailnet()),
      probe: () => null,
      login: (h) => {
        const c = loadRemote(kv);
        const user = h.user !== "" ? h.user : c.user;
        return user === "" ? null : [user, false];
      },
      sshPort: (h) => (h.port !== 0 ? h.port : loadRemote(kv).port),
      offers: () => [],
      homeName: () => basename(homedir()),
      test: () => {},
      add(name, host, user, p) {
        const c = loadRemote(kv);
        let n = 1;
        while (c.devices.some((d) => d.id === `ssh:${n}`)) n++;
        const id = `ssh:${n}`;
        saveRemote(kv, { ...c, devices: [...c.devices, newHost({ id, name, host, user, port: p, bridge: true })] });
        return id;
      },
      removeIcon: () => {},
      pickImage: () => {},
      terminal: () => {},
    },
  };
}
