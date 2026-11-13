// Computer use against this PC's real screen, through the tool's own code: what the backend is, a screenshot, a
// zoom, where the pointer is, and the pointer moved a few pixels and put back. Nothing is clicked or typed. Run it
// by hand on the PC to check (prints ok/FAIL per step, exits 1 on a failure):
//   bun packages/mcp/test/computer-live.ts [OUT_DIR]     (Windows: set BUN_BE_BUN=1 and run harbor.exe the same way)
// OUT_DIR gets the screenshot and the zoom as PNG files.
import { join } from "node:path";
import { screen } from "@harbor/os";
import { act, parseAction, scaled } from "../src/computer.ts";

const out = process.argv[2];
const fails: string[] = [];
async function check(name: string, f: () => Promise<unknown>): Promise<void> {
  try {
    const r = await f();
    console.log(`ok   ${name}${r === undefined ? "" : `: ${String(r)}`}`);
  } catch (e) {
    fails.push(name);
    console.log(`FAIL ${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
}
const image = async (r: Awaited<ReturnType<typeof act>>, file: string): Promise<string> => {
  const img = r.content.find((c) => (c as { type?: string }).type === "image") as { data: string } | undefined;
  if (!r.ok || !img) throw new Error(JSON.stringify(r.content).slice(0, 300));
  const bytes = Buffer.from(img.data, "base64");
  const p = screen.decode(new Uint8Array(bytes));
  if (out !== undefined) await Bun.write(join(out, file), bytes);
  return `${p?.w}x${p?.h}, ${bytes.length} bytes${out === undefined ? "" : ` -> ${join(out, file)}`}`;
};

const probe = screen.probe(process.env, true);
console.log(`backend: ${probe.name}${probe.ok ? "" : ` — missing: ${probe.missing.join("; ")}`}${probe.limits.length ? ` — limits: ${probe.limits.join("; ")}` : ""}`);
if (!probe.ok) process.exit(1);
const b = screen.backend();
const real = await b.size();
const view = scaled(real.w, real.h);
console.log(`screen ${real.w}x${real.h}, shown at ${view.w}x${view.h}`);

await check("screenshot", async () => {
  const t = performance.now();
  const r = await act({ action: "screenshot" }, { backend: b });
  return `${await image(r, "screenshot.png")} in ${Math.round(performance.now() - t)} ms`;
});
await check("zoom on the top-left quarter", async () => image(await act(parseAction({ action: "zoom", region: [0, 0, Math.floor(view.w / 2), Math.floor(view.h / 2)] }, view), { backend: b }), "zoom.png"));
const before = await b.cursor();
await check("cursor_position", async () => {
  const r = await act({ action: "cursor_position" }, { backend: b });
  return `${(r.content[0] as { text: string }).text} (screen ${JSON.stringify(before)})`;
});
await check("mouse_move 5 px right and down, then back", async () => {
  if (before === null) return "skipped: this system doesn't say where the pointer is";
  const [vx, vy] = [Math.round((before.x * view.w) / real.w), Math.round((before.y * view.h) / real.h)];
  const to: [number, number] = [Math.min(view.w - 1, vx + 5), Math.min(view.h - 1, vy + 5)];
  const r = await act(parseAction({ action: "mouse_move", coordinate: to }, view), { backend: b });
  if (!r.ok) throw new Error((r.content[0] as { text: string }).text);
  const moved = await b.cursor();
  // Back exactly where it was, in the screen's own pixels.
  await b.move(before.x, before.y);
  const back = await b.cursor();
  if (back && (back.x !== before.x || back.y !== before.y)) throw new Error(`not back: ${JSON.stringify(back)} vs ${JSON.stringify(before)}`);
  if (moved && moved.x === before.x && moved.y === before.y) throw new Error("the pointer didn't move");
  return `${JSON.stringify(before)} -> ${JSON.stringify(moved)} -> ${JSON.stringify(back)}`;
});

if (fails.length > 0) {
  console.log(`${fails.length} failed: ${fails.join(", ")}`);
  process.exit(1);
}
console.log("all ok");
