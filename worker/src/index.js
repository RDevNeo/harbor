// Harbor accounts API: Clerk (Google sign-in, organizations) behind a small
// Worker that issues offline-verifiable Harbor tokens. Wire format: android/PROTOCOL.md.

const enc = new TextEncoder();
const dec = new TextDecoder();
const SKEW = 600;
const MAX_BODY = 192 * 1024;
const MAX_SETTINGS = 128 * 1024;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

// ---- encoding helpers

const b64 = (bytes) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
};
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async (data) => hex(await crypto.subtle.digest('SHA-256', data));
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const now = () => Math.floor(Date.now() / 1000);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function body(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'That request is too large.');
  try {
    const v = JSON.parse(text || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new HttpError(400, 'The request body must be a JSON object.');
}

const str = (v, max, what) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) {
    throw new HttpError(400, `Invalid ${what}.`);
  }
  return v.trim();
};

// ---- signing key and tokens

let keyCache = null;
async function signing(env) {
  if (keyCache && keyCache.raw === env.HARBOR_SIGNING_KEY) return keyCache;
  if (!env.HARBOR_SIGNING_KEY) throw new HttpError(500, 'The server is not configured yet.');
  const priv = await crypto.subtle.importKey(
    'pkcs8',
    unb64(env.HARBOR_SIGNING_KEY.trim()),
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  // A private Ed25519 JWK carries the public half in x.
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  const pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, true, [
    'verify',
  ]);
  keyCache = { raw: env.HARBOR_SIGNING_KEY, priv, pub, x: jwk.x };
  return keyCache;
}

