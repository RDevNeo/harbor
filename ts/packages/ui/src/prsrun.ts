import { join } from "node:path";
import * as slint from "slint-ui";
import { git } from "@harbor/agents";
import { ghapi, prs } from "@harbor/mcp";
import { dataDir, repoDir, Store } from "@harbor/store";
import { uiDir } from "./assets.ts";
import { appMark } from "./logos.ts";
import { runLoop } from "./loop.ts";
import { busOf } from "./pages/bus.ts";
import { mountPrs, type PrsView } from "./pages/prs.ts";
import { token } from "./theme.ts";

interface PrsWindow extends slint.ComponentHandle {
  dark: boolean;
}

const store = Store.open(dataDir());
const ui = slint.loadFile(join(await uiDir(), "prs.slint"), { style: "fluent" });
const ctor = Reflect.get(ui, "PrsWindow");
if (typeof ctor !== "function") throw new Error("prs.slint has no PrsWindow");
const win: PrsWindow = new ctor();
const bus = busOf<PrsView>(win, "PrsBus");
win.dark = process.env.HTS_LIGHT === undefined;
bus.github = await appMark("github", token("fg", win.dark), win.dark);

const projects: { id: number; name: string; repo: string }[] = [];
for (const r of store.repos()) {
  const origin = await git.origin(repoDir(r));
  const repo = origin === null ? undefined : prs.githubRepo(origin);
  if (repo !== undefined) projects.push({ id: r.id, name: r.name, repo });
}

const handle = mountPrs(bus, {
  projects: () => projects,
  repos: async () => projects.map((p) => p.repo).sort(),
  agentLabel: () => "Claude",
  accounts: () => [{ id: "claude", label: "Claude", current: true }, { id: "codex", label: "Codex", current: false }],
  pickAccount: () => {},
  openUrl: git.openUrl,
  openBrowser: () => {},
  copy: () => {},
  checkout: () => {},
  review: () => {},
  merge: () => {},
  close: () => process.exit(0),
  now: () => Math.floor(Date.now() / 1000),
  notProject: ghapi.NOT_PROJECT,
});

handle.resize(1400 - 256);
const steps = (process.argv[2] ?? "").split(",").filter(Boolean);
if (steps.length > 0) await handle.idle();
for (const step of steps) {
  const [k, v = ""] = step.split("=");
  if (k === "open") {
    const row = [...bus.rows].find((r) => r.kind === "row" && r.url.endsWith(`/${v}`));
    if (row !== undefined) handle.open(row.url);
  } else if (k === "tab") bus.pick_tab(v);
  else if (k === "toggle") bus.detail_toggle(v);
  else if (k === "search") bus.edited(v);
  await handle.idle();
}

// A screenshot aid: HARBOR_POINTER="x,y[,click|rclick|key:text[,secs]];..." moves the pointer and clicks, the way prs.rs's own hook does.
const spec = process.env.HARBOR_POINTER ?? "";
const [t0, win2] = [Date.now(), win.window];
for (const step of spec.split(";").filter(Boolean)) {
  const [x = "0", y = "0", action = "", secs = "1"] = step.split(",");
  setTimeout(() => {
    const position = { x: Number(x), y: Number(y) };
    win2.dispatchEvent({ type: "pointer-moved", position });
    if (action.startsWith("key:")) win2.dispatchEvent({ type: "key-pressed", text: action.slice(4) });
    if (action === "click" || action === "rclick") {
      const button = action === "click" ? "left" : "right";
      win2.dispatchEvent({ type: "pointer-pressed", position, button });
      win2.dispatchEvent({ type: "pointer-released", position, button });
    }
  }, Math.max(0, Number(secs) * 1000 - (Date.now() - t0)));
}

win.show();
await runLoop();
