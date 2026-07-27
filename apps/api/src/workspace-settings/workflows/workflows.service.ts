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

import { decryptSecret, encryptSecret, isEncrypted } from "@/lib/crypto/envelope";
import { describeStep } from "@/lib/workflows/steps";
import { REDACTED_HEADER_VALUE } from "@/lib/workflows/steps/http-request";
import { dispatchManualTrigger } from "@/lib/workflows/dispatcher";
import {
  parseWorkflowBody,
  redactGraph,
  type WorkflowBody,
} from "@/lib/workflows/parse";
import { enqueueWorkflowRun, getRedisConnection } from "@/lib/workflows/queue";
import { MAX_CHAIN_DEPTH, parseChainDepth } from "@/lib/workflows/events";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  ListWorkflowRunsQuery,
  ManualTriggerInput,
  TestWorkflowInput,
} from "./workflows.schemas";

// Dedupe the timestamp-missing deprecation warning to one log per workflow
// per process. A hot legacy caller (think: n8n cron pinging every 30s) would
// otherwise flood the api log with the same line forever. Once the operator
// has seen it once they have what they need to migrate the caller.
const loggedLegacyTimestampWarn = new Set<string>();

// Webhook-specific alias retained so the cross-axis ceiling (MAX_CHAIN_DEPTH,
// in lib/workflows/events.ts) stays the single source of truth — used here +
// in the /v1 send/template endpoints + in trigger_workflow.
const MAX_WEBHOOK_CHAIN_DEPTH = MAX_CHAIN_DEPTH;

