import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

/** Channels whose accounts are ChannelConnection rows (webchat has its own CRUD). */
export const AccountChannelSchema = z.enum(["whatsapp", "messenger", "instagram"]);
export type AccountChannelParam = z.infer<typeof AccountChannelSchema>;

/**
 * Validate the `:channel` path param.
 *
 * There is no `zParam` pipe in this codebase, and a bare `.parse` would surface an
 * unhandled ZodError as a 500 — wrong for a caller who simply typed a channel we
 * don't manage accounts for (`telegram`, `webchatwidget`). 400 with the allowed set.
 */
export function parseAccountChannel(value: string): AccountChannelParam {
  const parsed = AccountChannelSchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({
      error: "unsupported_channel",
      detail: `channel must be one of: ${AccountChannelSchema.options.join(", ")}`,
    });
  }
  return parsed.data;
}

export const RenameAccountSchema = z.object({
  label: z.string().trim().max(60).nullable(),
});
export type RenameAccountInput = z.infer<typeof RenameAccountSchema>;
