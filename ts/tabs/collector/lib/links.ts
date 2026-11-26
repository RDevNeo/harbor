// A creator's links: every URL their bio, About page or link-in-bio page gives, normalized (https, no www, no tracking
// params, redirect wrappers unwrapped), labeled by what it is, and turned into identity keys when it's a profile on a
// platform Collector knows (so the same person is never collected twice, whichever platform finds them first).
import type { CreatorLink } from "./types.ts";

// Bare "instagram.com/x" in a bio counts too (most bios don't type the scheme); a known-domain list keeps "obrigado.vc"-like
// words out.
const BARE_HOSTS =
  "(?:youtube\\.com|youtu\\.be|instagram\\.com|instagr\\.am|tiktok\\.com|vm\\.tiktok\\.com|twitter\\.com|x\\.com|twitch\\.tv|kick\\.com|discord\\.gg|discord\\.com|facebook\\.com|fb\\.com|kwai\\.com|wa\\.me|api\\.whatsapp\\.com|chat\\.whatsapp\\.com|t\\.me|linktr\\.ee|beacons\\.ai|bio\\.link|lnk\\.bio|linkin\\.bio|solo\\.to|campsite\\.bio|carrd\\.co|taplink\\.cc|allmylinks\\.com|linkr\\.bio|msha\\.ke|hoo\\.be|direct\\.me|tap\\.bio|snipfeed\\.co|stan\\.store|roblox\\.com|threads\\.net|github\\.com|spokpay\\.com)";
const URL_RE = new RegExp(`(?:https?:\\/\\/[^\\s<>"'\`)\\]]+|(?<![\\w@.])(?:www\\.)?${BARE_HOSTS}\\/[^\\s<>"'\`)\\]]*)`, "gi");

/** Hosts whose page is a list of the creator's links (worth opening for more links and an email). */
export const LINK_IN_BIO = new Set([
  "linktr.ee",
  "beacons.ai",
  "bio.link",
  "lnk.bio",
  "linkin.bio",
  "solo.to",
  "campsite.bio",
  "taplink.cc",
  "allmylinks.com",
  "linkr.bio",
  "msha.ke",
  "hoo.be",
  "direct.me",
  "tap.bio",
  "snipfeed.co",
  "linkbio.co",
  "carrd.co",
]);

export const isLinkInBio = (url: string): boolean => {
  const h = hostOf(url);
  return !!h && (LINK_IN_BIO.has(h) || h.endsWith(".carrd.co") || h.endsWith(".bio.link"));
};

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\.|^m\.|^mobile\./, "");
  } catch {
    return null;
  }
}

const TRACKING = /^(utm_|fbclid$|gclid$|igshid$|igsh$|si$|feature$|ref_src$|_t$|_r$|is_from_webapp$|sender_device$|mibextid$)/i;

