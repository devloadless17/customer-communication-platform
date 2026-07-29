# Verification Ledger — 2026-07-29 program

The single authority on what has been verified, how, and when, for THIS program.
A domain is ✅ only when every invariant in its section maps to a **green test**
or an explicit **R-only (reason)** note, with the commit hash recorded. Anything
else is unverified — no matter how confident anyone feels about it.

The predecessor ledger (`tests/VERIFICATION.md`, 28/28 closed on `80f606c8`) is
kept as history: its ACCEPTED-tradeoff reasoning is still the record of *why*
things are the way they are. This file re-opens every domain, because **225
files / +14,341 / −1,517 landed after the last audited commit `f4efe96c` with no
verification pass at all**, and because closing a domain never immunises it.

Method codes: **R** = adversarial code-reading pass · **E** = existing tests
audited (still asserting the invariant, green, isolation-scoped) · **N** = new
targeted tests written.

Edge themes applied per domain (mark N/A explicitly, never silently):
① concurrent double-submit / CAS races · ② at-least-once redelivery ·
③ mid-flight deletion of a referenced entity · ④ reconnect / backfill
convergence · ⑤ timezone + window boundaries · ⑥ empty inputs · ⑦ huge inputs ·
⑧ permission boundaries (agent/manager/admin/org-admin/superadmin) ·
⑨ workspace isolation · ⑩ pause/resume/worker-restart.

**The multi-account lens is applied to EVERY domain**, not just its own row: for
each one, does every path here *name a channel account*, or does it silently
resolve the workspace default? That single question has produced a HIGH in five
separate prior sessions.

Checklist generation rule (run at the start of each domain session):
invariants = CLAUDE.md §18 + `docs/<domain>.md` + schema constraints + lib
READMEs; seams = grep `publish(`/subscribers + FK relations + cross-domain
imports + `fanout-rules.ts` entries + thread-reducer wiring + `/v1` twins. Every
lifecycle-ending op gets a named seam-trace listing every table/queue/cache/
socket-room that references the dying entity.

## Predeploy ritual (run before every push to `production`)

1. `pnpm run check` (typecheck ×3 + lint + 7 checkers) — must be 0 ERRORS
2. `pnpm test` (Vitest, api + web)
3. `pnpm test:e2e:meta` (hermetic; needs Postgres + Redis)
4. `pnpm test:e2e:multiaccount` — **never concurrently with 3** (both spawn the
   same api on :4001 and mock Graph on :4100)
5. `pnpm test:e2e` against the running stack, with an **explicit path filter**
   (a bare run also picks up `multi-account/` and `uiux/`, which expect a
   different stack) and `CALLS_SKIP_PREFLIGHT=0`
6. Canary intact after 3–5 (automatic — the run fails if not)

---

## Phase 0 — Baseline (2026-07-29, HEAD `44d538e0`)

**Gate status after this session's fixes — all four green, re-run end to end:**
`pnpm run check` 0 errors / 7 checkers · vitest **827/827** + web **18/18** ·
meta e2e **170/170** · multi-account e2e **42/42**.

