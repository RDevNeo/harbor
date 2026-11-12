import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { BunPlugin } from "bun";
import { paths, platform } from "../packages/os/src/index.ts";
import * as macho from "../packages/update/src/macho.ts";

const cacheHome = (): string => paths.cacheHome();

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

/** What a build is for: this PC by default, or `--target OS-ARCH` (whose addons `bun install --os OS --cpu ARCH` put in node_modules). */
type Target = { os: "linux" | "darwin"; arch: "x64" | "arm64" };

function target(arg: string | undefined): Target {
  const t = arg ?? `${platform()}-${process.arch}`;
  const m = /^(linux|darwin)-(x64|arm64)$/.exec(t);
  if (!m) {
    console.error(`build.ts: no build for ${t} (linux-x64, linux-arm64, darwin-arm64)`);
    process.exit(2);
  }
  return { os: m[1] as Target["os"], arch: m[2] as Target["arch"] };
}

/** Bun's name for the target, for `compile.target`. */
const bunTarget = (t: Target): Bun.Build.CompileTarget => `bun-${t.os}-${t.arch}` as Bun.Build.CompileTarget;

/** Slint's addon package for the target (its JS loader asks for it by this name). */
const slintPackage = (t: Target): string => `slint-ui-binary-${t.os}-${t.arch}${t.os === "linux" ? "-gnu" : ""}`;

async function nativeFiles(t: Target): Promise<Record<string, string>> {
  const { os, arch } = t;
  const lib = os === "darwin" ? "dylib" : "so";
  const root = new URL("../node_modules/.bun/", import.meta.url).pathname;
  const out: Record<string, string> = {};
  const add = (pattern: string, key: (file: string) => string): void => {
    for (const f of new Bun.Glob(pattern).scanSync({ cwd: root })) out[key(f)] = `${root}${f}`;
  };
  const base = (f: string): string => f.slice(f.lastIndexOf("/") + 1);
  // Each library keeps its place next to the others: the addons find theirs through relative rpaths.
  add(`@img+sharp-${os}-${arch}@*/node_modules/@img/sharp-${os}-${arch}/lib/*.node`, (f) => `sharp/@img/sharp-${os}-${arch}/lib/${base(f)}`);
  add(`@img+sharp-libvips-${os}-${arch}@*/node_modules/@img/sharp-libvips-${os}-${arch}/lib/libvips-cpp.*${lib}*`, (f) => `sharp/@img/sharp-libvips-${os}-${arch}/lib/${base(f)}`);
  add(`sherpa-onnx-${os}-${arch}@*/node_modules/sherpa-onnx-${os}-${arch}/*.{node,${lib}}`, (f) => `sherpa/${base(f)}`);
  add(`@slint-ui+${slintPackage(t)}@*/node_modules/@slint-ui/${slintPackage(t)}/*.node`, (f) => `slint/${base(f)}`);
  // Harbor's own build of it (slint/: the compiler's state isn't kept), when the release brings one.
  const own = process.env.HARBOR_SLINT_ADDON;
  if (own) {
    const key = `slint/slint-ui.${slintPackage(t).replace("slint-ui-binary-", "")}.node`;
    if (!(key in out) || !Bun.file(own).size) throw new Error(`HARBOR_SLINT_ADDON: ${own} is not this target's Slint addon`);
    out[key] = own;
    console.log(`Slint addon: ${own}`);
  }
  if (![`sharp/@img/sharp-${os}`, "sherpa/", "slint/"].every((p) => Object.keys(out).some((k) => k.startsWith(p)))) {
    throw new Error(`sharp's, sherpa's or Slint's native files for ${os}-${arch} are not installed (bun install${os === platform() && arch === process.arch ? "" : ` --os ${os} --cpu ${arch}`})`);
  }
  if (os === "darwin") Object.assign(out, await darwinIntl(out));
  return out;
}

/**
 * slint-ui's macOS addon links Homebrew's libintl (/opt/homebrew/opt/gettext), which a Mac without Homebrew
 * lacks: the addon gets its own copy beside it, from Homebrew's pinned package, and
 * points at it. The patched files' signatures are stale until native.ts signs them on the Mac (ad hoc).
 * gettext 0.26's build for macOS 13 (Ventura): Harbor's floor stays Bun's own (macOS 13), not 1.0's 15.
 */
const GETTEXT = {
  blob: "sha256:c9cf89dc04f56eb4939b00eea3c0361cd4498f8237e527f2f741682bf7e6de61",
  lib: "gettext/0.26/lib/libintl.8.dylib",
};
const HOMEBREW_INTL = "/opt/homebrew/opt/gettext/lib/libintl.8.dylib";

