// Bun exports uv_backend_fd as a stub that panics, so slint.runEventLoop() kills the process
// before its own 16 ms fallback starts: under Bun the loop lives here.
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import * as slint from "slint-ui";
// Its source, not its path: a compiled executable or a bundle has no fdwait.ts beside it.
import * as fdwaitText from "./fdwait.ts" with { type: "text" };
import { stallwatch } from "@harbor/store";
import * as switchTrace from "./switchtrace.ts";
import native, { ProcessEventsResult, processEvents, setQuitOnLastWindowClosed, setXdgAppId } from "slint-ui/rust-module.cjs";

type Method = (...a: unknown[]) => unknown;
interface Binding extends Record<string, unknown> {
  ComponentInstance: { prototype: Record<"setProperty" | "setGlobalProperty" | "invoke" | "invokeGlobal", Method> };
  ComponentDefinition?: unknown;
}
// The object slint-ui's own code calls through, not an import's frozen copy of it. A bundle resolves it with the
// other imports; a require() made at run time finds nothing inside a compiled executable.
const napi = native as unknown as Binding;

/** The period of Slint's own fallback in slint-ui's EventLoop.start(). */
export const TICK_MS = 16;

/** How often Slint's timers (the cursor's blink, spinners, tooltips) get a turn when nothing else wakes the window. */
export const IDLE_MS = 100;

