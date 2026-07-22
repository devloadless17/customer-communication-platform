import { db } from "@/lib/db";
import { type MessageFlagRow, mapFlag } from "@/lib/message-flags/queries";
import { normalizeStringMap } from "@/lib/normalize-string-map";
import {
  ephemeralVisitorLabel,
  isEphemeralChannel,
  socialContactPlaceholder,
} from "@ccp/shared/providers/capabilities";
import type {
  ActivityActorKind,
  Contact,
  Conversation,
  ConversationActivityEvent,
  ConversationEventKind,
  ConversationStatus,
  InternalNote,
  MediaAttachment,
  MediaKind,
  Message,
  MessageDirection,
  MessageStatus,
  Channel,
  ReplySnapshot,
  Role,
  SocialProfile,
  User,
  UserAvailabilityStatus,
} from "@ccp/shared/types";
import type { AvailabilitySource, WorkHoursMode } from "@ccp/shared/work-hours";

export const MAX_TAKE = 100;

export function clampTake(requested: number | undefined, fallback: number): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(Math.floor(requested), MAX_TAKE);
}

// ---------------------------------------------------------------------------
// Prisma row types — used by the mappers below.
// ---------------------------------------------------------------------------

type PrismaConversation = Awaited<
  ReturnType<typeof db.conversation.findUniqueOrThrow>
>;
type PrismaContact = Awaited<ReturnType<typeof db.contact.findUniqueOrThrow>>;
type PrismaUser = Awaited<ReturnType<typeof db.user.findUniqueOrThrow>>;
type PrismaMessage = Awaited<ReturnType<typeof db.message.findUniqueOrThrow>>;
type PrismaNote = Awaited<ReturnType<typeof db.internalNote.findUniqueOrThrow>>;

/**
 * Selector snippet used wherever we render a quoted-reply preview. Centralised
 * so message-list, single-thread, and ingest all pull the same fields.
 */
export const REPLY_TO_INCLUDE = {
  select: {
    id: true,
    body: true,
    direction: true,
    mediaKind: true,
    // Drives the quoted-reply video thumbnail — present only when ingest
    // extracted a poster frame (NULL on outbound/older video; absent then).
    mediaThumbnailUrl: true,
    sender: { select: { name: true } },
  },
} as const;

type ReplyToRow = {
  id: string;
  body: string;
  direction: string;
  mediaKind: string | null;
  mediaThumbnailUrl: string | null;
  sender: { name: string } | null;
};

