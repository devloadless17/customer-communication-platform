import { z } from "zod";

import { MESSAGE_FLAG_STATUSES } from "@ccp/shared/message-flags/types";

/**
 * Zod schemas for raising / resolving individual message flags and reading the
 * triage queue. The CATALOG (which flags exist) has its own schemas — see
 * apps/api/src/team/message-flags/message-flags-catalog.schemas.ts.
 */

const StatusSchema = z.enum(
  MESSAGE_FLAG_STATUSES as unknown as [string, ...string[]],
);

export const RaiseFlagSchema = z.object({
  messageId: z.string().min(1),
  definitionId: z.string().min(1),
  note: z.string().trim().max(1000).optional(),
  /** Optional owner at raise time — "this complaint is Sara's". */
  assignedToId: z.string().min(1).nullable().optional(),
});
export type RaiseFlagInput = z.infer<typeof RaiseFlagSchema>;

export const UpdateFlagSchema = z
  .object({
    status: StatusSchema.optional(),
    // Explicit null clears the owner; omitted leaves it unchanged. The
    // three-way (undefined | null | id) is why this can't be a bare optional
    // string — "unassign" and "don't touch" are different intents.
    assignedToId: z.string().min(1).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    resolutionNote: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });
export type UpdateFlagInput = z.infer<typeof UpdateFlagSchema>;

/**
 * Queue filters. `status` and `definitionId` are repeatable query params, which
 * Express surfaces as `string | string[]` — the preprocess normalizes both
 * shapes plus the comma-joined form a hand-written client might send.
 */
const CsvArray = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const parts = Array.isArray(v) ? v : String(v).split(",");
  const cleaned = parts.map((p) => String(p).trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}, z.array(z.string()).optional());

export const ListFlagsQuerySchema = z.object({
  status: z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : Array.isArray(v) ? v : String(v).split(",")),
    z.array(StatusSchema).optional(),
  ),
  definitionId: CsvArray,
  /** A user id, or the literal `"unassigned"`, or `"me"` (resolved server-side
   *  from the session so the client doesn't have to know its own id). */
  assignedTo: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  take: z.coerce.number().int().min(1).max(50).optional(),
  /** Free-text over the message body/caption, the contact, and the flag notes. */
  q: z.string().trim().min(1).max(200).optional(),
});
export type ListFlagsQuery = z.infer<typeof ListFlagsQuerySchema>;
