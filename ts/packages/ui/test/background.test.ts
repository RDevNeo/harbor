import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Background,
  type BackgroundHost,
  type HiddenApp,
  autostart,
  autostartFile,
  autostartLauncher,
  desktopEntry,
  setAutostart,
} from "../src/background.ts";

class Kv {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

class FakeApp implements HiddenApp {
  ticks = 0;
  closed = 0;
  offered: string | null = null;
  auto = false;
  windowClosed(): void {
    this.closed++;
  }
  tick(): void {
    this.ticks++;
  }
  updateOffered(): string | null {
    return this.offered;
  }
  autoUpdate(): boolean {
    return this.auto;
  }
}

interface Calls {
  wakes: number;
  closes: number;
  notes: [string, string][];
}

function setup(opts: { tray?: boolean } = {}) {
  const calls: Calls = { wakes: 0, closes: 0, notes: [] };
  const host: BackgroundHost = {
    wake: () => void calls.wakes++,
    closeWindow: () => void calls.closes++,
    notify: (title, body) => void calls.notes.push([title, body]),
    trayActive: () => opts.tray ?? false,
  };
  const kv = new Kv();
  const bg = new Background(host, kv, { minGapMs: 5, heartbeatMs: 40 });
  const app = new FakeApp();
  return { calls, kv, bg, app };
}

const saved = { config: process.env.XDG_CONFIG_HOME, home: process.env.HOME };
let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "harbor-bg-"));
  process.env.XDG_CONFIG_HOME = join(tmp, "config");
  process.env.HOME = join(tmp, "home");
});

