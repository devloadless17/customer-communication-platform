import { existsSync } from "node:fs";

import { createTestPrismaClient } from "./_prisma";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The hand-written PARTIAL indexes must exist.
 *
 * Prisma's schema DSL cannot express a `WHERE` predicate, so these live in raw
 * SQL migrations — which means Prisma has no record of them, `prisma migrate
 * diff` doesn't see them, and `check:prisma-fields` can't either. Nothing in the
 * toolchain notices when one disappears.
 *
 * One did. The org→workspace rename renamed the tenant column with
 * `ALTER TABLE … DROP COLUMN "teamId"`, and dropping a column drops every index
 * whose key references it. SIX of these went with it — every single one keyed on
 * `teamId`, while the three that weren't (ChannelConnection_one_default_per_channel,
 * ConversationSessionSummary_one_open_per_conversation,
 * OutboundEvent_drainer_pending_idx) survived untouched. Four of the six were
 * UNIQUE: they are the backstops under check-then-act races the application
 * deliberately does not lock for, so their absence doesn't fail anything loudly
 * — it just lets duplicate contacts, duplicate default stages and concurrent
 * 100k imports through, occasionally, under load.
 *
 * This test is the tripwire: it costs one query and it fails the moment a
 * migration drops one again.
 *
 *   pnpm --filter @ccp/api exec vitest run test/partial-indexes.spec.ts
 */

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

