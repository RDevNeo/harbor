// Ported from creators-hub/src/lib/types.ts (Person Hub). Same JSON schema (data.json version 7), so the
// migrated file loads unchanged and Person Hub could still read a copy back.

/** data.json: version 7 (see data.ts normalizeData for the history). */
export const DATA_VERSION = 7;

export type SectionId = "stores" | "creators" | "spokpay";
export type ChannelKind = "discord" | "gmail" | "whatsapp";

export interface Person {
  id: string;
  /** Name shown in the app (defaults to the Discord display name). */
  name: string;
  /** Discord user id ('' while only a username is known). */
  discordId: string;
  discordUsername?: string;
  email?: string;
  /** WhatsApp number: digits with the country code. */
  whatsapp?: string;
  /** More identities, each used in one section instead of the defaults above. */
  identities?: Identity[];
  /** Read state: per "<connection id>:<identifier>", the time of the newest message seen. */
  seen?: Record<string, string>;
  /** Settled per section: when. A newer message in that section unsettles them. */
  settled?: Record<string, string>;
  displayName?: string;
  /** Discord avatar hash (null = default avatar). */
  avatar?: string | null;
  profileAt?: string;
  /** Google contact photo (or Gravatar). */
  photo?: string;
  photoAt?: string;
  photoFull?: boolean;
  /** YouTube / TikTok profile picture. */
  socialPhoto?: string;
  socialPhotoAt?: string;
  socialPhotoOf?: string;
  storeIds: string[];
  listIds: string[];
  notes?: string;
  /** Social profile URLs (TikTok, Instagram, YouTube), canonical. */
  socials?: string[];
  /** Kept from version 1 (no longer shown). */
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Identity {
  kind: ChannelKind;
  /** Discord id, email address, or WhatsApp number (digits). */
  value: string;
  section: SectionId;
  username?: string;
  displayName?: string;
  avatar?: string | null;
  profileAt?: string;
}

export interface Store {
  id: string;
  name: string;
  color?: string;
  /** Person id of the store's owner. */
  ownerId?: string;
  /** Picture file in <persons dir>/images. */
  image?: string;
}

export interface PersonList {
  id: string;
  name: string;
  accountId: "stores" | "spokpay" | "gmail";
}

export interface AppData {
  version: number;
  people: Person[];
  stores: Store[];
  lists: PersonList[];
  /** When read state started: older messages count as read unless the platform says they're unread. */
  readSince?: string;
  legacy?: Record<string, unknown>;
  updatedAt: string;
}

// ---------- channels (one shape for Discord, Gmail and WhatsApp) ----------

export interface ChannelUser {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  discriminator?: string;
  bot?: boolean;
  /** https URL (Discord CDN, Google photo…) or "" */
  avatarUrl: string;
}

export interface Attachment {
  name: string;
  url: string;
  type?: string;
  size?: number;
  width?: number;
  height?: number;
  proxyUrl?: string;
  /** Seconds (voice messages). */
  duration?: number;
  /** Discord's voice waveform (base64). */
  waveform?: string;
}

export interface ReplyRef {
  id: string;
  authorId?: string;
  fromMe?: boolean;
  content?: string;
  attachments?: number;
  attachment?: Attachment;
  voice?: boolean;
  deleted?: boolean;
}

export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "error";

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  fromMe: boolean;
  content: string;
  /** ISO time. */
  timestamp: string;
  edited?: boolean;
  attachments?: Attachment[];
  embed?: boolean;
  voice?: boolean;
  /** Unread on the platform when last fetched. */
  unread?: boolean;
  /** Email only. */
  threadId?: string;
  subject?: string;
  reply?: ReplyRef;
  /** WhatsApp, own messages: ticks. */
  status?: MessageStatus;
}

export interface OutgoingFile {
  name: string;
  type: string;
  data: Uint8Array;
  voice?: { duration: number; waveform: string };
}

export interface Conversation {
  channelId: string | null;
  messages: Message[];
}

export type ConnStatus = "starting" | "signed-out" | "signing-in" | "connecting" | "connected";

export interface ConnState {
  status: ConnStatus;
  me: ChannelUser | null;
  gateway: "up" | "down";
  error?: string | null;
  /** WhatsApp, while linking: the QR payload to draw (the raw string, not an image). */
  qr?: string | null;
  /** Gmail: contacts granted; upgrading = the reconnect sign-in is open. */
  contacts?: boolean;
  upgrading?: boolean;
}

export type PresenceStatus = "online" | "idle" | "dnd" | "offline" | "invisible";

export type ConnEvent =
  | { type: "state"; state: ConnState }
  | { type: "messages"; peerId: string; messages: Message[] }
  | { type: "delete"; peerId: string; messageId: string }
  | { type: "users"; users: ChannelUser[] }
  | { type: "presence"; presence: Record<string, PresenceStatus | null>; lastSeen?: Record<string, number> }
  | { type: "typing"; peerId: string; kind: "typing" | "recording"; until: number };

export interface LookupResult {
  matches: ChannelUser[];
  notFound?: boolean;
  contacts?: boolean;
  searched?: boolean;
  notes?: string[];
  searchedServers?: boolean;
  saved?: boolean;
}

export interface SendResult {
  ok: boolean;
  message?: Message;
  error?: string;
}
