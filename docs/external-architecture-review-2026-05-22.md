# External architecture review — advice vs. our system (2026-05-22)

Captured so this doesn't get re-litigated. An external advisor sent a schema
review, an architecture writeup, and three diagrams. Verdict: one genuine fix
(#8); everything else is already built, deliberately deferred, or contradicts a
locked decision. The recurring pattern: the advice keeps recommending the things
we **chose not to build**.

## The one real action
**#8 — Snapshot the workflow graph at run creation.** `runWorkflow()` reads the
*live* `Workflow.graph` on every pickup, including resume from `wait`/`ask_question`.
Editing a workflow mid-run corrupts the in-flight run. Fix: `WorkflowRun.graphSnapshot`
JSONB, written at creation, read by the runner. (Held until the UI-redesign branch
lands on `main`, then done on a fresh branch — see the session plan for the file-level
implementation spec.)

## Schema review (10 points)
| # | Claim | Verdict | Why |
|---|---|---|---|
| 1 | Add `Conversation.channelConnectionId` | Deferred (known cliff) | `(teamId, channel)` already uniquely routes today; only needed for a 2nd WhatsApp number. Locked MVP decision (rule #7). |
| 2 | `Message.externalId` should be nullable | **Wrong** | Message rows are created only *after* Meta returns a wamid; pending state lives on `OutboundSendAttempt`. Nullable breaks the dedup unique. |
| 3 | Add `_ConversationToTag` | **Wrong** | Tags are deliberately contact-scoped (reverted in migration `20260516160000`). `ConversationEventKind.tag_added` audits contact-tag changes on the 1:1 timeline. |
| 4 | `UNIQUE(teamId, channel)` blocks 2 numbers | Intentional + documented | Locked rule #7; the fix-when-needed is #1's `channelConnectionId`. |
| 5 | Add priority / SLA deadline | Product decision — skipped | Out of current scope; user chose skip. SLA can be computed, not stored. |
| 6 | Add team/group assignment | Deferred | Bigger than round-robin (paused Round 2c, which assigns to users). Not in the advisor's own domain model either. |
| 7 | Collapse `enabled`+`published` into status enum | **Wrong** | They're orthogonal (kill-switch vs test-vs-prod), not a 3-state ladder. An enum loses a real distinction + breaks the `[teamId,trigger,enabled,published]` index. |
| 8 | No workflow versioning / mid-run edits | **Real find** | The only genuine gap. Snapshot the graph at run creation. |
| 9 | `identityChannel` NULL uniqueness | Non-issue | Advisor self-resolves; `UNIQUE(teamId, phoneNumber)` already covers manual-contact dedup. |
| 10 | Rename `TeamChannel` | Cosmetic churn — skip | Shipped subsystem (Message/ReadReceipt/Pin/Member); rename = pure churn. Collision is conceptual only. |

## "5 critical decisions" + stack + realtime
| Advice | Reality |
|---|---|
| Normalize at adapter boundary (UniversalMessage) | Done — `MessagingProvider` + `MetaProvider.parse`; `Message.rawPayload` = their `raw`. |
| Channel-scoped contact identity | Done + locked — `@@unique([teamId, identityChannel, externalContactId])`. "Merge later = separate feature" = our locked no-`Person` rule. |
| Event bus is the spine, append-only | Done — DomainEvent bus + `OutboundEvent` outbox + `ConversationEvent` timeline. |
| Workflows async + off the hot path | Done — `dispatch()` enqueues to BullMQ after store+fanout; fail-soft by design. |
| Adapters are plugins | Done — `getProviderBinding(channel)`, one impl per vendor per channel. |
| Stack: NestJS / Socket.io / BullMQ / Postgres | Matches. |
| Stack: Redis cache, S3, n8n | Deliberate deferrals — in-memory rate-limit (documented Redis trigger), UploadThing (documented S3/R2 trigger), n8n via external `/v1` API. |
| Realtime: Redis-backed Socket.io / presence | **Diverged & better** — in-process emit, zero pub/sub hop; Redis adapter deferred to 2nd instance. |
| "Every agent sees read receipts" | Diverged — replaced by **team-wide unread** (team chat has its own receipts). Settled; don't re-add per-agent. |
| Build sequence steps 1–5 | All done. Step 6 "more channels" = explicitly deferred (WhatsApp depth first). |
| `sla.breached` events | Declined (matches #5 skip). |

## The three diagrams
- **Workflow engine:** matches box-for-box; we're a **superset** (DAG with branch/jump/wait/ask_question + crash-safe `stepLog`, vs the diagram's linear queue). Only "Assign → team" is missing (= #6).
- **System architecture:** mostly ours. **Reject** two boxes: "Event Bus (Redis pub/sub or Kafka)" — we run in-process; and "Contact Svc: merge" — contradicts no-merge. Deferred-future: 5 channels, S3, Redis cache. "Webhooks (outbound HTTP)" = our paused outbound-webhooks workstream.
- **Domain model:** mostly right, and "Contact = customer on one channel" matches our lock — which **contradicts** the system diagram's "merge" (advisor is internally inconsistent; our version is the consistent one). Two intentional structural differences: **no `Inbox` entity** (channel lives on Conversation/Contact + ChannelConnection), and **no normalized `Action` table** (graph JSON on the Workflow row) — the latter is *exactly why #8 exists*.

## Locked decisions the advice keeps pulling against (do not concede)
1. In-process event bus + Socket.io emit — NOT Redis pub/sub / Kafka (until a 2nd instance).
2. Channel-scoped contacts, NO cross-channel merge, NO `Person`/`Customer` super-entity.
3. WhatsApp depth before multi-channel breadth; provider seam is ready but dormant.
4. Channel discriminator is `Channel` (the medium) on the rows — NO "provider"/"vendor" column, NO `Inbox` table.
5. Team-wide unread, NOT per-agent inbox read state.

## Second schema review (later same day, 2026-05-22)
A different reviewer did a deeper schema pass. Sharper than the first — its
"don't touch" section correctly validated the locked decisions above. But almost
all its *actionable* calls were wrong, and it **contradicted the first review on
three tables the first one correctly told us to keep**.

**Score: 1 minor-legitimate find out of ~9 claims.**
- ✅ **`InternalNote.teamId` missing** — the one real item. It was the only
  conversation-child without `teamId` while its sibling `ConversationEvent` had one
  — a real deviation from rule #2. **Fixed** (branch `feat/internal-note-teamid`):
  additive nullable→backfill→NOT NULL→FK→index migration + `teamId` set at all 4
  create sites. (Reviewer's stated reason — "team deletion needs a join" — was off;
  deletes already cascade `Team→Conversation→InternalNote`. The real value is
  rule-#2 uniformity + future RLS.)
- ❌ **Add telegram/instagram to the `Channel` enum "before it breaks":** locked
  WhatsApp-first deferral; and "breaks" is false — enum values are additive
  (`ALTER TYPE … ADD VALUE`), a non-destructive migration.
- ❌ **`Broadcast.templateId` needs an FK:** it's a *documented snapshot*
  (`template*` fields frozen at send; soft `templateId` for UI), same as
  `audienceGroupId`/`createdById` — never cascade-delete audit history.
- ❌ **Index `WorkflowRun.contactId` for once-per-contact:** self-contradictory —
  once-per-contact is `WorkflowContactState` (unique index), which the same review
  praised. No `WorkflowRun.contactId` query exists.
- ❌ **Remove `Contact.version`:** it IS used — app-level optimistic-lock CAS in
  workflow tag/update steps (`where: { …, version }`, `version: { increment: 1 }`).
- ❌ **Remove `OutboundEvent`:** it's the transactional outbox for the internal
  domain-event bus — a different layer from `OutboundWebhookDelivery` (external HTTP).
- ❌ **Remove `OutboundSendAttempt` / add `messageId` FK:** it's the Meta-send
  idempotency ledger; the `Message` row is created only *after* Meta returns a wamid,
  so a `messageId` FK is impossible. It guards BullMQ retries from double-sending.
- ❌ **Remove `ApiIdempotencyKey`:** the `/v1` API is public/partner-facing
  (n8n etc.); idempotency is required.
- ❌ **"Audience/Broadcast is confused":** misread a documented snapshot/audit design
  as live reconciliation — recipients are materialized once into `BroadcastRecipient`;
  `audienceTagIds`/`audienceGroupId` are audit metadata, not reconciled at send.

**Tells (same pattern as review #1):** doesn't know locked decisions (Channel),
misses app-level enforcement (`version` CAS), conflates distinct tables (the two
outbox tables; the send-attempt ledger), and reads deliberate documented denorm as
accidental redundancy. It told us to delete three things review #1 correctly kept
(`version`, `OutboundEvent`, `ApiIdempotencyKey`).