/** Every raw partial index the product depends on, and what it protects. */
const REQUIRED_PARTIAL_INDEXES: {
  name: string;
  unique: boolean;
  protects: string;
  /** Present when the index's Prisma-inexpressibility is an expression/opclass
   *  rather than a WHERE predicate — asserted in place of the WHERE check. */
  signature?: string;
}[] = [
  {
    name: "TicketView_shared_name_key",
    unique: true,
    protects:
      "case-insensitive name uniqueness for SHARED saved views — two team " +
      "boards called 'Escalations' is a configuration nobody can tell apart",
  },
  {
    name: "TicketView_personal_name_key",
    unique: true,
    protects: "the same, per author, for PERSONAL views",
  },
  {
    name: "Ticket_subject_trgm_idx",
    unique: false,
    protects:
      "ticket search by subject — ILIKE '%term%' cannot use a btree index, so " +
      "without the trigram GIN every search sequential-scans Ticket",
  },
  {
    name: "Ticket_description_trgm_idx",
    unique: false,
    protects: "ticket search by CAUSE, the same scan for the ticket's founding text",
  },
  {
    name: "TicketEvent_body_trgm_idx",
    unique: false,
    protects:
      "ticket search across the comment / note thread — the timeline is the " +
      "largest ticket-side table and the one people search hardest",
  },
  {
    name: "Message_template_send_budget_idx",
    unique: false,
    protects:
      "the portfolio 24h messaging-budget query — it scans outbound TEMPLATE " +
      "sends on the largest table in the schema, so without this the gate " +
      "sequential-scans Message on every broadcast eligibility check",
  },
  {
    name: "Ticket_first_response_due_idx",
    unique: false,
    protects:
      "the SLA sweeper's minutely first-response scan — without it the scan " +
      "is a full Ticket table walk every 60s, with no failing test to say so",
  },
  {
    name: "Ticket_resolution_due_idx",
    unique: false,
    protects:
      "the SLA sweeper's minutely resolution scan — same full-table-walk " +
      "regression as the first-response leg if a baseline regen drops it",
  },
  {
    name: "WorkflowRun_event_key_uniq",
    unique: true,
    protects:
      "Outbox redelivery: without it a crash-window replay creates a SECOND " +
      "WorkflowRun and re-executes every step — including a second BILLED send.",
  },
  {
    name: "OutboundWebhookDelivery_event_key_uniq",
    unique: true,
    protects:
      "Outbox redelivery: the delivery id IS the partner's dedup header, so a " +
      "replay without this re-POSTs with a fresh id neither side can dedupe.",
  },
  {
    name: "ConversationEvent_event_key_uniq",
    unique: true,
    protects:
      "Outbox redelivery: without it a replay writes a second identical audit " +
      "pill (the messy-timeline class).",
  },
  {
    name: "Contact_workspaceId_phoneNumber_whatsapp_key",
    unique: true,
    protects:
      "two simultaneous first-time WhatsApp inbounds from one number creating two contacts — the §7 one-conversation-per-contact invariant",
  },
  {
    name: "ContactTransferJob_workspaceId_active_key",
    unique: true,
    protects: "two concurrent contact imports/exports for one workspace",
  },
  {
    name: "ContactStage_workspaceId_isDefault_key",
    unique: true,
    protects: "two default lifecycle stages, making 'the default' non-deterministic",
  },
  {
    name: "AiReplySuggestion_one_pending_per_inbound",
    unique: true,
    protects: "two pending AI suggestions for the same inbound message",
  },
  {
    name: "ChannelConnection_one_default_per_channel",
    unique: true,
    protects: "two default accounts on one channel, so outbound picks arbitrarily",
  },
  {
    name: "ConversationSessionSummary_one_open_per_conversation",
    unique: true,
    protects: "two open session summaries on one conversation",
  },
  // The last two of the seven UNIQUE race backstops 0_init's own header block
  // enumerates. They were the only ones that header named and this tripwire
  // did not pin — and they are doubly invisible to the toolchain: partial
  // (WHERE visibility = …) AND expression (lower(name)), so `migrate diff`
  // cannot see them in either direction.
  {
    name: "InboxView_shared_name_key",
    unique: true,
    protects:
      "two shared inbox views whose names differ only in case — the picker would show one workspace-wide filter twice with no way to tell them apart",
  },
  {
    name: "InboxView_personal_name_key",
    unique: true,
    protects: "the same case-insensitive clash among one user's personal views",
  },
  {
    name: "Conversation_workspaceId_unread_idx",
    unique: false,
    protects: "the inbox sidebar's five unread COUNT()s — its most repeated DB work",
  },
  {
    name: "Conversation_workspaceId_openFlag_idx",
    unique: false,
    protects: "the flagged-conversation filter's ordered index scan",
  },
  {
    name: "OutboundEvent_drainer_pending_idx",
    unique: false,
    protects: "the transactional-outbox drainer's pending scan",
  },
  {
    name: "Organization_isPlatform_idx",
    unique: false,
    protects:
      "the `isPlatform = false` filter every customer-facing org read applies — the platform operator's anchor org must never render as a tenant",
  },
  {
    name: "BroadcastRecipient_replied_idx",
    unique: false,
    protects:
      "the campaign report's 'who replied' drill-down — without it every page " +
      "of the filtered recipient list heap-scans the whole 100k-row campaign",
  },
  {
    name: "BroadcastRecipient_clicked_idx",
    unique: false,
    protects:
      "the campaign report's 'who clicked' drill-down — same full-campaign " +
      "re-scan per page as the replied leg if a baseline regen drops it",
  },
  // ── The 11 below were in the hand-maintained 0_init section but NOT here ──
  // Found 2026-07-31 by mechanically diffing that section against this list —
  // the section's own header says "keep [this spec] in lockstep" and it had
  // drifted by eleven. None are UNIQUE; all are performance indexes whose loss
  // is a silent seq-scan, which is exactly the failure this spec exists to make
  // loud. `signature` (instead of the default WHERE assertion) marks the ones
  // whose Prisma-inexpressibility is an expression/opclass, not a predicate.
  {
    name: "AiContextChunk_content_fts_idx",
    unique: false,
    signature: "to_tsvector",
    protects:
      "AI context retrieval — full-text search over knowledge chunks; without " +
      "the GIN every assistant lookup scans the workspace's whole corpus",
  },
  {
    name: "Contact_phoneNumber_trgm_idx",
    unique: false,
    protects:
      "contact search by partial phone number — ILIKE '%555%' cannot use a " +
      "btree; partial on phoneNumber IS NOT NULL so social-only contacts cost nothing",
  },
  {
    name: "Contact_workspaceId_marketingCapReachedAt_idx",
    unique: false,
    protects:
      "the per-user marketing-cap sweep — finding capped contacts without " +
      "scanning the whole directory (the column is NULL for almost everyone)",
  },
  {
    name: "Message_broadcastId_idx",
    unique: false,
    protects:
      "campaign message lookups ('every message this broadcast produced') — " +
      "partial on broadcastId IS NOT NULL because organic messages dominate",
  },
  {
    name: "Message_conversationId_timestamp_inbound_idx",
    unique: false,
    protects:
      "the 24h-window check — 'latest INBOUND in this thread' answered off the " +
      "index tip instead of walking outbound rows backwards",
  },
  {
    name: "Message_inbound_media_pending_idx",
    unique: false,
    protects:
      "the pending-media sweeper — inbound rows whose bytes never landed; " +
      "without the partial index every sweep scans all of Message",
  },
  {
    name: "OutboundEvent_retention_idx",
    unique: false,
    protects:
      "outbox retention — reaping published-and-not-failed rows by publishedAt " +
      "without scanning the live tail the drainer is working",
  },
  {
    name: "OutboundWebhookDelivery_orphan_pending_idx",
    unique: false,
    protects:
      "the orphaned-delivery sweep — never-attempted rows found by createdAt " +
      "instead of scanning every delivery ever made",
  },
  {
    name: "TeamChannelMessage_channel_toplevel_keyset_idx",
    unique: false,
    protects:
      "team-chat keyset paging — (channelId, createdAt DESC, id DESC) on " +
      "top-level messages only; without it every channel open re-sorts threads too",
  },
  {
    name: "WorkflowRun_active_startedAt_idx",
    unique: false,
    protects:
      "the workflow dashboard's active-runs lens and the stuck-run sweeper — " +
      "queued/running/waiting rows are a sliver of a table that only grows",
  },
  {
    name: "WorkflowRun_terminal_startedAt_idx",
    unique: false,
    protects:
      "workflow-run history paging and retention — the terminal-status " +
      "complement of the active lens",
  },
];

