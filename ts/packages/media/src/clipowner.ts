// A Worker for clipboard.ts: owns the Wayland clipboard with several types at once (a message's text, HTML with its
// images, the image itself, the image files), where wl-copy offers one. It speaks the Wayland wire protocol over
// the compositor's socket with libc, as wl-copy does: ext-data-control-v1 (or wlr-data-control-unstable-v1), which
// needs no window or keyboard focus. One Worker owns one copy: it answers pastes until another copy replaces it,
// then says "done". Self-contained (no imports but bun:ffi): it runs from its source as a Blob URL.
import { dlopen, FFIType, ptr } from "bun:ffi";

declare const self: Worker;

export type Offer = { mime: string; data: Uint8Array };
export type OwnerIn = { offers: Offer[]; display: string; runtime: string };
export type OwnerOut = { t: "owned" } | { t: "failed"; why: string } | { t: "done" };

const DISPLAY = 1;
const MANAGERS = ["ext_data_control_manager_v1", "zwlr_data_control_manager_v1"];

/** A request: `id`'s `op` with its arguments (numbers are uint, strings strings), as the wire wants it. */
export function request(id: number, op: number, args: (number | string)[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 8;
  for (const a of args) {
    if (typeof a === "number") {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, a >>> 0, true);
      parts.push(b);
      size += 4;
    } else {
      const s = new TextEncoder().encode(a);
      const padded = (s.length + 1 + 3) & ~3;
      const b = new Uint8Array(4 + padded);
      new DataView(b.buffer).setUint32(0, s.length + 1, true);
      b.set(s, 4);
      parts.push(b);
      size += b.length;
    }
  }
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, id, true);
  v.setUint32(4, ((size << 16) | op) >>> 0, true);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export type Event = { id: number; op: number; body: Uint8Array };

/** The whole events at the start of `buf`, and how many bytes they took. */
export function events(buf: Uint8Array): { list: Event[]; used: number } {
  const list: Event[] = [];
  let at = 0;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (buf.length - at >= 8) {
    const word = v.getUint32(at + 4, true);
    const size = word >>> 16;
    if (size < 8 || buf.length - at < size) break;
    list.push({ id: v.getUint32(at, true), op: word & 0xffff, body: buf.slice(at + 8, at + size) });
    at += size;
  }
  return { list, used: at };
}

/** An event's arguments read in turn: `u` a uint, `s` a string. */
export class Args {
  private at = 0;
  private v: DataView;
  constructor(private b: Uint8Array) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u(): number {
    if (this.at + 4 > this.b.length) return 0;
    const n = this.v.getUint32(this.at, true);
    this.at += 4;
    return n;
  }
  s(): string {
    const len = this.u();
    if (len === 0) return "";
    const s = new TextDecoder().decode(this.b.subarray(this.at, this.at + len - 1));
    this.at += (len + 3) & ~3;
    return s;
  }
}

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOCK_CLOEXEC = 0o2000000;
const MSG_NOSIGNAL = 0x4000;
const MSG_CMSG_CLOEXEC = 0x40000000;
const SOL_SOCKET = 1;
const SCM_RIGHTS = 1;
const POLLOUT = 4;
const F_GETFL = 3;
const F_SETFL = 4;
const O_NONBLOCK = 0o4000;
/** A paste whose reader takes no more for this long is given up. */
const STALL_MS = 5000;

function libc() {
  return dlopen("libc.so.6", {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    recvmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64_fast },
    send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64_fast },
    write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols;
}

type Libc = ReturnType<typeof libc>;

class Conn {
  private buf = new Uint8Array(0);
  private fds: number[] = [];
  private data = new Uint8Array(4096);
  private control = new Uint8Array(256);
  private iov = new DataView(new ArrayBuffer(16));
  private hdr = new DataView(new ArrayBuffer(56));
  private next = 2;

  private constructor(
    private c: Libc,
    readonly fd: number,
  ) {
    this.iov.setBigUint64(0, BigInt(ptr(this.data)), true);
    this.iov.setBigUint64(8, BigInt(this.data.length), true);
  }

  static open(c: Libc, path: string): Conn | string {
    const name = new TextEncoder().encode(path);
    if (name.length >= 108) return "the compositor's socket path is too long";
    const fd = c.socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return "no socket";
    const addr = new Uint8Array(110);
    new DataView(addr.buffer).setUint16(0, AF_UNIX, true);
    addr.set(name, 2);
    if (c.connect(fd, ptr(addr), addr.length) !== 0) {
      c.close(fd);
      return "can't reach the compositor";
    }
    return new Conn(c, fd);
  }

  id(): number {
    return this.next++;
  }

  send(...msgs: Uint8Array[]): boolean {
    for (const m of msgs) {
      let at = 0;
      while (at < m.length) {
        const n = Number(this.c.send(this.fd, ptr(m, at), m.length - at, MSG_NOSIGNAL));
        if (n <= 0) return false;
        at += n;
      }
    }
    return true;
  }

  /** The next events (blocks until some come); null once the compositor is gone. */
  read(): Event[] | null {
    for (;;) {
      const { list, used } = events(this.buf);
      if (list.length > 0) {
        this.buf = this.buf.slice(used);
        return list;
      }
      const h = this.hdr;
      h.setBigUint64(0, 0n, true);
      h.setUint32(8, 0, true);
      h.setBigUint64(16, BigInt(ptr(this.iov)), true);
      h.setBigUint64(24, 1n, true);
      h.setBigUint64(32, BigInt(ptr(this.control)), true);
      h.setBigUint64(40, BigInt(this.control.length), true);
      h.setInt32(48, 0, true);
      const n = Number(this.c.recvmsg(this.fd, ptr(h), MSG_CMSG_CLOEXEC));
      if (n <= 0) return null;
      this.takeFds(Number(h.getBigUint64(40, true)));
      const more = new Uint8Array(this.buf.length + n);
      more.set(this.buf);
      more.set(this.data.subarray(0, n), this.buf.length);
      this.buf = more;
    }
  }

