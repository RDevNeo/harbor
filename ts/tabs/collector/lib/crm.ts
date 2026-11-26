// The SpokPay CRM's creators, read-only, as Collector leads. The CRM is a Convex app (spokpay-crm, production deployment
// combative-wildcat-45); its board's two queries are public: creators:listCreatorStatuses (the columns) and
// creators:listCreators (every card, convex/fieldRegistry.ts creatorEntity.dto). Called over Convex's HTTP query API: no
// CLI, no sign-in, nothing written. Their recent videos sit behind a member sign-in (creatorVideos:getRecentVideos), so
// Collector reads them itself (Collector.fill).
import { isReachKind, normalizeReach, reachError } from "./reach.ts";
import type { CreatorLink, CreatorRecord } from "./types.ts";

export const CRM_URL = "https://combative-wildcat-45.convex.cloud";

export interface CrmStatus {
  id: string;
  name: string;
}

/** One card of the CRM's creator board (the fields Collector keeps). */
export interface CrmCreator {
  id: string;
  platform: string;
  platform_id: string;
  name: string;
  handle: string | null;
  profile_url: string | null;
  avatar_url: string | null;
  subscriber_count: number | null;
  video_count: number | null;
  view_count: number | null;
  description: string | null;
  links: { label: string | null; url: string }[] | null;
  country: string | null;
  discovered_via: string | null;
  captured_at: string | null;
  updated_at: string | null;
  status_id: string | null;
  reach_kind: string | null;
  reach_value: string | null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function query<T>(fetch: Fetch, base: string, path: string): Promise<T> {
  const r = await fetch(`${base}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: {}, format: "json" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`the CRM answered ${r.status} to ${path}`);
  const j = (await r.json()) as { status?: string; value?: T; errorMessage?: string };
  if (j.status !== "success") throw new Error(`the CRM refused ${path}: ${j.errorMessage ?? j.status}`);
  return j.value as T;
}

/** The CRM's creators whose status (column) is named `status` ("Has Contact"), read-only. */
export async function crmCreators(fetch: Fetch, status: string, base = CRM_URL): Promise<CrmCreator[]> {
  const statuses = await query<CrmStatus[]>(fetch, base, "creators:listCreatorStatuses");
  const want = status.trim().toLowerCase();
  const ids = new Set(statuses.filter((s) => s.name.trim().toLowerCase() === want).map((s) => s.id));
  if (!ids.size) throw new Error(`the CRM has no “${status}” status`);
  const all = await query<CrmCreator[]>(fetch, base, "creators:listCreators");
  return all.filter((c) => c.status_id && ids.has(c.status_id) && c.platform && c.platform_id);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A CRM card as a Collector lead: the detail's fields, its Reach (typed by an operator: kept as typed), where it came from. */
export function crmRecord(c: CrmCreator, status: string, now = new Date().toISOString()): CreatorRecord {
  const links: CreatorLink[] = (c.links ?? []).filter((l) => l && typeof l.url === "string" && l.url.trim()).map((l) => ({ label: l.label && l.label !== l.url ? l.label : null, url: l.url.trim(), source: "SpokPay CRM" }));
  const handle = str(c.handle);
  const rec: CreatorRecord = {
    platform: c.platform.toLowerCase(),
    platform_id: c.platform_id.trim(),
    name: str(c.name) ?? handle ?? c.platform_id,
    handle: handle ? (handle.startsWith("@") ? handle : `@${handle}`) : null,
    profile_url: str(c.profile_url),
    avatar_url: str(c.avatar_url),
    subscriber_count: num(c.subscriber_count),
    video_count: num(c.video_count),
    view_count: num(c.view_count),
    description: str(c.description),
    links,
    country: str(c.country),
    discovered_via: str(c.discovered_via) ?? "",
    captured_at: str(c.captured_at) ?? now,
    updated_at: str(c.updated_at) ?? now,
    imported_from: `SpokPay CRM · ${status}`,
  };
  const kind = c.reach_kind;
  const value = str(c.reach_value);
  if (isReachKind(kind) && value) {
    const v = reachError(kind, value) ? value : normalizeReach(kind, value);
    rec.reach = { kind, value: v };
    if (kind === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
      rec.email = v.toLowerCase();
      rec.email_source = "SpokPay CRM";
      rec.email_manual = true;
    }
    if (kind === "whatsapp") {
      rec.whatsapp = v.replace(/\D/g, "");
      rec.whatsapp_manual = true;
    }
  }
  return rec;
}
