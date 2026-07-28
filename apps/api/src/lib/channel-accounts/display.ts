import type { Prisma } from "@prisma/client";

/** The subset of a ChannelConnection any display name needs. */
export interface ChannelAccountNameSource {
  label: string | null;
  externalAccountId: string;
  config: Prisma.JsonValue;
}

/**
 * The provider's own human identifier for an account, when it has one.
 *
 * Each channel puts it somewhere different — a WhatsApp number's display form,
 * a Page's name, an Instagram handle — so this is the one place that knows
 * which key to read per channel.
 */
export function channelAccountProviderName(
  config: Prisma.JsonValue,
): string | null {
  const cfg = (config ?? {}) as {
    displayPhoneNumber?: string;
    pageName?: string;
    igUsername?: string;
  };
  return (
    cfg.displayPhoneNumber ??
    cfg.pageName ??
    (cfg.igUsername ? `@${cfg.igUsername}` : undefined) ??
    null
  );
}

/**
 * What a human should SEE for a channel account, everywhere.
 *
 * Precedence: the admin's label (that is the entire point of labelling a number
 * "Sales line"), then the provider's own human name, then the raw account id as
 * a last resort — never blank, because "which number was this?" answered with
 * an empty string is worse than answered with an ugly id.
 *
 * Extracted because three call sites had grown their own copy — the accounts
 * directory, the broadcast report and the calls list — and they had already
 * diverged: the calls list returned `null` instead of falling back to the id,
 * so a number with no label and no captured display number showed nothing at
 * all in the history. One rule, one place.
 */
export function channelAccountDisplayName(
  conn: ChannelAccountNameSource | null | undefined,
): string | null {
  if (!conn) return null;
  return conn.label || channelAccountProviderName(conn.config) || conn.externalAccountId;
}