  private takeFds(len: number): void {
    const v = new DataView(this.control.buffer);
    let at = 0;
    while (at + 16 <= len) {
      const clen = Number(v.getBigUint64(at, true));
      if (clen < 16) break;
      if (v.getInt32(at + 8, true) === SOL_SOCKET && v.getInt32(at + 12, true) === SCM_RIGHTS) {
        for (let i = at + 16; i + 4 <= at + clen; i += 4) this.fds.push(v.getInt32(i, true));
      }
      at += (clen + 7) & ~7;
    }
  }

  fd1(): number {
    return this.fds.shift() ?? -1;
  }

  close(): void {
    for (const f of this.fds) this.c.close(f);
    this.c.close(this.fd);
  }
}

/** Writes `data` to a paste's pipe and closes it; a reader that stops reading is left after STALL_MS. */
function serve(c: Libc, fd: number, data: Uint8Array): void {
  if (fd < 0) return;
  c.fcntl(fd, F_SETFL, c.fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
  const pfd = new DataView(new ArrayBuffer(8));
  pfd.setInt32(0, fd, true);
  pfd.setInt16(4, POLLOUT, true);
  let at = 0;
  while (at < data.length) {
    pfd.setInt16(6, 0, true);
    if (c.poll(ptr(pfd), 1, STALL_MS) <= 0) break;
    const n = Number(c.write(fd, ptr(data, at), Math.min(65536, data.length - at)));
    if (n <= 0) break;
    at += n;
  }
  c.close(fd);
}

/** Takes the clipboard with `offers` and answers its pastes until it's taken back; `tell` says how it went. */
export function own(msg: OwnerIn, tell: (m: OwnerOut) => void): void {
  const c = libc();
  const path = msg.display.startsWith("/") ? msg.display : `${msg.runtime}/${msg.display}`;
  const conn = Conn.open(c, path);
  if (typeof conn === "string") return tell({ t: "failed", why: conn });
  try {
    run(c, conn, msg.offers, tell);
  } finally {
    conn.close();
  }
}

function run(c: Libc, conn: Conn, offers: Offer[], tell: (m: OwnerOut) => void): void {
  const registry = conn.id();
  const sync1 = conn.id();
  conn.send(request(DISPLAY, 1, [registry]), request(DISPLAY, 0, [sync1]));
  const globals: { name: number; iface: string; version: number }[] = [];
  const error = (e: Event): string | null => {
    if (e.id !== DISPLAY || e.op !== 0) return null;
    const a = new Args(e.body);
    a.u();
    a.u();
    return `the compositor said: ${a.s()}`;
  };
  for (let done = false; !done; ) {
    const list = conn.read();
    if (!list) return tell({ t: "failed", why: "the compositor closed the connection" });
    for (const e of list) {
      const err = error(e);
      if (err) return tell({ t: "failed", why: err });
      if (e.id === registry && e.op === 0) {
        const a = new Args(e.body);
        globals.push({ name: a.u(), iface: a.s(), version: a.u() });
      }
      if (e.id === sync1 && e.op === 0) done = true;
    }
  }
  const mgr = MANAGERS.map((m) => globals.find((g) => g.iface === m)).find((g) => g !== undefined);
  const seatG = globals.find((g) => g.iface === "wl_seat");
  if (!mgr || !seatG) return tell({ t: "failed", why: "the compositor has no data-control clipboard" });
  const seat = conn.id();
  const manager = conn.id();
  const source = conn.id();
  const device = conn.id();
  const sync2 = conn.id();
  conn.send(
    request(registry, 0, [seatG.name, "wl_seat", 1, seat]),
    request(registry, 0, [mgr.name, mgr.iface, 1, manager]),
    request(manager, 0, [source]),
    ...offers.map((o) => request(source, 0, [o.mime])),
    request(manager, 1, [device, seat]),
    request(device, 0, [source]),
    request(DISPLAY, 0, [sync2]),
  );
  let owned = false;
  for (;;) {
    const list = conn.read();
    if (!list) return tell(owned ? { t: "done" } : { t: "failed", why: "the compositor closed the connection" });
    for (const e of list) {
      const err = error(e);
      if (err) return tell(owned ? { t: "done" } : { t: "failed", why: err });
      if (e.id === sync2 && e.op === 0 && !owned) {
        owned = true;
        tell({ t: "owned" });
      } else if (e.id === source && e.op === 0) {
        const mime = new Args(e.body).s();
        const fd = conn.fd1();
        const o = offers.find((x) => x.mime === mime);
        if (o) serve(c, fd, o.data);
        else if (fd >= 0) c.close(fd);
      } else if ((e.id === source && e.op === 1) || (e.id === device && e.op === 2)) {
        // Cancelled (another copy took the clipboard) or the device is finished.
        return tell(owned ? { t: "done" } : { t: "failed", why: "the clipboard was taken at once" });
      }
    }
  }
}

if (typeof Bun !== "undefined" && !Bun.isMainThread) {
  self.onmessage = (e: MessageEvent<OwnerIn>) => {
    try {
      own(e.data, (m) => self.postMessage(m));
    } catch (err) {
      self.postMessage({ t: "failed", why: err instanceof Error ? err.message : String(err) } satisfies OwnerOut);
    }
  };
}