async function darwinIntl(files: Record<string, string>): Promise<Record<string, string>> {
  const key = Object.keys(files).find((k) => /^slint\/slint-ui\.darwin-[^/]+\.node$/.test(k));
  const addon = key === undefined ? undefined : files[key];
  if (key === undefined || addon === undefined) return {};
  const node = Buffer.from(await Bun.file(addon).arrayBuffer());
  if (!macho.links(node).includes(HOMEBREW_INTL)) return {};
  const dir = join(cacheHome(), "harbor-build", "darwin-intl", GETTEXT.blob.slice(7, 23));
  mkdirSync(dir, { recursive: true });
  const intl = join(dir, "libintl.8.dylib");
  if (!existsSync(intl)) {
    const tok = ((await (await fetch("https://ghcr.io/token?scope=repository:homebrew/core/gettext:pull")).json()) as { token: string }).token;
    const r = await fetch(`https://ghcr.io/v2/homebrew/core/gettext/blobs/${GETTEXT.blob}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) throw new Error(`gettext's package: ${r.status}`);
    const tgz = Buffer.from(await r.arrayBuffer());
    if (`sha256:${new Bun.CryptoHasher("sha256").update(tgz).digest("hex")}` !== GETTEXT.blob) throw new Error("gettext's package isn't the pinned one");
    const tar = Bun.spawnSync(["tar", "-xzO", "-f", "-", GETTEXT.lib], { stdin: tgz, stdout: "pipe", stderr: "pipe" });
    if (!tar.success) throw new Error(`gettext's package: ${tar.stderr.toString()}`);
    const lib = Buffer.from(tar.stdout);
    macho.changeId(lib, "@rpath/libintl.8.dylib");
    writeFileSync(`${intl}.tmp`, lib);
    renameSync(`${intl}.tmp`, intl);
  }
  if (macho.changeLink(node, HOMEBREW_INTL, "@loader_path/libintl.8.dylib") !== 1) throw new Error("the Slint addon's libintl link didn't change");
  const patched = join(dir, basename(key));
  writeFileSync(patched, node);
  const notice = join(dir, "libintl-NOTICE.txt");
  writeFileSync(
    notice,
    "libintl.8.dylib is GNU gettext's libintl 0.26 (LGPL-2.1-or-later), from Homebrew's gettext package for macOS 13 on Apple Silicon (ghcr.io/homebrew/core/gettext, blob " +
      `${GETTEXT.blob}), with its install name changed. Source: https://ftp.gnu.org/gnu/gettext/gettext-0.26.tar.gz\n`,
  );
  console.log(`Slint addon: ${key} uses its own libintl (${intl})`);
  return { [key]: patched, "slint/libintl.8.dylib": intl, "slint/libintl-NOTICE.txt": notice };
}

const nativeAddons = (t: Target): BunPlugin => ({
  name: "native-addons",
  setup(build) {
    build.onResolve({ filter: /^harbor:native$/ }, (a) => ({ path: a.path, namespace: "native" }));
    build.onLoad({ filter: /.*/, namespace: "native" }, async () => {
      const files = Object.entries(await nativeFiles(t));
      const imports = files.map(([, p], i) => `import f${i} from ${JSON.stringify(p)} with { type: "file" };`);
      return { contents: `${imports.join("\n")}\nexport const files = { ${files.map(([k], i) => `${JSON.stringify(k)}: f${i}`).join(", ")} };`, loader: "js" };
    });
  },
});

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
    build.onResolve({ filter: /^@slint-ui\/slint-ui-binary-(linux-(x64|arm64)-gnu|darwin-arm64)$/ }, () => ({ path: "slint", namespace: "slint-addon" }));
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
  console.error("usage: build.ts app|runtime|single OUTFILE [--target OS-ARCH] [--version V] [--min-runtime V] [--sha SHA]");
  process.exit(2);
}

const version = opt("--version");
const tgt = target(opt("--target"));
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
          plugins: [noExtraBinaries, slintAddon, nativeAddons(tgt), embedAssets, addonsFromRuntime],
          compile: { outfile, target: bunTarget(tgt) },
          minify: !rest.includes("--debug"),
          sourcemap: "none",
          define: defines([["HARBOR_VERSION", version], ["HARBOR_RUNTIME_VERSION", version], ["HARBOR_MIN_RUNTIME", version], ["HARBOR_GIT_SHA", opt("--sha")], ...google]),
        })
      : await Bun.build({
          entrypoints: [new URL("../runtime.ts", import.meta.url).pathname],
          plugins: [noExtraBinaries, slintAddon, nativeAddons(tgt)],
          compile: { outfile, target: bunTarget(tgt) },
          minify: !rest.includes("--debug"),
          sourcemap: "none",
          define: defines([["HARBOR_RUNTIME_VERSION", version]]),
        });
for (const log of r.logs) console.log(log.message);
if (!r.success) process.exit(1);
