// A creator's links and email, from everything they publish: the bio (description), their platform's own link list,
// each link-in-bio page (Linktree, Beacons, bio.link…: every link on it, and an email when one's there), and, when no
// email turned up yet, their own website (the home page, then a contact page). Each email keeps where it was found.
// Gentle: a few pages per creator at most, one at a time, a pause between each.
import { bestEmail, extractEmails } from "./email.ts";
import { extractUrls, hostOf, isLinkInBio, kindLabel, kindOf, mergeLinks, normalizeUrl } from "./links.ts";
import type { CreatorLink } from "./types.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const PAGE_MAX = 2_000_000;
export const LINK_PAGES_MAX = 3;
export const SITES_MAX = 2;
export const PAGE_DELAY_MS = 700;

/** Sites that are never the creator's own (stores, app stores, big platforms): no point looking for their email there. */
const NOT_THEIR_SITE =
  /(^|\.)(google\.com|apple\.com|roblox\.com|amazon\.[a-z.]+|mercadolivre\.com\.br|mercadolibre\.com|shopee\.com\.br|aliexpress\.com|spotify\.com|steampowered\.com|steamcommunity\.com|epicgames\.com|microsoft\.com|xbox\.com|playstation\.com|nintendo\.com|reddit\.com|wikipedia\.org|github\.com|patreon\.com|ko-fi\.com|livepix\.gg|streamlabs\.com|streamelements\.com|apoia\.se|picpay\.me|nubank\.com\.br|paypal\.com|paypal\.me|pix\.[a-z.]+|hotmart\.com|kiwify\.com\.br|sympla\.com\.br|bit\.ly|tinyurl\.com|cutt\.ly|goo\.gl|spokpay\.com|gamersclub\.com\.br|curseforge\.com|minecraft\.net|discord\.gg|discord\.com)$/i;

export interface FoundEmail {
  email: string;
  /** Where it was found, as shown: "bio", "linktr.ee/x", "site meusite.com.br/contato". */
  source: string;
}

export interface Enriched {
  links: CreatorLink[];
  email: FoundEmail | null;
  /** Every email seen, with its source (the first business-looking one is `email`). */
  emails: FoundEmail[];
}

export interface EnrichCtx {
  fetch: Fetch;
  sleep(ms: number): Promise<void>;
  stopped?(): boolean;
  log?(text: string): void;
}

/** A page's HTML (a browser's UA, English then Portuguese), or null when it doesn't answer one. */
export async function fetchPage(f: Fetch, url: string): Promise<{ html: string; url: string } | null> {
  try {
    const r = await f(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "";
    if (type && !/html|text\/plain/i.test(type)) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > PAGE_MAX) return { html: new TextDecoder().decode(buf.slice(0, PAGE_MAX)), url: r.url || url };
    return { html: new TextDecoder().decode(buf), url: r.url || url };
  } catch {
    return null;
  }
}

const ASSET = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|woff2?|ttf|xml|txt)(\?|$)/i;
const BOILERPLATE = /(^|\.)(linktr\.ee|linktree\.com|beacons\.ai|bio\.link|lnk\.bio|solo\.to|taplink\.cc|allmylinks\.com|carrd\.co|w3\.org|schema\.org|googletagmanager\.com|google-analytics\.com|gstatic\.com|googleapis\.com|cloudflare\.com|jsdelivr\.net|unpkg\.com|sentry\.io|facebook\.net|doubleclick\.net|hotjar\.com|onetrust\.com|cookielaw\.org|apple\.com|play\.google\.com)$/i;

const decodeEntities = (s: string): string => s.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Linktree pages carry their links as JSON (`__NEXT_DATA__`): the buttons and the social icons, with titles. */
export function linktreeLinks(html: string): { url: string; label: string | null }[] {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data: unknown;
  try {
    data = JSON.parse(m[1]!);
  } catch {
    return [];
  }
  const acct = (data as { props?: { pageProps?: { account?: Record<string, unknown>; links?: unknown[]; socialLinks?: unknown[] } } })?.props?.pageProps;
  const out: { url: string; label: string | null }[] = [];
  const take = (arr: unknown): void => {
    for (const x of Array.isArray(arr) ? arr : []) {
      const o = x as { url?: unknown; title?: unknown; type?: unknown };
      if (typeof o?.url === "string" && o.url) out.push({ url: o.url, label: typeof o.title === "string" && o.title ? o.title : null });
    }
  };
  take(acct?.links);
  take(acct?.account?.links);
  take(acct?.socialLinks);
  take(acct?.account?.socialLinks);
  return out;
}

