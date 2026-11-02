import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentModes,
  type Entry,
  type Local,
  type SlashChat,
  accessAfter,
  entries,
  entryJson,
  expand,
  expands,
  front,
  localAlias,
  parseInitialize,
  replace,
  scan,
  search,
  word,
} from "../src/logic/slash.ts";

// providers.rs: effort levels and access levels per agent.
const CLAUDE: AgentModes = { efforts: ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"], access: ["full", "edits", "plan"] };
const CODEX: AgentModes = { efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], access: ["full", "edits", "plan"] };
const OPENCODE: AgentModes = { efforts: [], access: ["full"] };

function local(name: string, skill: boolean, body: string): Local {
  return { name, description: `${name} does things`, body, skill: skill ? `/s/${name}` : null };
}

function cliEntry(name: string, aliases: string[], description: string, hint: string, scope: "builtin" | "plugin"): Entry {
  return { name, aliases, description, hint, scope, command: null, skill: false };
}

test("front_matter", () => {
  expect(front("---\ndescription: Do it\n---\nBody $ARGUMENTS\n")).toEqual({ name: "", description: "Do it", body: "Body $ARGUMENTS\n" });
  expect(front("---\r\nname: \"x-y\"\r\ndescription: >\r\n  Folded\r\n  over lines\r\nother: 1\r\n---\r\nText\r\n")).toEqual({ name: "x-y", description: "Folded over lines", body: "Text\n" });
  expect(front("No front matter")).toEqual({ name: "", description: "", body: "No front matter" });
});

test("scans_commands_and_skills", () => {
  const base = join(tmpdir(), `harbor-slash-${process.pid}`);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, "commands/fe"), { recursive: true });
  mkdirSync(join(base, "skills/folder"), { recursive: true });
  mkdirSync(join(base, "skills/empty"), { recursive: true });
  writeFileSync(join(base, "commands/fe/comp.md"), "---\ndescription: Make one\n---\nBuild $ARGUMENTS\n");
  writeFileSync(join(base, "commands/top.md"), "# Top title\nbody\n");
  writeFileSync(join(base, "skills/folder/SKILL.md"), "---\nname: named\ndescription: A skill\n---\nSteps\n");
  const v = scan(base);
  expect(v.map((l) => [l.name, l.description, l.skill !== null])).toEqual([
    ["fe:comp", "Make one", false],
    ["top", "Top title", false],
    ["named", "A skill", true],
  ]);
  const skill = v[2];
  expect(skill === undefined ? null : localAlias(skill)).toBe("folder");
  rmSync(base, { recursive: true });
});

test("finds_the_word_at_the_cursor", () => {
  expect(word("/co", 3)).toEqual({ start: 0, end: 3, query: "co", first: true });
  expect(word("/compact now", 4)).toEqual({ start: 0, end: 8, query: "com", first: true });
  expect(word("fix it /rev", 11)).toEqual({ start: 7, end: 11, query: "rev", first: false });
  expect(word("  /x", 4)?.first).toBe(true);
  expect(word("/", 1)?.query).toBe("");
  expect(word("a/b", 3)).toBeNull();
  expect(word("/compact ", 9)).toBeNull();
  expect(word("/x", 0)).toBeNull();
});

test("replaces_the_word", () => {
  const at = (text: string, cursor: number) => {
    const w = word(text, cursor);
    if (w === null) throw new Error(`no word in ${text}`);
    return w;
  };
  expect(replace("/co", at("/co", 3), "/compact")).toEqual({ text: "/compact ", cursor: 9 });
  expect(replace("/co more", at("/co more", 2), "/compact")).toEqual({ text: "/compact more", cursor: 9 });
  expect(replace("/mod hello", at("/mod hello", 3), "")).toEqual({ text: "hello", cursor: 0 });
  expect(replace("é /sk", at("é /sk", 5), "/skill")).toEqual({ text: "é /skill ", cursor: 9 });
});

test("lists_by_agent", () => {
  const cli = [
    cliEntry("compact", [], "Free up context", "", "builtin"),
    cliEntry("clear", ["reset"], "New session", "", "builtin"),
    cliEntry("vercel:deploy", [], "(vercel) Deploy", "", "plugin"),
    cliEntry("mine", [], "Mine", "", "plugin"),
  ];
  const personal = [local("mine", true, "Do mine"), local("fresh", false, "New")];
  const project = [local("proj", false, "P")];
  const names = (v: Entry[]) => v.map((e) => [e.name, e.scope, e.command, e.skill]);
  // Claude here: its list, the user's files marked, newer files added; /clear hidden.
  expect(names(entries(CLAUDE, false, "full", null, cli, project, personal))).toEqual([
    ["model", "harbor", "model", false],
    ["effort", "harbor", "effort", false],
    ["plan", "harbor", "plan", false],
    ["compact", "builtin", null, false],
    ["vercel:deploy", "plugin", null, false],
    ["mine", "personal", null, true],
    ["proj", "project", null, false],
    ["fresh", "personal", null, false],
  ]);
  // On another device: built-ins, and this PC's files (inlined), no plugins.
  expect(entries(CLAUDE, true, "plan", null, cli, project, personal).map((e) => e.name)).toEqual(["model", "effort", "default", "compact", "proj", "mine", "fresh"]);
  // Other agents: the files only; no /plan where there's no read-only mode.
  expect(entries(OPENCODE, false, "full", null, null, project, personal).map((e) => e.name)).toEqual(["model", "proj", "mine", "fresh"]);
});

