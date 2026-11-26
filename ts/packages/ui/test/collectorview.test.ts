import { describe, expect, it } from "bun:test";
import { formOf, leadsOf, runLine, type CollectorView, type Row } from "../src/tabs/collector/ui.ts";
import { GAP_CHOICES, defaultSettings } from "../../../tabs/collector/lib/types.ts";

const row = (id: string, over: Partial<Row> = {}): Row => ({ id, name: id, handle: `@${id}`, platform: "YouTube", url: `https://y/@${id}`, short: `y/@${id}`, avatarPath: null, email: "", emailSource: "", videos: [], restricted: false, ...over });

const view = (over: Partial<CollectorView> = {}): CollectorView => ({
  rev: 1,
  settings: defaultSettings(),
  sources: [
    { value: "instagram", label: "Instagram", available: false, why: "Instagram's search only answers a signed-in account.", note: "" },
    { value: "tiktok", label: "TikTok", available: true, why: "", note: "Hashtag videos" },
    { value: "youtube", label: "YouTube", available: true, why: "", note: "Search" },
  ],
  sessions: [{ platform: "instagram", label: "Instagram", connected: false, account: null, savedAt: 0, help: "paste" }],
  canSend: false,
  gaps: GAP_CHOICES,
  run: null,
  counts: { available: 0, restricted: 0 },
  creators: [],
  ...over,
});

const run = (over: Partial<NonNullable<CollectorView["run"]>> = {}): NonNullable<CollectorView["run"]> => ({ running: false, label: "YouTube", platform: "youtube", query: "dress to impress", found: 2, target: 5, known: 0, line: "", status: "Done: 2 new leads", ids: [], elapsed: 3, ...over });

describe("collector window", () => {
  it("names why a source can't run, and asks for Instagram's session", () => {
    expect(formOf(view()).unavailable).toBe("");
    const v = view();
    v.settings.platform = "instagram";
    expect(formOf(v)).toMatchObject({ unavailable: "Instagram's search only answers a signed-in account.", session: true });
  });
  it("says the run in one line", () => {
    expect(runLine(view())).toBe("");
    expect(runLine(view({ run: run({ running: true, found: 1, line: "Checking @ana…" }) }))).toBe("1 of 5 · Checking @ana…");
    expect(runLine(view({ run: run({ running: true, target: 0, found: 3 }) }))).toBe("3 found · Searching…");
    expect(runLine(view({ run: run() }))).toBe("Done: 2 new leads");
  });
  it("Collector shows the run's leads, newest first; Available and Restricted split the rest, one filter for both", () => {
    const creators = [row("c", { restricted: true, email: "c@x.com" }), row("b", { platform: "TikTok" }), row("a", { email: "hello@ana.com" })];
    const v = view({ creators, run: run({ ids: ["a", "b", "c"] }) });
    expect(leadsOf(v, "collector", "").rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(leadsOf(v, "collector", "").head).toBe("FOUND FOR “DRESS TO IMPRESS”");
    expect(leadsOf(v, "available", "").rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(leadsOf(v, "available", "tiktok").rows.map((r) => r.id)).toEqual(["b"]);
    expect(leadsOf(v, "available", "ANA.COM").rows.map((r) => r.id)).toEqual(["a"]);
    expect(leadsOf(v, "available", "zzz")).toMatchObject({ rows: [], emptyTitle: "No match" });
    expect(leadsOf(v, "restricted", "").rows.map((r) => r.id)).toEqual(["c"]);
    expect(leadsOf(view(), "restricted", "").emptyTitle).toBe("Nobody restricted");
    expect(leadsOf(view(), "collector", "").emptyTitle).toBe("No search yet");
    expect(leadsOf(view({ run: run({ running: true }) }), "collector", "").emptyTitle).toBe("");
  });
});
