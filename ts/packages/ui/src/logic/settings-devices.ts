import { agoShort, allowedKey, hostLabel, normalizeFp, short as keyShort } from "@harbor/net";
import type { Allowed, Kv, Me, PairCode, Peer, RemoteHost, Seen } from "@harbor/net";
import { ICONS } from "../icons.ts";
import { badge, btn, copy, field, form, list, row, title, type Block, type BlockRow, type BlockTab } from "./settings-blocks.ts";

export interface MeshHost {
  me(): Me;
  myFp(): string;
  versionLabel(): string;
  peers(): Peer[];
  allowed(): Allowed[];
  seen(): ReadonlyMap<string, Seen>;
  allow(key: string, name: string, allow: boolean): void;
  addrs(): string[];
  copy(text: string): void;
}

export interface PairHost {
  shown(): PairCode | null;
  show(): string | null;
  cancel(): void;
  busy(): boolean;
  join(addr: string, code: string): void;
  result(): { ok: boolean; text: string } | null;
}

export interface DevicesHost {
  kv: Kv;
  now(): number;
  mesh: MeshHost;
  pair: PairHost;
  phones(): BlockRow[];
  signOut(fp: string): void;
  ssh: {
    devices(): [RemoteHost, boolean | null][];
    remove(id: string): void;
  };
}

export interface DevicesState { pairAddr: string }
export const newDevicesState = (): DevicesState => ({ pairAddr: "" });

function deviceRows(h: DevicesHost): BlockRow[] {
  const m = h.mesh;
  const lines = [row(`${m.me().name} (this PC)`, {
    icon: ICONS.MONITOR,
    desc: `Harbor ${m.versionLabel()} · key ${keyShort(m.myFp())}`,
    buttons: [btn("copy_key", "", { icon: ICONS.COPY, variant: "muted", tip: "Copy this PC's full key" })],
  })];
  const peers = m.peers();
  const keys = new Map<string, string>();
  for (const a of m.allowed()) keys.set(allowedKey(a), a.name);
  for (const p of peers) keys.set(p.fp || p.node || p.id, p.name);
  for (const [key, name] of keys) {
    const p = peers.find((p) => p.fp === key || p.node === key || p.id === key);
    const last = p?.seen ?? 0;
    const status = p?.online ? "Online" : last > 0 ? `Last seen ${agoShort(last, h.now())} ago` : "Offline";
    lines.push(row(name || p?.name || "PC", {
      icon: ICONS.MONITOR,
      desc: `${status}${p?.version ? ` · Harbor ${p.version}` : ""}${normalizeFp(key) ? ` · key ${keyShort(key)}` : ""}`,
      badges: [badge(p?.online ? "Online" : "Offline", p?.online ? "green" : "gray")],
      buttons: [btn(`remove:${key}`, "Remove", { variant: "destructive" })],
    }));
  }
  for (const [d, online] of h.ssh.devices()) {
    if (peers.some((p) => p.id === d.id || p.name === hostLabel(d))) continue;
    lines.push(row(hostLabel(d), { icon: ICONS.MONITOR, desc: `SSH · ${online === true ? "Online" : online === false ? "Offline" : "Status unknown"}`, buttons: [btn(`ssh_remove:${d.id}`, "Remove", { variant: "destructive" })] }));
  }
  lines.push(...h.phones());
  return lines;
}

export function devicesBlocks(h: DevicesHost, st: DevicesState): Block[] {
  const shown = h.pair.shown();
  const now = h.now();
  let first: BlockRow;
  if (shown?.paired) first = row(`Paired with ${shown.paired}`, { buttons: [btn("pair_cancel", "Done")] });
  else if (shown && (shown.tries >= 5 || shown.expires <= now)) first = row("The code expired", { buttons: [btn("pair_show", "New code", { variant: "primary" })] });
  else if (shown) {
    const left = Math.max(0, shown.expires - now);
    first = row(`Code  ${shown.code}`, { desc: `On the other PC, enter this code and address ${h.mesh.addrs()[0] ?? "(no network)"} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`, buttons: [btn("pair_cancel", "Cancel")] });
  } else first = row("Show a code", { desc: "Show a one-time code to enter on your other PC.", buttons: [btn("pair_show", "Show a code", { variant: "primary" })] });
  const result = h.pair.result();
  return [
    title("Your devices", 11), list(deviceRows(h), ""),
    title("Pair a device"), list([first], ""),
    form("pair", [field("addr", "Its address (e.g. 10.0.0.12)", { min: 1, text: st.pairAddr }), field("code", "Code", { mono: true, width: 160, min: 10 })], btn("pair", h.pair.busy() ? "Pairing…" : "Pair", { variant: "primary", enabled: !h.pair.busy() }), { before: 16, frame: "header", title: "Enter a code", desc: "The address and code shown on your other PC." }),
    ...(result ? [copy(result.ok ? result.text : `Not paired: ${result.text}`, 13, { before: 8 })] : []),
  ];
}

export function devicesTab(h: DevicesHost): BlockTab {
  const st = newDevicesState();
  return {
    blocks: () => devicesBlocks(h, st),
    pressed(key) {
      if (key === "copy_key") h.mesh.copy(h.mesh.myFp());
      else if (key === "pair_show") h.pair.show();
      else if (key === "pair_cancel") h.pair.cancel();
      else if (key.startsWith("remove:")) h.mesh.allow(key.slice(7), "", false);
      else if (key.startsWith("signout:")) h.signOut(key.slice(8));
      else if (key.startsWith("ssh_remove:")) h.ssh.remove(key.slice(11));
    },
    toggled() {},
    edited() {},
    submitted(key, values) {
      if (key === "pair") {
        st.pairAddr = (values[0] ?? "").trim();
        h.pair.join(st.pairAddr, values[1] ?? "");
      }
      return "";
    },
  };
}
