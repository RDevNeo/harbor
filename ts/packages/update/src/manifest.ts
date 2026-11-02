import { parse } from "./version.ts";

export interface Extra {
  id: string;
  release: string;
}

export interface ApkExtra {
  code: number;
  release: string;
}

export interface Manifest {
  version: string;
  minRuntime: string;
  runtime: string;
  browser?: Extra;
  video?: Extra;
  apk?: ApkExtra;
}

export const MANIFEST = "harbor-app.json";

const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function version(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || parse(v) === null) throw new Error(`${MANIFEST}: ${key} is not a version`);
  return v.replace(/^v/, "");
}

function extra(o: Record<string, unknown>, key: string): Extra | undefined {
  const e = record(o[key]);
  if (e === null) return undefined;
  const id = e.id;
  if (typeof id !== "string" || id === "") return undefined;
  return { id, release: version(e, "release") };
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${MANIFEST}: unreadable`);
  }
  const o = record(raw);
  if (o === null) throw new Error(`${MANIFEST}: unreadable`);
  const m: Manifest = { version: version(o, "version"), minRuntime: version(o, "minRuntime"), runtime: version(o, "runtime") };
  const browser = extra(o, "browser");
  const video = extra(o, "video");
  if (browser !== undefined) m.browser = browser;
  if (video !== undefined) m.video = video;
  const apk = record(o.apk);
  if (apk !== null && typeof apk.code === "number" && Number.isInteger(apk.code)) m.apk = { code: apk.code, release: version(apk, "release") };
  return m;
}
