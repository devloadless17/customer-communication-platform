import { db } from "@/lib/db";

/**
 * Retrieve the top knowledge chunks relevant to a query — tenant-filtered and
 * limited (correction #8). Uses the Postgres full-text GIN index added in the
 * migration; pgvector can replace this later without changing the interface.
 * NEVER returns another tenant's chunks: `workspaceId` is a bound parameter, and only
 * chunks of enabled + ready documents are considered.
 */

export interface RetrievedChunk {
  id: string;
  content: string;
  documentId: string;
}

export async function retrieveContextChunks(
  workspaceId: string,
  query: string,
  limit = 6,
): Promise<RetrievedChunk[]> {
  const q = (query || "").slice(0, 1000).trim();
  if (!q) return [];
  const cap = Math.max(1, Math.min(limit, 12));
  try {
    const rows = await db.$queryRaw<RetrievedChunk[]>`
      SELECT c."id", c."content", c."documentId"
      FROM "AiContextChunk" c
      JOIN "AiContextDocument" d ON d."id" = c."documentId"
      WHERE c."workspaceId" = ${workspaceId}
        AND d."enabled" = true
        AND d."status" = 'ready'
        AND to_tsvector('simple', c."content") @@ plainto_tsquery('simple', ${q})
      ORDER BY ts_rank(to_tsvector('simple', c."content"), plainto_tsquery('simple', ${q})) DESC
      LIMIT ${cap}
    `;
    return rows;
  } catch {
    // A malformed tsquery or missing index must never break a reply — degrade
    // to "no retrieved context" (the company profile still grounds the answer).
    return [];
  }
}
