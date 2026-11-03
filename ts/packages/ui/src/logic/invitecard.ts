/** An invitation to a workspace, as the account service lists it (account.ts `AccountPendingInvite`). */
export interface Invite {
  id: string;
  ws_name: string;
  inviter_name: string;
  email: string;
}

/** The main window's invitation card (top right): the first invitation not closed this run, or null. */
export interface InviteCard {
  id: string;
  title: string;
  body: string;
}

export function inviteCard(invites: readonly Invite[], closed: readonly string[]): InviteCard | null {
  const open = invites.filter((i) => !closed.includes(i.id));
  const inv = open[0];
  if (inv === undefined) return null;
  const ws = inv.ws_name === "" ? "a workspace" : inv.ws_name;
  const more = open.length - 1;
  return {
    id: inv.id,
    title: inv.inviter_name === "" ? `You're invited to ${ws}` : `${inv.inviter_name} invited you to ${ws}`,
    body: `Accept to use its PCs and see its chats on all your devices. This PC stays in its own workspace.${more > 0 ? ` ${more} more ${more === 1 ? "invitation waits" : "invitations wait"} in Settings › Workspace.` : ""}`,
  };
}