/** The outbound links of any page: absolute hrefs to other sites, less assets and the page's own boilerplate. */
export function pageLinks(html: string, pageUrl: string): { url: string; label: string | null }[] {
  const own = hostOf(pageUrl);
  const out: { url: string; label: string | null }[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = decodeEntities(m[1]!);
    if (/^mailto:/i.test(raw)) continue;
    if (!/^https?:\/\//i.test(raw) || ASSET.test(raw)) continue;
    const url = normalizeUrl(raw);
    if (!url) continue;
    const h = hostOf(url);
    if (!h || h === own || BOILERPLATE.test(h)) continue;
    if (!out.some((x) => x.url === url)) out.push({ url, label: null });
  }
  return out;
}

const shortUrl = (url: string): string => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Links and emails out of the creator's own words (a bio, an About description). */
export function fromText(text: string | null | undefined, source: string): { links: { url: string; label: string | null; source: string }[]; emails: FoundEmail[] } {
  return {
    links: extractUrls(text).map((url) => ({ url, label: null, source })),
    emails: extractEmails(text).map((email) => ({ email, source })),
  };
}

/**
 * Everything findable for one creator, from what the platform gave (`links`, `bio`): link-in-bio pages opened, and their
 * website when there's still no email. `bioSource` names the bio ("YouTube About", "Instagram bio").
 */
export async function enrich(c: EnrichCtx, input: { links: CreatorLink[]; bio: string | null; bioSource: string }): Promise<Enriched> {
  const fromBio = fromText(input.bio, input.bioSource);
  let links = mergeLinks(input.links, fromBio.links);
  const emails: FoundEmail[] = [...fromBio.emails];
  const addEmails = (list: string[], source: string): void => {
    for (const e of list) if (!emails.some((x) => x.email === e)) emails.push({ email: e, source });
  };
  for (const l of input.links) if (/^mailto:/i.test(l.url)) addEmails(extractEmails(l.url), input.bioSource);

  const stopped = (): boolean => c.stopped?.() ?? false;
  const bioPages = links.filter((l) => isLinkInBio(l.url)).slice(0, LINK_PAGES_MAX);
  for (const l of bioPages) {
    if (stopped()) break;
    const page = await fetchPage(c.fetch, l.url);
    await c.sleep(PAGE_DELAY_MS);
    if (!page) continue;
    const src = shortUrl(l.url);
    const found = [...linktreeLinks(page.html), ...pageLinks(page.html, page.url)];
    links = mergeLinks(
      links,
      found.filter((x) => !/^mailto:/i.test(x.url)).map((x) => ({ ...x, source: src })),
    );
    addEmails(extractEmails(page.html), src);
  }

  if (!emails.length) {
    const sites = links.filter((l) => kindOf(l.url) === "website" && !NOT_THEIR_SITE.test(hostOf(l.url) ?? "")).slice(0, SITES_MAX);
    for (const l of sites) {
      if (stopped() || emails.length) break;
      const home = await fetchPage(c.fetch, l.url);
      await c.sleep(PAGE_DELAY_MS);
      if (!home) continue;
      const host = hostOf(home.url) ?? hostOf(l.url) ?? l.url;
      addEmails(extractEmails(home.html), `site ${host}`);
      if (emails.length) break;
      // A contact page the home page links to (or the usual paths), one at most.
      const contact =
        [...home.html.matchAll(/href\s*=\s*["']([^"']*(?:contato|contact|fale-conosco|sobre|about)[^"']*)["']/gi)]
          .map((m) => {
            try {
              return new URL(decodeEntities(m[1]!), home.url).toString();
            } catch {
              return null;
            }
          })
          .find((u) => u && hostOf(u) === host) ?? `${new URL(home.url).origin}/contato`;
      const page = await fetchPage(c.fetch, contact);
      await c.sleep(PAGE_DELAY_MS);
      if (page) addEmails(extractEmails(page.html), `site ${shortUrl(contact)}`);
    }
  }

  links = links.filter((l) => !/^mailto:/i.test(l.url)).map((l) => (l.label ? l : { ...l, label: kindLabel(kindOf(l.url)) }));
  const best = bestEmail(emails.map((e) => e.email));
  return { links, email: best ? emails.find((e) => e.email === best)! : null, emails };
}
