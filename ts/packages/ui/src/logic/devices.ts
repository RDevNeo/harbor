/** Directory fields needed to label devices. */
export interface DeviceWorkspace {
  id: string;
  name: string;
  members: readonly { id: string; role: string; image?: string }[];
  pcs: readonly { id: string; owner: string }[];
}

/** Resolve ownership from signed-in account IDs, never a phone display name. */
export function deviceWorkspace(device: { key: string; kind: string; here: boolean; account?: string }, workspaces: readonly DeviceWorkspace[], mine: string): { name: string; photo: string } {
  const pc = workspaces.flatMap((w) => w.pcs).find((p) => p.id === device.key);
  const account = device.kind === "android" ? device.account : pc?.owner;
  const workspace = device.here
    ? workspaces.find((w) => w.id === mine)
    : workspaces.find((w) => w.members.some((m) => account && m.id === account && m.role === "owner"))
      ?? (device.kind === "android" ? undefined : workspaces.find((w) => w.pcs.some((p) => p.id === device.key)));
  const owner = workspace?.members.find((m) => m.role === "owner");
  return { name: workspace?.name ?? "No workspace", photo: owner?.image ?? "" };
}
