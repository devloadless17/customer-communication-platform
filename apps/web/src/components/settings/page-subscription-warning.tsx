/**
 * Health banner for the Facebook Page ↔ app webhook subscription.
 *
 * A Page can be "connected" with perfect credentials and still receive NOTHING:
 * Meta only delivers webhooks for the fields the Page is subscribed to, and a
 * re-save in Meta's dashboard silently resets that set (observed 2026-07-10 —
 * `subscribed_fields: ["name"]`, zero Messenger inbound for days, with WhatsApp
 * and Instagram unaffected because they subscribe separately).
 *
 * Shared by the Messenger and Instagram settings pages: Instagram DMs ride the
 * SAME linked Page, so the failure and the remedy are identical.
 */
export interface PageSubscription {
  receivesMessages: boolean;
  subscribedFields: string[];
  missingFields: string[];
}

export function PageSubscriptionWarning({
  subscription,
  channelLabel,
}: {
  subscription: PageSubscription | null | undefined;
  channelLabel: string;
}) {
  if (!subscription) return null;

  if (!subscription.receivesMessages) {
    return (
      <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
        This Page is <strong>not subscribed to the “messages” webhook</strong>, so Meta will never
        deliver an inbound {channelLabel} message. Press <strong>Edit → Save</strong> to
        re-subscribe it, or fix it in Meta → Webhooks.
      </p>
    );
  }

  if (subscription.missingFields.length > 0) {
    return (
      <p className="mt-4 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
        Messages are arriving, but this Page isn’t subscribed to:{" "}
        <strong>{subscription.missingFields.join(", ")}</strong>. Those events (reactions, edits,
        read receipts…) won’t reach the inbox. Press Edit → Save to re-subscribe.
      </p>
    );
  }

  return null;
}
