// Types for ts/packages/net/test/accounthub.test.ts (the Worker itself is plain JavaScript).
export interface HubSocket {
  send(msg: string): void;
}

export interface HubCtx {
  storage: { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void> };
  getWebSockets(): HubSocket[];
  acceptWebSocket?(ws: unknown): void;
  setWebSocketAutoResponse?(pair: unknown): void;
}

export class AccountHub {
  constructor(ctx: HubCtx, env?: { EVENTS_WAIT_MS?: string });
  fetch(req: Request): Promise<Response>;
  notify(what: string): Promise<Response>;
  wait(since: number, waitMs: number, signal?: AbortSignal): Promise<Response>;
}

export interface HubNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> };
}

export function tell(env: { ACCOUNT_HUB?: HubNamespace }, users: string[], what: string): Promise<void>;
export function events(req: Request, env: { ACCOUNT_HUB?: HubNamespace }, sub: string): Promise<Response> | Response;
