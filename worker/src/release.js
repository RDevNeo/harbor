const DEFAULT_REPO = 'RDevNeo/harbor';
const DEFAULT_ORIGIN = 'https://github.com';
const MANIFEST = 'harbor-app.json.minisig';
const WAIT_MS = 50_000;
// A phone may ask to be held longer (`wait`, seconds): its radio wakes once per answer, so fewer is less battery.
const MAX_HOLD_MS = 240_000;
const MIN_GAP_MS = 5_000;
const RECHECK_MS = 10 * 60 * 1000;
const MISSING_ASSET_MS = 5_000;
const MISSING_ASSET_TRIES = 36;
const MAX_WAITERS = 1000;
const SHA_RE = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);
const MAX_HOOK_BYTES = 30 * 1024 * 1024;
// A nudge (a PC that just pushed) reads GitHub at most this often, and a few times while GitHub doesn't show the commit yet.
const NUDGE_GAP_MS = 1000;
const NUDGE_TRIES = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0), m[4] ? 0 : 1];
}

export function newer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function tagFrom(location) {
  const at = String(location || '').lastIndexOf('/tag/');
  if (at < 0) return null;
  const tag = location.slice(at + 5).trim();
  return parseVersion(tag) ? tag.replace(/^v/, '') : null;
}

