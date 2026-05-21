/**
 * Public event allowlist + payload shapes for outbound webhooks.
 *
 * Two reasons this lives in `packages/shared`:
 *   - The list is the **contract** with partners. We need to be able to
 *     enumerate it for the docs page AND for the create-webhook UI's
 *     multi-select.
 *   - The mapping logic (internal DomainEvent → public shape) must be
 *     reachable from both the subscriber (api) and any future test
 *     harness, so framework-agnostic is the right home.
 *
 * Why an allowlist and not "publish every DomainEvent":
 *   Internal events carry implementation details (workflowContact
 *   snapshots, suppressSocketFanout flags, full rawPayload JSONB). Leaking
 *   that to partner integrations is both a privacy concern and a
 *   compatibility tarpit — every internal refactor would break their
 *   parsers. The public shape is intentionally narrow.
 *
 * Envelope is **snake_case throughout** to match respond.io / Stripe /
 * GitHub webhook conventions — n8n users come over with snake_case
 * muscle memory and our delivery payloads should not surprise them.
 *
 * `sender` and `assignee` are structured `{ type, id, ... }` objects on
 * purpose: when AI agents start authoring messages and being assigned to
 * contacts/conversations, the type discriminator gains `"ai_agent"` and
 * existing n8n flows don't break.
 */

import type {
  ContactCreatedEvent,
  ContactLifecycleChangedEvent,
  ContactTagChangedEvent,
  ContactUpdatedEvent,
  ContactDeletedEvent,
  ConversationAssignedEvent,
  ConversationStatusChangedEvent,
  DomainEvent,
  DomainEventType,
  MessageReceivedEvent,
  MessageSentEvent,
  MessageStatusChangedEvent,
  NoteCreatedEvent,
} from "../events/types";
import { publicChannel } from "../channel";

/**
 * Stable identifiers partners subscribe to. Must NOT change once shipped —
 * adding new ones is fine; renaming or removing breaks live integrations.
 */
export const PUBLIC_EVENT_TYPES = [
  "message.received",
  "message.sent",
  "message.status_changed",
  "conversation.assigned",
  "conversation.status_changed",
  // Filtered synthetics fired from `conversation.status_changed`. Receivers
  // subscribing to `conversation.opened` see ONLY transitions into `open`;
  // `conversation.closed` ONLY transitions into `closed`. Matches respond.io's
  // "On Conversation opened" / "On Conversation closed" trigger UX — without
  // this, partners would have to filter status in their own flow.
  "conversation.opened",
  "conversation.closed",
  "contact.created",
  "contact.updated",
  "contact.tag_changed",
  "contact.lifecycle_changed",
  "contact.deleted",
  "note.created",
] as const;
export type PublicEventType = (typeof PUBLIC_EVENT_TYPES)[number];

export function isPublicEventType(s: string): s is PublicEventType {
  return (PUBLIC_EVENT_TYPES as readonly string[]).includes(s);
}

/**
 * Compact JSON example used by the docs page + create-webhook UI to show
 * receivers what they'll need to parse. Real envelopes carry the wrapper
 * fields (`event_id`, `event_type`, `occurred_at`, `team_id`, `channel`) —
 * see `PublicEnvelope` — so each sample below shows only `data`. Strings
 * use the `cmp…` placeholder convention so partners don't paste fake-looking
 * ids into their workflows.
 */
type SampleData = Record<string, unknown>;

