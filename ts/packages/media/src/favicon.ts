import { lookup } from "node:dns/promises";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { basename, dirname, join } from "node:path";
import { dataDir } from "@harbor/store";
import sharp from "sharp";
import { type Decoded, decodeBytes } from "./images.ts";

export const SIZE = 32;
const MAX_FILE = 8 * 2 ** 20;
const MAX_SIDE = 4096;
const MAX_ALLOC = 128 * 2 ** 20;
const WEEK_MS = 7 * 86400 * 1000;
const EXTS = ["svg", "png", "ico"];

interface Watch {
  src: string;
  mtime: number | null;
  checked: number;
}

const watched = new Map<number, Watch>();

function mtime(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function changed(repo: number, now: number = Date.now()): boolean {
  const w = watched.get(repo);
  if (!w || now - w.checked < 3000) return false;
  w.checked = now;
  const m = mtime(w.src);
  if (m === w.mtime) return false;
  w.mtime = m;
  return true;
}

function watch(repo: number, src: string | null): void {
  if (src === null) watched.delete(repo);
  else watched.set(repo, { src, mtime: mtime(src), checked: Date.now() });
}

const cacheDir = (): string => join(dataDir(), "favicons");

export const customPath = (repo: number): string => join(cacheDir(), "custom", String(repo));

export function setCustom(repo: number, file: string): boolean {
  const dst = customPath(repo);
  try {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(file, dst);
    return true;
  } catch {
    return false;
  }
}

export function clearCustom(repo: number): void {
  rmSync(customPath(repo), { force: true });
}

export async function resolve(repo: number, root: string, name: string, refresh: boolean): Promise<Decoded | null> {
  const custom = customPath(repo);
  if (isFile(custom)) {
    const img = await decode(custom);
    if (img) {
      watch(repo, custom);
      return img;
    }
  }
  for (const src of await localCandidates(root, name)) {
    const img = await decode(src);
    if (img) {
      watch(repo, src);
      return img;
    }
  }
  watch(repo, null);
  const domain = website(root);
  if (domain === null) return null;
  const file = await fetchSiteIcon(domain, refresh);
  return file === null ? null : decode(file);
}

export async function describeLocal(root: string, name: string): Promise<string> {
  for (const src of await localCandidates(root, name)) if (await decode(src)) return src;
  const d = website(root);
  return d === null ? "monogram" : `website ${d}`;
}

function roots(root: string): string[] {
  const v = [root];
  for (const d of ["web", "frontend", "site", "www", "client", "app", "packages/web", "packages/app", "packages/site"]) {
    const p = join(root, d);
    if (isFile(join(p, "package.json")) || isDir(join(p, "public")) || isFile(join(p, "index.html"))) v.push(p);
  }
  for (const parent of ["apps", "packages"]) {
    let subs: string[];
    try {
      subs = readdirSync(join(root, parent)).map((n) => join(root, parent, n)).filter((p) => isDir(p) && !v.includes(p));
    } catch {
      continue;
    }
    const keyOf = (p: string): [number, string] => {
      const n = basename(p).toLowerCase();
      const rank = ["web", "site", "www", "app", "frontend", "client"].indexOf(n);
      return [rank < 0 ? 9 : rank, n];
    };
    subs.sort((a, b) => {
      const [ra, na] = keyOf(a);
      const [rb, nb] = keyOf(b);
      return ra - rb || cmp(na, nb);
    });
    v.push(...subs);
  }
  return v;
}

const cmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function glob(dir: string, f: (name: string) => boolean): string[] {
  try {
    return readdirSync(dir).filter((n) => f(n.toLowerCase())).map((n) => join(dir, n)).sort(cmp);
  } catch {
    return [];
  }
}

export async function localCandidates(root: string, name: string): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots(root)) {
    const tier: string[] = [];
    for (const app of ["app", "src/app"]) for (const stem of ["icon", "favicon", "apple-icon"]) for (const ext of EXTS) tier.push(join(r, app, `${stem}.${ext}`));
    for (const dir of ["public", "static", "src/assets", "assets", ""]) {
      const d = join(r, dir);
      for (const f of ["favicon.svg", "favicon.png", "icon.svg", "icon.png", "apple-touch-icon.png", "favicon.ico"]) tier.push(join(d, f));
      tier.push(...glob(d, (n) => (n.startsWith("icon-") || n.startsWith("favicon-")) && n.endsWith(".png")));
    }
    out.push(...(await bestOf(tier)));
    out.push(...(await bestOf(htmlIcons(r))));
    out.push(...(await bestOf(manifestIcons(r))));
    const app = [
      "src-tauri/icons/icon.png",
      "src-tauri/icons/128x128@2x.png",
      "src-tauri/icons/128x128.png",
      "build/icon.png",
      "resources/icon.png",
      "assets/icon.svg",
      "assets/icon.png",
      `icons/${name}.svg`,
      `icons/${name}.png`,
      `assets/${name}.svg`,
      `assets/${name}.png`,
    ].map((p) => join(r, p));
    app.push(...glob(join(r, "assets"), (n) => n.startsWith("icon") && (n.endsWith(".png") || n.endsWith(".svg"))));
    for (const dpi of ["xxxhdpi", "xxhdpi", "xhdpi"]) for (const base of ["android/app/src/main/res", "app/src/main/res"]) app.push(join(r, `${base}/mipmap-${dpi}/ic_launcher.png`));
    out.push(...(await bestOf(app)));
    out.push(...(await desktopIcons(r)));
  }
  const seen = new Set<string>();
  return out.filter((p) => isFile(p) && !seen.has(p) && seen.add(p));
}

