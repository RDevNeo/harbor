import { AccountService, hostPort, lanAddrs, loadOrCreate, readMe } from "@harbor/net";
import { secrets, type Store, stateDir } from "@harbor/store";
import { accountTab } from "./logic/settings-account.ts";
import { devicesTab } from "./logic/settings-devices.ts";
import { secretsTab } from "./logic/settings-secrets.ts";
import { type BlockTab } from "./logic/settings-blocks.ts";
import { type Tab } from "./logic/pages.ts";
import { type SettingsRuntime, devicesHost } from "./settingsrun-devices.ts";

/** The tabs drawn from blocks, over this PC's store. `refresh` redraws the page when something outside changed. */
export async function blockTabs(store: Store, refresh: () => void, copy: (text: string) => void, runtime?: SettingsRuntime): Promise<Map<Tab, BlockTab>> {
  const tabs = new Map<Tab, BlockTab>();
  let ready = false;
  const now = () => Math.floor(Date.now() / 1000);
  const port = Number(store.get("api_port") ?? "47930");
  const account = runtime?.account ?? new AccountService({
    kv: store,
    stateDir: stateDir(),
    identity: () => loadOrCreate(stateDir()),
    me: () => readMe(store),
    addrs: () => lanAddrs().map((a) => hostPort(a, port)),
    version: "0.108.0",
    onChange: () => {
      if (ready) refresh();
    },
  });
  account.load();
  ready = true;
  const myFp = () => loadOrCreate(stateDir()).fp;
  tabs.set("account", accountTab({ account, myFp, onlineFps: () => new Set(), openUrl: () => {}, now }));
  const chatLabel = (id: number): string => {
    const c = store.chats().find((x) => x.id === id);
    return c === undefined ? "" : c.role === "sub" ? `${c.name} · ${c.title}` : c.title;
  };
  tabs.set("secrets", secretsTab({ store, path: secrets.secretsPath(), chatLabel, told: () => {}, now }));
  const devices = devicesHost(store, refresh, myFp, copy, runtime);
  tabs.set("devices", devicesTab(devices));
  return tabs;
}
