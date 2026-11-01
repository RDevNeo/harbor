// Bun exports uv_backend_fd as a stub that panics, so slint.runEventLoop() kills the process
// before its own 16 ms fallback starts: under Bun the tick lives here.
import * as slint from "slint-ui";
import { ProcessEventsResult, processEvents, setQuitOnLastWindowClosed } from "slint-ui/rust-module.cjs";

/** The period of Slint's own fallback in slint-ui's EventLoop.start(). */
export const TICK_MS = 16;

/** Resolves when the last window closes or quit() is called. */
export function runLoop(tickMs: number = TICK_MS): Promise<void> {
  if (typeof Bun === "undefined") {
    return slint.runEventLoop().then(() => undefined);
  }
  setQuitOnLastWindowClosed(true);
  return new Promise((resolve) => {
    const id = setInterval(() => {
      if (processEvents() === ProcessEventsResult.Exited) {
        clearInterval(id);
        resolve();
      }
    }, tickMs);
  });
}