async function bestOf(files: string[]): Promise<string[]> {
  const rows: [number, number, number, string][] = [];
  for (const [i, p] of files.entries()) {
    if (!isFile(p)) continue;
    const ext = (p.split(".").at(-1) ?? "").toLowerCase();
    let rank = 3;
    let size = 0;
    if (ext === "svg") [rank, size] = [0, Number.MAX_SAFE_INTEGER];
    else if (ext === "ico") [rank, size] = [2, 0];
    else {
      const m = await sharp(p).metadata().catch(() => null);
      if (m?.width && m.height) [rank, size] = m.width === m.height ? [0, m.width] : [1, Math.min(m.width, m.height)];
    }
    rows.push([rank, -size, i, p]);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || cmp(a[3], b[3]));
  return rows.map((r) => r[3]);
}

function htmlIcons(r: string): string[] {
  const files = glob(r, (n) => n.endsWith(".html"));
  for (const d of ["public", "src", "static"]) files.push(...glob(join(r, d), (n) => n === "index.html"));
  const v: string[] = [];
  for (const f of files) {
    let html: string;
    try {
      html = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const href of linkIcons(html)) {
      if (href.includes("://") || href.startsWith("//") || href.startsWith("data:")) continue;
      v.push(...localHref(r, dirname(f), href));
    }
  }
  return v;
}

