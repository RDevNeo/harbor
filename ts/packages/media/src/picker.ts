export const IMAGES: readonly string[] = ["*.png", "*.svg", "*.ico", "*.jpg", "*.jpeg", "*.webp", "*.gif"];
export const NO_PICKER = "No file picker found: install zenity (or kdialog on KDE).";
const SHOW_FOR_MS = 8000;

export interface Opts {
  title?: string;
  multiple?: boolean;
  filter?: readonly [string, readonly string[]];
  dir?: string;
  directory?: boolean;
}

export function zenityArgs(o: Opts): string[] {
  const a = ["--file-selection", "--separator=\n", `--title=${o.title ?? ""}`];
  if (o.directory) a.push("--directory");
  if (o.multiple) a.push("--multiple");
  if (o.filter) a.push(`--file-filter=${o.filter[0]} | ${o.filter[1].join(" ")}`);
  if (o.dir) a.push(`--filename=${o.dir}/`);
  return a;
}

export function kdialogArgs(o: Opts): string[] {
  const a = [o.directory ? "--getexistingdirectory" : "--getopenfilename", o.dir ?? "."];
  if (o.filter) a.push(`${o.filter[0]} (${o.filter[1].join(" ")})`);
  if (o.multiple) a.push("--multiple", "--separate-output");
  a.push("--title", o.title ?? "");
  return a;
}

export function paths(stdout: Uint8Array): string[] {
  return Buffer.from(stdout).toString("utf8").split("\n").filter((l) => l !== "");
}

let error: { msg: string; at: number } | null = null;
const listeners = new Set<() => void>();

export function onToast(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

function fail(msg: string): string[] {
  console.error(`harbor: ${msg}`);
  error = { msg, at: Date.now() };
  for (const f of listeners) f();
  return [];
}

export function showToast(msg: string): void {
  fail(msg);
}

export function toast(now: number = Date.now()): { msg: string; leftMs: number } | null {
  if (!error) return null;
  const leftMs = SHOW_FOR_MS - (now - error.at);
  if (leftMs <= 0) {
    error = null;
    return null;
  }
  return { msg: error.msg, leftMs };
}

export async function pick(o: Opts): Promise<string[]> {
  for (const [bin, args] of [["zenity", zenityArgs(o)], ["kdialog", kdialogArgs(o)]] as const) {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([bin, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
      return fail(`Couldn't open the file picker (${bin}): ${e instanceof Error ? e.message : String(e)}`);
    }
    const out = new Uint8Array(await new Response(proc.stdout as ReadableStream).arrayBuffer());
    return (await proc.exited) === 0 ? paths(out) : [];
  }
  return fail(NO_PICKER);
}
