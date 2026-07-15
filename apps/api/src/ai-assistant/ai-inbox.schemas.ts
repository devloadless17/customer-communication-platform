import { z } from "zod";

export const StateActionSchema = z
  .object({ action: z.enum(["pause", "resume", "takeover", "enable", "disable"]) })
  .strict();
export type StateActionInput = z.infer<typeof StateActionSchema>;

export const SuggestionDecisionSchema = z
  .object({
    action: z.enum(["accept", "reject"]),
    editedText: z.string().max(20000).optional(),
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
