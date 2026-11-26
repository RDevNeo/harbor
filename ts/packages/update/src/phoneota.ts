// Hub's phone app, over the air (android/README.md "Shell and code", HUB.md "Updates").
//
// The Android app is a shell that runs downloaded app code (harbor-phone-code.zip). Harbor's phones took it from
// Harbor's GitHub releases; Hub's take it from their own PC: every Hub PC that follows `hub` (followmain.ts) builds
// the phone's code when a commit changes it (android/, the fonts and logos), signs it with Hub's own code key
// (minisign format, the shell's Minisign.HUB_PUBKEY) and serves it to its paired phones under /phone/ (api.ts):
//
//   phone/hub-app.json(.minisig)           what's on offer: {release, commit, at, apk: {code, release, shell}, phone: {code, release, minShell}}
//   phone/harbor-phone-code.zip(.minisig)  the app's code alone: phones on Android 9+ run it without installing anything
//   phone/harbor-android.apk(.minisig)     the whole app (signed with Hub's APK keystore): only for a new shell, or Android 8
//
// A phone holds `GET /phone/wait?have=CODE` while a Hub screen is up, so new code reaches it seconds after it's
// served, and goes in live (Swap). Version numbers: the commit's time in seconds (it only grows along `hub`), the
// same for the APK's versionCode and its built-in code, so they compare as one; the name a person reads is the
// desktop's (`0.194.0+abc1234`). The builds run on boat.dev (scripts/boat/android), never on the PC.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { blake2b, blake2bFile } from "./minisign.ts";
import { ensureDir, isFile, read, readJson, remove, writeAtomic } from "./files.ts";

export const PHONE_DIR = "phone";
export const MANIFEST = "hub-app.json";
export const CODE_ZIP = "harbor-phone-code.zip";
export const APK = "harbor-android.apk";
export const FILES = [MANIFEST, CODE_ZIP, APK] as const;

export interface PhoneManifest {
  release: string;
  commit: string;
  at: number;
  apk?: { code: number; release: string; shell: number };
  phone: { code: number; release: string; minShell: number };
}

/** What changes the phone's app (its code or its shell): the rest of a commit builds nothing for phones. */
export function phoneShips(path: string): boolean {
  if (path.startsWith("android/")) return !/^android\/(test|rigcaller)\//.test(path) && !/\.md$/i.test(path);
  return /^assets\/(fonts|logos)\//.test(path) || path === "ts/package.json";
}

// ---- Hub's code key (minisign's format) ----

export interface CodeKey {
  /** minisign's public key line ("RW…"), as the shell carries it. */
  pub: string;
  id: Uint8Array;
  sk: ReturnType<typeof createPrivateKey>;
}

/** Hub's code key: in HUB_CODE_KEY's file, else ~/.local/share/hub-android/hub-code.key (made once, 0600). */
export function codeKeyFile(env: Record<string, string | undefined> = process.env): string {
  return env.HUB_CODE_KEY || join(homedir(), ".local", "share", "hub-android", "hub-code.key");
}

export function publicLine(id: Uint8Array, raw: Uint8Array): string {
  return Buffer.concat([Buffer.from("Ed"), Buffer.from(id), Buffer.from(raw)]).toString("base64");
}

