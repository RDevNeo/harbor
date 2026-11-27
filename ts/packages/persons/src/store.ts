// data.json and connections.json in <hub data>/persons. Atomic 0600 writes; edits made elsewhere (the
// migration, a hand edit) are picked up by a watcher, keeping read marks made here (mergeSeen).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@harbor/store";
import { emptyData, normalizeData } from "./model/data.ts";
import { mergeSeen } from "./model/readState.ts";
import type { AppData, ChannelKind, SectionId } from "./model/types.ts";
import type { ConnMeta } from "./conn/types.ts";

/** ~/.local/share/hub/persons (HUB_PERSONS_DIR overrides, for the screenshot rig and tests). */
export function personsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HUB_PERSONS_DIR || join(dataDir(env), "persons");
}

export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

const KINDS: ChannelKind[] = ["discord", "gmail", "whatsapp", "instagram"];
const SECTIONS: SectionId[] = ["stores", "creators", "spokpay", "neobux", "personal"];

export function loadConnections(dir: string): ConnMeta[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")) as { connections?: unknown };
    const list = Array.isArray(raw.connections) ? raw.connections : [];
    const out: ConnMeta[] = [];
    for (const x of list) {
      if (!x || typeof x !== "object") continue;
      const { id, kind, section, also } = x as Record<string, unknown>;
      if (typeof id !== "string" || !/^[\w-]{1,60}$/.test(id)) continue;
      if (!KINDS.includes(kind as ChannelKind) || !SECTIONS.includes(section as SectionId)) continue;
      if (out.some((c) => c.id === id)) continue;
      const more = Array.isArray(also) ? [...new Set(also.filter((s): s is SectionId => SECTIONS.includes(s as SectionId) && s !== section))] : [];
      out.push(more.length ? { id, kind: kind as ChannelKind, section: section as SectionId, also: more } : { id, kind: kind as ChannelKind, section: section as SectionId });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveConnections(dir: string, list: ConnMeta[]): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "connections.json"), `${JSON.stringify({ version: 1, connections: list }, null, 2)}\n`);
}

export class DataFile {
  readonly file: string;
  /** The document as last read from or written to disk (the merge base). */
  private base: AppData | null = null;
  private lastText = "";
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly dir: string) {
    this.file = join(dir, "data.json");
  }

  load(): AppData {
    mkdirSync(this.dir, { recursive: true });
    let d: AppData;
    if (existsSync(this.file)) {
      const text = readFileSync(this.file, "utf8");
      this.lastText = text;
      try {
        d = normalizeData(JSON.parse(text));
      } catch {
        d = emptyData();
      }
    } else d = emptyData();
    this.base = d;
    return d;
  }

  save(d: AppData): void {
    const text = `${JSON.stringify(d, null, 2)}\n`;
    if (text === this.lastText) return;
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.file, text);
    this.lastText = text;
    this.base = d;
  }

  /** Calls `onExternal(merged)` when someone else rewrites the file. `current` = the document here now. */
  watch(current: () => AppData | null, onExternal: (d: AppData) => void): void {
    try {
      this.watcher = watch(this.dir, (_ev, name) => {
        if (name !== "data.json") return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          let text = "";
          try {
            if (!statSync(this.file).isFile()) return;
            text = readFileSync(this.file, "utf8");
          } catch {
            return;
          }
          if (text === this.lastText) return;
          let remote: AppData;
          try {
            remote = normalizeData(JSON.parse(text));
          } catch {
            return;
          }
          this.lastText = text;
          const here = current();
          const merged = here ? mergeSeen(remote, this.base, here, remote) : remote;
          this.base = remote;
          onExternal(merged);
        }, 150);
      });
    } catch {
      // no watcher (folder missing): edits from elsewhere show after a restart
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
  }
}
