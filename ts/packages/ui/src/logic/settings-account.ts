import { agoShort, inviteNote, short as keyShort, type AccountDir, type AccountDirectory, type AccountPendingInvite, type AccountStatus, type AccountUser } from "@harbor/net";
import { ICONS } from "../icons.ts";
import { badge, btn, copy, field, form, gap, list, row, rows, status, title, type Block, type BlockRow, type BlockTab } from "./settings-blocks.ts";

/** The part of `AccountService` this tab reads and presses. */
export interface AccountPort {
  status(): AccountStatus;
  account(): AccountUser | null;
  invites(): AccountPendingInvite[];
  workspace(): string;
  directory(): AccountDirectory;
  configured(): boolean;
  signIn(): Promise<void>;
  cancelSignIn(): void;
  signOut(): void;
  chooseWorkspace(ws: string): Promise<void>;
  leaveWorkspace(): Promise<void>;
  invite(ws: string, email: string): Promise<void>;
  acceptInvite(id: string): Promise<void>;
  declineInvite(id: string): Promise<void>;
  cancelInvite(ws: string, id: string): Promise<void>;
  removeMember(ws: string, user: string): Promise<void>;
}

export interface AccountHost {
  account: AccountPort;
  /** This PC's TLS key. */
  myFp(): string;
  /** Keys of the workspace's PCs this PC is linked to now. */
  onlineFps(): ReadonlySet<string>;
  openUrl(url: string): void;
  /** Unix seconds. */
  now(): number;
}

const SIGN_OUT_TIP = "Signs this PC out. It stays in its workspace, so its people's phones and PCs keep reaching it.";
const ACCEPT_TIP = "Join this workspace: its PCs and chats reach you on every device. This PC stays in its workspace.";

const roleBadge = (owner: boolean) => badge(owner ? "Owner" : "Member");

/** accountui.rs `account_tab`. */
export function accountBlocks(host: AccountHost): Block[] {
  const acc = host.account;
  const st = acc.status();
  const ago = (t: number) => (agoShort(t, host.now()) === "now" ? "just now" : `${agoShort(t, host.now())} ago`);
  const out: Block[] = banners(st, acc.account() !== null, ago);
  const me = acc.account();
  if (!me) {
    out.push(
      rows([
        row("Sign in with Google", {
          desc: "Every PC and phone signs in. Your PCs find each other through your workspace, and settings follow your account.",
          buttons: [st.signingIn ? btn("cancel", "Cancel") : btn("signin", "Sign in", { variant: "primary" })],
        }),
      ]),
    );
    if (st.signingIn && st.url !== "") out.push(status(badge(""), "Waiting for the browser.", { before: 14, buttons: [btn("open_page", "Open the page again")] }));
    if (!acc.configured()) out.push(copy("This build of Harbor has no account service set up (a development build).", 12, { before: 14 }));
    return out;
  }
  const who = me.name === "" ? me.email : me.name;
  out.push(rows([row(who, { desc: `${me.email} · signed in with Google. To use another account, sign out and sign in again.`, buttons: [btn("signout", "Sign out", { variant: "destructive", tip: SIGN_OUT_TIP })] })]));

  const pending = acc.invites();
  if (pending.length > 0) {
    out.push(title("Invitations"));
    out.push(
      list(
        pending.map((inv) =>
          row(inv.ws_name === "" ? "A workspace" : inv.ws_name, {
            icon: ICONS.USERS,
            line: `${inv.inviter_name === "" ? "" : `${inv.inviter_name} invited `}${inv.email} · ${ago(inv.at)}`,
            buttons: [btn(`accept:${inv.id}`, "Accept", { variant: "primary", tip: ACCEPT_TIP, enabled: !st.busy }), btn(`decline:${inv.id}`, "Decline", { variant: "destructive", enabled: !st.busy })],
          }),
        ),
        "",
      ),
    );
  }

  const ws = acc.workspace();
  const dir = acc.directory();
  out.push(title("This PC's workspace"));
  if (st.pick || ws === "") {
    out.push(copy("Pick the workspace this PC belongs to: its people get all of this PC's chats.", 14));
    out.push(
      list(
        me.workspaces.map((w) => row(w.name, { icon: ICONS.USERS, badges: [roleBadge(w.role === "owner")], buttons: [btn(`use:${w.id}`, "Use this one", { variant: "primary", enabled: !st.busy })] })),
        "",
        { before: 14 },
      ),
    );
    return out;
  }
  const here: AccountDir | undefined = dir.workspaces.find((w) => w.id === ws);
  const name = here?.name ?? me.workspaces.find((w) => w.id === ws)?.name ?? "";
  const owner = here?.role === "owner";
  const lines: BlockRow[] = [row(name, { desc: "Everyone in this workspace controls all of its PCs and sees all of their chats, from their own PCs and phones.", badges: [roleBadge(owner)] })];
  lines.push(row("Take this PC out", { desc: "It leaves the workspace: its people's phones and PCs stop reaching it.", buttons: [btn("leave_pc", "Take out", { variant: "destructive", enabled: !st.busy })] }));
  out.push(rows(lines));
  if (!here) {
    out.push(copy("Fetching the workspace…", 13, { before: 14 }));
    return out;
  }

  out.push(title("People"));
  out.push(
    list(
      here.members.map((m) => {
        const self = m.id === me.id;
        const buttonsOf = [];
        if (owner && !self) buttonsOf.push(btn(`remove:${m.id}`, "Remove", { variant: "destructive", enabled: !st.busy }));
        if (self && !here.personal) buttonsOf.push(btn(`remove:${m.id}`, "Leave", { variant: "destructive", enabled: !st.busy }));
        return row(`${m.name === "" ? m.email : m.name}${self ? " (you)" : ""}`, { icon: ICONS.USER_ROUND, line: m.email, side: [roleBadge(m.role === "owner")], buttons: buttonsOf });
      }),
      "",
    ),
  );
  if (owner) {
    out.push(form("invite", [field("email", "name@example.com", { width: 260 })], btn("invite", "Invite", { icon: ICONS.PLUS, variant: "primary", enabled: !st.busy }), { before: 16 }));
    out.push(
      copy(
        "They'll see the invitation in Harbor when they sign in with that Google account, on a PC or phone (no email is sent). Once they accept, they have full control of this workspace's PCs and chats. Only owners invite and remove people.",
        12,
        { before: 12 },
      ),
    );
    here.invites.forEach((inv, i) => out.push(status(badge(""), `Invited ${inv.email} · ${ago(inv.at)}${inviteNote(inv)}`, { before: i === 0 ? 14 : 8, buttons: [btn(`cancel_invite:${inv.id}`, "", { icon: ICONS.X, variant: "muted", tip: "Cancel the invitation", enabled: !st.busy })] })));
  }

  out.push(title("PCs"));
  const mine = host.myFp();
  const online = host.onlineFps();
  out.push(
    list(
      here.pcs.map((p) => {
        const by = p.owner_name === "" ? "" : ` · added by ${p.owner_name}`;
        const v = p.version === "" ? "" : ` · Harbor ${p.version}`;
        const badges = p.fp === mine ? [badge("This PC", "green")] : online.has(p.fp) ? [badge("Online", "green")] : [];
        return row(p.name, { icon: ICONS.MONITOR, lead: 32, badges, line: `key ${keyShort(p.fp)}${by}${v} · checked in ${ago(p.seen)}` });
      }),
      "None yet.",
    ),
  );

  const rest = dir.workspaces.filter((x) => x.id !== ws);
  if (rest.length > 0) {
    out.push(title("Your other workspaces"));
    out.push(
      list(
        rest.map((o) =>
          row(o.name, {
            icon: ICONS.USERS,
            line: `${o.members.length} people · ${o.pcs.length} PCs`,
            side: [roleBadge(o.role === "owner")],
            buttons: o.personal ? [] : [btn(`leave:${o.id}`, "Leave", { variant: "destructive", enabled: !st.busy })],
          }),
        ),
        "",
      ),
    );
  }
  return out;
}

