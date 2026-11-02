import { describe, expect, test } from "bun:test";
import { now } from "../src/kv.ts";
import type { PairedPhone, Sighting } from "../src/hub.ts";
import { newPeer } from "../src/shared.ts";
import { wire } from "../src/wire.ts";
import {
  codeName,
  gatherVersions,
  newestVersion,
  newPcVersion,
  newPhoneVersion,
  pcLine,
  phoneLine,
  phoneShort,
  versionNewer,
  versionsJson,
  versionsText,
  type PcVersion,
  type VersionsInput,
} from "../src/versions.ts";

function pc(v: string, update: unknown): PcVersion {
  return newPcVersion({ name: "desk", online: true, version: v, update });
}

describe("versions", () => {
  test("pc_lines", () => {
    const up = { managed: true, latest: null, status: "up to date", auto: true };
    expect(pcLine(pc("0.66.0", up), "0.66.0")).toBe("0.66.0 (latest, updates automatically)");
    expect(pcLine(pc("0.64.1", { managed: true, latest: "0.66.0", auto: false }), "0.66.0")).toBe("0.64.1, 0.66.0 available, auto-update off");
    expect(pcLine(pc("0.64.1", { managed: true, latest: null, auto: true }), "0.66.0")).toBe("0.64.1, 0.66.0 is out, updates automatically");
    expect(pcLine(pc("0.64.1", { managed: true, latest: "0.66.0", installing: true }), "")).toBe("0.64.1, updating to 0.66.0");
    expect(pcLine(pc("0.64.1", { managed: true, latest: "0.66.0", ready: true }), "")).toBe("0.64.1, 0.66.0 installed, restarts into it");
    expect(pcLine(pc("0.66.0", { managed: false }), "0.66.0")).toBe("0.66.0 (built from source, doesn't update itself)");
    expect(pcLine(pc("0.48.0", null), "0.66.0")).toBe("0.48.0 (update status unknown, before 0.51); 0.66.0 is out");
    expect(pcLine(pc("", null), "")).toBe("version unknown");
    const off = newPcVersion({ online: false, seen: now() - 7200, version: "0.64.1" });
    expect(pcLine(off, "0.66.0")).toBe("0.64.1, offline (last seen 2h ago)");
    expect(pcLine(newPcVersion(), "")).toBe("version unknown, offline");
    expect(newestVersion([pc("0.64.1", { latest: "0.66.0" }), pc("0.65.0", null)])).toBe("0.66.0");
  });

  test("pc_lines: the rest of the states", () => {
    const m = (extra: Record<string, unknown>) => pc("0.64.1", { managed: true, ...extra });
    expect(pcLine(m({ checking: true }), "")).toBe("0.64.1, checking for updates");
    expect(pcLine(m({ error: "no network" }), "")).toBe("0.64.1, update failed: no network");
    expect(pcLine(m({}), "")).toBe("0.64.1");
    expect(pcLine(m({ auto: true, preview: { id: "pr-7" } }), "")).toBe("0.64.1, updates automatically, running preview pr-7");
    expect(pcLine(pc("0.64.1", { managed: false, preview: { id: "x" } }), "")).toBe("0.64.1, built from source, doesn't update itself, running preview x");
    expect(pcLine(newPcVersion({ me: true, online: false, version: "0.64.1", update: { managed: true, status: "up to date" } }), "0.64.1")).toBe("0.64.1 (latest)");
    expect(pcLine(newPcVersion({ seen: 5 }), "", 5)).toBe("version unknown, offline (last seen just now)");
  });

  test("versions order", () => {
    expect(versionNewer("0.2.0", "0.2.0-rc.1")).toBe(true);
    expect(versionNewer("0.2.0-rc.1", "0.1.9")).toBe(true);
    expect(versionNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(versionNewer("0.66", "0.66.0")).toBe(false);
    expect(versionNewer("x", "0.1.0")).toBe(false);
  });

  test("phone_lines", () => {
    const at = now();
    expect(codeName(66001)).toBe("0.66.1");
    expect(phoneLine(newPhoneVersion({ name: "p", app: 66000, seen: at }), 66000)).toBe("app 0.66.0 (66000), seen just now");
    expect(phoneLine(newPhoneVersion({ name: "p", app: 64001, seen: at - 300, via: "lab" }), 66000)).toBe("app 0.64.1 (64001), 0.66.0 available, seen 5m ago at lab");
    const p = newPhoneVersion({ name: "p", app: 84000, seen: at, platform: "Samsung SM-A135M, Android 12 (SDK 31), ABIs armeabi-v7a" });
    expect(phoneLine(p, 0)).toBe("app 0.84.0 (84000), seen just now; Samsung SM-A135M, Android 12 (SDK 31), ABIs armeabi-v7a");
    expect(phoneLine(newPhoneVersion(), 0)).toBe("app version unknown (older than 0.17), not seen yet");
    expect(phoneLine(newPhoneVersion({ app: 17000 }), 0)).toBe("app 0.17 or 0.18.0 (doesn't say which), not seen yet");
    expect(phoneShort(0)).toBeNull();
    expect(phoneShort(17000)).toBeNull();
    expect(phoneShort(66000)).toBe("app 0.66.0");
  });

  const at = 1_761_600_000;
  const phone: PairedPhone = { group: "g1", name: "", seen: at - 600, ip: "", via: "", app: 68000, owner: "", platform: "", alive: at - 60 };
  const sighting = (group: string, name: string, seen: number, app: number, alive: number, platform: string): Sighting => ({ group, name, seen, app, alive, platform });
  const input: VersionsInput = {
    me: { id: "ts:desk", name: "desk" },
    hostname: "host",
    meshOn: true,
    version: "0.68.0",
    update: { managed: true, latest: null, status: "up to date", auto: true },
    peers: [
      newPeer({ id: "ts:b", name: "zeta", online: false, seen: at - 2 * 86400, version: "0.66.0" }),
      newPeer({ id: "ts:a", name: "laptop", online: true, seen: at - 5, version: "0.67.0", update: { managed: true, latest: "0.68.0", auto: true } }),
      newPeer({ id: "ts:c", name: "alpha", online: false, seen: 0, version: "" }),
    ],
    paired: [phone],
    local: [phone],
    elsewhere: [
      ["laptop", [sighting("g1", "Pixel", at, 1, 0, ""), sighting("g2", "Tab", at - 300, 66000, 0, "Pixel 7")]],
      ["zeta", [sighting("g2", "Tab 2", at - 100, 64000, at - 30, "")]],
    ],
    served: 68000,
  };

  test("gather: this PC first, then online ones by name; phones by last seen", () => {
    const [pcs, phones] = gatherVersions(input, at);
    expect(pcs.map((p) => p.name)).toEqual(["desk", "laptop", "alpha", "zeta"]);
    expect(pcs[0]).toMatchObject({ me: true, online: true, seen: at, version: "0.68.0" });
    expect(phones.map((p) => [p.name, p.app, p.seen, p.via, p.platform])).toEqual([
      ["Tab 2", 66000, at - 30, "zeta", "Pixel 7"],
      ["Phone", 68000, at - 60, "", ""],
    ]);
    expect(gatherVersions({ ...input, meshOn: false, hostname: "host", me: { id: "x", name: "" } }, at)[0].map((p) => p.name)).toEqual(["host"]);
  });

  test("/v1/versions", () => {
    const line = (o: Record<string, unknown>) => o;
    const expected = {
      newest: "0.68.0",
      pcs: [
        line({ name: "desk", self: true, online: true, seen: at, version: "0.68.0", line: "0.68.0 (latest, updates automatically)" }),
        line({ name: "laptop", self: false, online: true, seen: at - 5, version: "0.67.0", line: "0.67.0, 0.68.0 available, updates automatically" }),
        line({ name: "alpha", self: false, online: false, seen: 0, version: "", line: "version unknown, offline" }),
        line({ name: "zeta", self: false, online: false, seen: at - 172800, version: "0.66.0", line: "0.66.0, offline (last seen 2d ago)" }),
      ],
      phones: [
        line({ name: "Tab 2", app: 66000, app_version: "0.66.0", seen: at - 30, via: "zeta", platform: "Pixel 7", line: "app 0.66.0 (66000), 0.68.0 available, seen just now at zeta; Pixel 7" }),
        line({ name: "Phone", app: 68000, app_version: "0.68.0", seen: at - 60, via: "", platform: "", line: "app 0.68.0 (68000), seen 1m ago" }),
      ],
    };
    expect(JSON.parse(wire(versionsJson(input, at)))).toEqual(expected);
    expect(wire(versionsJson(input, at)).startsWith('{"newest":"0.68.0","pcs":[{"line":"0.68.0 (latest, updates automatically)","name":"desk","online":true,"seen":')).toBe(true);
  });

  test("the agent's text", () => {
    expect(versionsText(input, at)).toBe(
      [
        "Harbor versions (newest known: 0.68.0):",
        "- desk (this PC): Harbor 0.68.0 (latest, updates automatically)",
        "- laptop: Harbor 0.67.0, 0.68.0 available, updates automatically",
        "- alpha: Harbor version unknown, offline",
        "- zeta: Harbor 0.66.0, offline (last seen 2d ago)",
        "Phones:",
        "- Tab 2: app 0.66.0 (66000), 0.68.0 available, seen just now at zeta; Pixel 7",
        "- Phone: app 0.68.0 (68000), seen 1m ago",
      ].join("\n"),
    );
    expect(versionsText({ ...input, paired: [], local: [], elsewhere: [], meshOn: false }, at)).toBe(
      "Harbor versions (newest known: 0.68.0):\n- desk (this PC): Harbor 0.68.0 (latest, updates automatically)\nPhones: none paired",
    );
  });
});
