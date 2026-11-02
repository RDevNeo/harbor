import { createConnection, type Socket } from "node:net";

const WATCHER = "org.kde.StatusNotifierWatcher";
const ITEM_PATH = "/StatusNotifierItem";
const MENU_PATH = "/MenuBar";
const MENU_OPEN = 1;
const MENU_QUIT = 3;

let ACTIVE = false;

/** A tray host shows Harbor's icon. */
export function trayActive(): boolean {
  return ACTIVE;
}

/** What the tray needs from the shell: opening the window, quitting, and whether there is no window. */
export interface TrayHooks {
  onOpen(): void;
  onQuit(): void;
  hidden?(): boolean;
  onError?(message: string): void;
}

export interface TrayHandle {
  /** Settles when the bus connection ends (stop() or an error). */
  readonly done: Promise<void>;
  stop(): void;
}

/** Starts the tray (HARBOR_NO_TRAY set: null). Never throws: no bus, no tray. */
export function trayStart(hooks: TrayHooks): TrayHandle | null {
  if (process.env.HARBOR_NO_TRAY !== undefined) return null;
  let bus: Bus | null = null;
  let stopped = false;
  const done = (async () => {
    try {
      bus = await Bus.connect();
      if (stopped) {
        bus.close();
        return;
      }
      await run(bus, hooks);
    } catch (e) {
      ACTIVE = false;
      if (stopped) return;
      const message = `harbor: no tray icon: ${e instanceof Error ? e.message : String(e)}`;
      (hooks.onError ?? ((m: string) => console.error(m)))(message);
    }
  })();
  return {
    done,
    stop() {
      stopped = true;
      ACTIVE = false;
      bus?.close();
    },
  };
}

