/** The device name a PC's own window sends with a request to another PC (api.rs `local_device`). */
export function localDevice(env: Record<string, string | undefined>, hostname: string): string {
  const id = env.HARBOR_MESH_ID;
  return `pc:${id !== undefined && id !== "" ? id : hostname}`;
}

export type FixOutcome = { chat: number } | { toast: string };

/** What a Fix started on another PC came to: its copy here to open, or a line for the toast. */
export function fixOutcome(reply: { status: number; body: unknown }, pc: string): FixOutcome {
  const body = typeof reply.body === "object" && reply.body !== null ? reply.body : {};
  if (reply.status >= 300) {
    const e = Reflect.get(body, "error");
    return { toast: `Couldn't start the chat: ${typeof e === "string" ? e : "it didn't work"}` };
  }
  const id = Reflect.get(body, "id");
  if (typeof id === "number") return { chat: id };
  return { toast: `The chat started on ${pc}. It opens here once it has arrived.` };
}

/** The toast after "Check for updates": the updater's own status line, or why there is none. */
export function updateToast(status: string): string {
  const line = status.trim();
  return line === "" ? "Update check finished" : line.charAt(0).toUpperCase() + line.slice(1);
}

/** The part of the hub's GitHub API a Fix on another PC uses. */
export interface PeerFixer {
  readonly pcName: string;
  issuePeer(url: string, prefer: string | undefined, project: boolean): { name: string } | undefined;
  fixAway(url: string, extra: string, prefer: string | undefined, sender: [name: string, device: string], global: boolean): Promise<{ status: number; body: unknown }>;
}

/** issues.rs `fix_issue_on_peer`: starts the thread on the other PC, then opens its copy here or says what went wrong. */
export async function fixOnPeer(gh: PeerFixer, url: string, extra: string, prefer: string | undefined, device: string, out: { toast: (m: string) => void; open: (chat: number) => void }): Promise<void> {
  const pc = gh.issuePeer(url, prefer, true)?.name ?? "the other PC";
  try {
    const r = fixOutcome(await gh.fixAway(url, extra, prefer, [gh.pcName, device], false), pc);
    if ("chat" in r) out.open(r.chat);
    else out.toast(r.toast);
  } catch (e) {
    out.toast(`Couldn't start the chat: ${e instanceof Error ? e.message : String(e)}`);
  }
}
