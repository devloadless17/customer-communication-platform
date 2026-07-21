import { Prisma, type PrismaClient } from "@prisma/client";

import type { MessageFlag, MessageFlagSource, MessageFlagStatus } from "@ccp/shared/types";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";

import { MESSAGE_FLAG_SELECT, mapFlag } from "./queries";

/**
 * Write side of message flags — the ONLY place a `MessageFlag` row is created,
 * changed, or deleted, and the only publisher of `message.flag_changed`.
 *
 * Framework-agnostic (lib/): `db` is INJECTED, so the NestJS service passes
 * `this.db`, the /v1 service passes the same, and a future workflow step or AI
 * call passes the lib `db` Proxy — all three then share one set of rules.
 * Same contract and durability posture as lib/conversations/mutations.ts: every
 * mutation co-commits its row write, its `Conversation.openFlagCount`
 * maintenance, and its domain event inside ONE `$transaction` via
 * `publishInTx`, then calls `kickOutbox()` after commit. A crash between the
 * state write and the emit therefore cannot lose the realtime frame, the audit
 * row, or the outbound webhook.
 *
 * No NestJS exceptions are thrown from here — callers map the typed outcome to
 * their own error surface (an HTTP exception, or a workflow step result).
 */

/** Minimal Prisma surface these helpers touch. */
type Db = Pick<
  PrismaClient,
  | "messageFlag"
  | "messageFlagDefinition"
  | "message"
  | "conversation"
  | "user"
  | "$transaction"
>;

/** Who is making the change. Exactly one of these is set in practice: a human
 *  session, or an external /v1 key. The AI and workflow paths set neither and
 *  are identified by `source` instead. */
export interface FlagActor {
  userId?: string | null;
  apiKeyId?: string | null;
}

export type FlagMutationOutcome =
  | {
      ok: true;
      flag: MessageFlag;
      openFlagCount: number;
      action: "added" | "updated" | "reopened" | "resolved" | "removed";
    }
  | { ok: false; reason: "message_not_found" }
  | { ok: false; reason: "flag_not_found" }
  | { ok: false; reason: "definition_not_found" }
  | { ok: false; reason: "definition_archived" }
  | { ok: false; reason: "assignee_not_found" };

/** Loop-safety / delivery gates, mirroring ContactTagChangedEvent. Set by
 *  automated callers so a flag raised BY a workflow can't re-trigger it. */
interface EventGates {
  silent?: boolean;
  skipOutboundWebhook?: boolean;
}

export interface RaiseFlagArgs extends EventGates {
  teamId: string;
  messageId: string;
  definitionId: string;
  actor: FlagActor;
  source?: MessageFlagSource;
  confidence?: number | null;
  note?: string | null;
  assignedToId?: string | null;
}

/**
 * Raise a flag on a message, or re-open one that was already resolved there.
 *
 * IDEMPOTENT by construction: `@@unique([messageId, definitionId])` means
 * flagging the same message with the same definition twice can't duplicate. A
 * double-click, a retried /v1 call with the same body, or an at-least-once AI
 * job all converge on one row.
 */
export async function raiseFlag(db: Db, args: RaiseFlagArgs): Promise<FlagMutationOutcome> {
  const message = await db.message.findFirst({
    where: { id: args.messageId, teamId: args.teamId },
    select: { id: true, conversationId: true },
  });
  if (!message) return { ok: false, reason: "message_not_found" };

  const definition = await db.messageFlagDefinition.findFirst({
    where: { id: args.definitionId, teamId: args.teamId },
    select: { id: true, archived: true },
  });
  if (!definition) return { ok: false, reason: "definition_not_found" };
  // An archived definition still RENDERS on its historical flags, but must not
  // accept new ones — otherwise "retired" wouldn't mean anything.
  if (definition.archived) return { ok: false, reason: "definition_archived" };

  if (args.assignedToId && !(await assertTeamMember(db, args.teamId, args.assignedToId))) {
    return { ok: false, reason: "assignee_not_found" };
  }

  // Two concurrent first-raises both miss the `findUnique` below and both
  // INSERT; the loser hits the unique constraint. A P2002 raised inside a
  // Postgres transaction poisons that transaction, so it cannot be caught and
  // recovered from in-place — the retry has to re-run the whole thing. One
  // retry is provably enough: on the second pass the row exists, so the
  // create branch isn't taken at all.
  return withUniqueRetry(() => raiseFlagOnce(db, args, message.conversationId));
}

