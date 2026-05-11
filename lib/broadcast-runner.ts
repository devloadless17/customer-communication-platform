import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  countTemplatePlaceholders,
  MetaSendError,
  renderTemplateBody,
} from "@/lib/providers/meta";
import { emitToTeam } from "@/lib/socket-server";
import type { Message } from "@/lib/types";

/**
 * Broadcast iteration runner.
 *
 *   1) Mark broadcast as `running`, stamp startedAt.
 *   2) For each recipient (status=queued), in order:
 *        a) Resolve / create the contact's most recent non-closed conversation.
 *        b) Call provider.sendTemplate with the broadcast's variables.
 *        c) Insert a Message row, bump the conversation summary, emit
 *           `message:new` so the inbox updates live.
 *        d) Update the BroadcastRecipient row (sent or failed).
 *        e) Bump broadcast counters; emit `broadcast:progress`.
 *   3) Stamp `completed` / `failed`, emit `broadcast:status`.
 *
 * Fire-and-forget: callers POST to `/api/broadcasts` which kicks this off via
 * `setImmediate` so the HTTP response returns immediately with the new id.
 *
 * Tradeoff: this runs in-process on the Next.js server. Restart mid-broadcast
 * = orphaned `running` rows. Worth flagging for v2 (a real queue / cron
 * pickup) but acceptable for the pilot's volume.
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
  if (broadcast.status !== "queued" && broadcast.status !== "running") {
    // Already done or failed — don't restart it.
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
  // Validate placeholder counts ONCE up-front — if the template was edited
  // between picking and sending, we want to fail loudly before burning
  // recipient sends.
  const bodyVarCount = countTemplatePlaceholders(
    await loadTemplateBody(broadcast.teamId, broadcast.templateId),
  );
  if (variables.body.length !== bodyVarCount) {
    await fail(
      broadcast.id,
      `Variable count mismatch: template expects ${bodyVarCount}, broadcast has ${variables.body.length}. Template may have changed since the broadcast was created.`,
    );
    return;
  }

  await db.broadcast.update({
    where: { id: broadcast.id },
    data: { status: "running", startedAt: new Date() },
  });
  emitToTeam(broadcast.teamId, "broadcast:status", {
    teamId: broadcast.teamId,
    broadcastId: broadcast.id,
    status: "running",
  });

  for (const recipient of broadcast.recipients) {
    try {
      // Per-recipient conversation resolution. Reuse the most recent non-
      // closed conversation; otherwise spin up a new one — same rule as the
      // inbound ingest path, so templates don't open ghost threads when the
      // contact already has an active one.
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
            status: "open",
            lastMessagePreview: "",
          },
        }));

      const send = await provider.sendTemplate(
        {
          to: recipient.contact.phoneNumber,
          name: broadcast.templateName,
          language: broadcast.templateLanguage,
          variables: {
            body: variables.body,
            ...(variables.header ? { header: variables.header } : {}),
          },
        },
        config,
      );

      const renderedBody = renderTemplateBody(
        await loadTemplateBody(broadcast.teamId, broadcast.templateId),
        variables.body,
      );
      const preview = renderedBody.slice(0, 200);

      const created = await db.message.create({
        data: {
          teamId: broadcast.teamId,
          conversationId: conversation.id,
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
        },
      });

      await db.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: send.timestamp, lastMessagePreview: preview },
      });

      await db.broadcastRecipient.update({
        where: { id: recipient.id },
        data: {
          status: "sent",
          externalId: send.externalId,
          conversationId: conversation.id,
          sentAt: send.timestamp,
        },
      });

      await bumpCounters(broadcast.id, broadcast.teamId, { sent: 1 });

      const messagePayload: Message = {
        id: created.id,
        teamId: broadcast.teamId,
        conversationId: conversation.id,
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
        conversationId: conversation.id,
        message: messagePayload,
        preview,
        lastMessageAt: send.timestamp.toISOString(),
        unreadDelta: 0,
      });
    } catch (err) {
      const detail = errorDetail(err);
      await db.broadcastRecipient.update({
        where: { id: recipient.id },
        data: { status: "failed", errorMessage: detail.slice(0, 500) },
      });
      await bumpCounters(broadcast.id, broadcast.teamId, { failed: 1 });
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

async function loadTemplateBody(teamId: string, templateId: string): Promise<string> {
  const row = await db.messageTemplate.findFirst({
    where: { id: templateId, teamId },
    select: { bodyText: true },
  });
  return row?.bodyText ?? "";
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
  if (err instanceof MetaSendError) {
    return `Meta ${err.httpStatus}: ${err.body}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