async function signToken(env, payload) {
  const k = await signing(env);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: env.HARBOR_KID || 'k1' })));
  const data = `${head}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, k.priv, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

async function verifyToken(env, token) {
  const bad = new HttpError(401, 'Your Harbor session is invalid or expired: sign in again.', { signin: true });
  const parts = token.split('.');
  if (parts.length !== 3) throw bad;
  try {
    const head = JSON.parse(dec.decode(unb64(parts[0])));
    if (head.alg !== 'EdDSA' || head.kid !== (env.HARBOR_KID || 'k1')) throw bad;
    const k = await signing(env);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, k.pub, unb64(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) throw bad;
    const p = JSON.parse(dec.decode(unb64(parts[1])));
    if (p.iss !== 'harbor-accounts' || !(p.exp > now())) throw bad;
    return p;
  } catch (e) {
    throw e instanceof HttpError ? e : bad;
  }
}

function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '');
  if (!m) throw new HttpError(401, 'Sign in to continue.', { signin: true });
  return m[1];
}

// ---- device proof (ECDSA P-256)

// WebCrypto wants raw r||s; clients may send ASN.1 DER.
function derToRaw(sig) {
  if (sig.length === 64) return sig;
  let i = 0;
  const len = () => {
    let l = sig[i++];
    if (l & 0x80) {
      const n = l & 0x7f;
      l = 0;
      for (let j = 0; j < n; j++) l = (l << 8) | sig[i++];
    }
    return l;
  };
  if (sig[i++] !== 0x30) throw new Error('der');
  len();
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (sig[i++] !== 0x02) throw new Error('der');
    let l = len();
    let v = sig.subarray(i, i + l);
    i += l;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new Error('der');
    out.set(v, part * 32 + (32 - v.length));
  }
  return out;
}

async function checkDevice(dev, ct) {
  const refused = new HttpError(400, 'This device could not be verified.');
  if (!dev || typeof dev !== 'object') throw new HttpError(400, 'Missing device.');
  if (dev.kind !== 'pc' && dev.kind !== 'phone') throw new HttpError(400, 'Invalid device kind.');
  const name = typeof dev.name === 'string' ? dev.name.trim().slice(0, 64) : '';
  if (typeof dev.spki !== 'string' || dev.spki.length > 400 || typeof dev.sig !== 'string' || dev.sig.length > 400) throw refused;
  if (!Number.isFinite(dev.ts) || Math.abs(dev.ts - now()) > SKEW) {
    throw new HttpError(400, "This device's clock is off: fix the date and time, then try again.");
  }
  try {
    const spki = unb64(dev.spki);
    const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const msg = enc.encode(`harbor-device-v1\n${dev.ts}\n${await sha256hex(enc.encode(ct))}`);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(unb64(dev.sig)), msg);
    if (!ok) throw refused;
    return { kind: dev.kind, name, fp: await sha256hex(spki) };
  } catch {
    throw refused;
  }
}

// ---- Clerk

const unavailable = () => new HttpError(502, 'The sign-in service is unavailable right now. Try again soon.');

async function clerkRaw(url, init) {
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, ok: r.ok, data };
  } catch {
    throw unavailable();
  }
}

const clerk = (env, method, path, payload) =>
  clerkRaw(env.CLERK_API_URL + path, {
    method,
    headers: {
      authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

const clerkCode = (r) => r.data?.errors?.[0]?.code || '';

/** Clerk error -> a sentence for the user. */
function clerkFail(r, fallback) {
  if (r.status >= 500 || r.status === 0) return unavailable();
  const e = r.data?.errors?.[0];
  let msg = (e && (e.long_message || e.message)) || fallback;
  if (typeof msg !== 'string') msg = fallback;
  msg = msg.slice(0, 300);
  if (!/[.!?]$/.test(msg)) msg += '.';
  return new HttpError(r.status === 404 ? 404 : r.status === 409 ? 409 : 400, msg);
}

const must = (r, fallback) => {
  if (!r.ok) throw clerkFail(r, fallback);
  return r.data;
};

const fullName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
const roleOf = (r) => (r === 'org:admin' ? 'owner' : 'member');

async function userMemberships(env, sub) {
  const d = must(await clerk(env, 'GET', `/users/${enc2(sub)}/organization_memberships?limit=100`), 'Could not load your workspaces.');
  return (d.data || []).map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
    role: roleOf(m.role),
    personal: m.organization.public_metadata?.harbor_personal === sub,
  }));
}

async function orgMembers(env, ws) {
  const d = must(await clerk(env, 'GET', `/organizations/${enc2(ws)}/memberships?limit=100`), 'Could not load the workspace members.');
  return (d.data || []).map((m) => {
    const u = m.public_user_data || {};
    return {
      id: u.user_id,
      name: fullName(u) || u.identifier || '',
      email: u.identifier || '',
      role: roleOf(m.role),
    };
  });
}

const enc2 = encodeURIComponent;

// ---- auth for the Harbor-token routes

async function harborAuth(req, env) {
  return verifyToken(env, bearer(req));
}

async function liveWs(env, sub) {
  return userMemberships(env, sub);
}

// ---- routes

async function session(req, env) {
  const ct = bearer(req);
  const b = await body(req);
  const dev = await checkDevice(b.device, ct);
  const app = typeof b.app === 'string' ? b.app.slice(0, 32) : '';

  const ui = await clerkRaw(`${env.CLERK_FRONTEND_URL}/oauth/userinfo`, { headers: { authorization: `Bearer ${ct}` } });
  if (ui.status >= 500 || ui.status === 0) throw unavailable();
  const sub = ui.ok && typeof ui.data?.sub === 'string' ? ui.data.sub : null;
  if (!sub) throw new HttpError(401, 'Your sign-in expired: sign in again.', { signin: true });
  return json(await issue(env, sub, dev, ui.data.email));
}

/** Who the account is, its personal workspace, invitations, workspaces, the device, and a
 *  Harbor token bound to the device: the answer of every way to sign in. */
async function issue(env, sub, dev, fallbackEmail) {
  const user = must(await clerk(env, 'GET', `/users/${enc2(sub)}`), 'Could not load your account.');
  const emails = user.email_addresses || [];
  const primary = emails.find((e) => e.id === user.primary_email_address_id) || emails[0];
  const email = (primary?.email_address || fallbackEmail || '').toLowerCase();
  const verified = emails.filter((e) => e.verification?.status === 'verified').map((e) => e.email_address.toLowerCase());
  const first = user.first_name || email.split('@')[0] || 'My';
  const name = fullName(user) || email.split('@')[0];

  await ensurePersonal(env, sub, first);

  // Invitations wait for the person to accept them in Harbor (GET /v1/invites); nothing joins here.
  const pending = await pendingFor(env, sub, verified);
  const workspaces = await userMemberships(env, sub);

  await env.DB.prepare(
    `INSERT INTO devices (fp,user_id,kind,name,seen) VALUES (?,?,?,?,?)
     ON CONFLICT(fp) DO UPDATE SET user_id=excluded.user_id, kind=excluded.kind, name=excluded.name, seen=excluded.seen`,
  )
    .bind(dev.fp, sub, dev.kind, dev.name, now())
    .run();

  const iat = now();
  const exp = iat + Math.max(1, parseInt(env.TOKEN_DAYS, 10) || 7) * 86400;
  const token = await signToken(env, {
    iss: 'harbor-accounts',
    sub,
    email,
    name,
    ws: workspaces.map((w) => w.id),
    dev: dev.fp,
    kind: dev.kind,
    iat,
    exp,
  });

  const out = {
    account: { id: sub, email, name, image: user.image_url || '' },
    workspaces,
    token,
    exp,
    device: { fp: dev.fp },
    joined: [],
    invites: pending,
  };
  if (dev.kind === 'pc') {
    const row = await env.DB.prepare(`SELECT ws FROM pcs WHERE fp=?`).bind(dev.fp).first();
    if (row) {
      const mine = workspaces.find((w) => w.id === row.ws);
      const info = await wsInfo(env, row.ws, mine?.name);
      if (info) out.pc = { ws: row.ws, ws_name: info.name, owner: info.owner, member: !!mine };
    }
  }
  return out;
}

// ---- Android's own Google account picker (Credential Manager): a Google ID token

let googleKeys = null;
/** Google's signing keys (JWKS), cached for an hour. */
async function googleJwks(env, kid) {
  const fresh = googleKeys && Date.now() - googleKeys.at < 3600_000 && googleKeys.keys[kid];
  if (!fresh) {
    let r;
    try {
      r = await fetch(env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs');
    } catch {
      throw unavailable();
    }
    if (!r.ok) throw unavailable();
    const keys = {};
    for (const k of (await r.json()).keys || []) keys[k.kid] = k;
    googleKeys = { at: Date.now(), keys };
  }
  return googleKeys.keys[kid];
}

/** The claims of a Google ID token for Harbor's Web client, after checking its signature
 *  (RS256, Google's keys), issuer, audience, expiry, nonce and verified email. */
async function verifyGoogle(env, token, nonce) {
  const bad = (why) => new HttpError(401, `Google's sign-in couldn't be checked (${why}): try again.`, { signin: true });
  const parts = String(token).split('.');
  if (parts.length !== 3) throw bad('format');
  let head, claims;
  try {
    head = JSON.parse(dec.decode(unb64(parts[0])));
    claims = JSON.parse(dec.decode(unb64(parts[1])));
  } catch {
    throw bad('format');
  }
  if (head.alg !== 'RS256') throw bad('algorithm');
  const jwk = await googleJwks(env, head.kid);
  if (!jwk) throw bad('key');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw bad('signature');
  if (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com') throw bad('issuer');
  if (claims.aud !== env.GOOGLE_WEB_CLIENT_ID) throw bad('audience');
  if (!(claims.exp > now())) throw bad('expired');
  if (nonce && claims.nonce !== nonce) throw bad('nonce');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new HttpError(403, 'That Google account has no verified email.');
  return claims;
}

/** A new renewal secret for a phone (only its hash is kept). */
async function newRefresh(env, fp, sub) {
  const secret = rand(32);
  await env.DB.prepare(
    `INSERT INTO device_refresh (fp,user_id,hash,at) VALUES (?,?,?,?)
     ON CONFLICT(fp) DO UPDATE SET user_id=excluded.user_id, hash=excluded.hash, at=excluded.at`,
  )
    .bind(fp, sub, await sha256hex(enc.encode(secret)), now())
    .run();
  return secret;
}

/** POST /v1/session/google: a phone that picked its Google account in Android's own sheet.
 *  The ID token's verified email must belong to a Clerk account (made by a sign-in through
 *  Clerk, e.g. on a PC): then it's that same account. Without one: `browser: true`, sign in
 *  through Clerk once. */
async function googleSession(req, env) {
  if (!env.GOOGLE_WEB_CLIENT_ID) throw new HttpError(404, 'Google sign-in on phones is not set up.', { browser: true });
  const b = await body(req);
  if (typeof b.id_token !== 'string' || b.id_token.length > 8192) throw new HttpError(400, 'Missing Google sign-in.');
  const dev = await checkDevice(b.device, b.id_token);
  if (dev.kind !== 'phone') throw new HttpError(400, 'Only phones sign in this way.');
  const claims = await verifyGoogle(env, b.id_token, typeof b.nonce === 'string' ? b.nonce : '');
  const email = String(claims.email || '').toLowerCase();
  const list = must(await clerk(env, 'GET', `/users?email_address=${enc2(email)}&limit=10`), 'Could not look up your account.');
  const users = Array.isArray(list) ? list : list.data || [];
  const user = users.find((u) => (u.email_addresses || []).some((e) => e.email_address.toLowerCase() === email && e.verification?.status === 'verified'));
  if (!user) {
    throw new HttpError(409, 'This Google account has no Harbor account yet: finish the first sign-in in the browser.', { browser: true });
  }
  const out = await issue(env, user.id, dev, email);
  out.refresh = await newRefresh(env, dev.fp, user.id);
  return json(out);
}

/** POST /v1/session/refresh: a new Harbor token for a phone that signed in with the picker,
 *  with its renewal secret and the proof it holds its key. */
async function refreshSession(req, env) {
  const b = await body(req);
  if (typeof b.refresh !== 'string' || b.refresh.length !== 64) throw new HttpError(401, 'Sign in again.', { signin: true });
  const dev = await checkDevice(b.device, b.refresh);
  const row = await env.DB.prepare(`SELECT user_id, hash FROM device_refresh WHERE fp=?`).bind(dev.fp).first();
  if (!row || row.hash !== (await sha256hex(enc.encode(b.refresh)))) throw new HttpError(401, 'Your sign-in on this phone ended: sign in again.', { signin: true });
  const r = await clerk(env, 'GET', `/users/${enc2(row.user_id)}`);
  if (r.status === 404) {
    await env.DB.prepare(`DELETE FROM device_refresh WHERE fp=?`).bind(dev.fp).run();
    throw new HttpError(401, 'That account is gone: sign in again.', { signin: true });
  }
  return json(await issue(env, row.user_id, dev, ''));
}

/** Workspace name and the name of its admin; null when Clerk no longer has it. */
async function wsInfo(env, ws, knownName) {
  let name = knownName;
  if (!name) {
    const r = await clerk(env, 'GET', `/organizations/${enc2(ws)}`);
    if (r.status === 404) return null;
    name = must(r, 'Could not load the workspace.').name;
  }
  const members = await orgMembers(env, ws);
  const admin = members.find((m) => m.role === 'owner');
  return { name, owner: admin?.name || '' };
}

/** One personal workspace per account; races resolve through the D1 primary key. */
async function ensurePersonal(env, sub, first) {
  const read = () => env.DB.prepare(`SELECT personal_ws FROM accounts WHERE user_id=?`).bind(sub).first('personal_ws');
  const have = await read();
  if (have) return have;
  const org = must(
    await clerk(env, 'POST', '/organizations', {
      name: `${first}'s workspace`.slice(0, 80),
      created_by: sub,
      public_metadata: { harbor_personal: sub },
      max_allowed_memberships: 20,
    }),
    'Could not create your workspace.',
  );
  await env.DB.prepare(`INSERT INTO accounts (user_id,personal_ws,created) VALUES (?,?,?) ON CONFLICT(user_id) DO NOTHING`)
    .bind(sub, org.id, now())
    .run();
  const id = await read();
  if (id !== org.id) await clerk(env, 'DELETE', `/organizations/${enc2(org.id)}`).catch(() => {});
  return id;
}

