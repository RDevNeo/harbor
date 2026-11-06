const DEFAULT_REPO = 'RDevNeo/harbor';
const DEFAULT_ORIGIN = 'https://github.com';
const MANIFEST = 'harbor-app.json.minisig';
const WAIT_MS = 50_000;
const MIN_GAP_MS = 5_000;
const RECHECK_MS = 10 * 60 * 1000;
const MISSING_ASSET_MS = 5_000;
const MISSING_ASSET_TRIES = 36;
const MAX_WAITERS = 1000;

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
    if (this.waiters.size > 0) await this.state.storage.setAlarm(Date.now() + RECHECK_MS);
  }

  async wait(have, signal) {
    let version = await this.load();
    if (!version) version = await this.refresh(true);
    if (version && newer(version, have)) return this.answer();
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
      const timer = setTimeout(() => waiter.finish(new Response(null, { status: 204 })), Number(this.env.RELEASE_WAIT_MS) || WAIT_MS);
      this.waiters.add(waiter);
      signal?.addEventListener('abort', () => waiter.finish(new Response(null, { status: 204 })), { once: true });
    });
  }

  answer() {
    return json({ version: this.version, at: Math.floor(Date.now() / 1000) });
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
    if (request.method === 'GET' && url.pathname === '/wait') return this.wait(url.searchParams.get('have'), request.signal);
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

export async function releaseWait(req, env) {
  const have = new URL(req.url).searchParams.get('have') || '';
  if (!parseVersion(have)) return json({ error: 'Send ?have=<the version this PC runs>.' }, 400);
  return hub(env).fetch(`https://release/wait?have=${encodeURIComponent(have)}`, { signal: req.signal });
}
