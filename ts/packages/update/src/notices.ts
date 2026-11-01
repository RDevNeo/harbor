import type { Kv } from "./reload.ts";
import type { State, UpdateInfo } from "./delivery.ts";
import type { RolledBack } from "./install.ts";

export const HARBOR_DISMISSED = "update_toast_dismissed";
export const PROVIDERS_DISMISSED = "provider_updates_dismissed";
export const ROLLBACK_DISMISSED = "rollback_toast_dismissed";

export const DONE_FOR_MS = 6000;

export const notesUrl = (v: string): string => `https://github.com/RDevNeo/harbor/releases/tag/v${v}`;

export type Icon = "sparkles" | "users" | "bot" | "providers" | "undo";

export interface Toast {
  id: "harbor-update-toast" | "provider-update-toast" | "invite-toast" | "rollback-toast";
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

export interface ProviderUpdate {
  kind: string;
}

export interface ProviderStatus {
  items: ProviderUpdate[];
  updating: boolean;
  error: string | null;
  done: { message: string; at: number } | null;
  key: string;
  names: string;
}

export function providerToast(st: ProviderStatus, dismissed: string | null, now: number): Toast | null {
  const done = st.done !== null && now - st.done.at < DONE_FOR_MS ? st.done.message : null;
  const offered = st.items.length > 0 && dismissed !== st.key;
  if (!st.updating && st.error === null && done === null && !offered) return null;
  const n = st.items.length;
  let title: string;
  let body: string;
  let primary: Toast["primary"];
  if (st.updating) {
    title = "Updating providers…";
    body = `Updating ${st.names}. Chats keep running.`;
    primary = { label: "Updating…", enabled: false };
  } else if (st.error !== null) {
    title = "A provider update failed";
    body = st.error;
    primary = n > 0 ? { label: "Try again", enabled: true } : null;
  } else if (offered) {
    title = `Updates available: ${n} provider${n === 1 ? "" : "s"}`;
    body = `${st.names} can be updated.`;
    primary = { label: "Update", enabled: true };
  } else {
    title = done ?? "";
    body = "Their new versions are in use from the next turn.";
    primary = null;
  }
  return { id: "provider-update-toast", icon: n === 0 ? "bot" : "providers", title, body, primary, secondary: "Settings" };
}

export interface Invite {
  id: string;
  ws_name: string;
  inviter_name: string;
  email: string;
}

export function inviteToast(invites: readonly Invite[], hidden: readonly string[], busy: boolean): { toast: Toast; invite: Invite } | null {
  const inv = invites.find((i) => !hidden.includes(i.id));
  if (inv === undefined) return null;
  const by = inv.inviter_name === "" ? "" : `${inv.inviter_name} invited you`;
  const who = by === "" ? `An invitation to ${inv.email}` : ` (${inv.email})`;
  const toast: Toast = {
    id: "invite-toast",
    icon: "users",
    title: `Join ${inv.ws_name === "" ? "a workspace" : inv.ws_name}?`,
    body: `${by}${who}. You'd share all of its PCs and chats, on every device. Nothing here changes: this PC stays in its workspace.`,
    primary: { label: "Accept", enabled: !busy },
    secondary: "Decline",
  };
  return { toast, invite: inv };
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
