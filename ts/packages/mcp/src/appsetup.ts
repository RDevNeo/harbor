// What Hub's own background apps (WhatsApp's host and engine) need from the rest of Hub, wired by `serve.ts`
// (`configure`): the command that runs Hub itself, its version, the commit its engine files go with, and the
// installed bundle; plus their downloads, checksums and the one-host lock.
import { createHash } from "node:crypto";
import { createReadStream, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { lock, spawn as osSpawn } from "@harbor/os";
import { message, sleep } from "./discordjson.ts";
import { selfExe } from "./sys.ts";

export interface Ports {
  /** The command that runs Hub itself: `[...selfCommand, "app", "whatsapp-host"]` starts the host. */
  selfCommand(): string[] | undefined;
  version(): string;
  /** The repository ref (commit or release tag) this build was made from; undefined: a build from source. */
  buildRef(): string | undefined;
  /** The installed app bundle this process runs (`harbor-app.js`); undefined: not an installed copy. */
  bundle(): string | undefined;
}

function defaultCommand(): string[] {
  if (process.env.HARBOR_EXE) return [selfExe()];
  return osSpawn.compiled() ? [process.execPath] : [process.execPath, Bun.main];
}

let ports: Ports = { selfCommand: defaultCommand, version: () => "0.0.0", buildRef: () => undefined, bundle: () => undefined };

export function configure(p: Partial<Ports>): void {
  ports = { ...ports, ...p };
}

export const version = (): string => ports.version();
export const selfCommand = (): string[] | undefined => ports.selfCommand();
/** The commit (or tag) this build was made from, if it knows: the WhatsApp engine is fetched at it. */
export const buildRef = (): string | undefined => ports.buildRef();

/** The installed bundle as it is now (its time and size); "" when there's none to watch. An update replaces it. */
export function bundleStamp(): string {
  const b = ports.bundle();
  if (b === undefined) return "";
  try {
    const s = statSync(b);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export async function fileSha256(p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Fetches `url` to `to`, telling how far it got (bytes so far) about every half second. */
export async function download(url: string, to: string, progress: (n: number) => void = () => {}): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const abort = new AbortController();
    const connect = setTimeout(() => abort.abort(), 20_000);
    try {
      const res = await fetch(url, { signal: abort.signal, redirect: "follow" });
      clearTimeout(connect);
      if (!res.ok || res.body === null) {
        last = `HTTP ${res.status}`;
        if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
        await sleep(500);
        continue;
      }
      const file = await open(to, "w");
      let got = 0;
      let reported = 0;
      try {
        for await (const chunk of res.body) {
          await file.write(chunk);
          got += chunk.byteLength;
          if (Date.now() - reported >= 500) {
            reported = Date.now();
            progress(got);
          }
        }
      } finally {
        await file.close();
      }
      progress(got);
      return;
    } catch (e) {
      clearTimeout(connect);
      last = message(e);
      await sleep(500);
    }
  }
  rmSync(to, { force: true });
  throw new Error(`Couldn't download ${url}: ${last}`);
}

/** A host's lock, or undefined when another host holds it for the next two seconds. */
export async function takeLock(path: string): Promise<lock.Held | undefined> {
  const until = Date.now() + 2000;
  for (;;) {
    const got = lock.hold(path, false);
    // undefined: no lock to take here; one host is all there can be then.
    if (got !== null) return got ?? { release() {} };
    if (Date.now() > until) return undefined;
    await sleep(50);
  }
}
