import "server-only";

import type {
  Contact as DbContact,
  Conversation as DbConversation,
  Message as DbMessage,
} from "@prisma/client";

/**
 * Wire shapes the external API (/api/external/v1) returns. Stable contract
 * for n8n / partner integrations — once consumers start parsing these, the
 * shapes are versioned.
 *
 * They're slightly different from the internal `lib/types.ts` shapes:
 *   - No `rawPayload` (huge JSON, not useful to integrators)
 *   - No optimistic-UI fields (`pending`, `failed`, `clientTempId`)
 *   - All timestamps are ISO strings, never Date — JSON-stable
 */

export interface ExternalContact {
  id: string;
  phoneNumber: string;
  name: string;
  email: string | null;
  customFields: Record<string, string>;
  createdAt: string;
}

export interface ExternalConversation {
  id: string;
  contactId: string;
  status: "open" | "pending" | "closed";
  assignedUserId: string | null;
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string;
}

export interface ExternalMessage {
  id: string;
  conversationId: string;
  externalId: string;
  direction: "in" | "out";
  body: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  senderUserId: string | null;
  mediaKind: string | null;
  mediaCaption: string | null;
}

export function toExternalContact(c: DbContact): ExternalContact {
  return {
    id: c.id,
    phoneNumber: c.phoneNumber,
    name: c.name,
    email: c.email ?? null,
    customFields: normalizeCustomFields(c.customFields),
    createdAt: c.createdAt.toISOString(),
  };
}

export function toExternalConversation(c: DbConversation): ExternalConversation {
  return {
    id: c.id,
    contactId: c.contactId,
    status: c.status as ExternalConversation["status"],
    assignedUserId: c.assignedUserId,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastMessagePreview: c.lastMessagePreview,
  };
}

export function toExternalMessage(m: DbMessage): ExternalMessage {
  return {
    id: m.id,
    conversationId: m.conversationId,
    externalId: m.externalId,
    direction: m.direction as ExternalMessage["direction"],
    body: m.body,
    status: m.status as ExternalMessage["status"],
    timestamp: m.timestamp.toISOString(),
    senderUserId: m.senderUserId,
    mediaKind: m.mediaKind,
    mediaCaption: m.mediaCaption,
  };
}

function normalizeCustomFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
