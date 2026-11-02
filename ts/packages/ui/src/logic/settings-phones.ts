import { agoShort, PHONE_ALIVE_SECS, PHONE_OPEN_SECS, phoneAppNote, short as keyShort } from "@harbor/net";
import type { Kv, PairedPhone, Token } from "@harbor/net";
import { ICONS } from "../icons.ts";
import { badge, btn, buttons, copy, list, qr, row, rows, status, title, type Block, type BlockImage, type BlockTab } from "./settings-blocks.ts";
import { outsideBlocks, outsideEdited, outsidePressed, outsideToggled, type OutsideHost } from "./settings-outside.ts";

/** Where the phone app comes from: not this PC, whose key a phone's browser can't check. */
export const APK_URL = "https://github.com/RDevNeo/harbor/releases/latest/download/harbor-android.apk";

/** What the phone API listens on (hub.net). */
export interface PhonesNet {
  addrs: string[];
  bound: string[];
  error: string;
}

export interface PhonesHost {
  kv: Kv;
  now(): number;
  enabled(): boolean;
  /** Turns the phone API on or off (and starts it). */
  setEnabled(on: boolean): void;
  net(): PhonesNet;
  port(): number;
  firewallBlocks(port: number): boolean;
  openFirewall(): void;
  outside: OutsideHost;
  /** This PC's workspace id ("" when it's in none), its name, and whether the signed-in account owns it. */
  workspace(): string;
  workspaceName(): string | null;
  owner(): boolean;
  /** The signed-in account's id. */
  accountId(): string | null;
  /** Every pairing; those without an account are from before Google accounts. */
  tokens(): Token[];
  phones(): PairedPhone[];
  /** Signs a phone out of the account and forgets its pairing. */
  signOut(fp: string): void;
  removeOldTokens(): void;
  /** Calls refused lately, newest last: [unix s, why]. */
  refused(): [number, string][];
  /** The app this PC carries: its versionCode (0 when it can't tell), or null without one. */
  apk(): { code: number } | null;
  /** Draws a QR code. */
  qr(text: string): BlockImage;
  copy(text: string): void;
  downloadApk(): void;
  downloadBusy(): boolean;
  downloadResult(): { ok: true; code: number } | { ok: false; error: string } | null;
  openAccount(): void;
}

const ago = (t: number, now: number) => (agoShort(t, now) === "now" ? "just now" : `${agoShort(t, now)} ago`);

function phoneLine(host: PhonesHost, t: Token, phones: PairedPhone[]): string {
  const now = host.now();
  const phone = t.group === "" ? undefined : phones.find((p) => p.group === t.group);
  let last = "";
  if (phone && Math.max(phone.seen, phone.alive) > 0) {
    const via = phone.via === "" ? "" : ` via ${phone.via}`;
    if (now - phone.seen < PHONE_OPEN_SECS) last = ` · Harbor open${via}`;
    else if (now - phone.alive < PHONE_ALIVE_SECS) last = ` · online${via}, app in the background (checked in ${ago(phone.alive, now)})`;
    else {
      const at = Math.max(phone.seen, phone.alive);
      last = agoShort(at, now) === "now" ? ` · seen just now${via}` : ` · last seen ${agoShort(at, now)} ago${via}`;
    }
  }
  const note = phone ? phoneAppNote(phone.app, phone.seen, host.apk()?.code ?? 0) : null;
  if (note) last += ` · ${note[0]}`;
  const who = t.account_name === "" ? "Signed in" : `Signed in as ${t.account_name}`;
  return `${who} · key ${keyShort(t.fp)}${last}`;
}