function epolls(): Set<number> {
  const out = new Set<number>();
  if (process.platform !== "linux") return out;
  for (const n of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${n}`) === "anon_inode:[eventpoll]") out.add(Number(n));
    } catch {
      // Closed between the listing and the read.
    }
  }
  return out;
}

// Taken before any window exists: the epoll fd that appears with the first window is the backend's (winit's
// calloop), which is readable whenever the compositor sends something or Slint asks for a redraw.
const before = epolls();

/**
 * The Wayland app_id (and X11 WM_CLASS) of every Harbor window. It must match the desktop entry
 * (harbor.desktop, StartupWMClass=harbor): without one, GNOME's dock shows the window as a separate
 * "Unknown" app beside the pinned Harbor. A `scripts/preview` window gets its own id so the dock keeps
 * it apart from the real Harbor.
 */
export function appId(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARBOR_PREVIEW_APP ? "harbor-preview" : "harbor";
}

/**
 * winit reads the id when a window is created, and every entry point creates its window before it calls
 * runLoop(): so the id is set right before the first component is created. Not at import: setting it starts
 * Slint's backend, which a command line run (`harbor mesh status`, over ssh, with no display) must not do.
 */
function hookAppId(): void {
  const proto = (napi.ComponentDefinition as { prototype: Record<"create", Method> } | undefined)?.prototype;
  const create = proto?.create;
  if (proto === undefined || typeof create !== "function") return;
  let done = false;
  proto.create = function (this: unknown, ...a: unknown[]): unknown {
    if (!done) {
      done = true;
      try {
        setXdgAppId(appId());
      } catch (e) {
        console.error(`harbor: couldn't set the window's app id: ${e}`);
      }
    }
    return create.apply(this, a);
  };
}
hookAppId();

/** The fds an epoll fd watches. */
function watched(fd: number): string[] {
  try {
    return [...readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").matchAll(/^tfd:\s*(\d+)/gm)].map((m) => {
      try {
        return readlinkSync(`/proc/self/fd/${m[1]}`);
      } catch {
        return "";
      }
    });
  } catch {
    return [];
  }
}

/** The new epoll fd that watches a socket (the compositor's); others come with the window too (async-io's). */
function backendFd(): number | null {
  const fresh = [...epolls()].filter((fd) => !before.has(fd) && watched(fd).some((t) => t.startsWith("socket:")));
  return fresh.length === 1 ? (fresh[0] ?? null) : null;
}

let touched: (() => void) | null = null;

/** How the running loop is woken, and how many times the display's fd woke it. */
export const loopState: { kind: "node" | "fixed" | "paced" | "woken" | null; wakes: number } = { kind: null, wakes: 0 };
let hooked = false;

/** Every change JavaScript makes to a window (properties, models, functions) asks for a turn of Slint's loop. */
function hookChanges(): void {
  if (hooked) return;
  hooked = true;
  const wrap = (f: Method): Method =>
    function (this: unknown, ...a: unknown[]): unknown {
      touched?.();
      return f.apply(this, a);
    };
  const proto = napi.ComponentInstance.prototype;
  for (const k of ["setProperty", "setGlobalProperty", "invoke", "invokeGlobal"] as const) proto[k] = wrap(proto[k]);
  for (const k of ["jsModelNotifyRowDataChanged", "jsModelNotifyRowAdded", "jsModelNotifyRowRemoved", "jsModelNotifyReset"]) {
    const f = napi[k];
    if (typeof f === "function") napi[k] = wrap(f as Method);
  }
}

/** Resolves when the last window closes or quit() is called. */
export function runLoop(tickMs: number = TICK_MS): Promise<void> {
  if (typeof Bun === "undefined") {
    loopState.kind = "node";
    return slint.runEventLoop().then(() => undefined);
  }
  setQuitOnLastWindowClosed(true);
  if (process.env.HARBOR_FIXED_TICK) {
    loopState.kind = "fixed";
    return fixed(tickMs);
  }
  const fd = backendFd();
  loopState.kind = fd === null ? "paced" : "woken";
  return fd === null ? paced(tickMs) : woken(fd, tickMs);
}

function fixed(tickMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setInterval(() => {
      let r: ProcessEventsResult;
      try {
        r = processEvents();
      } catch (e) {
        clearInterval(id);
        reject(e);
        return;
      }
      if (r === ProcessEventsResult.Exited) {
        clearInterval(id);
        resolve();
      }
    }, tickMs);
  });
}

/** The longest a paced loop waits between turns while nothing happens: the most input waits for its first frame. */
export const PACED_IDLE_MS = 33;

/** A turn that took this long drew or handled something: the next ones come at the frame rate again. */
const BUSY_TURN_MS = 0.5;

/** How long a paced loop stays at the frame rate after the last busy turn (short: a text cursor's blink is busy every 500 ms). */
const BUSY_HOLD_MS = 250;

/**
 * Where the window backend has no fd to wait on (macOS's and Windows' message queues belong to the
 * main thread): Slint's loop runs every frame while it draws or JavaScript changes the window, and
 * eases off to PACED_IDLE_MS when nothing happens, instead of 60 empty turns a second (Slint's own timers,
 * a cursor's blink, are seen as busy turns when they draw).
 */
function paced(tickMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let due = Number.POSITIVE_INFINITY;
    let busyAt = performance.now();
    let done = false;
    const at = (ms: number) => {
      const t = performance.now() + ms;
      if (timer !== null && due <= t) return;
      if (timer !== null) clearTimeout(timer);
      due = t;
      timer = setTimeout(pump, ms);
    };
    const pump = () => {
      timer = null;
      due = Number.POSITIVE_INFINITY;
      if (done) return;
      let r: ProcessEventsResult;
      const t0 = performance.now();
      try {
        r = processEvents();
      } catch (e) {
        r = ProcessEventsResult.Exited;
        reject(e);
      }
      const t1 = performance.now();
      switchTrace.turn(t0);
      if (r === ProcessEventsResult.Exited) {
        done = true;
        touched = null;
        resolve();
        return;
      }
      loopState.wakes++;
      if (t1 - t0 >= BUSY_TURN_MS) busyAt = t1;
      const idle = t1 - busyAt;
      // At the frame rate while busy, then a little slower each turn up to PACED_IDLE_MS.
      at(idle < BUSY_HOLD_MS ? tickMs : Math.min(PACED_IDLE_MS, tickMs + (idle - BUSY_HOLD_MS) / 10));
    };
    hookChanges();
    touched = () => {
      busyAt = performance.now();
      at(0);
    };
    pump();
  });
}

/**
 * Slint's loop runs when the backend's fd is readable (input, the compositor's frame callbacks, redraws),
 * right after JavaScript changes a window, and every IDLE_MS for its timers. A Worker waits on the fd.
 */
function woken(fd: number, tickMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const waiter = new Worker(URL.createObjectURL(new Blob([(fdwaitText as unknown as { default: string }).default], { type: "application/typescript" })));
    waiter.unref();
    let waiting = false;
    let armedAt = 0;
    let instant = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let due = Number.POSITIVE_INFINITY;
    let done = false;
    const at = (ms: number) => {
      const t = performance.now() + ms;
      if (timer !== null && due <= t) return;
      if (timer !== null) clearTimeout(timer);
      due = t;
      timer = setTimeout(pump, ms);
    };
    const pump = () => {
      timer = null;
      due = Number.POSITIVE_INFINITY;
      if (done) return;
      let r: ProcessEventsResult;
      const t0 = performance.now();
      try {
        r = stallwatch.within("slint", processEvents);
      } catch (e) {
        r = ProcessEventsResult.Exited;
        reject(e);
      }
      switchTrace.turn(t0);
      if (r === ProcessEventsResult.Exited) {
        done = true;
        touched = null;
        waiter.terminate();
        resolve();
        return;
      }
      if (!waiting) {
        // An fd that stays readable after a turn would wake us at once forever: then wait a frame first.
        if (instant >= 3) {
          instant = 0;
          at(tickMs);
          return;
        }
        waiting = true;
        armedAt = performance.now();
        waiter.postMessage(fd);
      }
      at(IDLE_MS);
    };
    waiter.onmessage = () => {
      loopState.wakes++;
      waiting = false;
      instant = performance.now() - armedAt < 1 ? instant + 1 : 0;
      at(0);
    };
    hookChanges();
    touched = () => at(0);
    pump();
  });
}
