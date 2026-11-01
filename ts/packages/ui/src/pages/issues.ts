import { ghdetails, issues as ghissues } from "@harbor/mcp";
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
};

/** The Issues page on the `IssuesBus`: GitHub through `gh`, no avatars, no mesh to reach issues on other PCs. */
export function mountIssues(bus: IssuesView, deps: IssuesDeps) {
  const projects = deps.projects;
  const host: IssuesHost = {
    ...deps,
    fetch: (state) => ghissues.fetchIssues(state, projects().map((p) => p.repo)),
    peer: () => undefined,
    details: ghdetails.detailsPort({ http: () => Promise.reject(new Error("no mesh in this app")) }),
    avatar: () => Promise.resolve(null),
    now: () => Math.floor(Date.now() / 1000),
  };
  return attachIssues(bus, host, { close: deps.close, keys: deps.keys, github: deps.github });
}
