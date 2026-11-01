import type { DetailsPort } from "../ghapi.ts";
import { type GhRun, ghRun, type MeshHttp } from "./gh.ts";
import * as issue from "./issuedetail.ts";
import * as pr from "./prdetail.ts";

export interface DetailsDeps {
  http: MeshHttp;
  run?: GhRun;
}

export const detailsPort = (deps: DetailsDeps): DetailsPort => {
  const run = deps.run ?? ghRun;
  return {
    fetchPr: (url) => pr.fetch(url, run),
    fetchIssue: (url) => issue.fetch(url, run),
    fetchIssueRaw: (url) => issue.fetchRaw(url, run),
    fetchIssueOn: (dest, url) => issue.fetchOn(deps.http, dest, url),
    setIssueOpenOn: (dest, url, open) => issue.setOpenOn(deps.http, dest, url, open),
    gh: (args) => pr.gh(args, run),
    parseDiff: pr.parseDiff,
  };
};