async function run(bus: Bus, hooks: TrayHooks): Promise<void> {
  const DBUS = "org.freedesktop.DBus";
  bus.call(DBUS, "/org/freedesktop/DBus", DBUS, "Hello", []);
  const name = `org.kde.StatusNotifierItem-${process.pid}-1`;
  bus.call(DBUS, "/org/freedesktop/DBus", DBUS, "RequestName", [dv.s(name), dv.u(4)]);
  const rule = `type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${WATCHER}'`;
  bus.call(DBUS, "/org/freedesktop/DBus", DBUS, "AddMatch", [dv.s(rule)]);
  const register = (): number | null => {
    try {
      return bus.call(WATCHER, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem", [dv.s(name)]);
    } catch {
      return null;
    }
  };
  let pending = register();
  for (;;) {
    const m = await bus.read();
    if ((m.kind === 2 || m.kind === 3) && m.replySerial !== null && m.replySerial === pending) {
      ACTIVE = m.kind === 2;
      pending = null;
    } else if (m.kind === 4 && m.member === "NameOwnerChanged") {
      const [n, , owner] = m.body;
      if (n?.t === "s" && owner?.t === "s" && n.v === WATCHER) {
        ACTIVE = false;
        if (owner.v !== "") pending = register();
      }
    } else if (m.kind === 1) {
      const reply = trayHandle(m, hooks);
      if ((m.flags & 1) === 0) {
        if ("body" in reply) bus.send(2, { dest: m.sender, replySerial: m.serial }, reply.body);
        else bus.send(3, { dest: m.sender, replySerial: m.serial, error: reply.error }, [dv.s(reply.error)]);
      }
    }
  }
}

export type TrayReply = { body: V[] } | { error: string };

/** Answers a method call: the item, its menu, properties, introspection. */
export function trayHandle(m: Msg, hooks: Pick<TrayHooks, "onOpen" | "onQuit" | "hidden">): TrayReply {
  const s = (i: number): string => {
    const x = m.body[i];
    return x?.t === "s" ? x.v : "";
  };
  const int = (i: number): number => {
    const x = m.body[i];
    return x?.t === "i" ? x.v : 0;
  };
  const prop = (list: Prop[], missing: string): TrayReply => {
    const found = list.find(([k]) => k === s(1));
    return found ? { body: [dv.variant(found[1])] } : { error: missing };
  };
  const ok = (body: V[]): TrayReply => ({ body });
  const unknownProp = "org.freedesktop.DBus.Error.UnknownProperty";
  const item = m.path === ITEM_PATH;
  const menu = m.path === MENU_PATH;

  if (m.iface === "org.freedesktop.DBus.Peer" && m.member === "Ping") return ok([]);
  if (m.iface === "org.freedesktop.DBus.Introspectable" && m.member === "Introspect") return ok([dv.s(introspect(m.path))]);
  if (m.iface === "org.freedesktop.DBus.Properties") {
    if (item && m.member === "Get") return prop(itemProps(hooks.hidden?.() ?? false), unknownProp);
    if (item && m.member === "GetAll") return ok([dict(s(0) === "org.kde.StatusNotifierItem" ? itemProps(hooks.hidden?.() ?? false) : [])]);
    if (menu && m.member === "Get") return prop(menuProps(), unknownProp);
    if (menu && m.member === "GetAll") return ok([dict(s(0) === "com.canonical.dbusmenu" ? menuProps() : [])]);
  }
  if (item) {
    if (m.member === "Activate" || m.member === "SecondaryActivate") {
      hooks.onOpen();
      return ok([]);
    }
    if (m.member === "ContextMenu" || m.member === "Scroll" || m.member === "ProvideXdgActivationToken") return ok([]);
  }
  if (menu) {
    switch (m.member) {
      case "GetLayout":
        return ok([dv.u(1), layout(int(0))]);
      case "GetGroupProperties": {
        const first = m.body[0];
        const ids =
          first?.t === "a" && first.items.length > 0
            ? first.items.flatMap((v) => (v.t === "i" ? [v.v] : []))
            : [0, MENU_OPEN, 2, MENU_QUIT];
        return ok([dv.a("(ia{sv})", ids.map((id) => dv.r([dv.i(id), dict(entryProps(id))])))]);
      }
      case "GetProperty":
        return prop(entryProps(int(0)), "com.canonical.dbusmenu.Error.UnknownProperty");
      case "Event":
        if (s(1) === "clicked") clicked(hooks, int(0));
        return ok([]);
      case "EventGroup": {
        const events = m.body[0];
        if (events?.t === "a") {
          for (const e of events.items) {
            if (e.t !== "r") continue;
            const [id, ev] = e.items;
            if (id?.t === "i" && ev?.t === "s" && ev.v === "clicked") clicked(hooks, id.v);
          }
        }
        return ok([dv.a("i", [])]);
      }
      case "AboutToShow":
        return ok([dv.b(false)]);
      case "AboutToShowGroup":
        return ok([dv.a("i", []), dv.a("i", [])]);
    }
  }
  return { error: "org.freedesktop.DBus.Error.UnknownMethod" };
}

function clicked(hooks: Pick<TrayHooks, "onOpen" | "onQuit">, id: number): void {
  if (id === MENU_OPEN) hooks.onOpen();
  else if (id === MENU_QUIT) hooks.onQuit();
}

type Prop = readonly [string, V];

export function dict(props: readonly Prop[]): V {
  return dv.a(
    "{sv}",
    props.map(([k, v]) => dv.e(dv.s(k), dv.variant(v))),
  );
}

export function trayItemProps(hidden: boolean): Prop[] {
  return itemProps(hidden);
}

function itemProps(hidden: boolean): Prop[] {
  const tip = hidden ? "Running in the background" : "Open";
  return [
    ["Category", dv.s("ApplicationStatus")],
    ["Id", dv.s("harbor")],
    ["Title", dv.s("Harbor")],
    ["Status", dv.s("Active")],
    ["WindowId", dv.i(0)],
    ["IconName", dv.s("harbor")],
    ["IconThemePath", dv.s("")],
    ["IconPixmap", pixmaps()],
    ["OverlayIconName", dv.s("")],
    ["AttentionIconName", dv.s("")],
    ["ToolTip", dv.r([dv.s(""), dv.a("(iiay)", []), dv.s("Harbor"), dv.s(tip)])],
    ["ItemIsMenu", dv.b(false)],
    ["Menu", dv.o(MENU_PATH)],
  ];
}

function menuProps(): Prop[] {
  return [
    ["Version", dv.u(3)],
    ["TextDirection", dv.s("ltr")],
    ["Status", dv.s("normal")],
    ["IconThemePath", dv.a("s", [])],
  ];
}

function entryProps(id: number): Prop[] {
  switch (id) {
    case 0:
      return [["children-display", dv.s("submenu")]];
    case MENU_OPEN:
      return [
        ["label", dv.s("Open Harbor")],
        ["enabled", dv.b(true)],
        ["visible", dv.b(true)],
      ];
    case MENU_QUIT:
      return [
        ["label", dv.s("Quit Harbor completely")],
        ["enabled", dv.b(true)],
        ["visible", dv.b(true)],
      ];
    case 2:
      return [
        ["type", dv.s("separator")],
        ["visible", dv.b(true)],
      ];
    default:
      return [];
  }
}

/** The menu as (ia{sv}av): the root and its three entries. */
export function layout(parent: number): V {
  const node = (id: number, children: V[]): V => dv.r([dv.i(id), dict(entryProps(id)), dv.a("v", children)]);
  const entries = [MENU_OPEN, 2, MENU_QUIT].map((id) => dv.variant(node(id, [])));
  return parent === 0 ? node(0, entries) : node(parent, []);
}

const ITEM_XML =
  '<interface name="org.kde.StatusNotifierItem"><method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method><method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method><method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method><method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method><property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/><property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/><property name="WindowId" type="i" access="read"/><property name="IconName" type="s" access="read"/><property name="IconThemePath" type="s" access="read"/><property name="IconPixmap" type="a(iiay)" access="read"/><property name="OverlayIconName" type="s" access="read"/><property name="AttentionIconName" type="s" access="read"/><property name="ToolTip" type="(sa(iiay)ss)" access="read"/><property name="ItemIsMenu" type="b" access="read"/><property name="Menu" type="o" access="read"/></interface>';

const MENU_XML =
  '<interface name="com.canonical.dbusmenu"><method name="GetLayout"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/><arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/></method><method name="GetGroupProperties"><arg type="ai" direction="in"/><arg type="as" direction="in"/><arg type="a(ia{sv})" direction="out"/></method><method name="GetProperty"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method><method name="Event"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/></method><method name="EventGroup"><arg type="a(isvu)" direction="in"/><arg type="ai" direction="out"/></method><method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method><method name="AboutToShowGroup"><arg type="ai" direction="in"/><arg type="ai" direction="out"/><arg type="ai" direction="out"/></method><signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal><property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/><property name="Status" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/></interface>';

export function introspect(path: string): string {
  const body = path === ITEM_PATH ? ITEM_XML : path === MENU_PATH ? MENU_XML : "";
  return `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd"><node><interface name="org.freedesktop.DBus.Introspectable"><method name="Introspect"><arg type="s" direction="out"/></method></interface><interface name="org.freedesktop.DBus.Properties"><method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method><method name="GetAll"><arg type="s" direction="in"/><arg type="a{sv}" direction="out"/></method></interface>${body}</node>`;
}

/** Harbor's icon (Lucide's anchor on a dark rounded square) for hosts without the "harbor" theme icon. */
function pixmaps(): V {
  return dv.a(
    "(iiay)",
    [22, 32, 48, 64].map((n) => dv.r([dv.i(n), dv.i(n), dv.a("y", Array.from(trayIcon(n), (b) => dv.y(b)))])),
  );
}

/** ARGB32 in network byte order, n by n pixels (computed in f64: edge pixels may differ by one from the Rust f32). */
export function trayIcon(n: number): Uint8Array {
  const px = 512 / n; // svg units per pixel
  const seg = (p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.sqrt((p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2);
  };
  const out = new Uint8Array(n * n * 4);
  let o = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const sx = (x + 0.5) * px;
      const sy = (y + 0.5) * px;
      // Rounded square, radius 112.
      const qx = Math.abs(sx - 256) - (256 - 112);
      const qy = Math.abs(sy - 256) - (256 - 112);
      const dBox = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) + Math.min(Math.max(qx, qy), 0) - 112;
      const bg = Math.min(1, Math.max(0, 0.5 - dBox / px));
      // The anchor, in its 24-unit space (translate 88, scale 14), stroke 2.
      const p: readonly [number, number] = [(sx - 88) / 14, (sy - 88) / 14];
      const ring = Math.sqrt((p[0] - 12) ** 2 + (p[1] - 5) ** 2);
      const arc = Math.sqrt((p[0] - 12) ** 2 + (p[1] - 12) ** 2);
      const d = Math.min(
        seg(p, [12, 22], [12, 8]),
        seg(p, [5, 12], [2, 12]),
        seg(p, [22, 12], [19, 12]),
        Math.abs(ring - 3),
        p[1] >= 12 ? Math.abs(arc - 10) : Number.MAX_VALUE,
      );
      const fg = Math.min(1, Math.max(0, 0.5 - ((d - 1) * 14) / px)) * bg;
      const c = Math.round(0x11 + (0xed - 0x11) * fg);
      out[o++] = Math.round(bg * 255);
      out[o++] = c;
      out[o++] = c;
      out[o++] = c;
    }
  }
  return out;
}


