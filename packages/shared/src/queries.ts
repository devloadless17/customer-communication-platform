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
  ContactFieldDefinition,
  MediaKind,
  MessageDirection,
  Role,
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
  whatsappConnected: boolean;
  whatsappDisplayNumber: string | null;
  userCount: number;
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
  /** Filter by 24h customer-service window: "open" = messaged us in the last
   *  24h; "closed" = no inbound, or last inbound > 24h ago. */
  window?: "open" | "closed";
  /** Filter to contacts currently parked in this stage. `"none"` matches
   *  contacts with no stage at all (orphaned after a stage delete). */
  stageId?: string | "none";
  cursor?: string | null;
  take?: number;
}

// ---------------------------------------------------------------------------
// WhatsApp settings — current Meta config view shipped to the admin
// pre-fill form. Plain values (decrypted server-side), display-only.
// ---------------------------------------------------------------------------

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
}

// Re-export commonly co-imported types so callers can grab everything from
// one path when they want to.
export type { ContactFieldDefinition };
