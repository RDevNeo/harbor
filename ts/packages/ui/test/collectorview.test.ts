import { describe, expect, it } from "bun:test";
import { bioLine, destRows, formOf, historyItems, leadsOf, runHead, nextLead, platformCounts, sortRows, sortShort, podium, reachState, runLine, underReview, type CollectorView, type Compose, type Row } from "../src/tabs/collector/ui.ts";
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

const hist = (): NonNullable<CollectorView["history"]> => [
  {
    key: "2026-11-27",
    label: "Today",
    runs: [
      { id: "run-2", time: "09:52", query: "anime", platform: "YouTube", platformKey: "youtube", line: "3 new leads · 7 already collected", note: "", tone: "done", running: false, ids: ["c", "gone", "a", "b"], found: 4 },
      { id: "run-1", time: "08:26", query: "dti", platform: "Instagram", platformKey: "instagram", line: "No new leads", note: "Stopped on an error: HTTP 429", tone: "failed", running: false, ids: [], found: 0 },
    ],
  },
  { key: "2026-11-26", label: "Yesterday", runs: [{ id: "run-0", time: "10:16", query: "old", platform: "TikTok", platformKey: "tiktok", line: "1 new lead", note: "", tone: "done", running: false, ids: ["gone"], found: 1 }] },
];

