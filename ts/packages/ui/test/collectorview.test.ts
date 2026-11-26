import { describe, expect, it } from "bun:test";
import { approveToOf, formOf, leadsOf, nextLead, podium, reachState, runLine, type CollectorView, type Row } from "../src/tabs/collector/ui.ts";
import type { DetailView } from "../../../tabs/collector/view.ts";
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
  it("Approved leads leave Available and the run's list for their own view; the filter works there too", () => {
    const creators = [row("c", { approved: true, email: "c@x.com" }), row("b", { restricted: true }), row("a")];
    const v = view({ creators, run: run({ ids: ["a", "b", "c"] }) });
    expect(leadsOf(v, "available", "").rows.map((r) => r.id)).toEqual(["a"]);
    expect(leadsOf(v, "collector", "").rows.map((r) => r.id)).toEqual(["a"]);
    expect(leadsOf(v, "approved", "").rows.map((r) => r.id)).toEqual(["c"]);
    expect(leadsOf(v, "approved", "x.com").rows.map((r) => r.id)).toEqual(["c"]);
    expect(leadsOf(v, "restricted", "").rows.map((r) => r.id)).toEqual(["b"]);
    expect(leadsOf(view(), "approved", "").emptyTitle).toBe("Nobody approved");
  });
});

describe("collector review bar", () => {
  it("goes on to the next lead of the list it was opened from that is still in it; null at the end", () => {
    const q = ["a", "b", "c", "d"];
    // Skip: the lead stays; the next is the one after it.
    expect(nextLead(q, "a", q)).toBe("b");
    // Reject / Approve: the lead left the list; the next is still the one after it.
    expect(nextLead(q, "b", ["a", "c", "d"])).toBe("c");
    // One after it left meanwhile (another device): passed over.
    expect(nextLead(q, "b", ["a", "d"])).toBe("d");
    expect(nextLead(q, "d", q)).toBeNull();
    expect(nextLead(q, "c", ["a", "b", "c"])).toBeNull();
    expect(nextLead(q, "zz", q)).toBeNull();
    expect(nextLead([], "a", ["a"])).toBeNull();
  });
  it("Approve to: the picked choice, else the first", () => {
    const choices = [
      { value: "list", label: "Approved list only", tip: "" },
      { value: "persons", label: "Persons › Creators", tip: "" },
    ];
    const v = view({ approveTo: choices });
    expect(approveToOf(v)).toEqual({ value: "list", label: "Approved list only" });
    v.settings.approveTo = "persons";
    expect(approveToOf(v)).toEqual({ value: "persons", label: "Persons › Creators" });
    v.settings.approveTo = "bogus";
    expect(approveToOf(v).value).toBe("list");
  });
});

describe("collector lead detail", () => {
  it("lays the newest videos out as the CRM's podium: #2, #1 (featured), #3; missing ones leave their place", () => {
    expect(podium(["a", "b", "c"])).toEqual([{ v: "b", featured: false }, { v: "a", featured: true }, { v: "c", featured: false }]);
    expect(podium(["a"])).toEqual([{ v: null, featured: false }, { v: "a", featured: true }, { v: null, featured: false }]);
    expect(podium([])).toEqual([]);
  });
  it("Reach: Save only for a valid, changed value; WhatsApp and Discord say what to type", () => {
    const d = { reach: "email", reachValue: "a@b.co" } as DetailView;
    expect(reachState(d, "email", "a@b.co")).toMatchObject({ error: "", canSave: false });
    expect(reachState(d, "email", "x@y.com").canSave).toBe(true);
    expect(reachState(d, "email", "nope")).toMatchObject({ error: "That isn't an email address.", canSave: false });
    expect(reachState(d, "whatsapp", "").help).toContain("Country code first");
    expect(reachState(d, "discord", "").hint).toBe("Discord user ID (17-20 digits)");
  });
});
