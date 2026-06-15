import { Archive, CircleCheck, CircleDashed } from "lucide-react";

import type { ConversationStatus } from "@ccp/shared/types";

/**
 * Single source of truth for conversation-status presentation (label + icon +
 * colour). Previously duplicated across status-dropdown.tsx (twice — the
 * trigger map carried dark-mode variants, the menu map dropped them, so the
 * trigger and its menu items rendered different greens in dark mode) and
 * contact-panel.tsx's STATUS_LABEL. Derive every call site from this so a 4th
 * status (or a colour tweak) is a one-file change.
 *
 * `cls` always carries the dark-mode variant — that's the fix for the
 * trigger-vs-menu mismatch the audit flagged.
 */
export interface StatusMeta {
  label: string;
  icon: typeof CircleCheck;
  cls: string;
}

export const STATUS_META: Record<ConversationStatus, StatusMeta> = {
  open: { label: "Open", icon: CircleDashed, cls: "text-success-fg" },
  pending: { label: "Pending", icon: CircleDashed, cls: "text-warning-fg" },
  closed: { label: "Closed", icon: Archive, cls: "text-muted-foreground" },
};
