import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import type {
  MessageFlag,
  MessageFlagCounts,
  MessageFlagQueueItem,
  MessageFlagStatus,
} from "@ccp/shared/message-flags/types";

import {
  isRestrictedViewer,
  visibilityWhere,
  type ConversationViewer,
} from "@/lib/conversations/visibility";

import { DbService } from "../db/db.service";
import {
  raiseFlag,
  removeFlag,
  updateFlag,
  type FlagActor,
  type FlagMutationOutcome,
} from "@/lib/message-flags/mutations";
import { flagCounts, listFlags } from "@/lib/message-flags/queries";
import type { ListFlagsQuery, RaiseFlagInput, UpdateFlagInput } from "./message-flags.schemas";

/**
 * Thin seam over lib/message-flags — the domain layer owns every rule; this
 * class only supplies `this.db`, resolves the `"me"` shorthand, and maps the
 * domain's typed outcomes onto HTTP exceptions.
 *
 * The /v1 external surface calls the SAME lib functions with an apiKey actor,
 * so the two surfaces cannot drift.
 */
@Injectable()
export class MessageFlagsService {
  constructor(private readonly db: DbService) {}

  /**
   * Agent conversation-visibility boundary for the flag mutations.
   *
   * Raising, editing or deleting a flag on a thread the agent can't open is a
   * WRITE they shouldn't be able to make (and a `404 vs 200` existence oracle
   * besides). The flag's parent conversation is resolved from the message /
   * flag id and checked before the mutation runs.
   *
   * Zero queries for unrestricted viewers, which is every request in an
   * un-configured org.
   */
  private async assertVisible(
    viewer: ConversationViewer | undefined,
    where: { messageId?: string; flagId?: string },
  ): Promise<void> {
    if (!viewer || !isRestrictedViewer(viewer)) return;
    const conversationWhere = { assignedUserId: viewer.userId };
    const ok = where.messageId
      ? await this.db.message.findFirst({
          where: {
            id: where.messageId,
            teamId: viewer.teamId,
            conversation: conversationWhere,
          },
          select: { id: true },
        })
      : await this.db.messageFlag.findFirst({
          where: {
            id: where.flagId,
            teamId: viewer.teamId,
            conversation: conversationWhere,
          },
          select: { id: true },
        });
    // 404, never 403 — a 403 confirms the row exists to someone who isn't
    // allowed to know that.
    if (!ok) throw new NotFoundException({ error: "not_found" });
  }

  async raise(
    teamId: string,
    userId: string,
    input: RaiseFlagInput,
    viewer?: ConversationViewer,
  ): Promise<{ flag: MessageFlag; openFlagCount: number }> {
    const actor: FlagActor = { userId };
    await this.assertVisible(viewer, { messageId: input.messageId });
    const outcome = await raiseFlag(this.db, {
      teamId,
      messageId: input.messageId,
      definitionId: input.definitionId,
      actor,
      source: "human",
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
    });
    return this.unwrap(outcome);
  }

  async update(
    teamId: string,
    userId: string,
    flagId: string,
    input: UpdateFlagInput,
    viewer?: ConversationViewer,
  ): Promise<{ flag: MessageFlag; openFlagCount: number }> {
    await this.assertVisible(viewer, { flagId });
    const outcome = await updateFlag(this.db, {
      teamId,
      flagId,
      actor: { userId },
      ...(input.status !== undefined
        ? { status: input.status as MessageFlagStatus }
        : {}),
      ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.resolutionNote !== undefined
        ? { resolutionNote: input.resolutionNote }
        : {}),
    });
    return this.unwrap(outcome);
  }

  async remove(
    teamId: string,
    userId: string,
    flagId: string,
    viewer?: ConversationViewer,
  ): Promise<{ flag: MessageFlag; openFlagCount: number }> {
    await this.assertVisible(viewer, { flagId });
    const outcome = await removeFlag(this.db, { teamId, flagId, actor: { userId } });
    return this.unwrap(outcome);
  }

  async list(
    teamId: string,
    userId: string,
    query: ListFlagsQuery,
    viewer?: ConversationViewer,
  ): Promise<{ items: MessageFlagQueueItem[]; nextCursor: string | null }> {
    return listFlags(this.db, teamId, {
      // Agent conversation-visibility boundary. The queue selects message body,
      // media caption and the contact's name + phone, so an unscoped read hands
      // a restricted agent excerpts of every flagged conversation in the org.
      ...(viewer ? { visibility: visibilityWhere(viewer) } : {}),
      ...(query.status?.length
        ? { statuses: query.status as MessageFlagStatus[] }
        : {}),
      ...(query.definitionId?.length ? { definitionIds: query.definitionId } : {}),
      // `"me"` is resolved here rather than client-side so a bookmarked
      // "assigned to me" queue URL works for whoever opens it.
      ...(query.assignedTo
        ? { assignedToId: query.assignedTo === "me" ? userId : query.assignedTo }
        : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.take ? { take: query.take } : {}),
    });
  }

  async counts(
    teamId: string,
    userId: string,
    viewer?: ConversationViewer,
  ): Promise<MessageFlagCounts> {
    // Scoped so the badge counts what this viewer can actually open.
    return flagCounts(this.db, teamId, userId, viewer ? visibilityWhere(viewer) : undefined);
  }

  /**
   * Map the domain's typed outcome onto the HTTP surface. Keeping this in ONE
   * place is why the lib layer returns outcomes instead of throwing Nest
   * exceptions — the /v1 twin maps the same union onto its own error bodies.
   */
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
          detail: "That teammate isn't an active member of this team.",
        });
    }
  }
}
