import { describe, expect, it } from "bun:test";
import { clock, dailyOf, formOf, runOf, type CollectorView } from "../src/tabs/collector/ui.ts";
import { GAP_CHOICES, defaultSettings } from "../../../tabs/collector/lib/types.ts";

const view = (over: Partial<CollectorView> = {}): CollectorView => ({
  rev: 1,
  settings: defaultSettings(),
  sources: [
    { value: "instagram", label: "Instagram", available: false, why: "Instagram's search only answers a signed-in account.", note: "" },
    { value: "tiktok", label: "TikTok", available: true, why: "", note: "Suggestions" },
    { value: "youtube", label: "YouTube", available: true, why: "", note: "Search" },
  ],
  sessions: [{ platform: "instagram", label: "Instagram", connected: false, account: null, savedAt: 0, help: "paste" }],
  canSend: false,
  gaps: GAP_CHOICES,
  run: null,
  refresh: { running: false, done: 0, total: 0, changed: 0, failed: 0, status: "", due: 0, daily: true, last: "", next: "", lastFullAt: 0 },
  log: [],
  counts: { creators: 0, emails: 0, contacted: 0, remembered: 0 },
  creators: [],
  ...over,
});

describe("collector window", () => {
  it("names why a source can't run, and asks for Instagram's session", () => {
    expect(formOf(view()).unavailable).toBe("");
    const v = view();
    v.settings.platform = "instagram";
    expect(formOf(v)).toMatchObject({ unavailable: "Instagram's search only answers a signed-in account.", session: true });
  });
  it("shows the run with what was passed over", () => {
    const run = { running: true, label: "YouTube", platform: "youtube", query: "blox", status: "Running…", found: 6, target: 50, considered: 8, dropped: 2, known: 3, elapsed: 83 };
    expect(runOf(view({ run }))).toEqual({ title: "YouTube · “blox”", status: "6 of 50 new creators", clock: "1:23", frac: 0.12, meta: "8 checked · 2 dropped · 3 already known" });
    expect(clock(5)).toBe("0:05");
  });
  it("says where the daily update is", () => {
    const v = view();
    v.refresh = { ...v.refresh, running: true, done: 3, total: 12, changed: 1, status: "Updating Kauã…" };
    expect(dailyOf(v)).toEqual({ status: "Updating Kauã…", meta: "3 of 12 read · 1 changed", frac: 0.25 });
    v.refresh = { ...v.refresh, running: false, last: "3 h ago", next: "in 21 h", due: 0, status: "Updated 12 creator(s): 1 changed." };
    expect(dailyOf(v).meta).toBe("Last full update 3 h ago · next in 21 h");
  });
});