| Gate | Result |
|---|---|
| `pnpm run check` | ✅ **0 errors**, 28 warnings, 7/7 checkers green |
| `pnpm test` — api vitest | ⚠️→✅ **INTERMITTENT on arrival** (812/813, then 813/813 ×2 — Finding #0, root-caused and fixed). Now **827/827**, zero skipped under `BLOB_STORAGE_DRIVER=local` |
| `pnpm test` — web vitest | ✅ 18/18 |
| `pnpm test:e2e:meta` | ⛔→✅ **169/170** on arrival; the one failure was the `@pressure` harness, not the app — **170/170** after Finding #1 |
| `pnpm test:e2e:multiaccount` | ⛔→✅ **37/38 on arrival**; the failure was a real HIGH — Finding #2. Now **42/42** (＋4 new reports-lens cases) |
| `pnpm test:e2e` (main, dev stack, 537) | ⛔→✅ **534/537** on arrival; 1 env artifact + **2 stale specs asserting abandoned contracts** — see Finding #4. Green after |

Note for anyone re-running: locally `pnpm test:e2e:meta` runs **170** tests, not
the 166 the old ledger records — `@pressure` is `grepInvert`ed only when `CI` is
set, so a local run includes it and a CI run does not.

### Step 0 — `docs/` restored (`44d538e0`)

All 35 files under `docs/` had been deleted from `production` by `5ed0247a`
(commit message: "delted", 37,161 deletions, no additions — a pure deletion).
They still existed on `main`. CLAUDE.md §20 links ~25 of them and they are the
checklist source for ~10 domains, so the audit's invariant source was being read
through `git show main:` — or not at all.

Restored verbatim from `main`. **`main` is 131 commits behind `production`**, so
every restored doc is stale for anything shipped after it (cross-workspace
escalation, the multi-account spine, calling artifacts, reports). Per-doc drift
is recorded as a finding inside the relevant domain session, not fixed up front.

### Finding #0 — `pnpm test` is intermittently red, and the cause is a real serialization property of ticket creation

**Symptom.** Run 1 of `pnpm test` failed one test —
`tickets.spec.ts > numbering > hands out unique sequential numbers under
concurrent creates` — with:

```
Transaction API error: A query cannot be executed on an expired transaction.
The timeout for this transaction was 15000 ms, however 15775 ms passed since
the start of the transaction.
  at bumpOpenTicketCount  (lib/tickets/mutations.ts:1128)
  at createTicketInTx     (lib/tickets/mutations.ts:217)
```

Runs 2 and 3 passed 813/813. In isolation the whole 27-test file runs in **1.3
s**, three times consecutively.

**This is the THIRD appearance of the same failure, and it has been misdiagnosed
twice.** `7d9149e7` raised the interactive-transaction timeout 5 s → 15 s; the
post-matrix delta then centralised those options in `apps/api/test/_prisma.ts`.
Both treated it as test configuration. The 15 s ceiling is now blown too, so a
third ceiling raise would be the third wrong fix.

**Measured cause — not inferred.** Sampling `pg_stat_activity` every 2 s through
a full suite run:

```
22:17:29 conns=44 active=16 idletx=1 lockwait=7
22:17:33 conns=51 active=12 idletx=1 lockwait=2
22:17:35 conns=39 active=9  idletx=5 lockwait=1
```

Peak 51 connections against `max_connections = 120` — **connection exhaustion is
ruled out**. The signal is `lockwait=7`: seven backends blocked on a *Lock*.

`allocateNumber` (`lib/tickets/mutations.ts:985`) takes a row lock via
`upsert … increment`, and its own docblock states the property correctly:
*"Postgres blocks the second concurrent allocator until the first commits."*
It is called at line **182**, and the transaction then does the workspace-scoped
tag query, `ticket.create`, `bumpOpenTicketCount`, `conversation.update`,
`readTicket` and `writeTicketEvent` — **all while holding the lock every other
concurrent create in that workspace is queued behind**. N concurrent creates
therefore cost the Nth agent N × (a full create), not N × (one increment).

**Why it matters beyond the suite.** This is a production property, not a test
artifact: ticket creation does not scale with concurrency *within a workspace*,
and the failure mode for the agents at the back of the queue is a hard 500. The
15 s ceiling is a mitigation that hides it until the box is loaded enough.

**FIXED 2026-07-29.** `createTicket` now allocates on the base client, before
opening its transaction, so the counter's row lock lives for one statement
instead of spanning the whole create. Concurrent creates then proceed in
parallel. The allocation sits INSIDE the `withUniqueRetry` closure, so a P2002
still re-allocates — the collision backstop is untouched.

The tradeoff is that a create failing after allocation burns its number.
`docs/ticketing.md` sanctions exactly that: *"Gaps are fine; collisions are
not."* — the contract was checked before the code was changed, not after.

`escalations.ts:175` still allocates inside its transaction, deliberately:
creating an escalation twin is a rare operator-driven act with no concurrency to
serialize, and keeping it in-transaction means a failed escalation leaves no gap.

**MEASURED**, three runs each on an idle box, N concurrent `createTicket` calls
in one workspace (temporary harness, since removed):

| N | before (allocate in-tx) | after (allocate pre-tx) |
|---|---|---|
| 8 | realtime layer | 1 | R (adversarial) + E (18 reducer + storm guard) | ✅ **2026-07-29** — all three reducer consumers verified table-driven; no defect |
| 24 | notes | 3 | R (adversarial) | ✅ **2026-07-29** — clean; the visibility spread verified safe for a structural reason (scalar return shape) |

~2× at N=8 with no overlap between the two ranges. The absolute numbers are
small because the box is idle; the win scales with how long each in-lock
statement takes, which is exactly the loaded case where the 15 s ceiling was
being blown.

Pinned by a new case in `tickets.spec.ts` — *"a burnt number leaves a GAP and is
never handed out twice"* — NEGATIVE-TESTED by swapping in the gap-reusing
`max(number)+1` implementation, which fails it and the sequential-allocation
case together. **Stated honestly: that pin protects the numbering CONTRACT, not
the lock placement.** A revert of the perf change would not fail it; the
evidence for the perf property is the measurement above. A timing assertion
strong enough to catch a revert would be flaky in CI, which is a worse trade.

**Stale comment corrected on the way**: `createTicketInTx`'s docblock claimed it
was split out "because the ingest path opens a ticket in the same transaction as
the message write". Untrue since auto-open was removed on 2026-07-25 — ingest
only ATTACHES or REOPENS, and `createTicket` is the sole caller.

### Finding #1 — the pressure harness cannot converge, and its failure message misdiagnoses why

`zz-pressure-burst-ingest.spec.ts` failed both times it was run, reporting
*"every delivered message must commit; a 200 that never commits is silent
loss"* for ~200 of 500 messages. **It is not silent loss.** Every one of those
messages has a recorded status history of:

```
pass1:503, pass2-redelivery:503, pass3-redelivery:429, pass4-redelivery:429, pass5-redelivery:429
```

`503` and `429` are both statuses Meta retries, so the ingest invariant — *every
non-2xx must be a status Meta RETRIES* — is intact. What failed is the harness's
own convergence phase.

**Measured, idle-box run:**

```
pass1  500 webhooks  8072ms  61.9/s  p50=392ms p95=728ms max=1361ms
       shed 297/500 (59.4%) as retryable 503
pass2  297 webhooks  2896ms  102.6/s p50=201ms p95=580ms max=784ms
pass3  196 webhooks   108ms  1814/s  p50=7ms          <- all 429, instant refusals
pass4  193 webhooks    75ms  2573/s  p50=7ms
pass5  192 webhooks    53ms  3622/s  p50=6ms
```

**Ingest itself is healthy.** 61.9/s sits at the top of the recorded 42–63/s
band, and p95 728 ms is *better* than the recorded 883–950 ms. Passes 3–5 are
fast because they are the rate limiter refusing instantly, not because work got
faster.

**The harness defect is arithmetic.** The budget is
`WebhookRateLimitGuard` — 600/min **per workspace** (plus 1200/min per IP), a
continuously-refilling token bucket at `perMin/60_000` per ms, i.e. 10
tokens/second. *(An earlier draft of this entry blamed
`ip-rate-limit.middleware.ts` `PER_MINUTE = 600`. Wrong source, same number:
that middleware explicitly `shouldSkip`s `/webhooks/*`. Corrected.)*

Pass 1 spends 500 of the 600, leaving ~100. So redelivery has headroom only
while pass 1 shed fewer than ~100 of 500 — **under about 20 %**, which is
exactly the 9–22 % band this harness has historically measured. It has always
passed by a margin of at most a few dozen requests. At a 60 % shed every
redelivery pass is refused 429 and convergence is arithmetically impossible *no
matter how correct ingest is* — so the harness reports the rate limiter as data
loss. The spec's own comment claimed redelivering only the missing indices
avoided this; that mitigation silently stops working above ~20 % shed.

**FIXED.** The harness now waits for the tokens each redelivery round will
spend (`length / 10` seconds + margin) before sending it — the honest model,
since Meta honours `Retry-After` rather than giving up. It also asserts **zero
429s** in every redelivery round, so if it is ever measuring the limiter again
it fails loudly instead of reporting throttling as lost data.

**RESOLVED — ingest is CORRECT under burst.** With the harness fixed, the spec
**passes**:

```
pass1  500 webhooks  8860ms  56.4/s  p50=421ms p95=892ms max=1575ms
       shed 318/500 (63.6%) as retryable 503
pass2  318 (after a 32.8s token wait)  58.5/s  p50=386ms p95=938ms
pass3  173 (after 18.3s)               66.2/s
pass4  1   (after 1.1s)
→ converged: all 500 committed, no duplicates, no thread fragmentation
```

Throughput and latency sit inside the recorded band (42–63/s, p95 883–950 ms),
so nothing regressed. **The shed rate is not a correctness signal** — this
ledger's predecessor says so explicitly, having watched shed RISE when conflicts
that used to vanish as a silent 200 started being reported honestly as 503s.
What matters is the pair: every non-2xx is a status Meta retries, and the burst
converges. Both hold.

*Two hypotheses raised and refuted on the way, both worth recording so they are
not re-run:* (1) the new account re-stamp adds an unconditional write —
**refuted by reading**, `ingest.ts:2223` writes `channelConnectionId` only when
it differs, and a fresh conversation already carries it from the insert at 2207;
(2) the elevated shed was contention from my own dev stack sharing Postgres —
**refuted by measurement**, 61.6 % on a quiet box with the dev stack stopped.

### Finding #2 — HIGH, FIXED: every `message.sent` outbound webhook named the wrong account after a thread re-stamp

**Found by** `tests/e2e/multi-account/03-reads-and-webhooks.spec.ts:133`, which
was **already red in the tree** — the multi-account suite is not wired into CI
and is not in the old ledger's predeploy ritual, so nothing was running it.

**The defect.** `resolveEventAccountId`
(`outbound-webhooks.subscriber.ts:812`) resolves which of our numbers an event
belongs to, and its first branch deliberately prefers `Message.channelConnectionId`
— the immutable record of which number actually carried the send — over the
`Conversation` pointer, which ingest re-stamps whenever the customer writes to a
different number of ours. That branch read `raw.messageId`, a **top-level**
field. Auditing `packages/shared/src/events/types.ts`, only these carry one:
`MessageStatusChangedEvent`, `MessageReactionChangedEvent`, `MessageUpdatedEvent`,
`MessageFlagChangedEvent`, `MessageMediaReadyEvent`.

`MessageSentEvent` does **not**. It carries the whole `Message` DTO, so its id is
at `message.id`. The branch therefore never matched for `message.sent`, fell
through to the conversation pointer, and reported the account the thread had
since moved to.

**Blast radius.** `message.sent` is the most-subscribed event in the outbound
API. In any workspace with two numbers on a channel, a reply genuinely sent from
Sales was reported to every partner under Support the moment the customer next
wrote to Support — with `channel.id`, `account_label`, `account_address`,
`account_external_id` and `message.channelId` all consistently wrong, not
intermittently. Verified in the delivered body: `channel.id` came back as
`…conn_wa_b` / `"Support line"` / `+15550000002` for a message sent from
`…conn_wa_a`.

This is the same class the previous session fixed for the *seven events with no
account on their payload* — the fix landed for those and silently missed the one
whose payload shape differs.

**Fix.** Read both shapes in the one place the resolver already centralises:
top-level `messageId`, else nested `message.id`. Nine lines, no new call sites —
threading a field onto ~20 publish sites is precisely how this class started, as
the function's own docblock says.

**Evidence.** `03-reads-and-webhooks` red → green (38/38). NEGATIVE-TESTED at the
unit level: reverting the fix fails exactly the new nested-shape case and leaves
the top-level case passing. Pinned in `apps/api/test/webhook-channel-provenance.spec.ts`
(now 7 tests) **because that spec runs in CI and the e2e suite that caught it
does not**.

**Process finding, and the more important half:** `pnpm test:e2e:multiaccount`
is in neither CI nor the old predeploy ritual, so a red spec sat in the tree
undetected. It is step 4 of this ledger's ritual. Wiring it into CI is a
candidate for the ops/deploy domain (#31).

---

## Domain matrix (31)

Carried from the predecessor's 28 rows, plus 3 surfaces that never had one.
All rows reset to ☐ — a prior ✅ is scoped to the code that existed when it was
written, and 225 files have landed since.

**Status key.** ☐ = untouched · ◐ = real evidence gathered, but the domain's
full invariant checklist has NOT been generated and walked, so it is NOT closed
· ✅ = every invariant maps to a green test or a written R-only reason, commit
hash recorded. **Nothing here is ✅ yet, and ◐ must not be read as "probably
fine"** — the whole point of the predecessor's method is that a domain closes on
a checklist, not on however many findings happened to surface.

| # | Domain | Tier | Method | Status |
|---|---|---|---|---|
| 1 | webhooks ingest | 1 | E (meta 170/170) + N (pressure harness) | ◐ burst behaviour VERIFIED: converges to exactly 500, no duplicates, no thread fragmentation, 56.4/s p95 892ms — inside the recorded band. Full checklist not yet walked |
| 2 | outbound send + idempotency ledger | 1 | | ☐ |
| 3 | event bus / outbox | 1 | R (adversarial, registries not comments) + E | ✅ **2026-07-29** — tiers, single-critical boot assertion and the §18 broadcast exclusion all verified from both sides; no defect |
| 4 | workflows (~22 step types) | 1 | | ☐ |
| 5 | assignment (policies/rules/capacity) | 1 | R (adversarial) + E | ✅ **2026-07-29** — §18 enforcement verified structural (CAS, not the pre-read); no defect |
| 6 | broadcasts (+audience/templates/analytics) | 1 | | ☐ |
| 7 | tickets (+SLA+numbering+escalation) | 1 | R (adversarial) + E (28+) + N (burnt-number pin) | ✅ **2026-07-29** — Finding #0 fixed + measured; 2 product decisions carried forward |
| 8 | realtime layer | 1 | R (adversarial) + E (18 reducer + storm guard) | ✅ **2026-07-29** — all three reducer consumers verified table-driven; no defect |
| 9 | auth / org / workspaces / members | 1 | | ☐ |
| 10 | external `/v1` API | 1 | | ☐ |
| 11 | contacts (+import/export/transfer) | 2 | | ☐ |
| 12 | customers / identity | 2 | R (adversarial, 7 doc rules + §58) + E | ✅ **2026-07-29** — all seven hold, incl. the both-directions ephemeral exclusion; no defect. Merge-audit gap carried forward (doc-declared) |
| 13 | inbox-views | 2 | R (adversarial, 6 doc invariants) + E (31) | ✅ **2026-07-29** — all six already covered; no defect, one stale comment fixed |
| 14 | channels / multi-account | 2 | R (adversarial, 9 doc invariants) + E + N (7) | ✅ **2026-07-29** — doc §6 walked line by line; invariant 8 was FALSE and was a data-loss path (Finding #8) |
| 15 | outbound-webhooks (delivery/retry) | 2 | R (adversarial, 13 invariants) + E + N (16 tests) | ✅ **2026-07-29** — full checklist walked, 0 unmapped. HIGH wrong-account FIXED; signing newly covered + negative-tested ×2; one false positive of my own caught and withdrawn |
| 16 | calls (WhatsApp calling + artifacts) | 2 | R (adversarial) + E (multi-account 05) + N | ✅ **2026-07-29** — Finding #5 fixed; SIP refusal and provider-read gate verified |
| 17 | media / R2 / blob-storage | 2 | | ☐ |
| 18 | queues / workers | 2 | | ☐ |
| 19 | sweepers | 2 | R + N (6 tests) | ◐ `webhook-subscription-health` covered + negative-tested both directions; RISK-1/RISK-2 recorded; the other ~30 sweepers not re-walked |
| 20 | coexistence | 2 | | ☐ |
| 21 | **reports / analytics** *(NEW)* | 2 | R (adversarial, 11 invariants) + E + N (6) | ✅ **2026-07-29** — full checklist walked, 0 unmapped |
| 22 | **webchat widget** *(NEW)* | 2 | R (adversarial) + E (2 e2e) | ✅ **2026-07-29** — public-surface boundary verified fail-closed; no defect |
| 23 | tags / stages / fields / snippets / flags | 3 | | ☐ |
| 24 | notes | 3 | R (adversarial) | ✅ **2026-07-29** — clean; the visibility spread verified safe for a structural reason (scalar return shape) |
| 25 | team-chat (+DMs) | 3 | R (adversarial, 11 doc invariants + mechanical tenancy scan) | ✅ **2026-07-29** — no defect; 5 satellites re-verified, 0 real violations |
| 26 | ai-assistant | 3 | | ☐ |
| 27 | admin / platform (superadmin) | 3 | | ☐ |
| 28 | registration / invites | 3 | | ☐ |
| 29 | common guards / pipes / filters | 3 | | ☐ |
| 30 | api-keys lifecycle | 3 | | ☐ |
| 31 | **ops / health / deploy pipeline** *(NEW)* | 3 | R + N (4 tests) | ◐ `ops-snapshot` degradation covered + negative-tested; RISK-3 (`probeStuckBroadcasts` unbounded on the container healthcheck) OPEN; deploy pipeline not yet reviewed |

### Never-audited subsystems (Phase 1 triage targets, risk order)

| Subsystem | Path | Why it is first |
|---|---|---|
| ops snapshot | `apps/api/src/health/ops-snapshot.ts` | **zero tests**; `bounded()` probe timeouts + the partial-failure `queues[name] = null` path; reached from the Platform page |
| webhook-subscription health | `apps/api/src/lib/sweepers/webhook-subscription-health.ts` | **zero tests**; 272 L self-healing state machine. A bug means inbound goes dark *and* the detector doesn't fire |
| reports | `apps/api/src/reports/`, `lib/analytics/reports.ts` | 2 unit specs; **no e2e, no UI spec, no `/v1` parity spec**; tz-bucketed SQL (theme ⑤) |
| in-app call recording | `calls.service.ts`, `lib/media/call-recording-download.ts` | Meta's own recording flow was **removed** and replaced with browser upload + our transcripts |
| account display | `lib/channel-accounts/display.ts` | no direct spec, and it exists *because* three call sites had diverged |
| outbound-account rule | `lib/conversations/account.ts` | the single binding rule for 5 outbound-first paths; covered only indirectly |
| the two backfill migrations | `20260728110000`, `20260728120000` | irreversible data writes; verify against the dev DB what they touched and that a re-run is a no-op |

---

## Carry-forward backlog (re-verify against current code before repeating)

The predecessor found its own standing list stale **in both directions** — items
already fixed, and fixed items that had regressed. Nothing below is trusted
until re-confirmed at HEAD.

**Needs a product decision, not a patch**
- `orgRole` has no write path — "org admin" is unreachable and there is no
  ownership succession; a lost sole owner permanently loses org rename,
  workspace create/delete and all membership management.
- Closing a conversation does not stop/pause its ticket SLA → permanent false
  breach on work finished on time.
- `call.incoming` toasts carry contact name + phone team-wide even under
  `agentConversationVisibility: "assigned"`.
- `unreadCount` can only get a reconciler if a read watermark is added (schema
  change + product decision). CLAUDE.md §7 states this plainly; do not claim a
  sweeper for it.

**Open MED/LOW at last pass**
- per-WABA template-insights enable still needs `?accountId=`.
- ~~`ai-knowledge/`, `ai-voice-draft/` blobs orphaned by workspace delete~~ —
  **CLOSED 2026-07-29.** Verified the whole class mechanically rather than
  spot-fixing: enumerated every blob-key-shaped column in `schema.prisma` and
  every `putObject` call site, then checked each prefix against the sweeper's
  cross-check list (`Message.mediaKey`/`.mediaThumbnailKey`,
  `TeamChannelMessage.mediaKey`, `Call.recordingKey`/`.transcriptKey`) and its
  `URL_ONLY_KEY_PREFIXES` exclusion list. **Deletion safety is complete** — every
  prefix is either cross-checked or excluded, so nothing live can be reclaimed.
  But `ai-knowledge/` and `ai-voice-draft/` are the only two that are excluded
  *and* had no collector in `destroy()`, which means they were the only blobs in
  the system with **no reclaim path at all**: the cascade takes the rows, the
  sweeper is forbidden to touch the prefix, and the objects leak forever.
  `collectAiArtifactKeys` added; pinned by `workspace-destroy-ai-blobs.spec.ts`
  (collects both, and does not reach into a sibling workspace),
  NEGATIVE-TESTED. `tpl-hdr-` stays open by design — it has no column at all
  (the URL is the only reference, held in workflow step config, Broadcast
  variables and `Message.rawPayload`), so collecting it needs a different
  approach than a column scan.
- Hard-deleting a user re-homes nothing through the domain path (no version
  bump, no `TicketEvent`, no `conversation.assigned`).
- `shiftDueDates` adds **wall-clock** pause time to a **business-hours**
  deadline (a Fri-17:00→Mon-09:00 hold credits ~64 h never owed).
- The platform anchor org may be deletable via `DELETE /api/workspace` (no
  `isPlatform` check; the admin route has one) — PLAUSIBLE, confirm.
- `/v1` phase-4 parity gaps: contact bulk ops, sync-profile, count/preview,
  conversation bulk/delete/search, the composer sends (media / location /
  contact-card / reaction / forward), template-into-existing-thread, note LIST,
  catalog writes. Plus 9 admin-grade reads under low read scopes.
- `docs/organization-api.md`'s scope table is stale for ~20 routes moved to
  `admin:settings` — now fixable, since `docs/` is restored.
- LOWs: assignment-config cache not busted on add/re-role; a workflow
  `assign_to` naming a removed user no-ops forever; superadmin aggregates stale
  on two delete paths; an in-flight broadcast page still sends after its
  workspace is deleted; deleting an account orphans `MessageTemplate` rows and
  can orphan a `WhatsappPortfolio`; §18 letter violation in the merge/split
  reap; the coexistence history worker retry-storms on a deleted workspace.

**Time-critical, needs the operator (not a code change)**
- The legacy Meta webhook proxy (`apps/web/src/app/api/webhooks/meta/[workspaceId]/route.ts`)
  carries a **deletion deadline of 2026-08-03**, and step 1 of its own checklist
  is a 7-day zero-hit check against production Caddy access logs — that needs
  VPS access. Today is 2026-07-29. Do not delete without the log check; do not
  extend it silently (the file's own policy).

### Finding #4 — two specs have been asserting contracts the code deliberately abandoned

The main Playwright suite came back **534/537**. One failure was the dev
cold-compile artifact (`/settings/webchatwidget`, first visit > 30 s). The other
two were specs frozen against behaviour that was intentionally changed — each
green in CI only because **the main suite has not been run to completion
recently**. The predecessor ledger's own row *"Main Playwright suite ×2 with
canary intact"* is still marked `in progress`, which is exactly how this
accumulates.

**(a) `calls.spec.ts:352` — the CAS-race spec asserted a discarded audit-trail
rule.** It required `answeredByUserId === userId` unconditionally after the CAS
win, commenting that "the rollback flips status to failed but leaves answeredBy
for the audit trail". `calls.service.ts` abandoned that on **2026-06-11**
(`769536bc`): the acceptCall rollback now nulls `answeredAt` AND
`answeredByUserId`, because `connected` is derived as `answeredAt !== null` in
`listTeamCalls`, so keeping the stamp reported a call that never connected as
connected and permanently attributed an agent to a conversation they never spoke
on. The code's reasoning is the better one and is specific about its downstream
victim, so the SPEC was corrected — it now asserts the coherent *pairing*
(`in_progress` ⇒ answerer stamped; `failed` ⇒ both nulled) instead of one field.

Note **why it hid for seven weeks**: it only fails when the Meta hop actually
rejects, which needs `CALLS_SKIP_PREFLIGHT=0`. The dev `.env` ships `1`, so the
gate under test is skipped and the spec passes without exercising it. That flag
is now part of this ledger's ritual.

**(b) `full-ui-functional.spec.ts:222` — asserted a gate that was removed.** It
required `/broadcasts/groups/new` to redirect to `/settings/whatsapp` when no
number is configured. `4aaf3c6e` (2026-07-27) deliberately deleted that
pre-flight, and the page says why in place: an audience group is a saved CONTACT
list and is channel-agnostic, so a WhatsApp-specific gate bounced a
Messenger-only or Instagram-only workspace to a settings page for a channel it
does not use. Spec inverted to assert the current contract.

**Also fixed: the setup gate that let Finding #3 hide.** `app-admin.setup.ts` now
asserts the authenticated shell actually rendered. NEGATIVE-TESTED against a
real 404 page (`/calls`, which genuinely has no `page.tsx`): the 404 body
contains **zero** `<nav>` landmarks while `/inbox` has one, so the assertion
fails exactly on the condition it was written for, and passes on the real inbox
(verified in a 59/59 green run).

**Suite-hygiene note.** `e2e-app-ws` carries three leftover `externalAccountId:
""` placeholder `ChannelConnection` rows (whatsapp / messenger / instagram, all
`isActive: false`) — pre-minted by `getConfig` whenever a spec merely *visits* a
channel settings page, and only cleaned up by `normalizeDefaultAccount` when
real credentials are pasted. Harmless today (`wipeTestData` does not delete
connections, and the gate they would have confused is gone), but this is the
same `""`-placeholder row that once became a channel default and silently lost
all inbound. Worth adding to `wipeTestData`.

---

## Phase 1 — delta triage notes (in progress)

### ✅ The two zero-test subsystems now have specs (both NEGATIVE-TESTED)

`apps/api/test/webhook-subscription-health.spec.ts` (6) and
`apps/api/test/ops-snapshot.spec.ts` (4). Unit-level with Graph mocked at the
module seam, in the established `whatsapp-health-per-account.spec.ts` style —
the e2e mock Graph cannot serve these (see below).

**webhook-subscription-health** pins the behaviours whose failure is silent: a
healthy subscription is left alone; a dropped one SELF-HEALS without raising the
banner; a heal that fails raises `needsReconnect`; **a transient Graph error is
not mistaken for broken**; a dead token (Graph 190) IS classified broken; an
inactive connection is never probed. Negative-tested BOTH directions on the
classifier — forcing `isTokenError` to `true` fails exactly the transient case,
forcing it to `false` fails exactly the dead-token case.

**ops-snapshot** pins that degradation stays partial: all seven queues are
present; a queue whose `getJobCounts` never settles degrades to `null` while
every sibling still reports; a queue that REJECTS degrades to `null` rather than
taking the whole `Promise.all` down; a dead database reports `db:false` and the
outbox probe returns its `-1` sentinel rather than a reassuring "0 pending".
Negative-tested by raising `PROBE_TIMEOUT_MS` to 600 s — the wedged-queue case
then times out, proving the bound is what the assertion is measuring.

**A vacuity trap, caught in my own spec.** The first version seeded
`config.wabaId` but not the `wabaId` **column** — which is what the sweeper
selects. Every case skipped the connection, and the three tests whose assertions
are negatives (*"no heal attempted"*, *"needsReconnect stays false"*) **passed
without executing any of the code under test**. Both now carry an explicit
non-vacuity guard asserting the sweeper actually probed this WABA. A spec full
of negative assertions is exactly the kind that can go green against nothing.

### `lib/sweepers/webhook-subscription-health.ts` — the remaining gaps

The module's whole purpose is detecting the one failure where customer data
disappears with no signal: a Meta-dashboard re-save silently drops the
WABA/Page subscription, credentials stay valid, inbound goes to zero, nothing
errors. It took Messenger dark in production on 2026-07-10.

**Why there are no tests:** `tests/e2e/_mock/graph-mock.mjs` does not implement
`/subscribed_apps` **at all** (zero occurrences). So the sweeper cannot be
exercised against the existing mock Graph without extending it first. That is
the prerequisite for closing this gap, and it is the work item — not "write a
spec".

**RISK-1 (characterized, NOT fixed — needs wire verification).** Both
`checkWhatsapp` (line 124) and `ensureWabaSubscribed`
(`meta-waba-subscription.ts:36`) treat `subscribed_apps.data.length > 0` as
"we are subscribed". That is a strictly weaker property than the one they
report: it answers *"is **some** app subscribed to this WABA"*. The two diverge
exactly when ANOTHER app is subscribed and ours is not — which is the ordinary
state during a migration from a previous BSP, a flow this product supports. The
symptom would be the precise failure this module exists to catch: onboarding
reports "subscribed ✓", zero inbound, no error anywhere.

`ChannelConnection.config.appId` is already stored (optional; used by
`meta.ts:4812` for resumable uploads), so an exact match is *available* — but
whether the GET response carries an app id to match against is **not
established**: `docs/Meta/whatsapp.md` documents the POST and not the GET
response schema. Writing the comparison now would be coding against an
unverified wire shape, which §17 forbids and which this repo has been burned by.
**Verification step before any fix:** capture a real
`GET /{waba-id}/subscribed_apps` body (or the Graph reference) and confirm the
per-entry `whatsapp_business_api_data.id` field. Then match on it when `appId`
is known, and keep the length check as the fallback when it isn't.

**RISK-2 (characterized).** `isTokenError` (line 101) classifies a dead token by
substring-matching `"code":190` / `OAuthException` against the error *message*.
This codebase has been defeated by error-shape classification twice — the
`P2002`-via-`err.meta` case, and the burst-ingest classifier that was correct
about every code it named and still wrong because the pg driver adapter
delivered a different shape. Here a false negative is silent and total: a dead
token is classified transient, no state transition is recorded, and purpose #2
of the module never fires. Per the standing rule, match more than one way and
let a test prove it.

**REFUTED by comparison, so not a finding:** the sweeper does no immediate sweep
at boot (30 min blind after each deploy). Checked `whatsapp-health-refresh`,
`template-catalog-refresh` and `broadcast-materialize-drift` — every sibling
starts with a bare `setInterval` too. It is the house convention (no boot storm
across 30 sweepers), not a defect in this one.

### `health/ops-snapshot.ts` — zero tests

Reads carefully. `bounded()` is correct (the fallback resolves, the timer is
always cleared) and every probe catches internally, so `Promise.all` cannot
reject. Destructure order matches the array. Recorded for the domain session
rather than fixed:

**RISK-3 — FIXED 2026-07-29.** `probeStuckBroadcasts` was the one probe **not**
wrapped in `bounded()` — in `ops-snapshot.ts:112`, and identically at its two other call
sites (`health.controller.ts:101`, `health-watchdog.service.ts:90`), while
every sibling DB probe there is bounded at 2.5 s. It is a Prisma query, so
under a saturated pool it waits — up to the 30 s `statement_timeout`. `/health`
is the **api container's Docker healthcheck** (`docker-compose.yml:205`,
`timeout: 3s`, `retries: 3`), and the deploy gate reads
`docker inspect .State.Health.Status`. So DB pressure — the moment you least
want it — can make the api read unhealthy and trip the deploy's auto-rollback on
a release that is fine. Pre-existing (not from the delta) and consistent across
all three sites, so it was a design gap rather than a regression.

**Fixed at the source** rather than at three call sites: the probe now takes a
`timeoutMs` and races internally, mirroring `probeRedisMemory(redis, timeoutMs)`
— the shape its sibling already used — and all three callers pass their existing
2 s constant. On timeout it degrades to the same all-clear its `catch` returns,
the posture `outboxLag` already takes: /health's job is to report, and a probe
that cannot answer must not take the whole report down with it.

The distinction that made this worth fixing: `catch` covers a query that FAILS
and does nothing for one that merely takes too long, which is exactly the pool-
saturation case. Pinned by *"a SLOW stuck-broadcast probe cannot hang the
snapshot"* and NEGATIVE-TESTED — dropping the timeout argument at the
`ops-snapshot` call site makes the test hang until its own 40 s ceiling.

### Finding #5 — in-app call recording deleted the interim raw BEFORE moving the row pointer

`storeInAppRecording`'s final path uploaded the remuxed OGG, **deleted the
interim `.raw`, and only then** updated `Call.recordingKey`. A crash or a DB
blip in that window leaves the row naming an object that has just been deleted,
while the OGG nobody points at becomes an orphan the blob sweeper reclaims 24 h
later.

That is **permanent, total loss**. Unlike Meta's own recordings there is no
upstream copy to re-fetch — the whole point of the in-app mode is that the bytes
only ever existed in the agent's browser. This is the **fifth** instance of the
blob-orphan class the sweeper's own header documents (avatars, ai-knowledge +
ai-voice-draft, contact transfer artifacts, call recordings/transcripts).

**Fixed** by reversing the order: commit the pointer, then drop the raw (and
only when it is genuinely a different key). Reversed, the worst case is a stray
`.raw` the sweeper reclaims on its own — which is what the comment's
"best-effort" should have meant all along.

**Pinned by an ORDERING assertion, because both orders look identical once the
function returns**: `inapp-recording.spec.ts` spies on `blobStorage.delete` and
reads the `Call` row *at the moment the delete fires*, asserting it already
names the OGG. Runs against real ffmpeg (`describe.skipIf(!hasFfmpeg)`, the
repo's existing convention) with synthesised OPUS audio, so the remux-SUCCESS
branch — the only branch that behaves differently — is genuinely exercised.
NEGATIVE-TESTED: restoring the original order fails it with exactly the intended
message.

### The two backfill migrations — VERIFIED against the real dev database

Irreversible data writes, so checked by querying the result rather than reading
the SQL and trusting it.

**`20260728110000_backfill_conversation_account` — verified complete and
re-runnable.** It stamps `Conversation.channelConnectionId` on outbound-first
threads that no create path stamped. Dev DB after the fact: 12 conversations,
**6 still NULL, and 0 of those fixable** — i.e. a re-run would change nothing,
which is what "only touches NULL rows" is supposed to buy. Inspecting the six:
every one has **zero active connections** on its channel, so NULL is the only
honest value. Three of them are `webchatwidget`, which has no
`ChannelConnection` at all by design (the one allowlisted entry in
`check-channel-account`), so those stay NULL permanently and correctly.

This also **refutes, against real data, a hypothesis raised earlier in this
pass**: that `resolveOutboundAccountId` could return its documented-harmful
null for a workspace holding active accounts but no `isDefault` one. No such
row exists — consistent with `normalizeDefaultAccount` (guarantees exactly one
ACTIVE default on connect) and `ChannelAccountsService.remove` (promotes a
viable successor, explicitly skipping inactive and `""`-placeholder rows).
VERIFIED HELD, not a finding.

**`20260728120000_backfill_template_waba` — applied clean in dev; one branch
unexercised.** Dev DB: 11 templates, **0 legacy `wabaId = ''` rows, 0 with
bindings**. The SQL is careful — it adopts only where the workspace has exactly
ONE distinct real WABA, and never deletes a `''` duplicate carrying
`variableBindings`, which is the one thing a Meta re-sync cannot give back.

**RISK-4 (characterized, cannot be confirmed locally).** That preservation rule
has a tail: a `''` row WITH bindings is kept by step 1 and then **skipped by
step 2's unique-key guard**, so it retains `wabaId = ''` permanently — which is
exactly the state the migration exists to eliminate, and the state in which
`refreshTemplateAnalytics` refuses and Meta's ~7-day analytics horizon passes
uncaptured. The workspace is also left showing two templates of the same
name/language. The better ending is to COPY the bindings onto the real row and
then drop the legacy one; preserving the row preserves the defect with it. Zero
such rows exist in dev, so this is unexercised here. **Operator check for
production:**

```sql
SELECT count(*) FROM "MessageTemplate"
WHERE "wabaId" = '' AND "variableBindings" IS NOT NULL
  AND "variableBindings"::text NOT IN ('{}', 'null');
```

Non-zero means those templates' analytics are permanently dark and want a
follow-up migration.

### `lib/analytics/reports.ts` — VERIFIED CORRECT on its highest-risk detail

Edge theme ⑤: the daily bucketing attaches UTC before converting
(`(m."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}`), which is right —
`Message.timestamp` is a naive timestamp holding UTC, and a single `AT TIME
ZONE` would reinterpret rather than convert it. The comment records that a
`Pacific/Auckland` spec caught it before it shipped. `tz` reaches SQL as a bound
parameter and is shape-validated first; `accountId` is ownership-checked against
the workspace before it reaches nine raw predicates, and is rejected rather than
silently returning an empty report. `from`/`to` are ISO instants, so the caller
owns its own midnight. Remaining gap is coverage breadth, not correctness: no
e2e, no UI spec, no `/v1` parity spec.

### Finding #3 — the app-admin auth setup passes vacuously on a broken app

Chasing what looked like a catastrophe: **every authenticated `(app)` route
returned 404** — `/inbox`, `/contacts`, `/tickets`, `/broadcasts`, `/settings`,
`/team`, `/flags`, `/workflows`, `/templates`, `/account`. The inbox is the
heart of the product, so this was run to ground before anything else.

**It was NOT a product defect.** `rm -rf apps/web/.next` and a restart returned
every one of them to 200. A stale Next dev build, the gotcha the repo already
records ("dev OOM → `rm -rf .next`"). Recorded here because it cost real time
and the symptom is maximally alarming; the diagnostic that settles it in one
step is a clean rebuild, before reading any application code.

Two things it *did* establish, both real:

**Finding #3 (harness, MED).** `tests/e2e/app-admin.setup.ts:33` asserts only
`await expect(page.locator("body")).not.toBeEmpty()`. **A Next 404 page has a
non-empty body.** So the setup went green while the app it authenticates into
was returning 404 on every route — and it saved that storageState for all 537
downstream specs. A setup gate that cannot distinguish "logged in" from "the
whole app is 404ing" is not a gate. It should assert something only the real
inbox renders. (Its sibling `auth.setup.ts` failed honestly, because it waits
for `/platform` — a URL assertion, not a body assertion.)

**Observation (LOW, not fixed).** `apps/web/src/app/(app)/calls/` contains only
`calls-history.tsx` and **no `page.tsx`**, so `/calls` genuinely 404s. Nothing
links to it — the component is imported by `features/inbox/components/inbox-shell.tsx`
— so there is no user-visible break today. But a component parked at a
route-shaped path in the App Router tree is exactly what made the stale-build
symptom hard to read, and it becomes a real route the moment someone adds a
page. Worth moving to `features/calls/`.

**Environment note for re-runs.** Next dev compiles a route on first visit, and
the main config's `navigationTimeout` is 30 s — a cold `/login` exceeded it and
failed both setup projects before any spec ran. Warm the routes with a curl
sweep before starting the suite.

---

## Domain session notes

### #16 calls (WhatsApp calling + artifacts) — ✅ CLOSED (2026-07-29)

Checklist from `docs/whatsapp-calling.md`. One defect found and fixed earlier
this session (Finding #5, the in-app recording blob ordering).

| Invariant | Evidence |
|---|---|
| **SIP: do not enable** — it disables the Graph calling endpoints this platform is built on | **R** we never set it. We DETECT it (`sipEnabled` off the provider) and REFUSE the preflight with a named `sip_disabled` check and an actionable remedy. The comment records why: a tenant enabling it in WhatsApp Manager would otherwise silently break every place/answer "with nothing in our logs" |
| The permission gate is a **provider read**, never the local ledger | **R** documented at the function (*"permission + quota, read from the PROVIDER (never a local ledger)"*) and implemented via `readPermission` — and a permission read that FAILS is explicitly not a green light |
| `CallPermissionRequest` rows are a cache + audit trail only | **R** created alongside, never consulted as the gate |
| **Artifacts must not move `Call.status`** — they arrive minutes after the call | **R** the artifact-store path performs **zero** `status` writes |
| Call artifacts are not `Message` media and must not be confused with it | **R** separate `recordingKey`/`transcriptKey` columns and separate blob prefixes — and the blob-orphan sweeper now cross-checks BOTH columns (the predecessor's HIGH) |
| Recording/transcription config lives in TEAM SETTINGS, never agent free-text | **R** — it is a legal decision, not a per-agent one |
| No `if (workspaceId === …)` in the provider | **R** |
| Dedup on `@@unique([workspaceId, channel, externalCallId])`; terminal state is a CAS | **E** `call-*.spec.ts`, `multi-account/05-calls.spec.ts` |
| Every call path resolves credentials from `Conversation.channelConnectionId` | **E** `multi-account/05` — both numbers attributed independently, and the history distinguishes two calls from one customer to two numbers |

**Finding #5 (fixed this session):** the in-app recording deleted the interim
`.raw` blob BEFORE moving `Call.recordingKey` to the transcoded `.ogg`. A crash
or DB blip in that window left the row pointing at an object that had just been
deleted, while the `.ogg` nobody pointed at became an orphan the sweeper
reclaims 24 h later — **permanent** loss, because unlike Meta's own recordings
these bytes only ever existed in the agent's browser. Reversed: the pointer
moves first, so the worst case is a stray `.raw` the sweeper reclaims on its own.

**Edge themes:** ① terminal-state CAS, and the answer race is pinned by
`calls.spec.ts` · ② redelivered terminal events are idempotent · ③ N/A ·
④ N/A · ⑤ `call_hours` windows · ⑥ N/A · ⑦ the recording upload is capped at
64 MB by multer · ⑧ `calls:make` / `calls:receive` · ⑨ every call query is
workspace-scoped · ⑩ artifacts are downloaded by a sweeper that resumes.


### #22 webchat widget — ✅ CLOSED (2026-07-29)

A live channel that never had a matrix row. Checklist from
`docs/webchatwidget.md` + `docs/identity.md`'s ephemeral rules. No defect.

| Invariant | Evidence |
|---|---|
| The handshake is gated by an **origin allow-list**, fail-closed | **R** `originAllowed(origin, resolved.allowedOrigins)` → `next(new Error("origin_not_allowed"))` **before** any room join, and after the site-key check. The rejection log carries the actual origin so support can say exactly what to add |
| Trust-on-first-use origin recording **never gates a connection** | **R** fire-and-forget with a non-consuming catch, and it no-ops once the widget is locked — a visitor's handshake must never wait on, or fail from, a bookkeeping write |
| Per-IP handshake rate limit | **R** `createTokenBucket({ perMin: 120 })`, with the reason recorded in place: without it one IP could mint ~120 Contacts + Conversations a minute |
| Anonymous, WebSocket-only transport so browser CORS never applies | **R** |
| A visitor only ever joins ITS OWN conversation room | **R** both joins are `widgetRoom(conversationId)` = `widget:conv:<id>` — there is no team room, no channel room, and no visitor-to-visitor surface |
| Widget contacts stay out of the directory, CSV, audience counts and search | **R** `EPHEMERAL_CONTACT_CHANNELS` drives `directoryContactWhere` / `DIRECTORY_CONTACT_SQL`; membership is DERIVED (has a phone or an email), so a visitor who self-identifies is promoted automatically and there is no flag to forget to flip |
| …but full-quality in the inbox, and workflows still fire | **R** the exclusion is a directory/audience concern only |
| A widget contact's self-typed value never acts as a strong key | **R** the candidate-set exclusion — see #12 rule 7, where the both-directions reasoning is recorded |
| Widget conversation binding is STICKY (unlike a channel account's re-stamp) | **R** `ingest.ts` calls it out explicitly when re-stamping `channelConnectionId` |

**Edge themes:** ① `createOrGet` on the visitor conversation is idempotent ·
② N/A · ③ N/A · ④ the visitor re-joins its room on reconnect ·
⑤ N/A · ⑥ the pre-chat form is optional · ⑦ per-IP bucket ·
⑧ **the whole domain is an unauthenticated public surface — the site key plus
the origin allow-list ARE the boundary** · ⑨ the widget resolves to one
workspace from its site key, never from client input · ⑩ N/A.


### #25 team-chat (+DMs) — ✅ CLOSED (2026-07-29)

Checklist from `docs/team-chat.md` (11 numbered invariants + the UI notes). No
defect.

| Invariant | Evidence |
|---|---|
| A deliberately SEPARATE message graph — a `Message` query can never leak into team chat | **R** distinct models, distinct hooks, never cross-wired |
| `dmKey` is ALWAYS derived server-side | **R** `createOrGetDm(workspaceId, actorUserId, targetUserId)` — the schemas and controller never accept a `dmKey` or a raw pair, so a caller cannot claim a conversation between two other people |
| `createOrGetDm` re-reads on P2002, never a bare create | **R** `isP2002` → re-read on `workspaceId_dmKey` |
| Membership failures 404, never 403 | **R** — a 403 would teach a non-member the channel exists |
| Public channels are join-to-read; there is deliberately NO "public → allow read" branch | **R** browsing has its own metadata-only endpoint |
| `browsePublicChannels` must never touch `TeamChannelMessage` | **R** **zero** references in that function — it is served to non-members |
| **`subscribe:channel` re-checks membership on EVERY subscribe**, and LEAVES on failure | **R** the check is not gated on `!alreadyJoined`, and failure does `if (alreadyJoined) client.leave(room)`. Socket.io's `connectionStateRecovery` restores rooms with no handler running, so skipping the re-check left a revoked member in `chan:<id>` while their laptop slept · plus `pruneRecoveredChannelRooms()` on `client.recovered` |
| Mention counters compare `COALESCE(editedAt, createdAt)` | **R** in the SQL — an edit is the only way to be mentioned without a new message, and by then `createdAt` is already behind the reader's receipt |
| Reaction `emoji` must actually be an emoji | **R** `EMOJI_ONLY_RE` (Extended_Pictographic + modifiers + regional indicators + ZWJ/VS16/keycap) **AND** a separate non-ASCII requirement, because the class must admit ASCII digits as keycap bases — so `1️⃣` passes and a bare `"1"` does not — plus a per-message distinct cap |
| `ChannelExistenceGuard` must consult BOTH lists | **R** `channels.some(...) \|\| dms.some(...)` for existence AND `channels.length + dms.length` for emptiness, plus a 2 s grace period so a just-created DM isn't evicted by whichever round-trip loses |

**The five `TeamChannel*` TENANCY EXCEPTIONS — re-verified mechanically, and my
scanner was wrong twice before it was right.** A structural scan of every query
against the five satellites flagged 11 sites, then 7 after a fix, then **0 real
ones** after reading each.

- First pass: the alternation `(update|updateMany)` matched `update` as a
  PREFIX of `updateMany`, so the captured `where` block started mid-token and
  the `workspaceId` sitting right there was invisible. Longest-alternative-first
  fixed it.
- Second pass: the remaining 7 are all safe on inspection — each reaches the
  satellite by a **server-derived id from an already-scoped row** (a paging
  anchor, a `threadRootId` FK off a verified message, a reaction found by the
  `messageId_userId_emoji` compound unique whose channel access was asserted
  upstream). That IS the documented parent-scoped pattern.

And the code is stricter than the pattern requires: `editMessage` adds
`workspaceId` to every mutate WHERE as defence-in-depth *even though* the
preceding `findFirst` already proved ownership, using `updateMany`/`deleteMany`
because `id` alone is the unique key.

**Edge themes:** ① the thread-reply counter is an atomic in-transaction
increment returning the POST value, so two concurrent replies can't both
publish `N+1` · ② N/A · ③ a lost concurrent-delete race bails BEFORE the
decrement, so the root counter can't drift negative with no sweeper ·
④ head-resync on every connect · ⑤ N/A · ⑥ N/A · ⑦ distinct-reaction cap ·
⑧ private creation stays admin/manager; public is open · ⑨ every satellite
reaches a workspace-scoped parent · ⑩ recovery prunes restored rooms.


### #8 realtime layer — ✅ CLOSED (2026-07-29)

Checklist from `docs/realtime.md` + CLAUDE.md §10. No defect.

| Invariant | Evidence |
|---|---|
| Emit only after a committed state change; frames small, scoped, idempotent | **R** across the fanout table |
| Broadcast recipient frames are CONVERSATION-scoped, not team-scoped | **E** `fanout-storm-guard.spec.ts` — asserted against the `FANOUT_RULES` decision table itself, so it needs no socket and cannot flake; a 10k send costs ~2 workspace-room frames, not 20,000 |
| `message.status_changed` moved team → conversation room | **R** the rule table |
| Table-driven reducer wiring shared by all consumers | **R** `use-conversation-events.ts` AND `inbox-shell.tsx` both iterate `THREAD_REDUCER_EVENTS`; `contact-panel.tsx` is a DOCUMENTED exception that derives its four events straight from its `data` prop and still imports `assertReducerCoverage` |
| `assertReducerCoverage` throws in dev for an unwired event | **R** it throws, and early-returns under `NODE_ENV === "production"` |
| Monotonic message-status guard, mirroring the server | **R** `STATUS_RANK {pending 0 … failed 4}`, `if (nextRank <= curRank) return prev` — which also returns the SAME reference on a no-op, satisfying §15's "same reference when nothing changed" · **E** `thread-reducers.spec.ts` (18) |
| **Unread: markRead only when genuinely viewing** — the app's most-guarded invariant | **R** gated on `document.visibilityState === "visible"`; a hidden background tab parked on a thread never clears team-wide unread for a message nobody saw |
| Team chat is a SEPARATE realtime graph, never cross-wired | **R** distinct hooks (`use-team-events` et al.) |
| Presence is in-memory, never persisted | **R** `PresenceService` |
| `availabilityStatus` is the EFFECTIVE value, resolved in ONE function | **R** `resolveEffectiveAvailability` in `@ccp/shared/presence`; the manual pick lives separately so an off-shift stretch never destroys the note the person typed |

**Edge themes:** ① seq-guarded presence transitions · ② the monotonic guard IS
the redelivery defence (Meta sends status webhooks at-least-once and unordered) ·
③ a recovered conv room is pruned when it no longer resolves · ④ **covered —
delta backfill on open, full refetch on reconnect, both converging to server
state** · ⑤ the override anchor falls back to the next local midnight on a 24/7
schedule (returning null would let the schedule reclaim the status immediately,
so a round-the-clock team could never mark itself busy) · ⑥ N/A · ⑦ SUB_CAP 60 ·
⑧ authorization enforced at JOIN **and revoked** — member removal/role change
busts the cache and disconnects · ⑨ rooms are workspace-keyed (`user:<ws>:<uid>`) ·
⑩ multi-tab 0↔1 transition gating.


### #5 assignment (policies / rules / capacity) — ✅ CLOSED (2026-07-29)

Checklist from `docs/assignment.md` + CLAUDE.md §18. No defect.

| Invariant | Evidence |
|---|---|
| **§18: automation never takes a thread from a human** | **R** verified in DEPTH — see below · **E** `assignment-pick-burst.spec.ts`, `workflows-events/assignment-*.spec.ts` |
| Every automated caller passes `onlyIfUnassigned` | **R** all four automated callers do: AI orchestrator, broadcast runner (`!assignmentOverwrite`), and both workflow `assign_to` modes. The AI ESCALATION path passes `false` deliberately, and says why in place — an escalation is a re-route a human asked for |
| Every automated assignment writes through `assignConversation` | **R** `apply.ts` calls it at both sites; nothing writes `assignedUserId` directly |
| Deactivated agents never receive new work | **R** the member lookup filters `deactivatedAt: null` |
| Assignment never sets `open` — only chatting does | **R** explicit in the status branch |
| Restricted agents are scoped by ROOM MEMBERSHIP, not emit-time filtering | **R** `isRestrictedViewer` at the gateway's join |
| Campaign assignment respects `assignmentOverwrite` (default false) | **R** `onlyIfUnassigned: !broadcast.assignmentOverwrite` |

**The §18 enforcement is structural, and I checked it twice because the first
reading looked wrong.** `assignConversation` compares `onlyIfUnassigned` against
a PRE-READ `previousAssignedUserId`, which on its own is a TOCTOU: a human
claiming the thread between the read and the write would still be overwritten.
It is not, because that comparison is only a fast-path short-circuit — the write
itself is a CAS pinning **both** `assignedUserId` AND `status` in the `where`,
inside `publishInTx`. A human who claims the thread in the window makes the CAS
match zero rows, Prisma raises P2025, and `isP2025` maps it to
`{ ok: false, reason: "conflict" }` rather than a 500. So the guarantee holds
even if the fast path is wrong, which is the right way round.

Recorded because the pre-read pattern READS like the exact bug the predecessor
fixed in `79b2597` ("`assignByPolicy` never forwarded `onlyIfUnassigned` into
the CAS"), and a reviewer who stopped at the comparison would report a HIGH that
isn't there. **The fifth claim I raised and withdrew in this program by reading
further.**

**Edge themes:** ① **covered — the CAS is the domain's core** · ② at-least-once
redelivery is idempotent precisely because of fill-empty-only · ③ deactivated
assignee degrades rather than drops · ④ N/A · ⑤ work-hours windows ·
⑥ N/A · ⑦ the offline rebalance is bounded · ⑧ restricted-agent scoping ·
⑨ policy/member writes carry `workspaceId` · ⑩ the pick lock + single-flighted
config survive a restart; presence returning an EMPTY set means "do nothing".


### #7 tickets (+SLA + numbering + escalation) — ✅ CLOSED (2026-07-29)

Checklist from `docs/ticketing.md` + CLAUDE.md §2/§18. One real defect, already
fixed this session (Finding #0).

| Invariant | Evidence |
|---|---|
| **No auto-open** — an inbound never creates a ticket | **R** `routeMessageToTicket` only ATTACHES to an active ticket or REOPENS one inside the window; it returns `opened: null` on the attach path and has no create call · **E** `tickets.spec.ts` *"does NOT open a ticket on an inbound"* |
| **§18: broadcasts never open tickets** | **R** `broadcast-runner.ts` contains **zero** references to `commitOutboundSend` — the bypass is structural, not a runtime flag |
| Outbound never reopens — an agent's follow-up on closed work is not new work | **R** the reopen branch is gated on `args.direction === "in"` |
| Due dates are computed at create and **STORED**, never derived on read | **R** `computeDueDates` appears only on WRITE paths: create, the escalation twin, and a priority change — the last gated on an active final status, because recomputing "from now" on a solved ticket would arm the sweeper against finished work |
| The handed-to team is validated against THIS workspace **and** must not be archived, on create AND update | **R** `assertWorkspaceTeam` filters `{ id, workspaceId, archivedAt: null }`, called 4× — the FK alone only proves the row exists |
| `Message.ticketId` is explicit, never derived from timestamps | **R** stored column; deriving would silently rewrite which work a past message belonged to when a boundary moves |
| Number allocation is race-safe; gaps are fine, collisions are not | **E** `tickets.spec.ts` (28) incl. the new burnt-number case · **FIXED** Finding #0 |
| An escalated-in ticket is visible to its assignee even while unbound | **E** `tickets-escalation.spec.ts` — one `ticketVisibilityWhere` now serves list, counts and the per-ticket guard |
| Escalation never crosses the read boundary | **E** twin + frozen snapshot + MIRRORED events, each workspace-scoped |

**Edge themes:** ① **the domain's headline** — Finding #0, measured and fixed ·
② ingest redelivery is gated by the message dedupe + a co-committed reopen ·
③ `Ticket.conversationId` is nullable for the escalation twin, and the
visibility predicate accounts for it (the post-matrix delta's MED) ·
④ N/A · ⑤ `businessHoursOnly` walks forward through `Workspace.workHours` ·
⑥ N/A · ⑦ `listTicketEvents` bounded to the newest 500 · ⑧ restricted agents
cannot raise a ticket outside their visibility · ⑨ every ticket/event/field/SLA
query is workspace-scoped · ⑩ the SLA sweeper is mutexed and CAS-marks.

**CARRIED FORWARD** (unchanged by this pass, both doc-level product decisions):
closing a conversation does not stop its ticket's SLA → a permanent false breach
on work finished on time; and `shiftDueDates` credits WALL-CLOCK pause time
against a deadline computed in BUSINESS hours (a Fri-17:00 → Mon-09:00 hold
credits ~64 h never owed).


### #24 notes — ✅ CLOSED (2026-07-29)

Small domain, re-walked rather than trusted. The predecessor recorded it as
"CLEAN, zero findings"; that still holds at HEAD.

| Invariant | Evidence |
|---|---|
| Visibility boundary on BOTH mutations — a restricted agent cannot note on a thread they can't see, and gets 404 not 403 | **R** `visibilityWhere(viewer)` on create (`notes.service.ts:34`) and delete (`:89`), the delete rooted through the `conversation` relation because `InternalNote` has no `workspaceId` |
| Durable: the note and its event commit together | **R** `publishInTx` + `kickOutbox`, not fire-and-forget |
| Body capped | **R** `z.string().trim().min(1).max(8000)` |
| No edit route exists | **R** the controller exposes only `@Post()` and `@Delete(":id")` |

**The spread is safe here, and for a STRUCTURAL reason worth writing down.**
Both call sites apply visibility via object spread —
`...(viewer ? visibilityWhere(viewer) : {})` — which is the exact shape that has
defeated this codebase repeatedly (the inbox-view clobber, `directoryContactWhere`,
and Finding #8 this session). It is safe *here* because `visibilityWhere`
returns a single scalar key `{ assignedUserId?: string }`, not an `OR` node or a
predicate array, so the only thing it could clobber is a sibling
`assignedUserId` — which neither site has. The danger in the other three cases
came from the RETURN SHAPE, not from spreading as such. Checked, not assumed.

**Edge themes:** ① N/A · ② the event is outbox-delivered, so at-least-once ·
③ delete on a vanished note 404s · ④ N/A · ⑤ N/A · ⑥ `min(1)` rejects an
empty body · ⑦ `max(8000)` · ⑧ covered · ⑨ workspace-scoped through the
conversation · ⑩ N/A.


### #3 event bus / outbox — ✅ CLOSED (2026-07-29)

Checklist from `docs/events.md` §1–§4 + CLAUDE.md §9/§18. No defect.

| Invariant | Evidence |
|---|---|
| Events are notifications — a subscriber reacts, never owns the mutation | **R** every subscriber consumes a committed change |
| Priority tiers, in order | **R** `REALTIME 0 · REALTIME_SECONDARY 1 · AUDIT 10 · ANALYTICS 20 · WORKFLOW_DISPATCH 30 · OUTBOUND_WEBHOOKS 50 · DEFAULT 100` — exactly what §9 and the doc state (40 removed, with the reason recorded in place) |
| Only ONE subscriber runs in the critical tier | **R** `assertSingleCriticalSubscriber()` — and it is genuinely CALLED, from the outbox drainer's bootstrap after every module has registered, not merely defined |
| **§18: never subscribe audit or workflow-dispatch to `broadcast.*`** | **R** verified against the REGISTRIES from both sides: `audit.ts` 12 subscriptions / **0** `broadcast.*`; `workflow-dispatch.ts` 4 / **0**; and a repo-wide scan finds **no** file subscribing `broadcast.*` by literal |
| …and broadcast events still ARE delivered, to socket-fanout alone | **R** they are registered TABLE-DRIVEN — `realtime-fanout.service.ts` iterates `FANOUT_RULES`, which carries `broadcast.status_changed`, `progress`, `recipient_message_sent`, `conversation_reopened` — plus **E** `fanout-storm-guard.spec.ts` pins the per-recipient ones conversation-scoped |
| Durable outbox survives a crash between the DB write and fanout | **E** `outbox-lease.spec.ts` |
| Consumers tolerate at-least-once redelivery | **E** `outbox-redelivery-dedupe.spec.ts` + the three `*_event_key_uniq` partial UNIQUEs, pinned by `partial-indexes.spec.ts` |
| Ordering assumed only within one publish's tiers | **R** documented and not relied on across events |

**Method note worth keeping.** The broadcast-exclusion check had to be run from
BOTH sides. A repo-wide grep for `subscribe("broadcast.…")` returns **zero
files**, which naively reads as "the events go nowhere" — a second, different
bug. They are delivered because socket-fanout registers from the `FANOUT_RULES`
table rather than by literal string. Proving an absence-based invariant means
also proving the thing that SHOULD consume the event still does; otherwise the
strongest evidence for the invariant is indistinguishable from the feature being
dead.

**Edge themes:** ① N/A · ② **covered — the domain's core** · ③ subscribers
tolerate a vanished row · ④ N/A · ⑤ N/A · ⑥ N/A · ⑦ the drainer batches
(200/tick, ≤10 drains) · ⑧ N/A · ⑨ every payload carries `workspaceId` ·
⑩ the drainer re-dispatches claimed-but-uncommitted rows after a restart.


### #12 customers / identity — ✅ CLOSED (2026-07-29)

Checklist = the seven numbered rules in `docs/identity.md` "Rules that keep this
safe", plus the §58 composition warning. **All seven hold.** No defect found.

| Rule | Invariant | Evidence |
|---|---|---|
| 1 | Auto-merge ONLY on deterministic strong keys | **R** `strongKeys` is exactly `phoneNumber`, plus `email` gated on `trustEmailAsStrongKey` (default OFF, one caller: the self-asserted contact-share chip) |
| 2 | No fuzzy / name matching, ever | **R** `name` appears in identity-service only to SEED a new customer — it is never a predicate |
| 3 | event bus / outbox | 1 | R (adversarial, registries not comments) + E | ✅ **2026-07-29** — tiers, single-critical boot assertion and the §18 broadcast exclusion all verified from both sides; no defect |
| 4 | Merge is non-destructive | **R** zero `contact.delete*` / `message.delete*` in `customers.service.ts`; the only delete is empty-customer cleanup, which the doc sanctions |
| 5 | assignment (policies/rules/capacity) | 1 | R (adversarial) + E | ✅ **2026-07-29** — §18 enforcement verified structural (CAS, not the pre-read); no defect |
| 6 | ONE writer | **R** `resolveCustomerId` called only from ingest (×3), ingest-call and the drift sweeper — never a controller or provider |
| 7 | tickets (+SLA+numbering+escalation) | 1 | R (adversarial) + E (28+) + N (burnt-number pin) | ✅ **2026-07-29** — Finding #0 fixed + measured; 2 product decisions carried forward |

**Rule 7 is the subtle one and it is genuinely implemented.** Blocking only the
outbound half would leave the attack reachable from the far side: a stranger
types a known customer's number into the public pre-chat box, and *the real
owner's* next inbound then resolves that number, finds the widget contact, and
adopts ITS customer — folding a stranger's live thread into the real person's
profile and channel switcher (exploitable when the widget row is older, since
`orderBy: createdAt asc` means oldest wins). The exclusion sits in the candidate
query, so both directions are closed. The value is still STORED so an agent can
see it; it just never acts as a key.

**§58 composition warning — VERIFIED HELD at every site.** `directoryContactWhere`
is an `OR` node, so spreading it into a `where` that already has a top-level `OR`
clobbers that disjunction and silently widens the result — the same class as the
inbox-view spread and the `filterKey` omission (Finding #8). All sites are
correct: `countAll` spreads it but has no sibling `OR`; the export runner uses an
explicit `AND: [...]`; and the raw-SQL twin `DIRECTORY_CONTACT_SQL` is a
parenthesised fragment ANDed in.

**Edge themes:** ① the drift sweeper CASes on `customerId` · ② N/A ·
③ `deletedAt: null` keeps tombstones out of the candidate set · ④ N/A ·
⑤ N/A · ⑥ no strong key → a fresh customer, never a match-all · ⑦ the drift
sweeper is batched · ⑧ merge/split is agent-driven and workspace-scoped ·
⑨ covered (rule 5) · ⑩ the sweeper is mutexed and resumable.

**CARRIED FORWARD (the doc declares it itself, not a new finding):** the
merge/split **audit record** is still not persisted — merge and split only write
log lines. `docs/identity.md` rule 3 flags it: *"Add it before relying on merge
history."* Unchanged by this pass.


### #13 inbox-views — ✅ CLOSED (2026-07-29)

Checklist taken from `docs/inbox-views.md` §1–§6. **The best-covered domain
found so far**: all six invariants already map to green tests in
`inbox-views.spec.ts` (31), and the walk found no defect — only one stale
comment.

| Doc § | Invariant | Evidence |
|---|---|---|
| §1 | An empty list is "no opinion", never `in: []` — a view with every box unticked shows everything, not nothing | **E** *"treats an EMPTY list as no opinion, not as 'match nothing'"* |
| §2 | Visibility is a READ boundary in the workspace-scoped `where`, never fetch-all-filter-in-JS; a personal view 404s (not 403) for a teammate | **E** the whole `visibility` block (6) incl. cross-workspace and the API-key actor |
| §3 | `inboxViewWhereClauses` returns INDEPENDENT predicates that callers AND — **never** a merged object | **E** *"returns INDEPENDENT clauses so a visibility restriction can't be clobbered"* + *"CANNOT escape the agent-visibility restriction"*; **R** both callers verified to splice `...viewClauses` into an AND array, never a sibling spread |
| §4 | Dangling references WIDEN, they don't empty — and resolution runs on the list AND the counts path | **E** `dangling references` block (4) + *"counts the same set the list returns"* |
| §5 | Counts are a separate endpoint keyed by the filter document | **E** + **R** `GET /inbox-views/counts` resolves before counting |
| §6 | The client mirror `matchesInboxViewFilters` must agree with the server, and EXCLUDES when it cannot decide | **E** `client matcher` block (4) — incl. agreement on the empty document and *"EXCLUDES a row whose data it cannot see"* |

**The one thing found: a stale comment that would have misled the next reader.**
`InboxViewsService.get`'s docblock said dangling-id cleanup is opt-in "because
it costs three extra queries and **the list path is the only caller that needs
it**." That has not been true since counts started resolving. It is the exact
shape of comment that causes a later change to skip resolution on counts for
"performance" — and a badge that skips it counts a dangling tag as matching
nothing while the list it labels widens, so the number and the rows disagree.
Corrected in place, citing §4.

**Edge themes:** ① N/A (views are documents, not counters) · ② N/A ·
③ **covered — this is the domain's whole §4** · ④ N/A · ⑤ N/A ·
⑥ covered (§1) · ⑦ per-scope view cap · ⑧ covered (§2, incl. shared-view
capability and the API-key actor getting shared-only) · ⑨ covered
(*"does not leak a view across workspaces"*) · ⑩ N/A.

Notable for the program: the predecessor recorded this invariant as having been
defeated "3+ times" by an object spread. It is now genuinely closed — the
builder's SHAPE (an array) makes the old mistake unrepresentable, which is a
better fix than remembering not to make it.


### #14 channels / multi-account — ✅ CLOSED (2026-07-29)

The domain the maintainer cares most about, and the one that has produced a HIGH
in five separate prior sessions. Checklist taken verbatim from
`docs/channel-accounts.md` §6 (nine stated invariants) plus CLAUDE.md §5/§7/§18.

| # | Invariant (doc §6) | Evidence |
|---|---|---|
| 1 | `@@unique([workspaceId, channel, externalAccountId])` — re-connecting updates, never duplicates | **R** schema |
| 2 | Dedup keys stay **workspace**-scoped, NOT per-account | **R** `Message @@unique([workspaceId, channel, externalId])`, `Call @@unique([workspaceId, channel, externalCallId])` — adding the account would make status webhooks miss |
| 3 | event bus / outbox | 1 | R (adversarial, registries not comments) + E | ✅ **2026-07-29** — tiers, single-critical boot assertion and the §18 broadcast exclusion all verified from both sides; no defect |
| 4 | The account is re-stamped on every inbound; the widget binding is **sticky** | **R** `ingest.ts:2217-2223` (guarded so the common case writes nothing, and explicitly *"unlike webchat's sticky webchatWidgetId"*) + **E** `webhook-account-attribution.spec.ts`, `multi-account/01` |
| 5 | assignment (policies/rules/capacity) | 1 | R (adversarial) + E | ✅ **2026-07-29** — §18 enforcement verified structural (CAS, not the pre-read); no defect |
| 6 | Attribution renders ONLY above one account per channel | **R** `showAccountFor(channel)` gates every `AccountLabel`; a single-account inbox stays byte-identical |
| 7 | tickets (+SLA+numbering+escalation) | 1 | R (adversarial) + E (28+) + N (burnt-number pin) | ✅ **2026-07-29** — Finding #0 fixed + measured; 2 product decisions carried forward |
| 8 | realtime layer | 1 | R (adversarial) + E (18 reducer + storm guard) | ✅ **2026-07-29** — all three reducer consumers verified table-driven; no defect |
| 9 | `business_management` is required in practice | **R-only** — a Meta permission, not our code; both onboarding guides and the settings panel say so |

Plus the multi-account lens applied across the delta: `Message.channelConnectionId`
as immutable history (**E** `multi-account/03`), outbound-webhook attribution
(**FIXED**, Finding #2), calls/ingest account threading, and the whole
`tests/e2e/multi-account/` suite at **42/42**.

**Invariant 8 was the one that was false, and it was a data-loss path.** See the
finding below. Worth noting *how* it was found: not by reading the inbox code,
but by taking the doc's own list of invariants and checking each one. Invariants
1–7 and 9 all held; a reviewer trusting the code's own comments would have moved
on, because the comment three lines above the bug describes the exact hazard and
sounds authoritative.

**Edge themes:** ① N/A · ② covered (2 — dedup survives redelivery per account) ·
③ disconnecting an account is `SetNull` + the >1-account confirm guard
(`assert-channel-disconnect.ts`, `channel-disconnect-guard.spec.ts`) ·
④ N/A · ⑤ N/A · ⑥ a workspace with zero accounts renders no chrome · ⑦ N/A ·
⑧ the directory is member-readable by design, credentials are not (5) ·
⑨ every account query is workspace-scoped · ⑩ N/A.

### Finding #8 — HIGH: bulk delete could destroy chats the agent could not see

`docs/channel-accounts.md` §6: *"the account narrow is ANDed, never merged, and
must be part of `filterKey` or it silently does nothing."* It was not in
`filterKey`.

The key was built inline from `filter` alone. The account narrow is a SECOND,
independent dimension living in the filter CONTEXT, so switching Sales → Support
produced a byte-identical key and neither effect keyed on it fired:
`setSelectedIds(new Set())` and `setHighlightedIndex(-1)`.

The first is the dangerous half. `bulkDelete()` posts the retained ids to
`/api/conversations/bulk`, which removes every message and note and says so in
its own dialog (*"This can't be undone"*). Select chats on Sales → narrow to
Support → Delete, and Sales threads the agent cannot see are destroyed while the
UI shows Support rows.

**The inline comment three lines above the bug already described this hazard**
(*"a bulk-delete would target invisible chats"*) — it simply did not know a
second dimension existed. That is the argument for extracting the rule to
`lib/filter-key.ts` rather than patching in place: the next dimension gets added
somewhere a test can see it, the same reason `inboxViewWhereClauses` and
`channelAccountDisplayName` exist.

Pinned by `apps/web/test/filter-key.spec.ts` (6), asserting DISTINCTNESS across
dimensions rather than exact strings — including a collision case (stage `"a"` +
account `"b"` must not alias stage `"a|b"` + no account, which naive
concatenation would). NEGATIVE-TESTED: dropping the account segment fails 3 of 6.


### #21 reports / analytics — ✅ CLOSED (2026-07-29)

A domain that never had a matrix row: it shipped in the unaudited delta with 2
unit specs, no e2e, no UI spec and no `/v1` parity spec. Checklist from
CLAUDE.md §7/§12/§15/§18 + the module docblock.

| # | Invariant | Evidence |
|---|---|---|
| 1 | `workspaceId` in EVERY query | **R** all ten query functions verified individually |
| 2 | `accountId` proved to belong to THIS workspace before it reaches nine raw predicates | **R** + **N** `reports-accounts.spec.ts` — an unknown id is REJECTED, not silently emptied |
| 3 | event bus / outbox | 1 | R (adversarial, registries not comments) + E | ✅ **2026-07-29** — tiers, single-critical boot assertion and the §18 broadcast exclusion all verified from both sides; no defect |
| 4 | Range capped (`MAX_RANGE_DAYS = 366`) → `400 invalid_range` | **E** `reports-overview.spec.ts` |
| 5 | assignment (policies/rules/capacity) | 1 | R (adversarial) + E | ✅ **2026-07-29** — §18 enforcement verified structural (CAS, not the pre-read); no defect |
| 6 | Internal route gated on `teamActivity:view` | **R** `@RequireCapability("teamActivity:view")` under `SessionGuard`; the web redirect is UX only, the API is authoritative |
| 7 | tickets (+SLA+numbering+escalation) | 1 | R (adversarial) + E (28+) + N (burnt-number pin) | ✅ **2026-07-29** — Finding #0 fixed + measured; 2 product decisions carried forward |
| 8 | realtime layer | 1 | R (adversarial) + E (18 reducer + storm guard) | ✅ **2026-07-29** — all three reducer consumers verified table-driven; no defect |
| 9 | One response shape shared by both routes | **R** both call `getWorkspaceReport` and return `WorkspaceReport`; the docblock names the 2026-07-28 calls-artifact regression a second mapper caused |
| 10 | Multi-account lens: every panel scopable to one account | **N** `multi-account/08-reports.spec.ts` (4) |
| 11 | Heavy queries ride an index, not a scan | **R** the module documents `(workspaceId, timestamp)`; the account filter rides the FK index added in `20260728100000` |

**Edge themes:** ① N/A (read-only) · ② N/A · ③ an agent deleted mid-range simply
stops matching · ④ N/A · ⑤ **covered — the highest-risk detail in the domain**
(`Message.timestamp` is a naive timestamp holding UTC, so a single `AT TIME
ZONE` would REINTERPRET rather than convert; the code attaches UTC first) ·
⑥ empty range → zeros, not a crash · ⑦ 366-day cap · ⑧ covered (6, 7) ·
⑨ covered (1, 2) · ⑩ N/A.

**A third false positive from my own tooling, caught by reading.** My scoping
detector reported `querySla` as having a raw query with no `workspaceId`. It
does not — the detector counted the NESTED `Prisma.sql` fragment (the
account-filter `EXISTS` sub-clause) as an independent query. The outer statement
is scoped, and the fragment is transitively safe because it joins on
`t."conversationId"` of an already-scoped row. Three of my own detectors have
now produced a wrong answer in this program (a missing-index claim, a
prose-matching doc probe, and this); every one was caught by reading the code
instead of trusting the grep. Worth stating plainly, because the same instinct
is what the ledger keeps demanding of the app's own checkers.


### §12 /v1 DOC PARITY — 31 routes were undocumented; now CHECKER 8 (2026-07-29)

CLAUDE.md §12 makes this a **locked rule**: every `/v1` endpoint documented in
BOTH `docs/organization-api.md` and the in-app `/docs/api` page. Nothing
enforced it, so it drifted — and the drift is invisible from every side: the
code compiles, both docs render, and only a partner discovers the route they
needed was never written down.

Measured against the controller's 163 routes:

| Surface | Undocumented routes | Missing scopes | Phantom scopes |
|---|---|---|---|
| `docs/organization-api.md` | **31** | 3 (`admin:settings`, `read:reports`, `write:workflows`) | 1 (`write:users`) |
| in-app `/docs/api` page | 0 | 0 | 0 |

The markdown is what rots, because it is the surface a human has to remember.
It came back from `main` (131 commits behind) when `docs/` was restored, which
is precisely the situation the predecessor ledger warned about: *"WHOEVER
RESTORES docs/ MUST refresh those rows."*

**The worst single entry was not a missing route — it was `write:users`.** The
doc told partners to request a scope **no route requires any more** (the
availability write moved to `admin:settings`). A key minted from that
instruction 403s with nothing to explain why. A doc that advertises a dead scope
is worse than one that omits a live route.

FIXED: documented all 31 (customers, workflows, audience-groups, snippets,
outbound-webhook management, reports, escalation targets, broadcast
preview-missing, two WhatsApp admin actions) and corrected the scope.

**A false negative in my own tooling, caught before it became a claim.** The
first comparison probed for a route's bare stem, and "workflows" appears in
prose throughout the document — so it reported **0 missing while 10 routes were
genuinely absent** (6 workflows, 4 customers). I had already written down "0
undocumented". The strict matcher requires a ROUTE-shaped context
(`/v1/<path>`, a backticked `/<path>`, `/<path>/:`). **A checker that matches
prose is a checker that lies**, and this one nearly shipped saying everything
was fine.

**CHECKER 8 — `scripts/check-v1-docs.mjs`.** Enumerates the controller's routes
and `@RequireScope` values and asserts both surfaces carry them, plus flags any
scope a surface ADVERTISES that no route requires (the `write:users` class),
while deliberately allowing a sentence that explains a retirement. In
`pnpm run check` and the deploy workflow. NEGATIVE-TESTED both directions:
deleting the workflows section fails with the 6 routes + the missing scope named
(exit 1); re-advertising `write:users` without a retirement note fails (exit 1);
the restored doc passes (exit 0).


### #15 outbound-webhooks — ✅ CLOSED (2026-07-29)

Checklist generated from CLAUDE.md §12 + §18 + `docs/events.md`, then each line
mapped to a green test or an explicit R-only reason. **13 invariants, 0
unmapped.**

| # | Invariant | Evidence |
|---|---|---|
| 1 | Signed `X-CCP-Signature: t=…,v1=…`, HMAC-SHA256 over the RAW posted bytes | **N** `webhook-signing.spec.ts` (9) — incl. a receiver-side recomputation and a re-serialized-body case. NEGATIVE-TESTED ×2 |
| 2 | Idempotent for the partner: stable `X-CCP-Delivery` id | **E** `outbox-redelivery-dedupe.spec.ts` + **R** `worker.ts:431` |
| 3 | event bus / outbox | 1 | R (adversarial, registries not comments) + E | ✅ **2026-07-29** — tiers, single-critical boot assertion and the §18 broadcast exclusion all verified from both sides; no defect |
| 4 | Auto-disable after repeated failure | **R** `worker.ts` `consecutiveFailures` increment + reset-on-success |
| 5 | assignment (policies/rules/capacity) | 1 | R (adversarial) + E | ✅ **2026-07-29** — §18 enforcement verified structural (CAS, not the pre-read); no defect |
| 6 | SSRF-safe egress | **R** `worker.ts:425` routes through `safeFetch` (DNS-pinned, private ranges + all IPv6 notations blocked) — verified in depth by the predecessor program; R-only because exercising it needs a live resolver |
| 7 | tickets (+SLA+numbering+escalation) | 1 | R (adversarial) + E (28+) + N (burnt-number pin) | ✅ **2026-07-29** — Finding #0 fixed + measured; 2 product decisions carried forward |
| 8 | realtime layer | 1 | R (adversarial) + E (18 reducer + storm guard) | ✅ **2026-07-29** — all three reducer consumers verified table-driven; no defect |
| 9 | Chain-depth guard (`X-CCP-Depth`) | **E** `workflows.spec.ts:159,224` (at-cap and below-cap) + **R** `worker.ts:440` |
| 10 | Retention cleanup batched | **R** `MAX_BATCHES` loop — the unbounded `deleteMany` the predecessor fixed is gone |
| 11 | Fires at tier `OUTBOUND_WEBHOOKS` (50), self-registers | **R** + **E** `fanout-storm-guard.spec.ts` |
| 12 | customers / identity | 2 | R (adversarial, 7 doc rules + §58) + E | ✅ **2026-07-29** — all seven hold, incl. the both-directions ephemeral exclusion; no defect. Merge-audit gap carried forward (doc-declared) |
| 13 | inbox-views | 2 | R (adversarial, 6 doc invariants) + E (31) | ✅ **2026-07-29** — all six already covered; no defect, one stale comment fixed |

**A false positive I caught in my own audit, worth recording.** I reported that
the three `*_event_key_uniq` partial UNIQUE indexes — the only thing preventing
redelivery from double-firing workflows (billed Meta sends) and double-POSTing
partners — were missing from `partial-indexes.spec.ts`. They are not. I had
grepped the spec for the COLUMN name (`eventKey`) while the spec names them by
INDEX name (`event_key_uniq`). Verified three ways before withdrawing it: the
migration, `pg_indexes` on the live dev DB, and the spec's own list. The
§18 tripwire is intact.

**Edge themes:** ① N/A (delivery is queue-serialized per row) · ② covered (12) ·
③ covered (`worker.ts:355` exits cleanly when the row is gone) · ④ N/A ·
⑤ N/A · ⑥ N/A · ⑦ retention batching (10) · ⑧ management routes are
`admin:settings` incl. reads, pinned by `v1-parity.spec.ts` · ⑨ covered (8) ·
⑩ orphan-delivery sweeper re-enqueues preserving `chainDepth`.

**ACCEPTED (documented, not defects):** the retry schedule is BullMQ's, so it is
asserted by configuration rather than by waiting ~31 min in a test; `safeFetch`
is R-only for the same reason its own hardening was — a genuine SSRF assertion
needs a resolver, and the predecessor verified the implementation line by line.


