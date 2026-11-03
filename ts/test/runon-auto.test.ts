import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newHost, newPeer, type Peer, type RemoteHost } from "../packages/net/src/index.ts";
import { blankChat, Store } from "../packages/store/src/index.ts";
import { RunOn, type RunOnDeps } from "../runon.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-autopc-"));
// One store for every rig: opening one is the slow part on a sandbox whose disk is still loading.
const store = Store.openAt(join(tmp, "auto.db"));
afterAll(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});
/** A generous limit: the first test also pays for loading runon.ts's imports. */
const SLOW = 60_000;

const claude: [string, string, string][] = [["claude", "Claude", "claude"]];

function rig(o: { peers: Peer[]; here: number | null; mesh?: boolean; devices?: [RemoteHost, boolean | null][]; running?: Set<number> }) {
  const deps = {
    store,
    engine: { chat: (id: number) => store.chat(id), allSubsOf: () => [], running: (id: number) => o.running?.has(id) ?? false, changed: () => {} },
    mover: { movingTo: () => null },
    remotes: { devices: () => o.devices ?? [], tailnetCached: () => null },
    meshOn: () => o.mesh ?? true,
    hosts: () => o.peers,
    me: () => ({ name: "desk", hostname: "desk-host" }),
    accounts: () => [{ id: "claude", kind: "Claude" }],
    ram: () => o.here,
  } as unknown as RunOnDeps;
  return { run: new RunOn(deps), store };
}

/** A PC that's both a device (Settings › Devices, the name the user gave it) and a mesh PC (the name its Harbor gives itself). */
const samDevice = (x: Partial<RemoteHost> = {}): [RemoteHost, boolean | null] => [newHost({ id: "pc:a", name: "Sam-Laptop", host: "laptop.example.ts.net", ...x }), true];

const peer = (id: string, name: string, ram: number | null, x: Partial<Peer> = {}) => newPeer({ id, name, online: true, accounts: claude, ram, ...x });

