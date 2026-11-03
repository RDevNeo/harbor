import { providers } from "@harbor/agents";
import { type Pixels, providerLogo } from "./logos.ts";
import { firstModel, label, makeDefault, providersData, type ProvidersData, toggleAccount } from "./logic/settings-providers.ts";
import type { Kv } from "./logic/settings.ts";
import { pick } from "./logic/text.ts";
import { token } from "./theme.ts";

/** What the Providers tab asks of the shell: the terminal for sign-in and Claude accounts. */
export interface ProvidersHost {
  login(id: string): void;
  addClaudeAccount(): void;
  modelsFor(kind: providers.Kind): providers.Model[];
  /** The app's account list changed (an account turned off or removed): read it again, as Refresh does. */
  changed?(): void;
}

const ACTS = ["add", "login", "default", "on", "off", "remove", "remove_yes", "remove_no"] as const;

/** Every provider's logo in both themes, loaded once. */
export async function providerLogos(): Promise<(kind: providers.Kind, dark: boolean) => Pixels> {
  const logos = new Map<string, Pixels>();
  for (const dark of [true, false]) for (const k of providers.KINDS) logos.set(`${k}:${dark}`, await providerLogo(k, token("fg", dark)));
  return (k, dark) => logos.get(`${k}:${dark}`) ?? { width: 1, height: 1, data: new Uint8Array(4) };
}

/** The tab's data and its buttons over `kv`, with both themes' logos loaded. */
export async function providersFeed(kv: Kv, host: ProvidersHost, logos?: Awaited<ReturnType<typeof providerLogos>>) {
  const logoOf = logos ?? (await providerLogos());
  let accounts = providers.discover();
  let confirming = "";
  let note = "";
  const defaultOf = () => kv.get("default_account") ?? "claude";
  return {
    view(dark: boolean): ProvidersData {
      accounts = providers.discover();
      return providersData(accounts, defaultOf(), (k) => logoOf(k, dark), confirming, note);
    },
    act(id: string, what: string): void {
      const a = accounts.find((x) => x.id === id);
      const act = pick(what, ACTS);
      if (act !== "remove_yes") note = "";
      if (act !== "remove") confirming = "";
      if (act === "add") host.addClaudeAccount();
      else if (act === "login" && a) host.login(a.id);
      else if (act === "default" && a) {
        if (a.off === true) providers.setOff(a.id, false);
        makeDefault(kv, a, firstModel(host.modelsFor(a.kind)));
        if (a.off === true) host.changed?.();
      } else if ((act === "on" || act === "off") && a) {
        const r = toggleAccount(accounts, defaultOf(), a.id, act === "on", providers.setOff);
        if ("error" in r) note = r.error;
        else if (r.newDefault !== null) {
          makeDefault(kv, r.newDefault, firstModel(host.modelsFor(r.newDefault.kind)));
          note = `${label(a)} is off. New chats use ${label(r.newDefault)}.`;
        }
        host.changed?.();
      } else if (act === "remove" && a && providers.removable(a)) confirming = a.id;
      else if (act === "remove_yes" && a && providers.removable(a)) {
        try {
          if (a.id === defaultOf()) {
            const next = providers.fallback(accounts.filter((x) => x.id !== a.id), "Claude");
            if (next) makeDefault(kv, next, firstModel(host.modelsFor(next.kind)));
          }
          providers.removeAccount(a);
          note = `Removed ${label(a)}. Its folder was kept in Harbor's removed-accounts folder.`;
        } catch (e) {
          note = `Couldn't remove ${label(a)}: ${e instanceof Error ? e.message : String(e)}`;
        }
        host.changed?.();
      }
    },
  };
}
