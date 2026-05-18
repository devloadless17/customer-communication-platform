import { z } from "zod";

/**
 * Broadcast create body. Audience is a discriminated union over `mode`;
 * mode-specific fields are required only on their branch. Each branch is
 * tolerant of extra unused fields (e.g. a UI that always sends contactIds=[]
 * for the "all" mode won't 400) — irrelevant fields are silently ignored.
 */

const AudienceAllSchema = z.object({
  mode: z.literal("all"),
});

const AudienceSelectedSchema = z.object({
  mode: z.literal("selected"),
  contactIds: z.array(z.string().min(1)).default([]),
});

const AudienceByTagSchema = z.object({
  mode: z.literal("by_tag"),
  tagIds: z.array(z.string().min(1)).default([]),
});

const AudienceGroupSchema = z.object({
  mode: z.literal("group"),
  groupId: z.string().min(1).nullable().optional(),
});

export const AudienceSchema = z.union([
  AudienceAllSchema,
  AudienceSelectedSchema,
  AudienceByTagSchema,
  AudienceGroupSchema,
]);
export type AudienceInput = z.infer<typeof AudienceSchema>;

export const BroadcastVariablesSchema = z.object({
  body: z.array(z.string()).default([]),
  header: z.string().optional(),
});
export type BroadcastVariablesInput = z.infer<typeof BroadcastVariablesSchema>;

export const CreateBroadcastSchema = z.object({
  templateId: z.string().min(1),
  variables: BroadcastVariablesSchema.default({ body: [] }),
  audience: AudienceSchema,
});
export type CreateBroadcastInput = z.infer<typeof CreateBroadcastSchema>;
