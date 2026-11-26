// Collector's made-up data for the screenshot rigs (scripts/shot on the PC, ts/rig/phonehub.ts for the phone): creators
// from YouTube, TikTok and Instagram (emails found in different places, made-up video thumbnails), two Restricted, and the
// last run (or one under way). No network, nobody real.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { avatarKey } from "../tabs/collector/avatar-key.ts";

export interface FixtureOpts {
  /** A run going. */
  running?: boolean;
  now?: number;
}

const PALETTE = [
  ["#f97316", "#7c2d12"],
  ["#22c55e", "#14532d"],
  ["#3b82f6", "#1e3a8a"],
  ["#e11d48", "#4c0519"],
  ["#a855f7", "#3b0764"],
  ["#eab308", "#713f12"],
  ["#06b6d4", "#164e63"],
  ["#ec4899", "#500724"],
];

async function avatar(dir: string, url: string, i: number, letter: string): Promise<void> {
  const [a, b] = PALETTE[i % PALETTE.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="160" height="160" fill="url(#g)"/><circle cx="80" cy="64" r="30" fill="#ffffff" fill-opacity="0.85"/><rect x="34" y="104" width="92" height="56" rx="28" fill="#ffffff" fill-opacity="0.85"/><text x="80" y="76" font-family="sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="${b}">${letter}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(join(dir, `${avatarKey(url)}.img`));
}

/** A made-up video thumbnail: a gradient "scene" (landscape for YouTube, portrait for TikTok and Instagram). */
async function thumb(dir: string, url: string, i: number, portrait: boolean): Promise<void> {
  const [a, b] = PALETTE[(i * 3 + 1) % PALETTE.length]!;
  const [w, h] = portrait ? [144, 256] : [256, 144];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.5}" cy="${h * 0.42}" r="${Math.min(w, h) * 0.18}" fill="#ffffff" fill-opacity="0.7"/><rect x="${w * 0.3}" y="${h * 0.62}" width="${w * 0.4}" height="${h * 0.38}" rx="${w * 0.12}" fill="#ffffff" fill-opacity="0.55"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(join(dir, `${avatarKey(url)}.img`));
}

