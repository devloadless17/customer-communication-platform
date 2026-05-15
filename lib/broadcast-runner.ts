import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  countTemplatePlaceholders,
  MetaSendError,
  normalizeMetaSendError,
  renderTemplateBody,
} from "@/lib/providers/meta";
import { emitToTeam } from "@/lib/socket/server";
import {
  parseVariableBindings,
  resolveBinding,
  type VariableBindings,
} from "@/lib/template-bindings";
import { resolveFieldTokens } from "@/lib/field-tokens";
import type { Message } from "@/lib/types";

/**
 * Broadcast iteration runner.
 *
 *   1) Atomically claim the broadcast (`queued` → `running`) — bails if some
 *      other runner already won, so two concurrent POSTs / a retry can't
 *      double-send.
 *   2) For each recipient (status=queued), in order:
 *        a) Resolve / create the contact's most recent non-closed conversation.
 *        b) Call provider.sendTemplate. If this throws, the recipient is
 *           marked `failed` and we move on. If it SUCCEEDS, we immediately
 *           CAS-flip the recipient to `sent` so a later DB hiccup can never
 *           re-send (Meta has already charged us).
 *        c) Best-effort: insert the Message row + bump the conversation +
 *           emit `message:new`. Failures here are LOGGED, not propagated —
 *           the recipient is already `sent`, the message went out.
 *   3) Stamp `completed` / `failed`, emit `broadcast:status`.
 *
 * Fire-and-forget: callers POST to `/api/broadcasts` which kicks this off via
 * `setImmediate` so the HTTP response returns immediately with the new id.
 *
 * Tradeoff: this runs in-process on the Next.js server. server.ts has a boot
 * reconciler that flips orphaned `running` rows to `failed` so a restart
 * mid-broadcast doesn't leave them dangling — but in-flight Meta sends from
 * the dead process are not retried (we don't know if they landed).
 *
 * Rate: a 200ms gap between sends keeps us at ~5 msg/sec, well under Meta's
 * default tier 1 limit (1000 unique recipients / 24h, 80 msg/sec hard cap).
 */

const SEND_GAP_MS = 200;

interface BroadcastVariables {
  body: string[];
  header?: string;
}

export async function startBroadcast(broadcastId: string): Promise<void> {
  // Fire-and-forget — the caller doesn't await this; we explicitly catch so
  // the unhandled rejection doesn't crash the server.
  void runBroadcast(broadcastId).catch((err) => {
    console.error(`[broadcast ${broadcastId}] runner crashed`, err);
  });
}