describe("collector history", () => {
  it("lays History out as the timeline: each day's head, its runs, no line under a day's last dot", () => {
    const items = historyItems(hist());
    expect(items.map((x) => [x.kind, x.kind === "day" ? x.label : x.query, x.first, x.last])).toEqual([
      ["day", "Today", true, false],
      ["run", "anime", false, false],
      ["run", "dti", false, true],
      ["day", "Yesterday", false, false],
      ["run", "old", false, true],
    ]);
    expect(items[2]).toMatchObject({ platform_key: "instagram", tone: "failed", note: "Stopped on an error: HTTP 429" });
    expect(historyItems([])).toEqual([]);
  });
  it("an opened run shows the leads it found in the order found, whatever list they're in now; its head says how it went", () => {
    const v = view({ history: hist(), creators: [row("a"), row("b", { restricted: true }), row("c", { approved: true })] });
    expect(leadsOf(v, "history", "", "run-2").rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
    // The filter box belongs to the lists, not to a run.
    expect(leadsOf(v, "history", "zzz", "run-2").rows.length).toBe(3);
    expect(leadsOf(v, "history", "", "run-1")).toMatchObject({ rows: [], emptyTitle: "Nothing new this time" });
    expect(leadsOf(v, "history", "", "run-0")).toMatchObject({ rows: [], emptyTitle: "Its leads are gone" });
    expect(leadsOf(v, "history", "", "")).toMatchObject({ rows: [], emptyTitle: "" });
    expect(runHead(v, "run-2")).toEqual({ query: "anime", platformKey: "youtube", sub: "YouTube · Today 09:52 · 3 new leads · 7 already collected", note: "", tone: "done" });
    expect(runHead(v, "run-1")!.note).toBe("Stopped on an error: HTTP 429");
    expect(runHead(v, "nope")).toBeNull();
  });
});

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

describe("collector lists' Sort and platforms", () => {
  const rows = [
    row("new", { platformKey: "tiktok", subs: null }),
    row("big", { name: "Zé", platformKey: "youtube", subs: 900 }),
    row("small", { name: "Ana", platformKey: "instagram", subs: 10 }),
    row("mid", { name: "Bia", platformKey: "youtube", subs: 300 }),
  ];
  it("sorts by followers, high → low (the default) or low → high; unknown last both ways", () => {
    const ids = (m: string) => sortRows(rows, m).map((r) => r.id);
    expect(ids("followers-desc")).toEqual(["big", "mid", "small", "new"]);
    expect(ids("followers-asc")).toEqual(["small", "mid", "big", "new"]);
    expect(ids("bogus")).toEqual(ids("followers-desc"));
    expect(sortShort("Followers (high → low)")).toBe("Followers ↓");
    expect(sortShort("Followers (low → high)")).toBe("Followers ↑");
  });
  it("a list shows only the platforms picked, in the Sort's order (the review bar's order too); counts per platform", () => {
    const v = view({ creators: [...rows, row("gone", { restricted: true, platformKey: "youtube", subs: 5000 })] });
    expect(leadsOf(v, "available", "").rows.map((r) => r.id)).toEqual(["big", "mid", "small", "new"]);
    v.settings.platforms = ["youtube", "tiktok"];
    expect(leadsOf(v, "available", "").rows.map((r) => r.id)).toEqual(["big", "mid", "new"]);
    v.settings.sort = "followers-asc";
    expect(leadsOf(v, "available", "").rows.map((r) => r.id)).toEqual(["mid", "big", "new"]);
    v.settings.platforms = ["instagram"];
    expect(leadsOf(v, "available", "zzz")).toMatchObject({ rows: [], emptyDesc: "Nobody matches “zzz” on Instagram." });
    expect(leadsOf(view({ creators: [row("a", { platformKey: "youtube" })], settings: { ...defaultSettings(), platforms: ["tiktok"] } }), "available", "").emptyDesc).toBe("Nobody here on TikTok.");
    expect(platformCounts(v, "available")).toEqual({ youtube: 2, tiktok: 1, instagram: 1 });
    expect(platformCounts(v, "restricted")).toEqual({ youtube: 1, tiktok: 0, instagram: 0 });
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
});

describe("collector lead detail", () => {
  it("lays the newest videos out as the CRM's podium: #2, #1 (featured), #3; missing ones leave their place", () => {
    expect(podium(["a", "b", "c"])).toEqual([{ v: "b", featured: false }, { v: "a", featured: true }, { v: "c", featured: false }]);
    expect(podium(["a"])).toEqual([{ v: null, featured: false }, { v: "a", featured: true }, { v: null, featured: false }]);
    expect(podium([])).toEqual([]);
  });
  it("Reach: Save only for a valid, changed value; no help line, only the error for a bad value", () => {
    const d = { reach: "email", reachValue: "a@b.co" } as DetailView;
    expect(reachState(d, "email", "a@b.co")).toMatchObject({ error: "", canSave: false });
    expect(reachState(d, "email", "x@y.com").canSave).toBe(true);
    expect(reachState(d, "email", "nope")).toMatchObject({ error: "That isn't an email address.", canSave: false });
    expect("help" in reachState(d, "discord", "")).toBe(false);
    expect(reachState(d, "discord", "").hint).toBe("Discord user ID (17-20 digits)");
    expect(reachState(d, "discord", "123").error).toContain("17-20 digits");
  });
  it("Send message's To menu: every Persons › Creators channel, who they are there, the account or why not", () => {
    const c = {
      id: "youtube:UC1",
      name: "Ana",
      templates: [],
      template: "padrao",
      channel: "creators-discord",
      kind: "discord",
      to: "123456789012345678",
      subject: "",
      text: "Oi",
      guard: null,
      channels: [
        { id: "creators-gmail", kind: "gmail", label: "Email", account: "igor@spokpay.com", connected: true, to: "a@b.co", why: "" },
        { id: "creators-whatsapp", kind: "whatsapp", label: "WhatsApp", account: null, connected: true, to: "", why: "No WhatsApp number in their bio: type one." },
        { id: "creators-discord", kind: "discord", label: "Discord", account: "spokpay", connected: true, to: "123456789012345678", why: "" },
        { id: "none-instagram", kind: "instagram", label: "Instagram", account: null, connected: false, to: "@ana", why: "Persons › Creators has no Instagram: add one there (Creators › Connections)." },
      ],
    } as Compose;
    const r = destRows(c);
    expect(r.map((x) => [x.kind, x.to, x.on, x.available])).toEqual([["email", "a@b.co", false, true], ["whatsapp", "", false, true], ["discord", "123456789012345678", true, true], ["instagram", "@ana", false, false]]);
    expect(r.map((x) => x.via)).toEqual(["Creators Gmail · igor@spokpay.com", "Creators WhatsApp · none yet: type it in To", "Creators Discord · spokpay", "Persons › Creators has no Instagram: add one there (Creators › Connections)."]);
  });
});

describe("review bar", () => {
  it("shows only for leads under review: not Approved ones, nor Sent's", () => {
    expect([underReview({}, "available"), underReview({}, "collector"), underReview({}, "restricted")]).toEqual([true, true, true]);
    expect([underReview({ approved: true }, "history"), underReview({}, "approved"), underReview({}, "sent")]).toEqual([false, false, false]);
  });
});

describe("detail bio", () => {
  it("folds line breaks and blank lines into one paragraph for the clamped lines", () => {
    const bio = "Fala galera esse é o meu canal !!\n\n\n\n02/02/2022▸ CRIEI ESSE CANAL\r\n05/02/2022▸ PRIMEIRO VÍDEO\n  \n\t05/02/2022▸  1º INSCRITO  \n";
    expect(bioLine(bio)).toBe("Fala galera esse é o meu canal !! · 02/02/2022▸ CRIEI ESSE CANAL · 05/02/2022▸ PRIMEIRO VÍDEO · 05/02/2022▸ 1º INSCRITO");
    expect(bioLine(bio)).not.toMatch(/[\r\n]/);
    expect(bioLine("")).toBe("");
    expect(bioLine("\n\n")).toBe("");
    expect(bioLine("one line")).toBe("one line");
  });
});