/** A D-Bus value. Arrays carry their element signature (empty arrays need it). */
export type V =
  | { t: "y"; v: number }
  | { t: "b"; v: boolean }
  | { t: "i"; v: number }
  | { t: "u"; v: number }
  | { t: "s"; v: string }
  | { t: "o"; v: string }
  | { t: "g"; v: string }
  | { t: "a"; elem: string; items: V[] }
  | { t: "r"; items: V[] }
  | { t: "var"; v: V }
  | { t: "e"; k: V; v: V };

export const dv = {
  y: (v: number): V => ({ t: "y", v }),
  b: (v: boolean): V => ({ t: "b", v }),
  i: (v: number): V => ({ t: "i", v }),
  u: (v: number): V => ({ t: "u", v }),
  s: (v: string): V => ({ t: "s", v }),
  o: (v: string): V => ({ t: "o", v }),
  g: (v: string): V => ({ t: "g", v }),
  a: (elem: string, items: V[]): V => ({ t: "a", elem, items }),
  r: (items: V[]): V => ({ t: "r", items }),
  variant: (v: V): V => ({ t: "var", v }),
  e: (k: V, v: V): V => ({ t: "e", k, v }),
};

export function dbusSig(v: V): string {
  switch (v.t) {
    case "y":
    case "b":
    case "i":
    case "u":
    case "s":
    case "o":
    case "g":
      return v.t;
    case "a":
      return `a${v.elem}`;
    case "r":
      return `(${v.items.map(dbusSig).join("")})`;
    case "var":
      return "v";
    case "e":
      return `{${dbusSig(v.k)}${dbusSig(v.v)}}`;
  }
}

