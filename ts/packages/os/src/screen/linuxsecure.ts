// What has the keyboard focus on Linux, for computer use's refusal to type secrets: the focused window's class
// from the compositor (hyprctl, swaymsg) or X11 (xdotool), for polkit agents, pinentry, askpass and keyring
// prompters; and, where python3 with AT-SPI's GObject bindings is installed, the focused accessible's role
// (ROLE_PASSWORD_TEXT). Each probe runs as its own process with a deadline: none of it waits on Harbor's main thread.
import { focusedClass, linuxFocus, type SecureFocus } from "./secure.ts";

type Env = Record<string, string | undefined>;

/** `argv`'s output, or null when it fails, isn't installed or takes longer than `ms`. */
async function out(argv: string[], ms: number): Promise<string | null> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
  try {
    const r = await Promise.race([Promise.all([new Response(p.stdout as ReadableStream).text(), p.exited]), late]);
    if (r === null) {
      p.kill();
      return null;
    }
    return r[1] === 0 ? r[0] : null;
  } finally {
    clearTimeout(timer);
  }
}

// The focused accessible: AT-SPI has no "who has the focus" call, so the active frames of every app are walked
// (at most a few thousand nodes) for the one with state FOCUSED. Prints "ROLE APP" (role as AT-SPI names it, with
// dashes), or nothing.
const ATSPI = `
import sys
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception:
    sys.exit(3)
seen = [0]
def walk(o, d):
    if o is None or d > 60 or seen[0] > 4000:
        return None
    seen[0] += 1
    try:
        st = o.get_state_set()
        if st.contains(Atspi.StateType.FOCUSED):
            return o
        n = min(o.get_child_count(), 400)
    except Exception:
        return None
    for i in range(n):
        try:
            r = walk(o.get_child_at_index(i), d + 1)
        except Exception:
            r = None
        if r is not None:
            return r
    return None
desk = Atspi.get_desktop(0)
for i in range(desk.get_child_count()):
    app = desk.get_child_at_index(i)
    if app is None:
        continue
    for j in range(app.get_child_count()):
        w = app.get_child_at_index(j)
        try:
            if w is None or not w.get_state_set().contains(Atspi.StateType.ACTIVE):
                continue
        except Exception:
            continue
        f = walk(w, 0)
        if f is not None:
            print(f.get_role_name().replace(' ', '-'), app.get_name() or '')
            sys.exit(0)
`;

const CLASS_MS = 800;
const ATSPI_MS = 1500;

async function windowClass(env: Env): Promise<string> {
  if ((env.HYPRLAND_INSTANCE_SIGNATURE ?? "") !== "") {
    const o = await out(["hyprctl", "activewindow", "-j"], CLASS_MS);
    if (o !== null) return focusedClass("hyprctl", o);
  }
  if ((env.SWAYSOCK ?? "") !== "") {
    const o = await out(["swaymsg", "-t", "get_tree", "-r"], CLASS_MS);
    if (o !== null) return focusedClass("swaymsg", o);
  }
  if ((env.DISPLAY ?? "") !== "" && (env.WAYLAND_DISPLAY ?? "") === "") {
    const o = await out(["xdotool", "getactivewindow", "getwindowclassname"], CLASS_MS);
    if (o !== null) return focusedClass("xdotool", o);
  }
  return "";
}

/** What has the keyboard focus now; "unknown" when neither the compositor nor AT-SPI says (never throws). */
export async function secureFocus(env: Env = process.env): Promise<SecureFocus> {
  try {
    const [cls, atspi] = await Promise.all([windowClass(env), out(["python3", "-c", ATSPI], ATSPI_MS)]);
    return linuxFocus(cls, atspi ?? "");
  } catch (e) {
    return { state: "unknown", why: e instanceof Error ? e.message : String(e) };
  }
}
