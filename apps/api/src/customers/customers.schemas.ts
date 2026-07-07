import { z } from "zod";

/** POST /api/customers/:id/link — join a contact to this customer (person). */
export const LinkContactSchema = z.object({
  contactId: z.string().trim().min(1),
});
export type LinkContactInput = z.infer<typeof LinkContactSchema>;

/** POST /api/customers/:id/unlink — split a contact off to its own customer. */
export const UnlinkContactSchema = z.object({
  contactId: z.string().trim().min(1),
});
export type UnlinkContactInput = z.infer<typeof UnlinkContactSchema>;