// The ping is never believed: this object re-reads GitHub's latest release itself.
export class ReleaseHub {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.waiters = new Set();
    this.version = undefined;
    this.readAt = 0;
    this.missing = 0;
    // The version the last ping named. Never believed either: it only keeps this object re-reading
    // GitHub, whose /releases/latest can still name the previous tag for a while after a release is
    // created. Kept in memory only: if the object is thrown away, the 10-minute recheck remains.
    this.hint = null;
    // Main's newest commit, as GitHub's push webhook told it ({ sha, at }), and the PCs waiting to hear
    // it moved (followmain.ts). Like the release, never believed by the PCs: only a reason to look.
    this.main = undefined;
    this.mainWaiters = new Set();
    this.mainReadAt = 0;
    this.nudging = null;
    this.nudgeWant = null;
    // Mains seen before the current one: a lagging read of GitHub never takes main back to one.
    this.pastMains = [];
  }

  get repo() {
    return this.env.RELEASE_REPO || DEFAULT_REPO;
  }

  get origin() {
    return this.env.RELEASE_ORIGIN || DEFAULT_ORIGIN;
  }

  async load() {
    if (this.version === undefined) this.version = (await this.state.storage.get('version')) || null;
    return this.version;
  }

  async readGithub() {
    const init = { redirect: 'manual', headers: { 'user-agent': 'harbor-accounts' } };
    const res = await fetch(`${this.origin}/${this.repo}/releases/latest`, { ...init, method: 'HEAD' });
    const version = tagFrom(res.headers.get('location'));
    if (!version) return { version: null, ready: false };
    const asset = await fetch(`${this.origin}/${this.repo}/releases/download/v${version}/${MANIFEST}`, { ...init, method: 'HEAD' });
    return { version, ready: asset.status === 200 || (asset.status >= 300 && asset.status < 400) };
  }

  async refresh(force, hint) {
    if (hint && parseVersion(hint) && newer(hint, this.hint || '0.0.0')) this.hint = String(hint).replace(/^v/, '');
    const wait = this.readAt + MIN_GAP_MS - Date.now();
    if (!force || wait > 0) {
      if (force) await this.state.storage.setAlarm(Date.now() + Math.max(wait, 1));
      return this.load();
    }
    this.readAt = Date.now();
    let seen;
    try {
      seen = await this.readGithub();
    } catch {
      await this.state.storage.setAlarm(Date.now() + MISSING_ASSET_MS * 4);
      return this.load();
    }
    const known = await this.load();
    if (seen.version && newer(seen.version, known || '0.0.0')) {
      if (!seen.ready) {
        if (this.missing < MISSING_ASSET_TRIES) {
          this.missing += 1;
          await this.state.storage.setAlarm(Date.now() + MISSING_ASSET_MS);
        }
        return known;
      }
      this.missing = 0;
      this.version = seen.version;
      await this.state.storage.put('version', seen.version);
      this.announce();
    }
    // A ping named a release GitHub doesn't show yet: look again shortly, as for missing files.
    if (this.hint && newer(this.hint, seen.version || '0.0.0') && newer(this.hint, this.version || '0.0.0')) {
      if (this.missing < MISSING_ASSET_TRIES) {
        this.missing += 1;
        await this.state.storage.setAlarm(Date.now() + MISSING_ASSET_MS);
      } else {
        this.hint = null;
      }
    } else if (this.hint && !newer(this.hint, this.version || '0.0.0')) {
      this.hint = null;
    }
    return this.version;
  }

  announce() {
    for (const w of [...this.waiters]) {
      if (newer(this.version, w.have)) w.finish(this.answer());
    }
  }

  async alarm() {
    await this.refresh(true);
    // The 10-minute recheck only when refresh didn't ask for a sooner look (files missing, a pinged
    // release GitHub doesn't show yet): overwriting that one held such a release back 10 minutes.
    if (this.waiters.size === 0) return;
    const at = await this.state.storage.getAlarm();
    if (at === null || at <= Date.now()) await this.state.storage.setAlarm(Date.now() + RECHECK_MS);
  }

  /** `hold`: how long to keep the request when there's no news (ms); 0 answers at once (a phone's quick look). */
  async wait(have, signal, hold) {
    let version = await this.load();
    if (!version) version = await this.refresh(true);
    if (version && newer(version, have)) return this.answer();
    if (hold === 0) return new Response(null, { status: 204 });
    if (this.waiters.size >= MAX_WAITERS) return json({ error: 'Too many waiting PCs.' }, 503, { 'retry-after': '30' });
    if (this.waiters.size === 0 && !(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + RECHECK_MS);
    if (this.version && newer(this.version, have)) return this.answer();
    return new Promise((resolve) => {
      const waiter = {
        have,
        finish: (res) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(res);
        },
      };
      const timer = setTimeout(() => waiter.finish(new Response(null, { status: 204 })), hold > 0 ? hold : Number(this.env.RELEASE_WAIT_MS) || WAIT_MS);
      this.waiters.add(waiter);
      signal?.addEventListener('abort', () => waiter.finish(new Response(null, { status: 204 })), { once: true });
    });
  }

  answer() {
    return json({ version: this.version, at: Math.floor(Date.now() / 1000) });
  }

  async loadMain() {
    if (this.main === undefined) this.main = (await this.state.storage.get('main')) || null;
    return this.main;
  }

  async setMain(sha, at) {
    const known = await this.loadMain();
    if (known && known.sha === sha) return known;
    if (known) this.pastMains = [...this.pastMains.filter((p) => p !== known.sha), known.sha].slice(-50);
    this.pastMains = this.pastMains.filter((p) => p !== sha);
    this.main = { sha, at };
    await this.state.storage.put('main', this.main);
    for (const w of [...this.mainWaiters]) if (w.have !== sha) w.finish(json(this.main));
    return this.main;
  }

  /** Main's commit as GitHub's git endpoint advertises it (no API rate limit): what a nudge is checked against. */
  async readGithubMain() {
    const res = await fetch(`${this.origin}/${this.repo}.git/info/refs?service=git-upload-pack`, { headers: { 'user-agent': 'git/2.47.0 (harbor-accounts)' } });
    if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
    const m = /([0-9a-f]{40}) refs\/heads\/main(?:\0|\n)/.exec(await res.text());
    return m ? m[1] : null;
  }

  /**
   * A signed-in PC says it just pushed main (`want`). Never believed: main becomes what GitHub itself
   * says. `want` only keeps this reading GitHub (once a second, a few times) while GitHub shows another commit.
   */
  nudge(want) {
    if (want) this.nudgeWant = want;
    if (this.nudging) return this.nudging;
    this.nudging = (async () => {
      for (let i = 0; i < NUDGE_TRIES; i++) {
        const wait = this.mainReadAt + (Number(this.env.NUDGE_GAP_MS) || NUDGE_GAP_MS) - Date.now();
        if (wait > 0) await sleep(wait);
        this.mainReadAt = Date.now();
        let sha = null;
        try {
          sha = await this.readGithubMain();
        } catch {}
        if (sha && !this.pastMains.includes(sha)) await this.setMain(sha, Date.now());
        if (!this.nudgeWant || sha === this.nudgeWant) break;
      }
      this.nudgeWant = null;
      return this.main || null;
    })().finally(() => {
      this.nudging = null;
    });
    return this.nudging;
  }

  async waitMain(have, signal) {
    const main = await this.loadMain();
    if (main && main.sha !== have) return json(main);
    if (this.waiters.size + this.mainWaiters.size >= MAX_WAITERS) return json({ error: 'Too many waiting PCs.' }, 503, { 'retry-after': '30' });
    return new Promise((resolve) => {
      const waiter = {
        have,
        finish: (res) => {
          clearTimeout(timer);
          this.mainWaiters.delete(waiter);
          resolve(res);
        },
      };
      const timer = setTimeout(() => waiter.finish(new Response(null, { status: 204 })), Number(this.env.RELEASE_WAIT_MS) || WAIT_MS);
      this.mainWaiters.add(waiter);
      signal?.addEventListener('abort', () => waiter.finish(new Response(null, { status: 204 })), { once: true });
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/refresh') {
      this.missing = 0;
      let hint = null;
      try {
        const v = (await request.json())?.version;
        if (typeof v === 'string') hint = v;
      } catch {}
      const version = await this.refresh(true, hint);
      return json({ ok: true, version });
    }
    if (request.method === 'GET' && url.pathname === '/wait') {
      const w = url.searchParams.get('wait');
      const hold = w === null || w === '' ? undefined : Math.min(Math.max(Number(w) || 0, 0), MAX_HOLD_MS / 1000) * 1000;
      return this.wait(url.searchParams.get('have'), request.signal, hold);
    }
    if (request.method === 'POST' && url.pathname === '/main') {
      const b = await request.json().catch(() => ({}));
      if (!SHA_RE.test(String(b?.sha || ''))) return json({ error: 'Send { sha }.' }, 400);
      return json({ ok: true, main: await this.setMain(b.sha, Number(b.at) || Date.now()) });
    }
    if (request.method === 'POST' && url.pathname === '/main/nudge') {
      const b = await request.json().catch(() => ({}));
      const want = SHA_RE.test(String(b?.sha || '')) ? b.sha : null;
      return json({ ok: true, main: await this.nudge(want) });
    }
    if (request.method === 'GET' && url.pathname === '/main/wait') return this.waitMain(url.searchParams.get('have') || '', request.signal);
    return json({ error: 'Not found.' }, 404);
  }
}

