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
  ConversationAiChangedEvent,
  ConversationAssignedEvent,
  ConversationStatusChangedEvent,
  DomainEvent,
  DomainEventType,
  MessageReceivedEvent,
  MessageSentEvent,
  MessageStatusChangedEvent,
  NoteCreatedEvent,
  NoteDeletedEvent,
} from "../events/types";

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
  // AI Autopilot toggled on/off for a conversation — lets a partner flow track
  // the human↔AI handoff state (the inbound message.received also carries the
  // current state inline as `ai_enabled`).
  "conversation.ai_changed",
  "contact.created",
  "contact.updated",
  "contact.tag_changed",
  "contact.lifecycle_changed",
  "contact.deleted",
  "note.created",
  "note.deleted",
] as const;
export type PublicEventType = (typeof PUBLIC_EVENT_TYPES)[number];

/**
 * Compact `data`-shape example for each event, used by the docs page +
 * create-webhook UI to show receivers what they'll need to parse. This is the
 * INTERNAL `PublicEnvelope.data` shape — NOT what we POST. The docs page runs
 * each sample through `toWirePayload` (see below) to render the real FLAT wire
 * body partners actually receive: `{ team_id, event_type, …event blocks }`
 * with NO `event_id` / `occurred_at` / `data` wrapper (dedup rides the
 * `X-CCP-Delivery` header). `PublicEnvelope` is the mapper's intermediate
 * representation only. Strings use the `cmp…` placeholder convention so
 * partners don't paste fake-looking ids into their workflows.
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
            external_id: "wamid.HBgLMTU1NTU1NTAxMDAVAgASGBI5RkE…",
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
            assignee: {
              type: "user",
              id: "cmpusr_01",
              name: "Ali Hassan",
              email: "ali@example.com",
              role: "agent",
              created_at: "2025-08-12T09:00:00.000Z",
            },
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
            external_id: "wamid.HBgLMTU1NTU1NTAxMDAVAgARGBI2QkE…",
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
            assignee: {
              type: "user",
              id: "cmpusr_01",
              name: "Ali Hassan",
              email: "ali@example.com",
              role: "agent",
              created_at: "2025-08-12T09:00:00.000Z",
            },
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
        description:
          "Contact removed from the directory (soft delete). Conversation history is preserved, so conversation_ids is empty.",
        samplePayload: {
          contact_id: "cmpcnt_01",
          conversation_ids: [],
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
      {
        type: "note.deleted",
        label: "On Comment deleted",
        description: "An internal note was removed from a conversation.",
        samplePayload: {
          note_id: "cmpnote_01",
          conversation_id: "cmpconv_01",
          deleted_by_user_id: "cmpusr_01",
        },
      },
    ],
  },
];

/**
 * Look up the documented `data`-shape sample payload for an event type. Used by
 * the webhook "test fire" so a synthetic delivery carries the SAME shape that
 * event type really produces (run through `toWirePayload`), not a hardcoded
 * message-shaped body. Falls back to `message.received`'s sample for the (today
 * impossible) case of an unknown type, so the caller always gets a real shape.
 */
export function samplePayloadFor(type: PublicEventType): SampleData {
  for (const group of PUBLIC_EVENT_GROUPS) {
    for (const ev of group.events) {
      if (ev.type === type) return ev.samplePayload;
    }
  }
  // Unreachable today (every PublicEventType has a sample) — empty object
  // keeps the return total without a non-null assertion.
  return {};
}

// ---------------------------------------------------------------------------
// Public payload shapes — snake_case
// ---------------------------------------------------------------------------

/**
 * Channel context — single channel per team today (Meta Cloud API), but
 * structured for the multi-channel future. Subscriber populates this from
 * the team's Meta config (it's stable per team; mapper doesn't know it).
 */
