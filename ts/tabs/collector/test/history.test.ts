import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collector, collectorRoute, type CollectorDeps } from "../engine.ts";
import { backfillRuns, historyView, keepRun, outcomeOfStatus, parseRuns, RUNS_KEEP, type RunRecord } from "../lib/history.ts";
import { defaultData, migrate, type CreatorRecord, type RunState } from "../lib/types.ts";
import { fakePersons } from "../persons-bridge.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-27T15:00:00Z"); // 12:00 in Brasília
const TZ = "America/Sao_Paulo";

function rec(over: Partial<CreatorRecord>): CreatorRecord {
  return { platform: "youtube", platform_id: "UC1", name: "N", handle: null, profile_url: null, avatar_url: null, subscriber_count: null, video_count: null, view_count: null, description: null, links: [], country: null, discovered_via: "q", captured_at: new Date(NOW).toISOString(), ...over };
}

function run(over: Partial<RunRecord>): RunRecord {
  return { id: `run-${over.startedAt ?? NOW}`, platform: "youtube", query: "q", gapDays: 14, target: 20, startedAt: NOW, endedAt: NOW + 60_000, found: 0, known: 0, ids: [], outcome: "done", ...over };
}

/** A fake YouTube whose search gives one video per channel id and whose channels all posted yesterday. */
function fakeYt(ids: string[]) {
  return {
    search: async (_q: string, sp: { type?: number }) => (sp.type === undefined ? { contents: ids.map((id) => ({ videoRenderer: { videoId: `v-${id}`, ownerText: { runs: [{ text: id, navigationEndpoint: { browseEndpoint: { browseId: id } } }] } } })) } : {}),
    continuation: async () => ({}),
    feed: async () => ({ newest: Date.now() - DAY, videos: [] }),
    about: async (id: string) => {
      return { name: `N ${id}`, handle: `@${id}`, profileUrl: `https://y/@${id}`, avatarUrl: null, subscribers: 10, videos: 2, views: 3, description: null, country: null, links: [] };
    },
  };
}

function deps(over: Partial<CollectorDeps> = {}): CollectorDeps {
  return { offline: false, changed: () => {}, log: () => {}, persons: fakePersons(), sleep: async () => {}, fetch: async () => new Response("", { status: 404 }), ...over };
}

const caller = (c: Collector) => (method: string, path: string, body: unknown = null) =>
  collectorRoute(c, { method, path: ["v1", "collector", ...path.split("/").filter(Boolean)], query: [], body, token: "", device: "", global: false } as never);

