import { expect, test } from "bun:test";
import { Funnel } from "../src/funnel.ts";

const probe = (answer: [string | undefined, number | undefined]) => {
  const asked: number[] = [];
  return { asked, run: (port: number): Promise<[string | undefined, number | undefined]> => (asked.push(port), Promise.resolve(answer)) };
};

test("funnel keeps what Tailscale says about /hooks", async () => {
  const p = probe(["https://box.example.test/hooks", undefined]);
  const f = new Funnel(() => true, () => 47920, p.run);
  await f.check();
  expect([f.base, f.stale, p.asked]).toEqual(["https://box.example.test/hooks", null, [47920]]);
  const other = probe([undefined, 3000]);
  const g = new Funnel(() => true, () => 47920, other.run);
  await g.check();
  expect([g.base, g.stale]).toEqual([null, 3000]);
});

test("funnel asks nothing while Tailscale is not installed", async () => {
  const p = probe(["https://box.example.test/hooks", undefined]);
  const f = new Funnel(() => false, () => 47920, p.run);
  await f.check();
  expect([f.base, f.stale, p.asked]).toEqual([null, null, []]);
});

test("funnel forgets its address when Disable is pressed", async () => {
  const f = new Funnel(() => true, () => 47920, probe(["https://box.example.test/hooks", undefined]).run);
  await f.check();
  f.forget();
  expect(f.base).toBeNull();
  await f.check();
  expect(f.base).toBe("https://box.example.test/hooks");
});

test("funnel asks about the port the hook listener bound, read at each check", async () => {
  const p = probe([undefined, undefined]);
  let port = 47920;
  const f = new Funnel(() => true, () => port, p.run);
  await f.check();
  port = 47923;
  await f.check();
  expect(p.asked).toEqual([47920, 47923]);
});
