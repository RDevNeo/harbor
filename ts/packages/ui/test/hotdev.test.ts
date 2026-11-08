import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hot } from "@harbor/store";
import { HotDev, hostModule, pin, tsRoot } from "../src/hotdev.ts";

/** A throwaway checkout: ts/packages/demo/src with a unit, a plain dependency and a file holding state. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "hot-"));
  const src = join(root, "ts", "packages", "demo", "src");
  mkdirSync(src, { recursive: true });
  mkdirSync(join(root, "ts", "packages", "ui", "src"), { recursive: true });
  writeFileSync(join(root, "ts", "packages", "ui", "src", "cards.ts"), "");
  writeFileSync(join(src, "state.ts"), "export const table = new Map<string, number>();\n");
  writeFileSync(join(src, "dep.ts"), 'export const word = (): string => "one";\n');
  writeFileSync(
    join(src, "unit.ts"),
    'import { word } from "./dep.ts";\nimport { table } from "./state.ts";\nimport { hot } from "@harbor/store";\nexport function says(): string { return word(); }\nexport function remember(k: string): number { table.set(k, (table.get(k) ?? 0) + 1); return table.size; }\nexport const shared = (): unknown => hot;\n',
  );
  return join(root, "ts");
}

const notices: string[] = [];
const host = { notice: (t: string) => void notices.push(t), log: () => {} };

describe("hot reload", () => {
  test("finds a checkout's ts/", () => {
    const ts = checkout();
    expect(tsRoot(join(ts, ".."))).toBe(ts);
    expect(tsRoot("/nonexistent")).toBeNull();
  });

  test("swaps a unit from the checkout, keeps state and the old version on a broken save", async () => {
    const ts = checkout();
    const hostTable = new Map<string, number>([["kept", 1]]);
    pin("packages/demo/src/state.ts", { table: hostTable });
    hot.share("@harbor/store", { hot });
    const initial = { says: () => "built in", remember: (_k: string) => 0, shared: (): unknown => null };
    const u = hot.unit("demo", "packages/demo/src/unit.ts", initial);
    let swaps = 0;
    const dev = new HotDev(ts, host, ["demo"]);
    dev.onSwapped = () => void swaps++;
    await dev.start();
    expect(u.now.says()).toBe("one");
    expect(swaps).toBe(1);
    // The pinned file is the running app's instance: its state is there and stays.
    expect(u.now.remember("new")).toBe(2);
    expect(hostTable.get("new")).toBe(1);
    // A shared package is the app's own object, not a copy.
    expect(u.now.shared()).toBe(hot);

    writeFileSync(join(ts, "packages", "demo", "src", "dep.ts"), 'export const word = (): string => "two";\n');
    await Bun.sleep(150);
    await dev.idle();
    expect(u.now.says()).toBe("two");
    expect(u.version).toBe(2);
    expect(dev.timings.at(-1)?.file).toBe("packages/demo/src/dep.ts");

    writeFileSync(join(ts, "packages", "demo", "src", "dep.ts"), "export const word = (: string => ;\n");
    await Bun.sleep(150);
    await dev.idle();
    expect(u.now.says()).toBe("two");
    expect(notices.some((n) => n.includes("kept the running version"))).toBe(true);

    // A pinned file's change takes a restart: said, not loaded.
    writeFileSync(join(ts, "packages", "demo", "src", "state.ts"), "export const table = new Map<string, number>(); // edited\n");
    await Bun.sleep(150);
    await dev.idle();
    expect(notices.some((n) => n.includes("state.ts holds state"))).toBe(true);
    dev.stop();
  });

  test("a swap that drops an export the app calls is refused", () => {
    const u = hot.unit<{ a: () => number; b: () => number }>("demo2", "packages/demo/src/x.ts", { a: () => 1, b: () => 2 });
    expect(() => hot.swap("demo2", { a: () => 3 })).toThrow("no longer exports b");
    expect(u.now.a()).toBe(1);
    hot.swap("demo2", { a: () => 3, b: () => 4, c: 5 });
    expect(u.now.a()).toBe(3);
  });

  test("a package's changed files come from the checkout, the rest from the app", () => {
    const ts = checkout();
    const pkgDir = join(ts, "packages", "demonet", "src");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "view.ts"), "export const look = 2;\nexport type T = 1;\n");
    hot.share("@harbor/demonet", { look: 1, other: 7 });
    const code = hostModule(ts, "@harbor/demonet", new Set(["packages/demonet/src/view.ts"]));
    expect(code).toContain(`export { look } from ${JSON.stringify(join(pkgDir, "view.ts"))}`);
    expect(code).toContain("export const other = H.other;");
    expect(code).not.toContain("export const look");
  });
});
