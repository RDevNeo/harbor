#!/usr/bin/env bun
// Imports Person Hub's data into Hub's Persons tab. COPIES ONLY: nothing in Person Hub's data folder (creators-hub) or
// ~/.config/Creators Hub is ever moved, changed or deleted, so Person Hub keeps working on its own data.
//
//   bun ts/packages/persons/scripts/migrate.ts [--dry-run] [--sessions] [--force] [--from DIR] [--profile DIR] [--to DIR]
//
// Repeatable: each run copies what changed in Person Hub since the last run (manifest: <to>/.import.json). A file Hub
// changed since it was imported is kept (reported as "kept: changed in Hub") unless --force; anything overwritten is
// first saved under <to>/.import-backup/<time>/. WhatsApp's linked-device keys are copied only with --sessions (the
// cutover, with Person Hub stopped): two programs on one linked device's keys would break it. Discord and Gmail
// sessions are copied always (several clients on one login are normal).
// Verified by counts (people, stores, lists, notes, read marks, conversations and messages per cache, WhatsApp chats,
// pictures) of the source and the copy; exit 1 when they differ. Prints names and counts only, never contents.
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { paths } from "@harbor/os";
import { dirname, join, relative } from "node:path";

const args = process.argv.slice(2);
const flag = (f: string): boolean => args.includes(f);
const opt = (f: string, d: string): string => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const DRY = flag("--dry-run");
const SESSIONS = flag("--sessions");
const FORCE = flag("--force");
// Person Hub's data folder and Electron profile, and Hub's (the system's data and config folders: @harbor/os)
const FROM = opt("--from", join(paths.systemDataHome(), "creators-hub"));
const PROFILE = opt("--profile", join(paths.configHome(), "Creators Hub"));
const TO = opt("--to", join(paths.dataHome(), "hub", "persons"));
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

if (!existsSync(join(FROM, "data.json"))) {
  console.error(`No Person Hub data at ${FROM} (data.json missing).`);
  process.exit(2);
}

const readJson = (f: string): unknown => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ---------- what to copy ----------

interface Item { src: string; dst: string; dir: boolean; why: string }
const items: Item[] = [];
const file = (name: string, why: string): void => {
  if (existsSync(join(FROM, name))) items.push({ src: join(FROM, name), dst: join(TO, name), dir: false, why });
};
const dir = (name: string, why: string, to = name, from = FROM): void => {
  if (existsSync(join(from, name))) items.push({ src: join(from, name), dst: join(TO, to), dir: true, why });
};
file("data.json", "people, stores, lists, notes, read marks");
file("connections.json", "the sections' accounts");
file("google-client.json", "Gmail's OAuth client");
file("spokpay.json", "SpokPay admin key");
file("spokpay-links.json", "SpokPay links");
dir("images", "store pictures");
dir("avatars", "picture cache");
for (const n of readdirSync(FROM)) {
  if (/^gmail-(account|cache)-[\w-]+\.json$/.test(n)) file(n, n.includes("account") ? "Gmail sign-in" : "Gmail conversations");
  if (/^discord-cache(-[\w-]+)?\.json$/.test(n)) file(n, "Discord conversations");
  if (/^whatsapp-[\w-]+$/.test(n) && statSync(join(FROM, n)).isDirectory()) {
    file(join(n, "chats.json"), "WhatsApp conversations");
    dir(join(n, "media"), "WhatsApp media");
    if (SESSIONS) dir(join(n, "auth"), "WhatsApp linked device (cutover)");
  }
}
// Discord logins: Person Hub's Electron partitions, one per Discord connection (discord.ts partitionOf / discordSessionDir)
const conns = (obj(readJson(join(FROM, "connections.json"))).connections as { id: string; kind: string }[] | undefined) ?? [];
const partition = (id: string): string => (id === "stores" ? "discord" : id === "spokpay" ? "discord-spokpay" : `conn-${id}`);
const clientFile = (id: string): string => (id === "stores" ? "discord-client.json" : id === "spokpay" ? "discord-client-spokpay.json" : `discord-client-${id}.json`);
for (const c of conns.filter((x) => x.kind === "discord")) {
  const p = partition(c.id);
  if (existsSync(join(PROFILE, "Partitions", p))) items.push({ src: join(PROFILE, "Partitions", p), dst: join(TO, "discord", c.id, "Partitions", p), dir: true, why: `Discord login (${c.id})` });
  if (existsSync(join(PROFILE, clientFile(c.id)))) items.push({ src: join(PROFILE, clientFile(c.id)), dst: join(TO, "discord", c.id, clientFile(c.id)), dir: false, why: `Discord client headers (${c.id})` });
}

/** Chromium's caches: not needed for a login, and big. */
const SKIP_IN_PROFILE = /(^|\/)(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|CacheStorage|ScriptCache|Crashpad)(\/|$)/;
/** Lock files of a running Chromium / LevelDB: copying them would make the copy look in use. */
const SKIP_LOCKS = /(^|\/)(LOCK|SingletonLock|SingletonSocket|SingletonCookie)$/;

function walk(d: string, base = d, out: string[] = []): string[] {
  for (const n of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, n.name);
    const rel = relative(base, p);
    if (SKIP_IN_PROFILE.test(rel) || SKIP_LOCKS.test(rel)) continue;
    if (n.isDirectory()) walk(p, base, out);
    else if (n.isFile()) out.push(rel);
  }
  return out;
}

