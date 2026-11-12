// macOS's menu bar: Harbor's icon there (NSStatusItem), with its menu. Loaded only on macOS, in the
// process that runs the window (AppKit's main thread is Bun's JavaScript thread: menu actions arrive
// while Slint's loop runs, and call back into JavaScript there).
import { actionClass, call, call1, call3Sel, callF64, callI64, callBool, callSetI64, callSize, callVoid1, cls, nsData, nsString, pool, release, retain, sel, type Id } from "./darwin-objc.ts";
import type { TrayItem, TrayOptions } from "./tray.ts";

/** NSVariableStatusItemLength */
const VARIABLE = -1;

let handlers: (() => void)[] = [];

export function start(o: TrayOptions): () => void {
  const target = pool(() => {
    const c = actionClass("HarborMenuTarget", "harborMenu:", (sender) => handlers[callI64(sender, "tag")]?.());
    return retain(call(call(c, "alloc"), "init"));
  });
  const item = pool(() => {
    const bar = call(cls("NSStatusBar"), "systemStatusBar");
    const it = retain(callF64(bar, "statusItemWithLength:", VARIABLE));
    const button = call(it, "button");
    const img = call1(call(cls("NSImage"), "alloc"), "initWithData:", nsData(o.iconPng));
    // A template image: macOS draws it in the menu bar's own colour, light or dark.
    callBool(img, "setTemplate:", true);
    callSize(img, "setSize:", o.iconPoints, o.iconPoints);
    callVoid1(button, "setImage:", img);
    callVoid1(button, "setToolTip:", nsString(o.tooltip));
    callVoid1(it, "setMenu:", menu(o.items, target));
    return it;
  });
  return () =>
    pool(() => {
      callVoid1(call(cls("NSStatusBar"), "systemStatusBar"), "removeStatusItem:", item);
      release(item);
      release(target);
      handlers = [];
    });
}

function menu(items: readonly TrayItem[], target: Id): Id {
  handlers = [];
  const m = call1(call(cls("NSMenu"), "alloc"), "initWithTitle:", nsString(""));
  for (const i of items) {
    if (i === "separator") {
      callVoid1(m, "addItem:", call(cls("NSMenuItem"), "separatorItem"));
      continue;
    }
    const mi = call3Sel(call(cls("NSMenuItem"), "alloc"), "initWithTitle:action:keyEquivalent:", nsString(i.label), sel("harborMenu:"), nsString(""));
    callVoid1(mi, "setTarget:", target);
    callSetI64(mi, "setTag:", handlers.length);
    handlers.push(i.onClick);
    callVoid1(m, "addItem:", mi);
  }
  return m;
}
