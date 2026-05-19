import { Prisma } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";

import { reconcileOrphanedBroadcasts, startBroadcast } from "@/lib/broadcast-runner";
import { countTemplatePlaceholders } from "@/lib/providers/meta";
import type { TemplateComponent } from "@ccp/shared/providers/types";
import { resolveAudienceGroupMembers } from "@/lib/queries";

import { DbService } from "../db/db.service";
import type { CreateBroadcastInput } from "./broadcasts.schemas";

@Injectable()
export class BroadcastsService implements OnModuleInit {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Boot-time crash recovery. Any broadcast row still in `running` status
   * is by definition orphaned — the api process is the only thing that
   * drives the runner, and we just started. Flip them to `failed` so the
   * delete endpoint and UI can move on. See `reconcileOrphanedBroadcasts`
   * in lib/broadcast-runner.ts for the rationale.
   */
  async onModuleInit(): Promise<void> {
    try {
      await reconcileOrphanedBroadcasts();
    } catch (err) {
      this.logger.error("orphan reconciler failed on boot", err);
    }
  }

  /**
   * Create a Broadcast row + snapshot recipients + fire-and-forget the
   * runner. Returns the new id immediately so the UI can redirect to the
   * detail page and watch progress via the bus events.
   *
   * Audience resolution happens HERE (not in the runner) so the audience
   * snapshot is locked at creation time — later tagging changes don't
   * affect an already-queued broadcast.
   *
   * Runner kickoff is `setImmediate` inside startBroadcast — the HTTP
   * response returns before any Meta sends happen. The runner publish()
   * events reach realtime-fanout in this same process with zero pub/sub hop.
   */
  async create(
    teamId: string,
    userId: string,
    input: CreateBroadcastInput,
  ): Promise<{ broadcastId: string; totalCount: number }> {
    const { templateId, audience, variables } = input;

    const template = await this.db.messageTemplate.findFirst({
      where: { id: templateId, teamId },
    });
    if (!template) throw new NotFoundException({ error: "template not found" });
    if (template.status !== "approved") {
      throw new ConflictException({
        error: "template not approved",
        detail: `Template is ${template.status}. Only approved templates can be broadcast.`,
      });
    }

    // Variable count sanity check — fire BEFORE creating the row so the UI
    // can correct without a broadcast row hanging around in `queued`.
    const bodyVarCount = countTemplatePlaceholders(template.bodyText);
    if (variables.body.length !== bodyVarCount) {
      throw new BadRequestException({
        error: "wrong variable count",
        detail: `Template expects ${bodyVarCount} body variable(s), got ${variables.body.length}.`,
      });
    }
    const components = Array.isArray(template.components)
      ? (template.components as unknown as TemplateComponent[])
      : [];
    const headerComp = components.find((c) => c.type === "HEADER");
    const headerVarCount =
      headerComp?.format === "TEXT" && headerComp.text
        ? countTemplatePlaceholders(headerComp.text)
        : 0;
    if (headerVarCount > 0 && (!variables.header || variables.header.length === 0)) {
      throw new BadRequestException({
        error: "header variable required",
        detail: "This template's header has a placeholder — fill it in.",
      });
    }

    // Resolve recipient contact ids based on audience mode. `by_tag` is the
    // OR-union over selected tags (matches segmentation-tool convention).
    let recipientIds: string[] = [];
    let validatedTagIds: string[] = [];
    let resolvedGroupId: string | null = null;
    let resolvedGroupName: string | null = null;

    if (audience.mode === "all") {
      recipientIds = (
        await this.db.contact.findMany({
          where: { teamId },
          select: { id: true },
        })
      ).map((c) => c.id);
    } else if (audience.mode === "by_tag") {
      if (audience.tagIds.length === 0) {
        throw new BadRequestException({
          error: "no tags selected",
          detail: "Pick at least one tag.",
        });
      }
      // Validate tag ownership before the contact lookup — a foreign-team
      // id would silently yield zero recipients otherwise.
      const tagRows = await this.db.tag.findMany({
        where: { teamId, id: { in: audience.tagIds } },
        select: { id: true },
      });
      validatedTagIds = tagRows.map((t) => t.id);
      if (validatedTagIds.length === 0) {
        throw new BadRequestException({
          error: "no valid tags",
          detail: "None of the selected tags belong to this team.",
        });
      }
      const taggedContacts = await this.db.contact.findMany({
        where: { teamId, tags: { some: { id: { in: validatedTagIds } } } },
        select: { id: true },
      });
      recipientIds = taggedContacts.map((c) => c.id);
    } else if (audience.mode === "group") {
      if (!audience.groupId) {
        throw new BadRequestException({
          error: "groupId required",
          detail: "Pick a saved group.",
        });
      }
      const group = await this.db.audienceGroup.findFirst({
        where: { id: audience.groupId, teamId },
        include: {
          tags: { select: { id: true } },
          contacts: { select: { id: true } },
        },
      });
      if (!group) {
        throw new NotFoundException({
          error: "group not found",
          detail: "This audience group no longer exists.",
        });
      }
      // Snapshot the group's tag + manual membership into a concrete id set
      // at THIS moment. New contacts matching the tag criteria after this
      // point won't join the in-flight broadcast.
      recipientIds = await resolveAudienceGroupMembers(teamId, {
        tagIds: group.tags.map((t) => t.id),
        manualContactIds: group.contacts.map((c) => c.id),
      });
      resolvedGroupId = group.id;
      resolvedGroupName = group.name;
    } else {
      // mode === "selected"
      recipientIds = Array.from(
        new Set(
          (
            await this.db.contact.findMany({
              where: { teamId, id: { in: audience.contactIds } },
              select: { id: true },
            })
          ).map((c) => c.id),
        ),
      );
    }

    if (recipientIds.length === 0) {
      throw new BadRequestException({
        error: "empty audience",
        detail:
          "Pick at least one contact (or 'All contacts') to broadcast to.",
      });
    }

    const broadcast = await this.db.broadcast.create({
      data: {
        teamId,
        createdById: userId,
        status: "queued",
        templateId: template.id,
        templateName: template.name,
        templateLanguage: template.language,
        variables: variables as unknown as Prisma.InputJsonValue,
        audienceMode: audience.mode,
        audienceTagIds: validatedTagIds,
        audienceGroupId: resolvedGroupId,
        audienceGroupName: resolvedGroupName,
        totalCount: recipientIds.length,
        recipients: {
          create: recipientIds.map((id) => ({ contactId: id })),
        },
      },
      select: { id: true, totalCount: true },
    });

    // Fire-and-forget; startBroadcast schedules via setImmediate so the
    // response returns before any Meta sends happen.
    startBroadcast(broadcast.id);

    return { broadcastId: broadcast.id, totalCount: broadcast.totalCount };
  }

