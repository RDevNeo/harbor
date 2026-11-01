import { isIPv4, isIPv6 } from "node:net";

export type Ip = { v: 4; b: Uint8Array } | { v: 6; b: Uint8Array };

export function parseIp(s: string): Ip | null {
  const t = s.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIPv4(t)) return { v: 4, b: Uint8Array.from(t.split(".").map(Number)) };
  if (!isIPv6(t)) return null;
  let head = t;
  let tail4: number[] = [];
  const m = t.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    head = m[1].endsWith("::") ? m[1] : m[1].slice(0, -1);
    tail4 = m[2].split(".").map(Number);
  }
  const groups = (x: string) => (x === "" ? [] : x.split(":").map((g) => parseInt(g, 16)));
  const want = 8 - tail4.length / 2;
  let words: number[];
  if (head.includes("::")) {
    const [a = "", b = ""] = head.split("::");
    const l = groups(a);
    const r = groups(b);
    words = [...l, ...new Array<number>(want - l.length - r.length).fill(0), ...r];
  } else {
    words = groups(head);
  }
  const b = new Uint8Array(16);
  words.forEach((w, i) => {
    b[i * 2] = w >> 8;
    b[i * 2 + 1] = w & 0xff;
  });
  tail4.forEach((x, i) => {
    b[12 + i] = x;
  });
  return { v: 6, b };
}

export function ipString(ip: Ip): string {
  if (ip.v === 4) return Array.from(ip.b).join(".");
  const w: number[] = [];
  for (let i = 0; i < 16; i += 2) w.push(((ip.b[i] ?? 0) << 8) | (ip.b[i + 1] ?? 0));
  // The longest run of two or more zero words becomes "::" (RFC 5952), the first one on a tie.
  let best = -1;
  let len = 0;
  for (let i = 0; i < 8; ) {
    if (w[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > len && j - i >= 2) {
      best = i;
      len = j - i;
    }
    i = j;
  }
  const hex = (a: number[]) => a.map((x) => x.toString(16)).join(":");
  if (best < 0) return hex(w);
  return `${hex(w.slice(0, best))}::${hex(w.slice(best + len))}`;
}

/** IPv4-mapped IPv6 as IPv4. */
export function canonical(ip: Ip): Ip {
  if (ip.v === 6 && ip.b.subarray(0, 10).every((x) => x === 0) && ip.b[10] === 0xff && ip.b[11] === 0xff) {
    return { v: 4, b: ip.b.slice(12) };
  }
  return ip;
}

export function canon(s: string): string {
  const ip = parseIp(s);
  return ip ? ipString(canonical(ip)) : s;
}

export function word(ip: Ip, i: number): number {
  return ((ip.b[i * 2] ?? 0) << 8) | (ip.b[i * 2 + 1] ?? 0);
}

export function isLoopback(ip: Ip): boolean {
  const c = canonical(ip);
  if (c.v === 4) return c.b[0] === 127;
  return c.b.subarray(0, 15).every((x) => x === 0) && c.b[15] === 1;
}

export function isUnspecified(ip: Ip): boolean {
  return ip.b.every((x) => x === 0);
}

export function linkLocal(ip: Ip): boolean {
  if (ip.v === 4) return ip.b[0] === 169 && ip.b[1] === 254;
  return (word(ip, 0) & 0xffc0) === 0xfe80;
}