async function directory(req, env) {
  const p = await harborAuth(req, env);
  const mine = (await liveWs(env, p.sub)).slice(0, 20);
  const workspaces = await Promise.all(
    mine.map(async (w) => {
      const members = await orgMembers(env, w.id);
      const ids = members.map((m) => m.id).filter(Boolean);
      const ph = ids.map(() => '?').join(',') || "''";
      const [pcs, devs, inv] = await Promise.all([
        env.DB.prepare(`SELECT * FROM pcs WHERE ws=? ORDER BY name`).bind(w.id).all(),
        env.DB.prepare(`SELECT fp FROM devices WHERE user_id IN (${ph})`).bind(...ids).all(),
        w.role === 'owner'
          ? env.DB.prepare(`SELECT id,email,at FROM invites WHERE ws=? AND status='pending' ORDER BY at`).bind(w.id).all()
          : Promise.resolve({ results: [] }),
      ]);
      return {
        ...w,
        members,
        pcs: pcs.results.map((r) => ({
          fp: r.fp,
          id: r.pid,
          name: r.name,
          addrs: JSON.parse(r.addrs || '[]'),
          owner: r.owner,
          owner_name: r.owner_name,
          seen: r.seen,
          version: r.version,
        })),
        devices: devs.results.map((r) => r.fp),
        invites: inv.results,
      };
    }),
  );
  return json({ at: Date.now(), workspaces });
}