async function raiseFlagOnce(
  db: Db,
  args: RaiseFlagArgs,
  conversationId: string,
): Promise<FlagMutationOutcome> {
  const result = await db.$transaction(async (tx) => {
    const existing = await tx.messageFlag.findUnique({
      where: {
        messageId_definitionId: {
          messageId: args.messageId,
          definitionId: args.definitionId,
        },
      },
      select: { id: true, status: true },
    });

    let flagId: string;
    let delta: number;
    let action: "added" | "updated" | "reopened";

    if (!existing) {
      const created = await tx.messageFlag.create({
        data: {
          teamId: args.teamId,
          messageId: args.messageId,
          conversationId,
          definitionId: args.definitionId,
          status: "open",
          source: args.source ?? "human",
          confidence: args.confidence ?? null,
          note: args.note ?? null,
          createdById: args.actor.userId ?? null,
          assignedToId: args.assignedToId ?? null,
        },
        select: { id: true },
      });
      flagId = created.id;
      delta = 1;
      action = "added";
    } else if (existing.status === "open") {
      // Already open — this is the idempotent replay. Only fold in newly
      // supplied context (a note, an owner); never clobber existing values with
      // the undefined of a bare re-raise.
      await tx.messageFlag.update({
        where: { id: existing.id },
        data: {
          ...(args.note !== undefined ? { note: args.note } : {}),
          ...(args.assignedToId !== undefined ? { assignedToId: args.assignedToId } : {}),
        },
      });
      flagId = existing.id;
      delta = 0;
      action = "updated";
    } else {
      // Re-opening a resolved/dismissed flag: the same complaint came back.
      // CAS on `status: { not: "open" }` so two concurrent re-opens can't both
      // count as a transition and double-increment the counter.
      const reopened = await tx.messageFlag.updateMany({
        where: { id: existing.id, status: { not: "open" } },
        data: {
          status: "open",
          resolvedById: null,
          resolvedAt: null,
          resolutionNote: null,
          ...(args.note !== undefined ? { note: args.note } : {}),
          ...(args.assignedToId !== undefined ? { assignedToId: args.assignedToId } : {}),
        },
      });
      flagId = existing.id;
      delta = reopened.count === 1 ? 1 : 0;
      // Only a transition that actually landed is a reopen; if a concurrent
      // caller reopened it first this is a no-op replay, not a second reopen.
      action = reopened.count === 1 ? "reopened" : "updated";
    }

    const openFlagCount = await bumpOpenFlagCount(tx, conversationId, delta);
    const flag = await readFlag(tx, flagId);
    await publishFlagEvent(tx, { args, flag, openFlagCount, action, conversationId });
    return { flag, openFlagCount, action };
  });

  kickOutbox();
  return { ok: true, ...result };
}

export interface UpdateFlagArgs extends EventGates {
  teamId: string;
  flagId: string;
  actor: FlagActor;
  /** Omitted = leave the lifecycle alone (this is an assignee/note-only edit). */
  status?: MessageFlagStatus;
  /** `null` clears the owner. Omitted leaves it unchanged. */
  assignedToId?: string | null;
  note?: string | null;
  resolutionNote?: string | null;
}

/**
 * Change a flag's lifecycle, owner, or notes.
 *
 * The counter maintenance is CAS-gated on the flag's PREVIOUS status, so two
 * agents resolving the same complaint at the same moment produce exactly one
 * decrement. Whichever transaction loses the race sees `count === 0`, applies a
 * delta of zero, and still returns the (identical) final state — so the caller
 * gets a success, not a spurious conflict error for an outcome that is exactly
 * what they asked for.
 */
