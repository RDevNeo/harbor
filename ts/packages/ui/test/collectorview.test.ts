import { describe, expect, it } from "bun:test";
import { clock, formOf, runOf, type CollectorView } from "../src/tabs/collector/ui.ts";
import { CREATOR_SOURCES, GAP_CHOICES, SERVER_MODES, defaultSettings } from "../../../tabs/collector/lib/types.ts";

const view = (over: Partial<CollectorView> = {}): CollectorView => ({
  rev: 1,
  settings: defaultSettings(),
  sources: CREATOR_SOURCES,
  modes: SERVER_MODES,
  gaps: GAP_CHOICES,
  discord: { connected: false, account: null },
  run: null,
  log: [],
  counts: { creators: 0, servers: 0 },
  creators: [],
  servers: [],
  ...over,
});

describe("collector window", () => {
  it("names why a source can't run", () => {
    expect(formOf(view()).unavailable).toBe("");
    const v = view();
    v.settings.platform = "tiktok";
    expect(formOf(v).unavailable).toContain("Not available yet");
  });
  it("servers need the Discord login; Reader asks for a channel link", () => {
    const v = view();
    v.settings.tab = "servers";
    expect(formOf(v).accountOk).toBe(false);
    v.settings.serverMode = "reader";
    v.settings.channel = "https://discord.com/channels/1/2";
    v.discord = { connected: true, account: "Igor" };
    const f = formOf(v);
    expect([f.label, f.query, f.accountOk]).toEqual(["Channel link", "https://discord.com/channels/1/2", true]);
    expect(f.accountNote).toContain("Igor");
  });
  it("shows the run of the tab on screen only", () => {
    const run = { running: true, tab: "creators", label: "YouTube", query: "blox", status: "Running…", found: 6, target: 50, considered: 8, dropped: 2, elapsed: 83 };
    expect(runOf(view({ run }))).toEqual({ title: "YouTube · “blox”", status: "6 of 50 creators", clock: "1:23", frac: 0.12, meta: "8 checked · 2 dropped" });
    const v = view({ run });
    v.settings.tab = "servers";
    expect(runOf(v)).toBeNull();
    expect(clock(5)).toBe("0:05");
  });
});