async function putPc(req, env) {
  const p = await harborAuth(req, env);
  if (p.kind !== 'pc') throw new HttpError(403, 'Only a PC can register itself.');
  const b = await body(req);
  const ws = str(b.ws, 80, 'workspace');
  const name = str(b.name, 64, 'name');
  if (b.id !== undefined && (typeof b.id !== 'string' || b.id.length > 80)) throw new HttpError(400, 'Invalid PC id.');
  const pid = b.id || '';
  const version = typeof b.version === 'string' ? b.version.slice(0, 32) : '';
  if (!Array.isArray(b.addrs) || b.addrs.length > 16) throw new HttpError(400, 'Invalid addresses.');
  const addrs = b.addrs.map((a) => str(a, 100, 'address'));

  const mine = await liveWs(env, p.sub);
  if (!mine.some((w) => w.id === ws)) throw new HttpError(403, 'You are not a member of that workspace.');

  const row = await env.DB.prepare(`SELECT ws FROM pcs WHERE fp=?`).bind(p.dev).first();
  if (row && row.ws !== ws && !mine.some((w) => w.id === row.ws)) {
    const info = await wsInfo(env, row.ws);
    if (info) {
      throw new HttpError(403, `This PC belongs to “${info.name}”. Ask its owner to invite you.`, {
        ws: row.ws,
        ws_name: info.name,
        owner: info.owner,
      });
    }
  }
  await env.DB.prepare(
    `INSERT INTO pcs (fp,pid,ws,name,addrs,owner,owner_name,version,seen) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(fp) DO UPDATE SET pid=excluded.pid, ws=excluded.ws, name=excluded.name, addrs=excluded.addrs,
       owner=excluded.owner, owner_name=excluded.owner_name, version=excluded.version, seen=excluded.seen`,
  )
    .bind(p.dev, pid, ws, name, JSON.stringify(addrs), p.sub, p.name || '', version, now())
    .run();
  return json({ ok: true });
}

