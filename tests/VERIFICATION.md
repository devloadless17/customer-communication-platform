# Verification Ledger

The single authority on what has been verified, how, and when. A domain is ✅
only when every invariant in its section maps to a **green test** or an
explicit **R-only (reason)** note, with the commit hash recorded. Anything
else is unverified — no matter how confident anyone feels about it.

Method codes: **R** = adversarial code-reading pass · **E** = existing tests
audited (still asserting the invariant, green, isolation-scoped) · **N** = new
targeted tests written.

Edge themes applied per domain (mark N/A explicitly, never silently):
① concurrent double-submit / CAS races · ② at-least-once redelivery ·
③ mid-flight deletion of a referenced entity · ④ reconnect / backfill
convergence · ⑤ timezone + window boundaries · ⑥ empty inputs · ⑦ huge inputs ·
⑧ permission boundaries (agent/manager/admin/org-admin/superadmin) ·
⑨ workspace isolation · ⑩ pause/resume/worker-restart.

Checklist generation rule (run at the start of each domain session):
invariants = CLAUDE.md §18 + `git show HEAD:docs/<domain>.md` + schema
constraints + lib READMEs; seams = grep `publish(`/subscribers + FK relations +
cross-domain imports + `fanout-rules.ts` entries + thread-reducer wiring +
`/v1` twins. Every lifecycle-ending op gets a named seam-trace listing every
table/queue/cache/socket-room that references the dying entity.

## Predeploy ritual (run before every push to `production`)

1. `pnpm run check` (typecheck ×3 + lint + prisma-fields + test isolation)
2. `pnpm test` (Vitest, 36 files)
3. `pnpm test:e2e:meta` (hermetic; needs Postgres + Redis)
4. `pnpm test:e2e` against the running stack (needs `pnpm dev` or prod:local)
5. Canary intact after 3 & 4 (automatic — the run fails if not)

## Infrastructure (Milestone B-M1) — 2026-07-26

| Item | Status |
|---|---|
| Dedicated e2e fixture org/workspace (`e2e-app-org`/`e2e-app-ws`), app-admin re-homed off the real superadmin workspace | ✅ |
| `wipeTestData(workspaceIds)` scoped + `/^e2e-/` tripwire (was 14 unfiltered `deleteMany({})`) | ✅ |
| `createTestWorkspace` forces `e2e-` ids; explicit ids validated | ✅ |
| `superadminTeam()` moved to `_helpers/platform.ts` (platform specs only); 15 specs re-pointed to `appAdmin()` | ✅ |
| Isolation canary (`_helpers/canary.ts` + setup/teardown, wired into BOTH playwright configs) | ✅ |
| `scripts/check-test-isolation.mjs` (self-tested: catches `deleteMany({})`, bare call, where-less `updateMany`) | ✅ |
| Root scripts: `test`, `typecheck:tests`, `typecheck:root`, `check`; `scripts/` in root tsconfig | ✅ |
| Latent type errors surfaced by typecheck:tests fixed (assignment-select spec ×3, meta-social BlobPart) | ✅ |
| Vitest suite green (502/502) after applying 2 pending migrations to dev DB | ✅ |
| Meta suite green (165/165) incl. canary | ✅ |
| Stale-suite repair: harness still seeded dropped `ticketAutoOpen` column (Prisma `data` checker blind spot — live proof); ticket-routing.spec rewritten to the no-auto-open model; `routeMessageToTicket` doc comment + CLAUDE.md §2 corrected | ✅ |
| Main Playwright suite ×2 with canary intact | in progress |

### Production bugs found BY the isolation work (fixed 2026-07-26)

| Bug | Root cause | Fix |
|---|---|---|
| **Team-chat @mention sends 400 in every workspace** (P0, live since the Team→Workspace rename) | `channels.service.ts validateMentions` filtered `User` by the dropped `workspaceId` column — built in a typed variable, the field checker's documented non-inline blind spot; surfaced only when the suite ran in a fresh workspace | Filter via `workspaceMemberships.some.workspaceId` (users are org-scoped) |
| **"AI Active" badge + "Handled by the AI Agent" assignee shown in AI-less workspaces** (misleading UI fiction) | `ai-inbox.service.ts overview()` returned `state ?? "ai_active"` without gating on `configEnabled(loadAiConfig(ws))` — the reply subscriber checks it, the UI didn't | Report `"disabled"` when the workspace assistant isn't enabled; web already hides all AI chrome for it |
| Suite-hygiene leaks breaking honest specs | calls specs left WhatsApp connections (gate test saw "configured"); r2-media + security-hardening left media messages whose blobs 404 every later /team render | Scoped afterAll cleanups added to all three files |
| **Team-chat composer silently dropped rapid sends** (Enter during an in-flight POST was eaten; Send button greyed mid-flight) | `busy` guard fired after the optimistic clear, so a legitimately-typed second message had no path to send | In-order `sendChain` (text + media): each submission has its own clientTempId/optimistic row; order preserved, nothing dropped |
| **Grouped-row height flicker on chained sends** (continuation row sprouted a full author header for ~a round-trip, then collapsed) | Grouping un-groups on negative timestamp gap; a pending row's local time legitimately sits behind the server stamp its predecessor adopts on confirm | Pending rows with a small (≤30s) negative gap stay grouped; their own confirm restores true order |

## Domain matrix