export async function writeCollectorFixture(cdir: string, o: FixtureOpts = {}): Promise<void> {
  const now = o.now ?? Date.now();
  const day = 86_400_000;
  const iso = (t: number): string => new Date(t).toISOString();
  mkdirSync(join(cdir, "avatars"), { recursive: true });
  const vids = (p: string, id: string, ages: number[], title: string) =>
    ages.map((a, i) => ({
      video_id: `${id}v${i}`,
      title: `${title} #${ages.length - i}`,
      url: p === "youtube" ? `https://www.youtube.com/watch?v=${id}v${i}` : p === "tiktok" ? `https://www.tiktok.com/@${id}/video/7${i}` : `https://www.instagram.com/reel/${id}${i}/`,
      thumbnail_url: `https://rig.invalid/collector/thumb/${id}/${i}.png`,
      published_at: iso(now - a * day),
      view_count: 18_000 + i * 7_400,
      is_short: p !== "youtube",
    }));
  type L = { label: string; url: string; source?: string };
  const base = (p: string, id: string, name: string, handle: string, links: L[], ages: number[], title: string, extra: Record<string, unknown> = {}) => ({
    platform: p,
    platform_id: id,
    name,
    handle,
    profile_url: p === "youtube" ? `https://www.youtube.com/${handle}` : p === "tiktok" ? `https://www.tiktok.com/${handle}` : `https://www.instagram.com/${handle.slice(1)}/`,
    avatar_url: `https://rig.invalid/collector/${id}.png`,
    subscriber_count: 12_000,
    video_count: 120,
    view_count: null,
    description: null as string | null,
    links,
    country: "Brazil",
    discovered_via: "dress to impress",
    captured_at: iso(now - 3 * day),
    last_upload_at: iso(now - ages[0]! * day),
    updated_at: iso(now - 3 * day),
    recent_videos: vids(p, id, ages, title),
    ...extra,
  });
  const creators = [
    base("youtube", "UCrig0001lia", "Lia Looks", "@lialooks", [{ label: "Linktree", url: "https://linktr.ee/lialooks" }], [1, 3, 6], "Dress to Impress: tema Gala", { email: "contato@lialooks.com.br", email_source: "YouTube About" }),
    base("tiktok", "68110022334455", "Caio Runway", "@caiorunway", [{ label: "Beacons", url: "https://beacons.ai/caiorunway" }], [0, 2, 4], "DTI speedrun", { email: "caio.runway@gmail.com", email_source: "TikTok bio" }),
    base("instagram", "4455667788", "Bia Joga", "@biajoga", [{ label: "Link in bio", url: "https://linktr.ee/biajoga" }], [2, 5, 8], "Look do dia no DTI", { email: null }),
    base("youtube", "UCrig0005raf", "Rafa Styles", "@rafastyles", [], [4, 9, 12], "Ranking every DTI theme", { email: "rafa.styles@outlook.com", email_source: "typed", email_manual: true }),
    base("tiktok", "68110099887766", "Tia Kitsune", "@tiakitsune", [{ label: "Instagram", url: "https://instagram.com/tiakitsune" }], [1, 1, 3], "POV: tema Y2K", { email: null }),
    base("youtube", "UCrig0007duda", "Duda Robux", "@dudarobux", [{ label: "Linktree", url: "https://linktr.ee/dudarobux" }], [2, 6, 9], "Vestindo inscritos", { email: "dudarobux.parcerias@gmail.com", email_source: "linktr.ee/dudarobux" }),
    base("instagram", "9988776655", "Gui Brookhaven", "@guibrookhaven", [], [5, 7, 11], "Brookhaven fits", { email: null, restricted: true }),
    base("tiktok", "68110055443322", "Nina Fits", "@ninafits", [], [3, 4, 9], "Fit check", { email: "nina@ninafits.com", email_source: "TikTok bio", restricted: true }),
  ];
  for (let i = 0; i < creators.length; i++) {
    const c = creators[i]!;
    await avatar(join(cdir, "avatars"), c.avatar_url, i, c.name[0]!);
    for (const [j, v] of c.recent_videos.entries()) await thumb(join(cdir, "avatars"), v.thumbnail_url, i + j, c.platform !== "youtube");
  }
  const seen = creators.flatMap((c) => [`${c.platform}:${c.platform_id}`, `${c.platform}:${c.handle.toLowerCase()}`]);
  // The last run found the first five (newest last in the file: the lists show Lia, Caio… first).
  const ids = creators.slice(0, 5).map((c) => `${c.platform}:${c.platform_id}`).reverse();
  writeFileSync(
    join(cdir, "state.json"),
    JSON.stringify({
      v: 2,
      settings: { platform: "youtube", query: "dress to impress", gapDays: 14, target: 20, lastTemplate: "padrao" },
      creators: creators.slice().reverse(),
      seen: [...seen, "youtube:UCrigold1", "youtube:UCrigold2", "tiktok:@oldone"],
      run: o.running
        ? { running: true, label: "YouTube", platform: "youtube", query: "dress to impress", startedAt: now - 95_000, endedAt: 0, status: "Running…", found: 5, target: 20, considered: 11, dropped: 3, known: 2, ids, line: "Checking Duda Robux…" }
        : { running: false, label: "YouTube", platform: "youtube", query: "dress to impress", startedAt: now - 3 * day, endedAt: now - 3 * day + 410_000, status: "Done: 5 new leads (no more for this term) · 2 already collected, passed over", found: 5, target: 20, considered: 19, dropped: 9, known: 2, ids, line: "" },
      log: [],
    }),
  );
}

if (import.meta.main) {
  const [dir, mode] = process.argv.slice(2);
  if (!dir) throw new Error("usage: bun ts/rig/collector-fixture.ts <dir> [running]");
  await writeCollectorFixture(dir, { running: mode === "running" });
  console.log(`collector fixture in ${dir}`);
}
