import { z } from "zod";

import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from "@ccp/shared/tickets/types";

const StatusSchema = z.enum(TICKET_STATUSES as unknown as [TicketStatus, ...TicketStatus[]]);
const PrioritySchema = z.enum(
  TICKET_PRIORITIES as unknown as [TicketPriority, ...TicketPriority[]],
);

/** `a,b,c` → `["a","b","c"]`. Query strings can't carry arrays natively and
 *  repeated `?status=` keys are ambiguous across clients, so one comma list. */
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v, ctx): z.infer<T>[] | undefined => {
      if (!v) return undefined;
      const parsed = z.array(item).safeParse(v.split(",").filter(Boolean));
      if (!parsed.success) {
        // Name the offending values rather than emitting a bare "invalid
        // string" — an integration that sends `?status=don` should be told
        // which value we rejected, not just that its query failed.
        ctx.addIssue({
          code: "custom",
          message: `invalid values: ${parsed.error.issues
            .map((i) => i.path.join("."))
            .join(", ")}`,
        });
        return undefined;
      }
      return parsed.data as z.infer<T>[];
    });

export const ListTicketsQuerySchema = z.object({
  status: csv(StatusSchema),
  priority: csv(PrioritySchema),
  /**
   * `me` resolves server-side to the caller; `none` means UNASSIGNED (a real
   * filter, distinct from omitting the param), and a raw id filters to that
   * teammate.
   */
  assignee: z.string().optional(),
  /**
   * The TEAM queue. `none` means "owned by no team" (a real filter, distinct
   * from omitting the param); a raw Team id filters to that team.
   *
   * Independent of `assignee`, and both together is the useful query: "in
   * Sales' queue AND still unclaimed" is how a team finds work handed to them.
   */
  team: z.string().optional(),
  contactId: z.string().optional(),
  conversationId: z.string().optional(),
  channel: z.string().optional(),
  /**
   * One channel ACCOUNT (`ChannelConnection.id`) — "tickets raised on the
   * Support line".
   *
   * Filtered THROUGH the conversation relation rather than a denormalized
   * column on Ticket. `Ticket.channel` is safe to copy because
   * `Conversation.channel` never changes; `channelConnectionId` is re-stamped
   * whenever the customer messages a different number of ours, so a copy would
   * drift and §7 would demand a reconciler for it.
   */
  accountId: z.string().min(1).optional(),
  tagIds: csv(z.string()),
  breached: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  /** Free-text search: `#47`, a subject, a cause, a customer name, or any
   *  comment on the ticket. */
  q: z.string().trim().max(200).optional(),
  /** Scope the board by a SAVED view. Its criteria are merged UNDER the
   *  explicit query params, so a chip the agent toggles still narrows further. */
  viewId: z.string().min(1).optional(),
  /** Only tickets another workspace escalated to us. */
  shared: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  /** Only tickets somebody replied to YOU on and you haven't read. Per-user,
   *  so it resolves server-side from the session like `assignee=me`. */
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  /** Only work nobody in this workspace has claimed yet (either side). */
  untriaged: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  /**
   * The previous page's `nextCursor.activityAt`. The board sorts by LAST
   * ACTIVITY, so the cursor keys on that — `cursorCreatedAt` is kept as a
   * deprecated alias so an integration mid-pagination when this shipped
   * finishes its walk instead of silently repeating rows.
   */
  cursorActivityAt: z.string().datetime().optional(),
  cursorCreatedAt: z.string().datetime().optional(),
  cursorId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type ListTicketsQuery = z.infer<typeof ListTicketsQuerySchema>;

export const CreateTicketSchema = z.object({
  conversationId: z.string().min(1),
  subject: z.string().trim().max(200).nullable().optional(),
  /** The cause — why the ticket is raised, for whoever it's handed to. */
  description: z.string().trim().max(5000).nullable().optional(),
  priority: PrioritySchema.optional(),
  assignedUserId: z.string().nullable().optional(),
  /** Hand it straight to a team's queue — no person named yet. */
  assignedTeamId: z.string().nullable().optional(),
  tagIds: z.array(z.string()).max(50).optional(),
  customFields: z.record(z.string(), z.string().max(2000)).optional(),
});
export type CreateTicketInput = z.infer<typeof CreateTicketSchema>;

export const UpdateTicketSchema = z
  .object({
    // Sent back from the read so a board drag built on a stale card is
    // rejected rather than silently overwriting a colleague's move.
    expectedVersion: z.number().int().nonnegative().optional(),
    status: StatusSchema.optional(),
    priority: PrioritySchema.optional(),
    assignedUserId: z.string().nullable().optional(),
    /**
     * Hand the ticket to another team (or `null` to take it out of every
     * queue). Independent of `assignedUserId` — see the schema comment on
     * `Ticket.assignedTeamId` for why both exist.
     */
    assignedTeamId: z.string().nullable().optional(),
    /** Why it is being handed over — stored on the `team_changed` event so the
     *  receiving team doesn't have to re-read the thread to find out. */
    handoffReason: z.string().trim().max(2000).optional(),
    subject: z.string().trim().max(200).nullable().optional(),
    /** Edit the cause. */
    description: z.string().trim().max(5000).nullable().optional(),
    resolutionCode: z.string().trim().max(80).nullable().optional(),
    resolutionNote: z.string().trim().max(2000).nullable().optional(),
    tagIds: z.array(z.string()).max(50).optional(),
    customFields: z.record(z.string(), z.string().max(2000)).optional(),
  })
  // An empty PATCH would still bump `version` and fan a realtime frame for a
  // change that changed nothing — the same no-op-publish trap message flags hit.
  .refine((v) => Object.keys(v).some((k) => k !== "expectedVersion"), {
    message: "at least one field must be provided",
  });
export type UpdateTicketInput = z.infer<typeof UpdateTicketSchema>;

export const UpsertSlaPolicySchema = z.object({
  priority: PrioritySchema,
  // `null` is meaningful: no commitment on that leg, which is NOT the same as
  // zero minutes. The domain treats null as "nothing is due".
  firstResponseMins: z.number().int().min(1).max(100_000).nullable(),
  resolutionMins: z.number().int().min(1).max(100_000).nullable(),
  pauseOnHold: z.boolean().optional(),
  pauseWhenPending: z.boolean().optional(),
  businessHoursOnly: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type UpsertSlaPolicyInput = z.infer<typeof UpsertSlaPolicySchema>;

export const CreateTicketFieldSchema = z.object({
  label: z.string().trim().min(1).max(80),
  order: z.number().int().min(0).max(1000).optional(),
});
export type CreateTicketFieldInput = z.infer<typeof CreateTicketFieldSchema>;

export const UpdateTicketFieldSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  order: z.number().int().min(0).max(1000).optional(),
  isVisible: z.boolean().optional(),
});
export type UpdateTicketFieldInput = z.infer<typeof UpdateTicketFieldSchema>;

/**
 * `ticketReopenWindowHours` is RETIRED (2026-08-01): nothing opens or reopens a
 * ticket but a person raising one. Zod strips unknown keys, so an integration
 * still sending it gets a successful no-op rather than a 400; the column stays
 * unread for the same reason.
 */
export const TicketSettingsSchema = z.object({
  /** Solving the LAST active ticket on a thread closes the conversation.
   *  Off by default — conversation status and ticket status are deliberately
   *  independent. */
  ticketCloseConversationOnLastSolved: z.boolean().optional(),
});
export type TicketSettingsInput = z.infer<typeof TicketSettingsSchema>;

/** An internal note on a ticket. Never reaches the customer. */
export const AddTicketNoteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});
export type AddTicketNoteInput = z.infer<typeof AddTicketNoteSchema>;

