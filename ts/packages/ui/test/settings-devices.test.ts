import { expect, test } from "bun:test";
import { MemKv, newHost, newPeer, type AccountPc } from "@harbor/net";
import { devicesBlocks, devicesTab, newDevicesState, type DevicesHost } from "../src/logic/settings-devices.ts";
import { row } from "../src/logic/settings-blocks.ts";

const pc = (p: Partial<AccountPc> & { fp: string; name: string }): AccountPc => ({ id: "", addrs: [], owner: "", owner_name: "", seen: 0, version: "", ...p });

function rig(inWorkspace = true) {
  const calls: string[] = [];
  const h: DevicesHost = {
    kv: new MemKv(),
    now: () => 1000,
    inWorkspace: () => inWorkspace,
    mesh: {
      me: () => ({ id: "pc:desk", name: "Desk" }),
      myFp: () => "a".repeat(64),
      versionLabel: () => "0.130.0",
      pcs: () => [pc({ fp: "b".repeat(64), id: "pc:laptop", name: "Laptop", owner_name: "Sam", version: "0.129.0", seen: 400, via: ["Home"] }), pc({ fp: "c".repeat(64), id: "pc:studio", name: "Studio" })],
      peers: () => [newPeer({ id: "pc:laptop", fp: "b".repeat(64), online: true, version: "0.130.0" })],
      rename: (n) => {
        calls.push(`rename:${n}`);
      },
      copy: (t) => {
        calls.push(t);
      },
    },
    phones: () => [row("Phone", { desc: "Signed in as Sam · key abcd", buttons: [] })],
    signOut: (fp) => {
      calls.push(`signout:${fp}`);
    },
    ssh: {
      devices: () => [[newHost({ id: "ssh:1", name: "Build PC", host: "10.0.0.3" }), true]],
      remove: (id) => {
        calls.push(`ssh:${id}`);
      },
    },
  };
  return { h, calls };
}

test("Devices lists this PC, the workspace's PCs and the phones; there is no pairing", () => {
  const { h } = rig();
  const blocks = devicesBlocks(h, newDevicesState());
  expect(blocks.filter((b) => b.kind === "title").map((b) => b.title)).toEqual(["Your devices"]);
  expect(blocks.some((b) => b.kind === "form")).toBe(false);
  const rows = blocks.find((b) => b.kind === "list")?.rows ?? [];
  expect(rows.map((r) => r.title)).toEqual(["Desk (this PC)", "Laptop", "Studio", "Build PC", "Phone"]);
  expect(rows.slice(1, 3).map((r) => [r.desc, r.badges.map((b) => b.text), r.buttons.length])).toEqual([
    ["Online · Harbor 0.130.0 · Sam (Home)", ["Online"], 0],
    ["Offline", ["Offline"], 0],
  ]);
  expect(blocks.at(-1)?.text).toContain("shares chats with the PCs of everyone who shares a workspace with you");
  expect(devicesBlocks(rig(false).h, newDevicesState()).at(-1)?.text).toContain("Sign in and pick a workspace");
});

test("copy, SSH removal and sign-out reach the host", () => {
  const { h, calls } = rig();
  const tab = devicesTab(h);
  tab.pressed("copy_key");
  tab.pressed("ssh_remove:ssh:1");
  tab.pressed("signout:phone-key");
  tab.pressed("pair_show");
  expect(calls).toEqual(["a".repeat(64), "ssh:ssh:1", "signout:phone-key"]);
});

test("Rename opens a form under the list with this PC's name, and Save renames it", () => {
  const { h, calls } = rig();
  const tab = devicesTab(h);
  expect(tab.blocks().find((b) => b.kind === "list")?.rows[0]?.buttons.map((b) => b.key)).toEqual(["rename", "copy_key"]);
  tab.pressed("rename");
  const f = tab.blocks().find((b) => b.key === "rename");
  expect([f?.title, f?.fields[0]?.text, f?.submit.label, f?.cancel.key]).toEqual(["Rename this PC", "Desk", "Save", "rename_cancel"]);
  tab.submitted("rename", ["Studio PC"]);
  expect(calls).toEqual(["rename:Studio PC"]);
  expect(tab.blocks().some((b) => b.key === "rename")).toBe(false);
  tab.pressed("rename");
  tab.pressed("rename_cancel");
  expect(tab.blocks().some((b) => b.key === "rename")).toBe(false);
});