afterEach(() => {
  for (const [name, value] of [
    ["XDG_CONFIG_HOME", saved.config],
    ["HOME", saved.home],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function until(what: string, ok: () => boolean): Promise<void> {
  const limit = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > limit) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("autostart_entry_quotes_paths", () => {
  expect(desktopEntry("/opt/harbor/harbor")).toContain("\nExec=/opt/harbor/harbor --background\n");
  expect(desktopEntry("/home/sam/My Apps/harbor")).toContain('\nExec="/home/sam/My Apps/harbor" --background\n');
  expect(desktopEntry("/x/a$b")).toContain('Exec="/x/a\\$b" --background');
});

test("show_waits_for_hidden", async () => {
  const { bg, app } = setup();
  const run = bg.runHidden(app, false);
  expect(bg.hidden()).toBe(true);
  bg.show();
  expect(bg.takeShow()).toBe(false);
  expect(await run).toBe(true);
  expect(bg.hidden()).toBe(false);
  expect(bg.takeShow()).toBe(false);
  bg.show();
  expect(bg.takeShow()).toBe(true);
  expect(bg.takeShow()).toBe(false);
});

test("the desktop entry has every line Harbor writes", () => {
  expect(desktopEntry("/opt/h")).toBe(
    "[Desktop Entry]\nType=Application\nName=Harbor\nComment=Starts Harbor in the background, so phones and other PCs can reach this one\nExec=/opt/h --background\nIcon=harbor\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
  );
  expect(desktopEntry('/x/a"b`c\\d\'e')).toContain('Exec="/x/a\\"b\\`c\\\\d\'e" --background');
});

test("autostart is written into XDG_CONFIG_HOME, read back, and removed", () => {
  expect(autostartFile()).toBe(join(tmp, "config", "autostart/harbor.desktop"));
  expect(autostart()).toBe(false);
  setAutostart(false, { exe: null, managed: false });
  setAutostart(true, { exe: "/opt/harbor/harbor", managed: false });
  expect(readFileSync(autostartFile(), "utf8")).toBe(desktopEntry("/opt/harbor/harbor"));
  expect(autostart()).toBe(true);
  writeFileSync(autostartFile(), `${desktopEntry("/opt/harbor/harbor")}Hidden=true\n`);
  expect(autostart()).toBe(false);
  writeFileSync(autostartFile(), "[Desktop Entry]\nExec=/other\n");
  expect(autostart()).toBe(false);
  setAutostart(true, { exe: "/opt/harbor/harbor", managed: false });
  setAutostart(false, { exe: null, managed: false });
  expect(existsSync(autostartFile())).toBe(false);
  expect(existsSync(join(tmp, "home"))).toBe(false);
});

test("autostart without a known executable says so, and a relative XDG_CONFIG_HOME falls back to HOME", () => {
  expect(() => setAutostart(true, { exe: null, managed: true })).toThrow("Harbor can't tell where its own file is");
  process.env.XDG_CONFIG_HOME = "relative/dir";
  expect(autostartFile()).toBe(join(tmp, "home", ".config", "autostart/harbor.desktop"));
  delete process.env.XDG_CONFIG_HOME;
  expect(autostartFile()).toBe(join(tmp, "home", ".config", "autostart/harbor.desktop"));
});

test("autostart runs the launcher only when it leads to this install", () => {
  const bin = join(tmp, "home", ".local/bin/harbor");
  const real = join(tmp, "install", "harbor");
  const other = join(tmp, "install", "other");
  mkdirSync(join(tmp, "home", ".local/bin"), { recursive: true });
  mkdirSync(join(tmp, "install"));
  writeFileSync(real, "");
  writeFileSync(other, "");
  symlinkSync(real, bin);
  expect(autostartLauncher({ exe: real, managed: true })).toBe(bin);
  expect(autostartLauncher({ exe: real, managed: false })).toBe(real);
  expect(autostartLauncher({ exe: other, managed: true })).toBe(other);
  rmSync(bin);
  expect(autostartLauncher({ exe: real, managed: true })).toBe(real);
});

test("autostart reports a path it cannot write", () => {
  writeFileSync(join(tmp, "blocker"), "");
  process.env.XDG_CONFIG_HOME = join(tmp, "blocker");
  expect(() => setAutostart(true, { exe: "/opt/h", managed: false })).toThrow(join(tmp, "blocker", "autostart/harbor.desktop"));
});

test("keep running ignores the retired bg_keep preference", () => {
  const { bg, kv } = setup();
  kv.set("bg_keep", "0");
  expect(bg.keepRunning()).toBe(true);
});

test("the hidden loop ticks on a heartbeat, on repaints no closer than the gap, and returns on quit", async () => {
  const { bg, app, calls } = setup();
  const run = bg.runHidden(app, false);
  expect(app.ticks).toBe(1);
  await until("the heartbeat", () => app.ticks >= 3);
  const before = app.ticks;
  for (let i = 0; i < 10; i++) bg.repaint(0);
  await until("the repaint tick", () => app.ticks > before);
  bg.quit();
  expect(await run).toBe(false);
  expect(bg.quitting()).toBe(true);
  expect(calls.closes).toBe(1);
  expect(calls.wakes).toBe(1);
  expect(app.closed).toBe(1);
});

test("a repaint request far away waits for the heartbeat at most", async () => {
  const { bg, app } = setup();
  const run = bg.runHidden(app, false);
  const started = performance.now();
  bg.repaint(60_000);
  await until("a second tick", () => app.ticks >= 2);
  expect(performance.now() - started).toBeLessThan(1000);
  bg.show();
  expect(await run).toBe(true);
});

test("a show asked before the loop starts opens the window at once", async () => {
  const { bg, app, calls } = setup();
  bg.show();
  expect(calls.wakes).toBe(1);
  expect(await bg.runHidden(app, false)).toBe(true);
  expect(app.ticks).toBe(0);
});

test("closing the window says once that Harbor is still running, with the tray hint", async () => {
  const withTray = setup({ tray: true });
  withTray.bg.show();
  await withTray.bg.runHidden(withTray.app, true);
  expect(withTray.calls.notes).toEqual([
    [
      "Harbor is still running",
      "Phones, other PCs and queued work keep reaching this PC. Run Harbor again to open it. Quit it from its tray icon, or turn this off there.",
    ],
  ]);
  withTray.bg.show();
  await withTray.bg.runHidden(withTray.app, true);
  expect(withTray.calls.notes.length).toBe(1);
  expect(withTray.kv.get("bg_explained")).toBe("1");

  const noTray = setup();
  noTray.bg.show();
  await noTray.bg.runHidden(noTray.app, true);
  expect(noTray.calls.notes[0]?.[1]).toContain("Quit it from Settings › General, or turn this off there.");

  const started = setup();
  started.bg.show();
  await started.bg.runHidden(started.app, false);
  expect(started.calls.notes).toEqual([]);
  expect(started.kv.get("bg_explained")).toBeNull();
});

test("an update that needs the owner's click is announced once per version", async () => {
  const { bg, app, calls, kv } = setup();
  app.offered = "1.2.3";
  const run = bg.runHidden(app, false);
  await until("a second tick", () => app.ticks >= 2);
  expect(calls.notes).toEqual([["Harbor 1.2.3 is ready", "Open Harbor and click Update to install it."]]);
  expect(kv.get("bg_update_noticed")).toBe("1.2.3");
  app.offered = "";
  await until("the unnamed version", () => calls.notes.length === 2);
  expect(calls.notes[1]?.[0]).toBe("A new version is ready");
  app.auto = true;
  app.offered = "2.0.0";
  const ticks = app.ticks;
  await until("two more ticks", () => app.ticks >= ticks + 2);
  expect(calls.notes.length).toBe(2);
  bg.show();
  await run;
});

test("opening a window clears a show that was waiting", async () => {
  const { bg, app } = setup();
  const run = bg.runHidden(app, false);
  bg.show();
  await run;
  bg.show();
  bg.windowOpened();
  expect(bg.takeShow()).toBe(false);
});
