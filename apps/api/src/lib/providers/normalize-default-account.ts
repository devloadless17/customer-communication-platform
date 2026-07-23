import { db } from "@/lib/db";
import type { Channel } from "@ccp/shared/types";

/**
 * After a real credentialed account is connected, guarantee the channel holds
 * exactly one ACTIVE default and no leftover placeholder row.
 *
 * WHY THIS EXISTS. `getConfig` (which runs on every settings-page load, before
 * the operator has pasted anything) pre-mints a credential-less verify-token
 * placeholder `ChannelConnection`. It is keyed on `externalAccountId: ""` —
 * there is no real account id yet — and hardcoded `isDefault: true`,
 * `isActive: false`.
 *
 * When the operator then pastes real credentials, `updateConfig` upserts keyed
 * on the REAL account id (phoneNumberId / pageId / igId). That is a DIFFERENT
 * key from `""`, so it CREATEs a second row — and the create's
 * `isDefault: !(count)` evaluates to `false` because the placeholder already
 * counts as 1. The workspace is left with the inactive `""` placeholder as its
 * `isDefault: true` account and the real, credentialed account as non-default.
 *
 * Every default resolution then picks the wrong row:
 *   - `getMeta/Messenger/InstagramWebhookConfig` reads the isDefault placeholder
 *     → no appSecret → inbound HMAC verify fails → webhook 403 → Meta drops the
 *     event after retries → ALL INBOUND SILENTLY LOST.
 *   - default-account outbound (broadcasts, compose-new) resolves the
 *     placeholder → `ProviderNotConfiguredError` → default sends fail.
 *
 * This normalises both away, idempotently, and is safe to call on every
 * connect (including re-pasting creds and connecting a 2nd/3rd account).
 */
export async function normalizeDefaultAccount(
  workspaceId: string,
  channel: Channel,
  connectedAccountId: string,
): Promise<void> {
  // 1. Drop the credential-less placeholder(s). Only the `""`-keyed rows — a
  //    real account always has a non-empty provider id, so this can never
  //    touch a genuine connection.
  await db.channelConnection.deleteMany({
    where: { workspaceId, channel, externalAccountId: "" },
  });

  // 2. Ensure exactly one ACTIVE default. If the current default is missing or
  //    inactive — e.g. the placeholder we just deleted WAS the default — promote
  //    the account that was just connected. When a real active default already
  //    exists (re-pasting creds, or adding a 2nd number), leave it untouched so
  //    this never steals the default from an established account.
  const activeDefault = await db.channelConnection.count({
    where: { workspaceId, channel, isDefault: true, isActive: true },
  });
  if (activeDefault === 0) {
    await db.$transaction([
      db.channelConnection.updateMany({
        where: { workspaceId, channel, isDefault: true },
        data: { isDefault: false },
      }),
      db.channelConnection.updateMany({
        where: { workspaceId, channel, externalAccountId: connectedAccountId },
        data: { isDefault: true },
      }),
    ]);
  }
}