/** One URL as Collector keeps it, or null when it isn't one. Redirect wrappers (YouTube, Instagram, Facebook) unwrapped. */
export function normalizeUrl(raw: string): string | null {
  let s = raw.trim().replace(/[.,;:!?…»”’'")\]}>]+$/u, "");
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
  const host = u.hostname.toLowerCase();
  const wrapped =
    (/(^|\.)youtube\.com$/.test(host) && u.pathname === "/redirect" && u.searchParams.get("q")) ||
    (host === "l.instagram.com" && u.searchParams.get("u")) ||
    ((host === "l.facebook.com" || host === "lm.facebook.com") && u.searchParams.get("u")) ||
    (host === "www.google.com" && u.pathname === "/url" && (u.searchParams.get("q") || u.searchParams.get("url")));
  if (wrapped) return normalizeUrl(wrapped);
  u.protocol = "https:";
  u.hostname = host.replace(/^www\./, "");
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  let out = u.toString();
  if (u.pathname === "/" && !u.search) out = out.replace(/\/$/, "");
  return out;
}

/** Every URL in a text (a bio, a description), normalized, in order, once each. */
export function extractUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const n = normalizeUrl(m[0]);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export type LinkKind =
  | "youtube"
  | "instagram"
  | "tiktok"
  | "twitter"
  | "twitch"
  | "kick"
  | "discord"
  | "facebook"
  | "kwai"
  | "whatsapp"
  | "telegram"
  | "threads"
  | "roblox"
  | "linkinbio"
  | "email"
  | "website";

const KIND_LABEL: Record<LinkKind, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  twitter: "X",
  twitch: "Twitch",
  kick: "Kick",
  discord: "Discord",
  facebook: "Facebook",
  kwai: "Kwai",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  threads: "Threads",
  roblox: "Roblox",
  linkinbio: "Link in bio",
  email: "Email",
  website: "Website",
};

export function kindOf(url: string): LinkKind {
  if (/^mailto:/i.test(url)) return "email";
  const h = hostOf(url) ?? "";
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return "youtube";
  if (/(^|\.)instagram\.com$|^instagr\.am$/.test(h)) return "instagram";
  if (/(^|\.)tiktok\.com$/.test(h)) return "tiktok";
  if (h === "twitter.com" || h === "x.com") return "twitter";
  if (h === "twitch.tv") return "twitch";
  if (h === "kick.com") return "kick";
  if (/^discord(app)?\.(gg|com)$/.test(h)) return "discord";
  if (h === "facebook.com" || h === "fb.com" || h === "fb.me") return "facebook";
  if (/(^|\.)kwai\.com$|^kwai\.app$/.test(h)) return "kwai";
  if (h === "wa.me" || /whatsapp\.com$/.test(h)) return "whatsapp";
  if (h === "t.me" || h === "telegram.me") return "telegram";
  if (h === "threads.net") return "threads";
  if (/(^|\.)roblox\.com$/.test(h)) return "roblox";
  if (isLinkInBio(url)) return "linkinbio";
  return "website";
}

export const kindLabel = (k: LinkKind): string => KIND_LABEL[k];

const IG_RESERVED = new Set(["p", "reel", "reels", "tv", "explore", "stories", "accounts", "direct", "about", "developer", "legal", "web", "api", "s"]);
const TT_RESERVED = new Set(["discover", "tag", "music", "video", "search", "foryou", "following", "live", "upload", "login", "signup"]);
const YT_RESERVED = new Set(["watch", "results", "playlist", "feed", "shorts", "redirect", "embed", "live", "hashtag", "gaming", "premium", "account", "post"]);

/** A creator profile a URL points at, as `<platform>:<id-or-@handle>` (lowercased handles), or null for anything else. */
export function profileKeyOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const k = kindOf(url);
  const parts = u.pathname.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (k === "youtube") {
    const [a, b] = parts;
    if (!a) return null;
    if (a.startsWith("@")) return `youtube:${a.toLowerCase()}`;
    if (a === "channel" && b && /^UC[\w-]{22}$/.test(b)) return `youtube:${b}`;
    if ((a === "c" || a === "user") && b) return `youtube:/${a}/${b.toLowerCase()}`;
    return null;
  }
  if (k === "instagram") {
    const a = parts[0];
    if (!a || IG_RESERVED.has(a.toLowerCase()) || !/^[\w.]{1,30}$/.test(a)) return null;
    return `instagram:@${a.toLowerCase()}`;
  }
  if (k === "tiktok") {
    const a = parts[0];
    if (!a || !a.startsWith("@") || TT_RESERVED.has(a.slice(1).toLowerCase())) return null;
    return `tiktok:${a.toLowerCase()}`;
  }
  return null;
}

/** A link entry for each URL, labeled, once each (by URL), keeping a label someone already gave it. */
export function mergeLinks(have: CreatorLink[], urls: { url: string; label?: string | null; source?: string }[]): CreatorLink[] {
  const out = have.slice();
  for (const x of urls) {
    const url = normalizeUrl(x.url) ?? x.url;
    if (out.some((l) => (normalizeUrl(l.url) ?? l.url) === url)) continue;
    out.push({ label: x.label || kindLabel(kindOf(url)), url, ...(x.source ? { source: x.source } : {}) });
  }
  return out;
}

/** A WhatsApp number a link or text gives (digits, with country code), for the WhatsApp channel. */
export function whatsappOf(urls: string[], text = ""): string | null {
  for (const url of urls) {
    try {
      const u = new URL(url);
      const h = u.hostname.replace(/^www\./, "");
      const d = h === "wa.me" ? u.pathname.replace(/\D/g, "") : /whatsapp\.com$/.test(h) ? (u.searchParams.get("phone") ?? "").replace(/\D/g, "") : "";
      if (d.length >= 10 && d.length <= 15) return d;
    } catch {
      // not a URL
    }
  }
  const m = text.match(/(?:whats(?:app|zap)?|wpp|zap)[^\d+]{0,12}(\+?\d[\d ().-]{9,18}\d)/i);
  if (m) {
    const d = m[1]!.replace(/\D/g, "");
    if (d.length >= 10 && d.length <= 15) return d.length <= 11 ? `55${d}` : d;
  }
  return null;
}
