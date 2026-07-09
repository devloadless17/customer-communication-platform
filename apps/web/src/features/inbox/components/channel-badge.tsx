import type { JSX } from "react";

import { cn } from "@ccp/shared/utils";
import type { Channel } from "@ccp/shared/types";

/**
 * Real brand logos per channel, so a mixed inbox shows the authentic
 * WhatsApp / Messenger / Instagram marks (not generic glyphs). Each renders
 * inside a small white "chip" so it reads clearly when overlaid on an avatar
 * corner or shown inline. telegram/email/sms are wired for when they go live.
 */

function WhatsAppLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
      <path
        fill="#25D366"
        d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 1.67c2.2 0 4.27.86 5.83 2.42a8.2 8.2 0 0 1 2.42 5.82c0 4.54-3.7 8.24-8.25 8.24a8.2 8.2 0 0 1-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24Z"
      />
      <path
        fill="#25D366"
        d="M9.5 7.3c-.19-.42-.38-.43-.56-.44h-.48c-.16 0-.43.06-.66.31-.23.25-.86.85-.86 2.06 0 1.22.89 2.39 1.01 2.56.12.16 1.72 2.76 4.25 3.76 2.1.83 2.53.66 2.98.62.46-.04 1.48-.6 1.68-1.19.21-.58.21-1.08.15-1.19-.06-.1-.23-.16-.48-.29-.25-.12-1.48-.73-1.71-.81-.23-.09-.4-.13-.56.12-.16.25-.64.81-.79.98-.14.16-.29.19-.54.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.38-1.72-.15-.25-.02-.39.1-.51.12-.12.25-.29.37-.44.13-.15.17-.25.25-.42.09-.16.04-.31-.02-.44-.06-.12-.55-1.36-.78-1.86Z"
      />
    </svg>
  );
}

function MessengerLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
      <defs>
        <linearGradient id="ccp-msgr" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#0099FF" />
          <stop offset="0.6" stopColor="#A033FF" />
          <stop offset="0.9" stopColor="#FF5280" />
          <stop offset="1" stopColor="#FF7061" />
        </linearGradient>
      </defs>
      <path
        fill="url(#ccp-msgr)"
        d="M12 2C6.34 2 2 6.13 2 11.7c0 2.91 1.19 5.44 3.14 7.19.16.14.26.35.27.57l.05 1.78c.02.57.6.94 1.12.71l1.99-.88c.17-.07.35-.09.53-.04 1.03.28 2.12.44 3.24.44 5.66 0 10-4.13 10-9.7C22 6.13 17.66 2 12 2Zm6 7.46-2.93 4.67c-.47.74-1.47.93-2.17.4l-2.33-1.75a.6.6 0 0 0-.72 0l-3.16 2.4c-.42.32-.97-.19-.69-.63l2.93-4.66c.47-.74 1.46-.93 2.17-.4l2.33 1.74c.21.16.5.16.72 0l3.15-2.39c.42-.32.98.18.7.62Z"
      />
    </svg>
  );
}

function InstagramLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
      <defs>
        <linearGradient id="ccp-ig" x1="0.1" y1="0.95" x2="0.9" y2="0.05">
          <stop offset="0" stopColor="#FEDA75" />
          <stop offset="0.25" stopColor="#FA7E1E" />
          <stop offset="0.5" stopColor="#D62976" />
          <stop offset="0.75" stopColor="#962FBF" />
          <stop offset="1" stopColor="#4F5BD5" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#ccp-ig)" />
      <rect
        x="5.4"
        y="5.4"
        width="13.2"
        height="13.2"
        rx="4"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
      />
      <circle cx="12" cy="12" r="3.4" fill="none" stroke="#fff" strokeWidth="1.7" />
      <circle cx="16.6" cy="7.4" r="1.15" fill="#fff" />
    </svg>
  );
}

function TelegramLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#229ED9" />
      <path
        fill="#fff"
        d="M17.5 7.2 15.4 17c-.16.7-.58.87-1.17.54l-3.24-2.39-1.56 1.5c-.17.17-.32.32-.66.32l.24-3.3 6.02-5.44c.26-.23-.06-.36-.4-.13L6.9 12.5l-3.2-1c-.7-.22-.71-.7.15-1.03l12.5-4.82c.58-.21 1.09.14.9.98Z"
      />
    </svg>
  );
}

const LOGOS: Record<Channel, (() => JSX.Element) | null> = {
  whatsapp: WhatsAppLogo,
  messenger: MessengerLogo,
  instagram: InstagramLogo,
  telegram: TelegramLogo,
  email: null,
  sms: null,
};

/** Human label per channel — for headers, the contact panel, and a11y. */
export const CHANNEL_LABEL: Record<Channel, string> = {
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  telegram: "Telegram",
  email: "Email",
  sms: "SMS",
};

/**
 * The channel's real logo in a small white chip. `className` sizes the chip
 * (default `size-4`); pass positioning for an avatar-corner overlay.
 */
export function ChannelBadge({
  channel,
  className,
}: {
  channel: Channel;
  className?: string;
}) {
  const Logo = LOGOS[channel];
  if (!Logo) return null;
  return (
    <span
      role="img"
      aria-label={CHANNEL_LABEL[channel]}
      title={CHANNEL_LABEL[channel]}
      className={cn(
        "inline-flex size-4 items-center justify-center overflow-hidden rounded-full bg-white p-px shadow-sm ring-1 ring-black/5 dark:ring-white/10",
        className,
      )}
    >
      <Logo />
    </span>
  );
}
