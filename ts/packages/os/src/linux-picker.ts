// The desktop's own file picker through the XDG portal (org.freedesktop.portal.FileChooser), for Linux desktops
// without zenity or kdialog (Hyprland, Sway… with xdg-desktop-portal-gtk or -kde). The portal answers on a Request
// object of the caller's own D-Bus connection and closes the request when that connection goes away, so the call
// and the wait run in one process: python3 with GLib's bindings (gi), in a process of its own, so the window keeps
// drawing while the dialog is open. It prints the chosen paths, one a line; exit 1 when cancelled, 3 when there's no
// portal or no gi (the caller says no picker was found).
import type { PickOptions } from "./win32/picker.ts";

const SCRIPT = String.raw`
import json, random, sys
from urllib.parse import unquote, urlparse
try:
    import gi
    from gi.repository import Gio, GLib
except Exception:
    sys.exit(3)
o = json.loads(sys.argv[1])
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
except Exception:
    sys.exit(3)
token = "hub%d" % random.randint(1, 1 << 30)
sender = bus.get_unique_name()[1:].replace(".", "_")
path = "/org/freedesktop/portal/desktop/request/%s/%s" % (sender, token)
loop = GLib.MainLoop()
out = {"code": 2, "uris": []}
def answered(conn, who, obj, iface, sig, params, *rest):
    code, results = params.unpack()
    out["code"] = code
    out["uris"] = results.get("uris", [])
    loop.quit()
bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response", path, None, Gio.DBusSignalFlags.NONE, answered)
opts = {"handle_token": GLib.Variant("s", token), "modal": GLib.Variant("b", True), "multiple": GLib.Variant("b", bool(o.get("multiple")))}
if o.get("directory"):
    opts["directory"] = GLib.Variant("b", True)
if o.get("filter"):
    name, globs = o["filter"]
    f = (name, [(0, g) for g in globs])
    opts["filters"] = GLib.Variant("a(sa(us))", [f, ("All files", [(0, "*")])])
    opts["current_filter"] = GLib.Variant("(sa(us))", f)
if o.get("dir"):
    opts["current_folder"] = GLib.Variant("ay", o["dir"].encode() + b"\0")
try:
    bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.FileChooser", "OpenFile",
                  GLib.Variant("(ssa{sv})", ("", o.get("title") or "", opts)), GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, -1, None)
except Exception:
    sys.exit(3)
loop.run()
if out["code"] == 1:
    sys.exit(1)
if out["code"] != 0:
    sys.exit(2)
for u in out["uris"]:
    p = urlparse(u)
    if p.scheme == "file":
        print(unquote(p.path))
`;

/** python3's command line for it (isolated: nothing from the working folder or the user's site-packages). */
export function portalPickerCommand(o: PickOptions): string[] {
  return ["python3", "-I", "-c", SCRIPT, JSON.stringify({ title: o.title ?? "", multiple: !!o.multiple, directory: !!o.directory, filter: o.filter ?? null, dir: o.dir ?? "" })];
}
