// The account vault: rows an account's PCs encrypt end to end (ts/packages/net/src/vault.ts). The
// service never sees a key or a plaintext: it stores opaque rows per account and decides only which
// write wins. Ids are either hashes the PCs make with the vault key (items, leases) or
// key-management ids: `meta` (the vault's epoch), `key:<fp>` (the vault key wrapped for one PC's
// own key), `key:recovery` (wrapped with the recovery code), `req:<fp>` (a PC asking for the key:
// its public key, signed with its TLS key).
//
// Writes: last writer wins per row by the PC's `at` (ms), ties by `by`; or, with `prev`, only when
// the row's `seq` is still `prev` (0: absent), for the vault's creation and the single-host leases.

const MAX_VALUE = 768 * 1024;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_TOTAL = 24 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_SET = 64;
const ID = /^[A-Za-z0-9:_.-]{1,96}$/;

export class VaultError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Rows the push doesn't announce: lease renewals come every minute and wake nobody. */
const quiet = (id) => id.startsWith('lease:');

async function vaultBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new VaultError(413, 'That request is too large.');
  try {
    const v = JSON.parse(text || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new VaultError(400, 'The request body must be a JSON object.');
}

/** Only a PC signed in to this account, still registered as its device, reaches the vault. */
export async function vaultDevice(env, p) {
  if (p.kind !== 'pc' || typeof p.dev !== 'string' || p.dev === '') throw new VaultError(403, 'Only PCs use the vault.');
  const row = await env.DB.prepare(`SELECT user_id FROM devices WHERE fp=?`).bind(p.dev).first();
  if (!row || row.user_id !== p.sub) throw new VaultError(403, 'This PC is no longer signed in to this account.');
  return p.dev;
}

const rowJson = (r) => ({ id: r.id, v: r.v, at: r.at, by: r.by, seq: r.seq });

async function devices(env, sub) {
  const r = await env.DB.prepare(`SELECT fp,name,seen FROM devices WHERE user_id=? AND kind='pc' ORDER BY seen DESC`).bind(sub).all();
  return r.results.map((d) => ({ fp: d.fp, name: d.name, seen: d.seen }));
}

/** `GET /v1/vault?since=N`: the rows written after `since`, this account's PCs, the service's clock. */
export async function getVault(req, env, p) {
  await vaultDevice(env, p);
  const since = Math.max(0, Number(new URL(req.url).searchParams.get('since')) || 0);
  const rows = await env.DB.prepare(`SELECT id,v,at,by,seq FROM vault WHERE user_id=? AND seq>? ORDER BY seq LIMIT ${MAX_ROWS}`)
    .bind(p.sub, since)
    .all();
  const top = await env.DB.prepare(`SELECT MAX(seq) AS s FROM vault WHERE user_id=?`).bind(p.sub).first();
  return { now: Date.now(), seq: top?.s || 0, items: rows.results.map(rowJson), devices: await devices(env, p.sub) };
}

/** `PUT /v1/vault {set: [{id, v, at, prev?}]}`: each row's outcome, and the row as it stands when it lost. */
export async function putVault(req, env, p, tell) {
  const fp = await vaultDevice(env, p);
  const b = await vaultBody(req);
  if (!Array.isArray(b.set) || b.set.length === 0 || b.set.length > MAX_SET) throw new VaultError(400, 'Missing rows.');
  for (const e of b.set) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID.test(e.id)) throw new VaultError(400, 'A row id is invalid.');
    if (!(typeof e.v === 'string' || e.v === null) || !Number.isSafeInteger(e.at) || e.at < 0) throw new VaultError(400, 'A row is invalid.');
    if (e.v !== null && e.v.length > MAX_VALUE) throw new VaultError(413, 'A vault item is too large.');
    if (e.prev !== undefined && !(Number.isSafeInteger(e.prev) && e.prev >= 0)) throw new VaultError(400, 'A row is invalid.');
  }
  const ids = b.set.map((e) => e.id);
  const cur = new Map(
    (await env.DB.prepare(`SELECT id,v,at,by,seq FROM vault WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`).bind(p.sub, ...ids).all()).results.map((r) => [r.id, r]),
  );
  const size = await env.DB.prepare(`SELECT COALESCE(SUM(LENGTH(v)),0) AS n, COUNT(*) AS c, COALESCE(MAX(seq),0) AS s FROM vault WHERE user_id=?`).bind(p.sub).first();
  let total = size.n;
  let count = size.c;
  let seq = Math.max(Date.now(), (size.s || 0) + 1);
  const results = [];
  const stmts = [];
  let loud = false;
  for (const e of b.set) {
    const old = cur.get(e.id);
    let win;
    if (e.prev !== undefined) win = (old ? old.seq : 0) === e.prev;
    else win = !old || e.at > old.at || (e.at === old.at && fp > old.by);
    if (!win) {
      results.push({ id: e.id, ok: false, cur: old ? rowJson(old) : null });
      continue;
    }
    total += (e.v === null ? 0 : e.v.length) - (old && old.v ? old.v.length : 0);
    if (!old) count++;
    if (total > MAX_TOTAL || count > MAX_ROWS) throw new VaultError(413, 'The vault is full.');
    const row = { id: e.id, v: e.v, at: e.at, by: fp, seq: seq++ };
    cur.set(e.id, row);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO vault (user_id,id,v,at,by,seq) VALUES (?,?,?,?,?,?)
         ON CONFLICT(user_id,id) DO UPDATE SET v=excluded.v, at=excluded.at, by=excluded.by, seq=excluded.seq`,
      ).bind(p.sub, row.id, row.v, row.at, row.by, row.seq),
    );
    results.push({ id: e.id, ok: true, seq: row.seq });
    if (!quiet(e.id)) loud = true;
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
  if (loud) await tell([p.sub]);
  return { now: Date.now(), results };
}

/** `DELETE /v1/vault`: everything goes (a reset, when no PC holds the key and the recovery code is lost). */
export async function resetVault(env, p, tell) {
  await vaultDevice(env, p);
  await env.DB.prepare(`DELETE FROM vault WHERE user_id=?`).bind(p.sub).run();
  await tell([p.sub]);
  return { ok: true };
}

/** A device signed out for good: its wrapped key and its request go with it. */
export function forgetDevice(env, sub, fp) {
  return env.DB.prepare(`DELETE FROM vault WHERE user_id=? AND (id=? OR id=?)`).bind(sub, `key:${fp}`, `req:${fp}`);
}
