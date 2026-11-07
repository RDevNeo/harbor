import { discord, mcp, whatsapp } from "@harbor/mcp";
import type { Tile } from "../applogos.ts";
import type { Pixels } from "../logos.ts";
import { pick } from "./text.ts";

export interface IntAccount {
  email: string;
  default: boolean;
  label: string;
}

/** The card's one button; "" for none. */
export type IntegrationAction = "" | "signin" | "google" | "signout" | "cancel" | "cancel-form" | "add";

/** What opens under the card's head. */
export type IntegrationForm = "" | "pending" | "discord-qr" | "discord" | "whatsapp-qr" | "whatsapp" | "google" | "key" | "accounts";

const ACTS = ["signin", "google", "signout", "cancel", "cancel-form", "add", "own-client", "save-key", "save-google", "get-key", "google-help", "harbors", "discord-ok", "discord-window", "whatsapp-ok", "whatsapp-code", "copy", "open-page", "make-default", "signout-account", "dismiss", "chip"] as const;

/** One app's card, as slint/settings-integrations.slint draws it (`IntApp`). */
export interface IntApp {
  id: string;
  label: string;
  sub: string;
  sub_tone: 0 | 1 | 2;
  tile: Tile;
  busy: boolean;
  action: IntegrationAction;
  action_text: string;
  action_primary: boolean;
  badge: boolean;
  gear: boolean;
  form: IntegrationForm;
  code: string;
  has_url: boolean;
  qr: Pixels;
  has_qr: boolean;
  window_btn: boolean;
  builtin_hint: boolean;
  builtin: boolean;
  client_id: string;
  client_secret: string;
  accounts: IntAccount[];
}

export interface IntRow {
  left: IntApp;
  right: IntApp;
  has_right: boolean;
}

export interface IntError {
  id: string;
  text: string;
}

export interface IntChip {
  id: string;
  label: string;
  tile: Tile;
  found: boolean;
  off: boolean;
  tip: string;
}

export interface IntData {
  rows: IntRow[];
  errors: IntError[];
  chips: IntChip[];
}

/** The form a card has open, which the Rust app keeps in the page's memory. */
export type Form = { kind: "key" } | { kind: "google"; clientId: string; secret: string } | { kind: "discord" } | { kind: "whatsapp" };

/** What the page reads of the apps; `mcp` answers it for real, a test answers it with canned values. */
export interface AppsView {
  pending(id: string): mcp.Pending | undefined;
  signedIn(id: string): boolean;
  account(id: string): string | undefined;
  error(id: string): string | undefined;
  googleBuiltin(): boolean;
  googleClient(id: string): { id: string; secret: string };
  googleAccounts(id: string): string[];
  /** The Discord card's line (discord.ts `cardLine`, which the phone shows too). */
  discordLine(about: string): { text: string; tone: number };
  /** The WhatsApp card's line (whatsapp.ts `cardLine`, which the phone shows too). */
  whatsappLine(about: string): { text: string; tone: number };
  locals(): { id: string; label: string; found: boolean }[];
  isOff(id: string): boolean;
}

export interface IntInput {
  view: AppsView;
  forms: ReadonlyMap<string, Form>;
  tile(name: string): Tile;
  /** The Discord QR code for a login URL. */
  qr(url: string): Pixels;
}

const blank: Pixels = { width: 1, height: 1, data: new Uint8Array(4) };