export async function updateFlag(db: Db, args: UpdateFlagArgs): Promise<FlagMutationOutcome> {
  const existing = await db.messageFlag.findFirst({
    where: { id: args.flagId, teamId: args.teamId },
    select: { id: true, status: true, conversationId: true },
  });
  if (!existing) return { ok: false, reason: "flag_not_found" };

  if (args.assignedToId && !(await assertTeamMember(db, args.teamId, args.assignedToId))) {
    return { ok: false, reason: "assignee_not_found" };
  }

  const result = await db.$transaction(async (tx) => {
    const nextStatus = args.status;
    const statusChanges = nextStatus !== undefined && nextStatus !== existing.status;

    const data: Prisma.MessageFlagUpdateManyMutationInput = {
      ...(args.assignedToId !== undefined ? { assignedToId: args.assignedToId } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
    };

    if (statusChanges) {
      Object.assign(
        data,
        nextStatus === "open"
          ? // Re-opening wipes the resolution so a stale "resolved by Sara 3
            // weeks ago" can't sit on an open item.
            { status: "open", resolvedById: null, resolvedAt: null, resolutionNote: null }
          : {
              status: nextStatus,
              resolvedById: args.actor.userId ?? null,
              resolvedAt: new Date(),
              ...(args.resolutionNote !== undefined
                ? { resolutionNote: args.resolutionNote }
                : {}),
            },
      );
    } else if (args.resolutionNote !== undefined) {
      // Editing the resolution note of an already-resolved flag.
      data.resolutionNote = args.resolutionNote;
    }

    // CAS on the status we read: the write only lands if nobody changed the
    // lifecycle in between. On a lost race `count` is 0 and `delta` stays 0, so
    // the counter can't drift.
    const written = await tx.messageFlag.updateMany({
      where: { id: existing.id, status: existing.status },
      data,
    });

    const delta =
      written.count === 1 && statusChanges
        ? nextStatus === "open"
          ? 1
          : existing.status === "open"
            ? -1
            : 0
        : 0;

    const openFlagCount = await bumpOpenFlagCount(tx, existing.conversationId, delta);
    const flag = await readFlag(tx, existing.id);
    // Derive the action from the TRANSITION that actually happened, never from
    // the post-state alone. Deriving it from `flag.status` was wrong in both
    // directions: editing the note on an already-resolved flag reported
    // "resolved" (writing a duplicate audit row and re-firing the partner's
    // "complaint closed" webhook for a change that closed nothing), and a
    // genuine reopen reported "updated" (which the audit subscriber skips, so
    // the timeline still ended at "resolved" while the flag was open again).
    const action = !statusChanges || written.count !== 1
      ? ("updated" as const)
      : nextStatus === "open"
        ? ("reopened" as const)
        : ("resolved" as const);
    await publishFlagEvent(tx, {
      args,
      flag,
      openFlagCount,
      action,
      conversationId: existing.conversationId,
    });
    return { flag, openFlagCount, action };
  });

  kickOutbox();
  return { ok: true, ...result };
}

export interface RemoveFlagArgs extends EventGates {
  teamId: string;
  flagId: string;
  actor: FlagActor;
}

/**
 * Delete a flag outright — "this was flagged by mistake".
 *
 * Distinct from `dismissed`: dismissing keeps a record that someone looked and
 * decided it wasn't one (useful for judging AI precision), while removing
 * erases a flag that should never have existed. The audit timeline still
 * records the removal, so nothing vanishes without a trace.
 */
export async function removeFlag(db: Db, args: RemoveFlagArgs): Promise<FlagMutationOutcome> {
  const existing = await db.messageFlag.findFirst({
    where: { id: args.flagId, teamId: args.teamId },
    select: { id: true, status: true, conversationId: true },
  });
  if (!existing) return { ok: false, reason: "flag_not_found" };

  const result = await db.$transaction(async (tx) => {
    // Read the full shape BEFORE deleting — the event payload (and therefore
    // the socket frame, the audit row, and the webhook body) still needs to say
    // WHAT was removed.
    const flag = await readFlag(tx, existing.id);

    // Delete and learn the status IN ONE STATEMENT. The obvious version — CAS
    // on the status we read outside the transaction, then fall back to an
    // unconditional delete — has a hole in one direction: if a concurrent
    // reopen incremented the counter after our read, the guarded delete misses,
    // the fallback removes the now-OPEN row, and nothing decrements. The thread
    // then sits in the "Flagged" preset with no flag on it until the sweeper
    // runs. `DELETE … RETURNING` closes that: the status we decrement against is
    // by construction the status of the row we actually removed.
    const deletedRows = await tx.$queryRaw<Array<{ status: MessageFlagStatus }>>`
      DELETE FROM "MessageFlag" WHERE id = ${existing.id} RETURNING status
    `;
    const delta = deletedRows[0]?.status === "open" ? -1 : 0;

    const openFlagCount = await bumpOpenFlagCount(tx, existing.conversationId, delta);
    await publishFlagEvent(tx, {
      args,
      flag,
      openFlagCount,
      action: "removed",
      conversationId: existing.conversationId,
    });
    return { flag, openFlagCount, action: "removed" as const };
  });

  kickOutbox();
  return { ok: true, ...result };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

type TxClient = Parameters<Parameters<Db["$transaction"]>[0]>[0];

async function readFlag(tx: TxClient, id: string): Promise<MessageFlag> {
  const row = await tx.messageFlag.findUniqueOrThrow({
    where: { id },
    select: MESSAGE_FLAG_SELECT,
  });
  return mapFlag(row);
}

/**
 * Move `Conversation.openFlagCount` by `delta` and return the resulting value.
 *
 * `delta === 0` still reads the column, because the event payload always
 * carries the authoritative count — an idempotent replay that changed nothing
 * must not ship a stale or invented number to the inbox badge.
 *
 * The clamp exists for one reason: if drift ever pushed the counter negative
 * (a row deleted by a cascade the counter never saw), the "Flagged" filter's
 * `> 0` predicate would silently start hiding threads. Clamping keeps the
 * filter honest until the drift sweeper reconciles the true value.
 */
async function bumpOpenFlagCount(
  tx: TxClient,
  conversationId: string,
  delta: number,
): Promise<number> {
  if (delta === 0) {
    const row = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: { openFlagCount: true },
    });
    return row?.openFlagCount ?? 0;
  }

  const updated = await tx.conversation.update({
    where: { id: conversationId },
    data: { openFlagCount: { increment: delta } },
    select: { openFlagCount: true },
  });
  if (updated.openFlagCount >= 0) return updated.openFlagCount;

  await tx.conversation.update({
    where: { id: conversationId },
    data: { openFlagCount: 0 },
  });
  return 0;
}

