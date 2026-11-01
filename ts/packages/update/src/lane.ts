import type { Manifest } from "./manifest.ts";

export type Lane = "bundle" | "runtime";

export const RUNTIME_SOURCES: readonly string[] = [
  "ts/runtime.ts",
  ...[
    "commands",
    "config",
    "delivery",
    "download",
    "extras",
    "files",
    "install",
    "launcher",
    "manifest",
    "minisign",
    "preview",
    "previewmeta",
    "reload",
    "startup",
    "version",
  ].map((n) => `ts/packages/update/src/${n}.ts`),
];

export const RUNTIME_FOLDERS: readonly string[] = ["video/", "packaging/"];

const RUNTIME_DEPENDENCIES = ["slint-ui", "sherpa-onnx-node", "sharp"] as const;

type Json = Record<string, unknown>;

function parseJson(text: string | null): Json {
  if (text === null) return {};
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
  } catch {
    return {};
  }
}

const field = (o: Json, ...path: string[]): unknown => path.reduce<unknown>((x, k) => (typeof x === "object" && x !== null ? (x as Json)[k] : undefined), o);

export function dependencyChanges(before: string | null, after: string | null): string[] {
  const a = parseJson(before);
  const b = parseJson(after);
  const out: string[] = [];
  const differs = (path: string[]): boolean => JSON.stringify(field(a, ...path)) !== JSON.stringify(field(b, ...path));
  if (differs(["packageManager"]) || differs(["engines", "bun"])) out.push("Bun's version changed");
  for (const dep of RUNTIME_DEPENDENCIES) if (differs(["dependencies", dep])) out.push(`${dep} changed`);
  return out;
}

export interface LaneInput {
  changed: readonly string[];
  packageJson: { before: string | null; after: string | null };
}

export function lane(input: LaneInput): { lane: Lane; reasons: string[] } {
  const reasons = dependencyChanges(input.packageJson.before, input.packageJson.after);
  for (const f of input.changed) {
    if (RUNTIME_SOURCES.includes(f)) reasons.push(`${f} is part of the runtime`);
    else if (RUNTIME_FOLDERS.some((d) => f.startsWith(d))) reasons.push(`${f} changed`);
  }
  return { lane: reasons.length > 0 ? "runtime" : "bundle", reasons };
}

export interface ManifestInput {
  version: string;
  lane: Lane;
  previous: Manifest | null;
  browser?: { id: string; release?: string };
  video?: { id: string; release?: string };
  apk?: { code: number; release?: string };
}

export function buildManifest(input: ManifestInput): Manifest {
  const { version, previous } = input;
  if (input.lane === "bundle" && previous === null) throw new Error("a bundle-only release needs the previous release's manifest to take its runtime from");
  const m: Manifest = input.lane === "runtime" ? { version, minRuntime: version, runtime: version } : { version, minRuntime: (previous as Manifest).minRuntime, runtime: (previous as Manifest).runtime };
  const browser = input.browser === undefined ? previous?.browser : { id: input.browser.id, release: input.browser.release ?? version };
  const video = input.video === undefined ? previous?.video : { id: input.video.id, release: input.video.release ?? version };
  const apk = input.apk === undefined ? previous?.apk : { code: input.apk.code, release: input.apk.release ?? version };
  if (browser !== undefined) m.browser = browser;
  if (video !== undefined) m.video = video;
  if (apk !== undefined) m.apk = apk;
  return m;
}
