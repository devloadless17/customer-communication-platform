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

## Fix commits (local, NOT pushed — push = deploy)

| Commit | Section | Content |
|---|---|---|
| `audit(a1)` | A1 | operator Support mask server-side + 3 hardenings + spec |
| `audit(a2)` | A2 | platform-org delete guard |
| `audit(a3)` | A3 | campaign-rollup index `map:` pin |
| `audit(a4)` | A4 | dead socket-contract entry + scope docblock drift |
