/** HARBOR_FAKE_MEMORY=1 (scripts/shot --env): the rig has no agents and no network, so make some up; this PC's RAM stays real. */
const MB = 1024 ** 2;
const GB = 1024 ** 3;

export interface FakeMemory {
  local(real: unknown, chat: boolean): unknown;
  peers(names: readonly string[]): Promise<{ name: string; online: boolean; mem: unknown; ssh?: boolean }[]>;
}

export function fakeMemory(env: Record<string, string | undefined> = process.env): FakeMemory | null {
  if (!env.HARBOR_FAKE_MEMORY) return null;
  const parts = [
    { kind: "agent", label: "Lead · Claude", bytes: 248 * MB },
    { kind: "sub", label: "tests", bytes: 96 * MB },
    { kind: "proc", label: "dev server", bytes: 68 * MB },
  ];
  const top = [
    { title: "This chat", bytes: 412 * MB },
    { title: "Release checks", bytes: 1.1 * GB },
    { title: "Phone screenshots", bytes: 286 * MB },
  ].sort((a, b) => b.bytes - a.bytes);
  return {
    local(real, chat) {
      const r = typeof real === "object" && real !== null ? (real as Record<string, unknown>) : {};
      return { ...r, running: top.length, top, ...(chat ? { chat: { parts } } : {}) };
    },
    /** A PC with room, a low one deep in swap, a Runs on device over SSH and one that's off. */
    async peers(names) {
      const [roomy = "studio-pc", short = "laptop", off = "old-desktop"] = names;
      const pc = (name: string, total: number, used: number, swap: number, t: { title: string; bytes: number }[]) => ({ name, online: true, mem: { ram: { total, used, swap_total: 8 * GB, swap_used: swap }, running: t.length, top: t } });
      return [
        pc(roomy, 32 * GB, 12.3 * GB, 0, [
          { title: "Discord bot", bytes: 530 * MB },
          { title: "Docs site", bytes: 310 * MB },
          { title: "Nightly backups", bytes: 92 * MB },
        ]),
        pc(short, 16 * GB, 14.9 * GB, 5.6 * GB, [
          { title: "Build the APK", bytes: 2.4 * GB },
          { title: "Video player", bytes: 640 * MB },
          { title: "Sidebar polish", bytes: 410 * MB },
          { title: "Release notes", bytes: 220 * MB },
          { title: "Flaky test hunt", bytes: 160 * MB },
        ]),
        { name: "build-box", online: true, ssh: true, mem: { ram: { total: 16 * GB, used: 9.1 * GB, swap_total: 2 * GB, swap_used: 0 }, running: 0, top: [] } },
        { name: off, online: false, mem: null },
      ];
    },
  };
}
