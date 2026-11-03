import { describe, expect, test } from "bun:test";
import { averageMb, pickAuto, RAM_WINDOW_MS, RamMeter, ramOf, ramText, type AutoCandidate } from "../src/ram.ts";

describe("free memory (ram.ts)", () => {
  test("the average is over the last 10 minutes; with no sample yet it's the current value", () => {
    const now = 100 * 60_000;
    expect(averageMb([], now, () => 4000)).toBe(4000);
    expect(averageMb([], now, () => null)).toBeNull();
    // Older than 10 minutes: not counted.
    expect(averageMb([[now - RAM_WINDOW_MS - 1, 100], [now - 60_000, 3000], [now - 30_000, 4000]], now, () => 9999)).toBe(3500);
    // Only old samples: the current value.
    expect(averageMb([[now - RAM_WINDOW_MS, 100]], now, () => 2048)).toBe(2048);
    expect(averageMb([[now - 1000, 1001], [now - 500, 1002]], now, () => 0)).toBe(1002);
  });

  test("the meter keeps 10 minutes of samples and skips unreadable ones", () => {
    let t = 0;
    let v: number | null = 1000;
    const m = new RamMeter(() => v, () => t);
    expect(m.mb()).toBe(1000);
    m.sample();
    t = 30_000;
    v = 3000;
    m.sample();
    v = 7000;
    // Two samples: 1000 and 3000; the current 7000 isn't one.
    expect(m.mb()).toBe(2000);
    t = 30_000 + RAM_WINDOW_MS;
    v = null;
    m.sample();
    // Both fell out and the new one couldn't be read: the current value (none).
    expect(m.mb()).toBeNull();
    v = 500;
    expect(m.mb()).toBe(500);
  });

  test("a peer's figure is a non-negative number or nothing", () => {
    expect(ramOf(2048.4)).toBe(2048);
    expect(ramOf(0)).toBe(0);
    expect(ramOf(-1)).toBeNull();
    expect(ramOf("2048")).toBeNull();
    expect(ramOf(undefined)).toBeNull();
    expect(ramOf(Number.NaN)).toBeNull();
    expect(ramText(512)).toBe("512 MB free");
    expect(ramText(12_595)).toBe("12.3 GB free");
  });
});

describe("Auto's pick (pickAuto)", () => {
  const c = (id: string, name: string, ram: number | null): AutoCandidate => ({ id, name, ram });

  test("the PC with the most free memory, this PC no different from the others", () => {
    expect(pickAuto([c("", "desk", 4000), c("pc:a", "laptop", 9000), c("pc:b", "box", 6000)])?.id).toBe("pc:a");
    expect(pickAuto([c("", "desk", 9001), c("pc:a", "laptop", 9000)])?.id).toBe("");
  });

  test("PCs without a figure aren't a choice; none at all is no pick", () => {
    expect(pickAuto([c("", "desk", null), c("pc:a", "laptop", 10)])?.id).toBe("pc:a");
    expect(pickAuto([c("", "desk", null), c("pc:a", "laptop", null)])).toBeNull();
    expect(pickAuto([])).toBeNull();
  });

  test("a tie goes to the name, then the id, whatever the order", () => {
    const tied = [c("pc:z", "zeta", 5000), c("", "alpha", 5000), c("pc:b", "beta", 5000)];
    expect(pickAuto(tied)?.name).toBe("alpha");
    expect(pickAuto([...tied].reverse())?.name).toBe("alpha");
    expect(pickAuto([c("pc:2", "box", 1), c("pc:1", "box", 1)])?.id).toBe("pc:1");
    expect(pickAuto([c("pc:1", "box", 1), c("pc:2", "box", 1)])?.id).toBe("pc:1");
  });
});

describe("screenshot peers (HARBOR_FAKE_PEERS)", () => {
  test("name:MB pairs become PCs that are on; anything else is ignored", async () => {
    const { fakePeers } = await import("../src/ram.ts");
    expect(fakePeers(undefined)).toEqual([]);
    expect(fakePeers("laptop:12595, bad, box:4096").map((p) => [p.id, p.name, p.online, p.ram, p.accounts[0]?.[2]])).toEqual([
      ["pc:fake-laptop", "laptop", true, 12595, "claude"],
      ["pc:fake-box", "box", true, 4096, "claude"],
    ]);
  });
});
