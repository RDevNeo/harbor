import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

type Plan = {
  state?: unknown;
  calls?: Record<string, unknown>;
  thawed?: unknown;
  opens?: number;
  readyAfterMs?: number;
  silent?: string[];
  exitAfterMs?: number;
  events?: unknown[];
  scratch?: Record<string, unknown>;
  failFlush?: boolean;
  eventGapMs?: number;
  breakable?: boolean;
  /** Tools whose call fails, with the page's error. */
  throws?: Record<string, string>;
  /** A captcha on the page: whether it shows, and whether the join it held has landed. */
  captcha?: { showing: boolean; joined: boolean; error?: string; seq?: number };
};

const cfg = JSON.parse(process.env.HARBOR_DISCORD ?? "{}") as { mode: string; data: string; page: string; vencord: string; url: string | null };
const root = dirname(cfg.data);
const plan = (): Plan => (existsSync(join(root, "fake.json")) ? (JSON.parse(readFileSync(join(root, "fake.json"), "utf8")) as Plan) : {});
const log = (o: unknown): void => appendFileSync(join(root, "fake.log"), `${JSON.stringify(o)}\n`);
const send = (o: unknown): void => void process.stdout.write(`${JSON.stringify(o)}\n`);

log({ started: cfg.mode, argv: process.argv.slice(2), env: Object.keys(process.env).sort(), wayland: process.env.WAYLAND_DISPLAY ?? null, display: process.env.DISPLAY ?? null, cfg });
const p0 = plan();
setTimeout(() => {
  send({ ev: "started" });
  send({ ev: "ready" });
  (p0.events ?? []).forEach((e, i) => setTimeout(() => send(e), i * (p0.eventGapMs ?? 0)));
}, p0.readyAfterMs ?? 20);
if (p0.exitAfterMs !== undefined) setTimeout(() => process.exit(7), p0.exitAfterMs);

const script = (): string => readFileSync(cfg.page, "utf8");

const ops: Record<string, (m: Record<string, unknown>) => unknown> = {
  state: () => plan().state ?? { user: { id: "1" }, path: "/channels/@me" },
  selftest: () => {
    const needs: Record<string, string> = { MessageActions: !plan().breakable || script().includes('"sendMessage", "updateMessage"') ? "ok" : "missing", UserStore: "ok" };
    return plan().calls?.selftest ?? { vencord: true, build: "build-1", needs, tools: {} };
  },
  call: (m) => {
    const err = plan().throws?.[String(m.name)];
    if (err !== undefined) throw new Error(err);
    return JSON.stringify(plan().calls?.[String(m.name)] ?? { ran: m.name, args: m.args });
  },
  thawed: () => plan().thawed ?? { path: "/channels/@me" },
  flush: () => {
    if (plan().failFlush) throw new Error("flush failed");
    return null;
  },
  gateway: () => ({ opens: plan().opens ?? 1 }),
  settled: () => null,
  inject: () => null,
  show: () => null,
  logout: () => null,
  rect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
  capture: () => ({ data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png", width: 10, height: 10, bytes: 9 }),
  captcha: () => ({ showing: plan().captcha?.showing ?? false, rect: plan().captcha?.showing ? { x: 400, y: 200, width: 300, height: 200 } : null, pending: { joined: plan().captcha?.joined ?? false, error: plan().captcha?.error ?? null } }),
  captcha_frame: (m) =>
    m.crop === true && typeof m.after === "number"
      ? (plan().captcha?.seq ?? 1) > m.after
        ? { showing: true, rect: { x: 400, y: 200, width: 300, height: 200 }, crop: { x: 376, y: 176, width: 348, height: 248 }, seq: plan().captcha?.seq ?? 1, width: 348, height: 248, mimeType: "image/jpeg", data: Buffer.from("live").toString("base64") }
        : { showing: true, rect: { x: 400, y: 200, width: 300, height: 200 }, crop: { x: 376, y: 176, width: 348, height: 248 }, seq: plan().captcha?.seq ?? 1, same: true }
      : m.crop === true
      ? { showing: plan().captcha?.showing ?? false, rect: { x: 400, y: 200, width: 300, height: 200 }, crop: { x: 376, y: 176, width: 348, height: 248 }, width: Math.min(348, Number(m.max) || 348), height: 248, mimeType: "image/jpeg", data: Buffer.from("crop").toString("base64") }
      : { showing: plan().captcha?.showing ?? false, rect: { x: 400, y: 200, width: 300, height: 200 }, width: 1280, height: 720, mimeType: "image/jpeg", data: Buffer.from("jpeg").toString("base64") },
  captcha_input: (m) => ({ taken: m.x === 450 }),
  captcha_cancel: () => null,
  captcha_end: () => null,
  quit: () => {
    setTimeout(() => process.exit(0), 10);
    return null;
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line) as Record<string, unknown>;
  log({ op: m.op, name: m.name, args: m.args, ...(m.kind !== undefined ? { kind: m.kind, x: m.x, y: m.y } : {}), ...(m.crop !== undefined ? { crop: m.crop, max: m.max, after: m.after, wait: m.wait } : {}) });
  if ((plan().silent ?? []).includes(String(m.op))) return;
  try {
    const f = ops[String(m.op)] ?? (cfg.mode === "scratch" ? (): unknown => plan().scratch?.[String(m.op)] ?? { scratch: m.op } : undefined);
    if (f === undefined) throw new Error(`no such op: ${String(m.op)}`);
    send({ id: m.id, ok: true, result: f(m) ?? null });
  } catch (e) {
    send({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
process.stdin.on("end", () => process.exit(0));
