/** Directory fields needed to label devices. */
export interface DeviceWorkspace {
  id: string;
  name: string;
  members: readonly { id: string; role: string; image?: string }[];
  pcs: readonly { id: string; owner: string }[];
}

/** PCs belong to their owner's workspace; paired phones use this account's workspace. */
export function deviceWorkspace(device: { key: string; kind: string; here: boolean }, workspaces: readonly DeviceWorkspace[], mine: string): { name: string; photo: string } {
  const pc = workspaces.flatMap((w) => w.pcs).find((p) => p.id === device.key);
  const workspace = device.kind === "android" || device.here
    ? workspaces.find((w) => w.id === mine)
    : workspaces.find((w) => w.members.some((m) => m.id === pc?.owner && m.role === "owner"))
      ?? workspaces.find((w) => w.pcs.some((p) => p.id === device.key));
  const owner = workspace?.members.find((m) => m.role === "owner");
  return { name: workspace?.name ?? "No workspace", photo: owner?.image ?? "" };
}
