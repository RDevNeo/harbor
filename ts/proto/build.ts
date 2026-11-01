import { basename, dirname } from "node:path";
import type { BunPlugin } from "bun";

// slint-ui's loader only falls through on MODULE_NOT_FOUND, and the compiler's stub for a missing
// file throws without it; the musl addon bun install fetches on glibc is 33 MB of dead weight.
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

// The app bundle runs on a compiled runtime, which holds the addon: `import "slint-ui"` becomes what
// proto/runtime.ts left on globalThis.
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

const [entry, outfile, ...flags] = process.argv.slice(2);
if (!entry || !outfile) throw new Error("build ENTRY OUTFILE [--bytecode] [--app]");

const r = flags.includes("--app")
  ? await Bun.build({ entrypoints: [entry], plugins: [runtimeSlint], target: "bun", minify: true, outdir: dirname(outfile), naming: basename(outfile) })
  : await Bun.build({
      entrypoints: [entry],
      plugins: [noExtraBinaries],
      compile: { outfile },
      minify: true,
      ...(flags.includes("--bytecode") ? { bytecode: true, format: "esm" as const } : {}),
      sourcemap: "none",
    });
for (const log of r.logs) console.log(log.message);
if (!r.success) process.exit(1);
