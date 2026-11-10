import { expect, test } from "bun:test";
import { ProjectIcons } from "../projecticons.ts";

test("a project's icon is read once, named by its hash, and read again after it's forgotten", async () => {
  let pic: Uint8Array | null = new Uint8Array([1, 2, 3]);
  let reads = 0;
  let changes = 0;
  const icons = new ProjectIcons({
    read: async () => {
      reads++;
      return pic;
    },
    changed: () => changes++,
  });
  // Not read yet: no hash, and asking starts the read.
  expect(icons.hash(7)).toBe("");
  const got = await icons.get(7);
  expect(reads).toBe(1);
  expect(changes).toBe(1);
  expect(got?.png).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  expect(icons.hash(7)).toBe(got?.hash ?? "x");
  await icons.get(7);
  expect(reads).toBe(1);
  // A new picture: a new hash, and phones are told.
  pic = new Uint8Array([4, 5]);
  icons.forget(7);
  const next = await icons.get(7);
  expect(next?.hash).not.toBe(got?.hash);
  expect(changes).toBe(2);
  // None: the letter shows.
  pic = null;
  icons.forget(7);
  expect(await icons.get(7)).toBeNull();
  expect(icons.hash(7)).toBe("");
});

test("an icon is read again once it's old, and an unchanged one tells nobody", async () => {
  let now = 0;
  let reads = 0;
  let changes = 0;
  const icons = new ProjectIcons({
    read: async () => {
      reads++;
      return new Uint8Array([9]);
    },
    changed: () => changes++,
    now: () => now,
  });
  await icons.get(1);
  now += 11 * 60_000;
  await icons.get(1);
  expect(reads).toBe(2);
  expect(changes).toBe(1);
});