/** Sign-in ran out, the service can't be reached, an error: above the page. */
function banners(st: AccountStatus, signedIn: boolean, ago: (t: number) => string): Block[] {
  const out: Block[] = [];
  const before = () => ({ before: out.length > 0 ? 8 : 0 });
  if (st.expired && signedIn) {
    out.push(status(badge("Sign in again", "amber"), "Your sign-in ran out. Everything keeps working here; sign in again to sync settings and the workspace.", { buttons: st.signingIn ? [] : [btn("signin", "Sign in", { variant: "primary" })] }));
  }
  if (st.offlineSince > 0) out.push(status(badge("Offline"), `The account service hasn't answered since ${ago(st.offlineSince)}: working with what this PC has cached.`, before()));
  if (st.error !== "") out.push(status(badge("Account", "red"), st.error, before()));
  if (st.syncedAt > 0) out.push(copy(`Synced ${ago(st.syncedAt)}.`, 12, before()));
  if (out.length > 0) out.push(gap(10));
  return out;
}

/** The tab's controls over `host`. */
export function accountTab(host: AccountHost): BlockTab {
  const acc = host.account;
  const press = (key: string): void => {
    const at = key.indexOf(":");
    const verb = at < 0 ? key : key.slice(0, at);
    const id = at < 0 ? "" : key.slice(at + 1);
    const busy = acc.status().busy;
    const dir = acc.directory().workspaces.find((w) => w.id === acc.workspace());
    const me = acc.account();
    if (key === "signin") void acc.signIn();
    else if (key === "cancel") acc.cancelSignIn();
    else if (key === "signout") acc.signOut();
    else if (key === "open_page") host.openUrl(acc.status().url);
    else if (busy) return;
    else if (key === "leave_pc") void acc.leaveWorkspace();
    else if (verb === "accept") void acc.acceptInvite(id);
    else if (verb === "decline") void acc.declineInvite(id);
    else if (verb === "use" || verb === "move") void acc.chooseWorkspace(id);
    else if (verb === "remove" && dir) void acc.removeMember(dir.id, id);
    else if (verb === "leave" && me) void acc.removeMember(id, me.id);
    else if (verb === "cancel_invite" && dir) void acc.cancelInvite(dir.id, id);
  };
  return {
    blocks: () => accountBlocks(host),
    pressed: press,
    toggled: () => {},
    edited: () => {},
    submitted(key, values) {
      const email = (values[0] ?? "").trim().toLowerCase();
      const dir = acc.directory().workspaces.find((w) => w.id === acc.workspace());
      if (key === "invite" && dir && email.includes("@") && !acc.status().busy) void acc.invite(dir.id, email);
      return "";
    },
  };
}
