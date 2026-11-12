import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Header,
  type Msg,
  type V,
  dbusDecode,
  dbusEncode,
  dbusFirstType,
  dbusSig,
  dbusTargets,
  dbusTypes,
  dbusUnescape,
  dict,
  dv,
  introspect,
  layout,
  trayActive,
  trayHandle,
  trayIcon,
  trayItemProps,
  trayStart,
} from "../src/tray.ts";
import { tray as osTray } from "@harbor/os";

// trayStart talks D-Bus where the system has no tray of its own for Harbor (Linux); macOS's and Windows' are os.tray's.
const dbusTray = !osTray.available();

const MENU_PATH = "/MenuBar";
const MENU_IFACE = "com.canonical.dbusmenu";
const WATCHER = "org.kde.StatusNotifierWatcher";
const noHooks = { onOpen() {}, onQuit() {} };

const saved = {
  address: process.env.DBUS_SESSION_BUS_ADDRESS,
  runtime: process.env.XDG_RUNTIME_DIR,
  noTray: process.env.HARBOR_NO_TRAY,
};
let tmp = "";

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "harbor-tray-"));
  delete process.env.HARBOR_NO_TRAY;
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(tmp, "nothing")}`;
  process.env.XDG_RUNTIME_DIR = tmp;
});

afterEach(() => {
  restore("DBUS_SESSION_BUS_ADDRESS", saved.address);
  restore("XDG_RUNTIME_DIR", saved.runtime);
  restore("HARBOR_NO_TRAY", saved.noTray);
  rmSync(tmp, { recursive: true, force: true });
});

async function waitFor(what: string, ok: () => boolean): Promise<void> {
  const until = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function call(path: string, iface: string, member: string, body: V[] = []): Msg {
  return { kind: 1, flags: 0, serial: 1, path, iface, member, sender: null, replySerial: null, body };
}

/** A session bus that answers the login and the daemon's own methods, on a Unix socket in the temp dir. */
class FakeBus {
  readonly received: Msg[] = [];
  authLine = "";
  watcherAnswers = true;
  private server: Server;
  private socket: Socket | null = null;
  private serial = 100;
  private buf: Buffer = Buffer.alloc(0);
  private began = false;

  constructor(readonly path: string) {
    this.server = createServer((s) => {
      this.socket = s;
      s.on("data", (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        this.pump(s);
      });
      s.on("error", () => {});
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve));
  }

  close(): void {
    this.socket?.destroy();
    this.server.close();
  }

  private pump(s: Socket): void {
    if (this.authLine === "") {
      const i = this.buf.indexOf(0x0a);
      if (i < 0) return;
      this.authLine = this.buf.subarray(0, i + 1).toString("utf8");
      this.buf = this.buf.subarray(i + 1);
      s.write("OK 00112233445566778899aabbccddeeff\r\n");
    }
    if (!this.began) {
      const i = this.buf.indexOf(0x0a);
      if (i < 0) return;
      this.began = this.buf.subarray(0, i + 1).toString("utf8") === "BEGIN\r\n";
      this.buf = this.buf.subarray(i + 1);
    }
    for (;;) {
      if (this.buf.length < 16) return;
      const total = Math.ceil((16 + this.buf.readUInt32LE(12)) / 8) * 8 + this.buf.readUInt32LE(4);
      if (this.buf.length < total) return;
      const m = dbusDecode(this.buf.subarray(0, total));
      this.buf = this.buf.subarray(total);
      if (m !== null) this.handle(s, m);
    }
  }

  private handle(s: Socket, m: Msg): void {
    this.received.push(m);
    if (m.kind !== 1) return;
    const reply = (body: V[]): void => {
      s.write(dbusEncode(2, ++this.serial, { replySerial: m.serial }, body));
    };
    if (m.member === "Hello") reply([dv.s(":1.7")]);
    else if (m.member === "RequestName") reply([dv.u(1)]);
    else if (m.member === "AddMatch") reply([]);
    else if (m.member === "RegisterStatusNotifierItem" && this.watcherAnswers) reply([]);
  }

  send(kind: number, h: Header, body: V[]): number {
    const serial = ++this.serial;
    this.socket?.write(dbusEncode(kind, serial, h, body));
    return serial;
  }

  async ask(path: string, iface: string, member: string, body: V[] = []): Promise<Msg> {
    const serial = this.send(1, { path, iface, member }, body);
    await waitFor(`the answer to ${member}`, () => this.received.some((m) => m.replySerial === serial));
    const answer = this.received.find((m) => m.replySerial === serial);
    if (!answer) throw new Error("no answer");
    return answer;
  }

  registrations(): Msg[] {
    return this.received.filter((m) => m.member === "RegisterStatusNotifierItem");
  }
}

test("messages_round_trip", () => {
  const body = [dv.u(1), layout(0), dict(trayItemProps(false))];
  const h = { path: MENU_PATH, iface: MENU_IFACE, member: "GetLayout", dest: ":1.7" };
  const buf = dbusEncode(1, 9, h, body);
  const m = dbusDecode(buf);
  expect(m).not.toBeNull();
  expect([m?.kind, m?.serial, m?.path, m?.member]).toEqual([1, 9, MENU_PATH, "GetLayout"]);
  expect(m?.body).toEqual(body);
});

test("signatures", () => {
  expect(dbusTypes("ia{sv}av")).toEqual(["i", "a{sv}", "av"]);
  expect(dbusTypes("a(isvu)u")).toEqual(["a(isvu)", "u"]);
  expect(dbusSig(layout(0))).toBe("(ia{sv}av)");
  expect(dbusFirstType("(ii")).toBeNull();
});

test("menu_clicks_route", () => {
  const m = call(MENU_PATH, MENU_IFACE, "GetGroupProperties", [dv.a("i", [dv.i(3)]), dv.a("s", [])]);
  const r = trayHandle(m, noHooks);
  if (!("body" in r)) throw new Error("expected a reply");
  const first = r.body[0];
  if (first?.t !== "a") throw new Error("expected an array");
  expect(first.items.length).toBe(1);
  expect(JSON.stringify(first.items)).toContain("Quit Harbor completely");
});

test("icon_is_square_argb", () => {
  const px = trayIcon(32);
  expect(px.length).toBe(32 * 32 * 4);
  expect(px[0]).toBe(0);
  const mid = (16 * 32 + 16) * 4;
  expect(px[mid]).toBe(255);
});

test("address_unescapes", () => {
  expect(dbusUnescape("/run/user/1000/bus")).toBe("/run/user/1000/bus");
  expect(dbusUnescape("/tmp/a%20b")).toBe("/tmp/a b");
});

test.if(dbusTray)("the tray talks to a fake session bus: registers, serves the menu, routes clicks, follows the watcher", async () => {
  const fake = new FakeBus(join(tmp, "bus-socket"));
  await fake.listen();
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${fake.path}`;
  const events: string[] = [];
  const errors: string[] = [];
  let hidden = false;
  const tray = trayStart({
    onOpen: () => events.push("open"),
    onQuit: () => events.push("quit"),
    hidden: () => hidden,
    onError: (m) => errors.push(m),
  });
  try {
    expect(tray).not.toBeNull();
    await waitFor("the tray to be active", trayActive);

    const uid = Array.from(String(process.getuid?.() ?? 0), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    expect(fake.authLine).toBe(`\0AUTH EXTERNAL ${uid}\r\n`);
    expect(fake.received.slice(0, 4).map((m) => m.member)).toEqual(["Hello", "RequestName", "AddMatch", "RegisterStatusNotifierItem"]);
    const name = fake.registrations()[0]?.body[0];
    expect(name?.t === "s" && name.v.startsWith("org.kde.StatusNotifierItem-")).toBe(true);
    expect(fake.received[1]?.body[1]).toEqual(dv.u(4));

    const lay = await fake.ask(MENU_PATH, MENU_IFACE, "GetLayout", [dv.i(0), dv.i(-1), dv.a("s", [])]);
    expect(lay.kind).toBe(2);
    expect(lay.body).toEqual([dv.u(1), layout(0)]);

    const all = await fake.ask("/StatusNotifierItem", "org.freedesktop.DBus.Properties", "GetAll", [dv.s("org.kde.StatusNotifierItem")]);
    expect(JSON.stringify(all.body)).toContain('"Open"');
    hidden = true;
    const again = await fake.ask("/StatusNotifierItem", "org.freedesktop.DBus.Properties", "Get", [dv.s("org.kde.StatusNotifierItem"), dv.s("ToolTip")]);
    expect(JSON.stringify(again.body)).toContain("Running in the background");

    await fake.ask(MENU_PATH, MENU_IFACE, "Event", [dv.i(1), dv.s("clicked"), dv.variant(dv.s("")), dv.u(0)]);
    await fake.ask(MENU_PATH, MENU_IFACE, "Event", [dv.i(1), dv.s("hovered"), dv.variant(dv.s("")), dv.u(0)]);
    await fake.ask(MENU_PATH, MENU_IFACE, "Event", [dv.i(3), dv.s("clicked"), dv.variant(dv.s("")), dv.u(0)]);
    await fake.ask("/StatusNotifierItem", "org.kde.StatusNotifierItem", "Activate", [dv.i(0), dv.i(0)]);
    expect(events).toEqual(["open", "quit", "open"]);

    const bad = await fake.ask("/StatusNotifierItem", "org.kde.StatusNotifierItem", "Explode");
    expect(bad.kind).toBe(3);
    expect(bad.body).toEqual([dv.s("org.freedesktop.DBus.Error.UnknownMethod")]);

    fake.send(4, { path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "NameOwnerChanged" }, [dv.s(WATCHER), dv.s(":1.3"), dv.s("")]);
    await waitFor("the tray to go off with its host", () => !trayActive());
    expect(fake.registrations().length).toBe(1);

    fake.send(4, { path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "NameOwnerChanged" }, [dv.s(WATCHER), dv.s(""), dv.s(":1.9")]);
    await waitFor("the tray to come back with the host", trayActive);
    expect(fake.registrations().length).toBe(2);

    tray?.stop();
    await tray?.done;
    expect(trayActive()).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    tray?.stop();
    fake.close();
  }
});