/**
 * A saved view's criteria. Every field optional and additive — an empty
 * document means "no narrowing", which is what a new view holds before you
 * configure it. Validated on WRITE here; tolerated-and-narrowed on read (see
 * parseTicketViewFilters) so a document from a newer build degrades instead of
 * failing the board.
 */
export const TicketViewFiltersSchema = z.object({
  status: z.array(StatusSchema).max(6).optional(),
  priority: z.array(PrioritySchema).max(4).optional(),
  assignee: z.string().min(1).max(60).optional(),
  team: z.string().min(1).max(60).optional(),
  tagIds: z.array(z.string()).max(50).optional(),
  channel: z.string().min(1).max(40).optional(),
  accountId: z.string().min(1).max(60).optional(),
  breachedOnly: z.boolean().optional(),
  sharedWithUsOnly: z.boolean().optional(),
  untriagedOnly: z.boolean().optional(),
  query: z.string().trim().max(200).optional(),
});

const VisibilitySchema = z.enum(["personal", "shared"]);

export const CreateTicketViewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().trim().max(20).optional(),
  icon: z.string().trim().max(20).optional(),
  visibility: VisibilitySchema.default("personal"),
  filters: TicketViewFiltersSchema.default({}),
});
export type CreateTicketViewInput = z.infer<typeof CreateTicketViewSchema>;

export const UpdateTicketViewSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    color: z.string().trim().max(20).optional(),
    icon: z.string().trim().max(20).optional(),
    visibility: VisibilitySchema.optional(),
    filters: TicketViewFiltersSchema.optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field must be provided" });
export type UpdateTicketViewInput = z.infer<typeof UpdateTicketViewSchema>;

/**
 * Attachment limits. Deliberately far below the 100 MiB message-media ceiling:
 * a ticket file is evidence (a screenshot, an invoice, a form), the buffer is
 * held in memory, and the per-ticket count is capped too — see
 * MAX_TICKET_ATTACHMENTS.
 */
export const TICKET_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Per REQUEST, not per ticket — one comment carries a few files at most. */
export const MAX_FILES_PER_REQUEST = 5;

/**
 * Escalate a ticket to a sibling workspace in the organization. The cause is
 * REQUIRED — it becomes the twin ticket's description and is the whole point
 * of the referral: the receiving workspace must understand the issue without
 * access to the source thread.
 */
export const EscalateTicketSchema = z.object({
  targetWorkspaceId: z.string().min(1),
  cause: z.string().trim().min(1).max(5000),
});
export type EscalateTicketInput = z.infer<typeof EscalateTicketSchema>;

/**
 * A message in the ticket's THREAD — every workspace with access sees it,
 * unlike an internal note. Sent as multipart when it carries files, so the body
 * arrives as a form field.
 *
 * `clientTempId` is the optimistic-send token: the same one twice returns the
 * message that already landed instead of posting a duplicate.
 */
export const PostThreadMessageSchema = z.object({
  /**
   * Empty is ALLOWED when the message carries files — a screenshot with no
   * caption is a perfectly ordinary reply, and the composer has always offered
   * it. `min(1)` here meant every attachment-only reply 400'd as
   * `empty_message`: the row was never written, so the UI showed "Didn't send"
   * AND nobody was notified (no message, no unread marker, no bell). The
   * "message or file" rule is enforced where both are known — the service.
   */
  body: z.string().trim().max(5000).optional().default(""),
  clientTempId: z.string().trim().min(1).max(80).optional(),
});
export type PostThreadMessageInput = z.infer<typeof PostThreadMessageSchema>;
