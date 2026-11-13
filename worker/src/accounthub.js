// Pushes to one account's devices that something changed (an invitation came or went, a workspace
// gained or lost a member or a PC), so they fetch /v1/invites and /v1/directory at once instead of
// on their next poll. One object per account (idFromName(user id)). The message carries no data:
// devices always re-read through the authenticated routes.
//
// PCs keep a WebSocket open (GET /v1/events with Upgrade): the object accepts it with the
// hibernation API, so an idle connection costs nothing, and "ping" is answered by the runtime
// without waking it. Phones, which have no WebSocket client, long-poll GET /v1/events?since=N for
// up to WAIT_MS while a screen of the app is open. `seq` counts the changes: a device that comes
// back with an older one fetches again.

const WAIT_MS = 20_000;
const MAX_SOCKETS = 64;
const MAX_WAITERS = 64;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const WHAT = new Set(['invites', 'directory', 'vault', 'cloud']);

export class AccountHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env || {};
    this.waiters = new Set();
    this.seq = undefined;
    if (typeof WebSocketRequestResponsePair !== 'undefined' && ctx.setWebSocketAutoResponse) {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  async current() {
    if (this.seq === undefined) this.seq = (await this.ctx.storage.get('seq')) || 0;
    return this.seq;
  }

  /** Something changed for this account: every open socket and waiting poll hears it. */
  async notify(what) {
    // The workspace cloud changed: only PCs read it (their sockets), every few seconds while someone works. Phones
    // aren't woken and the seq stays (what a device missed of the rest is still told by it).
    if (what === 'cloud') {
      const msg = JSON.stringify({ seq: await this.current(), what });
      let sent = 0;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(msg);
          sent++;
        } catch {
          // gone
        }
      }
      return json({ ok: true, sent });
    }
    const seq = (await this.current()) + 1;
    this.seq = seq;
    await this.ctx.storage.put('seq', seq);
    const msg = JSON.stringify({ seq, what });
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
        sent++;
      } catch {
        // gone: the runtime closes it
      }
    }
    for (const w of [...this.waiters]) {
      w.finish(json({ seq, what }));
      sent++;
    }
    return json({ ok: true, seq, sent });
  }

  async socket(req) {
    if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426);
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return json({ error: 'Too many connections for this account.' }, 503);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    // What it has missed is unknown: it fetches once on every connect anyway; `seq` lets it skip a repeat.
    server.send(JSON.stringify({ seq: await this.current(), what: 'hello' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A phone's long poll: answers at once when `since` is behind, else at the next change or after `wait` ms (204). */
  async wait(since, waitMs, signal) {
    const seq = await this.current();
    if (!Number.isInteger(since) || since < seq) return json({ seq, what: 'hello' });
    if (this.waiters.size >= MAX_WAITERS) return json({ error: 'Too many waiting devices.' }, 503);
    return new Promise((resolve) => {
      const waiter = {
        finish: (res) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(res);
        },
      };
      const timer = setTimeout(() => waiter.finish(new Response(null, { status: 204 })), waitMs);
      this.waiters.add(waiter);
      signal?.addEventListener('abort', () => waiter.finish(new Response(null, { status: 204 })), { once: true });
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/notify') {
      let what = 'directory';
      try {
        const b = await req.json();
        if (WHAT.has(b?.what)) what = b.what;
      } catch {
        // the default
      }
      return this.notify(what);
    }
    if (url.pathname === '/socket') return this.socket(req);
    if (url.pathname === '/wait') {
      const raw = url.searchParams.get('since');
      const wait = Math.min(Math.max(Number(this.env.EVENTS_WAIT_MS) || WAIT_MS, 10), 25_000);
      // No `since` (a device just come): the current seq at once.
      return this.wait(raw === null || raw === '' ? NaN : Number(raw), wait, req.signal);
    }
    return json({ error: 'Not found.' }, 404);
  }

  // Hibernation handlers: messages other than the auto-answered "ping" are ignored.
  webSocketMessage() {}

  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  webSocketError() {}
}

/** Tells these accounts' devices that `what` ("invites" or "directory") changed. Never throws: a
 *  missed push only means the device's slow poll catches it. */
export async function tell(env, users, what) {
  const hub = env.ACCOUNT_HUB;
  if (!hub) return;
  const ids = [...new Set((users || []).filter((u) => typeof u === 'string' && u !== ''))].slice(0, 100);
  await Promise.all(
    ids.map((u) =>
      hub
        .get(hub.idFromName(u))
        .fetch('https://hub/notify', { method: 'POST', body: JSON.stringify({ what }) })
        .then((r) => r.body?.cancel?.())
        .catch(() => {}),
    ),
  );
}

/** `GET /v1/events` for the authenticated account `sub`: a WebSocket (PCs) or a long poll (phones). */
export function events(req, env, sub) {
  const hub = env.ACCOUNT_HUB;
  if (!hub) return json({ error: 'Not available.' }, 404);
  const stub = hub.get(hub.idFromName(sub));
  const url = new URL(req.url);
  if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') return stub.fetch('https://hub/socket', { headers: req.headers });
  const since = url.searchParams.get('since');
  return stub.fetch(`https://hub/wait${since === null || since === '' ? '' : `?since=${encodeURIComponent(since)}`}`, { signal: req.signal });
}
