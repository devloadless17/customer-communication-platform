import "server-only";

import { Prisma, type Message } from "@prisma/client";

import { db } from "@/lib/db";

/**
 * CLAUDE.md rule #3: every write of a Meta wamid (`externalId`) must be
 * idempotent. Bare `db.message.create` is forbidden — the unique index throws
 * P2002 on a duplicate, which on outbound paths can happen via:
 *   - client retry after a transient 5xx from our own API
 *   - Meta returning a wamid that already exists (replay / manual repair)
 *   - two browser tabs sending the same optimistic payload
 *
 * On collision we return the EXISTING row so the caller can still emit
 * `message:new` with a real id and keep the optimistic UI flowing. Inbound
 * paths (ingest) want different semantics (silently drop on collision), so
 * they keep their own try/catch — this helper is for outbound only.
 */
export async function createOutboundMessageIdempotent(
  data: Prisma.MessageUncheckedCreateInput,
): Promise<Message> {
  try {
    return await db.message.create({ data });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      data.externalId
    ) {
      const existing = await db.message.findUnique({
        where: { externalId: data.externalId },
      });
      // Tenant guard: the unique index is global on externalId, but a foreign
      // team owning the row would be a Meta-side replay across tenants — we
      // never want to surface that. Treat as unrecoverable.
      if (existing && existing.teamId === data.teamId) return existing;
    }
    throw err;
  }
}
