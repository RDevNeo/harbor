// The account vault: rows an account's PCs encrypt (ts/packages/net/src/vault.ts) with one key per
// account that the service keeps for them (`vault_keys`, sealed with the Worker secret VAULT_SECRET)
// and hands to the account's own signed-in PCs only, so a new PC opens the vault with nobody else on.
// The rows are opaque here: ids are hashes the PCs make with the key (items, leases), but `meta`
// (the vault's epoch and a check of its key), which only the service writes.
//
// Writes: last writer wins per row by the PC's `at` (ms), ties by `by`; or, with `prev`, only when
// the row's `seq` is still `prev` (0: absent), for the single-host leases.

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
/** The per-PC key wraps and key requests of Harbor 0.162-0.164: no longer kept, and dropped when such a PC writes them. */
const legacy = (id) => id.startsWith('key:') || id.startsWith('req:');
/** A vault whose key no PC handed over (made by Harbor 0.162-0.164) and nobody wrote to for this long starts over. */
const STALE_MS = 7 * 86400 * 1000;
const INFO = 'harbor-vault-v1';

const te = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

let secretCache = null;
/** The AES-GCM key the vault keys are sealed with at rest: the Worker secret VAULT_SECRET (32 bytes, base64). */
async function sealKey(env) {
  const raw = (env.VAULT_SECRET || '').trim();
  if (secretCache && secretCache.raw === raw) return secretCache.key;
  let bytes;
  try {
    bytes = unb64(raw);
  } catch {
    bytes = new Uint8Array(0);
  }
  if (bytes.length !== 32) throw new VaultError(500, 'The vault is not configured yet.');
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  secretCache = { raw, key };
  return key;
}

const sealAad = (sub, epoch) => te.encode(`harbor-vault-key\n${sub}\n${epoch}`);

async function sealVaultKey(env, sub, epoch, vk) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: sealAad(sub, epoch) }, await sealKey(env), vk));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

/** The account's key, or null when it doesn't open (the secret changed: a PC that has the key hands it over again). */
async function openVaultKey(env, sub, row) {
  try {
    const box = unb64(row.k);
    const vk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.subarray(0, 12), additionalData: sealAad(sub, row.epoch) }, await sealKey(env), box.subarray(12)));
    return vk.length === 32 ? vk : null;
  } catch (e) {
    if (e instanceof VaultError) throw e;
    return null;
  }
}

/** What the PCs check a key against (vaultcrypto.ts keyCheck): HMAC of the epoch under the key's "check" subkey. */
async function keyCheck(vk, epoch) {
  const ikm = await crypto.subtle.importKey('raw', vk, 'HKDF', false, ['deriveBits']);
  const sub = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(`${INFO} check`) }, ikm, 256);
  const h = await crypto.subtle.importKey('raw', sub, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', h, te.encode(epoch)))).slice(0, 32);
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function metaOf(env, sub) {
  const r = await env.DB.prepare(`SELECT v,seq FROM vault WHERE user_id=? AND id='meta'`).bind(sub).first();
  if (!r || typeof r.v !== 'string') return null;
  try {
    const m = JSON.parse(r.v);
    return m && typeof m.epoch === 'string' && typeof m.check === 'string' ? { epoch: m.epoch, check: m.check, seq: r.seq } : null;
  } catch {
    return null;
  }
}

const keyRow = (env, sub) => env.DB.prepare(`SELECT epoch,k FROM vault_keys WHERE user_id=?`).bind(sub).first();

async function nextSeq(env, sub) {
  const top = await env.DB.prepare(`SELECT COALESCE(MAX(seq),0) AS s FROM vault WHERE user_id=?`).bind(sub).first();
  return Math.max(Date.now(), (top?.s || 0) + 1);
}

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
  // `held`: the service keeps this vault's key (false: a PC that has it hands it over, PUT /v1/vault/key).
  const [meta, kr] = await Promise.all([metaOf(env, p.sub), keyRow(env, p.sub)]);
  const held = meta === null || (kr !== null && kr.epoch === meta.epoch);
  return { now: Date.now(), seq: top?.s || 0, held, items: rows.results.map(rowJson), devices: await devices(env, p.sub) };
}

/**
 * `GET /v1/vault/key`: the account's vault key {key, epoch, check}, made with its `meta` row the
 * first time. {key: null}: the vault was made by a Harbor that kept the key on its PCs, and none of
 * them has handed it over yet (one does on its next round once it updates).
 */
