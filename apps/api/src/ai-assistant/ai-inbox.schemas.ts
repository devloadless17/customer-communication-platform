import { z } from "zod";

// Agents can pause/resume/take-over the assistant — there is no separate
// "disable" anymore (removed 2026-07; see conversation-state.ts).
export const StateActionSchema = z
  .object({ action: z.enum(["pause", "resume", "takeover"]) })
  .strict();
export type StateActionInput = z.infer<typeof StateActionSchema>;

/**
 * GET .../summary query — agent-selected date range for an on-demand summary
 * spanning the WHOLE conversation (distinct from the auto-generated "Latest
 * Session Summary"). Stateless: not persisted, generated fresh on every call.
 */
export const SummaryRangeQuerySchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .strict()
  .refine((v) => new Date(v.from).getTime() <= new Date(v.to).getTime(), {
    message: "from must be before to",
  });
export type SummaryRangeQuery = z.infer<typeof SummaryRangeQuerySchema>;

export const SuggestionDecisionSchema = z
  .object({
    action: z.enum(["accept", "reject"]),
    editedText: z.string().max(20000).optional(),
    // "Send as Voice" vs "Send as Text" for a draft (default text).
    sendAs: z.enum(["text", "voice"]).optional(),
  })
  .strict();
export type SuggestionDecisionInput = z.infer<typeof SuggestionDecisionSchema>;

export const PatchMemorySchema = z
  .object({
    status: z.enum(["confirmed", "rejected", "candidate"]).optional(),
    value: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.value !== undefined, {
    message: "status or value required",
  });
export type PatchMemoryInput = z.infer<typeof PatchMemorySchema>;

export const CorrectTranscriptionSchema = z
  .object({ correctedText: z.string().max(20000) })
  .strict();
export type CorrectTranscriptionInput = z.infer<typeof CorrectTranscriptionSchema>;
