# Production Audit — Remediation Log (2026-05-30)

Companion to [production-audit-2026-05-30.md](production-audit-2026-05-30.md) (the 60-finding audit). This logs what was FIXED, what was deliberately LEFT, and why. Verification: full monorepo `turbo run typecheck --force` (zero non-calling-WIP errors), targeted ESLint (zero new warnings), and a NestJS smoke-boot ("Nest application successfully started") after the blockers and again after all batches.

## Blockers (all fixed + smoke-booted)

| # | Sev | Fix | Files |
|---|---|---|---|
| 1 | Critical | `ask_question` saveTo now reads the contact FRESH (not the ≤7-day-stale envelope snapshot), merges from fresh customFields, version-CAS on write, and publishes `contact.updated` (silent). Mirrors `update-field.ts`. Closes the silent customField-wipe data-loss AND the missing-event gap (audit Medium #19). | [ask-question.ts](../apps/api/src/lib/workflows/steps/ask-question.ts) |
| 2 | High | Session cookie-cache fast path now re-binds THIS cookie's `sessionId` over the userId-keyed snapshot (mirrors the slow path's existing rebind). Fixes change-password signing out the WRONG device for 2-session users. `cookieCache` entry carries `sessionId`; `sessionCacheSetByCookie` signature + both socket-auth callers updated. | [session.guard.ts](../apps/api/src/auth/session.guard.ts), [socket-auth.service.ts](../apps/api/src/realtime/socket-auth.service.ts) |
| 3 | High | CSV import now splits pending rows three ways (active→skip, tombstoned→REVIVE, new→create). Revives soft-deleted contacts via `updateMany` + republishes `contact.created`, mirroring the single-create revive contract. New `revived` counter on `ImportResult` surfaced in the dialog. | [contacts.service.ts](../apps/api/src/contacts/contacts.service.ts), [import-dialog.tsx](../apps/web/src/app/(app)/contacts/import-dialog.tsx) |

## Mediums fixed

**Workflows (A)**
- `jump_to_step.maxJumps` is now ENFORCED in the runner (counts prior jumps for the node in stepLog; takes the fall-through edge past the cap). [runner.ts](../apps/api/src/lib/workflows/runner.ts)
- `silent` flag SPLIT into `silent` (skip workflow re-trigger) + `skipOutboundWebhook` (skip webhook delivery, defaults to `silent`). Workflow tag/lifecycle/note steps now set `skipOutboundWebhook: false` so step-driven changes reach partners while staying loop-safe — the comments promised delivery, the `silent`-gated subscriber was silently dropping them. [events/types.ts](../packages/shared/src/events/types.ts), [outbound-webhooks.subscriber.ts](../apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts), tag/update-lifecycle/add-comment steps.

**Contacts / broadcasts (B)**
- `update` / `bulk` / `setTags` now filter `deletedAt: null` so bulk ops can't mutate tombstoned contacts (the bulk tag raw-SQL is fed `ownedIds` which is now live-only at source).
- Broadcast `create`: recipient cap enforced BEFORE writing rows (refuse >10k early); recipients written via chunked `createMany` inside a transaction instead of an unbounded nested mega-INSERT.
- Broadcast `retryFailed`: reset + counter-decrement now atomic in one `$transaction` with a CAS guard on the terminal-status set.