  async list(teamId: string) {
    const rows = await this.db.broadcast.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { createdBy: { select: { id: true, name: true } } },
    });
    return rows.map((b) => ({
      id: b.id,
      status: b.status,
      templateName: b.templateName,
      templateLanguage: b.templateLanguage,
      audienceMode: b.audienceMode,
      totalCount: b.totalCount,
      sentCount: b.sentCount,
      failedCount: b.failedCount,
      createdById: b.createdById,
      createdByName: b.createdBy?.name ?? "Removed user",
      createdAt: b.createdAt.toISOString(),
      startedAt: b.startedAt?.toISOString() ?? null,
      completedAt: b.completedAt?.toISOString() ?? null,
    }));
  }

  async get(teamId: string, id: string) {
    // Hard cap on inlined recipients. A 10k-recipient broadcast detail page
    // was returning multi-MB of JSON + rendering 10k <tr> rows, freezing
    // the browser tab for 10-30s. Cap to the first 500 (status grouped:
    // failed first so the operator can triage immediately, then queued,
    // then sent — the recipients they care about are the ones that didn't
    // succeed). Caller paginates the rest via /recipients?status=&cursor=.
    const RECIPIENTS_INLINE_CAP = 500;
    const row = await this.db.broadcast.findFirst({
      where: { id, teamId },
      include: {
        createdBy: { select: { id: true, name: true } },
        recipients: {
          // failed → queued → sent groups the most actionable rows first.
          // BroadcastRecipientStatus enum sorts alphabetically (canceled,
          // failed, queued, sending, sent) so status-asc puts failures
          // near the top, which is what the operator wants to see first.
          orderBy: [{ status: "asc" }, { id: "asc" }],
          take: RECIPIENTS_INLINE_CAP + 1,
          include: {
            contact: { select: { id: true, name: true, phoneNumber: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException({ error: "not found" });

    const truncated = row.recipients.length > RECIPIENTS_INLINE_CAP;
    const recipients = truncated
      ? row.recipients.slice(0, RECIPIENTS_INLINE_CAP)
      : row.recipients;

    return {
      id: row.id,
      status: row.status,
      templateId: row.templateId,
      templateName: row.templateName,
      templateLanguage: row.templateLanguage,
      audienceMode: row.audienceMode,
      variables: row.variables,
      totalCount: row.totalCount,
      sentCount: row.sentCount,
      failedCount: row.failedCount,
      lastError: row.lastError,
      createdById: row.createdById,
      createdByName: row.createdBy?.name ?? "Removed user",
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      recipientsTruncated: truncated,
      recipientsShown: recipients.length,
      recipients: recipients.map((r) => ({
        id: r.id,
        contactId: r.contactId,
        contactName: r.contact.name,
        contactPhone: r.contact.phoneNumber,
        conversationId: r.conversationId,
        status: r.status,
        externalId: r.externalId,
        errorMessage: r.errorMessage,
        sentAt: r.sentAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Paginated recipient page. Cursor-based on `id` (status-grouped) so
   * "Load more" works without offset's "rows shift under you" problem.
   */
  async listRecipients(
    teamId: string,
    broadcastId: string,
    opts: { cursor?: string; status?: string; take?: number },
  ) {
    const take = Math.min(Math.max(opts.take ?? 200, 1), 500);
    const broadcast = await this.db.broadcast.findFirst({
      where: { id: broadcastId, teamId },
      select: { id: true },
    });
    if (!broadcast) throw new NotFoundException({ error: "not found" });

    const where: Prisma.BroadcastRecipientWhereInput = {
      broadcastId,
    };
    if (opts.status) {
      where.status = opts.status as Prisma.BroadcastRecipientWhereInput["status"];
    }
    const rows = await this.db.broadcastRecipient.findMany({
      where,
      orderBy: [{ status: "asc" }, { id: "asc" }],
      take: take + 1,
      ...(opts.cursor
        ? { cursor: { id: opts.cursor }, skip: 1 }
        : {}),
      include: { contact: { select: { id: true, name: true, phoneNumber: true } } },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      recipients: page.map((r) => ({
        id: r.id,
        contactId: r.contactId,
        contactName: r.contact.name,
        contactPhone: r.contact.phoneNumber,
        conversationId: r.conversationId,
        status: r.status,
        externalId: r.externalId,
        errorMessage: r.errorMessage,
        sentAt: r.sentAt?.toISOString() ?? null,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Cancel a broadcast that's still queued or already running. The runner
   * checks the row's `status` between recipients and bails out the moment
   * it sees `canceled`. Already-sent recipients stay sent (Meta can't be
   * unsent); remaining `queued` recipient rows are left untouched in the
   * DB so the operator can audit what would have been sent.
   *
   * Compare-and-set on the previous status so two operators clicking
   * cancel at once (or cancel-while-already-canceled) don't double-emit.
   */
  async cancel(teamId: string, id: string): Promise<void> {
    const row = await this.db.broadcast.findFirst({
      where: { id, teamId },
      select: { id: true, status: true },
    });
    if (!row) throw new NotFoundException({ error: "not found" });
    if (row.status !== "queued" && row.status !== "running") {
      throw new ConflictException({
        error: "broadcast not cancelable",
        detail: `Broadcast is already ${row.status}; cancel is only valid while queued or running.`,
      });
    }
    const updated = await this.db.broadcast.updateMany({
      where: { id, status: { in: ["queued", "running"] } },
      data: { status: "canceled" },
    });
    if (updated.count === 0) {
      // Another caller / the runner flipped the status between read and
      // write — surface idempotently as success rather than a 409 race.
      return;
    }
  }

  /**
   * Delete broadcast + recipient rows. Refuses while runner is mid-loop —
   * the runner reads recipient rows by parent id and would error on a
   * missing parent. Real WhatsApp messages already sent stay in the inbox.
   */
  async remove(teamId: string, id: string): Promise<void> {
    const row = await this.db.broadcast.findFirst({
      where: { id, teamId },
      select: { id: true, status: true },
    });
    if (!row) throw new NotFoundException({ error: "not found" });
    if (row.status === "running" || row.status === "queued") {
      throw new ConflictException({
        error: "broadcast in progress",
        detail: "Wait for the broadcast to finish before deleting it.",
      });
    }
    await this.db.broadcast.delete({ where: { id } });
  }
}