| Domain | Tier | Method | Status |
|---|---|---|---|
| webhooks ingest | 1 | R (controller + core, adversarial) + E (meta 165) | ✅ 2026-07-27 |
| outbound send + idempotency ledger | 1 | R (adversarial) + E | ✅ 2026-07-27 |
| event bus / outbox | 1 | R (adversarial) + E + N (dedupe spec) | ✅ 2026-07-27 |
| workflows (~22 step types) | 1 | R (adversarial) + E (144 e2e) | ✅ 2026-07-27 |
| assignment (policies/rules/capacity) | 1 | R (adversarial) + E + N (pick-burst spec) | ✅ 2026-07-27 |
| broadcasts (+audience/templates/analytics) | 1 | R (3-track adversarial) + E (meta 165) | ✅ 2026-07-27 |
| tickets (+SLA+numbering) | 1 | R (adversarial) + E (meta 165) + N (breach guard) | ✅ 2026-07-27 |
| realtime layer | 1 | R (adversarial) + E (144 e2e two-tab) | ✅ 2026-07-27 |
| auth / org / workspaces / members | 1 | R (adversarial) + E (45 e2e) | ✅ 2026-07-27 |
| external /v1 API | 1 | R (adversarial, all 111 routes) + E (180 e2e) | ✅ 2026-07-27 |
| contacts (+import/export/transfer) | 2 | R (adversarial) | ✅ 2026-07-27 — bulk-tag storm a2b6de83, reaper pagination 73317ffd, unknownStages + resume marker 112ac0c3, export directory filter f4f4318d (errorRows heap = ACCEPTED: bounded by the 50MB upload itself, only reachable on a fully-mismapped file) |
| customers / identity | 2 | R (adversarial) + N (visibility spec) | ✅ 2026-07-27 — profile visibility 3e137336, tombstone reap + §18 scoping f4f4318d, drift-sweeper starvation 73317ffd |
| inbox-views | 2 | R (adversarial) | ✅ 2026-07-27 — and-not-spread invariant HELD across all 3 callers; `channels` now validated via zLiveChannel (was free-text: one bogus value permanently 500'd counts for every member seeing a shared view) |
| channels / multi-account | 2 | R (adversarial) | ✅ 2026-07-27 — batched-webhook attribution fixed by the CONCURRENT SESSION (3ff49296); viable-default promotion f4f4318d; phone-claim check-then-act = ACCEPTED (needs a cross-workspace unique, migration-bearing, recorded for the next schema change) |
| outbound-webhooks (delivery/retry) | 2 | R (adversarial) | ✅ 2026-07-27 — SSRF/HMAC/dedupe VERIFIED HELD; unbounded retention DELETE FIXED 29deb9c8 |
| calls (WhatsApp calling) | 2 | R (adversarial) | ✅ 2026-07-27 — post-CAS throw 29deb9c8; live-vs-history scoping split DOCUMENTED 112ac0c3 (deliberate, was only noted on endCall) |
| media / R2 | 2 | R (adversarial) | ✅ 2026-07-27 — tenancy + XSS VERIFIED HELD; download regression 37c0a2b9, recovery sweeper + mime + parked echo a2b6de83, SSRF fetchUrlBytes 73317ffd |
| queues / workers | 2 | R (adversarial, all 7 workers) | ✅ 2026-07-27 — jobId/lockDuration/backpressure VERIFIED HELD; transfer-worker stall config + close cap FIXED 112ac0c3 |
| sweepers | 2 | R (adversarial, all 30 enumerated) | ✅ 2026-07-27 — mutex/bounds/pool-close VERIFIED HELD; retention batching 29deb9c8, pagination + starvation 73317ffd, openTicketCount reconciler ec282d79 (unreadCount is NOT recomputable — §7 corrected, not faked) |
| coexistence | 2 | R (adversarial) | ✅ 2026-07-27 — direction + poison chunk 3e137336, account binding (echo + history) f4f4318d (failed-job PII window = ACCEPTED: 24h/500-row cap, same posture as the completed-job retention) |
| tags / stages / fields / snippets / flags | 3 | R (adversarial) | ✅ 2026-07-27 — bcf656d8: tag delete now scrubs InboxView.filters (a dangling tagId made a SHARED `tagMatch:all` view return an empty inbox forever); usage() counts views; tags/snippets capped at 300 (unpaginated lists every client refetches on team.catalog_changed, `tags:manage` defaults TRUE for agents); reorder bodies capped. 4f080e1c: the stage isDefault race now reports itself instead of a bogus name collision |
| notes | 3 | R (adversarial) | ✅ 2026-07-27 — CLEAN, zero findings. visibilityWhere(viewer) on both mutations, publishInTx + kickOutbox (not fire-and-forget), emitAboutConversation respects restricted-agent scope, global-search notes carry the same restriction, body capped, no edit route |
| team-chat (+DMs) | 3 | R (adversarial) + the 5 tenancy-exception satellites audited | ✅ 2026-07-27 — bcf656d8. HIGH: setMembership never created the #general TeamChannelMember row → empty sidebar, dead workspace search, and an infinite /team redirect loop once anyone DM'd them (one DM defeats ChannelExistenceGuard's escape hatch); one `joinDefaultChannel` now serves all three membership paths. MED: markRead probed on createdAt while both badge counters use COALESCE(editedAt, createdAt), so an edit-added mention could never be cleared. MED: pins uncapped + unpaginated with full message DTOs, either party may pin in a DM. **All 5 TeamChannel* TENANCY EXCEPTIONS verified**: every query reaches them through a workspaceId-scoped parent or carries `channel: { workspaceId }` — no bare child id from request input |
| ai-assistant | 3 | R (adversarial) | ✅ 2026-07-27 — 4f080e1c. MED: the debounce silently DROPPED a message (remove() can't touch a locked job; BullMQ ignores an add on an existing jobId) — the assistant never answered it. MED: `escalate` bypassed autoReplyMode:'draft', auto-sending free-form model text in a workspace whose contract is human-approval-only; now sends only where the mode would, and the routing/hand-off is one shared helper. MED: knowledge extraction ran uninterruptible CPU work on the loop shared by Socket.io + ingest + every worker (Promise.race can't preempt it) — serialized process-wide, residual single-file block documented with its named trigger (worker thread). LOW: prompt now fences customer text; caption branch gates on configEnabled |
| admin / platform (superadmin) | 3 | R (adversarial) | ✅ 2026-07-27 — 98c94160. **MED/SEC**: a superAdmin was granted ANY workspace that exists and resolveSession handed them role 'admin' in it — one `ccp.ws` cookie exposed any tenant's message bodies + contact PII, unlogged, contradicting super-admin.ts's own stated invariant. Beyond-membership is now org-scoped for superAdmin and org-admin alike, in all three copies. The zero-membership fallback picked the oldest workspace ON THE PLATFORM (a customer's) — now the caller's own org. Anchor leaked into GET /api/admin/teams and was writable by the limit controls; roster memo not busted by workspace/member mutations; cold roster scan ran twice |
| registration / invites | 3 | R (adversarial) | ✅ 2026-07-27 — 98c94160. MED: invite create was an unmetered mail amplifier — re-invite deletes the pending row BEFORE counting seats, so the cap never bounded resends and each loop sent a real email from the shared sender identity; 60s per-recipient cooldown + 20/min controller limit. MED: registration COMMITS a whole tenant before the OTP is sent (OAuth mints an org with no compensating delete) and nothing reaped them — new `abandoned-registration` sweeper, deliberately narrow (pending + >7d + zero verified email + zero work), destroying through the real `destroyOrganization` rather than a second impl |
| common guards / pipes / filters | 3 | R (adversarial) | ✅ 2026-07-27 — 98c94160. The guard/pipe/filter layer VERIFIED HELD in depth (RoleGuard keys superAdmin on the flag not the collapsed role; ScopeGuard fail-closed; ConversationVisibilityGuard 404-never-403 through the single authority; SessionGuard cache keyed (userId, workspaceId) with the cookie hash covering ccp.ws; PrismaExceptionFilter logs .meta and never bodies it, incl. P2003→409). Fixed: the @RateLimit ceiling was per-bucket not global (a decorated route consumed only its own bucket, so one principal could stack inbox+conversations+messages+… on top of the 300) — decorated routes now also draw a 3000/min roof; two raw-exception echoes closed, one on a PUBLIC unauthenticated route |
| api-keys lifecycle | 3 | R (adversarial) | ✅ 2026-07-27 — 98c94160. MED: concurrent rotate left TWO live keys — the liveness read sat outside the transaction and the revoke had no CAS, so a double-click had both requests revoke and both create, one secret returned to a request nobody watched. Now `updateMany` on (id, workspaceId, revokedAt: null); the loser 409s. revoke() moved to the same scoped updateMany (§18 letter). Scope validation, one-time plaintext, hash-only storage and immediate revocation all verified held |

## Domain session notes

### webhooks ingest (B-M3 session 1, 2026-07-27)

Controller-side R-pass (meta.controller.ts) — verified clean:
- HMAC: raw-body bytes, timing-safe compare with length guard, dual
  team-owned secret candidates, dev-skip hard-gated off in production.
- Fail-soft envelope: parse failure / unknown account / missing rawBody →
  200-dropped (no retry storm); ONLY transient DB errors → 503 (safe because
  ingest dedupes); history chunks offloaded to BullMQ with 503-on-enqueue-fail
  (worker dedupes by wamid, so redelivery is safe).
- Media completion: patch CAS'd on `mediaUrl IS NULL AND mediaKind NOT NULL` —
  duplicate completions and sweeper races are no-ops; transient download
  failures PARK the shimmer for the sweeper; permanent ones collapse to a
  labeled text bubble exactly once.
- Orphaned-promise discipline: every fire-and-forget carries a non-consuming
  catch; in-flight media tracked for graceful shutdown drain.

Noted (efficiency, not correctness): a redelivered media batch re-downloads
bytes before the dedupe verdict — the patch no-ops but bandwidth is spent;
acceptable at current scale.

E-audit: meta suite (165 green today) covers signed ingest, HMAC rejection,
dedupe-on-redelivery, cross-channel identity separation, read receipts,
quoted replies, calls, ticket attach/reopen.

Core ingest.ts + ingest-call.ts adversarial pass (10 findings; per-checklist
verdicts CLEAN on tenancy, one-conversation-per-contact, fail-soft, media,
identity seam, ticket seam):

FIXED (2026-07-27):
- P2: echo-path reopen event permanently lost (third live copy of the INB-1
  tx-split class) → reopen CAS + status_changed now co-committed with the
  message insert; duplicate race can no longer split CAS winner from insert
  winner.
- Call terminal race: concurrent duplicate terminate double-published
  call.missed/ended and double-incremented consecutiveUnansweredOutCalls →
  terminal write is now a status-CAS; side effects gate on the CAS win.
- Parked-status drain lacked the live path's direction guard → a parked
  status can no longer rewrite an INBOUND row.
- Watermark paths published transitions that never committed (partners have
  no monotonic guard) → publish only rows re-selected in the committed state.
- Echo splice for a reopened thread carried lastInboundAt: null (teammates
  saw a template-only reply box) → filled from the contact.
- Stale/dead: header claim about status updates ignoring workspaceId; 15min
  park TTL; auto-open-era select + comments; loadRecentForWorkflow now
  carries workspaceId (letter of §18; was transitively safe).

ACCEPTED (documented tradeoffs, not fixed):
- Social reaction redelivery toggles a reaction off (IG same-glyph-remove is
  wire-indistinguishable from a redelivery; UI-only, deliberate per comment).
- Correction/reaction arriving before its target is dropped (no park) — rare
  double-fault ordering, UI-only; park infra exists if it ever bites.
- contact.created is a post-commit bare publish (acknowledged crash-window
  loss, comment accurate).
- BSUID↔phone identity fork if the keys arrive in separate events — DORMANT
  (bsuid null until Meta's 2026+ transition); re-flag before Phase 2.

Structural #14 (media-infra extraction out of meta.controller): DEFERRED to a
paired structural slot with #15 (realtime session) — correctness fixes took
this session's budget; extraction is move-only and safest done cold.

### outbound send + idempotency (B-M3 session 2, 2026-07-27)

Verdicts CLEAN: double-send on the QUEUE path (ledger claim/retain/release,
stable jobId across restart, completedAt stamped pre-insert, recovery
re-inserts from the recorded wamid instead of re-calling Meta), dropped-send
(enqueue awaited before 200, 7d dead-letter retention, terminal failure
publishes message.send_failed + client watchdog), status truth, events
(broadcast bypass complete — no commitOutboundSend import, no ticket/unread
side effects), concurrency caps (per-team 3 under global 5, slot handed back
on defer, no retry-policy deadlock).

FIXED (2026-07-27):
- HIGH §2 violation: five send paths (composer preflight, worker executor,
  media, forward, /v1 text) resolved credentials WITHOUT the thread's
  `channelConnectionId`, falling back to the workspace DEFAULT account — a
  two-number/two-Page workspace replied from the wrong sender, where no 24h
  window exists. All five now pass the conversation's account (forward
  resolves AFTER the destination thread, so a fresh thread still gets the
  default, which is correct for it).
- MED: worker crash-recovery re-insert published a SILENT message.sent even
  when the original commit never ran — no bump, no ticket attach, no SLA
  first-response stamp, no workflows/webhooks for a message the customer had
  received. Recovery now runs the full commit pipeline when it had to
  re-create the row; the silent re-emit stays only for the row-already-exists
  replay.
- LOW: `isProvablyNotSent` extracted as THE shared release-vs-retain rule —
  the worker's `rate_limited` carve-out was missing from all three /v1 sites,
  so a rate-limit signalled ≥500 stranded a partner's key on an unsent
  message.
- LOW: the ambiguous-refusal message told users to "re-send", which can never
  work (the reply box retries in place with the same clientTempId); copy +
  comment now say to compose it again. Sweeper comment describing a
  `v1-send-*` prefix no code writes corrected.

ACCEPTED (documented):
- No per-conversation send ordering: two rapid sends can reach the customer
  out of order if the first hits a transient Meta failure and retries (local
  thread order stays correct). Serializing per conversation is the fix if a
  real case appears.
- Sync paths (media/template/interactive/forward) keep only the in-process
  idempotency map: an api restart between Meta-accept and the HTTP response
  can let a human Retry re-send. Pre-existing, documented tradeoff.

### event bus / outbox subscribers (B-M3 session 3, 2026-07-27)

The at-least-once conversion (17c0501) was verified against the SUBSCRIBERS,
and three were not replay-safe. Fixed in 631c3a2:

- CRITICAL: workflow-dispatch created a WorkflowRun with no dedup key (the
  once-per-contact ledger only covers `triggerOncePerContact` workflows), so a
  redelivery re-executed every step — including a second billed Meta send.
  Now keyed per (outbox row, workflow) with a partial unique.
- HIGH: outbound-webhook deliveries minted `randomUUID()` per dispatch; that
  id is BOTH our BullMQ jobId and the partner's X-CCP-Delivery header, so a
  replay defeated dedupe on both sides. Now keyed per (outbox row, webhook).
- MED: audit pills had no dedup key → duplicate identical rows on replay
  (the messy-timeline class). Keyed with a per-tag discriminator.
- HIGH (ordering): auto-assign + the 4 ai-reply handlers returned `void`, so
  they resolved synchronously — tier 25's whole purpose (routing decided
  before workflow dispatch) was fiction, and they ran outside the timeout,
  the lastError sink and the lease. Now awaited.
- MED: two subscribers registered at REALTIME while only list[0] runs in the
  critical tier — the winner was AppModule.imports order. Widget delivery
  moved to REALTIME_SECONDARY + a boot assertion pins one-per-type.
- MED: publish()'s background tier had no per-subscriber timeout (bounded at
  30s); markDispatched now retries (a pool blip redelivered a successful
  batch); shutdown flush 25s → 60s (a SIGKILL mid-dispatch guarantees
  redelivery, and one row can legitimately take ~150s).

