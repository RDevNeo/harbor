import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, apply, commands, key, parse, toJson } from "../src/dictwords.ts";

const CASES = readFileSync(join(import.meta.dir, "../../../../android/test/dictation-cases.txt"), "utf8");

test("shared_cases", () => {
  const dict: Entry[] = [];
  let n = 0;
  for (const line of CASES.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const f = line.split("|");
    const un = (s: string | undefined) => (s ?? "").replaceAll("\\n", "\n");
    switch (f[0]) {
      case "entry":
        dict.push({ term: f[1] ?? "", sounds: f[2] ? f[2].split(",") : [] });
        break;
      case "dict":
        expect(apply(un(f[1]), dict), `dict: ${line}`).toBe(un(f[2]));
        break;
      case "cmd":
        expect(commands(un(f[1])), `cmd: ${line}`).toEqual([un(f[2]), f[3] === "1"]);
        break;
      default:
        throw new Error(`unknown case ${f[0]}`);
    }
    n += 1;
  }
  expect(n).toBeGreaterThan(20);
});

test("parses_and_cleans_the_dictionary", () => {
  const d = parse([{ term: " SpokPay ", sounds: ["spoke pay", "SpokPay", ""] }, { term: "spokpay" }, { term: "" }, { sounds: ["x"] }]);
  expect(d).toEqual([{ term: "SpokPay", sounds: ["spoke pay"] }]);
  expect(parse(toJson(d))).toEqual(d);
});

test("keys_fold_spellings", () => {
  expect(key("SpokPayCRM")).toBe(key("spock pay crm"));
  expect(key("Harbor")).toBe("harbor");
  expect(key("codes")).not.toBe(key("Codex"));
});

test("parse caps the lists and ignores what is not a dictionary", () => {
  expect(parse("nope")).toEqual([]);
  expect(parse([null, 3, { term: 4 }])).toEqual([]);
  const many = Array.from({ length: 600 }, (_, i) => ({ term: `word${i}` }));
  expect(parse(many)).toHaveLength(500);
  const sounds = Array.from({ length: 12 }, (_, i) => `sound ${i}`);
  expect(parse([{ term: "x".repeat(100), sounds }])[0]?.term).toHaveLength(60);
  expect(parse([{ term: "Term", sounds }])[0]?.sounds).toHaveLength(8);
});
