// The workspace cloud: each PC's chats and projects, encrypted by the PCs (ts/packages/net/src/chatcloud.ts) with
// one key per workspace that the service keeps for them (`cloud_keys`, sealed with VAULT_SECRET as the vault's
// keys are) and hands to the signed-in PCs of that workspace's members. A member's new PC, or one whose sibling is
// off, reads every chat of the workspace's PCs from here, with none of them on.
//
// Rows are opaque: ids are keyed hashes the PCs make (`m:` a chat's metadata, `k:` a chunk of its transcript, `p:`
// a project), values ciphertext. A row belongs to the PC that first wrote it (`by`, its key's fingerprint): only it
// rewrites or deletes it, so a member can't overwrite another PC's chats. Listing leaves the chunks out (`k:`); a PC
// asks for the chunks it needs by id.

import { openSecret, sealSecret, vaultDevice, VaultError } from './vault.js';

const MAX_VALUE = 1_400_000;
const MAX_BODY = 6 * 1024 * 1024;
const MAX_SET = 64;
const MAX_GET = 64;
/** What one answer of `POST /v1/cloud/rows` carries at most (the rest: ask again). */
const MAX_ANSWER = 8 * 1024 * 1024;
const PAGE = 400;
const ID = /^[mkp]:[0-9a-f]{40}$/;