test.if(dbusTray)("a refused registration leaves the tray inactive until a host answers", async () => {
  const fake = new FakeBus(join(tmp, "bus-socket"));
  fake.watcherAnswers = false;
  await fake.listen();
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${fake.path}`;
  const tray = trayStart({ ...noHooks, onError: () => {} });
  try {
    await waitFor("the registration", () => fake.registrations().length === 1);
    expect(trayActive()).toBe(false);
    const serial = fake.registrations()[0]?.serial ?? 0;
    fake.send(3, { replySerial: serial, error: "org.freedesktop.DBus.Error.ServiceUnknown" }, [dv.s("no watcher")]);
    await new Promise((r) => setTimeout(r, 30));
    expect(trayActive()).toBe(false);
  } finally {
    tray?.stop();
    fake.close();
  }
});

test("HARBOR_NO_TRAY keeps the tray off and never connects", async () => {
  const fake = new FakeBus(join(tmp, "bus-socket"));
  await fake.listen();
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${fake.path}`;
  process.env.HARBOR_NO_TRAY = "";
  try {
    expect(trayStart(noHooks)).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.received).toEqual([]);
    expect(fake.authLine).toBe("");
  } finally {
    fake.close();
  }
});

test.if(dbusTray)("no session bus: the tray reports it and stays off", async () => {
  const errors: string[] = [];
  const tray = trayStart({ ...noHooks, onError: (m) => errors.push(m) });
  await tray?.done;
  expect(trayActive()).toBe(false);
  expect(errors).toEqual(["harbor: no tray icon: no D-Bus session bus"]);
});