const hub = (env) => env.RELEASES.get(env.RELEASES.idFromName('latest'));

export async function releasePing(req, env) {
  // The version the release workflow names goes along as a hint (see ReleaseHub.hint).
  let version = null;
  try {
    const v = (await req.json())?.version;
    if (typeof v === 'string' && parseVersion(v)) version = v;
  } catch {}
  const res = await hub(env).fetch('https://release/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  const out = await res.json();
  return json({ ok: true, version: out.version || null }, 202);
}

/**
 * GET /v1/release/wait?have=<version>[&wait=<seconds>]: PCs and phones (no sign-in: what's published is
 * public). `wait` (0-240, phones) replaces the usual ~50 s hold; 0 answers at once, 204 when nothing's newer.
 */
export async function releaseWait(req, env) {
  const q = new URL(req.url).searchParams;
  const have = q.get('have') || '';
  if (!parseVersion(have)) return json({ error: 'Send ?have=<the version this PC runs>.' }, 400);
  const w = q.get('wait');
  if (w !== null && !/^\d{1,6}$/.test(w)) return json({ error: 'Send ?wait=<seconds>, 0 to 240.' }, 400);
  return hub(env).fetch(`https://release/wait?have=${encodeURIComponent(have)}${w === null ? '' : `&wait=${w}`}`, { signal: req.signal });
}

// ---- Main's news (follow-main) ----
// GitHub's push webhook on the repository (secret GITHUB_WEBHOOK_SECRET, `X-Hub-Signature-256`) names main's
// new commit; every PC holds GET /v1/main/wait?have=<the commit it knows> and is answered { sha, at } when
// main isn't that one any more. The PCs only take it as a reason to look: they build what the repository
// itself says main is, and only forward from what they run.

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** True when `header` is `sha256=<HMAC-SHA256 of body with secret>` (compared in constant time). */
export async function signedBy(secret, body, header) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, body));
  if (want.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

export async function githubHook(req, env) {
  if (!env.GITHUB_WEBHOOK_SECRET) return json({ error: 'Not set up.' }, 503);
  const size = Number(req.headers.get('content-length') || 0);
  if (size > MAX_HOOK_BYTES) return json({ error: 'Too large.' }, 413);
  const body = await req.arrayBuffer();
  if (!(await signedBy(env.GITHUB_WEBHOOK_SECRET, body, req.headers.get('x-hub-signature-256')))) return json({ error: 'Bad signature.' }, 401);
  const event = req.headers.get('x-github-event');
  if (event === 'ping') return json({ ok: true });
  if (event !== 'push') return json({ ok: true, ignored: event || 'no event' }, 202);
  let p;
  try {
    p = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: 'Not JSON.' }, 400);
  }
  const repo = env.RELEASE_REPO || DEFAULT_REPO;
  const name = String(p?.repository?.full_name || '');
  if (name.toLowerCase() !== repo.toLowerCase() || p?.ref !== 'refs/heads/main') return json({ ok: true, ignored: 'not main' }, 202);
  const sha = String(p?.after || '');
  if (!SHA_RE.test(sha) || sha === ZERO_SHA) return json({ ok: true, ignored: 'no commit' }, 202);
  const res = await hub(env).fetch('https://release/main', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sha, at: Date.now() }),
  });
  return json({ ok: true, main: (await res.json()).main || null }, 202);
}

export async function mainWait(req, env) {
  const have = new URL(req.url).searchParams.get('have') || '';
  if (have !== '' && !SHA_RE.test(have)) return json({ error: 'Send ?have=<the commit this PC knows main at>, or nothing.' }, 400);
  return hub(env).fetch(`https://release/main/wait?have=${have}`, { signal: req.signal });
}

/**
 * POST /v1/main: a signed-in PC (its Harbor token, `claims`) that just pushed main says so, `{ sha }`. The
 * object checks GitHub before anyone hears of it; the webhook stays the backup for pushes from elsewhere.
 */
export async function mainNudge(req, env, claims) {
  if (claims?.kind !== 'pc') return json({ error: 'Only a PC can say it pushed.' }, 403);
  let sha = null;
  try {
    const v = (await req.json())?.sha;
    if (typeof v === 'string' && SHA_RE.test(v)) sha = v;
  } catch {}
  const res = await hub(env).fetch('https://release/main/nudge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sha }),
  });
  return json({ ok: true, main: (await res.json()).main || null }, 202);
}
