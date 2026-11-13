// The workspace cloud's service for tests: the Worker's own handlers (worker/src/cloud.js) on SQLite as D1, called as
// the account loop calls it, as any member's PC.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WORKER = join(import.meta.dir, "..", "..", "worker");

interface Stmt {
  sql: string;
  args: unknown[];
  bind(...a: unknown[]): Stmt;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
  run(): Promise<unknown>;
}

function d1(db: Database) {
  const stmt = (sql: string, args: unknown[] = []): Stmt => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.query(sql).get(...(args as never[])) as Record<string, unknown> | null) ?? null,
    all: async () => ({ results: db.query(sql).all(...(args as never[])) as Record<string, unknown>[] }),
    run: async () => db.query(sql).run(...(args as never[])),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: Stmt[]) => db.transaction(() => list.map((s) => db.query(s.sql).run(...(s.args as never[]))))(),
  };
}

type Handler = (req: Request, env: unknown, p: unknown, live?: unknown) => Promise<unknown>;
const worker = (await import(join(WORKER, "src", "cloud.js"))) as { getCloudKey: Handler; getCloud: Handler; getCloudRows: Handler; putCloud: Handler };

export function service(opts: { deployed?: boolean; maxMb?: number } = {}) {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE devices (fp TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', seen INTEGER NOT NULL)`);
  db.run(readFileSync(join(WORKER, "migrations", "0008_cloud.sql"), "utf8"));
  const env = { DB: d1(db), VAULT_SECRET: Buffer.alloc(32, 7).toString("base64"), CLOUD_MAX_MB: String(opts.maxMb ?? 64) };
  const members = new Map<string, string[]>();
  const live = async (_env: unknown, sub: string) => (members.get(sub) ?? []).map((id) => ({ id }));
  let requests = 0;
  const callAs = (sub: string, fp: string, ws: string[]) => {
    db.run(`INSERT OR IGNORE INTO devices (fp,user_id,kind,seen) VALUES (?,?,'pc',0)`, [fp, sub]);
    members.set(sub, ws);
    const claims = { sub, dev: fp, kind: "pc", ws };
    return async (method: string, path: string, body?: unknown): Promise<unknown> => {
      requests++;
      if (opts.deployed === false) throw Object.assign(new Error("Not found."), { code: 404 });
      const req = new Request(`https://accounts.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const route = `${method} ${new URL(req.url).pathname}`;
      try {
        if (route === "GET /v1/cloud/key") return await worker.getCloudKey(req, env, claims, live);
        if (route === "GET /v1/cloud") return await worker.getCloud(req, env, claims);
        if (route === "PUT /v1/cloud") return await worker.putCloud(req, env, claims);
        if (route === "POST /v1/cloud/rows") return await worker.getCloudRows(req, env, claims);
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (typeof st === "number") throw Object.assign(new Error((e as Error).message), { code: st });
        throw e;
      }
      throw Object.assign(new Error("Not found."), { code: 404 });
    };
  };
  return { db, callAs, requests: () => requests };
}