test.if(dbusTray)("a bus that refuses the login is reported", async () => {
  const path = join(tmp, "refusing");
  const server = createServer((s) => {
    s.on("data", () => s.write("REJECTED EXTERNAL\r\n"));
    s.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path}`;
  const errors: string[] = [];
  const tray = trayStart({ ...noHooks, onError: (m) => errors.push(m) });
  await tray?.done;
  server.close();
  expect(errors).toEqual(["harbor: no tray icon: D-Bus refused the login: REJECTED EXTERNAL"]);
});

test("addresses: every unix entry is tried, the last path or abstract wins, the runtime dir is only the fallback", () => {
  expect(dbusTargets("unix:path=/a%20b;tcp:host=x;unix:abstract=/tmp/dbus-x,guid=1", "/run/u")).toEqual([{ path: "/a b" }, { abstract: "/tmp/dbus-x" }]);
  expect(dbusTargets("unix:path=/a,abstract=b", "/run/u")).toEqual([{ abstract: "b" }]);
  expect(dbusTargets("", "/run/u")).toEqual([{ path: "/run/u/bus" }]);
  expect(dbusTargets("", undefined)).toEqual([]);
  expect(dbusTargets("tcp:host=x", "/run/u")).toEqual([]);
});

test("the decoder refuses what is cut short or is not a message", () => {
  const buf = dbusEncode(1, 2, { path: MENU_PATH, iface: MENU_IFACE, member: "GetLayout" }, [dv.s("hello")]);
  expect(dbusDecode(buf.subarray(0, buf.length - 1))).toBeNull();
  expect(dbusDecode(Uint8Array.from([0x78, 1, 0, 1]))).toBeNull();
});

test("introspection names the item and the menu", () => {
  expect(introspect("/StatusNotifierItem")).toContain('<interface name="org.kde.StatusNotifierItem">');
  expect(introspect(MENU_PATH)).toContain('<interface name="com.canonical.dbusmenu">');
  expect(introspect("/other")).not.toContain("StatusNotifierItem");
  expect(introspect("/other")).toContain('<arg type="a{sv}" direction="out"/>');
});

test("the menu-bar icon: the anchor alone, black with alpha, as a PNG any decoder reads", async () => {
  const { pngOf, templateIcon } = await import("../src/tray.ts");
  const n = 36;
  const px = templateIcon(n);
  const alpha = (x: number, y: number) => px[(y * n + x) * 4 + 3] ?? 0;
  // Corners are transparent; the anchor's shaft runs down the middle.
  expect([alpha(0, 0), alpha(n - 1, n - 1)]).toEqual([0, 0]);
  expect(alpha(n / 2, Math.round(n * 0.62))).toBeGreaterThan(200);
  for (let i = 0; i < n * n; i++) expect(px[i * 4]! + px[i * 4 + 1]! + px[i * 4 + 2]!).toBe(0);
  const sharp = (await import("sharp")).default;
  const meta = await sharp(Buffer.from(pngOf(px, n, n))).metadata();
  expect([meta.format, meta.width, meta.height, meta.channels]).toEqual(["png", n, n, 4]);
  const back = await sharp(Buffer.from(pngOf(px, n, n))).raw().toBuffer();
  expect([...new Uint8Array(back)]).toEqual([...px]);
});