export interface ChannelInfo {
  source: "whatsapp";
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

/**
 * Mapper INTERMEDIATE representation — NOT the wire body. `toPublicEnvelopes`
 * produces these; the subscriber then runs `data` through `toWirePayload` and
 * posts the resulting FLAT shape (`{ team_id, event_type, …blocks }`). None of
 * `event_id` / `occurred_at` / the `data` wrapper appear in what partners
 * receive — they were never sent. Dedup is the `X-CCP-Delivery` header.
 */
export interface PublicEnvelope<T extends PublicEventType, P> {
  /** Internal-only: the delivery row id the subscriber stamps before persisting. Echoed on the X-CCP-Delivery header; NOT in the wire body. */
  event_id: string;
  event_type: T;
  /** Internal-only: when the envelope was generated. Not posted to partners. */
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
    case "conversation.ai_changed": {
      const e = event as ConversationAiChangedEvent;
      out.push({
        type: "conversation.ai_changed",
        envelope: build(e.teamId, occurredAt, "conversation.ai_changed", {
          conversation_id: e.conversationId,
          contact_id: e.contact.id,
          ai_enabled: e.newAiEnabled,
          previous_ai_enabled: e.previousAiEnabled,
          changed_by_user_id: e.changedByUserId,
          changed_by_api_key_id: e.changedByApiKeyId ?? null,
        }),
      });
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
    case "note.deleted": {
      // Symmetric with note.created so a partner syncing internal notes can
      // remove the row on their side. The note is gone, so only the ids +
      // actor are carried (no body/timestamp to read back).
      const e = event as NoteDeletedEvent;
      out.push({
        type: "note.deleted",
        envelope: build(e.teamId, occurredAt, "note.deleted", {
          note_id: e.noteId,
          conversation_id: e.conversationId,
          deleted_by_user_id: e.deletedByUserId,
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

/**
 * Set of every DomainEvent type the outbound-webhook subscriber must
 * register for.
 *
 * INVARIANT — `webhook.*` events MUST NEVER appear in this list.
 *
 * The outbound-webhook delivery worker publishes
 * `webhook.subscription_disabled` and `webhook.subscription_recovered`
 * from inside its own job context (see
 * `apps/api/src/lib/outbound-webhooks/worker.ts`). If a `webhook.*` event
 * were subscribed here, a partner's failure → circuit-breaker → trip →
 * `webhook.subscription_disabled` event would feed back into the same
 * delivery worker as a NEW delivery to enqueue, which on failure would
 * trip the breaker again, → infinite ping-pong on the BullMQ queue.
 *
 * The system is currently safe because no `webhook.*` types are listed
 * here. Adding one without first re-routing those events to a separate,
 * non-self-subscribing bus tier breaks this invariant.
 */
export function busEventTypesToSubscribe(): DomainEventType[] {
  return [
    "message.received",
    "message.sent",
    "message.status_changed",
    "conversation.assigned",
    "conversation.status_changed",
    "conversation.ai_changed",
    "contact.created",
    "contact.updated",
    "contact.tag_changed",
    "contact.lifecycle_changed",
    "contact.deleted",
    "note.created",
    "note.deleted",
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
    channel: m.channel,
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

// ===========================================================================
// WIRE SHAPE (what we actually POST)
// ---------------------------------------------------------------------------
// Flat, camelCase, epoch-timestamp envelope modelled on the partner's
// existing inbox webhook so their n8n flows work with minimal rework:
//   { event_type, assignee, message, channel, sender }  (+ event-specific
//   blocks for non-message events). The internal `PublicEnvelope` above is
//   the *input* to this transform — keeping the mapper + the subscriber's
//   enrichment untouched. `toWirePayload` runs in the subscriber AFTER
//   enrichment, reading the hydrated fields it left in place.
//
// Unavoidable deviations from the partner sample (DB-model facts, not bugs):
//   - ids are strings (cuids), not integers — field NAMES match.
//   - channelId/channel.id is the ChannelConnection cuid, not an integer.
//   - channel.name is the MEDIUM ("whatsapp"|"telegram"|"instagram"); source
//     keeps the partner's "<medium>_business" style.
// ===========================================================================

function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}
function toEpochSec(iso: string | null | undefined): number | null {
  const ms = toEpochMs(iso);
  return ms === null ? null : Math.floor(ms / 1000);
}
function splitName(name: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { firstName: null, lastName: null };
  const i = trimmed.indexOf(" ");
  if (i === -1) return { firstName: trimmed, lastName: null };
  return { firstName: trimmed.slice(0, i), lastName: trimmed.slice(i + 1) || null };
}

/** Base channel facts the subscriber resolves from the ChannelConnection row. */
export interface WireChannelBase {
  id: string | null;
  /** The medium — "whatsapp" | "telegram" | "instagram". */
  name: string;
  /** Partner-style source string, e.g. "whatsapp_business". */
  source: string;
  created_at: number | null;
}

/** Map our `Channel` medium to the partner's `source` convention. */
export function channelSourceFor(medium: string): string {
  return medium === "whatsapp" ? "whatsapp_business" : medium;
}

/**
 * The assignee block (the partner's top-level "team member assigned to this
 * conversation"). The subscriber stamps `role` + `created_at` (ISO) onto the
 * hydrated AssigneeInfo; this reads them back. null when unassigned.
 */
type AssigneeWithMeta = AssigneeInfo & { role?: string | null; created_at?: string | null };
function wireAssignee(a: AssigneeWithMeta | null | undefined): Record<string, unknown> | null {
  if (!a || !a.id) return null;
  const { firstName, lastName } = splitName(a.name);
  return {
    id: a.id,
    email: a.email ?? null,
    firstName,
    lastName,
    role: a.role ?? null,
    created_at: toEpochSec(a.created_at),
  };
}

function wireChannel(
  base: WireChannelBase | null,
  contact: { phone_number?: string | null; name?: string | null } | null | undefined,
): Record<string, unknown> | null {
  if (!base) return null;
  const waId = contact?.phone_number ? contact.phone_number.replace(/^\+/, "") : null;
  const profileName = contact?.name ?? null;
  const { firstName, lastName } = splitName(profileName);
  // Mirror the partner's stringified `meta` blob (contact profile lives here)
  // AND expose the same data as clean fields — both, per the integration's ask.
  const meta =
    waId || profileName
      ? JSON.stringify({
          meta: { profile: { name: profileName }, wa_id: waId, user_id: null, firstName, lastName },
        })
      : null;
  return {
    id: base.id,
    name: base.name,
    source: base.source,
    meta,
    waId,
    profileName,
    created_at: base.created_at,
  };
}

function wireSender(s: SenderInfo | null | undefined): Record<string, unknown> {
  const type = s?.type ?? "contact";
  const id = s?.id ?? null;
  return {
    source: type,
    userId: type === "user" ? id : null,
    teamId: null,
    workflowId: type === "workflow" ? id : null,
    broadcastHistoryId: type === "broadcast" ? id : null,
    // The originating API key for `/v1` sends. Surfaced here (and read back by
    // the delivery worker's loop-detection extractor) so a partner whose own
    // key triggered this message can short-circuit the webhook → /v1 → webhook
    // hot-potato via the `X-CCP-Origin-Key` header. null for every non-api
    // sender. `SenderInfo.id` IS the apiKeyId when `type === "api"` (set in
    // messageFromDomain).
    apiKeyId: type === "api" ? id : null,
  };
}

function wireMessageBlock(
  m: (PublicMessage & { external_id?: string | null }) | undefined,
  traffic: "incoming" | "outgoing",
  channelId: string | null,
): Record<string, unknown> | null {
  if (!m) return null;
  return {
    messageId: m.id,
    channelMessageId: m.external_id ?? null,
    // The thread this message belongs to. Surfaced so a partner (n8n, etc.)
    // can address a reply back via POST /v1/conversations/:id/messages — the
    // /v1 send path is keyed on conversation id, and it's the only id the
    // inbound webhook didn't previously expose.
    conversationId: m.conversation_id,
    contactId: m.contact_id,
    channelId,
    traffic,
    timestamp: toEpochMs(m.timestamp),
    message: { type: m.media ? m.media.kind : "text", text: m.body },
    // Extra vs. the partner sample, ignored by text flows; carries file links.
    media: m.media,
  };
}

function wireContact(c: PublicContact | null | undefined): Record<string, unknown> | null {
  if (!c) return null;
  return {
    id: c.id,
    phoneNumber: c.phone_number,
    name: c.name,
    firstName: c.first_name,
    lastName: c.last_name,
    language: c.language,
    countryCode: c.country_code,
    avatarUrl: c.avatar_url,
    email: c.email,
    location: c.location,
    stageId: c.stage_id,
    tagIds: c.tag_ids,
    customFields: c.custom_fields,
    created_at: toEpochSec(c.created_at),
  };
}

/**
 * Transform an enriched internal `data` payload into the flat wire shape for
 * one event type. Pure. `ctx.channelBase` is the team's resolved channel; the
 * subscriber passes it (it can't be derived here).
 */
export function toWirePayload(
  type: PublicEventType,
  data: unknown,
  ctx: {
    channelBase: WireChannelBase | null;
    /** Workspace AI Autopilot opt-in. ANDed into `ai_enabled` so a team with
     *  the feature off reports false regardless of the per-conversation flag.
     *  Absent = true (assume on) for synthetic/test callers; the real
     *  subscriber always supplies it. */
    teamAiAutopilotEnabled?: boolean;
  },
): Record<string, unknown> {
  const d = data as Record<string, any>;
  const channelId = ctx.channelBase?.id ?? null;
  // Effective AI gate = workspace opted in AND this conversation not paused.
  const aiEnabled =
    (ctx.teamAiAutopilotEnabled ?? true) && (d.conversation?.aiEnabled ?? true);

  switch (type) {
    case "message.received":
      return {
        event_type: type,
        // The customer who sent the message — first-class block (their full
        // record: phoneNumber for replying, name, tags, stage, custom fields).
        // The partner sample only carried this inside channel.meta; we keep
        // that AND surface the proper contact here.
        contact: wireContact(d.contact),
        assignee: wireAssignee(d.conversation?.assignee),
        // AI Autopilot state for this conversation — the partner flow gates its
        // auto-reply on this (true = AI may answer; false = a human owns it).
        ai_enabled: aiEnabled,
        message: wireMessageBlock(d.message, "incoming", channelId),
        channel: wireChannel(ctx.channelBase, d.contact),
        sender: wireSender(d.message?.sender),
      };
    case "message.sent":
      return {
        event_type: type,
        // The customer the message was sent to (same conversation contact).
        contact: wireContact(d.contact),
        assignee: wireAssignee(d.conversation?.assignee),
        ai_enabled: aiEnabled,
        message: wireMessageBlock(d.message, "outgoing", channelId),
        channel: wireChannel(ctx.channelBase, d.contact),
        sender: wireSender(d.message?.sender),
      };
    case "message.status_changed":
      return {
        event_type: type,
        messageId: d.message_id,
        contactId: d.contact_id,
        conversationId: d.conversation_id,
        status: d.status,
        channel: wireChannel(ctx.channelBase, null),
      };
    case "conversation.assigned":
      return {
        event_type: type,
        conversationId: d.conversation_id,
        contactId: d.contact_id,
        assignee: wireAssignee(d.assignee),
        previousAssignee: wireAssignee(d.previous_assignee),
        changedByUserId: d.changed_by_user_id ?? null,
        changedByApiKeyId: d.changed_by_api_key_id ?? null,
        channel: wireChannel(ctx.channelBase, null),
      };
    case "conversation.opened":
    case "conversation.closed":
    case "conversation.status_changed":
      return {
        event_type: type,
        conversationId: d.conversation_id,
        contactId: d.contact_id,
        previousStatus: d.previous_status ?? null,
        status: d.status,
        changedByUserId: d.changed_by_user_id ?? null,
        changedByApiKeyId: d.changed_by_api_key_id ?? null,
        closedCategory: d.closed_category ?? null,
        closedSummary: d.closed_summary ?? null,
        channel: wireChannel(ctx.channelBase, null),
      };
    case "conversation.ai_changed":
      return {
        event_type: type,
        conversationId: d.conversation_id,
        contactId: d.contact_id,
        aiEnabled: d.ai_enabled,
        previousAiEnabled: d.previous_ai_enabled ?? null,
        changedByUserId: d.changed_by_user_id ?? null,
        changedByApiKeyId: d.changed_by_api_key_id ?? null,
        channel: wireChannel(ctx.channelBase, null),
      };
    case "contact.created":
      return {
        event_type: type,
        contact: wireContact(d.contact),
        source: d.source ?? null,
        createdByUserId: d.created_by_user_id ?? null,
        createdByApiKeyId: d.created_by_api_key_id ?? null,
      };
    case "contact.updated":
      return {
        event_type: type,
        contact: wireContact(d.contact),
        fieldChanges: d.field_changes ?? null,
        tagChanges: d.tag_changes ?? null,
        previousStageId: d.previous_stage_id ?? null,
        changedByUserId: d.changed_by_user_id ?? null,
        changedByApiKeyId: d.changed_by_api_key_id ?? null,
      };
    case "contact.tag_changed":
      return {
        event_type: type,
        contactId: d.contact_id,
        before: d.before ?? null,
        after: d.after ?? null,
        added: d.added ?? [],
        removed: d.removed ?? [],
        changedByUserId: d.changed_by_user_id ?? null,
        changedByApiKeyId: d.changed_by_api_key_id ?? null,
      };
    case "contact.lifecycle_changed":
      return {
        event_type: type,
        contactId: d.contact_id,
        before: d.before ?? null,
        after: d.after ?? null,
        changedByUserId: d.changed_by_user_id ?? null,
        changedByApiKeyId: d.changed_by_api_key_id ?? null,
      };
    case "contact.deleted":
      return {
        event_type: type,
        contactId: d.contact_id,
        conversationIds: d.conversation_ids ?? [],
        deletedByUserId: d.deleted_by_user_id ?? null,
        deletedByApiKeyId: d.deleted_by_api_key_id ?? null,
      };
    case "note.created":
      return {
        event_type: type,
        conversationId: d.note?.conversation_id,
        note: {
          id: d.note?.id,
          conversationId: d.note?.conversation_id,
          authorUserId: d.note?.author_user_id ?? null,
          body: d.note?.body,
          timestamp: toEpochMs(d.note?.timestamp),
        },
      };
    case "note.deleted":
      return {
        event_type: type,
        conversationId: d.conversation_id,
        noteId: d.note_id,
        deletedByUserId: d.deleted_by_user_id ?? null,
      };
    default:
      return { event_type: type, ...(d as Record<string, unknown>) };
  }
}
