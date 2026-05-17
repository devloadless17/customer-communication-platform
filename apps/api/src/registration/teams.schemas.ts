import { z } from "zod";

export const CreateTeamSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type CreateTeamInput = z.infer<typeof CreateTeamSchema>;
