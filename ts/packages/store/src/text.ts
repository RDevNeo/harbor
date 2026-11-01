const enc = new TextEncoder();
const dec = new TextDecoder();

export function byteLength(s: string): number {
  return enc.encode(s).length;
}

/** `s` shortened to about `n` bytes by cutting its middle, with a note of how much went. */
export function clipMiddle(s: string, n: number): string {
  const b = enc.encode(s);
  if (b.length <= n) return s;
  const floor = (i: number): number => {
    while (i > 0 && ((b[i] ?? 0) & 0xc0) === 0x80) i--;
    return i;
  };
  const head = floor(Math.floor((n * 2) / 3));
  const tail = floor(b.length - Math.floor(n / 3));
  return `${dec.decode(b.subarray(0, head))}\n\n… (${tail - head} bytes cut) …\n\n${dec.decode(b.subarray(tail))}`;
}
