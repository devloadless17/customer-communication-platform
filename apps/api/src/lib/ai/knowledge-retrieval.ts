import { db } from "@/lib/db";

/**
 * Retrieve the top knowledge chunks relevant to a query — tenant-filtered and
 * limited (correction #8). Uses the Postgres full-text GIN index added in the
 * migration; pgvector can replace this later without changing the interface.
 * NEVER returns another tenant's chunks: `workspaceId` is a bound parameter, and only
 * chunks of enabled + ready documents are considered.
 *
 * MATCH ANY TERM, RANK BY HOW MANY. The query used to be `plainto_tsquery`,
 * which ANDs every word of the customer's message: "how much is delivery to
 * beirut?" only matched a chunk containing all of how/much/is/delivery/to/
 * beirut, so a real question almost never retrieved anything and the model
 * answered with "(no matching company knowledge)". Now the message is reduced
 * to its content words, OR'd together as prefix terms (`deliver:*` matches
 * "delivery"), and `ts_rank` puts the chunks matching the most of them first.
 * The config stays `'simple'` on both sides — it must equal the expression the
 * GIN index was built on, or the index is not used.
 */

export interface RetrievedChunk {
  id: string;
  content: string;
  documentId: string;
}

const MAX_TERMS = 24;

export async function retrieveContextChunks(
  workspaceId: string,
  query: string,
  limit = 6,
): Promise<RetrievedChunk[]> {
  const tsq = buildOrTsQuery((query || "").slice(0, 1000));
  if (!tsq) return [];
  const cap = Math.max(1, Math.min(limit, 12));
  try {
    const rows = await db.$queryRaw<RetrievedChunk[]>`
      SELECT c."id", c."content", c."documentId"
      FROM "AiContextChunk" c
      JOIN "AiContextDocument" d ON d."id" = c."documentId"
      WHERE c."workspaceId" = ${workspaceId}
        AND d."enabled" = true
        AND d."status" = 'ready'
        AND to_tsvector('simple', c."content") @@ to_tsquery('simple', ${tsq})
      ORDER BY ts_rank(to_tsvector('simple', c."content"), to_tsquery('simple', ${tsq})) DESC
      LIMIT ${cap}
    `;
    return rows;
  } catch {
    // A malformed tsquery or missing index must never break a reply — degrade
    // to "no retrieved context" (the company profile still grounds the answer).
    return [];
  }
}

/**
 * Customer text -> `term1:* | term2:* | …`, or "" when nothing is left to
 * search for. Tokens are letters/digits only, so no tsquery operator can leak
 * in from the message. Single characters and filler words are dropped: in an
 * OR query "is"/"to"/"shu" match nearly every chunk and would drown the rank.
 */
export function buildOrTsQuery(text: string): string {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    terms.add(raw);
    if (terms.size >= MAX_TERMS) break;
  }
  return [...terms].map((t) => `${t}:*`).join(" | ");
}

// English, Lebanese Arabizi and Arabic filler — the words a customer's
// question is built from but a knowledge document is never ABOUT.
const STOPWORDS = new Set<string>([
  // English
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "am", "do", "does",
  "did", "to", "of", "in", "on", "at", "for", "from", "by", "with", "and", "or",
  "but", "if", "so", "it", "its", "this", "that", "these", "those", "there",
  "here", "what", "which", "who", "whom", "how", "when", "where", "why", "can",
  "could", "would", "should", "will", "shall", "may", "might", "must", "have",
  "has", "had", "i", "me", "my", "we", "us", "our", "you", "your", "he", "she",
  "they", "them", "their", "please", "pls", "plz", "hi", "hello", "hey", "thanks",
  "thank", "ok", "okay", "yes", "no", "not", "any", "some", "much", "many",
  "about", "want", "need", "know", "tell", "get", "also", "just", "too", "very",
  // Lebanese Arabizi
  "shu", "chu", "sho", "ana", "enta", "ente", "inta", "inte", "huwe", "hiye",
  "ne7na", "fi", "fe", "w", "wa", "l", "el", "il", "3a", "3al", "ma", "eh", "ee",
  "la", "kif", "keef", "badde", "baddi", "bade", "bdi", "hal", "yalli", "ya",
  "mn", "men", "min", "ma3", "kel", "kell", "hayda", "hayde", "hek", "lesh",
  "aya", "ayya", "mar7aba", "marhaba", "merci", "mersi", "ahla", "halla2",
  // Arabic
  "في", "من", "على", "عن", "ما", "هل", "انا", "أنا", "شو", "كيف", "بدي", "يا",
  "و", "مع", "هذا", "هذه", "هيدا", "هيدي", "لو", "او", "أو", "مرحبا", "شكرا",
]);