// ---------- copy ----------

interface Manifest { files: Record<string, { sha: string; at: string }> }
const MANIFEST = join(TO, ".import.json");
const manifest = (readJson(MANIFEST) as Manifest | null) ?? { files: {} };
const report = { copied: 0, same: 0, kept: [] as string[], backedUp: 0, bytes: 0 };

function copyOne(src: string, dst: string): void {
  const key = relative(TO, dst);
  const srcSha = sha(src);
  if (existsSync(dst)) {
    const dstSha = sha(dst);
    if (dstSha === srcSha) {
      report.same++;
      manifest.files[key] = { sha: srcSha, at: manifest.files[key]?.at ?? new Date().toISOString() };
      return;
    }
    const imported = manifest.files[key]?.sha;
    // changed in Hub since it was imported (or there before any import): keep Hub's, unless --force
    if (imported !== dstSha && !FORCE) {
      report.kept.push(key);
      return;
    }
    if (!DRY) {
      const bak = join(TO, ".import-backup", STAMP, key);
      mkdirSync(dirname(bak), { recursive: true });
      copyFileSync(dst, bak);
    }
    report.backedUp++;
  }
  if (!DRY) {
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    copyFileSync(src, dst);
  }
  report.copied++;
  report.bytes += statSync(src).size;
  manifest.files[key] = { sha: srcSha, at: new Date().toISOString() };
}

for (const it of items) {
  if (!it.dir) copyOne(it.src, it.dst);
  else for (const rel of walk(it.src)) copyOne(join(it.src, rel), join(it.dst, rel));
}
if (!DRY) {
  mkdirSync(TO, { recursive: true, mode: 0o700 });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600 });
}

// ---------- verify by counts ----------

function counts(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const d = obj(readJson(join(root, "data.json")));
  const people = Array.isArray(d.people) ? (d.people as Record<string, unknown>[]) : [];
  out.people = people.length;
  out.stores = Array.isArray(d.stores) ? d.stores.length : 0;
  out.lists = Array.isArray(d.lists) ? d.lists.length : 0;
  out["people with notes"] = people.filter((p) => typeof p.notes === "string" && p.notes.trim()).length;
  out["note characters"] = people.reduce((n, p) => n + (typeof p.notes === "string" ? p.notes.length : 0), 0);
  out["read marks"] = people.reduce((n, p) => n + Object.keys(obj(p.seen)).length, 0);
  out["people with socials"] = people.filter((p) => Array.isArray(p.socials) && p.socials.length).length;
  out.connections = (((obj(readJson(join(root, "connections.json"))).connections as unknown[]) ?? []).length);
  if (!existsSync(root)) return out;
  for (const n of readdirSync(root).sort()) {
    if (/^(discord|gmail)-cache.*\.json$/.test(n)) {
      const conv = obj(obj(readJson(join(root, n))).conversations);
      out[`${n}: conversations`] = Object.keys(conv).length;
      out[`${n}: messages`] = Object.values(conv).reduce((k: number, c) => k + ((obj(c).messages as unknown[] | undefined)?.length ?? 0), 0);
    }
    if (/^whatsapp-/.test(n) && existsSync(join(root, n, "chats.json"))) out[`${n}: chats`] = Object.keys(obj(obj(readJson(join(root, n, "chats.json"))).chats)).length;
  }
  for (const sub of ["images", "avatars"]) out[`${sub} files`] = existsSync(join(root, sub)) ? readdirSync(join(root, sub)).length : 0;
  return out;
}

const before = counts(FROM);
const after = DRY ? before : counts(TO);
console.log(`Person Hub → Hub Persons ${DRY ? "(dry run: nothing written)" : ""}`);
console.log(`  from ${FROM}\n  and  ${PROFILE} (Discord logins)\n  to   ${TO}`);
console.log(`  files copied ${report.copied}, already the same ${report.same}, backed up first ${report.backedUp}, ${(report.bytes / 1048576).toFixed(1)} MB`);
if (!SESSIONS) console.log("  WhatsApp's linked device NOT copied (run with --sessions at the cutover, Person Hub stopped)");
for (const k of report.kept) console.log(`  kept: changed in Hub since the last import: ${k} (--force overwrites, after a backup)`);
let bad = 0;
console.log("\n  count                                          Person Hub      Hub");
for (const k of Object.keys(before)) {
  const a = before[k] ?? 0;
  const b = after[k] ?? 0;
  const src = k.includes(": ") ? k.split(": ")[0]! : k.endsWith(" files") ? k.slice(0, -6) : k === "connections" ? "connections.json" : "data.json";
  const keptFile = report.kept.some((x) => x === src || x.startsWith(`${src}/`));
  // pictures: Hub adds its own to the cache, so the copy may have more
  const grows = k.endsWith(" files");
  const mark = a === b || (grows && b >= a) ? "ok" : keptFile ? "kept" : "DIFFERENT";
  if (mark === "DIFFERENT") bad++;
  console.log(`  ${k.padEnd(46)} ${String(a).padStart(9)} ${String(b).padStart(9)}  ${mark}`);
}
if (bad) {
  console.error(`\n${bad} count(s) differ: the import is not complete.`);
  process.exit(1);
}
console.log("\nAll counts match. Person Hub's own files were only read.");
