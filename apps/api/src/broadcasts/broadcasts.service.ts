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
  CANCEL_RECIPIENT_MARKER,
  MAX_RECIPIENTS_IN_PROCESS,
  getInFlightRunPromises,
  pruneBroadcastInMemoryStateForTerminalRows,
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
import {
  parseVariableBindings,
  resolveBinding,
  type VariableBinding,
} from "@ccp/shared/template-bindings";
import { resolveFieldTokens } from "@ccp/shared/field-tokens";

import { DbService } from "../db/db.service";
import { EventBus } from "../events/event-bus.module";
import type {
  AudienceInput,
  BroadcastListQuery,
  CreateBroadcastInput,
  PreviewMissingFieldsInput,
} from "./broadcasts.schemas";

/** Friendly field name for a variable binding, for the pre-send warning.
 *  null for manual (agent-typed) variables — those "empty" cases are the
 *  agent's own blank input, not a missing contact field. */
function bindingFieldLabel(binding: VariableBinding | undefined): string | null {
  if (!binding || binding.source.kind === "manual") return null;
  if (binding.source.kind === "contact_field") {
    return binding.source.field === "phoneNumber"
      ? "phone number"
      : binding.source.field;
  }
  return binding.source.key;
}

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
    // Prune in-memory Map entries pinned to broadcasts that died in a terminal
    // state in a prior process. Must run AFTER reconcileOrphanedBroadcasts so
    // `running`/`paused` rows have already been demoted; what remains as
    // terminal is the safe-to-prune set. See header doc-comment in
    // broadcast-runner.ts for the list of Maps this touches.
    try {
      await pruneBroadcastInMemoryStateForTerminalRows();
    } catch (err) {
      this.logger.error("in-memory state prune failed on boot", err);
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
    // Media-header templates (IMAGE/VIDEO/DOCUMENT) need the campaign media
    // supplied as a public link — one media reused across every recipient.
    const HEADER_MEDIA_FORMATS: Record<string, "image" | "video" | "document"> = {
      IMAGE: "image",
      VIDEO: "video",
      DOCUMENT: "document",
    };
    const headerMediaKind = headerComp?.format
      ? HEADER_MEDIA_FORMATS[headerComp.format]
      : undefined;
    if (headerMediaKind) {
      if (!variables.headerMedia?.link) {
        throw new BadRequestException({
          error: "header media required",
          detail: `This template's header is a ${headerMediaKind} — attach one before scheduling.`,
        });
      }
      if (variables.headerMedia.kind !== headerMediaKind) {
        throw new BadRequestException({
          error: "header media kind mismatch",
          detail: `This template's header expects a ${headerMediaKind}.`,
        });
      }
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

    // Broadcasts send WhatsApp templates today, so only WhatsApp contacts are
    // valid recipients. Drop any social contacts (Messenger/Instagram) an
    // audience / tag / group swept in — they carry no phone and can't receive a
    // template, so leaving them in would just fail per-recipient with a cryptic
    // Meta error. When a channel gains its own broadcast type, resolve the
    // destination per-recipient here instead of pre-filtering.
    const hadAnyBeforeFilter = recipientIds.length > 0;
    if (hadAnyBeforeFilter) {
      const waRows = await this.db.contact.findMany({
        where: {
          teamId,
          id: { in: recipientIds },
          identityChannel: "whatsapp",
          deletedAt: null,
        },
        select: { id: true },
      });
      recipientIds = waRows.map((c) => c.id);
    }

    if (recipientIds.length === 0) {
      throw new BadRequestException({
        error: "empty audience",
        detail: hadAnyBeforeFilter
          ? "None of the selected contacts are on WhatsApp. Broadcasts currently send WhatsApp templates, so only WhatsApp contacts can be included."
          : "Pick at least one contact (or 'All contacts') to broadcast to.",
      });
    }

    // Enforce the in-process recipient cap HERE, before writing any rows. The
    // runner also checks it, but only after the recipient rows are persisted —
    // so an "all contacts" send on a 50k-contact team would build a 50k-row
    // nested INSERT and a 50k-id array in memory just to be rejected. Refuse
    // early with an actionable message instead.
    if (recipientIds.length > MAX_RECIPIENTS_IN_PROCESS) {
      throw new BadRequestException({
        error: "audience too large",
        detail: `This audience has ${recipientIds.length} recipients; the limit is ${MAX_RECIPIENTS_IN_PROCESS}. Split it into smaller broadcasts.`,
      });
    }

    // Create the broadcast row + recipients in ONE transaction, but write the
    // recipients via CHUNKED createMany rather than a nested create. A single
    // nested-create of N recipients ships one unbounded INSERT with N value
    // tuples — fine at 100, a multi-MB statement at the 10k cap. Chunked
    // createMany keeps each statement bounded and Postgres-plannable; the
    // transaction keeps it all-or-nothing so a mid-write crash can't leave a
    // broadcast whose totalCount disagrees with its recipient rows (the runner
    // would then under-send and mark complete). At the 10k cap that's ≤10
    // bounded inserts in the tx — short-lived.
    const RECIPIENT_CHUNK = 1_000;
    const broadcast = await this.db.$transaction(async (tx) => {
      const created = await tx.broadcast.create({
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
        },
        select: { id: true, totalCount: true },
      });
      for (let i = 0; i < recipientIds.length; i += RECIPIENT_CHUNK) {
        const slice = recipientIds.slice(i, i + RECIPIENT_CHUNK);
        await tx.broadcastRecipient.createMany({
          data: slice.map((id) => ({ broadcastId: created.id, contactId: id })),
          skipDuplicates: true,
        });
      }
      return created;
    }, {
      // Prisma's default interactive-tx timeout is 5s (wall-clock BEGIN→COMMIT
      // across every await). At the 10k-recipient cap this tx does 1 create +
      // up to 10 sequential 1k-row createMany round-trips; under pool contention
      // that can exceed 5s and roll back the ENTIRE broadcast create (P2028 →
      // opaque 500, no row). Give it the same 30s headroom as the statement
      // timeout ceiling. maxWait bumped so it can also wait for a pool slot.
      timeout: 30_000,
      maxWait: 5_000,
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

  /**
   * Pre-send preflight for the composer. Resolves the SAME audience the create
   * body would, then runs the ACTUAL runtime binding resolution
   * (resolveBinding → resolveFieldTokens, identical to the broadcast runner)
   * over a bounded sample of recipients to count how many would resolve a
   * template variable to EMPTY — which WhatsApp rejects. Read-only: it never
   * creates rows or touches the create path, so it's safe to call live as the
   * agent builds the campaign.
   */
  async previewMissingFields(
    teamId: string,
    input: PreviewMissingFieldsInput,
  ): Promise<{
    total: number;
    sampled: boolean;
    affectedCount: number;
    missing: Array<{
      location: "body" | "header";
      /** 1-based body variable position; 0 for the header variable. */
      position: number;
      /** Human field label when the variable is bound to a contact field
       *  (e.g. "email"), else null (a manual variable left blank). */
      fieldLabel: string | null;
      missingCount: number;
    }>;
  }> {
    const empty = { total: 0, sampled: false, affectedCount: 0, missing: [] as [] };
    const { templateId, audience, variables } = input;

    const template = await this.db.messageTemplate.findFirst({
      where: { id: templateId, teamId },
      select: { variableBindings: true },
    });
    if (!template) return empty;
    const bindings = parseVariableBindings(template.variableBindings as never);

    // Bounded to keep the composer snappy even on a huge audience. The count is
    // exact up to the cap; past it we flag `sampled` so the UI says "at least".
    const SCAN_CAP = 3000;
    const scanIds = await this.previewRecipientIds(teamId, audience, SCAN_CAP + 1);
    if (scanIds.length === 0) return empty;
    const sampled = scanIds.length > SCAN_CAP;
    const ids = sampled ? scanIds.slice(0, SCAN_CAP) : scanIds;

    const contacts = await this.db.contact.findMany({
      where: { teamId, id: { in: ids } },
      select: {
        name: true,
        phoneNumber: true,
        email: true,
        location: true,
        customFields: true,
      },
    });

    const bodyMissing = variables.body.map(() => 0);
    let headerMissing = 0;
    let affected = 0;
    for (const c of contacts) {
      let recipientAffected = false;
      variables.body.forEach((literal, i) => {
        const v = resolveFieldTokens(resolveBinding(bindings.body[i], literal, c), c);
        if (v.trim().length === 0) {
          bodyMissing[i] = (bodyMissing[i] ?? 0) + 1;
          recipientAffected = true;
        }
      });
      if (variables.header !== undefined) {
        const hv = resolveFieldTokens(
          resolveBinding(bindings.header, variables.header, c),
          c,
        );
        if (hv.trim().length === 0) {
          headerMissing++;
          recipientAffected = true;
        }
      }
      if (recipientAffected) affected++;
    }

    const missing: Array<{
      location: "body" | "header";
      position: number;
      fieldLabel: string | null;
      missingCount: number;
    }> = [];
    bodyMissing.forEach((cnt, i) => {
      if (cnt > 0) {
        missing.push({
          location: "body",
          position: i + 1,
          fieldLabel: bindingFieldLabel(bindings.body[i]),
          missingCount: cnt,
        });
      }
    });
    if (headerMissing > 0) {
      missing.push({
        location: "header",
        position: 0,
        fieldLabel: bindingFieldLabel(bindings.header),
        missingCount: headerMissing,
      });
    }

    return { total: contacts.length, sampled, affectedCount: affected, missing };
  }

  /**
   * Read-only audience → recipient-id resolver for {@link previewMissingFields}.
   * Mirrors create's mode resolution but NEVER throws (returns [] on any invalid
   * / empty input) and bounds the result, so the preview stays a pure, safe
   * read. Deliberately separate from create's resolver so the highest-blast
   * -radius send path stays untouched.
   */
  private async previewRecipientIds(
    teamId: string,
    audience: AudienceInput,
    limit: number,
  ): Promise<string[]> {
    // Broadcasts send WhatsApp templates, so the preview counts only WhatsApp
    // contacts — matching what `create` actually sends (it drops social
    // contacts). Over-scan the raw resolver so the filter doesn't under-sample
    // the cap, then keep the first `limit` WhatsApp ids.
    const raw = await this.previewRecipientIdsRaw(teamId, audience, limit * 2);
    if (raw.length === 0) return [];
    const wa = await this.db.contact.findMany({
      where: { teamId, id: { in: raw }, identityChannel: "whatsapp", deletedAt: null },
      select: { id: true },
      take: limit,
    });
    return wa.map((c) => c.id);
  }

  private async previewRecipientIdsRaw(
    teamId: string,
    audience: AudienceInput,
    limit: number,
  ): Promise<string[]> {
    try {
      if (audience.mode === "all") {
        return (
          await this.db.contact.findMany({
            where: { teamId, deletedAt: null },
            select: { id: true },
            take: limit,
          })
        ).map((c) => c.id);
      }
      if (audience.mode === "by_tag") {
        if (!audience.tagIds?.length) return [];
        const tagRows = await this.db.tag.findMany({
          where: { teamId, id: { in: audience.tagIds } },
          select: { id: true },
        });
        const validTagIds = tagRows.map((t) => t.id);
        if (validTagIds.length === 0) return [];
        return (
          await this.db.contact.findMany({
            where: { teamId, deletedAt: null, tags: { some: { id: { in: validTagIds } } } },
            select: { id: true },
            take: limit,
          })
        ).map((c) => c.id);
      }
      if (audience.mode === "group") {
        if (!audience.groupId) return [];
        const group = await this.db.audienceGroup.findFirst({
          where: { id: audience.groupId, teamId },
          include: { tags: { select: { id: true } }, contacts: { select: { id: true } } },
        });
        if (!group) return [];
        const ids = await resolveAudienceGroupMembers(teamId, {
          tagIds: group.tags.map((t) => t.id),
          manualContactIds: group.contacts.map((c) => c.id),
        });
        return ids.slice(0, limit);
      }
      if (audience.mode === "custom") {
        const tagRows = audience.tagIds?.length
          ? await this.db.tag.findMany({
              where: { teamId, id: { in: audience.tagIds } },
              select: { id: true },
            })
          : [];
        const ids = await resolveAudienceGroupMembers(teamId, {
          tagIds: tagRows.map((t) => t.id),
          manualContactIds: audience.contactIds ?? [],
        });
        return ids.slice(0, limit);
      }
      // mode === "selected"
      return Array.from(
        new Set(
          (
            await this.db.contact.findMany({
              where: { teamId, deletedAt: null, id: { in: audience.contactIds ?? [] } },
              select: { id: true },
              take: limit,
            })
          ).map((c) => c.id),
        ),
      );
    } catch {
      // Preview must never break the composer — a bad/foreign id or a transient
      // read error just yields "no warning".
      return [];
    }
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
    // Keyset pagination on (createdAt DESC, id DESC) by default. Numbered
    // (offset) mode kicks in when `page` is set — the list page uses it (25/page
    // + a numbered control), which also bounds the payload + the responsive
    // double-DOM render; keyset stays for any cursor caller.
    const pageMode = query?.page != null && query.page >= 1;
    const take = query?.take ?? (pageMode ? 25 : 100);
    const offset = pageMode ? (query!.page! - 1) * take : 0;
    const cursor = pageMode ? null : parseBroadcastCursor(query?.cursor);
    const cursorWhere: Prisma.BroadcastWhereInput | undefined = cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : undefined;
    const rows = await this.db.broadcast.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageMode ? take : take + 1,
      ...(pageMode ? { skip: offset } : {}),
      include: { createdBy: { select: { id: true, name: true } } },
    });
    const hasMore = pageMode ? false : rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const last = page.at(-1);
    const nextCursor =
      !pageMode && hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null;
    // Count shares `where` (filters, no cursor) so it matches the filtered set.
    const totalCount = pageMode
      ? await this.db.broadcast.count({ where })
      : undefined;
    return {
      broadcasts: page.map((b) => ({
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
      })),
      nextCursor,
      totalCount,
    };
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
          // Failures must sort FIRST so they're never truncated out of the
          // RECIPIENTS_INLINE_CAP (the operator triages failures first). NOTE:
          // BroadcastRecipientStatus is a Postgres ENUM (queued, sent, failed —
          // in DECLARATION order), so `ORDER BY status` uses that order, NOT
          // alphabetical (an earlier comment wrongly claimed alphabetical and
          // listed canceled/sending values that don't exist). `status: "asc"`
          // would therefore put failed LAST and truncate it away on a
          // many-recipient broadcast; DESC yields failed → sent → queued,
          // keeping the actionable rows at the top.
          orderBy: [{ status: "desc" }, { id: "asc" }],
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
      // Failed-first, matching the inline get() ordering rationale: the
      // BroadcastRecipientStatus enum declares (queued, sent, failed) so
      // `status: "desc"` yields failed → sent → queued — the actionable rows
      // (failures the operator triages) come first as "Load more" pages. An
      // explicit `status` filter narrows to one bucket anyway, so the ordering
      // only matters for the unfiltered "all recipients" paging.
      orderBy: [{ status: "desc" }, { id: "asc" }],
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
   * Return EVERY recipient contact id for a broadcast — used by the "Duplicate"
   * flow to reconstruct a hand-picked (`selected`/`custom`) audience, which only
   * lives on BroadcastRecipient rows (the parent stores tag/group refs, not the
   * resolved contact set). Lightweight: ids only, no contact join. Bounded by
   * MAX_RECIPIENTS_IN_PROCESS (10k), so a single query is fine.
   */
  async listRecipientContactIds(
    teamId: string,
    broadcastId: string,
  ): Promise<{ contactIds: string[] }> {
    const broadcast = await this.db.broadcast.findFirst({
      where: { id: broadcastId, teamId },
      select: { id: true },
    });
    if (!broadcast) throw new NotFoundException({ error: "not found" });
    const rows = await this.db.broadcastRecipient.findMany({
      where: { broadcastId },
      select: { contactId: true },
    });
    return { contactIds: Array.from(new Set(rows.map((r) => r.contactId))) };
  }

  /**
   * Cancel a broadcast that's still scheduled, queued, running, or paused. The
   * runner checks the row's `status` between recipients and bails out the moment
   * it sees `canceled`. Already-sent recipients stay sent (Meta can't be
   * unsent); every recipient that never sent is finalized `queued` → `failed`
   * with the CANCEL_RECIPIENT_MARKER errorMessage so the terminal counters sum
   * to totalCount, while `retryFailed` explicitly EXCLUDES that marker so a
   * deliberately-canceled audience is never re-sent (billed Meta template sends
   * are irreversible). (Leaving them `queued` would be a trap: retryFailed
   * re-opens the broadcast and the runner's refill pulls EVERY `queued` row,
   * silently re-sending the recipients the operator deliberately stopped.) The
   * rows stay in the DB for audit — just terminal, with the cancel recorded as
   * their errorMessage.
   *
   * `paused` is cancelable too: a broadcast paused by graceful-shutdown OR by the
   * permanent-error breaker (dead Meta credential) has no live runner — the boot
   * reconciler is the only thing that would resume it, and it only matches rows
   * STILL `paused`, so flipping paused→canceled here is permanent (no
   * resurrection). The detail-page "Stop broadcast" button is shown for `paused`
   * precisely so an operator can abandon a credential-failed broadcast instead of
   * waiting for an auto-resume that would just re-fail.
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
      row.status !== "running" &&
      row.status !== "paused"
    ) {
      throw new ConflictException({
        error: "broadcast not cancelable",
        detail: `Broadcast is already ${row.status}; cancel is only valid while scheduled, queued, running, or paused.`,
      });
    }
    const updated = await this.db.broadcast.updateMany({
      where: { id, status: { in: ["scheduled", "queued", "running", "paused"] } },
      data: { status: "canceled" },
    });
    if (updated.count === 0) {
      // Another caller / the runner flipped the status between read and
      // write — surface idempotently as success rather than a 409 race.
      return;
    }
    // Finalize every recipient that never sent: flip `queued` → `failed` with a
    // clear reason. Leaving them `queued` is a trap — a later `retryFailed`
    // re-opens the broadcast and the runner's refill pulls EVERY `queued` row,
    // re-sending the recipients the operator deliberately stopped, not just the
    // failures. This also makes the terminal counters sum to totalCount. The
    // rows stay for audit; `{ increment }` is atomic so a lane still draining its
    // final send (whose own mark is CAS-gated on `queued`) can't double-count.
    //
    // EXCLUDE in-flight recipients: a recipient stays `queued` for the whole Meta
    // send round-trip (the runner flips `queued` → `sent` via a CAS only AFTER
    // Meta accepts), and the in-flight marker is an OutboundSendAttempt row
    // (`bc-recipient-<id>`) that has not definitively failed (failedAt=null).
    // Flipping such a row to `failed` here would lose the runner's post-send CAS
    // (matches 0 rows) — the customer received the template but we'd record it
    // `failed` with no inbox Message row, and re-send it on retry. We match on
    // failedAt=null ALONE (not completedAt=null too): an attempt whose Meta send
    // already landed (completedAt set) but crashed before the queued→sent CAS is
    // still recoverable by the boot reconciler, so it must also stay `queued`.
    // Leave all such rows `queued`; the runner/reconciler finalizes them to `sent`.
    //
    // ONE atomic statement (raw — Prisma's typed updateMany can't express a
    // correlated subquery): flip queued→failed for every recipient that does NOT
    // have an in-flight `bc-recipient-<id>` attempt. Folding the in-flight
    // exclusion into the WHERE via NOT EXISTS removes the previous read-then-
    // write gap (a separate findMany of queued ids + findMany of attempts + a
    // client-side prefix map, between which a lane could create its attempt row
    // and slip through the snapshot). $executeRaw returns the affected-row count,
    // which is the exact failedCount bump. CANCEL_RECIPIENT_MARKER is a
    // deliberate state-discriminator carried ON errorMessage (chosen over a
    // schema enum value to avoid a migration): the live + boot cancel-race
    // reconcile AND retryFailed all key on this exact string, so keep it stable.
    const finalizedCount = await this.db.$executeRaw`
      UPDATE "BroadcastRecipient" br
      SET "status" = 'failed'::"BroadcastRecipientStatus",
          "errorMessage" = ${CANCEL_RECIPIENT_MARKER}
      WHERE br."broadcastId" = ${id}
        AND br."status" = 'queued'::"BroadcastRecipientStatus"
        AND NOT EXISTS (
          SELECT 1 FROM "OutboundSendAttempt" osa
          WHERE osa."jobId" = 'bc-recipient-' || br."id"
            AND osa."failedAt" IS NULL
        )
    `;
    if (finalizedCount > 0) {
      await this.db.broadcast.update({
        where: { id },
        data: { failedCount: { increment: finalizedCount } },
      });
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
    // Announce the cancel. The runner's canceled-exit branch deliberately skips
    // its own emit ("cancel endpoint already published the status change"), so
    // THIS is the only path that tells other tabs — without it a teammate's
    // broadcasts list / detail page spins on the stale status until a hard
    // refresh. Mirrors the create-path status emit.
    await this.bus.publish({
      type: "broadcast.status_changed",
      teamId,
      broadcastId: id,
      status: "canceled",
    });
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
    // Reset recipients + re-open the broadcast atomically in ONE transaction.
    // Two separate writes could leave recipients `queued` while the parent
    // still shows the old terminal status + failedCount if the process died
    // between them — the runner would then never pick it up (or double-count).
    // The parent update CAS-guards on the terminal-status set so a concurrent
    // runner flip / parallel retry can't race us. A throw inside the tx rolls
    // the whole thing back.
    const requeued = await this.db.$transaction(async (tx) => {
      // Grab the failed recipient ids up front so we can both reset them and
      // clear their OutboundSendAttempt rows (below) by id.
      // NOT the CANCEL_RECIPIENT_MARKER: recipients finalized by cancel() were
      // deliberately stopped by the operator, not genuine send failures.
      // Re-queuing them would re-send a billed Meta template to an audience the
      // operator explicitly canceled — irreversible. Retry re-sends ONLY the
      // recipients that actually failed at the provider.
      const failed = await tx.broadcastRecipient.findMany({
        where: {
          broadcastId: id,
          status: "failed",
          NOT: { errorMessage: CANCEL_RECIPIENT_MARKER },
        },
        select: { id: true },
      });
      if (failed.length === 0) {
        throw new ConflictException({
          error: "nothing to retry",
          detail: "This broadcast has no failed recipients.",
        });
      }
      const failedIds = failed.map((r) => r.id);
      // No marker re-filter here: `failedIds` came from the findMany above, which
      // already excluded CANCEL_RECIPIENT_MARKER inside this same tx — a second
      // filter would be dead. (The findMany's exclusion is the load-bearing one.)
      const reset = await tx.broadcastRecipient.updateMany({
        where: { id: { in: failedIds } },
        data: { status: "queued", errorMessage: null, sentAt: null, externalId: null },
      });

      // Delete the surviving OutboundSendAttempt rows (jobId `bc-recipient-<id>`)
      // for the recipients we're re-queuing. A recipient that failed via the
      // "attempt may have reached Meta" ABORT branch left its attempt row intact
      // with neither completedAt nor failedAt; without this delete the runner's
      // claim would P2002 → re-hit that abort → flip the recipient straight back
      // to failed, so the Retry button would be a permanent no-op (until the 7d
      // retention sweeper GC'd it). An EXPLICIT operator retry consciously accepts
      // the small double-send risk for a message that may never have landed, so
      // clearing the row to start a clean attempt is the right call.
      await tx.outboundSendAttempt.deleteMany({
        where: { jobId: { in: failedIds.map((rid) => `bc-recipient-${rid}`) } },
      });
      // Recompute counters off the reset and re-open the broadcast. failedCount
      // drops by the number we re-queued; the runner re-increments as it
      // re-processes. lastError cleared so the detail page banner goes away.
      // `failedCount` is clamped with GREATEST(0, …) rather than a plain
      // `{ decrement }` — if an earlier counter bump was lost to a transient DB
      // blip (see bumpCounters), the stored failedCount can be below reset.count
      // and a bare decrement would persist a NEGATIVE counter. The terminal-
      // status guard is kept inline so the affected-row count still drives the
      // concurrent-retry race check below. Raw because Prisma's typed update
      // can't express GREATEST.
      const flippedCount = await tx.$executeRaw`
        UPDATE "Broadcast"
        SET
          "status" = 'queued',
          "failedCount" = GREATEST(0, "failedCount" - ${reset.count}),
          "lastError" = NULL,
          "completedAt" = NULL
        WHERE "id" = ${id}
          AND "status" IN ('completed', 'failed', 'canceled')
      `;
      if (flippedCount === 0) {
        // A concurrent retry/runner already moved this broadcast out of a
        // terminal state — abort so we don't double-process.
        throw new ConflictException({
          error: "broadcast in progress",
          detail: "Another retry or run started for this broadcast.",
        });
      }
      return reset.count;
    });
    startBroadcast(id);
    return { requeued };
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
    // `paused` is in-progress too — it's the state graceful shutdown / reboot
    // leaves a running broadcast in for the boot reconciler to resume. Deleting
    // it races that resume and orphans the recipient send-progress, so refuse
    // it alongside running/queued. The user should CANCEL (clean stop) instead.
    if (
      row.status === "running" ||
      row.status === "queued" ||
      row.status === "paused"
    ) {
      throw new ConflictException({
        error: "broadcast in progress",
        detail: "Cancel the broadcast (or wait for it to finish) before deleting it.",
      });
    }
    await this.db.broadcast.delete({ where: { id } });
    // Tell other tabs the row is gone. There's no `deleted` status on the
    // broadcast.status_changed union, so re-emit the row's (terminal) status —
    // broadcasts-browser coalesces ANY broadcast:status frame into a list
    // refetch, which drops the now-404 row. A detail-page viewer of the deleted
    // broadcast refetches too and safely no-ops on the 404 (refreshRef skips
    // non-ok responses), keeping its stale terminal view instead of erroring.
    await this.bus.publish({
      type: "broadcast.status_changed",
      teamId,
      broadcastId: id,
      status: row.status,
    });
  }
}

/**
 * Decode a `<createdAtMs>_<id>` broadcast list cursor. Returns null on any
 * malformed input so a bad cursor degrades to "first page" rather than 500.
 */
function parseBroadcastCursor(
  raw: string | undefined,
): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf("_");
  if (sep <= 0) return null;
  const ms = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { createdAt: new Date(ms), id };
}