function alignment(sig: string): number {
  switch (sig[0]) {
    case "n":
    case "q":
      return 2;
    case "b":
    case "i":
    case "u":
    case "s":
    case "o":
    case "a":
    case "h":
      return 4;
    case "x":
    case "t":
    case "d":
    case "(":
    case "{":
      return 8;
    default:
      return 1;
  }
}

/** Length of the first complete type in a signature, null when it is cut short. */
export function dbusFirstType(sig: string): number | null {
  const c = sig[0];
  if (c === undefined) return null;
  if (c === "a") {
    const n = dbusFirstType(sig.slice(1));
    return n === null ? null : 1 + n;
  }
  if (c === "(" || c === "{") {
    const close = c === "(" ? ")" : "}";
    let i = 1;
    for (;;) {
      const at = sig[i];
      if (at === undefined) return null;
      if (at === close) return i + 1;
      const n = dbusFirstType(sig.slice(i));
      if (n === null) return null;
      i += n;
    }
  }
  return 1;
}

export function dbusTypes(sig: string): string[] {
  const out: string[] = [];
  for (;;) {
    const n = dbusFirstType(sig);
    if (n === null) return out;
    out.push(sig.slice(0, n));
    sig = sig.slice(n);
  }
}

const utf8 = new TextEncoder();
const lossy = new TextDecoder();

class Writer {
  readonly bytes: number[] = [];

  pad(n: number): void {
    while (this.bytes.length % n !== 0) this.bytes.push(0);
  }

  u32(n: number): void {
    this.pad(4);
    this.bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  }

  raw(b: Uint8Array): void {
    for (const x of b) this.bytes.push(x);
  }

