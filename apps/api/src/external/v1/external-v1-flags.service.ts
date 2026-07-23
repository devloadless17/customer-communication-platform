import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import type {
  MessageFlag,
  MessageFlagQueueItem,
  MessageFlagStatus,
} from "@ccp/shared/message-flags/types";

import { DbService } from "@/db/db.service";
import {
  raiseFlag,
  removeFlag,
  updateFlag,
  type FlagMutationOutcome,
} from "@/lib/message-flags/mutations";
import { flagCounts, listFlagDefinitions, listFlags } from "@/lib/message-flags/queries";
import { MessageFlagsCatalogService } from "@/workspace-settings/message-flags/message-flags-catalog.service";
import type {
  ExternalCreateFlagDefinitionInput,
  ExternalListFlagsQueryInput,
  ExternalRaiseFlagInput,
  ExternalUpdateFlagDefinitionInput,
  ExternalUpdateFlagInput,
} from "./external-v1.schemas";

/**
 * The `/v1` message-flag surface — the external twin of the in-app triage UI.
 *
 * Calls the SAME `lib/message-flags` functions the internal routes do, with an
 * `apiKeyId` actor instead of a `userId`. That is what makes the parity rule
 * (CLAUDE.md §12) real rather than a second implementation that drifts: the
 * idempotency, the CAS-gated counter maintenance, the audit row and the
 * `message.flag_changed` event are identical on both paths.
 *
 * This is also the "route a flagged message to another system" surface: a
 * partner subscribes to the `message.flag_changed` outbound webhook to be told
 * the moment something is flagged, then uses these endpoints to read the
 * backlog and mark items handled from their own tooling.
 */
@Injectable()
export class ExternalV1FlagsService {
  constructor(
    private readonly db: DbService,
    private readonly catalog: MessageFlagsCatalogService,
  ) {}

  async listDefinitions(workspaceId: string) {
    const definitions = await listFlagDefinitions(this.db, workspaceId, {
      includeArchived: true,
    });
    return { definitions };
  }

  /**
   * Catalog writes. Delegates to the SAME MessageFlagsCatalogService the
   * settings page uses, so the archive-not-delete rule, the name-collision 409
   * and the `team.catalog_changed` fanout are identical on both surfaces —
   * parity by construction rather than by a second implementation.
   */
  async createDefinition(workspaceId: string, body: ExternalCreateFlagDefinitionInput) {
    const definition = await this.catalog.create(workspaceId, body);
    return { definition };
  }

  async updateDefinition(
    workspaceId: string,
    id: string,
    body: ExternalUpdateFlagDefinitionInput,
  ) {
    const definition = await this.catalog.update(workspaceId, id, body);
    return { definition };
  }

  async deleteDefinition(workspaceId: string, id: string) {
    await this.catalog.remove(workspaceId, id);
    return { ok: true };
  }

  async list(
    workspaceId: string,
    query: ExternalListFlagsQueryInput,
  ): Promise<{ items: MessageFlagQueueItem[]; nextCursor: string | null }> {
    return listFlags(this.db, workspaceId, {
      ...(query.status?.length ? { statuses: query.status as MessageFlagStatus[] } : {}),
      ...(query.definitionId?.length ? { definitionIds: query.definitionId } : {}),
      ...(query.assignedTo ? { assignedToId: query.assignedTo } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.take ? { take: query.take } : {}),
      ...(query.q ? { search: query.q } : {}),
    });
  }

  /** Team-wide open counts. `mineOpen` is meaningless for a key (no user), so
   *  it is reported against no assignee and callers should ignore it. */
  async counts(workspaceId: string) {
    const counts = await flagCounts(this.db, workspaceId, "");
    return { counts };
  }

  async raise(
    workspaceId: string,
    apiKeyId: string,
    messageId: string,
    body: ExternalRaiseFlagInput,
  ): Promise<{ flag: MessageFlag; openFlagCount: number }> {
    // Accept the definition by NAME as well as id: a partner integration is
    // configured by a human who knows "Complaint", not a cuid. Resolved here
    // (not in the domain layer) because it's an ergonomics concern of this
    // surface, not a rule of the feature.
    const definitionId = await this.resolveDefinitionId(workspaceId, body);
    return this.unwrap(
      await raiseFlag(this.db, {
        workspaceId,
        messageId,
        definitionId,
        actor: { apiKeyId },
        source: "api",
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.assignedToId !== undefined ? { assignedToId: body.assignedToId } : {}),
      }),
    );
  }

  async update(
    workspaceId: string,
    apiKeyId: string,
    flagId: string,
    body: ExternalUpdateFlagInput,
  ): Promise<{ flag: MessageFlag; openFlagCount: number }> {
    return this.unwrap(
      await updateFlag(this.db, {
        workspaceId,
        flagId,
        actor: { apiKeyId },
        ...(body.status !== undefined ? { status: body.status as MessageFlagStatus } : {}),
        ...(body.assignedToId !== undefined ? { assignedToId: body.assignedToId } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.resolutionNote !== undefined
          ? { resolutionNote: body.resolutionNote }
          : {}),
      }),
    );
  }

  async remove(
    workspaceId: string,
    apiKeyId: string,
    flagId: string,
  ): Promise<{ flag: MessageFlag; openFlagCount: number }> {
    return this.unwrap(
      await removeFlag(this.db, { workspaceId, flagId, actor: { apiKeyId } }),
    );
  }

  private async resolveDefinitionId(
    workspaceId: string,
    body: ExternalRaiseFlagInput,
  ): Promise<string> {
    if (body.definitionId) return body.definitionId;
    const byName = await this.db.messageFlagDefinition.findFirst({
      where: { workspaceId, name: body.definitionName!, archived: false },
      select: { id: true },
    });
    if (!byName) {
      throw new NotFoundException({
        error: "message_flag_definition_not_found",
        detail: `No active message flag named "${body.definitionName}".`,
      });
    }
    return byName.id;
  }

  /** Same outcome→HTTP mapping as the internal service, kept deliberately in
   *  sync so a partner sees the same error keys an agent's client would. */
  private unwrap(
    outcome: FlagMutationOutcome,
  ): { flag: MessageFlag; openFlagCount: number } {
    if (outcome.ok) return { flag: outcome.flag, openFlagCount: outcome.openFlagCount };
    switch (outcome.reason) {
      case "message_not_found":
        throw new NotFoundException({ error: "message_not_found" });
      case "flag_not_found":
        throw new NotFoundException({ error: "flag_not_found" });
      case "definition_not_found":
        throw new NotFoundException({ error: "message_flag_definition_not_found" });
      case "definition_archived":
        throw new ConflictException({
          error: "message_flag_definition_archived",
          detail: "That flag has been archived and can no longer be raised.",
        });
      case "assignee_not_found":
        throw new BadRequestException({
          error: "assignee_not_found",
          detail: "That user isn't an active member of this team.",
        });
    }
  }
}
