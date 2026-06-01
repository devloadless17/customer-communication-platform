import { z } from "zod";

// Match the sibling caps in contacts.schemas.ts: tag selections are small,
// explicit contact selections are bounded by the in-process broadcast ceiling.
// Without these, a malformed/abusive request could pass a multi-MB id array
// into ownedTagIds/ownedContactIds (a huge `IN (...)`), unlike every sibling.
const MAX_TAG_IDS = 200;
const MAX_CONTACT_IDS = 5000;

export const CreateAudienceGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z
    .union([z.string().trim().max(500), z.null()])
    .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
    .optional(),
  tagIds: z.array(z.string().min(1)).max(MAX_TAG_IDS).default([]),
  contactIds: z.array(z.string().min(1)).max(MAX_CONTACT_IDS).default([]),
});
export type CreateAudienceGroupInput = z.infer<typeof CreateAudienceGroupSchema>;

export const UpdateAudienceGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z
      .union([z.string().trim().max(500), z.null()])
      .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
      .optional(),
    tagIds: z.array(z.string().min(1)).max(MAX_TAG_IDS).optional(),
    contactIds: z.array(z.string().min(1)).max(MAX_CONTACT_IDS).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });
export type UpdateAudienceGroupInput = z.infer<typeof UpdateAudienceGroupSchema>;