async function runBroadcast(broadcastId: string): Promise<void> {
  // Read the broadcast (without claiming yet) so we can validate the template
  // shape before flipping it to `running`. A validation failure should leave
  // the row as `queued` so the user can edit + retry.
  const broadcast = await db.broadcast.findUnique({
    where: { id: broadcastId },
    include: {
      recipients: {
        where: { status: "queued" },
        // Stable order so re-runs would process consistently. Mostly cosmetic.
        orderBy: { id: "asc" },
        include: { contact: true },
      },
    },
  });

  if (!broadcast) {
    console.warn(`[broadcast ${broadcastId}] not found at start`);
    return;
  }
  if (broadcast.status !== "queued") {
    // Already claimed by another runner / completed / explicitly failed —
    // never restart it from here. The reconciler on boot is the only thing
    // that revives `running` rows (by failing them).
    return;
  }

  let config;
  try {
    config = await getMetaSendConfig(broadcast.teamId);
  } catch (err) {
    const msg =
      err instanceof ProviderNotConfiguredError
        ? `WhatsApp not connected: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    await fail(broadcast.id, msg);
    return;
  }

  const provider = getMetaProvider();
  if (!provider.sendTemplate) {
    await fail(broadcast.id, "provider does not support templates");
    return;
  }

  const variables = parseVariables(broadcast.variables);
  // Hoist what doesn't change between recipients: the template body (for the
  // placeholder count + DB-side rendering preview) and its variable bindings.
  // Bindings define WHICH variables are pulled per-recipient and which use
  // the broadcast's literal value (the legacy "same for everyone" path).
  const template = await loadTemplate(broadcast.teamId, broadcast.templateId);
  const templateBody = template.bodyText;
  const bindings = parseVariableBindings(template.variableBindings);
  const bodyVarCount = countTemplatePlaceholders(templateBody);
  if (variables.body.length !== bodyVarCount) {
    await fail(
      broadcast.id,
      `Variable count mismatch: template expects ${bodyVarCount}, broadcast has ${variables.body.length}. Template may have changed since the broadcast was created.`,
    );
    return;
  }

  // Compare-and-swap: claim the broadcast atomically. If two POSTs raced (or
  // a retry fired before the first finished), only one of them flips
  // `queued` → `running`; the other sees `count === 0` and bails out without
  // sending a single message.
  const claimed = await db.broadcast.updateMany({
    where: { id: broadcast.id, status: "queued" },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  emitToTeam(broadcast.teamId, "broadcast:status", {
    teamId: broadcast.teamId,
    broadcastId: broadcast.id,
    status: "running",
  });

  for (const recipient of broadcast.recipients) {
    // Per-recipient conversation resolution. Outside the send try because a
    // DB error here means we DIDN'T touch Meta — safe to mark `failed` and
    // let the user retry.
    let conversationId: string;
    try {
      const existing = await db.conversation.findFirst({
        where: {
          teamId: broadcast.teamId,
          contactId: recipient.contactId,
          status: { not: "closed" },
        },
        orderBy: { lastMessageAt: "desc" },
      });
      const conversation =
        existing ??
        (await db.conversation.create({
          data: {
            teamId: broadcast.teamId,
            contactId: recipient.contactId,
            // New chats land in `pending` — matches the webhook ingest
            // default so a freshly-broadcast contact sits in the triage
            // column until an agent claims (open) or closes it.
            status: "pending",
            lastMessagePreview: "",
          },
        }));
      conversationId = conversation.id;
    } catch (err) {
      await markRecipientFailed(recipient.id, errorDetail(err));
      await bumpCounters(broadcast.id, broadcast.teamId, { failed: 1 });
      if (SEND_GAP_MS > 0) await sleep(SEND_GAP_MS);
      continue;
    }

    // Resolve per-recipient variable values from the template's bindings.
    // For variables bound to `manual`, this returns the broadcast's literal —
    // matches the pre-bindings behavior 1:1. Bound variables pull from the
    // contact row, falling back to the binding's defaultValue and then the
    // broadcast literal.
    const perRecipientVars = resolvePerRecipientVariables(
      bindings,
      variables,
      recipient.contact,
    );

    // The send itself. Anything that throws here counts as a failed recipient
    // — Meta either rejected us or the network died, no message went out.
    let send: Awaited<ReturnType<typeof provider.sendTemplate>>;
    try {
      send = await provider.sendTemplate(
        {
          to: recipient.contact.phoneNumber,
          name: broadcast.templateName,
          language: broadcast.templateLanguage,
          variables: {
            body: perRecipientVars.body,
            ...(perRecipientVars.header ? { header: perRecipientVars.header } : {}),
          },
        },
        config,
      );
    } catch (err) {
      await markRecipientFailed(recipient.id, errorDetail(err));
      await bumpCounters(broadcast.id, broadcast.teamId, { failed: 1 });
      if (SEND_GAP_MS > 0) await sleep(SEND_GAP_MS);
      continue;
    }

    // Send SUCCEEDED. Lock in the recipient as `sent` BEFORE doing any
    // bookkeeping — once Meta has accepted, we must never resend, and any DB
    // wobble after this point would otherwise leave the row as `queued` for
    // a future resume to re-process.
    const recipientLocked = await db.broadcastRecipient.updateMany({
      where: { id: recipient.id, status: "queued" },
      data: {
        status: "sent",
        externalId: send.externalId,
        conversationId,
        sentAt: send.timestamp,
      },
    });
    if (recipientLocked.count === 0) {
      // Another process beat us to it — their recipient row is the source of
      // truth. Skip the bookkeeping below to avoid duplicate Message rows.
      console.warn(
        `[broadcast ${broadcast.id}] recipient ${recipient.id} was already claimed; skipping post-send bookkeeping`,
      );
      if (SEND_GAP_MS > 0) await sleep(SEND_GAP_MS);
      continue;
    }
    await bumpCounters(broadcast.id, broadcast.teamId, { sent: 1 });

    // Best-effort post-send bookkeeping. A failure here is a real bug worth
    // logging, but it must NEVER flip the recipient back to `failed`: the
    // message went out and Meta's already charged us. Worst case the inbox
    // is missing the row until a manual re-fetch.
    try {
      // Render with the same per-recipient values we just sent so the inbox
      // bubble matches what landed in the customer's WhatsApp — not the
      // unresolved literals the agent typed into the broadcast form.
      const renderedBody = renderTemplateBody(templateBody, perRecipientVars.body);
      const preview = renderedBody.slice(0, 200);

      const created = await createOutboundMessageIdempotent({
        teamId: broadcast.teamId,
        conversationId,
        externalId: send.externalId,
        senderUserId: broadcast.createdById,
        body: renderedBody,
        direction: "out",
        provider: "meta_cloud",
        status: "sent",
        rawPayload: {
          sentVia: "broadcast",
          broadcastId: broadcast.id,
          templateId: broadcast.templateId,
          templateName: broadcast.templateName,
          templateLanguage: broadcast.templateLanguage,
          variables,
        } as unknown as Prisma.InputJsonValue,
        timestamp: send.timestamp,
      });

      await db.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: send.timestamp, lastMessagePreview: preview },
      });

      const messagePayload: Message = {
        id: created.id,
        teamId: broadcast.teamId,
        conversationId,
        externalId: send.externalId,
        senderUserId: broadcast.createdById,
        body: renderedBody,
        direction: "out",
        provider: "meta_cloud",
        status: "sent",
        rawPayload: { sentVia: "broadcast", broadcastId: broadcast.id },
        timestamp: send.timestamp.toISOString(),
      };

      emitToTeam(broadcast.teamId, "message:new", {
        teamId: broadcast.teamId,
        conversationId,
        message: messagePayload,
        preview,
        lastMessageAt: send.timestamp.toISOString(),
        unreadDelta: 0,
      });
    } catch (err) {
      console.error(
        `[broadcast ${broadcast.id}] post-send bookkeeping failed for recipient ${recipient.id} (message was sent, externalId=${send.externalId})`,
        err,
      );
    }

    if (SEND_GAP_MS > 0) {
      await sleep(SEND_GAP_MS);
    }
  }

  await db.broadcast.update({
    where: { id: broadcast.id },
    data: { status: "completed", completedAt: new Date() },
  });
  emitToTeam(broadcast.teamId, "broadcast:status", {
    teamId: broadcast.teamId,
    broadcastId: broadcast.id,
    status: "completed",
  });
}

async function markRecipientFailed(recipientId: string, message: string): Promise<void> {
  // CAS so a recipient that was already marked `sent` (or `failed`) by a
  // prior pass isn't reverted.
  await db.broadcastRecipient.updateMany({
    where: { id: recipientId, status: "queued" },
    data: { status: "failed", errorMessage: message.slice(0, 500) },
  });
}

async function bumpCounters(
  broadcastId: string,
  teamId: string,
  delta: { sent?: number; failed?: number },
): Promise<void> {
  const updated = await db.broadcast.update({
    where: { id: broadcastId },
    data: {
      ...(delta.sent ? { sentCount: { increment: delta.sent } } : {}),
      ...(delta.failed ? { failedCount: { increment: delta.failed } } : {}),
    },
    select: { sentCount: true, failedCount: true, totalCount: true },
  });
  // Live progress: each step emits the new counters so a detail page that's
  // watching this broadcast doesn't need to poll.
  emitToTeam(teamId, "broadcast:progress", {
    teamId,
    broadcastId,
    sentCount: updated.sentCount,
    failedCount: updated.failedCount,
    totalCount: updated.totalCount,
  });
}

async function fail(broadcastId: string, message: string): Promise<void> {
  const row = await db.broadcast.update({
    where: { id: broadcastId },
    data: {
      status: "failed",
      lastError: message.slice(0, 1000),
      completedAt: new Date(),
    },
    select: { teamId: true },
  });
  emitToTeam(row.teamId, "broadcast:status", {
    teamId: row.teamId,
    broadcastId,
    status: "failed",
    error: message,
  });
}

async function loadTemplate(
  teamId: string,
  templateId: string,
): Promise<{ bodyText: string; variableBindings: Prisma.JsonValue }> {
  const row = await db.messageTemplate.findFirst({
    where: { id: templateId, teamId },
    select: { bodyText: true, variableBindings: true },
  });
  return {
    bodyText: row?.bodyText ?? "",
    variableBindings: row?.variableBindings ?? {},
  };
}

/**
 * Resolve every variable for ONE recipient.
 *
 * The variable count comes from the broadcast-form payload (validated to match
 * the template above), so we iterate that array and consult the matching
 * binding by index. Missing bindings degrade to `manual` (the legacy path).
 */
function resolvePerRecipientVariables(
  bindings: VariableBindings,
  literals: BroadcastVariables,
  contact: {
    name: string;
    phoneNumber: string;
    email: string | null;
    location: string | null;
    customFields: Prisma.JsonValue;
  },
): BroadcastVariables {
  // Two-layer resolution:
  //   1. `resolveBinding` honors the template's binding (contact_field /
  //      contact_custom_field) — pulls the matching contact value, falls
  //      back to the binding's default, then to the agent-typed literal.
  //   2. Whatever string falls out of that gets a SECOND pass through
  //      `resolveFieldTokens`, which substitutes any `{{contact.X}}` tokens
  //      the agent typed straight into the broadcast input. This is what
  //      makes per-recipient personalization work even on templates without
  //      bindings configured.
  // Plain literals with no tokens pass through unchanged.
  const body = literals.body.map((literal, i) => {
    const bound = resolveBinding(bindings.body[i], literal, contact);
    return resolveFieldTokens(bound, contact);
  });
  const header = literals.header
    ? resolveFieldTokens(
        resolveBinding(bindings.header, literals.header, contact),
        contact,
      )
    : undefined;
  return header ? { body, header } : { body };
}

function parseVariables(v: Prisma.JsonValue): BroadcastVariables {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { body: [] };
  }
  const obj = v as { body?: unknown; header?: unknown };
  const body = Array.isArray(obj.body)
    ? obj.body.filter((x): x is string => typeof x === "string")
    : [];
  const header = typeof obj.header === "string" ? obj.header : undefined;
  return { body, ...(header ? { header } : {}) };
}

function errorDetail(err: unknown): string {
  const normalized = normalizeMetaSendError(err);
  if (normalized) return `${normalized.code}: ${normalized.message}`;
  if (err instanceof MetaSendError) {
    return `Meta ${err.httpStatus}: ${err.body}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
