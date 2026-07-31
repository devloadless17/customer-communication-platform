/**
 * WHO a SOCIAL campaign can actually reach, and from which account.
 *
 * ## The constraint this module exists to make visible
 *
 * Meta: "A person is assigned a unique page-scoped ID (PSID) for each Facebook
 * Page they start a conversation with." Instagram is the same shape — an IGSID
 * belongs to one Instagram professional account.
 *
 * The id therefore belongs to ONE account, on BOTH social channels. Account B
 * cannot address someone who messaged account A — the id does not resolve there,
 * and there is no cross-account identity for a person anywhere in Meta's API. So
 * "send this to all my customers from one account" is not a thing that can
 * exist on either channel.
 *
 * What CAN exist — and is what an operator actually means — is one campaign that
 * reaches every Messenger customer, with each recipient delivered through the
 * Page they themselves messaged. That makes the sending account a per-RECIPIENT
 * fact, and this module is what tells the composer the truth before anyone
 * schedules a send:
 *
 *   - how many Messenger contacts exist, broken down BY PAGE, and
 *   - which of those Pages actually have the chosen template approved.
 *
 * ## Why the template check is not optional
 *
 * A utility template is owned by the PAGE that created it. A template approved on
 * Page A does not exist on Page B, and sending its name there fails per-recipient
 * with a template-not-found error — a campaign that looks half-delivered for a
 * reason nobody can see from the report. Meta's own guidance is that a template
 * is cloned into each Page's library, so the honest UI is: name the Pages that
 * are missing it and let the operator clone, rather than silently skipping them
 * or silently creating templates on Pages they never named.
 */

import { db } from "@/lib/db";
import { getMessengerSendConfig } from "@/lib/providers/messenger-config";
import { listUtilityTemplates } from "@/lib/providers/messenger-utility-templates";

export interface MessengerPageReach {
  channelConnectionId: string;
  pageId: string;
  /** The Page's human name when we captured it, else its id. */
  label: string;
  /** Contacts on this Page who can be addressed. */
  recipientCount: number;
  /**
   * Whether the requested template is approved ON THIS PAGE. `null` when the
   * template list could not be read — which must NOT be shown as "missing":
   * that would send an operator to clone a template that is already there.
   */
  hasTemplate: boolean | null;
}

export interface MessengerBroadcastReach {
  pages: MessengerPageReach[];
  /** Recipients on Pages that have the template — the campaign's real reach. */
  reachable: number;
  /** Recipients we would have to skip, because their Page lacks the template. */
  blocked: number;
}

/**
 * Reach for a Messenger template campaign across every connected Page.
 *
 * `templateName` is optional: without it this is a pure audience breakdown (how
 * many customers per Page), which is what the composer shows before a template
 * is chosen.
 */
export async function messengerBroadcastReach(
  workspaceId: string,
  templateName?: string,
  channel: "messenger" | "instagram" = "messenger",
): Promise<MessengerBroadcastReach> {
  const connections = await db.channelConnection.findMany({
    where: { workspaceId, channel, isActive: true },
    select: { id: true, externalAccountId: true, label: true, config: true },
  });
  if (connections.length === 0) return { pages: [], reachable: 0, blocked: 0 };

  // Contacts are counted through their CONVERSATION, because that is where the
  // Page pointer lives — a Contact row has an `externalContactId` (the PSID) but
  // nothing that says which Page issued it. Counting any other way would assign
  // people to the wrong Page, which is the exact failure the PSID note above
  // describes.
  const counts = await db.conversation.groupBy({
    by: ["channelConnectionId"],
    where: {
      workspaceId,
      channel,
      channelConnectionId: { in: connections.map((c) => c.id) },
      // A blocked or deleted contact is not reachable, and counting them would
      // overstate the campaign before it runs.
      contact: { blockedAt: null, deletedAt: null },
    },
    _count: { _all: true },
  });
  const countByConnection = new Map(
    counts.map((row) => [row.channelConnectionId ?? "", row._count._all]),
  );

  const pages: MessengerPageReach[] = [];
  for (const conn of connections) {
    const cfg = (conn.config ?? {}) as { pageId?: string; pageName?: string };
    let hasTemplate: boolean | null = null;
    // Only Messenger has an approved-template catalog. Instagram has none, so a
    // template check there would be a question with no answer — `null` (unknown)
    // is the honest value, and it counts as reachable below.
    if (templateName && channel === "messenger") {
      try {
        const sendConfig = await getMessengerSendConfig(workspaceId, conn.id);
        const templates = await listUtilityTemplates({
          accountId: sendConfig.pageId,
          accessToken: sendConfig.pageAccessToken,
          graphVersion: sendConfig.graphVersion,
          label: "messenger",
          ...(sendConfig.appSecret ? { appSecret: sendConfig.appSecret } : {}),
        });
        hasTemplate = templates.some(
          (t) =>
            t.name === templateName &&
            // Only an APPROVED template can be sent; a pending or rejected one
            // exists in the library and still fails every recipient.
            (t.status ?? "").toUpperCase() === "APPROVED",
        );
      } catch {
        // Unreadable ≠ missing. See the field docs on `hasTemplate`.
        hasTemplate = null;
      }
    }
    pages.push({
      channelConnectionId: conn.id,
      pageId: conn.externalAccountId,
      label: conn.label ?? cfg.pageName ?? conn.externalAccountId,
      recipientCount: countByConnection.get(conn.id) ?? 0,
      hasTemplate,
    });
  }

  // `null` (unknown) counts as reachable rather than blocked: refusing to send to
  // a Page because we could not read its library would turn a transient Graph
  // blip into a silently truncated campaign.
  const reachable = pages
    .filter((p) => p.hasTemplate !== false)
    .reduce((n, p) => n + p.recipientCount, 0);
  const blocked = pages
    .filter((p) => p.hasTemplate === false)
    .reduce((n, p) => n + p.recipientCount, 0);

  return { pages, reachable, blocked };
}
