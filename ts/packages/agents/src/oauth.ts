// Only the access token may leave this PC: the CLI rotates the refresh token on every refresh, so
// a copy used elsewhere would sign this PC out.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as creds from "./claudecreds.ts";
import { lockFile } from "./flock.ts";
import { at, compact, f64, obj, optStr, parse, pretty } from "./json.ts";
import { writePrivate } from "./paths.ts";

const SKEW_MS = 5 * 60 * 1000;
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URLS = ["https://platform.claude.com/v1/oauth/token", "https://api.anthropic.com/v1/oauth/token"];
const DEFAULT_EXPIRES_S = 28_800;

/** The credentials file of a Claude profile (null: the default, ~/.claude). */
export const credentialsPath = creds.credentialsPath;

/** Where a login is read from and written back to: Claude Code's store (claudecreds.ts), or one file (tests). */
interface Login {
  read(): string | null;
  write(text: string): void;
}

/** A failed refresh returns the stale token on purpose: the CLI then reports the error instead of the turn running as another account. */
export function token(configDir: string | null): string | null {
  const store: Login = { read: () => creds.read(configDir), write: (t) => creds.write(configDir, t) };
  return tokenOf(store, credentialsPath(configDir), Date.now(), requestRefresh);
}

export function tokenAt(path: string, nowMs: number, refresh: (rt: string) => unknown): string | null {
  const store: Login = {
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    write: (t) => write(path, t),
  };
  return tokenOf(store, path, nowMs, refresh);
}

function tokenOf(store: Login, path: string, nowMs: number, refresh: (rt: string) => unknown): string | null {
  const unlock = lock(path);
  try {
    const text = store.read();
    if (text === null) return null;
    const data = parse(text);
    if (data === undefined) return null;
    const login = at(data, "claudeAiOauth");
    const access = clean(optStr(at(login, "accessToken")));
    if (access === null) return null;
    const expires = epochMs(at(login, "expiresAt"));
    if (expires === 0 || expires - SKEW_MS > nowMs) return access;
    const rt = clean(optStr(at(login, "refreshToken")));
    if (rt === null) return access;
    const rtExpires = epochMs(at(login, "refreshTokenExpiresAt"));
    if (rtExpires > 0 && rtExpires <= nowMs) return access;
    const payload = refresh(rt);
    if (payload === null || payload === undefined) return access;
    const root = obj(data);
    if (!root) return access;
    const fresh = apply(root, payload, nowMs);
    if (fresh === null) return access;
    try {
      store.write(pretty(root) + "\n");
    } catch {
      // the new token works for this turn; the CLI refreshes again next time
    }
    return fresh;
  } finally {
    unlock?.();
  }
}

/** A token as the CLI wrote it: one line, nothing a shell `read` would cut; null otherwise. */
function clean(s: string | undefined): string | null {
  if (s === undefined) return null;
  const t = s.trim();
  return t !== "" && !/[\s\p{Cc}]/u.test(t) ? t : null;
}

/** A time in the file as ms since the epoch; seconds are taken as such (0: none). */
export function epochMs(v: unknown): number {
  let n = f64(v);
  if (n === undefined && typeof v === "string") {
    const p = Number(v.trim());
    n = v.trim() !== "" && Number.isFinite(p) ? p : undefined;
  }
  const x = n ?? 0;
  if (x <= 0) return 0;
  return Math.trunc(x < 1e12 ? x * 1000 : x);
}

/** Puts a refresh answer into the credentials; returns the new access token, null for an answer without one. */
export function apply(data: Record<string, unknown>, payload: unknown, nowMs: number): string | null {
  const access = clean(optStr(at(payload, "access_token")));
  if (access === null) return null;
  const ei = f64(at(payload, "expires_in"));
  const expiresIn = ei !== undefined && ei > 0 ? Math.trunc(ei) : DEFAULT_EXPIRES_S;
  let login = obj(data.claudeAiOauth);
  if (!login) {
    login = {};
    data.claudeAiOauth = login;
  }
  login.accessToken = access;
  const rt = clean(optStr(at(payload, "refresh_token")));
  if (rt !== null) login.refreshToken = rt;
  login.expiresAt = nowMs + expiresIn * 1000;
  const rte = f64(at(payload, "refresh_token_expires_in"));
  if (rte !== undefined && rte > 0) login.refreshTokenExpiresAt = nowMs + Math.trunc(rte) * 1000;
  return access;
}

function write(path: string, text: string): void {
  writePrivate(path, text);
}

function lock(path: string): (() => void) | null {
  return lockFile(join(dirname(path), ".credentials.json.lock"));
}

/** A guest chat's login for the commands it runs: Claude Code keeps `CLAUDE_CODE_OAUTH_TOKEN` from them. */
export function lend(overlay: string, configDir: string | null, tok: string): void {
  // No login for the account here: the lent login has only the token.
  const text = creds.read(configDir);
  const src: unknown = text === null ? undefined : parse(text);
  const from = at(src, "claudeAiOauth");
  const login: Record<string, unknown> = { accessToken: tok, scopes: ["user:inference"] };
  if (optStr(at(from, "accessToken")) === tok) {
    for (const k of ["expiresAt", "scopes", "subscriptionType", "rateLimitTier"]) {
      const v = at(from, k);
      if (v !== null) login[k] = v;
    }
  }
  const unlock = lock(credentialsPath(overlay));
  try {
    creds.write(overlay, pretty({ claudeAiOauth: login }) + "\n");
  } finally {
    unlock?.();
  }
}

export function unlend(overlay: string): void {
  const unlock = lock(credentialsPath(overlay));
  try {
    creds.remove(overlay);
  } catch {
    // never lent
  } finally {
    unlock?.();
  }
}

/** Exchanges a refresh token through `curl`; the body goes on stdin, since a token on a command line shows in `ps`. */
function requestRefresh(refreshToken: string): unknown {
  const body = compact({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID });
  for (const url of TOKEN_URLS) {
    let r;
    try {
      r = Bun.spawnSync(
        ["curl", "-fsS", "--connect-timeout", "5", "--max-time", "15", "-X", "POST", "-H", "Content-Type: application/json", "-H", "Accept: application/json", "-A", "claude-code/2.1.0", "--data-binary", "@-", url],
        { stdin: new TextEncoder().encode(body), stdout: "pipe", stderr: "ignore" },
      );
    } catch {
      return null;
    }
    if (!r.success) continue;
    const v = parse(r.stdout.toString());
    if (clean(optStr(at(v, "access_token"))) !== null) return v;
  }
  return null;
}
