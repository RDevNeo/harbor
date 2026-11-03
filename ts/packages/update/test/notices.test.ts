import { expect, test } from "bun:test";
import type { State, UpdateInfo } from "../src/delivery.ts";
import {
  HARBOR_DISMISSED,
  dismiss,
  dismissed,
  harborOffer,
  harborToast,
  hubUpdate,
  notesUrl,
  rollbackToast,
} from "../src/notices.ts";

const idle: State = { t: "idle" };

test("the release notes of a version", () => {
  expect(notesUrl("1.2.3")).toBe("https://github.com/RDevNeo/harbor/releases/tag/v1.2.3");
});

test("a release is on offer only for an installed copy that has one to install or restart into", () => {
  expect(harborOffer(false, { t: "available", v: "2.0.0" }, null)).toBeNull();
  expect(harborOffer(true, idle, null)).toBeNull();
  expect(harborOffer(true, { t: "upToDate" }, null)).toBeNull();
  expect(harborOffer(true, { t: "available", v: "2.0.0" }, null)).toEqual({ version: "2.0.0", installing: false });
  expect(harborOffer(true, { t: "installing", v: "2.0.0" }, null)).toEqual({ version: "2.0.0", installing: true });
  expect(harborOffer(true, idle, "2.0.0")).toEqual({ version: "2.0.0", installing: false });
});

test("the update pop-up says what is happening and offers Update only when nothing is running", () => {
  const offer = { version: "2.0.0", installing: false };
  const a = harborToast(offer, "1.0.0", false, false, null);
  expect(a).toMatchObject({ id: "harbor-update-toast", title: "Harbor 2.0.0 is available", primary: { label: "Update", enabled: true }, secondary: "What's new" });
  expect(a?.body).toBe("You have 1.0.0. Update installs it and reloads Harbor in place.");
  const b = harborToast({ ...offer, installing: true }, "1.0.0", false, false, null);
  expect(b).toMatchObject({ title: "Updating Harbor to 2.0.0…", primary: { label: "Updating…", enabled: false } });
  expect(harborToast(offer, "1.0.0", false, true, null)?.primary?.enabled).toBe(false);
  const c = harborToast(offer, "1.0.0", true, false, null);
  expect(c?.title).toBe("Harbor 2.0.0 is installed");
  expect(c?.body).toContain("You still run 1.0.0");
});

test("closing the pop-up hides that version only", () => {
  const offer = { version: "2.0.0", installing: false };
  expect(harborToast(offer, "1.0.0", false, false, "2.0.0")).toBeNull();
  expect(harborToast({ version: "2.0.1", installing: false }, "1.0.0", false, false, "2.0.0")).not.toBeNull();
  expect(harborToast(null, "1.0.0", false, false, null)).toBeNull();
});

test("a start that was undone is said once per version", () => {
  const r = { version: "2.0.0", restored: "1.0.0", why: "it exited while starting", at: 1 };
  const t = rollbackToast(r, null);
  expect(t?.title).toBe("Harbor 2.0.0 didn't start");
  expect(t?.body).toContain("went back to 1.0.0");
  expect(t?.body).toContain("won't try 2.0.0 again on this PC");
  expect(rollbackToast(r, "2.0.0")).toBeNull();
  expect(rollbackToast(null, null)).toBeNull();
  expect(rollbackToast({ ...r, restored: "" }, null)?.body).toContain("the previous version");
});

test("dismissals are remembered in the settings store", () => {
  const data = new Map<string, string>();
  const kv = { get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => void data.set(k, v) };
  expect(dismissed(kv, HARBOR_DISMISSED)).toBeNull();
  dismiss(kv, HARBOR_DISMISSED, "2.0.0");
  expect(dismissed(kv, HARBOR_DISMISSED)).toBe("2.0.0");
  expect(HARBOR_DISMISSED).toBe("update_toast_dismissed");
  data.set(HARBOR_DISMISSED, "");
  expect(dismissed(kv, HARBOR_DISMISSED)).toBeNull();
});

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  version: "1.0.0",
  runtime: "1.0.0",
  managed: true,
  latest: null,
  ready: false,
  installing: false,
  checking: false,
  error: null,
  status: "",
  auto: true,
  skipped: null,
  rolled_back: null,
  preview_on: false,
  preview_kind: "bundle",
  preview: null,
  ...over,
});

test("the phone's banner: only for a release that was not taken, and a checking Update asked for by hand", () => {
  expect(hubUpdate(info(), idle, false)).toBeNull();
  expect(hubUpdate(info(), { t: "installing", v: "2.0.0" }, false)).toBeNull();
  expect(hubUpdate(info({ ready: true, latest: "2.0.0" }), { t: "installed", v: "2.0.0" }, false)).toBeNull();
  expect(hubUpdate(info(), { t: "available", v: "2.0.0" }, false)).toEqual({ version: "2.0.0", current: "1.0.0", installing: false, ready: false, notes_url: notesUrl("2.0.0") });
  expect(hubUpdate(info(), { t: "available", v: "2.0.0" }, true)?.installing).toBe(true);
  expect(hubUpdate(info(), { t: "checking" }, true)).toEqual({ version: "", current: "1.0.0", installing: true, checking: true, ready: false });
  expect(hubUpdate(info(), { t: "checking" }, false)).toBeNull();
  expect(hubUpdate(info({ managed: false }), { t: "available", v: "2.0.0" }, false)).toBeNull();
});
