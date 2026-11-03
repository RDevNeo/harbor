import { agoShort, hostLabel, short as keyShort } from "@harbor/net";
import type { AccountPc, Kv, Me, Peer, RemoteHost } from "@harbor/net";
import { ICONS } from "../icons.ts";
import { badge, btn, copy, field, form, list, row, title, type Block, type BlockRow, type BlockTab } from "./settings-blocks.ts";

export interface MeshHost {
  me(): Me;
  myFp(): string;
  versionLabel(): string;
  /** The PCs whose owner shares a workspace with this PC's owner (the directory's peers): the only PCs it trusts. */
  pcs(): AccountPc[];
  /** The mesh's peers, for whether a PC answers now. */
  peers(): Peer[];
  /** Gives this PC another name ("": back to the default); its id and key stay. */
  rename(name: string): void;
  copy(text: string): void;
}

export interface DevicesHost {
  kv: Kv;
  now(): number;
  mesh: MeshHost;
  /** Whether this PC is signed in to a workspace (otherwise the list says where to do it). */
  inWorkspace(): boolean;
  phones(): BlockRow[];
  signOut(fp: string): void;
  ssh: {
    devices(): [RemoteHost, boolean | null][];
    remove(id: string): void;
  };
}

export interface DevicesState {
  /** The rename form is open under the list. */
  renaming: boolean;
}
export const newDevicesState = (): DevicesState => ({ renaming: false });

/** A workspace PC's line: online now (the mesh hears it), else when the directory or the mesh last saw it. */
function pcRow(pc: AccountPc, peer: Peer | undefined, now: number): BlockRow {
  const online = peer?.online ?? false;
  const seen = Math.max(peer?.seen ?? 0, pc.seen);
  const status = online ? "Online" : seen > 0 ? `Last seen ${agoShort(seen, now)} ago` : "Offline";
  const version = peer?.version || pc.version;
  const via = pc.via && pc.via.length > 0 ? ` (${pc.via.join(", ")})` : "";
  const owner = pc.owner_name !== "" ? ` · ${pc.owner_name}${via}` : via !== "" ? ` ·${via}` : "";
  return row(pc.name || peer?.name || "PC", {
    icon: ICONS.MONITOR,
    desc: `${status}${version ? ` · Harbor ${version}` : ""}${owner}`,
    badges: [badge(online ? "Online" : "Offline", online ? "green" : "gray")],
  });
}

function deviceRows(h: DevicesHost, st: DevicesState): BlockRow[] {
  const m = h.mesh;
  const lines = [
    row(`${m.me().name} (this PC)`, {
      icon: ICONS.MONITOR,
      desc: `Harbor ${m.versionLabel()} · key ${keyShort(m.myFp())}`,
      buttons: [
        btn("rename", "Rename", { enabled: !st.renaming, tip: "The name your other PCs and phones show for this PC" }),
        btn("copy_key", "", { icon: ICONS.COPY, variant: "muted", tip: "Copy this PC's full key" }),
      ],
    }),
  ];
  const peers = m.peers();
  const now = h.now();
  for (const pc of m.pcs()) lines.push(pcRow(pc, peers.find((p) => p.fp === pc.fp), now));
  // Devices added by SSH before (they still run chats); listed so they can be removed.
  for (const [d, online] of h.ssh.devices()) {
    if (m.pcs().some((p) => p.id === d.id || p.name === hostLabel(d))) continue;
    lines.push(row(hostLabel(d), { icon: ICONS.MONITOR, desc: `SSH · ${online === true ? "Online" : online === false ? "Offline" : "Status unknown"}`, buttons: [btn(`ssh_remove:${d.id}`, "Remove", { variant: "destructive" })] }));
  }
  lines.push(...h.phones());
  return lines;
}

export function devicesBlocks(h: DevicesHost, st: DevicesState): Block[] {
  const out: Block[] = [title("Your devices", 11), list(deviceRows(h, st), "")];
  if (st.renaming) {
    out.push(
      form("rename", [field("name", "This PC's name", { text: h.mesh.me().name, min: 1 })], btn("rename_save", "Save", { variant: "primary" }), {
        before: 8,
        frame: "header",
        title: "Rename this PC",
        desc: "Your other PCs, your phones and your workspace show this name. Its key and id stay the same.",
        cancel: btn("rename_cancel", "Cancel"),
      }),
    );
  }
  const note = h.inWorkspace()
    ? "This PC shares chats with the PCs of everyone who shares a workspace with you. Invite someone to your workspace (Settings › Workspace) and their PCs show here."
    : "Sign in and pick a workspace (Settings › Workspace): this PC then shares chats with that workspace's PCs.";
  out.push(copy(note, 13, { before: 10 }));
  return out;
}

export function devicesTab(h: DevicesHost): BlockTab {
  const st = newDevicesState();
  return {
    blocks: () => devicesBlocks(h, st),
    pressed(key) {
      if (key === "copy_key") h.mesh.copy(h.mesh.myFp());
      else if (key === "rename") st.renaming = true;
      else if (key === "rename_cancel") st.renaming = false;
      else if (key.startsWith("signout:")) h.signOut(key.slice(8));
      else if (key.startsWith("ssh_remove:")) h.ssh.remove(key.slice(11));
    },
    toggled() {},
    edited() {},
    submitted(key, values) {
      if (key === "rename") {
        h.mesh.rename(values[0] ?? "");
        st.renaming = false;
      }
      return "";
    },
  };
}
