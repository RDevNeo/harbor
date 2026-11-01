import { join } from "node:path";
import * as slint from "slint-ui";
import { git } from "@harbor/agents";
import { dataDir, repoDir, Store } from "@harbor/store";
import { uiDir } from "./assets.ts";
import { Keys } from "./logic/keys.ts";
import { appMark } from "./logos.ts";
import { runLoop } from "./loop.ts";
import { busOf } from "./pages/bus.ts";
import { type IssuesView, mountIssues } from "./pages/issues.ts";
import { token } from "./theme.ts";

interface IssuesWindow extends slint.ComponentHandle {
  dark: boolean;
}

const store = Store.open(dataDir());
const ui = slint.loadFile(join(await uiDir(), "issues.slint"), { style: "fluent" });
const ctor = Reflect.get(ui, "IssuesWindow");
if (typeof ctor !== "function") throw new Error("issues.slint has no IssuesWindow");
const win: IssuesWindow = new ctor();
const bus = busOf<IssuesView>(win, "IssuesBus");
win.dark = process.env.HTS_LIGHT === undefined;

async function remote(dir: string): Promise<string | undefined> {
  const p = Bun.spawn(["git", "-C", dir, "remote", "get-url", "origin"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 ? out : undefined;
}

const projects: { id: number; name: string; repo: string }[] = [];
for (const r of store.repos()) {
  const url = await remote(repoDir(r));
  const slug = url === undefined ? undefined : githubOf(url);
  if (slug !== undefined) projects.push({ id: r.id, name: r.name, repo: slug });
}

function githubOf(url: string): string | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m === null ? undefined : `${m[1]}/${m[2]}`;
}

const github = await appMark("github", token("fg", win.dark), win.dark);
const page = mountIssues(bus, {
  projects: () => projects,
  agentLabel: () => "Claude",
  agents: () => [{ id: "claude", label: "Claude", current: true }],
  pickAgent: () => {},
  fix: (project, issue, ask) => console.error(`fix ${issue.url} in ${project} ask=${ask}`),
  openUrl: git.openUrl,
  browse: git.openUrl,
  copy: (text) => {
    const p = Bun.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    p.stdin.write(text);
    void p.stdin.end();
  },
  close: () => process.exit(0),
  keys: Keys.load(store),
  github,
});

// argv[2]: steps like `open=142,menu=filters,sub=state,search=bug,state=closed`, run once the list is there.
const steps = (process.argv[2] ?? "").split(",").filter(Boolean);
const started = Date.now();
const pick = <T extends string>(v: string, of: readonly T[]): T | undefined => of.find((x) => x === v);
const timer = setInterval(() => {
  if (page.data === null && Date.now() - started < 15000) return;
  clearInterval(timer);
  for (const step of steps) {
    const [k, v = ""] = step.split("=");
    if (k === "open") {
      const i = page.fetchedList().items.find((x) => String(x.number) === v);
      if (i !== undefined) page.open(i.url);
    } else if (k === "menu") {
      const m = pick(v, ["sort", "filters", "provider"] as const);
      if (m) page.toggleMenu(m);
    } else if (k === "sub") {
      page.sub = pick(v, ["account", "state", "involvement", "author", "assignee", "labels", "milestone", "project"] as const) ?? null;
      page.changed();
    } else if (k === "search") {
      page.search = v;
      bus.search = v;
      page.changed();
    } else if (k === "state") {
      page.filters.state = pick(v, ["all", "open", "closed"] as const) ?? page.filters.state;
      page.load();
    }
  }
}, 200);
win.show();
await runLoop();
