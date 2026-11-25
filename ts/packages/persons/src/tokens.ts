// Where Persons keeps Discord logins: the desktop's keyring (Secret Service: GNOME Keyring / KWallet) when there is
// one, encrypted by the user's login; otherwise a file sealed with AES-256-GCM (<persons>/discord/tokens.sealed, key
// in <persons>/discord/.tokens.key, both 0600). A token is only ever handed to the Discord connection: never logged,
// never printed, never sent anywhere but Discord.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secretService } from "@harbor/os";

const SERVICE = "hub-persons-discord";

export interface TokenStore {
  /** "keyring" or "sealed file". */
  readonly where: string;
  get(connId: string): string | null;
  set(connId: string, token: string): void;
  remove(connId: string): void;
}

/** HUB_PERSONS_TOKENS=file forces the sealed file (tests, the screenshot rig). */
export function tokenStore(dir: string, env: NodeJS.ProcessEnv = process.env): TokenStore {
  const forceFile = env.HUB_PERSONS_TOKENS === "file" || env.HARBOR_PERSONS_TOKENS === "file";
  if (!forceFile && secretService.available(env)) return keyringStore(dir);
  return sealedStore(join(dir, "discord"));
}

function keyringStore(dir: string): TokenStore {
  // one Hub data folder per keyring entry set, so a copy of the data (another Hub, a rig) never shares logins
  const attrs = (id: string): Record<string, string> => ({ service: SERVICE, folder: dir, account: id });
  return {
    where: "keyring",
    get: (id) => secretService.read(attrs(id)),
    set: (id, token) => {
      if (!secretService.write(`Hub Persons: Discord (${id})`, attrs(id), token)) throw new Error("The keyring didn't take the Discord login");
    },
    remove: (id) => void secretService.remove(attrs(id)),
  };
}

function sealedStore(d: string): TokenStore {
  const file = join(d, "tokens.sealed");
  const keyFile = join(d, ".tokens.key");
  const key = (): Buffer => {
    if (existsSync(keyFile)) {
      const k = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
      if (k.length === 32) return k;
    }
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const k = randomBytes(32);
    writeFileSync(keyFile, k.toString("base64"), { mode: 0o600 });
    return k;
  };
  const readAll = (): Record<string, string> => {
    if (!existsSync(file)) return {};
    try {
      const raw = Buffer.from(readFileSync(file, "utf8"), "base64");
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const dec = createDecipheriv("aes-256-gcm", key(), iv);
      dec.setAuthTag(tag);
      return JSON.parse(Buffer.concat([dec.update(raw.subarray(28)), dec.final()]).toString("utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const writeAll = (all: Record<string, string>): void => {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    if (!Object.keys(all).length) {
      rmSync(file, { force: true });
      return;
    }
    const iv = randomBytes(12);
    const enc = createCipheriv("aes-256-gcm", key(), iv);
    const body = Buffer.concat([enc.update(JSON.stringify(all), "utf8"), enc.final()]);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, Buffer.concat([iv, enc.getAuthTag(), body]).toString("base64"), { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    where: "sealed file",
    get: (id) => readAll()[id] ?? null,
    set: (id, token) => writeAll({ ...readAll(), [id]: token }),
    remove: (id) => {
      const all = readAll();
      if (!(id in all)) return;
      delete all[id];
      writeAll(all);
    },
  };
}
