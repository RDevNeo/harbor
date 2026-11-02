import { ICONS } from "../icons.ts";

/**
 * A project row's menu (sidebar.rs `project_menu`): the desktop's right-click popup and the
 * phone's project sheet are both built from this list, so they offer the same things in the
 * same order with the same words.
 */
export type ProjectAct = "terminal" | "prs" | "issues" | "remote" | "rename_main" | "settle_main" | "refresh_icon" | "choose_icon" | "website_icon" | "settle_project" | "unsettle_project" | "remove";

export interface ProjectMenuItem {
  act: ProjectAct;
  label: string;
  /** A glyph of ICONS, "" for none. */
  icon: string;
  desc: string;
  /** A line goes above it. */
  sep: boolean;
}

export interface ProjectMenuInput {
  /** The project's page on the web (`git.webUrl` of its origin), or null without one. */
  remote: string | null;
  /** It has a main chat. */
  main: boolean;
  /** An icon of the user's own is set. */
  customIcon: boolean;
  /** The project is settled (it's under Settled). */
  settled?: boolean;
}

export function projectMenu(p: ProjectMenuInput): ProjectMenuItem[] {
  const out: ProjectMenuItem[] = [];
  let sep = false;
  const add = (act: ProjectAct, label: string, icon = "", desc = ""): void => {
    out.push({ act, label, icon, desc, sep: sep && out.length > 0 });
    sep = false;
  };
  add("terminal", "Open terminal", ICONS.TERMINAL);
  if (p.remote !== null && /^https:\/\/github\.com\//.test(p.remote)) {
    add("prs", "Pull requests", ICONS.PULL);
    add("issues", "Issues", ICONS.CIRCLE_DOT);
  }
  if (p.remote !== null) add("remote", "Open remote", ICONS.EXTERNAL);
  if (p.main) {
    sep = true;
    add("rename_main", "Rename main chat");
    add("settle_main", "Settle main chat", "", "It goes to Settled; the project's next message starts a new main chat");
  }
  sep = true;
  add("refresh_icon", "Refresh icon");
  add("choose_icon", "Choose icon…");
  if (p.customIcon) add("website_icon", "Use website icon");
  sep = true;
  if (p.settled === true) add("unsettle_project", "Unsettle project", ICONS.UNARCHIVE, "It and the chats settled with it come back");
  else add("settle_project", "Settle project", ICONS.ARCHIVE, "It and its chats go to Settled; a new chat or new activity in it brings it back");
  add("remove", "Remove from Harbor");
  return out;
}

/** The confirmation Remove from Harbor asks first. */
export const REMOVE_PROJECT = { title: "Remove project?", text: "Its chats are removed from Harbor. Nothing on disk is touched.", ok: "Remove" } as const;
