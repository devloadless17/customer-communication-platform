import { Prisma } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import {
  getInFlightRunPromises,
  reconcileOrphanedBroadcasts,
  signalShutdown,
  startBroadcast,
} from "@/lib/broadcast-runner";
import {
  enqueueScheduledBroadcast,
  removeScheduledBroadcast,
} from "@/lib/broadcasts/schedule-queue";
import { countTemplatePlaceholders } from "@/lib/providers/meta";
import type { TemplateComponent } from "@ccp/shared/providers/types";
import { resolveAudienceGroupMembers } from "@/lib/queries";

import { DbService } from "../db/db.service";
import { EventBus } from "../events/event-bus.module";
import type {
  BroadcastListQuery,
  CreateBroadcastInput,
} from "./broadcasts.schemas";

@Injectable()
export class BroadcastsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Boot-time crash recovery + paused-broadcast resume. See
   * `reconcileOrphanedBroadcasts` in lib/broadcast-runner.ts for the full
   * rationale; in short, `running` orphans get demoted to `paused`, and
   * every `paused` row gets re-fired through startBroadcast() so the
   * runner picks up where the prior process left off (CAS per recipient).
   */
  async onModuleInit(): Promise<void> {
    try {
      await reconcileOrphanedBroadcasts();
    } catch (err) {
      this.logger.error("orphan reconciler failed on boot", err);
    }
    // Re-enqueue delayed jobs for any `scheduled` broadcasts. Covers the case
    // where Redis lost the job (flush / non-persistent restart) while the row
    // still says scheduled. Idempotent: enqueue uses jobId=bcast-<id>, so a
    // surviving job isn't duplicated. A past scheduledAt → clamped to fire
    // immediately (the worker's CAS still guards a canceled row).
    try {
      const scheduled = await this.db.broadcast.findMany({
        where: { status: "scheduled" },
        select: { id: true, scheduledAt: true },
      });
      for (const b of scheduled) {
        const delay = (b.scheduledAt?.getTime() ?? Date.now()) - Date.now();
        await enqueueScheduledBroadcast(b.id, delay).catch((err) =>
          this.logger.warn(
            `re-enqueue scheduled broadcast ${b.id} failed: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }
      if (scheduled.length > 0) {
        this.logger.log(`re-enqueued ${scheduled.length} scheduled broadcast(s) on boot`);
      }
    } catch (err) {
      this.logger.error("scheduled-broadcast reconciler failed on boot", err);
    }
  }

  /**
   * Graceful drain — fired by NestJS when main.ts triggers app.close().
   * Order is:
   *   1. signalShutdown() — sets the in-process flag the runner's lanes
   *      check between recipients. New startBroadcast() calls are also
   *      refused (would 503 the create endpoint, but we're shutting down
   *      so no new broadcasts should be hitting us anyway).
   *   2. Await the in-flight `runBroadcast(id)` promises with a timeout
   *      budget. Returning from each promise means every lane has finished
   *      its CURRENT recipient (Meta call + DB write) and the runner has
   *      stamped the parent row as `paused`.
   *   3. The timeout budget here matches main.ts's overall systemd
   *      TimeoutStopSec=120s minus headroom for the other onModuleDestroy
   *      hooks (workers, sweepers, queue close, Prisma pool drain). 25s
   *      covers ~125 recipient drain at 5 lanes × 200ms gap. Past that,
   *      any still-running lanes are killed mid-recipient and the boot
   *      reconciler will resume that broadcast cleanly (recipient stays
   *      `queued`, runner re-fires after restart).
   */
  async onModuleDestroy(): Promise<void> {
    signalShutdown();
    const inFlight = getInFlightRunPromises();
    if (inFlight.length === 0) return;

    this.logger.log(
      `draining ${inFlight.length} in-flight broadcast(s) for graceful shutdown`,
    );

    const drainTimeoutMs = 25_000;
    await Promise.race([
      Promise.allSettled(inFlight),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          this.logger.warn(
            `broadcast drain exceeded ${drainTimeoutMs}ms — abandoning in-flight runs; boot reconciler will resume them`,
          );
          resolve();
        }, drainTimeoutMs).unref(),
      ),
    ]);
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
  ): Promise<{ broadcastId: string; totalCount: number; scheduled: boolean }> {
    const { templateId, audience, variables } = input;

    // Resolve the schedule up front. A scheduledAt in the future → the
    // broadcast is created `scheduled` and a delayed job fires it later; a
    // null/past value → send now (legacy path).
    const SCHEDULE_LEAD_MS = 30_000; // treat <30s-out as "now" — not worth a job
    const scheduledAtDate = input.scheduledAt ? new Date(input.scheduledAt) : null;
    const isFutureSchedule =
      scheduledAtDate !== null &&
      scheduledAtDate.getTime() - Date.now() > SCHEDULE_LEAD_MS;
    const name = input.name && input.name.length > 0 ? input.name : null;

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
          where: { teamId, deletedAt: null },
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
        where: { teamId, deletedAt: null, tags: { some: { id: { in: validatedTagIds } } } },
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
    } else if (audience.mode === "custom") {
      // One-off audience built inline — same UNION semantics as a saved group
      // (contacts carrying ANY chosen tag, OR hand-picked by id), resolved and
      // snapshotted now. Tags are validated for the stored audit set; foreign
      // contact ids drop out automatically (the resolver scopes by teamId).
      const tagRows = audience.tagIds.length
        ? await this.db.tag.findMany({
            where: { teamId, id: { in: audience.tagIds } },
            select: { id: true },
          })
        : [];
      validatedTagIds = tagRows.map((t) => t.id);
      recipientIds = await resolveAudienceGroupMembers(teamId, {
        tagIds: validatedTagIds,
        manualContactIds: audience.contactIds,
      });
    } else {
      // mode === "selected"
      recipientIds = Array.from(
        new Set(
          (
            await this.db.contact.findMany({
              where: { teamId, deletedAt: null, id: { in: audience.contactIds } },
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
        // Scheduled → the delayed job will flip it to queued + run at time.
        // Otherwise queued → runs immediately below.
        status: isFutureSchedule ? "scheduled" : "queued",
        name,
        scheduledAt: scheduledAtDate,
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

    if (isFutureSchedule && scheduledAtDate) {
      // Enqueue the delayed fire. If Redis is briefly down the enqueue throws;
      // the row stays `scheduled` and the boot reconciler re-enqueues it.
      try {
        await enqueueScheduledBroadcast(
          broadcast.id,
          scheduledAtDate.getTime() - Date.now(),
        );
      } catch (err) {
        this.logger.error(
          `failed to enqueue scheduled broadcast ${broadcast.id} — reconciler will retry`,
          err,
        );
      }
    } else {
      // Fire-and-forget; startBroadcast schedules via setImmediate so the
      // response returns before any Meta sends happen.
      startBroadcast(broadcast.id);
    }

    // Publish a status frame for the create itself. The runner publishes
    // its own status_changed on the queued→running flip and again on
    // terminal states, but a scheduled broadcast sits at "scheduled" for
    // hours/days with NO bus event — every other open broadcasts-list tab
    // wouldn't know the row exists until the next nav. This event drives
    // `broadcasts-browser.tsx` to refetch and surface the new row live.
    await this.bus.publish({
      type: "broadcast.status_changed",
      teamId,
      broadcastId: broadcast.id,
      status: isFutureSchedule ? "scheduled" : "queued",
    });

    return {
      broadcastId: broadcast.id,
      totalCount: broadcast.totalCount,
      scheduled: isFutureSchedule,
    };
  }

  async list(teamId: string, query?: BroadcastListQuery) {
    const where: Prisma.BroadcastWhereInput = { teamId };
    if (query?.status && query.status !== "all") {
      where.status = query.status;
    }
    if (query?.search) {
      // Search the operator name + the template name (the two human labels).
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { templateName: { contains: query.search, mode: "insensitive" } },
      ];
    }
    const rows = await this.db.broadcast.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { createdBy: { select: { id: true, name: true } } },
    });
    return rows.map((b) => ({
      id: b.id,
      status: b.status,
      name: b.name,
      scheduledAt: b.scheduledAt?.toISOString() ?? null,
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
      name: row.name,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      templateId: row.templateId,
      templateName: row.templateName,
      templateLanguage: row.templateLanguage,
      audienceMode: row.audienceMode,
      audienceTagIds: row.audienceTagIds,
      audienceGroupId: row.audienceGroupId,
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
    if (
      row.status !== "scheduled" &&
      row.status !== "queued" &&
      row.status !== "running"
    ) {
      throw new ConflictException({
        error: "broadcast not cancelable",
        detail: `Broadcast is already ${row.status}; cancel is only valid while scheduled, queued, or running.`,
      });
    }
    const updated = await this.db.broadcast.updateMany({
      where: { id, status: { in: ["scheduled", "queued", "running"] } },
      data: { status: "canceled" },
    });
    if (updated.count === 0) {
      // Another caller / the runner flipped the status between read and
      // write — surface idempotently as success rather than a 409 race.
      return;
    }
    // Was it a scheduled broadcast? Pull its pending delayed job so it can't
    // fire later. The worker's CAS (scheduled→queued) already makes a late
    // fire on a now-`canceled` row a no-op, so this is belt-and-suspenders
    // that also keeps Redis tidy. Safe if the job already fired/is gone.
    if (row.status === "scheduled") {
      await removeScheduledBroadcast(id).catch((err) =>
        this.logger.warn(
          `removeScheduledBroadcast(${id}) failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
    }
  }

  /**
   * Re-queue a finished broadcast's FAILED recipients and run it again. Only
   * valid on a terminal broadcast (completed/failed/canceled) that actually
   * has failures. Resets those recipient rows to `queued` + clears their
   * error, flips the broadcast back to `queued`, and fires the runner — whose
   * per-recipient CAS guarantees already-`sent` rows are never touched.
   */
  async retryFailed(teamId: string, id: string): Promise<{ requeued: number }> {
    const row = await this.db.broadcast.findFirst({
      where: { id, teamId },
      select: { id: true, status: true, failedCount: true },
    });
    if (!row) throw new NotFoundException({ error: "not found" });
    if (row.status === "running" || row.status === "queued" || row.status === "scheduled") {
      throw new ConflictException({
        error: "broadcast in progress",
        detail: "Wait for the broadcast to finish before retrying failed recipients.",
      });
    }
    const reset = await this.db.broadcastRecipient.updateMany({
      where: { broadcastId: id, status: "failed" },
      data: { status: "queued", errorMessage: null, sentAt: null, externalId: null },
    });
    if (reset.count === 0) {
      throw new ConflictException({
        error: "nothing to retry",
        detail: "This broadcast has no failed recipients.",
      });
    }
    // Recompute counters off the reset and re-open the broadcast. failedCount
    // drops by the number we just re-queued; the runner re-increments as it
    // re-processes. lastError cleared so the detail page banner goes away.
    await this.db.broadcast.update({
      where: { id },
      data: {
        status: "queued",
        failedCount: { decrement: reset.count },
        lastError: null,
        completedAt: null,
      },
    });
    startBroadcast(id);
    return { requeued: reset.count };
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
