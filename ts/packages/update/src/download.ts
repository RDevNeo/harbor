import { join } from "node:path";
import { assetUrl, publicKey, type UpdateConfig } from "./config.ts";
import { verifyAsset } from "./minisign.ts";
import { read } from "./files.ts";

const TRIES = 3;
const TIMEOUT_MS = 15 * 60 * 1000;

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export async function download(cfg: UpdateConfig, release: string, name: string, to: string): Promise<void> {
  const url = assetUrl(cfg, release, name);
  let last = new DownloadError(`download failed: ${name}`, null);
  for (let i = 0; i < TRIES; i++) {
    if (i > 0) await cfg.sleep(1000 * i);
    try {
      const res = await cfg.fetch(url, { headers: { "user-agent": `harbor/${cfg.version}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        await Bun.write(to, res);
        return;
      }
      last = new DownloadError(`download failed: ${name} (HTTP ${res.status})`, res.status);
      if (res.status < 500) break;
    } catch (e) {
      last = new DownloadError(`download failed: ${name} (${e instanceof Error ? e.message : String(e)})`, null);
    }
  }
  throw last;
}

export async function fetchSigned(cfg: UpdateConfig, release: string, name: string, stage: string): Promise<string> {
  const file = join(stage, name);
  const sig = join(stage, `${name}.minisig`);
  await download(cfg, release, name, file);
  await download(cfg, release, `${name}.minisig`, sig);
  await verifyAsset(await publicKey(cfg), file, read(sig) + "\n", release, name);
  return file;
}
