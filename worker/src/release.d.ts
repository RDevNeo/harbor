export function parseVersion(v: string): [number, number, number, number] | null;
export function newer(candidate: string, current: string): boolean;
export function tagFrom(location: string | null): string | null;

export interface Storage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(at: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}

export interface ReleaseEnv {
  RELEASE_REPO?: string;
  RELEASE_ORIGIN?: string;
  RELEASE_WAIT_MS?: string;
  RELEASES?: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> } };
}

export class ReleaseHub {
  constructor(state: { storage: Storage }, env?: ReleaseEnv);
  version: string | null | undefined;
  waiters: Set<unknown>;
  readAt: number;
  hint: string | null;
  refresh(force: boolean, hint?: string | null): Promise<string | null>;
  alarm(): Promise<void>;
  wait(have: string | null, signal?: AbortSignal): Promise<Response>;
  answer(): Response;
  fetch(request: Request): Promise<Response>;
}

export function releasePing(req: Request, env: ReleaseEnv): Promise<Response>;
export function releaseWait(req: Request, env: ReleaseEnv): Promise<Response>;
