import { z } from "zod";

import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from "@ccp/shared/auth/password-policy";

export const CreateInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  /** Optional — falls back to "agent" if missing OR not assignable by caller. */
  role: z.string().optional(),
});
export type CreateInviteInput = z.infer<typeof CreateInviteSchema>;

// POST /api/invites/accept — unauthenticated, the token IS the auth.
// Length bounds match validatePasswordStructure() in
// apps/api/src/lib/auth/password.ts; the service runs the breach check.
export const AcceptInviteSchema = z.object({
  token: z.string().min(1, "token required"),
  name: z.string().trim().min(1, "name required").max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteSchema>;