/** Human-friendly grouping for the create-webhook UI multiselect. */
export const PUBLIC_EVENT_GROUPS: Array<{
  group: string;
  events: { type: PublicEventType; label: string; description: string; samplePayload: SampleData }[];
}> = [
  {
    group: "Messages",
    events: [
      {
        type: "message.received",
        label: "On Message received",
        description: "Fires when a contact sends a WhatsApp message (text or file).",
        samplePayload: {
          message: {
            id: "cmpmsg_01",
            conversation_id: "cmpconv_01",
            contact_id: "cmpcnt_01",
            channel: "whatsapp",
            direction: "in",
            body: "",
            timestamp: "2026-05-20T11:00:00.000Z",
            status: "sent",
            sender: { type: "contact", id: null, name: null },
            sender_api_key_id: null,
            // File messages carry the full attachment block — `url` is a
            // directly-downloadable CDN link (no session auth). null for text.
            media: {
              kind: "image",
              url: "https://cdn.example.com/media/cmpmsg_01.jpg",
              mime_type: "image/jpeg",
              filename: "receipt.jpg",
              size_bytes: 184320,
              duration_ms: null,
              thumbnail_url: "https://cdn.example.com/media/cmpmsg_01_thumb.jpg",
              caption: "Here's the receipt",
            },
          },
          contact: {
            id: "cmpcnt_01",
            phone_number: "+15555550100",
            name: "Jane Doe",
            first_name: "Jane",
            last_name: "Doe",
            language: "en",
            country_code: "US",
            avatar_url: null,
            email: null,
            location: null,
            stage_id: "cmpstg_01",
            tag_ids: [],
            assignee: null,
            custom_fields: {},
            created_at: "2026-05-19T08:30:00.000Z",
          },
          conversation: {
            id: "cmpconv_01",
            contact_id: "cmpcnt_01",
            status: "open",
            unread_count: 1,
            last_message_at: "2026-05-20T11:00:00.000Z",
            assignee: null,
          },
          is_new_conversation: false,
          reopened: false,
        },
      },
      {
        type: "message.sent",
        label: "On Message sent",
        description: "Fires when an agent or API sends a message. Carries the same contact + conversation + assignee context as `message.received`.",
        samplePayload: {
          message: {
            id: "cmpmsg_02",
            conversation_id: "cmpconv_01",
            contact_id: "cmpcnt_01",
            channel: "whatsapp",
            direction: "out",
            body: "Yes! Open until 8pm.",
            timestamp: "2026-05-20T11:00:05.000Z",
            status: "sent",
            // `sender.name` is the agent who sent it — hydrated from the user row.
            sender: { type: "user", id: "cmpusr_01", name: "Ali" },
            sender_api_key_id: null,
            media: null,
          },
          contact: {
            id: "cmpcnt_01",
            phone_number: "+15555550100",
            name: "Jane Doe",
            first_name: "Jane",
            last_name: "Doe",
            language: "en",
            country_code: "US",
            avatar_url: null,
            email: null,
            location: null,
            stage_id: "cmpstg_01",
            tag_ids: [],
            custom_fields: {},
            created_at: "2026-05-19T08:30:00.000Z",
          },
          conversation: {
            id: "cmpconv_01",
            contact_id: "cmpcnt_01",
            status: "open",
            unread_count: 0,
            last_message_at: "2026-05-20T11:00:05.000Z",
            assignee: { type: "user", id: "cmpusr_01", name: "Ali", email: "ali@example.com" },
          },
        },
      },
      {
        type: "message.status_changed",
        label: "Delivery status changed",
        description: "Sent / delivered / read receipts from WhatsApp.",
        samplePayload: {
          message_id: "cmpmsg_02",
          conversation_id: "cmpconv_01",
          contact_id: "cmpcnt_01",
          status: "delivered",
        },
      },
    ],
  },
  {
    group: "Conversations",
    events: [
      {
        type: "conversation.assigned",
        label: "On Conversation assignee updated",
        description: "Conversation reassigned to a new (or no) user.",
        samplePayload: {
          conversation_id: "cmpconv_01",
          contact_id: "cmpcnt_01",
          previous_assignee: null,
          assignee: { type: "user", id: "cmpusr_01", name: "Ali", email: "ali@example.com" },
          changed_by_user_id: "cmpusr_02",
          changed_by_api_key_id: null,
        },
      },
      {
        type: "conversation.opened",
        label: "On Conversation opened",
        description: "Conversation transitioned to `open` (new thread or reopen).",
        samplePayload: {
          conversation_id: "cmpconv_01",
          contact_id: "cmpcnt_01",
          previous_status: "pending",
          status: "open",
          changed_by_user_id: "cmpusr_01",
          changed_by_api_key_id: null,
          closed_category: null,
          closed_summary: null,
        },
      },
      {
        type: "conversation.closed",
        label: "On Conversation closed",
        description: "Conversation transitioned to `closed`.",
        samplePayload: {
          conversation_id: "cmpconv_01",
          contact_id: "cmpcnt_01",
          previous_status: "open",
          status: "closed",
          changed_by_user_id: "cmpusr_01",
          changed_by_api_key_id: null,
          closed_category: "resolved",
          closed_summary: "Customer's question answered.",
        },
      },
      {
        type: "conversation.status_changed",
        label: "Conversation status changed (any)",
        description: "Raw status transitions — open / pending / closed. Subscribe to this OR to opened/closed, not both.",
        samplePayload: {
          conversation_id: "cmpconv_01",
          contact_id: "cmpcnt_01",
          previous_status: "open",
          status: "pending",
          changed_by_user_id: null,
          changed_by_api_key_id: null,
          closed_category: null,
          closed_summary: null,
        },
      },
    ],
  },
  {
    group: "Contacts",
    events: [
      {
        type: "contact.created",
        label: "On Contact created",
        description: "A new contact row landed (inbound or API).",
        samplePayload: {
          contact: {
            id: "cmpcnt_01",
            phone_number: "+15555550100",
            name: "Jane Doe",
            first_name: "Jane",
            last_name: "Doe",
            language: null,
            country_code: "US",
            avatar_url: null,
            email: null,
            location: null,
            stage_id: "cmpstg_01",
            tag_ids: [],
            assignee: null,
            custom_fields: {},
            created_at: "2026-05-19T08:30:00.000Z",
          },
          source: "inbound",
          created_by_user_id: null,
          created_by_api_key_id: null,
        },
      },
      {
        type: "contact.updated",
        label: "On Contact updated",
        description: "Any field on a contact changed (name, email, custom fields).",
        samplePayload: {
          contact: { id: "cmpcnt_01", name: "Jane D.", email: "jane@example.com" },
          field_changes: { name: { before: "Jane Doe", after: "Jane D." } },
          tag_changes: null,
          previous_stage_id: null,
          changed_by_user_id: "cmpusr_01",
          changed_by_api_key_id: null,
        },
      },
      {
        type: "contact.tag_changed",
        label: "On Contact Tag updated",
        description: "Tag membership changed on a contact (added or removed).",
        samplePayload: {
          contact_id: "cmpcnt_01",
          before: { tag_ids: [] },
          after: { tag_ids: ["cmptag_vip"] },
          added: ["cmptag_vip"],
          removed: [],
          changed_by_user_id: "cmpusr_01",
          changed_by_api_key_id: null,
        },
      },
      {
        type: "contact.lifecycle_changed",
        label: "On Contact Lifecycle updated",
        description: "Contact moved to a different lifecycle stage.",
        samplePayload: {
          contact_id: "cmpcnt_01",
          before: { stage_id: "cmpstg_lead" },
          after: { stage_id: "cmpstg_qualified" },
          changed_by_user_id: "cmpusr_01",
          changed_by_api_key_id: null,
        },
      },
      {
        type: "contact.deleted",
        label: "Contact deleted",
        description: "Hard delete; conversationIds are included for cleanup.",
        samplePayload: {
          contact_id: "cmpcnt_01",
          conversation_ids: ["cmpconv_01"],
          deleted_by_user_id: "cmpusr_01",
        },
      },
    ],
  },
  {
    group: "Notes",
    events: [
      {
        type: "note.created",
        label: "On Comment added",
        description: "An agent posted an internal note on a conversation.",
        samplePayload: {
          note: {
            id: "cmpnote_01",
            conversation_id: "cmpconv_01",
            author_user_id: "cmpusr_01",
            body: "Customer prefers SMS — leaving a note here.",
            timestamp: "2026-05-20T11:05:00.000Z",
          },
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Public payload shapes — snake_case
// ---------------------------------------------------------------------------

/**
 * Channel context — single channel per team today (Meta Cloud API), but
 * structured for the multi-channel future. Subscriber populates this from
 * the team's Meta config (it's stable per team; mapper doesn't know it).
 */
export interface ChannelInfo {
  source: "meta_cloud";
  phone_number_id: string | null;
  display_phone_number: string | null;
}

/**
 * Structured sender. The `type` discriminator is the load-bearing field —
 * n8n flows pivot on `sender.type === "ai_agent"` etc. without breaking
 * when AI agents start sending. Today only `"contact"` (inbound) and
 * `"user"` (outbound from an agent) and `"api"` (outbound via /v1) and
 * `"workflow"` (workflow-step send) and `"broadcast"` are used; `"ai_agent"`
 * is reserved for the future workstream.
 */
export interface SenderInfo {
  type: "contact" | "user" | "ai_agent" | "workflow" | "broadcast" | "api";
  /** User id, ai_agent id, workflow id, etc. null when the sender has no row (inbound contact, anonymous api). */
  id: string | null;
  /** Display name. null when the sender is the contact themselves (their name is on `data.contact`). */
  name: string | null;
}

/**
 * Structured assignee. Same forward-compat rationale as SenderInfo. Used on
 * `conversation.assignee` (who's handling the current thread).
 */
export interface AssigneeInfo {
  type: "user" | "ai_agent";
  id: string;
  name: string | null;
  email: string | null;
}

export interface PublicEnvelope<T extends PublicEventType, P> {
  /** Stable id for client-side dedup. Matches the X-CCP-Event-Id + X-CCP-Delivery headers. */
  event_id: string;
  event_type: T;
  /** ISO timestamp when the envelope was generated by the bus subscriber. */
  occurred_at: string;
  team_id: string;
  /** Multi-channel forward-compat — populated by the subscriber from the team's Meta config. */
  channel: ChannelInfo | null;
  data: P;
}

/**
 * Attachment on a webhook message payload. `url` is the public CDN URL —
 * directly downloadable by the receiver (n8n/Zapier), NOT the session-gated
 * /api/media proxy. It's filled by the subscriber (the framework-agnostic
 * mapper can't query the DB for it); `null` means either text-only or the
 * media's 2-phase upload hadn't completed when the event fired.
 */
export interface PublicMedia {
  /** "image" | "video" | "audio" | "document" | "sticker". */
  kind: string;
  url: string | null;
  mime_type: string | null;
  filename: string | null;
  size_bytes: number | null;
  duration_ms: number | null;
  thumbnail_url: string | null;
  caption: string | null;
}

export interface PublicMessage {
  id: string;
  conversation_id: string;
  contact_id: string;
  /**
   * Messaging channel — the MEDIUM ("whatsapp", "instagram", "telegram", …).
   * Deliberately NOT our `provider`: one provider serves several channels —
   * `meta_cloud` (the Meta Cloud API) carries BOTH WhatsApp and Instagram — so
   * the channel canNOT be derived from the provider. Pivot on this when a team
   * runs more than one channel. Today always "whatsapp" (the only live channel).
   */
  channel: string;
  direction: "in" | "out";
  body: string;
  timestamp: string;
  status: "sent" | "delivered" | "read" | "failed";
  sender: SenderInfo;
  /** Set on /v1 / workflow sends so receivers can pivot on attribution. */
  sender_api_key_id: string | null;
  /** Attachment details, or null for a text-only message. */
  media: PublicMedia | null;
}

export interface PublicContact {
  id: string;
  phone_number: string | null;
  /** Canonical display name. Derived from first_name + last_name when both set; else literal `name`. */
  name: string;
  first_name: string | null;
  last_name: string | null;
  language: string | null;
  /** ISO 3166-1 alpha-2, derived from phone number on inbound. */
  country_code: string | null;
  avatar_url: string | null;
  email: string | null;
  location: string | null;
  stage_id: string | null;
  tag_ids: string[];
  custom_fields: Record<string, string>;
  /** Row-creation timestamp. Null when the source event didn't carry it. */
  created_at: string | null;
}

export interface PublicConversation {
  id: string;
  /** Contact this thread belongs to. Surfaced on every conversation-bearing
   *  envelope so receivers can route by contact without a callback to
   *  `/v1/conversations/:id`. */
  contact_id: string;
  status: "open" | "pending" | "closed";
  unread_count: number;
  last_message_at: string;
  /** Who's handling this thread. Null when unassigned. */
  assignee: AssigneeInfo | null;
}

/**
 * `message.sent` payload. Deliberately mirrors `message.received` so a single
 * n8n / Zapier branch can handle both directions off `message.direction`
 * instead of parsing two unrelated shapes.
 *
 * `contact`, plus the conversation's `status` / `unread_count` / `assignee`,
 * are stamped by the subscriber from the DB — the framework-agnostic mapper
 * can't query for them (same enrichment role as `PublicMedia.url`). They
 * arrive `null` only when that lookup fails (e.g. the conversation was deleted
 * between send and dispatch); receivers should treat null as "unknown, call
 * GET /v1/contacts/:id". `id` / `contact_id` / `last_message_at` are always
 * known from the event.
 */
export interface PublicMessageSentData {
  message: PublicMessage;
  contact: PublicContact | null;
  conversation: {
    id: string;
    contact_id: string;
    status: PublicConversation["status"] | null;
    unread_count: number | null;
    last_message_at: string;
    /** Who's handling this thread — hydrated by the subscriber. Null when unassigned. */
    assignee: AssigneeInfo | null;
  };
}

export interface PublicNote {
  id: string;
  conversation_id: string;
  /** Null when the note was authored by a removed user (audit attribution preserved). */
  author_user_id: string | null;
  body: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Internal → public mapping
// ---------------------------------------------------------------------------

/**
 * Map an internal DomainEvent to one OR MORE public envelopes.
 *
 * Envelopes returned here have `event_id = ""` and `channel = null` — the
 * subscriber stamps these from the freshly-created delivery row id + the
 * team's Meta config before persisting. Two reasons for splitting that
 * responsibility:
 *   - The mapper is framework-agnostic; it can't query the DB.
 *   - `event_id` must match the delivery row id so partners can
 *     cross-reference what they received against our delivery log.
 *
 * Returns empty when the event is internal-only (broadcast.*, team_channel.*,
 * suppressed bulk-coalesce events, etc.).
 */
export function toPublicEnvelopes(
  event: DomainEvent,
): Array<{ type: PublicEventType; envelope: PublicEnvelope<PublicEventType, unknown> }> {
  const occurredAt = new Date().toISOString();
  const out: Array<{ type: PublicEventType; envelope: PublicEnvelope<PublicEventType, unknown> }> = [];

  switch (event.type) {
    case "message.received": {
      const e = event as MessageReceivedEvent;
      out.push({
        type: "message.received",
        envelope: build(e.teamId, occurredAt, "message.received", {
          message: messageFromDomain(e.message, "in", null, e.contact.id),
          contact: contactFromSnapshot(e),
          conversation: {
            id: e.conversationId,
            contact_id: e.contact.id,
            status: e.conversation.status,
            unread_count: e.conversation.unreadCount,
            last_message_at: e.conversation.lastMessageAt,
            assignee: e.conversation.assignedUserId
              ? assigneeRef(e.conversation.assignedUserId)
              : null,
          } satisfies PublicConversation,
          is_new_conversation: e.isNewConversation,
          reopened: e.reopened,
        }),
      });
      break;
    }
    case "message.sent": {
      const e = event as MessageSentEvent;
      out.push({
        type: "message.sent",
        envelope: build(e.teamId, occurredAt, "message.sent", {
          message: messageFromDomain(e.message, "out", e.senderApiKeyId ?? null, e.contactId),
          // `contact` + the conversation's status/unread_count/assignee are
          // stamped by the subscriber (DB-derived; this mapper can't query).
          // ids + last_message_at are known here.
          contact: null,
          conversation: {
            id: e.conversationId,
            contact_id: e.contactId,
            status: null,
            unread_count: null,
            last_message_at: e.message.timestamp,
            assignee: null,
          },
        } satisfies PublicMessageSentData),
      });
      break;
    }
    case "message.status_changed": {
      const e = event as MessageStatusChangedEvent;
      out.push({
        type: "message.status_changed",
        envelope: build(e.teamId, occurredAt, "message.status_changed", {
          message_id: e.messageId,
          conversation_id: e.conversationId,
          contact_id: e.contactId,
          status: e.status,
        }),
      });
      break;
    }
    case "conversation.assigned": {
      const e = event as ConversationAssignedEvent;
      out.push({
        type: "conversation.assigned",
        envelope: build(e.teamId, occurredAt, "conversation.assigned", {
          conversation_id: e.conversationId,
          contact_id: e.contact.id,
          previous_assignee: e.previousAssignedUserId ? assigneeRef(e.previousAssignedUserId) : null,
          assignee: e.assignedUser
            ? { type: "user" as const, id: e.assignedUser.id, name: e.assignedUser.name, email: e.assignedUser.email }
            : null,
          changed_by_user_id: e.changedByUserId,
          changed_by_api_key_id: e.changedByApiKeyId ?? null,
        }),
      });
      break;
    }
    case "conversation.status_changed": {
      const e = event as ConversationStatusChangedEvent;
      const data = {
        conversation_id: e.conversationId,
        contact_id: e.contact.id,
        previous_status: e.previousStatus,
        status: e.newStatus,
        changed_by_user_id: e.changedByUserId,
        changed_by_api_key_id: e.changedByApiKeyId ?? null,
        closed_category: e.closedCategory ?? null,
        closed_summary: e.closedSummary ?? null,
      };
      out.push({
        type: "conversation.status_changed",
        envelope: build(e.teamId, occurredAt, "conversation.status_changed", data),
      });
      // Filtered synthetics — fire ONLY when the new status matches the
      // synthetic's filter. A pending → open transition fires opened ✓ but
      // not closed; an open → closed transition fires closed ✓ but not
      // opened. Subscribers wanting "any status change" subscribe to the
      // raw event above; subscribers wanting the n8n-style filtered trigger
      // subscribe to the synthetic and skip their own filter logic.
      if (e.newStatus === "open") {
        out.push({
          type: "conversation.opened",
          envelope: build(e.teamId, occurredAt, "conversation.opened", data),
        });
      } else if (e.newStatus === "closed") {
        out.push({
          type: "conversation.closed",
          envelope: build(e.teamId, occurredAt, "conversation.closed", data),
        });
      }
      break;
    }
    case "contact.created": {
      const e = event as ContactCreatedEvent;
      out.push({
        type: "contact.created",
        envelope: build(e.teamId, occurredAt, "contact.created", {
          contact: contactRowToPublic(e.contact),
          source: e.source,
          created_by_user_id: e.createdByUserId,
          created_by_api_key_id: e.createdByApiKeyId ?? null,
        }),
      });
      break;
    }
    case "contact.updated": {
      const e = event as ContactUpdatedEvent;
      // `kind === "created"` events used to fan into both contact.created and
      // contact.updated here; that's now redundant because contact.created is
      // a first-class event published from the create paths directly. If a
      // legacy caller still passes kind="created" on contact.updated, ignore
      // — they'll see it on contact.updated only.
      out.push({
        type: "contact.updated",
        envelope: build(e.teamId, occurredAt, "contact.updated", {
          contact: contactRowToPublic(e.contact),
          field_changes: e.fieldChanges,
          tag_changes: e.tagChanges,
          previous_stage_id: e.previousStageId,
          changed_by_user_id: e.changedByUserId,
          changed_by_api_key_id: e.changedByApiKeyId ?? null,
        }),
      });
      break;
    }
    case "contact.tag_changed": {
      const e = event as ContactTagChangedEvent;
      out.push({
        type: "contact.tag_changed",
        envelope: build(e.teamId, occurredAt, "contact.tag_changed", {
          contact_id: e.contactId,
          before: { tag_ids: e.before.tagIds },
          after: { tag_ids: e.after.tagIds },
          added: e.added,
          removed: e.removed,
          changed_by_user_id: e.changedByUserId,
          changed_by_api_key_id: e.changedByApiKeyId ?? null,
        }),
      });
      break;
    }
    case "contact.lifecycle_changed": {
      const e = event as ContactLifecycleChangedEvent;
      out.push({
        type: "contact.lifecycle_changed",
        envelope: build(e.teamId, occurredAt, "contact.lifecycle_changed", {
          contact_id: e.contactId,
          before: { stage_id: e.before.stageId },
          after: { stage_id: e.after.stageId },
          changed_by_user_id: e.changedByUserId,
          changed_by_api_key_id: e.changedByApiKeyId ?? null,
        }),
      });
      break;
    }
    case "contact.deleted": {
      const e = event as ContactDeletedEvent;
      out.push({
        type: "contact.deleted",
        envelope: build(e.teamId, occurredAt, "contact.deleted", {
          contact_id: e.contactId,
          conversation_ids: e.conversationIds,
          deleted_by_user_id: e.deletedByUserId,
          deleted_by_api_key_id: e.deletedByApiKeyId ?? null,
        }),
      });
      break;
    }
    case "note.created": {
      const e = event as NoteCreatedEvent;
      out.push({
        type: "note.created",
        envelope: build(e.teamId, occurredAt, "note.created", {
          note: {
            id: e.note.id,
            conversation_id: e.conversationId,
            author_user_id: e.note.authorUserId,
            body: e.note.body,
            timestamp: e.note.timestamp,
          } satisfies PublicNote,
        }),
      });
      break;
    }
    // All other DomainEvent types are intentionally internal — broadcast,
    // team-chat, catalog, message-send-failed, bulk coalescing, etc.
    default:
      break;
  }
  return out;
}

/** Set of every DomainEvent type the subscriber must register for. */
export function busEventTypesToSubscribe(): DomainEventType[] {
  return [
    "message.received",
    "message.sent",
    "message.status_changed",
    "conversation.assigned",
    "conversation.status_changed",
    "contact.created",
    "contact.updated",
    "contact.tag_changed",
    "contact.lifecycle_changed",
    "contact.deleted",
    "note.created",
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function build<T extends PublicEventType, P>(
  teamId: string,
  occurredAt: string,
  type: T,
  data: P,
): PublicEnvelope<T, P> {
  return {
    event_id: "", // subscriber stamps this with the delivery row id
    event_type: type,
    occurred_at: occurredAt,
    team_id: teamId,
    channel: null, // subscriber stamps this from the team's Meta config
    data,
  };
}

function messageFromDomain(
  m: import("../types").Message,
  direction: "in" | "out",
  senderApiKeyId: string | null,
  contactId: string,
): PublicMessage {
  // Sender shape: `direction === "in"` is always a contact (we don't see
  // multi-party inbound). Outbound is either user (senderUserId set), api
  // (senderApiKeyId set), or workflow/broadcast (both null + system action).
  let sender: SenderInfo;
  if (direction === "in") {
    sender = { type: "contact", id: null, name: null };
  } else if (m.senderUserId) {
    sender = { type: "user", id: m.senderUserId, name: null };
  } else if (senderApiKeyId) {
    sender = { type: "api", id: senderApiKeyId, name: null };
  } else {
    // System-initiated outbound (workflow step, broadcast). The exact origin
    // is on a sibling event type; webhook receivers see "workflow" as a
    // generic system label here.
    sender = { type: "workflow", id: null, name: null };
  }

  return {
    id: m.id,
    conversation_id: m.conversationId,
    contact_id: contactId,
    channel: publicChannel(),
    direction: m.direction,
    body: m.body,
    timestamp: m.timestamp,
    status: m.status,
    sender,
    sender_api_key_id: senderApiKeyId,
    // Everything except `url`/`thumbnail_url` is known from the domain event;
    // the subscriber fills the public CDN URLs (it has DB access; this mapper
    // doesn't). `m.media.url` is the /api/media proxy — useless externally —
    // so we don't carry it here.
    media: m.media
      ? {
          kind: m.media.kind,
          url: null,
          mime_type: m.media.mimeType ?? null,
          filename: m.media.filename ?? null,
          size_bytes: m.media.sizeBytes ?? null,
          duration_ms: m.media.durationMs ?? null,
          thumbnail_url: null,
          caption: m.media.caption ?? null,
        }
      : null,
  };
}

function contactRowToPublic(c: import("../types").Contact & {
  firstName?: string | null;
  lastName?: string | null;
  language?: string | null;
  countryCode?: string | null;
  createdAt?: string | null;
}): PublicContact {
  return {
    id: c.id,
    phone_number: c.phoneNumber,
    name: c.name,
    first_name: c.firstName ?? null,
    last_name: c.lastName ?? null,
    language: c.language ?? null,
    country_code: c.countryCode ?? null,
    avatar_url: c.avatarUrl ?? null,
    email: c.email ?? null,
    location: c.location ?? null,
    stage_id: c.stageId ?? null,
    tag_ids: c.tagIds ?? [],
    custom_fields: c.customFields ?? {},
    created_at: c.createdAt ?? null,
  };
}

function contactFromSnapshot(e: MessageReceivedEvent): PublicContact {
  // MessageReceivedEvent carries a WorkflowContactSnapshot — narrower than
  // the full Contact, but it has enough for the inbound payload. The new
  // contact fields (firstName, lastName, language, countryCode, assignedUserId)
  // are stamped here when the snapshot was built with them populated; otherwise
  // null. Receivers can call GET /v1/contacts/:id for the full row.
  const c = e.contact as MessageReceivedEvent["contact"] & {
    firstName?: string | null;
    lastName?: string | null;
    language?: string | null;
    countryCode?: string | null;
    avatarUrl?: string | null;
    location?: string | null;
    createdAt?: string | null;
  };
  return {
    id: c.id,
    phone_number: c.phoneNumber ?? null,
    name: c.name,
    first_name: c.firstName ?? null,
    last_name: c.lastName ?? null,
    language: c.language ?? null,
    country_code: c.countryCode ?? null,
    avatar_url: c.avatarUrl ?? null,
    email: c.email ?? null,
    location: c.location ?? null,
    stage_id: c.stageId ?? null,
    tag_ids: c.tagIds ?? [],
    custom_fields: c.customFields ?? {},
    created_at: c.createdAt ?? null,
  };
}

/**
 * Build an AssigneeInfo from a user id alone — used when the source event
 * carries only the id (no hydrated User row). The subscriber may hydrate
 * `name`/`email` from a one-shot user lookup, but the static shape is
 * stable for receivers regardless.
 */
function assigneeRef(userId: string): AssigneeInfo {
  return { type: "user", id: userId, name: null, email: null };
}
