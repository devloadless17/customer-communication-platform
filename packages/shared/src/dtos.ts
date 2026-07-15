/**
 * DTOs returned by the read-side queries that span the apps/web ↔ apps/api
 * package boundary. These started life inside `apps/api/src/lib/queries/*` —
 * they're hoisted here so apps/web client components + the post-Step-7b
 * HTTP-driven RSC pages can name the shape without reaching across the
 * monorepo via a tsconfig shim.
 *
 * Pure types only — no runtime, no DB access, no `server-only` guard. The
 * query files in apps/api re-export from here so the wire-shape stays
 * single-sourced.
 */

import type {
  Channel,
  ContactFieldDefinition,
  MediaKind,
  MessageDirection,
  Role,
  TeamStatus,
} from "./types";

// ---------------------------------------------------------------------------
// Audience groups — saved named lists used by broadcasts.
// ---------------------------------------------------------------------------

export interface AudienceGroupDto {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  tagIds: string[];
  contactIds: string[];
  /** Computed member count at read time. */
  memberCount: number;
  /** Null when the creator was hard-deleted; UI shows "Removed user". */
  createdById: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Super-admin: cross-team browse. Aggregates only — superAdmin visibility
// never crosses into customer message bodies (see the query file's note).
// ---------------------------------------------------------------------------

export interface SuperAdminTeamRow {
  id: string;
  name: string;
  createdAt: string;
  /** Org-approval lifecycle — drives the approve/suspend controls + the
   *  pending-review queue on the platform Organizations page. */
  status: TeamStatus;
  /** Operator note attached on suspension (or rejection). Null while active. */
  statusReason: string | null;
  /** When the status was last changed by a super-admin. Null if never. */
  statusUpdatedAt: string | null;
  whatsappConnected: boolean;
  whatsappDisplayNumber: string | null;
  userCount: number;
  /** Hard cap on ACTIVE member accounts. Default 2; only a superAdmin raises it. */
  maxMembers: number;
  contactCount: number;
  conversationCount: number;
  messageCount: number;
  broadcastCount: number;
}

export interface SuperAdminTeamDetail {
  team: SuperAdminTeamRow;
  members: Array<{
    id: string;
    name: string;
    email: string;
    role: Role;
    deactivatedAt: string | null;
    createdAt: string;
  }>;
}

// ---------------------------------------------------------------------------
// Platform analytics — super-admin overview. Cross-team aggregates only.
// ---------------------------------------------------------------------------

export interface PlatformAnalytics {
  orgs: {
    total: number;
    pending: number;
    active: number;
    suspended: number;
  };
  totals: {
    users: number;
    contacts: number;
    conversations: number;
    messages: number;
    broadcasts: number;
  };
  /** Orgs created in the trailing 30 days (signup momentum). */
  newOrgsLast30d: number;
  /** The current approval queue — newest first, capped for the overview card. */
  pendingOrgs: Array<{ id: string; name: string; createdAt: string }>;
}

// ---------------------------------------------------------------------------
// In-conversation message search.
// ---------------------------------------------------------------------------

export interface MessageSearchHit {
  id: string;
  body: string;
  direction: MessageDirection;
  timestamp: string;
  /** Authoring teammate's name on outbound, null on inbound. */
  senderName: string | null;
  /** mediaCaption when this is a media message, undefined otherwise. */
  mediaCaption?: string;
  mediaKind?: MediaKind;
}

export interface MessageSearchPage {
  items: MessageSearchHit[];
  nextCursor: string | null;
  totalMatched: number;
}

// ---------------------------------------------------------------------------
// Global inbox search (the tabbed search bar over the conversation list).
// Three scopes — contacts / messages / notes — each ILIKE-matched team-wide
// (NOT scoped to one conversation, unlike MessageSearchHit above). Every hit
// carries enough context to render a row AND to open the right conversation:
// `conversationId` is what the inbox opens, plus a `messageId` on message/note
// hits so the thread can jump straight to the match.
// ---------------------------------------------------------------------------

export type InboxSearchScope = "contacts" | "messages" | "notes";

/** A contact match — opens that contact's conversation (one-per-contact). */
/** One channel a person is reachable on — for the search row's badge cluster. */
export interface ContactSearchChannel {
  contactId: string;
  channel: Channel;
  /** Null when that channel-contact has never had a conversation. */
  conversationId: string | null;
}

export interface ContactSearchHit {
  contactId: string;
  /** Null when the contact has never had a conversation (manually added,
   *  never messaged). The UI renders these as "start a chat" rather than
   *  "open thread". */
  conversationId: string | null;
  name: string;
  phoneNumber: string | null;
  /** The channel this contact identity lives on — drives the row's channel
   *  badge so a WhatsApp vs Messenger vs Instagram result is distinguishable. */
  channel: Channel;
  /**
   * Every channel the SAME PERSON (unified Customer) is reachable on, including
   * the matched one — so a person who has chatted on WhatsApp + Messenger + IG
   * appears ONCE with a badge cluster you can click to jump to any channel's
   * thread, instead of as N duplicate rows. Length ≥ 1 (the matched contact).
   */
  channels: ContactSearchChannel[];
  avatarUrl?: string;
  /** Which field actually matched, so the row can show the matched value
   *  (e.g. an email hit shows the email, not just the name). */
  matchedField: "name" | "phone" | "email";
  /** The value of the matched field, for the snippet line. */
  matchedValue: string;
}

/** A message match anywhere in the team — opens its conversation + jumps. */
export interface GlobalMessageHit {
  messageId: string;
  conversationId: string;
  /** Contact name on the conversation, for the row header. */
  contactName: string;
  contactAvatarUrl?: string;
  /** The matched message `body`, trimmed for display. Media captions are
   *  copied into `body` at every write site, so a single `body` snippet
   *  always carries the matched text (see global-search.ts searchAllMessages). */
  snippet: string;
  direction: MessageDirection;
  timestamp: string;
  mediaKind?: MediaKind;
}

/** An internal-note match — opens the conversation it's attached to. */
export interface NoteSearchHit {
  noteId: string;
  conversationId: string;
  contactName: string;
  contactAvatarUrl?: string;
  /** The note author's name, null when the author was removed. */
  authorName: string | null;
  snippet: string;
  timestamp: string;
}

export interface ContactSearchPage {
  items: ContactSearchHit[];
  nextCursor: string | null;
}
export interface GlobalMessageSearchPage {
  items: GlobalMessageHit[];
  nextCursor: string | null;
}
export interface NoteSearchPage {
  items: NoteSearchHit[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Contacts list — request-side options. Response shape is `CursorPage<ContactListItem>`
// from ./types (already there).
// ---------------------------------------------------------------------------

export interface ListContactsOpts {
  /** Free-text search across name, phone, email, and customField values. */
  search?: string;
  /** Filter rows where customFields[key] matches value (case-insensitive contains). */
  fieldFilter?: { key: string; value: string };
  /** Filter by how the contact got into the DB. */
  source?: "inbound" | "manual";
  /** Keep only contacts carrying ANY of these tag ids (union, like audience groups). */
  tagIds?: string[];
  /** Filter to one channel identity (whatsapp / messenger / instagram). */
  channel?: Channel;
  /** Roll the list up to one row per unified PERSON (a `Customer`, or a solo
   *  contact as its own person) instead of one row per channel-contact — the
   *  contacts-page "Group by person" view. Runs in offset/page mode; the
   *  channel filter is ignored (a person spans channels). */
  groupByPerson?: boolean;
  /** Filter by 24h customer-service window: "open" = messaged us in the last
   *  24h; "closed" = no inbound, or last inbound > 24h ago. */
  window?: "open" | "closed";
  /** Filter to contacts currently parked in this stage. `"none"` matches
   *  contacts with no stage at all (orphaned after a stage delete). */
  stageId?: string | "none";
  cursor?: string | null;
  take?: number;
  /** 1-based page for numbered (offset) pagination. When set, the query runs
   *  in offset mode: `cursor` is ignored, `totalCount` is always returned, and
   *  `nextCursor` is null. Omit for the legacy keyset/infinite-scroll mode. */
  page?: number;
}

// ---------------------------------------------------------------------------
// WhatsApp settings — current Meta config view shipped to the admin
// pre-fill form. Plain values (decrypted server-side), display-only.
// ---------------------------------------------------------------------------

/**
 * Channel-member row for the members panel. Mirrors the underlying
 * `TeamChannelMember` join with the user fields denormalized so the panel
 * can render without a second round-trip.
 */
export interface ChannelMemberDto {
  channelId: string;
  userId: string;
  name: string;
  email: string;
  role: import("./types").Role;
  avatarUrl: string | null;
  /** ISO. Useful sorting in the list ("most-recently-added first"). */
  addedAt: string;
  /** Null when the adding admin has been removed (FK SetNull). */
  addedById: string | null;
  /** True when the row represents the current viewer, so the UI can render
   *  a "Leave" affordance instead of "Remove" + treat it specially. */
  isSelf: boolean;
}

export interface WhatsappConfigView {
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  wabaId: string | null;
  appId: string | null;
  verifyToken: string | null;
  /** Decrypted plaintext — wire path is server→browser only, never client→server. */
  accessToken: string | null;
  appSecret: string | null;
  /** True when secrets are present in the DB but decrypt failed (key rotated,
   *  envelope corrupt). Page surfaces this so admin can re-paste. */
  credentialsUndecryptable: boolean;
  /** True when a send failed with Graph 190 (token expired/revoked) — drives the
   *  Settings "reconnect" banner, consistent with Messenger/Instagram. */
  needsReconnect: boolean;
  /** WhatsApp messaging-limit tier (e.g. "TIER_10K") — how many unique customers
   *  the number may message per 24h. Null when not yet known. Drives the composer
   *  "remaining daily allowance" hint + Settings health row. */
  messagingTier: string | null;
  /** Derived numeric 24h unique-recipient cap for the tier (null = unlimited/unknown). */
  messagingDailyCap: number | null;
  /** Quality band: "GREEN" | "YELLOW" | "RED" | null. */
  qualityRating: string | null;
  /** Throughput level: "STANDARD" | "HIGH" | null. */
  throughputLevel: string | null;
}

// Re-export commonly co-imported types so callers can grab everything from
// one path when they want to.
export type { ContactFieldDefinition };
