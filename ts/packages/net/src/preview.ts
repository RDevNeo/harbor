import { writeFileSync } from "node:fs";
import { http, httpRaw, jsonBody } from "./client.ts";
import { urlEncode } from "./http.ts";
import { dest, type Dest, type Peer, type Shared } from "./shared.ts";
import type { Json } from "./wire.ts";

/** A live preview on offer (update's preview.ts `Offer`), as it travels between PCs. */
export interface PreviewOffer {
  id: string;
  sha256: string;
  note: string;
  kind: string;
}

/** The sender of a preview may be restarting into it itself: it gets this long to come back. */
export const PREVIEW_FETCH_MS = 45_000;

/** An offer from a `POST /mesh/v1/preview` body; null when it isn't one. */
export function previewOffer(v: unknown): PreviewOffer | null {
  if (typeof v !== "object" || v === null) return null;
  const s = (k: string): string | null => {
    const x: unknown = Reflect.get(v, k);
    return typeof x === "string" ? x : null;
  };
  const id = s("id");
  const sha256 = s("sha256");
  if (id === null || id === "" || sha256 === null) return null;
  return { id, sha256, note: s("note") ?? "", kind: s("kind") ?? "" };
}

/** Whether a peer's `update` says it takes previews (preview.rs `takes`). */
export function takesPreviews(update: unknown): boolean {
  return typeof update === "object" && update !== null && Reflect.get(update, "preview_on") === true && Reflect.get(update, "preview_kind") === "bundle";
}

/** Tells the PCs that take previews what this one has (mesh.rs `announce_preview`). Short: Harbor may be about to restart. */
export async function announcePreview(shared: Shared, offer: PreviewOffer, send: typeof http = http): Promise<string[]> {
  const peers = [...shared.peers.values()].filter((p: Peer) => p.online && takesPreviews(p.update));
  const body: Json = { id: offer.id, sha256: offer.sha256, note: offer.note, kind: offer.kind };
  const out = await Promise.all(
    peers.map(async (p) => {
      try {
        const [status, reply] = await send(dest(p), "POST", "/mesh/v1/preview", jsonBody(body), 2_000);
        if (status !== 200) throw new Error(typeof reply === "object" && reply !== null ? String(Reflect.get(reply, "error") ?? status) : String(status));
        return p.name;
      } catch (e) {
        console.error(`harbor: preview not offered to ${p.addr}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }),
  );
  return out.filter((n): n is string => n !== null);
}

/** One of the files of a preview `from` offers, into `to`, asked again until it comes or the sender's time is up. */
export async function fetchPreviewFile(from: Dest, offerId: string, kind: string, to: string, deps: { raw?: typeof httpRaw; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const raw = deps.raw ?? httpRaw;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  const path = `/mesh/v1/preview/file?kind=${urlEncode(kind)}&id=${urlEncode(offerId)}`;
  for (;;) {
    try {
      const a = await raw(from, "GET", path, null, 120_000);
      if (a.status !== 200) throw new Error(`${a.status}: ${new TextDecoder().decode(a.body).slice(0, 200)}`);
      writeFileSync(to, a.body);
      return;
    } catch (e) {
      if (now() - start > PREVIEW_FETCH_MS) throw e;
      await sleep(500);
    }
  }
}
