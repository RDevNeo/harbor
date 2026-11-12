// Starting Harbor at login on Windows: its value under HKCU\…\Run, which Settings › Apps › Startup and Task
// Manager list as "Harbor". Turning it off there leaves the value and marks it in StartupApproved\Run.
import { deleteRegValue, regBinary, regString, setRegString } from "./gui.ts";

const RUN = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const NAME = "Harbor";

/** The command line the Run value holds. */
export function command(exe: string, arg: string): string {
  return `"${exe}" ${arg}`;
}

/** Whether the value is Harbor's for `arg` and not turned off in Settings or Task Manager (an odd first byte). */
export function isOn(run: string | null, approved: Uint8Array | null, arg: string): boolean {
  if (run === null || !run.includes(arg)) return false;
  return approved === null || ((approved[0] ?? 0) & 1) === 0;
}

export function enabled(arg: string): boolean {
  return isOn(regString(RUN, NAME), regBinary(APPROVED, NAME), arg);
}

export function set(on: boolean, exe: string, arg: string): void {
  if (!on) {
    deleteRegValue(RUN, NAME);
    return;
  }
  setRegString(RUN, NAME, command(exe, arg));
  // Turned off in Task Manager before: on again.
  deleteRegValue(APPROVED, NAME);
}

/** Where the entry is, as the person would find it. */
export const where = `HKEY_CURRENT_USER\\${RUN}\\${NAME}`;
