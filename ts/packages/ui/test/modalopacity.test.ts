import { expect, test } from "bun:test";
import { ModalOpacity } from "../src/modalopacity.ts";

function fixture(opaque = "false") {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "clients") return JSON.stringify([
      { pid: 2, class: "harbor", address: "0x99" },
      { pid: 42, class: "harbor", address: "0xab" },
    ]);
    if (args[0] === "getprop") return opaque;
    return "ok";
  };
  return { calls, modal: new ModalOpacity(run, 42, true) };
}

test("only this Harbor window becomes opaque, and closing restores its original value", async () => {
  for (const old of ["false", "true"]) {
    const { calls, modal } = fixture(old);
    await modal.update(true);
    await modal.update(true);
    await modal.update(false);
    const sets = calls.filter((c) => c[0] === "dispatch");
    expect(sets).toEqual([
      ["dispatch", 'hl.dsp.window.set_prop({window="address:0xab",prop="opaque",value="true"})'],
      ["dispatch", `hl.dsp.window.set_prop({window="address:0xab",prop="opaque",value="${old}"})`],
    ]);
  }
});

test("a modal closed during window discovery never leaves an override behind", async () => {
  let release!: (text: string) => void;
  const calls: string[][] = [];
  const modal = new ModalOpacity(async (args) => {
    calls.push(args);
    if (args[0] === "clients") return new Promise<string>((r) => { release = r; });
    return "false";
  }, 42, true);
  const opened = modal.update(true);
  await Promise.resolve();
  const closed = modal.update(false);
  release(JSON.stringify([{ pid: 42, class: "harbor", address: "0xab" }]));
  await Promise.all([opened, closed]);
  expect(calls.some((c) => c[0] === "dispatch")).toBe(false);
});

test("other compositors and an unavailable hyprctl leave dialogs working", async () => {
  const modal = new ModalOpacity(async () => { throw new Error("not installed"); }, 42, true);
  await modal.update(true);
  await modal.update(false);
  let called = false;
  await new ModalOpacity(async () => { called = true; return ""; }, 42, false).update(true);
  expect(called).toBe(false);
});
