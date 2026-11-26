// Emails in what a creator publishes: plain ones, mailto: links, and the usual disguises in Brazilian and English bios
// ("contato [arroba] gmail [ponto] com", "name (at) gmail.com", "name @ gmail . com"). Junk that looks like an email
// (image names like logo@2x.png, tracking/sentry addresses, placeholders) is left out.

const EMAIL_RE = /[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;

const JUNK_DOMAIN = /(^|\.)(example\.(com|org|net)|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|domain\.com|email\.com|seudominio\.com|test\.com|sentry\.wixpress\.com|users\.noreply\.github\.com|mailinator\.com)$/i;
const JUNK_LOCAL = /^(no-?reply|noreply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|privacy|dpo|seuemail|youremail|your\.?email|email|nome|name|user|usuario)$/i;
const FILE_TLD = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|mp4|webm|woff2?|ttf|avif|bmp|tiff?)$/i;

/** The disguised forms rewritten as a plain address (only around something that already looks like a local part). */
export function deobfuscate(text: string): string {
  return text
    .replace(/\s*[[({<]\s*(?:at|arroba)\s*[\])}>]\s*/gi, "@")
    .replace(/\s*[[({<]\s*(?:dot|ponto)\s*[\])}>]\s*/gi, ".")
    .replace(/([A-Za-z0-9._%+-])\s+(?:at|arroba)\s+([A-Za-z0-9-]+)\s+(?:dot|ponto)\s+([a-z]{2,})/gi, "$1@$2.$3")
    .replace(/([A-Za-z0-9._%+-])\s+@\s+([A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z]{2,})+)/g, (_m, a: string, b: string) => `${a}@${b.replace(/\s+/g, "")}`)
    .replace(/([A-Za-z0-9._%+-]@[A-Za-z0-9-]+)\s+\.\s+([a-z]{2,})/gi, "$1.$2");
}

export function isUsableEmail(e: string): boolean {
  const at = e.lastIndexOf("@");
  if (at < 1) return false;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1).toLowerCase();
  if (FILE_TLD.test(domain) || JUNK_DOMAIN.test(domain) || JUNK_LOCAL.test(local)) return false;
  if (/^[0-9a-f]{24,}$/i.test(local)) return false; // hashed tracking ids
  if (/\.\./.test(e) || local.endsWith(".")) return false;
  return true;
}

/** Every usable email in a text, lowercased, in order, once each. */
export function extractEmails(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const add = (raw: string): void => {
    const e = raw.replace(/^mailto:/i, "").split("?")[0]!.trim().replace(/[.,;:]+$/, "").toLowerCase();
    if (isUsableEmail(e) && !out.includes(e)) out.push(e);
  };
  for (const m of text.matchAll(/mailto:([^"'\s<>?]+)/gi)) {
    try {
      add(decodeURIComponent(m[1]!));
    } catch {
      add(m[1]!);
    }
  }
  for (const m of deobfuscate(text).matchAll(EMAIL_RE)) add(m[0]);
  return out;
}

/** Of several, the one to write to: a business-looking one first (contato/parcerias/business/comercial), then the first. */
export function bestEmail(emails: string[]): string | null {
  if (!emails.length) return null;
  const biz = emails.find((e) => /^(contato|contact|parcerias?|partnerships?|business|biz|comercial|publi|marketing|collab|negocios|negócios|ads|sponsor|booking)/i.test(e));
  return biz ?? emails[0]!;
}
