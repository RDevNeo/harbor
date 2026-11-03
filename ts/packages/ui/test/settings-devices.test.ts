import { expect, test } from "bun:test";
import { MemKv, newHost } from "@harbor/net";
import { devicesBlocks, devicesTab, newDevicesState, type DevicesHost } from "../src/logic/settings-devices.ts";
import { row } from "../src/logic/settings-blocks.ts";

function rig() {
  const calls: string[] = [];
  const h: DevicesHost = {
    kv: new MemKv(), now: () => 100,
    mesh: { me: () => ({ id: "pc:desk", name: "Desk" }), myFp: () => "a".repeat(64), versionLabel: () => "0.124.0", peers: () => [], allowed: () => [{ id: "pc:laptop", node: "", fp: "b".repeat(64), name: "Laptop", addrs: [] }], seen: () => new Map(), addrs: () => ["10.0.0.2:47930"], allow: (k, n, on) => { calls.push(`allow:${on}`); }, rename: (n) => { calls.push(`rename:${n}`); }, copy: (t) => { calls.push(t); } },
    pair: { shown: () => null, show: () => { calls.push("show"); return null; }, cancel: () => { calls.push("cancel"); }, busy: () => false, join: (a, c) => { calls.push(`${a}:${c}`); }, result: () => null },
    phones: () => [row("Phone", { desc: "Signed in as Sam · key abcd", buttons: [] })], signOut: (fp) => { calls.push(`signout:${fp}`); },
    ssh: { devices: () => [[newHost({ id: "ssh:1", name: "Build PC", host: "10.0.0.3" }), true]], remove: (id) => { calls.push(`ssh:${id}`); } },
  };
  return { h, calls };
}

test("Devices has a single list followed by pairing, with no network or SSH forms", () => {
  const { h } = rig();
  const blocks = devicesBlocks(h, newDevicesState());
  expect(blocks.filter((b) => b.kind === "title").map((b) => b.title)).toEqual(["Your devices", "Pair a device"]);
  expect(blocks.find((b) => b.kind === "list")?.rows.map((r) => r.title)).toEqual(["Desk (this PC)", "Laptop", "Build PC", "Phone"]);
  expect(blocks.filter((b) => b.kind === "form").map((b) => b.key)).toEqual(["pair"]);
});

test("copy, removal, sign-out and pairing reach the host", () => {
  const { h, calls } = rig(); const tab = devicesTab(h);
  tab.pressed("copy_key"); tab.pressed("remove:abc"); tab.pressed("ssh_remove:ssh:1"); tab.pressed("signout:phone-key"); tab.pressed("pair_show");
  tab.submitted("pair", [" 10.0.0.2 ", "ABCD-EFGHIJ"]);
  expect(calls).toEqual(["a".repeat(64), "allow:false", "ssh:ssh:1", "signout:phone-key", "show", "10.0.0.2:ABCD-EFGHIJ"]);
});

test("Rename opens a form under the list with this PC's name, and Save renames it", () => {
  const { h, calls } = rig(); const tab = devicesTab(h);
  expect(tab.blocks().find((b) => b.kind === "list")?.rows[0]?.buttons.map((b) => b.key)).toEqual(["rename", "copy_key"]);
  tab.pressed("rename");
  const f = tab.blocks().find((b) => b.key === "rename");
  expect([f?.title, f?.fields[0]?.text, f?.submit.label, f?.cancel.key]).toEqual(["Rename this PC", "Desk", "Save", "rename_cancel"]);
  tab.submitted("rename", ["Studio PC"]);
  expect(calls).toEqual(["rename:Studio PC"]);
  expect(tab.blocks().some((b) => b.key === "rename")).toBe(false);
  tab.pressed("rename"); tab.pressed("rename_cancel");
  expect(tab.blocks().some((b) => b.key === "rename")).toBe(false);
});
