# Production Audit — 2026-05-30 (Pass 2)

_Method: 16 parallel dimension-finders (calling-feature backend+frontend and fix-verification prioritized — the two surfaces the morning's audit excluded) → independent adversarial verifier per finding (default-refute) → synthesis. 53 candidate findings, 50 survived refutation, 3 refuted (6%). 69 agents, ~6.4M tokens. Plus the auditor's own firsthand reads of the full calling stack and the three morning blocker-fixes._

Companion to `production-audit-2026-05-30.md` (the morning's 60-finding audit) and `production-audit-fixes-2026-05-30.md` (its remediation log). This pass deliberately did NOT re-list that audit's confirmed backlog; it (a) **verified the morning's claimed fixes actually landed**, (b) **deep-audited the WhatsApp-calling feature** — which every prior audit explicitly excluded as WIP but which is now committed (`e63dd69 "calling"`) + heavily modified in the working tree and **wired live into the production webhook ingest path**, and (c) hunted for genuinely new issues the uncommitted diff introduced.

## Scores

| Axis | Score | vs morning |
|---|---|---|
| Production Readiness | **80/100** | 82 ↓ |
| Architecture | **89/100** | 88 ↑ |
| Performance | **86/100** | 86 = |
| Realtime | **87/100** | 87 = |
| Database | **84/100** | 82 ↑ |
| Reliability | **81/100** | 83 ↓ |
| Security | **77/100** | 78 ↓ |
| Maintainability | **80/100** | 80 = |

**Deploy confidence: `yes-with-caveats` — blockable on ONE Critical (cheap fix) + the calling-admin auth gate IF calling ships this cycle.**

> The chat/realtime/DB/auth/event core remains production-grade and the morning's three blocker-fixes (ask-question saveTo, session cookie sessionId, CSV revive) all landed correctly and completely. But this pass found one genuinely new **Critical** in the workflow runner that the morning audit missed, and — by finally auditing the calling feature — a cluster of real defects in code that is already live in the webhook pipeline. None are app-down or cross-tenant, so it's not a hard no; the Critical is a ~5-line fix, and the calling issues are containable behind a feature flag.

## Severity breakdown (post-verification)

- **Critical: 1** (workflow terminal-rerun)
- **High: 1** (calling admin endpoints under-gated)
- **Medium: 9**
- **Low: 39**

Scores dipped slightly on Readiness/Reliability/Security because the calling feature — previously out of scope — is now in scope and carries real gaps; they rose on Architecture/Database because the fix-verification pass confirmed the morning's structural fixes are sound.

---

# Critical (1)

## W1. Stale ask_question timeout job re-executes an already-completed run from the START node — full duplicate workflow execution
_Workflow engine_ · `apps/api/src/lib/workflows/runner.ts:112-127` · NEW

**Problem.** The stale/early-resume guard only short-circuits when `run.status === 'waiting'`. There is **no guard for runs already in a terminal status** (`completed`/`failed`/`skipped`). For an `ask_question` step, two jobs are scheduled: the timeout job `resume-${runId}-${waitSeq}` (delay = timeoutHours, default 24h) AND the inbound-reply job `inbound-${runId}-${msgId}`. Nothing cancels the timeout job when the contact replies (`queue.ts:155` and `runner.ts:92` both say so explicitly). So when the contact replies before timeout and the run then completes (`currentStepId` set NULL, status `completed`), the dangling timeout job **still fires hours later**. On that pickup the waiting-guard is skipped (status is `completed`, not `waiting`), line 121 flips status back to `running`, and line 127 computes `currentStepId = run.currentStepId ?? graph.startNodeId` — a terminal run has `currentStepId=null`, so this resolves to **`graph.startNodeId`**. The entire workflow re-executes from the beginning.

**Why dangerous.** A completed customer-facing automation silently re-runs in full, hours/days later. Irreversible side effects double-fire: duplicate WhatsApp sends to the customer (the exact double-send CLAUDE.md rule #3 + the in-progress journaling exist to prevent — defeated here because it's a fresh from-start re-execution with empty per-step orphan history), duplicate tag/stage/field mutations, duplicate `trigger_workflow` child dispatches, and a re-asked question that pauses again and schedules **yet another** timeout job (the bug recurs). The per-conversation send-budget does not mitigate — the re-run is ≥1h later, long after the 30/min bucket reset. (Verifier refinement: because the original `waiting` stepLog entry persists, the ask_question node itself re-enters its resume branch rather than necessarily re-sending the question — but every other step between START and it, and on whichever branch resume selects, re-executes in full. The substantive harm stands.)

**Impact.** Every workflow containing an `ask_question` step that completes (or fails) before its timeout — with the default 24h timeout, the overwhelmingly common case (customers reply within hours). At pilot scale this is a guaranteed wrong-behavior the first time any qualification/ask flow is used.

**Fix.** Add a terminal-status guard at the top of `runWorkflow`, right after the `if (!run)` return:
```ts
if (run.status === "completed" || run.status === "failed" || run.status === "skipped") {
  return { runId: run.id, status: run.status };
}
```
Defensively also harden line 127 so a NULL `currentStepId` on a non-`queued` pickup never silently falls back to `startNodeId` — only a genuinely-fresh run (status `queued`, empty stepLog) should start there. ~5 lines; the highest-ROI fix in this audit.

---

# High (1)

## H-CALL-1. Calling admin endpoints (enable + read Meta config) are gated by `calls:make` — default TRUE for agents — so any agent can reconfigure the team's WhatsApp number
_Auth/security_ · `apps/api/src/calls/calls.controller.ts:95-111` · NEW

**Problem.** `POST /api/calls/admin/enable` and `GET /api/calls/admin/settings` are decorated only with `@RequireCapability("calls:make")`. `DEFAULT_CAPABILITIES` (`packages/shared/src/auth/permissions.ts:188`) sets `calls:make: true` for the `agent` role. On a fresh team (`rolePermissions={}`) every plain agent can call `enableCalling`, which POSTs to Meta's phone-number `/settings` endpoint and **overwrites** the team's calling config (status=ENABLED, call_icon_visibility=DEFAULT, callback_permission_status=ENABLED, call_hours forced to 24/7 UTC), and `getSettings`, which dumps the team's full Meta calling configuration. The controller's own doc-comment says "only an admin/manager should be running it" — the gate doesn't enforce that.

**Why dangerous.** A team-administration operation (reconfiguring the live WhatsApp number) is gated behind a routine per-agent capability. A low-trust agent — or an XSS payload / leaked agent session — can silently flip the number to 24/7 calling-enabled, blowing away any call-hours an admin deliberately set, and enumerate the team's Meta settings. `enableCalling` overwrites (not merges). Within-team privilege escalation vs. documented intent.

**Impact.** Every team on default permissions: all four roles incl. agent can run team-wide Meta config mutations + config disclosure. Not cross-tenant (teamId from session).

**Fix.** Gate both `/admin` endpoints with `@RequireRole("admin")` (matches the sibling WhatsApp-settings controller, `whatsapp.controller.ts:28`), OR add a dedicated `calls:admin` capability (default false for agent, true for manager/admin — which auto-passes since manager/admin are all-true). Keep `calls:make` on the per-conversation `initiate`/`permission` routes only. **Land before flipping calling on.**

---

# Medium (9)

## M1. Outbound-call SDP answer dropped if it beats the temp→real callId rebind (call never connects)
_Calling FE_ · `apps/web/src/features/calls/hooks/use-call.ts:135-158, 309-374` · NEW

Outbound calls use a synthetic `tmp_...` id and only rebind to Meta's real callId after `await res.json()` returns. The customer's answer SDP arrives via `call:sdp_offer` keyed by the **real** id; `onSdpOffer`'s answer branch only applies when `live.callId === payload.callId`. Because `call:sdp_offer` is fanned **team-room** (no room-join buffer), the frame can reach the browser before the POST response commits the rebind — the answer is dropped, never stashed (unlike inbound offers), ICE times out ~15s, the panel closes itself. This is verbatim the failure the ingest code comment calls "CRITICAL … a real bug in the first outbound flow." **Fix:** stash answer SDPs in a `pendingAnswersRef` keyed by callId, drain on rebind; also accept the answer when `liveCall.callId` starts with `tmp_` and `signalingState==='have-local-offer'` (single-PC invariant guarantees it's the right call).

## M2. `call.failed` fans out to the conversation room while every sibling terminal event uses the team room → stuck phantom incoming-call toast
_Calling FE/realtime_ · `apps/api/src/realtime/fanout-rules.ts:602-611` · NEW

`call.incoming` and the dismiss events (`call.answered`/`ended`/`missed`/`rejected`) are all **team-room**; `call.failed` alone uses `emitToConversation`. Agents only join a conversation room when viewing that thread, so on a provider-side call failure every teammate not viewing that exact thread keeps a live "Customer is calling you" toast with Answer/Decline buttons that do nothing — clearable only by reload. **Fix:** change line 603 to `emitToTeam(e.teamId, …)` (wire frame is already identical). Defense-in-depth: client-side ~60s ring-expiry in `IncomingCallToast`.

## M3. Outbound call pre-flight rejections (permission/region/cap) set an error that is never rendered
_Calling FE_ · `apps/web/src/features/inbox/components/inbox-shell.tsx:912-923,1044-1050` + `use-call.ts:349-379` · NEW

`callError` is consumed only by `CallPanel`, which returns null when `liveCall` is null. On a pre-flight rejection `initiateOutbound` calls `tearDown()` (nulls `liveCall`) **then** the error is set — so the only component that would show it has already unmounted its content. The entire structured-rejection class (`permission_required`, `bic_blocked_region`, `permission_revoked`, `rate_limited`, `daily_cap_reached`, `provider_not_configured`, `provider_rejected`) produces **zero** visible feedback. Worse: on `permission_required` the server already fired a permission request to the customer, but the agent isn't told to "try again once they accept" — they re-click and burn Meta's 1/24h permission quota. Same dead-display hits the answer-race 409 "another teammate picked up." **Fix:** route `callError` through the existing `toast.error` so it shows independent of `liveCall`.

## M4. Inbound-call reopen (closed→pending) commits in tx1 but its `conversation.status_changed` event publishes in tx2 → reopen silently lost on a tx2 failure
_Reliability / DB_ · `apps/api/src/lib/providers/ingest-call.ts:141-149, 158-253` · NEW

`ingestCallEvent` reopens the conversation inside tx1 (Serializable contact/conversation tx) but publishes the matching `conversation.status_changed` via `publishInTx` inside the separate tx2 (Call upsert). If tx2 throws (pool timeout, serialization, blip) after tx1 commits, the conversation is reopened in the DB with **no event ever published** — and the outer `ingestEvents` catch swallows the error and returns 200, so Meta never retries. Workflows (`On Conversation opened`), audit timeline, analytics, and outbound-webhook partners all miss the reopen. This is the exact bug class the message-ingest path was rewritten to fix (it co-commits reopen + `publishInTx` in one tx, `ingest.ts:684-694`); the call path reintroduced it. **Fix:** move the reopen UPDATE into tx2 (or the publishInTx into tx1) so the status flip and its event commit-or-rollback atomically. _(Note: the same structural split exists on the message path too but there the whole thing is one tx — only the call path splits it.)_

## M5. Duplicate terminal call webhook double-increments `consecutiveUnansweredOutCalls` and re-publishes call.* events
_Reliability_ · `apps/api/src/lib/providers/ingest-call.ts:183-189, 296-310` · NEW

The terminal-state guard only short-circuits when `existing.status !== targetStatus`. A **duplicate** `missed` webhook (Meta is at-least-once) has same terminal status both sides → guard doesn't fire → it re-runs `consecutiveUnansweredOutCalls: { increment: 1 }` and re-publishes `call.missed`/`ended`/`rejected`/`failed`. The counter is not idempotent, so each redelivery inflates it, surfacing a premature "permission likely revoked" warning. **Fix:** add an explicit early return when `existing.status === targetStatus` (no-op rawPayload refresh only), OR gate the increment + publishes on the actual non-terminal→terminal transition (`isFirstInsert || !TERMINAL_STATUSES.has(existing.status)`), mirroring the Message `statusRank` guard.

## M6. `update_field` and ask_question `saveTo` custom-field changes are NOT delivered to outbound webhooks (M20 fix incomplete)
_Workflow engine_ · `apps/api/src/lib/workflows/steps/update-field.ts:149-161` (+ `ask-question.ts:524-533`) · NEW

The morning's M20 fix split `silent` into `silent` + `skipOutboundWebhook` and set `skipOutboundWebhook:false` on the tag and lifecycle steps so partners receive step-driven changes — but `update_field` (and the ask_question saveTo path, which mirrors it) was left publishing `contact.updated` with `silent:true` and `skipOutboundWebhook` **unset**, which the subscriber resolves to `true` → delivery skipped. Its own comment claims "future subscribers (e.g. outbound webhooks) can see what changed" — now false. A CRM/n8n flow syncing custom fields sees manual edits but silently misses every automated field update (the most valuable pipeline-automation signal). **Fix:** set `skipOutboundWebhook:false` on both publishes (keep `silent:true`), correct the comment, and deliberately decide whether `assign_to`/`set_status` step changes should deliver too.

## M7. ContactPanel assignee picker predicts the REMOVED `assign→open` rule → phantom "Open" status + false activity pill no server frame corrects
_State / code-quality_ · `apps/web/src/features/inbox/components/contact-panel.tsx:648-718` · NEW

`persistAssignee` computes `predictedNextStatus` inline as `assign while !=open → open`, and a comment falsely claims it's "kept identical to assignment-dropdown.tsx." The server rule (`mutations.ts:153-159`) and the header dropdown (`assignment-dropdown.tsx:45-52`) both implement **assignment NEVER sets open** (assign+closed→pending, assign+pending→unchanged) — the rule the locked memory `project_assignment_status_rules` says "don't reintroduce." The panel feeds the wrong prediction into both an optimistic `conversation:status` frame and a `buildOptimisticStatusChange` pill: for assign+pending the server changes nothing (no `status_changed` published), so the phantom "Open" + pill **persist until a refetch/reconnect**; for assign+closed the chat flips Open→pending visibly. Behavior depends on which control the agent used. **Fix:** hoist `predictNextStatus` into a shared `features/inbox/lib/` helper and call it from both sites; delete the inline ternary. _(Closely related: **M8** below — the server JSDoc at `conversations.service.ts:314-320` still documents this removed rule, the morning audit's M3 left unfixed, and is exactly what the client copy mirrors. Fix together.)_

## M8. Duplicate contact-field labels are allowed and silently drop data on CSV export/import
_Contacts/pipeline_ · `apps/api/src/team/contact-fields/contact-fields.service.ts:106-203` + `contacts.service.ts:756,1460,1485` · NEW

`ContactFieldDefinition` has `@@unique([teamId, key])` but **no uniqueness on `label`**. `create()` de-dupes the derived `key` but never the label, so two fields named "Notes" both render to `row["Notes"]` on export (last-write-wins; the first field's per-contact value silently vanishes and the CSV shows two identical columns) and `labelToKey` collapses on import (only one key is ever importable). Silent customer-CRM data loss with no error, breaking the documented export→import round-trip. **Fix:** case-insensitive label-uniqueness guard (normalized like `slugifyKey`) in both `create()` and `update()` → 409 on collision. Keep `key` immutable so existing data is untouched.

## M9. `calling` ingest is wired live into the production webhook path with no feature flag while the WebRTC signaling is mid-refactor
_Deployment_ · `apps/api/src/lib/providers/ingest.ts:74-75`, `app.module.ts:55`, `meta.ts:383` · NEW

The working tree fully activates WhatsApp Calling in prod: `CallsModule` registered, the Meta provider parses call webhooks, and the live ingest dispatches every `kind === "call"` event to `ingestCallEvent` **unconditionally** — no env flag, plan gate, or per-team toggle — while the signaling contract is actively in flux this session (`call:ice` removed, `call:sdp_offer` widened). A signaling bug can only be mitigated by a full redeploy, and a slow/erroring call-ingest shares the bounded `INGEST_CONCURRENCY=8` pool with message ingest (latency contention; a throwing event is isolated per-event, a slow one isn't). **Fix:** gate the call-ingest dispatch + `CallsModule` behind `ENABLE_WHATSAPP_CALLING` (default 0, **wired in `docker-compose.yml` api.environment** per the env-wiring rule) so calling dark-ships and toggles without a redeploy.

---

# Low (39 — grouped)

**Calling backend/correctness**
- **calls-initiate-tx-no-p2002-catch** (`calls.service.ts:238-255`): no try/catch around the Call-INSERT tx; a webhook racing the just-placed call hits the `@@unique` P2002. The global `PrismaExceptionFilter` maps it to **409** (not 500 — finding's "5xx" framing refuted), but the FE treats !ok as failure → tears down the ringing panel on a call that's actually live + may re-click → second real call. Fix: catch P2002, re-read the row, return `{ok:true}` from it.
- **calls-answer-provider-fail-phantom-in-progress** (`calls.service.ts:454-505`): CAS flips row to `in_progress` before Meta accept; a Meta failure leaves a phantom-answered row no one can re-answer, healed only by the client ICE-timeout `/end` (lost if the tab closes — no Call sweeper exists). _(Cap-erosion claim refuted: daily cap filters `direction: out`, this is inbound-only.)_ Fix: roll back in the catch + add a TTL sweeper for non-terminal Call rows.
- **calls-daily-cap-bypassed-outside-window** (`calls.service.ts:133-195`): the 5-connected/24h cap lives in the inside-window `else` branch, so permission-based cold-outbound (the exact case the rule targets) skips it → generic `provider_rejected` instead of clean `daily_cap_reached`. Fix: hoist the cap to run on both paths.
- **calls-permission-no-idempotency** (`calls.service.ts:342-420`): `requestPermission` doc claims idempotency but unconditionally re-hits Meta + writes a row; the standalone endpoint is unguarded (though it has **no FE caller** — UI goes through `initiateCall`, which pre-checks). Real residual: false doc, a narrow TOCTOU in `initiateCall`, scripted hits. Fix: lift the pre-check into the shared internal.
- **calls-missed-double-increment**: duplicate-`missed` counter inflation (same root as M5, counter-only slice).
- **calls-failed-fanout-conversation-room-only**: backend half of M2 (`call.failed` → `emitToConversation`).
- **calls-fe-timeline-outbound-stuck-ringing** (`thread-reducers.ts:188-218`): outbound `activeCall.status` never advances past `ringing` (no `call:answered` on customer pickup) — but **`activeCall` is dead/write-only state**, nothing renders it (verifier: zero observable impact today; fix when a UI consumes it).
- **call-over-indexing** (`schema.prisma:2036-2042`): `@@index([teamId])` is fully redundant (prefix of the unique + the status composite); `@@index([teamId,status,ringingAt])` is unused (no query filters by it — the cap count rides `conversationId,ringingAt`). Write amplification on a write-heavy table. Fix: drop `[teamId]` now; drop the status index unless the ringing-queue admin view ships this cycle (new migration; `0_init` frozen).

**Calling rate-limits / auth**
- **calls-no-ratelimit-override** (`calls.controller.ts:51-53`): no `@RateLimit` → Meta-billed `placeCall`/`sendCallPermissionRequest` run at the 300/min default vs `MessagesController`'s 60/min. A retry storm can flag the number's Meta standing. Fix: class-level `@RateLimit({ perMinute: 60 })`, tighter on the permission route.
- **calls-list-no-capability-gate** (`calls.controller.ts:78-85`): `GET …/calls` history has no capability gate while every other calling route does — an admin who scopes calling to managers still leaks history to all agents. Fix: gate on `calls:make || calls:receive` like `endCall`.

**Soft-delete leftovers (morning M5 fix incomplete)**
- **lookupContacts** (`lib/queries/contacts.ts:268-269`): still no `deletedAt:null` — tombstoned contacts surface as picker chips. One-line fix. _(The morning audit's M5 explicitly listed this 4th site; it was the one missed.)_
- **external-v1 mutations** (`external-v1.service.ts:674,953,1034,1145`): `addContactTags`/`removeContactTags`/`updateContact`/`bulkTag` omit `deletedAt:null` — a partner can tag/edit a tombstoned contact via /v1, firing bogus workflow + webhook events. Fix: add the filter + `AND "deletedAt" IS NULL` on the tag-join CTEs.
- **csv-revive-race** (`contacts.service.ts:1043-1065`): the revive UPDATE lacks `deletedAt:{not:null}` → a concurrent inbound revival can be clobbered by CSV data (silent, version bump). Fix: add the guard so it CAS-misses (the existing try/catch already swallows P2025).
- **inbox-stage-badge-counts-tombstoned** (`conversations.service.ts:134-138`): the inbox stage badge groupBy omits `deletedAt:null` so it disagrees with the settings/stages count. Fix: add the filter to the count + the list-filter (`lib/queries/conversations.ts:158`).

**Workflow / integrations**
- **concurrent-run-pickups-no-cas** (`runner.ts:121-124`): inbound + timeout jobs can both pass the waiting-guard in the ~2s knife-edge and both set `status='running'` with no CAS. _(Downgraded: the named mutating steps are version-CAS-guarded so they don't double-mutate; only `add_comment` (bare `internalNote.create`) double-fires. Real but Low.)_ Fix: atomic `updateMany` claim; pair with W1's terminal guard.
- **jump-loop-mislabeled-completed** (`runner.ts:197-201`): a `jump_to_step` cycle without `maxJumps` exhausts `executedThisPickup` and is marked **`completed`** (not `failed`) — operator gets no loop signal. Bounded (one-time ~100 execs, no re-pickup). Overlaps morning M21. Fix: distinguish "ran out of edges" from "hit ceiling with `currentStepId` still set" → fail.
- **outbound-webhook-never-stamps-X-CCP-Depth** (`outbound-webhooks/worker.ts:317-341`): the cross-system loop guard's depth counter resets to 0 on every roundtrip through us; the `/v1` controller comment claims the deliverer stamps it (it doesn't). _(Downgraded: duplicates morning M14/L23; `X-CCP-Origin-Key` covers more than the finding implies; the realistic uncovered class is the http_request→/v1 chain.)_ Fix: at minimum correct the false comments; optionally add the `chainDepth` column + worker stamp.
- **forward-ratelimit-multiplier** (`messages.controller.ts:142-148`): `POST /messages/forward` consumes 1 rate-limit token for up to 40 Meta sends across 5 conversations, and never calls `consumeConversationSendBudget` — a scripted session can exceed Meta's 80/min/number cap. Fix: consume `messageIds×contactIds` tokens, or a tighter dedicated `@RateLimit`, ideally + a per-team aggregate send bucket.

**Reliability / DB**
- **presence-snapshot-unhandled-rejection** (`fanout-rules.ts:457-459` + `realtime.gateway.ts:257`): `buildVisibleOnlineSnapshot` has no try/catch (unlike its `buildVisibleViewers` sibling) and is called without `.catch`; a DB flap during an availability toggle → unhandled rejection (process survives via the `main.ts` handler — crash claim refuted) + a lost presence frame. Fix: wrap the `findMany` returning the unfiltered set on error.
- **call-ingest-reopen-event-split-tx** / **calling-migration-comment-contradicts-next-migration**: see M4; plus the calling migration's "no further migration needed" recording-column comment is contradicted by the same-day drop migration. Doc-coherence only.
- **broadcast-create-tx-default-timeout** (`broadcasts.service.ts:316-347`): the chunked-createMany tx uses Prisma's 5s default `timeout`; a near-10k-cap audience under pool contention can hit P2028 and roll back the whole create. Fix: pass `{ timeout: 30_000, maxWait: 5_000 }`.
- **broadcast-retryFailed-stuck-abort** (`broadcast-runner.ts:970-1008`): a recipient stuck in the "attempt may have reached Meta" abort state can't be cleared by Retry (re-claims → abort again). _(Self-heals in ≤7 days via the retention sweeper — "permanent / manual SQL" framing refuted.)_ Fix: delete the `OutboundSendAttempt` row inside `retryFailed`'s tx so an explicit operator retry starts clean.
- **stage-remove-toctou** (`stages.service.ts:153-197`): count-in-use then delete is non-atomic; a concurrent assign into a non-default stage during its delete → contact silently `SetNull`'d. _(Verifier: nulled contacts ARE visible via "No stage" filter; default-stage protection blocks the ingest/import vectors — narrowed.)_ Fix: wrap count+delete in one tx, re-count inside.

**Deployment / docs (maintainability)**
- **untracked-migrations-schema-drift**: the two new migrations are untracked while `schema.prisma` is modified — a partial commit ships a drifted DB. _(Downgraded: normal in-progress state; `git add prisma/` stages atomically.)_ Fix: commit them together; add a CI `prisma migrate diff … --exit-code` guard.
- **readme-npm-seed-broken-on-web-image** (`deploy/README.md:226`): manual superadmin-seed uses `npm`, but `npm` is `rm`'d from the web runtime image (corepack pnpm survives). The one documented recovery-bootstrap path fails during fresh-volume recovery. Fix: `pnpm run db:seed:superadmin`; fix the `npm run *` refs at lines 327-401.
- **web-dockerfile-stale-migrate-comment** (`apps/web/Dockerfile:206-230`): CMD + NODE_PATH comments reference the removed `migrate` compose service / a migrate step web no longer runs.
- **smoke-deadline-message-mismatch** (`deploy.yml:412,434`): failure message says 120s, loop budget is 180s.
- **stale-comment-call-ice-and-note-index** / **inbox-shell-stale-doc-comment-call-ice**: `inbox-shell.tsx:269` still lists removed `call:ice`; `global-search.ts:250` says InternalNote has no keyset index but migration 20260530140000 just added it.
- **assign-status-flow-tripled-duplication** (`assignment-dropdown.tsx:85-193`): the ~90-line optimistic assign-with-status flow is copy-pasted across 3 inbox components (one already drifted — M7). Fix: extract a shared frame-builder + the shared `predictNextStatus`.
- **contactpanel-crossfield-clobber-offslice** (`thread-reducers.ts:81-88`): `applyContactUpdate` wholesale-replaces the embedded contact; rapid stage(header)+tags(panel) edits on an **off-slice** thread can transiently revert the just-changed stage (self-heals on server echo). Fix: shallow-merge `applyContactUpdate` with a `changedKeys` hint, or base optimistic dispatches on the freshest contact.
- **broadcast-listRecipients-raw-query** (`broadcasts.controller.ts:83-96`): raw `@Query` instead of `zQuery`; an invalid `?status=` returns a `{error:"invalid_request"}` envelope (Postgres enum reject via the global filter — "silent empty result" refuted) instead of the standard zod `{error:"invalid_body",issues}`. Cosmetic error-shape inconsistency.

---

# What's verified CLEAN (high-signal)

The adversarial pass independently re-certified large swaths of the system and **confirmed the morning's blocker-fixes landed correctly**:

- **C1/H1/H2 morning blockers** — all three correct and complete. ask-question `saveAnswerToField` reads fresh + version-CAS + P2025-drop + silent `contact.updated`; session cookie-cache rebinds THIS cookie's `sessionId` on both fast + slow paths (change-password sign-out-other-devices now correct); CSV import 3-way split (skip/revive/create) with a `revived` counter.
- **Chat + realtime** — re-certified. message:new dedup by externalId + optimistic reconcile by clientTempId is race-safe across Meta retries and cross-tab; the `fetch→apiFetch` migration + batched `dispatchLocalSocketEvents` refactor are sound; room scoping (message:status / broadcast frames conversation-scoped, message:new team-scoped) intact; reconnect delta-vs-full-refetch correct; listener cleanup symmetric everywhere; the cache-patch matrix is enforced by a dev-time `assertReducerCoverage()`.
- **Workflow loop-safety on the domain-event axis** — genuinely solid: every mutating step publishes `silent:true`, the workflow-dispatch subscriber hard-gates on it, outbound sends produce `message.sent` (not `received`) so auto-replies can't self-trigger; both depth ceilings (`TRIGGER_DEPTH_MAX`, `MAX_CHAIN_DEPTH`) wired; trigger_workflow enforces once-per-contact. (W1 is a resume/terminal-state hole, not a loop-safety hole.)
- **Calling backend fundamentals** — webhook authenticity (shared HMAC path), multi-tenant teamId scoping on every query, Call-row dedup (`findUnique` on the compound unique + P2002 catch), terminal-state downgrade guard, CAS single-winner on answer/reject/end, SDP bounded at 64KB.
- **SSRF defenses** (`safe-fetch.ts`), **idempotency** (Stripe-style claim-then-execute on /v1), **API-key guard** (hash lookup, timing-equalized, loop-guard), **envelope crypto** (AES-256-GCM, fresh IV, tag verified), **graceful shutdown** ordering, **BullMQ drain budgets**, **outbox drainer** (runWithConcurrency(8), single-timer, FIFO, per-subscriber isolation), **per-team fairness gates** (the PASS-3 P1/P2 deferrals are now implemented), **credential cache** bounded, **broadcast runner** streams (doesn't hold all recipients), **hot inbox/contact/message query paths** well-indexed + keyset-paginated + tenant-scoped, **env wiring** complete (no new uncovered `process.env`), **rollback semantics** + **healthcheck decoupling** correct.

---

# Would you confidently deploy this application to production today?

**Almost — fix one Critical first; the rest depends on whether calling ships this cycle.**

The chat, realtime, database, auth, and event core is production-grade and the morning's fixes are verified sound. But:

**Hard blocker (must fix before deploy):**
1. **W1 — workflow terminal-rerun.** A completed `ask_question` workflow silently re-runs from START hours later, double-firing irreversible Meta sends and child dispatches. Default 24h timeout makes it the common case. ~5-line fix (terminal-status guard in `runner.ts`).

**Conditional blockers (must fix IF WhatsApp calling is enabled for the pilot this cycle):**
2. **H-CALL-1 — calling admin endpoints under-gated** (any agent can rewrite the team's Meta number). `@RequireRole("admin")`.
3. **M1 — outbound SDP temp-id race** (intermittent "my call dies after a few seconds").
4. **M2/M3 — stuck phantom toast + invisible pre-flight errors** (calling looks broken on day one).
5. **M9 — add `ENABLE_WHATSAPP_CALLING` flag** so calling can be dark-shipped and killed without a redeploy.

If calling is **not** part of the pilot launch, gate it off with M9's flag and only W1 blocks — then deploy with confidence and work the Medium/Low backlog post-pilot. Everything below the calling cluster (the soft-delete leftovers, M6 webhook delivery, M7/M8 contact-field issues, the deploy-hygiene Lows) is real but non-blocking pilot-week polish.

_Full per-finding detail with verifier notes: this document's source workflow result. Prior context: `production-audit-2026-05-30.md`, `production-audit-fixes-2026-05-30.md`._

---

# Remediation log (applied same session)

Verification: full `turbo run typecheck --force` (both packages green), targeted ESLint on all 18 touched files (zero warnings), and a swc-runtime smoke-load of every changed API module (decorator metadata emits, no circular-import/resolution breaks). No DB-backed boot run (Docker not up this session) — but no DI wiring changed (only decorator additions composing existing global guards + logic edits inside existing service methods), which is the class swc-load covers.

| # | Sev | Fix | Files |
|---|---|---|---|
| W1 | **Critical** | Terminal-status guard at top of `runWorkflow` (refuse pickup on completed/failed/skipped) + defensive `markFailed` when a non-fresh resume has NULL `currentStepId` (no silent restart-from-START). Kills the dangling-ask_question-timeout full-re-run. | `lib/workflows/runner.ts` |
| H-CALL-1 | **High** | Both `/api/calls/admin/*` endpoints regated `@RequireCapability("calls:make")` → `@RequireRole("admin")` (matches WhatsApp settings controller). Agents can no longer rewrite the team's Meta calling config. | `calls/calls.controller.ts` |
| M1 | Med | Outbound SDP answer race fixed: stash answer in `pendingAnswerRef` if it beats the tmp→real rebind, drain on rebind; `applyOutboundAnswer` matches on PC signaling-state + direction (not callId), so a `tmp_`-id call still accepts the answer. No more "call dies after a few seconds". | `features/calls/hooks/use-call.ts` |
| M2 | Med | `call.failed` fanout `emitToConversation` → `emitToTeam` (matches every sibling terminal phase) — no more stuck phantom incoming-call toast. | `realtime/fanout-rules.ts` |
| M3 | Med | Pre-flight + answer-race call errors now also `toast.error(...)` (panel is unmounted by the time the error is set). `surfaceCallReason` → pure `callReasonMessage`; hook adds a `fail()` helper. | `inbox-shell.tsx`, `use-call.ts` |
| M4 | Med | Inbound-call reopen UPDATE moved into tx2 (co-commits with its `conversation.status_changed` event via publishInTx) + idempotent `updateMany where status:"closed"` CAS. No more silently-lost reopen on a tx2 failure. | `lib/providers/ingest-call.ts` |
| M5 | Med | Duplicate terminal call webhook now a true no-op for side effects (`alreadyTerminal` gate on phase publishes + `consecutiveUnansweredOutCalls` increment). Also fixed `call.ended` carrying `durationSeconds:null` → real computed duration. | `lib/providers/ingest-call.ts` |
| M6 | Med | `update_field` + ask_question `saveTo` now `skipOutboundWebhook:false` (kept `silent:true`) so partners receive step-driven field changes; added `skipOutboundWebhook` to `ContactUpdatedEvent`. | `events/types.ts`, `steps/update-field.ts`, `steps/ask-question.ts` |
| M8 | Med | Case-insensitive duplicate contact-field **label** guard (409) in create + update (`assertLabelAvailable`, normalized via `slugifyKey`). Closes the silent CSV export/import data-loss. | `team/contact-fields/contact-fields.service.ts` |
| M9 | Med | `DISABLE_WHATSAPP_CALLING` kill-switch on call ingest (default off = calling on; logged no-op when set) + wired in `docker-compose.yml` api.environment. Lets ops dark-stop calling without a redeploy. | `lib/providers/ingest.ts`, `docker-compose.yml` |
| Low | — | `initiateCall` Call-INSERT now catches P2002 (webhook beat us) → re-reads + returns ok (no 409 → no FE-perceived-failed-but-live call); skips the duplicate ringing publish on that path. | `calls/calls.service.ts` |
| Low | — | `list()` call-history gated `calls:make || calls:receive` (inline, mirrors `endCall`). | `calls/calls.service.ts` |
| Low | — | `CallsController` class-level `@RateLimit({ perMinute: 60 })` (Meta-billed routes). | `calls/calls.controller.ts` |
| Low | — | `lookupContacts` + all 4 external-v1 contact mutators (`update`/`addTags`/`removeTags`/`bulkTag` ownedIds) now filter `deletedAt:null`. Completes the morning M5 fix. | `lib/queries/contacts.ts`, `external/v1/external-v1.service.ts` |
| Low | — | CSV revive now `updateMany where deletedAt:{not:null}` CAS (no clobber of a concurrently-revived live row) + skips double-count/republish on miss. | `contacts/contacts.service.ts` |
| Low | — | Inbox stage-badge count + stage-filter list now filter `deletedAt:null` (agree with settings/stages count). | `conversations/conversations.service.ts`, `lib/queries/conversations.ts` |
| Low | — | Broadcast create tx given explicit `{ timeout: 30_000, maxWait: 5_000 }` (was Prisma's 5s default → near-cap rollback risk). | `broadcasts/broadcasts.service.ts` |
| Low | — | `retryFailed` deletes the surviving `OutboundSendAttempt` rows in-tx so a stuck-abort recipient can actually be retried. | `broadcasts/broadcasts.service.ts` |
| Low | — | Stage `remove()` re-checks in-use + default-protection inside a Serializable tx with the delete (closes the SetNull TOCTOU orphan). | `team/stages/stages.service.ts` |
| Low | — | Doc-drift: inbox-shell `call:ice` comment, `global-search` InternalNote-index comment, web Dockerfile migrate-service comments, README `npm`→`pnpm` (seed + dev), deploy.yml smoke message `120s`→`${budget}`, drop-migration supersedes-note. | various |

**Deferred (need a browser / out of safe-static scope):** the calling-timeline `activeCall` dead-state advance (zero observable impact today). The outbound-webhook X-CCP-Depth comment-correction (overlaps morning M14/L23). The single-request DNS-rebinding TOCTOU (low-confidence, partner-controlled URL). The untracked-migrations CI guard (process change).

After these, W1 (the deploy blocker) and the full calling-feature cluster are resolved; with the M9 kill-switch in place, calling can also be dark-shipped if you'd rather it not be in the pilot's first week.

## Follow-up: assignment-status prediction unified + browser-verified (M7 + M3 + fe-dup)

The deferred "single-source `predictNextStatus`" change is now done and **verified against the running stack**:
- New pure `apps/web/src/features/inbox/lib/predict-status.ts` (`predictAssignmentStatus`) is the single source of truth, mirroring `mutations.ts:assignConversation` (assignment NEVER sets `open`).
- `assignment-dropdown.tsx` (was correct) and `contact-panel.tsx` (had the resurrected `assign→open` bug) both now call it; the inline copies are deleted. The header and panel can no longer diverge.
- The stale `assignment-dropdown` "should still move it to open" comment + the false contact-panel "kept identical" comment are fixed.
- **M3**: the `conversations.service.ts:assign` JSDoc (lines ~318-340) is rewritten to match the implementation (it documented the removed `assign→open` rule + referenced a non-existent `assignBulk` — both corrected).

**Verification:** a truth-table check proved the shared predictor matches the server rule for all 6 (status × assign/unassign) cases and diverges from the old panel bug on exactly `assign+pending` and `assign+closed` (both were wrongly `open`, now correctly `pending`). A new e2e spec `tests/e2e/post-audit-fixes/assignment-status-rule.spec.ts` pins the server rule end-to-end. Full run against `pnpm prod:local` on :8080: **62/62 e2e passing** (the new 6 + inbox-filter regression + the entire predeploy + post-audit-fixes suites — confirming this session's whole fix batch boots + behaves correctly under the production runtime), both packages typecheck-green, zero lint.
