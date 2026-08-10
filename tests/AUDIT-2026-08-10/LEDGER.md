# Production-Grade Audit — 2026-08-10 — Findings Ledger

Baseline: `7c1935a7` (production, pushed, CI green). Scope: the system's own behavior
(external/Meta wire conformance is round two). Method + section list: see the approved
plan. Every finding here is verified against code or infrastructure before being
recorded; refuted candidates are kept so they are not re-chased.

Severity: **P0** = would burn a live client (data loss / cross-tenant / broken core flow) ·
**P1** = real defect or missing production control, not immediately client-visible ·
**P2** = cosmetic / hygiene, logged for later.

## Phase 0 — Green baseline

| Check | Result |
|---|---|
| `pnpm check` (3 typechecks, lint, 12 checkers) | ✅ pass (0 errors, 31 pre-existing lint warnings) |
| API unit suite (1520 tests) | ✅ green. Local full-suite runs show phantom timeout failures under box contention (every failure re-passes in isolation, different set each run); CI at baseline runs the same suite green on a clean runner. Known box limitation, same class as the e2e OOM memory. |
| Web unit suite (49 tests) | ✅ 49/49 |
| Prisma: migration history vs schema (shadow-DB diff) | ✅ equivalent, except **P0-drift-1** below |
| Dev DB vs schema | ⚠️ dev-only cruft (`AiMessageMetadata.interactionId`, `Invite.organizationId` exist in dev DB only — `db push` leftovers; prod built from migrations does not have them). No action. |
| `operator-access.spec.ts` e2e (never run before) | ✅ **13/13 passed** — all stealth assertions + org-approval gate. (First run failed only because the default playwright baseURL is :8080 prod-local; this box runs dev on :3000 → `E2E_BASE_URL=http://localhost:3000`.) |
| Full batched e2e | 🔄 running in background |

### Findings

**A3-drift-1 (P2, fix in A3): Broadcast index name mismatch.** Migrations create
`Broadcast_campaign_rollup_idx`; `schema.prisma` declares the same columns under the
default name `Broadcast_workspaceId_campaignName_createdAt_idx`. Same index either way;
risk is a future `migrate dev` spontaneously generating a rename migration. Fix: add
`map: "Broadcast_campaign_rollup_idx"` to the `@@index` in schema.prisma.

## A3 (early) — Backups

**Verified on the VPS (central.loadless.site):**
- Nightly `pg-backup.sh` cron installed and firing daily at 03:17 — dumps present for
  Aug 8/9/10, plus per-deploy `pre-deploy-*` dumps. VPS healthy (12% disk, 6.5Gi free).
- **Restore drill exercised for the first time**: latest nightly dump restored into a
  scratch DB on the VPS — 0 errors, row counts sane, index set identical to live
  (the 3 extra live indexes are `OperatorAccess`, whose migration deployed at 14:56,
  after the 03:17 dump — expected). Drill DB dropped after.
- Today's deploy applied the `20260810180000_operator_access` migration cleanly in prod.

**A3-1 (P1): No offsite backup copy and no dead-man's switch.** Zero `BACKUP_*` keys in
`/opt/ccp/.env`: dumps live only on the same disk as the postgres volume, and a silently
failing nightly would page nobody. The script already supports both — needs an rclone/S3
target (e.g. a Cloudflare R2 `ccp-backups` bucket) + a healthchecks.io ping URL. **Needs
credentials only the maintainer can provide — surfaced at Phase A exit.**

## A1 — Tenancy isolation & operator mode

Read directly (clean): `active-workspace.ts` (shared rule + operator branch),
`session.guard.ts` (snapshot cache keyed (userId, workspaceId); cookie-hash cache
unpoisonable — snapshots only written post-validation), `socket-auth.service.ts`
(mirrors guard incl. gated-vs-unauthenticated split), gateway stealth gates
(presence/viewers/typing suppressed by non-registration), `conversations.controller.ts`
(markRead + HTTP typing operator gates), `admin-operator-access.controller.ts`
(log-before-access ordering, platform-anchor 404), `active-workspace-cookie.ts`
(single cookie writer, both doors).

