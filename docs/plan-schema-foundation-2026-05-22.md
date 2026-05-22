# Schema foundation plan — post-audit (2026-05-22)

Outcome of the deep schema/architecture audit. Sequenced foundational changes,
each independently shippable + smoke-bootable. **Execution gated on Docker/DB
being up** (every item touches a critical runtime path and must be smoke-booted;
the channel remodel also needs a live enum migration). Review, then "go".

## Locked product decision (user-confirmed 2026-05-22)

**`Contact` = a single CHANNEL IDENTITY, never a human.** A WhatsApp account and
a Telegram account are independent `Contact` rows with independent
`Conversation`s **even when they're the same human** — the accounts differ, so
the records differ. There is deliberately **NO `Person`/`Customer` super-entity
and NO cross-channel merge/unified profile.** (Already in memory as
`contacts-siloed-per-channel`; now explicitly ratified.) Consequence: a
`Conversation` is 1:1 with a `Contact` (the contact is already channel-scoped),
so "one conversation per channel per contact" collapses to **one conversation
per contact**, reopened on re-contact rather than fragmented.

---

## Change 1 — DB-enforce "one conversation per contact" (highest certainty)

**Why:** the system's core invariant is currently code-only (find-or-create +
reopen). A race (two near-simultaneous inbound webhooks for a new contact, a
forward racing an inbound) can create a second `Conversation` → permanently
fragmented inbox, silently.

**Schema:** on `Conversation`, replace `@@index([teamId, contactId])` with
`@@unique([teamId, contactId])`. (Contact is channel-siloed, so this is exactly
"one conversation per channel per contact".)

**Code (load-bearing — this is why it can't go in blind):** every find-or-create
site must become race-safe against the new constraint, NOT crash on P2002:
- `lib/providers/ingest.ts` — conversation create runs inside the inbound tx; a
  P2002 there aborts the whole tx. Convert to `tx.conversation.upsert` on
  `teamId_contactId` (INSERT … ON CONFLICT — race-safe at the DB), with the
  conditional reopen (closed→pending) applied as a follow-up update, since
  upsert's `update` can't express "only if currently closed".
- `messages.service.ts` forward `processContact`, `external-v1-messaging`
  `sendTopLevelMessage`, `lib/broadcast-runner.ts` — wrap create in
  catch-P2002→refetch.

**Migration:** for the fresh `0_init` baseline, fold the unique in (regenerate
offline). For **existing prod**, pre-check dups before applying:
`SELECT "teamId","contactId",count(*) FROM "Conversation" GROUP BY 1,2 HAVING count(*)>1;`
— resolve any (merge/close) before the unique will apply.

**Verify:** smoke-boot; send two rapid inbounds from a brand-new number; confirm
exactly one conversation + no ingest error.

---

## Change 2 — Model CHANNEL as distinct from PROVIDER (the multi-channel fix)

**Why:** today `ProviderName { meta_cloud }` is the channel discriminator on
`Conversation`/`Message`/`Contact`, and `ChannelConnection @@unique([teamId,
provider])`. But Meta Cloud serves **both WhatsApp and Instagram** — so (a) a
team can't connect WhatsApp *and* Instagram (both `meta_cloud`, unique blocks
the 2nd), and (b) `provider=meta_cloud` can't tell a WA thread from an IG thread.
This is the one place the schema is under-modeled for the stated multi-channel
vision. Cheapest to fix now (only value is `meta_cloud`, no IG data yet).

**Model:** the discriminator everything keys on becomes the **channel** (the
medium); **provider** (the delivery vendor) becomes an attribute of the
connection.
- Rename enum `ProviderName` → `Channel`; value `meta_cloud` → `whatsapp`.
  (TS safety: `ProviderName` is a string-literal union, so every `"meta_cloud"`
  literal + `Record<ProviderName,…>` registry key becomes a compile error →
  typecheck surfaces all sites. The residual runtime risk is dynamic/JSON string
  use → smoke-boot.)
- `ChannelConnection`: `@@unique([teamId, channel])` + add `provider Provider`
  (new tiny enum `{ meta_cloud }`). A team now has a WhatsApp(meta_cloud) row AND
  an Instagram(meta_cloud) row.
- `Conversation`: keep `channel Channel`; add `channelConnectionId` FK so sends
  resolve credentials directly (no `(teamId, channel)` lookup).
- `Message.channel`, `Contact.identityChannel` follow the rename.
- `publicChannel()` (the webhook/API channel field, added 2026-05-22) becomes
  derivable from the row's `channel` instead of a constant.

**Migration (existing prod):** `ALTER TYPE "ProviderName" RENAME VALUE
'meta_cloud' TO 'whatsapp'` + `ALTER TYPE … RENAME TO "Channel"` + add the
`provider` column/enum + backfill + the new unique. Real migration → needs a
live DB to author + test. Fresh `0_init` just defines the end state.

**Verify:** smoke-boot; round-trip a WhatsApp send + inbound; confirm provider
binding still resolves; confirm webhook/API `channel` reads "whatsapp".

**NOT now:** do not build Instagram. This is purely the seam so a 2nd channel is
a row + a `MessagingProvider` impl, never a schema migration on a live messages
table.

---

## Change 3 — Soft-delete `Contact` (production-grade deletion semantics)

**Why:** today `Contact` delete is hard cascade → wipes all conversations,
messages, AND audit (`ConversationEvent`) irreversibly. No undo; audit dies with
the row. A comms platform wants recoverable delete + explicit GDPR purge.

**Schema:** `Contact.deletedAt DateTime?` (+ index). Reads filter
`deletedAt IS NULL`. Keep an explicit hard-purge path for "right to be
forgotten". Conversations/messages stay cascade under a soft-deleted contact
(filtered out via the contact).

**Code (why it needs care):** EVERY contact read path must filter `deletedAt`
(inbox, contacts list, search, lookup, count, export, audience resolve) — a
missed filter = ghost contacts. Needs the app running to verify each surface.

**Verify:** smoke-boot; soft-delete a contact; confirm it vanishes from all
surfaces; confirm purge removes it + history.

---

## Change 4 — Retention sweeps (table-growth, lower priority)

- `Message.rawPayload`: null it after N days (biggest messages-table-growth
  lever; debugging value decays). New sweeper in `lib/sweepers/`.
- `WorkflowRun`: drop completed/failed/skipped older than N days (fat JSON rows,
  fastest-growing at automation volume). New sweeper.

Both wire into `WorkflowWorkerService` lifecycle alongside the existing sweepers.
Additive; verify they run + delete only intended rows.

---

## Sequencing & verification discipline

1. Change 1 (uniqueness) — smallest, highest-certainty, do first.
2. Change 2 (channel remodel) — biggest; its own branch + migration + smoke-boot.
3. Change 3 (soft-delete contact).
4. Change 4 (sweeps).

Each: typecheck (both apps) + `prisma validate` + **smoke-boot the api** + the
per-change manual check above, before claiming green. Existing prod also needs
the migration-baseline reconciliation from the migration squash (see the squash
notes) — fold these deltas into that cutover.
