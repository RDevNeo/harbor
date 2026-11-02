import { providers } from "@harbor/agents";
import { type Pixels, providerLogo } from "./logos.ts";
import { firstModel, makeDefault, providersData, type ProvidersData } from "./logic/settings-providers.ts";
import type { Kv } from "./logic/settings.ts";
import { pick } from "./logic/text.ts";
import { token } from "./theme.ts";

/** What the Providers tab asks of the shell: the terminal for sign-in and Claude accounts. */
export interface ProvidersHost {
  login(id: string): void;
  addClaudeAccount(): void;
  modelsFor(kind: providers.Kind): providers.Model[];
}

const ACTS = ["add", "login", "default"] as const;

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
  return {
    view(dark: boolean): ProvidersData {
      accounts = providers.discover();
      return providersData(accounts, kv.get("default_account") ?? "claude", (k) => logoOf(k, dark));
    },
    act(id: string, what: string): void {
      const a = accounts.find((x) => x.id === id);
      const act = pick(what, ACTS);
      if (act === "add") host.addClaudeAccount();
      else if (act === "login" && a) host.login(a.id);
      else if (act === "default" && a) makeDefault(kv, a, firstModel(host.modelsFor(a.kind)));
    },
  };
}
