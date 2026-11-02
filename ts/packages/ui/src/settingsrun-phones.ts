import { hostPort, lanAddrs, loadTokens, saveTokens, type Kv } from "@harbor/net";
import { type Store } from "@harbor/store";
import { type AccountPort } from "./logic/settings-account.ts";
import { type PhonesHost } from "./logic/settings-phones.ts";
import { type OutsideHost } from "./logic/settings-outside.ts";
import { type BlockImage } from "./logic/settings-blocks.ts";

/** The Phones tab over this PC's store alone: no API is listening, no phone has called, and downloads do nothing. */
export function phonesHost(store: Store, account: AccountPort & { removeDevice(fp: string): Promise<void> }, outside: OutsideHost, qr: (text: string) => BlockImage, openAccount: () => void): PhonesHost {
  const kv: Kv = store;
  const port = () => {
    const t = store.get("api_port") ?? "";
    return /^\d+$/.test(t) ? Number(t) : 47930;
  };
  return {
    kv,
    now: () => Math.floor(Date.now() / 1000),
    enabled: () => store.get("api_enabled") === "1",
    setEnabled: (on) => store.set("api_enabled", on ? "1" : "0"),
    net: () => ({ addrs: lanAddrs().map((a) => hostPort(a, port())), bound: [], error: "" }),
    port,
    firewallBlocks: () => false,
    openFirewall: () => {},
    outside,
    workspace: () => account.workspace(),
    workspaceName: () => account.directory().workspaces.find((w) => w.id === account.workspace())?.name ?? null,
    owner: () => account.directory().workspaces.find((w) => w.id === account.workspace())?.role === "owner",
    accountId: () => account.account()?.id ?? null,
    tokens: () => loadTokens(store),
    phones: () => [],
    signOut: (fp) => {
      void account.removeDevice(fp);
      saveTokens(store, loadTokens(store).filter((t) => t.fp !== fp || t.account === ""));
    },
    removeOldTokens: () => saveTokens(store, loadTokens(store).filter((t) => t.account !== "")),
    refused: () => [],
    apk: () => null,
    qr,
    copy: () => {},
    downloadApk: () => {},
    downloadBusy: () => false,
    downloadResult: () => null,
    openAccount,
  };
}