test("ranks_and_filters", () => {
  const personal = [local("code-review", true, ""), local("review-pr", false, ""), local("deploy", false, "")];
  const all = entries(CODEX, false, "full", null, null, [], personal);
  const find = (text: string) => {
    const w = word(text, Array.from(text).length);
    if (w === null) throw new Error(`no word in ${text}`);
    return search(all, w).map((e) => e.name);
  };
  expect(find("/review")).toEqual(["review-pr", "code-review"]);
  expect(find("/dpl")).toEqual(["deploy"]);
  expect(find("/zzz")).toEqual([]);
  expect(find("/")).toEqual(["model", "plan", "effort", "code-review", "deploy", "review-pr"]);
  // After other words: no commands, only skills (and Harbor's).
  expect(find("look at /rev")).toEqual(["code-review"]);
  // Descriptions match too, after names.
  expect(find("/model")).toEqual(["model"]);
  expect(find("/things")).toEqual(["code-review", "deploy", "review-pr"]);
});

test("expands_for_other_agents", () => {
  const locals = [local("fix", false, "Fix $ARGUMENTS now"), local("plain", false, "Plain body"), local("style", true, "Write well")];
  expect(expand("/fix the bug", locals)).toBe("Fix the bug now");
  expect(expand("/plain x y", locals)).toBe("Plain body\n\nArguments: x y");
  expect(expand("/unknown thing", locals)).toBe("/unknown thing");
  expect(expand("no commands here", locals)).toBe("no commands here");
  const out = expand("please /style this, /style", locals);
  expect(out.startsWith("[skill /style: follow it for this message. Its other files are in /s/style]\n\nWrite well\n\n---\n\nplease /style this")).toBe(true);
  expect(out.split("Write well").length - 1).toBe(1);
});

test("the_phones_list", () => {
  const cli = [cliEntry("compact", ["c"], "Free up context", "<instructions>", "builtin"), cliEntry("vercel:deploy", [], "(vercel) Deploy", "", "plugin")];
  const v = entries(CLAUDE, false, "full", null, cli, [local("proj", false, "P")], [local("mine", true, "M")]).map(entryJson);
  const row = (i: number) => {
    const r = v[i];
    return r === undefined ? null : [r.name, r.source, r.badge, r.skill];
  };
  expect(row(0)).toEqual(["model", "harbor", "Harbor", false]);
  expect(v[0]?.command).toBe("model");
  expect(row(1)).toEqual(["effort", "harbor", "Harbor", false]);
  expect(v[1]?.command).toBe("effort");
  expect(row(2)).toEqual(["plan", "harbor", "Harbor", false]);
  expect(v[2]?.command).toBe("plan");
  expect(row(3)).toEqual(["compact", "builtin", "Built-in", false]);
  expect([v[3]?.hint, v[3]?.aliases, v[3]?.command]).toEqual(["<instructions>", ["c"], null]);
  expect(row(4)).toEqual(["vercel:deploy", "plugin", "Plugin", false]);
  expect(row(5)).toEqual(["proj", "project", "Project command", false]);
  expect(row(6)).toEqual(["mine", "personal", "Personal skill", true]);
  expect(v[6]?.description).toBe("mine does things");
  // A chat in read-only mode gets /default instead of /plan.
  const plan = entries(CLAUDE, false, "plan", null, null, [], [])[2];
  expect(plan === undefined ? null : entryJson(plan).command).toBe("default");
});

test("a_chats_own_commands", () => {
  const names = (c: SlashChat | null) => entries(CLAUDE, false, "full", c, null, [], []).map((e) => entryJson(e).command ?? "");
  // The draft: no chat to fork, settle or clear yet.
  expect(names(null)).toEqual(["model", "effort", "plan"]);
  expect(names({ forkable: true, settled: false, queued: true })).toEqual(["model", "effort", "plan", "new", "fork", "settle", "clear-queue"]);
  // Nothing to fork after, settled already, nothing waiting.
  expect(names({ forkable: false, settled: true, queued: false })).toEqual(["model", "effort", "plan", "new"]);
});

test("plan_and_back", () => {
  expect(accessAfter("plan", CLAUDE, null)).toBe("plan");
  expect(accessAfter("default", CLAUDE, "ask")).toBe("ask");
  // Nothing remembered (another device did /plan, or Harbor restarted): the provider's first level.
  expect(accessAfter("default", CLAUDE, null)).toBe(CLAUDE.access[0] ?? "");
  expect(accessAfter("default", CLAUDE, "plan")).toBe(CLAUDE.access[0] ?? "");
});

test("who_gets_commands_expanded", () => {
  // Claude Code here expands them itself; other agents and Claude on another device get the text.
  expect(expands("claude", "")).toBe(false);
  expect(expands("claude", "ts:pc-a")).toBe(true);
  expect(expands("codex", "")).toBe(true);
  expect(expands(null, "")).toBe(true);
});

test("reads_claude_codes_list", () => {
  const line =
    '{"type":"control_response","response":{"subtype":"success","request_id":"harbor-slash","response":{"commands":[{"name":"compact","description":"Free up context","argumentHint":"<instructions>","builtin":true},{"name":"top","description":"Top body (project)","argumentHint":"","aliases":["t"]}]}}}';
  const v = parseInitialize(line);
  expect(v?.[0]).toEqual(cliEntry("compact", [], "Free up context", "<instructions>", "builtin"));
  expect([v?.[1]?.description, v?.[1]?.scope, v?.[1]?.aliases]).toEqual(["Top body", "plugin", ["t"]]);
  expect(parseInitialize('{"type":"system","subtype":"init"}')).toBeNull();
});
