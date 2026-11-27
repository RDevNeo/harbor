// Hub's top-level tabs (Projects | Persons | Routine), engine side. Projects is the hub itself; every other tab is a
// TabEngine: its own storage under <data dir>/<id>/ and routes under `v1/<id>/…`, which hub.ts tries before the phone
// routes. The window (packages/ui/src/tabs, in-process through `call`) and Hub for Android (the same paths over the
// phone API) use the same routes, so a tab's data is shared by the PC and the phone.
import type { Store } from "../packages/store/src/index.ts";
import type { Call, NotePerson, Reply } from "../packages/net/src/index.ts";

export interface TabEngineCtx {
  store: Store;
  /** <data dir>/<tab id>, made before start. */
  dir: string;
  env: Record<string, string | undefined>;
  /** The tab's data changed: phones and the window hear of it (`GET /v1/events` → state_changed, `v1/tabs/<id>` rev). */
  changed(): void;
  log(line: string): void;
  /** One of the hub's own routes (`v1/chats`, `v1/chats/<id>/send` …), as a call from this PC. */
  call(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<Reply>;
  /** Hub's notification for something of this tab (kind = the tab's id, coalesced by `key`): this PC's popup when the
   *  window isn't in front, and the phones' note (Settings › Notifications turns the kind off). */
  notify?(key: string, title: string, body: string): void;
  /** A person wrote (Persons): the phones' conversation notification (kind "person"), never a desktop popup. */
  notePerson?(p: NotePerson): void;
  /** A person's messages were all read (here, on a phone, or by a reply): the phones' notification for them goes. */
  seenPerson?(id: string): void;
}

export interface TabEngine {
  /** "persons", "routine": its routes are `v1/<id>/…`. */
  id: string;
  start?(ctx: TabEngineCtx): void | Promise<void>;
  /** Null: not this tab's call. */
  route(call: Call): Promise<Reply | null>;
  stop?(): void | Promise<void>;
}