  put(v: V): void {
    switch (v.t) {
      case "y":
        this.bytes.push(v.v & 0xff);
        break;
      case "b":
        this.u32(v.v ? 1 : 0);
        break;
      case "i":
      case "u":
        this.u32(v.v >>> 0);
        break;
      case "s":
      case "o": {
        const b = utf8.encode(v.v);
        this.u32(b.length);
        this.raw(b);
        this.bytes.push(0);
        break;
      }
      case "g": {
        const b = utf8.encode(v.v);
        this.bytes.push(b.length & 0xff);
        this.raw(b);
        this.bytes.push(0);
        break;
      }
      case "a": {
        this.u32(0);
        const at = this.bytes.length - 4;
        this.pad(alignment(v.elem));
        const start = this.bytes.length;
        for (const item of v.items) this.put(item);
        const n = this.bytes.length - start;
        this.bytes[at] = n & 0xff;
        this.bytes[at + 1] = (n >>> 8) & 0xff;
        this.bytes[at + 2] = (n >>> 16) & 0xff;
        this.bytes[at + 3] = (n >>> 24) & 0xff;
        break;
      }
      case "r":
        this.pad(8);
        for (const item of v.items) this.put(item);
        break;
      case "e":
        this.pad(8);
        this.put(v.k);
        this.put(v.v);
        break;
      case "var":
        this.put(dv.g(dbusSig(v.v)));
        this.put(v.v);
        break;
    }
  }
}

class Reader {
  constructor(
    readonly b: Uint8Array,
    public p: number,
    readonly be: boolean,
  ) {}

  align(n: number): void {
    this.p = Math.ceil(this.p / n) * n;
  }

  take(n: number): Uint8Array | null {
    if (n < 0 || this.p + n > this.b.length) return null;
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }

  u32(): number | null {
    this.align(4);
    const b = this.take(4);
    if (b === null) return null;
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, !this.be);
  }

  read(t: string, depth: number): V | null {
    if (depth > 32) return null;
    switch (t[0]) {
      case "y": {
        const b = this.take(1);
        return b === null ? null : dv.y(b[0] ?? 0);
      }
      case "b": {
        const n = this.u32();
        return n === null ? null : dv.b(n !== 0);
      }
      case "i": {
        const n = this.u32();
        return n === null ? null : dv.i(n | 0);
      }
      case "u":
      case "h": {
        const n = this.u32();
        return n === null ? null : dv.u(n);
      }
      case "n":
      case "q":
        this.align(2);
        return this.take(2) === null ? null : dv.u(0);
      case "x":
      case "t":
      case "d":
        this.align(8);
        return this.take(8) === null ? null : dv.u(0);
      case "s":
      case "o": {
        const n = this.u32();
        if (n === null) return null;
        const b = this.take(n);
        if (b === null) return null;
        const s = lossy.decode(b);
        if (this.take(1) === null) return null;
        return t[0] === "s" ? dv.s(s) : dv.o(s);
      }
      case "g": {
        const n = this.take(1)?.[0];
        if (n === undefined) return null;
        const b = this.take(n);
        if (b === null) return null;
        const s = lossy.decode(b);
        if (this.take(1) === null) return null;
        return dv.g(s);
      }
      case "v": {
        const sig = this.read("g", depth + 1);
        if (sig === null || sig.t !== "g") return null;
        if (dbusFirstType(sig.v) !== sig.v.length) return null;
        const inner = this.read(sig.v, depth + 1);
        return inner === null ? null : dv.variant(inner);
      }
      case "a": {
        const elem = t.slice(1);
        const n = this.u32();
        if (n === null) return null;
        this.align(alignment(elem));
        const end = this.p + n;
        if (end > this.b.length) return null;
        const items: V[] = [];
        while (this.p < end) {
          const before = this.p;
          const item = this.read(elem, depth + 1);
          if (item === null) return null;
          items.push(item);
          if (this.p === before) return null;
        }
        return dv.a(elem, items);
      }
      case "(": {
        this.align(8);
        const items: V[] = [];
        for (const f of dbusTypes(t.slice(1, -1))) {
          const item = this.read(f, depth + 1);
          if (item === null) return null;
          items.push(item);
        }
        return dv.r(items);
      }
      case "{": {
        this.align(8);
        const [kt, vt] = dbusTypes(t.slice(1, -1));
        if (kt === undefined || vt === undefined) return null;
        const k = this.read(kt, depth + 1);
        if (k === null) return null;
        const v = this.read(vt, depth + 1);
        return v === null ? null : dv.e(k, v);
      }
      default:
        return null;
    }
  }
}

