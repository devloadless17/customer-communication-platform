import { z } from "zod";

export const SwitchWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
});
export type SwitchWorkspaceInput = z.infer<typeof SwitchWorkspaceSchema>;

export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(60),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

export const RenameWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(60),
});
export type RenameWorkspaceInput = z.infer<typeof RenameWorkspaceSchema>;

export const SetMembershipSchema = z.object({
  userId: z.string().min(1),
  /** `null` removes the person from the workspace entirely. */
  role: z.enum(["admin", "manager", "agent"]).nullable(),
});
export type SetMembershipInput = z.infer<typeof SetMembershipSchema>;

export const RenameOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export type RenameOrganizationInput = z.infer<typeof RenameOrganizationSchema>;
