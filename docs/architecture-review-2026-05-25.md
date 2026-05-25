# Architecture & Production-Readiness Review — 2026-05-25

**Scope:** Full-system audit requested by the owner — schema, domain model, event
architecture, realtime, workflows, automations, queues, integrations, message
pipeline, DB scalability, soft-delete/retention.

**Method:** *Delta + re-verify* against the prior certified audits (schema /
event-safety / stabilization, all 2026-05-22). Every finding below is anchored to
actual `file:line` evidence from six parallel deep-dives, not generic advice. Where
a "finding" is actually a **locked decision working as intended**, it's labelled
as such — per [project_external_reviews_vs_locked_decisions], generic reviews keep
"discovering" the things we deliberately chose not to build.

**No code was changed for this review.** This is a read-only audit + prioritized
fix backlog for the owner to triage.

---

## TL;DR verdict

The system **re-certifies as production-grade for the pilot**. The four subsystems
the owner ranked most important — live chat, realtime sync, message in/out, and
conversation assignment/status/stage/tag — are **safe, bounded, and fast** with
correct indexes, idempotency, and loop guards. The prior verdicts hold.

The deep-dive found **zero critical bugs**, **two genuine MEDIUM gaps**, and a
handful of LOW/NIT items. The single highest-value finding is the **multi-WhatsApp-
account gap** (the owner's stated #1 future need) — it is a real, pre-scoped
schema limitation, not a bug. The biggest *risk to the codebase* remains, as every
prior audit concluded, **over-tinkering** — see the "Do NOT touch" list at the end.

### Findings by severity

| # | Severity | Area | One-liner | Status |
|---|---|---|---|---|
| F1 | ~~MEDIUM~~ **RETIRED (not a gap)** | Channel accounts | "Can't run 2 WhatsApp numbers per team" — but Team = 1 org = 1 number is the business model; the constraint enforces it. NOT a feature. (corrected 2026-05-25) | Won't build |
| F2 | **MEDIUM** | /v1 idempotency | Non-send `/v1` mutations (assign/status/tag/contact) don't honor `Idempotency-Key` | Real gap, small fix |
| F3 | **LOW** | Analytics denorm | Conversation analytics counters drift silently on exception (no reconciler) | Real, low impact |
| F4 | **LOW** | Identity (future) | Inbound contact lookup keys on `phoneNumber` only — must switch to compound unique before channel #2 | Latent, only bites at multi-channel |
| F5 | **NIT** | Retention | `Verification` / `Session` have no app-side sweeper (Better Auth handles internally) | Verify, likely no-op |
| F6 | **NIT** | Webhook tracing | Correlation ID not propagated onto outbound webhook delivery rows | Nice-to-have |
| — | **RESOLVED this session** | /v1 echo loop | `silent` flag now threads through all `/v1` mutations (was the audit's "GAP #1") | Done 2026-05-25 |

Everything else across all 13 requested areas verified **SAFE**. Details below.

---

## Part 1 — The four most-important subsystems (owner's top priority)

### 1.1 Live chat / message in & out — SAFE

The message pipeline is the strongest part of the system. Every failure mode the
owner worried about (duplicate sends, lost messages, races, desync) is handled.

- **Inbound dedup** — `@@unique([teamId, channel, externalId])`
  ([schema.prisma:829](../prisma/schema.prisma#L829)) + a `findUnique` pre-gate
  before the tx ([ingest.ts:310-323]) + a P2002 catch as backstop ([ingest.ts:720-726]).
  On a Meta retry the webhook **still returns 200** so Meta stops retrying. Correct.
- **Inbound atomicity** — message insert + conversation bump + `unreadCount`
  increment + `Contact.lastInboundAt` bump + event publish all in **one
  transaction** with the outbox row written *inside* it via `publishInTx`
  ([ingest.ts:495-706]). Partial failure rolls everything back; no ghost rows, no
  leaked events.
- **Outbound double-send guard** — this is the critical one (an irreversible Meta
  send must not re-fire on a BullMQ retry). Guarded by `OutboundSendAttempt` keyed
  on a unique `jobId` ([messages.service.ts:494-582]): on retry it checks
  `completedAt` + `externalId`; if the prior attempt succeeded it **re-publishes
  `message.sent` and exits without calling Meta again**; if uncertain it *refuses*
  to retry (deliberate safety-first trade — rare loss over systematic double-send).
- **Send retries** — bounded at 3 attempts, exponential backoff
  ([send-queue.ts:88-102]); recoverable vs non-recoverable error classification;
  `message.send_failed` published on the first failure so the optimistic bubble
  flips immediately.
- **Optimistic reconciliation** — bubble keyed by `clientTempId`, swapped to the
  real id on `message.sent`; idempotent by `externalId`.
- **Races** — two simultaneous sends use distinct jobIds + idempotent rows +
  monotonic `lastMessageAt` guard; inbound-during-send uses Serializable isolation
  + P2034 retry on the reopen race. No lost-update found.

**Verdict: SAFE.** No genuine gaps. The "no `queued`/`processing` message status"
(owner's Q12) is **intentional** — the real in-flight state lives in BullMQ, not on
the row; the row is created at `sent` once Meta accepts. Adding intermediate
statuses would be complexity for no behavioral gain.

### 1.2 Realtime sync — SAFE

- **One central in-process bus** — every mutation publishes one `DomainEvent`;
  socket / audit / analytics / workflow-dispatch / webhooks all subscribe. No
  service-calling-service-calling-service; the only direct `emitToTeam` is the dev
  test harness. This is exactly the "publish a fact, subscribers react" model the
  owner asked for.
- **Subscriber ordering is explicit & load-bearing** — `SubscriberPriority`
  (REALTIME 0 → AUDIT 10 → ANALYTICS 20 → WORKFLOW_DISPATCH 30 →
  WEB_CACHE_REVALIDATE 40 → OUTBOUND_WEBHOOKS 50) enforced by sorted insertion, not
  import order ([bus.ts:65-114]).
- **No feedback loops** — fanout-rules handlers are pure socket emits; none call
  `publish()`. Verified by grep.
- **Scoped emits** — team-room + conversation-room + channel-room ([rooms.ts]);
  broadcast events deliberately scoped to the conversation room (not team-wide) so
  a 1k-recipient broadcast can't storm every agent's tab.
- **Coalesced bulk fanout** — per-contact events carry `suppressSocketFanout:true`
  + one `contact.bulk_updated` frame; bounds 500×25 from ~12,500 frames to 25.
- **Absolute (not delta) counters** — `unreadCount` published as the post-write
  absolute so brief client/server drift self-heals.
- **Reconnect convergence** — 30s `connectionStateRecovery` + full-refetch on long
  disconnect, re-auth on recovery ([ws-adapter.ts]). Converges to server state with
  no custom replay layer.

**Verdict: SAFE.** No event storms, no recursive emits, no duplicate writes.

### 1.3 Conversation assignment / status / stage / tag — SAFE

- DB-enforced **one conversation per contact** (`@@unique([teamId, contactId])`,
  [schema.prisma:744]) — closed threads reopen, never fragment.
- Assignment uses CAS on `(assignedUserId, status)` so concurrent assigns get a 409,
  not a silent clobber; auto status-flip (assign→open, unassign→pending) publishes a
  second `status_changed` ([conversations.service.ts:283-400]).
- Status/stage/tag changes flow through the bus → reducers on both the live thread
  and the cached inbox shell (the "realtime cache patch matrix" in CLAUDE.md).
- The `silent` flag (extended this session) lets code/API mark a mutation as
  "don't trigger reactions" — covers the owner's loop-avoidance need end to end.

**Verdict: SAFE.**

### 1.4 Realtime performance / smoothness — SAFE

- Hot-path indexes all present and exactly shaped for keyset pagination:
  inbox list `@@index([teamId, lastMessageAt DESC, id DESC])` ([schema.prisma:735]);
  thread load `@@index([conversationId, timestamp DESC, id DESC])`
  ([schema.prisma:837]); status-filtered list ([schema.prisma:729]); trigram GIN on
  `Contact.name` + `Conversation.lastMessagePreview` for search.
- Inbox thread is intentionally **not virtualized** (a blind attempt broke media
  layout — see [project_inbox_thread_not_virtualized]); correct as-is.
- Payloads are scoped and the list updates incrementally via reducers, not whole-list
  invalidation.

**Verdict: SAFE.** The "fast/smooth/soft" goals are met by the current design.

---

## Part 2 — Genuine findings (ranked)

### F1 — RETIRED (NOT a gap, by design) — was: "Multiple WhatsApp accounts per team"

> **CORRECTION (2026-05-25):** The owner confirmed the tenancy model is
> **multi-tenant SaaS where Team = one customer org = ONE WhatsApp number.**
> Multiple WhatsApp numbers per team is therefore **NOT a feature gap — it's
> explicitly outside the business model.** The `@@unique([teamId, channel])`
> constraint below *enforces* that rule; it is correct, not a limitation. This
> finding is **retired** — do not build channelConnectionId-on-rows / multi-number
> routing. The analysis below is preserved only as a record of how the constraint
> works. See memory `project_tenancy_model`.

**(Historical — was originally framed as the owner's #1 future need.)**

**Current state:**
- `ChannelConnection` is keyed `@@unique([teamId, channel])`
  ([schema.prisma:307]) → **exactly one connection per channel per team**. Creating
  a second `whatsapp` row fails with P2002.
- `Contact.identityChannel`, `Conversation.channel`, `Message.channel` carry the
  **enum** (`whatsapp`), **not** a `channelConnectionId` FK.
- The send path loads the single connection by
  `findUnique({ teamId_channel: { teamId, channel: "whatsapp" } })`
  ([providers/config.ts:160-184]) — there is no way to express "which WhatsApp
  number."

**Consequence:** A team **cannot** run two WhatsApp numbers today. Even if the
unique constraint were relaxed, nothing on a `Conversation` says which number it
belongs to, so sends couldn't route and inbound couldn't be attributed.

**This is a known, documented, pre-scoped limitation** — not a bug. See
[docs/external-architecture-review-2026-05-22.md] (row 4: "`UNIQUE(teamId, channel)`
blocks 2 numbers — Intentional + documented; the fix-when-needed is
`channelConnectionId`") and [docs/plan-schema-foundation-2026-05-22.md] ("add
`channelConnectionId` FK so sends pick the right account number").

**The fix (when a customer actually needs it):**
1. Change `ChannelConnection` key from `@@unique([teamId, channel])` to allow
   multiple per channel (add a `label`/`displayNumber`; keep a per-channel
   "primary" flag or make the key `@@unique([teamId, channel, externalNumberId])`).
2. Add nullable `channelConnectionId` FK to **Conversation** (source of truth) and
   **Message** (so dedup + routing are unambiguous). Backfill existing rows to the
   team's single connection. *Contact* probably does **not** need it — a contact is
   already channel-siloed and bound to one conversation; the connection lives on the
   thread. (Confirm before adding to Contact — that's the over-engineering trap.)
3. Route the send path off `channelConnectionId`, not `channel`.
4. Route inbound: the webhook URL is already per-team; add the `phoneNumberId` from
   the Meta payload to pick the right connection.

**Recommendation:** Do **not** build this now. It's correctly deferred. Build it the
day a pilot signs who needs a second number — the schema migration is non-destructive
and pre-planned. Flagging it so it's a conscious "not yet," not a surprise.

---

### F2 — MEDIUM: `/v1` non-send mutations don't honor `Idempotency-Key`

**Current state:** The shared idempotency machinery (`ApiIdempotencyKey`, claim →
execute → store-response, 5-min pending / 24h completed TTL, request-hash reuse
guard) is wired for **text + template sends**
([external-v1-messaging.service.ts:89-190]) — verified working, covers templates.
But the **non-send** `/v1` mutations do **not** check the header:
- `POST /v1/conversations/:id/assign` (+ by-contact)
- `POST /v1/conversations/:id/status` (+ by-contact)
- `POST /v1/contacts/:id/tags` (add/remove), `PATCH /v1/contacts/:id`

**Consequence:** A partner retry (n8n re-fires on a timeout) can apply the mutation
twice. Most are naturally idempotent at the DB (status is set-once, assignment is a
FK overwrite, tag add is a connect), so the *data* rarely corrupts — but each retry
**re-publishes the domain event**, which re-fires workflows/webhooks. With the
`silent` flag now available this is *containable*, but true idempotency would make
retries free.

**Severity is MEDIUM not HIGH** because the DB-level idempotence + the new `silent`
opt-in already blunt the worst case (the echo-loop). The clean fix is to extract the
existing claim/execute helper from the send path and wrap the four mutation handlers
with it (reusing `ApiIdempotencyKey`). Small, mechanical, no new infra.

> Note: the webhook-safety deep-dive originally flagged a sibling "GAP #1: silent
> not set on /v1 mutations (MEDIUM)". **That was closed earlier this session** — the
> `silent`/suppress flag now threads through assign/status/tag/contact-update on all
> `/v1` paths. The agent was reading pre-session code. F2 (idempotency) is the
> remaining, distinct half.

---

### F3 — LOW: Conversation analytics counters drift silently on exception

**Current state:** `trackOnAssigned` / `trackOnStatusChanged` /
`trackOnOutboundMessage` ([conversations/analytics.ts:22-154]) update the
denormalized counters (`assignmentsCount`, `incomingMessagesCount`,
`outgoingMessagesCount`, `responsesCount`) and timestamps (`firstResponseAt`,
`closedAt`, …) inside a `try/catch` that **only logs** on failure (analytics.ts:52,
94, 148). A failed update is swallowed; there is **no reconciliation sweeper** for
these fields (unlike `Contact.lastInboundAt`, which *does* have a daily drift
sweeper).

**Consequence:** On a transient DB error the counter/timestamp drifts low and never
self-heals. Impact is limited to **workflow-analytics trigger payloads** and any
future reporting surface — it does **not** affect chat, unread, assignment, or any
hot path. The owner has no analytics dashboards today (deferred), so blast radius is
near-zero now.

**Recommendation:** Either (a) accept it (swallowing is deliberate — analytics must
never break a send), or (b) add a periodic re-derive sweeper mirroring the
`lastInboundAt` pattern if/when analytics become user-visible. **Do not** make the
counter update throw — that would let analytics break a send. Low priority.

---

### F4 — LOW (latent): Inbound contact lookup keys on `phoneNumber` only

**Current state:** Identity is modeled correctly at the **schema** level — a partial
unique `(teamId, phoneNumber) WHERE identityChannel='whatsapp'`
([project_phone_unique_partial_whatsapp]) plus a compound unique
`(teamId, identityChannel, externalContactId)` ([schema.prisma:580]) for non-phone
channels. Together these cover every channel without collision.

**The latent issue is in the ingest *query*, not the schema:** the inbound lookup is
`findFirst({ where: { teamId, phoneNumber } })` ([ingest.ts:386-389]) — it keys on
phone and does **not** filter by channel. Today that's fine (only WhatsApp exists).
But when channel #2 ships, this query must switch to the compound key
`(identityChannel, externalContactId)` for non-phone channels, or a Telegram contact
sharing a phone with a WhatsApp contact could resolve to the wrong row.

**Recommendation:** This is a **pre-condition on the multi-channel work**, not a
standalone fix. When F1's channel work lands (or any second channel), update the
ingest lookup to route by channel. The schema is already correct and future-proof;
only the query needs the switch. **Phone-based uniqueness is NOT dangerous** — it's
scoped to WhatsApp by the partial index. Verdict on the owner's Q3: **CLEAN, with
this one query to fix before channel #2.**

---

### F5 — NIT: `Verification` / `Session` have no app-side retention sweeper

`Verification` and `Session` (Better Auth tables) have no entry in
`lib/sweepers/`. **However**, Better Auth 1.6.x runs its own expired-session cleanup
internally, and the `session.guard.ts` cache evicts expired entries on read
([session.guard.ts:148-194]). So this is likely a **no-op**, not a real leak.

**Recommendation:** Confirm Better Auth's `session.expiresIn` + its internal cleanup
is active (it is by default). If you want belt-and-suspenders, a trivial daily
`DELETE WHERE expiresAt < now()` sweeper for both tables costs ~30 min — but it's
optional. **Do not** treat this as urgent.

### F6 — NIT: Correlation ID not propagated to outbound webhook deliveries

`getCorrelationId()` is request-scoped via ALS ([common/correlation.ts]) and works
within HTTP handlers, but the async outbound-webhook delivery worker runs outside
that scope, so a delivery row can't be traced back to the originating request by
correlation ID. The stable `X-CCP-Delivery` header (= delivery row id) + payload IDs
already allow manual joining.

**Recommendation:** Optionally capture `getCorrelationId()` onto the
`OutboundWebhookDelivery` row at creation and echo it as `X-CCP-Trace-Id`.
Nice-to-have for debugging, not a safety issue.

---

## Part 3 — Verified SAFE (the owner's explicit worry-list, all clear)

These were investigated against real code and found safe. Listed so the owner knows
they were *checked*, not skipped.

**Workflow engine (owner's #5 — every loop vector checked):**
- Infinite loops / recursion: `trigger_workflow` depth cap **8** with chain-depth
  stamped on child runs ([steps/trigger-workflow.ts:41,84-114]); **DAG cycle
  detection at publish** via white/gray/black DFS ([workflows/graph.ts:210-246]).
- Runaway steps: per-run ceiling **100 steps**, jump counter capped, counted by
  distinct stepId so retries don't burn the budget ([workflows/runner.ts:28,523-587]).
- `silent` on every mutating step (assign/tag/set-status/lifecycle/field/comment) —
  verified, none missing.
- Waits/awaiting-reply: `expiresAt` + two sweepers (waiting-runs 60s, awaiting-reply
  hourly) with grace windows; no forever-wait.
- Retries: BullMQ 3 attempts + exponential backoff, run marked `failed` on
  exhaustion ([workflows/queue.ts:89-94]).
- Once-per-contact ledger: `WorkflowContactState` unique `(workflowId, contactId)`,
  transactional marker-before-run, P2002 = bail.
- Graph snapshot pinned at run creation ([dispatcher → runner], commit 0171a65) so
  editing a live workflow can't corrupt an in-flight run.
- **Verdict: SAFE on all 8 axes.** The system is intentionally *not* Turing-complete;
  it's a bounded DAG. Exactly what the owner asked for.

**Event/queue/integration safety (owner's #6, #7):**
- Transactional **outbox** (`OutboundEvent` + `OutboxDrainerService`):
  `publishInTx` writes the event row in the caller's tx; drainer claims via
  `UPDATE … WHERE publishedAt IS NULL … RETURNING` (at-most-once, no double-dispatch).
- Webhook bounce loop: `X-CCP-Depth` stamped outbound ([http-request.ts:129-140]),
  read + capped at **8** inbound ([workflows.service.ts:746-758]).
- Inbound `incoming_webhook` idempotency: Redis `SET NX` 24h on
  `Idempotency-Key` ([workflows.service.ts:760-793]).
- Outbound delivery: BullMQ **4 attempts**, stable `X-CCP-Delivery` header for
  partner dedup, **circuit breaker auto-disables after 20** consecutive failures
  with disable/recover events.
- Replay protection: Meta HMAC-SHA256 + externalId dedup; `incoming_webhook`
  ±5-min timestamp window folded into the signed payload.
- Origin tracking: every mutation event carries `changedByUserId` **xor**
  `changedByApiKeyId` — API-driven vs human-driven is unambiguous; `X-CCP-Origin-Key`
  on outbound lets a partner recognize its own echo.
- **All 6 CLAUDE.md "Event-safety audit 2026-05-22" hardening fixes verified present
  in code** (not just documented).

**Contact/Conversation responsibilities (owner's #1):** Clean separation — Contact
owns identity/tags/stage/customFields, Conversation owns assignment/status/unread/
runtime + analytics. **No field is dual-owned.** The only cross-entity denorms are
`Contact.lastInboundAt` (reconciled by a daily sweeper) and the analytics counters
(F3). The 1:1-today reality is fine: the split is by *responsibility*, and the
locked invariant (one conversation per contact, channel-siloed) is what makes it 1:1
— not a modeling smell.

**Custom fields (owner's #4):** CLEAN. Zod caps **50 keys × 80-char key × 500-char
value**, flat record only (no nesting) ([contacts.schemas.ts:58-76]); GIN
`jsonb_path_ops` index exists. ~30-50 KB/contact ceiling. No uncontrolled growth.

**DB scalability & retention (owner's #10):** Eight retention sweepers verified with
windows — `OutboundSendAttempt` 7d, `OutboundEvent` 7d, `WorkflowRun` 30d,
`OutboundWebhookDelivery` 30d, `ApiIdempotencyKey` 24h, plus the drift/awaiting/blob
sweepers. Hot-path indexes all present. `Message.rawPayload` grows unbounded **by
design** (CLAUDE.md rule #4, debugging) — the documented scaling cliff is ~1M
msgs/month; add a 180-day `rawPayload` purge then, not now.

**Soft-delete consistency (owner's #11):** SAFE. `deletedAt: null` filter applied
consistently across **all 10** list/search/count/export/audience/forward queries
(verified individually). Soft-deleting a contact preserves its conversation
(intentional) and cascades clean up runtime state (`WorkflowContactState`,
`WorkflowAwaitingReply`, `BroadcastRecipient`). Stage delete refuses if live
contacts reference it; tag delete is non-destructive (label only). Cascade vs
SetNull rules all correct (Team→cascade, User→SetNull preserves history,
Contact→cascade guarded by soft-delete).

**Message delivery states (owner's #12):** Current `sent/delivered/read/failed` is
correct; monotonic rank guard prevents regressions; `failed` is terminal. No
`queued/processing` needed — in-flight state lives in BullMQ. SAFE.

---

## Part 4 — Do NOT touch (over-tinkering guardrails)

Every prior audit named **over-tinkering as the #1 risk**. These are working,
deliberate decisions. Changing them adds risk for no gain:

- **No Person/Customer super-entity, no cross-channel merge.** Contacts are
  channel-siloed by design ([project_contacts_siloed_per_channel]). Re-ratified.
- **No `provider`/`vendor` field.** `channel` is the one discriminator. (Don't
  "re-add provider for multi-account" — F1's fix is `channelConnectionId`, not a
  provider column.)
- **No Redis pub/sub for sockets yet, no second app instance.** In-process bus is
  correct for single-VPS; the trigger is a second instance, not now.
- **No Zustand / React Query.** Plain React + reducers + socket frames.
- **Inbox thread not virtualized.** A prior attempt broke media layout; don't retry
  without a browser ([project_inbox_thread_not_virtualized]).
- **Don't selectively encrypt one customer-data column.** Partial encryption is
  security theater (CLAUDE.md); whole-DB TDE is the real fix, on the enterprise
  trigger.
- **Don't add intermediate message statuses** or make analytics throw.
- **`Message.rawPayload` stays forever** until the documented 1M/month cliff.

---

## Part 5 — Suggested action order (if anything)

Nothing here is required for pilot. In rough value order:

1. **F2 (idempotency on `/v1` mutations)** — small, mechanical, removes a real
   partner-retry footgun. ~1-2h. *Worth doing.*
2. **F4 prep** — leave a `TODO` at [ingest.ts:386] noting the lookup must switch to
   the compound key before channel #2 (so it's not forgotten —
   cf. [feedback_not_in_this_batch_means_forgotten]). 5 min.
3. ~~**F1 (multi-WhatsApp)**~~ — **RETIRED (2026-05-25): not a gap.** Team = 1 org
   = 1 WhatsApp number is the business model; the unique constraint enforces it.
   Don't build it. See memory `project_tenancy_model`.
4. **F3 / F5 / F6** — optional; defer until analytics/observability are user-facing.

---

*Reviewed by: deep multi-agent read-only audit, reconciled against the 2026-05-22
certified audits. Verdict: re-certified production-grade for pilot. Highest-value
finding = the pre-scoped multi-WhatsApp gap (F1). Highest *risk* = over-tinkering.*

> **2026-05-25 follow-up:** F1 is RETIRED — multi-WhatsApp-per-team is outside the
> business model (Team = 1 org = 1 number), not a gap. F2–F6 all fixed since.
