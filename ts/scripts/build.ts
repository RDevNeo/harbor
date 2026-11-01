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

const runtimeSlint: BunPlugin = {
  name: "slint-from-runtime",
  setup(build) {
    build.onResolve({ filter: /^slint-ui(\/rust-module\.cjs)?$/ }, (a) => ({ path: a.path, namespace: "runtime" }));
    build.onLoad({ filter: /.*/, namespace: "runtime" }, (a) => ({
      contents: `module.exports = globalThis.__harbor.${a.path === "slint-ui" ? "slint" : "native"};`,
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
        plugins: [runtimeSlint],
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
