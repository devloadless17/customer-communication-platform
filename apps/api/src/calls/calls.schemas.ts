import { z } from "zod";

/**
 * Request body schemas for the WhatsApp calling endpoints. Validation lives
 * here so the controller stays declarative — zBody(...) at the route, then
 * the typed input flows into the service.
 */

/** No body — call target is derived from the conversation's contact. */
export const InitiateCallSchema = z.object({}).strict();
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

/**
 * ICE candidate body. `candidate` can be the empty string (browser signals
 * end-of-candidates that way), so it's only required to exist; sdpMid /
 * sdpMLineIndex can be null per WebRTC's contract.
 */
export const IceCandidateSchema = z
  .object({
    candidate: z.string(),
    sdpMid: z.string().nullable(),
    sdpMLineIndex: z.number().int().nullable(),
  })
  .strict();
export type IceCandidateInput = z.infer<typeof IceCandidateSchema>;

/** Listing — keyset cursor on (ringingAt DESC, id DESC). */
export const ListCallsQuerySchema = z
  .object({
    take: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  })
  .strict();
export type ListCallsQuery = z.infer<typeof ListCallsQuerySchema>;
