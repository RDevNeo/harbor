import { join } from "node:path";
import { readJson, remove, writeAtomic } from "./files.ts";

export const SLOT = "harbor-preview.js";
export const META = "preview.json";
export const OPT_IN = ".preview";
export const OUT = "preview-out";

export type Stage = "trying" | "ok" | "failed";

export interface Meta {
  id: string;
  sha256: string;
  version: string;
  note: string;
  from: string;
  at: number;
  stage: Stage;
  why: string;
  shown_ms: number;
}

const STAGES: readonly string[] = ["trying", "ok", "failed"];

export function readMeta(dir: string): Meta | null {
  const m = readJson<Partial<Meta>>(join(dir, META));
  if (m === null || typeof m.id !== "string" || typeof m.stage !== "string" || !STAGES.includes(m.stage)) return null;
  return {
    id: m.id,
    sha256: m.sha256 ?? "",
    version: m.version ?? "",
    note: m.note ?? "",
    from: m.from ?? "",
    at: m.at ?? 0,
    stage: m.stage as Stage,
    why: m.why ?? "",
    shown_ms: m.shown_ms ?? 0,
  };
}

export function writeMeta(dir: string, m: Meta): void {
  writeAtomic(join(dir, META), JSON.stringify(m));
}

export function fail(dir: string, id: string, why: string): void {
  const m = readMeta(dir);
  if (m !== null && m.id === id) writeMeta(dir, { ...m, stage: "failed", why });
}

export function forget(dir: string): void {
  remove(join(dir, META));
}