function card(a: mcp.App, i: IntInput): IntApp {
  const { view } = i;
  const pending = view.pending(a.id);
  const signed = view.signedIn(a.id);
  const form = i.forms.get(a.id);
  const google = a.auth.kind === "google";
  const discord = a.auth.kind === "discord";
  const wa = a.auth.kind === "whatsapp";
  const builtin = google && view.googleBuiltin() && view.googleClient(a.id).id === "";
  const accounts = google ? view.googleAccounts(a.id) : [];
  const line = discord ? view.discordLine(a.about) : wa ? view.whatsappLine(a.about) : undefined;

  let action: IntegrationAction = "signin";
  let actionText = wa ? "Link" : "Sign in";
  let primary = true;
  let badge = false;
  let gear = false;
  if (pending) [action, actionText, primary] = ["cancel", "Cancel", false];
  else if (form) [action, actionText, primary] = ["cancel-form", "Cancel", false];
  else if (signed && google) [action, actionText, primary] = ["add", "Add account", false];
  else if (signed) [action, actionText, primary, badge] = ["signout", wa ? "Unlink" : "Sign out", false, true];
  else if (builtin) [action, actionText, gear] = ["google", "Sign in with Google", true];

  let sub = a.about;
  let tone: IntApp["sub_tone"] = 0;
  if (pending?.note !== undefined) [sub, tone] = [pending.note, 1];
  else if (pending?.code !== undefined) [sub, tone] = [wa ? "Enter the code on your phone" : "Enter the code below in your browser", 1];
  else if (pending && wa) [sub, tone] = ["Getting WhatsApp ready\u{2026}", 1];
  else if (pending) [sub, tone] = ["Finish in your browser\u{2026}", 1];
  else if (form && (discord || wa)) sub = "Read this first";
  else if (form?.kind === "google") sub = "Add your Google OAuth client below";
  else if (form) sub = "Paste an API key below";
  else if (accounts.length > 1) sub = `${accounts.length} accounts`;
  else if (line !== undefined && (signed || line.tone !== 0)) [sub, tone] = [line.text, line.tone === 2 ? 2 : line.tone === 1 ? 1 : 0];
  else if (signed) sub = view.account(a.id) !== undefined ? `Signed in as ${view.account(a.id)}` : a.about;

  let open: IntegrationForm = "";
  if (pending && discord) open = pending.qr !== undefined ? "discord-qr" : "";
  else if (pending && wa) open = pending.qr !== undefined || pending.code !== undefined ? "whatsapp-qr" : "";
  else if (pending) open = pending.code !== undefined || pending.url !== undefined ? "pending" : "";
  else if (form) open = form.kind;
  else if (accounts.length > 0) open = "accounts";
  return {
    id: a.id,
    label: a.label,
    sub,
    sub_tone: tone,
    tile: i.tile(a.id),
    busy: pending !== undefined,
    action,
    action_text: actionText,
    action_primary: primary,
    badge,
    gear,
    form: open,
    code: pending?.code ?? "",
    has_url: pending?.url !== undefined,
    qr: pending?.qr !== undefined ? i.qr(pending.qr) : blank,
    has_qr: pending?.qr !== undefined,
    window_btn: pending !== undefined && discord && pending.window !== true,
    builtin_hint: pending !== undefined && !discord && !wa && builtin,
    builtin: view.googleBuiltin(),
    client_id: form?.kind === "google" ? form.clientId : "",
    client_secret: form?.kind === "google" ? form.secret : "",
    accounts: accounts.map((email, n) => ({ email, default: n === 0, label: n === 0 ? (accounts.length > 1 ? "Default" : "Signed in") : "" })),
  };
}

/** pages.rs `integrations_tab`: the apps in two columns, their errors, and the local MCP servers. */
export function integrationsData(i: IntInput): IntData {
  const cards = mcp.APPS.map((a) => card(a, i));
  const rows: IntRow[] = [];
  for (let n = 0; n < cards.length; n += 2) {
    const left = cards[n];
    if (left) rows.push({ left, right: cards[n + 1] ?? left, has_right: cards[n + 1] !== undefined });
  }
  const errors = mcp.APPS.flatMap((a): IntError[] => {
    const e = i.view.error(a.id);
    return e === undefined ? [] : [{ id: a.id, text: `${a.label}: ${e}` }];
  });
  const chips = i.view.locals().map((l): IntChip => {
    const off = i.view.isOff(l.id);
    return { id: l.id, label: l.label, tile: i.tile(l.label), found: l.found, off, tip: !l.found ? "Not set up on this machine" : off ? "Off for agents \u{b7} click to turn on" : "On for agents \u{b7} click to turn off" };
  });
  return { rows, errors, chips };
}

/** The apps as `mcp` has them. */
export function realView(): AppsView {
  return {
    pending: mcp.pending,
    signedIn: mcp.signedIn,
    account: mcp.account,
    error: mcp.error,
    googleBuiltin: mcp.googleBuiltin,
    googleClient: mcp.googleClient,
    googleAccounts: mcp.googleAccounts,
    discordLine: (about) => discord.card(about),
    whatsappLine: (about) => whatsapp.card(about),
    locals: () => mcp.locals().map((l) => ({ id: l.local.id, label: l.local.label, found: l.def !== undefined })),
    isOff: mcp.isOff,
  };
}