export interface Msg {
  kind: number;
  flags: number;
  serial: number;
  path: string;
  iface: string;
  member: string;
  sender: string | null;
  replySerial: number | null;
  body: V[];
}

export interface Header {
  path?: string | null;
  iface?: string | null;
  member?: string | null;
  dest?: string | null;
  error?: string | null;
  replySerial?: number | null;
}

export function dbusEncode(kind: number, serial: number, h: Header, body: readonly V[]): Uint8Array {
  const b = new Writer();
  for (const v of body) b.put(v);
  const sig = body.map(dbusSig).join("");
  const fields: V[] = [];
  const field = (code: number, v: V): void => {
    fields.push(dv.r([dv.y(code), dv.variant(v)]));
  };
  if (h.path != null) field(1, dv.o(h.path));
  if (h.iface != null) field(2, dv.s(h.iface));
  if (h.member != null) field(3, dv.s(h.member));
  if (h.error != null) field(4, dv.s(h.error));
  if (h.replySerial != null) field(5, dv.u(h.replySerial));
  if (h.dest != null) field(6, dv.s(h.dest));
  if (sig !== "") field(8, dv.g(sig));
  const w = new Writer();
  w.bytes.push(0x6c, kind, 0, 1);
  w.u32(b.bytes.length);
  w.u32(serial);
  w.put(dv.a("(yv)", fields));
  w.pad(8);
  return Uint8Array.from([...w.bytes, ...b.bytes]);
}

export function dbusDecode(buf: Uint8Array): Msg | null {
  const first = buf[0];
  if (first !== 0x6c && first !== 0x42) return null;
  const be = first === 0x42;
  const r = new Reader(buf, 4, be);
  const bodyLen = r.u32();
  const serial = r.u32();
  if (bodyLen === null || serial === null) return null;
  const list = r.read("a(yv)", 0);
  if (list === null || list.t !== "a") return null;
  r.align(8);
  const flags = buf[2];
  if (flags === undefined) return null;
  const m: Msg = { kind: buf[1] ?? 0, flags, serial, path: "", iface: "", member: "", sender: null, replySerial: null, body: [] };
  let sig = "";
  for (const f of list.items) {
    if (f.t !== "r") continue;
    const [code, wrapped] = f.items;
    if (code?.t !== "y" || wrapped?.t !== "var") continue;
    const v = wrapped.v;
    if (code.v === 1 && v.t === "o") m.path = v.v;
    else if (code.v === 2 && v.t === "s") m.iface = v.v;
    else if (code.v === 3 && v.t === "s") m.member = v.v;
    else if (code.v === 5 && v.t === "u") m.replySerial = v.v;
    else if (code.v === 7 && v.t === "s") m.sender = v.v;
    else if (code.v === 8 && v.t === "g") sig = v.v;
  }
  const start = r.p;
  const end = start + bodyLen;
  if (end > buf.length) return null;
  // Body alignment counts from the start of the message.
  const body = new Reader(buf.subarray(0, end), start, be);
  const values: V[] = [];
  for (const t of dbusTypes(sig)) {
    const v = body.read(t, 0);
    if (v === null) {
      values.length = 0;
      break;
    }
    values.push(v);
  }
  m.body = values;
  return m;
}

export type BusTarget = { path: string } | { abstract: string };

