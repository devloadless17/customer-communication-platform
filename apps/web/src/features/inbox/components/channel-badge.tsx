import { Camera, Mail, MessageSquare, MessagesSquare, Send } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import type { Channel } from "@ccp/shared/types";

/**
 * Per-channel visual mark. WhatsApp is intentionally `null` — an inbox that's
 * only ever had WhatsApp shouldn't sprout an icon on every row; the badge earns
 * its place only where it disambiguates (Messenger / Instagram / future
 * channels). Brand hues, kept subtle. telegram/email/sms are wired here so the
 * UI is ready even though those channels aren't live yet.
 */
const CHANNEL_META: Record<
  Channel,
  { label: string; Icon: typeof MessagesSquare; className: string } | null
> = {
  whatsapp: null,
  messenger: { label: "Messenger", Icon: MessagesSquare, className: "text-[#0084FF]" },
  instagram: { label: "Instagram", Icon: Camera, className: "text-[#E4405F]" },
  telegram: { label: "Telegram", Icon: Send, className: "text-[#229ED9]" },
  email: { label: "Email", Icon: Mail, className: "text-muted-foreground" },
  sms: { label: "SMS", Icon: MessageSquare, className: "text-muted-foreground" },
};

/** Human label per channel — for badges, headers, and the contact panel. */
export const CHANNEL_LABEL: Record<Channel, string> = {
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  telegram: "Telegram",
  email: "Email",
  sms: "SMS",
};

export function ChannelBadge({
  channel,
  className,
}: {
  channel: Channel;
  className?: string;
}) {
  const meta = CHANNEL_META[channel];
  if (!meta) return null;
  const { label, Icon, className: color } = meta;
  return (
    <Icon
      role="img"
      aria-label={label}
      className={cn("size-3.5 shrink-0", color, className)}
    />
  );
}