describe("hand-written partial indexes", () => {
  it("all exist, with the right uniqueness", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
    `;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    const missing = REQUIRED_PARTIAL_INDEXES.filter((i) => !byName.has(i.name));
    expect(
      missing.map((i) => `${i.name} — without it: ${i.protects}`),
      "partial index(es) missing from the database",
    ).toEqual([]);

    // A partial index that lost either its UNIQUE or its WHERE is not the same
    // constraint — a non-partial rebuild of the WhatsApp one, for instance,
    // would reject every Instagram contact sharing a phone number.
    for (const idx of REQUIRED_PARTIAL_INDEXES) {
      const def = byName.get(idx.name)!;
      if (idx.signature) {
        expect(def, `${idx.name} must keep its expression (${idx.signature})`).toContain(
          idx.signature,
        );
      } else {
        expect(def, `${idx.name} must stay PARTIAL`).toMatch(/WHERE/i);
      }
      if (idx.unique) {
        expect(def, `${idx.name} must stay UNIQUE — it is ${idx.protects}`).toMatch(
          /CREATE UNIQUE INDEX/i,
        );
      }
    }
  });

  it("none of them still key on the pre-rename `teamId` column", async () => {
    // `Contact_teamId_lastInboundAt_idx`, `InternalNote_teamId_…` and
    // `Message_teamId_…` are re-created by the rename migration under their OLD
    // NAMES over the new column — legal, but it means a `teamId` in an index
    // name is no longer evidence of a stale index. What would be a real problem
    // is an index still keyed on a column that no longer exists, which Postgres
    // cannot have; this asserts the weaker, checkable thing: no index DEFINITION
    // references a teamId column.
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef ILIKE '%"teamId"%'
    `;
    expect(rows.map((r) => r.indexname)).toEqual([]);
  });
});