/** phonesui.rs `phones_tab`. */
export function phonesBlocks(host: PhonesHost): Block[] {
  const on = host.enabled();
  const out: Block[] = [
    rows([
      row("Phone access", {
        desc: "Harbor for Android lists, opens and starts this PC's chats over your network. Every connection is encrypted with this PC's key and the phone's own, and Harbor answers only phones signed in with Google by people in this PC's workspace.",
        key: "phones_on",
        control: "toggle",
        on,
      }),
    ]),
  ];
  const port = host.port();
  if (on) {
    const net = host.net();
    if (net.addrs.length === 0) out.push(status(badge("No network", "amber"), "This PC has no network address right now (it's checked again every 20 s).", { before: 16 }));
    else if (net.bound.length > 0) out.push(status(badge("Listening", "green"), `${net.addrs.slice(0, 6).join("  ")} · port ${port}`, { before: 16, title: "mono" }));
    else out.push(status(badge("Starting"), `port ${port}`, { before: 16, title: "mono" }));
    if (net.error !== "") out.push(copy(`Couldn't listen on ${net.error}`, 12, { before: 8 }));
    if (host.firewallBlocks(port)) {
      out.push(status(badge("Firewall", "amber"), `This PC's firewall (ufw) drops port ${port}: phones on your network can't reach it.`, { before: 14, buttons: [btn("fix_firewall", "Allow on the local network", { variant: "primary" })] }));
    }
    out.push(...outsideBlocks(host.outside));
  }

  out.push(title("Add a phone"));
  const name = host.workspaceName();
  if (name !== null) {
    out.push(
      copy(
        `Install Harbor for Android (below) and sign in with Google there, with an account in this PC's workspace, “${name}”. The phone finds this PC and the workspace's other PCs on its own: no code to scan or confirm. To add someone else, invite them in Settings › Account.`,
        14,
      ),
    );
  } else if (host.workspace() === "") out.push(copy("Sign in on this PC first (Settings › Account): phones reach the PCs of their account's workspaces.", 14));
  else out.push(copy("Install Harbor for Android (below) and sign in with Google there, with an account in this PC's workspace.", 14));
  if (host.workspace() === "") out.push(buttons([btn("open_account", "Open Settings › Account", { icon: ICONS.USER_ROUND })], { before: 14 }));

  out.push(title("Phones"));
  const all = host.tokens();
  const tokens = all.filter((t) => t.account !== "");
  const old = all.length - tokens.length;
  const phones = host.phones();
  const mayAll = host.owner();
  const me = host.accountId();
  out.push(
    list(
      tokens.map((t) => {
        const may = (me !== null && me === t.account) || mayAll;
        return row(t.name === "" ? "Phone" : t.name, {
          icon: ICONS.SMARTPHONE,
          line: phoneLine(host, t, phones),
          buttons: may ? [btn(`signout:${t.fp}`, "Sign out", { variant: "destructive", tip: "Signs this phone out of the account: every PC refuses it from their next directory update (a few minutes). For a lost phone." })] : [],
        });
      }),
      "No phone has connected yet.",
    ),
  );
  if (old > 0) {
    out.push(status(badge(""), `${old} phone pairing${old === 1 ? "" : "s"} from before Google accounts: they can only update the app, then sign in.`, { size: 12, before: 14, buttons: [btn("remove_old", "Remove", { variant: "destructive" })] }));
  }
  const refused = [...host.refused()].reverse().slice(0, 4);
  if (refused.length > 0) {
    out.push(copy("Recently refused", 12, { before: 14 }));
    for (const [at, what] of refused) out.push(copy(`${agoShort(at, host.now())} ago · ${what}`, 12, { before: 8, title: "mono" }));
  }

  out.push(title("Install the app"));
  const apk = host.apk();
  if (apk) {
    const v = apk.code > 0 ? `Harbor for Android (build ${apk.code})` : "Harbor for Android";
    out.push(copy(`${v} is on this PC. To install it, scan the code with the phone's camera (it downloads the latest release); the app updates itself from this PC afterwards.`, 14));
  } else out.push(copy("This PC doesn't have the app yet. Installed copies of Harbor get it with every update; this one can download it from the latest release.", 14));
  if (on) out.push(qr(APK_URL, host.qr(APK_URL), [btn("copy_url", "", { icon: ICONS.COPY, variant: "muted", tip: "Copy" })], { before: 16 }));
  const busy = host.downloadBusy();
  const result = host.downloadResult();
  const text = result === null ? (busy ? "Downloading…" : "") : result.ok ? `Build ${result.code} is ready.` : result.error;
  out.push(buttons([btn("download", apk ? "Download the latest app" : "Download the app", { icon: ICONS.DOWNLOAD })], { before: 16, text }));
  return out;
}

/** The tab's controls over `host`. */
export function phonesTab(host: PhonesHost): BlockTab {
  return {
    blocks: () => phonesBlocks(host),
    pressed(key) {
      if (outsidePressed(host.outside, key)) return;
      if (key === "fix_firewall") host.openFirewall();
      else if (key === "open_account") host.openAccount();
      else if (key === "remove_old") host.removeOldTokens();
      else if (key === "copy_url") host.copy(APK_URL);
      else if (key === "download") {
        if (!host.downloadBusy()) host.downloadApk();
      } else if (key.startsWith("signout:")) host.signOut(key.slice(8));
    },
    toggled(key, on) {
      if (outsideToggled(host.outside, key, on)) return;
      if (key === "phones_on") host.setEnabled(on);
    },
    edited(key, text) {
      outsideEdited(host.outside, key, text);
    },
    submitted: () => "",
  };
}
