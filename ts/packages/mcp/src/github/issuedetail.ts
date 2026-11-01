import { urlEncode } from "@harbor/net";
import type { Dest, IssueFull, IssueState, Rgb } from "../ghapi.ts";
import { GH_TIMEOUT, type GhRun, ghRun, type MeshHttp } from "./gh.ts";
import { cleanMd, gh, login } from "./prdetail.ts";
import { hexRgb, isoSecs } from "./prs.ts";
import { asArr, asStr, asUint, at } from "./read.ts";

export const FIELDS = "number,title,body,url,state,stateReason,author,createdAt,updatedAt,labels,assignees,milestone,comments";

export function stateOf(state: string, reason: string): IssueState {
  if (state.toUpperCase() === "OPEN") return "open";
  const r = reason.toUpperCase();
  return r === "NOT_PLANNED" || r === "DUPLICATE" ? "not_planned" : "done";
}

export async function fetch(url: string, run: GhRun = ghRun): Promise<IssueFull> {
  return parse(await fetchRaw(url, run));
}

/** `gh issue view` as JSON (what another PC asks for: `GET /mesh/v1/issues/view`). */
export async function fetchRaw(url: string, run: GhRun = ghRun): Promise<unknown> {
  const out = await gh(["issue", "view", url, "--json", FIELDS], run);
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
}

const answered = (status: number, v: unknown): Error => new Error(asStr(at(v, "error")) ?? `the other PC answered ${status}`);

export async function fetchOn(http: MeshHttp, dest: Dest, url: string): Promise<IssueFull> {
  const [status, v] = await http(dest, "GET", `/mesh/v1/issues/view?url=${urlEncode(url)}`, undefined, GH_TIMEOUT);
  if (status !== 200) throw answered(status, v);
  return parse(v);
}

export async function setOpenOn(http: MeshHttp, dest: Dest, url: string, open: boolean): Promise<void> {
  const [status, v] = await http(dest, "POST", `/mesh/v1/issues/${open ? "reopen" : "close"}?url=${urlEncode(url)}`, {}, GH_TIMEOUT);
  if (status !== 200) throw answered(status, v);
}

export function parse(v: unknown): IssueFull {
  const s = (k: string): string => asStr(at(v, k)) ?? "";
  const ts = (x: unknown, k: string): number => isoSecs(asStr(at(x, k)) ?? "") ?? 0;
  const milestone = asStr(at(v, "milestone", "title"));
  return {
    number: asUint(at(v, "number")) ?? 0,
    title: s("title"),
    url: s("url"),
    state: stateOf(s("state"), s("stateReason")),
    author: login(at(v, "author")),
    created: ts(v, "createdAt"),
    updated: ts(v, "updatedAt"),
    labels: asArr(at(v, "labels")).flatMap((l): [string, Rgb][] => {
      const name = asStr(at(l, "name"));
      return name === undefined ? [] : [[name, hexRgb(asStr(at(l, "color")) ?? "")]];
    }),
    assignees: asArr(at(v, "assignees")).map(login),
    milestone: milestone === undefined || milestone === "" ? null : milestone,
    body: cleanMd(s("body")),
    comments: asArr(at(v, "comments")).map((c) => ({ author: login(at(c, "author")), at: ts(c, "createdAt"), body: cleanMd(asStr(at(c, "body")) ?? "") })),
  };
}

export function repoOf(url: string): string {
  const rest = url.startsWith("https://github.com/") ? url.slice("https://github.com/".length) : url;
  return rest.split("/issues/")[0] ?? "";
}