Verdicts CLEAN: §18 broadcast.* exclusion (verified against the registries,
not comments), no recursive chains, error isolation, registration hygiene.
Analytics counters remain non-idempotent by design — `outgoingMessagesCount`
self-heals via the drift sweeper; `responsesCount`/`assignmentsCount` do not
and can drift on a crash-window replay (documented, sweeper-excluded).
Webhook payloads are rebuilt from CURRENT state on replay, so a duplicate
delivery can disagree with the original — bounded by the dedupe key now
preventing the duplicate in the first place.

### workflows engine (B-M3 session 4, 2026-07-27)

Independent verification of the redelivery dedupe I added in session 3 —
ALS token confirmed present at every run-create site (including inside
`runWithConcurrency` lanes and `$transaction` callbacks), all four
run-creating paths accounted for, P2002 unambiguous, crash-window covered by
the `queued` sweeper backstop. It found the key too NARROW twice (fixed):
per-trigger fan-out, then per-field/per-tag fan-out.

FIXED: contact locked out permanently by a throwing ledger-rollback scan;
runaway jump loops reporting `completed`; assign_ticket overriding a human
(status-only CAS); two replies claiming one ask_question; `listRuns`
ternary-built where without workspaceId; 8 stale comments incl. two README
blocks describing prevented behavior.

Verdicts CLEAN: loop/recursion guards TERMINATE (MAX_STEPS_PER_RUN =
MAX_WORKFLOW_NODES = 200; jumpsUsed persisted+monotonic; TRIGGER_DEPTH_MAX
survives non-manual hops; X-CCP-Depth fails closed; no `message_sent`
trigger exists so send_message cannot self-retrigger); step side-effect
safety under retry (lockDuration 90s > step timeout 60s, boot-asserted; the
in_progress journal turns a half-completed send into `skipped_after_crash`,
NOT a re-send); §18 assignment for conversations; wait/ask_question resume
(terminal guard, not-due guard, per-run lock, graphSnapshot pinning,
graceful contact/conversation deletion); conditions validated on both save
and publish; step-target tenancy fully scoped.

ACCEPTED: send_message/send_template/ask_question bypass the
OutboundSendAttempt ledger (journal-protected only — a crash in the narrow
pre-journal window can re-send); branch presets read LIVE contact state
while generic conditions read the frozen trigger snapshot (documented split,
not unified); manual trigger returns 500 if the Redis enqueue fails though
the sweeper will still run it.

### assignment + availability (B-M3 session 5, 2026-07-27) — ✅ CLOSED

