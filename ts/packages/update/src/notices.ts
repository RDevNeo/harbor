import type { Kv } from "./reload.ts";
import type { State, UpdateInfo } from "./delivery.ts";
import type { RolledBack } from "./install.ts";

export const HARBOR_DISMISSED = "update_toast_dismissed";
export const ROLLBACK_DISMISSED = "rollback_toast_dismissed";

export const DONE_FOR_MS = 6000;

export const notesUrl = (v: string): string => `https://github.com/RDevNeo/harbor/releases/tag/v${v}`;

export type Icon = "sparkles" | "users" | "bot" | "providers" | "undo";

export interface Toast {
  id: "harbor-update-toast" | "rollback-toast";
  icon: Icon;
  title: string;
  body: string;
  primary: { label: string; enabled: boolean } | null;
  secondary: string;
}

export type Click = "none" | "primary" | "secondary" | "close";

export interface Offer {
  version: string;
  installing: boolean;
}

export function harborOffer(managed: boolean, state: State, ready: string | null): Offer | null {
  if (!managed) return null;
  if (ready !== null) return { version: ready, installing: false };
  if (state.t === "available") return { version: state.v, installing: false };
  if (state.t === "installing") return { version: state.v, installing: true };
  return null;
}

export function harborToast(offer: Offer | null, running: string, ready: boolean, asked: boolean, dismissed: string | null): Toast | null {
  if (offer === null || dismissed === offer.version) return null;
  const v = offer.version;
  const busy = offer.installing || asked;
  let title = `Harbor ${v} is available`;
  let body = `You have ${running}. Update installs it and reloads Harbor in place.`;
  if (busy) {
    title = `Updating Harbor to ${v}…`;
    body = "It reloads in place when it's ready; running agents keep going.";
  } else if (ready) {
    title = `Harbor ${v} is installed`;
    body = `You still run ${running}. Update restarts Harbor into it; running agents keep going.`;
  }
  return { id: "harbor-update-toast", icon: "sparkles", title, body, primary: { label: busy ? "Updating…" : "Update", enabled: !busy }, secondary: "What's new" };
}

export function rollbackToast(r: RolledBack | null, dismissed: string | null): Toast | null {
  if (r === null || dismissed === r.version) return null;
  return {
    id: "rollback-toast",
    icon: "undo",
    title: `Harbor ${r.version} didn't start`,
    body: `Harbor went back to ${r.restored === "" ? "the previous version" : r.restored} and won't try ${r.version} again on this PC. ${r.why}.`,
    primary: null,
    secondary: "What's new",
  };
}

export function dismiss(kv: Kv, key: string, value: string): void {
  kv.set(key, value);
}

export const dismissed = (kv: Kv, key: string): string | null => {
  const v = kv.get(key);
  return v === null || v === "" ? null : v;
};

export interface HubUpdate {
  version: string;
  current: string;
  installing: boolean;
  ready: boolean;
  checking?: boolean;
  notes_url?: string;
}

export function hubUpdate(info: UpdateInfo, state: State, asked: boolean): HubUpdate | null {
  const ready = info.ready ? info.latest : null;
  const offer = harborOffer(info.managed, state, ready);
  if (offer !== null && state.t === "available") {
    return { version: offer.version, current: info.version, installing: asked, ready: false, notes_url: notesUrl(offer.version) };
  }
  if (asked && state.t === "checking") return { version: "", current: info.version, installing: true, checking: true, ready: false };
  return null;
}
