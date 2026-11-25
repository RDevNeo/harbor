// One connection = one account on one platform in one section (Person Hub's DiscordBridge, shell/main.cjs
// "ch:conn" calls). Discord, Gmail and WhatsApp all implement it; the service (../service.ts) owns them.
// Tokens and keys stay inside the implementation: nothing here returns them, and nothing may log them.
import type { ChannelKind, ChannelUser, ConnEvent, ConnState, Conversation, LookupResult, OutgoingFile, SectionId, SendResult } from "../model/types.ts";

export interface ConnMeta {
  /** "stores", "spokpay", "creators-gmail-8ce5c1"… (Person Hub's ids, kept by the migration). */
  id: string;
  kind: ChannelKind;
  section: SectionId;
}

export interface ConnContext extends ConnMeta {
  /** ~/.local/share/hub/persons: caches and account files live here (each implementation names its own). */
  dir: string;
  /** Events for the service (it adds the connection id). */
  emit: (ev: ConnEvent) => void;
  /** One line to persons.log. Never pass tokens, headers or message bodies. */
  log: (...a: unknown[]) => void;
  /** Opens a URL in the user's browser (Google sign-in). */
  openExternal: (url: string) => void;
}

export interface Connection extends ConnMeta {
  state(): ConnState;
  /** Starts (or resumes) the session from what's on disk; never opens a sign-in by itself. */
  start(): Promise<void>;
  /** Sign in (Discord and WhatsApp: a QR code in the state; Gmail: Google's page in the user's own browser). */
  connect(): Promise<ConnState>;
  /** Stops a sign-in under way (Discord's QR code); the account stays as it was before it. */
  cancelSignIn?(): void;
  /** Signs out and forgets the session. */
  disconnect(): Promise<ConnState>;
  /** Gmail: sign in again for more scopes. Others: same as connect. */
  reconnect?(): Promise<ConnState>;
  /** The identifiers of the people in the app (live updates and presence are kept for these). Returns cached conversations. */
  track(peers: string[]): Promise<Record<string, Conversation>>;
  lookup(query: string): Promise<LookupResult>;
  user(id: string): Promise<ChannelUser | null>;
  /** Newest page, or the page before message `before`. */
  history(peer: string, before?: string): Promise<Conversation>;
  /** `subject`: Gmail, starts a new thread. */
  send(peer: string, text: string, files?: OutgoingFile[], replyTo?: string, subject?: string): Promise<SendResult>;
  /** Downloads an attachment into the cache; returns the local file path. */
  fetchAttachment?(url: string, name: string): Promise<string>;
  markRead?(peer: string): Promise<unknown>;
  markUnread?(peer: string, messageId: string): Promise<unknown>;
  typing?(peer: string, on: boolean): Promise<unknown>;
  /** Follow their typing / presence closely while their chat is open. */
  watch?(peer: string): Promise<unknown>;
  /** WhatsApp: save the number in the address book. */
  saveContact?(peer: string, name: string): Promise<{ ok: boolean; saved?: boolean; already?: boolean; error?: string }>;
  /** WhatsApp profile photo of a number, as a local file path (cached daily), or null. */
  photo?(peer: string): Promise<string | null>;
  /** Stops timers, sockets and child processes (Hub quitting). */
  stop(): Promise<void>;
}

export type ConnFactory = (ctx: ConnContext) => Connection;
