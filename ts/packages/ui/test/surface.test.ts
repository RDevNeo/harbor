import { expect, test } from "bun:test";
import { listeningPorts, type PaneTerm, Surfaces, tabTitle } from "../src/surface.ts";

const fake = (title: string, cwd: string) => {
  const t = { title, cwd, alive: true, killed: false, kill: () => void (t.killed = true) };
  return t;
};

function panes() {
  const spawned: ReturnType<typeof fake>[] = [];
  const focused: string[] = [];
  const s = new Surfaces<PaneTerm & { killed: boolean }>({
    spawn: (title, cwd) => {
      const t = fake(title, cwd);
      spawned.push(t);
      return t;
    },
    changed: () => {},
    focus: (d, terminal) => focused.push(`${d}:${terminal ? "terminal" : "chooser"}`),
  });
  return { s, spawned, focused };
}

test("a pane opens on its chooser, and what is picked there takes the chooser's tab", () => {
  const { s, focused } = panes();
  s.toggleDock("right");
  expect(s.panes.right.surfaces.map((x) => x.kind)).toEqual(["chooser"]);
  expect(focused).toEqual(["right:chooser"]);
  s.openTerminal("app", "/p/app", [], "right");
  expect(s.panes.right.surfaces.map((x) => x.kind)).toEqual(["terminal"]);
  expect(s.panes.right.open).toBe(true);
  s.toggleDock("right");
  expect(s.panes.right.open).toBe(false);
});

test("closing a pane's last tab hides it and ends its terminal", () => {
  const { s, spawned } = panes();
  s.openTerminal("app", "/p/app");
  expect(s.panes.bottom.open).toBe(true);
  s.close("bottom", 0);
  expect(spawned[0]?.killed).toBe(true);
  expect(s.panes.bottom.open).toBe(false);
});

test("Ctrl+` shows the folder's shell, opens one, or hides it", () => {
  const { s, spawned } = panes();
  s.toggleTerminal("/p/app");
  expect(spawned.map((t) => t.title)).toEqual(["app"]);
  s.toggleTerminal("/p/app");
  expect(s.panes.bottom.open).toBe(false);
  s.toggleTerminal("/p/app");
  expect(spawned).toHaveLength(1);
  s.toggleTerminal("/p/web");
  expect(spawned.map((t) => t.title)).toEqual(["app"]);
  s.hide("bottom");
  s.toggleTerminal("/p/web");
  expect(spawned.map((t) => t.title)).toEqual(["app", "web"]);
});

test("one browser tab, reused wherever it is; maximizing goes with hiding", () => {
  const { s } = panes();
  s.openBrowser("localhost:3000");
  s.openBrowser("https://example.com/", "bottom");
  expect(s.panes.right.surfaces).toEqual([{ kind: "browser", url: "https://example.com/" }]);
  expect(s.panes.bottom.surfaces).toEqual([]);
  expect(tabTitle(s.panes.right.surfaces[0] ?? { kind: "chooser" })).toBe("example.com");
  s.toggleMax("right");
  s.hide("right");
  expect(s.max).toBeNull();
  expect(tabTitle({ kind: "browser", url: `https://${"a".repeat(40)}` })).toHaveLength(26);
});

test("dev servers: loopback and every-address listeners, not Harbor's own or privileged ports", () => {
  const head = "  sl  local_address rem_address   st\n";
  const tcp = `${head}   0: 0100007F:0BB8 00000000:0000 0A\n   1: 00000000:1F90 00000000:0000 0A\n   2: 0100007F:BB30 00000000:0000 0A\n   3: 0100007F:0050 00000000:0000 0A\n   4: 0A00000A:1388 00000000:0000 0A\n   5: 0100007F:0BB9 00000000:0000 01\n`;
  const tcp6 = `${head}   0: 00000000000000000000000001000000:1771 00000000000000000000000000000000:0000 0A\n`;
  expect(listeningPorts([tcp, tcp6], 47920)).toEqual([3000, 6001, 8080]);
});

test("a live terminal in a folder or under it holds the folder; a dead one or a sibling doesn't", () => {
  const { s, spawned } = panes();
  s.openTerminal("wt", "/w/harbor-add-thing/src");
  expect(s.terminalIn("/w/harbor-add-thing")).toBe(true);
  expect(s.terminalIn("/w/harbor-add")).toBe(false);
  s.hide("bottom");
  expect(s.terminalIn("/w/harbor-add-thing/")).toBe(true);
  for (const t of spawned) t.alive = false;
  expect(s.terminalIn("/w/harbor-add-thing")).toBe(false);
});


test("Devices restores a maximized pane and cannot be maximized", () => {
  const { s } = panes();
  s.openBrowser("https://example.com");
  s.toggleMax("right");
  expect(s.max).toBe("right");
  s.openDevices("right");
  expect(s.max).toBeNull();
  s.toggleMax("right");
  expect(s.max).toBeNull();
  s.open("right", 0);
  s.toggleMax("right");
  expect(s.max).toBe("right");
  s.openDevices("right");
  expect(s.max).toBeNull();
});
