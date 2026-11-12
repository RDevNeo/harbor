import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { blockedWhy, panelItems, patchDirs, Patches, PATCH_DOC, shape, writeDoc } from "../src/patches.ts";

const kv = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
};

function project(): string {
  const d = mkdtempSync(join(tmpdir(), "patch-"));
  mkdirSync(join(d, "app", ".harbor", "patches"), { recursive: true });
  return join(d, "app");
}

const PATCH = `export default {
  icon: "flask",
  actions: [
    { title: "Run tests", run: "bun test" },
    { title: "Explain", prompt: "Explain the schema." },
    { title: "Docs", url: "https://example.com/docs" },
  ],
  panels: [
    { title: "App", url: "localhost:3000" },
    { title: "Files", items: async ({ sh }) => (await sh("printf 'a\\\\nb\\\\n'")).split("\\n").filter(Boolean).map((t) => ({ title: t, section: "Here" })) },
  ],
};
`;

describe("patches", () => {
  test("folders: the chat's and each above it to home, the project's, then home's", () => {
    // Full paths of this system (on Windows "/h" is on the current drive).
    const r = (ps: string[]): string[] => ps.map((p) => resolve(p));
    expect(patchDirs("/h/p/wt/sub", "/h/p", "/h")).toEqual(r(["/h/p/wt/sub/.harbor/patches", "/h/p/wt/.harbor/patches", "/h/p/.harbor/patches", "/h/.harbor/patches"]));
    expect(patchDirs("/h", null, "/h")).toEqual(r(["/h/.harbor/patches"]));
  });

  test("only node: and bun imports, and no import() by a name", () => {
    expect(blockedWhy('import { readFileSync } from "node:fs";\nimport type { X } from "./x";\nexport default {};')).toBeNull();
    expect(blockedWhy('import x from "./helper.ts";\nexport default {};')).toContain("imports ./helper.ts");
    expect(blockedWhy('import x from "lodash";\nexport default {};')).toContain("imports lodash");
    expect(blockedWhy("const m = await import(name);\nexport default {};")).toContain("import()");
  });

  test("shape: exactly one of run, prompt or url; panels need a url or items", () => {
    const s = shape({ default: { actions: [{ title: "A", run: "x" }], panels: [{ title: "P", url: "localhost:5173" }] } }, "/p.ts");
    expect(s.actions[0]?.kind).toBe("run");
    expect(s.panels[0]?.url).toBe("http://localhost:5173");
    expect(() => shape({ default: { actions: [{ title: "A", run: "x", url: "https://e" }] } }, "/p.ts")).toThrow("exactly one");
    expect(() => shape({ default: { actions: [{ title: "A", url: "file:///etc" }] } }, "/p.ts")).toThrow("http");
    expect(() => shape({ default: { panels: [{ title: "P" }] } }, "/p.ts")).toThrow("url or an items");
    expect(() => shape({}, "/p.ts")).toThrow("default export");
  });

  test("runs only once trusted; an edit asks again; a failed load says why", async () => {
    const app = project();
    const file = join(app, ".harbor", "patches", "dev.ts");
    writeFileSync(file, PATCH);
    const store = kv();
    const p = new Patches(store);
    const dirs = patchDirs(app, app, "/nonexistent-home");
    let [f] = p.scan(dirs);
    expect(f?.state).toBe("untrusted");
    expect(f?.actions).toEqual([]);
    p.trust(f!);
    p.scan(dirs);
    await p.settled();
    [f] = p.scan(dirs);
    expect(f?.state).toBe("trusted");
    expect(f?.actions.map((a) => a.title)).toEqual(["Run tests", "Explain", "Docs"]);
    expect(f?.panels.map((x) => x.title)).toEqual(["App", "Files"]);
    expect(await panelItems(f!.panels[1]!, app, app)).toEqual([{ title: "a", section: "Here" }, { title: "b", section: "Here" }]);

    await Bun.sleep(5);
    writeFileSync(file, PATCH.replace("Run tests", "Run all tests"));
    [f] = p.scan(dirs);
    expect(f?.state).toBe("untrusted");

    writeFileSync(file, "export default { actions: [{ title: 'x' }] };\n");
    [f] = p.scan(dirs);
    p.trust(f!);
    p.scan(dirs);
    await p.settled();
    [f] = p.scan(dirs);
    expect(f?.state).toBe("error");
    expect(f?.error).toContain("exactly one");
    // The version before it stays until it's fixed.
    expect(f?.actions.map((a) => a.title)).toEqual(["Run tests", "Explain", "Docs"]);
  });

  test("a blocked patch never loads", () => {
    const app = project();
    writeFileSync(join(app, ".harbor", "patches", "bad.ts"), 'import x from "./x.ts";\nexport default {};\n');
    const [f] = new Patches(kv()).scan([join(app, ".harbor", "patches")]);
    expect(f?.state).toBe("blocked");
  });

  test("the format's doc goes to ~/.harbor/patches/README.md", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const p = writeDoc(home);
    expect(p).toBe(join(home, ".harbor", "patches", "README.md"));
    expect(Bun.file(p).size).toBe(Buffer.byteLength(PATCH_DOC));
  });
});
