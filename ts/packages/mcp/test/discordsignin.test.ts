import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountName, cancel, login, signedIn, status } from "../src/discord.ts";
import type { Pending } from "../src/discord.ts";
import * as setup from "../src/discordsetup.ts";
import { type Started, fakeLog, plan, repoDiscord, rig, startHost, until } from "./discordkit.ts";

let r: ReturnType<typeof rig>;
let h: Started | undefined;

beforeEach(() => {
  r = rig(false);
  process.env.WAYLAND_DISPLAY = "wayland-test";
});
afterEach(async () => {
  delete process.env.WAYLAND_DISPLAY;
  await h?.running.close();
  h = undefined;
  r.box.restore();
});

const started = async (events: unknown[], gap = 0): Promise<Started> => {
  plan(r.root, { events, eventGapMs: gap });
  h = await startHost();
  return h;
};

const signin = (s: Started): Record<string, unknown> => (s.host.status() as Record<string, Record<string, unknown>>).signin ?? {};

test("signing in shows the QR code, then the account", async () => {
  const s = await started([{ ev: "qr", url: "https://discord.com/ra/abc" }, { ev: "login-page", scanned: true, captcha: false }, { ev: "signed-in", user: { id: "9", username: "ana", name: "Ana" } }], 700);
  expect(signedIn()).toBe(false);
  const seen: Pending[] = [];
  await login(new AbortController().signal, (p) => seen.push(p));
  expect(seen.some((p) => p.qr === "https://discord.com/ra/abc" && p.note === "Scan with the Discord app")).toBe(true);
  expect(seen.some((p) => p.note === "Confirm on your phone")).toBe(true);
  expect(signedIn()).toBe(true);
  expect(accountName()).toBe("Ana");
  expect(JSON.parse(readFileSync(setup.accountPath(), "utf8")).id).toBe("9");
  await until(() => s.host.phase() === "stopped");
  const launch = fakeLog(r.root).find((l) => l.started === "signin");
  expect(launch?.argv).toEqual([repoDiscord, "--ozone-platform=wayland"]);
  expect(launch?.wayland).toBe("wayland-test");
  expect(((await status()) as Record<string, unknown>).phase).toBe("stopped");
});

test("cancelling stops the sign-in page", async () => {
  const s = await started([{ ev: "qr", url: "https://discord.com/ra/abc" }]);
  const stop = new AbortController();
  await expect(login(stop.signal, () => stop.abort())).rejects.toThrow("Sign-in was cancelled.");
  await until(() => s.host.phase() === "stopped");
  expect(signedIn()).toBe(false);
  expect(signin(s).active).toBe(false);
});

test("a captcha opens the real window when there is a desktop", async () => {
  const s = await started([{ ev: "login-page", scanned: false, captcha: true }]);
  expect(await s.host.handle({ op: "signin", accept: true, display: { wayland: "w", x11: "", runtime: "/run/user/test" } })).toEqual({ ok: true, result: {} });
  await until(() => fakeLog(r.root).some((l) => l.op === "show"));
  await until(() => signin(s).window === true);
  expect(signin(s).note).toBe("Finish in Discord's window");
  await cancel();
  await until(() => s.host.phase() === "stopped");
});

test("without a desktop a captcha says so", async () => {
  const s = await started([{ ev: "login-page", scanned: false, captcha: true }]);
  await s.host.handle({ op: "signin", accept: true, display: {} });
  await until(() => String(signin(s).note).startsWith("Discord wants a captcha"));
  expect(fakeLog(r.root).some((l) => l.op === "show")).toBe(false);
  expect(await s.host.handle({ op: "window" })).toEqual({ ok: false, error: "This PC has no desktop to open the sign-in window on: use the QR code, or sign in from the PC itself." });
});

test("sign-in needs the warning accepted, and one at a time", async () => {
  const s = await started([]);
  expect(await s.host.handle({ op: "signin" })).toEqual({ ok: false, error: "Sign-in needs the warning accepted first." });
  expect(await s.host.handle({ op: "window" })).toEqual({ ok: false, error: "No sign-in is going on." });
  expect(await s.host.handle({ op: "signin", accept: true })).toEqual({ ok: true, result: {} });
  expect(await s.host.handle({ op: "signin", accept: true })).toEqual({ ok: false, error: "Discord is busy; try again in a moment." });
  await until(() => s.host.phase() === "signin");
  expect(await s.host.handle({ op: "call", name: "discord_view", args: {} })).toEqual({ ok: false, error: "Discord is signing in on this PC. Try again when that's done." });
});

test("closing the sign-in window cancels it", async () => {
  const s = await started([{ ev: "window-closed" }]);
  await s.host.handle({ op: "signin", accept: true, display: { wayland: "w" } });
  await until(() => fakeLog(r.root).some((l) => l.started === "signin"));
  await until(() => s.host.phase() === "stopped");
  expect(signin(s).active).toBe(false);
});

test("a sign-in that cannot start reports why", async () => {
  const s = await started([]);
  process.env.HARBOR_DISCORD_ELECTRON = join(r.box.dir, "missing-electron");
  process.env.HARBOR_DISCORD_ELECTRON_URL = "http://127.0.0.1:1";
  await s.host.handle({ op: "signin", accept: true });
  await until(() => signin(s).error !== null, 15_000);
  expect(String(signin(s).error)).toContain("Couldn't download");
  expect(s.host.phase()).toBe("stopped");
}, 20_000);

test("signing out ends the session and removes the profile", async () => {
  const s = await started([]);
  await Bun.write(setup.accountPath(), JSON.stringify({ id: "1", username: "ana", name: "Ana", at: 1 }));
  await Bun.write(join(setup.profile(), "Cookies"), "session");
  expect(await s.host.handle({ op: "signout" })).toEqual({ ok: true, result: {} });
  await until(() => s.host.phase() === "stopped" && !existsSync(join(setup.profile(), "Cookies")));
  expect(fakeLog(r.root).some((l) => l.op === "logout")).toBe(true);
  expect(existsSync(setup.accountPath())).toBe(false);
});
