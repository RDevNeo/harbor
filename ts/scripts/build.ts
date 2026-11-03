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

function nativeFiles(): Record<string, string> {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const root = new URL("../node_modules/.bun/", import.meta.url).pathname;
  const out: Record<string, string> = {};
  const add = (pattern: string, key: (file: string) => string): void => {
    for (const f of new Bun.Glob(pattern).scanSync({ cwd: root })) out[key(f)] = `${root}${f}`;
  };
  const base = (f: string): string => f.slice(f.lastIndexOf("/") + 1);
  add(`@img+sharp-linux-${arch}@*/node_modules/@img/sharp-linux-${arch}/lib/*.node`, (f) => `sharp/@img/sharp-linux-${arch}/lib/${base(f)}`);
  add(`@img+sharp-libvips-linux-${arch}@*/node_modules/@img/sharp-libvips-linux-${arch}/lib/libvips-cpp.so.*`, (f) => `sharp/@img/sharp-libvips-linux-${arch}/lib/${base(f)}`);
  add(`sherpa-onnx-linux-${arch}@*/node_modules/sherpa-onnx-linux-${arch}/*.{node,so}`, (f) => `sherpa/${base(f)}`);
  add(`@slint-ui+slint-ui-binary-linux-${arch}-gnu@*/node_modules/@slint-ui/slint-ui-binary-linux-${arch}-gnu/*.node`, (f) => `slint/${base(f)}`);
  if (!["sharp/@img/sharp-linux", "sherpa/", "slint/"].every((p) => Object.keys(out).some((k) => k.startsWith(p)))) {
    throw new Error("sharp's, sherpa's or Slint's native files for this architecture are not installed (bun install)");
  }
  return out;
}

const nativeAddons: BunPlugin = {
  name: "native-addons",
  setup(build) {
    build.onResolve({ filter: /^harbor:native$/ }, (a) => ({ path: a.path, namespace: "native" }));
    build.onLoad({ filter: /.*/, namespace: "native" }, () => {
      const files = Object.entries(nativeFiles());
      const imports = files.map(([, p], i) => `import f${i} from ${JSON.stringify(p)} with { type: "file" };`);
      return { contents: `${imports.join("\n")}\nexport const files = { ${files.map(([k], i) => `${JSON.stringify(k)}: f${i}`).join(", ")} };`, loader: "js" };
    });
  },
};

const addonsFromRuntime: BunPlugin = {
  name: "addons-from-runtime",
  setup(build) {
    // sharp finds its addon through createRequire, which the bundler does not follow.
    build.onLoad({ filter: /sharp\/dist\/sharp\.mjs$/ }, async (a) => ({
      contents: (await Bun.file(a.path).text()).replace(
        "const require = createRequire(import.meta.url);",
        'const nodeRequire = createRequire(import.meta.url);\nconst require = (id) => (id.startsWith("@img/sharp-") && id.endsWith("/sharp.node") ? globalThis.__harbor.addon("sharp") : nodeRequire(id));',
      ),
      loader: "js",
    }));
    // Named by the addon, not the file: the single executable also imports these files as files.
    build.onResolve({ filter: /(\/|^)(sharp|sherpa-onnx)\.node$/ }, (a) => (a.importer === "harbor:native" ? undefined : { path: a.path.includes("sharp") ? "sharp" : "sherpa", namespace: "addon" }));
    build.onLoad({ filter: /.*/, namespace: "addon" }, (a) => ({
      contents: `module.exports = globalThis.__harbor.addon(${JSON.stringify(a.path)});`,
      loader: "js",
    }));
  },
};

// Slint's addon, written to disk with the others (native.ts): left to Bun, a compiled executable
// writes it to /tmp, often a tmpfs, where its 36 MB are RAM whose pages can only go to swap.
const slintAddon: BunPlugin = {
  name: "slint-addon-on-disk",
  setup(build) {
    build.onResolve({ filter: /^@slint-ui\/slint-ui-binary-linux-(x64|arm64)-gnu$/ }, () => ({ path: "slint", namespace: "slint-addon" }));
    build.onLoad({ filter: /.*/, namespace: "slint-addon" }, () => ({ contents: `module.exports = globalThis.__harbor.addon("slint");`, loader: "js" }));
  },
};

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
    build.onResolve({ filter: /^slint-ui(\/rust-module\.cjs)?$/ }, (a) => ({ path: a.path, namespace: "runtime" }));
    build.onLoad({ filter: /.*/, namespace: "runtime" }, (a) => ({
      contents: `module.exports = globalThis.__harbor.${a.path === "slint-ui" ? "slint" : "native"};`,
      loader: "js",
    }));
  },
};

const [kind, outfile, ...rest] = process.argv.slice(2);
const opt = (name: string): string | undefined => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const defines = (pairs: Array<[string, string | undefined]>): Record<string, string> =>
  Object.fromEntries(pairs.filter((p): p is [string, string] => p[1] !== undefined).map(([k, v]) => [k, JSON.stringify(v)]));

if ((kind !== "app" && kind !== "runtime" && kind !== "single") || outfile === undefined) {
  console.error("usage: build.ts app|runtime|single OUTFILE [--version V] [--min-runtime V] [--sha SHA]");
  process.exit(2);
}

const version = opt("--version");
// Harbor's Google OAuth clients (packages/mcp/src/apps.ts), from the build's environment when set:
// release.yml passes its secrets by name, so the values never show on a command line.
const google: Array<[string, string | undefined]> = ["HARBOR_GOOGLE_CLIENT_ID", "HARBOR_GOOGLE_CLIENT_SECRET", "HARBOR_GOOGLE_WEB_CLIENT_ID", "HARBOR_GOOGLE_WEB_CLIENT_SECRET"].map((k) => [k, process.env[k] || undefined]);

const r =
  kind === "app"
    ? await Bun.build({
        entrypoints: [new URL("../app.ts", import.meta.url).pathname],
        plugins: [embedAssets, runtimeSlint, addonsFromRuntime],
        target: "bun",
        minify: true,
        outdir: dirname(outfile),
        naming: basename(outfile),
        define: defines([["HARBOR_VERSION", opt("--version")], ["HARBOR_MIN_RUNTIME", opt("--min-runtime")], ["HARBOR_GIT_SHA", opt("--sha")], ...google]),
      })
    : kind === "single"
      ? await Bun.build({
          entrypoints: [new URL("../single.ts", import.meta.url).pathname],
          plugins: [noExtraBinaries, slintAddon, nativeAddons, embedAssets, addonsFromRuntime],
          compile: { outfile },
          minify: !rest.includes("--debug"),
          sourcemap: "none",
          define: defines([["HARBOR_VERSION", version], ["HARBOR_RUNTIME_VERSION", version], ["HARBOR_MIN_RUNTIME", version], ["HARBOR_GIT_SHA", opt("--sha")], ...google]),
        })
      : await Bun.build({
          entrypoints: [new URL("../runtime.ts", import.meta.url).pathname],
          plugins: [noExtraBinaries, slintAddon, nativeAddons],
          compile: { outfile },
          minify: !rest.includes("--debug"),
          sourcemap: "none",
          define: defines([["HARBOR_RUNTIME_VERSION", version]]),
        });
for (const log of r.logs) console.log(log.message);
if (!r.success) process.exit(1);
