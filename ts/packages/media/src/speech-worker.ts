import { MAX_WORKER_SAMPLES, handle, parseHead } from "./parakeet.ts";

class Input {
  private buf = new Uint8Array(0);
  private reader = Bun.stdin.stream().getReader();

  private async more(): Promise<boolean> {
    const { done, value } = await this.reader.read();
    if (done) return false;
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf);
    next.set(value, this.buf.length);
    this.buf = next;
    return true;
  }

  async line(): Promise<string | null> {
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl >= 0) {
        const s = new TextDecoder().decode(this.buf.subarray(0, nl));
        this.buf = this.buf.subarray(nl + 1);
        return s;
      }
      if (!(await this.more())) return null;
    }
  }

  async exact(n: number): Promise<Uint8Array | null> {
    while (this.buf.length < n) {
      if (!(await this.more())) return null;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

async function main(): Promise<number> {
  const input = new Input();
  for (;;) {
    const line = await input.line();
    if (line === null) return 0;
    let raw: unknown = null;
    try {
      raw = JSON.parse(line.trim());
    } catch {
      // answered as an unknown request below
    }
    const count = typeof raw === "object" && raw !== null && typeof (raw as { n?: unknown }).n === "number" ? (raw as { n: number }).n : 0;
    const n = Math.max(0, Math.min(Math.floor(count), MAX_WORKER_SAMPLES));
    const bytes = await input.exact(n * 2);
    if (bytes === null) return 1;
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, n);
    const head = parseHead(raw);
    let answer: { text: string } | { error: string };
    if (head === null) {
      answer = { error: "unknown request" };
    } else {
      try {
        answer = { text: await handle(head, samples) };
      } catch (e) {
        answer = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  }
}

process.exit(await main());
