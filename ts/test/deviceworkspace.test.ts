import { expect, test } from "bun:test";
import { deviceWorkspace, type DeviceWorkspace } from "../packages/ui/src/logic/devices.ts";

const spaces: DeviceWorkspace[] = [
  { id: "sam", name: "Sam's Workspace", members: [{ id: "sam", role: "owner", image: "https://photos.example/sam" }, { id: "dana", role: "member" }], pcs: [{ id: "pc:dana", owner: "dana" }] },
  { id: "dana", name: "Dana's Workspace", members: [{ id: "dana", role: "owner", image: "https://photos.example/dana" }], pcs: [{ id: "pc:dana", owner: "dana" }] },
];
test("a PC shared into multiple workspaces uses its owner's workspace and photo", () => {
  expect(deviceWorkspace({ key: "pc:dana", kind: "pc", here: false }, spaces, "sam")).toEqual({ name: "Dana's Workspace", photo: "https://photos.example/dana" });
});
test("phones and this PC use the signed-in account's workspace", () => {
  for (const device of [{ key: "phone:one", kind: "android", here: false, account: "sam" }, { key: "pc:self", kind: "pc", here: true }])
    expect(deviceWorkspace(device, spaces, "sam")).toEqual({ name: "Sam's Workspace", photo: "https://photos.example/sam" });
});
test("missing directory data and missing photos have safe fallbacks", () => {
  expect(deviceWorkspace({ key: "pc:unknown", kind: "pc", here: false }, spaces, "sam")).toEqual({ name: "No workspace", photo: "" });
  expect(deviceWorkspace({ key: "pc:dana", kind: "pc", here: false }, [{ ...spaces[0]!, members: [] }], "sam")).toEqual({ name: "Sam's Workspace", photo: "" });
});

test("phones use their own account when shared into this PC's workspace", () => {
  expect(deviceWorkspace({ key: "phone:one", kind: "android", here: false, account: "dana" }, spaces, "sam")).toEqual({ name: "Dana's Workspace", photo: "https://photos.example/dana" });
  expect(deviceWorkspace({ key: "phone:unknown", kind: "android", here: false }, spaces, "sam")).toEqual({ name: "No workspace", photo: "" });
});
