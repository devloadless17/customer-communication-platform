/**
 * WHERE EACH CUSTOMER CAME FROM — acquisition attribution, aggregated.
 *
 * Every ad-sourced inbound already carries `Message.attribution`: the parser
 * fills it from Meta's `referral` block on a Click-to-Messenger ad, an m.me
 * `ref` deep link, an Instagram Shop product tap, and WhatsApp's Click-to-WhatsApp
 * `ctwa_clid`. It has been driving the "from your ad" chip on the bubble since
 * social shipped. Nothing has ever aggregated it, so a business could see that
 * ONE conversation came from an ad but never "which ad brought us 40 customers
 * last month".
 *
 * ## The attribution belongs to the FIRST inbound, and only to it
 *
 * Meta sends `referral` on the message that STARTS the conversation — the click
 * itself. Later messages in the same thread carry none. So counting attributed
 * MESSAGES would undercount nothing but would double-count nothing either; it
 * simply answers a different, useless question ("how many messages arrived with a
 * referral"). The question a business asks is about PEOPLE, so this counts
 * distinct contacts, keyed on their earliest attributed inbound.
 *
 * ## Why the source is read, not inferred
 *
 * `source` is stamped by the parser from what Meta actually sent — `ad` when
 * there is an `ad_id`, `ref` for a bare deep link, and so on. Re-deriving it here
 * from the presence of `clickId` would disagree with the chip the agent saw on
 * the bubble, and two numbers for one fact is worse than one imperfect number.
 *
 * ## Cost
 *
 * One workspace-scoped aggregate over inbound messages that HAVE attribution.
 * `attribution` is a JSONB column with no index today, so this is a filtered scan
 * — acceptable for a report that is opened deliberately rather than polled, and
 * bounded by the date window the caller passes. If it ever shows up in the slow
 * log the fix is a partial index on `(workspaceId, timestamp) WHERE attribution
 * IS NOT NULL`, which belongs in the hand-maintained raw-index section rather
 * than the Prisma DSL (it cannot express a WHERE).
 */

import { db } from "@/lib/db";
import { DIRECTORY_CONTACT_SQL } from "@/lib/queries/contacts";

export interface AcquisitionSourceRow {
  /** `ad` | `ref` | `post` | `unknown` — Meta's own classification, as parsed. */
  source: string;
  /**
   * WHICH ad, post, or deep link. `adId` on every Meta channel (Messenger's
   * `referral.ad_id`, WhatsApp's `referral.source_id`), then `postId`, then the
   * `ref` payload. Null when Meta gave none — an ad referral with no id is rare
   * but real, and dropping those rows would make the totals disagree with the
   * funnel.
   */
  sourceId: string | null;
  /** The ad creative's headline, when Meta included one. Null otherwise. */
  headline: string | null;
  /** Distinct CONTACTS acquired through this source — not messages. */
  contacts: number;
  /** Earliest and latest acquisition, so a stale source is visibly stale. */
  firstAt: string | null;
  lastAt: string | null;
}

export interface AcquisitionSourcesReport {
  rows: AcquisitionSourceRow[];
  /** Directory contacts who arrived in the window carrying NO attribution at all. */
  organic: number;
}

/**
 * WHERE ONE CUSTOMER CAME FROM — the single-contact counterpart of the report
 * above, for the contact panel and the `/v1` API.
 *
 * The same fact is already on the message bubble, but only on the message that
 * started the thread: on a customer you have been talking to for six months
 * that is thousands of messages up, so in practice nobody ever sees it. The
 * question "which ad won us this customer" is asked while looking at the
 * CUSTOMER, so the answer belongs on the profile.
 *
 * Returns the FIRST attributed inbound across all of the contact's threads —
 * the same rule the aggregate uses, so the profile and the report can never
 * disagree about which ad gets the credit. Null when they arrived organically.
 *
 * Cost: one lookup riding `Message`'s conversation+timestamp ordering, bounded
 * by `LIMIT 1`. Deliberately NOT folded into the conversation payload the inbox
 * loads on every thread open — this is a rarely-read profile field, and the
 * inbox's open path is the one place in the app where an extra query per open
 * is actually felt.
 */
export async function contactAcquisition(
  workspaceId: string,
  contactId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db.$queryRaw<{ attribution: unknown; at: Date }[]>`
    SELECT m."attribution" AS attribution, m."timestamp" AS at
    FROM "Message" m
    JOIN "Conversation" conv ON conv."id" = m."conversationId"
    WHERE m."workspaceId" = ${workspaceId}
      AND conv."contactId" = ${contactId}
      AND m."direction" = 'in'
      AND m."attribution" IS NOT NULL
    ORDER BY m."timestamp" ASC
    LIMIT 1
  `;
  if (!row) return null;
  // The attribution blob is passed through verbatim rather than reshaped: it is
  // already the normalized shape the parser writes for every Meta channel, and
  // the bubble renders it from the same keys. A second projection here is how
  // the panel and the bubble end up describing one referral differently.
  const attribution =
    row.attribution && typeof row.attribution === "object"
      ? (row.attribution as Record<string, unknown>)
      : {};
  return { ...attribution, at: row.at.toISOString() };
}

/**
 * Acquisition sources for a workspace over a window.
 *
 * `since`/`until` bound the scan and are inclusive of `since`. Omitting them
 * reports all time, which is the right default for a business that wants to know
 * which ad has ever worked.
 */