export async function getVaultKey(env, p, tell) {
  await vaultDevice(env, p);
  const sub = p.sub;
  const meta = await metaOf(env, sub);
  const kr = await keyRow(env, sub);
  if (kr && meta && kr.epoch === meta.epoch) {
    const vk = await openVaultKey(env, sub, kr);
    if (vk) return { key: b64(vk), epoch: kr.epoch, check: meta.check };
  }
  if (kr) await env.DB.prepare(`DELETE FROM vault_keys WHERE user_id=?`).bind(sub).run();
  if (meta) {
    const top = await env.DB.prepare(`SELECT COALESCE(MAX(seq),0) AS s FROM vault WHERE user_id=?`).bind(sub).first();
    if (Date.now() - (top?.s || 0) < STALE_MS) return { key: null };
  }
  // A new vault (or an old one nobody can open any more: its rows go).
  const vk = crypto.getRandomValues(new Uint8Array(32));
  const epoch = hex(crypto.getRandomValues(new Uint8Array(8)));
  const check = await keyCheck(vk, epoch);
  const at = Date.now();
  const seq = await nextSeq(env, sub);
  const stmts = [];
  if (meta) stmts.push(env.DB.prepare(`DELETE FROM vault WHERE user_id=?`).bind(sub));
  stmts.push(
    env.DB.prepare(`INSERT OR IGNORE INTO vault_keys (user_id,epoch,k,at) VALUES (?,?,?,?)`).bind(sub, epoch, await sealVaultKey(env, sub, epoch, vk), at),
    env.DB.prepare(`INSERT OR IGNORE INTO vault (user_id,id,v,at,by,seq) VALUES (?,'meta',?,?,'',?)`).bind(sub, JSON.stringify({ epoch, check, at }), at, seq),
  );
  await env.DB.batch(stmts);
  // Two PCs made one at once: both take the one stored.
  const won = await keyRow(env, sub);
  const m2 = await metaOf(env, sub);
  const got = won && m2 && won.epoch === m2.epoch ? await openVaultKey(env, sub, won) : null;
  if (!got) return { key: null };
  await tell([sub]);
  return { key: b64(got), epoch: won.epoch, check: m2.check };
}

/** `PUT /v1/vault/key {key, epoch}`: a PC that made or opened the vault under Harbor 0.162-0.164 hands its key over. */
export async function putVaultKey(req, env, p, tell) {
  await vaultDevice(env, p);
  const b = await vaultBody(req);
  const sub = p.sub;
  let vk;
  try {
    vk = typeof b.key === 'string' ? unb64(b.key) : null;
  } catch {
    vk = null;
  }
  if (!vk || vk.length !== 32 || typeof b.epoch !== 'string') throw new VaultError(400, 'Missing the key.');
  const meta = await metaOf(env, sub);
  if (!meta || meta.epoch !== b.epoch || (await keyCheck(vk, b.epoch)) !== meta.check) throw new VaultError(409, "That key isn't this account's vault's.");
  const kr = await keyRow(env, sub);
  if (kr && kr.epoch === meta.epoch) {
    const have = await openVaultKey(env, sub, kr);
    if (have) {
      if (!sameBytes(have, vk)) throw new VaultError(409, 'The service has another key for this vault.');
      return { ok: true };
    }
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vault_keys (user_id,epoch,k,at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET epoch=excluded.epoch, k=excluded.k, at=excluded.at`,
    ).bind(sub, meta.epoch, await sealVaultKey(env, sub, meta.epoch, vk), Date.now()),
    // The per-PC wraps and requests are of no use any more.
    env.DB.prepare(`DELETE FROM vault WHERE user_id=? AND (id LIKE 'key:%' OR id LIKE 'req:%')`).bind(sub),
  ]);
  // The account's PCs waiting for the key take it now.
  await tell([sub]);
  return { ok: true };
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
    // Harbor 0.162-0.164 still sends its key wraps and requests: taken and dropped, so the rest of its round goes on.
    if (legacy(e.id)) {
      results.push({ id: e.id, ok: true });
      continue;
    }
    const old = cur.get(e.id);
    // `meta` is the service's: a PC that tries to make a vault of its own gets the one there is.
    if (e.id === 'meta') {
      results.push({ id: e.id, ok: false, cur: old ? rowJson(old) : null });
      continue;
    }
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

/** Seals `bytes` with the Worker secret, bound to `aad` (the workspace cloud's keys, src/cloud.js). */
export async function sealSecret(env, aad, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, await sealKey(env), bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

/** What `sealSecret` sealed, or null when it doesn't open (the secret changed). */
export async function openSecret(env, aad, text) {
  try {
    const box = unb64(text);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.subarray(0, 12), additionalData: te.encode(aad) }, await sealKey(env), box.subarray(12)));
  } catch (e) {
    if (e instanceof VaultError) throw e;
    return null;
  }
}
