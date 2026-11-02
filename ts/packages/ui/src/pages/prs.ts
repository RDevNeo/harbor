import { ghdetails, prs } from "@harbor/mcp";
import { attachPrs, type PrsHandle, type PrsHost, type PrsView } from "../prs.ts";

export type { PrsHandle, PrsHost, PrsView };

/** The Pull requests page on the `PrsBus`: GitHub through `gh`, and no mesh to ask another PC's details of. */
export function mountPrs(bus: PrsView, host: PrsHost): PrsHandle {
  return attachPrs(bus, { prs: prs.prsPort, details: ghdetails.detailsPort({ http: () => Promise.reject(new Error("no mesh in this app")) }) }, host);
}