**Accepted-by-design (ledger note, not defects):**
- Within-org sibling-workspace switches by an operator write no second `OperatorAccess`
  row — org-keyed log records the tenant crossing; documented in `setActive`.
- The log is not a gate (hand-set `ccp.ws` bypasses) — single-operator tradeoff,
  documented in three places with the multi-operator upgrade path named.
- Settings → Organization in operator mode shows the operator's own org (reads and
  writes deliberately scoped together; documented in `workspaces.service.ts`).

**A2-note-1 (check in A2):** an org admin acting beyond membership gets
`rolePermissions: {}` for that workspace (no membership row to read overrides from) —
verify admin-role gates don't consult overrides in a way that behaves differently there.

**Adversarial sweeps (4 agents over the whole API surface): NO P0/P1 tenancy findings.**
Swept and clean: every controller/service/lib Prisma call traced (workspaceId provenance
always session/apiKey), ticket surfaces uniformly on `ticketAccessWhere`, the 7
parent-scoped children, raw SQL, media streaming, calls, webchat handshake, admin routes,
invites, users, workspaces, settings, auth. Notable evidence preserved in the sweep
reports (session transcripts).

### A1 findings → FIXED in `audit(a1)` commit

**A1-1 (P1, FIXED): operator's real name leaked past the "Support" mask on four
server-side surfaces** — conversation activity pills, ticket events/thread(+avatar)/
attachments/`resolvedByName`, the APPEND-ONLY `Notification` rows, and the team report
(counted the operator as "Former member" workforce). Root cause: §18's mask lived only in
the web's member-map fallback; server-side name joins resolve the operator's row
normally. Fix: one predicate `lib/workspaces/operator-mask.ts` (same semantics as
`isOperatorAccess`), applied at DTO-mapping / notification-write time; report drops
non-roster superAdmin rows only. Pinned by `apps/api/test/operator-name-mask.spec.ts`.
**A1-2 (P2, FIXED):** call-CAS `updateMany` wheres (answer/reject/end/rollback) now carry
`workspaceId` (defense-in-depth; gates already protected them).
**A1-3 (P2, FIXED):** internal bulk tag-remove raw DELETE now carries the SEC-4
IN-subquery backstops like its `/v1` twin.
**A1-4 (P2, DOCUMENTED):** workflow ticket steps' `{id, workspaceId}` scope is the one
sanctioned `ticketAccessWhere` deviation — owner-only, fails closed; docblock added so a
"consistency cleanup" can't silently widen automation into shared tickets.
**Accepted (not defects):** operator can deliberately post in team chat under their real
name (actions are ordinary writes; masking a live chat author invites replies to a ghost).
`assertMessageVisible(viewer: undefined) → true` default noted for B-phase hardening.

## A2 — Authentication & authorization

Sweep: **no P0/P1**. All 78 controllers guarded (SessionGuard / ApiKeyGuard+ScopeGuard /
documented-public-with-throttle / internal-secret+Caddy-refused / triple-gated dev
module); org-authority actions verified end-to-end (deactivate/reset/delete/org ops all
on `canModifyUserAccount`/org role with FOR UPDATE last-admin guards); complete
`invalidateSessionCache` discipline table (every snapshot-affecting mutation invalidates
or revokes); API keys (192-bit, SHA-256, per-key + negative-path buckets, revocation
immediate); Better Auth config (cookie flags, additionalFields both declared, OTP
signup closed at TWO layers, `revokeSessionsOnPasswordReset`); invite flow (256-bit
hashed token, single-use in-tx, org derived from locked workspace row, seat cap FOR
UPDATE); rate limits on every unauthenticated surface.

