import { type ghapi, ghdetails, issues as ghissues } from "@harbor/mcp";
import { attachIssues, type IssuesView } from "../issues.ts";
import type { IssuesHost } from "../logic/issues.ts";
import type { Keys } from "../logic/keys.ts";
import type { Pixels } from "../logos.ts";

export type { IssuesView };

/** What the page asks of its host beyond GitHub: the projects, the agent a fix runs with, the system and the page's way out. */
export type IssuesDeps = Pick<IssuesHost, "projects" | "agentLabel" | "agents" | "pickAgent" | "fix" | "openUrl" | "browse" | "copy"> & {
  close: () => void;
  keys: Keys;
  github: Pixels;
  /** The hub's GitHub API, which merges in the other PCs' Issues; without it the page lists this PC's own through `gh`. */
  gh: ghapi.GhApi | null;
};

/** The Issues page on the `IssuesBus`: GitHub through `gh` and, with the hub's API, the mesh's PCs; no avatars. */
export function mountIssues(bus: IssuesView, deps: IssuesDeps) {
  const { gh, projects } = deps;
  let page: ReturnType<typeof attachIssues> | null = null;
  const host: IssuesHost = {
    ...deps,
    fetch: gh === null ? (state) => ghissues.fetchIssues(state, projects().map((p) => p.repo)) : (state) => gh.mergedIssues(state, true),
    peer: (issue, project) => {
      const p = gh?.issuePeer(issue.url, page?.filters.account, project);
      return p === undefined ? undefined : { name: p.name, dest: p.dest };
    },
    details: gh?.details ?? ghdetails.detailsPort({ http: () => Promise.reject(new Error("no mesh in this app")) }),
    avatar: () => Promise.resolve(null),
    now: () => Math.floor(Date.now() / 1000),
  };
  page = attachIssues(bus, host, { close: deps.close, keys: deps.keys, github: deps.github });
  return page;
}