describe("collector history", () => {
  it("records every run when it ends: term, platform, settings, times, counts, its leads, how it ended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-h-"));
    const c = new Collector(dir, deps({ youtube: fakeYt(["UCa", "UCb"]) as never }));
    const call = caller(c);
    await call("POST", "start", { platform: "youtube", query: "blox fruits", target: 0, gapDays: 30 });
    await c.settled();
    // The same term again: nobody new.
    await call("POST", "start", { platform: "youtube", query: "blox fruits", target: 0, gapDays: 30 });
    await c.settled();
    expect(c.data.runs.map((r) => [r.platform, r.query, r.gapDays, r.target, r.found, r.known, r.ids, r.outcome])).toEqual([
      ["youtube", "blox fruits", 30, 0, 2, 0, ["youtube:UCa", "youtube:UCb"], "exhausted"],
      ["youtube", "blox fruits", 30, 0, 0, 2, [], "none"],
    ]);
    expect(c.data.runs.every((r) => r.endedAt >= r.startedAt && r.startedAt > 0)).toBe(true);
    // In the view, newest first, as one day.
    const v = (await call("GET", ""))!.body as { history: { label: string; runs: { query: string; line: string; tone: string; ids: string[] }[] }[] };
    expect(v.history.length).toBe(1);
    expect(v.history[0]!.label).toBe("Today");
    expect(v.history[0]!.runs.map((e) => [e.line, e.tone, e.ids.length])).toEqual([
      ["No new leads · 2 already collected", "empty", 0],
      ["2 new leads", "done", 2],
    ]);
    // Kept across a restart.
    await c.flush();
    const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { runs: RunRecord[] };
    expect(saved.runs.length).toBe(2);
    expect(new Collector(dir, deps()).data.runs.map((r) => r.outcome)).toEqual(["exhausted", "none"]);
  });

  it("Stop or an error says so; a run cut by a restart is Interrupted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-h-"));
    const c = new Collector(dir, deps({ youtube: fakeYt(["UCa", "UCb", "UCc"]) as never }));
    await caller(c)("POST", "start", { platform: "youtube", query: "x", target: 5, gapDays: 7 });
    await c.stop();
    expect([c.data.runs[0]!.outcome, c.data.runs[0]!.target, c.data.runs[0]!.gapDays]).toEqual(["stopped", 5, 7]);
    const failed = historyView({ runs: [run({ outcome: "failed", error: "HTTP 429", found: 2, ids: ["a", "b"] })], run: null }, NOW, TZ)[0]!.runs[0]!;
    expect([failed.tone, failed.line, failed.note]).toEqual(["failed", "2 new leads", "Stopped on an error: HTTP 429"]);
    // A state.json saved mid-run (Hub quit): the next start records it as interrupted, once.
    const d = defaultData();
    d.run = { running: true, label: "TikTok", platform: "tiktok", query: "dti", startedAt: NOW, endedAt: 0, status: "Running…", found: 1, target: 20, considered: 3, dropped: 1, known: 0, ids: ["tiktok:1"], line: "Checking @a…", gapDays: 14 };
    d.runs = [];
    const dir2 = mkdtempSync(join(tmpdir(), "collector-h-"));
    writeFileSync(join(dir2, "state.json"), JSON.stringify(d));
    const again = new Collector(dir2, deps());
    expect(again.data.runs.map((r) => [r.query, r.outcome, r.ids, r.gapDays])).toEqual([["dti", "interrupted", ["tiktok:1"], 14]]);
    expect(historyView(again.data, NOW, TZ)[0]!.runs[0]!.note).toBe("Interrupted: Hub restarted.");
  });

  it("shows the run going now on top, with how far it is", () => {
    const d = { runs: [run({ startedAt: NOW - 3_600_000, ids: ["youtube:a"], found: 1 })], run: { running: true, label: "YouTube", platform: "youtube", query: "live", startedAt: NOW - 5 * 60_000, endedAt: 0, status: "Running…", found: 3, target: 20, considered: 5, dropped: 0, known: 1, ids: ["youtube:b", "youtube:c", "youtube:d"], line: "Checking @x…" } as RunState };
    const top = historyView(d, NOW, TZ)[0]!.runs;
    expect(top.map((e) => [e.query, e.time, e.tone, e.line, e.note])).toEqual([
      ["live", "5m", "running", "3 of 20 so far · 1 already collected", "Checking @x…"],
      ["q", "11:00", "done", "1 new lead", ""],
    ]);
  });

  it("groups by day in the PC's time zone: Today, Yesterday, then the date", () => {
    const runs = [run({ startedAt: NOW - 2 * DAY - 3_600_000, query: "c" }), run({ startedAt: NOW - DAY, query: "b" }), run({ startedAt: NOW - 14 * 3_600_000, query: "late" }), run({ startedAt: NOW - 60_000, query: "a" })];
    const days = historyView({ runs, run: null }, NOW, TZ);
    // 14 h before noon is 22:00 yesterday in Brasília.
    expect(days.map((d) => [d.label, d.runs.map((e) => `${e.time} ${e.query}`)])).toEqual([
      ["Today", ["11:59 a"]],
      ["Yesterday", ["22:00 late", "12:00 b"]],
      ["Wed, Nov 25", ["11:00 c"]],
    ]);
    // Stopped early: amber, with the target it stopped before.
    const s = historyView({ runs: [run({ outcome: "stopped", found: 4, ids: ["a", "b", "c", "d"], target: 20 })], run: null }, NOW, TZ)[0]!.runs[0]!;
    expect([s.tone, s.line, s.note]).toEqual(["stopped", "4 new leads", "Stopped before the target (20)."]);
  });

  it("rebuilds the runs from before History from the leads: the last run as saved, the others by term and time", () => {
    const at = (min: number): string => new Date(NOW + min * 60_000).toISOString();
    const creators = [
      rec({ platform_id: "UC1", discovered_via: "anime", captured_at: at(0) }),
      rec({ platform_id: "UC2", discovered_via: "anime", captured_at: at(2) }),
      // The same term two hours later: another run.
      rec({ platform_id: "UC3", discovered_via: "anime", captured_at: at(150) }),
      rec({ platform: "tiktok", platform_id: "t1", discovered_via: "anime", captured_at: at(1) }),
      // Brought in from the CRM: not a run.
      rec({ platform_id: "UC4", discovered_via: "robux", captured_at: at(3), imported_from: "SpokPay CRM · Has Contact" }),
      // The last run's own lead.
      rec({ platform_id: "UC5", discovered_via: "dti", captured_at: at(200) }),
    ];
    const last: RunState = { running: false, label: "YouTube", platform: "youtube", query: "dti", startedAt: NOW + 199 * 60_000, endedAt: NOW + 201 * 60_000, status: "Done: 1 new lead (no more for this term) · 7 already collected, passed over", found: 1, target: 20, considered: 8, dropped: 0, known: 7, ids: ["youtube:UC5"], line: "" };
    const runs = backfillRuns(creators, last);
    expect(runs.map((r) => [r.platform, r.query, r.ids, r.outcome, !!r.backfilled])).toEqual([
      ["youtube", "anime", ["youtube:UC1", "youtube:UC2"], "done", true],
      ["tiktok", "anime", ["tiktok:t1"], "done", true],
      ["youtube", "anime", ["youtube:UC3"], "done", true],
      ["youtube", "dti", ["youtube:UC5"], "exhausted", false],
    ]);
    expect(runs[3]!.known).toBe(7);
    // migrate does it once: a file with runs (even none) keeps them as they are.
    expect(migrate({ creators, run: last }).runs.length).toBe(4);
    expect(migrate({ creators, run: last, runs: [] }).runs).toEqual([]);
  });

  it("reads the outcome off an old status line; keeps at most RUNS_KEEP runs; drops malformed ones", () => {
    expect(["Interrupted: Hub restarted.", "Stopped: 3 new leads", "No new leads for “x”. Try another term.", "Done: 4 new leads (no more for this term)", "Done: 20 new leads"].map(outcomeOfStatus)).toEqual(["interrupted", "stopped", "none", "exhausted", "done"]);
    let runs: RunRecord[] = [];
    for (let i = 0; i < RUNS_KEEP + 5; i++) runs = keepRun(runs, run({ id: `run-${i}`, startedAt: i }));
    expect([runs.length, runs[0]!.startedAt]).toEqual([RUNS_KEEP, 5]);
    // The same run again replaces it.
    expect(keepRun([run({ id: "x", found: 1 })], run({ id: "x", found: 2 })).map((r) => r.found)).toEqual([2]);
    expect(parseRuns([null, { id: "a" }, { id: "b", platform: "myspace", query: "q", startedAt: 1 }, { id: "c", platform: "tiktok", query: "q", startedAt: 2, ids: ["t:1", 3], outcome: "weird" }])).toEqual([
      { id: "c", platform: "tiktok", query: "q", gapDays: null, target: 0, startedAt: 2, endedAt: 2, found: 1, known: 0, ids: ["t:1"], outcome: "done" },
    ]);
  });
});
