import { createHash } from "node:crypto";

/** How long a project's icon is trusted before it's read again (a new favicon, an icon picked on the desktop). */
const TTL_MS = 10 * 60_000;

export interface ProjectIcon {
  /** Names this picture: a new icon is a new hash (the phone keeps them by it). */
  hash: string;
  /** The PNG, base64. */
  png: string;
}

interface Known {
  at: number;
  icon: ProjectIcon | null;
}

/**
 * Projects' icons for phones, as the desktop's sidebar shows them (their own, their website's): read once in the
 * background, then `/v1/state` names each by its hash and `/v1/projects/icon` hands the picture over.
 */
export class ProjectIcons {
  private readonly known = new Map<number, Known>();
  private readonly reading = new Map<number, Promise<ProjectIcon | null>>();

  constructor(
    private readonly d: {
      /** Project `repo`'s icon as PNG bytes; null when it has none (the phone shows its letter). */
      read(repo: number): Promise<Uint8Array | null>;
      /** An icon came or changed: phones should ask for the state again. */
      changed(): void;
      now?(): number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** The hash of `repo`'s icon for `/v1/state` ("" none, or not read yet: reading it starts then). */
  hash(repo: number): string {
    const k = this.known.get(repo);
    if (k === undefined || this.now() - k.at >= TTL_MS) void this.read(repo);
    return k?.icon?.hash ?? "";
  }

  /** `repo`'s icon, read first when it isn't known yet. */
  async get(repo: number): Promise<ProjectIcon | null> {
    const k = this.known.get(repo);
    if (k !== undefined && this.now() - k.at < TTL_MS) return k.icon;
    return this.read(repo);
  }

  /** Read it again next time (an icon picked or dropped on this PC). */
  forget(repo: number): void {
    this.known.delete(repo);
  }

  private read(repo: number): Promise<ProjectIcon | null> {
    const busy = this.reading.get(repo);
    if (busy) return busy;
    const p = this.d
      .read(repo)
      .catch(() => null)
      .then((bytes) => {
        const icon = bytes === null || bytes.length === 0 ? null : { hash: createHash("sha256").update(bytes).digest("hex").slice(0, 16), png: Buffer.from(bytes).toString("base64") };
        const before = this.known.get(repo)?.icon?.hash ?? "";
        this.known.set(repo, { at: this.now(), icon });
        this.reading.delete(repo);
        if ((icon?.hash ?? "") !== before) this.d.changed();
        return icon;
      });
    this.reading.set(repo, p);
    return p;
  }
}
