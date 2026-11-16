// The Node.js Harbor brings along (agents/src/noderuntime.ts): which official archive is this PC's, where its
// programs are inside it, and how it's unpacked. One pinned LTS version, its archives' SHA-256 from that
// release's SHASUMS256.txt: a download that doesn't match is never installed.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Platform, platform } from "./platform.ts";

/** The Node.js LTS Harbor installs when the PC has none. A new one: its version and the six hashes below. */
export const NODE_VERSION = "26.13.1";

/** https://nodejs.org/dist/v26.13.1/SHASUMS256.txt, for the archives Harbor uses. */
export const NODE_SHA256: Readonly<Record<string, string>> = {
  "node-v26.13.1-linux-x64.tar.gz": "518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778",
  "node-v26.13.1-linux-arm64.tar.gz": "80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d",
  "node-v26.13.1-darwin-x64.tar.gz": "82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f",
  "node-v26.13.1-darwin-arm64.tar.gz": "aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735",
  "node-v26.13.1-win-x64.zip": "e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7",
  "node-v26.13.1-win-arm64.zip": "181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97",
};

export const NODE_DIST = "https://nodejs.org/dist";

export interface NodeDist {
  version: string;
  /** The archive's file name, e.g. node-v26.13.1-win-x64.zip. */
  archive: string;
  /** Its download address. */
  url: string;
  /** Its expected SHA-256 (hex). */
  sha256: string;
  /** The one folder the archive holds, e.g. node-v26.13.1-linux-x64. */
  folder: string;
  /** Where node, npm and npx are, relative to that folder: "" on Windows (node.exe, npm.cmd, npx.cmd), "bin" elsewhere. */
  bin: string;
  /** node's file name: node.exe on Windows. */
  node: string;
  kind: "zip" | "tar.gz";
}

/**
 * The official archive for `p` and `arch` (process.arch's names), null where nodejs.org has none Harbor uses
 * (32-bit, other systems). Linux takes the .tar.gz like macOS, not the .tar.xz: gzip is on every system, xz
 * not always.
 */
export function distFor(p: Platform = platform(), arch: string = process.arch, version = NODE_VERSION, base = NODE_DIST, sums: Readonly<Record<string, string>> = NODE_SHA256): NodeDist | null {
  const os = p === "win32" ? "win" : p === "darwin" ? "darwin" : p === "linux" ? "linux" : null;
  if (os === null || (arch !== "x64" && arch !== "arm64")) return null;
  const folder = `node-v${version}-${os}-${arch}`;
  const kind = os === "win" ? "zip" : "tar.gz";
  const archive = `${folder}.${kind}`;
  const sha256 = sums[archive];
  if (sha256 === undefined) return null;
  return { version, archive, url: `${base.replace(/\/+$/, "")}/v${version}/${archive}`, sha256, folder, bin: os === "win" ? "" : "bin", node: os === "win" ? "node.exe" : "node", kind };
}

/**
 * Unpacks `archive` (`kind`) into the folder `dest`, which exists, in a child process: never on the caller's
 * thread. Windows: its own tar.exe (bsdtar, which reads .zip), else PowerShell's Expand-Archive; elsewhere tar.
 */
export async function extract(archive: string, kind: NodeDist["kind"], dest: string): Promise<void> {
  const runs: string[][] = [];
  if (kind === "zip") {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const tar = join(root, "System32", "tar.exe");
    if (platform() === "win32" && existsSync(tar)) runs.push([tar, "-xf", archive, "-C", dest]);
    if (platform() === "win32") {
      const quote = (s: string): string => `'${s.replaceAll("'", "''")}'`;
      runs.push([join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(dest)} -Force`]);
    } else {
      runs.push(["unzip", "-q", archive, "-d", dest]);
    }
  } else {
    runs.push(["tar", "-xzf", archive, "-C", dest]);
  }
  let last = "";
  for (const argv of runs) {
    try {
      const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      if (code === 0) return;
      last = `${argv[0]} exited ${code}: ${err.trim().slice(-300)}`;
    } catch (e) {
      last = `${argv[0]}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(`unpacking ${archive}: ${last}`);
}