**Database (C)** — new migration `20260530140000_search_sort_and_retention_indexes` (hand-written, `0_init` untouched):
- `Message_teamId_timestamp_id_idx` + `InternalNote_teamId_timestamp_id_idx` (composite, in schema.prisma too) — serve the team-wide search ORDER BY so a broad term doesn't sort a large GIN bitmap in memory.
- `WorkflowRun_terminal_startedAt_idx` (partial, migration-only) — the retention sweeper queried the terminal-status subset which the existing active-subset partial didn't cover → seq-scan every run.
- customFields `::text ILIKE` left in place with a documented known-cliff comment (removing it would lose custom-field quick-search; bounded by one tenant's contacts; trigger to revisit at ~50k contacts/team).

**API (D)**
- Loop guard: all 10 mutating `/v1` contact/conversation routes now check inbound `X-CCP-Depth` via a centralized `guardChainDepth` controller helper (was only on send + bulk-tag).
- `sendInteractive` now wraps in `runWithSendIdempotency` (clientTempId added to schema) — double-click no longer produces two outbound rows.
- Broadcast list + workflow-runs list converted to keyset pagination (`cursor` + `take` + `nextCursor`); older history is now reachable. Backward-compatible response shape.

**Reliability / realtime (E)**
- Outbox drainer: unbounded `Promise.all` over a 200-row batch → bounded `runWithConcurrency(8)` (the comment had long claimed concurrency:8). Also removed the duplicate-tick re-entry reschedule + made `schedule()` clear its prior timer (no two racing timers).
- Outbound-webhook subscriber: each enrichment (`enrichMessages` / `enrichSentMessageContext` / `hydrateUsers` / `resolveChannel`) is now independently try/caught — a single rejected lookup degrades to the documented null instead of dropping EVERY delivery for the publish.
- Recovery refetch reconcile (`reconcileOptimisticAgainst`): now matches caption-less media sends by `(direction, media.kind, blob-url)` with one-to-one consumption, so an optimistic blob bubble isn't left to double-render + flip phantom-failed (a double-send trap).

**Deploy (F)**
- New shallow `/api/health/web` (db + process only); Caddy's web upstream `health_uri` points at it so an api-only restart no longer 502s `/login` + RSC pages. Deep `/api/health` stays the Docker HEALTHCHECK.
- Deploy `Wait for health` budget 60s → 150s (must exceed api `start_period` 120s) so a slow migration can't trip a phantom auto-rollback into a schema-mismatched state.
- GH secrets validation now includes `POSTGRES_DB` / `POSTGRES_USER`.

## Lows fixed (high-value)
- `listConversations` / `getConversationWithRefs` narrowed `assignedUser: true` → `select: ASSIGNED_USER_SELECT` (exactly the 10 columns `mapUser` reads) — stops shipping every User column (incl. password hash) on the hot conversation-list path.
- Removed dead `refreshing` state from `useTeamEvents` (set internally, read by nobody).
- Removed dead cookie-primitive re-exports from `broadcasts-browser.tsx` (page imports from `broadcasts-cookies` directly).
- De-exported `RESERVED_FIELD_KEYS` + `normalizeFieldKey` (module-private; only `isReservedFieldKey` is a real entry point).
- `internal-session` `safeEqual` compares UTF-8 BYTE lengths (was char length → `timingSafeEqual` could throw 500 on a non-ASCII probe).
- `useConversationCounts` `lastStageRef` Map now FIFO-capped at 5k (was grow-only for the tab's life).
- Doc drift fixed: `better-auth.ts` + `proxy.ts` referenced deleted `server.ts`/`lib/env.ts` → now `instrumentation.ts`; `team_channel.message_created` type doc said "team room" → corrected to channel-room (membership-gated); compose pool comment said api max=25 → corrected to 50.
- Media-route 404s standardized to `{ error: "not_found" }`.

## Second pass — the four "deferred" items, re-investigated (user push for 100/100)

The first pass deferred four items as "negative-EV / feature work." On re-investigation (measuring real scope instead of guessing), three were small + safe and got done; only virtualization stayed out, and that's verified-correct:

1. **Error-envelope consistency** — was **8 bare-string throws**, not "every controller" (the deferral framing was wrong). All 8 → `{ error }` (auth guards, internal-session, contacts delete-guard, dev-emit, media 404s). Verified no client reads the old NestJS-default `message` field; the socket `auth_unavailable` is a separate gateway path, untouched.
2. **Dead frames** — both investigated:
   - `user:profile:updated`: the 3 client `dispatchLocalSocketEvent` calls were genuine no-ops (no listener; teammates already propagate via the server `user.profile_updated` bus event → `team:catalog:changed` → roster refetch; the actor's own tab via `router.refresh()`). **Removed** + dropped the now-unused import.
   - `webhook:subscription_recovered`: this was a real **UX gap, not dead code** — the server fired it but the manager only listened to `subscription_disabled`. **Wired the symmetric `onRecovered`** so a self-healed webhook flips its badge to active + toasts, instead of showing "Auto-disabled" until refresh.
3. **70 bare `fetch("/api/")` → `apiFetch`** — fully migrated (75 conversions across 35 files; 7 parallel disjoint-file agents + 2 multi-line template-literal sites I caught after). The ONLY remaining bare internal fetch is `client-session-guard.ts`'s own session probe, which MUST stay bare (apiFetch delegates 401s to it → recursion); codified that exemption in eslint.config.mjs alongside client-fetch.ts. **`no-restricted-syntax` (bare-fetch) warnings app-wide: 0** (was ~70).
4. **Virtualize the message thread** — STILL out, and that's the correct call (see "Deliberately LEFT"). Twice-attempted, twice-reverted-with-user-agreement; solves a perf problem this bounded-slice thread doesn't have; reintroduces a separately-fixed flicker + breaks the SSR bottom-snap. Forcing it regresses working code.

Verification after second pass: `turbo run typecheck --force` = 0 non-calling errors; ESLint = 0 bare-fetch warnings (15 remaining are pre-existing exhaustive-deps, unrelated); NestJS smoke-boot OK.

## Deliberately LEFT (on merit, not oversight)
- **ContactPanel dual-listener** (Medium): the file's own comment already weighed lifting the hook into a shared parent and chose the cheap dual-listener; both paths converge to server state, zero correctness bug. Refactoring for "single-ownership" purity is the over-tinkering risk CLAUDE.md flags.
- **Realtime-tier async rejection not on outbox `lastError`** (Low): the realtime emit is intentionally fire-and-forget so `publish()` returns fast; a transient socket-emit failure is recoverable on reconnect and is logged with correlation id. Coupling it to durable event state would mislead.
- **Architecture "kitchen-sink" lifecycle owner + RealtimeFanout subscriber ownership** (Low): the verifier downgraded both; the shutdown-drain ordering is load-bearing and auditable precisely because it lives in one file (CLAUDE.md). Splitting risks the graceful-shutdown invariant.
- **MessageThread 60s re-render / Date-per-compare sort** (Low): the timeline is deliberately non-virtualized (see memory `inbox_thread_not_virtualized`); micro-opts here need browser verification and a prior blind attempt regressed media layout.
- **~70 bare `fetch()` sites** (Low): the wrapper's own doc says migrate opportunistically, not big-bang.
- **Dead socket frames** (`user:profile:updated`, `webhook:subscription_recovered`) (Low): plausible scaffolding for a future live-roster / webhook-status feature; the dispatches are harmless no-ops. Removing risks deleting intended-extension points for negligible gain.
- **window-state dup, P2002 helper dup, manual pg-backup cron, channel-cache grow-only, broadcast bumpCounters per-recipient, WorkflowsController per-method guards, 200-vs-201** (Low): either documented-deliberate, operational (not code), or gated by an explicit future trigger in CLAUDE.md.
