// sys.ts's answers on Windows: memory from GlobalMemoryStatusEx, the boot from the tick count.
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { Listener, Memory } from "../sys.ts";
import { bootFiletime, memoryStatus, sessionOf } from "./k32.ts";

export function memory(): Memory | null {
  const m = memoryStatus();
  if (m === null || m.total <= 0) return null;
  // The commit limit beyond physical memory stands in for swap (the page file).
  const swapTotal = Math.max(0, m.pageTotal - m.total);
  return { total: m.total, available: m.available, swapTotal, swapFree: Math.min(swapTotal, Math.max(0, m.pageAvail - m.available)) };
}

/** Changes at every boot, the same until the next: the boot's own time. */
export function bootId(): string {
  const b = bootFiletime();
  return b === null ? "" : `win-boot-${b}`;
}

const IPHLPAPI = {
  GetExtendedTcpTable: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
} as const;
let iphlp: ReturnType<typeof dlopen<typeof IPHLPAPI>>["symbols"] | null | undefined;
const TCP_TABLE_OWNER_PID_LISTENER = 3;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** One family's listening sockets (GetExtendedTcpTable): [port, owning pid]. Null when Windows wouldn't say. */
function listeners(family: 2 | 23): [number, number][] | null {
  if (iphlp === undefined) {
    try {
      iphlp = dlopen("iphlpapi.dll", IPHLPAPI).symbols;
    } catch {
      iphlp = null;
    }
  }
  if (iphlp === null) return null;
  const size = new Uint32Array(1);
  let buf = new Uint8Array(4096);
  for (let tries = 0; ; tries++) {
    size[0] = buf.length;
    const r = iphlp.GetExtendedTcpTable(ptr(buf), ptr(size), 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (r === 0) break;
    if (r !== ERROR_INSUFFICIENT_BUFFER || tries > 4) return null;
    buf = new Uint8Array((size[0] ?? 0) + 1024);
  }
  const v = new DataView(buf.buffer);
  const n = v.getUint32(0, true);
  // MIB_TCPROW_OWNER_PID: state, local address, local port, remote address, remote port, pid (24 bytes);
  // MIB_TCP6ROW_OWNER_PID: local address (16), scope, local port, remote address (16), scope, port, state, pid (56).
  const [row, portAt, pidAt] = family === 2 ? [24, 8, 20] : [56, 20, 52];
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const at = 4 + i * row;
    if (at + row > buf.length) break;
    // The port in network byte order in the low two bytes.
    out.push([(buf[at + portAt]! << 8) | buf[at + portAt + 1]!, v.getUint32(at + pidAt, true)]);
  }
  return out;
}

/** Every TCP socket listening on this PC, any user's: its "uid" is its process's session, as proc's ownerOf says. */
export function tcpListeners(): Listener[] | null {
  const v4 = listeners(2);
  const v6 = listeners(23);
  if (v4 === null && v6 === null) return null;
  const session = new Map<number, number | null>();
  return [...(v4 ?? []), ...(v6 ?? [])].map(([port, pid]) => {
    if (!session.has(pid)) session.set(pid, sessionOf(pid));
    return { port, uid: session.get(pid) ?? null };
  });
}
