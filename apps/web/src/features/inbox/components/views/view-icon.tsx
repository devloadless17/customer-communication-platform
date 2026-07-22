import {
  Bookmark,
  CircleAlert,
  Clock,
  Filter,
  Flame,
  Inbox,
  LifeBuoy,
  MessageCircle,
  Shield,
  ShoppingCart,
  Star,
  Target,
  TrendingUp,
  User,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";

import {
  DEFAULT_INBOX_VIEW_ICON,
  INBOX_VIEW_ICONS,
  type InboxViewIcon,
} from "@ccp/shared/inbox-views/types";

/**
 * Icon KEY → component. A view stores the key, never a component name, so a
 * value that somehow reached the database can only ever select from this
 * table — and an unknown one degrades to the default instead of rendering
 * `undefined` and blanking the rail.
 *
 * `Record<InboxViewIcon, …>` is load-bearing: adding a key to
 * INBOX_VIEW_ICONS without adding it here is a compile error, not a silently
 * missing icon in the picker.
 */
const ICONS: Record<InboxViewIcon, LucideIcon> = {
  inbox: Inbox,
  star: Star,
  flame: Flame,
  zap: Zap,
  users: Users,
  user: User,
  filter: Filter,
  bookmark: Bookmark,
  target: Target,
  shield: Shield,
  clock: Clock,
  "circle-alert": CircleAlert,
  "message-circle": MessageCircle,
  "shopping-cart": ShoppingCart,
  "life-buoy": LifeBuoy,
  "trending-up": TrendingUp,
};

export function viewIcon(key: string | null | undefined): LucideIcon {
  return ICONS[key as InboxViewIcon] ?? ICONS[DEFAULT_INBOX_VIEW_ICON];
}

/** Every icon, in picker order. */
export const VIEW_ICON_OPTIONS: Array<{ key: InboxViewIcon; Icon: LucideIcon }> =
  INBOX_VIEW_ICONS.map((key) => ({ key, Icon: ICONS[key] }));