export function loadCodeKey(file: string, make = false): CodeKey | null {
  if (!isFile(file)) {
    if (!make) return null;
    const { privateKey } = generateKeyPairSync("ed25519");
    const id = randomBytes(8);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ id: id.toString("base64"), pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") });
    writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  const j = JSON.parse(read(file)) as { id: string; pkcs8: string };
  const sk = createPrivateKey({ key: Buffer.from(j.pkcs8, "base64"), format: "der", type: "pkcs8" });
  const id = new Uint8Array(Buffer.from(j.id, "base64"));
  const jwk = createPublicKey(sk).export({ format: "jwk" }) as { x: string };
  return { pub: publicLine(id, new Uint8Array(Buffer.from(jwk.x, "base64url"))), id, sk };
}

/** A prehashed minisign signature (BLAKE2b-512, Ed25519) of `digest`, with its trusted comment. */
export function signDigest(key: CodeKey, digest: Uint8Array, trusted: string): string {
  const sig = edSign(null, Buffer.from(digest), key.sk);
  const global = edSign(null, Buffer.concat([sig, Buffer.from(trusted, "utf8")]), key.sk);
  const line = Buffer.concat([Buffer.from("ED"), Buffer.from(key.id), sig]).toString("base64");
  return `untrusted comment: signature from Hub's code key\n${line}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
}

export const signBytes = (key: CodeKey, data: Uint8Array, trusted: string): string => signDigest(key, blake2b(data), trusted);

export const signFile = async (key: CodeKey, file: string, trusted: string): Promise<string> => signDigest(key, await blake2bFile(file), trusted);

/** The trusted comment the shell checks (Minisign.signedFor: "v<release> " in it, the file's name at its end). */
export const trustedFor = (release: string, name: string): string => `hub v${release} ${name}`;

// ---- numbers and names ----

/** The phone's version number for a commit: its committer time in seconds (only grows along `hub`). */
export const codeOf = (commitTime: number): number => Math.floor(commitTime);

/** android/shell/shell.lock's version. */
export function shellOf(lock: string): number {
  const m = /^version=(\d+)\s*$/m.exec(lock);
  return m === null ? 0 : Number(m[1]);
}

// ---- serving ----

/** The folder phones are served from: `<install>/phone`. */
export const servedDir = (installDir: string): string => join(installDir, PHONE_DIR);

export function served(installDir: string): PhoneManifest | null {
  const m = readJson<PhoneManifest>(join(servedDir(installDir), MANIFEST));
  return m !== null && typeof m.phone?.code === "number" ? m : null;
}

/**
 * Puts a signed build in place for phones: the files first, the manifest last (a phone that reads it finds them
 * all). `files` maps the served names to the built files; each gets its `.minisig`.
 */
export async function publish(installDir: string, key: CodeKey, m: PhoneManifest, files: Partial<Record<typeof CODE_ZIP | typeof APK, string>>): Promise<void> {
  const dir = servedDir(installDir);
  ensureDir(dir);
  for (const [name, from] of Object.entries(files) as [string, string][]) {
    const sig = await signFile(key, from, trustedFor(m.release, name));
    copyFileSync(from, join(dir, `.${name}.new`));
    writeAtomic(join(dir, `.${name}.minisig.new`), sig);
    renameSync(join(dir, `.${name}.new`), join(dir, name));
    renameSync(join(dir, `.${name}.minisig.new`), join(dir, `${name}.minisig`));
  }
  const body = `${JSON.stringify(m, null, 2)}\n`;
  writeAtomic(join(dir, `${MANIFEST}.minisig`), signBytes(key, new TextEncoder().encode(body), trustedFor(m.release, MANIFEST)));
  writeAtomic(join(dir, MANIFEST), body);
  // The whole app at /app.apk too (the install QR's link), with its version (hub.ts apkInfo).
  if (files[APK] !== undefined && m.apk !== undefined) {
    copyFileSync(files[APK], join(installDir, ".harbor-android.apk.new"));
    renameSync(join(installDir, ".harbor-android.apk.new"), join(installDir, APK));
    writeAtomic(join(installDir, "harbor-android.version"), String(m.apk.code));
  }
}

/** A served file's path, or null (only the names in FILES and their signatures). */
export function servedFile(installDir: string, name: string): string | null {
  const ok = FILES.some((f) => name === f || name === `${f}.minisig`);
  if (!ok) return null;
  const p = join(servedDir(installDir), name);
  return isFile(p) ? p : null;
}

/** What a phone compares with what it runs: the newest number on offer (code or APK). */
export function offerCode(m: PhoneManifest | null): number {
  if (m === null) return 0;
  return Math.max(m.phone.code, m.apk?.code ?? 0);
}

/**
 * `GET /phone/wait?have=N&wait=S`: answers as soon as the PC offers something other than `have` (the manifest's
 * newest number), else null after `waitMs`. One stat a second per waiting phone.
 */
export async function waitOffer(installDir: string, have: number, waitMs: number, signal?: AbortSignal): Promise<PhoneManifest | null> {
  const until = Date.now() + Math.max(0, Math.min(waitMs, 240_000));
  const file = join(servedDir(installDir), MANIFEST);
  let seen = -1;
  for (;;) {
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime !== seen) {
      seen = mtime;
      const m = served(installDir);
      if (m !== null && offerCode(m) !== have) return m;
    }
    if (Date.now() >= until || signal?.aborted) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---- building (on the PC that follows `hub`) ----

export type Run = (cmd: string[], o: { cwd: string; env?: Record<string, string>; timeoutMs: number; log?: string; nice?: boolean }) => Promise<{ code: number; out: string }>;

export interface PhoneBuildDeps {
  installDir: string;
  /** follow-main's folder: the phone's worktree, outputs, log and memory go in `phone/`. */
  home: string;
  run: Run;
  log: (m: string) => void;
  /** Hub's APK keystore (android/build.sh's variables): without it only the code is served. */
  keystore?: { file: string; pass: string; alias: string } | null;
  /** apksigner's path (an SDK's build-tools), null: none. */
  apksigner?: string | null;
  keyFile?: string;
  /** The phone build (scripts/boat/android): replaced in tests. */
  build?: (worktree: string, out: string, log: string) => Promise<boolean>;
  changed?: () => void;
}

interface PhoneMemory {
  /** The last tip looked at, and the last that failed to build (not tried again until `hub` moves). */
  looked?: string;
  failed?: string;
  why?: string;
}

/** Finds apksigner in an Android SDK's newest build-tools (ANDROID_HOME, ANDROID_SDK_ROOT, ~/Android/Sdk). */
export function findApksigner(env: Record<string, string | undefined> = process.env): string | null {
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(homedir(), "Android", "Sdk")]) {
    if (!sdk) continue;
    const bt = join(sdk, "build-tools");
    if (!existsSync(bt)) continue;
    const vs = readdirSync(bt).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of vs) if (isFile(join(bt, v, "apksigner"))) return join(bt, v, "apksigner");
  }
  return null;
}

/** Hub's APK keystore, as android/build.sh's variables name it (ANDROID_KEYSTORE…), else Hub's default place. */
export function findKeystore(env: Record<string, string | undefined> = process.env): { file: string; pass: string; alias: string } | null {
  const file = env.ANDROID_KEYSTORE || join(homedir(), ".local", "share", "hub-android", "hub-android.jks");
  if (!isFile(file)) return null;
  const passFile = file.replace(/\.jks$/, ".pass");
  return { file, pass: env.ANDROID_KEYSTORE_PASS ? "env:ANDROID_KEYSTORE_PASS" : `file:${passFile}`, alias: env.ANDROID_KEY_ALIAS || "hub" };
}

export class PhoneBuilds {
  private job: Promise<void> | null = null;
  private next: { src: string; tip: string } | null = null;
  private readonly dir: string;

  constructor(private readonly d: PhoneBuildDeps) {
    this.dir = join(d.home, "phone");
  }

  private memory(): PhoneMemory {
    return readJson<PhoneMemory>(join(this.dir, "state.json")) ?? {};
  }

  private remember(m: PhoneMemory): void {
    ensureDir(this.dir);
    writeAtomic(join(this.dir, "state.json"), JSON.stringify({ ...this.memory(), ...m }));
  }

  status(): string {
    const m = served(this.d.installDir);
    const mem = this.memory();
    const on = m === null ? "no phone code served yet" : `phones get ${m.release} (code ${m.phone.code}, shell ${m.phone.minShell}${m.apk ? `, APK ${m.apk.code}` : ""})`;
    return mem.failed ? `${on}; ${mem.failed.slice(0, 7)} didn't build: ${mem.why ?? "?"}` : on;
  }

  /** follow-main looked at `tip` (in its clone `src`): a phone build when it changed the phone's app. */
  seen(src: string, tip: string): void {
    this.next = { src, tip };
    if (this.job !== null) return;
    this.job = (async () => {
      while (this.next !== null) {
        const n = this.next;
        this.next = null;
        try {
          await this.look(n.src, n.tip);
        } catch (e) {
          this.d.log(`phone: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })().finally(() => {
      this.job = null;
    });
  }

  /** Waits for the build going on (tests). */
  idle(): Promise<void> {
    return this.job ?? Promise.resolve();
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const r = await this.d.run(["git", "-C", cwd, ...args], { cwd, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.split("\n").pop()}`);
    return r.out;
  }

  async look(src: string, tip: string): Promise<void> {
    const mem = this.memory();
    const now = served(this.d.installDir);
    if (now?.commit === tip || mem.failed === tip || mem.looked === tip) return;
    if (now !== null && now.commit !== "") {
      const changed = await this.git(src, ["diff", "--name-only", now.commit, tip]).then(
        (o) => o.split("\n").filter(Boolean),
        () => null,
      );
      // Only forward: a tip older than what's served (its number would be lower) builds nothing.
      const ahead = await this.d.run(["git", "-C", src, "merge-base", "--is-ancestor", now.commit, tip], { cwd: src, timeoutMs: 60_000 }).then((r) => r.code === 0);
      if (changed !== null && (!ahead || !changed.some(phoneShips))) {
        this.remember({ looked: tip });
        return;
      }
    }
    const key = loadCodeKey(this.d.keyFile ?? codeKeyFile(), false);
    if (key === null) {
      this.remember({ looked: tip, failed: tip, why: `no code key at ${this.d.keyFile ?? codeKeyFile()} (packaging/hub-phone-key.sh makes it)` });
      return;
    }
    const committed = Number(await this.git(src, ["log", "-1", "--format=%ct", tip]));
    const pkg = (JSON.parse(await this.git(src, ["show", `${tip}:ts/package.json`])) as { version?: string }).version ?? "0.0.0";
    const shell = shellOf(await this.git(src, ["show", `${tip}:android/shell/shell.lock`]).catch(() => ""));
    const code = codeOf(committed);
    const release = `${pkg}+${tip.slice(0, 7)}`;
    const wt = join(this.dir, "src");
    const out = join(this.dir, "out");
    const log = join(this.dir, "build.log");
    ensureDir(this.dir);
    writeAtomic(log, `phone: building ${release} (code ${code}, shell ${shell})\n`);
    this.d.log(`phone: building ${release} on boat (code ${code}, shell ${shell})`);
    if (!isFile(join(wt, ".git"))) {
      remove(wt);
      await this.git(src, ["worktree", "prune"]).catch(() => "");
      await this.git(src, ["worktree", "add", "--force", "--detach", wt, tip]);
    } else {
      await this.git(wt, ["checkout", "--quiet", "--force", "--detach", tip]);
      await this.git(wt, ["clean", "-fdq"]);
    }
    // android/build.sh numbers the code and the APK from this (the sandbox has no .git to ask).
    mkdirSync(join(wt, "android"), { recursive: true });
    writeFileSync(join(wt, "android", "hub-code.env"), `HUB_CODE=${code}\nHUB_CODE_NAME=${release}\n`);
    remove(out);
    mkdirSync(out, { recursive: true });
    const ok = this.d.build ? await this.d.build(wt, out, log) : (await this.d.run(["bash", "scripts/boat/android", "--out", out, "--quiet"], { cwd: wt, timeoutMs: 45 * 60_000, log, nice: true })).code === 0;
    const zip = join(out, "hub-phone-code.zip");
    if (!ok || !isFile(zip)) {
      this.remember({ looked: tip, failed: tip, why: `the boat build failed (${log})` });
      this.d.log(`phone: ${release} didn't build (${log})`);
      return;
    }
    const files: Partial<Record<typeof CODE_ZIP | typeof APK, string>> = { [CODE_ZIP]: zip };
    const m: PhoneManifest = { release, commit: tip, at: Math.floor(Date.now() / 1000), phone: { code, release, minShell: shell } };
    const unsigned = join(out, "harbor-android-unsigned.apk");
    const ks = this.d.keystore === undefined ? findKeystore() : this.d.keystore;
    const signer = this.d.apksigner === undefined ? findApksigner() : this.d.apksigner;
    if (isFile(unsigned) && ks !== null && signer !== null) {
      const apk = join(out, APK);
      const r = await this.d.run([signer, "sign", "--ks", ks.file, "--ks-pass", ks.pass, "--ks-key-alias", ks.alias, "--out", apk, unsigned], { cwd: out, timeoutMs: 5 * 60_000, log });
      if (r.code === 0 && isFile(apk)) {
        files[APK] = apk;
        m.apk = { code, release, shell };
      } else this.d.log(`phone: the APK of ${release} wasn't signed (${log}): code only`);
    } else if (now?.apk !== undefined) {
      // No keystore here: the APK on offer stays the last one signed (phones on its shell or newer still take the code).
      m.apk = now.apk;
    }
    await publish(this.d.installDir, key, m, files);
    this.remember({ looked: tip, failed: "", why: "" });
    this.d.log(`phone: serving ${release} (code ${code}, shell ${shell}${files[APK] ? ", APK too" : ""})`);
    this.d.changed?.();
  }
}

/** Makes the code key if there's none (packaging/hub-phone-key.sh): its public line, for the shell. */
export function ensureCodeKey(file = codeKeyFile()): string {
  const k = loadCodeKey(file, true) as CodeKey;
  try {
    chmodSync(file, 0o600);
  } catch {
    // another filesystem: its own rules
  }
  return k.pub;
}
