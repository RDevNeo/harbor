// Ported from creators-hub/src/lib/types.ts (Person Hub). Same JSON schema (data.json version 7), so the
// migrated file loads unchanged and Person Hub could still read a copy back.

/** data.json: version 7 (see data.ts normalizeData for the history). */
export const DATA_VERSION = 7;

export type SectionId = "stores" | "creators" | "spokpay" | "neobux" | "personal";
export type ChannelKind = "discord" | "gmail" | "whatsapp" | "instagram";

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
  /** Instagram user id (the app API's pk, digits) and the username it was added by. */
  instagram?: string;
  instagramUsername?: string;
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
  /** Sections they were moved out of (Move to…): those sections' chats with them still show, and can be sent on. */
  carried?: SectionId[];
  /** People linked into this one (Link with…): the same human on other channels. Unlink brings each back. */
  links?: PersonLink[];
  createdAt: string;
  updatedAt: string;
}

/** One person linked into another (model/link.ts): who they were, and what the link gave the person they joined. */
export interface PersonLink {
  /** The person as they were just before Link (same id, identities, notes, read state; their own links inside). */
  person: Person;
  /** When they were linked. */
  at: string;
  /** What Link added to the person they joined: Unlink takes back what is still the same. */
  added: LinkAdded;
}

export interface LinkAdded {
  /** Their identifiers and profile fields copied into empty ones (name → value as copied). */
  fields: Record<string, string | boolean | null>;
  identities: Identity[];
  storeIds: string[];
  listIds: string[];
  socials: string[];
  /** The text their notes added (appended under the person's own). */
  notes: string;
  /** Stores they owned, now owned by the person they joined. */
  owned: string[];
  /** Sections where the person was settled and the link made them active (they weren't): settled again by Unlink. */
  unsettled?: Record<string, string>;
}

export interface Identity {
  kind: ChannelKind;
  /** Discord id, email address, WhatsApp number (digits) or Instagram user id. */
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
  accountId: "stores" | "spokpay" | "gmail" | "personal";
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
  /** Discord: forwarded from another chat (content and files are the forwarded message's). */
  forwarded?: boolean;
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

/** Discord: where the account stands with someone (no entry = none). `sent`: our friend request waits; `incoming`: theirs. */
export type Relation = "friend" | "sent" | "incoming" | "blocked";

export type ConnEvent =
  | { type: "state"; state: ConnState }
  | { type: "messages"; peerId: string; messages: Message[] }
  | { type: "delete"; peerId: string; messageId: string }
  | { type: "users"; users: ChannelUser[] }
  | { type: "presence"; presence: Record<string, PresenceStatus | null>; lastSeen?: Record<string, number> }
  | { type: "typing"; peerId: string; kind: "typing" | "recording"; until: number }
  /** Discord relationships: `all` replaces every one (a new session), else only these change (null = none now). */
  | { type: "relations"; relations: Record<string, Relation | null>; all?: boolean };

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
  /** Discord's captcha: the path to open in Discord's app ("/channels/@me/<id>" or "/users/<id>"), where it's sent instead. */
  open?: string;
}

/** Add friend (Discord): where it stands after; `open` = Discord asked for a captcha, their profile to open in its app. */
export interface FriendResult {
  ok: boolean;
  relation?: Relation;
  error?: string;
  open?: string;
}