const b64 = (u8) => {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Bytes a workspace may keep here (env CLOUD_MAX_MB, default 256). */
const maxTotal = (env) => Math.max(1, Number(env.CLOUD_MAX_MB) || 256) * 1024 * 1024;

export class CloudError extends VaultError {}

/** The workspace `ws` of the request, checked against the token: a member's PC, still signed in. */
async function member(env, p, ws) {
  const fp = await vaultDevice(env, p);
  if (typeof ws !== 'string' || ws === '' || !Array.isArray(p.ws) || !p.ws.includes(ws)) throw new CloudError(403, 'You are not a member of that workspace.');
  return fp;
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new CloudError(413, 'That request is too large.');
  try {
    const v = JSON.parse(text || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new CloudError(400, 'The request body must be a JSON object.');
}

const wsOf = (req) => new URL(req.url).searchParams.get('ws') || '';
const aad = (ws, epoch) => `harbor-cloud-key\n${ws}\n${epoch}`;
const rowJson = (r) => ({ id: r.id, v: r.v, at: r.at, by: r.by, seq: r.seq });

/**
 * `GET /v1/cloud/key?ws=W`: the workspace's key {key, epoch}, made on the first ask. The membership is checked
 * live (`liveWs`, Clerk) besides the token: a key outlives a token.
 */
export async function getCloudKey(req, env, p, liveWs) {
  const ws = wsOf(req);
  await member(env, p, ws);
  const live = await liveWs(env, p.sub);
  if (!live.some((w) => w.id === ws)) throw new CloudError(403, 'You are not a member of that workspace.');
  const row = await env.DB.prepare(`SELECT epoch,k FROM cloud_keys WHERE ws=?`).bind(ws).first();
  if (row) {
    const k = await openSecret(env, aad(ws, row.epoch), row.k);
    if (k && k.length === 32) return { key: b64(k), epoch: row.epoch };
  }
  // None yet, or it no longer opens (the secret changed): a new key, and what the old one sealed goes.
  const k = crypto.getRandomValues(new Uint8Array(32));
  const epoch = hex(crypto.getRandomValues(new Uint8Array(8)));
  const sealed = await sealSecret(env, aad(ws, epoch), k);
  const stmts = [];
  if (row) {
    stmts.push(env.DB.prepare(`DELETE FROM cloud WHERE ws=?`).bind(ws));
    stmts.push(env.DB.prepare(`DELETE FROM cloud_keys WHERE ws=? AND epoch=?`).bind(ws, row.epoch));
  }
  stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO cloud_keys (ws,epoch,k,at) VALUES (?,?,?,?)`).bind(ws, epoch, sealed, Date.now()));
  await env.DB.batch(stmts);
  // Two PCs made one at once: both take the one stored.
  const won = await env.DB.prepare(`SELECT epoch,k FROM cloud_keys WHERE ws=?`).bind(ws).first();
  const got = won ? await openSecret(env, aad(ws, won.epoch), won.k) : null;
  if (!got || got.length !== 32) throw new CloudError(503, 'The workspace cloud is not ready yet.');
  return { key: b64(got), epoch: won.epoch };
}

/** `GET /v1/cloud?ws=W&since=N`: chats and projects written after `since` (no chunks), a page at a time (`more`). */
export async function getCloud(req, env, p) {
  const ws = wsOf(req);
  await member(env, p, ws);
  const since = Math.max(0, Number(new URL(req.url).searchParams.get('since')) || 0);
  const rows = await env.DB.prepare(`SELECT id,v,at,by,seq FROM cloud WHERE ws=? AND seq>? AND id NOT LIKE 'k:%' ORDER BY seq LIMIT ${PAGE}`)
    .bind(ws, since)
    .all();
  const items = rows.results.map(rowJson);
  const key = await env.DB.prepare(`SELECT epoch FROM cloud_keys WHERE ws=?`).bind(ws).first();
  return { now: Date.now(), epoch: key ? key.epoch : '', more: items.length === PAGE, items };
}

/** `POST /v1/cloud/rows?ws=W {ids}`: those rows (transcript chunks), as many as fit one answer; the rest are asked again. */
export async function getCloudRows(req, env, p) {
  const ws = wsOf(req);
  await member(env, p, ws);
  const b = await readBody(req);
  if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.length > MAX_GET || !b.ids.every((x) => typeof x === 'string' && ID.test(x))) {
    throw new CloudError(400, 'Missing row ids.');
  }
  const r = await env.DB.prepare(`SELECT id,v,at,by,seq FROM cloud WHERE ws=? AND id IN (${b.ids.map(() => '?').join(',')})`)
    .bind(ws, ...b.ids)
    .all();
  const items = [];
  let bytes = 0;
  for (const row of r.results) {
    const n = row.v ? row.v.length : 0;
    if (items.length > 0 && bytes + n > MAX_ANSWER) break;
    items.push(rowJson(row));
    bytes += n;
  }
  return { items };
}

/** `PUT /v1/cloud?ws=W {set: [{id, v}]}`: rows of this PC (v null: gone). Each row's outcome. When a chat's or a
 *  project's row changed, `notify(ws)` tells the workspace's members' devices (their PCs read it within a second). */
export async function putCloud(req, env, p, notify) {
  const ws = wsOf(req);
  const fp = await member(env, p, ws);
  const b = await readBody(req);
  if (!Array.isArray(b.set) || b.set.length === 0 || b.set.length > MAX_SET) throw new CloudError(400, 'Missing rows.');
  for (const e of b.set) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID.test(e.id)) throw new CloudError(400, 'A row id is invalid.');
    if (!(typeof e.v === 'string' || e.v === null)) throw new CloudError(400, 'A row is invalid.');
    if (e.v !== null && e.v.length > MAX_VALUE) throw new CloudError(413, 'A row is too large.');
  }
  const ids = b.set.map((e) => e.id);
  const cur = new Map(
    (await env.DB.prepare(`SELECT id,by,LENGTH(v) AS n FROM cloud WHERE ws=? AND id IN (${ids.map(() => '?').join(',')})`).bind(ws, ...ids).all()).results.map((r) => [
      r.id,
      r,
    ]),
  );
  const size = await env.DB.prepare(`SELECT COALESCE(SUM(LENGTH(v)),0) AS n, COALESCE(MAX(seq),0) AS s FROM cloud WHERE ws=?`).bind(ws).first();
  let total = size.n;
  let seq = Math.max(Date.now(), (size.s || 0) + 1);
  const at = Date.now();
  const results = [];
  const stmts = [];
  for (const e of b.set) {
    const old = cur.get(e.id);
    if (old && old.by !== fp) {
      results.push({ id: e.id, ok: false, why: 'owned' });
      continue;
    }
    const grow = (e.v === null ? 0 : e.v.length) - (old && old.n ? old.n : 0);
    if (grow > 0 && total + grow > maxTotal(env)) {
      results.push({ id: e.id, ok: false, why: 'full' });
      continue;
    }
    total += grow;
    const s = seq++;
    if (e.v === null && !old) {
      results.push({ id: e.id, ok: true, seq: s });
      continue;
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO cloud (ws,id,v,at,by,seq) VALUES (?,?,?,?,?,?)
         ON CONFLICT(ws,id) DO UPDATE SET v=excluded.v, at=excluded.at, seq=excluded.seq WHERE cloud.by=excluded.by`,
      ).bind(ws, e.id, e.v, at, fp, s),
    );
    results.push({ id: e.id, ok: true, seq: s });
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
  const listed = b.set.some((e, i) => results[i]?.ok && e.id[0] !== 'k');
  if (listed && notify) await notify(ws);
  return { now: Date.now(), results };
}
