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
    async peers(names) {
      const list = names.length > 0 ? names.slice(0, 3) : ["studio-pc", "laptop"];
      const pcs = list.map((name, i) => {
        const lowOne = i === list.length - 1 && list.length > 1;
        const total = lowOne ? 16 * GB : 32 * GB;
        const ram = { total, used: lowOne ? 14.6 * GB : 12.3 * GB, swap_total: 4 * GB, swap_used: lowOne ? 1.2 * GB : 0 };
        const t = lowOne ? [{ title: "Build the APK", bytes: 2.4 * GB }, { title: "Video player", bytes: 640 * MB }] : [{ title: "Discord bot", bytes: 530 * MB }];
        return { name, online: true, mem: { ram, running: t.length, top: t } };
      });
      const mac = { name: "MacBook Air", online: true, ssh: true, mem: { ram: { total: 16 * GB, used: 9.1 * GB, swap_total: 2 * GB, swap_used: 0 }, running: 2, top: [] } };
      return [...pcs, mac];
    },
  };
}