async function deletePc(req, env, fp) {
  const p = await harborAuth(req, env);
  const row = await env.DB.prepare(`SELECT ws FROM pcs WHERE fp=?`).bind(fp).first();
  if (!row) throw new HttpError(404, 'That PC is not registered.');
  if (!(await liveWs(env, p.sub)).some((w) => w.id === row.ws)) {
    throw new HttpError(403, 'You are not a member of that PC’s workspace.');
  }
  await env.DB.prepare(`DELETE FROM pcs WHERE fp=?`).bind(fp).run();
  return json({ ok: true });
}

/** The device's own user, or an owner of a workspace that user belongs to, may remove it. */
async function deleteDevice(req, env, fp) {
  const p = await harborAuth(req, env);
  const dev = await env.DB.prepare(`SELECT user_id FROM devices WHERE fp=?`).bind(fp).first();
  if (!dev) throw new HttpError(404, 'That device is not registered.');
  const mine = await liveWs(env, p.sub);
  let allowed = dev.user_id === p.sub;
  if (!allowed) {
    const owned = mine.filter((w) => w.role === 'owner');
    const lists = await Promise.all(owned.map((w) => orgMembers(env, w.id)));
    allowed = lists.some((ms) => ms.some((m) => m.id === dev.user_id));
  }
  if (!allowed) throw new HttpError(403, 'You cannot remove that device.');
  const pc = await env.DB.prepare(`SELECT ws FROM pcs WHERE fp=?`).bind(fp).first();
  const stmts = [env.DB.prepare(`DELETE FROM devices WHERE fp=?`).bind(fp), env.DB.prepare(`DELETE FROM device_refresh WHERE fp=?`).bind(fp)];
  if (pc && (dev.user_id === p.sub || mine.some((w) => w.id === pc.ws))) stmts.push(env.DB.prepare(`DELETE FROM pcs WHERE fp=?`).bind(fp));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

async function readSettings(env, sub) {
  const r = await env.DB.prepare(`SELECT data,at FROM settings WHERE user_id=?`).bind(sub).first();
  return { data: r ? JSON.parse(r.data) : {}, at: r ? r.at : 0 };
}

async function getSettings(req, env) {
  const p = await harborAuth(req, env);
  const s = await readSettings(env, p.sub);
  return json({ settings: s.data, at: s.at });
}

async function putSettings(req, env) {
  const p = await harborAuth(req, env);
  const b = await body(req);
  if (!b.set || typeof b.set !== 'object' || Array.isArray(b.set)) throw new HttpError(400, 'Missing settings.');
  const cur = await readSettings(env, p.sub);
  let changed = false;
  for (const [k, e] of Object.entries(b.set)) {
    if (!k || k.length > 64) throw new HttpError(400, 'A setting name is empty or too long.');
    if (!e || typeof e !== 'object' || !Number.isFinite(e.at) || !(typeof e.v === 'string' || e.v === null)) {
      throw new HttpError(400, 'Invalid setting value.');
    }
    if (e.v !== null && enc.encode(e.v).length > 16 * 1024) throw new HttpError(413, 'A setting value is too large.');
    const old = cur.data[k];
    if (!old || e.at > old.at) {
      cur.data[k] = { v: e.v, at: e.at };
      changed = true;
    }
  }
  const text = JSON.stringify(cur.data);
  if (enc.encode(text).length > MAX_SETTINGS) throw new HttpError(413, 'Your settings are too large.');
  if (changed) {
    cur.at = Date.now();
    await env.DB.prepare(
      `INSERT INTO settings (user_id,data,at) VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, at=excluded.at`,
    )
      .bind(p.sub, text, cur.at)
      .run();
  }
  return json({ settings: cur.data, at: cur.at });
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

async function requireOwner(env, sub, ws) {
  const w = (await liveWs(env, sub)).find((x) => x.id === ws);
  if (!w) throw new HttpError(403, 'You are not a member of that workspace.');
  if (w.role !== 'owner') throw new HttpError(403, 'Only the workspace owner can do that.');
  return w;
}

async function invite(req, env, ws) {
  const p = await harborAuth(req, env);
  const w = await requireOwner(env, p.sub, ws);
  const b = await body(req);
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address.');

  if ((await orgMembers(env, ws)).some((m) => m.email.toLowerCase() === email)) {
    throw new HttpError(409, 'That person is already a member of this workspace.');
  }
  const dup = await env.DB.prepare(`SELECT id FROM invites WHERE ws=? AND email=? AND status='pending'`).bind(ws, email).first();
  if (dup) throw new HttpError(409, 'That person has already been invited.');

  // Harbor's own invitation (Clerk's need an email-enabled instance): it waits in the invitee's
  // Harbor once they sign in with a Google account whose verified email is this one.
  const row = { id: `inv_${rand(8)}`, email, at: now() };
  await env.DB.prepare(`INSERT INTO invites (id,ws,email,inviter,status,at,ws_name,inviter_name) VALUES (?,?,?,?,'pending',?,?,?)`)
    .bind(row.id, ws, email, p.sub, row.at, w.name || '', p.name || '')
    .run();
  return json({ invite: row });
}

async function deleteInvite(req, env, ws, id) {
  const p = await harborAuth(req, env);
  await requireOwner(env, p.sub, ws);
  const row = await env.DB.prepare(`SELECT id FROM invites WHERE id=? AND ws=? AND status='pending'`).bind(id, ws).first();
  if (!row) throw new HttpError(404, 'That invitation does not exist.');
  await env.DB.prepare(`DELETE FROM invites WHERE id=?`).bind(id).run();
  return json({ ok: true });
}

async function deleteMember(req, env, ws, user) {
  const p = await harborAuth(req, env);
  const w = (await liveWs(env, p.sub)).find((x) => x.id === ws);
  if (!w) throw new HttpError(403, 'You are not a member of that workspace.');
  if (user === p.sub) {
    if (w.personal) throw new HttpError(409, 'You cannot leave your own personal workspace.');
  } else if (w.role !== 'owner') {
    throw new HttpError(403, 'Only the workspace owner can remove members.');
  }
  const r = await clerk(env, 'DELETE', `/organizations/${enc2(ws)}/memberships/${enc2(user)}`);
  if (!r.ok && r.status !== 404) throw clerkFail(r, 'Could not remove that member.');
  return json({ ok: true });
}

/** The verified addresses of an account (Clerk's user record). */
async function verifiedEmails(env, sub) {
  const user = must(await clerk(env, 'GET', `/users/${enc2(sub)}`), 'Could not load your account.');
  return (user.email_addresses || []).filter((e) => e.verification?.status === 'verified').map((e) => e.email_address.toLowerCase());
}

/** Invitations waiting for this account (to one of its verified addresses), with the names to show. */
async function pendingFor(env, sub, verified) {
  if (!verified.length) return [];
  const ph = verified.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT * FROM invites WHERE status='pending' AND email IN (${ph}) ORDER BY at`).bind(...verified).all();
  const mine = new Set((await userMemberships(env, sub)).map((w) => w.id));
  const out = [];
  for (const inv of results) {
    // Already in that workspace (joined another way, e.g. through Clerk's own link): settled.
    if (mine.has(inv.ws)) {
      await env.DB.prepare(`DELETE FROM invites WHERE id=?`).bind(inv.id).run();
      continue;
    }
    let wsName = inv.ws_name, by = inv.inviter_name;
    if (!wsName) {
      const r = await clerk(env, 'GET', `/organizations/${enc2(inv.ws)}`);
      if (r.status === 404) {
        await env.DB.prepare(`DELETE FROM invites WHERE id=?`).bind(inv.id).run();
        continue;
      }
      wsName = r.ok ? r.data.name : '';
    }
    if (!by && inv.inviter) {
      const r = await clerk(env, 'GET', `/users/${enc2(inv.inviter)}`);
      if (r.ok) by = fullName(r.data) || '';
    }
    out.push({ id: inv.id, ws: inv.ws, ws_name: wsName, inviter_name: by, email: inv.email, at: inv.at });
  }
  return out;
}

async function listInvites(req, env) {
  const p = await harborAuth(req, env);
  return json({ invites: await pendingFor(env, p.sub, await verifiedEmails(env, p.sub)) });
}

/** Accept (join the workspace) or decline one of the account's own pending invitations. */
async function answerInvite(req, env, id, accept) {
  const p = await harborAuth(req, env);
  const inv = await env.DB.prepare(`SELECT * FROM invites WHERE id=? AND status='pending'`).bind(id).first();
  if (!inv) throw new HttpError(404, 'That invitation is no longer waiting.');
  if (!(await verifiedEmails(env, p.sub)).includes(inv.email)) throw new HttpError(403, 'That invitation is for another address.');
  if (accept) {
    const r = await clerk(env, 'POST', `/organizations/${enc2(inv.ws)}/memberships`, { user_id: p.sub, role: 'org:member' });
    if (!r.ok && clerkCode(r) !== 'already_a_member_in_organization') throw clerkFail(r, 'Could not join that workspace.');
  }
  // Answered either way: the invitation is gone.
  await env.DB.prepare(`DELETE FROM invites WHERE id=?`).bind(id).run();
  const workspaces = await userMemberships(env, p.sub);
  return json({ ok: true, workspaces, joined: accept ? workspaces.find((w) => w.id === inv.ws) || null : null });
}

function invitePage() {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harbor invite</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>You're invited to a Harbor workspace</h1>
<p>Install Harbor on a PC or phone and sign in with Google using the address this invite was sent to.</p></body>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function androidBounce(req, env) {
  const base = env.APP_REDIRECT || 'harbor://oauth';
  const search = new URL(req.url).search;
  const to = search ? base + (base.includes('?') ? '&' + search.slice(1) : search) : base;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Harbor</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><p><a href="${esc(to)}">Open Harbor</a></p></body>`;
  return new Response(html, { status: 302, headers: { location: to, 'content-type': 'text/html; charset=utf-8' } });
}

async function route(req, env) {
  const url = new URL(req.url);
  const m = req.method;
  const seg = url.pathname.replace(/\/+$/, '').split('/').slice(1).map(decodeURIComponent);
  const path = '/' + seg.join('/');

  if (m === 'GET' && path === '/oauth/android') return androidBounce(req, env);
  if (m === 'GET' && path === '/invite') return invitePage();
  if (m === 'GET' && path === '/v1/keys') {
    const k = await signing(env);
    return json({ keys: [{ kid: env.HARBOR_KID || 'k1', alg: 'EdDSA', x: k.x }] });
  }
  if (m === 'POST' && path === '/v1/session') return session(req, env);
  if (m === 'POST' && path === '/v1/session/google') return googleSession(req, env);
  if (m === 'POST' && path === '/v1/session/refresh') return refreshSession(req, env);
  if (m === 'GET' && path === '/v1/directory') return directory(req, env);
  if (m === 'GET' && path === '/v1/invites') return listInvites(req, env);
  if (m === 'POST' && seg[0] === 'v1' && seg[1] === 'invites' && seg.length === 4 && (seg[3] === 'accept' || seg[3] === 'decline')) {
    return answerInvite(req, env, seg[2], seg[3] === 'accept');
  }
  if (m === 'POST' && path === '/v1/pcs') return putPc(req, env);
  if (m === 'DELETE' && seg[0] === 'v1' && seg[1] === 'pcs' && seg.length === 3) return deletePc(req, env, seg[2]);
  if (m === 'DELETE' && seg[0] === 'v1' && seg[1] === 'devices' && seg.length === 3) return deleteDevice(req, env, seg[2]);
  if (path === '/v1/settings') {
    if (m === 'GET') return getSettings(req, env);
    if (m === 'PUT') return putSettings(req, env);
  }
  if (seg[0] === 'v1' && seg[1] === 'workspaces' && seg[3] === 'invites') {
    if (m === 'POST' && seg.length === 4) return invite(req, env, seg[2]);
    if (m === 'DELETE' && seg.length === 5) return deleteInvite(req, env, seg[2], seg[4]);
  }
  if (m === 'DELETE' && seg[0] === 'v1' && seg[1] === 'workspaces' && seg[3] === 'members' && seg.length === 5) {
    return deleteMember(req, env, seg[2], seg[4]);
  }
  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error('unhandled', e?.name || 'error'); // never the message: it may carry request data
      return json({ error: 'Something went wrong on our side. Try again soon.' }, 500);
    }
  },
};
