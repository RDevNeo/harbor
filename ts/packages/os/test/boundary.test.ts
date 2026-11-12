import { expect, test } from "bun:test";
import { compare, RULES, readList, scan } from "./boundary.ts";

// The rest of ts/ reaches the OS only through @harbor/os (see boundary.ts): what isn't moved yet is
// counted in boundary.json, and the count may only go down.
test("no new Linux-only call outside @harbor/os", () => {
  const { more } = compare(scan(), readList());
  if (more.length > 0) {
    throw new Error(
      `Linux-only calls outside @harbor/os (ts/packages/os): put them behind a function there instead.\n${more.join("\n")}`,
    );
  }
});

test("boundary.json allows nothing that is gone", () => {
  const { fewer } = compare(scan(), readList());
  if (fewer.length > 0) {
    throw new Error(`Fewer hits than boundary.json allows: run \`bun packages/os/test/boundary.ts --write\` (from ts/).\n${fewer.join("\n")}`);
  }
  expect(fewer).toEqual([]);
});

test("the rules catch what they're for", () => {
  const hits = (line: string): string[] => Object.entries(RULES).filter(([, re]) => re.test(line)).map(([r]) => r);
  expect(hits('readFileSync(`/proc/${pid}/stat`, "utf8")')).toEqual(["procfs"]);
  expect(hits('import { dlopen } from "bun:ffi";')).toEqual(["ffi"]);
  expect(hits('Bun.spawn(["xdg-open", url])')).toEqual(["desktop-tools"]);
  expect(hits('if (process.platform === "darwin") x();')).toEqual(["platform"]);
  expect(hits("process.kill(-pgid, sig);")).toEqual(["process-groups"]);
  expect(hits('const name = "harbor.db";')).toEqual([]);
});
