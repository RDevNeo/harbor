// What a key typed in a Persons chat's composer costs with a long conversation open: bun rig/personsbench.ts [MSGS].
// Draws the real PersonsPage (persons.slint) with MSGS bubbles of wrapped text (the chat keeps its last 400), types
// 60 keys into the composer's draft and prints the ms of CPU per key (the change, the layout it dirties, a frame).
// It shows a window: run it on a headless compositor (scripts/shot's sway), not on the desktop.
import * as slint from "slint-ui";
import { processEvents } from "slint-ui/rust-module.cjs";
import { join } from "node:path";

const MSGS = Number(process.argv[2] ?? 400);
// "key" types into the composer; "status" changes only the header's status line (the cost of a frame alone);
// "switch" opens another chat of MSGS messages, 10 times (the rows built and laid out, the first frame); "mount"
// opens the tab 5 times with that chat open and SIDE people in the sidebar (app.slint builds PersonsPage each time)
const MODE = process.argv[3] ?? "key";
const FONTS = join(import.meta.dir, "../../assets/fonts");
// PERSONS_SLINT=other.slint: another copy of persons.slint beside it (a before / after comparison)
const src = `
import "${FONTS}/Geist-Regular.ttf";
import "${FONTS}/Geist-Medium.ttf";
import "${FONTS}/Geist-SemiBold.ttf";
import "${FONTS}/lucide.ttf";
import { PersonsBus, PersonsPage } from "${process.env.PERSONS_SLINT ?? "persons.slint"}";
export { PersonsBus }
export component W inherits Window {
  width: 1280px; height: 800px;
  default-font-family: "Geist";
  in property <bool> on: true;
  if root.on: PersonsPage { width: root.width; height: root.height; }
}`;
const ui = slint.loadSource(src, join(import.meta.dir, "../packages/ui/slint/bench.slint"), { style: "fluent" }) as Record<string, unknown>;
const W = ui.W as new () => { PersonsBus: Record<string, unknown>; on: boolean; show(): void };
const SIDE = Number(process.argv[4] ?? 150);
const w = new W();
const bus = w.PersonsBus;
const words = "the quick brown fox jumps over the lazy dog while the store owner asks about https://example.com/some/long/path?with=query".split(" ");
const para = (n: number, k: number) => Array.from({ length: n }, (_, i) => words[(i + k) % words.length]).join(" ");
const msg = (i: number) => ({
  kind: "msg",
  id: `m${i}`,
  mine: i % 3 === 0,
  text: para(8 + ((i * 7) % 60), i),
  time: "10:42",
  first: true,
  day: "Today",
});
bus.view = "chat";
bus.c_can_send = true;
bus.c_name = "Fagner";
bus.side = new slint.ArrayModel(
  Array.from({ length: SIDE }, (_, i) => ({ kind: "person", id: `p${i}`, section: "stores", name: `Person ${i}`, initials: "P", status: i % 4 ? "Sent a message about the store" : "", time: "10:42", unread: i % 7 === 0 ? 2 : 0 })),
);
bus.msgs = new slint.ArrayModel(Array.from({ length: MSGS }, (_, i) => msg(i)));
w.show();
const cpu = () => {
  const c = process.cpuUsage();
  return (c.user + c.system) / 1000;
};
for (let i = 0; i < 40; i++) {
  processEvents();
  await Bun.sleep(16);
}
if (MODE === "switch") {
  let total = 0;
  let worstSwitch = 0;
  for (let k = 1; k <= 10; k++) {
    const c0 = cpu();
    bus.side = new slint.ArrayModel(
  Array.from({ length: SIDE }, (_, i) => ({ kind: "person", id: `p${i}`, section: "stores", name: `Person ${i}`, initials: "P", status: i % 4 ? "Sent a message about the store" : "", time: "10:42", unread: i % 7 === 0 ? 2 : 0 })),
);
bus.msgs = new slint.ArrayModel(Array.from({ length: MSGS }, (_, i) => ({ ...msg(i + k), id: `c${k}m${i}` })));
    bus.c_open_rev = k;
    processEvents();
    const d = cpu() - c0;
    total += d;
    worstSwitch = Math.max(worstSwitch, d);
    for (let j = 0; j < 5; j++) {
      await Bun.sleep(16);
      processEvents();
    }
  }
  console.log(JSON.stringify({ msgs: MSGS, mode: MODE, ms_per_switch: +(total / 10).toFixed(2), worst_ms: +worstSwitch.toFixed(2) }));
  process.exit(0);
}
if (MODE === "mount") {
  let total = 0;
  let worstMount = 0;
  for (let k = 0; k < 5; k++) {
    w.on = false;
    for (let j = 0; j < 5; j++) {
      processEvents();
      await Bun.sleep(16);
    }
    const c0 = cpu();
    w.on = true;
    processEvents();
    const d = cpu() - c0;
    total += d;
    worstMount = Math.max(worstMount, d);
    for (let j = 0; j < 5; j++) {
      await Bun.sleep(16);
      processEvents();
    }
  }
  console.log(JSON.stringify({ msgs: MSGS, side: SIDE, mode: MODE, ms_per_mount: +(total / 5).toFixed(2), worst_ms: +worstMount.toFixed(2) }));
  process.exit(0);
}
const typed = "Opa, tudo certo? Te mandei o link da loja agora, da uma olhada quando puder e me fala";
let ms = 0;
let worst = 0;
const N = 60;
for (let i = 0; i < N; i++) {
  const c0 = cpu();
  if (MODE === "key") bus.draft = typed.slice(0, i + 1);
  else bus.c_status = typed.slice(0, i + 1);
  processEvents();
  const d = cpu() - c0;
  ms += d;
  worst = Math.max(worst, d);
  await Bun.sleep(20);
  processEvents();
}
console.log(JSON.stringify({ msgs: MSGS, mode: MODE, ms_per_key: +(ms / N).toFixed(2), worst_ms: +worst.toFixed(2) }));
process.exit(0);