describe("Runs on › Auto (runon.ts)", () => {
  test("picks the PC with the most free memory among those that can take the chat", () => {
    const { run } = rig({
      here: 6000,
      peers: [
        peer("pc:a", "laptop", 9000),
        peer("pc:off", "off", 64_000, { online: false }),
        peer("pc:codex", "codexbox", 64_000, { accounts: [["codex", "Codex", "codex"]] }),
        peer("pc:old", "old", null),
      ],
    });
    expect(run.autoCandidates("Claude").map((c) => c.id)).toEqual(["", "pc:a", "pc:old"]);
    expect(run.autoPick("Claude")).toEqual({ id: "pc:a", name: "laptop", ram: 9000 });
    expect(run.resolve("auto", "Claude")).toEqual({ device: "pc:a", auto: true });
    // Another pick stays as it is.
    expect(run.resolve("pc:old", "Claude")).toEqual({ device: "pc:old", auto: false });
    // Only Claude chats go to other PCs: Codex stays here.
    expect(run.resolve("auto", "Codex")).toEqual({ device: "", auto: true });
  }, SLOW);

  test("this PC when it has the most, when sharing is off, and when nothing has a figure", () => {
    expect(rig({ here: 9001, peers: [peer("pc:a", "laptop", 9000)] }).run.resolve("auto", "Claude").device).toBe("");
    expect(rig({ here: 10, mesh: false, peers: [peer("pc:a", "laptop", 9000)] }).run.resolve("auto", "Claude").device).toBe("");
    const none = rig({ here: null, peers: [peer("pc:a", "laptop", null)] }).run;
    expect(none.autoPick("Claude")).toBeNull();
    expect(none.resolve("auto", "Claude")).toEqual({ device: "", auto: true });
  }, SLOW);

  test("a tie goes by name, so every PC picks the same", () => {
    expect(rig({ here: 5000, peers: [peer("pc:a", "box", 5000)] }).run.autoPick("Claude")?.id).toBe("pc:a");
    expect(rig({ here: 5000, peers: [peer("pc:a", "zeta", 5000)] }).run.autoPick("Claude")?.id).toBe("");
  }, SLOW);

  test("the draft's menu has Auto second, saying where it would go; a chat not started has none", () => {
    const { run, store } = rig({ here: 2048, peers: [peer("pc:a", "laptop", 12_595)] });
    const rows = run.rows(null, "auto", "Claude");
    expect(rows.map((r) => [r.id, r.name, r.current, r.enabled])).toEqual([
      ["", "This PC", false, true],
      ["auto", "Auto", true, true],
      ["pc:a", "laptop", false, true],
    ]);
    // Only Auto's row has a second line.
    expect(rows.map((r) => r.desc)).toEqual(["", "Most free memory now: laptop · 12.3 GB free", ""]);
    // A PC that's off can't be picked, and says why.
    const off = rig({ here: 1, peers: [peer("pc:off", "box", 1, { online: false })] }).run.rows(null, "", "Claude").find((r) => r.id === "pc:off");
    expect([off?.enabled, off?.desc]).toEqual([false, "Harbor · off"]);
    const c = store.createChat(blankChat({ title: "x", role: "lead", name: "lead" }));
    expect(run.rows(c.id, "", "Claude").some((r) => r.id === "auto")).toBe(false);
    const empty = rig({ here: null, peers: [] }).run.rows(null, "", "Claude").find((r) => r.id === "auto");
    expect([empty?.enabled, empty?.desc]).toEqual([false, "No PC can take it now"]);
  }, SLOW);

  test("a chat Auto placed says so while it's still there", () => {
    const { run, store } = rig({ here: 1, peers: [peer("pc:a", "laptop", 9000)] });
    const here = store.createChat(blankChat({ title: "here", role: "lead", name: "lead" }));
    const there = store.createChat(blankChat({ title: "there", role: "lead", name: "lead", gid: "g-there", home: "pc:a", homeId: 3 }));
    const plain = store.createChat(blankChat({ title: "plain", role: "lead", name: "lead" }));
    run.markAuto(here.gid, "");
    run.markAuto("g-there", "pc:a");
    expect(run.autoLabel(here)).toBe("Auto → This PC");
    expect(run.autoLabel(here, "desk")).toBe("Auto → desk");
    expect(run.autoLabel(there)).toBe("Auto → laptop");
    expect(run.autoLabel(plain)).toBeNull();
    // Moved elsewhere afterwards: no longer Auto's place.
    expect(run.autoLabel({ ...here, device: "ssh:1" })).toBeNull();
    expect(run.autoLabel({ ...there, home: "pc:b" })).toBeNull();
  }, SLOW);

  test("Auto names a PC as the menu's rows do: the device's own name before its Harbor's", () => {
    const { run } = rig({ here: 2048, peers: [peer("pc:a", "laptop", 12_595)], devices: [samDevice()] });
    expect(run.nameOf("pc:a")).toBe("Sam-Laptop");
    expect(run.nameOf("")).toBe("This PC");
    expect(run.nameOf("", "desk")).toBe("desk");
    expect(run.nameOf("pc:gone")).toBe("pc:gone");
    const rows = run.rows(null, "auto", "Claude");
    expect(rows.find((r) => r.id === "pc:a")?.name).toBe("Sam-Laptop");
    expect(rows.find((r) => r.id === "auto")?.desc).toBe("Most free memory now: Sam-Laptop · 12.3 GB free");
    expect(run.autoPick("Claude")).toEqual({ id: "pc:a", name: "Sam-Laptop", ram: 12_595 });
    const there = store.createChat(blankChat({ title: "there", role: "lead", name: "lead", gid: "g-sam", home: "pc:a", homeId: 4 }));
    run.markAuto("g-sam", "pc:a");
    expect(run.autoLabel(there)).toBe("Auto → Sam-Laptop");
    // A hidden device isn't a row of its own: the PC's row (and Auto) use its Harbor's name.
    const hidden = rig({ here: 2048, peers: [peer("pc:a", "laptop", 12_595)], devices: [samDevice({ hidden: true })] }).run;
    expect(hidden.autoPick("Claude")?.name).toBe("laptop");
    expect(hidden.rows(null, "", "Claude").find((r) => r.id === "pc:a")?.name).toBe("laptop");
    // Ties still go by the name each PC gives itself, the same on every PC ("box" < "desk", whatever the device is called).
    const tie = rig({ here: 5000, peers: [peer("pc:a", "box", 5000)], devices: [samDevice({ name: "zzz" })] }).run;
    expect(tie.autoPick("Claude")).toEqual({ id: "pc:a", name: "zzz", ram: 5000 });
  }, SLOW);

  test("a started chat's menu has Auto: picking it moves the chat there as a pick of that PC would", async () => {
    const running = new Set<number>();
    const { run } = rig({ here: 2048, peers: [peer("pc:a", "laptop", 12_595, { moves: true })], devices: [samDevice()], running });
    const c = store.createChat(blankChat({ title: "s", role: "lead", name: "lead", account: "claude", started: true, gid: "g-started" }));
    const rows = run.rows(c.id, "", "Claude");
    expect(rows.map((r) => [r.id, r.name, r.current, r.enabled])).toEqual([
      ["", "This PC", true, true],
      ["auto", "Auto", false, true],
      ["pc:a", "Sam-Laptop", false, true],
    ]);
    expect(rows[1]?.desc).toBe("Most free memory now: Sam-Laptop · 12.3 GB free");
    // The move itself is relocate's, the one a pick of that PC runs.
    const moves: [number, string][] = [];
    run.relocate = async (chatId: number, to: string) => {
      moves.push([chatId, to]);
      return "Sam-Laptop";
    };
    expect(await run.relocateAuto(c.id, "Claude")).toEqual({ to: "pc:a", name: "Sam-Laptop", moved: true });
    expect(moves).toEqual([[c.id, "pc:a"]]);
    // Once there (this PC's copy has its home on that PC), the composer says so.
    expect(run.autoLabel({ ...c, home: "pc:a" })).toBe("Auto → Sam-Laptop");
    // Not a choice for Codex chats, nor while it's running (the reason shows).
    expect(run.rows(c.id, "", "Codex").some((r) => r.id === "auto")).toBe(false);
    running.add(c.id);
    const busy = run.rows(c.id, "", "Claude").find((r) => r.id === "auto");
    expect([busy?.enabled, busy?.desc]).toEqual([false, "it is running: move it once its turn ends"]);
    expect(run.autoWhy(c.id, "Claude")).toBe("it is running: move it once its turn ends");
  }, SLOW);

  test("Auto in a started chat already on the PC with the most free memory moves nothing", async () => {
    const { run } = rig({ here: 64_000, peers: [peer("pc:a", "laptop", 12_595, { moves: true })] });
    const c = store.createChat(blankChat({ title: "h", role: "lead", name: "lead", account: "claude", started: true, gid: "g-stay" }));
    let called = false;
    run.relocate = async () => {
      called = true;
      return "";
    };
    expect(run.autoWhy(c.id, "Claude")).toBeNull();
    expect(await run.relocateAuto(c.id, "Claude")).toEqual({ to: "", name: "desk", moved: false });
    expect(called).toBe(false);
    expect(run.autoLabel(c)).toBe("Auto → This PC");
  }, SLOW);
});
