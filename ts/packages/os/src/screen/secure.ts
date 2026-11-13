// What has the keyboard focus, as far as secrets go: a password field (Windows UI Automation's IsPassword, macOS'
// AXSecureTextField, AT-SPI's ROLE_PASSWORD_TEXT) or a system authentication dialog (Windows' credential UI and
// UAC, macOS' SecurityAgent, Linux' polkit agents, pinentry, askpass and keyring prompters). Computer use refuses to
// type there unless the user asked for that sign-in. "unknown" when the system won't say: callers let typing go on
// (a broken probe mustn't stop typing everywhere) and log it.

export type SecureFocus = { state: "secure"; what: string } | { state: "clear" } | { state: "unknown"; why: string };

const lower = (s: string) => s.trim().toLowerCase();

/** Windows processes that draw authentication UI: UAC's consent, the credential broker, the logon screen. */
const WIN_AUTH = ["consent", "credentialuibroker", "logonui", "credentialenrollmentmanager", "lockapp"];
/** macOS processes that draw authentication prompts (admin passwords, Touch ID, keychain). */
const MAC_AUTH = ["securityagent", "coreautha", "authorizationhost"];
/** Linux window classes or app names of polkit agents, pinentry, ssh askpass and keyring prompters (substrings). */
const LINUX_AUTH = ["polkit", "pinentry", "askpass", "gcr-prompter", "kwalletd", "gnome-keyring"];

/** Whether a process (Windows, macOS) or window class/app name (Linux) is a system authentication dialog. Pure. */
export function authApp(os: "win32" | "darwin" | "linux", name: string): boolean {
  const n = lower(name).replace(/\.exe$/, "");
  if (n === "") return false;
  if (os === "win32") return WIN_AUTH.includes(n);
  if (os === "darwin") return MAC_AUTH.includes(n);
  return LINUX_AUTH.some((x) => n.includes(x));
}

/** The answer of the Windows helper (one JSON line): `{ok, password, process, cls, type}` or `{ok: false, error}`. Pure. */
export function parseWinFocus(line: string): SecureFocus {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { state: "unknown", why: `unreadable answer: ${line.slice(0, 120)}` };
  }
  if (typeof v !== "object" || v === null) return { state: "unknown", why: "no answer" };
  const o = v as Record<string, unknown>;
  if (o.ok !== true) return { state: "unknown", why: typeof o.error === "string" ? o.error : "UI Automation gave no focused element" };
  const proc = typeof o.process === "string" ? o.process : "";
  if (o.password === true) return { state: "secure", what: `a password field${proc === "" ? "" : ` (${proc})`}` };
  if (authApp("win32", proc)) return { state: "secure", what: `a Windows sign-in or permission dialog (${proc})` };
  if (typeof o.cls === "string" && /credential/i.test(o.cls)) return { state: "secure", what: `a Windows credential dialog (${o.cls})` };
  return { state: "clear" };
}

/** macOS: the focused element's role and subrole and its process' name. Pure. */
export function macFocus(role: string, subrole: string, proc: string): SecureFocus {
  if (subrole === "AXSecureTextField" || role === "AXSecureTextField") return { state: "secure", what: `a password field${proc === "" ? "" : ` (${proc})`}` };
  if (authApp("darwin", proc)) return { state: "secure", what: `a macOS authentication prompt (${proc})` };
  return { state: "clear" };
}

/** The focused window's class (app id) from `hyprctl activewindow -j`, `swaymsg -t get_tree -r` or xdotool's
 *  `getwindowclassname` output; "" when none is focused or the output isn't understood. Pure. */
export function focusedClass(kind: "hyprctl" | "swaymsg" | "xdotool", out: string): string {
  if (kind === "xdotool") return out.trim();
  try {
    const v = JSON.parse(out) as unknown;
    if (kind === "hyprctl") {
      const o = v as Record<string, unknown>;
      return typeof o?.class === "string" ? o.class : typeof o?.initialClass === "string" ? o.initialClass : "";
    }
    // Sway's tree: the node with focused true, anywhere under nodes and floating_nodes.
    const find = (n: unknown): string | null => {
      if (typeof n !== "object" || n === null) return null;
      const o = n as Record<string, unknown>;
      if (o.focused === true) {
        const props = o.window_properties as Record<string, unknown> | undefined;
        return typeof o.app_id === "string" && o.app_id !== "" ? o.app_id : typeof props?.class === "string" ? props.class : "";
      }
      for (const k of ["nodes", "floating_nodes"]) {
        const kids = o[k];
        if (!Array.isArray(kids)) continue;
        for (const c of kids) {
          const r = find(c);
          if (r !== null) return r;
        }
      }
      return null;
    };
    return find(v) ?? "";
  } catch {
    return "";
  }
}

/** Linux: the focused window's class and what AT-SPI says has the focus ("role app", or "" when it can't tell). Pure. */
export function linuxFocus(cls: string, atspi: string): SecureFocus {
  if (authApp("linux", cls)) return { state: "secure", what: `an authentication dialog (${cls})` };
  const [role = "", ...app] = atspi.trim().split(" ");
  if (role === "password-text" || role === "password_text") return { state: "secure", what: `a password field${app.length > 0 ? ` (${app.join(" ")})` : ""}` };
  if (app.length > 0 && authApp("linux", app.join(" "))) return { state: "secure", what: `an authentication dialog (${app.join(" ")})` };
  if (cls === "" && atspi.trim() === "") return { state: "unknown", why: "neither the compositor nor AT-SPI said what has the focus" };
  return { state: "clear" };
}
