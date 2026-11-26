// Collector's made-up data for the screenshot rigs (scripts/shot on the PC, ts/rig/phonehub.ts for the phone): creators
// from YouTube, TikTok and Instagram with emails found in different places, links from link-in-bio pages, a daily update's
// changes, one contacted creator, and (optionally) a run or the daily update under way. No network, nobody real.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { avatarKey } from "../tabs/collector/avatar-key.ts";

export interface FixtureOpts {
  /** A YouTube run going. */
  running?: boolean;
  /** The daily update going. */
  refreshing?: boolean;
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

export async function writeCollectorFixture(cdir: string, o: FixtureOpts = {}): Promise<void> {
  const now = o.now ?? Date.now();
  const day = 86_400_000;
  const h = 3_600_000;
  const iso = (t: number): string => new Date(t).toISOString();
  mkdirSync(join(cdir, "avatars"), { recursive: true });
  const vids = (id: string, ages: number[], title: string) =>
    ages.map((a, i) => ({ video_id: `${id}v${i}`, title: `${title} #${ages.length - i}`, url: `https://www.youtube.com/watch?v=${id}v${i}`, thumbnail_url: null, published_at: iso(now - a * day), view_count: 18_000 + i * 7_400, is_short: false }));
  type L = { label: string; url: string; source?: string };
  const base = (p: string, id: string, name: string, handle: string, subs: number | null, videos: number, views: number | null, links: L[], age: number, extra: Record<string, unknown> = {}) => ({
    platform: p,
    platform_id: id,
    name,
    handle,
    profile_url: p === "youtube" ? `https://www.youtube.com/${handle}` : p === "tiktok" ? `https://www.tiktok.com/${handle}` : `https://www.instagram.com/${handle.slice(1)}/`,
    avatar_url: `https://rig.invalid/collector/${id}.png`,
    subscriber_count: subs,
    video_count: videos,
    view_count: views,
    description: null as string | null,
    links,
    country: "Brazil",
    discovered_via: "blox fruits brasil",
    captured_at: iso(now - 3 * day),
    last_upload_at: iso(now - age * day),
    updated_at: iso(now - 5 * h),
    ...extra,
  });
  const creators = [
    base("youtube", "UCrig0001lia", "Lia Frutas", "@liafrutas", 182_000, 412, 21_400_000, [
      { label: "Linktree", url: "https://linktr.ee/liafrutas" },
      { label: "Discord", url: "https://discord.gg/liafrutas" },
      { label: "TikTok", url: "https://tiktok.com/@liafrutas", source: "linktr.ee/liafrutas" },
      { label: "Instagram", url: "https://instagram.com/lia.frutas", source: "linktr.ee/liafrutas" },
      { label: "Loja da Lia", url: "https://lojadalia.com.br", source: "linktr.ee/liafrutas" },
      { label: "WhatsApp", url: "https://wa.me/5511987654321", source: "YouTube About" },
    ], 1, {
      description: "Blox Fruits todo dia! 🍉 Trades, raids e dicas pra subir rápido.\n📩 Parcerias: contato@liafrutas.com.br\nLoja oficial e redes no Linktree 👇",
      email: "contato@liafrutas.com.br",
      email_source: "YouTube About",
      whatsapp: "5511987654321",
      recent_videos: vids("lia", [1, 3, 6], "Trade de frutas míticas"),
      history: [
        { at: iso(now - 5 * h), changes: [{ field: "Subscribers", from: "176K", to: "182K" }, { field: "Last upload", from: iso(now - 3 * day).slice(0, 10), to: iso(now - day).slice(0, 10) }, { field: "Links added", from: "", to: "lojadalia.com.br" }] },
        { at: iso(now - 29 * h), changes: [{ field: "Subscribers", from: "171K", to: "176K" }, { field: "Videos", from: "409", to: "411" }] },
      ],
    }),
    base("tiktok", "68110022334455", "Caio Trades", "@caiotrades", 54_300, 210, 1_900_000, [
      { label: "Beacons", url: "https://beacons.ai/caiotrades" },
      { label: "YouTube", url: "https://youtube.com/@caiotrades", source: "same person" },
    ], 2, { description: "trades de blox fruits 🔥 parcerias: caio.trades [arroba] gmail [ponto] com", email: "caio.trades@gmail.com", email_source: "TikTok bio", history: [{ at: iso(now - 5 * h), changes: [{ field: "Followers", from: "51.2K", to: "54.3K" }] }] }),
    base("youtube", "UCrig0003mun", "Mundo Blox", "@mundoblox", 1_240_000, 880, 210_000_000, [
      { label: "Discord", url: "https://discord.gg/mundoblox" },
      { label: "Site", url: "https://mundoblox.com.br" },
    ], 0, { email: "comercial@mundoblox.com.br", email_source: "site mundoblox.com.br/contato", contacted: { at: iso(now - 2 * day), via: "gmail", to: "comercial@mundoblox.com.br", person: "p_rig" } }),
    base("instagram", "4455667788", "Bia Joga", "@biajoga", 98_000, 640, null, [{ label: "Link in bio", url: "https://linktr.ee/biajoga" }], 4, { description: "Roblox girl 🎮 Brookhaven e Blox Fruits", email: null, email_source: null }),
    base("youtube", "UCrig0005raf", "Rafa Raids", "@rafaraids", 9_800, 95, 640_000, [], 6, { email: "rafa.raids@outlook.com", email_source: "typed", email_manual: true }),
    base("tiktok", "68110099887766", "Tio Kitsune", "@tiokitsune", 371_000, 540, 9_400_000, [{ label: "Instagram", url: "https://instagram.com/tiokitsune" }], 3, { email: null, email_source: null, updated_at: iso(now - 26 * h), update_error: null }),
    base("youtube", "UCrig0007duda", "Duda Robux", "@dudarobux", 23_500, 160, 3_100_000, [{ label: "Linktree", url: "https://linktr.ee/dudarobux" }, { label: "Kwai", url: "https://kwai.com/@dudarobux", source: "linktr.ee/dudarobux" }], 2, { email: "dudarobux.parcerias@gmail.com", email_source: "linktr.ee/dudarobux" }),
    base("instagram", "9988776655", "Gui Brookhaven", "@guibrookhaven", 41_000, 320, null, [{ label: "YouTube", url: "https://youtube.com/@guibrookhaven" }], 5, { email: null, email_source: null }),
  ];
  for (let i = 0; i < creators.length; i++) await avatar(join(cdir, "avatars"), creators[i]!.avatar_url, i, creators[i]!.name[0]!);
  const lines: [string, string][] = [
    ["info", 'Sweeping YouTube for "blox fruits brasil" - target 50 creator(s).'],
    ["info", "Dropping any channel with no upload in the last 14 days."],
    ["info", "Channels page 1: 20 new channel(s). 20 queued."],
    ["skip", "SKIP Caio Trades: same person as Caio Trades (TikTok) - linked there."],
    ["ok", "OK Mundo Blox - 1240000 subs, 2 link(s), email (site mundoblox.com.br/contato), last upload today"],
    ["drop", "DROP Velho Canal: dead - last upload 212 days ago (limit 14 days)."],
    ["ok", "OK Lia Frutas - 182000 subs, 6 link(s), email (YouTube About), last upload 1 day ago"],
  ];
  const seen = creators.flatMap((c) => [`${c.platform}:${c.platform_id}`, `${c.platform}:${c.handle.toLowerCase()}`]);
  writeFileSync(
    join(cdir, "state.json"),
    JSON.stringify({
      v: 2,
      settings: { platform: "youtube", query: "blox fruits brasil", gapDays: 14, target: 50, daily: true, lastTemplate: "padrao" },
      // newest last: the list shows Lia, Caio and Mundo Blox first
      creators: creators.slice().reverse(),
      seen: [...seen, "youtube:UCrigold1", "youtube:UCrigold2", "tiktok:@oldone"],
      run: o.running
        ? { running: true, label: "YouTube", platform: "youtube", query: "blox fruits brasil", startedAt: now - 95_000, endedAt: 0, status: "Running…", found: 6, target: 50, considered: 11, dropped: 3, known: 2 }
        : { running: false, label: "YouTube", platform: "youtube", query: "blox fruits brasil", startedAt: now - 3 * day, endedAt: now - 3 * day + 410_000, status: "Done. 8 new creator(s). 2 already collected or in Persons, passed over.", found: 8, target: 50, considered: 19, dropped: 9, known: 2 },
      refresh: o.refreshing
        ? { running: true, startedAt: now - 70_000, endedAt: 0, done: 3, total: 8, changed: 2, failed: 0, status: "Updating Mundo Blox…", lastFullAt: now - 29 * h }
        : { running: false, startedAt: now - 5 * h - 600_000, endedAt: now - 5 * h, done: 8, total: 8, changed: 3, failed: 0, status: "Updated 8 creator(s): 3 changed.", lastFullAt: now - 5 * h },
      log: lines.map(([tone, text], i) => ({ at: now - (lines.length - i) * 4000, tone, text })),
    }),
  );
}

if (import.meta.main) {
  const [dir, mode] = process.argv.slice(2);
  if (!dir) throw new Error("usage: bun ts/rig/collector-fixture.ts <dir> [running|refreshing]");
  await writeCollectorFixture(dir, { running: mode === "running", refreshing: mode === "refreshing" });
  console.log(`collector fixture in ${dir}`);
}
