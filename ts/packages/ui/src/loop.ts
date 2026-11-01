// Bun exports uv_backend_fd as a stub that panics, so slint.runEventLoop() kills the process
// before its own 16 ms fallback starts: under Bun the loop lives here.
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import * as slint from "slint-ui";
import { ProcessEventsResult, processEvents, setQuitOnLastWindowClosed } from "slint-ui/rust-module.cjs";

type Method = (...a: unknown[]) => unknown;
interface Binding extends Record<string, unknown> {
  ComponentInstance: { prototype: Record<"setProperty" | "setGlobalProperty" | "invoke" | "invokeGlobal", Method> };
}
// The object slint-ui's own code calls through, not an import's frozen copy of it.
const napi = createRequire(import.meta.url)("slint-ui/rust-module.cjs") as Binding;

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
    return slint.runEventLoop().then(() => undefined);
  }
  setQuitOnLastWindowClosed(true);
  const fd = process.env.HARBOR_FIXED_TICK ? null : backendFd();
  if (fd === null) return fixed(tickMs);
  return woken(fd, tickMs);
}

function fixed(tickMs: number): Promise<void> {
  return new Promise((resolve) => {
    const id = setInterval(() => {
      if (processEvents() === ProcessEventsResult.Exited) {
        clearInterval(id);
        resolve();
      }
    }, tickMs);
  });
}

/**
 * Slint's loop runs when the backend's fd is readable (input, the compositor's frame callbacks, redraws),
 * right after JavaScript changes a window, and every IDLE_MS for its timers. A Worker waits on the fd.
 */
function woken(fd: number, tickMs: number): Promise<void> {
  return new Promise((resolve) => {
    const waiter = new Worker(new URL("./fdwait.ts", import.meta.url).href);
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
      if (processEvents() === ProcessEventsResult.Exited) {
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
      waiting = false;
      instant = performance.now() - armedAt < 1 ? instant + 1 : 0;
      at(0);
    };
    hookChanges();
    touched = () => at(0);
    pump();
  });
}
