import { createHmac, timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";

import { describeStep } from "@/lib/workflows/steps";
import { dispatchManualTrigger } from "@/lib/workflows/dispatcher";
import {
  parseWorkflowBody,
  redactGraph,
  type WorkflowBody,
} from "@/lib/workflows/parse";
import { enqueueWorkflowRun } from "@/lib/workflows/queue";

import { EventBus } from "../../events/event-bus.module";
import { PrismaService } from "../../prisma/prisma.service";
import type {
  ManualTriggerInput,
  TestWorkflowInput,
} from "./workflows.schemas";

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Workflow listing for the admin index. Surfaces a `firstStepLabel` hint
   * derived from the start node so admins skimming a long list can see
   * what each workflow does without opening it.
   */
  async list(teamId: string) {
    const rows = await this.prisma.workflow.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        enabled: true,
        published: true,
        trigger: true,
        graph: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { runs: true } },
      },
    });

    return {
      workflows: rows.map((r) => {
        const graph = r.graph as {
          nodes?: Array<{ id: string; type: string; config: unknown }>;
          startNodeId?: string;
        };
        const startNode = graph.nodes?.find((n) => n.id === graph.startNodeId);
        const firstStepLabel = startNode
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            describeStep(startNode.type as any, startNode.config)
          : "(empty graph)";
        const stepCount = graph.nodes?.length ?? 0;
        return {
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          published: r.published,
          trigger: r.trigger,
          stepCount,
          firstStepLabel,
          runCount: r._count.runs,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        };
      }),
    };
  }

  /**
   * Create always uses SAVE-tier validation. Admins publish via /publish
   * once the canvas is complete; new workflows always land as drafts.
   */
  async create(teamId: string, raw: unknown) {
    const body = (raw ?? {}) as WorkflowBody;
    const parsed = parseWorkflowBody(body);
    if (parsed.errors.length > 0) {
      throw new BadRequestException({
        error: "validation failed",
        details: parsed.errors,
        stepErrors: parsed.stepErrors,
      });
    }

    try {
      const created = await this.prisma.workflow.create({
        data: {
          teamId,
          name: parsed.name,
          enabled: parsed.enabled,
          published: false,
          trigger: parsed.trigger,
          triggerConfig: parsed.triggerConfig as Prisma.InputJsonValue,
          triggerConditions: parsed.triggerConditions as Prisma.InputJsonValue,
          triggerOncePerContact: parsed.triggerOncePerContact,
          graph: parsed.graph as unknown as Prisma.InputJsonValue,
        },
      });
      await this.publishCatalogChange(teamId);
      return this.toDto(created);
    } catch (err) {
      this.throwIfDuplicateName(err, parsed.name);
      throw err;
    }
  }

  async get(teamId: string, id: string) {
    const row = await this.prisma.workflow.findFirst({
      where: { id, teamId },
    });
    if (!row) throw new NotFoundException({ error: "not found" });
    return this.toDto(row);
  }

  /**
   * PATCH accepts partial bodies — fold incoming fields over the existing
   * row before validating, so the canvas's graph-only auto-save shape
   * stays trivial without losing trigger / conditions validation.
   *
   * Secret merge: admins don't re-enter sensitive step config (bearer
   * tokens) on every save, so we restore them from the matching old
   * node id when the incoming payload omits them.
   */
  async update(teamId: string, id: string, raw: unknown) {
    const existing = await this.prisma.workflow.findFirst({
      where: { id, teamId },
    });
    if (!existing) throw new NotFoundException({ error: "not found" });

    const body = (raw ?? {}) as WorkflowBody;
    const merged: WorkflowBody = {
      name: body.name ?? existing.name,
      enabled: body.enabled === undefined ? existing.enabled : body.enabled,
      trigger: body.trigger ?? existing.trigger,
      triggerConfig: body.triggerConfig ?? existing.triggerConfig,
      triggerConditions: body.triggerConditions ?? existing.triggerConditions,
      triggerOncePerContact:
        body.triggerOncePerContact === undefined
          ? existing.triggerOncePerContact
          : body.triggerOncePerContact,
      graph: body.graph ?? existing.graph,
      // PATCH never publishes — clients use /publish to flip the bit.
      published: existing.published,
    };

    // Secret merge — preserve bearerToken on http_request steps when not re-entered.
    if (body.graph) {
      const oldNodes =
        (existing.graph as {
          nodes?: Array<{ id: string; type: string; config: unknown }>;
        }).nodes ?? [];
      const incomingNodes =
        (merged.graph as {
          nodes?: Array<{ id: string; type: string; config: unknown }>;
        }).nodes ?? [];
      for (const inN of incomingNodes) {
        const oldN = oldNodes.find((n) => n.id === inN.id);
        if (!oldN || oldN.type !== inN.type) continue;
        const inCfg = inN.config as Record<string, unknown>;
        const oldCfg = oldN.config as Record<string, unknown>;
        if (
          inN.type === "http_request" &&
          !inCfg.bearerToken &&
          typeof oldCfg.bearerToken === "string"
        ) {
          inCfg.bearerToken = oldCfg.bearerToken;
        }
      }
    }

    const parsed = parseWorkflowBody(merged);
    if (parsed.errors.length > 0) {
      throw new BadRequestException({
        error: "validation failed",
        details: parsed.errors,
        stepErrors: parsed.stepErrors,
      });
    }

    try {
      const updated = await this.prisma.workflow.update({
        where: { id },
        data: {
          name: parsed.name,
          enabled: parsed.enabled,
          trigger: parsed.trigger,
          triggerConfig: parsed.triggerConfig as Prisma.InputJsonValue,
          triggerConditions: parsed.triggerConditions as Prisma.InputJsonValue,
          triggerOncePerContact: parsed.triggerOncePerContact,
          graph: parsed.graph as unknown as Prisma.InputJsonValue,
        },
      });
      await this.publishCatalogChange(teamId);
      return this.toDto(updated);
    } catch (err) {
      this.throwIfDuplicateName(err, parsed.name);
      throw err;
    }
  }

  async remove(teamId: string, id: string): Promise<void> {
    const existing = await this.prisma.workflow.findFirst({
      where: { id, teamId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "not found" });

    await this.prisma.workflow.delete({ where: { id } });
    await this.publishCatalogChange(teamId);
  }

  /**
   * Publish gate: flipping to published runs PUBLISH-tier validation against
   * the stored graph. Any error keeps the workflow `published=false` so the
   * dispatcher never picks up a broken graph. Flipping to unpublished never
   * validates (a published workflow can always be pulled offline).
   */
  async publish(
    teamId: string,
    id: string,
    publishFlag: boolean,
  ): Promise<{ published: boolean }> {
    const existing = await this.prisma.workflow.findFirst({
      where: { id, teamId },
    });
    if (!existing) throw new NotFoundException({ error: "not found" });

    if (publishFlag) {
      const validated = parseWorkflowBody(
        {
          name: existing.name,
          enabled: existing.enabled,
          trigger: existing.trigger,
          triggerConfig: existing.triggerConfig,
          triggerConditions: existing.triggerConditions,
          triggerOncePerContact: existing.triggerOncePerContact,
          graph: existing.graph,
        },
        { forPublish: true },
      );
      if (validated.errors.length > 0) {
        throw new BadRequestException({
          error: "cannot publish — fix validation errors first",
          details: validated.errors,
          stepErrors: validated.stepErrors,
        });
      }
    }

    await this.prisma.workflow.update({
      where: { id },
      data: { published: publishFlag },
    });
    await this.publishCatalogChange(teamId);
    return { published: publishFlag };
  }

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  /**
   * Manual trigger — used by the inbox "Run workflow" menu. Any agent can
   * fire, but the workflow must actually be `trigger=manual_trigger`. That
   * gate keeps a curious user from re-firing a "welcome" workflow outside
   * its natural trigger.
   */
  async manualTrigger(
    teamId: string,
    userId: string,
    id: string,
    input: ManualTriggerInput,
  ): Promise<{ runId: string }> {
    const wf = await this.prisma.workflow.findFirst({
      where: { id, teamId },
      select: { id: true, trigger: true, enabled: true, published: true },
    });
    if (!wf) throw new NotFoundException({ error: "workflow not found" });
    if (wf.trigger !== "manual_trigger") {
      throw new ConflictException({
        error: "workflow trigger is not manual_trigger",
      });
    }
    if (!wf.enabled || !wf.published) {
      throw new ConflictException({
        error: "workflow is disabled or unpublished",
      });
    }

    try {
      const runId = await dispatchManualTrigger({
        teamId,
        workflowId: id,
        contactId: input.contactId,
        conversationId: input.conversationId ?? null,
        triggeredByUserId: userId,
        metadata: input.metadata,
      });
      return { runId };
    } catch (err) {
      throw new InternalServerErrorException({
        error: err instanceof Error ? err.message : "dispatch failed",
      });
    }
  }

  /**
   * Synthetic test run. Bypasses trigger conditions + once-per-contact
   * dedupe (the admin is explicitly testing). Skips the dispatcher
   * entirely so a draft workflow (enabled=true, published=false) can
   * still be test-run from the canvas.
   */
  async test(
    teamId: string,
    id: string,
    input: TestWorkflowInput,
  ): Promise<{ runId: string; jobId: string | null }> {
    const wf = await this.prisma.workflow.findFirst({
      where: { id, teamId },
      select: { id: true, trigger: true, enabled: true },
    });
    if (!wf) throw new NotFoundException({ error: "not found" });
    if (!wf.enabled) {
      throw new ConflictException({
        error: "workflow is disabled — enable it before testing",
      });
    }

    const contactId = input.contactId ?? null;
    const conversationId = input.conversationId ?? null;

    let eventPayload: unknown;
    if (contactId) {
      const [contact, conversation] = await Promise.all([
        this.prisma.contact.findFirst({
          where: { id: contactId, teamId },
          include: { tags: { select: { id: true } } },
        }),
        conversationId
          ? this.prisma.conversation.findFirst({
              where: { id: conversationId, teamId },
            })
          : Promise.resolve(null),
      ]);
      if (!contact) throw new NotFoundException({ error: "contact not found" });
      eventPayload = {
        contact: {
          id: contact.id,
          phoneNumber: contact.phoneNumber,
          identityProvider: contact.identityProvider,
          externalContactId: contact.externalContactId,
          name: contact.name,
          email: contact.email,
          stageId: contact.stageId,
          tagIds: contact.tags.map((t) => t.id),
          customFields:
            contact.customFields &&
            typeof contact.customFields === "object" &&
            !Array.isArray(contact.customFields)
              ? (contact.customFields as Record<string, unknown>)
              : {},
        },
        conversation: conversation
          ? {
              id: conversation.id,
              status: conversation.status,
              assignedUserId: conversation.assignedUserId,
              unreadCount: conversation.unreadCount,
              lastMessageAt: conversation.lastMessageAt.toISOString(),
            }
          : null,
      };
    } else {
      eventPayload = {
        contact: {
          id: "test_contact",
          phoneNumber: "10000000000",
          identityProvider: null,
          externalContactId: null,
          name: "Test Contact",
          email: null,
          stageId: null,
          tagIds: [],
          customFields: {},
        },
        conversation: {
          id: "test_conversation",
          status: "open",
          assignedUserId: null,
          unreadCount: 1,
          lastMessageAt: new Date().toISOString(),
        },
      };
    }

    const run = await this.prisma.workflowRun.create({
      data: {
        workflowId: wf.id,
        teamId,
        trigger: wf.trigger,
        contactId,
        conversationId,
        eventPayload: eventPayload as Prisma.InputJsonValue,
        status: "queued",
      },
      select: { id: true },
    });
    const jobId = await enqueueWorkflowRun(run.id);
    return { runId: run.id, jobId };
  }

  /**
   * Per-workflow inbound URL. HMAC-SHA256 signature in
   * `X-Workflow-Signature` over the raw body; secret lives in the
   * workflow's triggerConfig.secret. Public endpoint by design — the
   * signature is the gate.
   *
   * Returns:
   *   - `{ runId }`            on success
   *   - throws NotFoundException for unknown workflow OR wrong trigger
   *     (don't leak which case it was — both look like "endpoint doesn't
   *     exist" from outside)
   *   - throws ConflictException for disabled / unpublished
   *   - throws ForbiddenException for signature failure
   */
  async incomingWebhook(
    id: string,
    rawBody: string,
    signatureHeader: string,
    headers: Record<string, string>,
  ): Promise<{ runId: string }> {
    const wf = await this.prisma.workflow.findFirst({
      where: { id },
      select: {
        id: true,
        teamId: true,
        trigger: true,
        enabled: true,
        published: true,
        triggerConfig: true,
      },
    });
    if (!wf) throw new NotFoundException({ error: "not found" });
    if (wf.trigger !== "incoming_webhook") {
      throw new NotFoundException({
        error: "workflow trigger is not incoming_webhook",
      });
    }
    if (!wf.enabled || !wf.published) {
      throw new ConflictException({
        error: "workflow is disabled or unpublished",
      });
    }

    const secret = (wf.triggerConfig as { secret?: string })?.secret;
    if (!secret) {
      throw new InternalServerErrorException({
        error: "workflow not configured with a signature secret",
      });
    }

    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (signatureHeader.length !== expected.length) {
      throw new ForbiddenException({ error: "invalid signature" });
    }
    try {
      const a = Buffer.from(signatureHeader, "utf8");
      const b = Buffer.from(expected, "utf8");
      if (!timingSafeEqual(a, b)) {
        throw new ForbiddenException({ error: "invalid signature" });
      }
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw new ForbiddenException({ error: "invalid signature" });
    }

    let parsedBody: unknown = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsedBody = { raw: rawBody };
    }

    // Strip the signature header — the step handler shouldn't proxy it onward.
    const passthroughHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "x-workflow-signature") continue;
      passthroughHeaders[k] = v;
    }

    const eventPayload = {
      contact: null,
      body: parsedBody,
      headers: passthroughHeaders,
    };

    const run = await this.prisma.workflowRun.create({
      data: {
        workflowId: wf.id,
        teamId: wf.teamId,
        trigger: "incoming_webhook",
        contactId: null,
        conversationId: null,
        eventPayload: eventPayload as Prisma.InputJsonValue,
        status: "queued",
      },
      select: { id: true },
    });
    await enqueueWorkflowRun(run.id);
    return { runId: run.id };
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  async listRuns(teamId: string, id: string) {
    const wf = await this.prisma.workflow.findFirst({
      where: { id, teamId },
      select: { id: true },
    });
    if (!wf) throw new NotFoundException({ error: "not found" });

    const rows = await this.prisma.workflowRun.findMany({
      where: { workflowId: id },
      orderBy: { startedAt: "desc" },
      take: 50,
      select: {
        id: true,
        status: true,
        trigger: true,
        attempts: true,
        errorMessage: true,
        currentStepId: true,
        waitUntil: true,
        startedAt: true,
        finishedAt: true,
        stepLog: true,
      },
    });
    return {
      runs: rows.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        attempts: r.attempts,
        errorMessage: r.errorMessage,
        currentStepId: r.currentStepId,
        waitUntil: r.waitUntil?.toISOString() ?? null,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        stepCount: Array.isArray(r.stepLog) ? r.stepLog.length : 0,
      })),
    };
  }

  async getRun(teamId: string, id: string, runId: string) {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, workflowId: id, teamId },
    });
    if (!run) throw new NotFoundException({ error: "not found" });

    return {
      id: run.id,
      workflowId: run.workflowId,
      status: run.status,
      trigger: run.trigger,
      contactId: run.contactId,
      conversationId: run.conversationId,
      currentStepId: run.currentStepId,
      waitUntil: run.waitUntil?.toISOString() ?? null,
      jumpsUsed: run.jumpsUsed,
      attempts: run.attempts,
      errorMessage: run.errorMessage,
      eventPayload: run.eventPayload,
      stepLog: run.stepLog,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private toDto(row: {
    id: string;
    name: string;
    enabled: boolean;
    published: boolean;
    trigger: string;
    triggerConfig: Prisma.JsonValue;
    triggerConditions: Prisma.JsonValue;
    triggerOncePerContact: boolean;
    graph: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      published: row.published,
      trigger: row.trigger,
      triggerConfig: row.triggerConfig,
      triggerConditions: row.triggerConditions,
      triggerOncePerContact: row.triggerOncePerContact,
      graph: redactGraph(row.graph as unknown as ReturnType<typeof redactGraph>),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private throwIfDuplicateName(err: unknown, name: string): void {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ConflictException({
        error: "name already in use",
        details: [`A workflow named "${name}" already exists.`],
      });
    }
  }

  private publishCatalogChange(teamId: string): Promise<void> {
    return this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "workflows",
    });
  }
}

