import { providers } from "@harbor/agents";
import type { Pixels } from "../logos.ts";
import type { Kv } from "./settings.ts";

export interface ProviderMeter {
  label: string;
  frac: number;
  pct: string;
}

export type ProviderState = "ready" | "signed-out" | "installed";

/** The row button's text. */
export type ProviderAction = "Install" | "Sign in" | "Re-auth";

/** One account's row, as slint/settings-providers.slint draws it (`ProviderRow`). */
export interface ProviderRow {
  id: string;
  logo: Pixels;
  badge: string;
  name: string;
  sub: string;
  plan: string;
  email: string;
  meters: ProviderMeter[];
  installed: boolean;
  state: ProviderState;
  action: ProviderAction;
  primary: boolean;
  is_default: boolean;
}

export interface ProvidersData {
  rows: ProviderRow[];
}

/** pages.rs `providers_tab`: every account with its state. */
export function providersData(accounts: readonly providers.Account[], defaultAccount: string, logo: (kind: providers.Kind) => Pixels): ProvidersData {
  const rows = accounts.map((a): ProviderRow => {
    const installed = providers.installed(a);
    const signedOut = a.loggedIn === false;
    return {
      id: a.id,
      logo: logo(a.kind),
      badge: a.badge,
      name: a.kind === "Claude" ? a.name : a.kind,
      sub: a.kind === "Claude" ? `Claude \u{b7} ${a.badge}` : "",
      plan: a.plan,
      email: installed ? a.email : "",
      meters: a.usage.map((w) => ({ label: w.label, frac: w.percent, pct: `${Math.round(w.percent * 100)}%` })),
      installed,
      state: signedOut ? "signed-out" : a.loggedIn === true ? "ready" : "installed",
      action: !installed ? "Install" : signedOut ? "Sign in" : "Re-auth",
      primary: installed && signedOut,
      is_default: a.id === defaultAccount,
    };
  });
  return { rows };
}

/** What "Add Claude account" runs in the terminal: the first free ~/.claudeN from 2 on (app.rs `add_claude_account`). */
export function addClaudeAccount(home: string, exists: (path: string) => boolean, hasProfileTool: boolean): { title: string; script: string; dir: string } {
  let n = 9;
  for (let i = 2; i < 20; i++) {
    if (!exists(`${home}/.claude${i}`)) {
      n = i;
      break;
    }
  }
  const dir = `${home}/.claude${n}`;
  const script = hasProfileTool ? `claude-profile --setup claude${n} && CLAUDE_CONFIG_DIR=${dir} claude /login` : `mkdir -p ${dir} && CLAUDE_CONFIG_DIR=${dir} claude /login`;
  return { title: `Claude account ${n}`, script, dir };
}

/** "Make default": the account, its first model, its provider's default effort and full access (app.rs `set_sel`). */
export function makeDefault(kv: Kv, a: providers.Account, model: string): void {
  const kind = a.kind;
  const acc = providers.access(kind).some((x) => x[0] === "full") ? "full" : (providers.access(kind)[0]?.[0] ?? "full");
  const rows: [string, string][] = [
    ["default_account", a.id],
    ["default_model", model],
    ["default_effort", providers.defaultEffort(kind)],
    ["default_access", acc],
  ];
  for (const [k, v] of rows) kv.set(k, v);
}

/** The model "Make default" picks: the first that isn't under "More models". */
export function firstModel(models: readonly providers.Model[]): string {
  return models.find((m) => !m.more)?.id ?? "";
}
