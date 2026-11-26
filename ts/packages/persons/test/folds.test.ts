import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldsFile, normFolds, readFolds, writeFolds } from "../src/folds.ts";

describe("the PC's sidebar folds", () => {
  it("come back as they were left, SpokPay › Site requests included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "folds-"));
    expect(readFolds(dir)).toEqual({ closed: [], stores: [], settledOpen: [] });
    await writeFolds(dir, { closed: ["sr", "creators"], stores: ["st_1"], settledOpen: ["spokpay"] });
    expect(readFolds(dir)).toEqual({ closed: ["sr", "creators"], stores: ["st_1"], settledOpen: ["spokpay"] });
    expect(statSync(foldsFile(dir)).mode & 0o777).toBe(0o600);
    // unfolded again: gone from the file
    await writeFolds(dir, { closed: ["creators"], stores: [], settledOpen: [] });
    expect(JSON.parse(readFileSync(foldsFile(dir), "utf8")).closed).toEqual(["creators"]);
  });

  it("leave out what isn't a fold, and a broken file reads as none", () => {
    expect(normFolds({ closed: ["sr", 3, "", "sr"], stores: "x", extra: 1 })).toEqual({ closed: ["sr"], stores: [], settledOpen: [] });
    const dir = mkdtempSync(join(tmpdir(), "folds-"));
    writeFileSync(foldsFile(dir), "{not json");
    expect(readFolds(dir)).toEqual({ closed: [], stores: [], settledOpen: [] });
  });
});
