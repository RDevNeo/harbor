// Discord invite URLs, as the userscript normalizes them: `https://discord.gg/<code>` (or discord.com/invite/<code>),
// trailing punctuation dropped, de-duplicated.

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;
const DISCORD_INVITE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[A-Za-z0-9-]+/gi;

export function normalizeInvite(url: string | null | undefined): string | null {
  if (!url) return null;
  let s = url.trim().replace(/[)\],.!?:;]+$/g, "");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (host === "discord.gg") return parts[0] ? `https://discord.gg/${parts[0]}` : null;
    if ((host === "discord.com" || host === "discordapp.com") && parts[0] === "invite" && parts[1]) return `https://discord.com/invite/${parts[1]}`;
  } catch {
    // not a URL
  }
  return null;
}

export function extractInviteUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const all = [...(text.match(URL_REGEX) ?? []), ...(text.match(DISCORD_INVITE_REGEX) ?? [])];
  return [...new Set(all.map(normalizeInvite).filter((x): x is string => x !== null))];
}

/** The code of an invite URL (discord.gg/abc → abc), for de-duplication across both URL forms. */
export function inviteCode(url: string): string {
  return url.replace(/\/+$/, "").split("/").pop()?.toLowerCase() ?? url;
}

/** A Reader channel: a link (https://discord.com/channels/<guild>/<channel>[/<message>]) or a bare id. */
export function parseChannel(text: string): { guild: string | null; channel: string } | null {
  const t = text.trim();
  if (/^\d{15,22}$/.test(t)) return { guild: null, channel: t };
  const m = t.match(/discord(?:app)?\.com\/channels\/(@me|\d{15,22})\/(\d{15,22})/);
  return m ? { guild: m[1] === "@me" ? null : (m[1] ?? null), channel: m[2]! } : null;
}