function localHref(r: string, base: string, rawHref: string): string[] {
  const href = rawHref.split(/[?#]/)[0] ?? "";
  if (href.includes("..") || href === "") return [];
  if (href.startsWith("/")) return ["", "public", "static"].map((d) => join(r, d, href.slice(1)));
  return [join(base, href), join(r, "public", href)];
}

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

export function linkIcons(html: string): string[] {
  const lower = asciiLower(html);
  const v: string[] = [];
  let at = 0;
  for (;;) {
    const i = lower.indexOf("<link", at);
    if (i < 0) break;
    const gt = lower.indexOf(">", i);
    const end = gt < 0 ? lower.length : gt;
    const tag = html.slice(i, end);
    const rel = asciiLower(attr(tag, "rel") ?? "");
    if (rel.split(/\s+/).some((w) => w === "icon" || w === "apple-touch-icon")) {
      const h = attr(tag, "href");
      if (h !== null) v.push(h);
    }
    at = end;
  }
  return v;
}

function attr(tag: string, name: string): string | null {
  const lower = asciiLower(tag);
  let at = 0;
  for (;;) {
    const i = lower.indexOf(name, at);
    if (i < 0) return null;
    at = i + name.length;
    if (!/\s/.test(lower[i - 1] ?? "x")) continue;
    const rest = lower.slice(at).trimStart();
    if (!rest.startsWith("=")) continue;
    const val = tag.slice(tag.length - rest.length + 1).trimStart();
    const q = val[0];
    if (q === undefined) return null;
    if (q === '"' || q === "'") return val.slice(1).split(q)[0] ?? null;
    return val.split(/[\s>]/)[0] ?? null;
  }
}

function manifestIcons(r: string): string[] {
  const v: string[] = [];
  for (const d of ["", "public", "static", "app"]) {
    for (const f of ["manifest.json", "site.webmanifest", "manifest.webmanifest"]) {
      const p = join(r, d, f);
      let j: unknown;
      try {
        j = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        continue;
      }
      const icons = typeof j === "object" && j !== null && "icons" in j && Array.isArray(j.icons) ? (j.icons as unknown[]) : [];
      for (const icon of icons) {
        const src = typeof icon === "object" && icon !== null && "src" in icon ? icon.src : null;
        if (typeof src === "string" && !src.includes("://")) v.push(...localHref(r, dirname(p), src));
      }
    }
  }
  return v;
}

async function desktopIcons(r: string): Promise<string[]> {
  const files = glob(r, (n) => n.endsWith(".desktop"));
  for (const d of ["assets", "data", "packaging", "dist", "resources"]) files.push(...glob(join(r, d), (n) => n.endsWith(".desktop")));
  const v: string[] = [];
  for (const f of files) {
    let s: string;
    try {
      s = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const line = s.split("\n").find((l) => l.startsWith("Icon="));
    if (line === undefined) continue;
    const icon = line.slice(5).trim();
    if (icon.includes("/")) v.push(join(dirname(f), icon));
    else for (const d of ["", "assets", "icons", "data", "resources"]) for (const ext of ["svg", "png"]) v.push(join(r, d, `${icon}.${ext}`));
  }
  return bestOf(v);
}

export async function decode(p: string): Promise<Decoded | null> {
  let bytes: Buffer;
  try {
    if (statSync(p).size > MAX_FILE) return null;
    bytes = readFileSync(p);
  } catch {
    return null;
  }
  const head = bytes.subarray(0, 512).toString("utf8").toLowerCase();
  const svg = p.toLowerCase().endsWith(".svg") || head.includes("<svg") || head.startsWith("<?xml");
  if (!svg) return decodeIcon(bytes);
  try {
    const png = await sharp(bytes, { density: 384 }).resize(SIZE * 2, SIZE * 2, { fit: "inside" }).png().toBuffer();
    return decodeIcon(png);
  } catch {
    return null;
  }
}

export async function decodeIcon(bytes: Uint8Array): Promise<Decoded | null> {
  try {
    const { image } = await decodeBytes(bytes, SIZE * 4, { maxSide: MAX_SIDE, maxAlloc: MAX_ALLOC });
    const s = Math.max(image.width, image.height);
    let pipe = sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).resize({ width: s, height: s, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
    if (s !== SIZE) pipe = pipe.resize(SIZE, SIZE, { kernel: "lanczos3" });
    const out = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: SIZE, height: SIZE, data: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength) };
  } catch {
    return null;
  }
}

function read(root: string, f: string): string | null {
  try {
    return readFileSync(join(root, f), "utf8");
  } catch {
    return null;
  }
}

function jsonOf(s: string | null): Record<string, unknown> | null {
  if (s === null) return null;
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function website(root: string): string | null {
  const pkg = jsonOf(read(root, "package.json"));
  if (typeof pkg?.homepage === "string") {
    const d = domainOf(pkg.homepage);
    if (d) return d;
  }
  for (const f of ["CNAME", "public/CNAME", "static/CNAME", "docs/CNAME"]) {
    const s = read(root, f);
    const d = s === null ? null : domainOf(s.split("\n")[0] ?? "");
    if (d) return d;
  }
  const vercel = jsonOf(read(root, "vercel.json"));
  const alias = vercel?.alias;
  const first = typeof alias === "string" ? alias : Array.isArray(alias) && typeof alias[0] === "string" ? alias[0] : null;
  if (first !== null) {
    const d = domainOf(first);
    if (d) return d;
  }
  const netlify = read(root, "netlify.toml");
  if (netlify !== null) {
    for (const l of netlify.split("\n")) {
      const i = l.indexOf("https://");
      const d = i < 0 ? null : domainOf(l.slice(i + "https://".length));
      if (d) return d;
    }
  }
  const readme = ["README.md", "readme.md", "README"].map((f) => read(root, f)).find((s) => s !== null);
  if (readme === undefined || readme === null) return null;
  const u = firstUrl(readme);
  return u === null ? null : domainOf(u);
}

const NOT_SITES = [
  "github.com", "githubusercontent.com", "gitlab.com", "bitbucket.org", "shields.io", "npmjs.com", "npmjs.org", "crates.io",
  "docs.rs", "pypi.org", "localhost", "127.0.0.1", "0.0.0.0", "example.com", "vercel.com", "netlify.com", "nextjs.org",
  "vitejs.dev", "vite.dev", "badge.fury.io", "travis-ci.org", "codecov.io",
];

export function domainOf(input: string): string | null {
  const s = input.trim();
  const rest = s.startsWith("https://") ? s.slice(8) : s.startsWith("http://") ? s.slice(7) : s;
  const host = (rest.split(/[/?#:"')*]/)[0] ?? "").trim().toLowerCase();
  const ok = host.includes(".") && /^[a-z0-9.-]*$/.test(host) && !/^[0-9.]*$/.test(host) && !NOT_SITES.some((n) => host === n || host.endsWith(`.${n}`));
  return ok ? host : null;
}

function v4Parts(ip: string): number[] | null {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

function v6Groups(ip: string): number[] | null {
  let s = ip;
  const v4 = s.lastIndexOf(".") >= 0 ? v4Parts(s.slice(s.lastIndexOf(":") + 1)) : null;
  if (v4) s = `${s.slice(0, s.lastIndexOf(":") + 1)}${((v4[0] ?? 0) * 256 + (v4[1] ?? 0)).toString(16)}:${((v4[2] ?? 0) * 256 + (v4[3] ?? 0)).toString(16)}`;
  const [head, tail] = s.split("::") as [string, string | undefined];
  const h = head === "" ? [] : head.split(":");
  const t = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array<string>(Math.max(fill, 0)).fill("0"), ...t].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPublic(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const o = v4Parts(ip);
    if (!o) return false;
    const [a = 0, b = 0, c = 0] = o;
    const priv = a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168);
    const doc = (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
    const loopback = a === 127;
    const link = a === 169 && b === 254;
    const other = ip === "255.255.255.255" || (a >= 224 && a < 240) || a === 0 || (a === 100 && b >= 64 && b < 128);
    return !(priv || doc || loopback || link || other);
  }
  if (kind === 6) {
    const g = v6Groups(ip);
    if (!g) return false;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublic(`${(g[6] ?? 0) >> 8}.${(g[6] ?? 0) & 255}.${(g[7] ?? 0) >> 8}.${(g[7] ?? 0) & 255}`);
    const s = g[0] ?? 0;
    const loopback = g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
    const unspecified = g.every((x) => x === 0);
    const multicast = (s & 0xff00) === 0xff00;
    return !(loopback || unspecified || multicast || (s & 0xfe00) === 0xfc00 || (s & 0xffc0) === 0xfe80);
  }
  return false;
}

export async function get(url0: string, domain: string, out: string): Promise<boolean> {
  let url = url0;
  for (let n = 0; n < 4; n++) {
    if (!url.startsWith("https://")) return false;
    const rest = url.slice(8);
    const auth = rest.split(/[/?#]/)[0] ?? "";
    const host = auth.toLowerCase();
    const site = (h: string): boolean => h === domain || h === `www.${domain}` || `www.${h}` === domain;
    if (/[:@]/.test(auth) || domainOf(host) === null || !site(host)) return false;
    const addrs = await lookup(host, { all: true }).catch(() => []);
    const first = addrs[0];
    if (!first || !addrs.every((a) => isPublic(a.address))) return false;
    const pin = first.family === 6 ? `${host}:443:[${first.address}]` : `${host}:443:${first.address}`;
    const proc = Bun.spawn(["curl", "-s", "--max-time", "8", "--max-filesize", "2000000", "--proto", "=https", "--resolve", pin, "-w", "%{http_code} %{redirect_url}", "-o", out, url], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const w = await new Response(proc.stdout as ReadableStream).text();
    const code = await proc.exited;
    const sp = w.indexOf(" ");
    const status = Number(sp < 0 ? w : w.slice(0, sp)) || 0;
    const next = sp < 0 ? "" : w.slice(sp + 1).trim();
    if (status >= 200 && status < 300) return code === 0 && isFile(out) && statSync(out).size <= 2_000_000;
    if (status >= 300 && status < 400 && next !== "") url = next;
    else return false;
  }
  return false;
}

export function firstUrl(text: string): string | null {
  const i = text.includes("https://") ? text.indexOf("https://") : text.indexOf("http://");
  if (i < 0) return null;
  let u = "";
  for (const c of text.slice(i)) {
    if (/\s/.test(c) || ")]>\"'`".includes(c)) break;
    u += c;
  }
  return u;
}

export async function fetchSiteIcon(domain: string, refresh: boolean): Promise<string | null> {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, domain);
  const none = join(dir, `${domain}.none`);
  const fresh = (p: string): boolean => {
    const m = mtime(p);
    return m !== null && Date.now() - m < WEEK_MS;
  };
  if (!refresh) {
    if (fresh(file)) return file;
    if (fresh(none)) return null;
  }
  const base = `https://${domain}`;
  const urls: string[] = [];
  const page = join(dir, `${domain}.html`);
  if (await get(`${base}/`, domain, page)) {
    const html = existsSync(page) ? readFileSync(page, "utf8") : "";
    for (const href of linkIcons(html)) {
      let url: string;
      if (href.startsWith("https://")) url = href;
      else if (href.startsWith("//") || href.startsWith("data:") || href.includes("://")) continue;
      else if (href.startsWith("/")) url = `${base}${href}`;
      else url = `${base}/${href}`;
      if (domainOf(url) === domain) urls.push(url);
    }
  }
  rmSync(page, { force: true });
  urls.push(`${base}/favicon.ico`);
  const tmp = join(dir, `${domain}.part`);
  for (const url of urls) {
    if ((await get(url, domain, tmp)) && (await decode(tmp))) {
      renameSync(tmp, file);
      rmSync(none, { force: true });
      return file;
    }
  }
  rmSync(tmp, { force: true });
  writeFileSync(none, "");
  return isFile(file) ? file : null;
}
