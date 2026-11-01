// Preloaded by cost.py when HTS_LOOPSTATS=1; it reads $HTS_LOOPSTATS_OUT.
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";

interface Slot { n: number; cpu: number; wall: number; max: number }
const req = createRequire(import.meta.url);
const m = req("slint-ui/rust-module.cjs") as {
  processEvents: () => unknown;
  buildFeatures: () => string[];
  ComponentInstance: { prototype: { setProperty: (name: string, v: unknown) => void } };
};
const out = process.env.HTS_LOOPSTATS_OUT ?? "/dev/stderr";
const slot = (): Slot => ({ n: 0, cpu: 0, wall: 0, max: 0 });
let pe = slot();
let props = new Map<string, Slot>();
let depth = 0;

function timed<T>(s: Slot, f: () => T): T {
  if (depth > 0) return f();
  depth++;
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  try {
    return f();
  } finally {
    const c = process.cpuUsage(c0);
    const w = performance.now() - t0;
    s.n++;
    s.cpu += (c.user + c.system) / 1000;
    s.wall += w;
    s.max = Math.max(s.max, w);
    depth--;
  }
}

const processEvents = m.processEvents;
m.processEvents = () => timed(pe, processEvents);
const setProperty = m.ComponentInstance.prototype.setProperty;
m.ComponentInstance.prototype.setProperty = function (this: unknown, name: string, v: unknown) {
  let s = props.get(name);
  if (!s) props.set(name, (s = slot()));
  timed(s, () => setProperty.call(this, name, v));
};

let c0 = process.cpuUsage();
let t0 = performance.now();
appendFileSync(out, JSON.stringify({ features: m.buildFeatures() }) + "\n");
setInterval(() => {
  const c = process.cpuUsage(c0);
  const dt = performance.now() - t0;
  const total = (c.user + c.system) / 1000;
  const setCpu = [...props.values()].reduce((a, s) => a + s.cpu, 0);
  const pct = (ms: number) => Math.round((ms / dt) * 10000) / 100;
  const top = [...props.entries()].sort((a, b) => b[1].cpu - a[1].cpu).slice(0, 8)
    .map(([k, s]) => [k, s.n, pct(s.cpu), Math.round(s.max * 10) / 10]);
  appendFileSync(out, JSON.stringify({
    secs: Math.round(dt / 100) / 10, cpu_pct: pct(total),
    process_events: { calls_s: Math.round((pe.n / dt) * 10000) / 10, cpu_pct: pct(pe.cpu), wall_pct: pct(pe.wall), max_ms: Math.round(pe.max * 10) / 10 },
    set_property: { cpu_pct: pct(setCpu), top },
    rest_cpu_pct: pct(total - pe.cpu - setCpu),
  }) + "\n");
  pe = slot();
  props = new Map();
  c0 = process.cpuUsage();
  t0 = performance.now();
}, 5000).unref();
