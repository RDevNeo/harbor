import type { DiffLine, Note, PrEvent, PrFull, Rgb } from "../ghapi.ts";
import { type GhRun, gh as runGh, ghRun } from "./gh.ts";
import { hexRgb, isoSecs } from "./prs.ts";
import { asArr, asStr, asUint, at } from "./read.ts";

export const FIELDS =
  "number,title,body,url,state,isDraft,author,createdAt,updatedAt,baseRefName,headRefName,additions,deletions,changedFiles," +
  "labels,reviewRequests,latestReviews,reviews,comments,statusCheckRollup,commits,mergeable";

export function gh(args: string[], run: GhRun = ghRun): Promise<string> {
  return runGh(args, run);
}

export async function fetch(url: string, run: GhRun = ghRun): Promise<PrFull> {
  const out = await gh(["pr", "view", url, "--json", FIELDS], run);
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
  return parse(v);
}

export function login(v: unknown): string {
  return asStr(at(v, "login")) ?? asStr(at(v, "name")) ?? "ghost";
}

const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const SKIP = new Set(["SKIPPED", "NEUTRAL", "STALE"]);

export function parse(v: unknown): PrFull {
  const s = (k: string): string => asStr(at(v, k)) ?? "";
  const ts = (x: unknown, k: string): number => isoSecs(asStr(at(x, k)) ?? "") ?? 0;
  const reviewers: [string, string][] = [];
  for (const r of asArr(at(v, "latestReviews"))) {
    const who = login(at(r, "author"));
    if (!reviewers.some((x) => x[0] === who)) reviewers.push([who, asStr(at(r, "state")) ?? ""]);
  }
  for (const r of asArr(at(v, "reviewRequests"))) {
    const who = asStr(at(r, "login")) ?? asStr(at(r, "slug")) ?? asStr(at(r, "name")) ?? "";
    if (who !== "" && !reviewers.some((x) => x[0] === who)) reviewers.push([who, "PENDING"]);
  }
  const checks = asArr(at(v, "statusCheckRollup")).map((c): PrFull["checks"][number] => {
    const concl = asStr(at(c, "conclusion")) ?? asStr(at(c, "state")) ?? "";
    return {
      name: asStr(at(c, "name")) ?? asStr(at(c, "context")) ?? "check",
      url: asStr(at(c, "detailsUrl")) ?? asStr(at(c, "targetUrl")) ?? "",
      state: concl === "SUCCESS" ? "pass" : FAIL.has(concl) ? "fail" : SKIP.has(concl) ? "skipped" : "pending",
    };
  });
  const comments: Note[] = asArr(at(v, "comments")).map((c) => ({ author: login(at(c, "author")), at: ts(c, "createdAt"), body: cleanMd(asStr(at(c, "body")) ?? "") }));
  const timeline: [number, string, PrEvent][] = [[ts(v, "createdAt"), login(at(v, "author")), { kind: "opened" }]];
  for (const c of asArr(at(v, "commits"))) {
    const who = asStr(at(c, "authors", 0, "login")) ?? asStr(at(c, "authors", 0, "name")) ?? "";
    const sha = Array.from(asStr(at(c, "oid")) ?? "").slice(0, 7).join("");
    timeline.push([ts(c, "committedDate"), who, { kind: "commit", sha, headline: asStr(at(c, "messageHeadline")) ?? "" }]);
  }
  for (const r of asArr(at(v, "reviews"))) {
    timeline.push([ts(r, "submittedAt"), login(at(r, "author")), { kind: "review", state: asStr(at(r, "state")) ?? "", body: cleanMd(asStr(at(r, "body")) ?? "") }]);
  }
  for (const c of comments) timeline.push([c.at, c.author, { kind: "comment", body: c.body }]);
  timeline.sort((a, b) => a[0] - b[0]);
  return {
    number: asUint(at(v, "number")) ?? 0,
    title: s("title"),
    url: s("url"),
    state: s("state"),
    draft: at(v, "isDraft") === true,
    author: login(at(v, "author")),
    created: ts(v, "createdAt"),
    updated: ts(v, "updatedAt"),
    base: s("baseRefName"),
    head: s("headRefName"),
    adds: asUint(at(v, "additions")) ?? 0,
    dels: asUint(at(v, "deletions")) ?? 0,
    files: asUint(at(v, "changedFiles")) ?? 0,
    labels: asArr(at(v, "labels")).flatMap((l): [string, Rgb][] => {
      const name = asStr(at(l, "name"));
      return name === undefined ? [] : [[name, hexRgb(asStr(at(l, "color")) ?? "")]];
    }),
    reviewers,
    body: cleanMd(s("body")),
    checks,
    comments,
    timeline,
    conflicting: at(v, "mergeable") === "CONFLICTING",
  };
}

const TAGS = new Set(["div", "a", "img", "picture", "source", "br", "p", "span", "details", "summary", "sub", "sup", "b", "i", "em", "strong", "hr", "center"]);

/** GitHub renders HTML the markdown viewer does not: drops comments and common tags outside code, keeping the text. */
export function cleanMd(s: string): string {
  let out = "";
  let fenced = false;
  let inComment = false;
  for (const line of s.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    if (!inComment && line.trimStart().startsWith("```")) {
      fenced = !fenced;
      out += line;
      continue;
    }
    if (fenced) {
      out += line;
      continue;
    }
    let i = 0;
    let code = false;
    while (i < line.length) {
      if (inComment) {
        const end = line.indexOf("-->", i);
        if (end < 0) break;
        i = end + 3;
        inComment = false;
        continue;
      }
      const c = line[i] ?? "";
      if (c === "`") {
        code = !code;
      } else if (!code && line.startsWith("<!--", i)) {
        inComment = true;
        i += 4;
        continue;
      } else if (!code && c === "<") {
        const name = /^[A-Za-z0-9]*/.exec(line.slice(i + 1).replace(/^\/+/, ""))?.[0]?.toLowerCase() ?? "";
        const end = line.indexOf(">", i);
        if (TAGS.has(name) && end >= 0) {
          i = end + 1;
          continue;
        }
      }
      out += c;
      i += 1;
    }
  }
  return out;
}

function lines(d: string): string[] {
  const l = d.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l.map((x) => (x.endsWith("\r") ? x.slice(0, -1) : x));
}

export function parseDiff(d: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file: Extract<DiffLine, { t: "file" }> | undefined;
  let inHunk = false;
  for (const l of lines(d)) {
    if (l.startsWith("diff --git ")) {
      const rest = l.slice("diff --git ".length);
      const cut = rest.lastIndexOf(" b/");
      file = { t: "file", path: cut < 0 ? rest : rest.slice(cut + 3), adds: 0, dels: 0 };
      out.push(file);
      inHunk = false;
    } else if (l.startsWith("@@")) {
      out.push({ t: "hunk", text: l });
      inHunk = true;
    } else if (!inHunk) {
      // index, ---, +++ and mode lines
    } else if (l.startsWith("+")) {
      out.push({ t: "add", text: l.slice(1) });
      if (file) file.adds += 1;
    } else if (l.startsWith("-")) {
      out.push({ t: "del", text: l.slice(1) });
      if (file) file.dels += 1;
    } else if (!l.startsWith("\\")) {
      out.push({ t: "ctx", text: l.startsWith(" ") ? l.slice(1) : l });
    }
  }
  return out;
}

export function repoOf(url: string): string {
  const rest = url.startsWith("https://github.com/") ? url.slice("https://github.com/".length) : url;
  return rest.split("/pull/")[0] ?? "";
}