// Opt-in idempotency window for the incoming_webhook trigger. When a caller
// supplies an `Idempotency-Key` header we dedupe run creation in Redis (SET NX)
// for this long, so a partner double-delivery / retry doesn't double-fire the
// workflow (double Meta sends, double tag changes). 24h matches the /v1
// idempotency TTL. No schema change — Redis is already required for the queue.
const WEBHOOK_IDEMPOTENCY_TTL_S = 24 * 60 * 60;

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly db: DbService,
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
  async list(workspaceId: string) {
    const rows = await this.db.workflow.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
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
          ?  
            describeStep(startNode.type as any, startNode.config)
          : "(empty graph)";
        const stepCount = graph.nodes?.length ?? 0;
        return {
          id: r.id,
          name: r.name,
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
  async create(workspaceId: string, raw: unknown) {
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
      const created = await this.db.workflow.create({
        data: {
          workspaceId,
          name: parsed.name,
          published: false,
          trigger: parsed.trigger,
          triggerConfig: encryptTriggerConfigSecret(parsed.triggerConfig),
          triggerConditions: parsed.triggerConditions as Prisma.InputJsonValue,
          triggerOncePerContact: parsed.triggerOncePerContact,
          graph: encryptGraphStepSecrets(parsed.graph),
        },
      });
      await this.publishCatalogChange(workspaceId);
      // `warnings` carries non-blocking mid-build incompleteness (unwired
      // Branch / ask_question outputs) so the canvas can surface them without
      // having blocked the save.
      return { ...this.toDto(created), warnings: parsed.warnings };
    } catch (err) {
      this.throwIfDuplicateName(err, parsed.name);
      throw err;
    }
  }

  async get(workspaceId: string, id: string) {
    const row = await this.db.workflow.findFirst({
      where: { id, workspaceId },
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
  async update(workspaceId: string, id: string, raw: unknown) {
    const existing = await this.db.workflow.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException({ error: "not found" });

    const body = (raw ?? {}) as WorkflowBody;
    const merged: WorkflowBody = {
      name: body.name ?? existing.name,
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

    // Secret merge — preserve http_request secrets (bearerToken + custom-header
    // VALUES) when the admin didn't re-enter them. redactGraph strips both
    // before they reach the UI (bearerToken → bearerTokenSet flag, removed from
    // config; each customHeaders value → REDACTED_HEADER_VALUE sentinel), so a
    // straight save would otherwise wipe / corrupt the stored ciphertext.
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
        if (inN.type !== "http_request") continue;
        const inCfg = inN.config as Record<string, unknown>;
        const oldCfg = oldN.config as Record<string, unknown>;
        if (!inCfg.bearerToken && typeof oldCfg.bearerToken === "string") {
          inCfg.bearerToken = oldCfg.bearerToken;
        }
        // Per-header restore: an incoming value still equal to the redaction
        // sentinel means "unchanged" — copy the stored (encrypted) value back
        // from the matching old header key. A value the admin actually edited
        // arrives as new plaintext and is left alone (encryptGraphStepSecrets
        // encrypts it on write).
        const inHeaders = inCfg.customHeaders;
        const oldHeaders = oldCfg.customHeaders;
        if (
          inHeaders &&
          typeof inHeaders === "object" &&
          !Array.isArray(inHeaders) &&
          oldHeaders &&
          typeof oldHeaders === "object" &&
          !Array.isArray(oldHeaders)
        ) {
          const inH = inHeaders as Record<string, unknown>;
          const oldH = oldHeaders as Record<string, unknown>;
          for (const [k, v] of Object.entries(inH)) {
            if (v === REDACTED_HEADER_VALUE && typeof oldH[k] === "string") {
              inH[k] = oldH[k];
            }
          }
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
      const updated = await this.db.workflow.update({
        where: { id },
        data: {
          name: parsed.name,
          trigger: parsed.trigger,
          triggerConfig: encryptTriggerConfigSecret(parsed.triggerConfig),
          triggerConditions: parsed.triggerConditions as Prisma.InputJsonValue,
          triggerOncePerContact: parsed.triggerOncePerContact,
          graph: encryptGraphStepSecrets(parsed.graph),
        },
      });
      await this.publishCatalogChange(workspaceId);
      // See create() — non-blocking mid-build incompleteness for the canvas.
      return { ...this.toDto(updated), warnings: parsed.warnings };
    } catch (err) {
      this.throwIfDuplicateName(err, parsed.name);
      throw err;
    }
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.db.workflow.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "not found" });

    await this.db.workflow.delete({ where: { id } });
    await this.publishCatalogChange(workspaceId);
  }

  /**
   * Publish gate: flipping to published runs PUBLISH-tier validation against
   * the stored graph. Any error keeps the workflow `published=false` so the
   * dispatcher never picks up a broken graph. Flipping to unpublished never
   * validates (a published workflow can always be pulled offline).
   */
  async publish(
    workspaceId: string,
    id: string,
    publishFlag: boolean,
  ): Promise<{ published: boolean }> {
    const existing = await this.db.workflow.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException({ error: "not found" });

    if (publishFlag) {
      const validated = parseWorkflowBody(
        {
          name: existing.name,
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
      // Cross-team reference validation: every step that names a tag /
      // field / stage / user / template / workflow id must resolve to a
      // row that ACTUALLY belongs to this team. parseWorkflowBody only
      // checks shape — without this check, an admin could publish a graph
      // whose every run silently 404s on the first action (the step
      // handlers return advanceWithError(404) and the run advances past
      // the broken step). Catching it at publish time keeps the dispatcher
      // from ever picking up a workflow that's structurally broken.
      const refErrors = await this.validateGraphReferences(
        workspaceId,
        existing.id,
        existing.graph as unknown,
      );
      if (refErrors.length > 0) {
        throw new BadRequestException({
          error: "cannot publish — referenced resources missing or in another team",
          details: refErrors,
        });
      }
    }

    await this.db.workflow.update({
      where: { id },
      data: { published: publishFlag },
    });
    await this.publishCatalogChange(workspaceId);
    return { published: publishFlag };
  }

  /**
   * Cross-team reference validator for the publish gate. Collects every
   * id/key the graph names, batch-loads them in six parallel queries
   * (one per resource type), and returns a list of human-readable errors
   * for any missing reference.
   *
   * Returns [] when the graph is reference-clean. Self is allowed as a
   * `trigger_workflow.workflowId` target (no infinite-recursion check
   * here — that lives in the runtime depth guard).
   */
  private async validateGraphReferences(
    workspaceId: string,
    selfWorkflowId: string,
    rawGraph: unknown,
  ): Promise<string[]> {
    const g = (rawGraph ?? {}) as {
      nodes?: Array<{ id: string; type: string; config: unknown }>;
    };
    if (!Array.isArray(g.nodes)) return [];

    const tagIds = new Set<string>();
    const fieldKeys = new Set<string>();
    const stageIds = new Set<string>();
    const userIds = new Set<string>();
    const templateIds = new Set<string>();
    const workflowIds = new Set<string>();

    for (const node of g.nodes) {
      if (!node.config || typeof node.config !== "object") continue;
      const cfg = node.config as Record<string, unknown>;
      switch (node.type) {
        case "add_tag":
        case "remove_tag":
          if (typeof cfg.tagId === "string") tagIds.add(cfg.tagId);
          break;
        case "update_field":
          if (typeof cfg.fieldKey === "string") fieldKeys.add(cfg.fieldKey);
          break;
        case "update_lifecycle":
          if (typeof cfg.stageId === "string") stageIds.add(cfg.stageId);
          break;
        case "assign_to":
          if (cfg.mode === "user" && typeof cfg.userId === "string") {
            userIds.add(cfg.userId);
          }
          break;
        case "send_template":
          if (typeof cfg.templateId === "string") templateIds.add(cfg.templateId);
          break;
        case "trigger_workflow":
          if (
            typeof cfg.workflowId === "string" &&
            cfg.workflowId !== selfWorkflowId
          ) {
            workflowIds.add(cfg.workflowId);
          }
          break;
        // No other step types reference team-scoped resources.
        default:
          break;
      }
    }

    const [foundTags, foundFields, foundStages, foundUsers, foundTemplates, foundWorkflows] =
      await Promise.all([
        tagIds.size > 0
          ? this.db.tag.findMany({
              where: { id: { in: [...tagIds] }, workspaceId },
              select: { id: true },
            })
          : Promise.resolve([] as { id: string }[]),
        fieldKeys.size > 0
          ? this.db.contactFieldDefinition.findMany({
              where: { key: { in: [...fieldKeys] }, workspaceId },
              select: { key: true },
            })
          : Promise.resolve([] as { key: string }[]),
        stageIds.size > 0
          ? this.db.contactStage.findMany({
              where: { id: { in: [...stageIds] }, workspaceId },
              select: { id: true },
            })
          : Promise.resolve([] as { id: string }[]),
        userIds.size > 0
          ? this.db.user.findMany({
              where: { id: { in: [...userIds] }, workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
              select: { id: true },
            })
          : Promise.resolve([] as { id: string }[]),
        templateIds.size > 0
          ? this.db.messageTemplate.findMany({
              where: { id: { in: [...templateIds] }, workspaceId },
              select: { id: true },
            })
          : Promise.resolve([] as { id: string }[]),
        workflowIds.size > 0
          ? this.db.workflow.findMany({
              where: { id: { in: [...workflowIds] }, workspaceId },
              select: { id: true },
            })
          : Promise.resolve([] as { id: string }[]),
      ]);

    const errors: string[] = [];
    const haveTag = new Set(foundTags.map((r) => r.id));
    const haveField = new Set(foundFields.map((r) => r.key));
    const haveStage = new Set(foundStages.map((r) => r.id));
    const haveUser = new Set(foundUsers.map((r) => r.id));
    const haveTemplate = new Set(foundTemplates.map((r) => r.id));
    const haveWorkflow = new Set(foundWorkflows.map((r) => r.id));

    for (const id of tagIds) {
      if (!haveTag.has(id)) errors.push(`tag ${id} not found (deleted or in another team)`);
    }
    for (const key of fieldKeys) {
      if (!haveField.has(key)) errors.push(`contact field "${key}" not defined for this team`);
    }
    for (const id of stageIds) {
      if (!haveStage.has(id)) errors.push(`stage ${id} not found (deleted or in another team)`);
    }
    for (const id of userIds) {
      if (!haveUser.has(id)) errors.push(`user ${id} not found, deactivated, or in another team`);
    }
    for (const id of templateIds) {
      if (!haveTemplate.has(id)) errors.push(`template ${id} not found in this team`);
    }
    for (const id of workflowIds) {
      if (!haveWorkflow.has(id)) errors.push(`workflow ${id} not found in this team`);
    }
    return errors;
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
    workspaceId: string,
    /** Null when an API key fired it — the dispatcher records "system". */
    userId: string | null,
    id: string,
    input: ManualTriggerInput,
  ): Promise<{ runId: string }> {
    const wf = await this.db.workflow.findFirst({
      where: { id, workspaceId },
      select: { id: true, trigger: true, published: true },
    });
    if (!wf) throw new NotFoundException({ error: "workflow not found" });
    if (wf.trigger !== "manual_trigger") {
      throw new ConflictException({
        error: "workflow trigger is not manual_trigger",
      });
    }
    if (!wf.published) {
      throw new ConflictException({
        error: "workflow is not published",
      });
    }

    try {
      // UI button — explicit admin intent. We do NOT pass
      // enforceOncePerContact, so the dispatcher always returns a runId
      // (never null) for this entry shape. The null branch only exists
      // for the trigger_workflow step chain path.
      const runId = await dispatchManualTrigger({
        workspaceId,
        workflowId: id,
        contactId: input.contactId,
        conversationId: input.conversationId ?? null,
        triggeredByUserId: userId,
        metadata: input.metadata,
      });
      if (runId === null) {
        // Unreachable on this entry path — defensive throw in case the
        // dispatcher signature changes and this caller forgets to pass
        // the flag explicitly.
        throw new InternalServerErrorException({
          error: "dispatcher returned no runId",
        });
      }
      return { runId };
    } catch (err) {
      if (err instanceof InternalServerErrorException) throw err;
      throw new InternalServerErrorException({
        error: err instanceof Error ? err.message : "dispatch failed",
      });
    }
  }

  /**
   * Synthetic test run. Bypasses trigger conditions + once-per-contact
   * dedupe (the admin is explicitly testing). Skips the dispatcher
   * entirely so a draft workflow (published=false) can still be test-run
   * from the canvas.
   */
  async test(
    workspaceId: string,
    id: string,
    input: TestWorkflowInput,
  ): Promise<{ runId: string; jobId: string | null }> {
    const wf = await this.db.workflow.findFirst({
      where: { id, workspaceId },
      select: { id: true, graph: true, trigger: true },
    });
    if (!wf) throw new NotFoundException({ error: "not found" });

    const contactId = input.contactId ?? null;
    const conversationId = input.conversationId ?? null;

    let eventPayload: unknown;
    if (contactId) {
      const [contact, conversation] = await Promise.all([
        this.db.contact.findFirst({
          where: { id: contactId, workspaceId },
          include: { tags: { select: { id: true } } },
        }),
        conversationId
          ? this.db.conversation.findFirst({
              where: { id: conversationId, workspaceId },
            })
          : Promise.resolve(null),
      ]);
      if (!contact) throw new NotFoundException({ error: "contact not found" });
      eventPayload = {
        contact: {
          id: contact.id,
          phoneNumber: contact.phoneNumber,
          identityChannel: contact.identityChannel,
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
          identityChannel: null,
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

    const run = await this.db.workflowRun.create({
      data: {
        workflowId: wf.id,
        workspaceId,
        trigger: wf.trigger,
        contactId,
        conversationId,
        // `__test: true` lets the runner execute this run even when the
        // workflow is a DRAFT (published=false) — see the runner's published
        // gate. Only this test path sets it, so real dispatch/manual/webhook
        // runs still respect the live published gate.
        eventPayload: {
          ...(eventPayload as Record<string, unknown>),
          __test: true,
        } as Prisma.InputJsonValue,
        graphSnapshot: wf.graph as Prisma.InputJsonValue,
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
    timestampHeader: string | undefined,
    headers: Record<string, string>,
  ): Promise<{ runId: string | null; duplicate?: boolean; dropped?: string }> {
    const wf = await this.db.workflow.findFirst({
      where: { id },
      select: {
        id: true,
        graph: true,
        workspaceId: true,
        trigger: true,
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
    if (!wf.published) {
      throw new ConflictException({
        error: "workflow is not published",
      });
    }

    const storedSecret = (wf.triggerConfig as { secret?: string })?.secret;
    if (!storedSecret) {
      throw new InternalServerErrorException({
        error: "workflow not configured with a signature secret",
      });
    }
    // The secret is stored envelope-encrypted at rest (see updateConfig
    // below). decryptSecret() passes legacy plaintext through unchanged so
    // the rollout is non-breaking; new writes go through encryptSecret().
    let secret: string;
    try {
      secret = decryptSecret(storedSecret);
    } catch {
      throw new InternalServerErrorException({
        error: "workflow signature secret could not be decrypted (key rotated?)",
      });
    }

    // Replay protection. Senders include `X-Workflow-Timestamp: <unix-ms>`
    // and HMAC `${timestamp}.${rawBody}`. We reject requests outside the
    // ±5min skew window so a captured request can't be replayed forever.
    //
    // Legacy compatibility: if the header is absent we fall back to signing
    // raw body only and log a one-line deprecation. New integrations MUST
    // use the timestamped scheme.
    const REPLAY_WINDOW_MS = 5 * 60_000;
    let payload: string;
    if (timestampHeader) {
      const ts = Number.parseInt(timestampHeader, 10);
      if (!Number.isFinite(ts)) {
        throw new ForbiddenException({ error: "invalid timestamp" });
      }
      // Accept timestamps in either seconds or milliseconds.
      const tsMs = ts > 1e12 ? ts : ts * 1000;
      const skew = Math.abs(Date.now() - tsMs);
      if (skew > REPLAY_WINDOW_MS) {
        throw new ForbiddenException({
          error: "timestamp outside the ±5min replay window",
        });
      }
      payload = `${timestampHeader}.${rawBody}`;
    } else {
      // SEC-1: replay protection is REQUIRED by default in production (a missing
      // timestamp makes a captured signed request replayable forever). Opt-in
      // anywhere via `=1`; an operator can opt OUT in prod only with an explicit
      // `=0` escape hatch while migrating a legacy caller.
      const flag = process.env.WORKFLOW_WEBHOOK_REQUIRE_TIMESTAMP;
      const requireTimestamp =
        flag === "1" || (process.env.NODE_ENV === "production" && flag !== "0");
      if (requireTimestamp) {
        throw new ForbiddenException({
          error: "X-Workflow-Timestamp header required",
        });
      }
      if (!loggedLegacyTimestampWarn.has(id)) {
        loggedLegacyTimestampWarn.add(id);
        console.warn(
          `[workflow-webhook] workflow ${id} called without X-Workflow-Timestamp ` +
            `— replay protection disabled. Migrate the caller; this will become required. ` +
            `(further occurrences for this workflow are suppressed)`,
        );
      }
      payload = rawBody;
    }

    // Compute the expected hex digest. We accept the header as either bare
    // hex or with a `sha256=` prefix and decode both into raw bytes before
    // the timing-safe compare.
    const expectedHex = createHmac("sha256", secret).update(payload).digest("hex");
    const receivedHex = signatureHeader.startsWith("sha256=")
      ? signatureHeader.slice("sha256=".length)
      : signatureHeader;
    if (receivedHex.length !== expectedHex.length) {
      throw new ForbiddenException({ error: "invalid signature" });
    }
    let expectedBuf: Buffer;
    let receivedBuf: Buffer;
    try {
      expectedBuf = Buffer.from(expectedHex, "hex");
      receivedBuf = Buffer.from(receivedHex, "hex");
    } catch {
      throw new ForbiddenException({ error: "invalid signature" });
    }
    // Non-hex characters silently produce a shorter buffer — re-check.
    if (
      expectedBuf.length === 0 ||
      expectedBuf.length !== receivedBuf.length ||
      !timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      throw new ForbiddenException({ error: "invalid signature" });
    }

    // ---- Signature verified past this point. Loop + dedupe guards only run
    // on authenticated requests so an unsigned flood can't poison either. ----

    // Cross-system loop guard. Our own http_request step stamps X-CCP-Depth on
    // outbound calls; if an external system bounces back into this webhook the
    // header rides along. Drop (200, no run) at/above the ceiling so the
    // http_request -> external -> incoming_webhook -> http_request cycle can't
    // sustain. The resulting run carries depth+1 forward via eventPayload._depth.
    const inboundDepth = parseChainDepth(headers["x-ccp-depth"]);
    if (inboundDepth >= MAX_WEBHOOK_CHAIN_DEPTH) {
      console.warn(
        `[workflow-webhook] workflow ${id} dropped: chain depth ${inboundDepth} >= ` +
          `${MAX_WEBHOOK_CHAIN_DEPTH} — likely an http_request <-> incoming_webhook loop`,
      );
      // Write a `skipped` WorkflowRun row so the drop is visible in the
      // runs UI without log-grepping. The body still carries
      // `dropped: "chain_depth_exceeded"`, but a partner integration that
      // only checks for 200 won't surface the drop to the customer —
      // they'd just see workflows silently stop firing. The audit row
      // gives them a clean "what happened, when, and how often" surface.
      // Best-effort: if the insert itself fails (Postgres flap), the
      // drop still propagates via the response body + the log line.
      try {
        await this.db.workflowRun.create({
          data: {
            workflowId: wf.id,
            workspaceId: wf.workspaceId,
            trigger: "incoming_webhook",
            contactId: null,
            conversationId: null,
            eventPayload: {
              dropped: "chain_depth_exceeded",
              inboundDepth,
            } as Prisma.InputJsonValue,
            graphSnapshot: wf.graph as Prisma.InputJsonValue,
            status: "skipped",
            errorMessage: `chain_depth_exceeded (depth ${inboundDepth} >= ${MAX_WEBHOOK_CHAIN_DEPTH})`,
            finishedAt: new Date(),
          },
        });
      } catch (auditErr) {
        console.warn(
          `[workflow-webhook] failed to write skipped audit row: ${
            auditErr instanceof Error ? auditErr.message : String(auditErr)
          }`,
        );
      }
      return { runId: null, dropped: "chain_depth_exceeded" };
    }

    // Opt-in idempotency. When the caller supplies an Idempotency-Key we claim
    // it in Redis (SET NX) BEFORE creating the run; a duplicate within the
    // window returns the prior runId without firing a second run. Without the
    // header, behavior is unchanged (every signed request creates a run).
    const idempotencyKey = headers["idempotency-key"]?.slice(0, 255);
    const redisKey = idempotencyKey ? `wf-idem:${wf.id}:${idempotencyKey}` : null;
    if (redisKey) {
      try {
        const redis = getRedisConnection();
        const acquired = await redis.set(
          redisKey,
          "pending",
          "EX",
          WEBHOOK_IDEMPOTENCY_TTL_S,
          "NX",
        );
        if (acquired === null) {
          const prior = await redis.get(redisKey);
          return {
            runId: prior && prior !== "pending" ? prior : null,
            duplicate: true,
          };
        }
      } catch (err) {
        // Redis hiccup — fail OPEN (create the run) rather than dropping a
        // legitimately-signed webhook. At-most-once dedupe is best-effort;
        // double-fire on a Redis outage is the lesser evil than silent loss.
        console.warn(
          `[workflow-webhook] idempotency claim failed for ${id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    let parsedBody: unknown = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsedBody = { raw: rawBody };
    }

    // Strip the signature header + any partner-sent credentials — the step
    // handler shouldn't proxy them onward AND they must never be persisted into
    // eventPayload (JSONB, retained + disclosed on the runs detail page). Mirrors
    // safe-fetch's SENSITIVE_HEADERS set; custom business headers pass through.
    const STRIP_HEADERS = new Set([
      "x-workflow-signature",
      "authorization",
      "cookie",
      "proxy-authorization",
      "x-api-key",
    ]);
    const passthroughHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (STRIP_HEADERS.has(k.toLowerCase())) continue;
      passthroughHeaders[k] = v;
    }

    const eventPayload = {
      contact: null,
      body: parsedBody,
      headers: passthroughHeaders,
      // Seed the chain depth so this run's http_request steps stamp depth+1.
      _depth: inboundDepth,
    };

    let run: { id: string };
    try {
      run = await this.db.workflowRun.create({
        data: {
          workflowId: wf.id,
          workspaceId: wf.workspaceId,
          trigger: "incoming_webhook",
          contactId: null,
          conversationId: null,
          eventPayload: eventPayload as Prisma.InputJsonValue,
          graphSnapshot: wf.graph as Prisma.InputJsonValue,
          status: "queued",
        },
        select: { id: true },
      });
      await enqueueWorkflowRun(run.id);
    } catch (err) {
      // The idempotency key was claimed as "pending" BEFORE this point. If the
      // create/enqueue fails we must release it, otherwise the sentinel lingers
      // for the full TTL and every legitimate partner retry is swallowed as a
      // duplicate with no run ever created. Best-effort DEL only while it's
      // still "pending" (don't clobber a concurrent claimant's real runId).
      if (redisKey) {
        try {
          const redis = getRedisConnection();
          if ((await redis.get(redisKey)) === "pending") {
            await redis.del(redisKey);
          }
        } catch {
          /* best-effort — the partner retry will re-attempt regardless */
        }
      }
      throw err;
    }
    // Record the runId against the idempotency key so a later duplicate returns
    // it (overwrites the "pending" sentinel, keeps the TTL window).
    if (redisKey) {
      try {
        await getRedisConnection().set(redisKey, run.id, "EX", WEBHOOK_IDEMPOTENCY_TTL_S);
      } catch {
        /* best-effort — the run is already created + enqueued */
      }
    }
    return { runId: run.id };
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  async listRuns(workspaceId: string, id: string, query?: ListWorkflowRunsQuery) {
    const wf = await this.db.workflow.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!wf) throw new NotFoundException({ error: "not found" });

    // Keyset pagination on (startedAt DESC, id DESC) — rides the existing
    // (workflowId, startedAt DESC) index. Previously hard-capped at 50 with no
    // cursor, so older runs were unreachable. Default page 50, max 200.
    const take = query?.take ?? 50;
    const cursor = parseRunCursor(query?.cursor);
    const rows = await this.db.workflowRun.findMany({
      // workspaceId in BOTH branches: the workflow was already ownership-checked
      // above, so this is defence-in-depth — but it is also a ternary-built
      // `where`, the exact shape scripts/check-prisma-fields.mjs cannot see, so
      // the boundary has to be visible in the code itself (§18).
      where: cursor
        ? {
            workspaceId,
            workflowId: id,
            OR: [
              { startedAt: { lt: cursor.startedAt } },
              { startedAt: cursor.startedAt, id: { lt: cursor.id } },
            ],
          }
        : { workspaceId, workflowId: id },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: take + 1,
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
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const last = page.at(-1);
    const nextCursor =
      hasMore && last ? `${last.startedAt.getTime()}_${last.id}` : null;
    return {
      runs: page.map((r) => ({
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
      nextCursor,
    };
  }

  async getRun(workspaceId: string, id: string, runId: string) {
    const run = await this.db.workflowRun.findFirst({
      where: { id: runId, workflowId: id, workspaceId },
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

  private publishCatalogChange(workspaceId: string): Promise<void> {
    return this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "workflows",
    });
  }
}

/**
 * Decode a `<startedAtMs>_<id>` workflow-run list cursor. Returns null on any
 * malformed input so a bad cursor degrades to "first page" rather than 500.
 */
function parseRunCursor(
  raw: string | undefined,
): { startedAt: Date; id: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf("_");
  if (sep <= 0) return null;
  const ms = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { startedAt: new Date(ms), id };
}

/**
 * Envelope-encrypt `triggerConfig.secret` if present, idempotently. Same
 * tolerance pattern as the per-team Meta secrets: legacy plaintext rows
 * decrypt unchanged on read, new writes go through ciphertext. Other
 * fields in triggerConfig pass through untouched.
 *
 * Idempotency: if the value already carries the `enc:v1:` prefix we leave
 * it alone — otherwise re-saving an existing row would double-encrypt and
 * the verifySignature decrypt path would yield ciphertext-as-plaintext.
 *
 * Returns `Prisma.InputJsonValue` so the caller can assign directly.
 */
function encryptTriggerConfigSecret(
  triggerConfig: unknown,
): Prisma.InputJsonValue {
  if (!triggerConfig || typeof triggerConfig !== "object") {
    return triggerConfig as Prisma.InputJsonValue;
  }
  const cfg = triggerConfig as Record<string, unknown>;
  const secret = cfg.secret;
  if (typeof secret !== "string" || secret.length === 0 || isEncrypted(secret)) {
    return triggerConfig as Prisma.InputJsonValue;
  }
  return {
    ...cfg,
    secret: encryptSecret(secret),
  } as Prisma.InputJsonValue;
}

/**
 * Mirror of `encryptTriggerConfigSecret` for step-config secrets stored
 * inside the workflow graph JSONB. For `http_request` this covers BOTH the
 * `bearerToken` AND every `customHeaders` VALUE — a custom header is the normal
 * place to put `X-API-Key: <secret>` / a non-Bearer `Authorization` header when
 * the target API doesn't use Bearer auth, so those values are credentials too
 * and must be envelope-encrypted at rest like the bearer token. Header NAMES
 * stay plaintext (they're not secret and are needed to merge/redact by key).
 * Extend the dispatch if a future step type ships a new secret field.
 *
 * Returns a shallow-cloned graph so the caller's `parsed.graph` reference
 * stays untouched and the original is safe to inspect/log.
 */
function encryptGraphStepSecrets(
  graph: unknown,
): Prisma.InputJsonValue {
  if (!graph || typeof graph !== "object") {
    return graph as Prisma.InputJsonValue;
  }
  const g = graph as { nodes?: Array<{ id: string; type: string; config: unknown }> };
  if (!Array.isArray(g.nodes)) return graph as Prisma.InputJsonValue;

  const nodes = g.nodes.map((node) => {
    if (!node.config || typeof node.config !== "object") return node;
    const cfg = { ...(node.config as Record<string, unknown>) };
    let mutated = false;
    if (node.type === "http_request") {
      const t = cfg.bearerToken;
      if (typeof t === "string" && t.length > 0 && !isEncrypted(t)) {
        cfg.bearerToken = encryptSecret(t);
        mutated = true;
      }
      const headers = cfg.customHeaders;
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        const enc: Record<string, unknown> = {};
        let headersMutated = false;
        for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
          if (typeof v === "string" && v.length > 0 && !isEncrypted(v)) {
            enc[k] = encryptSecret(v);
            headersMutated = true;
          } else {
            enc[k] = v;
          }
        }
        if (headersMutated) {
          cfg.customHeaders = enc;
          mutated = true;
        }
      }
    }
    return mutated ? { ...node, config: cfg } : node;
  });

  return { ...g, nodes } as Prisma.InputJsonValue;
}