FIXED (79b2597): §18 was structurally unenforced for automated routing —
`assignByPolicy` never forwarded `onlyIfUnassigned` into the CAS (TOCTOU
window of tens of ms), and two more paths (broadcast-runner on_send,
campaign-reply) pre-read instead of passing the flag. Round-robin collapsed
into 15-second shifts (cached policy row's cursor never advanced in-memory).
`excludeUserIds` from callers was overwritten by the retry loop, defeating
the offline rebalance. Campaign draw ignored `assignmentOverwrite`. No-op
writes reported as applied (phantom "moved" counts; skipped unassign).
Work-hours sweeper reverted an override set mid-sweep.

CLOSED (704717b): the whole open list.
- F4: the null presence guard was dead code (resolver wired at boot; a restart
  yields an EMPTY set, and tierFor then fails open to DB availabilityStatus,
  so the sweep really could move 50 threads/ws to merely-DB-available agents).
  Sweep now also skips on `online.size === 0` — restart and genuinely-empty
  floor both mean "do nothing".
- F6: picks serialized per (workspace, policy) (`withPickLock`) + loadConfig
  single-flighted. The single-flight matters: on a COLD cache each concurrent
  miss got its OWN policy object, so the in-cache cursor mutation from
  79b2597 didn't propagate and a boot/expiry burst still stampeded. Pinned by
  `apps/api/test/assignment-pick-burst.spec.ts`; the weighted-unequal-served
  case is the one the LOCK carries (round_robin is saved by the synchronous
  select+mutate on the shared object) — negative-tested: disabling the lock
  fails the spec 3-0-0 vs 2-1-0.
- F10: failed write → `releaseReservation`. Cursor/`served` stay advanced —
  ACCEPTED: both are last-writer-wins fairness hints; un-advancing a cursor a
  later pick already passed would corrupt the rotation (documented at the fn).
- F11: policy/member writes carry workspaceId (`updateMany` where update
  couldn't). The `policyId_userId` upserts keep the parent-scoped pattern
  (compound unique can't carry the column).
- F12: 4 stale claims fixed — the unimplemented "actively VIEWING" bullet
  removed; the schema `served`-renormalization claim corrected; the
  "returns null right after a restart" claim in presence-bridge.ts AND
  select.ts corrected (the false premise that made F4's guard look alive).
- F14: the pending-only rebalance filter now backstops `firstResponseAt`
  with `messages: none (direction out, senderUserId not null)` — ground
  truth over the fire-and-forget analytics stamp.

Evidence: vitest 512/512 twice, workflows-events 144/144 (on final code),
meta 165/165, typecheck + all 4 checkers green.

### broadcasts + audience + templates + analytics (B-M3 session 6, 2026-07-27) — ✅ CLOSED

Three-track adversarial pass (runner/service core; analytics + deliveryState
funnel; campaign-assignment seam). FIXED (f0e9e63):
- HIGH: paused SCHEDULED campaign resumed as an IMMEDIATE send (template
  re-approval webhook, or boot resume after ANY deploy) — resume now returns
  future-scheduled rows to `scheduled` + re-arms the delayed job. Also fixed
  the same path stamping a not-yet-materialized scheduled row `completed`.
- HIGH: analytics windows frozen at completedAt while Meta buckets
  reads/clicks by EVENT day — the post-completion engagement tail was never
  fetched anywhere (sweeper/report/manual refresh) and expired at ~7d.
  All three now read through `analyticsWindowEnd` (completedAt+7d clamp now).
- MED: runner pacing read the DEFAULT number's throughput (bound account now
  passed); customer-mode runs were fully unpaced under the enabled limiter
  (now static gap pacing); pre-claim fail() left recipients queued → Retry
  409 forever (now fails them, CAS on status so cancel wins); sweeper `take:
  10` (no orderBy) permanently dropped arbitrary templates; only `completed`
  campaigns swept (failed/canceled billed sends now covered);
  `pendingCampaignAssignee` post-filtered ONE row (on_send masked a pending
  on_reply draw — filters moved into the where); optedOutAt missed a STOP
  after an earlier reply; drift sweeper missed held→undelivered (135000
  drops) and never backfilled deliveredAt on straight-to-read rows.
- LOW: materialize plan-failure on retry inserted the remainder unassigned
  (now rethrows); cancel-race repair boot-only vs 7d attempt retention (now
  on the drift-sweeper cadence); cancel-mid-materialize totalCount recount;
  GREATEST high-water mark on sent/delivered; held drillable via the
  `pending` outcome filter; retryable-failures card capped at what Retry
  actually re-queues; per-WABA fault isolation in the capture sweeper;
  on_send draw to a deactivated agent now logged instead of silent.

VERIFIED HELD: never-open-tickets; no audit/workflow on broadcast.*;
parameterFormat single-authority; requiredCarouselCards gate; customer-mode
one-per-person dedupe (+ @@unique backstop); send idempotency across restart
(bc-recipient ledger, fail-closed on ambiguity); §18 on_send assignment via
shared assignConversation; keyset paging + slots/ceilings; tenancy
parent-scoped everywhere (no bare recipient id from request input); crash
matrix coherent; NULL-overwrite rule + null-vs-0 + UTC-day normalization;
monotonic delivery ladder incl. held; 131049/131050 workspace-scoped
opt-outs; failureBucket defaults to suppress; funnel is a partition (no
double counting); attribution repliedAt CAS first-only.

ACCEPTED (documented, not fixed):
- Quote-attribution vs last-touch divergence: with TWO on_reply campaigns
  in-window, a quote-reply to the older one can lose the owner race to the
  newer campaign's draw (both drawn by the admin; plumbing quote context
  into the auto-assign subscriber isn't worth the coupling).
- skipDuplicates drops a dup contact's plan slot ("exactly 50" can be 49 on
  an imperfectly-deduped audience); plan.totals stay the drawn counts.
- Customer-mode cross-channel replies (template on WhatsApp, answer on
  Instagram) lose attribution/assignment — inherent to per-contact threads;
  revisit with person-level identity lift.
- on_send + assignment on a 10k campaign publishes 10k non-silent
  `conversation.assigned` events (deliberate: audit/workflows SHOULD see
  ownership); the audit/workflow-storm invariant governs broadcast.* only.
- Cancel is cooperative (~2s lane latency); rate tokens burn on suppressed
  recipients; template-resume vs still-draining lanes can strand `queued`
  ~60s until the drift sweeper re-fires it (self-healing, CAS-safe).
- /v1 broadcasts is read-only and create has no Idempotency-Key gate — both
  scheduled for the /v1 parity sub-track (#20).

### tickets + SLA + numbering (B-M3 session 7, 2026-07-27) — ✅ CLOSED

FIXED (6be6acc):
- HIGH: reopen never reset the SLA clock — any reopen past the old
  `resolutionDueAt` fired an instant, permanent, unretractable breach on a
  ticket resolved ON TIME (both the update path and the ingest reopen).
  Reopens now start a fresh commitment; genuinely-fired flags stay (history).
- HIGH: `expectedVersion` was a pre-tx JS compare while the CAS guarded
  status only — the documented 409 contract failed for every non-status
  write (concurrent customFields edits erased each other wholesale).
- HIGH: `ticketCloseConversationOnLastSolved` was a dead control (stored,
  UI-settable, /v1-settable, documented — read by nothing). Now implemented
  on the shared solve path, detached and best-effort.
- MED: pointer-only routing misrouted with two tickets on a thread (solved
  pointer-holder → other active ticket unroutable, solved one resurrected)
  — active-scan fallback per docs §2 rule 1, pointer repaired; breach mark
  CAS now repeats the full scan predicate (no phantom breach when an agent
  replies mid-loop); fillActiveTicketAssignee fill-empty-only moved into the
  write CAS (§18); workflow auto-replies no longer stamp firstResponseAt;
  restricted agents can no longer raise tickets outside their visibility;
  the 2 SLA partial indexes joined partial-indexes.spec; escalate-while-
  paused no longer inflates the new commitment; rehomeTickets now bumps
  version + writes TicketEvents.
- LOW: closed→solved cleared of its double-life; deleteTicket counter read
  in-tx; /v1 `?assignee=me` 400s instead of silently matching nothing;
  listTicketEvents bounded (newest 500); priority recompute gated on active
  status; stale comments corrected.

VERIFIED HELD: no auto-open (reply attaches/reopens, never creates;
broadcasts can't reach commitOutboundSend); number allocation race-safe
(row-locked counter + unique backstop + one retry); tenancy on every
ticket/event/field/SLA query; breach fires once per leg; closed never
ingest-reopens, solved does within the window (inclusive gte); /v1 route
parity with admin:settings on config writes; visibility via the canonical
AND-array builder (reads); remove-member covers tickets; ingest redelivery
safe (message dedupe gate + co-committed reopen).

ACCEPTED: multiple active tickets per thread are PERMITTED (two teams, two
issues) — the pointer + scan routes to the newest; terminal tickets accept
subject/customFields edits (harmless corrections); a counter restored from
an old backup could still 500 ticket creation until it catches up (one
withUniqueRetry only).

### realtime layer (B-M3 session 8, 2026-07-27) — ✅ CLOSED

THEME: authorization enforced at JOIN, never revoked. FIXED (36a6a9d):
- HIGH: member removal / role change never severed live sockets (removed
  agent kept the full team firehose — message bodies, contact PII — until
  an organic reconnect). Now revoke = cache bust + disconnect.
- HIGH: conv-room membership had no revocation path — always-authz on
  subscribe (leave on failure; the alreadyJoined skip was the same recovery
  hole subscribe:channel fixed for itself), recovered conv rooms pruned,
  and conversation.assigned now evicts the stale restricted assignee (who
  otherwise kept typing/viewers/status + broadcast message BODIES).
- MED-HIGH: agentConversationVisibility flip now disconnects the
  workspace's sockets (handshake-time state was never re-derived).
- MED: multi-tab workspace switch announces via BroadcastChannel (other
  tabs' HTTP silently re-scoped while sockets stayed on the old ws);
  emitter assignee caches grow-only → periodic sweep; zero-workspace socket
  auth routed to /logout destroying a valid session → gated/reload path.
- LOW: typing STOPs uncharged (stuck pills), SUB_CAP 30→60 (keyboard
  triage silently unsubscribed on-screen threads), visitor-presence chip
  re-seeds on re-subscribe.

VERIFIED HELD: emit-after-commit with seq-guarded presence transitions;
room scoping table (message:status/typing/viewers/broadcast frames → conv
room; user room = user:<ws>:<uid> everywhere); DM/private frames fail
CLOSED; first-join authz + rawPayload stripped; reconnect convergence
(delta backfill + full refetch + monotonic status guard on both ends);
markRead visible+on-thread on every path, unread team-wide, badge via
local conversation:read; assertReducerCoverage partitions the full event
set; multi-tab 0↔1 transition gating; memory bounds on every gateway
structure; deactivation revoke ordering (bust-then-disconnect).

#12 CHARACTERIZED: the ~8 raw-emitted wire events (presence, availability
snapshot, typing ×3, viewers, visitor presence/typing) are each correctly
scoped — recorded as a documented sidecar of fanout-rules rather than
forced into the table.

ACCEPTED / DEFERRED:
- Restricted agents (out of the ws room by design) don't receive benign
  team-wide frames: presence dots, availability badges, member catalog,
  ticket:changed (even own tickets), contacts:bulk_updated, default-channel
  chat activity. Stale-state class, self-heals on reload; restricted
  visibility is off by default. Fix-shape recorded: a second
  `ws:<id>:benign` room joined by everyone, benign rules emit to both.
- #14/#15 (meta.controller / realtime.gateway size extractions): explicitly
  NOT done — §17 forbids rewrites without a concrete defect exposing the
  seam, and this session's fixes landed cleanly inside the current
  structure. Revisit only if a future fix fights the file layout.

### auth / org / workspaces / members (B-M3 session 9, 2026-07-27) — ✅ CLOSED

FIXED (b9649d8):
- HIGH: self-serve password reset never revoked sessions — Better Auth
  gates that on `revokeSessionsOnPasswordReset` (unset), while the code
  comment asserted it happened. The one flow for "someone has my session"
  left the intruder logged in for 90 days.
- MED-HIGH: `POST /api/auth/sign-in/email-otp` was an open account+org
  signup channel (plugin creates the user on an unknown email → our hook
  mints an Organization with orgRole owner), bypassing the register rate
  limit, disposable-domain policy, password requirement and lockout. The
  app has no passwordless flow at all: disableSignUp + edge block.
- MED: `maxMembers` enforced only at invite-accept while the invite flow
  routes admins to the uncapped direct-add path; zero-membership org owner
  locked out in a login→logout loop (no fallback in
  resolveActiveWorkspaceId); org-wide deactivation's last-admin guard
  checked only the acting workspace (remove() already spanned all);
  invite accept had no org-status gate.
- LOW: canDeleteMember let a workspace admin delete an org ADMIN (latent —
  no write path grants orgRole admin yet); /api/register skipped the
  disposable-email policy.

VERIFIED HELD: the four-caller active-workspace rule is genuinely one
definition, DB-verified and org-scoped everywhere; org-authority gating on
org-wide actions (delete = RequireOrgRole owner, no superAdmin bypass);
tenant boundary on every workspace route; one-org-per-user + global email
(org delete cascades orphans, so emails no longer strand); every
concurrency guard holds (workspace-create cap, invite seat cap, last-admin
demotion, lockout increment) — all FOR UPDATE; suspension gates HTTP +
socket + /v1 keys without deleting sessions; Better Auth additionalFields
complete and input:false; deactivation revokes + re-homes + preserves
grants; remove-member covers the full detachment list from both callers;
invite tokens hashed/single-use/expiring/email-bound.

OPEN (documented, needs a product decision):
- orgRole has NO write path: "org admin" is unreachable and there is no
  ownership succession. If the sole owner is deactivated or lost, the
  tenant permanently loses org rename, workspace create/delete AND all
  membership management. Recommend an owner-transfer + org-admin grant
  before real customers land.
- Workspace delete busts caches but doesn't drop members' sockets (no
  frames can target a deleted workspace, so exposure is nil).

### external /v1 API (B-M3 session 10, 2026-07-27) — ✅ CLOSED — **TIER-1 COMPLETE**

FIXED (e3194a0):
- HIGH: `POST /v1/contacts/import` accepted a MISSING Idempotency-Key while
  its own docblock, the service comment and both doc surfaces said REQUIRED
  — a gateway timeout + retry queued a second job over the same staged file
  (assertNoRunningJob only blocks a CONCURRENT one), re-applying every row
  and re-firing every per-row workflow + webhook.
- HIGH: the two BILLED call sends claimed idempotency without
  `refuseStaleOnAmbiguity` — a crash after Meta accepted but before
  `complete()` let the retry re-send once the pending row aged past TTL.
- MED-HIGH: `read:broadcasts` alone exfiltrated every recipient's name +
  raw E.164 phone (recipient list skipped the `read:contacts` PII gate).
- MED: `/v1/conversations/:id/call-button` sent a real CTA that persisted
  NOTHING and published nothing (no Message row, audit, frame, webhook, or
  lastMessageAt bump) — now through the shared interactive sender, extended
  for `voice_call`; that also fixed it (and both permission paths) sending
  from the workspace DEFAULT account instead of the thread's.
- MED: 8 webhook-firing writes had no chain-depth guard (partner echo could
  loop unbounded); `templates/:id/unpause` moved to `admin:settings` (it
  resumes billed campaigns); the template list — the only unpaged route —
  is keyset-paged and `.strict()`.
- MED: API-key creation defaulted to the `"*"` WILDCARD when scopes were
  omitted (a bare `{"name":"x"}` minted full access, bypassing even
  `admin:settings`); rotating an already-REVOKED key resurrected it.
- IMPLEMENTED the two routes both doc surfaces promised but that 404'd:
  `POST /v1/broadcasts/:id/analytics/refresh` (the ONLY way an API-only
  integration pulls Meta's currency cost + unique clicks) and
  `GET /v1/assignment-policies` (resolves `assignedTeamId` for tickets).
- `write:users` is dead post-S2c — the three advertising surfaces corrected.

VERIFIED HELD: all 111 routes carry `@RequireScope`; ScopeGuard fail-closed;
workspaceId sourced ONLY from the key (no P0 tenancy leak — every
parent-scoped exception proves ownership first, incl. the `"__no_user__"`
sentinel that closed the null-actor saved-view bug); the three customer
message sends enforce Idempotency-Key WITH ambiguity protection and correct
release/retain discipline; /v1 writes publish the same domain events as the
UI (same services); every implemented route appears in both doc surfaces;
Zod on every route; keyset pagination everywhere; key tokens hashed, scopes
server-validated, revocation immediate, no self-escalation path, suspended
orgs rejected after the rate-limit consume; layered rate limits with no
cross-key collision; the `X-CCP-Origin-Key` self-loop guard.

OPEN — for the parity build (inventory in the session report):
- `docs/organization-api.md` is DELETED from the working tree (another
  session owns the docs move) and its scope table is stale for all ~20
  routes moved to `admin:settings`, plus it documents 2 routes that only
  now exist. WHOEVER RESTORES docs/ MUST refresh those rows — the in-app
  /docs/api page is already correct.
- Whole domains still UI-only: workflows, customers/identity,
  audience-groups, outbound-webhooks management, snippets, broadcast
  writes. Plus contact/conversation/message op gaps (bulk, start,
  media/location/contact-card/reaction/forward sends, note LIST). Full
  route→scope→events table in the session report.
- 9 admin-grade READS sit under low read scopes (WA profile/QR/status,
  assignment config, ticket settings) — no credentials leak; re-scope
  alongside the parity build.

### /v1 integration-first PARITY BUILD (2026-07-27)

Phase 1 (5f4ccd8e) — 21 routes, the self-serve onboarding blockers:
- **Outbound webhooks** (7): list/create/update/rotate-secret/delete/
  deliveries/test, all `admin:settings` INCLUDING reads (a webhook is a
  standing data-egress grant). Until this, an integration could not receive
  ONE event until a human clicked through Settings.
- **Audience groups** (5) + **snippets** (4): `read/write:catalog`.
- Schema: `OutboundWebhook.createdById` nullable (migration
  20260727150000) — an integration has no human creator. DROP NOT NULL
  only; no column dropped, so the hand-maintained partial indexes are safe.

Phase 2 (5fd9b4b6) — 12 routes:
- **Customers / unified identity** (6): the largest single gap — an API-only
  integration could not see that two contacts were the same person.
  Merge/split are the manual REVERSIBLE kind (re-point `customerId` only);
  auto-merge stays ingest-only and unexposed. `read/write:contacts`.
- **Workflows** (6): list/get/runs/run-detail/publish/trigger. Deliberate
  3-way scope split — reads `read:catalog`, publish `admin:settings`,
  firing a NEW `write:workflows` (a run executes billed sends; that is not
  a catalog write). Trigger requires `Idempotency-Key` + chain-depth guard
  and uses the irreversible claim.

Every route reuses the SAME service the UI calls. Pinned by
`tests/e2e/post-audit-fixes/v1-parity.spec.ts` (13 tests): happy paths, the
secret-shown-once contract, the merge-is-reversible guarantee (unlink must
never delete a contact), and every scope boundary incl. the webhook READ
gate and read:catalog-can't-run-automation.

Phase 3 (84b4a3c1) — 10 routes:
- **Broadcast writes** (6): create / preview-missing / cancel / retry /
  delete / recipient-ids. NEW `write:broadcasts` — the most dangerous scope
  in the API (billed sends to a whole audience, no unsend), so
  `read:broadcasts` deliberately does NOT imply it. Create + retry require
  `Idempotency-Key` and use the irreversible claim.
- **Conversation operations** (4): start (open/reopen by contactId or
  phone — idempotent, which is what keeps one-conversation-per-contact
  true under an integration retry), mark-read, audit timeline, attachments.
- Actor-nullability threaded through create/start/mark-read to the columns
  already nullable for it. Mark-read stamps an `api-key` sentinel instead
  (the event's `readByUserId` is a non-null cross-tab nudge) — same
  convention as the Coexistence phone-app echo. No wire shape changed.

STILL OPEN (phase 4, not started): contact bulk ops + sync-profile +
count/preview, conversation bulk/delete/search, the 2026-07-13 composer
sends (media/location/contact-card/reaction/forward),
template-into-existing-thread, note LIST, and the catalog write gaps
(contact-fields, stages, usage counts, view reorder). Also still open from
the session-10 audit: 9 admin-grade READS under low read scopes, and
`docs/organization-api.md`'s stale scope table (file is deleted in-tree;
whoever restores it must refresh those rows — the in-app page is correct).
Full route→scope→events table in the session-10 report.

### Track A batch E — naming drift (2026-07-27) — ✅ (E3 decision pending)

FOUND A LIVE P0 (e9ffd8d2): the legacy Meta webhook proxy had been BROKEN
for 5 days. The org→workspace rename (f59696a9, 2026-07-22) renamed the
variable inside `app/api/webhooks/meta/[teamId]/route.ts` including the
`ctx.params` destructure, but left the DIRECTORY `[teamId]` — and in the App
Router the params keys come from the directory, so `workspaceId` was
`undefined` and every legacy delivery forwarded to
`/webhooks/meta/undefined`. Typecheck cannot see this: the route's own
RouteContext declares whatever the author typed, so the lie is
self-consistent. Fixed by renaming the directory (URL path unchanged — Caddy
wildcards it).

NEW CHECKER `scripts/check-route-params.mjs` — a dynamic Next handler must
destructure the param names its PATH declares. Negative-tested by
reintroducing the exact bug. In `pnpm run check` + the deploy workflow.
(5th checker: prisma-fields, test-isolation, double-assertions, tenancy
gate, route-params.)

E1/E2 done in the same commit: TeamsModule→RegistrationModule;
emitToTeam→emitToWorkspace + invalidateTeamScope→invalidateWorkspaceScope
(24 sites); `/settings/team`→`/settings/members` with a permanent redirect
(the page shows the workspace member roster, while "team" in this product
means an AssignmentPolicy INSIDE a workspace); the stranded
`Organization.maxWorkspaces` comment describing a member cap that moved to
`Workspace.maxMembers`.

E2 DELIBERATELY LEFT (documented, wire-persisted): the bus event
`team.catalog_changed` (its type string is persisted in OutboundEvent rows —
renaming breaks pending outbox rows) and the socket events
`team:renamed`/`team:catalog:changed`. Blob `teamSlug` prefixes stay
(historical keys).

**E3 — OPEN, NEEDS THE OPERATOR.** The legacy proxy's deletion deadline is
2026-08-03 and step 1 of its checklist is a 7-day zero-hit check against
prod Caddy access logs — which needs VPS access, not a code change. NEW
EVIDENCE: it was broken 07-22→07-27 with nobody reporting missing Meta
deliveries, which is the strongest signal yet that no live subscription
points at the legacy URL. Recorded in the route file. Do not delete without
the log check; do not extend silently (the file's own policy).

### Track A batch F — error-shape normalization (2026-07-27) — ✅ (9c27481a)

295 error keys normalized to snake_case; `detail` keeps the sentence.
Both spellings had coexisted for the SAME condition ("not found" ×26 vs
"not_found" ×18; "conversation not found" vs "conversation_not_found"), so a
client could not know which to branch on — and one already branched on the
prose (`reply-box.tsx` matched `error === "waba id missing"` to render the
WhatsApp-setup nudge; renamed on both sides in the same commit).

Safety order that made this cheap: (1) inventory both sides — exactly ONE web
matcher depended on a prose key; (2) confirm the /v1-DOCUMENTED set is
already all snake_case, so no published contract moved; (3) note that the
/v1-reachable shared services' prose keys became partner-visible only TODAY
via the parity routes, making this the last cheap moment; (4) 269 mechanical
renames + 26 by hand where the key was really a sentence.

NEW CHECKER `scripts/check-error-keys.mjs` (6th), negative-tested, in
`check` + CI. Scoped to HTTP-envelope surfaces ONLY — a Next server action
returns `{ error: "Enter the 6-digit code." }` to the form that RENDERS it,
where the string is display payload, not a key. Blanket-globbing web would
have put "Enter_the_6_digit_code." on screen.

NOT DONE (the plan's F4): routing the ~18 web call sites that discard the
API's `detail` through one helper. Independent of the key rename and worth
its own pass — those sites currently show a bare key where a sentence exists.

## Checkers (6) — each negative-tested, all in `pnpm run check` + CI
1. `check:prisma-fields` — stale select/where/data/orderBy keys (the #1
   outage class; Prisma's XOR unions make them compile clean).
2. `check-test-isolation` — unfiltered bulk writes in tests/.
3. `check-double-assertions` — `as unknown as` ratchet (baseline 124).
4. tenancy gate (inside check:prisma-fields) — a new model without
   workspaceId must be allowlisted.
5. `check-route-params` — a Next dynamic handler must destructure the param
   names its DIRECTORY declares (caught a 5-day live outage).
6. `check-error-keys` — API error keys stay snake_case identifiers.

### B-M4 seam traces (2026-07-27) — 19 findings, 2 HIGH fixed (4e4925ec)

FIXED:
- **HIGH — wrong-account sends after a disconnect.** Conversation AND
  Broadcast `channelConnectionId` are `onDelete: SetNull`, so disconnecting a
  number nulled every thread/campaign bound to it — and a null resolved to
  `isDefault: true`. Replies went out from a number the customer never
  messaged (no 24h window there); a scheduled campaign sent its whole
  audience from the wrong sender. This SILENTLY UNDID the §2 session-2 fix at
  the FK layer, and the service docstring + `removalImpact` both promised the
  opposite. Guard: refuse an unresolved account when >1 active account exists
  on that channel; single-account fallback unchanged; self-healing via
  ingest's re-stamp. NEGATIVE-TESTED.
- **HIGH — two implementations of workspace delete; the UI called the unsafe
  one.** `WorkspacesService.remove` cascaded inside the org-lock transaction
  with no message pre-drain, no R2 blob cleanup, no provider-cache bust —
  a lock storm that also blocked every other org-level write and would hit
  Prisma's 5s tx timeout. Now delegates to `WorkspaceRootService.destroy`.

FIXED IN THE FOLLOW-UP (7d9149e7):
- **The four-run "flaky" ticket test was a real 5s TRANSACTION CEILING.**
  Raising its timeout let it fail honestly: P2028, "the timeout for this
  transaction was 5000 ms". `transactionOptions` was set NOWHERE while the
  pool allowed `statement_timeout: 30_000` — a query could run 30s inside a
  transaction that died at 5. Ticket creation holds one interactive tx across
  a row-locked number allocation, so 8 concurrent creates queue and the ones
  at the back FAIL. Now 15s (under the statement timeout). Also removes the
  timeout half of the workspace-delete finding. The spec built its own bare
  client, so it was testing a config that doesn't exist in prod — aligned.
- HIGH: customer-mode person-dedupe at FIRE time, using the previously-unread
  `BroadcastRecipient.customerId` snapshot as a merge detector (unchanged
  owner short-circuits with no query). New `duplicate_person` code in the
  union + ALL_ list + suppress bucket + report label.
- MED: DM peer resolution — `dmKey` ("u:u" for a real self-DM) now
  distinguishes a self-DM from a departed peer, failing SAFE when absent;
  `createOrGetDm` repairs missing membership so remove→re-add no longer
  destroys a DM permanently.
- MED: contact import/export artifacts snapshotted before the cascade.

STILL OPEN (severity order — all CONFIRMED by code trace):
- MED: `ai-knowledge/`, `ai-voice-draft/`, `tpl-hdr-` blobs orphaned by
  workspace delete (same class as the transfer artifacts just fixed —
  collect their keys in `destroy()`).
- MED: hard-deleting a user re-homes nothing through the domain path — no
  version bump, no TicketEvent, no `conversation.assigned` publish (the
  removal path does all three deliberately).
- MED: closing a conversation does not stop/pause its ticket's SLA →
  permanent false breach on work finished on time. NEEDS A PRODUCT DECISION
  (auto-solve, auto-pause, or documented as independent).
- MED: `shiftDueDates` adds WALL-CLOCK pause time to a deadline computed in
  BUSINESS hours — a Friday-17:00→Monday-09:00 hold credits ~64h of
  commitment never owed.
- MED (PLAUSIBLE): the platform anchor org is deletable via the self-delete
  route (`DELETE /api/workspace` has no `isPlatform` check; the admin route
  does).
- LOW: add/re-role doesn't invalidate the assignment config cache (15s stale
  eligibleRoles); a workflow `assign_to` naming a removed user is never
  cleared and silently no-ops forever; superadmin aggregates stale on the two
  customer-reachable delete paths; in-flight broadcast page still sends after
  its workspace is deleted; deleting an account orphans its MessageTemplate
  rows and can orphan a WhatsappPortfolio; §18 letter violation in the
  merge/split reap (`contact.count` without workspaceId, upstream-scoped);
  coexistence history worker retry-storms on a deleted workspace (the only
  worker of 6 without a clean row-gone drop).

SEAM VERIFIED CLEAN (real coverage, not absence of evidence): member removal
re-homes conversations AND bumps ticket version + writes TicketEvents,
clears all three no-FK policy pointers then invalidates the cache in
lockstep, and needs no Session cleanup because resolution re-validates; the
workspace cascade was MACHINE-CHECKED to reach all 72 models (56 direct, 2
via parent, 14 documented exceptions) including the outbox; org delete frees
globally-unique emails incl. membership-less users; the provider credential
cache is correctly busted on delete/rename-default/setDefault; merge is
genuinely non-destructive and reversible; 5 of 6 workers drop cleanly when
their row is gone.

### TIER-2 — 6 of 10 domains ✅ (2026-07-27)

✅ outbound-webhooks · media/R2 · calls · queues/workers · sweepers ·
(inbox-views was clean on review — its and-not-spread invariant VERIFIED
HELD across all three callers).

◐ contacts · customers/identity · channels/multi-account · coexistence —
each with the HIGH/MED items fixed and only lows left; see the rows above.

OPEN, needs a PRODUCT decision (not a code fix):
- `call.incoming` toasts carry the contact's name + phone to the WHOLE team
  under `agentConversationVisibility: "assigned"`. Live call handling is
  team-wide by design (documented at the entry point in 112ac0c3) — but a
  call nobody can identify is also hard to answer well, so narrowing the
  toast is a judgement call, not a defect to patch.
- `unreadCount` can only get a reconciler if a read watermark is added
  (schema change). §7 now states plainly that it has none and why.

### TIER-2 fixes — running tally (2026-07-27)

37c0a2b9 media download (my regression) · 29deb9c8 webhook retention +
calls post-CAS · a2b6de83 media recovery + mime + parked echo + bulk-tag
storm · 3e137336 customer-profile visibility + coexistence direction +
poison chunk · 73317ffd SSRF fetchUrlBytes + upload-reaper pagination +
drift-sweeper starvation.

DOMAINS NOW ✅: outbound-webhooks, media/R2.

CHECKER LESSON (2nd time this program): `check-error-keys` over-matched an
internal `{ ok: false, error }` Result as if it were the HTTP envelope, and
caught the CONCURRENT session's brand-new file to prove it. Narrowed to
discriminate on `ok:` in the same object literal, then negative-tested again.
A checker that has never been shown a false POSITIVE is as unproven as one
that has never been shown a true negative.

CONCURRENT-SESSION DISCIPLINE that held all afternoon: the maintainer ran a
second session (multi-account channel/onboarding work) in the SAME tree.
Rules that worked — never `git add` a whole file without checking whose
hunks are in it (`meta.ts` needed `git apply --cached`); never stash in a
shared tree; re-run a suspicious suite in isolation before believing a
failure (several were files read mid-write); settle-gate on load before a
full run (one was OOM-killed).

### TIER-2 review (2026-07-27) — 3 clusters, ~40 findings, fixes IN PROGRESS

**A REGRESSION I CAUSED, and the lesson.** The B-M4 `account-unresolved`
guard (4e4925ec) was written for the five SEND paths. I did not audit every
caller of the function I tightened. `downloadInboundMedia` is a READ path
that also passed no account → it now threw → the catch marks every media
event non-retriably failed → **inbound media silently destroyed in every
multi-account workspace**, caption kept, binary never fetched, no error
surfaced. FIXED 37c0a2b9 (the right account was already in scope 60 lines
up). RULE: tightening a shared resolver means auditing EVERY caller, not the
ones the change was written for.

STILL OPEN from that same regression family (all pass no account):
`lib/sweepers/inbound-media.ts:300` (the RECOVERY path for exactly this),
`conversations.service.ts` typing + read receipts, `ingest.ts:3069` social
contact enrichment, ~13 sites in `calls.service.ts`,
`lib/analytics/template-analytics.ts:59`.

OPEN — HIGH:
- `outbound-webhook-delivery-cleanup.ts:86` is a single UNBOUNDED deleteMany
  under a 30s statement_timeout. Every sibling retention sweeper batches.
  Once the backlog exceeds 30s of DELETE throughput it cancels, rolls back,
  deletes NOTHING, and retries every 24h always further behind —
  self-perpetuating unbounded table growth.
- Filter-mode bulk tag fans out up to ~80,000 domain events (one
  `contact.updated` + one `contact.tag_changed` per contact, up to 50k) with
  NO cap → outbox rows + workflow runs + webhook deliveries. The IMPORT path
  caps the identical fan-out at `IMPORT_EVENT_FANOUT_CAP = 5_000`.
- A batched multi-account webhook attributes the WHOLE batch to the first
  account in the payload (`whatsappPayloadAccountId` returns on first match),
  and ingest re-stamps `Conversation.channelConnectionId` — so the thread
  MIGRATES to the wrong number permanently. Same wrong-account class, one
  layer above where the send-side guard can see it.
- Calls: every session-driven path resolves the workspace DEFAULT account,
  and in `answerCall`/`endCall`/`rejectCall` the throw lands AFTER a
  committed CAS and OUTSIDE the try → row stranded `in_progress` for 2h,
  terminal event never published.

OPEN — MED:
- Customer-profile endpoints bypass agent conversation-visibility and leak
  every thread's `lastMessagePreview` + unread + conversationId (the one
  surface that returns the preview without a visibility clause).
- Coexistence history direction detection FAILS OPEN: if
  `display_phone_number` is absent, every business-sent historical message
  becomes `direction: "in"`, which also sets `lastInboundAt` and so OPENS the
  24h window in the UI when it is closed.
- A poison event in a coexistence history chunk loses the remainder of that
  chunk permanently (no per-event try/catch, unlike the live path).
- `fetchUrlBytes` (social attachment download) uses raw `fetch`, not
  `safeFetch` — a workspace admin who sets their own appSecret can sign a
  payload pointing at an internal URL and read the response back via
  `/api/media/:id`.
- `reapAbandonedUploads` never paginates (no cursor) → once
  `contact-imports/` exceeds 200 keys, no other workspace's staged 50MB
  upload is ever reclaimed.
- `Conversation.unreadCount` and `lastMessagePreview` have NO drift sweeper
  despite CLAUDE.md §7 naming them as "each backed by a drift sweeper".
  `openTicketCount` likewise (lower risk — single writer).
- Media sweeper omits `reconcileInboundMediaMime`, so recovered voice notes
  are deterministically destroyed; parked coexistence-echo media
  (`direction: "out"`) is never retried NOR downgraded → permanent shimmer.
- `customer-link-drift` batches 500/60s globally and is not workspace-
  partitioned → a 100k import takes ~3.3h to get unified profiles; also no
  `orderBy`, so a permanently-failing contact starves everything behind it.
- Import: `unknownStages` unbounded (a mismapped column → 200k-element array
  into a JSON column); a resumed import writes an INCOMPLETE error report.

VERIFIED HELD (real coverage — the good news):
- **THE inbox-view invariant**: `inboxViewWhereClauses` traced through ALL
  THREE callers — no spread anywhere, visibility always a sibling AND
  element. The class that bit 3+ times is genuinely closed.
- **SSRF on outbound webhooks**: `safeFetch` resolves via dns.lookup, blocks
  every v4 private range AND normalizes all IPv6 notations, then PINS the
  validated address into a custom lookup — closing the DNS-rebinding TOCTOU.
  A partner cannot reach 169.254.169.254 or localhost.
- **Credentials**: cached as CIPHERTEXT, decrypted per call, never logged,
  never in a response body; cache keyed per (workspace, account);
  `workspaceId` stays in the WHERE even with an explicit account id.
- **Media tenancy**: key-path traversal closed (WHATWG URL normalization
  before the prefix check); every media surface checks a workspace-scoped ROW
  first, and `/api/media/:id` additionally applies the conversation
  visibility clause. Stored-XSS defense (allowlist + magic-byte sniff, SVG
  excluded) intact on every upload.
- **Identity**: `trustEmailAsStrongKey` defaults OFF with exactly one caller
  (the self-asserted contact-share chip); no fuzzy/name matching exists
  anywhere; ephemeral exclusion holds in BOTH directions.
- **Queues**: stable jobId everywhere it matters, the "terminal job makes
  add() a silent no-op" trap handled in all 5 places, lockDuration ≥ max
  handler time boot-asserted, per-team + global concurrency caps, no worker
  enqueues itself.
- **Sweepers**: 22 of 30 mutexed with the 8 exemptions individually
  justified; all 30 unref'd + staggered; all but one stop on a closed pool.
- **Calls**: dedup unique key, terminal-state CAS genuinely idempotent under
  redelivery, permission is a provider READ not a local ledger, SIP never
  enabled, recording correctly unbuilt.

### TIER-3 — 8 of 8 domains ✅ (2026-07-27) — **MATRIX COMPLETE: 28/28 domains**

Two adversarial review agents (team-chat/notes/AI/catalog · admin/guards/registration/keys),
~26 findings. Fixed across `bcf656d8` (team-chat + catalogs), `4f080e1c` (AI),
`98c94160` (admin/registration/keys). Evidence: vitest 549/549, meta e2e 165/165,
`pnpm run check` clean (6 checkers + typecheck + lint, 0 errors).

**Headline defects, by blast radius**

1. **A superAdmin could read any tenant's inbox with one cookie.** The
   beyond-membership escape granted `isSuperAdmin` *any workspace that exists*
   and `resolveSession` then collapsed them to role `"admin"` in it. Setting
   `ccp.ws=<victim-workspace>` returned that tenant's message bodies, contact
   names and phone numbers from every workspace-scoped route — unlogged, with no
   audit row, and directly contradicting the invariant `lib/queries/super-admin.ts`
   states for itself ("visibility ends at aggregate counts + the member roster").
   The only thing in front of it was a client-side redirect to `/platform`.
   Now org-scoped for superAdmin exactly as for an org admin, in all three
   copies of the rule. **If support impersonation is ever wanted it belongs here
   as an explicit, audited mode** — a one-line reversal, deliberately not taken.

2. **Adding an existing org user to a workspace produced a broken member.**
   `setMembership` — the path the invite flow's own conflict message points
   admins at — was the one of three membership-creating paths that never wrote
   the `#general` `TeamChannelMember` row. Empty channel sidebar, zero results
   from workspace-wide chat search, and an infinite `/team` redirect loop the
   moment anyone DM'd them (one DM makes `knownCount > 0`, which defeats
   `ChannelExistenceGuard`'s escape hatch — the exact loop that guard exists to
   end). One `joinDefaultChannel` helper now serves all three paths.

3. **The AI assistant silently dropped messages and escaped draft mode.** The
   debounce removes-and-re-adds a per-conversation job, but `remove()` cannot
   touch a locked (active) job and BullMQ ignores an `add` on an existing jobId —
   so a message arriving mid-generation was discarded and stayed discarded.
   Separately, `escalate` short-circuited ahead of every `autoReplyMode` branch,
   so a workspace whose whole contract is "a human approves every outbound" still
   auto-sent free-form model text whenever the model set a flag the customer's
   own message steers.

**Accepted with reason (not defects)**

- `destroyOrganization` is non-atomic — resumable by construction (the loop is
  query-driven, so an operator retry continues), documented in place.
- Knowledge-extraction's residual single-file event-loop block — serialized
  process-wide so concurrent uploads can't stack; the worker-thread fix has a
  named trigger (a measured stall) rather than being pre-built. Uploader is an
  authenticated workspace admin under a 10MB / 50-doc cap.

**Refuted by reading the code**

- "P2003 is unmapped by `PrismaExceptionFilter`" — it maps to 409
  `relation_violation` alongside P2014.

**Verified held (worth not re-auditing)** — the five `TeamChannel*` TENANCY
EXCEPTION satellites (every query reaches them through a workspaceId-scoped
parent or carries `channel: { workspaceId }`; no bare child id from request
input); the whole guard/pipe/filter layer; notes (zero findings); invite
token/seat-cap/escalation-matrix handling; api-key scope validation and
revocation immediacy.

## Cross-domain seam traces (after both endpoint domains ✅)

| Seam | Status |
|---|---|
| Member removal → assignments, tickets, views, policies, team-chat DMs, awaiting-reply, socket rooms, session pointer | ✅ 2026-07-27 (clean; 2 DM defects found) |
| Workspace delete → every workspaceId model, queued jobs, blobs, caches, sockets | ✅ 2026-07-27 (cascade proven complete; delete path unified 4e4925ec) |
| Channel-connection delete → threads, campaigns, caches, templates, portfolio | ✅ 2026-07-27 (HIGH wrong-account fixed 4e4925ec) |
| Contact merge mid customer-mode broadcast | ✅ 2026-07-27 (double-bill OPEN, see below) |
| Org delete → workspaces, users, globally-unique emails, sessions, keys | ✅ 2026-07-27 (clean; emails freed) |
| Queued job whose target row was deleted | ✅ 2026-07-27 (5 of 6 workers clean) |
| Workspace delete → everything under it (cascade audit) | ☐ |
| Contact merge/split during in-flight customer-mode broadcast | ☐ |
| Channel-connection delete → threads, sends, webhooks, broadcasts | ☐ |
| Org delete → users, workspaces, sessions, globally-unique emails | ☐ |

## Pressure numbers (B-M5 — record with commit hash)

| Check | Last measured | Result |
|---|---|---|
| Burst ingest 500 signed webhooks ×2 (dedup + p50/p95 ingest→fanout) | — | — |
| Broadcast scale 10k mock recipients | — | — |
| CSV import 100k rows under heap cap | — | — |
| Socket frame ceiling per room, 200-inbound burst | — | — |
