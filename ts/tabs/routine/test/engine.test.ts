import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Call } from "../../../packages/net/src/index.ts";
import { cardsToMessages, createRoutineEngine, stripContext, withContext } from "../engine.ts";

const call = (method: string, path: string, body: unknown = null): Call => ({ method, path: path.split("/"), query: [], body, token: "", device: "", global: false });

function rig(items: () => unknown[] = () => [], sent: unknown[] = []) {
  const e = createRoutineEngine();
  const dir = mkdtempSync(join(tmpdir(), "routine-"));
  void e.start?.({
    store: null as never,
    dir,
    env: {},
    changed: () => {},
    log: () => {},
    call: async (method, path, _q, body) => {
      if (path === "v1/state") return { status: 200, body: { projects: [{ id: 7, name: "creators", path: "/h/creators" }], chats: [{ id: 3, title: "Coach", project_id: 7, role: "lead", updated_ms: 1 }] } };
      if (path === "v1/chats/3/items") return { status: 200, body: { items: items(), running: false, queued: 0 } };
      sent.push({ method, path, body });
      return { status: 200, body: { id: 3 } };
    },
  });
  const r = async (m: string, p: string, b: unknown = null) => (await e.route(call(m, p, b)))!;
  return { e, r, dir };
}

describe("Routine engine", () => {
  test("first launch: no plan; a plan, a log, undo and a stopwatch", async () => {
    const { r } = rig();
    expect(((await r("GET", "v1/routine")).body as { data: { plan: unknown } }).data.plan).toBeNull();
    await r("POST", "v1/routine/act", { act: "plan", id: "basic" });
    let st = (await r("POST", "v1/routine/act", { act: "log", goal: "water", amount: 250 })).body as { data: { goals: { id: string }[]; entries: Record<string, { amount: number }[]> } };
    expect(st.data.goals.map((g) => g.id)).toEqual(["water", "pushups", "abs"]);
    expect(Object.values(st.data.entries).flat().map((e) => e.amount)).toEqual([250]);
    st = (await r("POST", "v1/routine/act", { act: "undo", goal: "water" })).body as typeof st;
    expect(Object.values(st.data.entries).flat()).toEqual([]);
    await r("POST", "v1/routine/act", { act: "timer", goal: "abs", cmd: "start" });
    const t = (await r("GET", "v1/routine")).body as { data: { timers: Record<string, unknown> } };
    expect(Object.keys(t.data.timers)).toEqual(["abs"]);
    expect((await r("POST", "v1/routine/act", { act: "nope" })).status).toBe(400);
    expect(await createRoutineEngine().route(call("GET", "v1/persons"))).toBeNull();
  });

  test("export imports back 1:1", async () => {
    const a = rig();
    await a.r("POST", "v1/routine/act", { act: "plan", id: "igor" });
    await a.r("POST", "v1/routine/act", { act: "log", goal: "pushups", amount: 12 });
    const bundle = (await a.r("GET", "v1/routine/export")).body;
    const b = rig();
    const preview = (await b.r("POST", "v1/routine/import", { text: JSON.stringify(bundle) })).body as { summary: { goals: number; entries: number } };
    expect(preview.summary.goals).toBe(7);
    expect(preview.summary.entries).toBe(1);
    await b.r("POST", "v1/routine/import", { text: JSON.stringify(bundle), confirm: true });
    expect(((await b.r("GET", "v1/routine")).body as { data: unknown }).data).toEqual(((await a.r("GET", "v1/routine")).body as { data: unknown }).data);
    expect((await b.r("POST", "v1/routine/import", { text: "nope" })).status).toBe(400);
  });

  test("the Coach: history is only marked seen; a new action runs once and can be undone", async () => {
    let cards: unknown[] = [{ seq: 1, kind: "user", text: withContext("hi", "stats") }, { seq: 2, kind: "text", markdown: 'Logged.\n```sf-action\n{"type":"log","goal":"Water","amount":500}\n```' }];
    const sent: unknown[] = [];
    const { r } = rig(() => cards, sent);
    await r("POST", "v1/routine/act", { act: "plan", id: "basic" });
    let c = (await r("GET", "v1/routine/coach")).body as { messages: { text: string; chips: unknown[] }[] };
    expect(c.messages.map((m) => m.text)).toEqual(["hi", "Logged."]);
    expect(c.messages[1]!.chips).toEqual([]);
    cards = [...cards, { seq: 3, kind: "user", text: "drank" }, { seq: 4, kind: "text", markdown: '```sf-action\n{"type":"log","goal":"water","amount":250}\n```' }];
    c = (await r("GET", "v1/routine/coach")).body as typeof c;
    await r("GET", "v1/routine/coach");
    const chips = c.messages[3]!.chips as { key: string; label: string; canUndo: boolean }[];
    expect(chips.map((x) => x.label)).toEqual(["+250 ml Water"]);
    const st = (await r("GET", "v1/routine")).body as { data: { entries: Record<string, { amount: number }[]> } };
    expect(Object.values(st.data.entries).flat().map((e) => e.amount)).toEqual([250]);
    await r("POST", "v1/routine/coach/undo", { key: chips[0]!.key });
    const st2 = (await r("GET", "v1/routine")).body as typeof st;
    expect(Object.values(st2.data.entries).flat()).toEqual([]);
    await r("POST", "v1/routine/coach", { text: "how am I doing?" });
    expect(String((sent[0] as { body: { text: string } }).body.text)).toContain("<routine-stats>");
    await r("POST", "v1/routine/coach", { text: "again" });
    expect(String((sent[1] as { body: { text: string } }).body.text)).toBe("again");
  });

  test("cards become messages; stats are stripped", () => {
    expect(stripContext(withContext("a", "b"))).toBe("a");
    const m = cardsToMessages([{ seq: 1, kind: "user", text: "q" }, { seq: 2, kind: "text", markdown: "x" }, { seq: 3, kind: "tool" }, { seq: 4, kind: "text", markdown: "y" }], true);
    expect(m.map((x) => [x.role, x.text, x.done])).toEqual([["user", "q", true], ["agent", "x\n\ny", false]]);
  });
});

describe("Routine for the phone", () => {
  test("the view, and a finished ride summarized and logged", async () => {
    const { r } = rig();
    await r("POST", "v1/routine/act", { act: "plan", id: "igor" });
    const v = (await r("GET", "v1/routine/view")).body as { picking: boolean; goals: { rows: unknown[] }; history: { cells: unknown[] }; wakes: unknown[] };
    expect(v.picking).toBe(false);
    expect(v.goals.rows.length).toBe(7);
    expect(v.history.cells.length).toBe(56);
    expect(v.wakes.length).toBe(4);
    const points = Array.from({ length: 61 }, (_, i) => ({ t: 1_000_000 + i * 1000, lat: -23.55 + (i * 5) / 111_195, lon: -46.63, acc: 5, alt: 700 }));
    const f = (await r("POST", "v1/routine/ride/finish", { goal: "bike", points, movingMs: 60_000, at: Date.now() })).body as { ride: { km: number; durationSec: number } };
    expect(f.ride.km).toBeCloseTo(0.3, 2);
    expect(f.ride.durationSec).toBe(60);
    const t = (await r("GET", "v1/routine/view")).body as { today: { goals: { id: string; todayKm: number }[] } };
    expect(t.today.goals.find((g) => g.id === "bike")?.todayKm).toBeCloseTo(0.3, 2);
  });
});