export async function acquisitionSources(
  workspaceId: string,
  opts: { since?: Date; until?: Date; channel?: string } = {},
): Promise<AcquisitionSourcesReport> {
  const since = opts.since ?? new Date(0);
  const until = opts.until ?? new Date(8_640_000_000_000);

  // FIRST attributed inbound per contact. `DISTINCT ON` is the cheap Postgres
  // idiom for "one row per group, ordered" and avoids a window function over the
  // whole message table.
  const rows = await db.$queryRaw<
    {
      source: string | null;
      sourceId: string | null;
      headline: string | null;
      contacts: bigint;
      firstAt: Date | null;
      lastAt: Date | null;
    }[]
  >`
    WITH first_attributed AS (
      SELECT DISTINCT ON (c."id")
             c."id"                                    AS "contactId",
             m."attribution"->>'source'                AS "source",
             -- WHICH AD, or which post, or which deep link. One column because
             -- they are the same question ("which source"), and a report with
             -- three mostly-null id columns is harder to read than one.
             --
             -- Deliberately NOT clickId: that is a per-CLICK id (WhatsApp
             -- ctwa_clid), unique per person, so grouping on it would produce one
             -- row per customer and answer nothing. adId is the same thing on
             -- every Meta channel - Messenger referral.ad_id and WhatsApp
             -- referral.source_id both land there.
             --
             -- NOTE: no backticks in this comment. It sits inside a tagged
             -- template literal, so a backtick TERMINATES the SQL string - which
             -- is exactly what happened on the first attempt at this edit.
             COALESCE(
               m."attribution"->>'adId',
               m."attribution"->>'postId',
               m."attribution"->>'ref'
             )                                        AS "sourceId",
             m."attribution"->>'headline'              AS "headline",
             m."timestamp"                             AS "at"
      FROM "Message" m
      JOIN "Conversation" conv ON conv."id" = m."conversationId"
      JOIN "Contact" c ON c."id" = conv."contactId"
      WHERE m."workspaceId" = ${workspaceId}
        AND m."direction" = 'in'
        AND m."attribution" IS NOT NULL
        AND m."timestamp" >= ${since}
        AND m."timestamp" <= ${until}
        AND (${opts.channel ?? null}::text IS NULL OR m."channel"::text = ${opts.channel ?? null})
      ORDER BY c."id", m."timestamp" ASC
    )
    SELECT "source",
           "sourceId",
           -- One headline per source: Meta can vary the creative text across a
           -- campaign, and MIN keeps the choice deterministic instead of
           -- whichever row Postgres happened to reach first.
           MIN("headline")   AS "headline",
           count(*)          AS "contacts",
           MIN("at")         AS "firstAt",
           MAX("at")         AS "lastAt"
    FROM first_attributed
    GROUP BY "source", "sourceId"
    ORDER BY count(*) DESC
  `;

  // Contacts whose first inbound carried nothing. Counted separately rather than
  // as a row, because "organic" is the ABSENCE of a source — folding it in would
  // let it sort above real campaigns and read as the best-performing one.
  //
  // DIRECTORY contacts only. Ephemeral webchat visitors (`vis_<uuid>` sessions
  // with no phone/email) are hidden from the contacts list, CSV and audience
  // counts, so counting them here would make "All N contacts arrived directly"
  // disagree with the directory's own total — N anonymous chat sessions read as
  // N organically-acquired customers. Same rule, same shared predicate.
  //
  // The channel filter narrows organic by the contact's IDENTITY channel — the
  // dimension a per-channel acquisition view is actually cut on. Leaving organic
  // workspace-wide while the rows narrowed was the same
  // numerator-and-denominator-from-different-questions mistake the share column
  // in the panel avoids.
  //
  // Same for the WINDOW, and it was wrong the same way: the attributed side
  // counts contacts ACQUIRED in [since, until], so organic must count arrivals
  // in that window too — unbounded, it counted every directory contact the
  // workspace has ever had and overstated organic (and every share percentage
  // with it). Bounded on `Contact.createdAt`, which is when the contact entered
  // the directory: the closest thing the table carries to "arrived", riding the
  // (workspaceId, createdAt) index instead of a per-contact MIN over Message.
  // The NOT EXISTS stays ALL-TIME on purpose — a contact whose ad click landed
  // before the window is attributed, not organic, and must not be counted twice.
  const organicRows = await db.$queryRaw<{ organic: bigint }[]>`
    SELECT count(*) AS organic
    FROM "Contact" c
    WHERE c."workspaceId" = ${workspaceId}
      AND c."deletedAt" IS NULL
      AND ${DIRECTORY_CONTACT_SQL}
      AND c."createdAt" >= ${since}
      AND c."createdAt" <= ${until}
      AND (${opts.channel ?? null}::text IS NULL OR c."identityChannel"::text = ${opts.channel ?? null})
      AND NOT EXISTS (
        SELECT 1
        FROM "Message" m
        JOIN "Conversation" conv ON conv."id" = m."conversationId"
        WHERE conv."contactId" = c."id"
          AND m."direction" = 'in'
          AND m."attribution" IS NOT NULL
      )
  `;

  return {
    rows: rows.map((r) => ({
      source: r.source ?? "unknown",
      sourceId: r.sourceId,
      headline: r.headline,
      contacts: Number(r.contacts),
      firstAt: r.firstAt?.toISOString() ?? null,
      lastAt: r.lastAt?.toISOString() ?? null,
    })),
    organic: Number(organicRows[0]?.organic ?? 0),
  };
}
