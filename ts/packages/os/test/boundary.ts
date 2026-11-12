// What of ts/ still reaches the OS directly instead of through @harbor/os, counted per file and rule.
// boundary.test.ts holds ts/ to boundary.json: no new hit anywhere, and a count that went down must be
// lowered there (so it can't come back). `bun packages/os/test/boundary.ts` prints the current counts;
// `--write` saves them, but only when none went up (adding to the list is a deliberate, by-hand edit).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** The ts/ folder. */
export const ROOT = join(import.meta.dir, "..", "..", "..");
export const LIST = join(import.meta.dir, "..", "boundary.json");

/** Each rule: one way of reaching Linux (or the desktop around it) directly. */
export const RULES: Readonly<Record<string, RegExp>> = {
  platform: /\bprocess\.platform\b/,
  procfs: /["'`]\/proc\/|["'`]\/proc["'`]\)/,
  ffi: /from ["']bun:ffi["']/,
  libc: /libc\.so|libSystem|\.dylib\b/,
  compositor: /hyprctl|swaymsg|HYPRLAND_INSTANCE_SIGNATURE|SWAYSOCK|WAYLAND_DISPLAY|wl-copy|wl-paste|xclip/,
  "desktop-tools": /["'`](xdg-open|xdg-user-dir|notify-send)["'`]/,
  systemd: /systemd-run|systemctl|\/sys\/fs\/cgroup|harbor-turns\.slice/,
  dbus: /org\.freedesktop|org\.kde\.StatusNotifier|DBUS_SESSION_BUS_ADDRESS/,
  session: /["'`](setsid|getconf)["'`]/,
  audio: /["'`](pw-record|parecord|pactl|pw-dump)["'`]/,
  xdg: /\bXDG_(DATA|STATE|CACHE|CONFIG|RUNTIME)_(HOME|DIR)\b/,
  "linux-paths": /\/dev\/shm|\.local\/share|"\.local", "(share|state)"|autostart\/harbor\.desktop/,
  "process-groups": /process\.kill\(-/,
};

export type Counts = Record<string, Record<string, number>>;

const SKIP_DIRS = new Set(["node_modules", "test", "rig", "proto", ".git"]);

function files(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || relative(ROOT, p) === join("packages", "os")) continue;
      files(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** A comment line: only code counts. */
const comment = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

/** Every hit in ts/ outside @harbor/os, tests, rigs and prototypes. */
export function scan(root: string = ROOT): Counts {
  const out: Counts = {};
  for (const f of files(root, []).sort()) {
    const lines = readFileSync(f, "utf8").split("\n").filter((l) => !comment(l));
    for (const [rule, re] of Object.entries(RULES)) {
      const n = lines.filter((l) => re.test(l)).length;
      if (n === 0) continue;
      const key = relative(root, f);
      out[key] = { ...(out[key] ?? {}), [rule]: n };
    }
  }
  return out;
}

export function readList(path: string = LIST): Counts {
  return JSON.parse(readFileSync(path, "utf8")) as Counts;
}

/** What differs: hits beyond the list (`more`) and counts the list still allows that are gone (`fewer`). */
export function compare(now: Counts, list: Counts): { more: string[]; fewer: string[] } {
  const more: string[] = [];
  const fewer: string[] = [];
  for (const [file, rules] of Object.entries(now)) {
    for (const [rule, n] of Object.entries(rules)) {
      const allowed = list[file]?.[rule] ?? 0;
      if (n > allowed) more.push(`${file}: ${rule} ${n} (allowed ${allowed})`);
    }
  }
  for (const [file, rules] of Object.entries(list)) {
    for (const [rule, allowed] of Object.entries(rules)) {
      const n = now[file]?.[rule] ?? 0;
      if (n < allowed) fewer.push(`${file}: ${rule} ${n} (allowed ${allowed})`);
    }
  }
  return { more, fewer };
}

export function format(c: Counts): string {
  const sorted: Counts = {};
  for (const f of Object.keys(c).sort()) {
    const rules = c[f] ?? {};
    sorted[f] = Object.fromEntries(Object.keys(rules).sort().map((r) => [r, rules[r] ?? 0]));
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

if (import.meta.main) {
  const now = scan();
  if (!process.argv.includes("--write")) {
    process.stdout.write(format(now));
  } else {
    const { more } = compare(now, readList());
    if (more.length > 0) {
      console.error(`Not written: these went up (move them behind @harbor/os, or add them to boundary.json by hand):\n${more.join("\n")}`);
      process.exit(1);
    }
    writeFileSync(LIST, format(now));
    console.log(`${LIST}: ${Object.keys(now).length} files`);
  }
}
