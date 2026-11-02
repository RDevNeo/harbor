import { providers } from "@harbor/agents";
import { limits, type Store } from "@harbor/store";
import { accountInfo, setUsage, usageData, type UsageData } from "./logic/settings-usage.ts";
import { sumResults } from "./logic/pages.ts";
import type { Pixels } from "./logos.ts";

/** A Limits over the store with no chats and nothing to start: the caps, blocks and settings the Usage page reads and writes. */
function limitsOf(store: Store, accounts: () => readonly providers.Account[]): limits.Limits {
  const infos = () => accounts().map(accountInfo);
  return new limits.Limits({
    store,
    chat: () => undefined,
    chats: () => [],
    account: (id) => infos().find((a) => a.id === id),
    accounts: infos,
    pending: new Map(),
    turnRunning: () => false,
    runningSubs: () => 0,
    startTurn: () => {},
    notice: () => {},
    noteLimit: () => {},
    noteResumed: () => {},
    notify: () => {},
    persist: () => {},
    setAccount: () => {},
    sessionFile: () => null,
  });
}

/** The Usage page over a store: its data (caps checked first, as the app does every few seconds) and its controls. */
export function usageFeed(store: Store, logo: (kind: providers.Kind, dark: boolean) => Pixels) {
  let accounts = providers.discover();
  const lim = limitsOf(store, () => accounts);
  lim.load();
  return {
    view(dark: boolean): UsageData {
      accounts = providers.discover();
      lim.ctl.checkCaps();
      const names = new Map(store.repos().map((r) => [r.id, r.name]));
      const chats = new Map(store.chats().map((c): [number, [string, string]] => [c.id, [c.account, c.repoId === null ? "" : (names.get(c.repoId) ?? "")]]));
      const today = Math.floor(lim.now() / 86400);
      return usageData({ accounts, limits: lim, totals: sumResults(store.results(), chats, today), today, logo: (k) => logo(k, dark) });
    },
    act: (what: string, a: string, n: number): boolean => setUsage(lim, store, what, a, n),
  };
}
