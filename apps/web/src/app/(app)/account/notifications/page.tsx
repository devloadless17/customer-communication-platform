import { NotificationsSettings } from "./notifications-settings";

export const metadata = { title: "Notifications · Settings" };

/**
 * Notification-sound preferences. Personal + per-device (saved in this
 * browser's localStorage via NotificationSoundProvider), so there's NO
 * capability gate and nothing to fetch server-side — every teammate sets their
 * own. Moved here from the AppRail user menu so it lives with the other
 * workspace settings (Lifecycle / Snippets / Tags). The (app) layout already
 * enforces auth + mounts the provider.
 */
export default function NotificationsSettingsPage() {
  return <NotificationsSettings />;
}
