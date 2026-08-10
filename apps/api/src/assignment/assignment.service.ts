import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ASSIGNMENT_LIMITS } from "@ccp/shared/assignment/types";

import {
  invalidateAssignmentCache,
  resolveAssignee,
  DEFAULT_ASSIGNMENT_SETTINGS,
} from "@/lib/assignment/resolve";
import { invalidateTeamVisibilityCaches } from "@/lib/conversations/visibility";

import { DbService } from "../db/db.service";
import type {
  CreatePolicyInput,
  CreateRuleInput,
  PreviewAssignmentInput,
  UpdateAssignmentSettingsInput,
  UpdatePolicyInput,
  UpdateRuleInput,
} from "./assignment.schemas";

/**
 * CRUD + bootstrap for assignment routing configuration.
 *
 * Two rules run through everything here:
 *
 *   1. EVERY WRITE INVALIDATES THE CACHE. `lib/assignment/resolve` caches
 *      policies/rules/settings for 15s. An admin who changes a weight and
 *      immediately watches the next conversation land must see the new
 *      behavior, so every mutation ends with `invalidateAssignmentCache`.
 *
 *   2. A TEAM ALWAYS HAS A DEFAULT POLICY. `ensureBootstrap` creates it (and
 *      the settings row) lazily on first read. The migration backfilled every
 *      existing team; this covers orgs created after it and any row that gets
 *      manually deleted, so `resolveAssignee` can never return "no_policy" for
 *      a team that has simply never opened the settings page.
 */
