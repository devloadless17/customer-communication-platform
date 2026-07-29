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

| Gate | Result |
|---|---|
| `pnpm run check` | ✅ **0 errors**, 28 warnings, 7/7 checkers green |
| `pnpm test` — api vitest | ⚠️ **INTERMITTENT**: run 1 **812/813** (1 failed), runs 2+3 **813/813**. See Finding #0 |
| `pnpm test` — web vitest | ✅ 18/18 |
| `pnpm test:e2e:meta` | ✅ **169/170** — the only failure is the `@pressure` spec, which CI excludes. See Finding #1 |
| `pnpm test:e2e:multiaccount` | ⛔→✅ **37/38 on arrival**; the failure was a real HIGH — see Finding #2. **38/38** after the fix |
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
| 8 | 202 / 241 / 209 ms | **107 / 87 / 125 ms** |
| 24 | 338 / 346 / 333 ms | **208 / 289 / 235 ms** |

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

**The harness defect is arithmetic.** The webhook budget is
`ip-rate-limit.middleware.ts:31` `PER_MINUTE = 600` — and it is per-**IP**, not
per-team as the spec header states. Pass 1 spends 500 of it; pass 2 spends
`shed`. Once cumulative requests in the window exceed 600, every remaining
redelivery is refused 429 and convergence becomes *impossible regardless of
whether the app is correct*. At the historically recorded 9–22 % shed the total
was 545–610 — so this harness has always passed by a margin of at most ~55
requests, and at 22 % it was already at the edge. It is not measuring what it
claims to measure.

**Open question for the webhooks-ingest session (B1): why is shed 59 % when the
recorded baseline is 9–22 %?** 503s come from write conflicts under the
Serializable ingest transaction, so a higher shed means more conflicts.
*Hypothesis raised and REFUTED by reading the code*: the new account re-stamp
does **not** add an unconditional write — `ingest.ts:2223` writes
`channelConnectionId` only when it actually differs, and a freshly created
conversation already carries it from the insert at line 2207. Remaining
candidates are box contention (25 in flight on 22 cores) versus a genuine
increase in per-request transaction work. Resolve it in B1 with a bisect against
`857f420f`, not by adjusting the threshold.

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

| # | Domain | Tier | Method | Status |
|---|---|---|---|---|
| 1 | webhooks ingest | 1 | | ☐ |
| 2 | outbound send + idempotency ledger | 1 | | ☐ |
| 3 | event bus / outbox | 1 | | ☐ |
| 4 | workflows (~22 step types) | 1 | | ☐ |
| 5 | assignment (policies/rules/capacity) | 1 | | ☐ |
| 6 | broadcasts (+audience/templates/analytics) | 1 | | ☐ |
| 7 | tickets (+SLA+numbering+escalation) | 1 | | ☐ |
| 8 | realtime layer | 1 | | ☐ |
| 9 | auth / org / workspaces / members | 1 | | ☐ |
| 10 | external `/v1` API | 1 | | ☐ |
| 11 | contacts (+import/export/transfer) | 2 | | ☐ |
| 12 | customers / identity | 2 | | ☐ |
| 13 | inbox-views | 2 | | ☐ |
| 14 | channels / multi-account | 2 | | ☐ |
| 15 | outbound-webhooks (delivery/retry) | 2 | | ☐ |
| 16 | calls (WhatsApp calling + artifacts) | 2 | | ☐ |
| 17 | media / R2 / blob-storage | 2 | | ☐ |
| 18 | queues / workers | 2 | | ☐ |
| 19 | sweepers | 2 | | ☐ |
| 20 | coexistence | 2 | | ☐ |
| 21 | **reports / analytics** *(NEW — never had a row)* | 2 | | ☐ |
| 22 | **webchat widget** *(NEW — never had a row)* | 2 | | ☐ |
| 23 | tags / stages / fields / snippets / flags | 3 | | ☐ |
| 24 | notes | 3 | | ☐ |
| 25 | team-chat (+DMs) | 3 | | ☐ |
| 26 | ai-assistant | 3 | | ☐ |
| 27 | admin / platform (superadmin) | 3 | | ☐ |
| 28 | registration / invites | 3 | | ☐ |
| 29 | common guards / pipes / filters | 3 | | ☐ |
| 30 | api-keys lifecycle | 3 | | ☐ |
| 31 | **ops / health / deploy pipeline** *(NEW — never had a row)* | 3 | | ☐ |

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
- `ai-knowledge/`, `ai-voice-draft/`, `tpl-hdr-` blobs orphaned by workspace
  delete (prefix-excluded rather than cross-checked — the same class that was
  permanently deleting call recordings).
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

### `lib/sweepers/webhook-subscription-health.ts` — zero tests, and untestable as the harness stands

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

**RISK-3.** `probeStuckBroadcasts` is the one probe **not** wrapped in
`bounded()` — in `ops-snapshot.ts:112`, and identically at its two other call
sites (`health.controller.ts:101`, `health-watchdog.service.ts:90`), while
every sibling DB probe there is bounded at 2.5 s. It is a Prisma query, so
under a saturated pool it waits — up to the 30 s `statement_timeout`. `/health`
is the **api container's Docker healthcheck** (`docker-compose.yml:205`,
`timeout: 3s`, `retries: 3`), and the deploy gate reads
`docker inspect .State.Health.Status`. So DB pressure — the moment you least
want it — can make the api read unhealthy and trip the deploy's auto-rollback on
a release that is fine. Pre-existing (not from the delta) and consistent across
all three sites, so it is a design gap, not a regression. Belongs to domain #31.

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

_(appended as each domain closes)_