/** D-Bus address values escape bytes as %xx. */
export function dbusUnescape(s: string): string {
  const b = utf8.encode(s);
  const out: number[] = [];
  let i = 0;
  while (i < b.length) {
    if (b[i] === 0x25 && i + 2 < b.length) {
      const hex = lossy.decode(b.subarray(i + 1, i + 3));
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    out.push(b[i] ?? 0);
    i++;
  }
  return lossy.decode(Uint8Array.from(out));
}

/** The sockets to try, in order: each unix: entry (its last path=/abstract= wins), else $XDG_RUNTIME_DIR/bus when there is no address. */
export function dbusTargets(address: string, runtimeDir: string | undefined): BusTarget[] {
  const targets: BusTarget[] = [];
  for (const entry of address.split(";")) {
    if (!entry.startsWith("unix:")) continue;
    let target: BusTarget | null = null;
    for (const kv of entry.slice("unix:".length).split(",")) {
      if (kv.startsWith("path=")) target = { path: dbusUnescape(kv.slice(5)) };
      else if (kv.startsWith("abstract=")) target = { abstract: dbusUnescape(kv.slice(9)) };
    }
    if (target !== null) targets.push(target);
  }
  if (address === "" && runtimeDir !== undefined) targets.push({ path: `${runtimeDir}/bus` });
  return targets;
}

function connectTo(target: BusTarget): Promise<Socket> {
  const path = "path" in target ? target.path : `\0${target.abstract}`;
  return new Promise((resolve, reject) => {
    const s = createConnection({ path });
    s.once("connect", () => {
      s.removeAllListeners("error");
      resolve(s);
    });
    s.once("error", (e) => {
      s.destroy();
      reject(e);
    });
  });
}

export class Bus {
  private serial = 0;
  private buf: Buffer = Buffer.alloc(0);
  private failure: string | null = null;
  private waiting: (() => void) | null = null;

  private constructor(private readonly s: Socket) {
    s.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.waiting?.();
    });
    s.on("error", (e) => {
      this.failure ??= e.message;
      this.waiting?.();
    });
    s.on("close", () => {
      this.failure ??= "D-Bus connection closed";
      this.waiting?.();
    });
  }

  /** Connects to $DBUS_SESSION_BUS_ADDRESS and logs in (SASL EXTERNAL with our uid, hex-encoded). */
  static async connect(): Promise<Bus> {
    const address = process.env.DBUS_SESSION_BUS_ADDRESS ?? "";
    let socket: Socket | null = null;
    for (const t of dbusTargets(address, process.env.XDG_RUNTIME_DIR)) {
      try {
        socket = await connectTo(t);
        break;
      } catch {
        continue;
      }
    }
    if (socket === null) throw new Error("no D-Bus session bus");
    const bus = new Bus(socket);
    const hex = Array.from(utf8.encode(String(process.getuid?.() ?? 0)), (b) => b.toString(16).padStart(2, "0")).join("");
    socket.write(`\0AUTH EXTERNAL ${hex}\r\n`);
    const line = await bus.wait(() => {
      const i = bus.buf.indexOf(0x0a);
      if (i < 0) return null;
      const text = bus.buf.subarray(0, i + 1).toString("utf8");
      bus.buf = bus.buf.subarray(i + 1);
      return text;
    }).catch((e: unknown) => {
      socket.destroy();
      throw e;
    });
    if (!line.startsWith("OK ")) {
      socket.destroy();
      throw new Error(`D-Bus refused the login: ${line.trim()}`);
    }
    socket.write("BEGIN\r\n");
    return bus;
  }

  close(): void {
    this.s.destroy();
  }

  private wait<T>(poll: () => T | null): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const attempt = (): void => {
        const got = poll();
        if (got !== null) {
          this.waiting = null;
          resolve(got);
        } else if (this.failure !== null) {
          this.waiting = null;
          reject(new Error(this.failure));
        } else {
          this.waiting = attempt;
        }
      };
      attempt();
    });
  }

  send(kind: number, h: Header, body: readonly V[]): number {
    if (this.failure !== null) throw new Error(this.failure);
    this.serial++;
    this.s.write(dbusEncode(kind, this.serial, h, body));
    return this.serial;
  }

  /** Sends a method call; the answer comes through `read` like everything else. */
  call(dest: string, path: string, iface: string, member: string, body: readonly V[]): number {
    return this.send(1, { path, iface, member, dest }, body);
  }

  read(): Promise<Msg> {
    return this.wait(() => {
      for (;;) {
        if (this.buf.length < 16) return null;
        const be = this.buf[0] === 0x42;
        const n = (at: number): number => (be ? this.buf.readUInt32BE(at) : this.buf.readUInt32LE(at));
        const total = Math.ceil((16 + n(12)) / 8) * 8 + n(4);
        if (total > 64 << 20) throw new Error("D-Bus message too large");
        if (this.buf.length < total) return null;
        const raw = this.buf.subarray(0, total);
        this.buf = this.buf.subarray(total);
        const m = dbusDecode(raw);
        if (m !== null) return m;
      }
    });
  }
}