@Injectable()
export class AssignmentService {
  constructor(private readonly db: DbService) {}

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  /**
   * Idempotently ensure the team has a default policy + a settings row.
   *
   * Both creates tolerate a P2002 from a concurrent request (two admins opening
   * the page at once) by falling back to a read — the partial unique index on
   * `(workspaceId) WHERE isDefault` is what makes that race safe rather than
   * producing two competing defaults.
   */
  async ensureBootstrap(workspaceId: string): Promise<void> {
    const [policyCount, settings] = await Promise.all([
      this.db.team.count({ where: { workspaceId, archivedAt: null } }),
      this.db.assignmentSettings.findUnique({ where: { workspaceId }, select: { workspaceId: true } }),
    ]);

    if (policyCount === 0) {
      await this.db.team
        .create({
          data: {
            workspaceId,
            name: "Default",
            description:
              "Balances new conversations across everyone online and available, fewest open chats first.",
            isDefault: true,
            strategy: "least_busy",
            eligibility: "online_first",
          },
        })
        .catch((err) => {
          if (!isUniqueViolation(err)) throw err;
        });
    }

    if (!settings) {
      await this.db.assignmentSettings
        .create({ data: { workspaceId } })
        .catch((err) => {
          if (!isUniqueViolation(err)) throw err;
        });
    }
    invalidateAssignmentCache(workspaceId);
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Everything the settings page renders, in ONE round trip — policies with
   *  their members, ordered rules, settings, and the member roster (with live
   *  open-conversation counts, so an admin sizing capacity can see actual
   *  load next to the cap they're about to set). */
  async getOverview(workspaceId: string) {
    await this.ensureBootstrap(workspaceId);
    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { agentConversationVisibility: true },
    });

    const [policies, rules, settings, members, grouped] = await Promise.all([
      this.db.team.findMany({
        where: { workspaceId, archivedAt: null },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        include: {
          members: {
            select: { userId: true, weight: true, maxOpen: true, enabled: true, served: true },
          },
        },
      }),
      this.db.assignmentRule.findMany({
        where: { workspaceId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      }),
      this.db.assignmentSettings.findUnique({ where: { workspaceId } }),
      // Members of THIS workspace: users are org-scoped now, so membership is
      // the filter and the role comes off the (workspace-filtered) membership.
      this.db.user.findMany({
        where: {
          workspaceMemberships: { some: { workspaceId } },
          deactivatedAt: null,
        },
        select: {
          id: true,
          name: true,
          email: true,
          avatarUrl: true,
          availabilityStatus: true,
          workspaceMemberships: {
            where: { workspaceId },
            select: { role: true },
            take: 1,
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      this.db.conversation.groupBy({
        by: ["assignedUserId"],
        where: { workspaceId, assignedUserId: { not: null }, status: { not: "closed" } },
        _count: { _all: true },
      }),
    ]);

    const openCounts = new Map(
      grouped.filter((g) => g.assignedUserId).map((g) => [g.assignedUserId!, g._count._all]),
    );

    return {
      policies,
      rules,
      settings: {
        ...(settings ?? { workspaceId, ...DEFAULT_ASSIGNMENT_SETTINGS, version: 1 }),
        agentConversationVisibility: team?.agentConversationVisibility ?? "team",
      },
      // Flatten the workspace-scoped membership back onto the member DTO so the
      // wire shape keeps a plain `role` (the UI + /v1 consumers read it there).
      members: members.map(({ workspaceMemberships, ...m }) => ({
        ...m,
        role: workspaceMemberships[0]?.role ?? "agent",
        openCount: openCounts.get(m.id) ?? 0,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Policies
  // -------------------------------------------------------------------------

  async createPolicy(workspaceId: string, input: CreatePolicyInput) {
    const count = await this.db.team.count({
      where: { workspaceId, archivedAt: null },
    });
    if (count >= ASSIGNMENT_LIMITS.maxPoliciesPerTeam) {
      throw new BadRequestException({ error: "too_many_policies" });
    }
    await this.validateTargets(workspaceId, input);

    const policy = await this.db.team.create({
      data: {
        workspaceId,
        name: input.name,
        description: input.description ?? null,
        strategy: input.strategy ?? "least_busy",
        eligibility: input.eligibility ?? "online_first",
        eligibleRoles: input.eligibleRoles ?? [],
        includeAllMembers: input.includeAllMembers ?? true,
        defaultMaxOpen: input.defaultMaxOpen ?? null,
        overflow: input.overflow ?? "leave_unassigned",
        fallbackUserId: input.fallbackUserId ?? null,
        fixedUserId: input.fixedUserId ?? null,
        preferPreviousAgent: input.preferPreviousAgent ?? true,
        previousAgentWindowDays: input.previousAgentWindowDays ?? 30,
        // A brand-new policy is never the default — `setDefault` is an explicit,
        // separate action, so creating a policy can't silently re-route all
        // traffic the moment it's saved.
        isDefault: false,
      },
    });
    if (input.members) await this.syncMembers(workspaceId, policy.id, input.members);
    invalidateAssignmentCache(workspaceId);
    return this.getPolicy(workspaceId, policy.id);
  }

  async updatePolicy(workspaceId: string, policyId: string, input: UpdatePolicyInput) {
    const existing = await this.db.team.findFirst({
      where: { id: policyId, workspaceId, archivedAt: null },
    });
    if (!existing) throw new NotFoundException({ error: "policy_not_found" });
    await this.validateTargets(workspaceId, input);

    // Optimistic concurrency: the CAS is on `version`, and the same statement
    // bumps it, so a co-admin's stale save fails loudly instead of silently
    // reverting the weights that just landed.
    const { count } = await this.db.team.updateMany({
      where: { id: policyId, workspaceId, version: input.expectedVersion },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
        ...(input.eligibility !== undefined ? { eligibility: input.eligibility } : {}),
        ...(input.eligibleRoles !== undefined ? { eligibleRoles: input.eligibleRoles } : {}),
        ...(input.includeAllMembers !== undefined
          ? { includeAllMembers: input.includeAllMembers }
          : {}),
        ...(input.defaultMaxOpen !== undefined ? { defaultMaxOpen: input.defaultMaxOpen } : {}),
        ...(input.overflow !== undefined ? { overflow: input.overflow } : {}),
        ...(input.fallbackUserId !== undefined ? { fallbackUserId: input.fallbackUserId } : {}),
        ...(input.fixedUserId !== undefined ? { fixedUserId: input.fixedUserId } : {}),
        ...(input.preferPreviousAgent !== undefined
          ? { preferPreviousAgent: input.preferPreviousAgent }
          : {}),
        ...(input.previousAgentWindowDays !== undefined
          ? { previousAgentWindowDays: input.previousAgentWindowDays }
          : {}),
        version: { increment: 1 },
      },
    });
    if (count === 0) throw new ConflictException({ error: "version_conflict" });

    if (input.members) await this.syncMembers(workspaceId, policyId, input.members);
    invalidateAssignmentCache(workspaceId);
    return this.getPolicy(workspaceId, policyId);
  }

  /**
   * Swap which policy is the team default, inside one transaction so there is
   * never an instant with zero (or two) defaults — the partial unique index
   * would reject the latter anyway, but ordering the clear before the set keeps
   * it from ever being attempted.
   */
  async setDefaultPolicy(workspaceId: string, policyId: string) {
    const policy = await this.db.team.findFirst({
      where: { id: policyId, workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!policy) throw new NotFoundException({ error: "policy_not_found" });

    await this.db.$transaction(async (tx) => {
      await tx.team.updateMany({
        where: { workspaceId, isDefault: true, id: { not: policyId } },
        data: { isDefault: false },
      });
      await tx.team.updateMany({
        where: { id: policyId, workspaceId },
        data: { isDefault: true },
      });
    });
    invalidateAssignmentCache(workspaceId);
    return this.getPolicy(workspaceId, policyId);
  }

  /**
   * Archive (soft delete). The default policy can't be archived — a team
   * without one has no fallback, which would silently stop all routing. Rules
   * pointing at the archived policy are deleted in the same transaction rather
   * than left dangling: a rule that can't resolve is a rule that silently does
   * nothing, and silent is the enemy here.
   */
  async archivePolicy(workspaceId: string, policyId: string) {
    const policy = await this.db.team.findFirst({
      where: { id: policyId, workspaceId, archivedAt: null },
      select: { id: true, isDefault: true },
    });
    if (!policy) throw new NotFoundException({ error: "policy_not_found" });
    if (policy.isDefault) {
      throw new BadRequestException({ error: "cannot_archive_default_policy" });
    }

    await this.db.$transaction(async (tx) => {
      await tx.assignmentRule.deleteMany({ where: { workspaceId, policyId } });
      await tx.team.updateMany({
        where: { id: policyId, workspaceId },
        data: { archivedAt: new Date(), isDefault: false },
      });
      // Anything pointing at it degrades to the team default rather than
      // breaking. Broadcasts keep their historical `assignmentPolicyId` for the
      // audit trail — resolution already tolerates a missing policy.
      await tx.assignmentSettings.updateMany({
        where: { workspaceId, aiHandoffPolicyId: policyId },
        data: { aiHandoffPolicyId: null },
      });
    });
    invalidateAssignmentCache(workspaceId);
    return { ok: true };
  }

  private async getPolicy(workspaceId: string, policyId: string) {
    const policy = await this.db.team.findFirst({
      where: { id: policyId, workspaceId },
      include: {
        members: {
          select: { userId: true, weight: true, maxOpen: true, enabled: true, served: true },
        },
      },
    });
    if (!policy) throw new NotFoundException({ error: "policy_not_found" });
    return { policy };
  }

  /**
   * Replace a policy's member overrides with the submitted set.
   *
   * The subtle part is `served` for a NEWLY added member. Weighted selection
   * picks the lowest served/weight ratio, so a member joining at served=0 while
   * everyone else sits at 400 would receive EVERY conversation until they caught
   * up — the classic weighted-round-robin cold-start stampede. We seed their
   * counter to the pool's current average ratio × their weight, which drops them
   * into the rotation at their fair share immediately. Existing members keep
   * their counter untouched so a weight edit doesn't reset history.
   */
  private async syncMembers(
    workspaceId: string,
    policyId: string,
    members: { userId: string; weight: number; maxOpen?: number | null; enabled: boolean }[],
  ): Promise<void> {
    const submittedIds = members.map((m) => m.userId);
    if (submittedIds.length > 0) {
      const valid = await this.db.user.findMany({
        where: { id: { in: submittedIds }, workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
        select: { id: true },
      });
      if (valid.length !== new Set(submittedIds).size) {
        throw new BadRequestException({ error: "invalid_member" });
      }
    }

    const existing = await this.db.teamMember.findMany({
      where: { policyId },
      select: { userId: true, weight: true, served: true },
    });
    const existingByUser = new Map(existing.map((e) => [e.userId, e]));

    // Pool average served-per-weight, used to seed newcomers.
    const totalWeight = existing.reduce((s, e) => s + Math.max(1, e.weight), 0);
    const totalServed = existing.reduce((s, e) => s + e.served, 0);
    const avgRatio = totalWeight > 0 ? totalServed / totalWeight : 0;

    await this.db.$transaction(async (tx) => {
      await tx.teamMember.deleteMany({
        where: {
          policyId,
          workspaceId,
          userId: { notIn: submittedIds.length ? submittedIds : ["__none__"] },
        },
      });
      for (const m of members) {
        const prior = existingByUser.get(m.userId);
        await tx.teamMember.upsert({
          where: { policyId_userId: { policyId, userId: m.userId } },
          create: {
            workspaceId,
            policyId,
            userId: m.userId,
            weight: m.weight,
            maxOpen: m.maxOpen ?? null,
            enabled: m.enabled,
            served: Math.round(avgRatio * Math.max(1, m.weight)),
          },
          update: {
            weight: m.weight,
            maxOpen: m.maxOpen ?? null,
            enabled: m.enabled,
            ...(prior ? {} : { served: Math.round(avgRatio * Math.max(1, m.weight)) }),
          },
        });
      }
    });
  }

  /** Reject a fixed/fallback target that isn't an active member of this team —
   *  caught at save time so a misconfiguration surfaces in the settings form
   *  rather than as silently-unrouted conversations at 2am. */
  private async validateTargets(
    workspaceId: string,
    input: { fixedUserId?: string | null; fallbackUserId?: string | null },
  ): Promise<void> {
    const ids = [input.fixedUserId, input.fallbackUserId].filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
    if (ids.length === 0) return;
    const found = await this.db.user.count({
      where: {
        id: { in: ids },
        // Users are org-scoped; "belongs to this workspace" is a membership.
        workspaceMemberships: { some: { workspaceId } },
        deactivatedAt: null,
      },
    });
    if (found !== new Set(ids).size) {
      throw new BadRequestException({ error: "invalid_member" });
    }
  }

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  async createRule(workspaceId: string, input: CreateRuleInput) {
    const [count, policy] = await Promise.all([
      this.db.assignmentRule.count({ where: { workspaceId } }),
      this.db.team.findFirst({
        where: { id: input.policyId, workspaceId, archivedAt: null },
        select: { id: true },
      }),
    ]);
    if (count >= ASSIGNMENT_LIMITS.maxRulesPerTeam) {
      throw new BadRequestException({ error: "too_many_rules" });
    }
    if (!policy) throw new BadRequestException({ error: "policy_not_found" });

    const last = await this.db.assignmentRule.findFirst({
      where: { workspaceId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const rule = await this.db.assignmentRule.create({
      data: {
        workspaceId,
        name: input.name,
        policyId: input.policyId,
        enabled: input.enabled,
        conditions: input.conditions,
        position: (last?.position ?? -1) + 1,
      },
    });
    invalidateAssignmentCache(workspaceId);
    return { rule };
  }

  async updateRule(workspaceId: string, ruleId: string, input: UpdateRuleInput) {
    if (input.policyId) {
      const policy = await this.db.team.findFirst({
        where: { id: input.policyId, workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!policy) throw new BadRequestException({ error: "policy_not_found" });
    }
    const { count } = await this.db.assignmentRule.updateMany({
      where: { id: ruleId, workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.policyId !== undefined ? { policyId: input.policyId } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
      },
    });
    if (count === 0) throw new NotFoundException({ error: "rule_not_found" });
    invalidateAssignmentCache(workspaceId);
    const rule = await this.db.assignmentRule.findUnique({ where: { id: ruleId } });
    return { rule };
  }

  async deleteRule(workspaceId: string, ruleId: string) {
    const { count } = await this.db.assignmentRule.deleteMany({
      where: { id: ruleId, workspaceId },
    });
    if (count === 0) throw new NotFoundException({ error: "rule_not_found" });
    invalidateAssignmentCache(workspaceId);
    return { ok: true };
  }

  /**
   * Full reorder. Positions are rewritten from the submitted order; any rule
   * the client omitted keeps a position AFTER the listed ones, so a stale
   * client can't accidentally promote a rule it never saw to the top.
   */
  async reorderRules(workspaceId: string, ruleIds: string[]) {
    const owned = await this.db.assignmentRule.findMany({
      where: { workspaceId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((r) => r.id));
    if (ruleIds.some((id) => !ownedIds.has(id))) {
      throw new BadRequestException({ error: "rule_not_found" });
    }
    await this.db.$transaction(
      ruleIds.map((id, index) =>
        this.db.assignmentRule.update({ where: { id }, data: { position: index } }),
      ),
    );
    const rest = owned.filter((r) => !ruleIds.includes(r.id));
    if (rest.length > 0) {
      await this.db.$transaction(
        rest.map((r, index) =>
          this.db.assignmentRule.update({
            where: { id: r.id },
            data: { position: ruleIds.length + index },
          }),
        ),
      );
    }
    invalidateAssignmentCache(workspaceId);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async updateSettings(workspaceId: string, input: UpdateAssignmentSettingsInput) {
    await this.ensureBootstrap(workspaceId);

    if (input.aiHandoffPolicyId) {
      const policy = await this.db.team.findFirst({
        where: { id: input.aiHandoffPolicyId, workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!policy) throw new BadRequestException({ error: "policy_not_found" });
    }

    // The visibility flag lives on Team, so it is split out of the settings
    // patch and written separately (both inside the same request, so the admin
    // sees one atomic-looking save).
    const { expectedVersion, agentConversationVisibility, ...fields } = input;
    if (agentConversationVisibility !== undefined) {
      await this.db.workspace.update({
        where: { id: workspaceId },
        data: { agentConversationVisibility },
      });
      // Full revocation, immediately: the registered invalidator (see
      // realtime.gateway.ts) busts the workspace's HTTP/handshake session
      // caches, busts the emitter scope cache, pushes a catalog tick so every
      // tab re-derives its restricted flag, then force-disconnects the
      // workspace's sockets — whose re-handshake now reads post-flip state.
      invalidateTeamVisibilityCaches(workspaceId);
    }
    const data = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    );
    const { count } = await this.db.assignmentSettings.updateMany({
      where: { workspaceId, ...(expectedVersion ? { version: expectedVersion } : {}) },
      data: { ...data, version: { increment: 1 } },
    });
    if (count === 0) throw new ConflictException({ error: "version_conflict" });

    invalidateAssignmentCache(workspaceId);
    const settings = await this.db.assignmentSettings.findUnique({ where: { workspaceId } });
    return { settings };
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /** Dry run — `commit: false` so previewing never advances rotation or
   *  weighted counters. An admin can hit it repeatedly without skewing the
   *  fairness state they're trying to configure. */
  async preview(workspaceId: string, input: PreviewAssignmentInput) {
    await this.ensureBootstrap(workspaceId);
    const decision = await resolveAssignee({
      db: this.db,
      workspaceId,
      policyId: input.policyId ?? null,
      commit: false,
      ctx: {
        source: input.source,
        channel: (input.channel ?? null) as never,
        tagIds: input.tagIds ?? [],
        stageId: input.stageId ?? null,
        language: input.language ?? null,
        messageText: input.messageText ?? null,
        ...(input.isNewContact !== undefined ? { isNewContact: input.isNewContact } : {}),
      },
    });

    const user = decision.userId
      ? await this.db.user.findUnique({
          where: { id: decision.userId },
          select: { id: true, name: true, email: true, avatarUrl: true },
        })
      : null;
    return { decision, user };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