**A2-1 (P2, FIXED in `audit(a2)`):** `DELETE /api/workspace` (org delete) lacked the
`isPlatform` belt every admin-organizations surface has — reachable by the operator from
operator mode (their session's organizationId stays the platform anchor), cascading the
platform org + their own user + the console. Now refused (`platform_org_not_deletable`).
**A2-2 (P2, ledger only):** the OTP-signup closure depends on BOTH `disableSignUp` and
the web proxy's 404 of `sign-in/email-otp`; if the proxy matcher is ever narrowed that
becomes a lockout bypass. Tripwire test → Phase B.

## A3 — Data integrity (continued)

- All **35 sweepers** verified wired to a scheduler (none orphaned).
- Blob-orphan cross-check verified complete: 6 cross-checked columns + every URL-only
  category prefix-excluded (`avatars/`, `ai-knowledge/`, `ai-voice-draft/`,
  `contact-exports/`, `contact-imports/`, `/tpl-hdr-` marker); all upload sites mint keys
  inside this taxonomy. Candidates (`ContactTransferJob.*Key`, `AiContextDocument.r2Key`,
  `AiReplySuggestion.audioR2Key`) **refuted** — each documented-excluded or
  self-lifecycled.
- **A3-2 (P2, FIXED in `audit(a3)`):** schema `@@index` for the campaign rollup now
  `map:`-pinned to the raw partial index's name — a future `migrate dev` would have
  "fixed" the perceived rename and silently dropped the `WHERE`. Migration history ↔
  schema now diffs clean (shadow-DB verified: "No difference detected").

## A4 — Realtime

Sweep: **all seven invariants hold** (emit-after-commit; room scoping rule-by-rule incl.
storm vectors; restricted-visibility joins/evictions/revocation order; reducer coverage
63-event diff; read-state convergence incl. list resync on reconnect; monotonic status
guard both sides; reference-stability + coalescing on the hot paths). Fixed in
`audit(a4)`: dead `user:profile:updated` contract entry removed; `message:reaction` /
`message:updated` scope docblocks corrected to match the fanout table; orphaned
`message.flag_changed` comment re-attached. **F4 (accepted):** one-frame reordering
window on restricted cold-cache slow path — reducers are order-tolerant by design.

## A5 — Message lifecycle (lead's direct read of the billed path)

`send-idempotency.ts` (in-process lock: transient-vs-deterministic rejection caching,
502 deliberately NOT evicted on the no-ledger paths), send-worker per-team fairness
(defer-generation backoff), and the `OutboundSendAttempt` ledger read end-to-end:
create-first; P2002 branch (a) completed → **full commit-pipeline replay** (not a
client-only re-emit); branch (b) incomplete → refuse (`send_in_progress_or_lost`);
failure classification `isProvablyNotSent` decides delete-row (safe retry) vs
retain+`failedAt` (refuse — ambiguous 5xx/transport where a retry would double-send);
completed-stamp committed in its OWN write BEFORE the Message insert. **Clean.**

Agent sweep (ingest fail-soft, bus tiers, outbox, media, queues, status monotonicity,
PrismaExceptionFilter): **clean except two P2s, both FIXED in `audit(a5)`**:
**A5-1 (P2, FIXED):** `inbound-media` sweeper stored the UNreconciled CDN mime — a
recovered voice note rendered audio live / video after refetch, `.mp4` download ext.
**A5-2 (P2, FIXED):** app-level webhook returned 200 on a partially rate-limited
co-batched body, dropping the throttled tenant's inbound permanently; now 429 when ANY
group throttled (redelivery dedupes to no-ops — lossless both directions).
**A5-3 (P3, ACCEPTED):** `message.status_changed` publishes on the best-effort sync path
rather than `publishInTx`, so a crash in the tiny window between the CAS status write and
the background tier can lose one partner status webhook. Moving it into the outbox would
add an outbox row per status tick (3 per message — the hottest write path) to close a
crash window measured in milliseconds; accepted as the bus's documented best-effort
posture. Revisit only if a partner contractually needs guaranteed status delivery.
Also verified: complete queue inventory (8 queues, all bounded attempts + retention +
stable jobIds), graceful shutdown chain, outbox poison-row policy (5-attempt terminal
fail + wedge watchdog), local-driver prod refusal.

## A6 — Ops & production readiness (VPS verified)

- Containers healthy, 0 restarts since deploy; `stop_grace_period` 100s (api);
  heap flags exactly per invariant (2048/3G, 1536/2G); `RUN_WORKER_INLINE=1`;
  `NODE_ENV=production`; no `BLOB_STORAGE_DRIVER` override.
- Host Caddy active, rendered from the committed template per deploy; external
  `/api/health` 200 (web); api health probed internally by Caddy (`health_uri`).
- Zero real errors in 6h of api logs.
- **A6-1 (P1, needs maintainer credentials):** no external uptime monitoring — nothing
  pages if the site goes down. Pair with A3-1 (no offsite backup + no dead-man's switch).
  Both are one free account away (healthchecks.io / UptimeRobot; R2 bucket + rclone for
  offsite). Surfaced at Phase A exit.

---

# Phase B (started 2026-08-10, after Phase A deployed green at 43dc309e)

## B8 — Workflow engine

Sweep (all 23 step handlers, runner, dispatcher, queue, sweepers): **no P0/P1**. Every
loop guard verified real (step ceiling, publish cap + cycle detection, jump caps,
trigger_workflow depth 8 with manual-only targets, X-CCP-Depth fail-closed, seq-keyed
resumes, triple-guarded ask_question races); snapshot immutability holds (deliberate
live reads each documented); per-step progress persistence prevents crash-retry double
sends; `triggerOncePerContact` release-vs-burn semantics deliberate.

**B8-1 (P2, FIXED in `audit(b8)`):** three doc claims said the OPPOSITE of the code
(queue docblock + README state table claimed live per-step config reads; README listed a
nonexistent dispatcher service file). **B8-2 (P2, FIXED):** `resolveStepTarget`'s
event-less auto-creates now documented as deliberate re-trigger-surface avoidance.
**Accepted:** legacy null-`graphSnapshot` fallback (self-draining, 90-day wait horizon);
`occurredAt` regenerated per pickup (cosmetic — X-CCP-Delivery is the dedupe key);
workflow sends bypass OutboundSendAttempt (README-documented residual at-least-once).

## B7 — Tickets & escalation (commit `audit(b7)`)

**B7-1 (P1, FIXED):** create/update passed a bare actor → `actorWorkspaceId = NULL` on the
highest-traffic events; a guest department's status/priority/assign writes rendered
unattributed on shared tickets. **B7-2 (P2, FIXED):** write-once cause was JS-pre-check
only; emptiness now pinned in both fill CASes (update + escalate) — concurrent fills
conflict instead of silently rewriting the founding context. **B7-3 (P2, FIXED):** six
TicketEvent writers stamped `lastActivityAt` ms-skewed from (or never with) their events;
all now align to the event's own createdAt, so the drift sweeper's corrected-count stops
being permanent noise. **B7-4 (P2, FIXED):** four stale twin-pair-era comments.
**B7-5 (P3, FIXED):** guest `assignedTeamId` refused (`teams_owner_only`) instead of
silently dropped; UI hides the control on the guest side.
Clean: numbering race-safety, state machine + SLA stamps, no auto-open/reopen anywhere,
share idempotency + revocation atomicity, counters, thread separation, /v1 parity.

## B9 — Broadcasts & audiences (commit `audit(b9)`)

**B9-1 (P1, FIXED):** `clickedAt` rode the first-reply CAS — day-2 button taps after a
day-1 reply were never counted; own first-click CAS now (mirrors the optedOutAt fix).
**B9-2 (P1, FIXED):** boot cancel-race recovery seeded no `deliveryState` — billed sends
invisible in the funnel forever. **B9-3 (P1, FIXED):** composer group-mode count dropped
the group's stored `fieldFilters` (~6× wrong confirm number). **B9-4/5 (P2, FIXED):**
recipient paging id-ordered in both modes (status mutates mid-send — keyset skipped/
repeated rows); audience-count accepts broadcastable channels only. **B9-6 (P2, FIXED):**
stale boot comment + CLAUDE.md's removed `targetMode:'customer'` claim corrected.
**Accepted:** canceled recipients read funnel-"pending" (deliberate canceled≠failed);
drift-sweeper backfills deliveredAt/readAt at send-time bucket; sweeper-recovered
`undelivered` rows lack normalized errorCode (raw SQL can't classify — report gap only).
**Test debt:** no e2e pins create-time opt-out suppression counts.
Clean: full status machine CAS (no zombie-send path), recipient exactly-once ledger,
crash/schedule/materialize recovery, budget-pause behavior, audience suppression scope,
ticket-bypass boundaries exactly as designed.

## B10 — Contacts, identity & customers (commit `audit(b10)`)

**B10-1 (P1, FIXED):** workflow phone targets weren't channel-scoped — a stranger typing
a customer's number into the public pre-chat box could capture the automation into their
unverified widget thread; both lookups now pin `identityChannel: "whatsapp"` (the import
runner's documented "borrowed phone" hazard, same fix). **B10-2 (P1, FIXED):** every
Customer reap orphaned `AiCustomerMemory` rows — a routine merge silently erased
"permanent" person-level memory; one dedup-aware helper (`lib/ai/customer-memory-adopt`)
now carries memories to the absorbing person (or purges with the person) at all 6 reap
sites. **B10-3 (P2, FIXED):** version-CAS discipline extended to contact-share (×2),
prechat (full CAS — racing agent PATCH no longer clobbered), ingest revive, and
removeOption's raw UPDATEs (ghost-option resurrection race). **B10-4 (P2, FIXED):**
prechat labels slugifying to reserved keys dropped instead of shadowing built-ins.
**B10-5 (P2, FIXED):** transfer retry contract was dead code (`failed` written on every
attempt made the row unclaimable); terminal-only now, transient failures resume from the
cursor. **B10-6 (P2, FIXED):** widget-view exports count/select through the same
directory gate hydrate applies.
Clean: strong-key discipline all 8 callers, merge/split reversibility (+ the audit-record
gap from §6 turns out BUILT — `CustomerIdentityEvent`), promotion predicate on every
directory surface, soft-delete + revive paths, import/export normalization + injection
escaping, select-field validation on every write path, lastInboundAt writers complete.

## B13 — Calls, system-side (light pass, by design)

Audited in depth 2026-08-10 (crosstalk fall-through, answered-frame race, recovery
sweeper, transcriptPending — see the call-transcription memory) and re-verified this
audit: call CAS writes hardened with workspaceId (A1 commit), tenancy sweep clean
(`{id, workspaceId}` gate + `conversationRelationWhere` on recording/transcript
streams), artifacts in the blob-orphan cross-check, `lastInboundAt` written at
ringing/answer with the drift sweeper recompute matched, CSW window specs green in
Phase 0 quiet runs (call-csw-window, call-inapp-recovery, call-transcript-pipeline,
call-artifacts, inapp-recording — 24+ tests). No new findings.

## B16 — Event bus / queues / sweepers inventory

Assembled across A3+A5 sweeps rather than as a separate pass: all **35 sweepers**
wired to schedulers (A3); all **8 BullMQ queues** bounded (attempts, backoff,
retention, stable jobIds — table in the A5 section); bus tier registrations verified
at their real priorities with no audit/analytics/workflow subscriber on `broadcast.*`
(A5); outbox poison-row + wedge-watchdog policy (A5); FANOUT_RULES is a compile-total
map (A4). Diff vs CLAUDE.md claims produced two doc fixes (a4: events contract; b9:
targetMode) — everything else matches.

## B11 — Team chat & DMs (commit `audit(b11)`)

**B11-1 (P2, FIXED):** the DM "peer left → read-only" rule fired only for deactivation;
REMOVAL deletes the member row, so the guard's peer lookup returned null and passed — a
direct POST kept writing into a readerless room whose backlog surfaced on re-invite. The
dmKey (mapDmPeer's own removed-vs-self rule) closes the branch (`dm_peer_removed`).
**B11-2 (P2, FIXED):** clientTempId capped at 128 (uncapped → btree ceiling → 500).
**B11-3 (P3, FIXED):** `X-Content-Type-Options: nosniff` on blob streams.
Clean: DM dedup race, exactly-two membership locks, per-request membership gates on all
17 handlers, all 5 satellite tables parent-scoped, clientTempId never ownership, §10
unread discipline + reconnect convergence, mention audience closed, media gates shared
with inbox.

## B12 — Notifications (commit `audit(b12)`)

**B12-1 (P2/MEDIUM, FIXED):** the schema promised a retention sweep that never existed —
rows were append-only forever. Built `notification-retention` (daily, read >30d /
unread >120d, tunable, mutex-registered). **B12-2 (P2, FIXED):** /v1 no-op re-assign
wrote a fresh "assigned to you" bell row + spurious `assigned` audit event per sync;
both now require an actual change. **B12-3 (P2, FIXED):** share revoke deletes the guest
workspace's bell rows (mark-read left a list of links that 404). **B12-4 (P3, FIXED):**
toast/list persona unified ("Automation").
**Accepted:** reassignment doesn't notify the raiser (documented — `ticket_assigned` is
the specific signal); `markThreadRead` clears across workspaces by design.
**Product decisions to consider later:** SLA breach and share-revoke notify nobody;
webhook auto-disable has no durable notification (socket toast only).
Clean: single write site, audience arms + dedupe, read-state scope, cascade, fanout
per-user only, all 5 kinds rendered.

## B14 — /v1 API + outbound webhooks (commit `audit(b14)`)

**B14-1 (P1/MEDIUM, FIXED):** /v1 contact create/revive published a NON-silent
`contact.updated` with every field/tag as a change — "On Contact Tag updated" workflows
(billed sends possible) and update-webhooks fired for creations the identical UI create
never fired. Now silent; trigger surface = `contact.created`, matching internal.
**B14-2 (P2, FIXED):** broadcast Idempotency-Key fingerprinted only {templateId,
audience} — corrected-variables re-POSTs silently replayed the OLD response on the most
irreversible route; whole input fingerprinted now. **B14-3 (P2, DOCUMENTED):**
shared-ticket webhooks deliver to the ACTING workspace only — deliberate until
per-workspace payload views are built (design sketched in public-events.ts; the naive
fix leaks the owner's contact into a guest's partner system). **B14-4 (P2, FIXED):**
stale retry-ladder (4→7 attempts) and /v1-echo-default comments corrected.
**Ledger-only:** contact create/delete take no Idempotency-Key (upsert is the idempotent
path; retry worst case is a clean 409).
Clean: parity delegation across all six write families, idempotency claim/replay/
conflict semantics (ambiguity-refusal + 24h verdict retention), delivery signing
(t=…,v1=…), SSRF posture incl. redirect refusal, breaker mechanics, event selection +
enrichment tenancy, error semantics, pagination bounds.

## B15 — Web app-wide sweep (commit `audit(b15)`)

**B15-1 (P2, FIXED):** account menu offered `/organization` in operator mode — the
wrong-org-edit invitation the switcher's unlinked name prevents; hidden now.
**B15-2 (P2, FIXED):** restricted viewers reaching /broadcasts by URL hit the error
boundary via a guaranteed 403; the three pages redirect like /workflows.
**B15-3 (P3, FIXED):** settings "Team activity" card linked the redirect stub.
**Ledger-only (cosmetic/deferred):** mobile chrome shows no operator banner and no
switcher (desktop-only rail — real gap if the operator works from a phone);
`loading.tsx` sparse outside the main sections (error coverage is total); /templates
reachable-but-unlinked for restricted viewers.
Clean: all 69 routes reachable, no dead nav, role gating server-redirected on every
sensitive page, RSC fetching uniform, zero TODOs in web src.

## B17 — Completeness & final adversarial pass (commit `audit(b17)`)

**B17-1 (HIGH, FIXED):** `customer-memory-adopt.ts` (written earlier IN THIS AUDIT)
carried a raw NUL byte — git saw the file as binary, every grep-based sweep skipped it,
and `check-binary-sources` was red, which would have FAILED the next deploy. ` `
escape now; checker green. Lesson recorded in memory: run the checker suite after
writing new files, and never put control bytes in source.
**B17-2 (P2, FIXED):** shared inbox views had no realtime propagation (the one catalog
without it) — now publish `team.catalog_changed {scope:"inbox-views"}`.
**B17-3 (P3, FIXED):** optional env vars documented; two dead exports removed.
**Refuted by verification:** "AI deleteMemory misses the viewer" (controller passes
session); "call-recordings sweeper never sweeps" (the tick runs `selectRetriable`; only
the test-hook export is dead).
**Cleanup backlog (P3, no action now):** ~13 more zero-reference exports (list in the
B17 agent transcript); `zod` declared-unused in apps/web (left — removing it churns the
frozen lockfile for nothing); three sweeper `*Once` test hooks with no test consumer.
Clean: zero TODO/FIXME anywhere, all dangerous env flags refuse prod boot, migration
hygiene, no missing runtime deps, 5-feature wiring spot-checks coherent.

## Final gate (Phase B exit)

`pnpm check` green (all 12 checkers); web units 49/49; API units 1523/1524 (the one =
the documented call-csw-window box-contention flake, passes isolated — twice re-proven).
Batched e2e: the box cannot complete all 8 batches in one pass (dev servers OOM mid-
suite — the documented limitation), so the gate is the UNION on current code: batches
0/3/4/5/6/7 green in the definitive run, batch 1 38/38 and batch 2 green on fresh-stack
reruns (message-flags 12/12 on its final run; its one failure was state pollution from
earlier aborted runs).

**FG-1 (P1, FIXED in `audit(final-gate)`) — LIVE PROD BUG, predates this audit:** the
2026-08-01 review removed `decodeURIComponent` from the campaign detail page on the
claim that Next pre-decodes dynamic segments — it does not, so every campaign whose
name contains a space rendered "No campaign by that name" IN PRODUCTION since Aug 1.
Fixed with decode-once-in-try/catch (covers the 08-01 bare-% concern in both worlds).
**FG-2/3 (spec truths, FIXED):** round-robin last-resort spec now pins the 2026-08-10
deliberate parks-Unassigned behavior; contacts-dialog count workspace-scoped.

## Fix commits (local, NOT pushed — push = deploy)

| Commit | Section | Content |
|---|---|---|
| `audit(a1)` | A1 | operator Support mask server-side + 3 hardenings + spec |
| `audit(a2)` | A2 | platform-org delete guard |
| `audit(a3)` | A3 | campaign-rollup index `map:` pin |
| `audit(a4)` | A4 | dead socket-contract entry + scope docblock drift |
| `audit(a5)` | A5 | inbound-media mime + app-level webhook 429 |
| `audit(b8)`…`audit(b17)` | B7–B17 | eleven Phase B section commits |
| `audit(final-gate)` | FG | campaign-name decode (prod bug) + two spec truths |