async function publishFlagEvent(
  tx: TxClient,
  params: {
    args: EventGates & { teamId: string; actor: FlagActor };
    flag: MessageFlag;
    openFlagCount: number;
    action: "added" | "updated" | "reopened" | "resolved" | "removed";
    conversationId: string;
  },
): Promise<void> {
  const { args, flag, openFlagCount, action, conversationId } = params;
  await publishInTx(tx, {
    type: "message.flag_changed",
    teamId: args.teamId,
    conversationId,
    messageId: flag.messageId,
    action,
    flag,
    openFlagCount,
    changedByUserId: args.actor.userId ?? null,
    changedByApiKeyId: args.actor.apiKeyId ?? null,
    ...(args.silent !== undefined ? { silent: args.silent } : {}),
    ...(args.skipOutboundWebhook !== undefined
      ? { skipOutboundWebhook: args.skipOutboundWebhook }
      : {}),
  });
}

/** An assignee must be a live member of THIS team — otherwise a crafted id
 *  could hand a complaint to someone in another tenant. */
async function assertTeamMember(db: Db, teamId: string, userId: string): Promise<boolean> {
  const user = await db.user.findFirst({
    where: { id: userId, teamId, deactivatedAt: null },
    select: { id: true },
  });
  return Boolean(user);
}

/**
 * Re-run `fn` once if it failed on a unique-constraint violation. See the
 * comment at the `raiseFlag` call site for why the retry must be OUTSIDE the
 * transaction rather than a catch inside it.
 */
async function withUniqueRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return fn();
    }
    throw err;
  }
}
