import { agoShort, hostLabel, runningVersion, short as keyShort } from "@harbor/net";
import type { AccountPc, Me, Peer, PeerDevice, RemoteHost } from "@harbor/net";
import { ICONS } from "../icons.ts";
import { badge, btn, field, form, list, row, title, type Block, type BlockRow } from "./settings-blocks.ts";

/** A phone signed in to this PC: whose it is (the account) and its key. */
export interface PhoneEntry {
  fp: string;
  /** Its device name as the Devices panel shows it ("Sam's Pixel 9"); "" when none is known. */
  name: string;
  /** The account id that signed it in. */
  account: string;
  accountName: string;
}

/** The machines the Workspace page shows under each person: this PC, the PCs it trusts, the phones signed in here. */
export interface DevicesHost {
  now(): number;
  me(): Me;
  myFp(): string;
  versionLabel(): string;
  /** The PCs of the workspaces this account is a member of (account.ts `usablePcs`): the only other PCs it uses, so the only
   * ones the page lists. */
  peers(): AccountPc[];
  /** The mesh's peers, for whether a PC answers now. */
  meshPeers(): Peer[];
  /** Gives this PC another name ("": back to the default); its id and key stay. */
  rename(name: string): void;
  copy(text: string): void;
  phones(): PhoneEntry[];
  signOutPhone(fp: string): void;
  /** Devices added by SSH before (they still run chats). */
  ssh: {
    devices(): [RemoteHost, boolean | null][];
    remove(id: string): void;
  };
}

export interface DevicesState {
  /** The rename form is open under this PC's card. */
  renaming: boolean;
}
export const newDevicesState = (): DevicesState => ({ renaming: false });

export function thisPcRow(h: DevicesHost, st: DevicesState): BlockRow {
  return row(h.me().name, {
    icon: ICONS.MONITOR,
    badges: [badge("This PC", "green")],
    line: `Harbor ${h.versionLabel()} · key ${keyShort(h.myFp())}`,
    buttons: [
      btn("rename", "Rename", { enabled: !st.renaming, tip: "The name your other PCs and phones show for this PC" }),
      btn("copy_key", "", { icon: ICONS.COPY, variant: "muted", tip: "Copy this PC's full key" }),
    ],
  });
}

/** A peer PC: online now (the mesh hears it), else when the directory or the mesh last saw it. `owner`: say whose
 *  workspace it comes from ("Sam's Workspace"). */
export function pcRow(h: DevicesHost, pc: AccountPc, owner = false): BlockRow {
  const peer = h.meshPeers().find((p) => p.fp === pc.fp);
  const online = peer?.online ?? false;
  const seen = Math.max(peer?.seen ?? 0, pc.seen);
  const ago = agoShort(seen, h.now());
  const status = online ? "" : seen > 0 ? (ago === "now" ? "seen just now" : `last seen ${ago} ago`) : "offline";
  // The Harbor it really runs (its update info's build, as the Devices panel shows), not the version it advertises to old peers.
  const version = (peer ? runningVersion(peer) : "") || pc.version;
  const bits = [owner ? ownersWorkspace(pc.owner_name) : "", version !== "" ? `Harbor ${version}` : "", status].filter((b) => b !== "");
  return row(pc.name || peer?.name || "PC", {
    icon: ICONS.MONITOR,
    badges: [badge(online ? "Online" : "Offline", online ? "green" : "gray")],
    line: bits.join(" · "),
  });
}

export function phoneRow(p: PhoneEntry, canSignOut: boolean): BlockRow {
  return row(p.name || "Phone", {
    icon: ICONS.SMARTPHONE,
    line: "Phone",
    buttons: canSignOut ? [btn(`phone_signout:${p.fp}`, "Sign out", { variant: "destructive" })] : [],
  });
}

export function renameForm(h: DevicesHost): Block {
  return form("rename", [field("name", "This PC's name", { text: h.me().name, min: 1 })], btn("rename_save", "Save", { variant: "primary" }), {
    before: 8,
    frame: "header",
    title: "Rename this PC",
    desc: "Your other PCs, your phones and your workspace show this name. Its key and id stay the same.",
    cancel: btn("rename_cancel", "Cancel"),
  });
}

/** A PC that comes from someone else's workspace, by its owner's first name: "Sam's Workspace". */
export function ownersWorkspace(ownerName: string): string {
  const first = ownerName.trim().split(/\s+/)[0] ?? "";
  return first === "" ? "Shared workspace" : `${first}'s Workspace`;
}

/** A machine a PC added over SSH says just that; which PC it came through is the row above it. */
const SSH_LINE = "SSH";

/** This PC's own SSH devices (not the ones that are PCs of `known`): under This PC, each with its status and Remove. */
export function ownDeviceRows(h: DevicesHost, known: readonly AccountPc[]): BlockRow[] {
  return h.ssh
    .devices()
    .filter(([d]) => !known.some((p) => p.id === d.id || p.name === hostLabel(d)))
    .map(([d, online]) =>
      row(hostLabel(d), {
        icon: ICONS.LAPTOP,
        line: `${SSH_LINE} · ${online === true ? "online" : online === false ? "offline" : "status unknown"}`,
        buttons: [btn(`ssh_remove:${d.id}`, "Remove", { variant: "destructive" })],
      }),
    );
}

/** The SSH devices a peer PC added (its hello's `devices`, as last heard), under that PC; none that are PCs of `known`. */
export function peerDeviceRows(h: DevicesHost, pc: AccountPc, known: readonly AccountPc[]): BlockRow[] {
  const peer = h.meshPeers().find((p) => (pc.fp !== "" && p.fp === pc.fp) || p.id === pc.id);
  return (peer?.devices ?? [])
    .filter((d: PeerDevice) => !known.some((p) => p.name === d.name) && d.name !== h.me().name)
    .map((d) => row(d.name, { icon: ICONS.LAPTOP, line: SSH_LINE }));
}

/** Devices added by SSH before, with Remove: a small section at the end, only when there are any (signed out, or before a
 * workspace is picked: there's no person's card to put them in). */
export function otherDevices(h: DevicesHost, known: readonly AccountPc[]): Block[] {
  const rows = ownDeviceRows(h, known);
  return rows.length === 0 ? [] : [title("Other devices"), list(rows, "")];
}

/** The device buttons of the Workspace page; false for a key that isn't one. */
export function devicesPressed(h: DevicesHost, st: DevicesState, key: string): boolean {
  if (key === "copy_key") h.copy(h.myFp());
  else if (key === "rename") st.renaming = true;
  else if (key === "rename_cancel") st.renaming = false;
  else if (key.startsWith("phone_signout:")) h.signOutPhone(key.slice("phone_signout:".length));
  else if (key.startsWith("ssh_remove:")) h.ssh.remove(key.slice("ssh_remove:".length));
  else return false;
  return true;
}

export function devicesSubmitted(h: DevicesHost, st: DevicesState, key: string, values: readonly string[]): boolean {
  if (key !== "rename") return false;
  h.rename(values[0] ?? "");
  st.renaming = false;
  return true;
}
