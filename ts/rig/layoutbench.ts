// Which Slint construct keeps a growing column of wrapped text cheap: bun rig/layoutbench.ts VARIANT [BLOCKS].
// Each update changes the last of BLOCKS paragraphs in a Flickable column; prints ms of CPU per update.
import * as slint from "slint-ui";
import { processEvents } from "slint-ui/rust-module.cjs";
import { join } from "node:path";
import { mdBlocks } from "../packages/ui/src/cards.ts";
import type { MdBlockData } from "../packages/ui/src/window.ts";

const ROW: Record<string, string> = {
  plain: `for b in root.blocks: Text { text: b; wrap: word-wrap; font-size: 16px; }`,
  fixed: `for b in root.blocks: Rectangle { height: t.preferred-height; t := Text { width: parent.width; text: b; wrap: word-wrap; font-size: 16px; } }`,
  prop: `for b in root.blocks: Rectangle { property <length> h: t.preferred-height; height: h; t := Text { width: parent.width; text: b; wrap: word-wrap; font-size: 16px; } }`,
  sized: `for b in root.blocks: Rectangle { property <length> h: t.preferred-height; min-height: h; max-height: h; t := Text { y: 0; width: parent.width; height: h; text: b; wrap: word-wrap; font-size: 16px; } }`,
  nested: `for b in root.blocks: VerticalLayout { if true: VerticalLayout { Text { text: b; wrap: word-wrap; font-size: 16px; } } }`,
  nestedfixed: `for b in root.blocks: Rectangle { property <length> h: l.preferred-height; height: h; l := VerticalLayout { width: parent.width; height: parent.height; if true: VerticalLayout { Text { text: b; wrap: word-wrap; font-size: 16px; } } } }`,
  sizednested: `for b in root.blocks: Rectangle { property <length> h: l.preferred-height; min-height: h; max-height: h; l := VerticalLayout { y: 0; width: parent.width; height: h; if true: VerticalLayout { Text { text: b; wrap: word-wrap; font-size: 16px; } } } }`,
  sizedinner: `for b in root.blocks: VerticalLayout { if true: Rectangle { property <length> h: l.preferred-height; min-height: h; max-height: h; l := VerticalLayout { y: 0; width: parent.width; height: h; if true: VerticalLayout { Text { text: b; wrap: word-wrap; font-size: 16px; } } } } }`,
  md: `for b in root.md: MdBlockView { block: b; size: 16px; }`,
  mdsized: `for b in root.md: Rectangle { property <length> h: v.preferred-height; min-height: h; max-height: h; v := MdBlockView { y: 0; width: parent.width; height: h; block: b; size: 16px; } }`,
};
const variant = process.argv[2] ?? "plain";
const BLOCKS = Number(process.argv[3] ?? 40);
const src = `
import { MdBlock, MdBlockView } from "markdown.slint";
export component W inherits Window {
  width: 800px; height: 700px;
  in property <[string]> blocks;
  in property <[MdBlock]> md;
  public function end() { list.viewport-y = min(0px, list.height - col.preferred-height); }
  list := Flickable {
    viewport-height: col.preferred-height;
    col := VerticalLayout { width: 760px; alignment: start; ${ROW[variant]} }
  }
}`;
const ui = slint.loadSource(src, join(import.meta.dir, "../packages/ui/slint/bench.slint")) as Record<string, unknown>;
const W = ui.W as new () => { blocks: slint.Model<string>; md: slint.Model<MdBlockData>; show(): void; end(): void };
const w = new W();
const words = "the quick brown fox jumps over the lazy dog while harbor keeps every chat in sync".split(" ");
const para = (n: number) => Array.from({ length: n }, (_, i) => words[i % words.length]).join(" ");
const m = new slint.ArrayModel<string>(Array.from({ length: BLOCKS }, () => para(60)));
w.blocks = m;
const mdOf = (n: number) => mdBlocks(para(n), 1)[0] as MdBlockData;
const mm = new slint.ArrayModel<MdBlockData>(Array.from({ length: BLOCKS }, () => mdOf(60)));
w.md = mm;
w.show();
const cpu = () => {
  const c = process.cpuUsage();
  return (c.user + c.system) / 1000;
};
for (let i = 0; i < 20; i++) {
  processEvents();
  await Bun.sleep(16);
}
let ms = 0;
const N = 100;
for (let i = 0; i < N; i++) {
  const c0 = cpu();
  if (variant.startsWith("md")) mm.setRowData(BLOCKS - 1, mdOf(1 + (i % 60)));
  else m.setRowData(BLOCKS - 1, para(1 + (i % 60)));
  w.end();
  processEvents();
  ms += cpu() - c0;
  await Bun.sleep(20);
  processEvents();
}
console.log(JSON.stringify({ variant, blocks: BLOCKS, ms_per_update: +(ms / N).toFixed(2) }));
process.exit(0);
