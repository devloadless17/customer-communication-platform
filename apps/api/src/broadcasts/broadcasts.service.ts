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

import { PrismaService } from "../prisma/prisma.service";
import type { CreateBroadcastInput } from "./broadcasts.schemas";

@Injectable()
export class BroadcastsService implements OnModuleInit {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(private readonly prisma: PrismaService) {}

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
   * response returns before any Meta sends happen. After Phase 5 the runner
   * lives in this same NestJS process; the publish() events it fires reach
   * the realtime-fanout subscriber with zero pub/sub hop.
   */
  async create(
    teamId: string,
    userId: string,
    input: CreateBroadcastInput,
  ): Promise<{ broadcastId: string; totalCount: number }> {
    const { templateId, audience, variables } = input;

    const template = await this.prisma.messageTemplate.findFirst({
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
        await this.prisma.contact.findMany({
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
      const tagRows = await this.prisma.tag.findMany({
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
      const taggedContacts = await this.prisma.contact.findMany({
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
      const group = await this.prisma.audienceGroup.findFirst({
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
            await this.prisma.contact.findMany({
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

    const broadcast = await this.prisma.broadcast.create({
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
    const rows = await this.prisma.broadcast.findMany({
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
    const row = await this.prisma.broadcast.findFirst({
      where: { id, teamId },
      include: {
        createdBy: { select: { id: true, name: true } },
        recipients: {
          orderBy: [{ status: "asc" }, { id: "asc" }],
          include: {
            contact: { select: { id: true, name: true, phoneNumber: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException({ error: "not found" });

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
      recipients: row.recipients.map((r) => ({
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
   * Delete broadcast + recipient rows. Refuses while runner is mid-loop —
   * the runner reads recipient rows by parent id and would error on a
   * missing parent. Real WhatsApp messages already sent stay in the inbox.
   */
  async remove(teamId: string, id: string): Promise<void> {
    const row = await this.prisma.broadcast.findFirst({
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
    await this.prisma.broadcast.delete({ where: { id } });
  }
}
