import { basename, dirname } from "node:path";
import type { BunPlugin } from "bun";

const noExtraBinaries: BunPlugin = {
  name: "no-extra-slint-binaries",
  setup(build) {
    build.onResolve({ filter: /rust-module-dev\.cjs$|slint-ui-binary-linux-(x64|arm64)-musl/ }, (a) => ({ path: a.path, namespace: "no-binary" }));
    build.onLoad({ filter: /.*/, namespace: "no-binary" }, () => ({
      contents: `throw Object.assign(new Error("not shipped"), { code: "MODULE_NOT_FOUND" });`,
      loader: "js",
    }));
  },
};

// Native addons that need files beside them are loaded when first used, so a command that never uses one starts without it.
const lazyAddon = (name: string): string =>
  `const load = () => globalThis.__harbor.${name}();
module.exports = new Proxy(function () {}, {
  apply: (_t, self, args) => Reflect.apply(load(), self, args),
  construct: (_t, args) => Reflect.construct(load(), args),
  get: (_t, key) => (key === "__esModule" ? false : load()[key]),
  has: (_t, key) => key in load(),
});`;

// The bundle has no files beside it: each asset import becomes a file written once, under the content's hash, and its path.
const embedAssets: BunPlugin = {
  name: "embed-assets",
  setup(build) {
    build.onLoad({ filter: /\.(slint|ttf|rgba|a8)$/ }, async (a) => {
      const bytes = await Bun.file(a.path).bytes();
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
      return {
        contents: `import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const run = process.env.XDG_RUNTIME_DIR;
const dir = \`\${run && existsSync(run) ? run : tmpdir()}/harbor-embedded-${hash}\`;
const file = dir + "/" + ${JSON.stringify(a.path.slice(a.path.lastIndexOf("/") + 1))};
if (!existsSync(file)) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file + "." + process.pid, Buffer.from(${JSON.stringify(Buffer.from(bytes).toString("base64"))}, "base64"));
  renameSync(file + "." + process.pid, file);
}
export default file;`,
        loader: "js",
      };
    });
  },
};

const runtimeSlint: BunPlugin = {
  name: "slint-from-runtime",
  setup(build) {
    build.onResolve({ filter: /^(slint-ui(\/rust-module\.cjs)?|sherpa-onnx-node|sharp)$/ }, (a) => ({ path: a.path, namespace: "runtime" }));
    build.onLoad({ filter: /.*/, namespace: "runtime" }, (a) => ({
      contents:
        a.path === "sherpa-onnx-node" || a.path === "sharp"
          ? lazyAddon(a.path === "sharp" ? "sharp" : "sherpa")
          : `module.exports = globalThis.__harbor.${a.path === "slint-ui" ? "slint" : "native"};`,
      loader: "js",
    }));
  },
};

const [kind, outfile, ...rest] = process.argv.slice(2);
const opt = (name: string): string | undefined => rest[rest.indexOf(name) + 1];
const defines = (pairs: Array<[string, string | undefined]>): Record<string, string> =>
  Object.fromEntries(pairs.filter((p): p is [string, string] => p[1] !== undefined).map(([k, v]) => [k, JSON.stringify(v)]));

if ((kind !== "app" && kind !== "runtime") || outfile === undefined) {
  console.error("usage: build.ts app|runtime OUTFILE [--version V] [--min-runtime V] [--sha SHA]");
  process.exit(2);
}

const r =
  kind === "app"
    ? await Bun.build({
        entrypoints: [new URL("../app.ts", import.meta.url).pathname],
        plugins: [embedAssets, runtimeSlint],
        target: "bun",
        minify: true,
        outdir: dirname(outfile),
        naming: basename(outfile),
        define: defines([["HARBOR_VERSION", opt("--version")], ["HARBOR_MIN_RUNTIME", opt("--min-runtime")], ["HARBOR_GIT_SHA", opt("--sha")]]),
      })
    : await Bun.build({
        entrypoints: [new URL("../runtime.ts", import.meta.url).pathname],
        plugins: [noExtraBinaries],
        compile: { outfile },
        minify: true,
        sourcemap: "none",
        define: defines([["HARBOR_RUNTIME_VERSION", opt("--version")]]),
      });
for (const log of r.logs) console.log(log.message);
if (!r.success) process.exit(1);