/** What a button of the page does outside it. */
export interface IntHost {
  /** Something changed: draw the page again. */
  changed(): void;
  openUrl(url: string): void;
  copy(text: string): void;
  /** Discord's own sign-in window. */
  discordWindow(): void;
}

/** The sign-in side of `mcp`, as a card's buttons use it. */
export interface AppsApi {
  signIn(id: string, changed: () => void): void;
  signOut(id: string): void;
  cancel(id: string): void;
  dismiss(id: string): void;
  saveKey(id: string, key: string): void;
  saveGoogleClient(id: string, clientId: string, secret: string): void;
  forgetGoogleClient(id: string): void;
  googleClient(id: string): { id: string; secret: string };
  googleDesktopClient(id: string): { id: string; secret: string } | undefined;
  setGoogleDefault(id: string, email: string): void;
  signOutAccount(id: string, email: string): void;
  toggleOff(id: string): void;
  /** WhatsApp's link by number: a code for the phone (signin.ts `whatsappCode`). */
  whatsappCode(id: string, phone: string, changed: () => void): void;
  pendingUrl(id: string): string | undefined;
}

export function realApi(): AppsApi {
  return { ...mcp, pendingUrl: (id) => mcp.pending(id)?.url };
}

/** A card's button (app.rs `app_card`, pages.rs `integrations_tab`): the form it opens, or what it asks of `mcp`. `a` and `b` are the form's inputs, or the email or text acted on. */
export function integrationsAct(api: AppsApi, forms: Map<string, Form>, host: IntHost, what: string, id: string, a: string, b: string): void {
  const app = mcp.app(id);
  const changed = () => host.changed();
  const ownClient = () => forms.set(id, { kind: "google", clientId: "", secret: "" });
  switch (pick(what, ACTS)) {
    case "signin":
      if (app?.auth.kind === "key") forms.set(id, { kind: "key" });
      else if (app?.auth.kind === "discord") forms.set(id, { kind: "discord" });
      else if (app?.auth.kind === "whatsapp") forms.set(id, { kind: "whatsapp" });
      else if (app?.auth.kind === "google") {
        const c = api.googleClient(id);
        forms.set(id, { kind: "google", clientId: c.id, secret: c.secret });
      } else api.signIn(id, changed);
      break;
    case "google":
      api.signIn(id, changed);
      break;
    case "own-client":
      ownClient();
      break;
    case "add":
      if (api.googleDesktopClient(id) !== undefined) api.signIn(id, changed);
      else ownClient();
      break;
    case "signout":
      api.signOut(id);
      break;
    case "cancel":
      api.cancel(id);
      break;
    case "cancel-form":
      forms.delete(id);
      break;
    case "save-key":
      if (a.trim() === "") return;
      api.saveKey(id, a);
      forms.delete(id);
      break;
    case "save-google":
      api.saveGoogleClient(id, a, b);
      api.signIn(id, changed);
      forms.delete(id);
      break;
    case "harbors":
      api.forgetGoogleClient(id);
      forms.delete(id);
      break;
    case "discord-ok":
      api.signIn(id, changed);
      forms.delete(id);
      break;
    case "whatsapp-ok":
      api.signIn(id, changed);
      forms.delete(id);
      break;
    case "whatsapp-code":
      if (a.replace(/\D/g, "").length < 8) return;
      api.whatsappCode(id, a, changed);
      break;
    case "discord-window":
      host.discordWindow();
      break;
    case "get-key":
      if (app?.auth.kind === "key") host.openUrl(app.auth.get);
      break;
    case "google-help":
      if (app?.auth.kind === "google") host.openUrl(app.auth.help);
      break;
    case "copy":
      host.copy(a);
      break;
    case "open-page": {
      const url = api.pendingUrl(id);
      if (url !== undefined) host.openUrl(url);
      break;
    }
    case "make-default":
      api.setGoogleDefault(id, a);
      break;
    case "signout-account":
      api.signOutAccount(id, a);
      break;
    case "dismiss":
      api.dismiss(id);
      break;
    case "chip":
      if (mcp.locals().some((l) => l.local.id === id && l.def !== undefined)) api.toggleOff(id);
      break;
    default:
      return;
  }
  host.changed();
}
