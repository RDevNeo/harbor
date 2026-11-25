// Pictures on disk: Discord avatars, Google / Gravatar photos, YouTube / TikTok pictures, WhatsApp photos and store
// pictures, so the Slint window can draw them from a file and the phone gets them through the API. Person Hub kept
// the same cache (chavatar://, <data>/avatars/) — Discord CDN files keep its names, so the migrated cache is reused.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { avatarUrl, isDiscordId, whatsappOf } from "./model/data.ts";
import type { Person, Store } from "./model/types.ts";

const WEEK = 7 * 24 * 3600_000;
const MAX_BYTES = 8 << 20;

/** Person Hub's file name for a CDN URL (shell/main.cjs chavatar://cdn): "avatars_<id>_<hash>.png_<size>". */
export function cdnFileName(url: string): string | null {
  const m = /^https:\/\/cdn\.discordapp\.com\/(.+?)(?:\?size=(\d+))?$/.exec(url);
  if (!m || !m[1]) return null;
  return `${m[1].replace(/[^\w.-]/g, "_")}_${m[2] ?? "0"}`;
}

export function fileNameOf(url: string): string {
  return cdnFileName(url) ?? `url_${createHash("sha1").update(url).digest("hex").slice(0, 24)}`;
}

export class Avatars {
  readonly dir: string;
  private pending = new Map<string, Promise<string | null>>();
  /** Misses (404, not an image) by URL: not asked again for a day. */
  private misses = new Map<string, number>();

  constructor(base: string, private readonly onFetched: () => void, private readonly fetchImpl: typeof fetch = fetch) {
    this.dir = join(base, "avatars");
  }

  /** The file for `url` when it's on disk (fresh or not); otherwise starts a download and returns null. */
  file(url: string | undefined): string | null {
    if (!url || !/^https:\/\//.test(url)) return null;
    const f = join(this.dir, fileNameOf(url));
    let have = false;
    try {
      const st = statSync(f);
      have = st.size > 0;
      if (have && Date.now() - st.mtimeMs < WEEK) return f;
    } catch {
      // not yet
    }
    void this.fetch(url);
    return have ? f : null;
  }

  /** Downloads `url` into the cache; the file, or null. */
  fetch(url: string): Promise<string | null> {
    const miss = this.misses.get(url);
    if (miss && Date.now() - miss < 24 * 3600_000) return Promise.resolve(null);
    const cur = this.pending.get(url);
    if (cur) return cur;
    const p = (async () => {
      try {
        const r = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(String(r.status));
        const type = r.headers.get("content-type") ?? "";
        if (type && !type.startsWith("image/")) throw new Error("not an image");
        const buf = new Uint8Array(await r.arrayBuffer());
        if (!buf.length || buf.length > MAX_BYTES) throw new Error("bad size");
        mkdirSync(this.dir, { recursive: true });
        const f = join(this.dir, fileNameOf(url));
        writeFileSync(f, buf, { mode: 0o600 });
        this.onFetched();
        return f;
      } catch {
        this.misses.set(url, Date.now());
        return null;
      } finally {
        this.pending.delete(url);
      }
    })();
    this.pending.set(url, p);
    return p;
  }

  /** A local file (WhatsApp photo, store picture) as is. */
  static existing(f: string | null | undefined): string | null {
    return f && existsSync(f) ? f : null;
  }

  static read(f: string): { type: string; data: string } | null {
    try {
      const b = readFileSync(f);
      return { type: sniff(b), data: b.toString("base64") };
    } catch {
      return null;
    }
  }
}

export function sniff(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "image/webp";
  return "application/octet-stream";
}

/**
 * The URLs a person's picture may come from, best first (PersonAvatar.tsx): their own Discord avatar, Google photo,
 * YouTube / TikTok picture, then Discord's default one. WhatsApp photos are local files (the connection's `photo`).
 */
export function pictureUrls(p: Person, size = 128): string[] {
  const discord = avatarUrl(p, size);
  const own = p.avatar ? discord : undefined;
  const out = [own, p.photo, p.socialPhoto].filter((x): x is string => !!x && /^https:\/\//.test(x));
  if (discord && !own) out.push(discord);
  return out;
}

/** Whether the person may have a WhatsApp photo (asked of the connection). */
export const whatsappNumber = (p: Person): string | undefined => whatsappOf(p);

export const storeImageFile = (base: string, s: Store): string | null => (s.image ? Avatars.existing(join(base, "images", s.image)) : null);

export { isDiscordId };
