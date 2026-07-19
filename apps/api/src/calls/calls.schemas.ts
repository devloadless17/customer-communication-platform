import { z } from "zod";

/**
 * Request body schemas for the WhatsApp calling endpoints. Validation lives
 * here so the controller stays declarative — zBody(...) at the route, then
 * the typed input flows into the service.
 */

/**
 * Outbound-call initiation body.
 *
 * `sdp` is the WebRTC OFFER the agent's browser generated via
 * `RTCPeerConnection.createOffer` — Meta's calling API requires it on the
 * connect payload (otherwise error 131009 "Missing session parameter").
 * Same upper bound as the answer SDP — well above any real SDP size
 * (~3-5KB typical).
 */
export const InitiateCallSchema = z
  .object({
    sdp: z.string().min(1).max(64_000),
  })
  .strict();
export type InitiateCallInput = z.infer<typeof InitiateCallSchema>;

/** Permission request — no body. */
export const RequestCallPermissionSchema = z.object({}).strict();
export type RequestCallPermissionInput = z.infer<typeof RequestCallPermissionSchema>;

/**
 * Answer body — the SDP the browser generated via RTCPeerConnection.createAnswer.
 * Bounded length so a malformed POST can't pin the gateway with a huge SDP.
 */
export const AnswerCallSchema = z
  .object({
    sdp: z.string().min(1).max(64_000),
  })
  .strict();
export type AnswerCallInput = z.infer<typeof AnswerCallSchema>;

/**
 * Media-update body — the SDP ANSWER the browser generated in reply to Meta's
 * mid-call renegotiation OFFER (Messenger `media_update`). Same bounded shape
 * as the answer body.
 */
export const MediaUpdateSchema = z
  .object({
    sdp: z.string().min(1).max(64_000),
  })
  .strict();
export type MediaUpdateInput = z.infer<typeof MediaUpdateSchema>;

/** Reject body — optional reason ("busy" | "declined"). */
export const RejectCallSchema = z
  .object({
    reason: z.enum(["busy", "declined"]).optional(),
  })
  .strict();
export type RejectCallInput = z.infer<typeof RejectCallSchema>;

/** End body — no fields. */
export const EndCallSchema = z.object({}).strict();
export type EndCallInput = z.infer<typeof EndCallSchema>;

/** Listing — keyset cursor on (ringingAt DESC, id DESC). */
export const ListCallsQuerySchema = z
  .object({
    take: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  })
  .strict();
export type ListCallsQuery = z.infer<typeof ListCallsQuerySchema>;

/**
 * Team-wide Calls-page listing — keyset cursor PLUS optional filters:
 *   q    — substring match on the contact's name OR phone number
 *   from — only calls with ringingAt >= this instant (ISO; the client sends the
 *          start of the selected local day so the date range respects the
 *          agent's timezone)
 *   to   — only calls with ringingAt <= this instant (ISO; end of local day)
 * Filters compose with the cursor (AND), so pagination walks the filtered set.
 */
export const ListTeamCallsQuerySchema = z
  .object({
    take: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
    /** 1-based page for numbered pagination. When present the query runs in
     *  offset mode (cursor ignored, totalCount returned). Upper-bounded for
     *  the same reason as the contacts list: offset paging scans and discards
     *  everything before the offset, so an unbounded page number lets a client
     *  ask for a full scan that returns nothing. */
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    q: z.string().trim().max(100).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();
export type ListTeamCallsQuery = z.infer<typeof ListTeamCallsQuerySchema>;
