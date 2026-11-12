// HARBOR_SWITCH_TRACE=1: how long opening a chat takes, step by step, and the loop turns (layout + paint) after it.
// HARBOR_SWITCH_CYCLE="id,id,…" (with HARBOR_SWITCH_AT=secs, HARBOR_SWITCH_EVERY=ms): opens those chats in turn.
// HARBOR_SWITCH_PROF=DIR: JSC's samples of the 600 ms after each switch, as JSON in DIR.
const on = !!process.env.HARBOR_SWITCH_TRACE;
let start = 0;
let last = 0;
let parts: string[] = [];
let lag: ReturnType<typeof setInterval> | null = null;
const prof = process.env.HARBOR_SWITCH_PROF ?? "";
interface Sampler {
  startSamplingProfiler(): void;
  samplingProfilerStackTraces(): unknown;
}
let jsc: Sampler | null = null;
let n = 0;
let epoch = 0;
let js = 0;
let turns: string[] = [];
let probe: () => string = () => "";
let report: ReturnType<typeof setTimeout> | null = null;

export function begin(what: string): void {
  if (!on) return;
  if (report !== null) flush();
  start = last = performance.now();
  epoch = Date.now();
  parts = [what + (jscMod ? ` p${jscMod.heapStats().protectedObjectCount}` : "")];
  turns = [];
  js = 0;
  if (prof !== "") {
    void import("bun:jsc").then((m) => {
      const s = m as unknown as Sampler;
      if (jsc === null) s.startSamplingProfiler();
      jsc = s;
    });
    jsc?.samplingProfilerStackTraces();
    const k = ++n;
    const at = performance.now();
    setTimeout(() => {
      const t = jsc?.samplingProfilerStackTraces();
      void Bun.write(`${prof}/switch-${k}.json`, JSON.stringify({ what, at, now: performance.now(), traces: t }));
    }, 600);
  }
  // The main thread blocked: a 5 ms interval that came late.
  if (lag !== null) clearInterval(lag);
  let prev = performance.now();
  lag = setInterval(() => {
    const t = performance.now();
    if (t - prev > 25) turns.push(`blocked+${(prev - start).toFixed(0)}:${(t - prev).toFixed(0)}`);
    prev = t;
    if (t - start > 1500 && lag !== null) {
      clearInterval(lag);
      lag = null;
    }
  }, 5);
  report = setTimeout(flush, 1500);
}

let jscMod: { heapStats(): { protectedObjectCount: number } } | null = null;
if (process.env.HARBOR_SWITCH_PROTECTED) void import("bun:jsc").then((m) => (jscMod = m as never));
export function mark(what: string): void {
  if (!on || start === 0) return;
  const t = performance.now();
  parts.push(`${what} ${(t - last).toFixed(1)}${jscMod ? ` p${jscMod.heapStats().protectedObjectCount}` : ""}`);
  last = t;
}

export function end(): void {
  if (!on || start === 0) return;
  mark("rest");
  js = performance.now() - start;
}

/** What the window shows now, for the turn log (e.g. the transcript's scroll state). */
export function probeWith(f: () => string): void {
  probe = f;
}

/** A turn of Slint's loop ran `t0`..now: logged within 1.5 s of a switch. */
export function turn(t0: number): void {
  if (!on || start === 0) return;
  const t = performance.now();
  if (t - start < 1500 && t - t0 > 2) turns.push(`turn ${(t0 - start).toFixed(0)}-${(t - start).toFixed(0)} ${probe()}`);
}

function flush(): void {
  if (report !== null) clearTimeout(report);
  report = null;
  const first = turns.find((x) => x.startsWith("turn "));
  const paint = first ? first.split(" ")[1]?.split("-")[1] : "?";
  console.error(`switch @${epoch} ${parts[0]} js ${js.toFixed(0)} ms, first turn done +${paint} ms, rss ${Math.round(process.memoryUsage.rss() / 2 ** 20)} MB${jscMod ? ` p${jscMod.heapStats().protectedObjectCount}` : ""}: ${parts.slice(1).join(" | ")}\n  ${turns.join("\n  ")}`);
  start = 0;
}

/** A transcript build drew `n` image placeholders (images not decoded yet): logged, with the time since the switch. */
export function gray(n: number): void {
  if (!on || n === 0) return;
  console.error(`gray ${n} at ${Date.now()}`);
}

/** A chat opened from the sidebar waited `ms` for its first frame's images (`capped`: it stopped waiting). */
export function waited(ms: number, capped: boolean): void {
  if (on) console.error(`ahead waited ${ms.toFixed(0)} ms${capped ? " (cap)" : ""}`);
}

/** HARBOR_SWITCH_CYCLE: opens each chat in turn. */
export function drive(open: (id: number) => void): void {
  const ids = (process.env.HARBOR_SWITCH_CYCLE ?? "").split(",").map(Number).filter((x) => x > 0);
  if (ids.length === 0) return;
  const at = Number(process.env.HARBOR_SWITCH_AT ?? 10) * 1000;
  const every = Number(process.env.HARBOR_SWITCH_EVERY ?? 2000);
  ids.forEach((id, i) => setTimeout(() => open(id), at + i * every));
  setTimeout(() => console.error("switch cycle done"), at + ids.length * every);
  setTimeout(() => console.error(`switch cycle rss ${Math.round(process.memoryUsage.rss() / 2 ** 20)} MB`), at + ids.length * every + 3000);
  // HARBOR_SWITCH_PROTECTED=1: the engine's protected objects (N-API references) by type, before the cycle and after.
  if (process.env.HARBOR_SWITCH_PROTECTED) {
    const dump = (when: string) =>
      void import("bun:jsc").then((m) => {
        Bun.gc(true);
        const h = m.heapStats();
        const top = Object.entries(h.protectedObjectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
        console.error(`protected ${when} ${h.protectedObjectCount} heap ${Math.round(h.heapSize / 2 ** 20)} MB objects ${h.objectCount}: ${top.map(([k, v]) => `${k}=${v}`).join(" ")}`);
      });
    setTimeout(() => dump("before"), at - 500);
    setTimeout(() => dump("after"), at + ids.length * every + 4000);
    setTimeout(() => dump("later"), at + ids.length * every + 9000);
  }
}


/** HARBOR_SWITCH_STREAM=ID (with HARBOR_SWITCH_TRACE): from HARBOR_SWITCH_AT s on, chat ID gets a reply that grows
 * every 250 ms, as a streaming turn does, so a rig can watch a pane that shows it (split panes) follow along. */
export function stream(items: (id: number) => { kind: string; text?: string; at?: number }[], changed: (id: number) => void): void {
  const id = Number(process.env.HARBOR_SWITCH_STREAM ?? "");
  if (!on || !Number.isInteger(id) || id <= 0) return;
  const at = Number(process.env.HARBOR_SWITCH_AT ?? "10") * 1000;
  setTimeout(() => {
    const reply = { kind: "text", text: "Streaming:", at: Date.now() };
    items(id).push(reply);
    let n = 0;
    const t = setInterval(() => {
      n++;
      reply.text += ` word${n}`;
      if (n % 12 === 0) reply.text += "\n\nA new paragraph.";
      changed(id);
      if (n >= 120) clearInterval(t);
    }, 250);
    changed(id);
  }, at);
}
