import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
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

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Every raw partial index the product depends on, and what it protects. */
const REQUIRED_PARTIAL_INDEXES: { name: string; unique: boolean; protects: string }[] = [
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
      expect(def, `${idx.name} must stay PARTIAL`).toMatch(/WHERE/i);
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
