import { loadPrefs, NOTE_KINDS, prefsOn, savePrefs, type Prefs } from "@harbor/net";
import type { Kv } from "./settings.ts";

/** One row of slint/settings-notifications.slint (`NotifyRow`). */
export interface NotifyRow {
  kind: "toggle" | "range" | "button";
  key: string;
  title: string;
  desc: string;
  on: boolean;
  from: string;
  to: string;
  label: string;
}

export interface NotifySection {
  title: string;
  rows: NotifyRow[];
}

/** What the Send a test button does: the shell posts the test note to the hub and shows its popup. */
export interface NotifyEnv {
  sendTest(): void;
}

const DESC: Record<string, string> = {
  input: "A lead chat asks you something, or waits for you after a usage limit.",
  done: "A lead chat's turn ends (once its sub-agents are done too), or stops with an error.",
  agent: "Each sub-agent's turn. Off by default: the lead tells you.",
  ci: "Checks fail on one of your open pull requests (looked at every 10 minutes).",
  limit: "An account hits its usage limit or your cap, or comes back.",
  discord: "The Discord app needs you: a captcha to solve, a session Discord ended, tools a repair couldn't fix.",
  whatsapp: "This PC's WhatsApp link ended (unlinked from the phone, or by WhatsApp).",
};
const DESC_PC = "Another PC of your mesh stops answering, or answers again.";

const row = (r: Partial<NotifyRow> & Pick<NotifyRow, "kind" | "key" | "title" | "desc">): NotifyRow => ({ on: false, from: "", to: "", label: "", ...r });

/** notify.rs `notifications_tab`: what the desktop shows, when, and the phones' test. */
export function notificationsSections(kv: Kv): NotifySection[] {
  const p = loadPrefs(kv);
  return [{ title: "Notify me when", rows: NOTE_KINDS.map(([kind, title]) => row({ kind: "toggle", key: `kind:${kind}`, title, desc: DESC[kind] ?? DESC_PC, on: prefsOn(p, kind) })) }];
}

/** Rust writes every kind as shown along with the change; the shell reloads `loadPrefs(kv)` into the desktop after. */
function save(kv: Kv, change: (p: Prefs) => void): void {
  const p = loadPrefs(kv);
  for (const [kind] of NOTE_KINDS) p.kinds[kind] = prefsOn(p, kind);
  change(p);
  savePrefs(kv, p);
}

/** A toggle of the Notifications tab, written to kv `notify`; false for a key that isn't one of its. */
export function setNotifications(kv: Kv, key: string, value: boolean): boolean {
  if (key.startsWith("kind:")) {
    const kind = key.slice(5);
    if (!NOTE_KINDS.some(([k]) => k === kind)) return false;
    save(kv, (p) => {
      p.kinds[kind] = value;
    });
  } else return false;
  return true;
}

/** The quiet hours' two times, kept as typed (an invalid time just means no quiet hours, as in Rust). */
export function editNotifications(kv: Kv, key: string, text: string): boolean {
  return false;
}

export function notifyPressed(key: string, env: NotifyEnv): boolean {
  if (key !== "notify_test") return false;
  env.sendTest();
  return true;
}
