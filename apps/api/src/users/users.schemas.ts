import { z } from "zod";

export const UpdateUserSchema = z
  .object({
    role: z.string().optional(),
    deactivated: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no changes" });
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

/**
 * Self-edit schema for `PATCH /api/users/me`. Deliberately narrow — name +
 * avatarUrl only. Email is identity-bound (Better Auth login) and changing
 * it needs an out-of-band verification flow; role is admin-managed; team is
 * fixed at signup. `avatarUrl: null` clears the avatar (revert to initials),
 * `avatarUrl: "<url>"` swaps it. The url itself is validated as one of our
 * own blob-storage hosts to keep this endpoint from being abused as a
 * hot-link target for arbitrary image URLs.
 */
export const UpdateMyProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    avatarUrl: z.union([z.string().url().max(500), z.null()]).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no changes" });
export type UpdateMyProfileInput = z.infer<typeof UpdateMyProfileSchema>;