export function mapReplySnapshot(row: ReplyToRow | null | undefined): ReplySnapshot | null {
  if (!row) return null;
  // Quoted-reply thumbnail — mirrors how mapMessage builds the main media
  // thumbnailUrl. Image: the authenticated stream itself doubles as its thumb.
  // Video: the extracted poster, only when mediaThumbnailUrl is set. Non-
  // image/video media (audio/document/sticker) carry no thumbnail.
  const thumbnailUrl =
    row.mediaKind === "image"
      ? `/api/media/${row.id}`
      : row.mediaKind === "video" && row.mediaThumbnailUrl
        ? `/api/media/${row.id}/thumb`
        : undefined;
  return {
    id: row.id,
    body: row.body.slice(0, 200),
    direction: row.direction as MessageDirection,
    senderName: row.sender?.name ?? null,
    ...(row.mediaKind ? { mediaKind: row.mediaKind as MediaKind } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

/**
 * Exactly the User columns `mapUser` reads. Use as the `select` for an
 * `assignedUser` include on hot list paths so Prisma stops shipping every
 * User column (password hash, updatedAt, deactivatedAt timestamp value, …)
 * across Postgres → Node → wire on every conversation-list row. The full
 * `findUniqueOrThrow` row is structurally assignable to `MappableUser`, so
 * existing full-row callers of `mapUser` still type-check.
 */
const USER_COLUMNS = {
  id: true,
  isSuperAdmin: true,
  name: true,
  email: true,
  avatarUrl: true,
  createdAt: true,
  deactivatedAt: true,
  availabilityStatus: true,
  availabilityMessage: true,
  availabilitySource: true,
  availabilityOverrideUntil: true,
  workHoursMode: true,
} as const;

/**
 * Select for an `assignedUser` include. Now a FUNCTION of the workspace because
 * `role` no longer lives on the User row — it is per-workspace, on
 * WorkspaceMember. The membership is pulled with a filtered nested select
 * (`take: 1`, scoped to this workspace) so a user who belongs to several
 * workspaces still reports the role that is correct for THIS query's scope,
 * rather than whichever membership happened to sort first.
 */
export function assignedUserSelect(workspaceId: string) {
  return {
    ...USER_COLUMNS,
    workspaceMemberships: {
      where: { workspaceId },
      select: { role: true },
      take: 1,
    },
  } as const;
}

type MappableUser = Pick<PrismaUser, keyof typeof USER_COLUMNS> & {
  workspaceMemberships: { role: Role }[];
};

/**
 * `workspaceId` is passed explicitly rather than read off the row: it IS the
 * scope the caller queried in, and the User row no longer carries it.
 */
export function mapUser(u: MappableUser, workspaceId: string): User {
  // Availability comes off the same row when present (every inbox query that
  // includes `assignedUser` brings these columns along by default). Only
  // emit them when set so the wire shape stays terse for clients that
  // don't read availability. `users.service.ts` used to carry a
  // near-identical local mapper (`mapAvailabilityRow`) until 2026-05-26;
  // collapsed into here so a future "availability shows in one panel but
  // not another" drift can't happen.
  return {
    id: u.id,
    workspaceId,
    isSuperAdmin: u.isSuperAdmin,
    // No membership row for this workspace means the user is reachable here
    // only via an org-admin/superAdmin override; "agent" is the safe floor for
    // a DISPLAY dto — it never grants anything (every real gate reads the
    // session, not this field).
    role: (u.workspaceMemberships[0]?.role ?? "agent") as Role,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl ?? undefined,
    createdAt: u.createdAt.toISOString(),
    isActive: u.deactivatedAt === null,
    ...(u.availabilityStatus
      ? { availabilityStatus: u.availabilityStatus as UserAvailabilityStatus }
      : {}),
    ...(u.availabilityMessage ? { availabilityMessage: u.availabilityMessage } : {}),
    // Provenance travels with the status so a surface can say "set by an admin"
    // or "outside working hours" instead of an unexplained grey dot. Same terse
    // rule as above: only emitted when it's not the boring default.
    ...(u.availabilitySource && u.availabilitySource !== "manual"
      ? { availabilitySource: u.availabilitySource as AvailabilitySource }
      : {}),
    ...(u.availabilityOverrideUntil
      ? { availabilityUntil: u.availabilityOverrideUntil.toISOString() }
      : {}),
    ...(u.workHoursMode && u.workHoursMode !== "inherit"
      ? { workHoursMode: u.workHoursMode as WorkHoursMode }
      : {}),
  };
}

/**
 * Wire display name + name-parts for a contact. A brand-new social contact has
 * no display name yet — ingest stores the opaque PSID/IGSID as `name` until the
 * async Graph enrichment pass fills the real name. Show a friendly stand-in
 * ("Messenger user") instead of the raw id so the inbox never flashes
 * "17885439021234" before enrichment lands (a few hundred ms later, via a
 * `contact.updated` frame carrying the real name). Wire-only: the DB row keeps
 * the id as `name` (the enrichment guard keys on that), and `externalContactId`
 * still carries the raw id. Shared by both contact mappers so they can't drift.
 */
function contactDisplayIdentity(c: {
  name: string;
  firstName: string | null;
  lastName: string | null;
  identityChannel: string | null;
  externalContactId: string | null;
  email?: string | null;
  phoneNumber?: string | null;
}): { name: string; firstName: string | null; lastName: string | null } {
  if (!c.externalContactId || c.name !== c.externalContactId) {
    return { name: c.name, firstName: c.firstName, lastName: c.lastName };
  }
  // Null the split-from-id parts too, so no surface reading firstName/lastName
  // leaks the raw id; initials fall back to the placeholder name.
  const channel = c.identityChannel as Channel | null;
  if (channel && isEphemeralChannel(channel)) {
    // A visitor who self-identified via the pre-chat form has a real handle — show
    // it. (They gave a phone/email but no name, so `name` is still the raw id;
    // without this a PROMOTED visitor still read "Website visitor", hiding the very
    // identity they just supplied.) Otherwise fall back to a per-visitor label so
    // concurrent anonymous chats are distinguishable — the shared placeholder made
    // every widget row in the inbox look identical.
    const identified = c.email || c.phoneNumber;
    return {
      name: identified || ephemeralVisitorLabel(c.externalContactId),
      firstName: null,
      lastName: null,
    };
  }
  return {
    name: socialContactPlaceholder(channel),
    firstName: null,
    lastName: null,
  };
}

export function mapContact(c: PrismaContact): Contact {
  const display = contactDisplayIdentity(c);
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    phoneNumber: c.phoneNumber,
    identityChannel: c.identityChannel as Channel | null,
    externalContactId: c.externalContactId,
    name: display.name,
    firstName: display.firstName,
    lastName: display.lastName,
    username: c.username,
    language: c.language,
    countryCode: c.countryCode,
    // Calling permission revocation — drives the inbox Phone-button gate so a
    // revoked contact doesn't show an enabled button the backend would reject.
    callPermissionRevokedUntil:
      c.callPermissionRevokedUntil?.toISOString() ?? null,
    // Consecutive unanswered outbound calls. Surfaced so the agent can see the
    // approaching cliff — WhatsApp nudges the customer at 2 and revokes calling
    // permission outright at 4.
    consecutiveUnansweredOutCalls: c.consecutiveUnansweredOutCalls,
    avatarUrl: c.avatarUrl ?? undefined,
    socialProfile: (c.socialProfile as SocialProfile | null) ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: normalizeStringMap(c.customFields),
    source: c.source,
    stageId: c.stageId,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * THE single Prisma-row → Contact WIRE serializer for every `contact.created` /
 * `contact.updated` publisher (HTTP edit, CSV import, /v1 API, workflow steps,
 * inbound ingest). Use this instead of hand-rolling a `Contact` literal: those
 * hand-rolled copies drifted and dropped `callPermissionRevokedUntil`, so a
 * workflow/edit touching a call-revoked contact broadcast a frame that
 * re-enabled the inbox Phone button for every agent until the next full read.
 * `mapContact` is the field source of truth (incl. callPermissionRevokedUntil);
 * `tagIds` is wire-only (the cross-conversation tag union the list/panel reduce
 * against) and is opt-in because not every publisher JOINs the tags.
 */
export function toContactWire(
  c: PrismaContact,
  opts?: { tagIds?: string[] },
): Contact {
  return {
    ...mapContact(c),
    ...(opts?.tagIds ? { tagIds: opts.tagIds } : {}),
  };
}

/**
 * Narrower mapper for the inbox list. The conversation list row only renders
 * `name` + the avatar gradient + stage chip + tag chip filter — it never
 * surfaces customFields / email / location. Dropping `customFields` from the
 * SELECT removes the JSONB column read from every list page; the rest stay
 * because they're cheap VARCHARs.
 *
 * Returns a full `Contact` so downstream UI types don't have to branch — the
 * dropped JSONB is synthesized as `{}`. When the agent opens a thread the
 * full record is re-fetched via the per-conversation query which DOES select
 * customFields.
 */
// `version` is the optimistic-concurrency token on the row — it never
// reaches the wire (clients don't need it; the server-side CAS handles
// races) so we omit it from the mapper's input type too. `deletedAt` is the
// soft-delete tombstone — likewise an internal column that never reaches the
// wire. Listing them alongside `customFields` keeps the strict shape's `Omit`
// tractable.
// `callPermissionRevokedUntil` + `consecutiveUnansweredOutCalls` are calling-
// state internals — never read by the list UI (the contact-panel can fetch
// them separately when needed), and excluding them keeps the contact-list
// select narrow.
type PrismaContactListItem = Omit<
  PrismaContact,
  | "customFields"
  | "version"
  | "deletedAt"
  | "callPermissionRevokedUntil"
  | "consecutiveUnansweredOutCalls"
  // customerId isn't part of the narrow list row — the unified profile is loaded
  // separately when a thread is opened, so the contact-list select omits it.
  | "customerId"
  // BSUID/username are identity internals (forward-compat) — not rendered in the
  // list row, so the narrow select omits them too.
  | "bsuid"
  | "username"
  // socialProfile (IG follower/verified signals) is panel-only context — the
  // list row never renders it, so the narrow select omits the JSONB column.
  | "socialProfile"
  // Marketing-consent state is enforced server-side during broadcast audience
  // resolution and surfaced on the campaign report; the inbox list row never
  // renders it, so it stays out of the narrow select like the other internals
  // above. Surface it in the contact PANEL (which loads the full row) if an
  // operator ever needs to see consent while replying.
  | "marketingOptOutAt"
  | "marketingOptOutSource"
>;
export function mapContactListItem(c: PrismaContactListItem): Contact {
  const display = contactDisplayIdentity(c);
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    phoneNumber: c.phoneNumber,
    identityChannel: c.identityChannel as Channel | null,
    externalContactId: c.externalContactId,
    name: display.name,
    firstName: display.firstName,
    lastName: display.lastName,
    language: c.language,
    countryCode: c.countryCode,
    avatarUrl: c.avatarUrl ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: {},
    source: c.source,
    stageId: c.stageId,
    createdAt: c.createdAt.toISOString(),
  };
}

// `normalizeCustomFields` is the canonical `normalizeStringMap` — re-exported
// under the contacts-domain name so existing import sites keep working while
// the implementation lives in exactly one place (see normalize-string-map.ts).
export { normalizeStringMap as normalizeCustomFields } from "@/lib/normalize-string-map";

export function mapConversation(
  // The source widget name rides along ONLY when the caller included the
  // relation (the primary inbox reads do); the scalar id is always present.
  c: PrismaConversation & { webchatWidget?: { name: string } | null },
): Conversation {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    contactId: c.contactId,
    assignedUserId: c.assignedUserId,
    status: c.status as ConversationStatus,
    aiEnabled: c.aiEnabled,
    unreadCount: c.unreadCount,
    // Only emitted when non-zero — the flagless majority of threads stays as
    // terse on the wire as before flags existed, and the list-row badge treats
    // absent as 0.
    ...(c.openFlagCount > 0 ? { openFlagCount: c.openFlagCount } : {}),
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastMessagePreview: c.lastMessagePreview,
    lastMessageDirection: c.lastMessageDirection,
    // The channel discriminator drives the per-row channel badge and the
    // channel-aware composer. Without it every thread reads as WhatsApp.
    channel: c.channel as Channel,
    // Website-widget attribution — which site this chat came from.
    ...(c.webchatWidgetId ? { webchatWidgetId: c.webchatWidgetId } : {}),
    ...(c.webchatWidget ? { webchatWidgetName: c.webchatWidget.name } : {}),
  };
}

// Read paths never need `raw_payload` — it's the verbatim Meta webhook body,
// kept in the DB for debugging only (CLAUDE.md rule #4). Pulling it would
// drag a full JSONB blob per row through Postgres → Node → the browser on
// every thread open, so we `omit` it from every message read and the domain
// type doesn't carry it.
export type PrismaMessageWithReply = Omit<PrismaMessage, "rawPayload"> & {
  replyTo?: ReplyToRow | null;
  /**
   * Triage flags, joined only by the per-thread hydration. Optional because the
   * ingest / broadcast / send paths map a row that was created microseconds ago
   * and therefore cannot carry flags — they'd be paying a join to prove an
   * empty array. Same convention as `replyTo` above.
   */
  flags?: MessageFlagRow[];
};

export function mapMessage(m: PrismaMessageWithReply): Message {
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    conversationId: m.conversationId,
    externalId: m.externalId,
    senderUserId: m.senderUserId,
    body: m.body,
    direction: m.direction as MessageDirection,
    channel: m.channel as Channel,
    // Coexistence provenance — only surfaced when it's a phone-app send, so the
    // bubble can render "· via WhatsApp app". `api` stays implicit (absent) to
    // keep the wire lean, matching the optional field on the Message type.
    ...(m.origin === "business_app" ? { origin: "business_app" as const } : {}),
    status: m.status as MessageStatus,
    timestamp: m.timestamp.toISOString(),
    // Persisted provider failure reason — only meaningful on a `failed` send,
    // and only set when Meta returned an `errors[0]`. Carried so a refresh
    // surfaces the same diagnostic the live `message:status` socket frame does
    // (the failed-bubble tooltip / muted line).
    ...(m.status === "failed" && m.statusErrorCode != null
      ? { statusErrorCode: m.statusErrorCode }
      : {}),
    ...(m.status === "failed" && m.statusErrorTitle != null
      ? { statusErrorTitle: m.statusErrorTitle }
      : {}),
    ...(m.status === "failed" && m.statusErrorDetail != null
      ? { statusErrorDetail: m.statusErrorDetail }
      : {}),
    // Both reaction sides (null/absent ⇒ none) — the customer's and our own —
    // hydrated so a refresh stays consistent with the live `message:reaction`
    // socket frames, which patch each side independently.
    ...(m.reaction ? { reaction: m.reaction } : {}),
    ...(m.agentReaction ? { agentReaction: m.agentReaction } : {}),
    // Customer 👍/👎 feedback on our outbound (Messenger response_feedback) —
    // a distinct chip, hydrated so a refresh matches the live message:updated.
    ...(m.feedback === "positive" || m.feedback === "negative"
      ? { feedback: m.feedback }
      : {}),
    // Structured content (location pin / contact card) → dedicated bubble. The
    // JSONB round-trips as the discriminated MessageStructured shape.
    ...(m.structured
      ? { structured: m.structured as unknown as Message["structured"] }
      : {}),
    // Ad / deep-link attribution — hydrated for the "from your ad" chip.
    ...(m.attribution
      ? { attribution: m.attribution as unknown as Message["attribution"] }
      : {}),
    // Unsend / edit — hydrated so a refresh matches the live `message:updated`
    // frame (tombstone / "edited" marker).
    ...(m.deletedAt ? { deletedAt: m.deletedAt.toISOString() } : {}),
    ...(m.editedAt ? { editedAt: m.editedAt.toISOString() } : {}),
    ...(m.replyToMessageId
      ? {
          replyToMessageId: m.replyToMessageId,
          replyTo: mapReplySnapshot(m.replyTo) ?? undefined,
        }
      : {}),
    ...(m.mediaKind && m.mediaMimeType
      ? {
          media: {
            kind: m.mediaKind as MediaAttachment["kind"],
            // Authenticated stream — never leaks the on-disk path.
            url: `/api/media/${m.id}`,
            mimeType: m.mediaMimeType,
            sizeBytes: m.mediaSizeBytes ?? 0,
            ...(m.mediaCaption ? { caption: m.mediaCaption } : {}),
            ...(m.mediaFilename ? { filename: m.mediaFilename } : {}),
            ...(m.mediaDurationMs != null ? { durationMs: m.mediaDurationMs } : {}),
            ...(m.mediaVoice ? { voice: true } : {}),
            // Video poster — only set when the inbound ingest extracted +
            // uploaded a first-frame JPEG via ffmpeg. Older rows + outbound
            // video sends leave mediaThumbnailUrl NULL; the VideoBlock
            // gracefully falls back to bg-black when thumbnailUrl is absent.
            ...(m.mediaThumbnailUrl
              ? { thumbnailUrl: `/api/media/${m.id}/thumb` }
              : {}),
          },
          // Row was inserted before the binary finished downloading — the
          // bubble renders a placeholder until the message:media:ready event
          // (or a later page load) fills it in. Two sources have this
          // background-download path: inbound customer media AND Coexistence
          // echoes (a photo the owner sent from the phone app, downloaded like
          // inbound). A regular API-sent outbound uploads its media BEFORE the
          // row exists, so a missing mediaUrl there is a hard failure
          // (caption-only), not pending.
          ...((m.direction === "in" || m.origin === "business_app") && !m.mediaUrl
            ? { mediaPending: true }
            : {}),
        }
      : {}),
    // Only emitted when the caller actually joined flags AND there are some, so
    // the overwhelmingly common flagless message stays exactly as terse on the
    // wire as it was before flags existed.
    ...(m.flags?.length ? { flags: m.flags.map(mapFlag) } : {}),
  };
}

export function mapNote(n: PrismaNote): InternalNote {
  return {
    id: n.id,
    conversationId: n.conversationId,
    authorUserId: n.authorUserId,
    body: n.body,
    timestamp: n.timestamp.toISOString(),
  };
}

// Activity-log mapper. The Prisma row joins `user`/`apiKey` for the actor
// name; `before`/`after` are the JSONB payloads the audit subscriber wrote.
// `assignedToName` (for the `assigned` kind) can't be joined off the audit row
// — it stores the assignee's *id* in `after.assignedUserId` — so the caller
// passes a pre-built id→name map (batched in getConversationWithRefs) rather
// than this mapper doing an N+1 lookup.
type PrismaActivityEventRow = {
  id: string;
  conversationId: string;
  kind: ConversationEventKind;
  before: unknown;
  after: unknown;
  at: Date;
  userId: string | null;
  apiKeyId: string | null;
  // Set when a workflow step (not a human/api-key) caused the change. There's
  // no FK to join (denormalized actor style — see the schema note), so the
  // caller batch-resolves the name into `workflowNameById`, mirroring the
  // `assigneeNameById` pattern.
  workflowId: string | null;
  user: { name: string } | null;
  apiKey: { name: string } | null;
};

function asJsonObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function mapActivityEvent(
  e: PrismaActivityEventRow,
  assigneeNameById?: Map<string, string>,
  workflowNameById?: Map<string, string>,
): ConversationActivityEvent {
  // Actor precedence: human user > API key > workflow (automation) > system
  // (retention sweeps / unattributed). These are mutually exclusive in practice
  // — a workflow-driven mutation carries `workflowId` and no userId/apiKeyId —
  // but the precedence keeps the resolution deterministic if a row ever set
  // more than one.
  const actorKind: ActivityActorKind = e.user
    ? "user"
    : e.apiKey
      ? "apiKey"
      : e.workflowId
        ? "workflow"
        : "system";
  const actorName = e.user?.name ?? e.apiKey?.name ?? null;
  // null = workflow since deleted (its `workflowId` row survives, but the name
  // can't be resolved) → the timeline renders the generic "Automation" label.
  const actorWorkflowName: string | null | undefined =
    actorKind === "workflow" && e.workflowId
      ? workflowNameById?.get(e.workflowId) ?? null
      : undefined;

  const after = asJsonObject(e.after);
  let assignedToName: string | null | undefined;
  if (e.kind === "assigned") {
    const toId = after?.assignedUserId;
    assignedToName =
      typeof toId === "string"
        ? assigneeNameById?.get(toId) ?? null
        : null; // explicit null = unassigned
  }

  return {
    id: e.id,
    conversationId: e.conversationId,
    kind: e.kind as ConversationEventKind,
    actorName,
    actorKind,
    before: asJsonObject(e.before),
    after,
    at: e.at.toISOString(),
    ...(assignedToName !== undefined ? { assignedToName } : {}),
    ...(actorWorkflowName !== undefined ? { actorWorkflowName } : {}),
  };
}

/**
 * One channel a person is reachable on, with the contact behind it.
 * `conversationId` is that contact's thread — always `null` unless the caller
 * passed `withConversation`, since resolving it costs a correlated subquery per
 * sibling and the contacts list only needs the channel set.
 */
export type SiblingChannel = {
  contactId: string;
  channel: Channel;
  conversationId: string | null;
};

/**
 * Roll up every non-deleted contact under each `customerId` into its list of
 * channels (the "linked channels" of a unified person). Single source for the
 * cross-channel sibling fetch used by both the contacts list and global search
 * — keeps the query shape (and the tenant `workspaceId` scope) identical in both.
 * Returns an empty map for an empty `customerIds` (no query issued).
 *
 * Pass `withConversation` when the caller lets the user jump straight into a
 * sibling's thread (global search does; the contacts list doesn't).
 */
export async function siblingChannelsByCustomer(
  workspaceId: string,
  customerIds: string[],
  opts?: { withConversation?: boolean },
): Promise<Map<string, SiblingChannel[]>> {
  const byCustomer = new Map<string, SiblingChannel[]>();
  if (customerIds.length === 0) return byCustomer;
  const where = { workspaceId, deletedAt: null, customerId: { in: customerIds } };
  const siblings = opts?.withConversation
    ? await db.contact.findMany({
        where,
        select: {
          id: true,
          customerId: true,
          identityChannel: true,
          conversations: { select: { id: true }, take: 1 },
        },
      })
    : (
        await db.contact.findMany({
          where,
          select: { id: true, customerId: true, identityChannel: true },
        })
      ).map((s) => ({ ...s, conversations: [] as Array<{ id: string }> }));
  for (const s of siblings) {
    if (!s.customerId) continue;
    const list = byCustomer.get(s.customerId) ?? [];
    list.push({
      contactId: s.id,
      channel: s.identityChannel as Channel,
      conversationId: s.conversations[0]?.id ?? null,
    });
    byCustomer.set(s.customerId, list);
  }
  return byCustomer;
}
